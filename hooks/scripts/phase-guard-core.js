#!/usr/bin/env node
/**
 * phase-guard-core.js — Node.js module for deep-work v4.0 Evidence-Driven Protocol
 *
 * Handles complex hook logic that bash cannot reliably do:
 * - TDD state machine enforcement
 * - Bash command file-write detection
 * - Receipt validation
 * - Slice scope enforcement
 *
 * Called by phase-guard.sh when the fast path (bash) determines
 * that complex validation is needed (implement phase, Bash tool).
 *
 * Input: JSON on stdin with { action, toolName, toolInput, state }
 * Output: JSON on stdout with { decision: "allow"|"block", reason?: string }
 */

const fs = require('fs');
const path = require('path');

// ─── TDD State Machine ───────────────────────────────────────

const TDD_STATES = {
  PENDING: 'PENDING',
  RED: 'RED',
  RED_VERIFIED: 'RED_VERIFIED',
  GREEN_ELIGIBLE: 'GREEN_ELIGIBLE',
  GREEN: 'GREEN',
  SENSOR_RUN: 'SENSOR_RUN',
  SENSOR_FIX: 'SENSOR_FIX',
  SENSOR_CLEAN: 'SENSOR_CLEAN',
  REFACTOR: 'REFACTOR',
  SPIKE: 'SPIKE',
};

const VALID_TRANSITIONS = {
  PENDING: ['RED', 'SPIKE'],
  RED: ['RED_VERIFIED', 'SPIKE'],
  RED_VERIFIED: ['GREEN_ELIGIBLE', 'SPIKE'],
  GREEN_ELIGIBLE: ['GREEN', 'SPIKE'],
  GREEN: ['SENSOR_RUN', 'REFACTOR', 'PENDING', 'SPIKE'],  // PENDING = next slice
  SENSOR_RUN: ['SENSOR_FIX', 'SENSOR_CLEAN'],
  SENSOR_FIX: ['GREEN', 'RED'],
  SENSOR_CLEAN: ['REFACTOR', 'PENDING', 'SPIKE'],
  REFACTOR: ['GREEN', 'PENDING', 'SPIKE'],
  SPIKE: ['PENDING'],  // exit spike → restart TDD
};

