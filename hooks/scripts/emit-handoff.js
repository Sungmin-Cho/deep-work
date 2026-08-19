#!/usr/bin/env node
'use strict';

/**
 * emit-handoff.js — Wrap a handoff payload in the deep-work M3 envelope and
 * write to disk. Used by /deep-finish (or /deep-integrate) when the user opts
 * to hand off to another plugin (typically deep-evolve) at Phase 5 Integrate.
 *
 * Identity-triplet contract enforced by the dashboard's unwrapStrict:
 *   - envelope.producer === 'deep-work'
 *   - envelope.artifact_kind === 'handoff'
 *   - envelope.schema.name === 'handoff'
 *   - envelope.schema.version === '1.0'
 * Payload required fields (cf. deep-suite/schemas/handoff.schema.json):
 *   schema_version, handoff_kind, from, to, summary, next_action_brief
 *
 * Cross-plugin chain (closes via envelope.parent_run_id):
 *   handoff.envelope.parent_run_id === session-receipt.envelope.run_id
 * Set automatically when --source-session-receipt is provided.
 *
 * Usage:
 *   node emit-handoff.js \
 *     --payload-file <path>           handoff payload JSON (built by SKILL)
 *     --output <path>                 final envelope-wrapped artifact
 *     [--source-session-receipt <p>]  intra-plugin chain — fills parent_run_id
 *     [--source-review-report <p>]    additional provenance entry (no chain)
 *     [--parent-run-id <ULID>]        explicit override (wins over --source-*)
 *     [--session-id <id>]             higher-level session marker
 *
 * Exit codes:
 *   0 — wrote envelope-wrapped handoff
 *   1 — payload missing required fields per handoff schema
 *   2 — usage / IO / argv error
 *
 * Notes:
 *   - Output dir is created if missing. Atomic temp+rename to avoid partial
 *     reads by dashboard collector running concurrently.
 *   - This helper does NOT validate the payload against the full suite schema
 *     (no ajv dep). It enforces the dashboard's hard-required field set; the
 *     companion validator (scripts/validate-envelope-emit.js) catches envelope
 *     shape violations; CI in deep-suite catches schema drift.
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./envelope');

const KNOWN_FLAGS = new Set([
  'payload-file',
  'output',
  'source-session-receipt',
  'source-review-report',
  'parent-run-id',
  'session-id',
]);

// Dashboard's PAYLOAD_REQUIRED_FIELDS['deep-work/handoff'] mirrored here so we
// catch malformed handoffs at emit time, not later at dashboard ingest time.
const HANDOFF_REQUIRED = [
  'schema_version',
  'handoff_kind',
  'from',
  'to',
  'summary',
  'next_action_brief',
];

// R1 review C4: handoff_kind enum from deep-suite/schemas/handoff.schema.json.
// Previously not enforced — a typo (`phase-5-evolve` missing `to`) would write
// successfully and pollute dashboard telemetry.
const VALID_HANDOFF_KINDS = new Set([
  'phase-5-to-evolve',
  'evolve-to-deep-work',
  'slice-to-slice',
  'session-resume',
  'custom',
]);

// R2 review fix (Codex adversarial MEDIUM): direction enforcement for kinds
// with canonical producer↔producer mappings. Prevents typos like
// `handoff_kind: 'evolve-to-deep-work'` paired with `from.producer:
// 'deep-work'` (wrong direction) from polluting dashboard telemetry. Custom +
// session-resume + slice-to-slice are NOT direction-bound (caller defines).
const KIND_DIRECTIONS = {
  'phase-5-to-evolve': { from: 'deep-work', to: 'deep-evolve' },
  'evolve-to-deep-work': { from: 'deep-evolve', to: 'deep-work' },
};

function usage(extra) {
  if (extra) process.stderr.write(`error: ${extra}\n`);
  process.stderr.write(
    'usage: emit-handoff.js --payload-file <p> --output <p>\n' +
      '                       [--source-session-receipt <p>] [--source-review-report <p>]\n' +
      '                       [--parent-run-id <ULID>] [--session-id <id>]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) usage(`unexpected positional argument: ${a}`);
    let key, value;
    if (a.includes('=')) {
      const eq = a.indexOf('=');
      key = a.slice(2, eq);
      value = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        usage(`flag --${key} expects a value`);
      }
      value = next;
      i++;
    }
    if (!KNOWN_FLAGS.has(key)) usage(`unknown flag --${key}`);
    args[key] = value;
  }
  return args;
}

function readJson(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    process.stderr.write(`error: cannot read ${p}: ${err.message}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`error: cannot parse ${p} as JSON: ${err.message}\n`);
    process.exit(2);
  }
}

// R2 review fix (Codex adversarial MEDIUM): enforce identity-triplet check
// before using a source artifact's run_id as parent_run_id. Previously this
// helper only ran `isValidEnvelope` (loose shape check) — a foreign envelope
// (e.g., deep-evolve evolve-receipt accidentally passed as source) would
// silently become this handoff's parent_run_id, corrupting dashboard chain
// reconstruction.
//
// expectedIdentities: optional array of `{ producer, kind }` tuples. When
// supplied, the envelope must match at least one tuple on producer +
// artifact_kind + schema.name. When omitted, the loose check is preserved
// for backward compat (no caller currently relies on this path).
function tryReadEnvelopeRunId(filePath, expectedIdentities) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!env.isValidEnvelope(obj)) return null;
    if (typeof obj.envelope.run_id !== 'string') return null;
    if (Array.isArray(expectedIdentities) && expectedIdentities.length > 0) {
      const matches = expectedIdentities.some(
        (id) =>
          obj.envelope.producer === id.producer &&
          obj.envelope.artifact_kind === id.kind &&
          obj.envelope.schema &&
          obj.envelope.schema.name === id.kind,
      );
      if (!matches) return null;
    }
    return obj.envelope.run_id;
  } catch (_err) {
    return null;
  }
}

function validateHandoffPayload(payload) {
  const errors = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload must be a non-null, non-array object');
    return errors;
  }
  for (const f of HANDOFF_REQUIRED) {
    if (!(f in payload)) errors.push(`payload missing required field "${f}"`);
  }
  if ('schema_version' in payload && payload.schema_version !== '1.0') {
    errors.push(
      `payload.schema_version must be "1.0", got ${JSON.stringify(payload.schema_version)}`,
    );
  }
  // R1 review C4: enforce handoff_kind enum (previously omitted — typos passed).
  if ('handoff_kind' in payload && !VALID_HANDOFF_KINDS.has(payload.handoff_kind)) {
    errors.push(
      `payload.handoff_kind must be one of ${[...VALID_HANDOFF_KINDS].join(', ')}, ` +
        `got ${JSON.stringify(payload.handoff_kind)}`,
    );
  }
  // R2 review fix: direction enforcement for kinds with canonical producer pairs.
  if (
    typeof payload.handoff_kind === 'string' &&
    KIND_DIRECTIONS[payload.handoff_kind] &&
    payload.from &&
    typeof payload.from === 'object' &&
    !Array.isArray(payload.from) &&
    payload.to &&
    typeof payload.to === 'object' &&
    !Array.isArray(payload.to)
  ) {
    const expected = KIND_DIRECTIONS[payload.handoff_kind];
    if (payload.from.producer && payload.from.producer !== expected.from) {
      errors.push(
        `payload.from.producer for handoff_kind="${payload.handoff_kind}" must be ` +
          `"${expected.from}", got ${JSON.stringify(payload.from.producer)}`,
      );
    }
    if (payload.to.producer && payload.to.producer !== expected.to) {
      errors.push(
        `payload.to.producer for handoff_kind="${payload.handoff_kind}" must be ` +
          `"${expected.to}", got ${JSON.stringify(payload.to.producer)}`,
      );
    }
  }
  if (
    'from' in payload &&
    (payload.from === null ||
      typeof payload.from !== 'object' ||
      Array.isArray(payload.from) ||
      typeof payload.from.producer !== 'string' ||
      typeof payload.from.completed_at !== 'string')
  ) {
    errors.push('payload.from must include string producer + completed_at');
  }
  if (
    'to' in payload &&
    (payload.to === null ||
      typeof payload.to !== 'object' ||
      Array.isArray(payload.to) ||
      typeof payload.to.producer !== 'string' ||
      typeof payload.to.intent !== 'string')
  ) {
    errors.push('payload.to must include string producer + intent');
  }
  return errors;
}

function atomicWriteJson(targetPath, obj) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, targetPath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const r of ['payload-file', 'output']) {
    if (!args[r]) usage(`missing required flag --${r}`);
  }

  const payloadPath = path.resolve(process.cwd(), args['payload-file']);
  const outputPath = path.resolve(process.cwd(), args['output']);
  const payload = readJson(payloadPath);

  // R2 review fix (Codex review P3): propagate --session-id to payload.session_id
  // when payload doesn't define it. Dashboard's drill-down counts unique sessions
  // from payload.session_id; without this, --payload-file callers who supply
  // --session-id at CLI but not in payload lose per-session attribution.
  if (
    args['session-id'] &&
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    !payload.session_id
  ) {
    payload.session_id = args['session-id'];
  }

  const errors = validateHandoffPayload(payload);
  if (errors.length > 0) {
    process.stderr.write('handoff payload validation failed:\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  let parentRunId = args['parent-run-id'] || undefined;
  const sourceArtifacts = [];

  if (args['source-session-receipt']) {
    const srPath = path.resolve(process.cwd(), args['source-session-receipt']);
    // R2 review fix: require source to be a deep-work session-receipt envelope
    // (rejecting foreign producer / foreign kind). Falls through to no-chain on
    // identity mismatch (W1 stderr warn fires below).
    const srRunId = tryReadEnvelopeRunId(srPath, [
      { producer: 'deep-work', kind: 'session-receipt' },
    ]);
    sourceArtifacts.push({
      path: args['source-session-receipt'],
      ...(srRunId ? { run_id: srRunId } : {}),
    });
    if (!parentRunId && srRunId) parentRunId = srRunId;
    // R1 review W1 (Opus W-1): stderr warn when --source-session-receipt is
    // provided but yields no run_id (file missing, corrupt, or not an envelope).
    // Producer-side: previously silently emitted handoff with no parent_run_id,
    // which dashboard counts as an orphan (legitimate "no upstream" looks
    // identical to "user passed wrong file"). The warning lets the caller
    // diagnose chain breakage at emit time.
    if (!parentRunId && !srRunId && !args['parent-run-id']) {
      process.stderr.write(
        `warning: --source-session-receipt ${args['source-session-receipt']} is not a ` +
          `valid envelope (chain broken; suite.handoff.roundtrip_success_rate will skip)\n`,
      );
    }
  }

  if (args['source-review-report']) {
    sourceArtifacts.push({ path: args['source-review-report'] });
  }

  let wrapped;
  try {
    wrapped = env.wrapEnvelope({
      artifactKind: 'handoff',
      payload,
      parentRunId,
      sessionId: args['session-id'] || undefined,
      sourceArtifacts,
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  try {
    atomicWriteJson(outputPath, wrapped);
  } catch (err) {
    process.stderr.write(`error: cannot write ${outputPath}: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `emitted: ${outputPath} (run_id=${wrapped.envelope.run_id}, parent_run_id=${
      wrapped.envelope.parent_run_id || '∅'
    })\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  HANDOFF_REQUIRED,
  VALID_HANDOFF_KINDS,
  KIND_DIRECTIONS,
  validateHandoffPayload,
  tryReadEnvelopeRunId,
};
