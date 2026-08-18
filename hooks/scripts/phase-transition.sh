#!/usr/bin/env bash
# phase-transition.sh — PostToolUse hook: phase 전환 감지 → 조건 checklist injection
#
# state 파일의 current_phase가 변경되면 worktree_path, team_mode 등
# 핵심 조건을 stdout으로 출력하여 LLM context에 주입한다.
#
# Exit codes:
#   0 = always (PostToolUse hooks are informational, never block)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/utils.sh"

init_deep_work_state

# ─── Read tool input ─────────────────────────────────────
# PostToolUse hooks 배열에서 앞선 hook(file-tracker.sh)이 stdin을 소비하므로
# 여기서는 stdin을 읽을 수 없다. v6.2.4 이전: CLAUDE_TOOL_INPUT 환경변수를
# 시도했지만 이는 Claude Code hook 프로토콜에 정의되어 있지 않아 프로덕션
# 에서는 사실상 빈 문자열이었다. 이제는 file-tracker.sh가 stdin을 읽으며
# $PPID 키로 캐시해 두고, 우리가 그 캐시 파일을 읽는다. 환경변수도
# 혹시 미래 버전에서 설정될 가능성을 고려해 우선 확인한다.
TOOL_INPUT="${CLAUDE_TOOL_USE_INPUT:-${CLAUDE_TOOL_INPUT:-}}"
_HOOK_INPUT_CACHE="$PROJECT_ROOT/.claude/.hook-tool-input.${PPID}"
if [[ -z "$TOOL_INPUT" && -f "$_HOOK_INPUT_CACHE" ]]; then
  TOOL_INPUT="$(cat "$_HOOK_INPUT_CACHE" 2>/dev/null || printf '')"
fi
# v7.2.1 (issue #74): we are the cache's only consumer, so the handoff is over
# the moment the read above has had its chance — drop the file here, ahead of
# every early exit below. This must NOT be conditional on having read it:
# hook-shell-adapter.js passes the payload in CLAUDE_TOOL_INPUT, so on the
# production path the branch above never runs and nothing else would ever
# remove what file-tracker.sh just wrote. That is why the files piled up one
# per tool call. $PPID stays as the key so two hook invocations racing inside
# one session cannot read each other's payload.
rm -f "$_HOOK_INPUT_CACHE" 2>/dev/null || true
[[ -z "$TOOL_INPUT" ]] && exit 0

# v6.9.4 (deep-review D-2): env 미설정(wrapper) 하네스 방어 — 받은 입력이
# wrapper JSON 형태면 공유 헬퍼로 unwrap한다. 정상 경로에서는 no-op이다:
# file-tracker.sh가 이미 unwrap해 캐시하므로 캐시 경로는 flat이고, flat 입력은
# tool_input 키가 없어 그대로 통과하며, tool-name env가 설정된 flat 계약
# 하네스에서는 헬퍼가 payload를 건드리지 않는다 (defense-in-depth).
resolve_hook_tool_context "$TOOL_INPUT"
TOOL_INPUT="$HOOK_TOOL_INPUT"

# ─── 1. State 파일 대상인지 확인 ────────────────────────────
FILE_PATH="$(extract_file_path_from_json "$TOOL_INPUT")"

[[ -z "$FILE_PATH" ]] && exit 0
# Fold backslashes → forward slashes (Windows/Git Bash) BEFORE the state-file
# guard, the -f existence check, and read_frontmatter_field. Without this a
# backslash target like `C:\repo\.claude\deep-work.s.md` contains
# `.claude\deep-work.` (not `.claude/deep-work.`), so this hook exited early and
# silently dropped worktree/TDD/team-mode injection — while file-tracker.sh
# normalizes and DID cache it. Keep both hooks' path classification symmetric.
FILE_PATH="$(normalize_path "$FILE_PATH")"
[[ "$FILE_PATH" != *".claude/deep-work."*".md" ]] && exit 0

# ─── 2. Session ID 추출 ────────────────────────────────────
# Take the LAST segment (innermost `deep-work.XXXX`) and disallow `/` in the
# captured id, so fork worktree paths like
# `.deep-work/sessions/deep-work.s-parent/sub/.claude/deep-work.s-child.md`
# resolve to `s-child`, not a multi-line mess.
SESSION_ID="$(echo "$FILE_PATH" | grep -o 'deep-work\.[^./]*' | sed 's/deep-work\.//' | tail -1)"
[[ -z "$SESSION_ID" ]] && exit 0

