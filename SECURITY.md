# Security Policy

## Supported versions

Security fixes are delivered through the latest release of deep-work and a
refreshed marketplace pin in the
[deep-suite](https://github.com/Sungmin-Cho/deep-suite) repository.
Check the current version with `jq -r .version .claude-plugin/plugin.json`.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/Sungmin-Cho/deep-work/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge reports within a few days and will coordinate a fix and a
disclosure timeline with you.

## Scope

deep-work runs hooks inside the Claude Code / Codex plugin runtime that **execute
shell commands** — `hook-bootstrap.js`, `phase-guard.sh` (Phase Guard / Worktree
Guard), `file-tracker.sh`, `phase-transition.sh`, `sensor-trigger.js`, and
`session-end.sh`. Before enabling the plugin, review `hooks/hooks.json` and the
scripts under `hooks/scripts/`.

The Phase Guard enforces a dangerous-command denylist (e.g. `curl | sh`,
`rm -rf` on protected paths, `npm publish`, destructive `kubectl`/SQL,
`dd`/`mkfs`); each family can be overridden with a per-family `CLAUDE_ALLOW_*`
env var. See also the suite-wide denylist guidance in
[`guides/hook-patterns.md`](https://github.com/Sungmin-Cho/deep-suite/blob/main/guides/hook-patterns.md).

When reporting, please indicate the plugin version and runtime (Claude Code or
Codex) affected.
