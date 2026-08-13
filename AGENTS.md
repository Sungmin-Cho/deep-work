# deep-work — Agent Guide

Evidence-Driven Development Protocol. `$deep-work:deep-work "task"` drives the
Brainstorm → Research → Spec → Plan → Implement → Test → Integrate workflow.
Claude Code and Codex share this file — it is the single source for both.

Read the version, never hardcode it: `jq -r .version ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.
Release history lives in `CHANGELOG.md` / `CHANGELOG.ko.md`; README owns what the
plugin is and how to use it.

> 📄 Doc maintenance follows `docs/DOCS_RULE.md` — a maintainer rulebook that is
> gitignored and ships with nothing. It exists only in a maintainer's own checkout;
> never try to open it at runtime, because the only place that path can resolve in an
> installed plugin is the project being analysed.

## Runtime surfaces

This section is the authority for shipped runtime surfaces and the Node floor.

Manifests `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` + `${CLAUDE_PLUGIN_ROOT}/.codex-plugin/plugin.json` · skills
`skills/*/SKILL.md` with cross-skill guides under `skills/shared/references/` ·
hooks `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` + `hooks/scripts/` · agents `agents/*.md`. Node ≥ 22
(`package.json` `engines`). Verify a change with:

```bash
node -e "JSON.parse(require('fs').readFileSync('${CLAUDE_PLUGIN_ROOT}/.codex-plugin/plugin.json','utf8'))"
npm test
```

## Host differences — subagent dispatch

`agents/*.md` are Claude Code subagents, discovered from the `agents/` directory by
convention — **neither** `plugin.json` declares an `agents` key, so manifest contents
do not tell the two hosts apart. Claude Code provides the `Agent` tool; Codex does
not.

**Decide on tool availability, not on the manifest.** This rule applies to *every*
`Agent(...)` dispatch in this plugin, currently five sites: `deep-research`
§모드 분기 (research workers) · `deep-implement` §2.1/§2.2 (slice workers) ·
`deep-work-orchestrator` §1-4-2 (session-recommender) · `deep-integrate` §3-2
(general-purpose recommendation call) · `deep-plan` §Contract Negotiation
(contract validation).

- The `Agent` tool is available → dispatch as written.
- It is not → **run that worker's own protocol inline in the calling skill**,
  reading `${CLAUDE_PLUGIN_ROOT}/agents/<worker>.md` for the contract it would have
  received. Keep the
  same inputs, output paths and receipt obligations; only the execution site
  changes. Where the dispatch is a plain reasoning call with no `agents/` file
  (deep-integrate §3-2, deep-plan §Contract Negotiation), perform the reasoning
  inline against the same prompt and schema.

`detectRuntime()` in `${CLAUDE_PLUGIN_ROOT}/scripts/detect-runtime.js` returns `claude` | `codex` |
`unknown` from `CLAUDECODE` / `CODEX_HOME` markers if a programmatic signal is
needed, but an agent can answer directly by checking whether it has the tool.
Never emit a dispatch the host cannot execute, and never silently skip the work
the worker would have done.

**Plugin files are read *and executed* from the plugin, never from the workspace.**
Every path this plugin tells you to open or run — `agents/*.md`, `skills/**`
(including the `*.sh` helpers), `scripts/**`, `hooks/**`, `runtime/**` — is
anchored at `${CLAUDE_PLUGIN_ROOT}`. This covers every way a path can appear:
running it through an interpreter (`bash`, `node`), reading it (`Read`,
`Follow`), sourcing or executing it directly (`source`, `.`, `./x`), loading it
as a module (`require`, `import`), and naming an executable at all.

Two conditions, and **both** must hold:

1. **Anchored** — the path states the plugin root explicitly.
2. **Contained** — it resolves *inside* that root. An anchor alone is not
   enough: an anchored path followed by a parent segment still walks out of the
   plugin, and so does one whose component is a symlink pointing outside. Resolve
   first, then check the result is under the root.

If either fails, **abort and report — do not read it and do not run it.**

Entry skills remain self-contained for state resolution, argument parsing, user choices, and output format. Shared procedures may be loaded only through an explicit, contained `Read` anchored at `${CLAUDE_PLUGIN_ROOT}`; sibling skill auto-loading is never required.

A bare relative path resolves against the *target workspace*. A repository under
analysis could then shadow a plugin contract with a same-named file and have its
contents read as instructions, or its script executed with the caller's Bash
permissions. This is not theoretical for the Phase 5 helpers:
`${CLAUDE_PLUGIN_ROOT}/hooks/scripts/phase-guard.sh` normalises a relative helper path against
`PROJECT_ROOT` and allows `$PROJECT_ROOT/skills/deep-integrate/<helper>.sh`, so a
bare path is permitted by the guard exactly where an attacker could place a file.
Anchoring keeps that allowance pointed at the plugin: in a dev checkout the plugin
root *is* `PROJECT_ROOT`, and for an installed plugin it is the cache path the
guard allows separately.

The guard also rejects `$(...)` in those calls, so resolve `${CLAUDE_PLUGIN_ROOT}`
to a literal absolute path **before** composing the command rather than
substituting inside it.

## Receipt envelope (M3)

`session-receipt.json` and `receipts/SLICE-*.json` are emitted as M3 cross-plugin
envelopes:

```
{
  "schema_version": "1.0",
  "envelope": {
    "producer": "deep-work",
    "producer_version": "<from ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json>",
    "artifact_kind": "session-receipt | slice-receipt",
    "run_id": "<ULID>",
    "session_id": "<dw-session-id>",
    "parent_run_id": "<consumed evolve-insights run_id, optional>",
    "generated_at": "<RFC 3339>",
    "schema": { "name": "<matches artifact_kind>", "version": "1.0" },
    "git": { "head": "<sha>", "branch": "<name>", "dirty": false },
    "provenance": { "source_artifacts": [...], "tool_versions": {...} }
  },
  "payload": { /* legacy receipt body — schema_version: "1.0" preserved */ }
}
```

Sole writer: `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-receipt-envelope.js`, invoked from
`${CLAUDE_PLUGIN_ROOT}/agents/implement-slice-worker.md` and `${CLAUDE_PLUGIN_ROOT}/skills/deep-finish/SKILL.md` §7-Z.

**Identity-triplet guard.** Before unwrapping `payload`, every reader verifies
`producer` equals the expected producer, `artifact_kind` equals the expected kind,
and `schema.name === artifact_kind`. A mismatch is skipped with a warning, never
partially consumed. Legacy non-envelope files pass through unmodified
(forward-compat). The same triplet applies when deep-work reads another plugin's
envelope — deep-dashboard's harnessability report, deep-evolve's insights.

Changing the `payload` shape requires a matching bump of
`schemas/payload-registry/deep-work/<artifact_kind>/v<MAJOR.MINOR>.schema.json`
in deep-suite. Additive changes are forward-compatible; a shape break needs a new
schema minor.

## Phase-guard denylist

`${CLAUDE_PLUGIN_ROOT}/hooks/scripts/phase-guard-core.js` blocks five catastrophic-blast-radius command
families outside the Implement phase, each with its own opt-out env var:

| Family | Matches | Override |
|---|---|---|
| `rm-rf` | any `rm` with `-r` / `-R` / `--recursive` | `CLAUDE_ALLOW_RM_RF` |
| `npm-publish` | `npm publish` | `CLAUDE_ALLOW_NPM_PUBLISH` |
| `kubectl-destructive` | `kubectl delete … --all`, `kubectl drain` | `CLAUDE_ALLOW_KUBECTL_DESTRUCTIVE` |
| `sql-destructive` | `DROP TABLE`, `TRUNCATE [TABLE] <name>` | `CLAUDE_ALLOW_SQL_DESTRUCTIVE` |
| `curl-pipe-shell` | `curl` / `wget` piped into `sh` / `bash` | `CLAUDE_ALLOW_CURL_PIPE_SHELL` |

Never disable the guard globally — set the one matching family override.

These families are **not** matched by the denylist: `DELETE FROM` without `WHERE`,
`DROP DATABASE`, `curl | zsh` and process substitution, `yarn`/`pnpm`/`lerna`
publish, and `dd` / `mkfs` / `fdisk`. `DANGEROUS_NON_IMPLEMENT_PATTERNS` records
each omission with the reason it was left out. The suite's strict-mode example
pack covers more families at the hook level.

## Conventions

This section is the authority for agent-only repository mechanics. Human
contributors follow `CONTRIBUTING.md`, which links here for these mechanics.

- **Never `git add -A`** — stage explicit paths so untracked local files cannot
  leak into a commit. One commit per task, HEREDOC message with the
  `Co-Authored-By` trailer.
- **Never edit install caches** — `~/.claude/plugins/`, `~/.codex/plugins/cache/`.
  Push to this repo, then run `/plugin marketplace update`.
- **Version triple-sync** — `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`, `${CLAUDE_PLUGIN_ROOT}/.codex-plugin/plugin.json`
  and `package.json` always carry the same version.
- Receipt validation failed? The script takes three required positionals:
  `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/verify-delegated-receipt.sh [--skip-items=N,M] [--only-completed]
  <state_file> <receipts_dir> <plan_md_path>`. It names the failing item; the checks
  live in `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/verify-receipt-core.js`. `/deep-receipt validate` wraps it.

## Release

A plugin PR touches this repo only: CHANGELOG in both languages plus the version
triple-sync across `package.json` and both plugin manifests, which the release
metadata test pins together. The marketplace pin and any payload-registry
promotion are batched on the suite side afterwards, once the merge lands on
`main`:

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-suite
npm run release:bump -- deep-work <sha40>
```

That one command is the whole suite-side step. It writes **both** manifests —
`.claude-plugin/marketplace.json` and the Codex mirror
`.agents/plugins/marketplace.json` — validating the edit against both before
writing either, so a plugin present in only one cannot end up pinned to different
commits. It then runs `docs:write` and `preflight` itself, so neither needs
invoking separately. Nothing here needs a hand sync;
`tests/codex-marketplace-contract.test.js` on the suite side deep-compares
`source` and `description` across the two manifests as the backstop.
