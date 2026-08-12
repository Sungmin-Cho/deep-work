---
name: deep-resume
description: "Resume an active deep-work session from its current phase, restoring artifacts and worktree context. Triggers on `/deep-resume`, \"resume session\", \"deep-work 이어서\", \"세션 재개\", \"이전 작업 계속\", or an interruption mid-phase. Supports `--session=<id>` and `--resume-from=<phase>`."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Auto-detect active session + 현재 phase resume |
| `--session=<id>` | 명시 세션 ID resume |
| `--resume-from=<phase>` | `brainstorm|research|spec|plan|implement|test` 강제 |
| `--worktree=<path>` | 파서가 받아 검증하지만 **resume 경로에서 소비하는 곳이 없다** — worktree는 state의 `worktree_path`에서만 복원된다 |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites

> **Utility** — standalone 명령. `/deep-work` init은 stale 세션 감지만 수행하며, active 세션 선택·worktree 컨텍스트 복원·state 마이그레이션·phase cache 정리·phase별 resume dispatch는 이 커맨드가 유일한 경로입니다.
> 향후 기능 이관 후 삭제 예정.
>
> **v6.4.2**: `parse-deep-work-flags` 파서가 `--session=<id>`, `--resume-from=brainstorm` (및 `research|plan|implement|test`), `--worktree=<path>` 플래그를 지원합니다.

# Deep Work Session Resume

You are resuming an active **Deep Work** session — restoring context from previous artifacts and continuing from the current phase.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Instructions

### 1. Detect active session & extract WORK_DIR (multi-session aware)

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply both its reusable resolution and **Resume-only continuation** sections.

### 1-1. 신규 state 필드 복원

- phase dispatch 전에 다음 production route를 실행한다:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-work-runtime.js" session authority validate --state "<STATE_FILE>"`.
  v7 policy-bound session에서 이 route가 실패하면 resume을 중단하고 Spec/Plan 재승인을
  안내한다. `methodology_policy_json`, exact `spec.md`, `plan.json`,
  `verification_plan_json`, committed evidence package 중 하나라도 승인 digest에서
  drift한 상태로 phase skill을 호출해서는 안 된다. legacy session은 route의
  `governed: false` 결과로 계속 읽을 수 있다.
- Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/model-routing-guide.md#model-routing-state-decode-v612`)로
  `decodedRouting`/`decodedRoutingMeta`를 복원한다.
- `methodology_policy_json`과 `review_execution_json`을 각각 `JSON.parse`해 policy mode,
  risk class, review mode override, floor baseline, channels, human ack,
  external change lock, risk acceptances를 복원한다. legacy session의 부재는 `{}`로
  호환 복원하지만, v7 policy-bound session의 손상은 위 authority route에서 fail-closed한다.
- `risk_profile_json`, `policy_shadow_json`, `slice_risk_shadow_json`도 같은 JSON-string
  규칙으로 복원한다. resume 인자가 state의 명시 값을 변경하지 않는 한 원래 값을 보존한다.

- `execution_override: inline | delegate | null` (sets decide_execution_mode override for inline escape hatches)
- `active_cluster_takeover: "<cluster_id>" | null` (debug takeover 중 세션 중단 시, resume 하면 해당 cluster를 inline으로 이어 실행)
- `delegation_snapshot: "<git hash>" | null` (delegate 진입 직전 capture된 commit hash. verify-receipt pass 시 null로 clear. resume 시 non-null이면 "verify-receipt fail 후 interrupt" 신호로 해석되어 Rollback Protocol AskUserQuestion을 재표시한다.)

### 1.4. State 스키마 마이그레이션

Resume 시 state 파일에 `phase_review` 필드가 없으면 빈 객체로 자동 초기화:

If `phase_review` field is missing from state YAML frontmatter:
- Add `phase_review: {}` to the state file
- Log: `📋 phase_review 필드 초기화 완료 (마이그레이션)`

If a legacy `review_results` field exists:
- Read `review_results.{phase}` values
- Migrate to `phase_review.{phase}.reviewed: true` for phases that have review data
- Keep `review_results` for backward compatibility (read-only)

