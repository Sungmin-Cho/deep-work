#!/usr/bin/env node
'use strict';

/**
 * validate-envelope-emit.js — Self-test validator for deep-work's M3 envelope
 * emission. Mirrors the suite-side schema (deep-suite/schemas/
 * artifact-envelope.schema.json) without external deps so this works as a
 * release-lint inside the deep-work plugin's own CI/test pipeline.
 *
 * Validates:
 *   - Top-level shape (schema_version === '1.0', envelope object, payload object).
 *   - additionalProperties:false on root, envelope, git, schema, provenance,
 *     source_artifacts items (root + envelope allow `^x-` prefixed keys).
 *   - producer === 'deep-work' (plugin identity).
 *   - artifact_kind === schema.name (envelope identity guard — round-4 lesson).
 *   - artifact_kind ∈ {session-receipt, slice-receipt}.
 *   - run_id is 26-char Crockford Base32 ULID.
 *   - parent_run_id (if present) is 26-char ULID.
 *   - producer_version is SemVer 2.0.0 strict.
 *   - generated_at is RFC 3339.
 *   - git.head matches /^[a-f0-9]{7,40}$/, git.dirty ∈ {true,false,'unknown'}.
 *   - provenance.source_artifacts[].path non-empty, run_id (if present) is ULID.
 *   - provenance.tool_versions container is object (not array).
 *   - provenance.tool_versions values are string OR (object && !array).
 *   - payload is non-null, non-array object.
 *   - payload.schema_version === '1.0' (preserved field from legacy receipts).
 *
 * Usage:
 *   node validate-envelope-emit.js <file.json> [<file2.json> ...]
 *
 * Exit codes:
 *   0 — all valid
 *   1 — at least one validation error
 *   2 — usage / IO error
 */

const fs = require('node:fs');
const path = require('node:path');

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// Official SemVer 2.0.0 regex (semver.org).
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const GIT_HEAD_RE = /^[a-f0-9]{7,40}$/;
const SCHEMA_VERSION_RE = /^\d+\.\d+$/;

const PLUGIN_NAME = 'deep-work';
// 'handoff' and 'compaction-state' added in v6.6.0 (M5.7 cross-plugin long-run
// handoff + dashboard compaction telemetry). Schemas live in deep-suite/
// schemas/{handoff,compaction-state}.schema.json.
const ALLOWED_KINDS = new Set([
  'session-receipt',
  'slice-receipt',
  'handoff',
  'compaction-state',
]);

