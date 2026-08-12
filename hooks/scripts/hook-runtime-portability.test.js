'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubHostEnv } = require('./test-helpers/run-phase-guard.js');

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const HOOKS_PATH = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
const BOOTSTRAP_PATH = path.join(__dirname, 'hook-bootstrap.js');
const STDIN_SENTINEL = Buffer.from('dw-stdin-\x1f-señtinel-딥\n');

const PROGRAM_TEMPLATE = "var e=process.env,c=e.CLAUDE_PLUGIN_ROOT,p=e.PLUGIN_ROOT,v=(c!==undefined&&c!=='')?'CLAUDE_PLUGIN_ROOT':((p!==undefined&&p!=='')?'PLUGIN_ROOT':'neither CLAUDE_PLUGIN_ROOT nor PLUGIN_ROOT'),r=v==='CLAUDE_PLUGIN_ROOT'?c:(v==='PLUGIN_ROOT'?p:'');try{if(!r||r.trim()==='')throw new Error('plugin root env unset or whitespace-only (CLAUDE_PLUGIN_ROOT/PLUGIN_ROOT)');var q=require('path'),f=require('fs'),S=q.sep,w=process.platform==='win32',a=r.charAt(0),b=r.charAt(1),d=r.charAt(2),ok=w?((b===':'&&(d===S||d==='/'))||((a===S||a==='/')&&(b===S||b==='/'))):a==='/';if(!ok)throw new Error('plugin root is not a fully qualified absolute path: '+r);var R=q.resolve(f.realpathSync(r)),B=q.resolve(f.realpathSync(q.join(R,'hooks','scripts','hook-bootstrap.js'))),t=B,g=false;for(;;){var n=q.dirname(t);if(n===t)break;if(n===R){g=true;break}t=n}if(!g)throw new Error('hook-bootstrap.js escapes the plugin root');require(B).main('<MODE>',R)}catch(x){var m=x&&x.message?x.message:String(x),h='plugin root source '+v+' with value '+JSON.stringify(r)+' could not be used; set CLAUDE_PLUGIN_ROOT or PLUGIN_ROOT to restore this session: '+m;<CATCH-TAIL>}";

const EXACT_CATCH = "console.error('deep-work hook bootstrap: '+h);process.exitCode=1";
const SENSOR_CATCH = "console.error('deep-work hook bootstrap: '+h);process.exitCode=0";
const PRE_CATCH = "console.error('deep-work hook bootstrap: '+h);console.log(JSON.stringify({decision:'block',reason:'deep-work hook bootstrap failed: '+h}));process.exitCode=2";

function programFor(mode) {
  const catchTail = mode === 'pre-tool-use'
    ? PRE_CATCH
    : mode === 'post-tool-sensor' ? SENSOR_CATCH : EXACT_CATCH;
  return PROGRAM_TEMPLATE
    .replace('<MODE>', mode)
    .replace('<CATCH-TAIL>', catchTail);
}

function expectedCommand(mode, fail) {
  const program = programFor(mode);
  if (mode === 'pre-tool-use') {
    return `if ! command -v node >/dev/null 2>&1; then echo 'deep-work hook bootstrap: node executable not found on PATH' >&2; exit 2; fi; s=0; node -e "${program}" || s=$?; if [ $s -eq 0 ] || [ $s -eq 2 ]; then exit $s; fi; echo 'deep-work hook bootstrap: unexpected guard status '$s' coerced to block' >&2; exit 2`;
  }
  return `if command -v node >/dev/null 2>&1; then exec node -e "${program}"; fi; echo 'deep-work hook bootstrap: node executable not found on PATH' >&2; exit ${fail}`;
}

function expectedCommandWindows(mode, fail) {
  const program = programFor(mode);
  const prefix = `$LASTEXITCODE = $null; try { node -e "${program}" } catch { [Console]::Error.WriteLine('deep-work hook bootstrap: node could not be started: ' + $_.Exception.Message) }; if ($null -eq $LASTEXITCODE) { exit ${fail} }`;
  if (mode === 'pre-tool-use') {
    return `${prefix}; if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 2) { exit $LASTEXITCODE }; [Console]::Error.WriteLine('deep-work hook bootstrap: unexpected guard status ' + $LASTEXITCODE + ' coerced to block'); exit 2`;
  }
  return `${prefix}; exit $LASTEXITCODE`;
}

function commandHandlers(document) {
  return Object.values(document.hooks)
    .flatMap((registrations) => registrations)
    .flatMap((registration) => registration.hooks)
    .filter((handler) => handler.type === 'command');
}

function registeredEntries(document = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'))) {
  return [
    { mode: 'session-start-update', handler: document.hooks.SessionStart[0].hooks[0], target: 'session-start-adapter.js', args: ['update-check'], fail: 1, timeout: 8 },
    { mode: 'session-start-sensor', handler: document.hooks.SessionStart[0].hooks[1], target: 'session-start-adapter.js', args: ['sensor-detect'], fail: 1, timeout: 8 },
    { mode: 'pre-tool-use', handler: document.hooks.PreToolUse[0].hooks[0], target: 'hook-shell-adapter.js', args: ['phase-guard'], fail: 2, timeout: 5 },
    { mode: 'post-tool-main', handler: document.hooks.PostToolUse[0].hooks[0], target: 'hook-shell-adapter.js', args: ['post-tool'], fail: 1, timeout: 6 },
    { mode: 'post-tool-sensor', handler: document.hooks.PostToolUse[0].hooks[1], target: 'sensor-trigger.js', args: [], fail: 0, timeout: 3 },
    { mode: 'stop', handler: document.hooks.Stop[0].hooks[0], target: 'hook-shell-adapter.js', args: ['session-end'], fail: 1, timeout: 5 },
  ];
}

