#!/usr/bin/env bash
# session-end.sh — Stop hook: CLI 세션 종료 시 활성 deep-work 세션 확인 및 알림
# + v5.0: 세션 히스토리 JSONL append (harness assumption engine용)
# Exit codes:
#   0 = always (Stop hooks must never block session close)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/utils.sh"

# ─── 프로젝트 루트 & 상태 파일 ─────────────────────────────

init_deep_work_state

# 상태 파일이 없으면 워크플로우 비활성 → 즉시 종료
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# ─── YAML frontmatter에서 current_phase, task_description 추출 ──

CURRENT_PHASE="$(read_frontmatter_field "$STATE_FILE" "current_phase")"
TASK_DESC="$(read_frontmatter_field "$STATE_FILE" "task_description")"

# ─── Phase cache cleanup ──────────────────────────────────
# Prevent stale cache on next resume
SESSION_ID="${DEEP_WORK_SESSION_ID:-}"
if [[ -z "$SESSION_ID" ]]; then
  _PTR="$PROJECT_ROOT/.claude/deep-work-current-session"
  [[ -f "$_PTR" ]] && SESSION_ID="$(tr -d '\n\r' < "$_PTR")"
fi
if [[ -n "$SESSION_ID" ]]; then
  PHASE_CACHE="$PROJECT_ROOT/.claude/.phase-cache-${SESSION_ID}"
  [[ -f "$PHASE_CACHE" ]] && rm -f "$PHASE_CACHE"
fi

# idle이거나 비어있으면 활성 세션 없음 → 종료
# v6.3.0 — Phase 5 interrupted marker
# Phase 5는 current_phase="idle" 유지 상태로 실행되므로, idle fast-path 이전에
# integrate-loop.json의 terminated_by를 interrupted로 전환해야 한다.
# v6.3.0 review RC5-4: snapshot 우선 사용 (state tampering 방어 일관성).
# `phase5_work_dir_snapshot`이 있으면 그 값을, 없으면 legacy `work_dir` fallback.
_P5_WD_REL="$(read_frontmatter_field "$STATE_FILE" "phase5_work_dir_snapshot")"
[[ -z "$_P5_WD_REL" ]] && _P5_WD_REL="$(read_frontmatter_field "$STATE_FILE" "work_dir")"
if [[ -n "$_P5_WD_REL" ]]; then
  _P5_LOOP="$PROJECT_ROOT/$_P5_WD_REL/integrate-loop.json"
  if [[ -f "$_P5_LOOP" ]]; then
    _P5_ACTIVE=$(jq -r 'if (.loop_round // 0) > 0 and (.terminated_by == null) then "yes" else "no" end' "$_P5_LOOP" 2>/dev/null || echo "no")
    if [[ "$_P5_ACTIVE" == "yes" ]]; then
      # Stop hook은 "exit 0 = always" 계약 — mktemp/jq 실패해도 중단 금지.
      (
        _P5_TMP=$(mktemp) || exit 0
        jq '.terminated_by = "interrupted"' "$_P5_LOOP" > "$_P5_TMP" 2>/dev/null \
          && mv "$_P5_TMP" "$_P5_LOOP" \
          || rm -f "$_P5_TMP"
      ) || true
    fi
  fi
fi

