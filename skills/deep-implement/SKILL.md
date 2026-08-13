---
name: deep-implement
description: "Phase 3 — slice-based TDD (RED → GREEN → REFACTOR) for each approved plan slice, in solo (inline) or team (implement-slice-worker) mode, emitting M3-envelope-wrapped receipts/SLICE-*.json. Triggered by 'implement phase', '구현 시작', '/deep-work continue', /deep-implement slash, Skill({ skill: \"deep-work:deep-implement\", args: \"...\" }), or orchestrator dispatch after plan approval."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지**
>
> 이 SKILL.md 본문을 사용자에게 echo하거나 요약하여 출력하지 마라.
>
> - Section 1 (state 로드, Plan 로드+Slice 파싱, Resume Detection, 완료-marker 감지)는 silent 내부 처리.
> - 첫 사용자-가시 주 동작은 Section 2의 **First Action: 첫 slice TDD RED 개시**.
> - Section 3 완료 메시지는 plan.md 모든 slice의 TDD cycle, sensor 검증, Slice Review, Phase Review Gate를 **실제로 수행**한 뒤에만 출력.
> - Implement phase 산출물은 코드 자체이다. 본 문서의 "Red Flags" 표나 TDD protocol 설명을 응답으로 출력하지 마라.

# Section 1: State 로드 (필수 — 건너뛰기 금지)

1. Session ID 결정
   - $ARGUMENTS에 --session=ID → 사용
   - 없으면 → .claude/deep-work-sessions.json에서 active session 탐색
2. State 파일 읽기: `.claude/deep-work.{SESSION_ID}.md`
3. 조건 변수 확인:
   - worktree_path — $ARGUMENTS 우선, 없으면 state에서
   - team_mode — $ARGUMENTS 우선, 없으면 state에서
   - tdd_mode — $ARGUMENTS에 --tdd=MODE 우선, 없으면 state에서 (기본: strict)
4. 추출: `work_dir`, `active_slice`, `tdd_state`, `evaluator_model`. 라우팅은
   Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/model-routing-guide.md#model-routing-state-decode-v612`)로
   `decodedRouting`/`decodedRoutingMeta`를 만든 뒤 읽는다.
5. Verify: `current_phase` = "implement", `plan_approved` = true
6. `implement_started_at` 기록 (ISO timestamp)
7. Read `state.execution_override` from state YAML frontmatter (orchestrator §1-3-1
   already ran `${CLAUDE_PLUGIN_ROOT}/scripts/parse-deep-work-flags.js` and persisted the value before this skill
   was invoked — no separate `--exec` extraction needed here):
   - `state.execution_override == "inline"` → Section 1.5 will select inline mode
   - `state.execution_override == "delegate"` → Section 1.5 will select delegate mode
   - `state.execution_override == null` → Section 1.5 auto-heuristic applies

   If `/deep-resume` is invoked with `--exec=<mode>` directly (not via orchestrator), the
   resume skill is responsible for updating `state.execution_override` before entering this
   skill. CLI args > state precedence is enforced at the orchestrator / resume layer.

## Plan 로드 + Slice 파싱

Read `$WORK_DIR/plan.md` → **Slice Checklist** 파싱. 각 slice:
- id, goal, files, failing_test, verification_cmd, expected_output
- spec_checklist, contract, acceptance_threshold, size, steps
- strict-spec plan은 outcome, depends_on, integration_touchpoints, requirements,
  invariants, failure_modes, risk, negative_tests, evidence_required, rollback,
  review_policy, scope_expansion_trigger를 모두 전달한다. 누락/중복/잘못된 ID는
  `${CLAUDE_PLUGIN_ROOT}/runtime/contract-runtime.js:parsePlanContractMarkdown` 결과로 fail-closed한다.

인라인 plan (state `skipped_phases` includes "plan"): SLICE-001만 존재, failing_test/contract 최소화 가능.

## Resume Detection

