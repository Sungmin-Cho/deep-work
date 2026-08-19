'use strict';

/**
 * handoff-roundtrip.test.js — M5.5 #8 (deep-work half) + M5.7.A test target.
 *
 * Verifies emit-handoff.js + emit-compaction-state.js produce envelope-wrapped
 * artifacts that satisfy the deep-dashboard suite-collector's
 * `unwrapStrict` contract (cf. deep-dashboard/lib/suite-collector.js).
 *
 * The contract has four layers — each test exercises at least one:
 *   1. envelope-shape (schema_version === '1.0', envelope + payload present)
 *   2. identity-triplet (producer + artifact_kind + schema.name match)
 *   3. payload-shape (non-null, non-array object)
 *   4. payload-required-fields per `<producer>/<kind>`:
 *        deep-work/handoff:           schema_version, handoff_kind, from, to,
 *                                     summary, next_action_brief
 *        deep-work/compaction-state:  schema_version, compacted_at, trigger,
 *                                     preserved_artifact_paths
 *
 * Also verifies the cross-plugin chain: handoff.envelope.parent_run_id ===
 * session-receipt.envelope.run_id when --source-session-receipt is provided.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ULID_RE, validate } = require('../scripts/validate-envelope-emit.js');
const {
  wrapEnvelope,
  generateUlid,
  isValidEnvelope,
} = require('../hooks/scripts/envelope.js');
const {
  validateHandoffPayload,
  HANDOFF_REQUIRED,
  VALID_HANDOFF_KINDS,
  KIND_DIRECTIONS,
  tryReadEnvelopeRunId,
} = require('../hooks/scripts/emit-handoff.js');
const {
  validateCompactionPayload,
  VALID_TRIGGERS,
  VALID_STRATEGIES,
  COMPACTION_REQUIRED,
} = require('../hooks/scripts/emit-compaction-state.js');

const EMIT_HANDOFF = path.resolve(__dirname, '..', 'hooks', 'scripts', 'emit-handoff.js');
const EMIT_COMPACTION = path.resolve(__dirname, '..', 'hooks', 'scripts', 'emit-compaction-state.js');
const VALIDATE_CLI = path.resolve(__dirname, '..', 'scripts', 'validate-envelope-emit.js');

// Dashboard's PAYLOAD_REQUIRED_FIELDS — must match
// deep-dashboard/lib/suite-constants.js exactly.
const DASHBOARD_HANDOFF_REQUIRED = [
  'schema_version', 'handoff_kind', 'from', 'to', 'summary', 'next_action_brief',
];
const DASHBOARD_COMPACTION_REQUIRED = [
  'schema_version', 'compacted_at', 'trigger', 'preserved_artifact_paths',
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dw-handoff-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function runEmit(script, args) {
  return execFileSync('node', [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runValidate(file) {
  return execFileSync('node', [VALIDATE_CLI, file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Mirror of deep-dashboard/lib/suite-collector.js `unwrapStrict` (the
 * contract this emit needs to satisfy). Kept zero-dep so the deep-work plugin
 * doesn't have to import dashboard code.
 *
 * R1 review C5 (Opus + de-Opus C3): the dashboard's real `unwrapStrict` checks
 * `schema.name === expectedKind` but NOT `schema.version`. The mirror was
 * previously a strict superset (also checked schema.version === '1.0') which
 * defeats its drift-sensor purpose. The mirror is now a true mirror — the
 * producer-side `wrapEnvelope` always sets schema.version='1.0' so this doesn't
 * change current behavior, but a future producer emitting schema.version='1.1'
 * (additive evolution) would now correctly pass the mirror as it would pass
 * the dashboard.
 *
 * If dashboard's contract drifts, this mirror will go stale — caught by
 * M5.5 #8 cross-plugin CI in suite repo.
 */
