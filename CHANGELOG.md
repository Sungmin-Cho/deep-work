**English** | [한국어](./CHANGELOG.ko.md)

# Changelog

All notable changes to the Deep Work plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [7.2.0] — 2026-08-17 (Suite Model-Router Shadow)

### Added

- **Model-router shadow comparison.** After `model-routing-cli.js`, session init and research reroute record a `router_shadow` observation on `model_routing_meta_json`. Dispatch authority stays the existing CLI JSON.

## [7.1.5] — 2026-08-13 (Strict Recovery Evidence Closure)

### Fixed

- **Strict recovery evidence now fails closed across rollback and retry transitions.** Receipt admission, completion evidence, release gates, and test results remain bound to the active recovery generation and authoritative state instead of accepting stale evidence from an earlier attempt.
- **Recovery and receipt contracts now preserve identity and ordering guarantees.** Added regression coverage for rollback, retry, receipt identity, governed context, and strict completion paths.

## [7.1.4] — 2026-08-06 (Session-Policy Prerequisite Closure)

### Changed

- **The session-policy prerequisite handoff now records its terminal reviewed no-go.** A project-controlled Git layout cannot authenticate repository-wide authority outside the worktree, and deep-work does not own the separately installed repository-authority and approval-broker products required to provide that trust. The existing inline policy pipeline therefore remains authoritative; the experimental P1 implementation and `scripts/session-policy-cli.js` are not shipped.
- The restart contract now requires signed broker packages plus independently verified OS installation and enrollment receipts. Human approval remains permission to proceed, not evidence that an absent authority exists.

## [7.1.3] — 2026-08-03 (Dual-Root Hook Bootstrap)

### Fixed

- **Dual-root hook bootstrap**: Registered hooks now resolve `CLAUDE_PLUGIN_ROOT` first and fall back to `PLUGIN_ROOT`, then canonicalize and contain-check the bootstrap and adapter targets before executing them with byte-identical stdin and event-specific exit semantics on POSIX and Windows.
- PreToolUse guard failures now block: any guard exit status other than 0 (allow) or 2 (block) — e.g. a broken install exiting 127 — is coerced to a block instead of silently letting the tool call through; the original status is reported on stderr. A misconfigured plugin root blocks the same way, with an unambiguous recovery message. Hook manifest timeouts now include one second of host-reporting headroom (9/9/6/7/4/6 seconds), while adapter deadlines retain their full pre-bootstrap effective budgets (8/8/5/6/3/5 seconds). Timed-out POSIX adapters run in a dedicated process group whose remaining descendants are killed; Windows `spawnSync` has no equivalent job-object tree termination, so descendant containment is not claimed there.

## [7.1.2] — 2026-08-03 (Host-Explicit GPT Routing)

### Changed

- **Codex routing follows the GPT-5.6 price-performance frontier without weakening risk floors.** The light, standard, and deep slots remain pinned to GPT-5.6 Luna, Terra, and Sol respectively, while methodology risk and error cost continue to set the minimum tier rather than a price-only formula.
- **Model routing now binds the actual host explicitly.** The orchestrator and authoritative research reroute derive `claude` versus `codex` from live `Agent` tool availability, pass that runtime to the routing CLI in the same shell invocation, and fail closed when the host cannot be resolved. Persisted runtime and child-process environment markers cannot override the current host.

### Fixed

- **Routing contract tests now reject executable shadow assignments.** Regression mutants cover split fences, comments, indentation, semicolon/logical separators, pipes, background commands, exports, quoting, escapes, and Bash backslash-newline token splicing while preserving valid continued arguments.
- **Repository-local npm lockfiles stay local.** The root `package-lock.json` is ignored so npm verification does not leak an untracked lockfile into release commits.

## [7.1.1] — 2026-07-28 (Separator Normalisation)

### Security

- **A Windows-style path spelling no longer escapes the plugin-path guard.** The check that keeps deep-work's own instructions from being redirected into the repository under analysis only understood `/`, so the same unanchored reference written `scripts\deep-work-runtime.js` — or with the two mixed, `hooks\scripts/envelope.js` — passed silently. Path separators are now canonicalised before any rule sees them, so both spellings, and the escaped `scripts\\x.js` form that a string literal produces, are judged identically.

### Fixed

- **The guard suite no longer fails on Windows.** Its index of plugin files was keyed with the host's path separator while the paths looked up in it were canonicalised, so on Windows the two never matched and `npm test` went red. Both sides now use one spelling, and the mismatch is reproduced from POSIX CI rather than waiting for a Windows report. The `bash` and symlink fixtures are skipped only when the host genuinely lacks the capability.
- **Release instructions corrected** (the 7.1.0 note below is wrong): `npm run release:bump` writes **both** marketplace manifests, validates both before writing either, and runs `docs:write` and `preflight` itself. No file needs a hand sync. The agent guide also referenced an "adoption-ledger" step that does not exist.

## [7.1.0] — 2026-07-27 (Plugin-Path Trust Hardening + Context Diet)

### Security

- **A repository under analysis can no longer hijack the plugin's own instructions.** Every path deep-work tells an agent to read or run is now resolved from the plugin's install directory and refused if it lands outside it. Previously a project being worked on could place a same-named file or Node module in its own tree and have that content read as instructions, or executed with your permissions — reachable through relative reads, plugin helper scripts, an attached JSON schema, an anchor the shell left literal, and a module path Node resolved from the workspace `node_modules`.

### Added

- **Per-skill `references/` split**: the eight largest entry skills now keep dispatch logic inline and load conditional procedure — team dispatch, rollback, completion options, cross-plugin handoff, fork and flag views, session detection — from `references/` only when that branch is taken.

### Changed

- **`AGENTS.md` is the single agent guide** for both Claude Code and Codex; `CLAUDE.md` imports it and keeps only the Claude-specific note about subagents.
- **Shorter skill and agent descriptions** across all 27 skills and 4 agents, with every trigger phrase preserved verbatim.
- **Skill bodies no longer carry release history**: per-version feature sections and internal fix/review labels were removed in favour of the constraint they annotated. The CHANGELOG remains the single source for what changed when.

### Fixed

- **Assumption Health showed no assumptions even when the registry had them.** `/deep-status --report`, `--assumptions`, timeline and badge read the registry from a path that never existed, and a missing file was treated as an empty registry rather than an error — so the section rendered empty and silent.

- **Agent guide corrections**: the documented phase-guard denylist now matches `hooks/scripts/phase-guard-core.js` (five families; `dd`/`mkfs`/`fdisk` and bare SQL `DELETE` are documented omissions, not blocked commands), the receipt validator is described as nine checks rather than eight, and the required Node version reads 22 rather than 20.
- **Release instructions**: the agent guide described a manual marketplace and README edit that `npm run release:bump` has replaced; only `.agents/plugins/marketplace.json` still needs a hand sync.

## [7.0.0] — 2026-07-27 (Adaptive Methodology Authority)

### Added

- **Explicit Spec phase and profile v4**: new sessions move through a first-class executable Spec phase, while profile v4 carries governed methodology policy and preserves bounded v3 and legacy-session compatibility.
- **Authenticated review envelopes**: cross-plugin review requests and receipts bind exact artifacts, contracts, evidence, reviewer identity, findings, verdict, and review round.
- **Runtime context policy**: Codex continues through native compaction in the same goal and worktree, while task or fork creation requires an explicit bounded purpose.

### Changed

