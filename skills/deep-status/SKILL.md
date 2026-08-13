---
name: deep-status
description: "Current deep-work session status — dashboard, badge, tree, or routing to the receipts / history / report / assumptions sub-pages. Triggers on `/deep-status`, \"session status\", \"deep-work status\", \"세션 상태\", \"세션 현황\", \"상태 확인\". Flags: `--compare`, `--receipts`, `--history`, `--report`, `--assumptions`, `--all`, `--tree`, `--badge`, `--risk`."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Default status dashboard |
| `--compare` | Fork session 비교 (parent vs forks) |
| `--receipts` | deep-receipt sub-skill 호출 (§6) |
| `--history` | deep-history sub-skill 호출 (§7) |
| `--report` | deep-report sub-skill 호출 (§8) |
| `--assumptions` | deep-assumptions sub-skill 호출 (§9) |
| `--risk` | Shadow risk/policy 표시 (§13) |
| `--all` | 4 sub-page 모두 순차 실행 |
| `--tree` | Fork tree 출력 |
| `--badge` | Shields.io 호환 badge 출력 |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites

**Hub-spoke 관계**: 본 skill 은 `deep-receipt` / `deep-history` / `deep-report` / `deep-assumptions` 4 개 sub-skill 의 hub 입니다 — 본문 §6 ~ §9 가 각 sub-skill 의 SKILL.md 를 inline Read 하여 로직을 실행합니다. 4 sub-skill 은 standalone 으로도 호출 가능합니다.

# Deep Work Status

Display the current state of the Deep Work session and session history.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Instructions

### 0. Check for compare mode

`$ARGUMENTS`에 `--compare`가 있으면
`${CLAUDE_PLUGIN_ROOT}/skills/deep-status/references/compare-mode.md`
를 읽고 그대로 수행한 뒤 종료한다. 없으면 §0-1로 진행한다.

### 0-1. Parse flags

Parse `$ARGUMENTS` for the following flags. If multiple flags are provided, execute each in order.

| Flag | Effect |
|------|--------|
| `--receipts` | Show receipt dashboard |
| `--receipts SLICE-NNN` | Show specific slice receipt detail |
| `--receipts --export=json` | Export all receipts as single JSON |
| `--receipts --export=md` | Export as markdown (for PR descriptions) |
| `--receipts --export=ci` | Export CI bundle |
| `--history` | Show cross-session trends |
| `--report` | Show/generate session report |
| `--assumptions` | Show assumption health report |
| `--assumptions --verbose` | Per-signal per-session breakdown |
| `--assumptions --rebuild` | Regenerate JSONL from receipts, then show report |
| `--risk` | Show shadow risk profile & policy recommendation |
| `--badge` | Generate shields.io badge markdown |
| `--tree` | Fork relationship tree visualization |
| `--all` | Show all sessions dashboard (multi-session) + all flags |
| `--compare` | Compare two sessions (existing, handled in Section 0) |

If no flags are provided (and no `--compare`), show the default view only (Steps 1-5).
If a flag is provided, execute the corresponding section after the default view.

### 1. Check if a session exists (multi-session aware)

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply only its **Reusable session-state resolution** section to resolve `$STATE_FILE`; retain this skill's own no-session and standalone-mode behavior.

If resolution returns `none` or `invalid-explicit`, display:

```
ℹ️ 활성화된 Deep Work 세션이 없습니다.

새 세션을 시작하려면: /deep-work <작업 설명>
```

If flags were provided (`--history`, `--assumptions`, `--receipts`, `--report`, `--all`):
- Skip the default view (Steps 2-4) but still execute the corresponding flag handler sections (Steps 6-10). These features can work without an active session by reading historical data from `.deep-work/` directory.