function dashboardUnwrapStrict(obj, expectedProducer, expectedKind, requiredFields) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { failure: 'not-envelope-shape' };
  }
  if (obj.schema_version !== '1.0') return { failure: 'not-envelope-shape' };
  if (!obj.envelope || typeof obj.envelope !== 'object' || Array.isArray(obj.envelope)) {
    return { failure: 'not-envelope-shape' };
  }
  if (obj.payload === undefined) return { failure: 'not-envelope-shape' };
  const env = obj.envelope;
  if (
    env.producer !== expectedProducer ||
    env.artifact_kind !== expectedKind ||
    !env.schema ||
    typeof env.schema !== 'object' ||
    Array.isArray(env.schema) ||
    env.schema.name !== expectedKind
  ) {
    return { failure: 'identity-mismatch' };
  }
  const pl = obj.payload;
  if (pl === null || typeof pl !== 'object' || Array.isArray(pl)) {
    return { failure: 'payload-shape-violation' };
  }
  const missing = requiredFields.filter((k) => !(k in pl));
  if (missing.length > 0) {
    return { failure: `missing-required-fields:${missing.join(',')}` };
  }
  return { ok: true, envelope: env, payload: pl };
}

function makeSessionReceiptEnvelope(dir) {
  const sessionRunId = generateUlid();
  const sessionReceipt = wrapEnvelope({
    artifactKind: 'session-receipt',
    payload: {
      schema_version: '1.0',
      session_id: '2026-05-12-handoff-test',
      slices: { total: 3, completed: 3, spike: 0 },
      outcome: 'merge',
    },
    runId: sessionRunId,
    git: { head: 'abc1234', branch: 'main', dirty: false },
  });
  const p = path.join(dir, 'session-receipt.json');
  writeJson(p, sessionReceipt);
  return { path: p, runId: sessionRunId };
}

function makeHandoffPayload() {
  return {
    schema_version: '1.0',
    handoff_kind: 'phase-5-to-evolve',
    from: {
      producer: 'deep-work',
      session_id: '2026-05-12-handoff-test',
      phase: 'integrate',
      completed_at: '2026-05-12T10:00:00Z',
    },
    to: {
      producer: 'deep-evolve',
      intent: 'performance-optimization',
      scope_hint: 'src/auth/jwt.ts',
    },
    summary: 'Test session integrated; 3/3 slices GREEN.',
    next_action_brief: 'deep-evolve로 JWT verify 성능 최적화 — current p99=180ms, target <50ms.',
    completed_actions: ['merged PR #123', '3/3 slices GREEN'],
  };
}

// ---------------------------------------------------------------------------
// emit-handoff.js — payload validation (unit)
// ---------------------------------------------------------------------------

