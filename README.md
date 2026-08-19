**English** | [한국어](./README.ko.md)

# deep-work

[![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/deep-work?label=version)](https://github.com/Sungmin-Cho/deep-work)
[![license](https://img.shields.io/github/license/Sungmin-Cho/deep-work)](./LICENSE)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/deep-suite)

An **Evidence-Driven Development Protocol** for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and Codex. A single command drives a full Brainstorm → Research → Spec → Plan → Implement → Test → Integrate workflow with TDD enforcement, receipt-based evidence collection, and a hard separation between planning and coding.

deep-work fights the common failure modes of AI coding on complex tasks: introducing new patterns that ignore the existing architecture, reimplementing utilities that already exist, jumping into code before understanding the codebase, adding unrequested "improvements" that cause bugs, and marking work done without verification.

## Role in deep-suite

deep-work is the **core harness engine** of the [deep-suite](https://github.com/Sungmin-Cho/deep-suite), implementing the [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) framework (Böckeler/Fowler, 2026). Across the Guide/Sensor × Computational/Inferential matrix it provides:

- **Computational Guides** — Phase Guard hook (physically blocks edits), Worktree Guard (P0, hard-blocks writes outside the worktree), authenticated correct-RED → GREEN → REFACTOR authority with automatic stop-and-replan, and topology templates.
- **Computational Sensors** — linter/typecheck/coverage/mutation pipeline, drift sensors, fitness rules, the review-check sensor, and the Phase Transition Injector (P1).
- **Inferential Guides** — research / plan / brainstorm documents and the Sprint Contract.
- **Self-Correction Loop** — SENSOR_RUN → SENSOR_FIX → SENSOR_CLEAN with a per-sensor 3-round limit.

It emits producer-authenticated functional receipts, governed progress projections, and health reports that [deep-review](https://github.com/Sungmin-Cho/deep-review) and [deep-dashboard](https://github.com/Sungmin-Cho/deep-dashboard) consume.

## Install

Via the `claude-deep-suite` marketplace (recommended):

```bash
/plugin marketplace add Sungmin-Cho/deep-suite
/plugin install deep-work@claude-deep-suite
```

Standalone, from this repository:

```bash
/plugin marketplace add Sungmin-Cho/deep-work
/plugin install deep-work@Sungmin-Cho-deep-work
```

deep-work runs in both the Claude Code and Codex plugin runtimes — each reads its native manifest, and skill callers use the same skill-native invocation model.

> **Windows**: hook scripts require `bash` in PATH (Git for Windows or WSL).

## Usage

The entire workflow runs from one skill invocation; plan approval is the only required interaction.

```bash
# Run the full auto-flow: Brainstorm → Research → Spec → Plan → [approve] → Implement → Test → Integrate → Report
$deep-work:deep-work "Implement JWT-based user authentication"

# Unified status — flags route to the same implementations as the standalone skills
$deep-work:deep-status              # current progress
$deep-work:deep-status --report     # session report
$deep-work:deep-status --receipts   # receipt dashboard
$deep-work:deep-status --history    # cross-session trends
$deep-work:deep-status --assumptions # assumption health
$deep-work:deep-status --all        # everything at once
$deep-work:deep-status --compare    # compare two sessions
```

In Claude Code the same surfaces are also available as slash commands (e.g. typing the command name); in Codex and other hosts use the `$deep-work:<verb>` skill form.

## Skills

deep-work exposes 27 command-equivalent skills. The most-used are:

| Skill | Description |
|---|---|
| `$deep-work:deep-work <task>` | Auto-flow orchestration — runs the entire pipeline; plan approval is the only required interaction |
| `$deep-work:deep-research` | Phase 1 (Research) — deep codebase analysis |
| `$deep-work:deep-spec` | Phase 2 (Spec) — executable requirements, failure modes, and evidence gates |
| `$deep-work:deep-plan` | Phase 3 (Plan) — slice-based implementation planning |
| `$deep-work:deep-implement` | Phase 4 (Implement) — TDD-enforced slice execution |
| `$deep-work:deep-test` | Phase 5 (Test) — receipt + spec + quality gates; auto-runs drift-check, SOLID review, insight |
| `$deep-work:deep-integrate` | Phase 6 (Integrate) — cross-plugin next-step recommendation loop |
| `$deep-work:deep-status` | Unified view (`--report` / `--receipts` / `--history` / `--assumptions` / `--all` / `--compare`) |
| `$deep-work:deep-finish` | Close a session — merge, PR, keep, or discard the worktree |
| `$deep-work:deep-debug` | Systematic debugging: investigate → analyze → hypothesize → fix |

Other skills cover quality gates (`drift-check`, `solid-review`, `deep-insight`), session utilities (`deep-fork`, `deep-resume`, `deep-cleanup`, `deep-slice`), and toolchain helpers (`deep-mutation-test`, `deep-sensor-scan`, `deep-phase-review`), plus the read-only status sub-skills (`deep-report`, `deep-receipt`, `deep-history`, `deep-assumptions`). All can be invoked manually; many also run automatically inside the auto-flow.

## The workflow

| Phase | Role |
|---|---|
| **0 — Brainstorm** | Optional design exploration, "why before how" (skip with `--skip-brainstorm`) |
| **1 — Research** | Deep codebase analysis across architecture, patterns, data, API, infra, and risks; output `research.md` |
| **2 — Spec** | Executable requirements, invariants, failure modes, compatibility, and evidence gates; output `spec.md` |
| **3 — Plan** | Slice-based plan with per-slice TDD fields, requiring user approval; output `plan.md` |
| **4 — Implement** | TDD-enforced slice execution: failing test → production code → receipt |
| **5 — Test** | Receipt completeness, spec compliance, code quality, and verification evidence, with up to 3 implement→test retries |
| **6 — Integrate** | Skippable loop that reads deep-suite plugin artifacts and proposes up to 3 next steps (skip with `--skip-integrate`) |

Each pre-integration phase ends with an explicit Exit Gate (proceed / revise / pause). Code-file edits are physically blocked during Brainstorm, Research, Spec, Plan, and Test (including file-writing Bash commands like `echo >`, `sed -i`, `cp`); file changes and receipt data are collected automatically during Implement.

## Output Files

All session artifacts live in `.deep-work/<task-folder>/`:

| File | Created | Description |
|---|---|---|
| `research.md` | Phase 1 | Codebase analysis (Executive Summary first) |
| `spec.md` | Phase 2 | Executable requirements, failure modes, and evidence-gate contract |
| `plan.md` | Phase 3 | Implementation plan (per-slice contract + acceptance fields) |
| `plan.v{N}.md` / `plan-diff.md` | Plan rewrite | Previous plan backup / structural change comparison |
| `brainstorm.md` | Phase 0 | Problem definition, approach comparison, success criteria |
| `receipts/SLICE-NNN.json` | Phase 3 | Per-slice evidence: TDD output, git diff, spec check, review, model |
| `file-changes.log` | Phase 3 | Auto-tracked file modifications with slice mapping |
| `test-results.md` | Phase 4 | Verification results (cumulative per attempt) |
| `quality-gates.md` / `drift-report.md` / `solid-review.md` / `insight-report.md` | Phase 4 | Quality gate, plan-alignment, SOLID, and metrics reports |
| `report.md` | Session complete | Full session report incl. phase durations |
| `session-receipt.json` | Session finish | Cross-slice session summary (M3 envelope) |
| `debug-log/RC-NNN.md` | Phase 3 (debug) | Root-cause analysis notes |
| `harness-history/harness-sessions.jsonl` | Session end | Per-session assumption-engine data |

Session state is stored as YAML frontmatter in `.claude/deep-work.local.md` (current phase, work dir, TDD state, model routing, worktree info, quality gates, health report, and more).

## Hooks

Hooks manage the session lifecycle and computational enforcement.

| Hook | Trigger | Purpose |
|---|---|---|
| SessionStart (`update-check.sh`) | startup/resume | Git-based version update check |
| PreToolUse (`phase-guard.sh`) | Write/Edit/MultiEdit/Bash | Phase-based edit blocking + P0 Worktree Path Guard + non-implement dangerous-command denylist |
| PostToolUse (`file-tracker.sh`) | Write/Edit/MultiEdit/Bash | Tracks file modifications during Implement, updates receipts |
| PostToolUse (`sensor-trigger.js`) | Write/Edit/MultiEdit/Bash | Triggers the computational sensor pipeline (lint, typecheck, review-check) |
| PostToolUse (`phase-transition.sh`) | Write/Edit/MultiEdit | P1 Phase Transition Injector — injects worktree/team/cross-model context on phase change |
| Stop (`session-end.sh`) | CLI session end | Active-session reminder, worktree info, phase-cache cleanup |

The Phase Guard denylist also blocks dangerous non-implement Bash (e.g. `curl | sh`, `rm -rf` on protected paths, `npm publish`, destructive `kubectl`/SQL, `dd`/`mkfs`), each with a per-family `CLAUDE_ALLOW_*` override env var.

## Key features

- **TDD enforcement** — a hook-enforced state machine (PENDING → RED → RED_VERIFIED → GREEN_ELIGIBLE → GREEN → REFACTOR) blocks production-code edits until a failing test exists. Modes: `strict`, `relaxed`, `coaching`, `spike`, plus a slice-scoped TDD override.
- **Worktree isolation** — sessions run in an isolated git worktree by default (`.worktrees/dw/<slug>/`); `/deep-finish` offers merge / PR / keep / discard. Opt out with `--no-branch`.
- **Model routing** — per-phase and per-slice model assignment (S→haiku, M/L→sonnet, XL→opus) cuts token cost; override per slice or in the preset routing table.
- **Receipts as M3 envelopes** — `session-receipt.json` and slice receipts ship as cross-plugin envelopes with identity-triplet guards and chained provenance, validated by `validate-receipt.sh` and a CI template.
- **Health Engine + architecture fitness** — Phase 1 runs parallel drift sensors (dead-export, stale-config, dependency-vuln, coverage-trend) and validates declarative rules in `.deep-review/fitness.json`; Phase 4 adds Fitness Delta (advisory) and Health Required (required) gates.
- **Quality measurement** — every session produces a Session Quality Score (test pass rate, rework cycles, plan fidelity, sensor clean rate, mutation score), trended across sessions.
- **Self-evolving rules** — the Assumption Engine treats each enforcement rule as a falsifiable hypothesis and suggests relaxing or strengthening it based on session-quality evidence.
- **Multi-model review** — phase documents are structurally reviewed, and plans get adversarial cross-model review from [codex](https://github.com/openai/codex) and/or [gemini-cli](https://github.com/google/gemini-cli) when installed (skip with `--skip-review`).
- **Profiles & flags** — named presets (`--profile=X`, `--setup`) and per-session overrides (`--team`, `--zero-base`, `--skip-research`, `--skip-to-implement`, `--tdd=MODE`).
- **Internationalization** — all messages follow the user's language automatically (Korean reference templates, translated on the fly).

## Plugin integration

deep-work integrates with sibling plugins when they are installed, always with user confirmation before any action:

- **deep-review** — generates `.deep-review/contracts/` from approved slices, suggests slice and full reviews, and shares `fitness.json` + `health_report` for architecture-aware review.
- **deep-wiki** — suggests `/wiki-ingest report.md` after a session to archive research and design decisions.
- **deep-memory** — recalls a cross-project brief in Phase 1 and recommends `/deep-memory-harvest` in Phase 5 (opt-in, read-only).

## Links

- [CHANGELOG](CHANGELOG.md) — release history
- [deep-suite](https://github.com/Sungmin-Cho/deep-suite) — the marketplace and sibling plugins
- [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md)

## License

MIT