> **모델 라우팅 재해석**: `decodedRoutingMeta.runtime`이 현재 감지 런타임
> (`node "${CLAUDE_PLUGIN_ROOT}/scripts/detect-runtime.js"`)과 다르면 decoded tiers를 현재
> 카탈로그로 재해석한다. 결과는 `model_routing_json`/`model_routing_meta_json` JSON-string
> 스칼라로 atomic 갱신하고 1회 안내한다. decoded meta 부재는 skip한다. runtime 변경 시
> concrete pin은 드롭하고 해당 phase는 재해석된 tier를 사용한다(1회 안내).

### 1.5. Worktree restoration

state의 `worktree_enabled`가 true일 때에만 수행한다. 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/worktree-restore.md`
를 읽는다.

### 2. Restore context

Based on the current phase, load the relevant artifacts to restore AI context:

#### Phase: `brainstorm`

- Read `$WORK_DIR/brainstorm.md` if it exists
  - If it has content: display "이전 브레인스톰 결과 발견" and read the content for context
  - If it doesn't exist or is empty: note "브레인스톰 산출물 없음"
- Set `phase_context` to "탐색 중"

#### Phase: `research`

- Read `$WORK_DIR/research.md` if it exists
  - If it has content: display "이전 리서치 일부 발견" and read the content to understand what was already analyzed
  - If it doesn't exist or is empty: note "리서치 산출물 없음"
- Set `phase_context` to "분석 중"

#### Phase: `plan`

- Read `$WORK_DIR/research.md` if it exists — **only the Executive Summary and Key Findings sections** (stop reading after `---` separator or the next `##` heading after Key Findings). This provides research context without consuming excessive tokens.
  - If it doesn't exist: display warning "⚠️ research.md를 찾을 수 없습니다"
- Read `$WORK_DIR/plan.md` if it exists (for review continuation)
- Set `phase_context` to "리뷰 대기" if plan.md exists, "작성 대기" if not
- Read `review_state` from state file
  - If `"in_progress"`: note "리뷰 진행 중이었음"
    - If `review_results.plan.judgments_timestamp` exists: note "종합 판단 완료, 사용자 확인 대기"
    - Otherwise: note "리뷰 진행 중"
  - If `"completed"`: note "리뷰 완료됨"
  - Review finding은 `readFindings({workDir: WORK_DIR, point: "plan", round})`로 복원한다.
    canonical 우선/legacy fallback과 `source:'legacy'`를 보존하며 raw cross-review 파일을
    직접 선택하지 않는다. structural `plan-review.json`은 점수 요약에만 사용한다.

#### Phase: `implement`

- Read `$WORK_DIR/research.md` if it exists — **only Executive Summary** (1 paragraph)
- Read `$WORK_DIR/plan.md` in full — this is the implementation guide
  - Parse the Slice Checklist: count `- [x]` (completed) and `- [ ]` (incomplete)
  - Identify the **last completed task** and the **next incomplete task**
  - Calculate progress: `completed / total * 100`
  - If plan.md doesn't exist: "⚠️ plan.md를 찾을 수 없습니다. /deep-plan을 먼저 실행하세요." → Stop
- Set `phase_context` to "N/M 완료"

#### Phase: `test`

- Read `$WORK_DIR/plan.md` — **only Plan Summary section** (approach, scope, risk)
- Read `$WORK_DIR/test-results.md` if it exists — focus on the most recent attempt's Failures section
- Read `test_retry_count` and `max_test_retries` from the state file
- Set `phase_context` to "시도 N/M"

**File resilience:** If any file fails to read (missing, corrupted), display a warning but continue with available data. Only stop if a critical dependency is missing (e.g., plan.md missing during implement phase).

### 3. Display resume status