- **Single methodology authority**: risk classification now compiles one authenticated policy for model floors, review, verification, migration, resume, and finish; legacy model routing remains a compatibility facade.
- **Governed progress reporting**: status, dashboards, reports, test admission, and finish admission consume the same digest-bound projection of evidence, residual risk, canonical findings, receipts, and replan state.

### Security

- **Authority drift rejection**: policy, Spec, plan, evidence, and review bindings fail closed when their authenticated bytes or digests drift across restart or resume.

## [6.14.0] — 2026-07-27 (Correct RED and Governed Completion)

### Added

- **Authenticated correct RED**: strict functional slices classify bounded test observations, publish immutable RED proof, and require the completed proof chain before production writes.
- **Governed functional completion**: deterministic slice receipts bind production GREEN, performed-refactor or no-refactor evidence, fresh sensor results, and their completed producer ledgers.

### Changed

- **Automatic stop-and-replan**: verification side effects, widened write scope, and manifest divergence invalidate stale authority and resume through one crash-safe replan epoch.
- **Canonical progress visibility**: status, reports, test admission, and finish admission consume the same governed evidence, risk, finding, receipt, and replan projection.

### Fixed

- **Bootstrap first-slice safety**: the one-time first RED bridge now requires separate adoption and canonical proof publication, and the resulting proof remains verifiable after later GREEN and sensor transitions.

## [6.13.1] — 2026-07-23 (Windows-portable Codex hooks)

### Fixed

- Codex hook execution on Windows now routes through `hooks/scripts/hook-shell-adapter.js`, a Node adapter that selects Git for Windows Bash for the underlying `.sh` scripts (`phase-guard.sh`, `file-tracker.sh`, `phase-transition.sh`, `session-end.sh`), preserves PowerShell exit codes via an explicit `commandWindows` entry (`; exit $LASTEXITCODE`), and keeps the PostToolUse tool-input flow intact end to end.
- `hooks/hooks.json` gains `commandWindows` variants for every hook entry (`session-start-adapter.js`, `hook-shell-adapter.js`, `sensor-trigger.js`) so Windows no longer depends on a bare POSIX `bash` invocation.

### Added

- `hooks/scripts/hook-runtime-portability.test.js` — pins the Windows Git-Bash resolution, exit-code preservation, and PostToolUse input passthrough behavior of the new adapter.

## [6.13.0] — 2026-07-22 (Spec Contract & Evidence Policy)

### Added

- **Executable spec contracts**: `runtime/contract-runtime.js`, the read-only validator CLI, `/deep-spec`, and the canonical spec/plan templates establish digest-bound requirements, invariants, failure matrices, and slice execution coverage.
- **Authenticated evidence packages**: `runtime/evidence-runtime.js` captures bounded command output in memory, applies deterministic redaction before persistence, authenticates contract/receipt/review/adapter producers, and publishes content-addressed EvidencePackageV2 records without changing receipt schema version `1.0`.
- **Enforced verification and finish gates**: `runtime/verification-policy-runtime.js` compiles a closed, monotonic gate catalog by risk profile. Test and finish admission reject missing, stale, invalidated, or redaction-failed evidence and unaccepted residual risk.

### Reliability

- Same-base publication deterministically rebases record unions under the transaction boundary; evidence journal stages cover artifact, package, and pointer ownership with crash/replay checks.
- Release-blocking omission, sentinel-redaction, adapter-cleanup, receipt compatibility, lock-order, and 1,923-row logical matrix tests cover PR4/PR5/PR6 behavior.

Design: `docs/design/v6-13-spec-contract-evidence-policy.md`

## [6.12.0] — 2026-07-21 (Adaptive Routing & Unified Review)

### Added

- **Adaptive tier floors and effort routing**: risk-aware policy floors now raise model tiers monotonically, preserve explicit pins as the final authority, and carry mapped Codex reasoning effort through the measured execution route with clamp and flag-free retry evidence.
- **Unified review contract**: canonical policy and finding runtimes compile review plans, normalize and deduplicate findings, persist review rounds, and evaluate execution fail-closed. Legacy review documents are bounded shims, duplicate automatic review is removed, and Critical completion requires the declared human gate.
- **Canonical state carriers**: `model_routing_json`, `model_routing_meta_json`, `methodology_policy_json`, and `review_execution_json` use JSON-string frontmatter scalars with scalar-first shared readers, legacy fallback, and migration guards that do not clobber canonical metadata.

### Fixed

- **v6.11 handoff items**: `runtime/risk-runtime.js` now separates text, per-path, text×path, and database path×path hard triggers (including segment-bounded auth matching); authoritative reuse extracts `routing_diff` deterministically from state; and receipt validation emits correct, consistent `errors`/`warnings` summary JSON under Node's `-e` argv contract.

Design: `docs/design/v6-12-adaptive-routing-unified-review.md`

## [6.11.0] — 2026-07-21 (Shadow Risk & Policy Engine — observation-only)

- **risk-runtime**: 7-dimensional deterministic risk scoring + 9 hard triggers + canonical digest (`runtime/risk-runtime.js`)
- **policy-runtime**: risk class → methodology profile + recommended tier/effort + routing_diff (tier-vs-tier, concrete pins excluded) (`runtime/policy-runtime.js`)
- **risk-profile-cli**: fail-safe CLI — provisional/authoritative/slice stages with effective-input artifacts preserved under `$WORK_DIR/risk-inputs/` (`scripts/risk-profile-cli.js`)
- **state**: `risk_profile_json`/`policy_shadow_json`/`slice_risk_shadow_json` frontmatter JSON-string scalars (optional — legacy readers unaffected)
- **Observation surfaces**: `/deep-status --risk`, optional session-receipt `methodology_shadow`
- **No enforcement**: model routing and gate behavior remain entirely unchanged (shadow-only). Design: `docs/superpowers/specs/2026-07-20-v6.11-shadow-risk-policy-design.md`

## [6.10.0] — 2026-07-20 (automatic model selection — Claude Code / Codex)

### Added

- **5-key ask → 4-key**: `model_routing` is no longer asked. The engine decides per-phase
  models from codebase scale + task difficulty (deterministic signals + recommender
  `task_difficulty` ±1 adjustment; deterministic fallback when the recommender is unavailable).
- **Runtime-neutral tiers**: `light`/`standard`/`deep`/`main` resolved via per-runtime catalog
  (`runtime/model-catalog.js`). Codex sessions resolve to Codex models; unknown runtime
  fails safe to `main` (session model). Claude model names never leak into Codex paths.
- **Per-slice rule**: implement delegation resolves `clamp(sizeTier + difficulty offset)` —
  identical to the legacy slice-size auto at `standard`.
- **Overrides**: `--model-routing=implement=deep,test=light` flag, profile pinned concrete
  values (respected, engine skipped), `/deep-slice model` unchanged.

### Changed

- **Back-compat**: `model_routing_meta` is optional; legacy `main→sonnet` migration now skips
  engine-authored states (meta guard); old profiles keep working — `interactive_each_session`
  is filtered unconditionally (`filterAskItems`).

## [6.9.4] — 2026-07-10 (hooks stdin wrapper contract — shared helper)

### Fixed

