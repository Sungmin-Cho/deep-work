const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  TDD_STATES,
  isValidTransition,
  checkTddEnforcement,
  detectBashFileWrite,
  splitCommands,
  extractBashTargetFile,
  checkSliceScope,
  validateReceipt,
  isTestFilePath,
  isExemptFile,
  processHook,
  lookupModel,
  validateModelName,
  DEFAULT_ROUTING_TABLE,
} = require('./phase-guard-core.js');

// ─── TDD State Machine Tests (8 tests) ──────────────────────

describe('TDD State Machine', () => {
  it('PENDING → RED: test file edit triggers transition', () => {
    assert.ok(isValidTransition('PENDING', 'RED'));
    assert.ok(!isValidTransition('PENDING', 'GREEN'));
  });

  it('RED → RED_VERIFIED: recording failing test output', () => {
    assert.ok(isValidTransition('RED', 'RED_VERIFIED'));
    assert.ok(!isValidTransition('RED', 'GREEN'));
  });

  it('RED_VERIFIED → GREEN_ELIGIBLE: production edit allowed', () => {
    assert.ok(isValidTransition('RED_VERIFIED', 'GREEN_ELIGIBLE'));
    const result = checkTddEnforcement('RED_VERIFIED', 'src/app.ts', 'strict', []);
    assert.ok(result.allowed);
  });

  it('PENDING blocks production file edits in strict mode', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.ts', 'strict', []);
    assert.ok(!result.allowed);
    assert.ok(result.reason.includes('TDD 강제'));
    assert.ok(result.reason.includes('/deep-slice spike'));
  });

  it('RED blocks production file edits (need failing test first)', () => {
    const result = checkTddEnforcement('RED', 'src/handler.ts', 'strict', []);
    assert.ok(!result.allowed);
  });

  it('SPIKE mode allows all edits', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.ts', 'spike', []);
    assert.ok(result.allowed);
  });

  it('coaching mode blocks with educational message', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.ts', 'coaching', []);
    assert.ok(!result.allowed);
    assert.ok(result.reason.includes('코칭'));
    assert.ok(result.reason.includes('/deep-slice spike'));
  });

  it('test files always allowed regardless of TDD state', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.test.ts', 'strict', []);
    assert.ok(result.allowed);
  });
});

// ─── Bash Command Detection Tests (5 tests) ─────────────────

describe('Bash Command Detection', () => {
  it('detects echo with redirect as file write', () => {
    const result = detectBashFileWrite("echo 'hello' > file.ts");
    assert.ok(result.isFileWrite);
  });

  it('allows cat without redirect (read only)', () => {
    const result = detectBashFileWrite('cat file.ts');
    assert.ok(!result.isFileWrite);
  });

  it('allows npm test (test execution)', () => {
    const result = detectBashFileWrite('npm test');
    assert.ok(!result.isFileWrite);
  });

  it('detects sed -i as file write', () => {
    const result = detectBashFileWrite("sed -i 's/old/new/' file.ts");
    assert.ok(result.isFileWrite);
  });

  it('detects cp as file write', () => {
    const result = detectBashFileWrite('cp source.ts dest.ts');
    assert.ok(result.isFileWrite);
  });
});

// ─── Cross-Model Review Tool Tests (v4.2) ───────────────────

describe('Cross-Model Review Safe Patterns', () => {
  it('allows codex exec (adversarial review)', () => {
    const result = detectBashFileWrite('codex exec "Review this plan document"');
    assert.ok(!result.isFileWrite);
  });

  it('allows timeout + codex exec', () => {
    const result = detectBashFileWrite('timeout 120 codex exec "$(cat /tmp/dw-review-abc.txt)" -s read-only');
    assert.ok(!result.isFileWrite);
  });

  it('allows gemini exec', () => {
    const result = detectBashFileWrite('gemini exec "Review this plan"');
    assert.ok(!result.isFileWrite);
  });

  it('allows gemini -p (fallback mode)', () => {
    const result = detectBashFileWrite('gemini -p "Review this plan"');
    assert.ok(!result.isFileWrite);
  });

  it('allows which codex/gemini (tool detection)', () => {
    assert.ok(!detectBashFileWrite('which codex').isFileWrite);
    assert.ok(!detectBashFileWrite('which gemini').isFileWrite);
  });

  it('allows mktemp (prompt temp file creation)', () => {
    const result = detectBashFileWrite('mktemp /tmp/dw-review-XXXXXXXX.txt');
    assert.ok(!result.isFileWrite);
  });

  it('allows codex --version (tool verification)', () => {
    assert.ok(!detectBashFileWrite('codex --version').isFileWrite);
    assert.ok(!detectBashFileWrite('gemini --version').isFileWrite);
  });
});