const ROOT_KEYS = new Set(['$schema', 'schema_version', 'envelope', 'payload']);
const ENVELOPE_KEYS = new Set([
  'producer', 'producer_version', 'artifact_kind', 'run_id', 'session_id',
  'parent_run_id', 'generated_at', 'schema', 'git', 'provenance',
]);
const ENVELOPE_REQUIRED = [
  'producer', 'producer_version', 'artifact_kind', 'run_id', 'generated_at',
  'schema', 'git', 'provenance',
];
const SCHEMA_KEYS = new Set(['name', 'version']);
const GIT_KEYS = new Set(['head', 'branch', 'worktree', 'dirty']);
const GIT_REQUIRED = ['head', 'branch', 'dirty'];
const PROVENANCE_KEYS = new Set(['source_artifacts', 'tool_versions']);
const SOURCE_ARTIFACT_KEYS = new Set(['path', 'run_id']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkAdditionalProps(obj, allowed, label, errors, allowXPrefix) {
  for (const k of Object.keys(obj)) {
    if (allowed.has(k)) continue;
    if (allowXPrefix && k.startsWith('x-')) continue;
    errors.push(`${label}: unknown key "${k}"`);
  }
}

function validateGit(git, errors) {
  if (!isPlainObject(git)) {
    errors.push('envelope.git: must be an object');
    return;
  }
  for (const r of GIT_REQUIRED) {
    if (!(r in git)) errors.push(`envelope.git: missing required key "${r}"`);
  }
  checkAdditionalProps(git, GIT_KEYS, 'envelope.git', errors, false);
  if (typeof git.head === 'string' && !GIT_HEAD_RE.test(git.head)) {
    errors.push(`envelope.git.head: must match /^[a-f0-9]{7,40}$/, got "${git.head}"`);
  }
  if (typeof git.branch !== 'string' || git.branch.length === 0) {
    errors.push('envelope.git.branch: must be non-empty string');
  }
  if (
    typeof git.dirty !== 'boolean' &&
    git.dirty !== 'unknown'
  ) {
    errors.push(`envelope.git.dirty: must be boolean or "unknown", got ${JSON.stringify(git.dirty)}`);
  }
  if ('worktree' in git && typeof git.worktree !== 'string') {
    errors.push('envelope.git.worktree: if present, must be string');
  }
}

function validateSchemaBlock(schema, artifactKind, errors) {
  if (!isPlainObject(schema)) {
    errors.push('envelope.schema: must be an object');
    return;
  }
  checkAdditionalProps(schema, SCHEMA_KEYS, 'envelope.schema', errors, false);
  if (typeof schema.name !== 'string' || schema.name.length === 0) {
    errors.push('envelope.schema.name: must be non-empty string');
  }
  if (typeof schema.version !== 'string' || !SCHEMA_VERSION_RE.test(schema.version)) {
    errors.push(`envelope.schema.version: must match /^\\d+\\.\\d+$/, got ${JSON.stringify(schema.version)}`);
  }
  // Identity check (round-4 lesson).
  if (schema.name !== artifactKind) {
    errors.push(
      `envelope.schema.name (${JSON.stringify(schema.name)}) must equal envelope.artifact_kind (${JSON.stringify(artifactKind)})`,
    );
  }
}

function validateProvenance(prov, errors) {
  if (!isPlainObject(prov)) {
    errors.push('envelope.provenance: must be an object');
    return;
  }
  for (const r of ['source_artifacts', 'tool_versions']) {
    if (!(r in prov)) errors.push(`envelope.provenance: missing required key "${r}"`);
  }
  checkAdditionalProps(prov, PROVENANCE_KEYS, 'envelope.provenance', errors, false);

  if ('source_artifacts' in prov) {
    if (!Array.isArray(prov.source_artifacts)) {
      errors.push('envelope.provenance.source_artifacts: must be array');
    } else {
      prov.source_artifacts.forEach((sa, idx) => {
        if (!isPlainObject(sa)) {
          errors.push(`envelope.provenance.source_artifacts[${idx}]: must be object`);
          return;
        }
        checkAdditionalProps(sa, SOURCE_ARTIFACT_KEYS, `envelope.provenance.source_artifacts[${idx}]`, errors, false);
        if (typeof sa.path !== 'string' || sa.path.length === 0) {
          errors.push(`envelope.provenance.source_artifacts[${idx}].path: must be non-empty string`);
        }
        if ('run_id' in sa && typeof sa.run_id !== 'string') {
          errors.push(`envelope.provenance.source_artifacts[${idx}].run_id: must be string`);
        }
      });
    }
  }

  if ('tool_versions' in prov) {
    // JS gotcha: `typeof [] === 'object'`. Guard with Array.isArray() (handoff §4 round-3).
    if (!isPlainObject(prov.tool_versions)) {
      errors.push('envelope.provenance.tool_versions: must be object (not array)');
    } else {
      for (const [k, v] of Object.entries(prov.tool_versions)) {
        const isString = typeof v === 'string';
        const isObject = isPlainObject(v);
        if (!isString && !isObject) {
          errors.push(
            `envelope.provenance.tool_versions[${JSON.stringify(k)}]: must be string or object, got ${
              Array.isArray(v) ? 'array' : typeof v
            }`,
          );
        }
      }
    }
  }
}

function validateEnvelopeBlock(env, errors) {
  if (!isPlainObject(env)) {
    errors.push('envelope: must be an object');
    return;
  }
  for (const r of ENVELOPE_REQUIRED) {
    if (!(r in env)) errors.push(`envelope: missing required key "${r}"`);
  }
  checkAdditionalProps(env, ENVELOPE_KEYS, 'envelope', errors, true);

  if (env.producer !== PLUGIN_NAME) {
    errors.push(`envelope.producer: must be "${PLUGIN_NAME}", got ${JSON.stringify(env.producer)}`);
  }
  if (typeof env.producer_version !== 'string' || !SEMVER_RE.test(env.producer_version)) {
    errors.push(`envelope.producer_version: must be SemVer 2.0.0, got ${JSON.stringify(env.producer_version)}`);
  }
  if (typeof env.artifact_kind !== 'string' || !KEBAB_RE.test(env.artifact_kind)) {
    errors.push(`envelope.artifact_kind: must be kebab-case, got ${JSON.stringify(env.artifact_kind)}`);
  } else if (!ALLOWED_KINDS.has(env.artifact_kind)) {
    errors.push(
      `envelope.artifact_kind: must be one of ${[...ALLOWED_KINDS].join(', ')}, got ${JSON.stringify(env.artifact_kind)}`,
    );
  }
  if (typeof env.run_id !== 'string' || !ULID_RE.test(env.run_id)) {
    errors.push(`envelope.run_id: must be 26-char Crockford Base32 ULID, got ${JSON.stringify(env.run_id)}`);
  }
  if ('parent_run_id' in env) {
    if (typeof env.parent_run_id !== 'string' || !ULID_RE.test(env.parent_run_id)) {
      errors.push(
        `envelope.parent_run_id: if present, must be 26-char ULID, got ${JSON.stringify(env.parent_run_id)}`,
      );
    }
  }
  if ('session_id' in env && typeof env.session_id !== 'string') {
    errors.push('envelope.session_id: if present, must be string');
  }
  if (typeof env.generated_at !== 'string' || !RFC3339_RE.test(env.generated_at)) {
    errors.push(`envelope.generated_at: must be RFC 3339, got ${JSON.stringify(env.generated_at)}`);
  }
  validateSchemaBlock(env.schema, env.artifact_kind, errors);
  validateGit(env.git, errors);
  validateProvenance(env.provenance, errors);
}

function validateRoot(obj, errors) {
  if (!isPlainObject(obj)) {
    errors.push('root: must be an object');
    return;
  }
  for (const r of ['schema_version', 'envelope', 'payload']) {
    if (!(r in obj)) errors.push(`root: missing required key "${r}"`);
  }
  checkAdditionalProps(obj, ROOT_KEYS, 'root', errors, true);
  if (obj.schema_version !== '1.0') {
    errors.push(`root.schema_version: must be "1.0", got ${JSON.stringify(obj.schema_version)}`);
  }
  validateEnvelopeBlock(obj.envelope, errors);

  // Payload shape: minimal — non-null, non-array object. Domain-specific
  // payload schema lives in deep-suite payload-registry (Phase 3).
  if (obj.payload === null || typeof obj.payload !== 'object' || Array.isArray(obj.payload)) {
    errors.push('payload: must be a non-null, non-array object');
  }
  // Preserve legacy contract: payload retains its own schema_version === '1.0'.
  if (isPlainObject(obj.payload) && obj.payload.schema_version !== '1.0') {
    errors.push(`payload.schema_version: must be "1.0", got ${JSON.stringify(obj.payload.schema_version)}`);
  }
}

function validate(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, errors: [`cannot read ${filePath}: ${err.message}`], ioError: true };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`cannot parse ${filePath}: ${err.message}`] };
  }
  const errors = [];
  validateRoot(obj, errors);
  return { ok: errors.length === 0, errors };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stderr.write('usage: validate-envelope-emit.js <file.json> [<file2.json> ...]\n');
    process.exit(2);
  }
  let allOk = true;
  for (const a of argv) {
    const filePath = path.resolve(process.cwd(), a);
    const r = validate(filePath);
    if (r.ok) {
      process.stdout.write(`OK   ${a}\n`);
    } else {
      allOk = false;
      process.stdout.write(`FAIL ${a}\n`);
      for (const e of r.errors) {
        process.stdout.write(`  - ${e}\n`);
      }
      if (r.ioError) {
        process.exit(2);
      }
    }
  }
  process.exit(allOk ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { validate, validateRoot, ULID_RE, SEMVER_RE, RFC3339_RE };
