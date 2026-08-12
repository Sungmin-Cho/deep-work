---
name: drift-check
description: "Plan-alignment verification — approved plan vs actual implementation, reporting unimplemented items, out-of-scope changes and design drift. Read-only. Triggers on `/drift-check`, \"plan drift\", \"drift detection\", \"plan alignment\", \"플랜 드리프트\", \"계획 정합성\", \"드리프트 검증\", or `/deep-test` running it as the Required Gate."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | 활성 세션의 plan.md 사용 |
| `<plan-file-path>` | 명시된 plan 파일 경로 |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites


> **Quality Gate** — `/deep-test`가 Required Gate로 자동 실행합니다. 특정 plan 파일에 대한 독립 검증이 필요할 때 직접 사용하세요.
> Standalone: `/drift-check [plan-file]`

# Plan Alignment Check (Drift Detection)

You are performing a **Plan Alignment Check** — comparing the approved plan against actual implementation to detect drift.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Critical Constraints

- **DO NOT modify any code files.** This is a verification-only operation.
- **Read plan, read code, compare, and report findings.**
- **Save results to file when in workflow mode.**

## Instructions

### 1. Determine operating mode and load plan

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply only its **Reusable session-state resolution** section to resolve `$STATE_FILE`; retain this skill's own no-session and standalone-mode behavior.

Check if `$STATE_FILE` exists and has an active session (`current_phase` is not `idle`).

**Workflow Mode** (active deep-work session):
- Read `work_dir` from the state file
- Set `WORK_DIR` to the value of `work_dir`
- Load `$WORK_DIR/plan.md` as the plan
- Get comparison baseline: `plan_approved_at` from state file, or fall back to the commit closest to plan.md's modification time

**Standalone Mode** (no active session):
- If `$ARGUMENTS` is provided: use as plan file path
- If `$ARGUMENTS` is empty: error — "Plan 파일 경로를 지정해주세요. 예: /drift-check path/to/plan.md"

### 2. Extract plan items

Parse the plan file and extract 3 categories:

**A. 파일 목록** — "Files to Modify", "수정 대상 파일", "File Changes" 등의 섹션에서 파일 경로 추출.

**B. 구현 항목** — 체크리스트(`- [ ]`, `- [x]`), 번호 매긴 단계, 또는 "Implementation Steps" 섹션의 각 항목. 각 항목에서 다음을 추출:
- 대상 파일 (있으면)
- 구현할 내용 요약
- plan 내 위치 (섹션 번호/이름)

**C. 설계 결정** — "Design Decisions", "설계 지침", "Architecture", "Constraints" 등의 섹션에서 명시적 설계 지시사항 추출. 예:
- "Strategy 패턴으로 구현"
- "인터페이스를 통한 의존성 주입"
- "기존 XXX 클래스는 수정하지 않음"

Display extracted items:
```
Plan 항목 추출 완료:
  파일: [N]개
  구현 항목: [N]개
  설계 결정: [N]개
```

### 3. Collect actual implementation

```bash
# Plan 승인 이후 변경된 파일 목록
git diff --name-only [baseline-commit]..HEAD

# 변경 내용 상세 (각 파일)
git diff [baseline-commit]..HEAD -- [file]
```

baseline-commit 결정:
1. `plan_approved_at` 타임스탬프가 있으면 → `git log --before="[timestamp]" -1 --format=%H`
2. 없으면 → plan.md 파일의 mtime 기준 가장 가까운 커밋
3. 둘 다 없으면 → `HEAD~10` (최근 10커밋과 비교, 경고 표시)

### 4. Compare and classify

각 Plan 항목을 다음 중 하나로 분류:

| 분류 | 조건 | 기호 |
|------|------|------|
| **구현 완료** | Plan 항목이 실제 코드에 반영됨 | PASS |
| **미구현** | Plan에 있지만 코드에 없음 | FAIL |
| **범위 초과** | Plan에 없지만 코드에 있음 (신규 파일/대규모 변경) | WARN |
| **설계 이탈** | Plan의 설계 결정과 다르게 구현됨 | FAIL |

**비교 방법**:

**파일 수준**: Plan의 파일 목록과 git diff의 파일 목록을 집합 비교.
- Plan에만 있는 파일 → 미구현
- git diff에만 있는 파일 → 범위 초과 후보 (테스트 파일, 설정 파일 등은 자동 제외)

