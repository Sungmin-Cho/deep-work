---
name: deep-finish
description: "Finish a deep-work session — merge, open a PR, keep the branch, or discard — and emit the M3-envelope-wrapped `session-receipt.json`. Triggers on `/deep-finish`, \"finish session\", \"wrap up session\", \"세션 마무리\", \"세션 종료\", \"PR 만들어줘\", or orchestrator auto-call after Integrate. Flags: `--skip-integrate`, `--handoff-to=<plugin>`, `--no-handoff`."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | AskUserQuestion: `outcome=merge\|pr\|keep\|discard` 분기 |
| `--skip-integrate` | Phase 5 가 에러/사용자 요청으로 중단된 경로 — Section 1c 로 강제 진행 |
| `--handoff-to=<plugin>` | 완료 후 명시된 plugin (deep-evolve / deep-wiki 등) 으로 fully-automated handoff |
| `--no-handoff` | outcome=merge/pr 이어도 handoff 제안 스킵 |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites

**Runtime dependencies (cross-platform invokers must provide)**:
- `CLAUDE_PLUGIN_ROOT` env var — absolute path to the deep-work plugin root (used by §7-Z `wrap-receipt-envelope.js` and §7-Z-A `emit-handoff.js`).
- `PROJECT_ROOT` env var — absolute path to the repository root (used by §1, §7-Z, §7-Z-A). Standalone invokers can derive via `git rev-parse --show-toplevel`.
- Node 22+ on PATH (the two hook scripts above are zero-dep Node CLIs; `package.json` declares `engines.node: ">=22"`).
- Sibling skill helper at `${CLAUDE_PLUGIN_ROOT}/skills/deep-integrate/phase5-record-error.sh` (used by §1c when `--skip-integrate` is taken with a stalled Phase 5).

> **Internal** — orchestrator가 이 파일의 로직을 참조합니다. 자동 호출이 주 경로이며, 수동 호출도 공식 경로입니다(특히 test 통과 후 세션 완료 시).
> 참조처: `${CLAUDE_PLUGIN_ROOT}/skills/deep-work-orchestrator/SKILL.md` Step 3-6 (`Read ${CLAUDE_PLUGIN_ROOT}/skills/deep-finish/SKILL.md`). `${CLAUDE_PLUGIN_ROOT}/skills/deep-test/SKILL.md`가 test pass 후 수동 호출을 안내.

# Deep Work Session Completion

Finish the current Deep Work session with an explicit branch completion workflow.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Instructions

### 1. Verify session exists

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply only its **Reusable session-state resolution** section to resolve `$STATE_FILE`; retain this skill's own no-session and standalone-mode behavior.

Read `$STATE_FILE`. If the file doesn't exist:

```
ℹ️ 활성화된 Deep Work 세션이 없습니다.
   새 세션을 시작하려면: /deep-work <작업 설명>
```

`current_phase` 분기:
- `current_phase`가 empty → 위와 동일 "세션 없음" 메시지.
- `finished_at` 필드 **존재** → 이미 종료된 세션. "ℹ️ 이 세션은 이미 종료되었습니다 (finished_at: <값>). 새 세션을 시작하려면 `/deep-work <작업>`을 실행하세요." → exit 0. (`--skip-integrate` 분기가 finalized 세션을 재실행하지 않도록 최상위 가드)
- `current_phase == "idle"` + `phase5_completed_at` 필드 **존재** → Phase 5 완료 상태로 간주하고 **정상 진행** (Section 1a, 2, 3... 계속).
- `current_phase == "idle"` + `phase5_completed_at` **부재**:
  - `phase5_entered_at` 존재:
    - `$ARGUMENTS`에 `--skip-integrate` 있음 → **정상 진행**. Phase 5가 에러/사용자 요청으로 중단되어 orchestrator가 강제 finish를 호출한 경로.
      **Defensive guard**: 아래 `WORK_DIR` resolve(Section 1 말미) 이후 Section 2로 진입하기 전에 Section 1c를 실행하여 `integrate-loop.json`의 `terminated_by`를 `"error"`로 defensively 기록한다. 이 로직은 Section 1a(Phase 5 힌트) **다음**, Section 2 **이전**에 배치한다.
    - `--skip-integrate` 없음 → **Phase 5가 중단된 상태**. 메시지: "Phase 5 Integrate 루프가 중단되었습니다. `/deep-integrate`로 재진입하거나 `--skip-integrate`와 함께 `/deep-finish`를 다시 실행하세요." → exit 0.
  - `phase5_entered_at` 부재 → 기존 "세션 없음" 메시지.
