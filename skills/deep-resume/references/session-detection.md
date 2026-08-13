# Session-state resolution and resume continuation

> Shared authority for the `--session=` → env var → pointer file → registry → legacy fallback chain, multi-session selection, and `WORK_DIR` extraction. The first section is composable by any caller. The second section is exclusive to `${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/SKILL.md`.

---

## Reusable session-state resolution

This section resolves session state only. It MUST NOT stop the caller, display resume-specific guidance, dispatch a phase, restore a worktree, or jump to a section in another skill. Reusable consumers MUST NOT apply the resume-only continuation policy.

Return one resolution result:

- `active`: set `$SESSION_ID`, `$STATE_FILE`, `$WORK_DIR`, and the extracted state fields.
- `none`: leave `$STATE_FILE` unset; the caller applies its own no-session or standalone-mode behavior.
- `completed`: set `$STATE_FILE` and extracted fields for the idle state; the caller decides how to present it.
- `invalid-explicit`: preserve the invalid explicit ID and missing-file reason; never fall through to a different session.

Resolve the session to resume using the following priority:

#### 1a-0. Explicit `--session=<id>`

`${CLAUDE_PLUGIN_ROOT}/scripts/parse-deep-work-flags.js` parses `--session=<id>` and rejects anything outside
`[A-Za-z0-9.-]` with a warning. When a valid value is present it wins over every source
below — read `.claude/deep-work.<id>.md` directly. If that file does not exist, return
`invalid-explicit` rather than silently falling through to another session.
If the file exists, continue to 1c regardless of `current_phase`.

#### 1a. Direct session ID (env var)

If `DEEP_WORK_SESSION_ID` environment variable is set:
- Read `.claude/deep-work.${DEEP_WORK_SESSION_ID}.md` directly
- If the file exists: continue to 1c regardless of `current_phase`
- If the file doesn't exist: fall through to 1b

#### 1a-2. Pointer file

If neither of the above resolved, read `.claude/deep-work-current-session` — a single
line holding the session ID. This is the same pointer the hooks fall back to
(`${CLAUDE_PLUGIN_ROOT}/hooks/scripts/utils.sh`, `phase-guard.sh`, `session-end.sh`), so honouring it here
keeps the skill and the hooks pointed at one session. If it names a session whose
state file is missing, fall through to 1b. If the named state file exists: continue to
1c regardless of `current_phase`.

#### 1b. Registry-based session discovery

Read the registry (`.claude/deep-work-sessions.json`). Filter to sessions where `current_phase` is NOT `idle`.

**If no active sessions in registry:**
- Check for legacy fallback: read `.claude/deep-work.local.md`
  - If exists and `current_phase` is NOT `idle` and NOT empty: use this file as the state file, continue to 1c, and return `active` without displaying caller-specific guidance.
  - Otherwise: return `none` without displaying caller-specific guidance.

**If exactly 1 active session in registry:**
- Auto-select this session
- Update the pointer file: `write_session_pointer SESSION_ID`
- Read `.claude/deep-work.${SESSION_ID}.md`
- Continue to 1c and return `active`

**If 2+ active sessions in registry:**
- Present selection UI using AskUserQuestion:

```
재개할 세션을 선택하세요:

  1. [SESSION_ID] [task_description] ([current_phase], [last_activity])
  2. [SESSION_ID] [task_description] ([current_phase], [last_activity])
  ...
```

- After user selects a session:
  - Update the pointer file: `write_session_pointer SELECTED_SESSION_ID`
  - Read `.claude/deep-work.${SELECTED_SESSION_ID}.md`
  - Continue to 1c and return `active`

#### 1c. Extract state

From the resolved state file, extract `current_phase`, `work_dir`, `task_description`, `started_at`, `team_mode`, `plan_approved`, `test_retry_count`, `max_test_retries`, `preset`, `evaluator_model`, `assumption_adjustments`, `skipped_phases`, `plan_review_retries`, and `auto_loop_enabled` from the YAML frontmatter.

Set `$WORK_DIR` to the value of `work_dir` (used in all subsequent steps).

If `current_phase` is `idle` or empty, return `completed`; otherwise return `active`.

## Resume-only continuation

Only `${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/SKILL.md` applies this section after reusable resolution:

- `invalid-explicit`: report the invalid or missing explicit session and stop without fallback.
- `none`: display the active-session guidance and stop.
- `completed`: display the completed-session guidance and stop.
- `active`: return to deep-resume §1-1 (`session authority validate`), then §1.4 (state schema migration), then §1.5 (worktree restoration). Never jump directly to worktree restoration or phase dispatch.

For `none`, display:

```
ℹ️ 활성 세션이 없습니다.

새 세션을 시작하려면: /deep-work <작업 설명>
```

For `completed`, display:

```
ℹ️ 완료된 세션입니다.

리포트 확인: `/deep-status --report` · 재생성: `/deep-report`
새 세션 시작: /deep-work <작업 설명>
```
