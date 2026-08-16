---
name: deep-work-orchestrator
description: "Session initialization plus the Brainstorm → Research → Plan → Implement → Test auto-flow, with an Exit Gate between phases. Triggers on /deep-work \"task\", Skill({ skill: \"deep-work:deep-work-orchestrator\", args: \"task\" }), or a request to start a new deep-work session."
user-invocable: true
---

# Step 1: 세션 초기화

사용자 입력: **$ARGUMENTS**

> `--resume-from=<phase>` 가 지정된 경우: Step 1의 **interactive/setup 대화(프로필 질문, 작업 모드 선택 등)만 건너뛴다**. `SESSION_ID`는 `--session`에서 결정되고, 기존 state file을 재사용하며 새 세션 파일을 쓰지 않는다.
>
> **반드시 수행**:
> 1. Step 1-2 state file 로드: `.claude/deep-work.{SESSION_ID}.md`에서 `work_dir`, `task_description`, `worktree_enabled`, `worktree_path`, `team_mode`, `cross_model_enabled`, `tdd_mode`, `iteration_count`, `skipped_phases`, `research_approved`, `research_approved_hash`, `plan_approved`, `plan_approved_hash`, `current_phase` 등 모든 상태 변수 로드.
> 2. `$WORK_DIR` 변수 초기화 (state의 `work_dir`에서). §3-2/§3-3 hash check 등 파일 경로 참조 시 필수.
> 3. Step 2 (조건 변수 조립 — `ARGS`, `tdd_mode` 등) 수행하여 Skill 호출에 session/worktree/tdd context 보존.
>
> 그 후 Step 3의 해당 `<phase>` branch로 점프한다.

### Step 1-3: Model Routing Migration

State load 직후, Step 3 dispatch 전에 migration helper 를 호출하여 `model_routing.{research,implement,test} == "main"` 값을 `"sonnet"` 으로 atomic 치환한다. `model_routing.plan` 은 migration 대상에서 제외 (Plan phase는 대화형 메인 세션이 설계상 필수).

**호출 조건**: `$STATE_FILE`이 이미 존재할 때만 호출 (W-1.1 fix — 새 세션은 §1-9에서 state를 생성하므로 이 시점엔 파일이 없을 수 있음).

> **가드**: `migrateStateFile`은 state에 `model_routing_meta:`가 있으면 skip을 반환한다(자동 결정 엔진이 쓴 fail-safe `main` 보호). skip 시 알림 불필요.

실행:
```bash
if [ -f "$STATE_FILE" ]; then
  result=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-model-routing.js" "$STATE_FILE" 2>&1 || true)
fi
```

또는 동등한 JS import (orchestrator가 Node 런타임 내에서 실행 가능한 경우):
```javascript
// ${CLAUDE_PLUGIN_ROOT}를 JS 리터럴에 그대로 쓰지 않는다: 템플릿 리터럴은 동명의
// **지역 변수**를 찾아 ReferenceError를 내고, 따옴표 문자열은 확장되지 않아 Node가
// bare specifier로 보고 워크스페이스 node_modules를 탐색한다. env에서 읽어 검증한다.
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
const { migrateStateFile } = pluginRequire("scripts/migrate-model-routing.js");
// migrateStateFile 자체가 fs.existsSync 가드를 내부에서 처리
const { replaced, warnings } = migrateStateFile(stateFile);
```

출력 결과:
- `replaced`가 비어있지 않으면 각 필드별로 1회 알림:
  `[migration v6.4.0] model_routing.research='main' deprecated → 'sonnet' 적용`
- `warnings`가 있으면 그대로 stderr에 출력 (치환 없이 원본 유지).
- 치환이 발생한 경우 atomic `writeFile + rename` 으로 state file에 persist됨.

