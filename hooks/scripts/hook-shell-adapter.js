#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const HOOK_SCRIPTS = Object.freeze({
  'update-check': 'update-check.sh',
  'phase-guard': 'phase-guard.sh',
  'file-tracker': 'file-tracker.sh',
  'phase-transition': 'phase-transition.sh',
  'session-end': 'session-end.sh',
});

function toGitBashPath(value) {
  const input = String(value || '');
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (drive) {
    return `/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}`;
  }
  if (/^\\\\/.test(input)) return `//${input.slice(2).replaceAll('\\', '/')}`;
  return input.replaceAll('\\', '/');
}

function cleanProbeOutput(value) {
  const output = String(value || '').trim();
  if (output.startsWith('"') && output.endsWith('"')) return output.slice(1, -1);
  return output;
}

function gitInstallCandidates(execPath) {
  const cleaned = cleanProbeOutput(execPath);
  if (!cleaned) return [];
  const root = path.win32.resolve(cleaned, '..', '..', '..');
  return [
    path.win32.join(root, 'bin', 'bash.exe'),
    path.win32.join(root, 'usr', 'bin', 'bash.exe'),
  ];
}

function standardGitBashCandidates(env) {
  const candidates = [];
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (root) candidates.push(path.win32.join(root, 'Git', 'bin', 'bash.exe'));
  }
  if (env.LOCALAPPDATA) {
    candidates.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  }
  return candidates;
}

function resolveBashExecutable(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return 'bash';

  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const run = options.run || spawnSync;
  const candidates = [];

  if (env.DEEP_WORK_GIT_BASH) candidates.push(env.DEEP_WORK_GIT_BASH);

  const probe = run('git', ['--exec-path'], {
    encoding: 'utf8',
    env,
    shell: false,
    timeout: 1_000,
    windowsHide: true,
  });
  if (probe && probe.status === 0) {
    candidates.push(...gitInstallCandidates(probe.stdout));
  }
  candidates.push(...standardGitBashCandidates(env));

  return candidates.find((candidate) => exists(candidate)) || null;
}

function failureStatus(hookName) {
  return hookName === 'phase-guard' ? 2 : 1;
}

function runHookScript(hookName, options = {}) {
  const scriptName = HOOK_SCRIPTS[hookName];
  if (!scriptName) {
    return {
      status: 2,
      stdout: '',
      stderr: `deep-work hook adapter: unknown hook script "${hookName || '<missing>'}"\n`,
    };
  }

  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const run = options.run || spawnSync;
  const bash = Object.hasOwn(options, 'bashExecutable')
    ? options.bashExecutable
    : resolveBashExecutable({
      platform,
      env,
      run,
      exists: options.exists,
    });
  if (!bash) {
    return {
      status: failureStatus(hookName),
      stdout: '',
      stderr: 'deep-work hook adapter: Git for Windows Bash was not found '
        + `(hook: ${hookName}). Install Git for Windows or set DEEP_WORK_GIT_BASH `
        + 'to its bash.exe path.\n',
    };
  }

  const pathApi = platform === 'win32' ? path.win32 : path;
  const pluginRoot = options.pluginRoot || PLUGIN_ROOT;
  const scriptPath = pathApi.resolve(pluginRoot, 'hooks', 'scripts', scriptName);
  const scriptArg = platform === 'win32' ? toGitBashPath(scriptPath) : scriptPath;
  // Guard decisions must be visible to hosts that consume exit-2 reasons only
  // from stderr. Keep stdout JSON intact for existing host/readers.
  const guard = hookName === 'phase-guard';
  const capture = options.capture === true || guard;
  const hasInput = Object.hasOwn(options, 'input');
  const stdin = hasInput ? 'pipe' : options.capture === true ? 'ignore' : 'inherit';
  const result = run(bash, [scriptArg], {
    cwd: options.cwd || process.cwd(),
    env,
    encoding: 'utf8',
    ...(hasInput ? { input: options.input } : {}),
    shell: false,
    stdio: capture ? [stdin, 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  }) || {};

  if (Number.isInteger(result.status)) {
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    let stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (guard && result.status === 2) {
      let reason;
      try {
        const decision = JSON.parse(stdout);
        if (decision.decision === 'block' && typeof decision.reason === 'string'
            && decision.reason.trim()) reason = decision.reason;
      } catch {}
      if (reason && !stderr.includes(reason)) {
        stderr += `${stderr && !stderr.endsWith('\n') ? '\n' : ''}${reason}\n`;
      } else if (!stderr.trim()) {
        stderr = 'deep-work phase guard blocked the tool without a readable reason; '
          + 'run /deep-status to inspect the session.\n';
      }
    }
    return {
      status: result.status,
      stdout,
      stderr,
    };
  }

  const detail = result.error && result.error.message
    ? `: ${result.error.message}`
    : (result.signal ? `: terminated by ${result.signal}` : '');
  return {
    status: failureStatus(hookName),
    stdout: '',
    stderr: `deep-work hook adapter: ${hookName} could not start${detail}\n`,
  };
}

function runPostToolHooks(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const run = options.run || spawnSync;
  const bash = Object.hasOwn(options, 'bashExecutable')
    ? options.bashExecutable
    : resolveBashExecutable({
      platform,
      env,
      run,
      exists: options.exists,
    });
  if (!bash) {
    return {
      status: 1,
      stdout: '',
      stderr: 'deep-work hook adapter: Git for Windows Bash was not found '
        + '(hook: post-tool). Install Git for Windows or set DEEP_WORK_GIT_BASH '
        + 'to its bash.exe path.\n',
    };
  }

  const input = String(options.input || '');
  const shared = {
    bashExecutable: bash,
    capture: true,
    cwd: options.cwd || process.cwd(),
    exists: options.exists,
    platform,
    pluginRoot: options.pluginRoot || PLUGIN_ROOT,
    run,
  };
  const tracker = runHookScript('file-tracker', {
    ...shared,
    env,
    input,
  });
  const transition = runHookScript('phase-transition', {
    ...shared,
    env: {
      ...env,
      CLAUDE_TOOL_INPUT: input,
    },
  });

  return {
    status: tracker.status !== 0 ? tracker.status : transition.status,
    stdout: `${tracker.stdout}${transition.stdout}`,
    stderr: `${tracker.stderr}${transition.stderr}`,
  };
}

function main() {
  const hookName = process.argv[2];
  const result = hookName === 'post-tool'
    ? runPostToolHooks({ input: fs.readFileSync(0, 'utf8') })
    : runHookScript(hookName);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status;
}

if (require.main === module) main();

module.exports = {
  HOOK_SCRIPTS,
  resolveBashExecutable,
  runHookScript,
  runPostToolHooks,
  toGitBashPath,
};