function isValidTransition(from, to) {
  if (!VALID_TRANSITIONS[from]) return false;
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Determines if a file edit should be allowed based on TDD state.
 * @param {string} tddState - Current TDD state of the active slice
 * @param {string} filePath - File being edited
 * @param {string} tddMode - Session TDD mode: strict|relaxed|coaching|spike
 * @param {string[]} exemptPatterns - File patterns exempt from TDD (e.g., *.yml)
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkTddEnforcement(tddState, filePath, tddMode, exemptPatterns, tddOverride) {
  // spike mode at session level = all edits allowed
  if (tddMode === 'spike') {
    return { allowed: true };
  }

  // relaxed mode = no TDD enforcement
  if (tddMode === 'relaxed') {
    return { allowed: true };
  }

  // TDD override = slice-level skip (user chose to bypass TDD via AskUserQuestion)
  if (tddOverride) {
    return { allowed: true };
  }

  // Check exempt file patterns
  if (isExemptFile(filePath, exemptPatterns)) {
    return { allowed: true };
  }

  const isTestFile = isTestFilePath(filePath);

  // Test files can always be edited (writing tests is always allowed)
  if (isTestFile) {
    return { allowed: true };
  }

  // Production file edits require RED_VERIFIED or later states
  const productionAllowedStates = [
    TDD_STATES.RED_VERIFIED,
    TDD_STATES.GREEN_ELIGIBLE,
    TDD_STATES.GREEN,
    TDD_STATES.SENSOR_FIX,
    TDD_STATES.REFACTOR,
    TDD_STATES.SPIKE,
  ];

  if (!productionAllowedStates.includes(tddState)) {
    const isCoaching = tddMode === 'coaching';
    if (isCoaching) {
      return {
        allowed: false,
        reason: `💡 TDD 코칭: 이 slice에서 먼저 테스트를 작성해보세요.\n` +
          `현재 상태: ${tddState} — 먼저 failing test를 작성하고 실행하면\n` +
          `production 코드를 수정할 수 있습니다.\n\n` +
          `팁: 어떤 동작을 테스트해야 할지 생각해보세요.\n\n` +
          `TDD를 건너뛰려면:\n` +
          `  /deep-slice spike SLICE-NNN — 이 slice만 자유 코딩 (merge 불가)\n` +
          `  /deep-slice reset SLICE-NNN — slice 리셋 후 재시작\n` +
          `  (auto-flow 사용 시 /deep-implement 내에서 자동 관리됩니다)`,
      };
    }
    return {
      allowed: false,
      reason: `⛔ TDD 강제: production 코드 수정이 차단되었습니다.\n` +
        `현재 TDD 상태: ${tddState}\n` +
        `먼저 failing test를 작성하고 실행하세요 (RED → RED_VERIFIED 필요).\n` +
        `파일: ${filePath}\n\n` +
        `TDD를 건너뛰려면:\n` +
        `  /deep-slice spike SLICE-NNN — 이 slice만 자유 코딩 (merge 불가)\n` +
        `  /deep-slice reset SLICE-NNN — slice 리셋 후 재시작\n` +
        `  (auto-flow 사용 시 /deep-implement 내에서 자동 관리됩니다)`,
    };
  }

  return { allowed: true };
}

// ─── Bash Command Detection ──────────────────────────────────

// ─── Write-pattern building blocks (issue #75) ────────────────
//
// A redirect writes a file only when its target is a real path. `/dev/null`
// discards output and `&1` duplicates a descriptor; neither creates anything,
// so `ls > /dev/null` and `make check >/dev/null 2>&1` are read-only.
const REDIRECT_TARGET = String.raw`\s*(?!/dev/null(?:\s|$)|&\d)\S+`;

// `2>` names a file descriptor, so `cat f 2>/dev/null` is a read. The generic
// entry below cannot match one because it demands a separator immediately
// before the operator, and a digit is not a separator. The command-specific
// entries need the rule spelled out: their `.*` used to swallow the fd digit,
// which is what blocked `cat pkg.json 2>/dev/null | grep name`.
const NOT_FD = String.raw`(?<![0-9])`;

// A command name only counts when it sits in command position: at the head of
// a fragment (splitCommands has already cut on | ; && ||), after env
// assignments or a privilege/timing prefix, or at the head of a shell-wrapper
// payload (`sh -c "…"`). Without this anchor a bare `\bmv\s+` matches English
// prose inside a quoted argument — `gh issue create --body "…then mv on
// L63-67"` was blocked as a file move, and `git commit -m "patch the bug"` as
// a patch. The repetition is bounded to keep the alternation from backtracking
// pathologically on hostile input.
const CMD_HEAD = String.raw`(?:^|-c\s*["']?)\s*(?:(?:[\w.]+=\S*|sudo|command|time|timeout|env|nohup|exec|xargs|\d+[a-z]?)\s+){0,6}`;

/** Builds a command-position-anchored write pattern. */
const cmd = (body) => new RegExp(CMD_HEAD + body);

/**
 * File-writing shell patterns that bypass Write/Edit tools.
 * Each pattern has a regex and a description.
 */
const FILE_WRITE_PATTERNS = [
  // Redirects are deliberately NOT command-anchored: the operator is what
  // writes, wherever it appears — including inside `bash -c "echo x > f"`.
  { pattern: new RegExp(String.raw`(?:^|[|;&]|\s)>{1,2}${REDIRECT_TARGET}`), desc: 'output redirection (> or >>)' },
  { pattern: new RegExp(String.raw`\bcat\s+[^|;]*${NOT_FD}>{1,2}${REDIRECT_TARGET}`), desc: 'cat with redirect' },
  { pattern: new RegExp(String.raw`\becho\s+[^|;]*${NOT_FD}>{1,2}${REDIRECT_TARGET}`), desc: 'echo with redirect' },
  { pattern: new RegExp(String.raw`\bprintf\s+[^|;]*${NOT_FD}>{1,2}${REDIRECT_TARGET}`), desc: 'printf with redirect' },
  { pattern: cmd(String.raw`tee\s+(?:-a\s+)?\S+`), desc: 'tee command' },
  { pattern: cmd(String.raw`sed\s+-i`), desc: 'sed in-place edit' },
  { pattern: cmd(String.raw`cp\s+`), desc: 'cp (file copy)' },
  { pattern: cmd(String.raw`mv\s+`), desc: 'mv (file move)' },
  { pattern: cmd(String.raw`install\s+-`), desc: 'install command' },
  // `\binstall\s+-` used to catch package-manager installs as a side effect of
  // matching anywhere. Command-anchoring would silently unblock them, which is
  // outside what issue #75 asked for, so state them explicitly instead.
  { pattern: cmd(String.raw`(?:npm|yarn|pnpm|bun)\s+(?:install|add)\b`), desc: 'package manager install' },
  { pattern: cmd(String.raw`dd\s+.*of=`), desc: 'dd with output file' },
  { pattern: cmd(String.raw`patch\s+`), desc: 'patch command' },
  { pattern: cmd(String.raw`chmod\s+`), desc: 'chmod (permission change)' },
  { pattern: cmd(String.raw`chown\s+`), desc: 'chown (ownership change)' },
  { pattern: cmd(String.raw`perl\s+.*-[^\s]*i`), desc: 'perl in-place edit' },
  { pattern: cmd(String.raw`node\s+-e\s+.*(?:writeFile|appendFile|createWriteStream|fs\.)`), desc: 'node -e file system write' },
  { pattern: cmd(String.raw`awk\s+.*-i\s+inplace\b`), desc: 'awk in-place edit' },
  { pattern: cmd(String.raw`python[23]?\s+-c\s+.*(?:open\s*\(|write|\.dump)`), desc: 'python -c file write' },
  { pattern: cmd(String.raw`ruby\s+-e\s+.*(?:File\.|IO\.|open\s*\()`), desc: 'ruby -e file write' },
  { pattern: cmd(String.raw`swift\s+-e\s+.*(?:write|FileManager|contentsOf)`), desc: 'swift -e file write' },
  { pattern: cmd(String.raw`truncate\s+`), desc: 'truncate command' },
  { pattern: cmd(String.raw`sponge\s+`), desc: 'sponge (moreutils) write' },
  { pattern: cmd(String.raw`git\s+(push|reset\s+--hard|checkout\s+--\s|clean\s+-f)`), desc: 'destructive git operation' },
  { pattern: cmd(String.raw`curl\s+.*-[^\s]*o\s`), desc: 'curl output to file' },
  { pattern: cmd(String.raw`wget\s+.*-[^\s]*O\s`), desc: 'wget output to file' },
  { pattern: cmd(String.raw`ln\s+(?:-[^\s]*\s+)*\S+\s+\S+`), desc: 'ln (link creation)' },
  { pattern: cmd(String.raw`tar\s+.*x`), desc: 'tar extract (file creation)' },
  { pattern: cmd(String.raw`unzip\s+`), desc: 'unzip (file extraction)' },
  { pattern: cmd(String.raw`cpio\s+`), desc: 'cpio archive extraction' },
  { pattern: cmd(String.raw`rsync\s+`), desc: 'rsync (file sync)' },
  { pattern: /\bwriteFile\b/, desc: 'Node.js writeFile API call' },
];

/**
 * Safe commands that look like they might write but don't, or are
 * needed for test execution / normal development.
 */
const SAFE_COMMAND_PATTERNS = [
  /\bnpm\s+test\b/, /\bnpm\s+run\s+test\b/, /\byarn\s+test\b/,
  /\bnpx\s+/, /\bbun\s+test\b/, /\bcargo\s+test\b/,
  /\bpytest\b/, /\bpython\s+-m\s+pytest\b/, /\bpython\s+-m\s+unittest\b/,
  /\bgo\s+test\b/, /\bmake\s+test\b/,
  /\bgit\s+(status|log|diff|branch|show|stash|fetch)\b/,
  /\bgit\s+add\b/, /\bgit\s+commit\b/,
  /\bls\b/, /\bpwd\b/, /\bwhich\b/, /\bcat\s+[^<>]/, /\bhead\b/, /\btail\b/,
  /\bgrep\b/, /\bfind\b/, /\bwc\b/, /\bsort\b/, /\buniq\b/, /\bdiff\b/, /\bfile\b/,
  /\bnode\s+--test\b/,
  /\bmkdir\s/, /\brm\s/, /\brmdir\s/,  // directory operations, not file writes to source
  // v4.2: cross-model review tools (adversarial review in plan phase)
  /\bcodex\s+exec\b/, /\bcodex\s+--version\b/,
  /\bgemini\s+exec\b/, /\bgemini\s+-p\b/, /\bgemini\s+--version\b/,
  /\btimeout\s+\d+\s+codex\b/, /\btimeout\s+\d+\s+gemini\b/,
  /\bmktemp\b/,
  /\bdocker\s+(ps|images|inspect|logs)\b/, /\bkubectl\s+(get|describe|logs)\b/,
  /\bcargo\s+(build|check|clippy|fmt\s+--check|bench)\b/, /\bgo\s+(build|vet|fmt)\b/,
  /\bdeno\s+(test|check|lint|fmt\s+--check)\b/, /\bbun\s+(run|x)\b/,
  /\benv\b/, /\bprintenv\b/, /\btype\s/, /\bcommand\s+-v\b/,
  /\bstat\s/, /\bdu\s/, /\bdf\s/, /\bfree\s/, /\buname\b/, /\bhostname\b/,
  /\btsc\s+--noEmit\b/, /\bpython\s+-m\s+py_compile\b/,
];

/**
 * Dangerous-Bash-command denylist for non-implement phases (M5.5 #7).
 *
 * Catastrophic-blast-radius families that pass through the file-write gate
 * because they are not literal file writes. Mirrors the example pack
 * (hooks-strict-mode/scripts/denylist-guard.sh) family list + override env
 * convention so users learn one mental model.
 *
 * `pattern` is anchored conservatively — we'd rather miss a creative
 * variant than false-positive on legitimate research commands. The
 * adversary model is "AI agent writing a destructive command by accident",
 * not "human author actively trying to evade." For the latter, install
 * the strict-mode example pack at the hook level (deeper defense).
 *
 * Phase 5 mode in phase-guard.sh ALSO catches these families via its
 * read-mostly allowlist + destructive-target + compound-operator gates;
 * this constant adds equivalent coverage to non-implement phases (which
 * previously only checked file-writes).
 *
 * **Intentional scope omissions** (R3 I-R3.1 — pin so future contributors
 * don't re-discover and "fix" silently). The following families are
 * deliberately NOT in this denylist; broadening requires a separate
 * adversary-model + override-naming design pass (§9.4 charter):
 *   - `DELETE FROM <table>` without WHERE — easy to false-positive on
 *     legitimate research queries; opt in via example pack.
 *   - `DROP DATABASE` — covered transitively by `psql`/`mysql` first-token
 *     blocks in Phase 5; non-implement phases rely on example pack.
 *   - `curl | zsh` / `bash <(curl ...)` — only `curl|sh` and `curl|bash`
 *     are caught; alternate shell pipes / process-substitution are
 *     uncommon-but-real bypasses left to example pack hardening.
 *   - `yarn publish` — only `npm publish` is canonicalized here;
 *     monorepo publishers (yarn, pnpm, lerna) require their own
 *     family entries when added.
 *   - `dd if=/dev/zero of=...`, `mkfs.*`, `fdisk` — disk-level
 *     blast-radius deferred to example pack; very rare in AI-agent
 *     command output.
 */
const DANGEROUS_NON_IMPLEMENT_PATTERNS = [
  {
    // Any `rm` with -r / -R recursive flag (catches `rm -rf`, `rm -fr`,
    // `rm -Rf`, `rm -r --no-preserve-root`, etc.). Single-file `rm -f`
    // is intentionally NOT matched — it's not catastrophic-blast-radius.
    pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|-{2}recursive\b)/,
    family: 'rm-rf',
    override: 'CLAUDE_ALLOW_RM_RF',
    why: 'recursive delete is catastrophic and unrecoverable',
    safer: "prefer targeted file removal: 'rm path/to/file'",
  },
  {
    pattern: /\bnpm\s+publish\b/,
    family: 'npm-publish',
    override: 'CLAUDE_ALLOW_NPM_PUBLISH',
    why: 'publishes a package version irreversibly to the npm registry',
    safer: 'bump version + git tag + manual publish from a CI release pipeline',
  },
  {
    // kubectl delete with --all OR kubectl drain (cluster-level blast radius).
    // Single-resource delete (e.g., `kubectl delete pod foo`) is allowed —
    // user can scope by enabling the example pack for full strict mode.
    // (?!-) negative lookahead prevents matching --all-namespaces / --all-containers /
    // etc., which are legitimate scoping flags not standalone destructive intents
    // (R3 review W-R3.2 fix — \b alone fires at the `-` in `--all-namespaces`).
    pattern: /\bkubectl\s+(?:delete\s+[^|;&]*\B--all(?!-)\b|drain\b)/,
    family: 'kubectl-destructive',
    override: 'CLAUDE_ALLOW_KUBECTL_DESTRUCTIVE',
    why: 'kubectl delete --all / drain affects shared infrastructure',
    safer: 'kubectl get to inspect first; coordinate with on-call before destructive ops',
  },
  {
    // SQL DROP TABLE / TRUNCATE (both PostgreSQL "TRUNCATE <table>" and the
    // ANSI "TRUNCATE TABLE <table>" forms). Case-insensitive because SQL is,
    // but most real foot-guns use canonical uppercase. Anchored to keyword
    // boundaries to avoid matching `-- DROP TABLE` in a docstring/comment.
    // R3 W-R3.1 fix: collapsed two TRUNCATE alternatives into one optional
    // TABLE group + `\w+` quantifier so realistic table names match
    // (previous `TRUNCATE\s+\w\b` required exactly one word char before
    // the boundary — `TRUNCATE users` was missed because `s` after `u` is
    // also word-class so no boundary fired).
    pattern: /\b(?:DROP\s+TABLE|TRUNCATE(?:\s+TABLE)?\s+\w+)\b/i,
    family: 'sql-destructive',
    override: 'CLAUDE_ALLOW_SQL_DESTRUCTIVE',
    why: 'DROP TABLE / TRUNCATE on production data is unrecoverable',
    safer: 'run against a staging database, or wrap in a transaction with rollback rehearsal',
  },
  {
    // curl|sh / curl|bash — arbitrary code execution from the network.
    // Matches the pipe-to-shell pattern with curl or wget upstream.
    pattern: /\b(?:curl|wget)[^|;&]*\|\s*(?:sh|bash)\b/,
    family: 'curl-pipe-shell',
    override: 'CLAUDE_ALLOW_CURL_PIPE_SHELL',
    why: 'executes arbitrary code fetched over the network; supply-chain risk',
    safer: 'download the script, inspect, then run locally',
  },
];