§1-1 Update Check 부터 §1-2 세션 ID 생성까지의 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-work-orchestrator/references/session-discovery.md`
를 읽고 그대로 수행한다.

### 플래그 표

| 플래그 | 효과 |
|--------|------|
| `--setup` | 프로필 재설정 강제 |
| `--team` | team_mode → "team" (해당 항목 ask 우회) |
| `--zero-base` | project_type → "zero-base" |
| `--skip-research` | start_phase → "plan" (해당 항목 ask 우회) |
| `--skip-brainstorm` | brainstorm 건너뜀 |
| `--tdd=MODE` | strict / relaxed / coaching / spike (해당 항목 ask 우회) |
| `--skip-review` | review_state → "skipped" |
| `--no-branch` | git → "current-branch" (해당 항목 ask 우회) |
| `--skip-to-implement` | Plan까지 전부 건너뜀, 인라인 slice |
| `--skip-integrate` | Phase 5 Integrate 건너뜀 |
| `--profile=X` | 프리셋 X 직접 선택 (ask 단계는 진행) |
| `--no-ask` | 신규: ask 단계 모두 skip + 추천 skip (가장 빠른 경로) |
| `--recommender=MODEL` | 신규: 추천 모델 override. allowlist `^(haiku\|sonnet\|opus)$`, 그 외 거부 + sonnet fallback + 1회 경고 |
| `--no-recommender` | 신규: 추천 sub-agent skip (defaults 값으로 ask 진입) |
| `--exec=<inline\|delegate>` | Implement 단계 실행 방식 override. parser → state.execution_override → deep-implement §1.5에서 read |
| `--resume-from=<phase>` | Step 1 초기화 건너뛰고 기존 state로 `<phase>`(research/plan/implement/test) 해당 Step 3-N부터 재개. `${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/SKILL.md`가 사용. |

플래그 파서 호출(§1-3-1), v2→v3 프로필 마이그레이션(§1-3-2), v3 로더 호출(§1-3-3),
플래그 우선순위(§1-3-4), 파싱 경고(§1-3-5), `--setup` 처리 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-work-orchestrator/references/flag-parsing.md`
를 읽고 그대로 수행한다.

§1-4 항목별 대화형 설정(assumption auto-adjust 통합, session-recommender sub-agent 호출,
항목별 AskUserQuestion, 결과 누적, 일시정지 재진입) 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-work-orchestrator/references/interactive-setup.md`
를 읽고 그대로 수행한다. `--no-ask`로 이 단계를 건너뛴 경우에는 읽지 않는다.

§1-5 작업 디렉토리 생성 · §1-6 Cross-model 도구 감지 · §1-7 Assumption Health Check ·
§1-8 Git Branch + Worktree 절차는
`${CLAUDE_PLUGIN_ROOT}/skills/deep-work-orchestrator/references/workspace-setup.md`
를 읽고 그대로 수행한다.

## 1-8.5. Provisional risk-only → adaptive 모델 결정

모델 라우팅은 유저에게 묻지 않는다. 동일한 유효 입력을 쓰는 다음 3단계를 순서대로
실행한다. `REC_TASK_DIFFICULTY`는 §1-4-2의 `task_difficulty.value`이며 부재 시 빈 값이다.

**1단계 — provisional risk-only:**

```bash
POLICY_MODE="${FLAGS.policy:-adaptive}"
RISK_IN=$(mktemp)
node -e 'process.stdout.write(JSON.stringify({task_text:process.argv[1],
  difficulty:process.argv[2]||null,policy_mode:process.argv[3]}))' \
  "$TASK_TEXT" "${REC_TASK_DIFFICULTY:-}" "$POLICY_MODE" > "$RISK_IN"
RISK_ONLY_OUT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/risk-profile-cli.js" \
  --stage provisional --risk-only --root "$PROJECT_ROOT" --work-dir "$WORK_DIR" \
  --input-file "$RISK_IN")
RISK_CLASS=$(printf '%s' "$RISK_ONLY_OUT" | node -e \
  'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(r.risk_profile?.class||"")')
RISK_INPUT_REF=$(printf '%s' "$RISK_ONLY_OUT" | node -e \
  'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(r.input_ref?.path||"")')