- 그 외 (`brainstorm`/`research`/`plan`/`implement`/`test`) → 정상 진행.

Extract: `work_dir`, `task_description`, `worktree_enabled`, `worktree_path`, `worktree_branch`, `worktree_base_commit`.

Resolve `$WORK_DIR` (used by Section 1a below):

```bash
WORK_DIR="${PROJECT_ROOT}/$(read_frontmatter_field "$STATE_FILE" work_dir)"
```

Phase 5 Integrate 힌트(§1a)와 Phase 5 defensive error marker(§1c) 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-finish/references/phase5-markers.md`
를 읽고 그대로 수행한다. Section 1 말미의 `WORK_DIR` resolve 이후, Section 2 진입 전에 실행한다.

### 2. Read all receipts and generate session receipt

Scan `$WORK_DIR/receipts/` for all `SLICE-*.json` files. For each:
- Count completed (status: "complete") vs total
- Aggregate TDD compliance (strict/relaxed/coaching/override/spike counts)
- Aggregate model usage (haiku/sonnet/opus counts)
- Sum estimated_cost across slices

**Generate `$WORK_DIR/session-receipt.json`** (derived cache — canonical source
is slice receipts) **wrapped in the M3 cross-plugin envelope** (deep-work
v6.5.0; cf. `deep-suite/docs/envelope-migration.md` §1).

> **Two-step protocol**: the legacy session-receipt body ("payload")
> is built first into a temp file; quality fields (Section 2-1) and
> outcome/outcome_ref (Section 7) are appended to that **same payload temp
> file**; only at the end of Section 7 does the wrap helper produce the final
> envelope-wrapped `session-receipt.json` with a single `run_id`. This avoids
> re-generating ULIDs as outcome data lands.

#### Step 2.1 — write the session-receipt payload to a temp file

Use the `Write` tool to emit the **payload** (legacy session-receipt body) to a
temp path, e.g. `$WORK_DIR/.session-receipt.payload.json`:

```json
{
  "schema_version": "1.0",
  "canonical": false,
  "derived_from": "receipts/SLICE-*.json",
  "session_id": "dw-[timestamp]",
  "task_description": "[from state]",
  "started_at": "[from state]",
  "finished_at": "[now ISO]",
  "worktree_branch": "[from state or empty]",
  "worktree_base_commit": "[from state or empty]",
  "outcome": null,
  "outcome_ref": null,
  "slices": {
    "total": N,
    "completed": N,
    "spike": N
  },
  "tdd_compliance": {
    "strict": N, "relaxed": N, "override": N, "spike": N, "coaching": N
  },
  "model_usage": {
    "haiku": N, "sonnet": N, "opus": N, "main": N
  },
  "total_estimated_cost": null,
  "total_files_changed": N,
  "total_tests": N,
  "total_tests_passed": N,
  "quality_gates": {
    "receipt_completeness": "PASS/FAIL",
    "verification_evidence": "PASS/FAIL"
  },
  "evaluation": {
    "evaluator_model": "sonnet",
    "plan_review_retries": 0,
    "test_retry_count": 0,
    "assumption_adjustments": []
  },
  "contract_compliance": {
    "total_contracts": 0,
    "contracts_met": 0
  },
  "deep_work_version": "6.5.0"
}
```

> **v6.12.0**: Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/model-routing-guide.md#model-routing-state-decode-v612`)로
> routing carrier를 decode한다. decoded meta가 있으면 payload의 optional `model_routing_meta`
> 필드에 포함하고, 부재/손상 시 생략한다. deep-suite payload-registry minor bump는 suite 측 후속 작업.

`schema_version` MUST be the literal string `"1.0"`. Section 2-1 will add
`quality_score`, `quality_breakdown`, and `quality_diagnostics` to this same
payload temp file. Section 7's option-specific blocks update
`outcome`/`outcome_ref` on the same temp file. The final envelope wrap is
performed by Section 7-Z below — exactly once per session.

Session Quality Score(§2-1) 계산 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-finish/references/session-quality-score.md`
를 읽고 그대로 수행한 뒤, 결과를 아래 payload에 채운다.

### Optional `methodology_shadow`

state에 `risk_profile_json`이 존재하면 payload에 다음 optional 블록을 추가한다 (부재 시 생략 — forward-compatible, 스키마 registry 새 minor 불필요):

```yaml
methodology_shadow:
  schema_version: 1
  risk:
    provisional_class: <risk_profile_json.provisional.class 또는 null>
    authoritative_class: <risk_profile_json.authoritative.class 또는 null>
    final_score: <authoritative.score ?? provisional.score ?? null>
    hard_triggers: <authoritative.hard_triggers의 id 목록 ?? provisional 것 ?? []>
  policy:
    recommended_profile: <policy_shadow_json.authoritative.profile ?? .provisional.profile ?? null>
    based_on: <해당 stage>
  routing_diff_count: <위 stage routing_diff에서 excluded_reason 없이 actual_tier ≠ recommended_tier인 항목 수>
  errors_count: <risk_profile_json.errors 배열 길이>
