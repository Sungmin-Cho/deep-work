---
name: deep-test
description: "Phase 4 — run the verification gates once every plan slice is marked [x], and set the `test_passed` marker that gates deep-finish's session-receipt envelope emit; failure drives the implement-test retry loop. Triggered by /deep-test slash, Skill({ skill: \"deep-work:deep-test\", args: \"...\" }), or orchestrator dispatch after implement approval."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지**
>
> 이 SKILL.md 본문을 사용자에게 echo하거나 요약하여 출력하지 마라.
>
> - Section 1 (state 로드, verification 명령 감지, 완료-marker 감지)는 silent 내부 처리.
> - 첫 사용자-가시 주 동작은 Section 2의 **First Action: 첫 verification 실행 선언 + 즉시 Bash 호출**.
> - Section 3 완료 메시지는 quality gate를 **실제로 수행**한 뒤에만 출력.

# Section 1: State 로드 (필수 — 건너뛰기 금지)

1. Session ID 결정
   - $ARGUMENTS에 --session=ID → 사용
   - 없으면 → .claude/deep-work-sessions.json에서 active session 탐색
2. State 파일 읽기: `.claude/deep-work.{SESSION_ID}.md`
3. 조건 변수 확인:
   - worktree_path — $ARGUMENTS 우선, 없으면 state에서
   - team_mode — $ARGUMENTS 우선, 없으면 state에서
4. 추출: `work_dir`, `test_retry_count`, `max_test_retries`, `evaluator_model`. 모델은
   Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/model-routing-guide.md#model-routing-state-decode-v612`)로
   만든 `decodedRouting.test`를 사용한다.
5. Verify: `current_phase` = "test", plan.md slice checklist 모두 `[x]`
6. `test_started_at` 기록 (ISO timestamp)

## Critical Constraints

- **DO NOT modify any code files** — Phase Guard가 차단
- ONLY: 테스트 실행, 결과 분석, 문서 업데이트
- 테스트 실패 시 implement phase로 복귀하여 수정

## 완료-Marker 감지 (Phase-level resume)

`test_completed_at` + `test_passed: true` 필드가 state에 이미 있고 `$ARGUMENTS`에 `--force-rerun`이 없으면:
- "Phase 4 (Test)는 이미 완료되었습니다. Exit Gate를 재표시합니다." 출력
- Orchestrator §3-5로 제어 반환 (Exit Gate 재실행)
- Section 2/3 진입 금지

## Red Flags — 이 생각이 들면 멈추세요

| 합리화 시도 | 현실 |
|------------|------|
| "테스트는 통과했으니 됐다" | 테스트 통과 ≠ 스펙 충족. Receipt의 spec_compliance를 확인하라. |
| "lint 경고 몇 개는 괜찮겠지" | Sensor Clean Gate가 차단한다. 지금 고쳐라. |
| "커버리지가 낮지만 핵심은 테스트했다" | "핵심"은 주관적이다. 누락된 경로가 프로덕션에서 터진다. |
| "이 실패는 환경 문제일 거야" | 95%의 "환경 문제"는 불완전한 조사다. Root cause를 찾아라. |

## Model Routing

`decodedRouting.test` 확인 (decode 실패 기본: "haiku"). "main"이 아니면 Agent 위임 (전체 test 지시 포함).
"main" → 아래 inline 실행.

# Section 2: Phase 실행

## First Action (즉시 실행 — 건너뛰기 금지)

Section 1의 verification 명령 감지와 완료-marker 감지가 silent하게 끝난 뒤 **즉시** 다음 메시지를 출력한다:

> "Test 단계를 시작합니다. Required Gate부터 순차 실행합니다."

이어서 Step 1 (Receipt Completeness) → Step 2 (Plan Alignment / drift) → 이후 quality gate들을 순차 실행. "실행할까요?" 같은 추가 확인 금지.

**금지**: 이 선언과 첫 gate 실행 전에 quality gate 설명, 완료 템플릿, retry 정책을 출력하지 마라.

## Step 1: Required Gate — Receipt Completeness

plan.md의 모든 SLICE-NNN에 대해 `$WORK_DIR/receipts/SLICE-NNN.json` 존재 + `status: "complete"` 확인.
실패 → implement로 복귀.

## Step 2: Required Gate — Plan Alignment (Drift Detection)

1. plan.md에서 파일 목록 + 체크리스트 + 설계 지침 파싱
2. Baseline 커밋 결정 (우선순위):
   - `plan_approved_at` timestamp → 해당 시점의 가장 가까운 커밋
   - fallback: plan.md 파일의 mtime → 해당 시점 커밋
   - fallback: 최근 24시간 이내 커밋 window
