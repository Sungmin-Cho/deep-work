---
name: deep-insight
description: "Code-metrics, complexity and dependency report for a file/directory/glob — analysis only, never modifies code. Triggers on `/deep-insight`, \"code insight\", \"complexity report\", \"code metrics\", \"메트릭 분석\", \"복잡도 리포트\", \"의존성 분석\", or `/deep-test` running it as the Insight Tier (never blocks)."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Auto-detect scope: 활성 세션의 changed files, 없으면 현재 디렉터리 |
| `<target>` | File path / directory / glob pattern |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites


> **Quality Gate** — `/deep-test`가 Insight Tier로 자동 실행합니다 (차단 없음). 특정 대상의 메트릭/복잡도/의존성 분석이 필요할 때 직접 사용하세요.
> Standalone: `/deep-insight [target]`

# Code Insight Analysis

You are performing a **Code Insight Analysis** — measuring code metrics, complexity indicators, and dependency patterns to provide informational reports. This is the **Insight tier** of the 3-tier Quality Gate system.

## Critical Constraints

- **DO NOT modify any code files.** This is an analysis-only operation.
- **Read, analyze, and report findings.**
- **Insight results NEVER block the workflow.** They are purely informational.
- **Save analysis results to file when in workflow mode.**

## Instructions

### 1. Determine operating mode

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply only its **Reusable session-state resolution** section to resolve `$STATE_FILE`; retain this skill's own no-session and standalone-mode behavior.

Check if `$STATE_FILE` exists and has an active session (`current_phase` is not `idle` and not empty).

**Workflow Mode** (active deep-work session):
- Read `work_dir` from the state file
- Set `WORK_DIR` to the value of `work_dir`
- Read `$WORK_DIR/plan.md` to extract the list of files (from "Files to Modify" section)
- Cross-reference with actual changes: `git diff --name-only` from baseline
- If `$WORK_DIR/file-changes.log` exists, use it for additional file tracking data
- Analysis scope: files listed in plan.md that were actually modified

**Standalone Mode** (no active session):
- If `$ARGUMENTS` is provided: use as target (file path, directory, or glob pattern)
- If `$ARGUMENTS` is empty: detect scope automatically:
  1. Check `git diff --name-only HEAD~1` for recently changed files
  2. If not a git repo or no changes, use current directory
- Analysis scope: all code files in detected scope (exclude node_modules, .git, __pycache__, build, dist, .next, vendor, etc.)

### 2. Collect analysis targets

Gather the list of files to analyze. For each file:
- Skip files that are clearly not code (README.md, .json config, .env, .lock, etc.)
- Skip files smaller than 3 lines (trivial)
- Skip auto-generated files (migrations, lock files, bundled output, .min.js)

If the total number of files exceeds 50, prioritize:
1. Files with the most lines of code
2. Files modified most recently
3. Files explicitly listed in plan.md (workflow mode)

Display progress:
```
ℹ️ Insight 분석 대상: [N]개 파일
  - src/auth/service.ts (245 lines)
  - src/models/user.ts (180 lines)
  - ...
```

If exceeding 50 files:
```
⚠️ 분석 대상이 50개를 초과합니다. 상위 50개 파일만 분석합니다.
```

### 3. Run built-in analyses

Execute 4 categories of analysis. Each analysis should be resilient — if one fails, continue with the rest.

#### 3A. File Metrics

For each target file, measure:
- **Lines of code** (excluding blank lines and comment-only lines)
- **Function/method count**: Use `grep -c` patterns appropriate for the language:
  - JS/TS: `function `, `=> {`, method definitions in classes
  - Python: `def `
  - Go: `func `
  - Rust: `fn `
  - Java/Kotlin: method patterns
  - Other: best-effort grep
- **Export count** (JS/TS: `export `, Python: `__all__`, Go: uppercase functions)

Generate summary table:

```markdown
## A. 파일 메트릭

| 파일 | 코드 줄 수 | 함수 수 | Export 수 |
|------|-----------|---------|----------|
| src/auth.ts | 245 | 12 | 5 |
| src/db.ts | 180 | 8 | 3 |

**합계**: 코드 425줄, 함수 20개, Export 8개
```

#### 3B. Complexity Indicators

For each target file, check:
- **Long files**: files exceeding 300 lines → flag with line count
- **Long functions**: functions exceeding 50 lines → identify function name and line range
  - Use heuristic: find function declarations, then count lines until matching closing brace/dedent
- **Deep nesting**: maximum indentation depth (count leading spaces/tabs)
  - Threshold: > 4 levels of nesting

Generate findings:

```markdown
## B. 복잡도 지표

### 대형 파일 (300줄 초과)
| 파일 | 줄 수 | 상태 |
|------|------|------|
| src/auth.ts | 456 | ⚠️ 대형 |

### 장함수 (50줄 초과)
| 파일 | 함수명 | 줄 수 |
|------|--------|------|
| src/auth.ts | handleLogin | 82 |

### 깊은 중첩 (4단계 초과)
| 파일 | 최대 깊이 | 위치 |
|------|----------|------|
| src/parser.ts | 6 | line 45-78 |

**요약**: 대형 파일 N개, 장함수 N개, 깊은 중첩 N개
```