완료된 slice (`- [x]`) 존재 시 → 미완료 slice부터 이어서 진행.

## 완료-Marker 감지 (Phase-level resume)

`implement_completed_at` 필드가 state에 이미 있고 모든 slice receipt가 `status: "complete"`이며 `$ARGUMENTS`에 `--force-rerun`이 없으면:
- "Phase 3 (Implement)은 이미 완료되었습니다. Exit Gate를 재표시합니다." 출력
- Orchestrator §3-4로 제어 반환 (Exit Gate 재실행)
- Section 2/3 진입 금지

**주의**: Slice 단위 resume (일부 slice만 완료)은 위의 Resume Detection이 처리. 본 branch는 **Phase 전체 완료 후 Exit Gate에서 일시정지한 경우에만** 발동.

## Section 1.5: Pre-routing — Inline Escape Hatches

Section 1 전체 완료 후, Section 2 First Action 진입 **전에** 실행 모드(inline/delegate)를 결정한다.
결정 규칙과 `execution_mode` / `delegation_snapshot` persist 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-implement/references/execution-mode.md`
를 읽고 그대로 수행한다.

# Section 2: Phase 실행

## Implementation Judgment Contract

첫 편집 전에 다음 근거 계약을 읽고, 계획 충실도와 현실 불일치를 그 기준으로 판단한다:
Read("${CLAUDE_PLUGIN_ROOT}/skills/shared/references/implementation-guide.md")

## First Action (즉시 실행 — 건너뛰기 금지)

Section 1 state 로드, Plan 파싱, Resume Detection, 완료-marker 감지가 silent하게 끝난 뒤 **즉시** 다음 메시지를 출력한다:

> "Implement 단계를 시작합니다. plan.md의 첫 미완료 slice부터 TDD 사이클(RED→GREEN→REFACTOR)을 개시합니다."

이어서:
1. 첫 미완료 slice의 test target 파일 경로 확인
2. RED: 실패 테스트 작성 (Write)
3. RED 검증: Bash로 테스트 실행 → FAIL 확인
4. GREEN: 최소 구현
5. GREEN 검증
6. REFACTOR
7. Sensor 검증
8. Slice Review
9. Receipt 생성

"시작할까요?" 같은 추가 확인 금지.

**금지**: 이 선언과 RED 테스트 Write 전에 plan 요약, slice 목록, 완료 메시지를 출력하지 마라.

## Critical Constraints

- **Preserve plan fidelity: do not change the acceptance contract, public interface, scope, or verification evidence without approval.**
- **A local adaptation within the active slice may proceed only when it does not change those approved boundaries; document and verify it. If a mismatch changes a boundary, stop the affected slice for approval or replanning.**
- **TDD mandatory** (strict/coaching): failing test → production code → refactor
- **Do NOT add features not in the plan**
- **Do NOT modify files outside the active slice's scope**
- **Bug → debug mode** — do NOT guess at fixes

## Red Flags — 이 생각이 들면 멈추세요

TDD를 건너뛰거나 slice scope를 넓히고 싶은 합리화가 떠오르면
`${CLAUDE_PLUGIN_ROOT}/skills/deep-implement/references/tdd-red-flags.md`
의 표에서 해당 항목을 찾아 "현실" 컬럼을 따른다.

## Model Routing

공통 decode 결과 `decodedRouting.implement`와 `decodedRoutingMeta`를 확인한다.

- **"main"**: 현재 대화 모델로 inline 실행 → Solo Slice Loop 진행
- **pinned (concrete 또는 tier)** (`decodedRoutingMeta.pinned.implement` 존재, 또는 meta 부재 AND `decodedRouting.implement !== "auto"`): 해당 모델/tier로 Agent 위임 — 기존 동작
- **엔진 자동** (`decodedRoutingMeta.tiers.implement` 존재, pinned 아님): slice마다 per-slice 해석:

  > **fail-safe 선행 체크**: decoded meta의 implement tier가 `main`이거나 error가 true이면 per-slice 해석을 하지 않고 **현재 세션 모델로 inline 실행**한다(error → main). 아래 per-slice 규칙은 tier가 light/standard/deep일 때만 적용.

```javascript
// plugin root는 JS 문자열에서 확장되지 않는다. ${CLAUDE_PLUGIN_ROOT}를 그대로
// require에 넘기면 Node가 절대경로가 아닌 **bare specifier**로 보고
// node_modules/${CLAUDE_PLUGIN_ROOT}/... 를 탐색한다 — 악성 워크스페이스가 그 자리에
// 모듈을 심으면 호출자 권한으로 실행된다. 반드시 env에서 읽어 해석하고 containment를 검증한다.
const nodePath = require("node:path");
const nodeFs = require("node:fs");
const PLUGIN_ROOT = nodeFs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT || "");
const pluginRequire = (rel) => {
  // realpath the *target*, not just the root: path.resolve is lexical, so a
  // symlink inside the root pointing outside would pass a prefix check and then
  // require would follow it. A missing file throws here, which is fail-closed.
  const target = nodeFs.realpathSync(nodePath.resolve(PLUGIN_ROOT, rel));
  if (target !== PLUGIN_ROOT && !target.startsWith(PLUGIN_ROOT + nodePath.sep)) {
    throw new Error("plugin path escapes root: " + rel);
  }
  return require(target);
};
const { sliceModelTierWithRisk } = pluginRequire("runtime/model-routing-runtime.js");
const { resolveTier } = pluginRequire("runtime/model-catalog.js");
// tiers.implement가 light/standard/deep일 때만 — main/error는 위에서 inline 처리됨
const sliceRiskClass = decodedSliceRisk[slice.id]?.class;
const tier = sliceModelTierWithRisk(decodedRoutingMeta.tiers.implement, slice.size, sliceRiskClass);
const { model } = resolveTier(tier, decodedRoutingMeta.runtime);
// 세션 tier standard일 때: S→haiku, M/L→sonnet, XL→opus (기존 auto와 동일)
// model === "main"이면 inline 실행
```

  > **cluster 위임 시 대표 tier**: 하나의 Agent가 여러 slice를 포함하는 cluster를 위임받을 때는
  > slice별로 다른 model을 줄 수 없으므로, cluster 내 slice들의 tier 중 **가장 높은 것**(max, 가장
  > 큰 slice 기준)을 대표 tier로 `resolveTier`해 단일 `model=`에 전달한다. slice가 하나뿐인
  > inline/단일-slice 경로에서는 그 slice의 `sliceModelTier` 결과를 그대로 사용한다. 대표 tier가
  > `main`이면 inline 실행.

- **legacy "auto" 문자열** (meta 부재 구세션): `sonnet` 취급 + 1회 경고 — 기존 S/M/L/XL 표는 위 per-slice 규칙으로 대체됨.
  (이 legacy 분기는 프롬프트 경로 산문 규칙이다 — Node 픽스처 고정 대상이 아니라 산문 acceptance로 검증한다.)

Agent 위임 시: `mode: "bypassPermissions"`, TDD 규칙 + Slice Review 규칙을 프롬프트에 포함 (hook이 delegated agent에 미적용), slice당 10분 timeout.
상세 및 carrier decode 정본: Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/model-routing-guide.md#model-routing-state-decode-v612`)