// ─── Slice Scope Tests ───────────────────────────────────────

describe('Slice Scope', () => {
  it('file in active slice is allowed', () => {
    const result = checkSliceScope('/project/src/auth.ts', ['src/auth.ts'], false);
    assert.ok(result.inScope);
  });

  it('file outside slice gets warning (default)', () => {
    const result = checkSliceScope('/project/src/other.ts', ['src/auth.ts'], false);
    assert.ok(!result.inScope);
    assert.ok(result.message.includes('경고'));
  });

  it('file outside slice gets blocked (strict)', () => {
    const result = checkSliceScope('/project/src/other.ts', ['src/auth.ts'], true);
    assert.ok(!result.inScope);
    assert.ok(result.message.includes('위반'));
  });
});

// ─── Receipt Validation Tests ────────────────────────────────

describe('Receipt Validation', () => {
  it('valid receipt passes', () => {
    const receipt = { slice_id: 'SLICE-001', status: 'complete', tdd_state: 'GREEN' };
    const result = validateReceipt(receipt);
    assert.ok(result.valid);
  });

  it('missing slice_id fails', () => {
    const receipt = { status: 'complete' };
    const result = validateReceipt(receipt);
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('Missing slice_id'));
  });

  it('invalid status fails', () => {
    const receipt = { slice_id: 'SLICE-001', status: 'unknown' };
    const result = validateReceipt(receipt);
    assert.ok(!result.valid);
  });
});

// ─── Exempt File Tests ───────────────────────────────────────

describe('Exempt Files', () => {
  it('yml files are exempt from TDD', () => {
    assert.ok(isExemptFile('config.yml', []));
    assert.ok(isExemptFile('docker-compose.yaml', []));
  });

  it('md files are exempt from TDD', () => {
    assert.ok(isExemptFile('README.md', []));
  });

  it('ts files are NOT exempt', () => {
    assert.ok(!isExemptFile('src/app.ts', []));
  });

  it('test files are detected', () => {
    assert.ok(isTestFilePath('src/app.test.ts'));
    assert.ok(isTestFilePath('test/handler.spec.js'));
    assert.ok(isTestFilePath('tests/test_auth.py'));
    assert.ok(!isTestFilePath('src/app.ts'));
  });
});

// ─── Integration: processHook Tests ──────────────────────────

describe('processHook', () => {
  it('blocks Write in research phase', () => {
    const result = processHook({
      action: 'pre', toolName: 'Write',
      toolInput: { file_path: 'src/app.ts' },
      state: { current_phase: 'research' },
    });
    // Write in research is handled by bash fast path, Node.js just sees Bash
    assert.equal(result.decision, 'allow');
  });

  it('blocks Bash file write in research phase', () => {
    const result = processHook({
      action: 'pre', toolName: 'Bash',
      toolInput: { command: "echo 'x' > src/app.ts" },
      state: { current_phase: 'research' },
    });
    assert.equal(result.decision, 'block');
  });

  it('allows Bash read in research phase', () => {
    const result = processHook({
      action: 'pre', toolName: 'Bash',
      toolInput: { command: 'cat src/app.ts' },
      state: { current_phase: 'research' },
    });
    assert.equal(result.decision, 'allow');
  });

  it('allows edit in implement with valid TDD state', () => {
    const result = processHook({
      action: 'pre', toolName: 'Write',
      toolInput: { file_path: 'src/auth.ts' },
      state: {
        current_phase: 'implement',
        tdd_mode: 'strict',
        tdd_state: 'RED_VERIFIED',
        active_slice: 'SLICE-001',
        slice_files: ['src/auth.ts'],
      },
    });
    assert.equal(result.decision, 'allow');
  });

  it('blocks edit in implement with PENDING TDD state', () => {
    const result = processHook({
      action: 'pre', toolName: 'Write',
      toolInput: { file_path: 'src/auth.ts' },
      state: {
        current_phase: 'implement',
        tdd_mode: 'strict',
        tdd_state: 'PENDING',
        active_slice: 'SLICE-001',
        slice_files: ['src/auth.ts'],
      },
    });
    assert.equal(result.decision, 'block');
  });

  it('allows everything in idle phase', () => {
    const result = processHook({
      action: 'pre', toolName: 'Write',
      toolInput: { file_path: 'anything.ts' },
      state: { current_phase: 'idle' },
    });
    assert.equal(result.decision, 'allow');
  });
});