function extractProgram(field) {
  const match = /node -e "([^"]+)"/.exec(field);
  assert.ok(match, `inline node program not found: ${field}`);
  return match[1];
}

function extractedPredicates(field) {
  const program = extractProgram(field);
  const fq = /w=process\.platform==='win32',a=([^,]+),b=([^,]+),d=([^,]+),ok=([^;]+);if\(!ok\)/.exec(program);
  assert.ok(fq, 'fully-qualified predicate not found');
  const fullyQualified = new Function('r', 'platform', 'sep',
    `var S=sep,w=platform==='win32',a=${fq[1]},b=${fq[2]},d=${fq[3]};return ${fq[4]};`);

  const walk = /var R=([^,]+),B=([^;]+),t=B,g=false;(for\(;;\)\{.*?\})if\(!g\)/.exec(program);
  assert.ok(walk, 'containment walk not found');
  const bExpression = walk[2].replace(
    /q\.join\(R,'hooks','scripts','hook-bootstrap\.js'\)/,
    'rawTarget',
  );
  const makeInside = new Function('pathApi', `
    return function(rawRoot, rawTarget) {
      var q=pathApi,f={realpathSync:function(value){return value}},r=rawRoot;
      var R=${walk[1]},B=${bExpression},t=B,g=false;
      ${walk[3]}
      return g;
    };
  `);
  return { fullyQualified, makeInside };
}