# ─── 3. 현재 phase 읽기 ────────────────────────────────────
[[ ! -f "$FILE_PATH" ]] && exit 0
NEW_PHASE="$(read_frontmatter_field "$FILE_PATH" "current_phase")"
[[ -z "$NEW_PHASE" ]] && exit 0

# ─── 4. Cache 비교 ─────────────────────────────────────────
CACHE_DIR="$PROJECT_ROOT/.claude"
CACHE_FILE="$CACHE_DIR/.phase-cache-${SESSION_ID}"
OLD_PHASE=""
[[ -f "$CACHE_FILE" ]] && OLD_PHASE="$(cat "$CACHE_FILE")"
[[ "$NEW_PHASE" == "$OLD_PHASE" ]] && exit 0

# ─── 5. Cache 업데이트 ─────────────────────────────────────
echo "$NEW_PHASE" > "$CACHE_FILE"

# ─── 6. State에서 조건 읽기 ────────────────────────────────
WORKTREE_ENABLED="$(read_frontmatter_field "$FILE_PATH" "worktree_enabled")"
WORKTREE_PATH="$(read_frontmatter_field "$FILE_PATH" "worktree_path")"
TEAM_MODE="$(read_frontmatter_field "$FILE_PATH" "team_mode")"
# cross_model_enabled: nested mapping (codex: true/false, gemini: true/false) 또는 scalar (true/false)
# read_frontmatter_field는 same-line scalar만 추출하므로, nested mapping 대비 grep으로 보완
CROSS_MODEL_ENABLED="$(read_frontmatter_field "$FILE_PATH" "cross_model_enabled")"
if [[ -z "$CROSS_MODEL_ENABLED" ]]; then
  # Nested mapping인 경우: cross_model_enabled: 아래 줄에 codex: true 또는 gemini: true가 있는지 확인
  if grep -A3 '^cross_model_enabled:' "$FILE_PATH" 2>/dev/null | grep -q 'true'; then
    CROSS_MODEL_ENABLED="true"
  fi
fi
TDD_MODE="$(read_frontmatter_field "$FILE_PATH" "tdd_mode")"

# ─── 7. Checklist injection (stdout → LLM context) ────────
HAS_CONDITIONS=false

OUTPUT=""
OUTPUT+=$'\n'"━━━ Phase Transition: ${OLD_PHASE:-init} → ${NEW_PHASE} ━━━"$'\n\n'

if [[ "$WORKTREE_ENABLED" == "true" && -n "$WORKTREE_PATH" ]]; then
  OUTPUT+="📂 worktree_path: $WORKTREE_PATH"$'\n'
  OUTPUT+="   → 모든 파일 작업은 이 경로 내에서 수행"$'\n'
  HAS_CONDITIONS=true
fi

if [[ "$TEAM_MODE" == "team" ]]; then
  OUTPUT+="👥 team_mode: team"$'\n'
  OUTPUT+="   → TeamCreate 사용하여 병렬 에이전트 실행"$'\n'
  HAS_CONDITIONS=true
fi

if [[ "$CROSS_MODEL_ENABLED" == "true" ]]; then
  OUTPUT+="🔄 cross_model_enabled: true"$'\n'
  OUTPUT+="   → 교차 검증 실행 필요"$'\n'
  HAS_CONDITIONS=true
fi

if [[ "$NEW_PHASE" == "implement" ]]; then
  OUTPUT+="🧪 tdd_mode: ${TDD_MODE:-strict}"$'\n'
  OUTPUT+="   → TDD 프로토콜 준수 (테스트 먼저)"$'\n'
  HAS_CONDITIONS=true
fi

OUTPUT+=$'\n'"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 조건이 있을 때만 출력
if [[ "$HAS_CONDITIONS" == "true" ]]; then
  printf '%s' "$OUTPUT"
fi