**항목 수준**: 각 구현 항목에 대해 관련 파일의 diff를 읽고, 해당 항목이 구현되었는지 판단.
- 클래스/함수/인터페이스 생성 항목 → 해당 심볼이 코드에 존재하는지 확인
- 로직 변경 항목 → diff에서 관련 변경이 있는지 확인
- 판단이 어려운 항목 → "확인 필요"로 표시 (false negative 방지)

**설계 수준**: 각 설계 결정에 대해 실제 코드가 해당 결정을 따르는지 확인.
- "Strategy 패턴" 지시 → 인터페이스 + 구현체 분리가 되어있는지
- "기존 XXX 수정 금지" → 해당 파일이 diff에 없는지
- "인터페이스 의존" → new ConcreteClass() 대신 인터페이스 참조인지

### 5. Generate report

```markdown
## Plan Alignment Report

**Plan**: [plan file path]
**비교 기준**: [baseline commit hash] → HEAD
**비교 범위**: [N]개 커밋, [N]개 파일 변경

---

### 종합 결과

| 구분 | 건수 | 판정 |
|------|------|------|
| 구현 완료 | 8/10 | — |
| 미구현 | 2/10 | **Fail** |
| 범위 초과 | 1건 | Warning |
| 설계 이탈 | 0건 | — |

**판정**: Required Gate 실패 — 미구현 2건

---

### 구현 완료
- [x] `src/auth/service.ts` — AuthService 클래스 생성 (Plan 3.1)
- [x] `src/auth/types.ts` — IAuthProvider 인터페이스 정의 (Plan 3.2)

### 미구현 — 반드시 구현 필요
1. `src/auth/middleware.ts` — 인증 미들웨어 (Plan 3.3)
   → Plan에 명시되었으나 파일이 생성되지 않음
2. `tests/auth.test.ts` — AuthService 단위 테스트 (Plan 5.1)
   → Plan에 명시되었으나 파일이 생성되지 않음

### 범위 초과
- `src/utils/crypto.ts` — Plan에 명시되지 않은 파일 추가
  → 의도된 변경이면 무시 가능. 지속적이면 Plan 업데이트 권장.

### 설계 정합성
- DIP: IAuthProvider 인터페이스 사용 (Plan 3.2 준수)
- "기존 UserService 수정 금지" — UserService.ts 미변경 확인
```

### 5-1. Calculate Fidelity Score

After classifying all plan items, calculate a numeric Fidelity Score (0-100):

**Scoring rules**:
- Each plan item has a base value of `100 / total_plan_items` points
- Fully implemented item: full points
- Partially implemented item: half points
- Not implemented item: 0 points
- Out of scope item: -2 points per item (capped — score cannot go below 0)

**Formula**: `score = max(0, (full_items * full_points) + (partial_items * half_points) - (out_of_scope_items * 2))`

Normalize to 0-100 scale.

Add the Fidelity Score to the drift report output:

```
📊 Plan Fidelity Report
━━━━━━━━━━━━━━━━━━━━━
✅ 구현 완료: [N]/[total] items ([pct]%)
⚠️ 부분 구현: [N]/[total] items
[for each: └─ #[N]: "[description]" — [what's done], [what's missing]]
❌ 미구현: [N]/[total] items
[for each: └─ #[N]: "[description]"]
🔀 범위 초과: [N] items
[for each: └─ [file]: [description]]

Fidelity Score: [score]/100
```

Write the numeric `fidelity_score` value to `$WORK_DIR/fidelity-score.txt` as a plain number (e.g., `85`) for consumption by the quality score calculator in deep-finish.

Write `fidelity_score: [N]` to the state file `$STATE_FILE`.

### 6. Determine pass/fail

```
미구현 0건 AND 설계 이탈 0건 → PASS
미구현 >0건 OR 설계 이탈 >0건 → FAIL (Required — 워크플로우 차단)
범위 초과만 있음 → PASS (경고만 표시)
```

### 7. Save results

**Workflow Mode**:
- Write full report to `$WORK_DIR/drift-report.md`
- Display summary in terminal
- FAIL 시: "미구현 항목을 구현하거나, /deep-plan 명령을 다시 실행하여 Plan을 수정하세요."

**Standalone Mode**:
- Display full report in terminal
- Ask: "리포트를 파일로 저장할까요? (기본: 아니오)"
- If yes, save to `./drift-report.md`