/**
 * Returns the first matching dangerous-command descriptor for the given
 * Bash command, or null if none match. Used by non-implement preToolUse
 * enforcement to short-circuit before the generic file-write gate.
 *
 * @param {string} command - The bash command string
 * @returns {{pattern: RegExp, family: string, override: string, why: string, safer: string} | null}
 */
function matchDangerousNonImplement(command) {
  if (!command || typeof command !== 'string') return null;
  for (const entry of DANGEROUS_NON_IMPLEMENT_PATTERNS) {
    if (entry.pattern.test(command)) return entry;
  }
  return null;
}

/**
 * Extracts the target file path from a bash command that writes files.
 * Used to determine whether the target is a test file or production file
 * for TDD enforcement on bash commands.
 *
 * @param {string} command - The bash command string
 * @returns {string} extracted file path, or '' if not extractable (treated as production = fail-closed)
 */
function extractBashTargetFile(command) {
  if (!command || typeof command !== 'string') return '';
  const trimmed = command.trim();

  // sed -i [flags] 's/...' FILE
  const sedMatch = trimmed.match(/\bsed\s+(?:-[^i]*)?-i[^\s]*\s+(?:'[^']*'|"[^"]*"|\S+)\s+(\S+)/);
  if (sedMatch) return sedMatch[1];

  // tee [-a] FILE
  const teeMatch = trimmed.match(/\btee\s+(?:-a\s+)?(\S+)/);
  if (teeMatch) return teeMatch[1];

  // cp SRC DEST — target is last argument
  const cpMatch = trimmed.match(/\bcp\s+(?:-[^\s]+\s+)*\S+\s+(\S+)\s*$/);
  if (cpMatch) return cpMatch[1];

  // mv SRC DEST — target is last argument
  const mvMatch = trimmed.match(/\bmv\s+(?:-[^\s]+\s+)*\S+\s+(\S+)\s*$/);
  if (mvMatch) return mvMatch[1];

  // dd of=FILE
  const ddMatch = trimmed.match(/\bdd\s+.*\bof=(\S+)/);
  if (ddMatch) return ddMatch[1];

  // perl -pi -e '...' FILE
  const perlMatch = trimmed.match(/\bperl\s+.*-[^\s]*i[^\s]*\s+(?:-e\s+)?(?:'[^']*'|"[^"]*"|\S+)\s+(\S+)/);
  if (perlMatch) return perlMatch[1];

  // Redirect: ... > FILE or ... >> FILE
  const redirectMatch = trimmed.match(/>{1,2}\s*(\S+)\s*$/);
  if (redirectMatch) return redirectMatch[1];

  // Could not extract — return empty string (fail-closed: treated as production)
  return '';
}

/**
 * Splits a shell command string on &&, ||, ;, and | operators,
 * respecting single and double quotes.
 * @param {string} command - The shell command string
 * @returns {string[]} Array of individual sub-commands (trimmed)
 */
function splitCommands(command) {
  if (!command || typeof command !== 'string') return [];

  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let parenDepth = 0;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // Handle escape inside double quotes
    if (ch === '\\' && inDouble && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }

    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      current += ch;
      i++;
      continue;
    }

    // Track $() subshell depth
    if (ch === '(' && !inSingle && !inDouble && !inBacktick) {
      parenDepth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ')' && !inSingle && !inDouble && !inBacktick && parenDepth > 0) {
      parenDepth--;
      current += ch;
      i++;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick && parenDepth === 0) {
      // Check for && or ||
      if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
        parts.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // Check for ; or single |
      if (ch === ';' || ch === '|') {
        parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  const last = current.trim();
  if (last) parts.push(last);

  return parts.filter(p => p.length > 0);
}

/**
 * Checks if a bash command attempts to write files.
 * Splits chained commands and checks each sub-command independently.
 * @param {string} command - The bash command string
 * @returns {{ isFileWrite: boolean, pattern?: string }}
 */
function detectBashFileWrite(command) {
  if (!command || typeof command !== 'string') {
    return { isFileWrite: false };
  }

  const subCommands = splitCommands(command);

  for (const sub of subCommands) {
    // Check file-write patterns FIRST (security-critical)
    let writeMatch = null;
    for (const { pattern, desc } of FILE_WRITE_PATTERNS) {
      if (pattern.test(sub)) {
        writeMatch = desc;
        break;
      }
    }

    // If file-write detected, return immediately (safe patterns cannot override)
    if (writeMatch) {
      return { isFileWrite: true, pattern: writeMatch };
    }

    // Check safe patterns — if no write detected and command is safe, skip it
    let isSafe = false;
    for (const safe of SAFE_COMMAND_PATTERNS) {
      if (safe.test(sub)) {
        isSafe = true;
        break;
      }
    }
    if (isSafe) continue;
  }

  return { isFileWrite: false };
}

// ─── Slice Scope Enforcement ─────────────────────────────────

/**
 * Checks if a file is within the active slice's scope.
 * @param {string} filePath - Absolute file path being modified
 * @param {string[]} sliceFiles - List of files in the active slice
 * @param {boolean} strictScope - If true, block; if false, warn only
 * @returns {{ inScope: boolean, message?: string }}
 */
function checkSliceScope(filePath, sliceFiles, strictScope) {
  if (!sliceFiles || sliceFiles.length === 0) {
    return { inScope: true }; // no slice files defined = no enforcement
  }

  const normalizedPath = filePath.replace(/\\/g, '/');
  const inScope = sliceFiles.some(sf => {
    const normalizedSliceFile = sf.replace(/\\/g, '/');
    return normalizedPath.endsWith(normalizedSliceFile) ||
      normalizedPath === normalizedSliceFile;
  });

  if (inScope) {
    return { inScope: true };
  }

  if (strictScope) {
    return {
      inScope: false,
      message: `⛔ Slice scope 위반: ${filePath}은(는) 현재 활성 slice의 파일 목록에 없습니다.\n` +
        `허용 파일: ${sliceFiles.join(', ')}`,
    };
  }

  // Warning only (default behavior)
  return {
    inScope: false,
    message: `⚠️ Slice scope 경고: ${filePath}은(는) 현재 활성 slice의 파일 목록 밖입니다.\n` +
      `허용 파일: ${sliceFiles.join(', ')}`,
  };
}

// ─── Receipt Validation ──────────────────────────────────────

/**
 * Validates a receipt JSON file against the expected schema.
 * @param {object} receipt - Parsed receipt object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateReceipt(receipt) {
  const errors = [];

  if (!receipt) {
    return { valid: false, errors: ['Receipt is null or undefined'] };
  }

  // Schema version check
  if (receipt.schema_version && receipt.schema_version !== '1.0') {
    errors.push(`Unknown schema_version: ${receipt.schema_version}. Expected: 1.0`);
  }

  // Required fields
  if (!receipt.slice_id) errors.push('Missing slice_id');
  if (!receipt.status) errors.push('Missing status');

  const validStatuses = ['complete', 'in_progress', 'partial', 'pending'];
  if (receipt.status && !validStatuses.includes(receipt.status)) {
    errors.push(`Invalid status: ${receipt.status}. Expected: ${validStatuses.join(', ')}`);
  }

  const validTddStates = Object.values(TDD_STATES);
  if (receipt.tdd_state && !validTddStates.includes(receipt.tdd_state)) {
    errors.push(`Invalid tdd_state: ${receipt.tdd_state}`);
  }

  // TDD section validation (if present)
  if (receipt.tdd) {
    if (receipt.tdd.failing_test_output && typeof receipt.tdd.failing_test_output !== 'string') {
      errors.push('tdd.failing_test_output must be a string');
    }
    if (receipt.tdd.passing_test_output && typeof receipt.tdd.passing_test_output !== 'string') {
      errors.push('tdd.passing_test_output must be a string');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Utility Functions ───────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /test_.*\.py$/,
  /.*_test\.py$/,
  /.*_test\.go$/,
  /.*_test\.rb$/,
  /.*\.test\.rb$/,
  /spec\/.*_spec\.rb$/,
  /.*_test\.rs$/,           // Rust
  /.*Test\.java$/,          // Java
  /.*Tests\.java$/,         // Java (plural)
  /.*Tests?\.cs$/,          // C#
  /.*Test\.kt$/,            // Kotlin
  /.*Tests?\.swift$/,       // Swift
  /.*_test\.exs?$/,         // Elixir
  /.*\.test\.lua$/,         // Lua
  /.*\.test\.dart$/,        // Dart/Flutter
  /.*_test\.dart$/,         // Dart (alt)
  /.*\.test\.vue$/,         // Vue
  /tests?\//,
  /__tests__\//,
  /spec\//,                 // RSpec, etc.
  /fixtures?\//,            // Test fixtures
  /__fixtures__\//,         // Jest fixtures
  /__mocks__\//,            // Jest mocks
];

function isTestFilePath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return TEST_FILE_PATTERNS.some(p => p.test(normalized));
}

const DEFAULT_EXEMPT_PATTERNS = [
  /\.ya?ml$/,
  /\.json$/,
  /\.toml$/,
  /\.ini$/,
  /\.cfg$/,
  /\.lock$/,
  /\.editorconfig$/,
  /\.svg$/,
  /\.png$/,
  /\.jpg$/,
  /\.gif$/,
  /\.md$/,
  /\.txt$/,
  /\.env/,
  /\.gitignore$/,
  /Dockerfile$/,
  /\.dockerignore$/,
  /Makefile$/,
];

function isExemptFile(filePath, customPatterns) {
  const normalized = filePath.replace(/\\/g, '/');
  const allPatterns = [
    ...DEFAULT_EXEMPT_PATTERNS,
    ...(customPatterns || []).map(p => new RegExp(p)),
  ];
  return allPatterns.some(p => p.test(normalized));
}

/**
 * Truncates a string to the last N lines.
 * @param {string} text
 * @param {number} maxLines
 * @returns {string}
 */
function truncateOutput(text, maxLines) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join('\n');
}

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Process a hook invocation.
 * @param {object} input - { action, toolName, toolInput, state }
 *   action: "pre" | "post"
 *   toolName: "Write" | "Edit" | "Bash" | etc.
 *   toolInput: { file_path?, command?, ... }
 *   state: { current_phase, tdd_mode, active_slice, tdd_state, slice_files, strict_scope, exempt_patterns }
 * @returns {{ decision: "allow"|"block"|"warn", reason?: string }}
 */
function processHook(input) {
  const { action, toolName, toolInput, state } = input;

  if (!state || !state.current_phase) {
    return { decision: 'allow' };
  }

  const phase = state.current_phase;

  // ─── Artifacts-only fork restriction (v5.6) ───────────
  if (state.fork_mode === 'artifacts-only' && ['implement', 'test'].includes(phase)) {
    return {
      decision: 'block',
      reason: `🚫 Non-git fork는 plan phase까지만 진행 가능합니다.\n` +
        `구현을 진행하려면 git 환경에서 /deep-fork를 사용하세요.`,
    };
  }

  // ─── Non-implement phases: block writes + dangerous commands ────────────
  // M5.5 #7 closure: non-implement Bash goes through TWO gates in sequence:
  //   1. dangerous-command denylist (catastrophic-blast-radius families)
  //   2. file-write detection (BASH_FILE_WRITE_PATTERNS)
  // Denylist families mirror the example pack (hooks-strict-mode/scripts/
  // denylist-guard.sh) so users learn one override convention. Each family
  // has a CLAUDE_ALLOW_<FAMILY>=1 env override for legitimate exceptions.
  // **Override semantics** (do not weaken without contract review):
  //   - The override env vars suppress ONLY the denylist branch — they
  //     fall through to the file-write gate, which still applies. This
  //     is the contract pinned by phase-guard-denylist.test.js §"override
  //     fall-through composition" (I-R3.3). Hoisting the new gate above
  //     denylist would silently weaken protection (denylist would never
  //     fire for commands that also match file-write patterns) — order
  //     is load-bearing.
  // **Cross-coverage** — Phase 5 mode in phase-guard.sh provides
  // independent enforcement via its read-mostly allowlist + destructive-
  // target + compound-operator gates (M5.5 #7 A1 spec). The two layers
  // overlap deliberately; either alone catches all 7 spec families, both
  // together provide defense-in-depth against bash-side regex bypass.
  if (['research', 'plan', 'test', 'brainstorm'].includes(phase)) {
    if (toolName === 'Bash') {
      const cmd = toolInput.command || '';

      // Dangerous-command denylist — applied BEFORE file-write detection
      // so a single error message points at the catastrophic family rather
      // than the incidental "file write" classification.
      const dangerous = matchDangerousNonImplement(cmd);
      if (dangerous) {
        // Override env var read at hook-execution time (Node child of bash
        // wrapper inherits the user's shell env).
        if (process.env[dangerous.override] !== '1') {
          return {
            decision: 'block',
            reason:
              `⛔ Deep Work Guard: ${phase} 단계에서 위험 명령 차단 ` +
              `(${dangerous.family}: ${dangerous.why}).\n` +
              `명령: ${cmd}\n` +
              `Override (only after careful thought): set ${dangerous.override}=1 ` +
              `in the shell that launched Claude Code, then retry.\n` +
              `Safer alternative: ${dangerous.safer}`,
          };
        }
        // Override active → fall through to file-write gate (still applies).
      }

      const { isFileWrite, pattern } = detectBashFileWrite(cmd);
      if (isFileWrite) {
        return {
          decision: 'block',
          reason: `⛔ Deep Work Guard: ${phase} 단계에서 파일 쓰기가 차단되었습니다.\n` +
            `감지된 패턴: ${pattern}\n명령: ${cmd}`,
        };
      }
      return { decision: 'allow' };
    }
    // Write/Edit already handled by bash fast path — shouldn't reach here
    return { decision: 'allow' };
  }

  // ─── Implement phase: TDD + Slice enforcement ──────────
  if (phase === 'implement') {
    // Validate TDD state is a known value (defensive)
    const knownState = state.tdd_state || TDD_STATES.PENDING;
    if (!Object.values(TDD_STATES).includes(knownState)) {
      return {
        decision: 'block',
        reason: `⛔ Deep Work Guard: 알 수 없는 TDD 상태입니다: ${knownState}\n` +
          `/deep-status로 현재 상태를 확인하세요.`,
      };
    }

    // Bash tool: check for file writes
    if (toolName === 'Bash') {
      const { isFileWrite, pattern } = detectBashFileWrite(toolInput.command);
      if (isFileWrite) {
        // Apply TDD enforcement to bash file writes too
        const tddResult = checkTddEnforcement(
          state.tdd_state || TDD_STATES.PENDING,
          extractBashTargetFile(toolInput.command),  // extract actual target file
          state.tdd_mode || 'strict',
          state.exempt_patterns,
          !!state.tdd_override,
        );
        if (!tddResult.allowed) {
          return { decision: 'block', reason: tddResult.reason };
        }
      }
      return { decision: 'allow' };
    }

    // Write/Edit: TDD + Slice scope
    const filePath = toolInput.file_path || '';

    // Check TDD enforcement
    const tddResult = checkTddEnforcement(
      state.tdd_state || TDD_STATES.PENDING,
      filePath,
      state.tdd_mode || 'strict',
      state.exempt_patterns,
      !!state.tdd_override,
    );
    if (!tddResult.allowed) {
      return { decision: 'block', reason: tddResult.reason };
    }

    // Check slice scope
    if (state.slice_files && state.active_slice) {
      const scopeResult = checkSliceScope(
        filePath,
        state.slice_files,
        state.strict_scope || false,
      );
      if (!scopeResult.inScope) {
        return {
          decision: state.strict_scope ? 'block' : 'warn',
          reason: scopeResult.message,
        };
      }
    }

    return { decision: 'allow' };
  }

  // Unknown phase (not idle): warn but allow
  if (phase !== 'idle') {
    return {
      decision: 'allow',
      reason: `⚠️ Deep Work Guard: 알 수 없는 phase '${phase}'. 기본 허용합니다.`,
    };
  }

  // idle phase: allow
  return { decision: 'allow' };
}

// ─── CLI Entry ───────────────────────────────────────────────

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(input);
      const result = processHook(parsed);
      process.stdout.write(JSON.stringify(result));
      // Exit 0 for all intentional decisions (allow/block/warn). The shell
      // wrapper inspects the `decision` field on stdout to decide hook action.
      process.exit(0);
    } catch (err) {
      // Internal error (JSON.parse, runtime exception). Distinguish from
      // intentional block so the shell can surface a debug-oriented message
      // pointing at the guard error log. Exit 3 is an internal signal that
      // phase-guard.sh translates to hook protocol exit 2.
      process.stderr.write(`INTERNAL_ERROR: ${err.message}\n${err.stack || ''}\n`);
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: '⛔ Deep Work Guard: 내부 검증 오류가 발생했습니다. .claude/deep-work-guard-errors.log 를 확인하세요.'
      }));
      process.exit(3);
    }
  });
}

