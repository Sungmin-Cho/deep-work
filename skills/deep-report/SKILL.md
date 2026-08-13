---
name: deep-report
description: "Generate or view the deep-work session report — lifecycle, slice summary, evidence trail, TDD compliance, model usage. Triggers on `/deep-report`, `/deep-status --report`, \"session report\", \"deep-work report\", \"세션 리포트\", \"세션 보고서\", \"리포트 생성\". Sub-page of the deep-status hub."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Default — current session 의 report 생성/regenerate |
| `<session-id>` | 명시 세션의 report |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites

**Hub-spoke 관계**: 본 skill 은 `deep-status` hub 의 sub-page 입니다 — `/deep-status --<flag>` 가 본문 로직을 inline Read 하여 실행하는 것이 주 경로이며, 직접 호출도 동일하게 지원됩니다.


> **Internal** — `/deep-status --report`가 이 파일의 로직을 `Read`하여 실행합니다. 자동 호출이 주 경로이며, 직접 호출도 지원됩니다.
> 참조처: `${CLAUDE_PLUGIN_ROOT}/skills/deep-status/SKILL.md` §8 (`Read ${CLAUDE_PLUGIN_ROOT}/skills/deep-report/SKILL.md and follow its logic`).

# Deep Work Session Report

Generate or regenerate a comprehensive report for the current (or most recent) Deep Work session.

## v7 governed report path

For a strict-spec session, the production dispatcher is the sole report generator:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-work-runtime.js" report generate --state "$STATE_FILE"
```

Use the generated `report.md` and returned `projection_sha256` as authoritative.
The report embeds the exact canonical progress projection used by status/dashboard.
If governed loading or publication fails, report the error and stop. Do not
manually combine state fields or artifacts. The instructions below are the legacy
compatibility path for sessions without strict-spec binding.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Instructions

### 1. Read state file

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply only its **Reusable session-state resolution** section to resolve `$STATE_FILE`; retain this skill's own no-session and standalone-mode behavior.

Read `$STATE_FILE` to get session metadata.

If the file doesn't exist, inform the user:
```
ℹ️ 활성화된 Deep Work 세션이 없습니다.

새 세션을 시작하려면: /deep-work <작업 설명>
```

Extract `work_dir` from the state file. If missing, default to `deep-work` (backward compatibility).
Set `WORK_DIR` to this value.

### 2. Check if report already exists

Check if `$WORK_DIR/report.md` exists.

- If it exists, ask the user:
  ```
  기존 리포트가 있습니다: $WORK_DIR/report.md

  1. 기존 리포트 표시
  2. 리포트 재생성 (현재 상태 기반)
  ```
  - If the user chooses to view, read and display the report content.
  - If the user chooses to regenerate, proceed to Step 3.

- If it doesn't exist, proceed to Step 3.

### 3. Read session artifacts

Read all available session artifacts:
- `$STATE_FILE` — session state, timestamps, metadata
- `$WORK_DIR/research.md` — research findings (if exists)
- `$WORK_DIR/plan.md` — plan and implementation checklist (if exists)
- `$WORK_DIR/test-results.md` — test results (if exists)
- `$WORK_DIR/quality-gates.md` — quality gate results (if exists)
- `$WORK_DIR/insight-report.md` — insight analysis results (if exists)
- `$WORK_DIR/file-changes.log` — file modification tracking log (if exists)
- `$WORK_DIR/plan-diff.md` — plan diff visualization (if exists)
- `.deep-work/harness-history/harness-sessions.jsonl` — assumption engine session history (if exists)

### 4. Calculate phase durations

From the state file, calculate time spent in each phase:
- Brainstorm: `brainstorm_completed_at` - `brainstorm_started_at` (if both exist; "Skipped" if brainstorm was not run)
- Research: `research_completed_at` - `research_started_at`
- Plan: `plan_completed_at` - `plan_started_at`
- Implement: `implement_completed_at` - `implement_started_at`
- Test: `test_completed_at` - `test_started_at`
- Total: `test_completed_at` (or current time) - `started_at`

If timestamps are empty, show "N/A" for that phase.

### 5. Generate report

Write `$WORK_DIR/report.md` with the following structure:

````markdown
# Deep Work Session Report

## Session Overview
| Field | Value |
|-------|-------|
| Task | [task_description] |
| Work Directory | [work_dir] |
| Mode | Solo / Team |
| Project Type | Existing / Zero-Base |
| Git Branch | [git_branch or "N/A"] |
| Started | [started_at] |
| Completed | [current timestamp or "In Progress"] |
| Current Phase | [current_phase] |
| Evaluator Model | [evaluator_model or "default"] |
| Plan Iterations | [iteration_count] |
| Plan Auto-Loop | [plan_review_retries]/[plan_review_max_retries] |
| Test Auto-Loop | [test_retry_count]/[max_test_retries] |
| Model Routing | Research: [model], Plan: 현재 세션, Implement: [model], Test: [model] |
| Assumption Adjustments | [list of assumption adjustments applied, or "None"] |

Model Routing 행은 Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/model-routing-guide.md#model-routing-state-decode-v612`)의
scalar-first decode 결과로 채운다. decode 실패 시 phase 기본값을 사용하고 경고를 보고서에 남긴다.

