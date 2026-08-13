# Contributing to deep-work

Thanks for your interest in improving **deep-work** — the Evidence-Driven
Development Protocol plugin and core harness engine of the
[claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite).

## Getting started

```bash
git clone https://github.com/Sungmin-Cho/claude-deep-work.git
cd claude-deep-work
```

Node 22+ is required (`package.json` `engines`). The plugin's runtime is
zero-dependency (Node built-ins +
bash hooks); there is no install step for development.

## Tests

```bash
npm test          # runs the full suite (hooks + tests + skills + sensors + templates + scripts)
npm run test:core # fast core subset (envelope, handoff, phase-guard, skill-entry, deep-memory)
```

`npm test` runs serially (`--test-concurrency=1`) to keep timing-sensitive hook
tests stable. `health/**/*.test.js` runs cleanly in isolation via
`npm run test:health` but has a known event-loop leak when interleaved with the
full suite, so it is kept on a separate script.

## Conventions

`AGENTS.md` is the authority for agent-only mechanics. The human-facing rules
below remain mandatory regardless of which agent or host performs the work.

- **Documentation** — the README is evergreen; release notes live only in the
  CHANGELOG. A fuller maintainer rulebook exists at `docs/DOCS_RULE.md`, but it is
  **not shipped**: it is gitignored, so your clone does not have it and CI never
  sees it. Do not try to open it; when it is absent, the rules in this file and in
  `AGENTS.md` are the whole contract.
- **CHANGELOG** uses [Keep a Changelog](https://keepachangelog.com/) — add your
  entry under `[Unreleased]` in both `CHANGELOG.md` and `CHANGELOG.ko.md`.
- **Version triple-sync** — `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  and `package.json` versions must always match.
- **Atomic commits** — one task per commit; never `git add -A`. Stage only the
  explicit paths that belong to the task.

## Pull requests

1. Branch from `main`.
2. Keep changes focused and make sure `npm test` is green.
3. Update the CHANGELOG (`[Unreleased]`, both languages) when behavior changes.
4. Explain what changed and why.

After a release lands on `main`, the suite marketplace pin is updated in the
[claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) repository —
not here.

## Reporting issues

Open a GitHub issue. For security reports, see [`SECURITY.md`](SECURITY.md).