METHODOLOGY_AUTHORITY=$(printf '%s' "$RISK_ONLY_OUT" | node -e \
  'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
   process.stdout.write(JSON.stringify(r.methodology_authority??{}))')
```

`FLAGS.risk`가 있으면 해당 class를 `RISK_CLASS`에 적용한다. 자동/기존 class보다 낮은
override는 확인을 받은 뒤에만 적용하고 `review_execution_json.risk_acceptances`에
`{from,to,reason,at,scope:"session"}`를 append한다. 상향은 즉시 적용한다.
override로 effective class가 바뀌면 `${CLAUDE_PLUGIN_ROOT}/runtime/policy-runtime.js`의
`compileMethodologyAuthority`를 그 승인된 class와 `POLICY_MODE`에 다시 적용해
`METHODOLOGY_AUTHORITY`를 교체한다. 이 재컴파일 없이 legacy `--risk-class`로
router를 직접 우회하는 것은 금지한다.

**2단계 — methodology-authority routing facade:**

현재 host의 `Agent` 도구 사용 가능 여부를 직접 확인한다. Agent tool available인
Claude Code host는 `claude`, Agent tool unavailable인 Codex host는 `codex`를 선택한다.
manifest, child process env marker, 이전 session state는 이 판정의 authority가 아니다.

아래 블록을 실행하기 전에 placeholder 전체를 관측한 host의 literal 하나로 치환한다.
대입과 소비는 반드시 이 한 shell invocation 안에서 함께 실행한다. host를 확정할 수
없거나 placeholder가 남아 있으면 fail closed로 중단한다.

```bash
ROUTING_RUNTIME="<current host: claude or codex>"
case "$ROUTING_RUNTIME" in
  claude|codex) ;;
  *) printf '%s\n' 'ERROR: current host runtime is unresolved' >&2; exit 1 ;;
esac
MR_OUT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/model-routing-cli.js" \
  --root "$PROJECT_ROOT" --task "$TASK_TEXT" \
  --difficulty "${REC_TASK_DIFFICULTY:-}" --pinned "${FLAGS.model_routing:-}" \
  --runtime "$ROUTING_RUNTIME" \
  --methodology-policy "$METHODOLOGY_AUTHORITY")
MR_FILE=$(mktemp)
printf '%s' "$MR_OUT" > "$MR_FILE"
SHADOW_WRAP=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/router-shadow.js" \
  --mr-out-file "$MR_FILE" \
  --runtime "$ROUTING_RUNTIME" \
  --risk-class "$RISK_CLASS" \
  --task-class IMPLEMENTATION)
rm -f "$MR_FILE"
```
`$MR_OUT` remains the dispatch authority. `$SHADOW_WRAP` is observation-only
(`authority` is a clone; persist only `shadow` under `model_routing_meta_json.router_shadow`).
The shadow CLI never fails the session: it always exits 0.

프로필의 per-phase concrete pin은 `--pinned`에 병합하되 CLI pin이 우선한다. `MR_OUT.meta.policy.floor_overridden_by_pin`에 true가 있고 risk class가
`high` 또는 `critical`이면 `⚠️ 사용자 pin이 <phase> policy floor보다 낮습니다`를 phase별
1회 표면화한다. pin은 최종 우선이며 이 경고가 실행을 차단하지는 않는다.

## 1-8.6. Provisional policy snapshot

**3단계 — 기존 policy snapshot, signals 재사용:** 2단계 결과의 routing을 신선하게
입력에 추가하고 1단계 artifact의 signals만 재사용한다.

```bash
node -e '
const mr=JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify({task_text:process.argv[2],
  model_routing:mr.model_routing,tiers:mr.meta?.tiers??{},pinned:mr.meta?.pinned??{},
  difficulty:process.argv[3]||null,runtime:mr.meta?.runtime??"unknown"}));
' "$MR_OUT" "$TASK_TEXT" "${REC_TASK_DIFFICULTY:-}" > "$RISK_IN"
RISK_OUT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/risk-profile-cli.js" \
  --stage provisional --root "$PROJECT_ROOT" --work-dir "$WORK_DIR" \
  --input-file "$RISK_IN" --reuse-input "$RISK_INPUT_REF")
