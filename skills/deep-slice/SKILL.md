---
name: deep-slice
description: "Slice-level management inside Phase 3 — status, activate, spike, reset, per-slice model override; the escape hatch phase-guard points at when TDD blocks. Triggers on `/deep-slice`, \"slice status\", \"spike mode\", \"slice reset\", \"슬라이스 상태\", \"스파이크 모드\"."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Slice status dashboard |
| `activate SLICE-NNN` | 특정 slice 수동 활성화 |
| `spike SLICE-NNN` | Spike mode 진입 (TDD 강제 해제) |
| `reset SLICE-NNN` | PENDING 으로 리셋 (spike 코드는 git stash 보관) |
| `model SLICE-NNN [model]` | `haiku|sonnet|opus|main|auto` 모델 override |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites


> **Escape hatch utility** — TDD 블록 시 `phase-guard`가 안내하는 수동 slice 개입 경로 (`spike`, `reset`, `model`). `/deep-implement` auto-flow가 정상 동작할 때는 대부분 자동 관리됩니다.
> 참조처: `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/phase-guard-core.js` L110-L123 (TDD 블록 메시지에서 `/deep-slice spike/reset` 안내).

# Slice Management

Manage slices within a Deep Work implementation session.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Usage

- `/deep-slice` — Show slice status dashboard
- `/deep-slice activate SLICE-NNN` — Manually activate a specific slice
- `/deep-slice spike SLICE-NNN` — Enter spike mode for a specific slice
- `/deep-slice reset SLICE-NNN` — Reset a slice to PENDING
- `/deep-slice model SLICE-NNN [model]` — Override model for a specific slice

## Slice Status Dashboard

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply only its **Reusable session-state resolution** section to resolve `$STATE_FILE`; retain this skill's own no-session and standalone-mode behavior.

Read `$STATE_FILE` and `$WORK_DIR/plan.md` to display:

```
Slice Status Dashboard

SLICE-001 [GREEN] ██████ tests:5/5 spec:3/3 contract:4/4 receipt:✅
SLICE-002 [RED]   ███░░░ tests:2/5 spec:1/3 contract:1/3 receipt:⏳
SLICE-003 [PEND]  ░░░░░░ tests:0/3 spec:0/2 contract:0/2 receipt:—
SLICE-004 [SPIKE] ▓▓▓▓░░ tests:—   spec:—   contract:—   receipt:⚠️

진행률: 1/4 완료 | Active: SLICE-002
TDD 모드: strict | 디버깅: 0회
```

For each slice, read the receipt JSON from `$WORK_DIR/receipts/SLICE-NNN.json` to get:
- TDD state (PENDING/RED/RED_VERIFIED/GREEN_ELIGIBLE/GREEN/REFACTOR/SPIKE)
- Sensor state (SENSOR_RUN/SENSOR_FIX/SENSOR_CLEAN — displayed if sensor infrastructure active)
- Test pass count (from verification output)
- Spec checklist completion
- Contract compliance (passed/total items from `contract_compliance` field)
- Receipt status (✅ complete, ⏳ in_progress, ⚠️ spike, — pending)

TDD state icon mapping:
```
[PEND]    — not started
[RED]     — failing test written
[RED_V]   — red verified
[G_ELG]   — green eligible
[GREEN]   — tests passing
[REFACT]  — refactoring
[SPIKE]   — spike mode
[S_CLEAN] — sensors passed
[S_RUN]   — sensors running
[S_FIX]   — fixing sensor errors
```

## Activate Command

`/deep-slice activate SLICE-NNN`:

1. Verify the target slice exists in plan.md
2. Verify it's not already completed (`- [x]`)
3. Update state file:
   - `active_slice: SLICE-NNN`
   - `tdd_state: PENDING` (reset for new slice)
4. Display:
   ```
   SLICE-NNN 활성화: [Goal]
      파일: [file1, file2]
      이전 활성 slice: [previous or none]

   Contract ([acceptance_threshold]):
     ✅ [contract item 1]
     ✅ [contract item 2]
     ⬜ [contract item 3 — not yet verified]
   ```

## Spike Command

`/deep-slice spike SLICE-NNN`:

1. Set the slice's TDD state to SPIKE
2. Update state: `tdd_state: SPIKE`
3. Display:
   ```
   SLICE-NNN spike 모드 진입
      TDD 강제가 해제되었습니다. 자유롭게 코딩하세요.
      ⚠️ spike 코드는 merge 대상이 아닙니다.
      종료 시 /deep-slice reset SLICE-NNN 으로 TDD로 복귀하세요.
   ```

## Model Override Command

`/deep-slice model SLICE-NNN [model]`:

1. Validate model name: must be one of `haiku`, `sonnet`, `opus`, `main`, `auto`
2. If invalid, display: `⚠️ 유효하지 않은 모델: [model]. 사용 가능: haiku, sonnet, opus, main, auto`
3. Store override in state file: `model_overrides.SLICE-NNN: [model]`
4. Display:
   ```
   SLICE-NNN 모델 override: [model]
      다음 실행 시 이 모델이 사용됩니다.
      해제: /deep-slice model SLICE-NNN auto
   ```

## Reset Command

`/deep-slice reset SLICE-NNN`:

1. If slice was in SPIKE mode:
   - Stash current changes: `git stash push -m "spike: SLICE-NNN"`
   - Reset slice status to unchecked in plan.md
2. Update state:
   - `tdd_state: PENDING`
   - `active_slice: SLICE-NNN`
3. Reset receipt to initial state
4. Display:
   ```
   SLICE-NNN 리셋
      TDD 상태: PENDING (처음부터 시작)
      spike 코드: git stash에 보관됨
   ```
