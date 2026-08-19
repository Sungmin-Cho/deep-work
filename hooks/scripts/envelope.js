'use strict';

/**
 * envelope.js — Shared utilities for the M3 cross-plugin envelope
 * (cf. deep-suite/docs/envelope-migration.md §1).
 *
 * Zero-dep, CommonJS, runs from any cwd. All paths that reference plugin
 * assets (e.g. plugin.json) resolve relative to this module's __dirname,
 * NOT the caller's process.cwd() — see handoff §4 "literal-cwd-resolve".
 *
 * Exports:
 *   generateUlid(now?)              MSB-first Crockford Base32 26-char ULID
 *   detectGit(cwd?)                 git head/branch/dirty trio with safe fallback
 *   loadProducerVersion()           reads .claude-plugin/plugin.json relative to module
 *   wrapEnvelope(opts)              builds an envelope object (does not write)
 *   unwrapEnvelope(obj, p, kind)    returns payload (or input as-is for legacy);
 *                                   null if envelope-shaped but identity mismatches.
 *   isEnvelope(obj)                 boolean — strict M3 envelope shape detector
 *
 * Identity contract: producer === 'deep-work', artifact_kind ∈ {session-receipt,
 * slice-receipt, handoff, compaction-state}, schema.name === artifact_kind.
 * unwrapEnvelope() enforces all three (handoff §4 round-4 "envelope identity
 * guards"). 'handoff' and 'compaction-state' added in v6.6.0 for M5.7
 * cross-plugin long-run handoff + dashboard compaction telemetry; cf.
 * deep-suite/schemas/handoff.schema.json + compaction-state.schema.json.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const PLUGIN_NAME = 'deep-work';
const ALLOWED_ARTIFACT_KINDS = Object.freeze(
  new Set(['session-receipt', 'slice-receipt', 'handoff', 'compaction-state']),
);

// Crockford's Base32 alphabet (per ULID spec) — excludes I/L/O/U.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function generateUlid(now) {
  if (now === undefined) now = Date.now();
  // 48-bit timestamp ms (10 base32 chars) MSB-first + 80-bit randomness (16 base32 chars).
  let ts = now;
  const tsChars = new Array(10);
  for (let i = 9; i >= 0; i--) {
    tsChars[i] = CROCKFORD[ts % 32];
    ts = Math.floor(ts / 32);
  }
  const r = randomBytes(10);
  let rb = 0n;
  for (const b of r) rb = (rb << 8n) | BigInt(b);
  const randChars = new Array(16);
  for (let i = 15; i >= 0; i--) {
    randChars[i] = CROCKFORD[Number(rb & 31n)];
    rb >>= 5n;
  }
  return tsChars.join('') + randChars.join('');
}

function safeGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_err) {
    return null;
  }
}

function detectGit(cwd) {
  const repoCwd = cwd || process.cwd();
  const head = safeGit(['rev-parse', 'HEAD'], repoCwd);
  if (!head) {
    // Non-git directory or shallow CI clone failure — emit envelope-schema-valid
    // sentinel that's distinguishable from a real SHA (7-zero hex, dirty=unknown).
    return { head: '0000000', branch: 'HEAD', dirty: 'unknown' };
  }
  const branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoCwd);
  const status = safeGit(['status', '--porcelain'], repoCwd);
  return {
    head,
    branch: branch && branch !== 'HEAD' ? branch : 'HEAD',
    dirty: status == null ? 'unknown' : status.length > 0,
  };
}

function loadProducerVersion() {
  // Resolve relative to this module file, NOT the caller's cwd. LLM-driven
  // contexts may run helpers from arbitrary directories.
  const pluginJsonPath = path.resolve(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
  const raw = fs.readFileSync(pluginJsonPath, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj || typeof obj.version !== 'string' || obj.version.length === 0) {
    throw new Error(`plugin.json missing string "version" at ${pluginJsonPath}`);
  }
  return obj.version;
}

/**
 * Build an envelope object (does not write).
 *
 * opts:
 *   artifactKind     'session-receipt' | 'slice-receipt' (required)
 *   payload          plain object (required, non-null, non-array)
 *   parentRunId      optional ULID — cross-plugin chain (e.g. evolve-insights run_id)
 *   sessionId        optional higher-level session marker
 *   sourceArtifacts  optional array of { path, run_id? }
 *   toolVersions     optional object — defaults to { node: process.version }
 *   schemaVersion    optional payload schema MAJOR.MINOR — defaults to '1.0'
 *   git              optional override (otherwise detectGit())
 *   runId            optional ULID override (otherwise generateUlid())
 *   producerVersion  optional override (otherwise loadProducerVersion())
 *   generatedAt      optional RFC 3339 timestamp (otherwise new Date().toISOString())
 */