If no issues found for a subcategory, display: "없음 ✅"

#### 3C. Dependency Analysis

For each target file, parse import/require statements:
- **JS/TS**: `import ... from '...'`, `require('...')`
- **Python**: `import ...`, `from ... import ...`
- **Go**: `import "..."`, `import (...)`
- **Other**: best-effort pattern matching

Build a simple adjacency list of internal dependencies (skip external packages).

Check for:
- **Circular dependencies**: Simple DFS cycle detection among internal modules
  - If cycles found, list each cycle as: `A → B → C → A`
- **Import depth**: Maximum chain length in the dependency graph
- **Hub files**: Files imported by 5+ other files (potential coupling hotspot)

Generate findings:

```markdown
## C. 의존성 분석

### Import 통계
| 파일 | Import 수 | 내부 | 외부 |
|------|----------|------|------|
| src/auth.ts | 8 | 3 | 5 |

### 순환 참조
없음 ✅
(or: ⚠️ 순환 참조 발견: src/a.ts → src/b.ts → src/a.ts)

### Hub 파일 (5+ 참조)
| 파일 | 참조 수 |
|------|---------|
| src/utils.ts | 12 |

### Import 깊이
최대 Import 체인: 4 (src/page.ts → src/auth.ts → src/db.ts → src/config.ts)
```

#### 3D. Change Summary (workflow mode only)

Only execute this section when in workflow mode with an active session.

Read `$WORK_DIR/file-changes.log` if it exists, or fall back to `git diff --stat`.

Generate:

```markdown
## D. 변경 요약

| 항목 | 값 |
|------|---|
| 총 변경 파일 수 | N |
| 신규 생성 | N |
| 수정 | N |
| 삭제 | N |
| 추가 줄 수 | +N |
| 삭제 줄 수 | -N |

### 파일별 수정 횟수 (file-changes.log 기준)
| 파일 | 수정 횟수 |
|------|----------|
| src/auth.ts | 5 |
| src/db.ts | 3 |
```

If neither `file-changes.log` nor git data is available, display:
```
변경 데이터 없음 — git diff 또는 file-changes.log를 사용할 수 없습니다.
```

### 4. Execute user-defined Insight gates (workflow mode)

If in workflow mode and `$WORK_DIR/plan.md` contains a Quality Gates table with ℹ️ markers:

1. Parse each ℹ️ gate: extract gate name and command
2. Execute each command
3. Record the result (output, exit code) — but NEVER treat failure as blocking
4. Include results in the Insight Gates section

```markdown
## 사용자 정의 Insight Gates

| Gate | 명령어 | 결과 | 출력 |
|------|--------|------|------|
| Complexity Score | `npx complexity-report` | ℹ️ INFO | score: 12.3 |
```

If a user-defined Insight gate command fails:
```
| Gate Name | `command` | ℹ️ SKIP | 명령어 실행 실패 (exit code: N) |
```

### 5. Generate overall summary

Combine all analyses into a concise overview:

```markdown
## 종합 인사이트 요약

| 카테고리 | 핵심 수치 | 주목 포인트 |
|----------|----------|------------|
| 파일 메트릭 | N파일, N줄, N함수 | — |
| 복잡도 | 대형 N / 장함수 N / 깊은 중첩 N | [가장 심각한 항목] |
| 의존성 | 순환 참조 N / Hub N / 최대 깊이 N | [가장 심각한 항목] |
| 변경 요약 | +N/-N줄, N파일 | — |

**판정**: ℹ️ Insight — 워크플로우 차단 없음, 참고용 정보 제공
```

### 6. Save results

**Workflow Mode**:
- Write full results to `$WORK_DIR/insight-report.md`
- Display summary in terminal:
  ```
  ℹ️ Insight 분석 완료 — 결과가 $WORK_DIR/insight-report.md에 저장되었습니다.
  ```

**Standalone Mode**:
- Display full results in terminal
- Ask user: "분석 결과를 파일로 저장할까요? (기본: 아니오)"
- If yes, save to `./insight-report.md`

### 7. Workflow integration (workflow mode only)

If called as a Quality Gate during Test phase:
- Record results in `quality-gates.md` as Insight entry
- Results do NOT affect pass/fail determination — always informational only

If called outside the Test phase:
- Still run the analysis
- Note: "deep-work 워크플로우 활성 — 결과가 $WORK_DIR/insight-report.md에 저장됩니다"

### 8. Error resilience

If any analysis section fails (e.g., no git repo, unsupported language):
- Log the error inline: `⚠️ [Section Name] 분석 실패: [reason]`
- Continue with remaining analyses
- NEVER abort the entire analysis due to a single section failure
- NEVER return a non-zero/blocking result