- `file-tracker.sh` / `phase-transition.sh` — the two PostToolUse hooks did not support the stdin wrapper contract that 6.9.3 fixed for `phase-guard.sh` (deep-review round-2 DEFER **D-2**). In an env-unset harness that delivers `tool_name` / `tool_input` as top-level stdin JSON keys, `file-tracker.sh` read `TOOL_NAME` from env only (empty → file tracking / receipt collection silently skipped) and cached the **wrapper** JSON verbatim — so `phase-transition.sh`'s `file_path` extraction came up empty and the phase-transition checklist injection was silently dropped. `file-tracker.sh` now resolves both values through the shared helper **before** the cache write, so the cache always carries the flat `tool_input`; `phase-transition.sh` additionally unwraps defensively in case a wrapper-shaped payload arrives via its env/cache input path (a no-op for flat inputs and for env-set tool-name harnesses).

### Changed

- `hooks/scripts/utils.sh` — new shared `resolve_hook_tool_context` helper: env-first (`CLAUDE_TOOL_USE_TOOL_NAME` / `CLAUDE_TOOL_NAME`) → stdin wrapper fallback + nested `tool_input` unwrap, extracted from the 6.9.3 inline logic so all three hooks share one implementation. Semantics are unchanged: env-set harnesses never get their payload swapped (guard-vs-execution symmetry, R1-1), malformed JSON stays fail-open (allowlist + fail-closed is deferred to the stdin-contract promotion, DEFER D-1). The helper extracts both values in a **single** node spawn (`U+001F` unit separator — `JSON.stringify` escapes control characters, so payload content cannot collide) instead of the previous two spawns; `phase-guard.sh`'s main and Phase 5 paths now call it.

### Added

