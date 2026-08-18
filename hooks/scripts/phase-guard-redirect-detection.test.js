// Quote-aware redirect detection.
//
// v7.2.1 fixed the reported #75 cases but left the redirect family leaking in
// both directions, because one precondition served two jobs: the generic
// pattern demanded a separator immediately before `>` so that `->` in prose
// would not match. That same demand made every no-space redirect invisible
// (`git diff>patch.diff`) and, since prose lives in the raw string, `>=` and
// `=>` inside a commit message still read as writes.
//
// Splitting the two jobs resolves the tension: quoted literals are masked out
// before redirect matching (so prose cannot match at all), which in turn makes
// the separator demand unnecessary (so no-space and fd-numbered redirects are
// caught). Spans the shell really executes — command substitutions and
// `sh -c` payloads — stay live and are analysed as commands.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectBashFileWrite } = require('./phase-guard-core.js');

const blocks = (cmd) => assert.equal(detectBashFileWrite(cmd).isFileWrite, true, `must block: ${cmd}`);
const allows = (cmd) => assert.equal(detectBashFileWrite(cmd).isFileWrite, false, `must allow: ${cmd}`);

describe('redirect detection — no-space redirects are writes', () => {
  const cases = [
    'node app.js>out.log',
    'python gen.py>result.txt',
    'git diff>patch.diff',
    'jq . in.json>out.json',
    'curl https://example.com/a>a.html',
    'echo hi>out.txt',
    'node app.js>>out.log',
  ];
  for (const cmd of cases) {
    it(`blocks: ${cmd}`, () => blocks(cmd));
  }
});

describe('redirect detection — fd-numbered redirects to a real file are writes', () => {
  it('blocks a stderr redirect to a named file', () => blocks('cmd 2> err.log'));
  it('blocks a stderr append to a named file', () => blocks('node app.js 2>> err.log'));
  it('blocks a no-space stderr redirect', () => blocks('make 2>build-errors.txt'));
});

describe('redirect detection — discards and fd duplication stay read-only', () => {
  it('allows stdout discard', () => allows('ls > /dev/null'));
  it('allows both-stream discard', () => allows('make check >/dev/null 2>&1'));
  it('allows fd duplication', () => allows('ls -la 2>&1 | head'));
  it('allows stderr discard on cat', () => allows('cat pkg.json 2>/dev/null | grep name'));
  it('allows a redirect to stderr', () => allows('printf oops >&2'));
});

describe('redirect detection — redirect characters inside prose are inert', () => {
  it('allows a comparison in a commit message', () => allows('git commit -m "a > b 순서로 정렬"'));
  it('allows a version constraint in a commit message', () => allows('git commit -m "require node >= 22"'));
  it('allows a fat arrow in an echoed string', () => allows('echo "map: x => y"'));
  it('allows an arrow in an issue body', () => allows('gh issue create --body "foo -> bar 로 바뀐다"'));
  it('allows an arrow inside a search pattern', () => allows('grep -n "a->b" src/*.c'));
  it('allows a redirect character quoted as documentation', () => allows('git commit -m "use cmd > file to save"'));
});

describe('redirect detection — spans the shell executes stay live', () => {
  it('blocks a redirect inside a shell wrapper payload', () => blocks('bash -c "echo x > f"'));
  it('blocks a redirect inside a single-quoted shell wrapper payload', () => blocks("sh -c 'echo x > f'"));
  it('blocks a redirect inside a command substitution', () => blocks('echo "$(cat x > f)"'));
  it('blocks a redirect inside a backtick substitution', () => blocks('echo `cat x > f`'));
  it('allows a substitution that only discards', () => allows('echo "n=$(ls a* 2>/dev/null | wc -l)"'));
  it('allows a substitution spelled literally in single quotes', () => allows("echo '$(cat x > f)'"));
});

describe('redirect detection — 7.2.1 behaviour is preserved', () => {
  it('still blocks a spaced redirect', () => blocks('echo x > f'));
  it('still blocks an append', () => blocks('echo hi >> out.txt'));
  it('still blocks the both-streams form', () => blocks('node app.js &> build.log'));
  it('still blocks cat into a file', () => blocks('cat a.txt > b.txt'));
  it('still allows a plain pipe', () => allows('grep -rn foo . | head -20'));
  it('still allows prose naming a command token', () =>
    allows('gh issue create --body "atomic temp write then mv on L63-67"'));
  it('still blocks mv in command position', () => blocks('mv a.txt b.txt'));
  it('still blocks mv in a wrapper payload', () => blocks('bash -c "mv a b"'));
  it('still blocks an interpreter write in a quoted argument', () =>
    blocks('node -e "require(\'fs\').writeFileSync(\'f\',\'x\')"'));
});