```
Deep Work 세션을 재개합니다

작업: [task_description]
현재 단계: [Phase 이름] ([phase_context])
작업 폴더: [work_dir]
프리셋: [preset]
평가자 모델: [evaluator_model]
시작: [started_at]
Assumption 조정: [N]건 또는 없음
건너뛴 단계: [list] 또는 없음

컨텍스트 복원:
  [✅/⬜] research.md [요약 로드 / 없음]
  [✅/⬜] plan.md [전문 로드 / 요약 로드 / 없음]
  [✅/⬜] 체크리스트 진행률: N/M (XX%)    ← implement만
  [✅/⬜] 테스트 결과 (시도 N/M)           ← test만
  [✅/⬜] 리뷰 상태: [완료 (8/10) / 진행중 / 대기 / 스킵]  ← plan만

▶️ [다음 행동]
```

Omit lines that don't apply to the current phase (e.g., don't show 체크리스트 for research phase). (If `preset` is empty or not set, omit the 프리셋 line.) If `evaluator_model` is empty or not set, omit the 평가자 모델 line. If `assumption_adjustments` is empty or not set, show "없음". If `skipped_phases` is empty or not set, show "없음".

### 3.5. Phase cache cleanup

Before dispatching to the phase skill, delete any stale phase cache to ensure a clean resume:

```bash
rm -f .claude/.phase-cache-${SESSION_ID} 2>/dev/null
```

Where `${SESSION_ID}` is the resolved session ID from Step 1.

### 4. Auto-continue

Execute the appropriate phase skill based on the current phase. Each skill handles its own resume logic (review state detection, checkpoint restoration, etc.) internally.

#### `brainstorm`

Brainstorm phase는 Orchestrator Exit Gate 재표시가 필요합니다.
**Orchestrator를 경유하여 resume합니다:**

```
Skill("deep-work-orchestrator", args="--session={SESSION_ID} --resume-from=brainstorm")
```

- `brainstorm_completed_at`이 있으면 Orchestrator §3-1 Exit Gate 재표시.
- 미완료면 brainstorm skill을 처음부터 재실행.

#### `research`

Research phase는 Orchestrator의 Review + Approval Workflow를 거쳐야 current_phase가 진전합니다.
Phase skill을 직접 호출하면 current_phase가 변경되지 않아 dead-end가 됩니다.
**Orchestrator를 경유하여 resume합니다:**

```
Skill("deep-work-orchestrator", args="--session={SESSION_ID} --resume-from=research")
```

Orchestrator가 research skill 호출 → review → approval → plan 진전까지 처리합니다.

#### `plan`

Plan phase도 Orchestrator Exit Gate 재표시가 필요합니다.
**Orchestrator를 경유하여 resume합니다:**

```
Skill("deep-work-orchestrator", args="--session={SESSION_ID} --resume-from=plan")
```

- `plan_completed_at` + `plan_approved: true`이면 Orchestrator §3-3 Exit Gate 재표시 (paused-after-approval 복귀 경로). current_phase를 implement로 강제 전환하지 않음 — Option A F1에서 이 상태는 정당한 일시정지 상태임.
- `plan_approved: false`이면 Orchestrator §3-3이 review+approval 단계 재개.

#### `implement`

Implement phase도 Orchestrator Exit Gate 재표시가 필요합니다.
**Orchestrator를 경유하여 resume합니다:**

```
Skill("deep-work-orchestrator", args="--session={SESSION_ID} --resume-from=implement")
```

- `implement_completed_at` + 모든 slice receipt complete이면 Orchestrator §3-4 Exit Gate 재표시.
- 미완료 slice가 있으면 implement skill이 slice-level resume 수행 (기존 Resume Detection 로직).

#### `test`

Test phase도 Orchestrator Exit Gate 재표시가 필요합니다.

- If `test_passed: true`:
  All Pass된 세션. Orchestrator §3-5 Exit Gate 재표시:
  ```
  Skill("deep-work-orchestrator", args="--session={SESSION_ID} --resume-from=test")
  ```

- Otherwise (retry 진행 중 또는 exhausted):
  ```
  Skill("deep-work-orchestrator", args="--session={SESSION_ID} --resume-from=test")
  ```
  Orchestrator §3-5가 test skill을 호출하고 retry loop을 이어서 관리합니다.