// ─── Model Routing (v4.1) ───────────────────────────────────

const DEFAULT_ROUTING_TABLE = {
  S: 'haiku',
  M: 'sonnet',
  L: 'sonnet',
  XL: 'opus',
};

const VALID_MODELS = ['haiku', 'sonnet', 'opus', 'main', 'auto'];

/**
 * Looks up the model for a given slice size.
 * @param {string} size - S, M, L, or XL
 * @param {object} [customTable] - Custom routing table (optional)
 * @returns {{ model: string, valid: boolean }}
 */
function lookupModel(size, customTable) {
  const table = { ...DEFAULT_ROUTING_TABLE, ...(customTable || {}) };
  const normalizedSize = (size || 'M').toString().toUpperCase().trim();
  const model = table[normalizedSize];
  if (!model) {
    return { model: table['M'] || 'sonnet', valid: false };
  }
  return { model, valid: true };
}

/**
 * Validates a model name.
 * @param {string} model - Model name to validate
 * @returns {{ valid: boolean, fallback: string }}
 */
function validateModelName(model) {
  if (!model || typeof model !== 'string') {
    return { valid: false, fallback: 'sonnet' };
  }
  const normalized = model.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  if (VALID_MODELS.includes(normalized)) {
    return { valid: true, fallback: normalized };
  }
  return { valid: false, fallback: 'sonnet' };
}

// ─── Exports (for testing) ───────────────────────────────────

module.exports = {
  TDD_STATES,
  VALID_TRANSITIONS,
  isValidTransition,
  checkTddEnforcement,
  DANGEROUS_NON_IMPLEMENT_PATTERNS,
  matchDangerousNonImplement,
  detectBashFileWrite,
  splitCommands,
  extractBashTargetFile,
  checkSliceScope,
  validateReceipt,
  isTestFilePath,
  isExemptFile,
  truncateOutput,
  processHook,
  DEFAULT_ROUTING_TABLE,
  VALID_MODELS,
  lookupModel,
  validateModelName,
};