## Section 2.1: Delegate Solo Path

`execution_mode == "delegate"` AND `team_mode == "solo"` 인 경우.

> **호스트 조건부**: `Agent` 도구가 없는 호스트(Codex)에서는 §2.1/§2.2의 Agent 위임 대신
> `${CLAUDE_PLUGIN_ROOT}/agents/implement-slice-worker.md`의 TDD + Sensor + Slice Review 프로토콜을 호출 스킬 안에서
> 인라인 실행한다. receipt 생성 의무와 §2.3 verify는 그대로 적용된다.
> 규칙 정본은 `AGENTS.md` §Host differences.

### Slice Cluster 추출

File-ownership 기반:
- 동일 파일을 수정하는 slice는 같은 cluster
- 파일 overlap 없는 slice는 독립 cluster

Solo는 **모든 cluster를 단일 agent에 순차 위임**:

```
Agent(
  subagent_type="deep-work:implement-slice-worker",
  model=decodedRouting.implement,   // 자동 경로는 cluster 대표 tier를 resolve한 값으로 교체. pinned/legacy면 그대로.
  prompt="cluster_ids=[C1,C2,...,Cn]; sequential;" +
         "work_dir=<$WORK_DIR>; plan_path=<$WORK_DIR/plan.md>;" +
         "delegation_snapshot=<hash>;" +
         "tdd_mode=<state.tdd_mode>;" +
         "evaluator_model=<state.evaluator_model>"
)
```