test('manifest commands are exact snapshots of the four canonical templates', () => {
  const document = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
  const entries = registeredEntries(document);
  const { MODES, HOST_TIMEOUT_HEADROOM_SECONDS } = require('./hook-bootstrap.js');

  assert.equal(document.description,
    'Phase enforcement, file tracking, update check, and session lifecycle hooks');
  assert.equal(entries.length, 6);
  assert.deepEqual(entries.map(({ mode }) => mode), [
    'session-start-update',
    'session-start-sensor',
    'pre-tool-use',
    'post-tool-main',
    'post-tool-sensor',
    'stop',
  ]);
  for (const entry of entries) {
    assert.equal(entry.handler.command, expectedCommand(entry.mode, entry.fail), entry.mode);
    assert.equal(entry.handler.commandWindows,
      expectedCommandWindows(entry.mode, entry.fail), entry.mode);
    assert.equal(entry.handler.timeout, entry.timeout + 1, entry.mode);
    assert.equal(MODES[entry.mode].timeoutSeconds + HOST_TIMEOUT_HEADROOM_SECONDS,
      entry.handler.timeout,
      `${entry.mode}: manifest timeout must preserve adapter budget plus host headroom`);
    const program = programFor(entry.mode);
    assert.doesNotMatch(program, /[$`\\"]/);
  }
});

test('all 12 shipped fields use predicates equivalent to hook-bootstrap exports', () => {
  const { isFullyQualified, isStrictlyInside } = require('./hook-bootstrap.js');
  const fqRows = [
    ['C:\\', 'win32', '\\', true],
    ['C:/', 'win32', '\\', true],
    ['\\\\server\\share', 'win32', '\\', true],
    ['//server/share', 'win32', '\\', true],
    ['C:foo', 'win32', '\\', false],
    ['\\foo', 'win32', '\\', false],
    ['relative/path', 'win32', '\\', false],
    ['/opt/plugin', 'linux', '/', true],
    ['relative/path', 'linux', '/', false],
  ];
  const insideRows = [
    [path.posix, '/', '/hooks/scripts/hook-bootstrap.js', true],
    [path.win32, 'C:\\', 'C:\\hooks\\scripts\\hook-bootstrap.js', true],
    [path.win32, '\\\\srv\\share', '\\\\srv\\share\\hooks\\scripts\\hook-bootstrap.js', true],
    [path.win32, '\\\\srv\\share\\', '\\\\srv\\share\\hooks\\scripts\\hook-bootstrap.js', true],
    [path.win32, '//srv/share', '//srv/share/hooks/scripts/hook-bootstrap.js', true],
    [path.win32, 'C:\\p\\Root', 'C:\\p\\Root\\..safe\\hook-bootstrap.js', true],
    [path.win32, 'C:\\p\\Root', 'C:\\p\\root\\evil.js', false],
    [path.win32, 'C:\\p\\İ', 'C:\\p\\i̇\\evil.js', false],
    [path.win32, 'C:\\p\\Root', 'C:\\p\\Root-sibling\\evil.js', false],
    [path.win32, 'C:\\p\\Root', 'C:\\p\\hook-bootstrap.js', false],
    [path.win32, 'C:\\p\\Root', 'C:\\p\\Sibling\\hook-bootstrap.js', false],
    [path.win32, 'C:\\p\\Root', 'C:\\p\\..\\hook-bootstrap.js', false],
  ];

  for (const { handler } of registeredEntries()) {
    for (const field of [handler.command, handler.commandWindows]) {
      const { fullyQualified, makeInside } = extractedPredicates(field);
      for (const [value, platform, sep, expected] of fqRows) {
        assert.equal(fullyQualified(value, platform, sep), expected, `${value}: ${field}`);
        assert.equal(isFullyQualified(value, platform, sep), expected, value);
      }
      for (const [pathApi, root, target, expected] of insideRows) {
        const extractedInside = makeInside(pathApi);
        assert.equal(extractedInside(root, target), expected, `${root} -> ${target}: ${field}`);
        assert.equal(
          isStrictlyInside(pathApi.resolve(root), pathApi.resolve(target), pathApi),
          expected,
          `${root} -> ${target}`,
        );
      }
    }
  }
});

test('manifest bootstrap tails, registration order, and deny rules stay fail-safe', () => {
  const document = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
  const entries = registeredEntries(document);
  assert.equal(commandHandlers(document).length, 6);
  assert.equal(document.hooks.PostToolUse.length, 1);
  assert.deepEqual(entries.slice(3, 5).map(({ mode }) => mode),
    ['post-tool-main', 'post-tool-sensor']);

  for (const { mode, handler } of entries) {
    for (const field of [handler.command, handler.commandWindows]) {
      assert.doesNotMatch(field, /\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/);
      assert.doesNotMatch(field, /\b(?:bash|wsl)(?:\.exe)?\b/i);
      assert.doesNotMatch(field, /\.sh(?:"|\s|$)/i);
      assert.doesNotMatch(field, /skip|CLAUDECODE|CODEX_HOME/i);
      assert.match(extractProgram(field), new RegExp(`main\\('${mode}',R\\)`));
    }
    assert.match(handler.command, /command -v node/);
    assert.match(handler.command, /node executable not found on PATH/);
    assert.match(handler.commandWindows, /^\$LASTEXITCODE = \$null; try \{ node -e /);
    assert.match(handler.commandWindows, /catch \{ \[Console\]::Error\.WriteLine/);
    assert.match(handler.commandWindows, /if \(\$null -eq \$LASTEXITCODE\)/);
  }

  const pre = entries.find(({ mode }) => mode === 'pre-tool-use').handler;
  assert.match(pre.command, /s=0; node -e /);
  assert.match(pre.command, /\|\| s=\$\?/);
  assert.match(pre.command, /if \[ \$s -eq 0 \] \|\| \[ \$s -eq 2 \]/);
  assert.match(pre.commandWindows, /-eq 0 -or \$LASTEXITCODE -eq 2/);
  for (const { mode, handler } of entries.filter(({ mode }) => mode !== 'pre-tool-use')) {
    assert.match(handler.command, /then exec node -e /, mode);
    assert.match(handler.commandWindows, /; exit \$LASTEXITCODE$/, mode);
  }
});

module.exports = { expectedCommand, expectedCommandWindows, registeredEntries };

function fixtureAdapterSource() {
  return `'use strict';
const fs=require('node:fs'),path=require('node:path');
const chunks=[];
process.stdin.on('data',(chunk)=>chunks.push(chunk));
process.stdin.on('end',()=>{
  const root=path.resolve(__dirname,'..','..');
  fs.mkdirSync(path.join(root,'capture'),{recursive:true});
  fs.writeFileSync(path.join(root,'capture',path.basename(__filename)+'.'+process.pid+'.json'),JSON.stringify({target:path.basename(__filename),argv:process.argv.slice(2),stdin:Buffer.concat(chunks).toString('base64')}));
  if(process.env.FIXTURE_CHILD_SIGNAL){process.kill(process.pid,process.env.FIXTURE_CHILD_SIGNAL);return}
  process.exitCode=Number(process.env.FIXTURE_CHILD_EXIT||0);
});
process.stdin.resume();
`;
}

function populateFixtureRoot(root) {
  const scripts = path.join(root, 'hooks', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(root, 'capture'), { recursive: true });
  if (fs.existsSync(BOOTSTRAP_PATH)) {
    fs.copyFileSync(BOOTSTRAP_PATH, path.join(scripts, 'hook-bootstrap.js'));
  }
  for (const target of [
    'hook-shell-adapter.js',
    'session-start-adapter.js',
    'sensor-trigger.js',
  ]) {
    fs.writeFileSync(path.join(scripts, target), fixtureAdapterSource());
  }
}

function makeFixture(t, prefix = 'deep work 플러그인 ') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(base, 'plugin root');
  populateFixtureRoot(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root };
}

function clearCaptures(root) {
  const capture = path.join(root, 'capture');
  fs.rmSync(capture, { recursive: true, force: true });
  fs.mkdirSync(capture, { recursive: true });
}

function captures(root) {
  const capture = path.join(root, 'capture');
  if (!fs.existsSync(capture)) return [];
  return fs.readdirSync(capture)
    .filter((name) => name.endsWith('.json') && name !== 'escaped.json')
    .map((name) => JSON.parse(fs.readFileSync(path.join(capture, name), 'utf8')));
}

function resolveWindowsPowerShell(environment = process.env, exists = fs.existsSync) {
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('SystemRoot must be an absolute Windows path');
  }
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!exists(executable)) throw new Error(`PowerShell executable not found: ${executable}`);
  return executable;
}

function planLaunch(entry, {
  env = {},
  input = STDIN_SENTINEL,
  cwd,
  platform = process.platform,
} = {}) {
  const options = {
    cwd,
    env: scrubHostEnv(env),
    input,
    encoding: 'utf8',
    shell: false,
  };
  if (platform === 'win32') {
    return {
      platform,
      executable: resolveWindowsPowerShell(options.env),
      args: ['-NoProfile', '-NonInteractive', '-Command', entry.handler.commandWindows],
      options,
    };
  }
  return {
    platform,
    executable: '/bin/sh',
    args: ['-c', entry.handler.command],
    options,
  };
}

function runRegistered(entry, options = {}) {
  const plan = planLaunch(entry, options);
  if (plan.platform === 'win32') {
    return spawnSync(resolveWindowsPowerShell(plan.options.env), plan.args,
      { ...plan.options, shell: false });
  }
  return spawnSync('/bin/sh', plan.args, { ...plan.options, shell: false });
}

function resultDetail(entry, result) {
  return `${entry.mode}: status=${result.status} signal=${result.signal || ''}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
}

function assertSuccessfulCapture(entry, result, root, input = STDIN_SENTINEL) {
  assert.equal(result.status, 0, resultDetail(entry, result));
  const observed = captures(root);
  assert.equal(observed.length, 1, resultDetail(entry, result));
  assert.equal(observed[0].target, entry.target, entry.mode);
  assert.deepEqual(observed[0].argv, entry.args, entry.mode);
  assert.equal(observed[0].stdin, Buffer.from(input).toString('base64'), entry.mode);
}

function assertEventFailure(entry, result) {
  assert.equal(result.status, entry.fail, resultDetail(entry, result));
  assert.match(result.stderr, /deep-work hook bootstrap/, resultDetail(entry, result));
  if (entry.mode === 'pre-tool-use') {
    assert.match(result.stdout, /"decision":"block"/, resultDetail(entry, result));
  }
  if (entry.mode.startsWith('session-start')) {
    assert.equal(result.stdout, '', resultDetail(entry, result));
  }
}

function writeEscapeModule(target, marker) {
  fs.writeFileSync(target,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped');module.exports={main:function(){process.exitCode=0}};\n`);
}

function replaceWithSymlink(linkPath, targetPath) {
  fs.rmSync(linkPath, { force: true });
  fs.symlinkSync(targetPath, linkPath);
}

test('case 0 Windows command quoting canary preserves the node -e payload', {
  skip: process.platform === 'win32' ? false : 'native PowerShell contract',
}, () => {
  const result = runRegistered({
    handler: {
      commandWindows: `node -e "console.log('dw-canary')"; exit $LASTEXITCODE`,
    },
  }, { input: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'dw-canary');
});

test('Windows launcher is verified under SystemRoot independently of the child PATH', () => {
  const systemRoot = 'C:\\Windows';
  const expected = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(resolveWindowsPowerShell(
    { SystemRoot: systemRoot, PATH: 'C:\\empty' },
    (candidate) => candidate === expected,
  ), expected);
  assert.throws(() => resolveWindowsPowerShell({ SystemRoot: 'Windows' }, () => true),
    /absolute Windows path/);
  assert.throws(() => resolveWindowsPowerShell({ SystemRoot: systemRoot }, () => false),
    /not found/);
});

test('planLaunch resolves the Windows executable from the child environment on POSIX', () => {
  const childSystemRoot = 'D:\\ChildWindows';
  const parentSystemRoot = process.env.SystemRoot;
  const originalExists = fs.existsSync;
  process.env.SystemRoot = 'C:\\ParentWindows';
  fs.existsSync = () => true;
  let plan;
  try {
    plan = planLaunch({ handler: { commandWindows: 'exit 0' } }, {
      env: { SystemRoot: childSystemRoot, PATH: 'D:\\empty' },
      platform: 'win32',
    });
  } finally {
    fs.existsSync = originalExists;
    if (parentSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = parentSystemRoot;
  }
  assert.equal(plan.executable,
    'D:\\ChildWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(plan.options.env.SystemRoot, childSystemRoot);
});

test('case 1 Claude-only root executes all registered entries with byte-identical stdin', (t) => {
  const fixture = makeFixture(t);
  for (const entry of registeredEntries()) {
    clearCaptures(fixture.root);
    const result = runRegistered(entry, {
      cwd: fixture.base,
      env: { CLAUDE_PLUGIN_ROOT: fixture.root },
    });
    assertSuccessfulCapture(entry, result, fixture.root);
  }
});

test('case 2 Codex-only root executes all registered entries with byte-identical stdin', (t) => {
  const fixture = makeFixture(t);
  const entries = registeredEntries();
  const pre = entries.find(({ mode }) => mode === 'pre-tool-use');
  for (const entry of [pre, ...entries.filter(({ mode }) => mode !== 'pre-tool-use')]) {
    clearCaptures(fixture.root);
    const result = runRegistered(entry, {
      cwd: fixture.base,
      env: { PLUGIN_ROOT: fixture.root },
    });
    assertSuccessfulCapture(entry, result, fixture.root);
  }
});

test('case 3 both-different roots give CLAUDE_PLUGIN_ROOT silent precedence', (t) => {
  const claude = makeFixture(t, 'deep work claude ');
  const codex = makeFixture(t, 'deep work codex ');
  for (const entry of registeredEntries()) {
    clearCaptures(claude.root);
    clearCaptures(codex.root);
    const result = runRegistered(entry, {
      cwd: claude.base,
      env: {
        CLAUDE_PLUGIN_ROOT: claude.root,
        PLUGIN_ROOT: codex.root,
      },
    });
    assertSuccessfulCapture(entry, result, claude.root);
    assert.equal(captures(codex.root).length, 0, entry.mode);
  }
});

test('case 4 neither root fails by event polarity without executing cwd decoys', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-work-hook-trap-'));
  const cwd = path.join(base, 'workspace');
  const marker = path.join(base, 'decoy-ran');
  fs.mkdirSync(path.join(cwd, 'hooks', 'scripts'), { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const target of ['hook-bootstrap.js', 'hook-shell-adapter.js', 'session-start-adapter.js', 'sensor-trigger.js']) {
    fs.writeFileSync(path.join(cwd, 'hooks', 'scripts', target),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.exitCode=0;\n`);
  }
  for (const entry of registeredEntries()) {
    fs.rmSync(marker, { force: true });
    const result = runRegistered(entry, { cwd });
    assertEventFailure(entry, result);
    assert.match(result.stderr, /neither CLAUDE_PLUGIN_ROOT nor PLUGIN_ROOT/);
    assert.match(result.stderr, /set CLAUDE_PLUGIN_ROOT or PLUGIN_ROOT/);
    assert.equal(fs.existsSync(marker), false, entry.mode);
  }
});

test('case 5 whitespace CLAUDE root does not fall through to valid PLUGIN_ROOT', (t) => {
  const fixture = makeFixture(t);
  for (const entry of registeredEntries()) {
    clearCaptures(fixture.root);
    const result = runRegistered(entry, {
      cwd: fixture.base,
      env: { CLAUDE_PLUGIN_ROOT: '   ', PLUGIN_ROOT: fixture.root },
    });
    assertEventFailure(entry, result);
    assert.equal(captures(fixture.root).length, 0, entry.mode);
  }
});

test('case 5b stale CLAUDE root reports the selected variable, value, and recovery', (t) => {
  const fixture = makeFixture(t);
  const staleRoot = path.join(fixture.base, 'missing plugin root');
  const entry = registeredEntries().find(({ mode }) => mode === 'pre-tool-use');
  const result = runRegistered(entry, {
    cwd: fixture.base,
    env: { CLAUDE_PLUGIN_ROOT: staleRoot, PLUGIN_ROOT: fixture.root },
  });
  assert.equal(result.status, 2, resultDetail(entry, result));
  assert.match(result.stderr, /plugin root source CLAUDE_PLUGIN_ROOT with value /);
  assert.ok(result.stderr.includes(JSON.stringify(staleRoot)), resultDetail(entry, result));
  assert.match(result.stderr, /set CLAUDE_PLUGIN_ROOT or PLUGIN_ROOT to restore this session/);
  assert.match(result.stdout, /CLAUDE_PLUGIN_ROOT/);
  assert.equal(captures(fixture.root).length, 0);
});

test('case 6a adapter symlink escape is rejected before outside code executes', {
  skip: process.platform === 'win32' ? 'symlink fixture is POSIX-only' : false,
}, (t) => {
  for (const entry of registeredEntries()) {
    const fixture = makeFixture(t, `deep work 6a ${entry.mode} `);
    const outside = path.join(fixture.base, `outside-${entry.target}`);
    const marker = path.join(fixture.root, 'capture', 'escaped.json');
    writeEscapeModule(outside, marker);
    replaceWithSymlink(path.join(fixture.root, 'hooks', 'scripts', entry.target), outside);
    const result = runRegistered(entry, {
      cwd: fixture.base,
      env: { PLUGIN_ROOT: fixture.root },
    });
    assert.equal(result.status, entry.fail, resultDetail(entry, result));
    assert.equal(fs.existsSync(marker), false, entry.mode);
  }
});

test('case 6b inline bootstrap symlink escape is rejected before require', {
  skip: process.platform === 'win32' ? 'symlink fixture is POSIX-only' : false,
}, (t) => {
  for (const entry of registeredEntries()) {
    const fixture = makeFixture(t, `deep work 6b ${entry.mode} `);
    const outside = path.join(fixture.base, 'outside-bootstrap.js');
    const marker = path.join(fixture.root, 'capture', 'escaped.json');
    writeEscapeModule(outside, marker);
    replaceWithSymlink(path.join(fixture.root, 'hooks', 'scripts', 'hook-bootstrap.js'), outside);
    const result = runRegistered(entry, {
      cwd: fixture.base,
      env: { PLUGIN_ROOT: fixture.root },
    });
    assert.equal(result.status, entry.fail, resultDetail(entry, result));
    assert.match(result.stderr, /escapes the plugin root/, resultDetail(entry, result));
    assert.equal(fs.existsSync(marker), false, entry.mode);
  }
});

test('case 6c relocated bootstrap keeps the caller-supplied root identity', {
  skip: process.platform === 'win32' ? 'symlink fixture is POSIX-only' : false,
}, (t) => {
  for (const entry of registeredEntries()) {
    const fixture = makeFixture(t, `deep work 6c ${entry.mode} `);
    const fixedBootstrap = path.join(fixture.root, 'hooks', 'scripts', 'hook-bootstrap.js');
    const relocated = path.join(fixture.root, 'hooks', 'bootstrap.js');
    fs.copyFileSync(fixedBootstrap, relocated);
    replaceWithSymlink(fixedBootstrap, '../bootstrap.js');

    const outsideTarget = path.join(fixture.base, 'hooks', 'scripts', entry.target);
    const marker = path.join(fixture.root, 'capture', 'escaped.json');
    fs.mkdirSync(path.dirname(outsideTarget), { recursive: true });
    writeEscapeModule(outsideTarget, marker);
    clearCaptures(fixture.root);

    const result = runRegistered(entry, {
      cwd: fixture.base,
      env: { PLUGIN_ROOT: fixture.root },
    });
    assertSuccessfulCapture(entry, result, fixture.root);
    assert.equal(fs.existsSync(marker), false, entry.mode);
  }
});

test('case 7 child exit 7 preserves exact modes and blocks PreToolUse', (t) => {
  const fixture = makeFixture(t);
  for (const entry of registeredEntries()) {
    clearCaptures(fixture.root);
    const result = runRegistered(entry, {
      cwd: fixture.base,
      env: { PLUGIN_ROOT: fixture.root, FIXTURE_CHILD_EXIT: '7' },
    });
    const expected = entry.mode === 'pre-tool-use' ? 2 : 7;
    assert.equal(result.status, expected, resultDetail(entry, result));
    if (entry.mode === 'pre-tool-use') assert.match(result.stderr, /7/);
  }
});

test('case 7b polarity sweep maps only PreToolUse statuses 1 and 129 to block', (t) => {
  const fixture = makeFixture(t);
  for (const status of [1, 129]) {
    for (const entry of registeredEntries()) {
      const result = runRegistered(entry, {
        cwd: fixture.base,
        env: { PLUGIN_ROOT: fixture.root, FIXTURE_CHILD_EXIT: String(status) },
      });
      const expected = entry.mode === 'pre-tool-use' ? 2 : status;
      assert.equal(result.status, expected, resultDetail(entry, result));
      if (entry.mode === 'pre-tool-use') assert.match(result.stderr, new RegExp(String(status)));
    }
  }
});

test('case 8 child SIGKILL is converted to each event failure policy', {
  skip: process.platform === 'win32' ? 'POSIX signal contract' : false,
}, (t) => {
  const fixture = makeFixture(t);
  for (const entry of registeredEntries()) {
    const result = runRegistered(entry, {
      cwd: fixture.base,
      env: { PLUGIN_ROOT: fixture.root, FIXTURE_CHILD_SIGNAL: 'SIGKILL' },
    });
    assert.equal(result.status, entry.fail, resultDetail(entry, result));
    assert.match(result.stderr, /SIGKILL|signal/i, resultDetail(entry, result));
  }
});

test('case 8b PreToolUse shell belt coerces bootstrap SIGKILL status 137 to block', {
  skip: process.platform === 'win32' ? 'POSIX signal contract' : false,
}, (t) => {
  const fixture = makeFixture(t);
  const bootstrap = path.join(fixture.root, 'hooks', 'scripts', 'hook-bootstrap.js');
  fs.writeFileSync(bootstrap,
    "module.exports={main:function(){process.kill(process.pid,'SIGKILL')}};\n");
  const entry = registeredEntries().find(({ mode }) => mode === 'pre-tool-use');
  const result = runRegistered(entry, {
    cwd: fixture.base,
    env: { PLUGIN_ROOT: fixture.root },
  });
  assert.equal(result.status, 2, resultDetail(entry, result));
  assert.match(result.stderr, /137/, resultDetail(entry, result));
});

test('case 9 relative and non-qualified roots never execute workspace decoys', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-work-relative-trap-'));
  const cwd = path.join(base, 'work');
  const marker = path.join(base, 'decoy-ran');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const root of [cwd, base]) {
    fs.mkdirSync(path.join(root, 'hooks', 'scripts'), { recursive: true });
    for (const target of ['hook-bootstrap.js', 'hook-shell-adapter.js', 'session-start-adapter.js', 'sensor-trigger.js']) {
      fs.writeFileSync(path.join(root, 'hooks', 'scripts', target),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');module.exports={main:function(){process.exitCode=0}};\n`);
    }
  }
  for (const badRoot of ['..', '.', 'x/..']) {
    for (const entry of registeredEntries()) {
      fs.rmSync(marker, { force: true });
      const result = runRegistered(entry, {
        cwd,
        env: { PLUGIN_ROOT: badRoot },
      });
      assert.equal(result.status, entry.fail, resultDetail(entry, result));
      assert.match(result.stderr, /not a fully qualified/, resultDetail(entry, result));
      assert.equal(fs.existsSync(marker), false, `${badRoot}: ${entry.mode}`);
    }
  }
});

test('case 10 missing node executable follows each event failure policy', (t) => {
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-work-empty-path-'));
  t.after(() => fs.rmSync(emptyPath, { recursive: true, force: true }));
  for (const entry of registeredEntries()) {
    const result = runRegistered(entry, {
      cwd: emptyPath,
      env: { PATH: emptyPath, PLUGIN_ROOT: PLUGIN_ROOT },
    });
    assert.equal(result.status, entry.fail, resultDetail(entry, result));
    assert.match(result.stderr, /deep-work hook bootstrap/, resultDetail(entry, result));
    if (process.platform !== 'win32') {
      assert.match(result.stderr, /node executable not found/, resultDetail(entry, result));
    }
  }
});

test('case 10b statuses 126 and 127 preserve exact modes and block PreToolUse', (t) => {
  const fixture = makeFixture(t);
  for (const status of [126, 127]) {
    for (const entry of registeredEntries()) {
      const result = runRegistered(entry, {
        cwd: fixture.base,
        env: { PLUGIN_ROOT: fixture.root, FIXTURE_CHILD_EXIT: String(status) },
      });
      const expected = entry.mode === 'pre-tool-use' ? 2 : status;
      assert.equal(result.status, expected, resultDetail(entry, result));
      if (entry.mode === 'pre-tool-use') assert.match(result.stderr, new RegExp(String(status)));
    }
  }
});

test('case 11 trailing-space root is preserved and its trimmed sibling is ignored', {
  skip: process.platform === 'win32' ? 'NTFS trailing-space contract is unsupported' : false,
}, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-work-trailing-space-'));
  const realRoot = path.join(base, 'dw ');
  const sibling = path.join(base, 'dw');
  populateFixtureRoot(realRoot);
  populateFixtureRoot(sibling);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const entry of registeredEntries()) {
    clearCaptures(realRoot);
    clearCaptures(sibling);
    const result = runRegistered(entry, {
      cwd: base,
      env: { CLAUDE_PLUGIN_ROOT: realRoot },
    });
    assertSuccessfulCapture(entry, result, realRoot);
    assert.equal(captures(sibling).length, 0, entry.mode);
  }
});

// Native Windows coverage intentionally carries one remaining assumption: Git
// Bash/MSYS coreutils must accept the spaced, non-ASCII TRACKER_DUMP path. The
// required windows-latest job is the evidence gate for that host behavior.
test('PostToolUse registered command forwards identical input to both real adapter consumers', (t) => {
  const fixture = makeFixture(t);
  const scripts = path.join(fixture.root, 'hooks', 'scripts');
  fs.copyFileSync(path.join(__dirname, 'hook-shell-adapter.js'),
    path.join(scripts, 'hook-shell-adapter.js'));
  fs.writeFileSync(path.join(scripts, 'file-tracker.sh'),
    '#!/bin/sh\nnode -e "require(\'node:fs\').writeFileSync(process.env.TRACKER_DUMP, require(\'node:fs\').readFileSync(0))"\n');
  fs.writeFileSync(path.join(scripts, 'phase-transition.sh'),
    '#!/bin/sh\nprintf %s "$CLAUDE_TOOL_INPUT" > "$TRANSITION_DUMP"\n');
  const trackerDump = path.join(fixture.base, 'tracker.bin');
  const transitionDump = path.join(fixture.base, 'transition.bin');
  const entry = registeredEntries().find(({ mode }) => mode === 'post-tool-main');
  const result = runRegistered(entry, {
    cwd: fixture.base,
    env: {
      PLUGIN_ROOT: fixture.root,
      TRACKER_DUMP: trackerDump,
      TRANSITION_DUMP: transitionDump,
    },
  });
  assert.equal(result.status, 0, resultDetail(entry, result));
  assert.deepEqual(fs.readFileSync(trackerDump), STDIN_SENTINEL);
  assert.deepEqual(fs.readFileSync(transitionDump), STDIN_SENTINEL);
});

test('Windows shell adapter converts drive-letter, UNC, and spaced paths for Git Bash', () => {
  const { toGitBashPath } = require('./hook-shell-adapter.js');

  assert.equal(
    toGitBashPath('C:\\Users\\Codex User\\.codex\\plugins\\deep-work\\hooks\\scripts\\phase-guard.sh'),
    '/c/Users/Codex User/.codex/plugins/deep-work/hooks/scripts/phase-guard.sh',
  );
  assert.equal(
    toGitBashPath('\\\\server\\share name\\deep-work\\hooks\\scripts\\session-end.sh'),
    '//server/share name/deep-work/hooks/scripts/session-end.sh',
  );
});

test('Windows shell adapter selects Git for Windows without probing PATH bash', () => {
  const { resolveBashExecutable } = require('./hook-shell-adapter.js');
  const calls = [];
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const result = resolveBashExecutable({
    platform: 'win32',
    env: {},
    exists: (candidate) => candidate === gitBash,
    run: (executable, args) => {
      calls.push([executable, args]);
      assert.equal(executable, 'git');
      assert.deepEqual(args, ['--exec-path']);
      return {
        status: 0,
        stdout: 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core\r\n',
        stderr: '',
      };
    },
  });

  assert.equal(result, gitBash);
  assert.deepEqual(calls, [['git', ['--exec-path']]]);
  assert.equal(calls.some(([executable]) => /bash/i.test(executable)), false);
});

test('Windows shell adapter fails immediately with a specific unsupported-runtime error', () => {
  const { runHookScript } = require('./hook-shell-adapter.js');
  const result = runHookScript('session-end', {
    platform: 'win32',
    pluginRoot: 'C:\\Users\\Codex User\\.codex\\plugins\\deep-work\\6.13.0',
    env: {},
    exists: () => false,
    run: (executable, args) => {
      assert.equal(executable, 'git');
      assert.deepEqual(args, ['--exec-path']);
      return { status: 1, stdout: '', stderr: '' };
    },
    capture: true,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Git for Windows Bash was not found/);
  assert.match(result.stderr, /session-end/);
  assert.doesNotMatch(result.stderr, /timed out/i);
});

test('Windows StopHook uses the resolved Git Bash and preserves the script exit code', () => {
  const { runHookScript } = require('./hook-shell-adapter.js');
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const calls = [];
  const result = runHookScript('session-end', {
    platform: 'win32',
    pluginRoot: 'C:\\Users\\Codex User\\.codex\\plugins\\deep work\\6.13.0',
    cwd: 'C:\\Users\\Codex User\\repo with spaces',
    env: {},
    exists: (candidate) => candidate === gitBash,
    run: (executable, args, options) => {
      if (executable === 'git') {
        return {
          status: 0,
          stdout: 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core\r\n',
          stderr: '',
        };
      }
      calls.push({ executable, args, options });
      return { status: 7, stdout: '', stderr: 'stop failed\n' };
    },
    capture: true,
  });

  assert.equal(result.status, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, gitBash);
  assert.deepEqual(calls[0].args, [
    '/c/Users/Codex User/.codex/plugins/deep work/6.13.0/hooks/scripts/session-end.sh',
  ]);
  assert.equal(calls[0].options.cwd, 'C:\\Users\\Codex User\\repo with spaces');
  assert.equal(calls[0].options.shell, false);
});

test('PostToolUse adapter forwards one input to file tracking and phase transition', () => {
  const { runPostToolHooks } = require('./hook-shell-adapter.js');
  const input = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: '/repo/.claude/deep-work.local.md', content: 'x' },
  });
  const calls = [];
  const result = runPostToolHooks({
    bashExecutable: '/opt/git/bin/bash',
    capture: true,
    cwd: '/repo',
    env: {},
    input,
    pluginRoot: '/plugin root',
    run: (executable, args, options) => {
      calls.push({ executable, args, options });
      if (args[0].endsWith('/file-tracker.sh')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0].endsWith('/phase-transition.sh')) {
        return { status: 0, stdout: 'Phase Transition', stderr: '' };
      }
      throw new Error(`unexpected command: ${executable} ${args.join(' ')}`);
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Phase Transition');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.input, input);
  assert.equal(calls[1].options.env.CLAUDE_TOOL_INPUT, input);
  assert.equal(calls[0].options.cwd, calls[1].options.cwd);
});

test('native adapter executes PreToolUse, PostToolUse, and StopHook end to end', (t) => {
  const {
    runHookScript,
    runPostToolHooks,
  } = require('./hook-shell-adapter.js');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-work-hook-runtime-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const sessionId = 's-portable';
  const claudeDir = path.join(fixtureRoot, '.claude');
  const stateFile = path.join(claudeDir, `deep-work.${sessionId}.md`);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'deep-work-current-session'), sessionId);
  fs.writeFileSync(stateFile, [
    '---',
    'current_phase: plan',
    'work_dir: ""',
    'worktree_enabled: true',
    `worktree_path: "${fixtureRoot}"`,
    'team_mode: team',
    'task_description: "Windows hook portability fixture"',
    '---',
    '',
  ].join('\n'));

  const env = scrubHostEnv({ DEEP_WORK_SESSION_ID: sessionId });
  const pre = runHookScript('phase-guard', {
    capture: true,
    cwd: fixtureRoot,
    env,
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
    }),
  });
  assert.equal(pre.status, 0, pre.stderr);

  const post = runPostToolHooks({
    capture: true,
    cwd: fixtureRoot,
    env,
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: stateFile, content: 'fixture' },
    }),
  });
  assert.equal(post.status, 0, post.stderr);
  assert.match(post.stdout, /Phase Transition/);
  assert.match(post.stdout, /team_mode: team/);

  const stop = runHookScript('session-end', {
    capture: true,
    cwd: fixtureRoot,
    env,
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /Deep Work/);

  const sensorDetect = runSessionStartAdapterForTest('sensor-detect', {
    cwd: fixtureRoot,
    env,
  });
  assert.equal(sensorDetect.status, 0, sensorDetect.stderr);

  const sensorTrigger = spawnSync(process.execPath, [
    path.join(PLUGIN_ROOT, 'hooks', 'scripts', 'sensor-trigger.js'),
  ], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env,
    shell: false,
  });
  assert.equal(sensorTrigger.status, 0, sensorTrigger.stderr);
});

function runSessionStartAdapterForTest(mode, options) {
  const { runSessionStartAdapter } = require('./session-start-adapter.js');
  return runSessionStartAdapter(mode, options);
}

test('SessionStart adapter emits the shared Claude and Codex additionalContext contract', () => {
  const { runSessionStartAdapter } = require('./session-start-adapter.js');
  const result = runSessionStartAdapter('update-check', {
    run: () => ({ status: 0, stdout: 'UPGRADE_AVAILABLE 6.12.0 6.13.0\n', stderr: '' }),
  });

  assert.equal(result.status, 0);
  assert.deepEqual(result.output, {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'UPGRADE_AVAILABLE 6.12.0 6.13.0',
    },
  });
});

test('SessionStart adapter stays silent when its probe has no context', () => {
  const { runSessionStartAdapter } = require('./session-start-adapter.js');
  const result = runSessionStartAdapter('sensor-detect', {
    run: () => ({ status: 0, stdout: '', stderr: '' }),
  });

  assert.deepEqual(result, { status: 0, output: null, stderr: '' });
});