# ─── v6.6.0 (M5.7) — compaction-state emit on phase transition ────────
# Each Phase boundary is a compaction event: the just-closed Phase's primary
# artifact (research.md, plan.md, ...) becomes the next Phase's only input;
# intermediate working memory is discarded. Strategy: key-artifacts-only.
# PostToolUse hook contract is "informational, never block" — wrap in subshell
# + `|| true`.
#
# R1 review C2 fix: preserved set now references the JUST-CLOSED phase's
# artifact (which exists when the hook fires) rather than the entering phase's
# artifact (which does not exist yet). All preserved paths are filtered to
# existing files at emit time.
#
# R1 review C3 fix: explicit --discarded set (concrete sensor + tmp files for
# the just-closed phase + a sentinel for the compacted in-memory LLM context)
# so the dashboard's suite.compaction.preserved_artifact_ratio metric gets
# data points. Without --discarded the dashboard treats the ratio as undefined
# per guides/context-management.md §5.
(
  EMIT_SCRIPT="$SCRIPT_DIR/emit-compaction-state.js"
  [ -f "$EMIT_SCRIPT" ] || exit 0
  command -v node >/dev/null 2>&1 || exit 0

  _PT_WD_REL="$(read_frontmatter_field "$FILE_PATH" "work_dir" 2>/dev/null || echo "")"
  [ -z "$_PT_WD_REL" ] && exit 0
  _PT_WORK_DIR="$PROJECT_ROOT/$_PT_WD_REL"
  _PT_OUTDIR="$PROJECT_ROOT/.deep-work/compaction-states"
  mkdir -p "$_PT_OUTDIR" 2>/dev/null || exit 0

  _PT_TS="$(date -u +%Y%m%dT%H%M%SZ)"
  _PT_OUT="$_PT_OUTDIR/${_PT_TS}-${SESSION_ID}-phase-${NEW_PHASE}.json"

  # Preserved: the artifact produced by the just-closed phase (OLD_PHASE in
  # this hook's variable scope). For the first phase entry (empty OLD_PHASE
  # or "init"), no predecessor artifact exists yet.
  _PT_PRESERVED=""
  case "$NEW_PHASE" in
    research)  _PT_PRESERVED="$_PT_WORK_DIR/brainstorm.md" ;;
    plan)      _PT_PRESERVED="$_PT_WORK_DIR/research.md" ;;
    implement) _PT_PRESERVED="$_PT_WORK_DIR/plan.md" ;;
    test)      _PT_PRESERVED="$_PT_WORK_DIR/plan.md,$_PT_WORK_DIR/receipts" ;;
    idle)      _PT_PRESERVED="$_PT_WORK_DIR/session-receipt.json" ;;
    *)         _PT_PRESERVED="" ;;
  esac

  # Filter preserved to existing paths only (avoid recording future/missing
  # artifacts in the dashboard ratio).
  _PT_PRESERVED_FILTERED=""
  if [ -n "$_PT_PRESERVED" ]; then
    IFS=',' read -ra _PT_PATHS <<< "$_PT_PRESERVED"
    for _p in "${_PT_PATHS[@]}"; do
      [ -z "$_p" ] && continue
      if [ -e "$_p" ]; then
        _PT_PRESERVED_FILTERED="${_PT_PRESERVED_FILTERED:+$_PT_PRESERVED_FILTERED,}$_p"
      fi
    done
  fi

  # Discarded: concrete intermediate state from the just-closed phase + a
  # sentinel path representing the compacted LLM working memory (no file
  # representation but a real semantic). The sentinel ensures the dashboard's
  # ratio formula has a denominator > 0.
  _PT_DISCARDED=""
  _PT_PREV_PHASE="${OLD_PHASE:-session-start}"
  # Concrete: sensor outputs and tmp files attributable to the just-closed phase.
  for f in "$_PT_WORK_DIR/sensors/${_PT_PREV_PHASE}"* "$_PT_WORK_DIR/.tmp.${_PT_PREV_PHASE}".*; do
    [ -e "$f" ] && _PT_DISCARDED="${_PT_DISCARDED:+$_PT_DISCARDED,}$f"
  done
  # Sentinel for in-memory LLM context that was compacted at this boundary.
  _PT_DISCARDED="${_PT_DISCARDED:+$_PT_DISCARDED,}.deep-work/$SESSION_ID/.compacted/${_PT_PREV_PHASE}-llm-context"

  # Emit. --preserved accepts empty string (helper splits to empty array per
  # schema 'preserved_artifact_paths can be empty array').
  node "$EMIT_SCRIPT" \
    --trigger phase-transition \
    --output "$_PT_OUT" \
    --preserved "$_PT_PRESERVED_FILTERED" \
    --discarded "$_PT_DISCARDED" \
    --strategy key-artifacts-only \
    --session-id "$SESSION_ID" >/dev/null 2>&1 || true
) 2>>"$PROJECT_ROOT/.claude/deep-work-guard-errors.log" || true

exit 0