# ─── v6.6.0 (M5.7) — compaction-state emit at session-stop ────────────
# R1 review C1+W2+C3 fix: this block runs BEFORE the idle fast-exit so finalized
# sessions (the normal happy-path post `/deep-finish`) also emit. The Stop hook
# contract is "must not block session close" — wrap in subshell + `|| true`,
# redirect stderr to guard-errors log.
#
# Strategy: receipt-only on session-stop (the session-receipt is comprehensive;
# in-flight working memory is not worth preserving since the next session
# starts fresh).
#
# bash 3.2 compatibility (R1 review W2): use if/else for the optional
# --source-session-receipt flag rather than array expansion, which triggers
# "unbound variable" under `set -u` on bash <= 4.3 (macOS default).
(
  EMIT_SCRIPT="$SCRIPT_DIR/emit-compaction-state.js"
  [ -f "$EMIT_SCRIPT" ] || exit 0  # plugin version without emit helper — skip silently
  command -v node >/dev/null 2>&1 || exit 0

  # R2 review fix (Codex adversarial MEDIUM): use phase5_work_dir_snapshot
  # first (immutable boundary recorded by Phase 5 entry) before falling back
  # to mutable work_dir. Mirrors the existing pattern at lines 44-45 of this
  # same file (Phase 5 interrupted marker logic uses snapshot-first too).
  _CS_WD_REL="$(read_frontmatter_field "$STATE_FILE" "phase5_work_dir_snapshot" 2>/dev/null || echo "")"
  [ -z "$_CS_WD_REL" ] && _CS_WD_REL="$(read_frontmatter_field "$STATE_FILE" "work_dir" 2>/dev/null || echo "")"
  [ -z "$_CS_WD_REL" ] && exit 0
  _CS_WORK_DIR="$PROJECT_ROOT/$_CS_WD_REL"
  _CS_OUTDIR="$PROJECT_ROOT/.deep-work/compaction-states"
  mkdir -p "$_CS_OUTDIR" 2>/dev/null || exit 0

  # Resolve session id (matches Section 1 fallback chain in deep-finish.md).
  _CS_SID="${DEEP_WORK_SESSION_ID:-}"
  if [ -z "$_CS_SID" ] && [ -f "$PROJECT_ROOT/.claude/deep-work-current-session" ]; then
    _CS_SID="$(tr -d '\n\r' < "$PROJECT_ROOT/.claude/deep-work-current-session" 2>/dev/null || echo "")"
  fi
  _CS_TS="$(date -u +%Y%m%dT%H%M%SZ)"
  _CS_OUT="$_CS_OUTDIR/${_CS_TS}-${_CS_SID:-session-stop}.json"

  # Preserved set: session-receipt if it exists (finalized session); otherwise
  # the state file (so the next session can resume from disk).
  _CS_RECEIPT="$_CS_WORK_DIR/session-receipt.json"
  if [ -f "$_CS_RECEIPT" ]; then
    _CS_PRESERVED="$_CS_RECEIPT"
  else
    _CS_PRESERVED="$STATE_FILE"
  fi

  # R1 review C3 fix: emit a meaningful --discarded set so dashboard's
  # suite.compaction.preserved_artifact_ratio gets data points. Concrete
  # discarded artifacts (where they exist) + sentinel for compacted in-memory
  # state per guides/context-management.md §5 (paths producer dropped from
  # memory, even if some are conceptual).
  _CS_DISCARDED=""
  for f in "$_CS_WORK_DIR/sensors"/* "$_CS_WORK_DIR/integrate-loop.json" \
           "$_CS_WORK_DIR/file-changes.log" "$_CS_WORK_DIR"/.tmp.*; do
    [ -e "$f" ] && _CS_DISCARDED+="${_CS_DISCARDED:+,}$f"
  done
  # Sentinel for conceptual in-memory state that doesn't have a file on disk
  # (LLM working context, tool-call traces). Without this, dashboard treats the
  # ratio as undefined when no concrete discarded files exist.
  _CS_DISCARDED+="${_CS_DISCARDED:+,}.deep-work/${_CS_SID:-session}/.compacted/in-memory-state"

  # Emit — use if/else for optional --source-session-receipt (bash 3.2 safe).
  if [ -f "$_CS_RECEIPT" ]; then
    node "$EMIT_SCRIPT" \
      --trigger session-stop \
      --output "$_CS_OUT" \
      --preserved "$_CS_PRESERVED" \
      --discarded "$_CS_DISCARDED" \
      --strategy receipt-only \
      ${_CS_SID:+--session-id "$_CS_SID"} \
      --source-session-receipt "$_CS_RECEIPT" >/dev/null 2>&1 || true
  else
    node "$EMIT_SCRIPT" \
      --trigger session-stop \
      --output "$_CS_OUT" \
      --preserved "$_CS_PRESERVED" \
      --discarded "$_CS_DISCARDED" \
      --strategy receipt-only \
      ${_CS_SID:+--session-id "$_CS_SID"} >/dev/null 2>&1 || true
  fi
) 2>>"$PROJECT_ROOT/.claude/deep-work-guard-errors.log" || true

if [[ -z "$CURRENT_PHASE" || "$CURRENT_PHASE" == "idle" ]]; then
  exit 0
fi

# ─── 활성 세션 알림 메시지 출력 ─────────────────────────────

PHASE_KO=""
case "$CURRENT_PHASE" in
  research)  PHASE_KO="리서치(Research)" ;;
  spec)      PHASE_KO="명세(Spec)" ;;
  plan)      PHASE_KO="기획(Plan)" ;;
  implement) PHASE_KO="구현(Implement)" ;;
  test)      PHASE_KO="테스트(Test)" ;;
  *)         PHASE_KO="$CURRENT_PHASE" ;;
esac

# ─── Worktree 정보 확인 ─────────────────────────────────────

WORKTREE_ENABLED="$(read_frontmatter_field "$STATE_FILE" "worktree_enabled")"
WORKTREE_BRANCH="$(read_frontmatter_field "$STATE_FILE" "worktree_branch")"
WORKTREE_MSG=""
if [[ "$WORKTREE_ENABLED" == "true" && -n "$WORKTREE_BRANCH" ]]; then
  WORKTREE_MSG="\n\n  🌿 Worktree: ${WORKTREE_BRANCH}\n     다음 세션에서 /deep-finish로 브랜치를 정리하세요."
fi

cat <<JSON
{"message":"Deep Work 세션이 활성 상태입니다.\n\n  Phase: ${PHASE_KO}\n  Task: ${TASK_DESC}${WORKTREE_MSG}\n\n다음 세션에서 /deep-status로 진행 상황을 확인하거나,\n작업이 완료되었다면 /deep-status --report로 리포트를 확인하세요."}
JSON

# ─── 세션 히스토리 JSONL append (v5.0) ──────────────────────
# Appends a session summary to harness-sessions.jsonl for the assumption engine.
# Errors are logged to stderr and never block session close.

append_session_history() {
  local work_dir_rel
  work_dir_rel="$(read_frontmatter_field "$STATE_FILE" "work_dir")"
  if [[ -z "$work_dir_rel" ]]; then
    return 0
  fi

  local work_dir="$PROJECT_ROOT/$work_dir_rel"
  # Write to shared harness-history at the deep-work root level (one level up from session folder)
  # Consumers (deep-status, deep-work, deep-report, deep-assumptions) all read from this path
  local history_dir="$(dirname "$work_dir")/harness-history"
  local jsonl_file="$history_dir/harness-sessions.jsonl"

  # ── session_id: started_at timestamp (unique per session)
  local session_id
  session_id="$(read_frontmatter_field "$STATE_FILE" "started_at")"
  if [[ -z "$session_id" ]]; then
    # Fallback: use session ID from env or pointer file
    session_id="${DEEP_WORK_SESSION_ID:-}"
    if [[ -z "$session_id" ]]; then
      return 0  # No identifier available
    fi
  fi

  # ── Check if finalized record already exists (deep-finish wrote it)
  if [[ -f "$jsonl_file" ]]; then
    if grep -qF "\"session_id\":\"$session_id\"" "$jsonl_file" 2>/dev/null; then
      # Check if the existing record is finalized
      if grep "\"session_id\":\"$session_id\"" "$jsonl_file" 2>/dev/null | grep -qF '"status":"finalized"'; then
        return 0  # Finalized record exists — do not overwrite
      fi
      # Provisional record exists — also skip (deep-finish will upsert later if needed)
      return 0
    fi
  fi

  # ── Read state fields
  local tdd_mode test_retry_count
  tdd_mode="$(read_frontmatter_field "$STATE_FILE" "tdd_mode")"
  test_retry_count="$(read_frontmatter_field "$STATE_FILE" "test_retry_count")"
  : "${tdd_mode:=unknown}"
  : "${test_retry_count:=0}"

  # ── Determine phases_used from timestamps
  local phases_json="["
  local first=true
  local phase ts
  for phase in brainstorm research plan implement test; do
    ts="$(read_frontmatter_field "$STATE_FILE" "${phase}_started_at")"
    if [[ -n "$ts" ]]; then
      if $first; then first=false; else phases_json+=","; fi
      phases_json+="\"$phase\""
    fi
  done
  phases_json+="]"

  # ── Determine model_primary (from model_routing or default)
  local model_primary
  model_primary="$(read_frontmatter_field "$STATE_FILE" "model_primary")"
  : "${model_primary:=unknown}"

  # ── Calculate total_duration_minutes from started_at to now
  local duration_minutes=0
  duration_minutes=$(node -e "
    const start = Date.parse(process.argv[1]);
    if (isNaN(start)) { console.log(0); process.exit(0); }
    console.log(Math.floor((Date.now() - start) / 60000));
  " "$session_id" 2>/dev/null || echo 0)

  # ── Aggregate receipt data from SLICE-*.json files
  local receipts_dir="$work_dir/receipts"
  local slices_total=0
  local slices_passed_first_try=0
  local tdd_overrides=0
  local bugs_caught_in_red_phase=0
  local research_references_used=0
  local cross_model_unique_findings=0
  local slices_json="["
  local slices_first=true

  if [[ -d "$receipts_dir" ]]; then
    local receipt_file
    for receipt_file in "$receipts_dir"/SLICE-*.json; do
      [[ -f "$receipt_file" ]] || continue

      # v6.5.0 envelope identity guard — fast-path bash only (round-1
      # deep-review W6 lesson — Stop hook contract is "must not block session
      # close"; spawning `node` per receipt added 1-3 s overhead with 30+
      # slices). The grep checks below are O(file-size) on small JSON, no
      # process spawn. Foreign envelopes (e.g. accidentally copied from
      # another plugin) are skipped — slices_total stays accurate. Legacy
      # (non-envelope) receipts pass through unchanged because they never
      # contain the substring `"envelope"`.
      #
      # Detection logic:
      #   - File contains `"envelope"` AND `"schema_version": "1.0"`
      #     → looks like envelope; check identity.
      #   - Otherwise → legacy receipt; count.
      #
      # Per-field grep extraction below works on either shape because
      # envelope keys (producer, producer_version, artifact_kind, run_id,
      # generated_at, schema, git, provenance) do not collide with payload
      # keys (slice_id, status, tdd_mode, harness_metadata.model_id, etc.).
      if grep -q '"envelope"[[:space:]]*:' "$receipt_file" 2>/dev/null \
         && grep -q '"schema_version"[[:space:]]*:[[:space:]]*"1\.0"' "$receipt_file" 2>/dev/null; then
        # Envelope-shaped — verify producer + artifact_kind + schema.name.
        if ! grep -q '"producer"[[:space:]]*:[[:space:]]*"deep-work"' "$receipt_file" 2>/dev/null \
           || ! grep -q '"artifact_kind"[[:space:]]*:[[:space:]]*"slice-receipt"' "$receipt_file" 2>/dev/null \
           || ! grep -q '"name"[[:space:]]*:[[:space:]]*"slice-receipt"' "$receipt_file" 2>/dev/null; then
          continue
        fi
      fi

      slices_total=$((slices_total + 1))

      # Extract per-slice data using lightweight parsing (no jq dependency)
      local slice_id="" slice_tdd_mode="" slice_status="" slice_model=""
      local s_tests_first="false" s_rework=0 s_bugs=0 s_refs=0 s_cross=0

      # Best-effort field extraction from JSON (single-line values only)
      slice_id=$(grep -o '"slice_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/' || echo "")
      slice_status=$(grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/' || echo "")
      slice_tdd_mode=$(grep -o '"tdd_mode"[[:space:]]*:[[:space:]]*"[^"]*"' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/' || echo "")
      # harness_metadata.model_id is the current receipt contract
      # (agents/implement-slice-worker.md); top-level "model_used" survives
      # only in legacy pre-envelope receipts (receipt-migration.js).
      slice_model=$(grep -o '"model_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/' || echo "")
      if [[ -z "$slice_model" ]]; then
        slice_model=$(grep -o '"model_used"[[:space:]]*:[[:space:]]*"[^"]*"' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:.*"\([^"]*\)".*/\1/' || echo "")
      fi

      # harness_metadata fields (may not exist in older receipts)
      local hm_block
      hm_block=$(grep -o '"tests_passed_first_try"[[:space:]]*:[[:space:]]*[a-z]*' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || echo "false")
      if [[ "$hm_block" == "true" ]]; then
        s_tests_first="true"
        slices_passed_first_try=$((slices_passed_first_try + 1))
      fi

      s_rework=$(grep -o '"rework_count"[[:space:]]*:[[:space:]]*[0-9]*' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || echo "0")
      s_bugs=$(grep -o '"bugs_caught_in_red_phase"[[:space:]]*:[[:space:]]*[0-9]*' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || echo "0")
      s_refs=$(grep -o '"research_references_used"[[:space:]]*:[[:space:]]*[0-9]*' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || echo "0")
      s_cross=$(grep -o '"cross_model_unique_findings"[[:space:]]*:[[:space:]]*[0-9]*' "$receipt_file" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || echo "0")

      # Check for TDD override
      if [[ "$slice_tdd_mode" == "override" ]] || grep -q '"action"[[:space:]]*:[[:space:]]*"override"' "$receipt_file" 2>/dev/null; then
        tdd_overrides=$((tdd_overrides + 1))
      fi

      bugs_caught_in_red_phase=$((bugs_caught_in_red_phase + ${s_bugs:-0}))
      research_references_used=$((research_references_used + ${s_refs:-0}))
      cross_model_unique_findings=$((cross_model_unique_findings + ${s_cross:-0}))

      # Build per-slice JSON entry
      if $slices_first; then slices_first=false; else slices_json+=","; fi
      slices_json+="{\"slice_id\":\"${slice_id}\",\"status\":\"${slice_status}\",\"tdd_mode\":\"${slice_tdd_mode}\",\"model\":\"${slice_model}\",\"tests_passed_first_try\":${s_tests_first},\"bugs_caught_in_red\":${s_bugs:-0},\"rework_count\":${s_rework:-0}}"
    done
  fi
  slices_json+="]"

  # ── Review scores from state file
  # review_results uses YAML flow style: brainstorm: {score: 8, iterations: 1, ...}
  # Extract score/spec_score numeric value from the flow mapping
  local review_scores="{}"
  local bs_score rs_score pl_score

  # Extract the flow-style line for each phase and parse score from it
  bs_score=$(grep 'brainstorm:' "$STATE_FILE" 2>/dev/null | grep -o 'score:[[:space:]]*[0-9]*' | head -1 | sed 's/score:[[:space:]]*//' || echo "")
  rs_score=$(grep 'research:' "$STATE_FILE" 2>/dev/null | grep -o 'score:[[:space:]]*[0-9]*' | head -1 | sed 's/score:[[:space:]]*//' || echo "")
  pl_score=$(grep '  plan:' "$STATE_FILE" 2>/dev/null | grep -o 'spec_score:[[:space:]]*[0-9]*' | head -1 | sed 's/spec_score:[[:space:]]*//' || echo "")

  # Build review_scores JSON
  local rs_parts=()
  [[ -n "$bs_score" && "$bs_score" != "0" ]] && rs_parts+=("\"brainstorm\":$bs_score")
  [[ -n "$rs_score" && "$rs_score" != "0" ]] && rs_parts+=("\"research\":$rs_score")
  [[ -n "$pl_score" && "$pl_score" != "0" ]] && rs_parts+=("\"plan\":$pl_score")
  if [[ ${#rs_parts[@]} -gt 0 ]]; then
    local IFS=","
    review_scores="{${rs_parts[*]}}"
  fi

  # ── Determine final_outcome
  local test_passed
  test_passed="$(read_frontmatter_field "$STATE_FILE" "test_passed")"
  local final_outcome="partial"
  if [[ "$test_passed" == "true" ]]; then
    final_outcome="pass"
  elif [[ "$CURRENT_PHASE" == "test" && "$test_passed" == "false" ]]; then
    final_outcome="fail"
  fi

  # ── Build the JSONL entry (single line, no jq dependency)
  local entry
  entry="{\"session_id\":\"${session_id}\",\"status\":\"provisional\",\"quality_score\":null,\"model_primary\":\"${model_primary}\",\"slices\":${slices_json},\"phases_used\":${phases_json},\"slices_total\":${slices_total},\"slices_passed_first_try\":${slices_passed_first_try},\"tdd_mode\":\"${tdd_mode}\",\"tdd_overrides\":${tdd_overrides},\"bugs_caught_in_red_phase\":${bugs_caught_in_red_phase},\"research_references_used\":${research_references_used},\"test_retry_count\":${test_retry_count},\"review_scores\":${review_scores},\"cross_model_unique_findings\":${cross_model_unique_findings},\"total_duration_minutes\":${duration_minutes},\"final_outcome\":\"${final_outcome}\"}"

  # ── Write to JSONL file with lock.
  # On lock timeout, queue the entry to a sibling pending-append.jsonl file
  # that a subsequent session-end will drain. Previously, the fallback wrote
  # unlocked, which could interleave bytes from concurrent session closes
  # (v6.2.3 bug M-1).
  _append_with_lock() {
    local target="$1" data="$2"
    local lockdir="${target}.lock.d"
    local pending="${target}.pending-append.jsonl"
    local retries=20
    while [ "$retries" -gt 0 ]; do
      if mkdir "$lockdir" 2>/dev/null; then
        # Crash-safe drain (v6.2.4 post-review W-1): rename pending to
        # .draining.<pid> BEFORE appending to target. If we crash between
        # cat and truncate, the renamed file survives and a future run
        # (including a second _append_with_lock call) can recover.
        if [ -s "$pending" ]; then
          local draining="${pending}.draining.$$"
          mv "$pending" "$draining" 2>/dev/null || true
          if [ -s "$draining" ]; then
            cat "$draining" >> "$target" 2>/dev/null
          fi
          rm -f "$draining" 2>/dev/null
        fi
        # Also recover any .draining.<pid> left by crashed prior runs.
        for orphan in "${pending}.draining."*; do
          [ -s "$orphan" ] || continue
          cat "$orphan" >> "$target" 2>/dev/null
          rm -f "$orphan" 2>/dev/null
        done
        echo "$data" >> "$target" 2>/dev/null
        rmdir "$lockdir" 2>/dev/null
        return 0
      fi
      retries=$((retries - 1)); sleep 0.1
    done
    # Lock timeout — queue instead of appending without a lock.
    echo "$data" >> "$pending" 2>/dev/null
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session-end JSONL lock timeout, queued to $pending" \
      >> "$PROJECT_ROOT/.claude/deep-work-guard-errors.log" 2>/dev/null || true
  }

  mkdir -p "$history_dir" 2>/dev/null || return 0

  # Validate JSON before writing (defensive)
  if command -v node &>/dev/null; then
    if ! echo "$entry" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d);process.exit(0)}catch(e){process.exit(1)}})" 2>/dev/null; then
      return 0  # skip malformed entry
    fi
  fi

  _append_with_lock "$jsonl_file" "$entry"
}

