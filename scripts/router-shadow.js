#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { locateDeepModelRouter, findPython3 } = require('./lib/locate-deep-model-router.js');
const { translateRouteOutcome } = require('./lib/router-adapter.js');

const EFFORT_RANK = Object.freeze({
  MINIMAL: 0, LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4, MAX: 5,
  medium: 2, high: 3, xhigh: 4, max: 5,
});

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function hashRequest(request) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(request ?? null))
    .digest('hex');
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function riskBandFromAuthority(mrOut) {
  const cls = mrOut && mrOut.meta && mrOut.meta.policy && mrOut.meta.policy.risk_class;
  if (!cls) return null;
  return String(cls).toUpperCase();
}

function isDowngrade(mrOut, decision) {
  if (!decision) return false;
  const authEffort = mrOut && mrOut.meta && mrOut.meta.efforts
    && mrOut.meta.efforts.implement && mrOut.meta.efforts.implement.effort;
  const routerEffort = decision.selected_effort;
  if (authEffort != null && routerEffort != null
    && EFFORT_RANK[routerEffort] != null && EFFORT_RANK[authEffort] != null
    && EFFORT_RANK[routerEffort] < EFFORT_RANK[authEffort]) {
    return true;
  }
  const authModel = mrOut && mrOut.model_routing && mrOut.model_routing.implement;
  if (authModel && decision.selected_model && authModel !== decision.selected_model) {
    if (/luna|haiku|fast/i.test(String(decision.selected_model))
      && /opus|sol|sonnet|terra/i.test(String(authModel))) {
      return true;
    }
  }
  return false;
}

function compareDecisions(mrOut, decision) {
  return {
    authority: {
      implement: mrOut && mrOut.model_routing ? mrOut.model_routing.implement : null,
      research: mrOut && mrOut.model_routing ? mrOut.model_routing.research : null,
      efforts: mrOut && mrOut.meta ? mrOut.meta.efforts || null : null,
    },
    router: decision ? {
      selected_model: decision.selected_model ?? null,
      selected_effort: decision.selected_effort ?? null,
      selected_effort_native: decision.selected_effort_native ?? null,
      review: decision.review ?? null,
    } : { selected_model: null, selected_effort: null, selected_effort_native: null, review: null },
    downgrade: isDowngrade(mrOut, decision),
  };
}

function mapRuntime(runtime) {
  if (runtime === 'codex') return 'codex';
  if (runtime === 'grok') return 'grok';
  return 'claude_code';
}

function dimensionsForRisk(riskClass) {
  const key = String(riskClass || '').toLowerCase();
  if (key === 'low') return [0, 0, 0, 0];
  if (key === 'high') return [2, 2, 2, 1];
  if (key === 'critical') return [3, 3, 3, 2];
  return [1, 1, 1, 1];
}

function buildShadowRequest({ runtime, riskClass, taskClass } = {}) {
  const dims = dimensionsForRisk(riskClass);
  return {
    route_schema_version: 1,
    task_class: taskClass || 'IMPLEMENTATION',
    complexity: dims[0],
    uncertainty: dims[1],
    blast_radius: dims[2],
    reversibility: dims[3],
    reasoning_centric: false,
    flags: [],
    runtime: mapRuntime(runtime),
    prior_failures: [],
  };
}

function classifySpawn(result) {
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return { exit: null, stdout: '', stderr: String(result.error.message || result.error), processState: 'spawn_failed' };
    }
    if (result.error.code === 'EACCES') {
      return { exit: null, stdout: '', stderr: String(result.error.message || result.error), processState: 'permission_denied' };
    }
    if (result.error.code === 'ETIMEDOUT' || result.error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const state = result.error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'truncated' : 'timeout';
      return {
        exit: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || String(result.error.message || result.error),
        processState: state,
      };
    }
  }
  if (result.signal) {
    return {
      exit: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      processState: 'signal',
      signal: result.signal,
    };
  }
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exit = result.status;
  if (typeof exit === 'number' && (exit < 0 || exit > 5)) {
    return { exit, stdout, stderr, processState: 'out_of_range' };
  }
  if (!String(stdout).trim()) {
    return { exit, stdout, stderr, processState: 'empty_stdout' };
  }
  return { exit, stdout, stderr, processState: 'exited' };
}

