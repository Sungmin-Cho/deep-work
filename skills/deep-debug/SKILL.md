---
name: deep-debug
description: "Debug sub-mode for Phase 3 — Investigate → Analyze → Hypothesize → Implement, with the iron rule that no fix ships before root-cause investigation. Triggers on `/deep-debug`, \"systematic debug\", \"root cause investigation\", \"디버그 모드\", \"근본 원인 분석\", `verification_cmd` 실패 시 자동 진입, or \"fix this\"."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Debug sub-mode 진입 — 현재 실패 컨텍스트로부터 root cause 분석 |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites


# Systematic Debugging

You are entering **Debug Sub-Mode** within a Deep Work implementation session.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Iron Rule

🚫 **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Do NOT:
- Guess at fixes based on the error message alone
- Try random changes to see if they work
- Apply a fix without understanding WHY the bug exists
- Move on after a fix without verifying the root cause theory

## Trigger Conditions

This command activates automatically when:
- `verification_cmd` fails after the GREEN phase (unexpected regression)
- A previously passing test starts failing
- The user explicitly calls `/deep-debug`

## Phase 1: Investigate

1. **Read the error carefully**:
   ```
   에러 분석:
      테스트: [failing test name]
      에러 메시지: [exact error]
      스택 트레이스: [relevant lines]
   ```

2. **Reproduce consistently**: Run the failing command 2 more times to confirm it's not flaky

3. **Check recent changes**: What was the last edit before the failure?
   ```bash
   git diff HEAD
   git log --oneline -5
   ```

4. **Gather evidence**: Read related files, check imports, trace data flow

## Phase 2: Analyze

1. **Find a working reference**: Is there similar code that works? Compare patterns.

2. **Identify the difference**: What's different between the working and broken state?

3. **Trace data flow**: Follow the data from input to the failure point:
   ```
   데이터 흐름:
      입력: [source] → [transform1] → [transform2] → ❌ [failure point]
      예상: [expected value at failure point]
      실제: [actual value at failure point]
   ```

## Phase 3: Hypothesize

1. **Form ONE hypothesis**: Based on evidence, not guessing
   ```
   가설:
      원인: [specific root cause]
      근거: [evidence supporting this hypothesis]
      검증 방법: [how to test this hypothesis]
   ```

2. **Test the hypothesis minimally**: Verify with the smallest possible change or check

3. **If hypothesis is wrong**: Return to Phase 2 with new data. Do NOT try another random fix.

## Phase 4: Implement Fix

1. **Apply the minimal fix** based on verified root cause
2. **Run the failing test** — it should now pass
3. **Run the full test suite** — no regressions
4. **Record the root cause**:

Write to `$WORK_DIR/debug-log/RC-NNN.md`:
```markdown
# Root Cause: [Title]

## 증상
- 실패한 테스트: [test name]
- 에러 메시지: [message]

## 근본 원인
[Explanation of why the bug existed]

## 수정 내용
[What was changed and why]

## 교훈
[What to watch for in the future]

## 관련 Slice
- SLICE-NNN: [goal]
```

5. **Update receipt**: Set `debug.root_cause_note` to the RC file path

## Escalation

If 3 fix attempts fail (3 different hypotheses tested and invalidated):

```
⚠️ 디버깅 에스컬레이션

3번의 수정 시도가 실패했습니다. 이것은 아키텍처 수준의 문제일 수 있습니다.

시도한 가설:
1. [hypothesis 1] — [why it failed]
2. [hypothesis 2] — [why it failed]
3. [hypothesis 3] — [why it failed]

사용자의 판단이 필요합니다.
```

**STOP and wait for user guidance.** Do NOT continue guessing.

## State Management

On entry:
- Set `debug_mode: true` in state file

On exit (fix verified):
- Set `debug_mode: false`
- Resume the TDD cycle where it was interrupted