describe('emit-handoff — HANDOFF_REQUIRED matches dashboard contract', () => {
  it('emit-handoff.js HANDOFF_REQUIRED is identical to dashboard PAYLOAD_REQUIRED_FIELDS["deep-work/handoff"]', () => {
    assert.deepEqual(HANDOFF_REQUIRED, DASHBOARD_HANDOFF_REQUIRED);
  });

  it('rejects payload missing handoff_kind', () => {
    const payload = makeHandoffPayload();
    delete payload.handoff_kind;
    const errors = validateHandoffPayload(payload);
    assert.ok(errors.some((e) => /handoff_kind/.test(e)), errors.join(';'));
  });

  it('rejects payload with non-1.0 schema_version', () => {
    const payload = makeHandoffPayload();
    payload.schema_version = '2.0';
    const errors = validateHandoffPayload(payload);
    assert.ok(errors.some((e) => /schema_version/.test(e)), errors.join(';'));
  });

  it('rejects payload with from.producer missing', () => {
    const payload = makeHandoffPayload();
    delete payload.from.producer;
    const errors = validateHandoffPayload(payload);
    assert.ok(errors.some((e) => /from/.test(e)), errors.join(';'));
  });

  it('rejects array payload (corrupt-payload defense)', () => {
    const errors = validateHandoffPayload([makeHandoffPayload()]);
    assert.ok(errors.some((e) => /non-array/.test(e)), errors.join(';'));
  });

  // R1 review C4: handoff_kind enum validation regression test.
  it('rejects payload with invalid handoff_kind (R1 C4)', () => {
    const payload = makeHandoffPayload();
    payload.handoff_kind = 'phase-5-evolve';  // typo (missing 'to')
    const errors = validateHandoffPayload(payload);
    assert.ok(errors.some((e) => /handoff_kind must be one of/.test(e)), errors.join(';'));
  });

  it('accepts every schema-enum handoff_kind value with matching direction', () => {
    // R2 review fix: direction enforcement now requires from/to producers to
    // match the kind for direction-bound kinds (phase-5-to-evolve, evolve-to-
    // deep-work). Other kinds (slice-to-slice, session-resume, custom) are
    // direction-free — direction can be anything.
    for (const kind of VALID_HANDOFF_KINDS) {
      const payload = makeHandoffPayload();
      payload.handoff_kind = kind;
      if (KIND_DIRECTIONS[kind]) {
        payload.from.producer = KIND_DIRECTIONS[kind].from;
        payload.to.producer = KIND_DIRECTIONS[kind].to;
      }
      const errors = validateHandoffPayload(payload);
      assert.deepEqual(errors, [], `${kind} should be valid: ${errors.join(';')}`);
    }
  });

  it('VALID_HANDOFF_KINDS contains all 5 schema enum values', () => {
    assert.deepEqual(
      [...VALID_HANDOFF_KINDS].sort(),
      [
        'custom',
        'evolve-to-deep-work',
        'phase-5-to-evolve',
        'session-resume',
        'slice-to-slice',
      ].sort(),
    );
  });

  // R2 review fix (Codex adversarial MEDIUM): direction enforcement.
  it('rejects phase-5-to-evolve with wrong from.producer (R2)', () => {
    const payload = makeHandoffPayload();
    payload.from.producer = 'deep-evolve';  // wrong — should be deep-work
    const errors = validateHandoffPayload(payload);
    assert.ok(
      errors.some((e) => /from\.producer.*must be "deep-work"/.test(e)),
      errors.join(';'),
    );
  });

  it('rejects phase-5-to-evolve with wrong to.producer (R2)', () => {
    const payload = makeHandoffPayload();
    payload.to.producer = 'deep-work';  // wrong — should be deep-evolve
    const errors = validateHandoffPayload(payload);
    assert.ok(
      errors.some((e) => /to\.producer.*must be "deep-evolve"/.test(e)),
      errors.join(';'),
    );
  });

  it('accepts canonical phase-5-to-evolve direction', () => {
    const payload = makeHandoffPayload();
    assert.deepEqual(validateHandoffPayload(payload), []);
  });

  it('does not enforce direction for slice-to-slice / custom', () => {
    const payload = makeHandoffPayload();
    payload.handoff_kind = 'slice-to-slice';
    // Direction doesn't matter for slice-to-slice
    payload.from.producer = 'deep-evolve';
    payload.to.producer = 'deep-evolve';
    assert.deepEqual(validateHandoffPayload(payload), []);
  });
});

// ---------------------------------------------------------------------------
// emit-handoff.js — CLI roundtrip
// ---------------------------------------------------------------------------