function defaultInvoke({ python, cli, request, env, timeoutMs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-router-shadow-'));
  const reqPath = path.join(dir, 'request.json');
  fs.writeFileSync(reqPath, JSON.stringify(request ?? {}));
  try {
    const result = spawnSync(python, [cli, '--request-json', reqPath, '--format', 'json'], {
      encoding: 'utf8',
      timeout: timeoutMs || 15_000,
      env,
      maxBuffer: 2 * 1024 * 1024,
    });
    return classifySpawn(result);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function failShadow(mrOut, request, started, extra) {
  const localRiskBand = extra.localRiskBand || riskBandFromAuthority(mrOut);
  return {
    authority: cloneJson(mrOut),
    shadow: {
      dispatch_authorized: false,
      status: extra.status || 'internal',
      degrade_reason: extra.degrade_reason || 'internal',
      risk_band: localRiskBand,
      local_floor_applied: {},
      routing_provenance: extra.routing_provenance || 'local-fallback',
      input_hash: hashRequest(request),
      identity: { route_schema_version: null, router_plugin_version: null, policy_sha256: null },
      comparison: compareDecisions(mrOut, null),
      latency_ms: Date.now() - started,
      exit: extra.exit === undefined ? null : extra.exit,
      policy_sha256: null,
      frozen_digest: extra.frozenDigest || null,
    },
  };
}

function recordRouterShadow({
  mrOut, request, env, home, frozenDigest, localRiskBand, invoke, findPython3: findPy, now,
} = {}) {
  const started = typeof now === 'function' ? now() : Date.now();
  const authority = cloneJson(mrOut);
  try {
    const envObj = env || process.env;
    let outcome;
    if (typeof invoke === 'function') {
      outcome = invoke({ request, env: envObj });
    } else {
      const cli = locateDeepModelRouter({ env: envObj, home });
      const pythonFinder = typeof findPy === 'function' ? findPy : findPython3;
      const python = pythonFinder({ env: envObj });
      if (!cli) {
        outcome = { exit: null, stdout: '', stderr: 'router-cli-missing', processState: 'missing_cli' };
      } else if (!python) {
        outcome = { exit: null, stdout: '', stderr: 'python3-unavailable', processState: 'python3_unavailable' };
      } else {
        outcome = defaultInvoke({ python, cli, request, env: envObj });
      }
    }

    const parsed = parseJson(outcome && outcome.stdout);
    const observedDigest = parsed && typeof parsed.policy_sha256 === 'string' ? parsed.policy_sha256 : null;
    if (frozenDigest && observedDigest && frozenDigest !== observedDigest) {
      outcome = { ...outcome, processState: 'digest_mismatch', expectedDigest: frozenDigest };
    }

    const band = localRiskBand || riskBandFromAuthority(mrOut);
    const translated = translateRouteOutcome({
      exit: outcome.exit,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      processState: outcome.processState,
      signal: outcome.signal,
      localRiskBand: band,
      expectedDigest: frozenDigest,
    });

    return {
      authority,
      shadow: {
        ...translated,
        input_hash: hashRequest(request),
        identity: {
          route_schema_version: parsed ? parsed.route_schema_version ?? null : null,
          router_plugin_version: parsed ? parsed.router_plugin_version ?? null : null,
          policy_sha256: observedDigest,
        },
        comparison: compareDecisions(mrOut, parsed),
        latency_ms: Date.now() - started,
        exit: outcome.exit === undefined ? null : outcome.exit,
        policy_sha256: observedDigest,
        frozen_digest: frozenDigest || observedDigest,
      },
    };
  } catch (err) {
    return failShadow(mrOut, request, started, {
      status: 'internal',
      degrade_reason: err && err.message ? err.message : String(err),
      localRiskBand,
      frozenDigest,
    });
  }
}

function parseArgs(argv) {
  const out = {
    mrOutFile: null, requestJson: null, frozenDigest: null,
    runtime: null, riskClass: null, taskClass: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mr-out-file') out.mrOutFile = argv[++i] || null;
    else if (a === '--request-json') out.requestJson = argv[++i] || null;
    else if (a === '--frozen-digest') out.frozenDigest = argv[++i] || null;
    else if (a === '--runtime') out.runtime = argv[++i] || null;
    else if (a === '--risk-class') out.riskClass = argv[++i] || null;
    else if (a === '--task-class') out.taskClass = argv[++i] || null;
  }
  return out;
}

function readMrOut(args) {
  if (args.mrOutFile) return fs.readFileSync(args.mrOutFile, 'utf8');
  return fs.readFileSync(0, 'utf8');
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const mrRaw = readMrOut(args);
    const mrOut = parseJson(mrRaw) || { model_routing: {}, meta: {}, warnings: ['shadow: invalid mr-out'] };
    let request = null;
    if (args.requestJson) request = parseJson(fs.readFileSync(args.requestJson, 'utf8'));
    if (!request) {
      request = buildShadowRequest({
        runtime: args.runtime,
        riskClass: args.riskClass,
        taskClass: args.taskClass,
      });
    }
    const wrap = recordRouterShadow({
      mrOut,
      request,
      env: process.env,
      frozenDigest: args.frozenDigest || null,
    });
    process.stdout.write(JSON.stringify(wrap));
  } catch (err) {
    process.stdout.write(JSON.stringify({
      authority: { model_routing: {}, meta: { error: true }, warnings: [] },
      shadow: {
        dispatch_authorized: false,
        status: 'internal',
        degrade_reason: err && err.message ? err.message : String(err),
        risk_band: null,
        local_floor_applied: {},
        routing_provenance: 'local-fallback',
      },
    }));
  }
}

if (require.main === module) main();

module.exports = { recordRouterShadow, buildShadowRequest, hashRequest, compareDecisions, main };