# Run in subshell — errors must never block session close
(append_session_history) 2>>"$PROJECT_ROOT/.claude/deep-work-guard-errors.log" || true

# v6.2.4 post-review: cleanup stale PostToolUse stdin-cache files.
# v7.2.1 (issue #74): phase-transition.sh now deletes each cache as soon as the
# handoff is done, so this sweep is only a backstop for invocations that died
# between the write and the read. The former `rm -f …$PPID` line was dropped:
# $PPID here is this Stop hook's own node bootstrap, never the PostToolUse one
# that created a cache, so it could not match a real file. Best-effort.
find "$PROJECT_ROOT/.claude" -maxdepth 1 -name '.hook-tool-input.*' -type f -mmin +60 -delete 2>/dev/null || true

# v5.4: Update last_activity on CLI stop (do NOT unregister)
if [[ -n "${DEEP_WORK_SESSION_ID:-}" ]]; then
  (update_last_activity "$DEEP_WORK_SESSION_ID") 2>/dev/null || true
fi

# v5.6: Update parent's fork_children status when fork session ends
if [[ -n "${DEEP_WORK_SESSION_ID:-}" ]]; then
  (
    local_registry="$(read_registry)"
    fork_parent=$(node -e '
      const data = JSON.parse(process.argv[1]);
      const sid = process.argv[2];
      const sess = data.sessions[sid];
      if (sess && sess.fork_parent) console.log(sess.fork_parent);
    ' "$local_registry" "$DEEP_WORK_SESSION_ID" 2>/dev/null || true)

    if [[ -n "$fork_parent" ]]; then
      parent_state="$PROJECT_ROOT/.claude/deep-work.${fork_parent}.md"
      if [[ -f "$parent_state" ]]; then
        # Mark this child as idle in parent's fork_children (best-effort)
        node -e '
          const fs = require("fs");
          const stateFile = process.argv[1];
          const childId = process.argv[2];
          let content = fs.readFileSync(stateFile, "utf8");
          // Add status: idle after the matching session_id line
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes("session_id: " + childId)) {
              // Check if status line already exists
              if (i + 3 < lines.length && lines[i + 3] && lines[i + 3].includes("status:")) {
                lines[i + 3] = "    status: idle";
              } else {
                lines.splice(i + 3, 0, "    status: idle");
              }
              break;
            }
          }
          fs.writeFileSync(stateFile, lines.join("\n"));
        ' "$parent_state" "$DEEP_WORK_SESSION_ID" 2>/dev/null || true
      fi
    fi
  ) 2>/dev/null || true
fi

exit 0