```

JSON 파싱 실패 시 경고 1줄 + 블록 생략 (fail-open).

The final envelope wrap (Section 7-Z) consumes this payload as-is, so any
field placed here ends up under `envelope.payload` in the wrapped receipt.

### Optional `methodology_policy` and `review_execution` (v6.12.0)

State의 `methodology_policy_json`과 `review_execution_json`을 각각 `JSON.parse`한다.
유효한 필드만 session-receipt payload에 아래 optional 블록으로 추가하고, 부재 시
해당 블록을 생략한다. 파싱 실패는 경고 1줄 후 블록만 생략하는 fail-open이며 기존
`methodology_shadow` 블록은 그대로 유지한다.

```yaml
methodology_policy:
  schema_version: 1
  mode: adaptive
  risk_class: high
  profile: strict
  floors_applied: { implement: { from: standard, to: deep } }
review_execution:
  schema_version: 1
  points_summary:
    final: { mode: dual, completed: 2, failed: 0, rounds: 1, verdict: PASS }
  reviewer_failures:
    - { point: final, role: executability, channel: codex-cli, reason: timeout, fallback_used: true }
  degraded_events: []
  risk_acceptances: []
```

`points_summary`는 각 point의 mode, 완료/실패 reviewer 수, rounds, verdict를 집계한다.
`reviewer_failures`에는 실패/timeout/skipped reviewer와 실제 fallback 사용 여부를
보존한다. 두 블록은 forward-compatible optional payload이므로 receipt schema version은
계속 문자열 `"1.0"`을 사용한다.

**Authoritative JSONL write**: After calculating the quality score, write the finalized session record to `harness-sessions.jsonl`. This is the authoritative write — it includes the `quality_score` field and `status: "finalized"`.

**Read assumption snapshot**: Read `assumption_snapshot` from the state file (written at session init by deep-work.md — see Task 7). Include it in the JSONL entry.

**JSONL path**: Use the shared path `.deep-work/harness-history/harness-sessions.jsonl` (NOT the per-session folder). This matches all consumers (deep-status, deep-assumptions, deep-report).

**Upsert logic** — use Bash to perform atomic upsert with lock:

```bash
# Variables: SESSION_ID, ENTRY (the full JSON line), JSONL_FILE
JSONL_FILE=".deep-work/harness-history/harness-sessions.jsonl"
LOCKDIR="${JSONL_FILE}.lock.d"

# Acquire lock (consistent with session-end.sh pattern)
RETRIES=3
while [ "$RETRIES" -gt 0 ]; do
  if mkdir "$LOCKDIR" 2>/dev/null; then
    break
  fi
  RETRIES=$((RETRIES - 1)); sleep 0.1
done

# Upsert: remove provisional line if exists, then append finalized
if [ -f "$JSONL_FILE" ] && grep -qF "\"session_id\":\"$SESSION_ID\"" "$JSONL_FILE" 2>/dev/null; then
  # Replace: filter out old line, append new
  grep -vF "\"session_id\":\"$SESSION_ID\"" "$JSONL_FILE" > "${JSONL_FILE}.tmp" 2>/dev/null
  echo "$ENTRY" >> "${JSONL_FILE}.tmp"
  mv "${JSONL_FILE}.tmp" "$JSONL_FILE"
else
  # Append new
  echo "$ENTRY" >> "$JSONL_FILE"
fi

# Release lock
rmdir "$LOCKDIR" 2>/dev/null || true
```

The entry JSON includes all existing fields from session-end.sh PLUS: `quality_score`, `quality_breakdown`, `status: "finalized"`, and `assumption_snapshot`.

### 3. Display session summary

```
Deep Work 세션 요약
   Task: [task_description]
   Branch: [worktree_branch or current branch]
   Slices: [completed]/[total] 완료
   TDD: [strict_count] strict, [override_count] override, [spike_count] spike
   Model: haiku×[n] sonnet×[n] opus×[n]
   Quality gates: [PASS/FAIL summary]
   Quality Score: [score]/100
```

If any slice has `slice_confidence: "done_with_concerns"`:

```
   Slice Confidence:
      ✅ done: [N]개
      ⚠️ done_with_concerns: [N]개

   Concerns:
      SLICE-NNN: [concern 1], [concern 2]
      SLICE-MMM: [concern 1]
