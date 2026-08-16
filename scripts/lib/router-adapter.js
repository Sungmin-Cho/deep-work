'use strict';

const HIGH_BANDS = new Set(['HIGH', 'CRITICAL']);

function parseDecision(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return { ok: false, reason: 'empty' };
  try {
    const value = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'non-object' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'non-json' };
  }
}

function bandOf(decision, localRiskBand) {
  const fromDecision = decision && typeof decision.risk_band === 'string'
    ? decision.risk_band.toUpperCase() : null;
  if (fromDecision && ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(fromDecision)) return fromDecision;
  if (typeof localRiskBand === 'string') {
    const local = localRiskBand.toUpperCase();
    if (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(local)) return local;
  }
  return null;
}

function envelope(status, {
  dispatchAuthorized = false,
  band = null,
  reason = null,
  provenance = 'router',
  writeRetryAllowed,
} = {}) {
  const out = {
    dispatch_authorized: dispatchAuthorized,
    status,
    degrade_reason: reason,
    risk_band: band,
    local_floor_applied: {},
    routing_provenance: provenance,
  };
  if (writeRetryAllowed === false) out.write_retry_allowed = false;
  return out;
}

function blockedOrFallback(status, band, reason) {
  if (HIGH_BANDS.has(band)) {
    return envelope(status, { band, reason, provenance: 'router' });
  }
  return envelope(status, { band, reason, provenance: 'local-fallback' });
}

function translateRouteOutcome({
  exit, stdout, stderr, processState, localRiskBand, expectedDigest, signal,
} = {}) {
  const parsed = parseDecision(stdout);
  const decision = parsed.ok ? parsed.value : null;
  const band = bandOf(decision, localRiskBand);
  const errText = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : null;

  if (processState === 'termination_unconfirmed'
    || (decision && decision.result && decision.result.state === 'TERMINATION_UNCONFIRMED')) {
    const out = blockedOrFallback('internal', band, 'TERMINATION_UNCONFIRMED');
    out.write_retry_allowed = false;
    return out;
  }

  if (processState === 'spawn_failed' || processState === 'permission_denied'
    || processState === 'timeout' || processState === 'missing_cli'
    || processState === 'python3_unavailable') {
    const reason = processState === 'python3_unavailable' ? 'python3-unavailable'
      : (processState === 'missing_cli' ? 'router-cli-missing' : processState);
    return blockedOrFallback('unavailable', band, reason);
  }

  if (processState === 'empty_stdout' || processState === 'truncated'
    || processState === 'out_of_range') {
    return blockedOrFallback('unavailable', band, processState);
  }

  if (processState === 'signal') {
    return blockedOrFallback('invalid', band, signal ? `signal:${signal}` : 'signal');
  }

  if (processState === 'digest_mismatch'
    || (decision && expectedDigest && decision.policy_sha256
      && decision.policy_sha256 !== expectedDigest)) {
    return blockedOrFallback('invalid', band, 'policy digest mismatch');
  }

  if (decision && decision.route_schema_version != null
    && decision.route_schema_version !== 1) {
    return blockedOrFallback('invalid', band,
      `unsupported route_schema_version ${decision.route_schema_version}`);
  }

  const knownExit = typeof exit === 'number' && Number.isInteger(exit) && exit >= 0 && exit <= 5;
  if (!parsed.ok) {
    if (knownExit && exit !== 0) {
      // A documented nonzero exit still classifies the outcome even without JSON.
    } else if (parsed.reason === 'empty') {
      return blockedOrFallback('unavailable', band, 'empty_stdout');
    } else {
      return blockedOrFallback('invalid', band, parsed.reason);
    }
  }

  if (!knownExit) {
    return blockedOrFallback('unavailable', band, 'out_of_range');
  }

  if (exit === 0) {
    return envelope('ok', { dispatchAuthorized: true, band, reason: null, provenance: 'router' });
  }
  if (exit === 3) {
    return envelope('human_gate', { band, reason: null, provenance: 'router' });
  }
  if (exit === 4) {
    return envelope('deferred_confirm', {
      dispatchAuthorized: true, band, reason: null, provenance: 'router',
    });
  }
  if (exit === 1) return blockedOrFallback('terminal', band, errText || 'terminal');
  if (exit === 2) return blockedOrFallback('invalid', band, errText || 'invalid');
  if (exit === 5) return blockedOrFallback('internal', band, errText || 'internal');
  return blockedOrFallback('unavailable', band, 'out_of_range');
}

module.exports = { translateRouteOutcome };
