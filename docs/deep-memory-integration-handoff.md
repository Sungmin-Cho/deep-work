# deep-memory v0.1.0 — deep-work Consumer-Side Integration Handoff

> **Audience**: contributors who land deep-memory-related changes in `deep-work`. This file is the **spec of record** for everything the deep-memory v0.1.0 integration adds on the deep-work side, plus the Phase 4+ roadmap for items deferred from v0.1.0.
>
> **Source spec**: `deep-memory/docs/superpowers/specs/2026-05-20-deep-memory-design.md` §14.2 (the deep-memory-side spec lists the 6 deep-work consumer items). This document mirrors that list and adds implementation detail.
>
> **Sibling plugin**: deep-memory v0.1.0 — https://github.com/Sungmin-Cho/deep-memory · marketplace entry already published in deep-suite (commit `68ff717`).

---

## 0. Why a consumer-side integration

`deep-memory` is a **read-only consumer** plugin from deep-work's perspective: it harvests artifacts emitted by deep-work (and other suite plugins) and produces task-specific **memory briefs** that future work can recall before it starts.

For the loop to close, deep-work needs two affordances:

1. **Recall** — when entering Phase 1 Research, surface the most recent `.deep-memory/latest-brief.md` so the research artifact carries cross-project memory as context.
2. **Persist** — when exiting Phase 5 Integrate, suggest `/deep-memory-harvest` as one of the top-3 next-step recommendations so this session's outputs flow back into the memory layer.

Both affordances are **opt-in**. deep-memory must never auto-trigger from deep-work — recall is privacy-sensitive (the brief may quote past work from other projects), and harvest is a write operation. The user keeps both gates.

---

## 1. Item map (spec §14.2)

| # | Item | Status in this PR | Where to look |
|---|---|---|---|
| 1 | This handoff doc | ✅ landed (this file) | `docs/deep-memory-integration-handoff.md` |
| 2 | Phase 1 Research cites `.deep-memory/latest-brief.md` | ✅ landed | `skills/deep-research/SKILL.md` — *Cross-Plugin Context → Deep-Memory Brief Context* |
| 3 | Phase 5 Integrate top-3 includes `/deep-memory-harvest` | ✅ landed | `skills/deep-integrate/SKILL.md` — *3-2 LLM 추천 요청* + *3-4 B-fallback* |
| 4 | Research artifact schema gains a `Cross-project Memory` section | ✅ landed | embedded in item 2's section (recall + provenance list) |
| 5 | `/deep-memory feedback <id> <accepted\|rejected>` hook | 🟡 **deferred to Phase 4+** | spec only — see §4 below |
| 6 | Graceful + cited tests | ✅ landed | `tests/deep-memory-integration.test.js` |

---

## 2. Item 2 + 4 — Phase 1 Research recall + provenance

### 2.1 Behavior

In `skills/deep-research/SKILL.md`, the `Cross-Plugin Context` block already enumerates external plugin data sources (Harnessability, Evolve Insights). A third subsection is added: **Deep-Memory Brief Context**.

When the Research skill enters Phase 1:

1. **Probe** — check whether `.deep-memory/latest-brief.md` exists in `$WORK_DIR`'s project root (resolved as `git rev-parse --show-toplevel` from `$WORK_DIR`; in non-git worktrees use the nearest ancestor containing a `.git/` directory — R1-I2 clarification).
2. **Cite (present)** — read the file and reproduce its content **verbatim** under a `## Cross-project Memory` heading in `$WORK_DIR/research.md`. The brief's heading hierarchy is preserved by adding two `#` levels (the brief is `# Deep-Memory Brief — <task>` / `## <idx>. <memory_type> — <memory_id>`, so it becomes `### Deep-Memory Brief — <task>` / `#### <idx>. ...` under the research-side `## Cross-project Memory` parent). **The `## Cross-project Memory` section is created only in this case** — when the brief is absent the research artifact stays deep-memory-agnostic (see step 3).
3. **Suggest (absent)** — emit a one-line note **into the runtime Research context only**, not into `research.md`: *"No `.deep-memory/latest-brief.md` found. Run `/deep-memory-brief \"<task>\"` first if you want cross-project recall."* Then continue normally — no `AskUserQuestion`, no auto-invoke. **The user must explicitly request recall.** This keeps the research artifact free of deep-memory-specific content for users who never opt in (R1-Y2 fix — prior behavior leaked the suggestion into every research.md unconditionally).
4. **Stale guard** — if the brief's mtime is older than 14 days, emit a stale warning *(\"brief is stale — re-run /deep-memory-brief\")* but still cite it (the user opted in by writing it; let them decide).
5. **Provenance** — extract every `\`mem-<ULID>\`` token from the cited brief (the deep-memory `memory_id` format is `mem-<ULID>` rendered inside single backticks in the markdown heading line) and write them to a new `cross_project_memory` field in the research state. This list is the provenance audit trail for which memories shaped this research artifact.

