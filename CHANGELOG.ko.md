[English](./CHANGELOG.md) | **한국어**

# Changelog

Deep Work 플러그인의 모든 주요 변경 사항을 이 파일에 기록합니다.

형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 따르며,
이 프로젝트는 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 준수합니다.

## [7.2.2] — 2026-08-18 (따옴표 인식 리다이렉트 판정)

### Fixed

- **`phase-guard`가 리다이렉트 문자를 양방향 모두 오판하지 않는다.** v7.2.1은 이슈 [#75](https://github.com/Sungmin-Cho/claude-deep-work/issues/75)가 나열한 사례를 닫았지만, 전제 하나가 두 가지 일을 겸하고 있었다 — 산문의 `->`가 매칭되지 않도록 `>` 앞에 구분자를 요구했고, 그 조건이 동시에 공백 없는 리다이렉트를 전부 놓치게 하면서 커밋 메시지 안의 `>=`는 여전히 쓰기로 읽었다. 이제 리다이렉트는 따옴표가 마스킹된 사본을 대상으로 매칭하므로 셸이 데이터로만 넘기는 텍스트는 아예 매칭될 수 없고, 산문이 구조적으로 처리되면서 구분자 요구는 제거됐다. 이 변경을 촉발한 19개 명령으로 측정: 놓치는 쓰기 8/12 → 0/12 (`git diff>patch.diff`, `cmd 2> err.log`, `make 2>build-errors.txt`가 이제 잡힌다), 오탐 3/7 → 0/7 (`git commit -m "require node >= 22"`, `echo "map: x => y"`가 이제 통과한다).
- **셸이 실제로 실행하는 구간은 살아 있다.** `scanShellFragment`가 각 fragment를 한 번 훑으며 따옴표 리터럴을 지우되, 명령 치환과 `sh -c` 페이로드는 그 자체로 명령으로 남겨 깊이 제한 하에 재귀 분석한다. `bash -c "echo x > f"`와 `echo "$(cat x > f)"`는 계속 차단되고, 작은따옴표라 리터럴인 `echo '$(cat x > f)'`는 차단되지 않는다. 명령어 패턴은 원본 fragment를 계속 대상으로 삼아 `node -e "…writeFileSync…"`가 영향받지 않는다. 중복이 된 `cat`/`echo`/`printf` 전용 리다이렉트 항목은 제거했다. 커버리지는 `hooks/scripts/phase-guard-redirect-detection.test.js`에 있다.

## [7.2.1] — 2026-08-18 (훅 캐시 및 가드 오탐 수정)

### Fixed

- **PostToolUse 핸드오프 캐시가 툴 호출마다 파일을 남기지 않는다** ([#74](https://github.com/Sungmin-Cho/claude-deep-work/issues/74)). `phase-transition.sh`가 조기 종료 지점들보다 앞에서 `.claude/.hook-tool-input.<PPID>`를 무조건 삭제한다. 캐시를 읽었을 때만 삭제해서는 안 된다 — `hook-shell-adapter.js`가 payload를 `CLAUDE_TOOL_INPUT`으로 직접 넘기므로 프로덕션 경로에서는 폴백 분기가 아예 실행되지 않아, `file-tracker.sh`가 방금 쓴 파일을 아무도 소비하지 않았다. 한 세션 안에서 동시 실행된 호출들이 서로의 payload를 읽지 않도록 키는 `$PPID`를 유지한다. `session-end.sh`는 도달 불가능하던 `$PPID` 삭제 줄을 제거하고, 60분 sweep은 크래시 백스톱으로 남긴다. 회귀 커버리지는 `hooks/scripts/hook-input-cache-lifecycle.test.js`에 있다.
- **`phase-guard`가 Implement 외 단계에서 읽기 전용 Bash를 막지 않는다** ([#75](https://github.com/Sungmin-Cho/claude-deep-work/issues/75)). `FILE_WRITE_PATTERNS`가 fd 번호 리다이렉트(`cat f 2>/dev/null`), `/dev/null` 및 fd 복제 대상(`ls > /dev/null`, `2>&1`), 따옴표 안 산문에 등장하는 명령어 이름(`git commit -m "patch the bug"`)을 더 이상 쓰기로 보지 않는다. 명령어 패턴은 명령 위치 — fragment 선두, env/권한 접두사 뒤, `sh -c` 페이로드 내부 — 에서만 매칭하므로 `bash -c "mv a b"`는 계속 차단된다. 패키지 매니저 install은 명시적 패턴으로 기존 동작을 유지한다. 양쪽 스트림 리다이렉트 `node app.js &> build.log`는 이제 올바르게 쓰기로 감지된다. 이슈가 제시한 12케이스 매트릭스를 `hooks/scripts/phase-guard-core.test.js`에 고정했다.

## [7.2.0] — 2026-08-17 (Suite Model-Router Shadow)

### Added

- **Model-router 섀도 비교.** `model-routing-cli.js` 직후 세션 초기화와 research 재라우팅이 `model_routing_meta_json.router_shadow`에 관측만 기록합니다. dispatch 권위는 기존 CLI JSON입니다.

## [7.1.5] — 2026-08-13 (Strict Recovery Evidence Closure)

### Fixed

- **Strict recovery evidence가 rollback·retry 전환에서 fail-closed로 동작합니다.** Receipt admission, completion evidence, release gate와 test result가 이전 시도의 stale evidence를 받아들이지 않고 현재 recovery generation과 authoritative state에 결속됩니다.
- **Recovery·receipt 계약이 identity와 ordering 보장을 유지합니다.** Rollback, retry, receipt identity, governed context와 strict completion 경로에 대한 회귀 테스트를 추가했습니다.

## [7.1.4] — 2026-08-06 (Session-Policy 선행조건 종료)

### Changed

- **Session-policy 선행조건 handoff에 독립 검토된 terminal no-go를 기록했습니다.** 프로젝트가 제어하는 Git 구조는 worktree 밖의 repository-wide authority를 인증할 수 없고, deep-work는 그 신뢰를 제공해야 하는 별도 설치형 repository-authority 및 approval-broker 제품을 소유하지 않습니다. 따라서 기존 inline policy pipeline이 계속 authoritative하며, 실험적 P1 구현과 `scripts/session-policy-cli.js`는 배포하지 않습니다.
- 재개 계약은 signed broker package와 독립 검증된 OS 설치·enrollment receipt를 요구합니다. 사람의 승인은 진행 권한이지 존재하지 않는 authority의 증거가 아닙니다.

## [7.1.3] — 2026-08-03 (이중 Root Hook Bootstrap)

### Fixed

- **이중 root hook bootstrap**: 등록된 hook은 `CLAUDE_PLUGIN_ROOT`를 먼저 해석하고 `PLUGIN_ROOT`로 fallback한 뒤, POSIX와 Windows에서 byte-identical stdin과 event별 종료 의미로 실행하기 전에 bootstrap 및 adapter target을 canonicalize하고 containment를 검사합니다.
- PreToolUse guard 실패가 이제 차단됩니다: 0(허용)·2(차단) 이외의 guard 종료 status(예: 손상된 설치의 127)는 도구 호출을 조용히 통과시키는 대신 차단으로 강제되며, 원 status는 stderr에 보고됩니다. 잘못 설정된 plugin root도 같은 방식으로 차단되고 복구 안내가 모호하지 않게 표시됩니다. Hook manifest timeout에는 host 보고용 1초 headroom(9/9/6/7/4/6초)을 포함하되 adapter deadline은 bootstrap 도입 전과 같은 전체 유효 budget(8/8/5/6/3/5초)을 유지합니다. Timeout된 POSIX adapter는 전용 process group에서 실행되고 남은 descendant도 함께 종료됩니다. Windows `spawnSync`에는 동등한 job-object tree termination이 없으므로 Windows descendant containment는 보장하지 않습니다.

## [7.1.2] — 2026-08-03 (호스트 명시형 GPT 라우팅)

### Changed

- **Codex 라우팅이 risk floor를 약화하지 않고 GPT-5.6 가격·성능 프런티어를 따릅니다.** light·standard·deep 슬롯은 각각 GPT-5.6 Luna·Terra·Sol로 유지하며, 가격만의 산식이 아니라 methodology risk와 오류 비용이 최소 tier를 계속 결정합니다.
- **모델 라우팅이 실제 host를 명시적으로 결속합니다.** orchestrator와 authoritative research reroute가 현재 `Agent` 도구 사용 가능 여부로 `claude`/`codex`를 판정하고 같은 shell invocation에서 routing CLI에 runtime을 전달하며, host를 확정하지 못하면 fail closed로 중단합니다. persisted runtime과 child-process 환경 marker는 현재 host 판정을 덮어쓸 수 없습니다.

### Fixed

- **라우팅 contract 테스트가 실행 가능한 shadow assignment를 거부합니다.** split fence, comment, indentation, semicolon/logical separator, pipe, background command, export, quote, escape, Bash backslash-newline token splicing mutant를 포괄하면서 정상적인 continued argument는 허용합니다.
- **저장소 로컬 npm lockfile은 로컬에만 남습니다.** npm 검증 과정에서 생긴 루트 `package-lock.json`이 릴리스 commit에 섞이지 않도록 ignore합니다.

## [7.1.1] — 2026-07-28 (경로 구분자 정규화)

### Security

- **Windows 방식으로 쓴 경로가 플러그인 경로 가드를 우회할 수 없습니다.** deep-work의 지시가 분석 대상 저장소로 유도되는 것을 막는 검사가 `/`만 인식했기 때문에, 같은 미고정(unanchored) 참조를 `scripts\deep-work-runtime.js`로 쓰거나 둘을 섞어 `hooks\scripts/envelope.js`로 쓰면 그대로 통과했습니다. 이제 모든 규칙보다 먼저 경로 구분자를 정규화하므로 두 표기와 문자열 리터럴의 `scripts\\x.js` 형태가 동일하게 판정됩니다.

### Fixed

- **가드 테스트가 Windows에서 더 이상 실패하지 않습니다.** 플러그인 파일 색인은 호스트의 경로 구분자로 키를 만들고 조회하는 경로는 정규화되어 있어서, Windows에서는 둘이 영영 만나지 못하고 `npm test`가 빨갛게 떴습니다. 이제 양쪽이 같은 표기를 쓰며, 이 불일치는 Windows 제보를 기다리지 않고 POSIX CI에서 재현해 검증합니다. `bash`·심볼릭 링크 픽스처는 호스트가 실제로 그 기능을 갖추지 못한 경우에만 건너뜁니다.
- **릴리스 절차 정정** (아래 7.1.0 항목의 서술은 틀렸습니다): `npm run release:bump`는 marketplace 매니페스트 **두 개를 모두** 쓰고, 둘 다 검증한 뒤에야 쓰기를 시작하며, `docs:write`와 `preflight`까지 스스로 실행합니다. 손으로 동기화할 파일은 없습니다. 에이전트 가이드가 언급하던 "adoption-ledger" 단계도 존재하지 않습니다.

## [7.1.0] — 2026-07-27 (플러그인 경로 신뢰 강화 + 컨텍스트 다이어트)

### Security

- **분석 대상 저장소가 플러그인 지시를 가로챌 수 없습니다.** deep-work가 읽거나 실행하라고 지시하는 모든 경로는 이제 플러그인 설치 위치를 기준으로 해석되며, 그 밖으로 벗어나면 거부됩니다. 이전에는 작업 중인 프로젝트가 자기 트리에 같은 이름의 파일이나 Node 모듈을 두면 그 내용이 지시로 읽히거나 사용자 권한으로 실행될 수 있었고, 상대 경로 read, 플러그인 helper 스크립트, 첨부 JSON 스키마, 셸이 확장하지 않은 앵커, 워크스페이스 `node_modules`에서 해석되던 모듈 경로가 그 경로였습니다.

### Added

- **스킬별 `references/` 분할**: 가장 큰 진입 스킬 8개가 디스패치 로직만 본문에 두고, 조건부 절차(팀 위임, 롤백, 완료 옵션, cross-plugin handoff, fork·플래그 뷰, 세션 탐지)는 해당 분기에 들어갈 때만 `references/`에서 읽습니다.

### Changed

- **`AGENTS.md`가 단일 에이전트 가이드**가 되어 Claude Code와 Codex가 공유하며, `CLAUDE.md`는 이를 import하고 Claude 전용 subagent 안내만 남깁니다.
- **스킬 27개와 에이전트 4개의 description 축약** — 트리거 문구는 모두 원문 그대로 보존했습니다.
- **스킬 본문에서 릴리스 이력 제거**: 버전별 기능 소개 절과 내부 fix/review 라벨을 걷어내고 그것이 달려 있던 제약 문장만 남겼습니다. 무엇이 언제 바뀌었는지는 CHANGELOG가 단일 출처입니다.

### Fixed

- **Assumption Health이 레지스트리에 항목이 있어도 비어 보였습니다.** `/deep-status --report`·`--assumptions`·timeline·badge가 존재하지 않는 경로에서 레지스트리를 읽었고, 파일 부재가 오류가 아니라 빈 레지스트리로 처리되어 해당 섹션이 조용히 비어 보였습니다.

- **에이전트 가이드 오류 수정**: phase-guard denylist 설명이 `hooks/scripts/phase-guard-core.js`와 일치하도록 5개 계열로 정정(`dd`/`mkfs`/`fdisk`와 단독 SQL `DELETE`는 차단 대상이 아니라 의도적 제외 항목), receipt 검증기는 8개가 아니라 9개 항목, 요구 Node 버전은 20이 아니라 22.
- **릴리스 절차**: `npm run release:bump`가 대체한 marketplace·README 수동 편집 안내를 삭제했습니다. 손으로 동기화가 필요한 파일은 `.agents/plugins/marketplace.json` 하나뿐입니다.

## [7.0.0] — 2026-07-27 (적응형 방법론 권위)

### Added

- **정식 Spec phase와 profile v4**: 새 세션은 실행 가능한 Spec을 정식 phase로 거치며, profile v4가 governed methodology policy를 운반하고 제한된 v3 및 legacy session 호환성을 보존합니다.
- **인증된 review envelope**: cross-plugin review request와 receipt가 정확한 artifact, contract, evidence, reviewer identity, finding, verdict, review round를 결속합니다.
- **Runtime context policy**: Codex는 같은 goal과 worktree에서 native compaction으로 계속하며, task 또는 fork 생성에는 명시적이고 제한된 목적이 필요합니다.

### Changed

- **단일 methodology authority**: risk classification이 model floor, review, verification, migration, resume, finish에 쓰이는 하나의 인증된 policy를 컴파일하며, 기존 model routing은 compatibility facade로만 유지됩니다.
- **Governed progress reporting**: status, dashboard, report, test admission, finish admission이 evidence, residual risk, canonical finding, receipt, replan state의 동일한 digest-bound projection을 사용합니다.

### Security

- **Authority drift 거부**: policy, Spec, plan, evidence, review binding의 인증된 byte 또는 digest가 restart나 resume 사이에 변경되면 fail-closed합니다.

## [6.14.0] — 2026-07-27 (Correct RED와 Governed Completion)

### Added

- **인증된 correct RED**: strict functional slice가 제한된 test observation을 분류하고 불변 RED proof를 게시하며, 완료된 proof chain이 있어야 production write를 허용합니다.
- **Governed functional completion**: 결정론적 slice receipt가 production GREEN, performed-refactor 또는 no-refactor evidence, fresh sensor result와 완료된 producer ledger를 결속합니다.

### Changed

- **자동 stop-and-replan**: verification side effect, write scope 확장, manifest divergence가 stale authority를 무효화하고 하나의 crash-safe replan epoch로 재개합니다.
- **정본 progress visibility**: status, report, test admission, finish admission이 동일한 governed evidence, risk, finding, receipt, replan projection을 사용합니다.

### Fixed

- **Bootstrap 첫 slice 안전성**: 일회성 first RED bridge가 별도 adoption과 canonical proof publication을 요구하며, 생성된 proof는 이후 GREEN 및 sensor transition 뒤에도 검증됩니다.

## [6.13.1] — 2026-07-23 (Windows 호환 Codex hook)

### Fixed

- Windows에서 Codex hook 실행이 이제 `hooks/scripts/hook-shell-adapter.js`(Node adapter)를 거칩니다. 이 adapter는 기존 `.sh` 스크립트(`phase-guard.sh`, `file-tracker.sh`, `phase-transition.sh`, `session-end.sh`) 실행을 위해 Git for Windows Bash를 선택하고, `commandWindows` 항목(`; exit $LASTEXITCODE`)으로 PowerShell 종료 코드를 보존하며, PostToolUse tool-input 흐름을 끝까지 온전하게 유지합니다.
- `hooks/hooks.json`의 모든 hook 항목(`session-start-adapter.js`, `hook-shell-adapter.js`, `sensor-trigger.js`)에 `commandWindows` variant가 추가되어, Windows가 더 이상 순수 POSIX `bash` 호출에 의존하지 않습니다.

### Added

- `hooks/scripts/hook-runtime-portability.test.js` — 신규 adapter의 Windows Git-Bash 경로 해석, 종료 코드 보존, PostToolUse 입력 통과 동작을 고정합니다.

## [6.13.0] — 2026-07-22 (Spec Contract & Evidence Policy)

### Added

- **실행 가능한 spec contract**: `runtime/contract-runtime.js`, read-only validator CLI, `/deep-spec`, 정본 spec/plan template이 digest로 결박된 requirement, invariant, failure matrix, slice 실행 coverage를 확립합니다.
- **인증된 evidence package**: `runtime/evidence-runtime.js`가 제한된 command output을 메모리에서 캡처하고 persistence 전에 결정론적으로 redact합니다. contract/receipt/review/adapter producer를 인증하고 receipt schema `1.0`을 유지한 채 content-addressed EvidencePackageV2를 게시합니다.
- **강제 verification/finish gate**: `runtime/verification-policy-runtime.js`가 risk profile별 closed monotonic gate catalog를 컴파일합니다. test/finish admission은 누락·stale·invalidated·redaction 실패 evidence와 승인되지 않은 residual risk를 거부합니다.

### Reliability

- same-base publication은 transaction 경계에서 record union을 결정론적으로 rebase하며, evidence journal stage는 crash/replay 검증과 함께 artifact/package/pointer 소유권을 기록합니다.
- PR4/PR5/PR6 동작은 omission, sentinel redaction, adapter cleanup, receipt compatibility, lock order, 1,923-row logical matrix release blocker로 검증합니다.

설계: `docs/design/v6-13-spec-contract-evidence-policy.md`

## [6.12.0] — 2026-07-21 (Adaptive Routing & Unified Review)

### Added

- **적응형 tier floor와 effort 라우팅**: 위험도 정책 floor가 모델 tier를 단조 상향하고 명시적 pin을 최종 우선권으로 보존합니다. 실측 Codex 실행 경로에 reasoning effort를 전달하며, 클램프와 플래그 제거 재시도 결과를 증거로 기록합니다.
- **통합 리뷰 계약**: 정본 policy/finding 런타임이 리뷰 계획 컴파일, finding 정규화·중복 제거, 라운드 영속, 실행 평가를 담당하며 실패 시 fail-closed합니다. 레거시 리뷰 문서는 제한된 shim으로 전환되고 중복 자동 리뷰는 제거되며, Critical 완료에는 선언된 human gate가 필요합니다.
- **정본 state carrier**: `model_routing_json`, `model_routing_meta_json`, `methodology_policy_json`, `review_execution_json`을 JSON-string frontmatter 스칼라로 저장합니다. 모든 reader는 scalar-first 공통 규칙과 legacy fallback을 사용하고, 마이그레이션 가드는 정본 metadata를 덮어쓰지 않습니다.

### Fixed

- **v6.11 인계 항목**: `runtime/risk-runtime.js`의 hard trigger를 text·경로별·text×path·database path×path로 분리하고 auth를 세그먼트 경계로 제한했습니다. authoritative reuse는 state의 `routing_diff`를 결정론적으로 추출하며, receipt 검증은 Node `-e` argv 규약에 맞춰 정확하고 일관된 `errors`/`warnings` summary JSON을 emit합니다.

설계: `docs/design/v6-12-adaptive-routing-unified-review.md`

## [6.11.0] — 2026-07-21 (Shadow Risk & Policy Engine — 관찰 전용)

- **risk-runtime**: 7차원 결정론 위험도 스코어링 + hard trigger 9종 + canonical digest (`runtime/risk-runtime.js`)
- **policy-runtime**: risk class → methodology profile + 권장 tier/effort + routing_diff(tier-vs-tier, concrete-pin 제외) (`runtime/policy-runtime.js`)
- **risk-profile-cli**: fail-safe CLI — provisional/authoritative/slice 3단계, 유효 입력 artifact(`$WORK_DIR/risk-inputs/`) 보존 (`scripts/risk-profile-cli.js`)
- **state**: `risk_profile_json`/`policy_shadow_json`/`slice_risk_shadow_json` frontmatter JSON-string 스칼라 (옵셔널 — 구버전 reader 무영향)
- **관찰 표면**: `/deep-status --risk`, session receipt optional `methodology_shadow`
- **enforcement 없음**: 모델 라우팅·게이트 동작 완전 무변경 (shadow-only). 설계: `docs/superpowers/specs/2026-07-20-v6.11-shadow-risk-policy-design.md`

## [6.10.0] — 2026-07-20 (자동 모델 선택 — Claude Code / Codex)

### Added

- **5-key ask → 4-key**: `model_routing`을 더 이상 묻지 않습니다. 엔진이 코드베이스 규모 + 태스크
  난이도(결정론적 신호 + 추천 에이전트의 `task_difficulty` ±1 보정, 추천 에이전트 부재 시 결정론적
  fallback)로 phase별 모델을 결정합니다.
- **런타임 중립 tier**: `light`/`standard`/`deep`/`main`을 런타임별 카탈로그(`runtime/model-catalog.js`)
  로 resolve합니다. Codex 세션은 Codex 모델로 resolve되고, 알 수 없는 런타임은 안전하게 `main`(세션
  모델)으로 fail-safe합니다. Claude 모델명이 Codex 경로로 새어나가지 않습니다.
- **Per-slice 규칙**: implement 위임이 `clamp(sizeTier + difficulty offset)`으로 resolve됩니다 —
  기존 slice-size 자동 선택(`standard` 고정)과 동일한 결과를 유지합니다.
- **오버라이드**: `--model-routing=implement=deep,test=light` 플래그, 프로필에 고정된 구체 값(그대로
  존중되며 엔진은 스킵됨), `/deep-slice model`은 변경 없음.

### Changed

- **하위호환**: `model_routing_meta`는 optional입니다; 레거시 `main→sonnet` 마이그레이션은 이제
  엔진이 작성한 state를 스킵합니다(meta 가드); 기존 프로필은 계속 동작하며 — `interactive_each_session`
  은 무조건 필터링됩니다(`filterAskItems`).

## [6.9.4] — 2026-07-10 (hooks stdin wrapper 계약 — 공유 헬퍼)

### Fixed

- `file-tracker.sh` / `phase-transition.sh` — 6.9.3이 `phase-guard.sh`에 대해 고친 stdin wrapper 계약을 두 PostToolUse 훅은 지원하지 않았습니다(deep-review 라운드 2 DEFER **D-2**). `tool_name` / `tool_input`을 stdin JSON 최상위 키로 전달하는 env-미설정 하네스에서 `file-tracker.sh`는 `TOOL_NAME`을 env에서만 읽어(빈 값 → 파일 추적/receipt 수집이 조용히 스킵) **wrapper** JSON을 그대로 캐시했고, 그 결과 `phase-transition.sh`의 `file_path` 추출이 비어 phase 전환 checklist 주입이 소리 없이 누락됐습니다. 이제 `file-tracker.sh`가 캐시 write **이전에** 공유 헬퍼로 두 값을 해석하므로 캐시에는 항상 flat `tool_input`이 담기고, `phase-transition.sh`는 env/캐시 입력 경로로 wrapper 형태가 직접 들어오는 경우까지 방어적으로 unwrap합니다(flat 입력·env-set tool-name 하네스에서는 no-op).

### Changed

- `hooks/scripts/utils.sh` — 공유 헬퍼 `resolve_hook_tool_context` 신설: env 우선(`CLAUDE_TOOL_USE_TOOL_NAME` / `CLAUDE_TOOL_NAME`) → stdin wrapper fallback + 중첩 `tool_input` unwrap을 6.9.3의 인라인 로직에서 추출해 세 훅이 하나의 구현을 공유합니다. 시맨틱 불변: env-set 하네스의 payload는 절대 교체하지 않고(가드-실행 대칭, R1-1), malformed JSON은 fail-open 유지(allowlist + fail-closed 전환은 stdin 계약 1차 승격 시로 유예, DEFER D-1). 기존 2회 node spawn을 **1회**로 통합해 두 값을 동시 추출합니다(`U+001F` unit separator 구분자 — `JSON.stringify`가 제어 문자를 이스케이프하므로 payload 내용과 충돌 불가). `phase-guard.sh`의 메인·Phase 5 경로가 이 헬퍼를 호출합니다.

### Added

- `hooks/scripts/hooks-stdin-contract.test.js` — 10케이스: 공유 헬퍼 단위 계약(wrapper unwrap, env 우선 무교체, flat/malformed fail-open, 비객체 `tool_input`, US 구분자 충돌 안전성), `file-tracker.sh` 캐시 unwrap + env-set flat 무회귀, PreToolUse→PostToolUse env-미설정 e2e 체인(`file-tracker` 캐시 → `phase-transition` checklist 주입) 및 wrapper-via-env defense-in-depth 경로.
- `hooks/scripts/test-helpers/run-phase-guard.js` — `HOST_LEAK_VARS`에 `CLAUDE_TOOL_USE_INPUT` / `CLAUDE_TOOL_INPUT` 추가(`phase-transition.sh`의 env 우선 입력 소스 — 호스트 leak이 테스트 중 file-tracker 캐시 경로를 가리는 것을 봉인).

## [6.9.3] — 2026-07-10 (phase-guard stdin `tool_name`/`tool_input` fallback)

### Fixed

- `phase-guard.sh` — PreToolUse 훅이 도구 이름을 `CLAUDE_TOOL_USE_TOOL_NAME` / `CLAUDE_TOOL_NAME` 환경변수에서**만** 읽었습니다. 현재 Claude Code 하네스(및 cmux 등 일부 실행 환경)는 이 env를 설정하지 않고 `tool_name` / `tool_input`을 훅 stdin JSON의 최상위 키로 전달하므로 `TOOL_NAME`이 빈 문자열이 되고, 추출된 파일 경로도 비어 `checkTddEnforcement`가 모든 호출을 production 파일 수정으로 fail-closed 분류했습니다: implement/strict TDD(PENDING)에서 무해한 Bash 조회·테스트 파일 편집·exempt 파일(`.md`/`.env`) 편집까지 전부 차단(차단 메시지의 `파일: `이 빈 경로)되고, 비-implement phase에서도 Bash 조회가 차단됐습니다. 이제 env가 없을 때만(env 우선) stdin payload에서 `tool_name`을 fallback 파싱하고 중첩 `tool_input`을 unwrap합니다 — env가 설정된 하네스는 flat 계약을 그대로 유지하며, 가드가 평가하는 payload가 툴이 실제 실행하는 입력과 어긋나지 않습니다(4-way 리뷰 라운드 1 🔴 지적 — 게이트 없는 unwrap은 가드-실행 비대칭을 열었을 것). 메인 경로와 Phase 5 read-only 경로를 모두 커버하며, node 부재 시 기존 동작으로 degrade합니다. (참조: `docs/handoff/2026-07-10-phase-guard-toolname-stdin-fallback.md`)

### Added

- `hooks/scripts/phase-guard-stdin-fallback.test.js` — e2e 9케이스: stdin-only 계약 고정(Bash 조회 허용 / 테스트 파일 Write 허용 / production Write **차단 유지** / exempt `.md` Edit 허용), stdin-only payload에서의 Phase 5 read-only 경계(work_dir 밖 Write·Bash redirect 차단, 안 Write 허용), env-set 하네스 무회귀 계약(flat payload 불변; env-set + wrapper payload는 unwrap하지 *않고* fail-closed).
- `hooks/scripts/test-helpers/run-phase-guard.js` — `HOST_LEAK_VARS`에 `CLAUDE_TOOL_USE_TOOL_NAME` / `CLAUDE_TOOL_NAME` 추가 — 호스트 셸/CI에서 leak된 tool-name 값이 훅 테스트의 "env 미설정" 전제를 깨지 못하게 봉인.

## [6.9.2] — 2026-07-07 (silent-failure 수정 + 결정론적 receipt 게이트)

### Fixed

- `update-check.sh` — 원격 버전 조회가 `.../main/plugins/deep-work/package.json`(404 — 저장소에 `plugins/` 하위 트리 없음)를 가리켜 매 fetch가 실패했고, 그 실패가 빈 응답 상태에서 `UP_TO_DATE`로 캐시되어 5분 캐시를 오염 → 업데이트 알림이 **영구히** 억제됐습니다. URL을 저장소 루트 `package.json`으로 교정하고, 실패/빈 응답/비-버전 응답 시 캐시를 건드리지 않고 종료(다음 세션에서 재시도)하도록 수정했습니다. 실제 최신/업그레이드 가능 결과는 계속 캐시됩니다(알림 스팸 방지 유지).
- `file-tracker.sh` — **Bash** 도구로 생성된 파일(`echo … > file`, `tee`, `cp`, 리다이렉트)이 cross-session ownership 레지스트리에 등록되지 않았습니다. ownership 추출 스니펫이 상대경로 `require('./phase-guard-core.js')`(hook CWD 기준 resolve → `MODULE_NOT_FOUND`)를 쓰고 반환 **객체**를 truthy 체크(`if(detectBashFileWrite(d))` — 항상 참)했으며, `2>/dev/null || echo ""`가 모듈 오류를 은폐했습니다. 검증된 `phase-guard.sh` 패턴(절대경로 `require(process.argv[1])` + `const r = …; if (r.isFileWrite)`)으로 교정했습니다.
- `utils.sh` — 레지스트리 변경이 **lost-update**에 취약했습니다: 각 콜러가 *unlocked* `read_registry` → 변환 → *locked* `write_registry` 순서라 lock이 read를 감싸지 못해 동시 세션이 서로의 write를 덮어썼습니다. 이제 read-modify-write 전체를 단일 lock으로 직렬화합니다. lock-free inner helper(`_read_registry_unlocked` / `_write_registry_unlocked`)를 분리하고, `register_session` / `unregister_session` / `register_file_ownership` / `update_last_activity` / `update_registry_phase` / `register_fork_session`가 단일 `_registry_rmw` lock 안에서 read+변환+write를 수행합니다. 공개 `read_registry` / `write_registry` 래퍼는 기존 콜러를 위해 유지(RMW 콜러는 재진입 금지 — lock은 재진입 불가), `read_registry`의 파일 부재 시 default-write도 lock 안으로 이동했습니다.

### Changed

- `wrap-receipt-envelope.js` + `skills/deep-finish/SKILL.md` §7-Z — session-receipt 증거 체인이 이제 deep-test → deep-finish `test_passed` 결과를 프롬프트 준수에 의존하지 않고 결정론적으로 담습니다. `--session-state-file`이 전달되면 wrapper가 state의 `test_passed` frontmatter 마커를 읽어 모든 session-receipt payload에 `x-test-verified: true|false`(forward-compat `^x-` 네임스페이스)를 기록합니다. `outcome`은 **기록된 사실 그대로 유지** — §7-Z 시점엔 `merge`/`pr`이 이미 물리적으로 완료(worktree 제거 + `branch -d`, 또는 `gh pr create`)되어 있어 이를 재작성하면 완료 폴링/집계 소비자에게 완료된 동작을 오보하게 되므로, receipt는 사실(`outcome`)과 검증 신호(`x-test-verified`)를 별도 필드로 남겨 소비자가 조합 판단하게 합니다. emit은 절대 거부하지 않으며, 플래그(또는 state 파일)가 없으면 payload는 무변경(하위호환)입니다.

### Added

- `hooks/scripts/update-check.test.js`, `hooks/scripts/registry-rmw.test.js`, `hooks/scripts/wrap-receipt-envelope.test.js`, `hooks/scripts/file-tracker-fixes.test.js`의 신규 케이스 — URL 앵커 + fetch 실패 분기, RMW 재진입 가드 + 동시 no-lost-update, Bash-write ownership 등록, 결정론적 test-verification 게이트를 고정합니다.

## [6.9.1] — 2026-07-03 (Windows/Git Bash 유령 `.claude` 폴더 수정)

### Fixed

- `file-tracker.sh`가 Windows/Git Bash에서 "유령" `.claude` 디렉터리 트리를 더 이상 생성하지 않고, 무관한 프로젝트에 `.hook-tool-input.*` payload 잔여물도 남기지 않습니다. 새 트리를 `mkdir -p` 하지 않으며(오염된 `$PROJECT_ROOT` — CRLF `\r`/역슬래시가 섞인 `$PWD` — 가 이전엔 매 도구 호출마다 `pop-studio-suite <CR>/d/NHN/.../.claude/` 같은 잘못된 디렉터리를 만들었음), PostToolUse tool-input 캐시는 이제 **활성 deep-work 세션(`$STATE_FILE` 존재)** 이거나 이번 호출이 `.claude/deep-work.*.md` 상태 파일을 쓸 때만 기록합니다 — `.claude` 존재만으로는 기록하지 않습니다.
- `utils.sh`가 `$PROJECT_ROOT` 유도를 단일 지점에서 견고화합니다: 신규 `sanitize_project_path()`가 CR 제거·역슬래시→슬래시·후행 공백 제거를 수행하고, `find_project_root`는 탐색 전 `$PWD`를 정화하며 드라이브 루트 무한루프 종료 가드를 추가하고(`D:/`에서 무한 반복 안 함), `init_deep_work_state`는 not-found 경로에서 멀티라인 `PROJECT_ROOT`를 유발하던 `|| echo "$PWD"` 이중 emit을 `|| true`로 교체합니다.
- `update-check.sh`(SessionStart hook)가 이제 자체 중복 미정화 root walk 대신 `utils.sh`의 경화된 `find_project_root` / `sanitize_project_path`를 재사용합니다 — 기존 복사본은 Windows 드라이브 루트(`D:/`)에서 SessionStart 타임아웃까지 spin할 수 있었으며, 이는 중앙에서 고친 동일 버그 클래스입니다.
- `phase-transition.sh`가 이제 추출한 `file_path`를 `.claude/deep-work.*.md` 가드 이전에 `normalize_path`(백슬래시 folding)하여, Windows/Git Bash 백슬래시 상태파일 write도 phase-transition 주입(worktree / TDD / team-mode)을 정상 트리거합니다 — 이전엔 조용히 유실되어 캐시 writer(`file-tracker.sh`)와 consumer 간 불일치가 있었습니다.

### Added

- `hooks/scripts/file-tracker-ghost-guard.test.js` — 정화 동작(CR / 역슬래시 / 후행 공백)과 캐시 게이트(활성 세션 밖에서는 `.claude` 트리·캐시 payload 미생성; 활성 세션이거나 상태 파일 write 시 캐시 기록)를 고정합니다.

## [6.9.0] — 2026-05-21 (deep-memory v0.1.0 consumer 통합 — Phase 1 recall + Phase 5 harvest 추천)

### Added

- Phase 1 Research recall: `.deep-memory/latest-brief.md`가 존재하면 brief를 `research.md`의 새 `## Cross-project Memory` 섹션에 verbatim으로 인용하고, 부재 시에는 아무것도 쓰지 않습니다(privacy invariant). `/deep-memory-brief`는 절대 자동 호출하지 않습니다. 인용된 memory ID(`mem-<ULID>`)는 `cross_project_memory.cited_memory_ids[]` state 필드로 캡처됩니다.
- Phase 5 Integrate는 `deep-memory`가 설치되어 있고 세션이 파일을 변경했을 때 `/deep-memory-harvest`를 추천합니다. `skills/deep-integrate/detect-plugins.sh`가 `plugins.installed`/`plugins.missing`에 deep-memory를 enumerate합니다.
- `docs/deep-memory-integration-handoff.md`가 보류된 `/deep-memory feedback` hook을 향후 joint PR용으로 기록합니다.
- `tests/deep-memory-integration.test.js`가 문서화된 invariant(privacy 경계, ULID 정규식, heading-shift rule, edge case)를 고정합니다.

### Changed

- Research artifact 스키마에 additive `cross_project_memory` 블록 추가 — brief 부재 시 null/empty로 기본 설정(forward-compatible).

## [6.8.0] — 2026-05-19 (Plan-quality contract 강제 + CI 견고화 + receipt-tracker 안정성)

### Changed

- 모든 비-인라인 S/M/L slice는 `failing_test`, `verification_cmd`, `expected_output`, `code_sketch`, `steps`를 선언해야 합니다. Plan review gate가 이 contract와 정렬됨(누락 필드에 대한 "권장" 헷지나 하위 호환 fallback 없음).
- Planning 참조와 템플릿을 `SLICE-NNN` 체크리스트(`depends_on`, `code_sketch`, `failing_test`, `verification_cmd`, `expected_output`)로 전환. `steps`는 필수(S: 2-4, M: 3-7, L: 5-12)이며 정확한 파일 경로 포함.
- Completeness Policy를 확장하여 모호한 지시, 누락된 red signal, 누락된 정확한 `expected_output` 조각을 거부.
- non-blocking `shellcheck` advisory 스텝이 `hooks/scripts/**/*.sh`를 lint; 재귀 `node --test` 글로브 발견을 위해 CI Node 20 → 22 (LTS) bump.
- Receipt-tracker 견고화: pre-lock receipt 초기화를 `O_CREAT | O_EXCL`로 복원하여 in-lock update가 타임아웃되어도 single-write slice가 canonical `SLICE-NNN.json`을 유지; pending changes는 다음 lock acquire 시 drain.

## [6.7.1] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### Added

- `.codex-plugin/plugin.json` — Claude Code manifest와 같은 skill·hook 표면을 가리키는 Codex-native manifest.
- `AGENTS.md` — runtime surface, 검증, downstream suite marketplace 업데이트를 다루는 Codex 프로젝트 가이드.
- 내부 orchestrator 이름을 몰라도 `$deep-work:deep-work "task"`로 호출할 수 있도록 primary `deep-work` skill alias 복구.

### Changed

- Manifest/package description이 entry alias를 Claude와 Codex 모두에 대한 skill-native로 기술; README가 Codex 호환성을 명시.

## [6.7.0] — 2026-05-18 (24 commands → user-invocable skills: cross-platform)

### Changed

- 24개 command-equivalent 표면이 모두 `skills/` 아래 `user-invocable: true` skill로 전환; `commands/` 디렉토리 제거 및 `package.json` `files`에서 제외.
- Skill 호출이 skill body로 직접 흐름(`Skill({ skill: "deep-work:<verb>", args: "..." })`) — Claude Code뿐 아니라 Codex / Copilot CLI / Gemini CLI / Agent SDK에서도 동작; orchestrator의 5-phase dispatch는 불변.
- `$ARGUMENTS`로 분기하는 body(`deep-finish` 플래그, `deep-fork`, `deep-status` 플래그 매트릭스 등)는 byte-for-byte 보존.

## [6.6.3] — 2026-05-12

### Added

- `tests/phase-guard-golden.test.js` — `phase-guard.sh`용 fixture 기반 golden test(8 시나리오: idle allow, implement slice scope in/out, 4개 non-implement denylist family, override pass-through).
- 공유 `scrubHostEnv()` / `runPhaseGuard()` / `parseGuardOutput()` 테스트 헬퍼; family별 `CLAUDE_ALLOW_<FAMILY>` override 루프와 override fall-through 합성 assertion.

### Changed

- `phase-guard-core.js`의 gate 순서, override-env 의미론(denylist만 억제, file-write는 여전히 적용), 의도적 scope 생략에 대한 문서 확장.

## [6.6.2] — 2026-05-12

### Added

- `phase-guard-core.js`에 non-implement dangerous-command denylist 5개 family(rm-rf, npm-publish, kubectl-destructive, sql-destructive, curl-pipe-shell) — 각 family에 `CLAUDE_ALLOW_<FAMILY>=1` override; research/plan/test/brainstorm Bash 진입에 게이트 적용.

### Fixed

- SQL `TRUNCATE` 단일 문자 매칭 버그와 kubectl `--all-namespaces` false-positive.

## [6.6.1] — 2026-05-12

### Added

- 크로스 플랫폼 CI 매트릭스(`ubuntu-latest` + `macos-latest`) — `npm test`와 bash 회귀 스크립트 실행.

### Fixed

- 회귀 스크립트의 크로스 플랫폼 `stat` fallback(`stat -c '%a' || stat -f '%A'`).

## [6.6.0] — 2026-05-12

### Added

- `hooks/scripts/emit-handoff.js` — handoff payload를 M3 envelope으로 감싸 `.deep-work/handoffs/`에 기록하고 session receipt에 `parent_run_id`를 자동 체인.
- `hooks/scripts/emit-compaction-state.js` — compaction-state payload를 M3 envelope으로 감쌈(trigger/strategy enum 검증); dashboard compaction 메트릭에 사용.
- `--handoff-to=<plugin>` 제공 시 `deep-finish`가 cross-plugin handoff emit.
- Stop hook과 phase-transition hook이 세션 종료 시 및 각 phase 경계에서 best-effort `compaction-state.json` emit.

### Changed

- `ALLOWED_ARTIFACT_KINDS`를 envelope 라이브러리와 CI validator 전반에서 `handoff`와 `compaction-state`로 확장.

## [6.5.0] — 2026-05-07

### Added

- M3 cross-plugin envelope 채택: `session-receipt.json`과 `receipts/SLICE-*.json`이 `{ schema_version, envelope, payload }`로 emit되며, session receipt의 `parent_run_id`가 consumed `evolve-insights.json`으로 체인되고 `provenance.source_artifacts[]`가 slice run ID를 aggregate.
- `hooks/scripts/envelope.js` — zero-dep envelope 라이브러리(ULID 생성기, git 감지, identity guard와 corrupt-payload defense를 갖춘 `wrapEnvelope`/`unwrapEnvelope`).
- `hooks/scripts/wrap-receipt-envelope.js` — cross-plugin/intra-plugin chain 추출 플래그를 갖춘 payload wrap CLI 헬퍼.
- `scripts/validate-envelope-emit.js` — suite envelope 스키마를 미러링한 zero-dep self-test validator.

### Changed

- 내부 reader와 cross-plugin consumer가 envelope을 감지하고 identity guard를 적용한 뒤 `.payload`로 unwrap; legacy non-envelope receipt는 pass-through(forward-compatible).

## [6.4.2] — 2026-04-29

### Added

- Profile schema v3 + `interactive_each_session` — 매 세션 묻는 항목을 사용자별로 제어, `defaults.*`는 자동 적용.
- `session-recommender` sub-agent(기본 sonnet)가 task와 workspace에서 최적 `team_mode` / `start_phase` / `tdd_mode` / `git` / `model_routing`을 추론.
- 새 플래그: `--no-ask`(ask + recommender 모두 skip, 가장 빠른 경로), `--recommender=MODEL`, `--no-recommender`.
- 멀티 유저 환경용 state-file 권한 가이드(600).

### Changed

- `--profile=X`가 이제 ask 단계를 거침(이전 빠른 경로는 `--no-ask` 추가).
- Profile v2 → v3 자동 마이그레이션: atomic write + flock + idempotent + `.v2-backup` + rollback.

### Fixed

- 플래그 파서의 shell injection(quoted single-string `$ARGUMENTS`가 allowlist 검사 전에 평가되지 않음).
- v6.4.1 `git_branch:` 프로필을 거부하지 않고 변환.
- 정상 git repo의 capability 감지 false negative(`git rev-parse`/`git worktree list` 사용).
- `--profile=X`가 profile loader로 전달됨; preset 수준 설정(`project_type`, `cross_model_preference`, `auto_update`)이 더 이상 silently 누락되지 않음.

### Removed

- 알림 시스템 완전 제거 — `notify.sh`, 그 테스트, 알림 가이드 삭제 및 phase skill에서 notify 가드 정리.

### Breaking

- Slack/Discord/Telegram/webhook 통합이 severed됨; 활성 webhook 사용자는 업그레이드 전 v6.4.1을 fork해야 함.
- bare `--profile=X`에 의존하는 자동화 스크립트는 이전 동작 유지를 위해 `--no-ask`를 추가해야 함.
- Profile v2 → v3 자동 마이그레이션은 `notifications.url` 같은 복구 불가 필드를 잃음(rollback용 `.v2-backup` 보존).

## [6.4.1] — 2026-04-26

### Changed

- SessionStart 센서 감지가 느린 `npx --no-install` probe를 피하고 로컬 `node_modules/.bin` + PATH 조회를 사용하여 missing-tool 환경이 hook 타임아웃 내에 완료.
- Phase 1 Health Engine wiring을 `deep-research`에 문서화; `health-check` CLI가 `.deep-review/fitness.json`을 자동 로드(`--fitness` / `--no-fitness` override).
- `/deep-status`와 `/deep-receipt`가 `health_report.drift.*` / `health_report.fitness.*` 실제 producer 경로를 읽음.

### Fixed

- 테스트 fixture의 lint guard false-positive(예외를 한 파일에서 모든 `*.test.js`로 확장).
- Parent receipt 검증이 empty/arbitrary 센서 결과, `fail`, `timeout`, 미지원 `not_applicable`을 거부하되 문서화된 메타데이터는 수용.
- Health Check CLI가 `--fitness <file>`을 positional project root로 오인하지 않음.

## [6.4.0] — 2026-04-23

### Changed

- **Breaking**: `model_routing.{research,implement,test}="main"` 제거(로드 시 `"sonnet"`로 자동 마이그레이션); `model_routing.plan="main"`은 보존.
- **Breaking**: `team_mode` 의미론을 병렬도만으로 통일(solo=1, team=N); 메인 세션 inline 실행은 명시적 escape hatch.

### Added

- `agents/` 아래 서브에이전트 3개: `research-codebase-worker`(read-only), `research-zerobase-worker`(read-only + 웹 접근), `implement-slice-worker`(TDD 강제).
- `verify-delegated-receipt.sh` + `verify-receipt-core.js` — 8항목 post-hoc receipt 검증.
- verify-receipt 실패 시 rollback 프로토콜(`git reset --hard <snapshot>`); inline escape hatch(auto-routing, `--exec=<inline|delegate>`, debug takeover).
- `scripts/validate-agents.sh` — `agents/*.md` 정적 sanity check.

### Fixed

- experimental-teams 환경변수 누락 시 `team_mode=team`이 solo로 silently fallback.
- 멀티 slice receipt에서 단일 `git_before` baseline 재사용 → per-slice baseline.
- Path-filtered diff가 out-of-scope 편집을 숨김 → unfiltered union-scope check.
- Zero-base 서브에이전트가 Write/Edit/Bash + 웹 접근을 상속 → 명시적 read-only tool allowlist.

## [6.3.1] — 2026-04-21

### Fixed

- Phase skill body echo 버그 — `Skill("deep-*")`가 SKILL.md 템플릿을 노출하고 phase 작업(brainstorm 명확화 질문, research/plan 분석)을 건너뛰던 현상 해결.
- Exit Gate pause/resume 회귀 — `current_phase` 변경을 orchestrator로 일원화하여 "일시정지" 선택 시 `/deep-resume`에서 Exit Gate를 재표시(다음 phase 자동 진입 방지).

### Added

- 5개 phase skill 공통 4계층 echo 방어(admonition 블록, 외부 템플릿, 명시적 First Action, 실행 순서 안전장치).
- 각 5개 phase의 Phase Exit Gate(진행 / 재실행 / 일시정지) — AskUserQuestion.
- 완료-marker 감지: `*_completed_at` 필드 존재 시 phase skill이 orchestrator로 제어 반환.
- Approval integrity hash(`research_approved_hash` / `plan_approved_hash`)로 `/deep-resume`가 out-of-band 편집을 감지하고 편집 문서를 `{research,plan}.v{N}-edit.md`로 백업 후 재검토.
- Backup 파일명 충돌 방지(`-edit` 접미사 vs. skill 자체 `v{N}.md`).

### Known limitations

- Hash-mismatch 복구가 plan-specific validation(Completeness Policy, Contract Negotiation, Phase Review Gate) 없이 generic review/approval flow를 실행; 전체 validation은 Exit Gate "재실행"으로 적용. Backup write 실패가 아직 state 변경을 중단하지 않음.

## [6.3.0] — 2026-04-18

### Added

- **Phase 5 "Integrate"** — Test 이후의 skippable phase로, deep-suite 플러그인 아티팩트를 읽어 AI가 interactive loop(최대 5 라운드)에서 top-3 다음 단계를 추천.
- 수동 재진입용 `/deep-integrate` 커맨드; `/deep-finish`로 바로 가는 `--skip-integrate` 플래그.
- 헬퍼 스크립트, JSON 스키마, fixture를 갖춘 `skills/deep-integrate/`.
- `phase5_work_dir_snapshot` state 필드 — Phase 5 진입 시 기록되는 불변 경계로, 런타임에서 `work_dir`을 변조해도 write 경계를 넓힐 수 없음.
- `phase5-finalize.sh`(Phase 5 중 state를 쓰는 유일한 인가 경로)와 `phase5-record-error.sh`(`terminated_by: "error"` 기록); Stop hook이 `terminated_by: "interrupted"` 기록.

### Changed

- Orchestrator가 Test와 `/deep-finish` 사이에 Phase 5를 dispatch; 에러 시 `--skip-integrate` 전달.
- 새 Phase 5 guard 모드: write는 snapshot `$WORK_DIR` 아래로 제한, state 변조는 `phase5-finalize.sh`로 제한, Bash는 allowlist-only(default-deny) — read-mostly 명령과 `$WORK_DIR` 범위 파일 작업만 허용하고 destructive/in-place/compound 형태는 차단.
- `/deep-integrate` tool allowlist 축소(`Write`, `Edit` 제거).

### Upgrade notes

- snapshot 없이 v6.2.x에서 Phase 5에 진입한 세션은 mutable `work_dir`로 fallback; Phase 5 재진입 시 snapshot 기록. Phase 5 헬퍼는 PATH에 `jq` 필요(`phase5-finalize.sh` 제외).

### Known limitations

- 일부 인터프리터(`Rscript`/`julia`/`lua`/...)와 `awk -f`는 Phase 5 allowlist에 없음; 네트워크 exfil 완화와 per-command invocation audit은 추후 추적. `Agent`/`Skill` tool은 Phase 5 guard를 pass-through.

## [6.2.4] — 2026-04-17

내부 audit에서 식별된 hook-layer 버그와 문서 드리프트를 다루는 버그 수정 릴리스.

### Fixed

- `file-tracker.sh`: BSD 전용 `sed -i ''`를 Node inline 스크립트로 교체(이전 코드는 Linux에서 silently 실패).
- `update-check.sh`: 플러그인 경로를 `process.argv`로 전달하여 apostrophe가 포함된 설치 경로가 update check를 깨지 않음.
- `phase-guard.sh` / `file-tracker.sh` / `phase-transition.sh`: JSON 파서 기반 `file_path` 추출(escaped quote 경로가 truncate되던 문제 해결).
- `phase-transition.sh`: `SESSION_ID`용 innermost `deep-work.XXXX` 세그먼트 추출로 fork worktree 경로가 올바르게 해석.
- Receipt 업데이트를 mkdir 기반 spinlock으로 감싸고 crash-safe pending-changes drain 적용; `sensor-trigger.js`와 `file-tracker.sh`가 state lock 공유.
- `utils.sh write_registry`: lock 타임아웃 시 fail-closed(다른 프로세스 lock을 force-remove하지 않음) + 에러 로깅.
- `phase-guard-core.js`: 내부 에러는 `exit(3)`(의도적 block과 구분); `phase-guard.sh`는 빈 `decision`에 fail-close.
- `phase-guard.sh`: frontmatter에서 `slice_files` / `strict_scope` / `exempt_patterns`를 읽어 slice-scope를 실제로 강제; 모든 block-message heredoc이 interpolated 필드를 JSON-escape.
- `phase-transition.sh` 캐시: `file-tracker.sh`가 phase 기반 early return 전에 stdin을 atomically 캐시하여 모든 phase 전환이 캐시를 refresh.
- `notify.sh`: YAML-aware `notifications.enabled` 파서, `osascript`/PowerShell-toast escaping, `pipefail` 제거.

### Changed

- 문서: 7개 SKILL.md 전반의 깨진 참조 링크 21개 수정; 버전 라벨 refresh; CLAUDE.md 구조 목록 완성.

### Known limitations

- 크로스 플랫폼 CI 매트릭스 미비; 새 portability 수정은 단위 테스트에 의존.

## [6.2.3] — 2026-04-16

### Changed

- `trigger-eval.json` 벤치마크 세트를 31 → 54 샘플로 확장·재조정; standalone 커맨드는 전체 워크플로우 세션을 트리거하지 않도록 재분류.

## [6.2.2] — 2026-04-16

### Fixed

- 5개 hook 커맨드 전부에서 POSIX inline 환경변수 할당 제거(Windows `cmd.exe`가 파싱 불가); 스크립트가 Claude Code의 native 환경변수를 backward-compatible fallback과 함께 직접 읽음.

## [6.2.1] — 2026-04-15

### Changed

- 커맨드 분류 정리: 13개 커맨드를 Quality Gate / Internal / Escape hatch / Utility / Special utility로 재분류; `/deep-finish`를 "자동 호출 우선, 수동 일등급"으로 재구성.
- Hook/skill 가이드가 `/deep-status` 플래그로 라우팅; README(en/ko)와 워크플로우 문서를 새 카테고리로 업데이트.

### Notes

- 삭제된 커맨드 없음, 기능 동작 변화 없음 — 라벨·문구·버전만 변경.

## [6.2.0] — 2026-04-14

### Added

- Cross-Plugin Context: Phase 1 Research가 `harnessability-report.json`(deep-dashboard)과 `evolve-insights.json`(deep-evolve)을 참조.

## [6.1.0]

### Added

- **P0 Worktree Path Guard** — 활성 worktree 외부의 Write/Edit/Bash를 hard-block하는 PreToolUse hook(meta 디렉토리 예외), 모든 phase에 적용.
- **P1 Phase Transition Injector** — `current_phase` 변경 시 worktree/team/cross-model/tdd context를 주입하는 PostToolUse hook.
- 6개 phase skill(phase별 독립 SKILL.md)로 context load 45-81% 감소.
- Review + Approval workflow — Research/Plan용 6단계 프로토콜, orchestrator가 `current_phase` 소유.

### Changed

- 핵심 phase 커맨드를 thin `Skill()` dispatch wrapper로 축소; 공유 참조를 `skills/shared/references/`로 이전.
- `deep-resume`이 Research/Plan resume을 orchestrator로 라우팅; `deep-test`가 성공 시 idle을 설정하지 않음.
- Implement receipt가 `status: "complete"`를 명시적으로 요구; drift gate에 `plan_approved_at` fallback chain.

## [6.0.2]

### Added

- Unified Phase Review Gate — 모든 phase(0-3)가 전환 전 self-review + external review를 실행(phase별 fallback chain + 사용자 확인); `/deep-phase-review`도 동일 chain 사용.

### Changed

- 세션 폴더를 `deep-work/` → `.deep-work/`(hidden)로 rename, 자동 마이그레이션 + worktree 안전 점검; 세션 폴더와 히스토리만 gitignore.

## [6.0.1] — 2026-04-10

### Added

- Superpowers 통합: per-slice 2단계 리뷰(Spec Compliance required + Code Quality advisory), Red Flags 표, pre-flight check, receipt별 `slice_confidence`/`concerns`.
- Phase 4 cross-slice + backfill 리뷰(Phase 3에서 FAIL한 slice는 필수 backfill 대상); 전체 변경 파일 기준 scope-creep 감지; per-slice working-tree diff.

### Changed

- Phase 4 Spec Compliance와 Code Quality 게이트가 cross-slice 일관성에 집중; receipt `git_diff`가 per-slice baseline 사용.

## [6.0.0] — 2026-04-09

### Added

- **Computational Sensor Pipeline** — registry 기반 ecosystem 감지(JS/TS/Python/C#/C++), 8개 output 파서, GREEN 이후 SENSOR_RUN → SENSOR_FIX → SENSOR_CLEAN 상태 머신 확장, 3-round 자기 교정 루프, `/deep-sensor-scan`, fail-closed 정책.
- **Mutation Testing** — Stryker / stryker-net / mutmut 통합, git-diff 범위와 테스트 재생성 루프를 갖춘 `/deep-mutation-test`, Mutation Score quality gate(세션 점수의 15%).
- **Health Engine** — Phase 1 Health Check, 4개 병렬 드리프트 센서(dead-export, stale-config, dependency-vuln, coverage-trend).
- **Architecture Fitness Functions** — `.deep-review/fitness.json`의 선언적 규칙(file-metric, forbidden-pattern, structure, dependency) + validator + ecosystem-aware generator.
- Baseline 관리(`health-baseline.json`, commit/branch 스코핑 + 자동 무효화); Phase 4 Fitness Delta(Advisory)와 Health Required(Required) 게이트; deep-review가 소비하는 receipt `health_report` 필드.
- **Harness Templates** — 6개 내장 토폴로지, deep-merge 로더 + `custom/` override; Phase 1/3 통합.
- **Self-Correction Loop** — `review-check` 센서(always-on 토폴로지 레이어 + fitness 레이어), 센서별 3-round 제한.

### Changed

- Session Quality Score가 5개 가중치 사용(Test Pass 25%, Rework 20%, Plan Fidelity 25%, Sensor Clean 15%, Mutation 15%); Health Check는 점수에서 제외.

## [5.8.1] — 2026-04-08

### Changed

- **Breaking**: deep-review 플러그인과의 이름 충돌 해결을 위해 `/deep-review` → `/deep-phase-review`; phase-문서 리뷰는 rename된 커맨드, 코드-diff 리뷰는 플러그인 사용.

## [5.8.0] — 2026-04-08

### Added

- Completeness Policy — `plan.md`용 명시적 금지 패턴(TBD, TODO, 모호한 지시, 내용 없는 cross-reference).
- Code-sketch 계층화(S 주석 의사코드 / M 시그니처 + 타입 / L 완전한 boundary 코드)와 `failing_test` 상세 계층.
- Slice 필드 `expected_output`과 `steps`; "Boundary: Files NOT to Modify" 섹션; research traceability 태그(`[RF-NNN]`, `[RA-NNN]`)와 lifecycle rule; research Testing Patterns 섹션.
- Brainstorm context-adaptive 질문, Scope Assessment, Boundaries 섹션; review-gate `code_completeness`와 `buildability` 차원 + legacy-plan 호환 fallback.

### Changed

- Slice 파서가 새(선택) 필드를 인식; RED는 `failing_test` 사용, GREEN은 `expected_output` 비교; planning/research 가이드 업그레이드.

## [5.7.0] — 2026-04-08

### Added

- Plan 승인 후 Sprint Contract 생성(deep-review 설치 시) — `plan.md` slice에서 `.deep-review/contracts/`로.
- GREEN 시 per-slice 리뷰 제안(`/deep-review --contract SLICE-NNN`), Phase 4 시 전체 리뷰 제안, Phase 4 이후 wiki-ingest 제안.

### Changed

- Contract 생성을 plan 승인 후로 이동하여 contract가 최종 plan과 일치; 플러그인 감지를 설치 방식 무관하게 통일.

## [5.6.0] — 2026-04-07

### Added

- `/deep-fork` — 다른 접근법 탐색을 위한 세션 fork(git worktree 전체 복제, 또는 non-git에서는 artifacts-only이며 implement/test 차단), parent-child 추적, fork-snapshot baseline, stale-parent 검증, 3-generation 제한.
- `/deep-status --tree`와 `--compare` fork 자동 감지; 기본 status의 fork 정보; `/deep-cleanup` fork 지원; `utils.sh`의 fork 유틸리티 함수.

### Changed

- 세션 registry와 state frontmatter에 fork-relationship 필드 추가.

## [5.5.2] — 2026-04-06

### Added

- 확장된 bash 파일 쓰기 감지(20+ 패턴: perl in-place, `node -e`/`python -c`/`ruby -e` 쓰기, awk, 파괴적 git ops, curl/wget 출력, 아카이브 추출, rsync)와 확장된 safe-command·test-file·TDD-exempt 패턴.
- TDD state 검증과 backtick/subshell-aware 명령 분할.

### Fixed

- **보안**: 파일 쓰기 패턴을 safe-command 패턴보다 먼저 검사(safe 접두사가 더 이상 파일 쓰기를 가리지 않음, 예: `fs.writeFileSync`가 있는 `node -e`).
- `file-tracker.sh` Node 25 `process.argv` 호환성; `assumption-engine.js` 다수 수정(quality-timeline CLI, threshold 전달, dedup keep-latest, array 입력 가드); `session-end.sh` JSON 검증, session-id fallback, 에러 로깅.

### Changed

- Redirect 감지를 mid-command redirect까지 확장; `node -e`를 safe 패턴에서 제거; model-name sanitization과 configurable signal threshold.

## [5.5.1] — 2026-04-03

### Changed

- Team 모드에서 plan phase가 부분 research 파일을 보조 참조로 로드하고 plan 결정을 교차 확인.
- B-1 (RED_VERIFIED)과 B-2 (GREEN) state 업데이트를 phase-guard 차단 경고와 함께 필수로 표시.

### Fixed

- `phase-guard.sh`가 `process.argv` 대신 stdin 파이프로 JSON 입력을 읽어 대용량 입력에서 `set -e` 실패 방지.

## [5.5.0] — 2026-04-02

### Added

- Research Cross-Model Review(codex/gemini)와 전용 research rubric; plan용 Claude self-review; per-conflict 프롬프트를 대체하는 Consolidated Judgment 프로토콜.
- score-regression rollback을 갖춘 auto-fix snapshot 계약; 실패한 reviewer를 추적하는 degraded mode(`reviewer_status`); resume 검증을 갖춘 v5.5 state-schema 마이그레이션.

### Changed

- Structural-review auto-fix 트리거를 score < 7로 상향(research는 최대 3회); research user-feedback 게이트를 consolidated judgment에 통합.

## [5.3.0] — 2026-03-31

### Added

- Document Intelligence — 피드백 적용 시 `research.md`/`plan.md`를 deduplicate·prune하고 refinement log 기록.
- 세션 관련성 감지(out-of-scope 요청에 새 세션 또는 backlog 제안); Plan Fidelity Score(0-100); Session Quality Score(0-100); assumption snapshot과 quality 통합; cross-session 품질 트렌드; shields.io 품질 뱃지.
- `deep-finish`의 authoritative JSONL write(atomic upsert); `session-end.sh`는 provisional 레코드만 기록.

### Fixed

- `session-end.sh`가 공유 `harness-history/`에 기록하여 세션 데이터가 trend/assumption 커맨드에 보임.

### Changed

- README를 problem-solution 내러티브로 재구성(데모 GIF 제거); `exportBadge()`가 구조화된 객체 반환(직접 consumer에 breaking).

## [5.2.0] — 2026-03-31

### Added

- Auto-flow 오케스트레이션 — `/deep-work`가 모든 phase를 자동 체인; plan 승인이 유일한 필수 인터랙션.
- `--receipts` / `--history` / `--report` / `--assumptions` / `--all`을 갖춘 통합 `/deep-status`; `/deep-test`에서 Drift Check(required), SOLID Review(advisory), Insight Analysis 자동 실행.

### Changed

- 13개 보조 커맨드를 deprecated로 표시(여전히 동작); `/deep-work` Step 1이 resume/new/cancel 제공; plan.md Quality Gates 표가 선택적 override로 변경.

### Deprecated

- `/deep-brainstorm`, `/deep-review`, `/deep-receipt`, `/deep-slice`, `/deep-insight`, `/deep-finish`, `/deep-cleanup`, `/deep-history`, `/deep-assumptions`, `/deep-resume`, `/deep-report`, `/drift-check`, `/solid-review`(기능이 auto-flow 또는 `/deep-status`로 통합).

## [5.1.2] — 2026-03-30

### Added

- Team-mode 자동 설정(`~/.claude/settings.json` 구성 제안)과 런타임 검증, 모든 phase에서 자동 Solo fallback.

### Fixed

- 적절한 설정 없이 Team 모드 선택 시 모든 phase에서 안정적으로 Solo로 fallback.

## [5.1.1] — 2026-03-30

### Fixed

- **Critical**: 내부 에러 시 phase-guard fail-closed(강제 우회 없음); receipt JSON 업데이트가 temp-file + rename 사용(동시 hook으로 인한 손상 없음).
- 커맨드 체인 우회 차단(`&&`/`||`/`;`/`|` 하위 명령 독립 검사); bash TDD target 추출; comma-delimited 정확 매칭 skipped-phase; Write/Edit가 `file_path` 누락 시 fail-closed.
- JSONL 히스토리 locking, 크로스 플랫폼 timestamp 파싱, notification JSON escaping, path 정규화, literal YAML 필드 추출, `JSON.stringify` 기반 receipt 초기 생성.

### Changed

- Signal evaluator가 `{ scope, fn }` 형식 사용; `TEST_FILE_PATTERNS` 확장(Rust, Java, C#, Kotlin, Swift).

## [5.1.0] — 2026-03-30

### Added

- Auto-Loop Evaluation(plan-review와 test-phase 자동 재시도 + 에스컬레이션); Contract Negotiation(`contract` / `acceptance_threshold` slice 필드); Wilson Score 기반 Assumption Engine 자동 적용; 적응형 평가자 모델; `--skip-to-implement`.

### Changed

- Structural review가 에스컬레이션 전 최대 3회 auto-loop; 기본 평가자 모델 haiku → sonnet; slice 형식에 contract 필드 추가.

## [5.0.0] — 2026-03-30

### Added

- **Self-Evolving Harness (Assumption Engine)** — 모든 강제 규칙이 machine-readable evidence signal을 갖춘 반증 가능 가설.
- `assumptions.json`(5개 핵심 가설)과 `assumption-engine.js`(Wilson Score 신뢰도, staleness/new-model 감지, 리포트 + ASCII 타임라인 + 뱃지 export).
- `/deep-assumptions` 커맨드; receipt의 per-slice `harness_metadata`; 세션 종료 시 append되는 `harness-sessions.jsonl`; 세션 init과 `/deep-report`의 assumption-health 요약.

## [4.2.1] — 2026-03-26

### Added

- TDD Override — TDD가 production 편집을 차단하면 Claude가 테스트 먼저 작성 또는 이 slice에 TDD 건너뛰기를 사유와 함께 제안(slice-scoped, 전환 시 auto-clear); block 메시지의 escape-hatch 가이드; `tdd_override` state 필드와 receipt 필드.

### Changed

- `phase-guard-core.js` / `phase-guard.sh`가 `tdd_override` 반영; `deep-implement`에 TDD Override flow; receipt/finish/history 표면에 override count 표시.

## [4.2.0] — 2026-03-25

### Added

- 모든 phase 문서의 Structural Review(Claude haiku 서브에이전트); plan의 adversarial cross-model 리뷰(codex / gemini-cli)와 투명한 conflict-resolution UX; 낮은 점수에서 auto-implement 차단하는 Review Gate; `/deep-review`; `--skip-review`; cross-model tool 자동 감지; profile `cross_model_preference`; resume/status의 리뷰 상태; JSON 정규화된 리뷰 결과.

### Changed

- Brainstorm/research/plan에 리뷰 단계 추가; `phase-guard-core.js`가 codex/gemini/mktemp를 safe 패턴에 추가; state와 profile 스키마 확장.

### Fixed

- `.gitignore`가 워크플로우 workspace venv를 제외.

## [4.1.0] — 2026-03-25

### Added

- 기본 worktree 격리(`.worktrees/dw/<slug>/`, `--no-branch`로 opt-out); slice 복잡도 기반 모델 auto-routing(S/M/L/XL) + per-slice override; 4가지 완료 옵션을 갖춘 `/deep-finish`; CI/CD receipt 검증(`validate-receipt.sh`, CI 템플릿, `--format=ci` export); `/deep-history`; `/deep-cleanup`.
- Receipt 스키마 v1.0(slice receipt canonical, session receipt derived) + 마이그레이션 헬퍼; worktree-aware resume; 모델 비용 추적; 공유 `utils.sh`.

### Changed

- 기본 `model_routing.implement` → `"auto"`; 기본 `git_branch` → `true`; `validate-receipt.sh`가 Bash 3.2용 `set -eo pipefail` 사용.

## [4.0.1] — 2026-03-25

### Added

- SessionStart의 Git 기반 auto-update check(자동 업데이트, escalating snooze, opt-out); `phase-guard.sh` / `file-tracker.sh`의 `process.argv`를 통한 shell-injection 방지.

### Fixed

- macOS 호환성(`timeout` 사용 제거); 문서의 버전 일관성.

## [4.0.0] — 2026-03-25

### BREAKING — Evidence-Driven Development Protocol

deep-work가 evidence-driven development 프로토콜로 전환: 모든 코드 변경이 증거(failing/passing 테스트 출력, git diff, spec check, code review)를 JSON receipt으로 수집.

### Added

- Phase 0 Brainstorm(`/deep-brainstorm`, `--skip-brainstorm`로 생략); slice 기반 실행; hook 강제 TDD 상태 머신(모드: strict/relaxed/coaching/spike); per-slice receipt.
- Bash tool 모니터링(non-implement phase에서 파일 쓰기 shell 패턴 차단); 체계적 디버깅(`/deep-debug`); `/deep-slice`; `/deep-receipt`; 2단계 code review; Receipt Completeness와 Verification Evidence 게이트; spike-mode guard.

### Changed

- bash + Node 하이브리드 hook 아키텍처; plan 형식이 slice 체크리스트로; implement/test/plan 전면 재작성; PreToolUse/PostToolUse 매처에 `Bash` 추가.

## [3.3.3] — 2026-03-24

### Added

- 멀티 프리셋 profile 시스템(Profile v2 + `presets:`, v1 → v2 자동 마이그레이션, `--profile=X`, `--setup` 관리 UI, 인터랙티브 선택); false-positive 가드를 갖춘 확장된 trigger-eval 세트.

### Changed

- `/deep-work` profile 로드/저장과 resume을 v2 형식으로 업데이트.

## [3.3.2] — 2026-03-22

### Added

- Profile 시스템 — 첫 실행이 설정 답변을 저장하고 이후 실행이 즉시 적용; override 플래그; `--setup`.
- Artifact 기반 context 복원과 phase auto-continue를 갖춘 세션 resume(`/deep-resume`); `git diff --name-only` 기반 checkpoint 검증.

### Changed

- `/deep-work`를 profile 로드/저장 중심으로 재구성; implement에 checkpoint mandate와 post-agent 검증 추가.

## [3.3.0] — 2026-03-22

### Added

- Insight Tier Quality Gate(`/deep-insight`, 내장 분석, `insight-report.md`, 차단 없음); `file-changes.log`로의 PostToolUse 파일 추적; 세션 종료 리마인더용 Stop hook.

### Changed

- `hooks.json`을 PreToolUse + PostToolUse + Stop으로 확장; `/deep-test`가 ℹ️ insight 마커를 파싱하고 내장 Insight 단계 추가; 리포트와 status가 새 아티팩트를 읽음.

## [3.2.2] — 2026-03-21

### Added

- 다국어 지원 — 모든 커맨드 파일이 사용자 언어를 감지하여 메시지를 출력(한국어 템플릿이 참조), 영어/일본어/중국어/기타 사용자가 수정 없이 사용 가능.

## [3.2.1] — 2026-03-21

### Fixed

- SKILL.md description 축소(~1,500 → ~450자)와 changelog bloat 제거; `deep-research.md` 단계 재번호; `deep-test.md`가 allowed-tools에서 `Edit` 제거; 커맨드 description 언어 표준화; `notify.sh` 메시지 escaping; SKILL.md의 명시적 phase-guard 경로.

### Added

- state 파일과 세션 아티팩트의 우발적 커밋을 방지하기 위해 `.npmignore`를 미러링한 `.gitignore`.

## [3.2.0] — 2026-03-18

### Added

- 3계층 Quality Gate 시스템(Required / Advisory / Insight); Plan Alignment / Drift Detection(`/drift-check` + 내장 게이트, `drift-report.md`); SOLID Design Review(`/solid-review` + advisory 게이트, `solid-review.md`); SOLID 리뷰 가이드.

### Changed

- `/deep-test`가 다른 게이트 전에 Plan Alignment를 자동 실행; SKILL.md 재구성; state 스키마에 `plan_approved_at` 추가.

## [3.1.0] — 2026-03-17

### Breaking

- 저장소 구조를 `plugins/deep-work/` 서브디렉토리로 마이그레이션 — 기존 사용자는 재설치 필요.

### Added

- Model Routing(phase별 모델 배정, 30-40% 토큰 절감); 멀티 채널 알림; 증분 research(`--incremental`, 60-80% 시간 절감); Quality Gate 시스템; Plan Diff 시각화; routing/notification 가이드.

### Changed

- `/deep-work` init, `/deep-status`, `/deep-report`가 새 옵션 표면화; state 스키마와 marketplace source 경로 업데이트.

## [3.0.0] — 2026-03-13

### Added

- 자동 감지 테스트/lint/type-check 명령과 fix-and-retest 루프(최대 3회 재시도), `test-results.md`, Test-phase 편집 차단을 갖춘 Phase 4 Test(`/deep-test`).
- 새 프로젝트용 Zero-Base 모드; 인터랙티브 plan 리뷰(피드백이 `plan.md` 업데이트); plan 버전 백업과 6개 템플릿; 부분/캐시 research; git 브랜치 + commit 제안; implement checkpoint; phase별 시간 추적; team-mode 진행; `/deep-status --compare`.

### Changed

- Phase 흐름이 `research → plan → implement → test ⟲ → idle`로; Executive Summary / Plan Summary를 먼저 배치(피라미드 원칙); phase-guard block 메시지에 next-step 가이드; state 스키마와 SKILL.md 확장.

## [2.0.0] — 2026-03-07

### Added

- Per-task 폴더 히스토리(`deep-work/YYYYMMDD-HHMMSS-slug/`); plan 승인 시 implementation 자동 시작; 자동 생성 세션 리포트; `/deep-report`; `/deep-status`; 3-agent 병렬 research와 cross-review를 갖춘 Solo/Team 모드.

### Changed

- State 파일에 `work_dir` / `team_mode` / `started_at` 추가; Phase Guard가 `deep-work/` 내 문서 편집 허용.

## [1.1.0] — 2026-03-01

### Added

- Research/Plan 중 코드 파일 편집을 차단하는 Phase Guard(PreToolUse hook); state 파일 기반 phase 관리.

### Changed

- 프롬프트 기반 접근에서 hook 기반 강제로 마이그레이션.

## [1.0.0] — 2026-02-15

### Added

- 최초 릴리스: 3단계 워크플로우(Research → Plan → Implement); `/deep-work`, `/deep-research`, `/deep-plan`, `/deep-implement`; `research.md` / `plan.md` 아티팩트; 반복적 plan 리뷰.