- `hooks/scripts/hooks-stdin-contract.test.js` — 10 cases: shared-helper unit contract (wrapper unwrap, env-first no-swap, flat/malformed fail-open, non-object `tool_input`, unit-separator collision safety), `file-tracker.sh` cache-unwrap + env-set flat regression, and the PreToolUse→PostToolUse env-unset e2e chain (`file-tracker` cache → `phase-transition` checklist injection) plus the wrapper-via-env defense-in-depth path.
- `hooks/scripts/test-helpers/run-phase-guard.js` — `CLAUDE_TOOL_USE_INPUT` / `CLAUDE_TOOL_INPUT` added to `HOST_LEAK_VARS` (they are `phase-transition.sh`'s env-first input source; a host leak would shadow the file-tracker cache path under test).

## [6.9.3] — 2026-07-10 (phase-guard stdin `tool_name`/`tool_input` fallback)

### Fixed

- `phase-guard.sh` — the PreToolUse hook read the tool name **only** from the `CLAUDE_TOOL_USE_TOOL_NAME` / `CLAUDE_TOOL_NAME` env vars. Current Claude Code harnesses (and runners such as cmux) do not set those vars and instead deliver `tool_name` / `tool_input` as top-level keys of the hook's stdin JSON payload — so `TOOL_NAME` came up empty, the extracted file path was empty, and `checkTddEnforcement` fail-closed classified every call as a production-file edit: in implement/strict TDD (PENDING) even harmless Bash queries, test-file edits, and exempt-file (`.md`/`.env`) edits were blocked (block message showed `파일: ` with an empty path), and non-implement phases blocked Bash queries too. The hook now falls back to parsing `tool_name` from the stdin payload and unwrapping the nested `tool_input` — strictly gated to when the env vars are absent (env-first): env-set harnesses keep the flat contract untouched, and the guard never swaps its evaluated payload away from what the tool actually executes (4-way review round-1 🔴 finding — an ungated unwrap would have opened a guard-vs-execution asymmetry). Both the main path and the Phase 5 read-only path are covered; with node absent the fallback degrades to the previous behavior. (Ref: `docs/handoff/2026-07-10-phase-guard-toolname-stdin-fallback.md`)

### Added

- `hooks/scripts/phase-guard-stdin-fallback.test.js` — 9 e2e cases pinning the stdin-only contract (Bash query allow / test-file Write allow / production Write **still blocked** / exempt `.md` Edit allow), the Phase 5 read-only boundary under stdin-only payloads (outside-work_dir Write and Bash redirect blocked, inside-work_dir Write allowed), and the no-regression contract for env-set harnesses (flat payload unchanged; env-set + wrapper payload is *not* unwrapped — fail-closed).
- `hooks/scripts/test-helpers/run-phase-guard.js` — `CLAUDE_TOOL_USE_TOOL_NAME` / `CLAUDE_TOOL_NAME` added to `HOST_LEAK_VARS`, so a tool-name value leaking from the host shell / CI can no longer break the "env unset" premise of hook tests.

## [6.9.2] — 2026-07-07 (silent-failure fixes + deterministic receipt gate)

### Fixed

- `update-check.sh` — the remote version probe pointed at `.../main/plugins/deep-work/package.json`, which 404s (the repo has no `plugins/` subtree). Every fetch failed, and the failure was then cached as `UP_TO_DATE` from an empty response — poisoning the 5-minute cache so the update prompt was suppressed **permanently**. The URL is corrected to the repo-root `package.json`, and a failed/empty/non-version fetch now exits without touching the cache (the next session retries) instead of masquerading as "up to date". Genuine up-to-date / upgrade-available results are still cached (anti-spam preserved).
- `file-tracker.sh` — files created via the **Bash** tool (`echo … > file`, `tee`, `cp`, redirects) were never added to the cross-session ownership registry. The ownership-extraction snippet used a bare `require('./phase-guard-core.js')` (resolved against the hook CWD, not the script dir → `MODULE_NOT_FOUND`) and truthy-checked the returned **object** `if(detectBashFileWrite(d))` (always true); the `2>/dev/null || echo ""` swallowed the module error. It now mirrors the verified `phase-guard.sh` pattern: absolute `require(process.argv[1])` + `const r = …; if (r.isFileWrite)`.
- `utils.sh` — registry mutations were **lost-update**-prone: each caller did an *unlocked* `read_registry` → transform → *locked* `write_registry`, so the lock never spanned the read and two concurrent sessions could clobber each other's registry write. The whole read-modify-write cycle is now serialized under one lock. Lock-free inner helpers (`_read_registry_unlocked` / `_write_registry_unlocked`) are split out, and `register_session` / `unregister_session` / `register_file_ownership` / `update_last_activity` / `update_registry_phase` / `register_fork_session` run read+transform+write under a single `_registry_rmw` lock hold. The public `read_registry` / `write_registry` wrappers are unchanged for existing callers (RMW callers must not re-enter them — the lock is not re-entrant), and `read_registry`'s missing-file default-write now also happens under the lock.

### Changed

- `wrap-receipt-envelope.js` + `skills/deep-finish/SKILL.md` §7-Z — the session-receipt evidence chain now carries the deep-test → deep-finish `test_passed` result deterministically instead of relying on prompt compliance. When `--session-state-file` is passed, the wrapper reads the state's `test_passed` frontmatter marker and stamps `x-test-verified: true|false` (forward-compat `^x-` namespace) on every session-receipt payload. `outcome` is **left as recorded** — by §7-Z a `merge`/`pr` is already physically complete (worktree removed + `branch -d`, or `gh pr create`), so rewriting it would misreport a done action to completion-polling / aggregation consumers; the receipt keeps the fact (`outcome`) and the verification signal (`x-test-verified`) as separate fields for downstream consumers to weigh. The emit is never refused, and absent the flag (or the state file) the payload is untouched (backward compatible).

### Added

- `hooks/scripts/update-check.test.js`, `hooks/scripts/registry-rmw.test.js`, `hooks/scripts/wrap-receipt-envelope.test.js`, and new cases in `hooks/scripts/file-tracker-fixes.test.js` — pin the URL anchor + fetch-failure branch, the RMW re-entrancy guard + concurrent no-lost-update behavior, the Bash-write ownership registration, and the deterministic test-verification gate.

## [6.9.1] — 2026-07-03 (Windows/Git Bash ghost `.claude` folder fix)

### Fixed

- `file-tracker.sh` no longer materializes a "ghost" `.claude` directory tree on Windows/Git Bash, and no longer leaves orphan `.hook-tool-input.*` payload files in unrelated projects. It never `mkdir -p`s a fresh tree (a malformed `$PROJECT_ROOT` from a CRLF `\r`- or backslash-tainted `$PWD` previously created bogus dirs like `pop-studio-suite <CR>/d/NHN/.../.claude/` on every tool call), and the PostToolUse tool-input cache is now written **only within an active deep-work session** (`$STATE_FILE` present) or when the call itself writes a `.claude/deep-work.*.md` state file — not on bare `.claude` existence.
- `utils.sh` hardens `$PROJECT_ROOT` derivation at its single source: new `sanitize_project_path()` strips stray CR, folds backslashes to forward slashes, and trims trailing whitespace; `find_project_root` sanitizes `$PWD` before walking and adds a drive-root loop-termination guard (never spins on `D:/`); `init_deep_work_state` replaces the `|| echo "$PWD"` double-emit — which produced a multi-line `PROJECT_ROOT` on the not-found path — with `|| true`.
- `update-check.sh` (a SessionStart hook) now reuses the hardened `find_project_root` / `sanitize_project_path` from `utils.sh` instead of a duplicated, unsanitized root walk that could spin on Windows drive roots (`D:/`) until the SessionStart timeout — the same bug class fixed centrally.
- `phase-transition.sh` now `normalize_path`s the extracted `file_path` (folding backslashes) before its `.claude/deep-work.*.md` guard, so Windows/Git Bash backslash state-file writes still fire the phase-transition injection (worktree / TDD / team-mode) instead of being silently dropped — keeping the cache writer (`file-tracker.sh`) and this consumer symmetric.

### Added

- `hooks/scripts/file-tracker-ghost-guard.test.js` — pins the sanitizer behavior (CR / backslash / trailing-space) and the cache gate (no `.claude` tree and no cached payload outside an active session; cache written for an active session or a state-file write).

## [6.9.0] — 2026-05-21 (deep-memory v0.1.0 consumer integration — Phase 1 recall + Phase 5 harvest recommendation)

### Added

- Phase 1 Research recall: when `.deep-memory/latest-brief.md` exists, the brief is quoted verbatim under a new `## Cross-project Memory` heading in `research.md`; when absent, nothing is written (privacy invariant). `/deep-memory-brief` is never auto-invoked. Cited memory IDs (`mem-<ULID>`) are captured into the `cross_project_memory.cited_memory_ids[]` state field.
- Phase 5 Integrate recommends `/deep-memory-harvest` when `deep-memory` is installed and the session changed files; `skills/deep-integrate/detect-plugins.sh` now enumerates deep-memory in `plugins.installed`/`plugins.missing`.
- `docs/deep-memory-integration-handoff.md` records the deferred `/deep-memory feedback` hook for a future joint PR.
- `tests/deep-memory-integration.test.js` pins the documented invariants (privacy boundary, ULID regex, heading-shift rule, edge cases).

### Changed

- Research artifact schema gains an additive `cross_project_memory` block, defaulting to null/empty when no brief is present (forward-compatible).

## [6.8.0] — 2026-05-19 (Plan-quality contract enforcement + CI hardening + receipt-tracker robustness)

### Changed

- Every non-inline S/M/L slice must declare `failing_test`, `verification_cmd`, `expected_output`, `code_sketch`, and `steps`; the plan review gate is aligned with this contract (no more "recommended" hedge or backward-compat fallback for missing fields).
- Planning references and templates switched to `SLICE-NNN` checklists with `depends_on`, `code_sketch`, `failing_test`, `verification_cmd`, and `expected_output`; `steps` are required (S: 2-4, M: 3-7, L: 5-12) with exact file paths.
- Completeness Policy expanded to reject vague directives, missing red signals, and missing exact `expected_output` fragments.
- A non-blocking `shellcheck` advisory step lints `hooks/scripts/**/*.sh`; CI Node bumped 20 → 22 (LTS) to support recursive `node --test` glob discovery.
- Receipt-tracker hardening: pre-lock receipt init restored with `O_CREAT | O_EXCL` so single-write slices retain a canonical `SLICE-NNN.json` even when the in-lock update path times out; pending changes drain on the next lock acquire.

## [6.7.1] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### Added

- `.codex-plugin/plugin.json` — Codex-native manifest pointing at the same skill and hook surfaces as the Claude Code manifest.
- `AGENTS.md` — Codex project guide covering runtime surfaces, verification, and the downstream suite marketplace update.
- Restored the primary `deep-work` skill alias so callers can invoke `$deep-work:deep-work "task"` without knowing the internal orchestrator name.

### Changed

- Manifest/package descriptions describe the entry alias as skill-native for both Claude and Codex; README calls out Codex compatibility.

## [6.7.0] — 2026-05-18 (24 commands → user-invocable skills: cross-platform)

### Changed

- All 24 command-equivalent surfaces are now `user-invocable: true` skills under `skills/`; the `commands/` directory was removed and `package.json` `files` updated to drop it.
- Skill invocation flows directly to skill bodies (`Skill({ skill: "deep-work:<verb>", args: "..." })`), working in Codex / Copilot CLI / Gemini CLI / Agent SDK as well as Claude Code; the orchestrator's 5-phase dispatch is unchanged.
- `$ARGUMENTS`-branching bodies (`deep-finish` flags, `deep-fork`, `deep-status` flag matrix, etc.) are preserved byte-for-byte.

## [6.6.3] — 2026-05-12

### Added

- `tests/phase-guard-golden.test.js` — fixture-driven golden test for `phase-guard.sh` (8 scenarios: idle allow, implement slice scope in/out, four non-implement denylist families, override pass-through).
- Shared `scrubHostEnv()` / `runPhaseGuard()` / `parseGuardOutput()` test helpers; per-family `CLAUDE_ALLOW_<FAMILY>` override loop and override fall-through composition assertions.

### Changed

- Extended `phase-guard-core.js` documentation on gate order, override-env semantics (suppresses denylist only, file-write still applies), and intentional scope omissions.

## [6.6.2] — 2026-05-12

### Added

- Non-implement dangerous-command denylist in `phase-guard-core.js` covering 5 families (rm-rf, npm-publish, kubectl-destructive, sql-destructive, curl-pipe-shell), each with a `CLAUDE_ALLOW_<FAMILY>=1` override; gate applied at research/plan/test/brainstorm Bash entry.

### Fixed

- SQL `TRUNCATE` single-char match bug and kubectl `--all-namespaces` false-positive.

## [6.6.1] — 2026-05-12

### Added

- Cross-platform CI matrix (`ubuntu-latest` + `macos-latest`) running `npm test` plus bash regression scripts.

### Fixed

- Cross-platform `stat` fallback (`stat -c '%a' || stat -f '%A'`) in a regression script.

## [6.6.0] — 2026-05-12

### Added

- `hooks/scripts/emit-handoff.js` — wraps a handoff payload in the M3 envelope and writes it under `.deep-work/handoffs/`, auto-chaining `parent_run_id` to the session receipt.
- `hooks/scripts/emit-compaction-state.js` — wraps a compaction-state payload in the M3 envelope (validated trigger/strategy enums); powers dashboard compaction metrics.
- `deep-finish` emits a cross-plugin handoff when `--handoff-to=<plugin>` is supplied.
- Stop hook and phase-transition hook emit best-effort `compaction-state.json` on session close and at each phase boundary.

### Changed

- `ALLOWED_ARTIFACT_KINDS` extended with `handoff` and `compaction-state` across the envelope library and CI validator.

## [6.5.0] — 2026-05-07

### Added

- M3 cross-plugin envelope adoption: `session-receipt.json` and `receipts/SLICE-*.json` now ship as `{ schema_version, envelope, payload }`, with the session receipt's `parent_run_id` chaining to the consumed `evolve-insights.json` and `provenance.source_artifacts[]` aggregating slice run IDs.
- `hooks/scripts/envelope.js` — zero-dep envelope library (ULID generator, git detection, `wrapEnvelope`/`unwrapEnvelope` with identity guards and corrupt-payload defense).
- `hooks/scripts/wrap-receipt-envelope.js` — CLI helper for wrapping a payload, with cross-plugin/intra-plugin chain extraction flags.
- `scripts/validate-envelope-emit.js` — zero-dep self-test validator mirroring the suite envelope schema.

### Changed

- Internal readers and cross-plugin consumers detect the envelope, enforce the identity guard, and unwrap to `.payload`; legacy non-envelope receipts pass through (forward-compatible).

## [6.4.2] — 2026-04-29

### Added

- Profile schema v3 with `interactive_each_session` — per-user control of which items are asked each session, with `defaults.*` applied automatically.
- `session-recommender` sub-agent (sonnet by default) infers ideal `team_mode` / `start_phase` / `tdd_mode` / `git` / `model_routing` from the task and workspace.
- New flags: `--no-ask` (skip ask + recommender, fastest path), `--recommender=MODEL`, `--no-recommender`.
- State-file permissions guidance (600) for multi-user environments.

### Changed

- `--profile=X` now proceeds through the ask step (add `--no-ask` for the old fast path).
- Profile v2 → v3 auto-migration: atomic write + flock + idempotent + `.v2-backup` + rollback.

### Fixed

- Shell injection in the flag parser (quoted single-string `$ARGUMENTS` no longer evaluated before the allowlist check).
- v6.4.1 `git_branch:` profiles are translated rather than rejected.
- Capability detection false negatives in normal git repos (uses `git rev-parse`/`git worktree list`).
- `--profile=X` now forwarded to the profile loader; preset-level settings (`project_type`, `cross_model_preference`, `auto_update`) no longer silently dropped.

### Removed

- Notification system removed entirely — `notify.sh`, its tests, and the notification guide deleted, and notify guards cleaned from the phase skills.

### Breaking

- Slack/Discord/Telegram/webhook integrations are severed; active webhook users must fork v6.4.1 before upgrading.
- Automated scripts relying on bare `--profile=X` must add `--no-ask` to preserve the old behavior.
- Profile v2 → v3 auto-migration loses unrecoverable fields such as `notifications.url` (a `.v2-backup` is retained for rollback).

## [6.4.1] — 2026-04-26

### Changed

- SessionStart sensor detection avoids slow `npx --no-install` probes, using local `node_modules/.bin` plus PATH lookup so missing-tool environments finish inside the hook timeout.
- Phase 1 Health Engine wiring documented in `deep-research`; the `health-check` CLI auto-loads `.deep-review/fitness.json` with `--fitness` / `--no-fitness` overrides.
- `/deep-status` and `/deep-receipt` read the actual producer paths under `health_report.drift.*` / `health_report.fitness.*`.

### Fixed

- Lint guard false-positive on test fixtures (exemption broadened from one file to all `*.test.js`).
- Parent receipt verification rejects empty/arbitrary sensor results, `fail`, `timeout`, and unsupported `not_applicable`, while still accepting documented metadata.
- Health Check CLI no longer mistakes `--fitness <file>` for the positional project root.

## [6.4.0] — 2026-04-23

### Changed

- **Breaking**: `model_routing.{research,implement,test}="main"` removed (auto-migrated to `"sonnet"` on load); `model_routing.plan="main"` preserved.
- **Breaking**: `team_mode` semantics unified to concurrency only (solo=1, team=N); main-session inline execution is now an explicit escape hatch.

### Added

- Three subagents under `agents/`: `research-codebase-worker` (read-only), `research-zerobase-worker` (read-only + web access), `implement-slice-worker` (TDD-enforced).
- `verify-delegated-receipt.sh` + `verify-receipt-core.js` — 8-item post-hoc receipt validation.
- Rollback protocol (`git reset --hard <snapshot>`) on verify-receipt failure; inline escape hatches (auto-routing, `--exec=<inline|delegate>`, debug takeover).
- `scripts/validate-agents.sh` — static sanity check for `agents/*.md`.

### Fixed

- Silent fallback from `team_mode=team` to solo when the experimental-teams env var was missing.
- Single `git_before` baseline reused across multi-slice receipts → per-slice baselines.
- Path-filtered diff hiding out-of-scope edits → unfiltered union-scope check.
- Zero-base subagent inheriting Write/Edit/Bash + web access → explicit read-only tool allowlist.

## [6.3.1] — 2026-04-21

### Fixed

- Phase skill body echo bug — `Skill("deep-*")` no longer exposes the SKILL.md template and skips the phase work (brainstorm clarifying questions, research/plan analysis).
- Exit Gate pause/resume regression — `current_phase` is now changed only by the orchestrator, so choosing "pause" re-presents the Exit Gate on `/deep-resume` instead of auto-entering the next phase.

### Added

- 4-layer echo defense across the 5 phase skills (admonition block, external templates, explicit First Action, execution-order safeguard).
- Phase Exit Gate on each of the 5 phases (proceed / re-run / pause) via AskUserQuestion.
- Completion-marker detection: phase skills return control to the orchestrator when a `*_completed_at` field is present.
- Approval integrity hash (`research_approved_hash` / `plan_approved_hash`) so `/deep-resume` detects out-of-band edits and backs up the edited doc to `{research,plan}.v{N}-edit.md` before re-review.
- Backup filename collision avoidance (`-edit` suffix vs. the skills' own `v{N}.md`).

### Known limitations

- Hash-mismatch recovery runs the generic review/approval flow without plan-specific validation (Completeness Policy, Contract Negotiation, Phase Review Gate); use Exit Gate "re-run" to apply full validation. Backup write-failure does not yet halt the state change.

## [6.3.0] — 2026-04-18

### Added

- **Phase 5 "Integrate"** — a skippable phase after Test that reads deep-suite plugin artifacts and lets an AI recommend the top-3 next steps in an interactive loop (max 5 rounds).
- `/deep-integrate` command for manual re-entry; `--skip-integrate` flag to go straight to `/deep-finish`.
- `skills/deep-integrate/` with helper scripts, JSON schemas, and fixtures.
- `phase5_work_dir_snapshot` state field — immutable boundary recorded at Phase 5 entry so runtime tampering with `work_dir` cannot widen the write boundary.
- `phase5-finalize.sh` (only sanctioned path to write state during Phase 5) and `phase5-record-error.sh` (records `terminated_by: "error"`); Stop hook records `terminated_by: "interrupted"`.

### Changed

- The orchestrator dispatches Phase 5 between Test and `/deep-finish`; on error it passes `--skip-integrate`.
- New Phase 5 guard mode: writes must stay under the snapshot `$WORK_DIR`, state mutation is restricted to `phase5-finalize.sh`, and Bash is allowlist-only (default-deny) — read-mostly commands and `$WORK_DIR`-scoped filesystem ops only, with destructive/in-place/compound forms blocked.
- `/deep-integrate` tool allowlist narrowed (removed `Write`, `Edit`).

### Upgrade notes

- Sessions that entered Phase 5 under v6.2.x without the snapshot fall back to mutable `work_dir`; re-entering Phase 5 records the snapshot. Phase 5 helpers require `jq` on PATH (except `phase5-finalize.sh`).

### Known limitations

- Some interpreters (`Rscript`/`julia`/`lua`/...) and `awk -f` are not in the Phase 5 allowlist; networked exfil mitigation and per-command invocation audit are tracked for later. `Agent`/`Skill` tools pass through the Phase 5 guard.

## [6.2.4] — 2026-04-17

Bug-fix release addressing hook-layer bugs and documentation drift from an internal audit.

### Fixed

- `file-tracker.sh`: replaced BSD-only `sed -i ''` with a Node inline script (previous code failed silently on Linux).
- `update-check.sh`: pass the plugin path via `process.argv` so install paths containing an apostrophe no longer break the update check.
- `phase-guard.sh` / `file-tracker.sh` / `phase-transition.sh`: JSON-parser-based `file_path` extraction (paths with escaped quotes were truncated).
- `phase-transition.sh`: extract the innermost `deep-work.XXXX` segment for `SESSION_ID` so fork worktree paths resolve correctly.
- Receipt updates wrapped in a mkdir-based spinlock with a crash-safe pending-changes drain; `sensor-trigger.js` and `file-tracker.sh` share the state lock.
- `utils.sh write_registry`: fail-closed on lock timeout (no force-remove of another process's lock) with errors logged.
- `phase-guard-core.js`: internal errors `exit(3)` (distinct from intentional blocks); `phase-guard.sh` fail-closes on empty `decision`.
- `phase-guard.sh`: reads `slice_files` / `strict_scope` / `exempt_patterns` from frontmatter so slice-scope is actually enforced; all block-message heredocs JSON-escape interpolated fields.
- `phase-transition.sh` cache: `file-tracker.sh` caches stdin before any phase-based early return and writes atomically, so all phase transitions refresh the cache.
- `notify.sh`: YAML-aware `notifications.enabled` parser, `osascript`/PowerShell-toast escaping, and `pipefail` dropped.

### Changed

- Documentation: 21 broken reference links fixed across 7 SKILL.md files; version labels refreshed; CLAUDE.md structure listing completed.

### Known limitations

- Cross-platform CI matrix not yet in place; new portability fixes rely on unit tests.

## [6.2.3] — 2026-04-16

### Changed

- `trigger-eval.json` benchmark set expanded 31 → 54 samples and rebalanced; standalone commands reclassified to not trigger full workflow sessions.

## [6.2.2] — 2026-04-16

### Fixed

- Removed POSIX inline env-var assignments from all 5 hook commands (Windows `cmd.exe` could not parse them); scripts now read Claude Code's native env vars directly with backward-compatible fallback.

## [6.2.1] — 2026-04-15

### Changed

- Command classification cleanup: 13 commands reclassified into Quality Gate / Internal / Escape hatch / Utility / Special utility; `/deep-finish` reframed as "auto-call primary, manual first-class".
- Hook/skill guidance routes to `/deep-status` flags; README (en/ko) and workflow docs updated to the new categories.

### Notes

- No commands removed and no functional behavior changed — only labels, wordings, and version numbers.

## [6.2.0] — 2026-04-14

### Added

- Cross-Plugin Context: Phase 1 Research references `harnessability-report.json` (deep-dashboard) and `evolve-insights.json` (deep-evolve).

## [6.1.0]

### Added

- **P0 Worktree Path Guard** — PreToolUse hook that hard-blocks Write/Edit/Bash outside the active worktree (meta directories exempt), across all phases.
- **P1 Phase Transition Injector** — PostToolUse hook that injects worktree/team/cross-model/tdd context when `current_phase` changes.
- 6 phase skills (independent SKILL.md per phase), reducing context load 45-81%.
- Review + Approval workflow — 6-step protocol for Research and Plan, with the orchestrator owning `current_phase`.

### Changed

- Core phase commands reduced to thin `Skill()` dispatch wrappers; shared references relocated to `skills/shared/references/`.
- `deep-resume` routes Research/Plan resume through the orchestrator; `deep-test` no longer sets idle on success.
- Implement receipts explicitly require `status: "complete"`; drift gate gains a `plan_approved_at` fallback chain.

## [6.0.2]

### Added

- Unified Phase Review Gate — every phase (0-3) runs self-review + external review before transitioning, with a phase-specific fallback chain and user confirmation; `/deep-phase-review` uses the same chain.

### Changed

- Session folder renamed `deep-work/` → `.deep-work/` (hidden) with auto-migration and worktree safety check; only session folders and history are gitignored.

## [6.0.1] — 2026-04-10

### Added

- Superpowers integration: per-slice 2-stage review (Spec Compliance required + Code Quality advisory), Red Flags tables, pre-flight check, and `slice_confidence`/`concerns` per receipt.
- Phase 4 cross-slice + backfill review (slices that FAILed in Phase 3 are mandatory backfill targets); scope-creep detection over all changed files; per-slice working-tree diff.

### Changed

- Phase 4 Spec Compliance and Code Quality gates focus on cross-slice consistency; receipt `git_diff` uses the per-slice baseline.

## [6.0.0] — 2026-04-09

### Added

- **Computational Sensor Pipeline** — registry-driven ecosystem detection (JS/TS/Python/C#/C++), 8 output parsers, a SENSOR_RUN → SENSOR_FIX → SENSOR_CLEAN state-machine extension after GREEN, a 3-round self-correction loop, `/deep-sensor-scan`, and a fail-closed policy.
- **Mutation Testing** — Stryker / stryker-net / mutmut integration, `/deep-mutation-test` with git-diff scope and a test-regeneration loop, plus a Mutation Score quality gate (15% of the session score).
- **Health Engine** — Phase 1 Health Check with 4 parallel drift sensors (dead-export, stale-config, dependency-vuln, coverage-trend).
- **Architecture Fitness Functions** — declarative rules in `.deep-review/fitness.json` (file-metric, forbidden-pattern, structure, dependency) with a validator and ecosystem-aware generator.
- Baseline management (`health-baseline.json`, commit/branch-scoped with auto-invalidation); Phase 4 Fitness Delta (Advisory) and Health Required (Required) gates; receipt `health_report` field consumed by deep-review.
- **Harness Templates** — 6 built-in topologies with a deep-merge loader and `custom/` override; Phase 1/3 integration.
- **Self-Correction Loop** — `review-check` sensor (always-on topology layer + fitness layer) with a per-sensor 3-round limit.

### Changed

- Session Quality Score uses 5 weights (Test Pass 25%, Rework 20%, Plan Fidelity 25%, Sensor Clean 15%, Mutation 15%); Health Check is excluded from scoring.

## [5.8.1] — 2026-04-08

### Changed

- **Breaking**: `/deep-review` → `/deep-phase-review` to resolve the naming conflict with the deep-review plugin; phase-document review uses the renamed command, code-diff review uses the plugin.

## [5.8.0] — 2026-04-08

### Added

- Completeness Policy — explicit banned patterns for `plan.md` (TBD, TODO, vague directives, content-free cross-references).
- Code-sketch tiering (S annotated pseudocode / M signatures + types / L complete boundary code) and `failing_test` detail tiers.
- Slice fields `expected_output` and `steps`; "Boundary: Files NOT to Modify" section; research traceability tags (`[RF-NNN]`, `[RA-NNN]`) with lifecycle rules; a research Testing Patterns section.
- Brainstorm context-adaptive questions, Scope Assessment, and Boundaries sections; review-gate `code_completeness` and `buildability` dimensions with a legacy-plan compatibility fallback.

### Changed

- The slice parser recognizes the new (optional) fields; RED uses `failing_test`, GREEN compares against `expected_output`; planning/research guides upgraded.

## [5.7.0] — 2026-04-08

### Added

- Sprint Contract generation after plan approval (when deep-review is installed) from `plan.md` slices into `.deep-review/contracts/`.
- Per-slice review suggestion (`/deep-review --contract SLICE-NNN`) at GREEN, full-review suggestion at Phase 4, and wiki-ingest suggestion after Phase 4.

### Changed

- Contract generation moved to after plan approval so contracts match the final plan; plugin detection unified across install methods.

## [5.6.0] — 2026-04-07

### Added

- `/deep-fork` — fork a session to explore a different approach (git worktree full replication or, in non-git, artifacts-only with implement/test blocked), with parent-child tracking, fork-snapshot baseline, stale-parent validation, and a 3-generation limit.
- `/deep-status --tree` and `--compare` fork auto-detection; fork info in default status; `/deep-cleanup` fork support; fork utility functions in `utils.sh`.

### Changed

- Session registry and state frontmatter gain fork-relationship fields.

## [5.5.2] — 2026-04-06

### Added

- Extended bash file-write detection (20+ patterns: perl in-place, `node -e`/`python -c`/`ruby -e` writes, awk, destructive git ops, curl/wget output, archive extraction, rsync) and extended safe-command, test-file, and TDD-exempt patterns.
- TDD state validation and backtick/subshell-aware command splitting.

### Fixed

- **Security**: file-write patterns are now checked before safe-command patterns (safe prefixes no longer mask file writes, e.g. `node -e` with `fs.writeFileSync`).
- `file-tracker.sh` Node 25 `process.argv` compatibility; several `assumption-engine.js` fixes (quality-timeline CLI, threshold passing, dedup keep-latest, array input guards); `session-end.sh` JSON validation, session-id fallback, and error logging.

### Changed

- Redirect detection broadened to catch mid-command redirects; `node -e` removed from safe patterns; model-name sanitization and configurable signal thresholds.

## [5.5.1] — 2026-04-03

### Changed

- In team mode the plan phase loads partial research files as supplementary references and cross-checks plan decisions against them.
- B-1 (RED_VERIFIED) and B-2 (GREEN) state updates marked mandatory with phase-guard blocking warnings.

### Fixed

- `phase-guard.sh` reads JSON input from a stdin pipe instead of `process.argv` to avoid `set -e` failures on large inputs.

## [5.5.0] — 2026-04-02

### Added

- Research Cross-Model Review (codex/gemini) with a dedicated research rubric; Claude self-review for plans; a Consolidated Judgment protocol replacing per-conflict prompts.
- Auto-fix snapshot contract with score-regression rollback; degraded mode tracking failed reviewers (`reviewer_status`); v5.5 state-schema migration with resume validation.

### Changed

- Structural-review auto-fix trigger raised to score < 7 (max 3 iterations for research); the research user-feedback gate folded into consolidated judgment.

## [5.3.0] — 2026-03-31

### Added

- Document Intelligence — deduplicate and prune `research.md`/`plan.md` when feedback is applied, with a refinement log.
- Session relevance detection (offers a new session or backlog for out-of-scope requests); Plan Fidelity Score (0-100); Session Quality Score (0-100); assumption snapshots and quality integration; cross-session quality trend; shields.io quality badge.
- Authoritative JSONL write at `deep-finish` (atomic upsert); `session-end.sh` writes provisional records only.

### Fixed

- `session-end.sh` writes to the shared `harness-history/` so session data is visible to trend/assumption commands.

### Changed

- README restructured to a problem-solution narrative (demo GIFs removed); `exportBadge()` returns a structured object (breaking for direct consumers).

## [5.2.0] — 2026-03-31

### Added

- Auto-flow orchestration — `/deep-work` chains all phases automatically; plan approval is the only required interaction.
- Unified `/deep-status` with `--receipts` / `--history` / `--report` / `--assumptions` / `--all`; auto-run Drift Check (required), SOLID Review (advisory), and Insight Analysis in `/deep-test`.

### Changed

- 13 auxiliary commands marked deprecated (still functional); `/deep-work` Step 1 offers resume/new/cancel; plan.md Quality Gates table becomes an optional override.

### Deprecated

- `/deep-brainstorm`, `/deep-review`, `/deep-receipt`, `/deep-slice`, `/deep-insight`, `/deep-finish`, `/deep-cleanup`, `/deep-history`, `/deep-assumptions`, `/deep-resume`, `/deep-report`, `/drift-check`, `/solid-review` (functionality folded into the auto-flow or `/deep-status`).

## [5.1.2] — 2026-03-30

### Added

- Team-mode auto-setup (offers to configure `~/.claude/settings.json`) and runtime validation with automatic Solo fallback across all phases.

### Fixed

- Team-mode selection without proper configuration now reliably falls back to Solo across all phases.

## [5.1.1] — 2026-03-30

### Fixed

- **Critical**: phase-guard fail-closed on internal errors (no enforcement bypass); receipt JSON updates use temp-file + rename (no corruption from concurrent hooks).
- Command-chain bypass closed (`&&`/`||`/`;`/`|` sub-commands checked independently); bash TDD target extraction; exact comma-delimited skipped-phase matching; Write/Edit fail-closed on missing `file_path`.
- JSONL history locking, cross-platform timestamp parsing, notification JSON escaping, path normalization, literal YAML field extraction, and receipt initial creation via `JSON.stringify`.

### Changed

- Signal evaluators use a `{ scope, fn }` format; `TEST_FILE_PATTERNS` extended (Rust, Java, C#, Kotlin, Swift).

## [5.1.0] — 2026-03-30

### Added

- Auto-Loop Evaluation (plan-review and test-phase auto-retry with escalation); Contract Negotiation (`contract` / `acceptance_threshold` slice fields); Assumption Engine auto-apply via Wilson Score; adaptive evaluator model; `--skip-to-implement`.

### Changed

- Structural review auto-loops (up to 3) before escalating; default evaluator model changed haiku → sonnet; slice format gains contract fields.

## [5.0.0] — 2026-03-30

### Added

- **Self-Evolving Harness (Assumption Engine)** — every enforcement rule is a falsifiable hypothesis with machine-readable evidence signals.
- `assumptions.json` (5 core assumptions) and `assumption-engine.js` (Wilson Score confidence, staleness/new-model detection, report + ASCII timeline + badge export).
- `/deep-assumptions` command; per-slice `harness_metadata` in receipts; `harness-sessions.jsonl` appended at session end; assumption-health summary at session init and in `/deep-report`.

## [4.2.1] — 2026-03-26

### Added

- TDD Override — when TDD blocks a production edit, Claude offers to write the test first or skip TDD for this slice with a recorded reason (slice-scoped, auto-clears on transition); escape-hatch guidance in block messages; `tdd_override` state field and receipt fields.

### Changed

- `phase-guard-core.js` / `phase-guard.sh` honor `tdd_override`; `deep-implement` gains a TDD Override flow; receipt/finish/history surfaces show override counts.

## [4.2.0] — 2026-03-25

### Added

- Structural Review of all phase documents (Claude haiku subagent); adversarial cross-model review of plans (codex / gemini-cli) with a transparent conflict-resolution UX; a Review Gate blocking auto-implement on low scores; `/deep-review`; `--skip-review`; cross-model tool auto-detection; profile `cross_model_preference`; review state in resume/status; JSON-normalized review results.

### Changed

- Brainstorm/research/plan gain review steps; `phase-guard-core.js` adds codex/gemini/mktemp to safe patterns; state and profile schemas extended.

### Fixed

- `.gitignore` excludes the workflow workspace venv.

## [4.1.0] — 2026-03-25

### Added

- Worktree isolation by default (`.worktrees/dw/<slug>/`, opt-out via `--no-branch`); model auto-routing by slice complexity (S/M/L/XL) with per-slice override; `/deep-finish` with 4 completion options; CI/CD receipt validation (`validate-receipt.sh`, CI template, `--format=ci` export); `/deep-history`; `/deep-cleanup`.
- Receipt schema v1.0 (slice receipts canonical, session receipt derived) with a migration helper; worktree-aware resume; model cost tracking; shared `utils.sh`.

### Changed

- Default `model_routing.implement` → `"auto"`; default `git_branch` → `true`; `validate-receipt.sh` uses `set -eo pipefail` for Bash 3.2.

## [4.0.1] — 2026-03-25

### Added

- Git-based auto-update check on SessionStart (auto-update, escalating snooze, opt-out); shell-injection prevention via `process.argv` in `phase-guard.sh` / `file-tracker.sh`.

### Fixed

- macOS compatibility (removed `timeout` usage); version consistency in docs.

## [4.0.0] — 2026-03-25

### BREAKING — Evidence-Driven Development Protocol

deep-work becomes an evidence-driven development protocol: every code change carries proof (failing/passing test output, git diff, spec check, code review) collected as JSON receipts.

### Added

- Phase 0 Brainstorm (`/deep-brainstorm`, skip with `--skip-brainstorm`); slice-based execution; hook-enforced TDD state machine (modes: strict/relaxed/coaching/spike); per-slice receipts.
- Bash tool monitoring (intercepts file-writing shell patterns in non-implement phases); systematic debugging (`/deep-debug`); `/deep-slice`; `/deep-receipt`; 2-stage code review; Receipt Completeness and Verification Evidence gates; spike-mode guard.

### Changed

- Hybrid bash + Node hook architecture; plan format becomes a slice checklist; full rewrites of implement/test/plan; `Bash` added to PreToolUse/PostToolUse matchers.

## [3.3.3] — 2026-03-24

### Added

- Multi-preset profile system (Profile v2 with `presets:`, v1 → v2 auto-migration, `--profile=X`, `--setup` management UI, interactive selection); expanded trigger-eval set with false-positive guards.

### Changed

- `/deep-work` profile load/save and resume updated for the v2 format.

## [3.3.2] — 2026-03-22

### Added

- Profile system — first run saves setup answers, later runs apply them instantly; override flags; `--setup`.
- Session resume (`/deep-resume`) with artifact-based context restoration and phase auto-continue; checkpoint verification via `git diff --name-only`.

### Changed

- `/deep-work` restructured around profile load/save; implement gains a checkpoint mandate and post-agent verification.

## [3.3.0] — 2026-03-22

### Added

- Insight Tier Quality Gate (`/deep-insight`, built-in analyses, `insight-report.md`, never blocks); PostToolUse file tracking to `file-changes.log`; a Stop hook for session-end reminders.

### Changed

- `hooks.json` expanded to PreToolUse + PostToolUse + Stop; `/deep-test` parses ℹ️ insight markers and adds a built-in Insight step; reports and status read the new artifacts.

## [3.2.2] — 2026-03-21

### Added

- Internationalization — all command files detect the user's language and output messages accordingly (Korean templates as the reference), enabling English/Japanese/Chinese/other users without modification.

## [3.2.1] — 2026-03-21

### Fixed

- SKILL.md description trimmed (~1,500 → ~450 chars) and changelog bloat removed; `deep-research.md` step renumbering; `deep-test.md` drops `Edit` from allowed-tools; command-description language standardized; `notify.sh` message escaping; explicit phase-guard path in SKILL.md.

### Added

- `.gitignore` mirroring `.npmignore` to prevent committing state files and session artifacts.

## [3.2.0] — 2026-03-18

### Added

- 3-Tier Quality Gate system (Required / Advisory / Insight); Plan Alignment / Drift Detection (`/drift-check` + built-in gate, `drift-report.md`); SOLID Design Review (`/solid-review` + advisory gate, `solid-review.md`); SOLID review guides.

### Changed

- `/deep-test` auto-runs Plan Alignment before other gates; SKILL.md restructured; `plan_approved_at` added to the state schema.

## [3.1.0] — 2026-03-17

### Breaking

- Repository structure migrated to a `plugins/deep-work/` subdirectory — existing users must reinstall.

### Added

- Model Routing (per-phase model assignment, 30-40% token savings); multi-channel notifications; incremental research (`--incremental`, 60-80% time savings); Quality Gate system; Plan Diff visualization; routing/notification guides.

### Changed

- `/deep-work` init, `/deep-status`, and `/deep-report` surface the new options; state schema and marketplace source path updated.

## [3.0.0] — 2026-03-13

### Added

- Phase 4 Test (`/deep-test`) with auto-detected test/lint/type-check commands and a fix-and-retest loop (up to 3 retries), `test-results.md`, and Test-phase edit blocking.
- Zero-Base mode for new projects; interactive plan review (feedback updates `plan.md`); plan version backups and 6 templates; partial/cached research; git branch + commit suggestions; implement checkpoints; per-phase time tracking; team-mode progress; `/deep-status --compare`.

### Changed

- Phase flow becomes `research → plan → implement → test ⟲ → idle`; Executive Summary / Plan Summary placed first (pyramid principle); phase-guard block messages gain next-step guidance; state schema and SKILL.md extended.

## [2.0.0] — 2026-03-07

### Added

- Per-task folder history (`deep-work/YYYYMMDD-HHMMSS-slug/`); auto-start implementation on plan approval; auto-generated session report; `/deep-report`; `/deep-status`; Solo/Team mode with 3-agent parallel research and cross-review.

### Changed

- State file gains `work_dir` / `team_mode` / `started_at`; Phase Guard allows document edits within `deep-work/`.

## [1.1.0] — 2026-03-01

### Added

- Phase Guard (PreToolUse hook) blocking code-file edits during Research/Plan; state-file-based phase management.

### Changed

- Migrated from a prompt-based approach to hook-based enforcement.

## [1.0.0] — 2026-02-15

### Added

- Initial release: 3-phase workflow (Research → Plan → Implement); `/deep-work`, `/deep-research`, `/deep-plan`, `/deep-implement`; `research.md` / `plan.md` artifacts; iterative plan review.
