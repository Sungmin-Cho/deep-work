#!/usr/bin/env node
'use strict';

/**
 * wrap-receipt-envelope.js — CLI to wrap a deep-work receipt payload in the
 * M3 cross-plugin envelope (cf. deep-suite/docs/envelope-migration.md §1).
 *
 * Designed to be called from markdown agent / skill prompts
 * (skills/deep-finish/SKILL.md §7-Z, agents/implement-slice-worker.md) via the
 * Bash tool. The caller writes the domain payload to a temp file, then invokes
 * this helper to produce the final receipt artifact at the canonical path.
 *
 * Usage:
 *   node wrap-receipt-envelope.js \
 *     --artifact-kind <session-receipt|slice-receipt> \
 *     --payload-file <path-to-payload.json> \
 *     --output <path-to-final-receipt.json> \
 *     [--parent-run-id <ULID>] \
 *     [--session-id <id>] \
 *     [--source-artifacts-glob <glob>]   (slice receipts → session-receipt: aggregate intra-plugin chain)
 *     [--source-evolve-insights <path>]  (cross-plugin chain — also fills parent_run_id if not set)
 *     [--source-harnessability <path>]   (cross-plugin chain — adds to source_artifacts only)
 *     [--session-state-file <path>]      (session-receipt: read test_passed marker → stamp x-test-verified; outcome unchanged)
 *     [--evidence-state-file <path>]     (attach the committed EvidencePackageV2)
 *
 * Exit codes:
 *   0 — wrote envelope-wrapped receipt
 *   2 — usage / IO / argv error
 *
 * Self-contained: no external deps. The envelope shape is enforced by the
 * companion validator (scripts/validate-envelope-emit.js).
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./envelope');

function usage(extra) {
  if (extra) process.stderr.write(`error: ${extra}\n`);
  process.stderr.write(
    'usage: wrap-receipt-envelope.js --artifact-kind <session-receipt|slice-receipt>\n' +
      '                                 --payload-file <payload.json>\n' +
      '                                 --output <receipt.json>\n' +
      '                                 [--parent-run-id <ULID>]\n' +
      '                                 [--session-id <id>]\n' +
      '                                 [--source-artifacts-glob <glob>]\n' +
      '                                 [--source-evolve-insights <path>]\n' +
      '                                 [--source-harnessability <path>]\n' +
      '                                 [--session-state-file <path>]\n' +
      '                                 [--evidence-state-file <path>]\n',
  );
  process.exit(2);
}

const KNOWN_FLAGS = new Set([
  'artifact-kind',
  'payload-file',
  'output',
  'parent-run-id',
  'session-id',
  'source-artifacts-glob',
  'source-evolve-insights',
  'source-harnessability',
  'session-state-file',
  'evidence-state-file',
]);

// Minimal YAML-frontmatter field reader, mirroring utils.sh:read_frontmatter_field.
// Reads the value of `field` from the leading `---` … `---` block. Returns the
// trimmed, quote-stripped value, or null when the file/field is absent.
function readFrontmatterField(filePath, field) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return null;
  }
  let inFrontmatter = false;
  for (const line of raw.split(/\r?\n/)) {
    if (line === '---') {
      if (inFrontmatter) break; // closing fence
      inFrontmatter = true;
      continue;
    }
    if (!inFrontmatter) continue;
    if (line.startsWith(`${field}:`)) {
      return line.slice(field.length + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      usage(`unexpected positional argument: ${a}`);
    }
    let key;
    let value;
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
    if (!KNOWN_FLAGS.has(key)) {
      usage(`unknown flag --${key}`);
    }
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

function tryReadEnvelopeRunId(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Round-1 deep-review W4: require strict envelope (payload non-null/
    // non-array object), not just structural shape. A corrupt envelope's
    // run_id must not contribute to provenance.source_artifacts[] —
    // downstream readers would have a chain pointing at a payload that
    // unwrapEnvelope rejects.
    if (env.isValidEnvelope(obj) && typeof obj.envelope.run_id === 'string') {
      return obj.envelope.run_id;
    }
    return null;
  } catch (_err) {
    return null;
  }
}

function expandSourceArtifactsGlob(globArg, baseCwd) {
  // Minimal POSIX-style glob: supports a single trailing `*` segment within
  // a literal directory path (e.g. `WORK_DIR/receipts/SLICE-*.json`).
  // Sufficient for deep-work's session-receipt → slice-receipt aggregation.
  if (!globArg) return [];
  const abs = path.isAbsolute(globArg) ? globArg : path.resolve(baseCwd, globArg);
  const dir = path.dirname(abs);
  const pattern = path.basename(abs);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const re = new RegExp('^' + escaped + '$');
  return fs.readdirSync(dir)
    .filter((f) => re.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['artifact-kind', 'payload-file', 'output'];
  for (const r of required) {
    if (!args[r]) usage(`missing required flag --${r}`);
  }

  const artifactKind = args['artifact-kind'];
  // R2 review fix (Codex adversarial HIGH): restrict this legacy wrapper to its
  // original 2 artifact kinds. envelope.js#ALLOWED_ARTIFACT_KINDS was extended
  // in v6.6.0 to also include 'handoff' and 'compaction-state', which would
  // (without this guard) let wrap-receipt-envelope.js mint envelope-valid but
  // domain-invalid handoff/compaction-state artifacts (it lacks payload-
  // required-field validation for those kinds). Force callers to use the
  // dedicated emit-handoff.js / emit-compaction-state.js helpers, which
  // enforce payload validation per dashboard contract.
  const LEGACY_RECEIPT_KINDS = new Set(['session-receipt', 'slice-receipt']);
  if (!LEGACY_RECEIPT_KINDS.has(artifactKind)) {
    usage(
      `--artifact-kind must be one of ${[...LEGACY_RECEIPT_KINDS].join(', ')}, got "${artifactKind}" ` +
        '(use emit-handoff.js / emit-compaction-state.js for handoff/compaction-state)',
    );
  }

  const payloadPath = path.resolve(process.cwd(), args['payload-file']);
  const outputPath = path.resolve(process.cwd(), args['output']);

  const payload = readJson(payloadPath);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    process.stderr.write(
      `error: payload at ${payloadPath} must be a non-null, non-array object\n`,
    );
    process.exit(2);
  }

  if (args['evidence-state-file']) {
    const statePath=path.resolve(process.cwd(),args['evidence-state-file']);
    let parsed;try{parsed=require('../../runtime/frontmatter.js').parseFrontmatter(fs.readFileSync(statePath,'utf8')).fields;}
    catch(error){usage(`invalid evidence state: ${error.message}`);}
    let review;try{review=JSON.parse(parsed.review_execution_json);}catch{usage('invalid review_execution_json in evidence state');}
    let verificationPlan;try{verificationPlan=JSON.parse(parsed.verification_plan_json);}catch{
      usage('invalid verification_plan_json in evidence state');}
    const verificationPolicy=require('../../runtime/verification-policy-runtime.js');
    if(!verificationPolicy.validateVerificationPlan(verificationPlan).pass||
        verificationPlan.plan_sha256!==parsed.verification_plan_sha256)
      usage('persisted verification plan is invalid');
    const evidence=review?.evidence;const pointer=artifactKind==='slice-receipt'
      ? evidence?.slice_packages?.[payload.slice_id]:evidence;
    if(!pointer?.package_ref||!pointer?.package_sha256)usage('committed evidence pointer is missing');
    if(pointer.verification_plan_sha256&&pointer.verification_plan_sha256!==verificationPlan.plan_sha256)
      usage('committed evidence pointer plan mismatch');
    const projectRoot=path.dirname(path.dirname(statePath)),workDir=parsed.work_dir;
    if(typeof workDir!=='string'||!workDir||path.isAbsolute(workDir)||workDir.split('/').includes('..'))
      usage('invalid evidence work_dir');const artifactRoot=path.resolve(projectRoot,...workDir.split('/'));
    if(!artifactRoot.startsWith(`${path.resolve(projectRoot)}${path.sep}`))usage('invalid evidence work_dir');
    const evidenceRuntime=require('../../runtime/evidence-runtime.js');let pkg,attached;
    try{pkg=evidenceRuntime.loadCommittedPackage(artifactRoot,pointer,verificationPlan);
      if(!pkg)throw new Error('missing committed package');attached=evidenceRuntime.attachEvidenceToReceipt(payload,
        {package:pkg,summary:evidence?.summary,verificationPlan,state:parsed,artifactRoot});}
    catch(error){usage(`committed evidence package is invalid: ${error.code||error.message}`);}
    for(const key of Object.keys(payload))delete payload[key];Object.assign(payload,attached);
  }

  // Deterministic test-verification signal (session-receipt only). deep-test
  // records `test_passed: true` in the session state's frontmatter as the
  // precondition for a verified session (deep-test SKILL.md §All Pass /
  // deep-finish SKILL.md §7-Z). We read that marker here rather than trusting
  // the caller to have honored the contract, and stamp the result on the
  // payload as `x-test-verified` (forward-compat `^x-` namespace — the schema
  // pins additionalProperties:false + patternProperties ^x-).
  //
  // We do NOT rewrite `outcome`. By the time §7-Z runs, a merge/pr outcome is
  // already physically done (worktree removed + branch -d, or `gh pr create`),
  // so demoting it to "in-progress" would misreport a completed action to
  // completion-polling / aggregation consumers. The receipt records the FACT
  // (outcome) and the verification SIGNAL (x-test-verified) separately;
  // consumers judge trustworthiness from the pair.
  if (artifactKind === 'session-receipt' && args['session-state-file']) {
    const statePath = path.resolve(process.cwd(), args['session-state-file']);
    if (fs.existsSync(statePath)) {
      const testPassed = readFrontmatterField(statePath, 'test_passed');
      const verified = testPassed === 'true';
      payload['x-test-verified'] = verified;
      if (!verified) {
        process.stderr.write(
          `note: test_passed not confirmed (test_passed=${JSON.stringify(testPassed)}); ` +
            'recorded x-test-verified=false (outcome left as recorded)\n',
        );
      }
    }
  }

  // Cross-plugin chain: harvest run_ids from consumed artifacts.
  const sourceArtifacts = [];

  // Cross-plugin: deep-evolve evolve-insights (handoff §3.3 chain row).
  let parentRunId = args['parent-run-id'] || undefined;
  if (args['source-evolve-insights']) {
    const evolvePath = path.resolve(process.cwd(), args['source-evolve-insights']);
    const evolveRunId = tryReadEnvelopeRunId(evolvePath);
    sourceArtifacts.push({
      path: args['source-evolve-insights'],
      ...(evolveRunId ? { run_id: evolveRunId } : {}),
    });
    if (!parentRunId && evolveRunId) {
      parentRunId = evolveRunId;
    }
  }

  // Cross-plugin: deep-dashboard harnessability-report (multi-source, no parent).
  if (args['source-harnessability']) {
    const harnPath = path.resolve(process.cwd(), args['source-harnessability']);
    const harnRunId = tryReadEnvelopeRunId(harnPath);
    sourceArtifacts.push({
      path: args['source-harnessability'],
      ...(harnRunId ? { run_id: harnRunId } : {}),
    });
  }

  // Intra-plugin: session-receipt aggregates slice receipts.
  if (args['source-artifacts-glob']) {
    const slicePaths = expandSourceArtifactsGlob(args['source-artifacts-glob'], process.cwd());
    for (const sp of slicePaths) {
      const runId = tryReadEnvelopeRunId(sp);
      const rel = path.relative(process.cwd(), sp);
      sourceArtifacts.push({
        path: rel.length > 0 ? rel : sp,
        ...(runId ? { run_id: runId } : {}),
      });
    }
  }

  let wrapped;
  try {
    wrapped = env.wrapEnvelope({
      artifactKind,
      payload,
      parentRunId,
      sessionId: args['session-id'] || undefined,
      sourceArtifacts,
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (err) {
      process.stderr.write(`error: cannot mkdir ${outDir}: ${err.message}\n`);
      process.exit(2);
    }
  }

  // C1 (round 1) — Atomic write: write to a unique temp path then rename.
  // Mid-write interruption (Ctrl-C, OOM, hook timeout) or two concurrent
  // finishers must not leave a truncated session-receipt.json that downstream
  // readers (verify-delegated-receipt-runner.js, validate-receipt.sh,
  // gather-signals.sh) parse-fail on. Mirrors the temp+rename pattern used by
  // receipt-migration.js:103-106 and session-end.sh's _append_with_lock.
  const tmpPath = `${outputPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(wrapped, null, 2) + '\n', 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    process.stderr.write(`error: cannot write ${tmpPath}: ${err.message}\n`);
    process.exit(2);
  }
  try {
    fs.renameSync(tmpPath, outputPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    process.stderr.write(`error: cannot rename ${tmpPath} → ${outputPath}: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `wrapped: ${outputPath} (run_id=${wrapped.envelope.run_id}, artifact_kind=${wrapped.envelope.artifact_kind})\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { expandSourceArtifactsGlob, tryReadEnvelopeRunId, readFrontmatterField };