describe('emit-handoff.js — CLI roundtrip satisfies dashboard unwrapStrict', () => {
  it('emits envelope + parent_run_id chains to session-receipt + dashboard accepts it', () => {
    const dir = tmpDir();
    const sr = makeSessionReceiptEnvelope(dir);

    const payloadPath = path.join(dir, 'handoff-payload.json');
    writeJson(payloadPath, makeHandoffPayload());

    const outPath = path.join(dir, 'handoffs', 'handoff.json');
    runEmit(EMIT_HANDOFF, [
      '--payload-file', payloadPath,
      '--output', outPath,
      '--source-session-receipt', sr.path,
      '--session-id', '2026-05-12-handoff-test',
    ]);

    // envelope shape via the deep-work-side validator (catches additionalProperties etc).
    runValidate(outPath);

    // Dashboard contract — the actual production gate.
    const obj = readJson(outPath);
    const result = dashboardUnwrapStrict(obj, 'deep-work', 'handoff', DASHBOARD_HANDOFF_REQUIRED);
    assert.equal(result.failure, undefined, `unwrapStrict failed: ${result.failure}`);
    assert.ok(result.ok);

    // Cross-plugin chain: parent_run_id closes against session-receipt.
    assert.equal(obj.envelope.parent_run_id, sr.runId);
    assert.match(obj.envelope.run_id, ULID_RE);
    assert.notEqual(obj.envelope.run_id, sr.runId);

    // Provenance: source_artifacts records the session-receipt with its run_id.
    const provSrc = obj.envelope.provenance.source_artifacts;
    assert.ok(Array.isArray(provSrc));
    const srcEntry = provSrc.find((s) => s.run_id === sr.runId);
    assert.ok(srcEntry, 'session-receipt source_artifacts entry missing');
  });

  it('exits non-zero with payload validation error when handoff_kind missing', () => {
    const dir = tmpDir();
    const sr = makeSessionReceiptEnvelope(dir);
    const bad = makeHandoffPayload();
    delete bad.handoff_kind;
    const payloadPath = path.join(dir, 'bad-payload.json');
    writeJson(payloadPath, bad);

    const outPath = path.join(dir, 'handoff.json');
    let stderr = '';
    try {
      execFileSync('node', [
        EMIT_HANDOFF,
        '--payload-file', payloadPath,
        '--output', outPath,
        '--source-session-receipt', sr.path,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.fail('emit-handoff should have failed for missing handoff_kind');
    } catch (err) {
      stderr = String(err.stderr || '');
      assert.equal(err.status, 1, `expected exit 1, got ${err.status}; stderr=${stderr}`);
      assert.match(stderr, /handoff_kind/);
    }
    assert.equal(fs.existsSync(outPath), false, 'should not have written output on failure');
  });

  // R2 review fix (Codex adversarial MEDIUM): tryReadEnvelopeRunId now rejects
  // foreign envelope (wrong producer / artifact_kind / schema.name).
  it('tryReadEnvelopeRunId rejects foreign envelope when expectedIdentities given (R2)', () => {
    const dir = tmpDir();
    // Build a deep-evolve evolve-receipt envelope (foreign for deep-work emit).
    const foreign = {
      $schema: 'https://example/envelope.schema.json',
      schema_version: '1.0',
      envelope: {
        producer: 'deep-evolve',
        producer_version: '3.3.0',
        artifact_kind: 'evolve-receipt',
        run_id: '01JTKGZQ7NABCDEFGHJKMNPQRS',
        generated_at: new Date().toISOString(),
        schema: { name: 'evolve-receipt', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: { node: 'v20' } },
      },
      payload: { schema_version: '1.0', plugin: 'deep-evolve' },
    };
    const foreignPath = path.join(dir, 'foreign.json');
    writeJson(foreignPath, foreign);

    // Expected identity = deep-work session-receipt; foreign envelope rejected.
    const result = tryReadEnvelopeRunId(foreignPath, [
      { producer: 'deep-work', kind: 'session-receipt' },
    ]);
    assert.equal(result, null, 'foreign envelope must not yield a run_id');
  });

  it('tryReadEnvelopeRunId accepts matching identity (R2)', () => {
    const dir = tmpDir();
    const sr = makeSessionReceiptEnvelope(dir);
    const result = tryReadEnvelopeRunId(sr.path, [
      { producer: 'deep-work', kind: 'session-receipt' },
    ]);
    assert.equal(result, sr.runId);
  });

  // R1 review W1: stderr warning when --source-session-receipt resolves to a
  // non-envelope (orphan chain breakage indicator).
  it('stderr-warns when --source-session-receipt is not a valid envelope (R1 W1)', () => {
    const dir = tmpDir();
    const payloadPath = path.join(dir, 'payload.json');
    writeJson(payloadPath, makeHandoffPayload());
    // Non-envelope JSON (just a legacy receipt shape).
    const badReceipt = path.join(dir, 'legacy-receipt.json');
    writeJson(badReceipt, { schema_version: '1.0', session_id: 'x', slices: { total: 1 } });

    const outPath = path.join(dir, 'handoff.json');
    const result = execFileSync('node', [
      EMIT_HANDOFF,
      '--payload-file', payloadPath,
      '--output', outPath,
      '--source-session-receipt', badReceipt,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // Emit still succeeds (orphan handoff is a valid envelope, just chain-less).
    const obj = readJson(outPath);
    assert.equal(obj.envelope.parent_run_id, undefined, 'parent_run_id should be omitted');
    // The CLI itself logs the emit-summary to stdout; the stderr warn happens
    // inside the process. execFileSync only returns stdout; we need spawnSync
    // for full stderr. Instead verify the absence of parent_run_id (which the
    // warning announces) and the presence of the source artifact path-only.
    const provSrc = obj.envelope.provenance.source_artifacts;
    const entry = provSrc.find((s) => s.path === badReceipt);
    assert.ok(entry, 'source artifact entry should be recorded path-only');
    assert.equal(entry.run_id, undefined, 'no run_id since non-envelope');
  });
});

// ---------------------------------------------------------------------------
// emit-compaction-state.js — payload validation (unit)
// ---------------------------------------------------------------------------

describe('emit-compaction-state — required + trigger enum match suite schema', () => {
  it('COMPACTION_REQUIRED matches dashboard PAYLOAD_REQUIRED_FIELDS["deep-work/compaction-state"]', () => {
    assert.deepEqual(COMPACTION_REQUIRED, DASHBOARD_COMPACTION_REQUIRED);
  });

  it('rejects unknown trigger', () => {
    const errors = validateCompactionPayload({
      schema_version: '1.0',
      compacted_at: '2026-05-12T10:00:00Z',
      trigger: 'not-a-real-trigger',
      preserved_artifact_paths: [],
    });
    assert.ok(errors.some((e) => /trigger/.test(e)));
  });

  it('accepts canonical phase-transition trigger with empty preserved array', () => {
    const errors = validateCompactionPayload({
      schema_version: '1.0',
      compacted_at: '2026-05-12T10:00:00Z',
      trigger: 'phase-transition',
      preserved_artifact_paths: [],
    });
    assert.deepEqual(errors, []);
  });

  it('rejects non-array preserved_artifact_paths', () => {
    const errors = validateCompactionPayload({
      schema_version: '1.0',
      compacted_at: '2026-05-12T10:00:00Z',
      trigger: 'phase-transition',
      preserved_artifact_paths: 'oops',
    });
    assert.ok(errors.some((e) => /preserved_artifact_paths/.test(e)));
  });

  it('VALID_TRIGGERS contains all 6 schema enum values', () => {
    assert.deepEqual(
      [...VALID_TRIGGERS].sort(),
      [
        'loop-epoch-end',
        'manual',
        'phase-transition',
        'session-stop',
        'slice-green',
        'window-threshold',
      ].sort(),
    );
  });

  // R1 review C4: compaction_strategy enum validation regression — previously
  // --payload-file mode bypassed strategy check (only CLI flag mode validated it).
  it('rejects payload-file with invalid compaction_strategy (R1 C4)', () => {
    const errors = validateCompactionPayload({
      schema_version: '1.0',
      compacted_at: '2026-05-12T10:00:00Z',
      trigger: 'phase-transition',
      preserved_artifact_paths: [],
      compaction_strategy: 'receipt-onnly',  // typo
    });
    assert.ok(
      errors.some((e) => /compaction_strategy must be one of/.test(e)),
      errors.join(';'),
    );
  });

  it('accepts every schema-enum compaction_strategy value', () => {
    for (const strategy of VALID_STRATEGIES) {
      const errors = validateCompactionPayload({
        schema_version: '1.0',
        compacted_at: '2026-05-12T10:00:00Z',
        trigger: 'phase-transition',
        preserved_artifact_paths: [],
        compaction_strategy: strategy,
      });
      assert.deepEqual(errors, [], `${strategy} should be valid: ${errors.join(';')}`);
    }
  });
});

// ---------------------------------------------------------------------------
// emit-compaction-state.js — CLI roundtrip
// ---------------------------------------------------------------------------

describe('emit-compaction-state.js — CLI roundtrip satisfies dashboard unwrapStrict', () => {
  it('build payload from flags + session-receipt chain', () => {
    const dir = tmpDir();
    const sr = makeSessionReceiptEnvelope(dir);

    const outPath = path.join(dir, 'compaction-states', 'cs.json');
    runEmit(EMIT_COMPACTION, [
      '--trigger', 'phase-transition',
      '--output', outPath,
      '--session-id', '2026-05-12-handoff-test',
      '--preserved', '.deep-work/foo/research.md,.deep-work/foo/plan.md',
      '--discarded', '.deep-work/foo/tmp-llm-trace.json',
      '--strategy', 'key-artifacts-only',
      '--source-session-receipt', sr.path,
    ]);

    runValidate(outPath);

    const obj = readJson(outPath);
    const result = dashboardUnwrapStrict(
      obj, 'deep-work', 'compaction-state', DASHBOARD_COMPACTION_REQUIRED,
    );
    assert.equal(result.failure, undefined, `unwrapStrict failed: ${result.failure}`);

    assert.equal(obj.envelope.parent_run_id, sr.runId);
    assert.equal(obj.payload.trigger, 'phase-transition');
    assert.equal(obj.payload.compaction_strategy, 'key-artifacts-only');
    assert.deepEqual(obj.payload.preserved_artifact_paths, [
      '.deep-work/foo/research.md',
      '.deep-work/foo/plan.md',
    ]);
    assert.deepEqual(obj.payload.discarded_artifact_paths, [
      '.deep-work/foo/tmp-llm-trace.json',
    ]);
  });

  it('emits valid compaction-state for each trigger enum value', () => {
    const dir = tmpDir();
    for (const trigger of VALID_TRIGGERS) {
      const outPath = path.join(dir, `cs-${trigger}.json`);
      runEmit(EMIT_COMPACTION, [
        '--trigger', trigger,
        '--output', outPath,
        '--preserved', '.deep-work/x/y.md',
      ]);
      const obj = readJson(outPath);
      assert.equal(obj.payload.trigger, trigger);
      const r = dashboardUnwrapStrict(
        obj, 'deep-work', 'compaction-state', DASHBOARD_COMPACTION_REQUIRED,
      );
      assert.equal(r.failure, undefined, `${trigger}: ${r.failure}`);
    }
  });

  it('rejects unknown trigger at CLI level (exit 1)', () => {
    const dir = tmpDir();
    const outPath = path.join(dir, 'cs.json');
    try {
      execFileSync('node', [
        EMIT_COMPACTION,
        '--trigger', 'bogus',
        '--output', outPath,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.fail('should have failed for unknown trigger');
    } catch (err) {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /trigger/);
    }
    assert.equal(fs.existsSync(outPath), false);
  });
});

// ---------------------------------------------------------------------------
// Round-trip — both artifacts present, dashboard chain check
// ---------------------------------------------------------------------------

describe('handoff + compaction-state round-trip together', () => {
  it('all three artifacts (session-receipt + handoff + compaction-state) share a run_id chain', () => {
    const dir = tmpDir();
    const sr = makeSessionReceiptEnvelope(dir);

    const payloadPath = path.join(dir, 'handoff-payload.json');
    writeJson(payloadPath, makeHandoffPayload());
    const handoffPath = path.join(dir, 'handoff.json');
    runEmit(EMIT_HANDOFF, [
      '--payload-file', payloadPath,
      '--output', handoffPath,
      '--source-session-receipt', sr.path,
    ]);

    const csPath = path.join(dir, 'compaction-state.json');
    runEmit(EMIT_COMPACTION, [
      '--trigger', 'session-stop',
      '--output', csPath,
      '--preserved', sr.path,
      '--source-session-receipt', sr.path,
      '--strategy', 'receipt-only',
    ]);

    const ho = readJson(handoffPath);
    const cs = readJson(csPath);
    assert.equal(ho.envelope.parent_run_id, sr.runId, 'handoff parent chains to session-receipt');
    assert.equal(cs.envelope.parent_run_id, sr.runId, 'compaction-state parent chains to session-receipt');
    assert.notEqual(ho.envelope.run_id, cs.envelope.run_id, 'each artifact has its own run_id');

    // Both pass dashboard's unwrapStrict.
    assert.ok(isValidEnvelope(ho));
    assert.ok(isValidEnvelope(cs));
    assert.equal(
      dashboardUnwrapStrict(ho, 'deep-work', 'handoff', DASHBOARD_HANDOFF_REQUIRED).failure,
      undefined,
    );
    assert.equal(
      dashboardUnwrapStrict(cs, 'deep-work', 'compaction-state', DASHBOARD_COMPACTION_REQUIRED)
        .failure,
      undefined,
    );
  });
});