3. `git diff --name-only [baseline]..HEAD`로 변경 파일 비교
4. 각 plan 항목 분류: Implemented / Not implemented / Out of scope / Design drift
5. `$WORK_DIR/drift-report.md` + `fidelity-score.txt` 생성
6. Not implemented 또는 Design drift 있으면 → **FAIL** (Required Gate)

## Step 3: Auto-detect + Run Verification

1. 프로젝트 설정에서 검증 명령어 감지 (package.json, pyproject.toml, Makefile 등)
2. plan.md에 `## Quality Gates` 테이블 있으면 auto-detection 대신 사용
3. 순차 실행, 결과 기록: `$WORK_DIR/test-results.md`

## Step 4: Quality Gates

### 4-1. Cross-Slice Spec Consistency (✅ Required)

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/adaptive-review-protocol.md`)하고 전체 receipt + plan.md로
`compileReviewPlan({artifactKind:'cross-slice', ...})`를 호출한다. Phase 3에서 review가
빠진 slice는 backfill하고 `done_with_concerns`는 extra scrutiny한다. 이 gate는 Required다.

### 4-2. Cross-Slice Quality Review (⚠️ Advisory)

같은 plan의 reviewer로 전체 git diff + receipt의 cross-cutting quality를 검증한다. 4-2의
gate 지위는 Advisory로 유지하되 High/Critical blocker는 사용자에게 required로 표면화한다.

4-1/4-2의 통합 실행 순서는 `compileReviewPlan → reviewers 실행 →
evaluateReviewExecution → (proceed/degraded-proceed에서) normalizeFinding →
verdictFromFindings → writeFindings`다. 결과는
`$WORK_DIR/reviews/cross-slice-round<N>-findings.json`에 보존하고 호환 요약 경로만
`$WORK_DIR/cross-slice-review.json`로 유지한다. severity와 reviewer는 런타임 결과 외에
별도 하드코딩하지 않는다.

### 4-3. Verification Evidence (✅ Required)

각 receipt의 `tdd.passing_test_output` 비어있지 않음 + `verification.full_test_suite` PASS 확인.

### 4-4. SOLID Review (⚠️ Advisory)

변경된 source 파일 대상 SOLID 원칙 평가 → `$WORK_DIR/solid-review.md`
상세: Read("${CLAUDE_PLUGIN_ROOT}/skills/shared/references/solid-guide.md")

### 4-5. Insight Analysis (ℹ️ Insight)

코드 메트릭, 복잡도, 의존성 분석 → `$WORK_DIR/insight-report.md`
실패해도 pass/fail에 영향 없음.

### 4-6. Sensor Clean (✅ Required) + Coverage (⚠️ Advisory)

Receipt의 `sensor_results`에서 읽기 (재실행 아님):
- Sensor Clean: 모든 slice의 lint/typecheck pass 확인. fail/timeout → FAIL.
- Coverage: coverage 퍼센트 표시. Advisory — 차단 없음.

### 4-7. Mutation Score (⚠️ Advisory)

mutation testing 도구 감지 시 `/deep-mutation-test` 실행.
survived mutants → `/deep-mutation-test`가 내부적으로 implement 복귀 처리.

### 4-8. Fitness Delta (⚠️ Advisory)

Phase 1의 fitness_baseline과 현재 비교. 위반 증가 시 경고.

### 4-9. Health Required (✅ Required)

Phase 1의 `unresolved_required_issues` 확인. 있으면 AskUserQuestion으로 acknowledge 요청.

모든 gate 후: quality_gates_passed 업데이트 + `$WORK_DIR/quality-gates.md` 작성.
상세: Read("${CLAUDE_PLUGIN_ROOT}/skills/shared/references/testing-guide.md")

# Section 3: 완료

> **실행 순서 안전장치**: 이 섹션은 모든 quality gate (test, lint, typecheck, sensor, mutation, drift, solid, insight, fitness, health)를 **실제로 수행**한 뒤에만 실행한다. All Pass 메시지만 출력하는 것은 실패 모드이다.

## All Pass

1. State 업데이트:
   - `test_passed: true`
   - `test_completed_at`: current ISO timestamp
   - **`current_phase`는 변경하지 않음** (test 유지). Orchestrator 또는 `/deep-finish`가 idle로 전환.
2. 완료 메시지:
   ```
   모든 검증 통과! `/deep-finish`로 세션을 완료하세요.
   상세 결과: $WORK_DIR/test-results.md
   ```
3. Session report 자동 생성: `$WORK_DIR/report.md`
4. Git commit 제안 (git_branch 설정 시)

### Handoff to /deep-finish — M3 envelope chain

본 skill은 envelope을 직접 emit하지 않으며, `/deep-finish §7-Z`가 session-receipt envelope을 쓸 수 있도록 다음 contract만 보장한다:

- **`state.test_passed === true` + `state.test_completed_at`** 마커 기록 — `/deep-finish §7-Z`의 envelope writer dispatcher가 이 두 필드를 precondition으로 읽는다.
- **모든 slice receipt가 M3 envelope 형태** (`producer === "deep-work"` + `artifact_kind === "slice-receipt"` + `schema.name === artifact_kind`)로 wrap된 상태 — §4-1 (Receipt Completeness) gate가 identity guard로 이를 검증하므로, gate를 통과한 시점에 모든 receipt가 envelope임이 보장됨.
- **`parent_run_id` chain** — Phase 1 (deep-research)가 consume한 `evolve-insights` envelope의 `run_id`가 state에 보관되어 있으면, `/deep-finish §7-Z`가 session-receipt envelope의 `envelope.parent_run_id` 필드와 `envelope.provenance.source_artifacts[]`에 함께 기록한다 (cross-plugin chain trace).
- **단일 writer 정책** — session-receipt는 `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-receipt-envelope.js`가 `--artifact-kind=session-receipt`로 호출되어 생성됨 (deep-implement Step D-1의 slice-receipt writer와 동일 helper). 본 skill은 helper를 호출하지 않는다.

위 contract가 깨지면 `/deep-finish §7-Z`가 envelope emit을 실패시키므로, **Some Fail (retry exhausted) 분기의 receipt invalidation** 은 envelope reader가 stale evidence를 받지 않도록 보장하는 contract의 일부다.

## Some Fail (retry available)

`test_retry_count` < `max_test_retries` 시:

1. `test_retry_count` 증가
2. 실패한 gate/slice 분석 → 수정 대상 식별
3. State: **`current_phase: implement`**
4. 실패 slice만 TDD cycle 재실행
5. 완료 후: `current_phase: test` → 전체 gate 재실행 (Section 1부터)

## Some Fail (retry exhausted)

`test_retry_count` >= `max_test_retries` 시:

1. 누적 실패 이력 표시
2. `current_phase: implement` 유지 (사용자 수동 수정 경로)
3. **Implement state cleanup**: 수동 수정 경로가 제대로 동작하려면 stale completion markers를 invalidate해야 함. 두 action 모두 수행:
   - `implement_completed_at: null` 설정 (Implement skill 완료-Marker branch가 발동하지 않도록)
   - 실패한 slice의 `[x]` 체크마크를 `[ ]`로 해제 (Implement skill Section 1 Resume Detection이 미완료 slice로 인식하도록)
   - **동시에** 해당 slice의 receipt에 `status: "invalidated"` 기록 — sensor/verification이 stale evidence를 재사용하지 않고 재구현 시 새 evidence를 생성하도록 보장
   - 이 checklist 변경만으로는 runtime 권위가 바뀌지 않으므로, 반드시 공개 `test retry`/동등한 journalled route로 `plan.json`의 해당 `checked`도 `false`로 reset한다. 직접 state/plan 파일을 편집해 completion gate를 우회하지 않는다.
   - **주의**: Receipt invalidate만 하고 `[x]`를 그대로 두면 Resume Detection이 미완료 slice를 찾지 못해 재구현이 skip됨. 반드시 둘 다 수행.
4. 안내:
   - `/deep-test --force-rerun`로 Test phase 직접 재실행 (retry count 초기화)
   - 또는 사용자 수동 수정 후 `/deep-resume` → Orchestrator §3-4 (Implement) 경로. Step 3의 cleanup 덕분에 Implement skill이 Section 1 완료-Marker branch를 통과하고 Section 2에 진입하여 영향 slice 재구현 + 새 receipt/sensor evidence 생성. 완료 후 Exit Gate → 사용자가 "다음 phase로 진행" 선택 시 Test 재진입.
   - 또는 `/deep-status --report`로 결과 정리

**주의**: retry exhausted 후 `/deep-resume`은 current_phase(`implement`)를 읽어 Implement로 dispatch한다. Test skill의 완료-Marker 감지 branch는 `test_passed: true`를 요구하므로 이 상태에서는 발동하지 않음 — 순환 무한 루프를 방지한다. 또한 Step 3의 Implement marker cleanup은 stale evidence 재사용을 차단하여 수정된 코드가 실제로 검증되도록 한다.