```

If all slices are `done`, skip this section.

### 4. Partial session check

If `slices.completed < slices.total`:

```
⚠️ [completed]/[total] 슬라이스만 완료되었습니다.
   미완료 슬라이스가 있는 상태에서 진행합니다.
```

The session receipt will include `"partial": true`.

### 4a. Unified finish gate

completion option을 제시하기 전에 state의 `review_execution_json`을 parse하고
`finishGateAllowed(reviewExecutionJson)`을 호출한다. 반환값만 외부 변경 권한의 정본이다.
`blocking.external_change_lock === true`이면 PR/merge/push 제안과 실행을 모두 차단한다.
`blocking.missing_acks`의 각 review point를 사용자에게 표면화하고 필요한 Critical human ack를
받은 뒤 state를 갱신해 함수를 다시 호출한다. allowed가 true가 되기 전에는 Section 5-7로
진행하지 않는다. keep/discard처럼 외부 변경을 만들지 않는 종료도 잠금 사유를 숨기지 않는다.

### 5. Check gh CLI availability

```bash
which gh 2>/dev/null
```

If `gh` is not available, the PR option will be marked as unavailable.

완료 옵션 제시(§6)와 선택 실행(§7 — merge / PR / branch 유지 / 폐기) 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-finish/references/completion-options.md`
를 읽고 그대로 수행한다. §4a Unified finish gate를 통과한 뒤에만 진입한다.

### 7-Z. Envelope wrap

Now that the payload temp file has all fields (Section 2 base + Section 2-1
quality + Section 7 outcome), wrap it in the M3 envelope and write the final
`session-receipt.json`. Use the `Bash` tool with the helper script:

> **Important — failure semantics**: the snippet uses `set -euo pipefail` so
> that any sub-command failure aborts before `rm -f` runs. The cleanup is
> gated with an `if/then/else` block (equivalent to `&&` for our purposes
> under `set -e`) so that on helper failure the payload temp file is
> **preserved** for retry. To re-attempt a failed wrap, simply re-execute
> Section 7-Z (Section 2/2-1/7 do not re-run; the same payload is used).

```bash
set -euo pipefail

# Resolve session_id with the same fallback chain as Section 1: env var →
# .claude/deep-work-current-session pointer file (omit flag if neither
# resolves rather than passing the empty string — handoff §4 W2).
SESSION_ID="${DEEP_WORK_SESSION_ID:-}"
if [ -z "$SESSION_ID" ] && [ -f "$PROJECT_ROOT/.claude/deep-work-current-session" ]; then
  SESSION_ID="$(tr -d '\n\r' < "$PROJECT_ROOT/.claude/deep-work-current-session" || true)"
fi

EVOLVE_PATH=""
if [ -f "$PROJECT_ROOT/.deep-evolve/current.json" ]; then
  EVOLVE_SID=$(node -e '
    try {
      const raw = require("fs").readFileSync(process.argv[1], "utf8");
      const obj = JSON.parse(raw);
      const v = (obj && typeof obj === "object" && typeof obj.session_id === "string")
        ? obj.session_id : "";
      console.log(v);
    } catch (_) { console.log(""); }
  ' "$PROJECT_ROOT/.deep-evolve/current.json" || true)
  if [ -n "$EVOLVE_SID" ] && [ -f "$PROJECT_ROOT/.deep-evolve/$EVOLVE_SID/evolve-insights.json" ]; then
    EVOLVE_PATH="$PROJECT_ROOT/.deep-evolve/$EVOLVE_SID/evolve-insights.json"
  fi
fi

HARN_PATH=""
if [ -f "$PROJECT_ROOT/.deep-dashboard/harnessability-report.json" ]; then
  HARN_PATH="$PROJECT_ROOT/.deep-dashboard/harnessability-report.json"
fi

# Resolve the session state file so the wrapper can read the deep-test
# `test_passed` marker deterministically (see the test-verification gate note
# below). Same session_id → deep-work.<sid>.md, else the legacy local path.
STATE_FILE_PATH=""
if [ -n "$SESSION_ID" ] && [ -f "$PROJECT_ROOT/.claude/deep-work.$SESSION_ID.md" ]; then
  STATE_FILE_PATH="$PROJECT_ROOT/.claude/deep-work.$SESSION_ID.md"
elif [ -f "$PROJECT_ROOT/.claude/deep-work.local.md" ]; then  # legacy fallback path
  STATE_FILE_PATH="$PROJECT_ROOT/.claude/deep-work.local.md"   # legacy fallback
fi

WRAP_ARGS=(
  --artifact-kind session-receipt
  --payload-file "$WORK_DIR/.session-receipt.payload.json"
  --output "$WORK_DIR/session-receipt.json"
  --source-artifacts-glob "$WORK_DIR/receipts/SLICE-*.json"
)
[ -n "$SESSION_ID" ] && WRAP_ARGS+=(--session-id "$SESSION_ID")
[ -n "$EVOLVE_PATH" ] && WRAP_ARGS+=(--source-evolve-insights "$EVOLVE_PATH")
[ -n "$HARN_PATH" ] && WRAP_ARGS+=(--source-harnessability "$HARN_PATH")
[ -n "$STATE_FILE_PATH" ] && WRAP_ARGS+=(--session-state-file "$STATE_FILE_PATH")

# Cleanup payload temp file ONLY on helper success — preserve on failure for
# retry. The `set -e` guarantees abort if the
# helper exits non-zero before this line runs.
if node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-receipt-envelope.js" "${WRAP_ARGS[@]}"; then
  rm -f "$WORK_DIR/.session-receipt.payload.json"
else
  echo "wrap helper failed — preserving $WORK_DIR/.session-receipt.payload.json for retry; re-run Section 7-Z to retry." >&2
  exit 1
fi
```