// ─── Model Routing Tests (v4.1) ─────────────────────────────

describe('Model Routing', () => {
  it('S → haiku', () => {
    const result = lookupModel('S');
    assert.equal(result.model, 'haiku');
    assert.ok(result.valid);
  });

  it('M → sonnet', () => {
    const result = lookupModel('M');
    assert.equal(result.model, 'sonnet');
    assert.ok(result.valid);
  });

  it('L → sonnet', () => {
    const result = lookupModel('L');
    assert.equal(result.model, 'sonnet');
    assert.ok(result.valid);
  });

  it('XL → opus', () => {
    const result = lookupModel('XL');
    assert.equal(result.model, 'opus');
    assert.ok(result.valid);
  });

  it('undefined size defaults to M → sonnet', () => {
    const result = lookupModel(undefined);
    assert.equal(result.model, 'sonnet');
  });

  it('custom routing table overrides defaults', () => {
    const result = lookupModel('S', { S: 'sonnet', L: 'opus' });
    assert.equal(result.model, 'sonnet');
  });

  it('invalid size falls back to M', () => {
    const result = lookupModel('XXL');
    assert.ok(!result.valid);
    assert.equal(result.model, 'sonnet');
  });
});

describe('Model Name Validation', () => {
  it('valid model names pass', () => {
    assert.ok(validateModelName('haiku').valid);
    assert.ok(validateModelName('sonnet').valid);
    assert.ok(validateModelName('opus').valid);
    assert.ok(validateModelName('main').valid);
    assert.ok(validateModelName('auto').valid);
  });

  it('invalid model name returns fallback sonnet', () => {
    const result = validateModelName('gpt-4');
    assert.ok(!result.valid);
    assert.equal(result.fallback, 'sonnet');
  });

  it('null/undefined returns fallback', () => {
    assert.ok(!validateModelName(null).valid);
    assert.ok(!validateModelName(undefined).valid);
  });

  it('case insensitive', () => {
    assert.ok(validateModelName('Haiku').valid);
    assert.ok(validateModelName('SONNET').valid);
  });
});

// ─── TDD Override Tests (v4.3) ──────────────────────────────

describe('TDD Override', () => {
  it('override allows production edit in strict mode with PENDING state', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.ts', 'strict', [], true);
    assert.ok(result.allowed);
  });

  it('override allows production edit in coaching mode with PENDING state', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.ts', 'coaching', [], true);
    assert.ok(result.allowed);
  });

  it('no override (undefined) preserves existing strict block', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.ts', 'strict', [], undefined);
    assert.ok(!result.allowed);
  });

  it('override false preserves existing strict block', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.ts', 'strict', [], false);
    assert.ok(!result.allowed);
  });

  it('override with relaxed mode still allows (relaxed checked first)', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.ts', 'relaxed', [], true);
    assert.ok(result.allowed);
  });

  it('override with spike mode still allows (spike checked first)', () => {
    const result = checkTddEnforcement('PENDING', 'src/app.ts', 'spike', [], true);
    assert.ok(result.allowed);
  });

  it('processHook: implement + override allows production edit', () => {
    const result = processHook({
      action: 'pre', toolName: 'Write',
      toolInput: { file_path: 'src/auth.ts' },
      state: {
        current_phase: 'implement',
        tdd_mode: 'strict',
        tdd_state: 'PENDING',
        active_slice: 'SLICE-001',
        slice_files: ['src/auth.ts'],
        tdd_override: true,
      },
    });
    assert.equal(result.decision, 'allow');
  });

  it('processHook: implement + Bash file write + override allows', () => {
    const result = processHook({
      action: 'pre', toolName: 'Bash',
      toolInput: { command: "echo 'x' > src/app.ts" },
      state: {
        current_phase: 'implement',
        tdd_mode: 'strict',
        tdd_state: 'PENDING',
        tdd_override: true,
      },
    });
    assert.equal(result.decision, 'allow');
  });

  it('processHook: research + override still blocks (override is implement-only)', () => {
    const result = processHook({
      action: 'pre', toolName: 'Bash',
      toolInput: { command: "echo 'x' > src/app.ts" },
      state: {
        current_phase: 'research',
        tdd_override: true,
      },
    });
    assert.equal(result.decision, 'block');
  });
});