function wrapEnvelope(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('wrapEnvelope: opts must be an object');
  }
  const artifactKind = opts.artifactKind;
  if (!ALLOWED_ARTIFACT_KINDS.has(artifactKind)) {
    throw new Error(
      `wrapEnvelope: artifactKind must be one of ${[...ALLOWED_ARTIFACT_KINDS].join(', ')}, got ${JSON.stringify(artifactKind)}`,
    );
  }
  if (
    opts.payload === null ||
    typeof opts.payload !== 'object' ||
    Array.isArray(opts.payload)
  ) {
    throw new Error('wrapEnvelope: payload must be a non-null, non-array object');
  }

  const runId = opts.runId || generateUlid();
  if (!ULID_RE.test(runId)) {
    throw new Error(`wrapEnvelope: runId must be 26-char Crockford Base32 ULID, got ${JSON.stringify(runId)}`);
  }
  const producerVersion = opts.producerVersion || loadProducerVersion();
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const git = opts.git || detectGit();
  const schemaVersion = opts.schemaVersion || '1.0';

  const sourceArtifacts = Array.isArray(opts.sourceArtifacts)
    ? opts.sourceArtifacts
        .filter((sa) => sa && typeof sa === 'object' && !Array.isArray(sa))
        .map((sa) => {
          const item = { path: String(sa.path || '') };
          if (typeof sa.run_id === 'string' && sa.run_id.length > 0) {
            item.run_id = sa.run_id;
          }
          return item;
        })
        .filter((sa) => sa.path.length > 0)
    : [];

  const toolVersions =
    opts.toolVersions && typeof opts.toolVersions === 'object' && !Array.isArray(opts.toolVersions)
      ? opts.toolVersions
      : { node: process.version };

  const envelope = {
    producer: PLUGIN_NAME,
    producer_version: producerVersion,
    artifact_kind: artifactKind,
    run_id: runId,
    generated_at: generatedAt,
    schema: { name: artifactKind, version: schemaVersion },
    git: {
      head: git.head,
      branch: git.branch,
      dirty: git.dirty,
    },
    provenance: {
      source_artifacts: sourceArtifacts,
      tool_versions: toolVersions,
    },
  };
  if (typeof opts.sessionId === 'string' && opts.sessionId.length > 0) {
    envelope.session_id = opts.sessionId;
  }
  if (typeof opts.parentRunId === 'string' && opts.parentRunId.length > 0) {
    envelope.parent_run_id = opts.parentRunId;
  }

  return {
    $schema: 'https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json',
    schema_version: '1.0',
    envelope,
    payload: opts.payload,
  };
}

/**
 * M3 envelope shape detector (loose).
 *
 * Returns true for {schema_version: "1.0", envelope: {...}, payload: <any>} —
 * structural detection only. Does NOT validate envelope contents OR payload
 * shape. Use `unwrapEnvelope()` for full identity + corrupt-payload checks,
 * or use the stricter `isValidEnvelope()` when consumers also need payload
 * to be a non-null/non-array object.
 *
 * Defends against legacy v1.0 receipts whose top-level `schema_version: "1.0"`
 * collides with envelope's `schema_version: "1.0"`: the legacy form lacks
 * `envelope` + `payload` keys, so this returns false. unwrapEnvelope()
 * preserves this same loose-detection contract — an envelope-shaped object
 * with corrupt payload is detected here, then rejected (null) by the
 * unwrapper rather than mis-classified as legacy.
 */
function isEnvelope(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.schema_version !== '1.0') return false;
  if (!obj.envelope || typeof obj.envelope !== 'object' || Array.isArray(obj.envelope)) return false;
  if (obj.payload === undefined) return false;
  return true;
}

/**
 * Strict M3 envelope detector — adds the payload-shape gate on top of
 * `isEnvelope`. Returns true only when payload is itself a non-null,
 * non-array object (round-1 deep-review W4 lesson). Use this when extracting
 * sub-fields like `envelope.run_id` from a chain-source artifact, where a
 * corrupt envelope must not contribute trace data downstream.
 */
function isValidEnvelope(obj) {
  if (!isEnvelope(obj)) return false;
  return obj.payload !== null && typeof obj.payload === 'object' && !Array.isArray(obj.payload);
}

/**
 * Unwrap envelope and verify identity. Three modes:
 *
 *   - Legacy (non-envelope) input → returns input unchanged. Caller must handle.
 *   - Envelope with identity match → returns payload (object).
 *   - Envelope with identity mismatch → returns null + stderr warning.
 *   - Envelope with corrupt payload (null/array/non-object) → returns null + warn.
 *
 * Identity is checked on producer === 'deep-work', artifact_kind === expectedKind,
 * schema.name === expectedKind. handoff §4 round-4 lesson.
 */
function unwrapEnvelope(obj, expectedKind) {
  if (!isEnvelope(obj)) return obj;
  if (!ALLOWED_ARTIFACT_KINDS.has(expectedKind)) {
    throw new Error(
      `unwrapEnvelope: expectedKind must be one of ${[...ALLOWED_ARTIFACT_KINDS].join(', ')}, got ${JSON.stringify(expectedKind)}`,
    );
  }
  const env = obj.envelope;
  const id = {
    producer: env && env.producer,
    artifact_kind: env && env.artifact_kind,
    schema_name: env && env.schema && env.schema.name,
  };
  if (
    id.producer !== PLUGIN_NAME ||
    id.artifact_kind !== expectedKind ||
    id.schema_name !== expectedKind
  ) {
    process.stderr.write(
      `[deep-work/envelope] identity mismatch: expected producer=${PLUGIN_NAME} kind=${expectedKind}, got ${JSON.stringify(id)}\n`,
    );
    return null;
  }
  const payload = obj.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    // Round-5/7 lesson: corrupt-payload defense — non-object payload must not
    // pass through silently.
    process.stderr.write(
      `[deep-work/envelope] corrupt payload: expected object, got ${
        Array.isArray(payload) ? 'array' : typeof payload
      }\n`,
    );
    return null;
  }
  return payload;
}

module.exports = {
  PLUGIN_NAME,
  ALLOWED_ARTIFACT_KINDS,
  ULID_RE,
  generateUlid,
  detectGit,
  loadProducerVersion,
  wrapEnvelope,
  isEnvelope,
  isValidEnvelope,
  unwrapEnvelope,
};