rm -f "$RISK_IN"
```

- 두 risk 호출의 구조화 `errors`를 `risk_profile_json.errors`에 보존한다. 실패는 경고 후
  fail-open하며 세션을 중단하지 않는다.
- `RISK_OUT.policy_snapshot`은 `policy_shadow_json.provisional`로 기존 관찰 연속성을
  유지한다.
- `methodology_policy_json`에는 검증된 `METHODOLOGY_AUTHORITY`를 그대로 기록한다.
  `policy_sha256`가 policy preimage와 일치하지 않으면 session 생성을 중단한다.
  실제 provider routing, pin override와 `floors_applied`는
  `model_routing_meta_json`에 실행 결과로 분리하고 `FLAGS.review`은
  `review_execution_json.review_mode_override`로 기록한다.

## 1-9. State 파일 + Registry 생성 (atomic + 권한 600)

`.claude/deep-work.{SESSION_ID}.md` 생성 (YAML frontmatter):
- session_id, current_phase, task_description, work_dir
- team_mode, tdd_mode, worktree_*, cross_model_*
- **`model_routing_json`**: `JSON.stringify(MR_OUT.model_routing)`로 만든 한 줄 JSON-string 스칼라
- **`model_routing_meta_json`**: `JSON.stringify({ ...MR_OUT.meta, router_shadow: SHADOW_WRAP.shadow })`로 만든 한 줄 JSON-string 스칼라. `router_shadow`는 관측 전용이며 phase-guard/dispatch는 이 키를 읽지 않는다. `MR_OUT` 권위 바이트는 그대로 둔다.
- **`risk_profile_json`, `policy_shadow_json`, `slice_risk_shadow_json`** (옵셔널, v6.11.0 — frontmatter JSON-string 스칼라, shadow 관찰 전용. phase-guard/gate enforcement에 영향 없음)
- **`methodology_policy_json`, `review_execution_json`**. v7은 digest-bound
  `methodology-policy-v1` authority를 전자에 기록한다. legacy v6.12 shape는
  reader fallback으로만 허용한다. `--policy`, `--risk`, `--review` 결정과 하향 승인
  `risk_acceptances`는 후자에 기록한다.
- 각 phase timestamp, test_retry_count, max_test_retries 등
- **`recommendations: { ... }`** — §1-4-2 sub-agent 응답 + §1-4-3 사용자 최종 선택 (옵셔널 필드, phase-guard enforcement에는 영향 없음)
- `execution_override: {FLAGS.exec_mode | null}` — v6.4.0 호환, deep-implement Section 1.5에서 read

**작성 절차** (atomic + 권한 600):

````bash
state_tmp="${state_path}.tmp"
write_yaml_to "$state_tmp"   # state file 내용 작성 (YAML frontmatter)
chmod 600 "$state_tmp"
sync_file "$state_tmp"
mv -f "$state_tmp" "$state_path"   # atomic rename
````

§1-4-2/§1-4-3의 in-memory 결과는 이 시점에 `recommendations` 필드로 직렬화. phase-guard는 `current_phase`, `*_completed_at`, `*_approved` 필드만 검사하며 `recommendations` 필드는 enforcement에 영향을 미치지 않는다.

Registry 등록: `register_session "$SESSION_ID" ...`

§1-10 프로필 저장 · §1-11 세션 확인 표시 절차는 같은 파일
`${CLAUDE_PLUGIN_ROOT}/skills/deep-work-orchestrator/references/workspace-setup.md`
후반부를 읽고 수행한다.

# Step 2: 조건 변수 조립

```
ARGS="--session={SESSION_ID}"
if worktree_enabled: ARGS += " --worktree={worktree_path}"
if team_mode=team:   ARGS += " --team"
if cross_model_enabled: ARGS += " --cross-model"
if tdd_mode:         ARGS += " --tdd={tdd_mode}"
```

# Step 3: Auto-flow Dispatch

State의 `current_phase`에서 시작점 결정:
- brainstorm → 3-1 | research → 3-2 | plan → 3-3 | implement → 3-4 | test → 3-5

## 3-1. Brainstorm (skip 가능)

`skipped_phases` / `start_phase` 확인. 건너뛰면 Exit Gate 생략하고 `current_phase: research`로 직접 전환 → 3-2.

Skill("deep-brainstorm", args=ARGS)

Brainstorm skill의 Section 3 완료 메시지 출력 후:

### Exit Gate (Phase 0 → Phase 1)

AskUserQuestion:

- header: "Phase 0 (Brainstorm) 완료. 어떻게 진행할까요?"
- multiSelect: false
- options:
  1. label: "다음 phase로 진행", description: "즉시 Phase 1 Research를 시작합니다"
  2. label: "이 phase 재실행/수정", description: "Brainstorm을 재실행하거나 brainstorm.md를 편집합니다"
  3. label: "일시정지", description: "세션 유지. /deep-resume으로 복귀 시 이 Exit Gate로 돌아옵니다"

분기:
- option 1 → **즉시 `current_phase: research` 설정** → **§3-2 Research로 dispatch** (§3-2 body가 Resume check + Skill 호출 담당). 본 branch에서 Skill을 직접 호출하지 않는다 — §3-2 본문과 중복 실행 방지.
- option 2 → **재실행 전 completion marker clear**: `brainstorm_completed_at: null` 설정 → 이후 사용자 상세 지시 청취. brainstorm.md 직접 편집(phase-guard 허용) 또는 `Skill("deep-brainstorm", args=ARGS + " --force-rerun")` 재호출. 재실행이 완료된 뒤에만 `brainstorm_completed_at`이 다시 기록되어 Resume fast-path가 정상 동작.
- option 3 → current_phase는 `brainstorm` 유지. "세션 유지됨. `/deep-resume {SESSION_ID}`로 복귀 시 Exit Gate가 재표시됩니다." 출력 후 턴 종료.

## 3-2. Research

`skipped_phases`에 "research" 포함 시 Exit Gate 생략하고 `current_phase: plan`으로 직접 전환 → 3-3.

**Spec resume 우선 분기 (v7; legacy v6.13 호환)**: `current_phase: spec` 또는
legacy `current_phase: research + subphase: spec`이면
`deep-research`를 재실행하지 않는다. 현재 `$WORK_DIR/spec.md` bytes와
`spec_approved_hash`를 재대조하고, 불일치/미승인이면
`Skill("deep-spec", args=ARGS)`로 spec gate에서 복구한다. 일치하고
`spec_gate_result_json.pass:true`이면 아래 Research Exit Gate만 재표시한다.

**Resume 분기**: state의 `research_approved: true`가 이미 있고 `$ARGUMENTS`에 `--force-rerun`이 없으면 paused-after-approval 복귀 후보 경로이다. 단, **approval integrity check**가 추가로 필요:

1. `research_approved_hash` (state) 와 현재 `$WORK_DIR/research.md`의 sha256을 비교:
   - `Bash({ command: "shasum -a 256 \"$WORK_DIR/research.md\" | awk '{print $1}'" })` (or `sha256sum` on Linux)
   - 해시 일치 → approval은 유효. Skill 호출과 review+approval을 **건너뛰고** 바로 아래 Exit Gate 실행.
   - 해시 불일치 → out-of-band 편집 감지. 데이터 보존 + in-place review 절차는
     `${CLAUDE_PLUGIN_ROOT}/skills/deep-work-orchestrator/references/out-of-band-edit-recovery.md`
     의 research 절을 읽고 그대로 수행한다.

   - `research_approved_hash` 필드 부재 (pre-v6.3.1 세션 또는 재실행 후 미승인) → Skill 재실행 + review+approval. pre-v6.3.1 세션은 fresh approval flow로 가는 것이 safer default.
   - 파일 missing → 복구 불가능. Skill 재실행 + review+approval (edited doc 소실 시점을 감출 수 없음).

2. `research.md`가 아닌 state만 가진 drift 상태 또한 invalidate (복구 불가능 상태를 감춘 채 진행하지 않음).

주의: `research_completed_at` / `research_complete`는 skill Section 3에서 기록하는 marker이며 review+approval **이전**에 set된다. Resume fast-path의 조건으로 사용 금지 — Orchestrator review+approval Step 6가 성공한 뒤에만 set되는 `research_approved: true` + `research_approved_hash` 한 쌍이 정확한 approval-state 증거이다.

그 외 경우:

Skill("deep-research", args=ARGS)

완료 후: **Review + Approval Workflow 실행** (문서 수정 승인 단계).

Phase Skill 완료 후 단일 리뷰 진입점만 실행한다:
1. Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/adaptive-review-protocol.md`) 후 document 입력을 조립한다.
2. `compileReviewPlan` 결과대로 reviewers 실행과 execution/finding 판정을 수행한다.
3. 통과 후에만 Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/review-approval-workflow.md`)의 Step 4-6 승인 UX로
   이동한다. 이 workflow는 자동 리뷰를 다시 실행하지 않는다.

문서 최종 승인 후 → State 부분 업데이트:
- `research_approved: true` (Resume fast-path baseline)
- `research_approved_at`: current ISO timestamp
- `research_approved_hash`: `Bash({ command: "shasum -a 256 \"$WORK_DIR/research.md\" | awk '{print $1}'" })` 결과 (integrity snapshot)

### Spec Subphase Gate

authoritative `risk_profile_json`의 class가 `medium|high|critical`이면 Exit
Gate 전에 반드시 runtime `phase spec enter`를 호출하고
`Skill("deep-spec", args=ARGS)`를 dispatch한다. Low는 명시적 opt-in일 때만
같은 경로를 사용한다.

- runtime은 정식 `current_phase: spec`을 기록한다. legacy
  `research + subphase: spec`은 resume reader에서만 허용한다.
- `deep-spec` 반환 후 현재 `spec.md` bytes, validator `pass:true`, document
  review 승인, `spec_approved_hash`, `spec_contract_json`,
  `spec_gate_result_json`을 runtime `phase spec approve`로 결박한다.
- unresolved marker, blocking question, validator/runtime 오류, stale whole-file
  hash가 하나라도 있으면 Medium+는 fail-closed하며 Research Exit Gate를
  표시하지 않는다.
- 성공한 Spec resume은 research를 재실행하지 않는다. canonical session은
  runtime `phase advance --from spec --to plan`을 사용한다. legacy session은
  `phase advance --from research --to plan` compatibility route가 `subphase`를
  null로 clear한다.

→ 아래 Exit Gate 실행.

### Exit Gate (Phase 1 → Phase 2)

AskUserQuestion:

- header: "Phase 1 (Research) 완료. 어떻게 진행할까요?"
- options:
  1. "다음 phase로 진행" — 즉시 Phase 2 Plan 시작
  2. "이 phase 재실행/수정"
  3. "일시정지"

분기:
- option 1 → runtime `phase advance --from spec --to plan`으로 fresh spec
  admission을 재검증한 뒤 **§3-3 Plan으로 dispatch**한다. state 직접 전환은
  금지한다.
- option 2 → **재실행 전 approval state clear**: `research_approved: false`, `research_approved_at: null`, `research_approved_hash: null`로 state 업데이트 → 이후 `Skill("deep-research", args=ARGS + " --force-rerun")` 재호출 또는 사용자 지시 편집 (phase-guard 허용 범위). 크기에 관계없이 post-approval 편집이면 approval clear 필수.
- option 3 → current_phase는 `research` 유지. 재개 안내 후 턴 종료.

## 3-3. Plan

`skipped_phases` / `--skip-to-implement` 포함 시 Exit Gate 생략하고 `current_phase: implement` + `plan_approved: true` + `plan_approved_at` 설정으로 직접 전환 → 3-4.

**Resume 분기**: state의 `plan_approved: true`가 이미 있고 `$ARGUMENTS`에 `--force-rerun`이 없으면 paused-after-approval 복귀 후보 경로이다. 단, **approval integrity check**가 추가로 필요:

1. `plan_approved_hash` (state) 와 현재 `$WORK_DIR/plan.md`의 sha256을 비교:
   - `Bash({ command: "shasum -a 256 \"$WORK_DIR/plan.md\" | awk '{print $1}'" })` (or `sha256sum`)
   - 해시 일치 → approval 유효. Skill 호출과 review+approval을 **건너뛰고** 바로 아래 Exit Gate 실행.
   - 해시 불일치 → out-of-band 편집 감지. 데이터 보존 + in-place review 절차는
     `${CLAUDE_PLUGIN_ROOT}/skills/deep-work-orchestrator/references/out-of-band-edit-recovery.md`
     의 plan 절을 읽고 그대로 수행한다.

   - `plan_approved_hash` 필드 부재 (pre-v6.3.1 세션 또는 재실행 후 미승인) → Skill 재실행 + review+approval.
   - 파일 missing → 복구 불가능. Skill 재실행.

2. drift gate의 `plan_approved_at`이 실제 최종 plan과 일치하도록 hash check가 추가 가드 역할.

그 외 경우:

Skill("deep-plan", args=ARGS)

완료 후 Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/adaptive-review-protocol.md`)의 document 단일 진입에서
`compileReviewPlan` 결과를 실행한다. 실행 판정과 finding verdict 통과 후에만
Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/review-approval-workflow.md`) Step 4-6 승인 UX로 이동한다.

문서 최종 승인 후 → State 부분 업데이트:
- `plan_approved: true`
- `plan_approved_at`: current ISO timestamp (drift baseline)
- `plan_approved_hash`: `Bash({ command: "shasum -a 256 \"$WORK_DIR/plan.md\" | awk '{print $1}'" })` 결과 (integrity snapshot)
- **`current_phase`는 이 시점에서는 변경하지 않는다.** Exit Gate "진행" 시에 `implement`로 전환.

### Exit Gate (Phase 2 → Phase 3)

AskUserQuestion:

- header: "Phase 2 (Plan) 완료. 어떻게 진행할까요?"
- options:
  1. "다음 phase로 진행"
  2. "이 phase 재실행/수정"
  3. "일시정지"

분기:
- option 1 → **즉시 `current_phase: implement` 설정** → **§3-4 Implement로 dispatch** (§3-4 body가 Skill 호출 담당). 본 branch에서 Skill 직접 호출하지 않음.
- option 2 → **재실행 전 approval state clear**: `plan_approved: false`, `plan_approved_at: null`, `plan_approved_hash: null`로 state 업데이트 → 이후 `Skill("deep-plan", args=ARGS + " --force-rerun")` 재호출 또는 사용자 지시 편집. 모든 편집은 Step 6 re-approval을 거치며, approval clear가 없으면 Resume fast-path가 stale approval을 재사용함. 크기에 관계없이 post-approval 편집이면 approval clear 필수 — drift gate baseline의 `plan_approved_at` + `plan_approved_hash`가 실제 최종 plan과 일치하도록.
- option 3 → current_phase는 `plan` 유지. 재개 안내 후 턴 종료.

## 3-4. Implement

`skipped_phases`에 "implement" 포함 시 Exit Gate 생략하고 `current_phase: test`로 직접 전환 → 3-5. (드문 경로이지만 spike 세션 등에서 활용)

Skill("deep-implement", args=ARGS + " --tdd={tdd_mode}")

Implement skill의 Section 3 완료 후:

### Exit Gate (Phase 3 → Phase 4)

AskUserQuestion:

- header: "Phase 3 (Implement) 완료. 어떻게 진행할까요?"
- options:
  1. "다음 phase로 진행"
  2. "이 phase 재실행/수정"
  3. "일시정지"

분기:
- option 1 → **즉시 `current_phase: test` 설정** → **§3-5 Test로 dispatch** (§3-5 body가 Skill 호출 담당). 본 branch에서 Skill 직접 호출하지 않음.
- option 2 → **재실행/수정 전 completion state clear**: completion marker + receipts + slice checklist 모두 invalidate해야 resume 시 stale evidence를 재사용하지 않는다.
   - `implement_completed_at: null` 설정
   - 영향 받는 slice의 receipt (`$WORK_DIR/receipts/SLICE-NNN.json`) status를 `"invalidated"`로 기록
   - plan.md의 해당 slice `[x]` → `[ ]`로 해제 (Implement skill Resume Detection이 미완료로 인식하도록)
   - checklist만 수정하지 말고 공개 journalled retry/replan route로 runtime `plan.json`의 `checked:false`도 확정한다. runtime plan reset 없이 invalidated receipt를 재발행하지 않는다.
   - 그 후 사용자 상세 지시 청취 또는 `Skill("deep-implement", args=ARGS + " --tdd={tdd_mode} --force-rerun")` 재호출. 재구현 완료 시 새 receipt + `implement_completed_at` 기록.
- option 3 → current_phase는 `implement` 유지. 재개 안내 후 턴 종료.

## 3-5. Test

Skill("deep-test", args=ARGS)

`/deep-test`가 내부적으로 implement-test retry loop 관리 (max 3회).

**Retry exhausted**: auto-flow 중단. 사용자 수동 개입. Exit Gate 실행하지 않음. current_phase는 `implement` 유지 (수동 수정 경로).

**All pass** (`test_passed: true`): 아래 Exit Gate 실행.

### Exit Gate (Phase 4 → Phase 5 / Finish)

`$ARGUMENTS`에 `--skip-integrate` 포함 시 Exit Gate 생략하고 바로 §3-6 Finish 진입.

AskUserQuestion:

- header: "Phase 4 (Test) 완료. 어떻게 진행할까요?"
- options:
  1. "다음 phase로 진행" — Phase 5 Integrate
  2. "Integrate 건너뛰고 Finish"
  3. "Test 재실행"
  4. "일시정지"

분기:
- option 1 → current_phase는 `test` 유지 (Integrate는 idle로 전환함) → **§3-5b Integrate로 dispatch** (§3-5b body가 Skill 호출 담당). 본 branch에서 Skill 직접 호출하지 않음.
- option 2 → `$ARGUMENTS`에 **실제로 `--skip-integrate` 플래그 추가** (ARGS mutation) → §3-5b를 건너뛰고 **§3-6 Finish로 직접 분기**. `--skip-integrate` 미설정된 채 §3-5b 진입하면 skip이 반영되지 않으므로 반드시 실제 ARGS 변경 필요.
- option 3 → **재실행 전 Test state clear**: `test_passed: false`, `test_completed_at: null`, `test_retry_count: 0` 설정 → 그 후 `Skill("deep-test", args=ARGS + " --force-rerun")` 재호출. 이렇게 해야 재실행 도중 세션 중단 시 `/deep-resume`이 stale `test_passed: true` marker를 재사용해 quality gate를 건너뛰는 것을 방지한다 (failing rerun을 "passed"로 기만하는 경로 차단).
- option 4 → current_phase는 `test` 유지. 재개 안내 후 턴 종료.

## 3-5b. Integrate

Phase 5: 설치된 deep-suite 플러그인 아티팩트를 읽어 AI가 다음 단계를 추천하는 대화형 루프.

- `$ARGUMENTS`에 `--skip-integrate` 포함 시 → 3-6로 직진 (state 변경 없음).
- 없으면 → `Skill("deep-integrate", args=ARGS)` 호출.
  - 스킬이 정상 종료하면 → 3-6로 진행.
  - 스킬이 에러로 종료하면 경고 메시지 출력 후 **`--skip-integrate`를 추가하여** 3-6로 진행한다. Phase 5는 진입 시 `phase5_entered_at`을 기록했지만 `phase5_completed_at`이 없으므로, `--skip-integrate` 없이 `/deep-finish`를 호출하면 "Phase 5 중단" 분기에 걸려 세션이 idle-but-unfinishable 상태에 고착된다. `--skip-integrate`가 이 분기를 우회하여 정상 finish 경로를 보장한다.
  - 스킬이 `terminated_by: "interrupted"` 상태로 남기고 종료하면 auto-flow 중단 (재진입 대기).

> current_phase 변경 주체: deep-integrate Skill이 Phase 5 진입 시 `idle`로 전환하고 `phase5_entered_at` + **`phase5_work_dir_snapshot`** 필드를 기록한다. Phase 5 종료 시 `${CLAUDE_PLUGIN_ROOT}/skills/deep-integrate/phase5-finalize.sh`로 `phase5_completed_at`만 atomically 기록한다. `current_phase` 자체는 `idle` 유지 (phase-guard Phase 5 mode와 호환). `phase5_work_dir_snapshot`은 phase-guard가 enforcement 기준으로 사용하는 불변 snapshot — state file의 `work_dir`이 런타임에 변조돼도 snapshot 값으로 방어된다. finished 같은 신규 state는 도입하지 않는다.

## 3-6. Finish

Read `${CLAUDE_PLUGIN_ROOT}/skills/deep-finish/SKILL.md` → 완료 옵션 제시:
- **Merge**: worktree를 base branch에 merge
- **PR**: GitHub PR 생성
- **Keep**: branch/worktree 유지, 나중에 처리
- **Discard**: branch/worktree 삭제

세션 히스토리 기록 (JSONL), Session Quality Score 계산.

Finish 완료 후: `current_phase: idle` 설정.
Registry 해제: `unregister_session "$SESSION_ID"`.

# current_phase 변경 주체 정리

| Phase | Review | 사용자 승인 | current_phase 변경 주체 | 변경 시점 |
|-------|--------|------------|----------------------|----------|
| Brainstorm | 선택적 | Exit Gate 필수 | **Orchestrator** | Exit Gate "진행" 선택 시 |
| Research | 필수 | review+approval + Exit Gate 필수 | **Orchestrator** | Exit Gate "진행" 선택 시 |
| Plan | 필수 | review+approval + Exit Gate 필수 | **Orchestrator** | Exit Gate "진행" 선택 시 |
| Implement | Phase Review | Exit Gate 필수 | **Orchestrator** | Exit Gate "진행" 선택 시 |
| Test | 자동 | Exit Gate 필수 | **Orchestrator** (유지: `test` → `test`; Integrate 진입 시에도 test 유지, Integrate skill이 idle로 전환) | Exit Gate "진행" 선택 시 |
| Integrate | 선택적 | 불필요 | **Integrate Phase Skill (`idle` + phase5_*_at 필드)** | 기존 동작 유지 |

**불변식**: 모든 phase skill은 `*_completed_at` marker만 기록하고 current_phase 변경은 Orchestrator에 위임한다. pause 선택 시 current_phase는 현재 값을 유지 → resume 시 Orchestrator가 해당 phase를 재호출 → skill의 완료-marker 감지 분기가 Orchestrator로 제어를 반환 → Exit Gate 재표시. skill이 직접 current_phase를 전환하면 Exit Gate 이전에 state가 이동해 pause/resume 시 Exit Gate를 재표시할 수 없다.