### Union scope

Agent의 out-of-scope guardrail은 "union of all assigned clusters' declared scopes". Solo는 cluster_ids 의 모든 cluster.files 의 union이 허용 범위.

### 반환 처리

Agent 반환 후 §Section 2.3 (verify-receipt + Rollback Protocol)으로 이동.

## Solo Slice Loop

각 미완료 slice (`- [ ]`)에 대해:

### Step A: Activate Slice

1. `git_before_slice` = `git rev-parse HEAD`
2. State 업데이트: `active_slice: SLICE-NNN`, `tdd_state: PENDING`
3. Pre-flight: files 존재, verification_cmd 실행 가능 확인 → 실패 시 AskUserQuestion

### Step B: TDD Cycle (strict/coaching)

#### B-1. RED: Failing Test 작성
1. slice의 `failing_test`/`steps` 기반으로 테스트 작성
2. `verification_cmd` 실행 → **올바른 이유로 FAIL 확인**
3. **[필수] State**: `tdd_state: RED_VERIFIED` (미수행 시 phase guard가 production 코드 편집 차단)

#### B-2. GREEN: Minimal Production Code
1. 테스트 통과에 필요한 최소 코드만 구현 (slice `files` 범위 내)
2. `verification_cmd` 실행 → **모든 테스트 PASS 확인**
3. `expected_output` 필드가 있으면 출력 대조
4. **[필수] State**: `tdd_state: GREEN`

#### B-3. SENSOR_RUN: Computational Sensor
> spike mode → skip. 나머지 모드:

GREEN 후 센서 실행 (fast-fail 순서): lint → typecheck → review-check
각 센서 독립 3-round correction limit. 실패 → SENSOR_FIX 진입 (코드 수정 → 테스트 재확인 → 센서 재실행).
3 round 소진 → unresolved 기록, 진행.
모두 pass → `tdd_state: SENSOR_CLEAN`

#### B-4. REFACTOR (optional)
테스트 유지하며 코드 개선. 매 refactor 후 `verification_cmd` 실행.

**relaxed mode**: RED 건너뜀, 직접 구현 후 검증.
**spike mode**: TDD 없이 자유 구현. Receipt에 `tdd_state: SPIKE`. **merge 불가**.
v6.13 strict-spec production slice에서는 SPIKE receipt/evidence를 completion,
delegated result, test, finish proof로 사용할 수 없다. 학습 artifact만 보존하고
production diff는 discard/isolate한 뒤 research/spec/plan을 갱신하고 새 strict
slice를 RED부터 시작한다.

### Stop/Replan trigger

authoritative/slice risk 상승, `scope_expansion_trigger` 일치, 새 public
contract/invariant/failure state/external side effect, unplanned mock, 한 slice의
서로 다른 root cause 2개, 새 persistent transition을 발견하면 즉시 write를
중단한다. runtime `phase invalidate-replan` route를 사용해 prior approval,
verification plan/consumption, test result, evidence summary를 원자적으로
invalidate하고 `receipt_invalidations_json`을 기록한다. Receipt 파일 자체를
수정하거나 skill이 state 필드를 piecemeal patch해서는 안 된다. 이후
canonical `current_phase: spec`에서 재개한다. legacy
`current_phase: research + subphase: spec`도 읽을 수 있다.

