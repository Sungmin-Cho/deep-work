---
name: deep-cleanup
description: "Scan and clean up stale deep-work git worktrees (`dw/*` branches) plus fork worktrees, and prune idle fork sessions from the registry. Triggers on `/deep-cleanup`, \"clean worktrees\", \"stale worktree\", \"worktree 정리\", \"fork 정리\", \"deep-work 정리\"."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Stale worktree 스캔 → AskUserQuestion 분기 |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites


> **Utility** — standalone 명령. `/deep-work` init이 stale 세션 일부를 감지하지만, `git worktree list` 스캔·stale/active 분류·dirty 트리 삭제 확인·fork worktree 및 registry 정리는 이 커맨드가 유일한 경로입니다.
> 향후 기능 이관 후 삭제 예정.

# Deep Work Worktree Cleanup

Scan for stale deep-work worktrees and offer cleanup options.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Instructions

### 1. Scan for deep-work worktrees

```bash
git worktree list 2>/dev/null
```

If not a git repo or no worktrees exist:
```
ℹ️ Git worktree가 없습니다.
```
Stop here.

Filter for worktrees with `dw/` in the branch name (deep-work convention).

### 2. Check each worktree

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply only its **Reusable session-state resolution** section to resolve `$STATE_FILE`; retain this skill's own no-session and standalone-mode behavior.

For each deep-work worktree:

1. Get the worktree path and branch name
2. Check age: `stat -f "%Sm" -t "%Y-%m-%d" [path]` (macOS) or `stat -c "%y" [path]` (Linux)
3. Check if it has an active session:
   - Read the resolved current session state file (`$STATE_FILE`) when resolution returned `active`
   - If `worktree_path` matches this worktree AND `current_phase` is not `idle` → **active**
4. Check for uncommitted changes: `git -C [path] status --porcelain`

### 3. Display worktree list

```
Deep Work Worktrees

┌────────┬──────────────────────┬──────────┬──────────┬───────────┐
│ #      │ Branch               │ Age      │ Status   │ Changes   │
├────────┼──────────────────────┼──────────┼──────────┼───────────┤
│ 1      │ dw/add-model-routing │ 3 days   │ active   │ clean     │
│ 2      │ dw/fix-receipt-bug   │ 12 days  │ stale    │ dirty     │
│ 3      │ dw/old-feature       │ 30 days  │ stale    │ clean     │
└────────┴──────────────────────┴──────────┴──────────┴───────────┘

stale = 7일 이상 + 활성 세션 없음
active = 현재 활성 세션의 worktree (삭제 불가)
```

If no stale worktrees:
```
✅ 모든 worktree가 활성 상태이거나 7일 이내입니다. 정리할 것이 없습니다.
```
Stop here.

### 4. Offer cleanup

Use AskUserQuestion:

```
stale worktree를 정리할까요?

1. clean stale 삭제 — 변경사항 없는 stale worktree만 삭제
2. 모든 stale 삭제 — dirty 포함 모든 stale worktree 삭제
3. 개별 선택 — 하나씩 선택하여 삭제
4. ❌ 취소
```

### 5. Execute cleanup

For each worktree to delete:

1. **Skip active worktrees** — never delete a worktree with an active session
2. If dirty (uncommitted changes), show extra confirmation:
   ```
   ⚠️ [branch]에 커밋되지 않은 변경이 있습니다. 강제 삭제?
   ```
3. Delete:
   ```bash
   git worktree remove [path]          # clean
   git worktree remove --force [path]  # dirty (after confirmation)
   git branch -D [branch]              # remove the branch too
   ```
4. Display per-worktree: `[branch] 삭제 완료`

### 6. Summary

```
Cleanup 완료
   삭제: [N]개 worktree
   유지: [M]개 worktree (active 또는 사용자 선택)
```

### 7. Fork Worktree 정리

기존 worktree 스캔 로직(Step 1-6)에 추가로 fork 세션 정리를 수행한다.

#### 7-1. Fork 세션 스캔

레지스트리(`.claude/deep-work-sessions.json`)에서 `fork_parent`가 있는 세션 중 `current_phase`가 `idle`인 것을 식별한다.

```bash
# 레지스트리에서 idle fork 세션 추출
node -e '
  const fs = require("fs");
  const reg = JSON.parse(fs.readFileSync(".claude/deep-work-sessions.json", "utf8"));
  const forks = Object.entries(reg.sessions)
    .filter(([_, s]) => s.fork_parent && s.current_phase === "idle")
    .map(([id, s]) => ({ id, parent: s.fork_parent, worktree: s.worktree_path }));
  console.log(JSON.stringify(forks));
' 2>/dev/null
```

해당 세션의 `worktree_path`가 있으면 정리 대상에 포함한다.

#### 7-2. 배치 정리 제안

부모와 모든 fork 자식이 전부 idle이면 배치 정리를 제안한다:

```
부모 세션 {parent_id}와 모든 fork 세션이 완료되었습니다. 전체 정리하시겠습니까?

1. 전체 정리 — 부모 + 모든 fork worktree 삭제
2. Fork만 정리 — fork worktree만 삭제, 부모 유지
3. 개별 선택
4. ❌ 취소
```

#### 7-3. Fork 정리 실행

각 fork worktree에 대해:

1. `git worktree remove {worktree_path}` 실행
2. 관련 branch 삭제: `git branch -D {fork_branch}`
3. 레지스트리에서 해당 세션 제거 (unregister)
4. 부모 상태 파일의 `fork_children`에서도 해당 항목 제거

#### 7-4. Fork 정리 Summary

```
Fork Cleanup 완료
   삭제: [N]개 fork worktree
   유지: [M]개 fork worktree (active 또는 사용자 선택)
   레지스트리 정리: [K]개 세션 제거
```
