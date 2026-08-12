---
name: solid-review
description: "SOLID design-principles review (SRP / OCP / LSP / ISP / DIP) on a file/directory/glob. Review-only. Triggers on `/solid-review`, \"SOLID review\", \"design review\", \"design principles\", \"SOLID 검증\", \"디자인 리뷰\", \"원칙 검증\", or `/deep-test` running it as the Advisory Gate."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Auto-detect scope: 활성 세션의 changed files, 없으면 현재 디렉터리 |
| `<target>` | File path / directory / glob pattern |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites


> **Quality Gate** — `/deep-test`가 Advisory Gate로 자동 실행합니다. 특정 파일/디렉터리에 대한 독립 SOLID 검증이 필요할 때 직접 사용하세요.
> Standalone: `/solid-review [target]`

# SOLID Design Review

You are performing a **SOLID Design Review** — analyzing code against the 5 SOLID design principles to evaluate design quality and suggest improvements.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Critical Constraints

- **DO NOT modify any code files.** This is a review-only operation.
- **Read, analyze, and report findings.**
- **Save review results to file when in workflow mode.**

## Instructions

### 1. Determine operating mode

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply only its **Reusable session-state resolution** section to resolve `$STATE_FILE`; retain this skill's own no-session and standalone-mode behavior.

Check if `$STATE_FILE` exists and has an active session (`current_phase` is not `idle` and not empty).

**Workflow Mode** (active deep-work session):
- Read `work_dir` from the state file
- Set `WORK_DIR` to the value of `work_dir`
- Read `$WORK_DIR/plan.md` to extract the list of files to review (from "Files to Modify" section)
- Read `$WORK_DIR/research.md` for architectural context (Executive Summary section only)
- Review scope: files listed in plan.md that were actually modified during implementation

**Standalone Mode** (no active session):
- If `$ARGUMENTS` is provided: use as target (file path, directory, or glob pattern)
- If `$ARGUMENTS` is empty: detect scope automatically:
  1. Check `git diff --name-only HEAD~1` for recently changed files
  2. If not a git repo or no changes, use current directory
- Review scope: all code files in detected scope (exclude node_modules, .git, __pycache__, build, dist, etc.)

### 2. Collect review targets

Gather the list of files to review. For each file:
- Read the file contents
- Skip files that are clearly not code (README.md, .json config, .env, etc.)
- Skip files smaller than 5 lines (trivial)
- Skip auto-generated files (migrations, lock files, bundled output)

If the total number of files exceeds 20, prioritize:
1. Files with the most lines of code
2. Files with class/interface definitions
3. Files explicitly listed in plan.md (workflow mode)

Display progress:
```
SOLID 리뷰 대상: [N]개 파일
  - src/auth/service.ts (245 lines)
  - src/models/user.ts (180 lines)
  - ...
```

### 3. Analyze each principle

For each file (or logical group of related files), evaluate against all 5 SOLID principles.

Read `${CLAUDE_PLUGIN_ROOT}/skills/shared/references/solid-guide.md` for the detailed checklist.

**Analysis approach**:
- Do NOT mechanically check every rule against every file
- Focus on **violations that actually matter** in the given context
- Consider the project's scale and maturity (KISS balance)
- A small utility script doesn't need DIP — flag it only in core domain logic

For each principle, assign one of:
- **준수**: No violations found, or principle is not applicable
- **개선 권장**: Minor violations that would improve maintainability
- **위반**: Clear violations that will cause maintenance problems

### 4. Generate scorecard

#### Per-file scorecard (for each reviewed file):

```markdown
### [filename] ([N] lines)

| 원칙 | 상태 | 요약 |
|------|------|------|
| SRP  | [status] | [1-line summary] |
| OCP  | [status] | [1-line summary] |
| LSP  | [status] | [N/A or finding] |
| ISP  | [status] | [1-line summary] |
| DIP  | [status] | [1-line summary] |
```

#### Overall scorecard:

```markdown
## 종합 SOLID 스코어카드

| 원칙 | 전체 상태 | 위반 파일 수 | 핵심 발견 |
|------|----------|-------------|----------|
| SRP  | [status] | N/M         | [most common issue] |
| OCP  | [status] | N/M         | — |
| LSP  | [status] | N/M         | — |
| ISP  | [status] | N/M         | [most common issue] |
| DIP  | [status] | N/M         | [most common issue] |

**총점**: N/5 원칙 준수
**판정**: 개선 권장 (Advisory — 워크플로우 차단 없음)
```

### 5. Generate refactoring suggestions

For each violation or improvement finding, provide a concrete refactoring suggestion. Limit to **top 5 suggestions** sorted by impact:

```markdown
## 리팩토링 제안

### 1. [SRP] PlayerController.cs — 책임 분리
**현재**: 이동, 입력, UI 업데이트가 한 클래스에 혼재
**제안**: PlayerMover, PlayerInput, PlayerUI로 분리
**우선순위**: 높음

### 2. [DIP] AuthService.ts — 추상화 도입
**현재**: `new DatabaseClient()` 직접 생성
**제안**: `IDatabaseClient` 인터페이스 추출, 생성자 주입
**우선순위**: 중간
```

### 6. AI 프롬프트 개선 제안 (워크플로우 모드, 선택적)

If running in **workflow mode** and clear SOLID violations were found, read `${CLAUDE_PLUGIN_ROOT}/skills/shared/references/solid-prompt-guide.md` and suggest how plan.md could be improved:

```markdown
## AI 프롬프트 개선 제안

다음 plan 작성 시 아래 조건을 추가하면 SOLID 위반을 사전에 방지할 수 있습니다:
- "각 클래스는 단일 책임만 담당하도록 분리할 것 (SRP)"
- "새 기능 추가 시 기존 코드 수정 없이 확장 가능한 구조로 설계할 것 (OCP)"
- "구체 클래스 대신 인터페이스에 의존하도록 구현할 것 (DIP)"
```

### 7. Save results

**Workflow Mode**:
- Write results to `$WORK_DIR/solid-review.md`
- Display summary in terminal

**Standalone Mode**:
- Display full results in terminal
- Ask user: "리뷰 결과를 파일로 저장할까요? (기본: 아니오)"
- If yes, save to `./solid-review.md`

### 8. Workflow integration (workflow mode only)

If called as a Quality Gate during Test phase:
- Record results in `quality-gates.md` as Advisory entry
- Violations do NOT block the workflow — record warning only

If called outside the Test phase:
- Still run the review
- Note: "deep-work 워크플로우 활성 상태 — 결과가 $WORK_DIR/solid-review.md에 저장됩니다"