### Step C: Spec/Contract 검증

1. `spec_checklist` 항목별 검증 → 미충족 시 추가 RED→GREEN cycle
2. `contract` 항목별 검증 → `acceptance_threshold`(all/majority) 적용

### Step C-2: Slice Review (2-Stage Independent Review)

> spike → skip. relaxed → Stage 1 only.

per-slice diff: `git diff $git_before_slice -- [slice files]`

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/adaptive-review-protocol.md`)하고
`compileReviewPlan({artifactKind:'slice-diff', riskClass, sliceRiskClass, runtime,
availableChannels, tddMode, evaluatorModelOverride, policyMode, reviewModeOverride})`를 호출한다.

**Stage 1 — semantic role / Spec Compliance** (Required): diff + spec_checklist + contract를
검증한다.

**Stage 2 — executability role / Code Quality**: dual plan이면 codex-cli 우선, 단일 또는
CLI 부재면 subagent를 쓴다. Low/Medium은 기존 advisory 동작을 유지한다. **High/Critical
slice에서 Stage 2 blocker는 차단**하고 fix loop로 돌아가며, 소진 시 needs-human이다.

`compileReviewPlan`은 codex-cli reviewer를 항상 `resolveTier(reviewer.tier, 'codex')`로,
subagent reviewer를 세션 runtime으로 해석해 concrete `reviewer.model`을 확정한다. Stage 2
소비자는 channel runtime을 다시 해석하지 않고 `reviewer.model`과 `reviewer.effort`를
빠뜨리지 않는다.
`reviewer.channel === 'codex-cli'`이면 prompt를 dispatcher 소유 임시 파일로 만든 뒤 반드시
다음 `${CLAUDE_PLUGIN_ROOT}/scripts/deep-work-runtime.js` dispatcher route로 실행한다.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-work-runtime.js" review run \
  --engine codex --prompt-file "$REVIEW_PROMPT_FILE" --timeout-ms 600000 --mode read-only \
  --model "${reviewer.model}" --effort "${reviewer.effort}"
```

route 응답의 `effort_applied`, `effort_clamped`, `fallback_used`, `effort_failure`를 해당
reviewer result와 receipt에 그대로 보존한다. subagent/gemini 경로는 protocol의
unsupported-channel 기록 계약을 따른다.

실행 순서는 `compileReviewPlan → reviewers 실행 → evaluateReviewExecution → (proceed 또는
degraded-proceed에서) normalizeFinding → verdictFromFindings → writeFindings`다. canonical
경로는 `$WORK_DIR/reviews/slice-SLICE-NNN-round<N>-findings.json`이다. reviewer 실패를
finding 없음으로 처리하지 않고 execution decision/degraded event를 receipt에 보존한다.

Delegate dual의 blind는 **입력 격리**다. worker의 Stage 1 finding/판정을 부모 Stage 2
prompt에 넣지 않고 diff, slice 계약, receipt만 전달하며 두 결과는 verdict 단계에서만
합친다. reviewer는 수정하지 않고 작성자/구현자가 수정한다. `rounds_max: 2`를 넘기지 않는다.

### Step D: Receipt 수집 — legacy payload 구성

slice 종료 직전 (spec 검증 + slice review 완료 후):
- `git_after_slice` = `git rev-parse HEAD`

먼저 **legacy payload** (per-slice baseline schema)를 in-memory로 구성한다 — 다음 필수 필드:
- **`schema_version`**: literal string `"1.0"`
- **`slice_id`**: 현재 `SLICE-NNN`
- **`cluster_id`** (team parallel에서 필수, solo에서는 optional): 부모가 전달한 cluster identity
- **status** (필수): "complete" | "blocked"
- **tdd**:
  - `state_transitions`: ["PENDING", "RED_VERIFIED", "GREEN", "SENSOR_CLEAN"] 등
  - **`red_verification_output`** (필수): RED 단계 verification_cmd의 FAIL 출력 전문. "ok"/"pass" 같은 trivial 값 금지
