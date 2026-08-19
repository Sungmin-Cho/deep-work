#!/usr/bin/env node
'use strict';

/**
 * emit-compaction-state.js — Wrap a compaction-state payload in the deep-work
 * M3 envelope and write to disk. Used by hooks (Stop, PostToolUse for phase
 * transition) and explicit invocations from skills (slice GREEN inline
 * compaction) to feed dashboard's M4-deferred compaction.* metrics.
 *
 * Identity-triplet contract enforced by the dashboard's unwrapStrict:
 *   - envelope.producer === 'deep-work'
 *   - envelope.artifact_kind === 'compaction-state'
 *   - envelope.schema.name === 'compaction-state'
 *   - envelope.schema.version === '1.0'
 * Payload required fields (cf. deep-suite/schemas/compaction-state.schema.json):
 *   schema_version, compacted_at, trigger, preserved_artifact_paths
 *
 * Trigger enum (must match schemas/compaction-state.schema.json):
 *   phase-transition, slice-green, loop-epoch-end, window-threshold,
 *   manual, session-stop
 *
 * Usage (build payload from CLI args — typical hook path):
 *   node emit-compaction-state.js \
 *     --trigger <enum>                 required
 *     --output <path>                  required
 *     [--session-id <id>]              recommended (drives dashboard grouping)
 *     [--preserved <p1,p2,...>]        comma-separated artifact paths
 *     [--discarded <p1,p2,...>]        drives preserved_artifact_ratio
 *     [--discarded-summary <text>]     audit-only
 *     [--pre-tokens <n>]               producer-side estimate
 *     [--post-tokens <n>]              producer-side estimate
 *     [--strategy <enum>]              compaction_strategy (see schema)
 *     [--source-session-receipt <p>]   intra-plugin chain → parent_run_id
 *     [--parent-run-id <ULID>]         explicit override (wins over --source-*)
 *
 * Usage (build from existing payload file):
 *   node emit-compaction-state.js \
 *     --payload-file <path>            mutually exclusive with --trigger
 *     --output <path>
 *     [--source-session-receipt <p>] [--parent-run-id <ULID>] [--session-id <id>]
 *
 * Exit codes:
 *   0 — wrote envelope-wrapped compaction-state
 *   1 — payload validation failed (bad trigger, missing required field)
 *   2 — usage / IO / argv error
 *
 * Hook contract: when invoked from a Stop hook, this helper MUST exit 0 even
 * on internal errors (hook contract — never block session close). Callers
 * should wrap in `|| true` and redirect stderr appropriately.
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./envelope');

const KNOWN_FLAGS = new Set([
  'trigger',
  'output',
  'session-id',
  'preserved',
  'discarded',
  'discarded-summary',
  'pre-tokens',
  'post-tokens',
  'strategy',
  'source-session-receipt',
  'parent-run-id',
  'payload-file',
]);

const COMPACTION_REQUIRED = [
  'schema_version',
  'compacted_at',
  'trigger',
  'preserved_artifact_paths',
];

const VALID_TRIGGERS = new Set([
  'phase-transition',
  'slice-green',
  'loop-epoch-end',
  'window-threshold',
  'manual',
  'session-stop',
]);

const VALID_STRATEGIES = new Set([
  'key-artifacts-only',
  'receipt-only',
  'summary-only',
  'selective-message-drop',
  'full-reset',
  'custom',
]);

function usage(extra) {
  if (extra) process.stderr.write(`error: ${extra}\n`);
  process.stderr.write(
    'usage: emit-compaction-state.js --trigger <enum> --output <p>\n' +
      '                                 [--session-id <id>] [--preserved <p,...>]\n' +
      '                                 [--discarded <p,...>] [--discarded-summary <t>]\n' +
      '                                 [--pre-tokens <n>] [--post-tokens <n>]\n' +
      '                                 [--strategy <enum>]\n' +
      '                                 [--source-session-receipt <p>] [--parent-run-id <ULID>]\n' +
      '                                 OR --payload-file <p> --output <p> [...]\n',
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

// R2 review fix (Codex adversarial MEDIUM): identity-triplet check before
// using source's run_id as parent_run_id. Same pattern as emit-handoff.js.
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

function splitCsv(s) {
  if (typeof s !== 'string' || s.length === 0) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function buildPayloadFromFlags(args) {
  if (!args.trigger) usage('missing required flag --trigger (or --payload-file)');
  if (!VALID_TRIGGERS.has(args.trigger)) {
    process.stderr.write(
      `error: --trigger must be one of ${[...VALID_TRIGGERS].join(', ')}, got "${args.trigger}"\n`,
    );
    process.exit(1);
  }

  const payload = {
    schema_version: '1.0',
    compacted_at: new Date().toISOString(),
    trigger: args.trigger,
    preserved_artifact_paths: splitCsv(args.preserved),
  };
  if (args['session-id']) payload.session_id = args['session-id'];
  const discarded = splitCsv(args.discarded);
  if (discarded.length > 0) payload.discarded_artifact_paths = discarded;
  if (args['discarded-summary']) payload.discarded_summary = args['discarded-summary'];
  if (args['pre-tokens'] != null) {
    const n = Number.parseInt(args['pre-tokens'], 10);
    if (Number.isFinite(n) && n >= 0) payload.pre_compaction_tokens = n;
  }
  if (args['post-tokens'] != null) {
    const n = Number.parseInt(args['post-tokens'], 10);
    if (Number.isFinite(n) && n >= 0) payload.post_compaction_tokens = n;
  }
  if (args.strategy) {
    if (!VALID_STRATEGIES.has(args.strategy)) {
      process.stderr.write(
        `error: --strategy must be one of ${[...VALID_STRATEGIES].join(', ')}, got "${args.strategy}"\n`,
      );
      process.exit(1);
    }
    payload.compaction_strategy = args.strategy;
  }
  return payload;
}

function validateCompactionPayload(payload) {
  const errors = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload must be a non-null, non-array object');
    return errors;
  }
  for (const f of COMPACTION_REQUIRED) {
    if (!(f in payload)) errors.push(`payload missing required field "${f}"`);
  }
  if ('schema_version' in payload && payload.schema_version !== '1.0') {
    errors.push(
      `payload.schema_version must be "1.0", got ${JSON.stringify(payload.schema_version)}`,
    );
  }
  if ('trigger' in payload && !VALID_TRIGGERS.has(payload.trigger)) {
    errors.push(
      `payload.trigger must be one of ${[...VALID_TRIGGERS].join(', ')}, got ${JSON.stringify(payload.trigger)}`,
    );
  }
  if (
    'preserved_artifact_paths' in payload &&
    !Array.isArray(payload.preserved_artifact_paths)
  ) {
    errors.push('payload.preserved_artifact_paths must be array');
  }
  // R1 review C4: enforce compaction_strategy enum in --payload-file mode as
  // well. Previously buildPayloadFromFlags validated strategy at CLI level but
  // --payload-file path bypassed it; a SKILL-composed payload with typo could
  // pass through.
  if ('compaction_strategy' in payload && !VALID_STRATEGIES.has(payload.compaction_strategy)) {
    errors.push(
      `payload.compaction_strategy must be one of ${[...VALID_STRATEGIES].join(', ')}, ` +
        `got ${JSON.stringify(payload.compaction_strategy)}`,
    );
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
  if (!args.output) usage('missing required flag --output');

  let payload;
  if (args['payload-file']) {
    const p = path.resolve(process.cwd(), args['payload-file']);
    payload = readJson(p);
  } else {
    payload = buildPayloadFromFlags(args);
  }

  // R2 review fix (Codex review P3): propagate --session-id to payload.session_id
  // for --payload-file mode (buildPayloadFromFlags already handles this for the
  // CLI-flag path at line 198). Dashboard drill-down counts unique sessions
  // from payload.session_id.
  if (
    args['session-id'] &&
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    !payload.session_id
  ) {
    payload.session_id = args['session-id'];
  }

  const errors = validateCompactionPayload(payload);
  if (errors.length > 0) {
    process.stderr.write('compaction-state payload validation failed:\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  let parentRunId = args['parent-run-id'] || undefined;
  const sourceArtifacts = [];
  if (args['source-session-receipt']) {
    const srPath = path.resolve(process.cwd(), args['source-session-receipt']);
    // R2 review fix: require deep-work session-receipt envelope identity.
    const srRunId = tryReadEnvelopeRunId(srPath, [
      { producer: 'deep-work', kind: 'session-receipt' },
    ]);
    sourceArtifacts.push({
      path: args['source-session-receipt'],
      ...(srRunId ? { run_id: srRunId } : {}),
    });
    if (!parentRunId && srRunId) parentRunId = srRunId;
    // R1 review W1 (Opus W-1): stderr warn when --source-session-receipt is
    // provided but yields no run_id (file missing, corrupt, or non-envelope).
    if (!parentRunId && !srRunId && !args['parent-run-id']) {
      process.stderr.write(
        `warning: --source-session-receipt ${args['source-session-receipt']} is not a ` +
          `valid envelope (chain broken; suite.compaction.frequency lineage skipped)\n`,
      );
    }
  }

  let wrapped;
  try {
    wrapped = env.wrapEnvelope({
      artifactKind: 'compaction-state',
      payload,
      parentRunId,
      sessionId: args['session-id'] || undefined,
      sourceArtifacts,
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  const outputPath = path.resolve(process.cwd(), args.output);
  try {
    atomicWriteJson(outputPath, wrapped);
  } catch (err) {
    process.stderr.write(`error: cannot write ${outputPath}: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `emitted: ${outputPath} (run_id=${wrapped.envelope.run_id}, trigger=${payload.trigger})\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  COMPACTION_REQUIRED,
  VALID_TRIGGERS,
  VALID_STRATEGIES,
  validateCompactionPayload,
  buildPayloadFromFlags,
  tryReadEnvelopeRunId,
};
