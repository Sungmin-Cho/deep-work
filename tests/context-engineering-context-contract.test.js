'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('shared context references are centralized', () => {
  const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const sessionAuthority = read('skills/deep-resume/references/session-detection.md');
  const reusableSessionAuthority = sessionAuthority.split('## Resume-only continuation')[0];
  assert.strictEqual(
    sessionAuthority.includes('## Reusable session-state resolution') &&
      sessionAuthority.includes('`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/SKILL.md`') &&
      !reusableSessionAuthority.includes('이 세션을 재개합니다'),
    true,
    'composable session authority missing',
  );

  const languageAuthority = path.join(ROOT, 'skills/shared/references/user-language.md');
  assert.strictEqual(fs.existsSync(languageAuthority), true, 'shared context authority missing');

  const languageRead = 'Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`)';
  const sessionRead = 'Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`)';
  const reusableSessionDirective = 'apply only its **Reusable session-state resolution** section';
  const languageConsumers = [
    'skills/deep-assumptions/SKILL.md',
    'skills/deep-finish/SKILL.md',
    'skills/deep-report/SKILL.md',
    'skills/deep-status/SKILL.md',
    'skills/deep-resume/SKILL.md',
    'skills/deep-cleanup/SKILL.md',
    'skills/deep-debug/SKILL.md',
    'skills/deep-history/SKILL.md',
    'skills/deep-receipt/SKILL.md',
    'skills/deep-slice/SKILL.md',
    'skills/drift-check/SKILL.md',
    'skills/solid-review/SKILL.md',
  ];
  const sessionConsumers = [
    'skills/deep-assumptions/SKILL.md',
    'skills/deep-finish/SKILL.md',
    'skills/deep-insight/SKILL.md',
    'skills/deep-receipt/SKILL.md',
    'skills/deep-report/SKILL.md',
    'skills/deep-slice/SKILL.md',
    'skills/deep-status/SKILL.md',
    'skills/deep-cleanup/SKILL.md',
    'skills/drift-check/SKILL.md',
    'skills/solid-review/SKILL.md',
  ];
  const invocationConsumers = [
    'skills/deep-cleanup/SKILL.md',
    'skills/deep-receipt/SKILL.md',
    'skills/deep-assumptions/SKILL.md',
    'skills/deep-mutation-test/SKILL.md',
    'skills/deep-insight/SKILL.md',
    'skills/deep-report/SKILL.md',
    'skills/drift-check/SKILL.md',
    'skills/deep-history/SKILL.md',
    'skills/deep-debug/SKILL.md',
    'skills/deep-slice/SKILL.md',
    'skills/deep-sensor-scan/SKILL.md',
    'skills/solid-review/SKILL.md',
    'skills/deep-status/SKILL.md',
    'skills/deep-finish/SKILL.md',
    'skills/deep-resume/SKILL.md',
  ];

  for (const file of languageConsumers) {
    assert.ok(read(file).includes(languageRead), `${file} must load the language authority`);
  }
  for (const file of sessionConsumers) {
    const content = read(file);
    assert.ok(content.includes(sessionRead), `${file} must load the session authority`);
    assert.ok(content.includes(reusableSessionDirective), `${file} must apply reusable session resolution only`);
    assert.ok(!content.includes(`${sessionRead} and follow it`), `${file} inherits resume-only continuation`);
  }

  assert.ok(
    sessionAuthority.includes('## Resume-only continuation'),
    'session authority must isolate resume-only continuation',
  );
  assert.ok(
    read('skills/deep-resume/SKILL.md').includes('apply both its reusable resolution and **Resume-only continuation** sections'),
    'deep-resume must explicitly apply resume-only continuation',
  );
  for (const file of invocationConsumers) {
    const content = read(file);
    assert.ok(!content.includes('## Invocation'), `${file} retains invocation boilerplate`);
    assert.ok(!content.includes('**Cross-platform self-containment**'), `${file} retains self-containment boilerplate`);
  }

  const agents = read('AGENTS.md');
  assert.ok(
    agents.includes('Entry skills remain self-contained for state resolution, argument parsing, user choices, and output format'),
    'AGENTS.md must own the entry-skill self-containment invariant',
  );
});

test('selected idle Phase 5 sessions remain available to deep-finish', () => {
  const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const sessionAuthority = read('skills/deep-resume/references/session-detection.md');
  const reusableSessionAuthority = sessionAuthority.split('## Resume-only continuation')[0];
  const deepFinish = read('skills/deep-finish/SKILL.md');

  assert.ok(
    reusableSessionAuthority.includes('If the file exists: continue to 1c regardless of `current_phase`'),
    'an env-selected idle state must reach extraction',
  );
  assert.ok(
    /If the named state file exists: continue\s+to\s+1c regardless of `current_phase`/.test(reusableSessionAuthority),
    'a pointer-selected idle state must reach extraction',
  );
  assert.ok(
    /If the file exists, continue to 1c regardless of `current_phase`/.test(reusableSessionAuthority),
    'an explicitly selected idle state must reach extraction',
  );
  assert.ok(
    !reusableSessionAuthority.includes("If the file doesn't exist or phase is `idle`: fall through to 1b"),
    'env selection must not discard idle Phase 5 state',
  );
  assert.ok(
    !reusableSessionAuthority.includes('state file is missing or `idle`, fall through to 1b'),
    'pointer selection must not discard idle Phase 5 state',
  );

  for (const phase5Marker of ['`phase5_completed_at` 필드 **존재**', '`phase5_entered_at` 존재']) {
    assert.ok(deepFinish.includes(phase5Marker), `deep-finish must consume ${phase5Marker}`);
  }
  assert.ok(
    deepFinish.includes('apply only its **Reusable session-state resolution** section'),
    'deep-finish must receive the selected completed state before applying Phase 5 branches',
  );
});