- **git_before_slice**, **git_after_slice** (필수): 이 slice만의 baseline pair
- **changes.git_diff**: `git diff git_before_slice..git_after_slice` 출력
- sensor_results, spec_compliance, slice_review, harness_metadata
- slice_confidence: done | done_with_concerns + concerns 배열

#### Optional `review` evidence

통합 리뷰를 실행한 slice는 legacy payload에 optional `review` 블록을 추가한다. 블록은
`findings_ref`(canonical `$WORK_DIR/reviews/slice-SLICE-NNN-round<N>-findings.json`),
reviewer별 `role`/`channel`/`status`/`fallback_used`/`effort`/`effort_applied`, 그리고
최종 `verdict`를 보존한다. 리뷰를 실행하지 않은 구세션·spike receipt에서는 블록을
생략한다. 이 optional 확장은 verify-receipt 9개 항목의 판정 입력이 아니다.

### Step D-1: M3 Envelope Wrap

legacy payload 구성 후, **`${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-receipt-envelope.js`** helper를 호출하여 M3 envelope으로 래핑한 최종 `$WORK_DIR/receipts/SLICE-NNN.json`을 emit한다. delegate 경로에서는 `${CLAUDE_PLUGIN_ROOT}/agents/implement-slice-worker.md`가 worker 내부에서 동일 helper를 호출하고, solo inline 경로도 동일 helper를 직접 호출 — 이 helper가 유일한 envelope writer이다 (`AGENTS.md` §Receipt envelope).

호출 예시 (실제 CLI는 helper 상단 usage block 참조):

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-receipt-envelope.js" \
  --artifact-kind slice-receipt \
  --session-id "${SESSION_ID}" \
  --payload-file <legacy payload JSON path> \
  --output "${WORK_DIR}/receipts/SLICE-NNN.json" \
  [--parent-run-id "${PARENT_RUN_ID:-}"] \
  [--source-evolve-insights <path>] \
  [--source-harnessability <path>]
```

- `run_id`는 helper가 ULID(Crockford base32)로 내부 생성 — CLI flag 없음.
- `--parent-run-id` 미지정 시 `--source-evolve-insights`에서 cross-plugin envelope의 `run_id`를 자동 추출 (helper §tryReadEnvelopeRunId).
- `--source-artifacts-glob`는 session-receipt 단계에서 slice-receipt들을 intra-plugin chain으로 집계하기 위한 옵션 (deep-finish §7-Z 사용).
- `--source-harnessability`는 cross-plugin source artifact를 `provenance.source_artifacts[]`에만 추가하고 `parent_run_id`는 건드리지 않는다.

최종 envelope 전체 스키마의 유일한 문서 권위는 `AGENTS.md` §Receipt envelope이다.
여기서는 실행 계약만 유지한다: helper가 `producer`, `artifact_kind`, `run_id`,
`schema.name`, Git 및 provenance 필드를 만들고 Step D의 legacy payload를 `payload`에
넣는다. envelope를 직접 작성하거나 이 문서에 전체 스키마를 복제하지 않는다.

- **Identity guard** — 모든 reader (`verify-delegated-receipt-runner.js`, `session-end.sh`, deep-test §4-1)가 `envelope.producer === "deep-work"` + `artifact_kind === "slice-receipt"` + `schema.name === artifact_kind` 3중 검증 후 `.payload`로 unwrap하여 legacy 필드를 읽는다.
- **Self-test** — `${CLAUDE_PLUGIN_ROOT}/scripts/validate-envelope-emit.js` (zero-dep release-lint) + `tests/envelope-emit.test.js` + `tests/envelope-chain.test.js`가 corrupt payload, ULID alphabet 위반, SemVer strict, cross-plugin chain assertion을 cover.
- **Legacy compat** — non-envelope receipt(이전 세션 잔존)는 reader 측에서 forward-compat 통과. 본 skill의 writer 경로는 무조건 envelope-wrap.

### Step E: Mark Complete

1. plan.md: `- [ ]` → `- [x]`
2. State: `active_slice: ""`, `tdd_state: PENDING`
3. 다음 미완료 slice로 진행

## TDD Override

main 모드 + strict/coaching에서 hook 차단 시:
AskUserQuestion → 테스트 먼저 / config 변경 / 테스트 불가 / 긴급 수정 선택.
override 선택 시: `tdd_override: "SLICE-NNN"` → hook 통과 허용.
slice 완료 시 override 자동 해제. Receipt에 override 기록.

## Debug Sub-Mode

GREEN 단계에서 예기치 않은 테스트 실패 시:
1. `debug_mode: true` → 체계적 조사 (Read error → Analyze → Hypothesize → Fix)
2. 3회 실패 시 **STOP → 사용자에게 질문**
3. Root cause를 receipt `debug.root_cause_note`에 기록

## Section 2.2: Delegate Team Path

`execution_mode=delegate` ∧ `team_mode=team`일 때에만 진입한다. env var 체크 +
AskUserQuestion, Branch A(Agent Team) / Branch B(복수 Subagent) 분기, partial failure 처리는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-implement/references/team-path.md`
를 읽고 그대로 수행한다.