## Phase Duration
| Phase | Started | Completed | Duration |
|-------|---------|-----------|----------|
| Brainstorm | [timestamp] | [timestamp] | [duration or "Skipped"] |
| Research | [timestamp] | [timestamp] | [duration] |
| Plan | [timestamp] | [timestamp] | [duration] |
| Implement | [timestamp] | [timestamp] | [duration] |
| Test | [timestamp] | [timestamp] | [duration] |
| **Total** | | | **[total duration]** |

## Brainstorm Summary
[If brainstorm.md exists: chosen approach, key decisions, success criteria]
[If brainstorm was skipped: "Brainstorm phase skipped (--skip-brainstorm)."]

## Research Summary
[3-5 bullet points summarizing the key findings from research.md]
[If research.md doesn't exist: "Research phase not yet completed (or skipped)."]

## Plan Summary
[Approach chosen, key architectural decisions, alternatives considered]
[If plan.md doesn't exist: "Planning phase not yet completed."]

## Plan Iterations
[If plan-diff.md exists in $WORK_DIR:
| Version | 주요 변경 | 리스크 변경 |
|---------|----------|------------|
[Parse from plan-diff.md]
]
[If plan-diff.md does not exist: "단일 반복 (재작성 없음)"]

### Plan Auto-Loop History
[If plan_review_retries > 0 from state file:]
| Attempt | Score | Issues |
|---------|-------|--------|
| 1 | [score]/10 | [list of issues from that attempt] |
| 2 | [score]/10 | [resolved issues or remaining] |
[Parse from plan review history in state file or plan-review.json]

[If plan_review_retries == 0: "Auto-loop 미사용 (첫 시도 통과)"]

## Implementation Results
| # | Task | File | Status | Notes |
|---|------|------|--------|-------|
| 1 | [description] | [path] | ✅/❌/⬜ | [notes] |
[Parse checklist from plan.md. ✅ = completed, ❌ = issue, ⬜ = not started]

**Contract Compliance**: [N]/[total] contracts verified
[Parse from slice receipts — count slices where all contracts are met vs total contracts defined]

## Files Changed

If `$WORK_DIR/file-changes.log` exists:
- Parse unique file paths from the log
- Cross-reference with `git status` to categorize as Created/Modified/Deleted
- Show modification count per file (how many times each file was edited during implementation)

If `file-changes.log` doesn't exist, fall back to `git diff --name-only`.

### Created
- [list of new files]

### Modified
- [list of modified files] (수정 횟수: N회)

### Deleted
- [list of deleted files, if any]

## Verification Results
| Check | Result |
|-------|--------|
| Type Check | ✅ Pass / ❌ Fail / ⬜ N/A |
| Lint | ✅ Pass / ❌ Fail / ⬜ N/A |
| Tests | ✅ Pass / ❌ Fail / ⬜ N/A |
| Build | ✅ Pass / ❌ Fail / ⬜ N/A |
[If test-results.md exists, use its data. Otherwise show ⬜ N/A for all]

## Quality Gate Results
[If $WORK_DIR/quality-gates.md exists, read and include its latest attempt table here]
[If quality-gates.md does not exist: "Quality Gates 미정의 — 기본 자동 감지 사용"]

## Review Results

### Structural Reviews
| Phase | Score | Iterations | Timestamp |
|-------|-------|------------|-----------|
| Brainstorm | [N]/10 | [N] | [time] |
| Research | [N]/10 | [N] | [time] |
| Plan | [N]/10 | [N] | [time] |

### Adversarial Review (Plan)
- **Models**: [Claude + Codex / Claude + Gemini / Claude only / 미실행]
- **Scores**: Claude [N]/10, [Model] [N]/10
- **Consensus**: [N]건
- **Conflicts**: [N]건 (resolved: [N], waived: [N])
- **Review Gate**: [통과 ✅ / 우회됨 ⚠️ / 미실행 ⬜]

(If review_state is "skipped": `리뷰: 스킵됨 (--skip-review)`)
(If cross_model not available: `크로스 모델: 도구 미설치 (structural review만 실행)`)

## Insight Analysis
[If $WORK_DIR/insight-report.md exists, include the "종합 인사이트 요약" section here]
[If insight-report.md does not exist: "Insight 분석 미실행"]

## Assumption Health

Generate assumption health data by running the assumption engine:

```bash
# 1) plugin root를 실제로 해석하고, 해석에 실패하면 실행하지 않는다.
PLUGIN_ROOT="$(cd "${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT unset — abort}" 2>/dev/null && pwd -P)"
[ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/assumptions.json" ] || { echo "plugin root 해석 실패 — 중단" >&2; exit 1; }

# 2) 경로는 argv로 넘기고 JSON은 JSON.stringify로 만든다.
#    (경로를 작은따옴표 JSON 안에 직접 쓰면 셸이 ${...}를 확장하지 않아
#     리터럴 이름의 경로가 워크스페이스 기준으로 읽힌다.)
node -e 'process.stdout.write(JSON.stringify({action:"report",registryPath:process.argv[1],historyPath:process.argv[2],options:{splitByModel:true}}))' \
  "$PLUGIN_ROOT/assumptions.json" \
  ".deep-work/harness-history/harness-sessions.jsonl" \
  | node "$PLUGIN_ROOT/hooks/scripts/assumption-engine.js"
```

`$PLUGIN_ROOT`는 위에서 `${CLAUDE_PLUGIN_ROOT}`를 해석한 절대 경로다 (`assumptions.json`이 있는 디렉터리). 해석에 실패하거나 결과가 plugin root 밖이면 실행하지 말고 중단한다.

[If harness-sessions.jsonl exists and engine returns data:]

| Assumption | Confidence | Category | Verdict | Details |
|-----------|-----------|----------|---------|---------|
| phase_guard_blocks_edits | 0.82 | HIGH | KEEP | [S]S/[W]W/[N]N |
| tdd_required_before_implement | 0.56 | MEDIUM | CONSIDER | [S]S/[W]W/[N]N |
| research_required_before_plan | 0.75 | HIGH | KEEP | [S]S/[W]W/[N]N |
| cross_model_review | — | INSUFFICIENT | — | [N]/[min] sessions |
| receipt_collection | 0.90 | HIGH | KEEP | [S]S/[W]W/[N]N |

**Proposed Changes**: [If any proposed changes from report: list them. Otherwise: "None"]

**This Session's Harness Metadata**:
- Slices with harness_metadata: [N]/[total]
- TDD overrides: [count]
- Bugs caught in RED: [count]
- Research references used: [count]
- Cross-model unique findings: [count]

[Aggregate harness_metadata from $WORK_DIR/receipts/SLICE-*.json for the
current session. **Envelope-aware unwrap**: receipts 는 M3 envelope
(`{schema_version: "1.0", envelope: {...}, payload: {...}}`) 로 emit 된다.
각 파일을 읽을 때 envelope 형태이면 identity guard
(`envelope.producer === "deep-work"` ∧
`envelope.artifact_kind === "slice-receipt"` ∧
`envelope.schema.name === envelope.artifact_kind`) 검증 후 `payload` 를
receipt body 로 사용. mismatch 는 skip + 경고. legacy 는 root 그대로 사용.
`harness_metadata` 는 payload root 에 있다.]

[If harness-sessions.jsonl does not exist: "Assumption 엔진 기록 없음 — 세션 완료 후 자동 수집됩니다."]

## Test Retry History
[If test_retry_count > 0, summarize each attempt from test-results.md]
| Attempt | Result | Failed Items |
|---------|--------|-------------|
| 1 | ❌ | [summary] |
| 2 | ✅ | All passed |

## Issues & Notes
[From plan.md ## Issues Encountered section, if any. "None" if no issues.]

## Team Mode Details (if applicable)
| Item | Value |
|------|-------|
| Agents | N |
| Cross-review Rounds | N |
| Issues Found/Fixed | N |
```

### 6. Display confirmation

```
세션 리포트가 생성되었습니다!

위치: $WORK_DIR/report.md

세션 상태: [current_phase]
작업: [task_description]
총 소요 시간: [total duration]

리포트를 검토하고 필요 시 `/deep-report`로 재생성하거나, `/deep-status --report`로 확인할 수 있습니다.
```

### 7. Git commit suggestion (if applicable)

If `git_branch` is set in the state file and `current_phase` is `idle`:

```
변경사항을 커밋할까요?
   브랜치: [git_branch]
   변경 파일: [N]개

제안 커밋 메시지:
  feat: [task_description 기반 자동 생성]
````

If the user agrees, create the commit. If not, skip.