### 2.2 State field shape (additive only, forward-compatible)

Added to the research state frontmatter / state file (no version bump required — frontmatter is open-shaped):

```yaml
cross_project_memory:
  brief_path: .deep-memory/latest-brief.md          # null if absent
  brief_mtime: 2026-05-21T03:14:00Z                  # null if absent
  brief_stale: false                                  # true if > 14d old
  cited_memory_ids:                                   # extracted from brief
    - mem-01HXY...
    - mem-01HXZ...
```

When absent, all five fields are `null` / `[]` — the schema is shape-stable.

### 2.3 Why inline + verbatim quotation

- The deep-memory brief is already privacy-redacted (3-pass) and human-formatted. Re-rendering would lose evidence quality and risk drift.
- Verbatim quotation makes the provenance trail trivially auditable — search for any cited `mem-<ULID>` and you find the originating card.
- Inline (vs. a separate file pointer) keeps the research artifact self-contained for downstream consumers (`deep-plan`, `deep-implement`) that read `research.md` without re-resolving paths.

### 2.4 Privacy invariants

- **Never auto-invoke `/deep-memory-brief`** — recall is user-driven. The Research skill only reads an already-materialized brief file; it never produces one.
- **Never write back to the brief** — the file is read-only from deep-work's perspective. Updates to brief content always go through `/deep-memory-brief`.
- **Stale warning is non-blocking** — the user already accepted recall by materializing the brief; we surface staleness but don't gate on it.

---

## 3. Item 3 — Phase 5 Integrate recommends `/deep-memory-harvest`

### 3.1 Behavior

In `skills/deep-integrate/SKILL.md`:

1. **LLM prompt (Section 3-2)** — the recommendation prompt is extended to declare `deep-memory` as an installable target with the canonical command `/deep-memory-harvest`. The LLM is told to *propose harvest when the session changed > 0 files and the previous round did not already harvest*. This keeps harvest from saturating the loop when there's nothing new to learn.
2. **B-fallback (Section 3-4)** — when the LLM path fails twice, the deterministic fallback list now includes `/deep-memory-harvest` as a candidate alongside the existing `/deep-review`, `/deep-docs scan`, `/wiki-ingest` candidates. Rendering is gated on `plugins.installed` containing `deep-memory` (the signal envelope already enumerates installed plugins).
3. **Installation suggestion** — when `deep-memory` is in `plugins.missing` (not installed), the LLM may emit an `installation_suggestions[]` entry as it does for any other missing plugin. Same gate as the existing suite plugins.

### 3.2 Why harvest at Phase 5 and not Phase 4 (Test) or `/deep-finish`

- Phase 5 is where deep-work already deliberately enumerates next-step plugins. Harvest belongs in that menu — it's optional, user-confirmed, and identical in shape to `/deep-review` / `/wiki-ingest` (all post-session enrichment).
- Phase 4 (Test) runs while the session is still mutating. Harvesting then would consume a moving target.
- `/deep-finish` is the lifecycle close — too late for harvest to participate in the integrate loop's recommendation budget.

### 3.3 Recommendation text shape

Following the existing Section 3-3 rendering convention:

```
1. /deep-memory-harvest  — Session 결과를 memory에 누적시켜 다음 작업에서 회상 (recurring-findings ≥ N, changes.files_changed=M).
```

The rationale field cites concrete envelope signals (per the existing prompt rule: *"rationale is ≥10 chars, cites specific signals"*).

---

## 4. Item 5 — `/deep-memory feedback <id> <accepted|rejected>` (DEFERRED)

### 4.1 Why deferred to Phase 4+

The feedback hook requires **both sides** to be aware:

- **deep-memory side**: a `/deep-memory feedback` command that mutates the underlying card's `feedback_history[]` and (eventually) the ranking model. **Not implemented in v0.1.0** (out-of-scope per the v0.1.0 spec §16).
- **deep-work side**: a Research post-step that asks *"did the recall help?"* and emits the feedback command.

