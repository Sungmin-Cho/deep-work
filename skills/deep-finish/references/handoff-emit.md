# Optional cross-plugin handoff emit (§7-Z-A)

> Reference for `${CLAUDE_PLUGIN_ROOT}/skills/deep-finish/SKILL.md`. Both handoff paths: the explicit `--handoff-to=<plugin>` route and the interactive proposal on outcome merge/pr. Covers when to emit `.deep-work/handoffs/*.json`, the emit-handoff.js invocation, and the `--no-handoff` opt-out (which suppresses only the interactive proposal).

---

### 7-Z-A. Optional cross-plugin handoff emit

> **Ordering**: this block runs **after** Section 7-Z (which wraps the
> session-receipt and assigns its `run_id`) and **before** Section 8 (state
> finalization). It MUST not run before 7-Z — the handoff payload chains its
> `parent_run_id` to the session-receipt's envelope `run_id`. If 7-Z fails
> (exit 1), skip this block and tell the user to re-run `/deep-finish` after
> resolving the wrap retry.

When the user opts to hand off to another deep-suite plugin (typically
deep-evolve for performance optimization, deep-review for security audit, or
a custom downstream), emit a cross-plugin handoff artifact (`handoff.json`).
The dashboard's `suite.handoff.roundtrip_success_rate` metric reads these.

**Trigger conditions** (LLM decides which path applies):
- `$ARGUMENTS` includes `--handoff-to=<plugin>` (preferred — fully automated;
  no user prompt). Parse the value into `HANDOFF_TO`.
- `outcome` is `"merge"` or `"pr"` AND `$ARGUMENTS` has no `--no-handoff` AND
  the orchestrator is in interactive mode → AskUserQuestion:

  ```
  세션을 다른 플러그인에 인계할까요?
  1. 인계 안함 — 이대로 종료
  2. deep-evolve — 성능/품질 최적화 루프
  3. deep-review — 독립 코드 리뷰
  4. (기타) — 직접 플러그인 이름 입력
  ```

  (2)/(3)/(4) → set `HANDOFF_TO` accordingly; (1) → skip this block.

**Payload composition** (per `deep-suite/schemas/handoff.schema.json`):

Write `$WORK_DIR/.handoff.payload.json` with the LLM-composed payload. Pull
fields from the session-receipt + slice receipts + any review reports under
`.deep-review/reports/`:

```json
{
  "schema_version": "1.0",
  "handoff_kind": "phase-5-to-evolve",
  "from": {
    "producer": "deep-work",
    "session_id": "<SESSION_ID>",
    "phase": "integrate",
    "completed_at": "<RFC 3339 — session-receipt.finished_at>"
  },
  "to": {
    "producer": "<HANDOFF_TO>",
    "intent": "<short label — LLM-derived from session goals or user-supplied>",
    "scope_hint": "<optional: src path or module name>"
  },
  "summary": "<one paragraph: outcome + slice GREEN count + key metric baseline>",
  "next_action_brief": "<seed prompt for receiver: WHY + CURRENT STATE + TARGET (measurable)>",
  "key_artifacts": [
    { "path": "<work_dir>/session-receipt.json", "kind": "session-receipt", "run_id": "<from 7-Z>" }
  ],
  "completed_actions": ["<from session-receipt + slice receipts>"],
  "context_window_state": {
    "compacted_at": "<RFC 3339>",
    "compaction_strategy": "key-artifacts-only",
    "preserved_artifact_paths": ["<work_dir>/session-receipt.json"]
  }
}
```

`handoff_kind` defaults to `phase-5-to-evolve` when `HANDOFF_TO == "deep-evolve"`;
use `custom` + `x-handoff-subkind` for non-canonical receivers (e.g.
`HANDOFF_TO == "deep-review"`).

**Emit**:

```bash
set -euo pipefail

# HANDOFF_TO must be set by the parser above; if empty, skip.
[ -z "${HANDOFF_TO:-}" ] && exit 0

RECEIPT_PATH="$WORK_DIR/session-receipt.json"
HANDOFF_PAYLOAD="$WORK_DIR/.handoff.payload.json"
# Flat-dir layout matches dashboard SOURCE_SPECS (`.deep-work/handoffs/*.json`).
HANDOFF_DIR="$PROJECT_ROOT/.deep-work/handoffs"
HANDOFF_OUT="$HANDOFF_DIR/$(date -u +%Y%m%dT%H%M%SZ)-${SESSION_ID:-session}.json"

mkdir -p "$HANDOFF_DIR"

if node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/emit-handoff.js" \
    --payload-file "$HANDOFF_PAYLOAD" \
    --output "$HANDOFF_OUT" \
    --source-session-receipt "$RECEIPT_PATH" \
    ${SESSION_ID:+--session-id "$SESSION_ID"}; then
  rm -f "$HANDOFF_PAYLOAD"
  echo "✓ handoff emitted → $HANDOFF_OUT (receiver: $HANDOFF_TO)"
else
  echo "⚠️ handoff emit failed — payload preserved at $HANDOFF_PAYLOAD for inspection" >&2
fi
```

The helper:
- Sets `envelope.parent_run_id = session-receipt.envelope.run_id` automatically
  (closes the intra-plugin chain the dashboard reads for
  `suite.handoff.roundtrip_success_rate`).
- Sets the identity-triplet (`producer = deep-work`, `artifact_kind = handoff`,
  `schema.name = handoff`, `schema.version = "1.0"`) — required by the
  dashboard's `unwrapStrict`.
- Validates payload required fields before writing — exit 1 with the missing
  field; the temp payload is preserved for retry.

**Receiver workflow** (informational; not part of `/deep-finish`):

```
/deep-evolve --resume-from-handoff .deep-work/handoffs/<file>.json
```

This block does NOT replace Section 8 — state finalization still runs.