The helper:
- Generates `envelope.run_id` (ULID), sets `producer = "deep-work"`,
  `artifact_kind = "session-receipt"`, `schema.name = "session-receipt"`.
- Sets `envelope.parent_run_id` from the consumed evolve-insights envelope's
  `run_id` (handoff §3.3 cross-plugin chain) when `--source-evolve-insights`
  is passed and the file is itself an envelope.
- Adds slice receipts' `run_id` (when envelope-wrapped) plus
  `harnessability-report.json`'s `run_id` to `provenance.source_artifacts[]`
  (intra-plugin chain + multi-source aggregation).
- **Test-verification signal (deterministic)**: when `--session-state-file` is
  passed, the helper reads the session state's `test_passed` frontmatter marker
  (set by deep-test §All Pass) and stamps `x-test-verified: true|false` on every
  session-receipt payload. This makes the evidence chain carry the deep-test →
  deep-finish verification result in code rather than relying on prompt
  compliance. The helper does **not** rewrite `outcome`: by the time §7-Z runs a
  `merge`/`pr` is already physically complete (worktree removed + `branch -d`, or
  `gh pr create`), so demoting it would misreport a done action to
  completion-polling / aggregation consumers. The receipt records the **fact**
  (`outcome`) and the **verification signal** (`x-test-verified`) separately —
  downstream consumers judge trustworthiness from the pair.

Cross-plugin handoff emit(§7-Z-A)은 다음 **두 경로 중 하나라도** 성립하면 수행한다:

- `$ARGUMENTS`에 `--handoff-to=<plugin>`가 있다 (명시 경로 — 사용자 확인 없이 자동 실행).
- `outcome`이 `merge` 또는 `pr`이고 `$ARGUMENTS`에 `--no-handoff`가 **없다**
  (대화형 경로 — reference가 AskUserQuestion으로 인계 여부를 묻는다).

둘 중 하나라도 성립하면
`${CLAUDE_PLUGIN_ROOT}/skills/deep-finish/references/handoff-emit.md`
를 읽고 그대로 실행한다. 두 트리거 중 어느 쪽인지 판정하고 `HANDOFF_TO`를 정하는 것은
reference가 담당한다.

건너뛰고 §8로 진행하는 경우는 두 가지뿐이다: `--handoff-to`가 **없고** `--no-handoff`가 있을 때
(대화형 제안만 스킵), 또는 `outcome`이 `keep`/`discard`이면서 `--handoff-to`도 없을 때.
`--handoff-to`는 명시 지시이므로 `--no-handoff`와 함께 주어져도 수행한다 — `--no-handoff`는
대화형 경로에만 걸린다.

### 8. Finalize state

Update `$STATE_FILE`:
- `current_phase: "idle"`
- `finished_at: [now ISO]`

#### 8a. Unregister session from registry

If the session has a `session_id` field in the state file:

```bash
unregister_session "$SESSION_ID"
```

Delete the pointer file if it points to this session:
```bash
CURRENT_POINTER=$(read_session_pointer)
if [ "$CURRENT_POINTER" = "$SESSION_ID" ]; then
  rm -f "$PROJECT_ROOT/.claude/deep-work-current-session"
fi
```

Display:

```
✅ Deep Work 세션이 완료되었습니다.
   결과: [merge/PR/keep/discard]
   Receipt: [work_dir]/session-receipt.json
```