Landing one side without the other creates a silent no-op surface. The two changes are bundled into a Phase 4+ joint PR.

### 4.2 Future PR specification (for the implementer)

When the Phase 4+ PR lands, deep-work needs to add:

1. **Research exit hook** — after the user approves the research artifact at the Phase Review Gate, if `cross_project_memory.cited_memory_ids` is non-empty, `AskUserQuestion`: *"방금 인용된 cross-project memory가 도움이 됐나요?"* with options *(a) all accepted, (b) selective, (c) all rejected, (d) skip*.
2. **Per-memory feedback (option b)** — for selective, iterate the cited IDs and ask accepted/rejected per ID.
3. **Emit feedback commands** — for each accepted/rejected pair, render a deferred `/deep-memory feedback <id> <accepted|rejected>` line into a `.deep-work/<session>/pending-memory-feedback.sh` file. **Do not auto-invoke** — same privacy stance as recall.
4. **Surface in Phase 5** — the integrate loop's existing `/deep-memory-harvest` candidate becomes a 2-step suggestion: *"먼저 `pending-memory-feedback.sh`를 실행한 뒤 `/deep-memory-harvest`"*.

The feedback file is deferred-execution rather than direct command emission because:

- the user may want to review/edit before sending,
- it survives session restarts,
- it stays harmless when deep-memory is uninstalled (just an inert shell file).

### 4.3 Schema reservation

To keep this PR forward-compatible with the Phase 4+ work, the Research state's `cross_project_memory` block (§2.2) already includes `cited_memory_ids[]` — that's the field the feedback hook will read. **Do not rename it.**

---

## 5. Item 6 — Tests

`tests/deep-memory-integration.test.js` covers two scenarios:

1. **Graceful path** — `.deep-memory/latest-brief.md` absent. Assertion: the Research skill body still contains the *"No `.deep-memory/latest-brief.md` found"* suggestion line and includes the `cross-project memory` section title with no cited IDs. **Verifies the skill body wording stays in sync with this spec** — when the wording changes in either place, the test breaks first.
2. **Cited path** — fixture brief planted at `<fixture>/.deep-memory/latest-brief.md` containing two `mem-<ULID>` tokens. Assertion: a small parser extracts the same two IDs from the planted brief (verifies the regex used to populate `cited_memory_ids`).

Both tests are **fixture-based static assertions** — they exercise the documented contract (skill body wording + ID extraction regex) without running the full Research worker, which would require an active deep-work session and Claude Code runtime.

---

## 6. Operational notes

### 6.1 No new dependencies

This integration adds **zero new npm packages** to deep-work. The brief is plain markdown read with the existing Read tool / `fs.readFileSync` in tests. ID extraction is a one-line regex.

### 6.2 No phase-guard changes

`.deep-memory/` is a normal directory under the project root. `phase-guard.sh`'s non-implement denylist already allows reads anywhere; the Research skill only reads the brief and never writes to `.deep-memory/`. No denylist or override env var is required.

### 6.3 Receipt envelope unchanged

The deep-work session/slice receipt envelopes (M3) are untouched by this PR. The `cross_project_memory` field lives in the Research artifact / state file, not in the receipt payload. Downstream consumers that read session receipts see no change.

### 6.4 Cross-repo coupling

Everything in this PR is **local to the deep-work repo**. No `deep-suite/` marketplace bump, no `deep-memory/` PR. The deep-memory marketplace entry was published independently (commit `68ff717`).

---

## 7. Glossary

| Term | Definition |
|---|---|
| **brief** | `.deep-memory/latest-brief.{json,md}` — top-N retrieved memory cards for a task. Produced by `/deep-memory-brief`. |
| **card** | `~/.deep-memory/cards/<type>/{global,project_id}/<memory_id>.json` — distilled, persistent memory atom. Produced by `/deep-memory-harvest`. |
| **memory_id** | `mem-<ULID>` — Crockford-base32 ULID prefixed with `mem-`, **uppercase-only** (I/L/O/U excluded). Rendered inside backticks in the brief markdown. |
| **recall** | The act of reading a brief into the active context (Phase 1 Research). |
| **harvest** | The act of writing cards from session artifacts (Phase 5 Integrate). |
| **promotion** | Moving a `local` card to `global` (deep-memory side, `/deep-memory-audit --promote <id>`). Out of scope for deep-work. |
