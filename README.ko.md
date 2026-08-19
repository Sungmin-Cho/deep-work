[English](./README.md) | **한국어**

# deep-work

[![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/deep-work?label=version)](https://github.com/Sungmin-Cho/deep-work)
[![license](https://img.shields.io/github/license/Sungmin-Cho/deep-work)](./LICENSE)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/deep-suite)

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)와 Codex를 위한 **Evidence-Driven Development Protocol**. 단일 커맨드가 Brainstorm → Research → Spec → Plan → Implement → Test → Integrate 전체 워크플로우를 구동하며, TDD 강제, receipt 기반 증거 수집, 계획과 코딩의 엄격한 분리를 제공합니다.

deep-work는 복잡한 작업에서 AI 코딩이 흔히 빠지는 실패 모드를 차단합니다: 기존 아키텍처를 무시한 새 패턴 도입, 이미 존재하는 유틸리티 재구현, 코드베이스를 이해하기 전에 구현 시작, 요청하지 않은 "개선"으로 인한 버그, 검증 없이 완료 처리.

## deep-suite에서의 역할

deep-work는 [deep-suite](https://github.com/Sungmin-Cho/deep-suite)의 **핵심 하네스 엔진**으로, [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) 프레임워크(Böckeler/Fowler, 2026)를 구현합니다. Guide/Sensor × Computational/Inferential 매트릭스에서:

- **Computational Guides** — Phase Guard hook(편집 물리적 차단), Worktree Guard(P0, worktree 외부 쓰기 hard-block), 자동 stop-and-replan이 포함된 인증된 correct-RED → GREEN → REFACTOR 권위, 토폴로지 템플릿.
- **Computational Sensors** — linter/typecheck/coverage/mutation 파이프라인, 드리프트 센서, fitness 규칙, review-check 센서, Phase Transition Injector(P1).
- **Inferential Guides** — research / plan / brainstorm 문서, Sprint Contract.
- **Self-Correction Loop** — SENSOR_RUN → SENSOR_FIX → SENSOR_CLEAN, 센서별 3-round 제한.

[deep-review](https://github.com/Sungmin-Cho/deep-review)와 [deep-dashboard](https://github.com/Sungmin-Cho/deep-dashboard)가 소비하는 producer-authenticated functional receipt, governed progress projection, health report를 생성합니다.

## 설치

`claude-deep-suite` 마켓플레이스 (권장):

```bash
/plugin marketplace add Sungmin-Cho/deep-suite
/plugin install deep-work@claude-deep-suite
```

이 저장소에서 단독 설치:

```bash
/plugin marketplace add Sungmin-Cho/deep-work
/plugin install deep-work@Sungmin-Cho-deep-work
```

deep-work는 Claude Code와 Codex 플러그인 런타임 모두에서 동작합니다 — 각자 native manifest를 읽고, skill 호출자는 동일한 skill-native invocation 모델을 사용합니다.

> **Windows**: hook 스크립트는 PATH에 `bash`가 필요합니다 (Git for Windows 또는 WSL).

## 사용법

전체 워크플로우가 skill 호출 하나로 실행되며, plan 승인이 유일한 필수 인터랙션입니다.

```bash
# 전체 auto-flow 실행: Brainstorm → Research → Spec → Plan → [승인] → Implement → Test → Integrate → Report
$deep-work:deep-work "JWT 기반 사용자 인증 구현"

# 통합 상태 조회 — 플래그는 standalone skill과 동일한 구현으로 라우팅됨
$deep-work:deep-status              # 현재 진행 상태
$deep-work:deep-status --report     # 세션 리포트
$deep-work:deep-status --receipts   # receipt 대시보드
$deep-work:deep-status --history    # 크로스 세션 트렌드
$deep-work:deep-status --assumptions # 가설 건강도
$deep-work:deep-status --all        # 전체 통합 뷰
$deep-work:deep-status --compare    # 두 세션 비교
```

Claude Code에서는 동일한 표면을 슬래시 커맨드로도 사용할 수 있으며, Codex 등 다른 호스트에서는 `$deep-work:<verb>` skill 형태를 사용합니다.

## Skills

deep-work는 27개 command-equivalent skill을 노출합니다. 가장 많이 쓰는 것:

| Skill | 설명 |
|---|---|
| `$deep-work:deep-work <task>` | Auto-flow 오케스트레이션 — 전체 파이프라인 실행; plan 승인이 유일한 필수 인터랙션 |
| `$deep-work:deep-research` | Phase 1 (Research) — 코드베이스 심층 분석 |
| `$deep-work:deep-spec` | Phase 2 (Spec) — 실행 가능한 requirement, failure mode, evidence gate |
| `$deep-work:deep-plan` | Phase 3 (Plan) — slice 기반 구현 계획 |
| `$deep-work:deep-implement` | Phase 4 (Implement) — TDD 강제 slice 실행 |
| `$deep-work:deep-test` | Phase 5 (Test) — receipt + spec + quality gate; drift-check·SOLID·insight 자동 실행 |
| `$deep-work:deep-integrate` | Phase 6 (Integrate) — 크로스 플러그인 다음 단계 추천 루프 |
| `$deep-work:deep-status` | 통합 뷰 (`--report` / `--receipts` / `--history` / `--assumptions` / `--all` / `--compare`) |
| `$deep-work:deep-finish` | 세션 종료 — worktree merge / PR / keep / discard |
| `$deep-work:deep-debug` | 체계적 디버깅: investigate → analyze → hypothesize → fix |

그 외 skill은 quality gate(`drift-check`, `solid-review`, `deep-insight`), 세션 유틸리티(`deep-fork`, `deep-resume`, `deep-cleanup`, `deep-slice`), 툴체인 헬퍼(`deep-mutation-test`, `deep-sensor-scan`, `deep-phase-review`), read-only status 서브 skill(`deep-report`, `deep-receipt`, `deep-history`, `deep-assumptions`)을 다룹니다. 모두 수동 호출 가능하며, 다수는 auto-flow 내에서 자동 실행됩니다.

## 워크플로우

| Phase | 역할 |
|---|---|
| **0 — Brainstorm** | 선택적 디자인 탐색, "왜 만드는가" (`--skip-brainstorm`으로 생략) |
| **1 — Research** | 아키텍처·패턴·데이터·API·인프라·리스크 전반의 코드베이스 분석; `research.md` 산출 |
| **2 — Spec** | 실행 가능한 requirement, invariant, failure mode, compatibility, evidence gate; `spec.md` 산출 |
| **3 — Plan** | per-slice TDD 필드를 갖춘 slice 기반 계획, 사용자 승인 필요; `plan.md` 산출 |
| **4 — Implement** | TDD 강제 slice 실행: failing test → production code → receipt |
| **5 — Test** | receipt 완전성·spec compliance·code quality·검증 증거, 최대 3회 implement→test 재시도 |
| **6 — Integrate** | deep-suite 플러그인 아티팩트를 읽어 최대 3개 다음 단계 제안하는 skippable 루프 (`--skip-integrate`로 생략) |

Integrate 이전 각 phase는 명시적 Exit Gate(진행 / 수정 / 일시정지)로 끝납니다. Brainstorm·Research·Spec·Plan·Test에서는 코드 파일 편집이 물리적으로 차단되며(`echo >`, `sed -i`, `cp` 같은 파일 쓰기 Bash 명령 포함), Implement에서는 파일 변경과 receipt 데이터가 자동 수집됩니다.

## 산출물

각 세션의 산출물은 `.deep-work/<작업폴더>/`에 저장됩니다:

| 파일 | 생성 시점 | 설명 |
|---|---|---|
| `research.md` | Phase 1 | 코드베이스 분석 (Executive Summary 먼저) |
| `spec.md` | Phase 2 | 실행 가능한 requirement, failure mode, evidence-gate contract |
| `plan.md` | Phase 3 | 구현 계획 (per-slice contract + acceptance 필드) |
| `plan.v{N}.md` / `plan-diff.md` | Plan 재작성 | 이전 plan 백업 / 구조적 변경 비교 |
| `brainstorm.md` | Phase 0 | 문제 정의, 접근법 비교, 성공 기준 |
| `receipts/SLICE-NNN.json` | Phase 3 | Per-slice 증거: TDD 출력, git diff, spec check, 리뷰, 모델 |
| `file-changes.log` | Phase 3 | slice 매핑을 갖춘 자동 파일 변경 추적 |
| `test-results.md` | Phase 4 | 검증 결과 (시도별 누적) |
| `quality-gates.md` / `drift-report.md` / `solid-review.md` / `insight-report.md` | Phase 4 | Quality gate, plan 정합성, SOLID, 메트릭 리포트 |
| `report.md` | 세션 완료 | Phase 소요 시간 포함 전체 세션 리포트 |
| `session-receipt.json` | 세션 종료 | 크로스 slice 세션 요약 (M3 envelope) |
| `debug-log/RC-NNN.md` | Phase 3 (디버깅) | Root cause 분석 노트 |
| `harness-history/harness-sessions.jsonl` | 세션 종료 | Per-session assumption-engine 데이터 |

세션 상태는 `.claude/deep-work.local.md`에 YAML frontmatter로 저장됩니다 (current phase, work dir, TDD state, model routing, worktree 정보, quality gate, health report 등).

## Hooks

훅은 세션 라이프사이클과 computational enforcement를 관리합니다.

| 훅 | 트리거 | 용도 |
|---|---|---|
| SessionStart (`update-check.sh`) | 시작/재개 | Git 기반 버전 업데이트 확인 |
| PreToolUse (`phase-guard.sh`) | Write/Edit/MultiEdit/Bash | Phase 기반 편집 차단 + P0 Worktree Path Guard + non-implement dangerous-command denylist |
| PostToolUse (`file-tracker.sh`) | Write/Edit/MultiEdit/Bash | Implement 중 파일 변경 추적, receipt 업데이트 |
| PostToolUse (`sensor-trigger.js`) | Write/Edit/MultiEdit/Bash | computational 센서 파이프라인 트리거 (lint, typecheck, review-check) |
| PostToolUse (`phase-transition.sh`) | Write/Edit/MultiEdit | P1 Phase Transition Injector — phase 전환 시 worktree/team/cross-model context 주입 |
| Stop (`session-end.sh`) | CLI 세션 종료 | 활성 세션 알림, worktree 정보, phase cache 정리 |

Phase Guard denylist는 위험한 non-implement Bash도 차단합니다 (예: `curl | sh`, 보호 경로의 `rm -rf`, `npm publish`, 파괴적 `kubectl`/SQL, `dd`/`mkfs`). 각 family에는 `CLAUDE_ALLOW_*` override 환경변수가 있습니다.

## 주요 기능

- **TDD 강제** — hook 강제 상태 머신(PENDING → RED → RED_VERIFIED → GREEN_ELIGIBLE → GREEN → REFACTOR)이 failing test가 존재할 때까지 production 코드 편집을 차단. 모드: `strict`, `relaxed`, `coaching`, `spike` + slice-scoped TDD override.
- **Worktree 격리** — 세션이 기본적으로 격리된 git worktree(`.worktrees/dw/<slug>/`)에서 실행; `/deep-finish`가 merge / PR / keep / discard 제공. `--no-branch`로 opt-out.
- **Model routing** — phase별·slice별 모델 배정(S→haiku, M/L→sonnet, XL→opus)으로 토큰 비용 절감; slice별 또는 preset routing table로 override.
- **M3 envelope receipt** — `session-receipt.json`과 slice receipt이 identity-triplet guard와 chained provenance를 갖춘 크로스 플러그인 envelope으로 emit되며, `validate-receipt.sh`와 CI 템플릿으로 검증.
- **Health Engine + 아키텍처 fitness** — Phase 1이 병렬 드리프트 센서(dead-export, stale-config, dependency-vuln, coverage-trend)를 실행하고 `.deep-review/fitness.json`의 선언적 규칙을 검증; Phase 4에 Fitness Delta(advisory)와 Health Required(required) 게이트 추가.
- **품질 측정** — 모든 세션이 Session Quality Score(테스트 통과율, 재작업 사이클, plan fidelity, 센서 클린율, mutation score)를 산출하고 세션 간 추세를 추적.
- **자기 진화 규칙** — Assumption Engine이 각 강제 규칙을 반증 가능 가설로 취급하고 세션 품질 증거에 따라 완화 또는 강화를 제안.
- **멀티 모델 리뷰** — phase 문서를 structural review하고, codex 및/또는 gemini-cli 설치 시 plan에 adversarial cross-model 리뷰 적용(`--skip-review`로 생략). [codex](https://github.com/openai/codex) · [gemini-cli](https://github.com/google/gemini-cli).
- **프로필 & 플래그** — named preset(`--profile=X`, `--setup`)과 세션별 override(`--team`, `--zero-base`, `--skip-research`, `--skip-to-implement`, `--tdd=MODE`).
- **다국어 지원** — 모든 메시지가 사용자 언어를 자동으로 따름(한국어 참조 템플릿, 실시간 번역).

## 플러그인 연동

deep-work는 sibling 플러그인이 설치된 경우 연동되며, 모든 동작 전 사용자 확인을 거칩니다:

- **deep-review** — 승인된 slice에서 `.deep-review/contracts/` 생성, slice·전체 리뷰 제안, 아키텍처 인식 리뷰를 위해 `fitness.json` + `health_report` 공유.
- **deep-wiki** — 세션 후 research와 설계 결정 아카이브를 위해 `/wiki-ingest report.md` 제안.
- **deep-memory** — Phase 1에서 크로스 프로젝트 brief recall, Phase 5에서 `/deep-memory-harvest` 추천(opt-in, read-only).

## 링크

- [CHANGELOG](CHANGELOG.ko.md) — 릴리스 히스토리
- [deep-suite](https://github.com/Sungmin-Cho/deep-suite) — 마켓플레이스와 sibling 플러그인
- [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md)

## 라이선스

MIT