## Section 2.3: verify-receipt + Rollback Protocol

**모든 slice가 끝나면 execution_mode와 무관하게 반드시 실행한다** — delegate 경로는
전체 verify, inline 경로는 부분 verify(`--skip-items=1,2,3,4`)로 형태만 다르며,
inline 경로에서는 이것이 유일한 receipt 검증이다(item 1-4는 hook이 실시간으로 강제).
`verify-delegated-receipt.sh` 호출, 두 경로의 차이, pass/fail 분기, Rollback Protocol,
`delegation_snapshot`이 non-null인 resume/takeover 분기는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-implement/references/rollback-protocol.md`
를 읽고 그대로 수행한다. 이 단계가 pass해야 Phase Review Gate에 도달한다.

## Phase Review Gate

> **Precondition**: Section 2.3 verify-receipt가 pass해야 이 단계에 도달한다. Fail 시 §5.6a Rollback Protocol이 이 단계를 우회한다.

모든 slice 완료 후, Test 전환 전:
Read("${CLAUDE_PLUGIN_ROOT}/skills/shared/references/phase-review-gate.md") — 프로토콜 실행:
- Phase: implement
- Document: 구현된 코드 전체 (git diff)
- Self-review: 계획 충실도, 크로스 슬라이스 일관성, 미구현 항목

상세 판단 기준은 Section 2 진입 전에 로드한 implementation guide를 따른다.

# Section 3: 완료

> **실행 순서 안전장치**: 이 섹션은 plan.md의 모든 slice(또는 spike 모드의 의도된 subset)의 TDD cycle, sensor 검증, Slice Review, Phase Review Gate를 **모두 실제로 수행**한 뒤에만 실행한다.

1. 모든 receipt 검증: `$WORK_DIR/receipts/SLICE-*.json` 존재 확인
2. State 업데이트:
   - `implement_completed_at`: current ISO timestamp
   - `phase_review.implement`: `{reviewed, reviewers, self_issues, external_issues, resolved}`
   - `review_state: completed`
   - **`current_phase`는 변경하지 않는다.** Orchestrator가 Exit Gate "진행" 분기에서 `test`로 전환.
3. 완료 메시지:
   ```
   구현 완료! 테스트 단계로 진입합니다.
   완료 slice: N/N
   TDD 준수율: [strict: N, relaxed: N, override: N, spike: N]
   Receipt 완성: N/N
   ```
