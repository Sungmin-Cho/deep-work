'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('receipt and maintainer authority stays operational', () => {
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const agents = read('AGENTS.md');
  const contributing = read('CONTRIBUTING.md');
  const implement = read('skills/deep-implement/SKILL.md');
  const worker = read('agents/implement-slice-worker.md');
  const packageJson = JSON.parse(read('package.json'));

  const agentsOwnsSchema = [
    '## Receipt envelope (M3)',
    '"producer": "deep-work"',
    '"artifact_kind": "session-receipt | slice-receipt"',
    '"schema": { "name": "<matches artifact_kind>", "version": "1.0" }',
    '"payload": { /* legacy receipt body — schema_version: "1.0" preserved */ }',
  ].every(fragment => agents.includes(fragment));
  const consumersKeepOperations = [implement, worker].every(text =>
    text.includes('`${CLAUDE_PLUGIN_ROOT}/hooks/scripts/wrap-receipt-envelope.js`') &&
    text.includes('producer') && text.includes('artifact_kind') && text.includes('schema.name'));
  const consumersKeepPayloadIdentity = [implement, worker].every(text =>
    text.includes('`schema_version`') && text.includes('`slice_id`') &&
    text.includes('`cluster_id`'));
  const duplicateSchemasRemoved = !implement.includes('"envelope": {') &&
    !worker.includes('"envelope": {');
  const maintainerAuthority = contributing.includes('`AGENTS.md` is the authority for agent-only mechanics') &&
    contributing.includes('one task per commit') && contributing.includes('never `git add -A`');
  const nodeFloor = packageJson.engines.node === '>=22' &&
    /Node\s*(?:≥\s*22|22\+)/.test(agents) &&
    /Node\s*(?:≥\s*22|22\+)/.test(contributing);

  assert.equal(agentsOwnsSchema && consumersKeepOperations && consumersKeepPayloadIdentity && duplicateSchemasRemoved &&
    maintainerAuthority && nodeFloor, true, 'receipt authority contract missing');
});