// ─── CLI Fail-Closed Tests (A-1) ───────────────────────────

describe('CLI fail-closed behavior', () => {
  const { execFileSync } = require('child_process');
  const scriptPath = require('path').join(__dirname, 'phase-guard-core.js');

  it('exits non-zero on invalid JSON input', () => {
    let exitCode = 0;
    let stdout = '';
    try {
      stdout = execFileSync('node', [scriptPath], {
        input: 'INVALID JSON',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      exitCode = err.status;
      stdout = err.stdout || '';
    }
    assert.notEqual(exitCode, 0);
    assert.ok(stdout.includes('block'), `expected stdout to contain "block", got: ${stdout}`);
  });

  it('exits non-zero on empty input', () => {
    let exitCode = 0;
    let stdout = '';
    try {
      stdout = execFileSync('node', [scriptPath], {
        input: '',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      exitCode = err.status;
      stdout = err.stdout || '';
    }
    assert.notEqual(exitCode, 0);
    assert.ok(stdout.includes('block'), `expected stdout to contain "block", got: ${stdout}`);
  });
});

// ─── extractBashTargetFile Tests (A-3) ─────────────────────

describe('extractBashTargetFile', () => {
  it('extracts file from sed -i', () => {
    assert.equal(extractBashTargetFile("sed -i 's/old/new/' src/app.ts"), 'src/app.ts');
  });

  it('extracts file from sed -i with backup extension', () => {
    assert.equal(extractBashTargetFile("sed -i.bak 's/old/new/' config.ts"), 'config.ts');
  });

  it('extracts file from tee', () => {
    assert.equal(extractBashTargetFile('echo hello | tee output.txt'), 'output.txt');
  });

  it('extracts file from tee -a (append)', () => {
    assert.equal(extractBashTargetFile('echo hello | tee -a log.txt'), 'log.txt');
  });

  it('extracts file from cp', () => {
    assert.equal(extractBashTargetFile('cp src/old.ts src/new.ts'), 'src/new.ts');
  });

  it('extracts file from mv', () => {
    assert.equal(extractBashTargetFile('mv temp.ts src/final.ts'), 'src/final.ts');
  });

  it('extracts file from redirect >', () => {
    assert.equal(extractBashTargetFile("echo 'data' > output.ts"), 'output.ts');
  });

  it('extracts file from redirect >>', () => {
    assert.equal(extractBashTargetFile("echo 'data' >> output.ts"), 'output.ts');
  });

  it('extracts file from dd of=', () => {
    assert.equal(extractBashTargetFile('dd if=/dev/zero of=output.bin bs=1024 count=1'), 'output.bin');
  });

  it('returns empty string for unrecognized command', () => {
    assert.equal(extractBashTargetFile('some-unknown-command'), '');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(extractBashTargetFile(null), '');
    assert.equal(extractBashTargetFile(undefined), '');
  });
});

// ─── splitCommands Tests (A-5) ─────────────────────────────

describe('splitCommands', () => {
  it('splits on &&', () => {
    assert.deepEqual(splitCommands('npm test && echo done'), ['npm test', 'echo done']);
  });

  it('splits on ||', () => {
    assert.deepEqual(splitCommands('npm test || echo fail'), ['npm test', 'echo fail']);
  });

  it('splits on ;', () => {
    assert.deepEqual(splitCommands('echo a; echo b'), ['echo a', 'echo b']);
  });

  it('splits on |', () => {
    assert.deepEqual(splitCommands('cat file.txt | grep test'), ['cat file.txt', 'grep test']);
  });

  it('respects single quotes', () => {
    assert.deepEqual(splitCommands("echo 'a && b'; echo c"), ["echo 'a && b'", 'echo c']);
  });

  it('respects double quotes', () => {
    assert.deepEqual(splitCommands('echo "a && b" && echo c'), ['echo "a && b"', 'echo c']);
  });

  it('handles multiple operators', () => {
    const result = splitCommands('a && b || c; d');
    assert.deepEqual(result, ['a', 'b', 'c', 'd']);
  });

  it('returns empty array for null/undefined', () => {
    assert.deepEqual(splitCommands(null), []);
    assert.deepEqual(splitCommands(undefined), []);
  });
});

// ─── detectBashFileWrite chained commands (A-5) ────────────

describe('detectBashFileWrite chained commands', () => {
  it('detects file write after safe command with &&', () => {
    const result = detectBashFileWrite("npm test && echo 'x' > evil.js");
    assert.ok(result.isFileWrite);
  });

  it('detects file write after safe command with ;', () => {
    const result = detectBashFileWrite("npm test; echo 'x' > evil.js");
    assert.ok(result.isFileWrite);
  });

  it('detects file write after safe command with ||', () => {
    const result = detectBashFileWrite("npm test || sed -i 's/a/b/' src/app.ts");
    assert.ok(result.isFileWrite);
  });

  it('allows pure safe chain', () => {
    const result = detectBashFileWrite('npm test && echo "done"');
    assert.ok(!result.isFileWrite);
  });

  it('detects file write piped after safe command', () => {
    const result = detectBashFileWrite('npm test | tee output.log');
    assert.ok(result.isFileWrite);
  });
});

// ─── Additional language test file patterns (A-6) ──────────

describe('Additional language test file patterns', () => {
  it('detects Rust test files', () => {
    assert.ok(isTestFilePath('src/parser_test.rs'));
  });

  it('detects Java test files', () => {
    assert.ok(isTestFilePath('src/main/java/AppTest.java'));
    assert.ok(isTestFilePath('src/test/java/AppTests.java'));
  });

  it('detects C# test files', () => {
    assert.ok(isTestFilePath('Tests/AppTest.cs'));
    assert.ok(isTestFilePath('Tests/AppTests.cs'));
  });

  it('detects Kotlin test files', () => {
    assert.ok(isTestFilePath('src/test/kotlin/AppTest.kt'));
  });

  it('detects Swift test files', () => {
    assert.ok(isTestFilePath('Tests/AppTest.swift'));
    assert.ok(isTestFilePath('Tests/AppTests.swift'));
  });
});

// ─── processHook regression: bash file write to production (A-3) ──

describe('processHook regression: bash file write TDD target extraction', () => {
  it('blocks bash write to production file even when command contains test keywords', () => {
    // Before fix: `toolInput.command` was used as the "file path",
    // so "npm test" in the command would match test patterns and allow.
    // After fix: extractBashTargetFile extracts the actual target file.
    const result = processHook({
      action: 'pre', toolName: 'Bash',
      toolInput: { command: "echo 'test result' > src/production.ts" },
      state: {
        current_phase: 'implement',
        tdd_mode: 'strict',
        tdd_state: 'PENDING',
      },
    });
    assert.equal(result.decision, 'block');
  });

  it('allows bash write to test file in implement phase with PENDING state', () => {
    const result = processHook({
      action: 'pre', toolName: 'Bash',
      toolInput: { command: "echo 'x' > src/app.test.ts" },
      state: {
        current_phase: 'implement',
        tdd_mode: 'strict',
        tdd_state: 'PENDING',
      },
    });
    assert.equal(result.decision, 'allow');
  });
});

// ─── v5.5.2: Runtime language file write detection ──────────

describe('v5.5.2: Runtime language file writes', () => {
  it('detects perl -pi -e in-place edit', () => {
    assert.ok(detectBashFileWrite("perl -pi -e 's/old/new/' file.ts").isFileWrite);
  });

  it('detects node -e fs.writeFileSync', () => {
    assert.ok(detectBashFileWrite("node -e \"require('fs').writeFileSync('f.ts','x')\"").isFileWrite);
  });

  it('detects python3 -c file write', () => {
    assert.ok(detectBashFileWrite("python3 -c \"open('f.ts','w').write('x')\"").isFileWrite);
  });

  it('detects ruby -e File.write', () => {
    assert.ok(detectBashFileWrite("ruby -e \"File.write('f.ts','x')\"").isFileWrite);
  });
});

// ─── v5.5.2: File-write-first detection order ───────────────

describe('v5.5.2: File-write patterns checked before safe patterns', () => {
  it('detects cat heredoc redirect despite cat being safe', () => {
    assert.ok(detectBashFileWrite("cat << 'EOF' > file.ts\ncontent\nEOF").isFileWrite);
  });

  it('still allows pure safe commands', () => {
    assert.ok(!detectBashFileWrite('npm test').isFileWrite);
    assert.ok(!detectBashFileWrite('git status').isFileWrite);
  });
});

// ─── v5.5.2: Extended test/exempt file patterns ─────────────

describe('v5.5.2: Extended test file patterns', () => {
  it('detects Dart test files', () => {
    assert.ok(isTestFilePath('test/widget_test.dart'));
    assert.ok(isTestFilePath('test/app.test.dart'));
  });

  it('detects Elixir test files', () => {
    assert.ok(isTestFilePath('test/app_test.exs'));
  });

  it('detects files in fixtures/ and __mocks__/', () => {
    assert.ok(isTestFilePath('fixtures/data.json'));
    assert.ok(isTestFilePath('__mocks__/api.js'));
  });
});

describe('v5.5.2: Extended exempt file patterns', () => {
  it('exempts .toml files', () => {
    assert.ok(isExemptFile('pyproject.toml'));
  });

  it('exempts .lock files', () => {
    assert.ok(isExemptFile('package-lock.json'));
    assert.ok(isExemptFile('yarn.lock'));
  });

  it('exempts image files', () => {
    assert.ok(isExemptFile('logo.svg'));
    assert.ok(isExemptFile('photo.png'));
  });
});

// ─── Sensor TDD States ──────────────────────────────────────

describe('Sensor TDD States', () => {
  // Valid transitions (7)
  it('GREEN → SENSOR_RUN: valid transition', () => {
    assert.ok(isValidTransition('GREEN', 'SENSOR_RUN'));
  });

  it('SENSOR_RUN → SENSOR_FIX: valid transition', () => {
    assert.ok(isValidTransition('SENSOR_RUN', 'SENSOR_FIX'));
  });

  it('SENSOR_RUN → SENSOR_CLEAN: valid transition', () => {
    assert.ok(isValidTransition('SENSOR_RUN', 'SENSOR_CLEAN'));
  });

  it('SENSOR_FIX → GREEN: valid transition', () => {
    assert.ok(isValidTransition('SENSOR_FIX', 'GREEN'));
  });

  it('SENSOR_FIX → RED: valid transition', () => {
    assert.ok(isValidTransition('SENSOR_FIX', 'RED'));
  });

  it('SENSOR_CLEAN → REFACTOR: valid transition', () => {
    assert.ok(isValidTransition('SENSOR_CLEAN', 'REFACTOR'));
  });

  it('SENSOR_CLEAN → PENDING: valid transition', () => {
    assert.ok(isValidTransition('SENSOR_CLEAN', 'PENDING'));
  });

  // Invalid transitions (2)
  it('SENSOR_RUN → REFACTOR: invalid (must go through SENSOR_CLEAN)', () => {
    assert.ok(!isValidTransition('SENSOR_RUN', 'REFACTOR'));
  });

  it('SENSOR_FIX → SENSOR_CLEAN: invalid (must go through GREEN first)', () => {
    assert.ok(!isValidTransition('SENSOR_FIX', 'SENSOR_CLEAN'));
  });

  // Production code permissions (2)
  it('SENSOR_FIX allows production file edits (mechanical lint/type fixes)', () => {
    const result = checkTddEnforcement('SENSOR_FIX', 'src/app.ts', 'strict', []);
    assert.ok(result.allowed);
  });

  it('SENSOR_RUN blocks production file edits (sensor is running, no edits)', () => {
    const result = checkTddEnforcement('SENSOR_RUN', 'src/app.ts', 'strict', []);
    assert.ok(!result.allowed);
  });

  // Receipt validation (1)
  it('validateReceipt accepts SENSOR_CLEAN as valid tdd_state', () => {
    const receipt = { slice_id: 'SLICE-001', status: 'complete', tdd_state: 'SENSOR_CLEAN' };
    const result = validateReceipt(receipt);
    assert.ok(result.valid);
  });

  // Backward compatibility (3)
  it('GREEN → REFACTOR still valid (for sensor-not-installed projects)', () => {
    assert.ok(isValidTransition('GREEN', 'REFACTOR'));
  });

  it('GREEN → PENDING still valid (skip to next slice)', () => {
    assert.ok(isValidTransition('GREEN', 'PENDING'));
  });

  it('GREEN → SPIKE still valid', () => {
    assert.ok(isValidTransition('GREEN', 'SPIKE'));
  });
});

// ─── v5.5.2: TDD state validation ──────────────────────────

describe('v5.5.2: TDD state validation in processHook', () => {
  it('blocks unknown TDD state', () => {
    const result = processHook({
      action: 'pre', toolName: 'Edit',
      toolInput: { file_path: 'src/main.ts' },
      state: { current_phase: 'implement', tdd_mode: 'strict', tdd_state: 'INVALID_STATE' },
    });
    assert.equal(result.decision, 'block');
  });
});

// ─── v5.5.2: Backtick and subshell handling ─────────────────

describe('v5.5.2: splitCommands backtick/subshell', () => {
  it('does not split inside backticks', () => {
    const parts = splitCommands('echo `a && b`');
    assert.equal(parts.length, 1);
  });

  it('does not split inside $() subshell', () => {
    const parts = splitCommands('echo $(a && b)');
    assert.equal(parts.length, 1);
  });

  it('handles nested $() correctly', () => {
    const parts = splitCommands('echo $(echo $(echo ok))');
    assert.equal(parts.length, 1);
  });
});

// ─── v5.5.2: Perl target extraction ────────────────────────

describe('v5.5.2: extractBashTargetFile perl', () => {
  it('extracts target from perl -pi -e', () => {
    const target = extractBashTargetFile("perl -pi -e 's/old/new/' src/main.ts");
    assert.equal(target, 'src/main.ts');
  });
});

// ─── v5.6: Artifacts-only fork phase restriction ──────────

describe('artifacts-only fork phase restriction', () => {
  it('should block implement phase for artifacts-only fork', () => {
    const result = processHook({
      action: 'pre', toolName: 'Write',
      toolInput: { file_path: 'src/main.js' },
      state: { current_phase: 'implement', tdd_mode: 'relaxed', tdd_state: 'RED_VERIFIED', fork_mode: 'artifacts-only' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /Non-git fork|plan/);
  });

  it('should block test phase for artifacts-only fork', () => {
    const result = processHook({
      action: 'pre', toolName: 'Bash',
      toolInput: { command: 'npm test' },
      state: { current_phase: 'test', fork_mode: 'artifacts-only' },
    });
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /Non-git fork|plan/);
  });

  it('should allow plan phase for artifacts-only fork', () => {
    const result = processHook({
      action: 'pre', toolName: 'Write',
      toolInput: { file_path: '.deep-work/plan.md' },
      state: { current_phase: 'plan', fork_mode: 'artifacts-only' },
    });
    assert.notEqual(result.reason?.includes('Non-git fork'), true);
  });

  it('should allow implement phase for worktree fork', () => {
    const result = processHook({
      action: 'pre', toolName: 'Write',
      toolInput: { file_path: 'src/main.js' },
      state: { current_phase: 'implement', tdd_mode: 'relaxed', tdd_state: 'RED_VERIFIED', fork_mode: 'worktree' },
    });
    assert.equal(result.decision, 'allow');
  });

  it('should allow implement phase when fork_mode is not set', () => {
    const result = processHook({
      action: 'pre', toolName: 'Write',
      toolInput: { file_path: 'src/main.js' },
      state: { current_phase: 'implement', tdd_mode: 'relaxed', tdd_state: 'RED_VERIFIED' },
    });
    assert.equal(result.decision, 'allow');
  });
});

// ─── FILE_WRITE_PATTERNS false positives / negatives (issue #75) ──────────
//
// The guard blocked ordinary read-only Bash during non-implement phases.
// SAFE_COMMAND_PATTERNS cannot rescue these: detectBashFileWrite checks the
// write patterns first and returns immediately.

describe('detectBashFileWrite — fd-numbered redirects are not file writes (issue #75.1)', () => {
  it('allows a stderr redirect to /dev/null on cat', () => {
    assert.equal(detectBashFileWrite('cat pkg.json 2>/dev/null | grep name').isFileWrite, false);
  });

  it('allows a stderr redirect inside command substitution on echo', () => {
    assert.equal(detectBashFileWrite('echo "n=$(ls a* 2>/dev/null | wc -l)"').isFileWrite, false);
  });

  it('allows a stderr redirect on printf', () => {
    assert.equal(detectBashFileWrite('printf "%s" "$x" 2>/dev/null').isFileWrite, false);
  });

  it('allows an fd duplication', () => {
    assert.equal(detectBashFileWrite('ls -la 2>&1 | head').isFileWrite, false);
  });
});

describe('detectBashFileWrite — /dev/null is not a file write (issue #75.2)', () => {
  it('allows discarding stdout to /dev/null', () => {
    assert.equal(detectBashFileWrite('ls > /dev/null').isFileWrite, false);
  });

  it('allows discarding both streams to /dev/null', () => {
    assert.equal(detectBashFileWrite('make check >/dev/null 2>&1').isFileWrite, false);
  });
});

describe('detectBashFileWrite — command tokens in prose are not commands (issue #75.3)', () => {
  it('allows an issue body that mentions mv in English prose', () => {
    assert.equal(
      detectBashFileWrite('gh issue create --body "atomic temp write then mv on L63-67"').isFileWrite,
      false,
    );
  });

  it('allows a commit message containing the word patch', () => {
    assert.equal(detectBashFileWrite('git commit -m "patch the bug"').isFileWrite, false);
  });

  it('allows a commit message containing the word install', () => {
    assert.equal(detectBashFileWrite('git commit -m "install the plugin first"').isFileWrite, false);
  });

  it('still blocks mv in command position', () => {
    assert.equal(detectBashFileWrite('mv a.txt b.txt').isFileWrite, true);
  });

  it('still blocks mv after a privilege prefix', () => {
    assert.equal(detectBashFileWrite('sudo mv a.txt b.txt').isFileWrite, true);
  });

  it('still blocks mv in a shell-wrapper payload', () => {
    assert.equal(detectBashFileWrite('bash -c "mv a.txt b.txt"').isFileWrite, true);
  });

  it('still blocks cp after a chained safe command', () => {
    assert.equal(detectBashFileWrite('npm test && cp a.txt b.txt').isFileWrite, true);
  });
});

describe('detectBashFileWrite — ampersand redirect is a file write (issue #75.4)', () => {
  it('blocks the both-streams redirect form', () => {
    assert.equal(detectBashFileWrite('node app.js &> build.log').isFileWrite, true);
  });

  it('blocks the both-streams append form', () => {
    assert.equal(detectBashFileWrite('node app.js &>> build.log').isFileWrite, true);
  });
});

describe('detectBashFileWrite — real writes stay blocked (issue #75 regression guard)', () => {
  const blocked = [
    'echo hi > out.txt',
    'echo hi>out.txt',
    'echo hi >> out.txt',
    'cat a.txt > b.txt',
    'printf x > f',
    'tee out.txt',
    "sed -i 's/a/b/' f.txt",
  ];
  for (const cmd of blocked) {
    it(`blocks: ${cmd}`, () => {
      assert.equal(detectBashFileWrite(cmd).isFileWrite, true);
    });
  }
});