If no flags were provided:
- Skip to [Step 5: Show session history](#5-show-session-history).

### 2. Read state and artifacts

Read the resolved state file (from Step 1) to get session state.

Extract `work_dir` from the state file. If missing, default to `deep-work` (backward compatibility).
Set `WORK_DIR` to this value.

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/model-routing-guide.md#model-routing-state-decode-v612`)의
scalar-first 규칙으로 `decodedRouting`을 만든다. decode 실패 시 기본값
(Research=sonnet, Plan=현재 세션, Implement=sonnet, Test=haiku)을 표시한다.

Read `evaluator_model`, `assumption_adjustments`, `skipped_phases`, `plan_review_retries`, and `plan_review_max_retries` from the state file. If missing, default to: evaluator_model="없음", assumption_adjustments=[] (empty), skipped_phases=[] (empty), plan_review_retries=0, plan_review_max_retries=3.

Read the following files if they exist:
- `$WORK_DIR/research.md` — check if it has content
- `$WORK_DIR/plan.md` — count checklist progress
- `$WORK_DIR/report.md` — check if it exists
- `$WORK_DIR/test-results.md` — check if it exists
- `$WORK_DIR/quality-gates.md` — check if it exists
- `$WORK_DIR/insight-report.md` — check if it exists
- `$WORK_DIR/file-changes.log` — check if it exists
- `$WORK_DIR/plan-diff.md` — check if it exists
- Read `review_state`, `cross_model_enabled`, and `review_results` from state file
- Review finding은 `readFindings({workDir, point, round})`로 읽는다. canonical reviews 경로를
  우선하며 함수가 제공하는 legacy fallback(`phase-cross-review.json` →
  `adversarial-review.json`)과 `source:'legacy'` 표기를 그대로 표시한다. structural 호환
  `${phase}-review.json`은 점수 요약에만 사용한다.

### 2-1. Read sensor data

If receipts directory exists (`$WORK_DIR/receipts/`):
- Read all `SLICE-NNN.json` receipt files
- **Envelope-aware unwrap**: 각 receipt 의 root 가 M3 envelope
  형태(`schema_version === "1.0"` + `envelope` 객체 + `payload` 키)이면
  identity guard 검증 (`envelope.producer === "deep-work"` ∧
  `envelope.artifact_kind === "slice-receipt"` ∧
  `envelope.schema.name === "slice-receipt"`) 후 `payload` 를 receipt body
  로 사용. mismatch / corrupt payload 는 "foreign envelope" 경고 후 무시.
  Legacy(non-envelope) receipt 는 root 객체를 그대로 사용 (forward-compat).
- For each receipt body, extract `sensor_results` if present
- Count slices where all sensor statuses are `pass` or `not_applicable` → Sensor Clean Rate numerator
- Count total slices with sensor data → Sensor Clean Rate denominator
- Read `mutation_testing` from the state file for mutation score

If no receipt files have `sensor_results`, show "N/A ⬜" for sensor status.

### 2-2. Read health check data

Read `health_report` from the session state file. If present, extract:
- **Drift metrics**: `health_report.drift.dead_exports.count`, `health_report.drift.coverage_trend.delta`, `health_report.drift.dependency_vuln.critical`, `health_report.drift.dependency_vuln.high`, `health_report.drift.stale_config.count`
- **Fitness metrics**: `health_report.fitness.passed`, `health_report.fitness.total_rules`, `health_report.fitness.required_missing`
- **Required status**: `unresolved_required_issues` count, `acknowledged_required_issues` presence

If `health_report` is absent from the state file, show "N/A ⬜" for Health Check status.

### 3. Calculate progress

From `$WORK_DIR/plan.md`, count:
- Total tasks: number of lines matching `- [ ]` or `- [x]`
- Completed tasks: number of lines matching `- [x]`
- Progress percentage: completed / total * 100

### 4. Display status

Show a comprehensive status report. If the `team_mode` field is missing from the state file, treat it as "Solo" (backward compatibility).

**Conditional fields:**
- `평가자 모델`: Always show the evaluator_model value (or "없음" if not set).
- `Assumption 조정`: Only show if `assumption_adjustments` is non-empty. Display the count of adjustments.
- `건너뛴 단계`: Only show if `skipped_phases` is non-empty. Display the list of skipped phase names.
- `Auto-Loop` on Phase 2 line: Only show the parenthetical if `plan_review_retries` > 0 or `auto_loop_enabled` is true.

```
Deep Work 세션 상태
━━━━━━━━━━━━━━━━━━━━━━━━━━

작업: [task description]
작업 폴더: [work_dir]
시작: [started_at]
반복 횟수: [iteration_count]
작업 모드: [Solo / Team]
프로젝트 타입: [Existing / Zero-Base]
Git 브랜치: [git_branch or "없음"]
모델 라우팅: Research=[model], Plan=main (현재 세션), Implement=[model], Test=[model]
평가자 모델: [evaluator_model]
[Fork 관계 — fork_info / fork_children 가 있을 때만 이 자리에 삽입]

현재 단계: [Phase name with emoji]
   Phase 0 (Brainstorm): [✅ 완료 / ⏳ 진행중 / ⬜ 대기 / ⏭️ 생략]
   Phase 1 (Research):   [✅ 완료 / ⏳ 진행중 / ⬜ 대기]
   Phase 2 (Plan):       [✅ 승인됨 / ⏳ 진행중 / ⬜ 대기] (Auto-Loop: [plan_review_retries]/[plan_review_max_retries])
   Phase 3 (Implement):  [✅ 완료 / ⏳ 진행중 / ⬜ 대기]
   Phase 4 (Test):       [✅ 통과 / ⏳ 진행중 / ⬜ 대기 / ❌ 실패(N회)]

구현 진행률: [N/M 완료 (XX%)]
   ████████░░ XX%

Phase별 소요 시간:
   Brainstorm: [duration or "N/A" or "생략"]
   Research: [duration or "N/A"]
   Plan: [duration or "N/A"]
   Implement: [duration or "N/A"]
   Test: [duration or "N/A"]
Quality Gates: [통과 ✅ / 실패 ❌ / 미정의 ⬜]
리뷰 현황:
   Brainstorm: [N/10 (N회) ✅ / 미실행 ⬜ / 스킵 ⏭️]
   Research: [N/10 (N회) ✅ / 미실행 ⬜ / 스킵 ⏭️]
   Plan (Structural): [N/10 (N회) ✅ / 미실행 ⬜ / 스킵 ⏭️]
   Plan (Adversarial): [Claude N/10, Codex N/10 — Consensus N, Conflicts N, Waivers N / 미실행 / 도구 미설치]
크로스 모델: [codex ✅ + gemini ❌ / 모두 미설치 / 비활성화]
Assumption 조정: [N]건 적용됨
건너뛴 단계: [brainstorm, research, plan]

센서 상태:
   생태계: [ecosystem, e.g. typescript (eslint ✅, tsc ✅, stryker ❌)] [or "감지 안됨 ⬜" if no sensor data]
   Sensor Clean Rate: [N]/[total] ([N]%) [or "N/A ⬜" if no sensor data in receipts]
   Mutation Score: [N]% ([Phase 4 실행됨 / 미실행 ⬜ / not_applicable ⏭️])

Health Check:
   드리프트: dead-export {N}건 ⚠️ | coverage {+/-N}%p ✅ | vuln {N}건 🔴 | stale {N}건 ✅
   Fitness:  {N}/{M} 통과 ✅ | required_missing: {N}건

산출물:
   - $WORK_DIR/brainstorm.md: [존재함 ✅ / 없음 ⬜ / 생략 ⏭️]
   - $WORK_DIR/research.md: [존재함 ✅ / 없음 ⬜]
   - $WORK_DIR/plan.md: [존재함 ✅ / 없음 ⬜]
   - $WORK_DIR/test-results.md: [존재함 ✅ / 없음 ⬜]
   - $WORK_DIR/report.md: [존재함 ✅ / 없음 ⬜]
   - $WORK_DIR/quality-gates.md: [존재함 ✅ / 없음 ⬜]
   - $WORK_DIR/insight-report.md: [존재함 ✅ / 없음 ⬜]
   - $WORK_DIR/file-changes.log: [존재함 ✅ / 없음 ⬜]
   - $WORK_DIR/plan-diff.md: [존재함 ✅ / 없음 ⬜]

다음 행동: [안내 메시지]
```

Adjust the "다음 행동" based on the current phase:
- **brainstorm**: `자동 흐름이 brainstorm을 진행합니다. /deep-work로 시작하세요.`
- **research**: `자동 흐름이 research를 진행 중입니다.`
- **plan**: `plan 승인을 기다리고 있습니다.` (or "plan 수정이 필요하면 /deep-plan을 사용하세요" if plan exists)
- **implement**: `자동 흐름이 구현을 진행 중입니다.`
- **test**: `자동 흐름이 테스트를 진행 중입니다.` (or "자동 수정 루프가 진행 중입니다 (시도 N/3)" if test_retry_count > 0)
- **idle**: `세션이 완료되었습니다. /deep-status --report로 리포트를 확인하세요. 새 세션: /deep-work <작업>`

#### Fork 관계 표시

세션 state에 `fork_info` 또는 `fork_children`이 있을 때에만 위 템플릿의 해당 자리에
삽입한다. 렌더링 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-status/references/fork-views.md`
를 읽고 그대로 수행한다. 둘 다 없으면 그 줄을 생략한다.

### 5. Show session history

List previous session folders by scanning `.deep-work/` directory for subdirectories:

```bash
ls -d .deep-work/*/  2>/dev/null
```

If subdirectories exist, display:

```
세션 히스토리:
   - .deep-work/20260307-143022-jwt-기반-인증/ [report.md 존재 여부]
   - .deep-work/20260306-091500-api-리팩토링/ [report.md 존재 여부]
   ...

TIP: /deep-status --compare 로 두 세션을 비교할 수 있습니다.
```

For each folder, check if `report.md` exists and show:
- `(완료 - 리포트 있음)` if report.md exists
- `(산출물만 보존)` if report.md doesn't exist

If no subdirectories exist and no flat files (research.md, plan.md) exist in `.deep-work/`, skip the history section.

### 6. --receipts: Receipt Dashboard

If `$ARGUMENTS` contains `--receipts`:

Read `${CLAUDE_PLUGIN_ROOT}/skills/deep-receipt/SKILL.md` and follow its display logic inline.

If a specific slice ID follows `--receipts` (e.g., `--receipts SLICE-001`):
- Show detailed receipt for that slice (equivalent to `/deep-receipt view SLICE-NNN`)

If `--export=FORMAT` is present:
- `json`: Export all receipts as single JSON file (equivalent to `/deep-receipt export --format=json`)
- `md`: Export as markdown for PR descriptions (equivalent to `/deep-receipt export --format=md`)
- `ci`: Export CI bundle — session-receipt + all slice receipts (equivalent to `/deep-receipt export --format=ci`)

Otherwise (bare `--receipts`):
- Show the ASCII receipt dashboard (equivalent to `/deep-receipt dashboard`)

### 7. --history: Cross-Session Trends

If `$ARGUMENTS` contains `--history`:

Read `${CLAUDE_PLUGIN_ROOT}/skills/deep-history/SKILL.md` and follow its display logic inline.

If insufficient session data (fewer than 2 completed sessions in `.deep-work/harness-history/harness-sessions.jsonl`):
```
ℹ️ 세션 이력이 부족합니다 (최소 2개 완료된 세션 필요).
   /deep-work로 세션을 시작하고 완료하면 이력이 기록됩니다.
```

**Quality Score Trend**: After displaying the existing session history, also show the quality score trend:

1. Read `.deep-work/harness-history/harness-sessions.jsonl` (shared path)
2. Filter to entries with `status: "finalized"` and `quality_score` not null
3. If fewer than 2 qualifying sessions, display: `ℹ️ Quality trend는 2개 이상의 완료 세션이 필요합니다.`
4. Otherwise, invoke the assumption engine and display the ASCII quality trend chart:

```
📈 Quality Trend (최근 [N] 세션)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
100|
 80|    *  *     *  *  *
 60| *        *
 40|
 20|
   +──────────────────
    #1 #2 #3 #4 #5 #6 #7

Average: [N]/100  Trend: [↑/↓] ([+/-N])
Best: #[N] ([score])  Worst: #[N] ([score])
```

### 8. --report: Session Report

If `$ARGUMENTS` contains `--report`:

Read `${CLAUDE_PLUGIN_ROOT}/skills/deep-report/SKILL.md` and follow its logic:
- If `$WORK_DIR/report.md` exists: display its contents
- If not: generate the report following `${CLAUDE_PLUGIN_ROOT}/skills/deep-report/SKILL.md`'s structure, then display

### 9. --assumptions: Assumption Health

If `$ARGUMENTS` contains `--assumptions`:

Read `${CLAUDE_PLUGIN_ROOT}/skills/deep-assumptions/SKILL.md` and follow its logic.

Sub-flags:
- `--verbose`: Show per-signal per-session breakdown (equivalent to `/deep-assumptions report --verbose`)
- `--rebuild`: Regenerate JSONL from receipt files, then show report (equivalent to `/deep-assumptions --rebuild`)
- No sub-flag: Show default health report (equivalent to `/deep-assumptions report`)

### 10. --all: All Sessions Dashboard + Everything

`$ARGUMENTS`에 `--all`이 있으면
`${CLAUDE_PLUGIN_ROOT}/skills/deep-status/references/flag-views.md`
의 `--all` 절을 읽고 그대로 수행한다. `--all`의 §10b는 Step 11(tree)까지 실행하도록
요구하므로, `--tree`가 함께 주어지지 않았더라도
`${CLAUDE_PLUGIN_ROOT}/skills/deep-status/references/fork-views.md`
를 **함께 읽는다** — tree 절차는 그 파일에만 있다.

### 11. --tree: Fork Relationship Tree

`$ARGUMENTS`에 `--tree`가 있으면 같은 파일
`${CLAUDE_PLUGIN_ROOT}/skills/deep-status/references/fork-views.md`
의 `--tree` 절을 읽고 그대로 수행한다.

### 12. --badge / 13. --risk

`--badge`(shields.io 품질 뱃지) 또는 `--risk`(governed risk & policy) 요청 시 같은 파일
`${CLAUDE_PLUGIN_ROOT}/skills/deep-status/references/flag-views.md`
의 해당 절을 읽고 그대로 수행한다.
