'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, fork, spawnSync } = require('node:child_process');
const { terminateWindowsTree } = require('./process-supervisor.js');

const platform = require('./platform.js');
const {
  PATH_THREAT_MODEL,
  PROJECT_STATE_ROLES,
  OWNED_TEMP_PURPOSES,
  WORKTREE_MANIFEST_MAX_ENTRIES,
  WORKTREE_MANIFEST_MAX_RELATIVE_PATH_BYTES,
  WORKTREE_MANIFEST_MAX_PATH_TOTAL_BYTES,
  WORKTREE_MANIFEST_MAX_FILE_BYTES,
  WORKTREE_MANIFEST_MAX_TOTAL_BYTES,
  INSTALL_ROOT_MAX_ROOTS,
  INSTALL_ROOT_MAX_DEPTH,
  INSTALL_ROOT_MAX_ENTRIES_PER_ROOT,
  INSTALL_ROOT_MAX_FILE_BYTES,
  INSTALL_ROOT_MAX_TOTAL_BYTES_PER_ROOT,
  CLAIM_TICKET_ONLY_TTL_MS,
  CLAIM_TICKET_SCAN_MAX_ENTRIES,
  CLAIM_TICKET_MAX_FILE_BYTES,
  CLAIM_TICKET_SCAN_MAX_TOTAL_BYTES,
  CLAIM_PRIVATE_SCAN_MAX_ENTRIES,
  CLAIM_TICKET_REPORT_MAX_ENTRIES,
  WINDOWS_STREAM_INVENTORY_TIMEOUT_MS,
  WINDOWS_STREAM_INVENTORY_MAX_OUTPUT_BYTES,
  WINDOWS_STREAM_INVENTORY_HELPER_SHA256,
  WINDOWS_STREAM_INVENTORY_PINVOKE_SHA256,
  sanitizePathInput,
  canonicalizePortableProjectPathV1,
  resolveProjectRoot,
  normalizeForCompare,
  isPathInside,
  issueProjectStateCapability,
  issueOwnedTempCapability,
  issueFinalizedReceiptPayloadCapability,
  issueSessionEnvelopeOutputCapability,
  issueSliceEnvelopeOutputCapability,
  issueProjectHandoffOutputCapability,
  issueInitialWorktreeCapability,
  issueForkWorktreeCapability,
  issueTrustedInstallRootCapability,
  issueNodeToolchainCapability,
  resolveNodePackageBin,
  captureWorktreeManifest,
  revalidatePathCapability,
  atomicWriteFile,
  compareRemoveOwnedTemp,
  consumeOwnedTemp,
  consumeFinalizedReceiptPayload,
  withDirectoryLock,
  inspectOwnedDirectoryClaim,
  mutateFileWithPendingOperations,
  appendJsonLineLocked,
  drainPendingOperations,
  scanTrustedInstallRoot,
  spawnPortable,
  createPlatformRuntimeForTest,
} = platform;

const fixtureRoot = path.join(__dirname, '..', 'tests', 'fixtures');

function makeRepo(prefix = 'dw-platform-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], {cwd:root});
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {cwd:root});
  execFileSync('git', ['config', 'user.name', 'Deep Work Test'], {cwd:root});
  fs.mkdirSync(path.join(root, '.claude'), {recursive:true});
  fs.mkdirSync(path.join(root, '.deep-work', 's-a1b2c3d4'), {recursive:true});
  fs.writeFileSync(path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'),
    '---\nwork_dir: .deep-work/s-a1b2c3d4\n---\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'tracked\n');
  execFileSync('git', ['add', 'tracked.txt'], {cwd:root});
  execFileSync('git', ['commit', '-qm', 'fixture'], {cwd:root});
  return root;
}

function caps(root) {
  const workDir = path.join(root, '.deep-work', 's-a1b2c3d4');
  const sessionState = issueProjectStateCapability(root,
    path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
  return {
    project:issueProjectStateCapability(root, root, {role:'project-root'}),
    git:issueProjectStateCapability(root, path.join(root, '.git'), {role:'git-root'}),
    sessionState,
    work:issueProjectStateCapability(root, workDir,
      {role:'session-work-dir', sessionStateCapability:sessionState}),
    state:issueProjectStateCapability(root, path.join(root, '.claude', 'state.json'),
      {role:'state', allowMissingLeaf:true}),
  };
}

function remove(root) { fs.rmSync(root, {recursive:true, force:true}); }

function canonicalJsonForTest(value) {
  const normalize = (item) => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]))
      : item;
  return `${JSON.stringify(normalize(value))}\n`;
}

function hash(value) {
  return require('node:crypto').createHash('sha256').update(value).digest('hex');
}

function boundedUtf8(value, maxBytes = 2_048) {
  const bytes = Buffer.from(value == null ? '' : String(value), 'utf8');
  return bytes.subarray(0, maxBytes).toString('utf8');
}

function boundedCode(value) {
  return value == null ? null : boundedUtf8(value, 128);
}

function nativeSpawnEvidence(result) {
  const stdout = result?.stdout == null ? '' : String(result.stdout);
  const stderr = result?.stderr == null ? '' : String(result.stderr);
  return {
    spawnErrorCode:boundedCode(result?.error?.code),
    status:Number.isInteger(result?.status) ? result.status : null,
    signal:boundedCode(result?.signal),
    stdoutBytes:Buffer.byteLength(stdout),
    stderrBytes:Buffer.byteLength(stderr),
    stdout:boundedUtf8(stdout),
    stderr:boundedUtf8(stderr),
  };
}

function countLiteral(value, literal) {
  return value.split(literal).length - 1;
}

function containsOrderedFragments(value, fragments) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = value.indexOf(fragment, cursor + 1);
    if (next <= cursor) return false;
    cursor = next;
  }
  return true;
}

function windowsStreamPInvokeSource() {
  const helperBytes = fs.readFileSync(path.join(__dirname, 'windows-stream-inventory.ps1'));
  const helperSource = helperBytes.toString('utf8');
  const begin = helperSource.indexOf('# DEEP_WORK_PINVOKE_SOURCE_BEGIN');
  const end = helperSource.indexOf('# DEEP_WORK_PINVOKE_SOURCE_END');
  const lineStart = helperSource.indexOf('\n', begin) + 1;
  assert.equal(begin >= 0 && end > begin && lineStart > begin, true);
  return helperSource.slice(lineStart, end);
}

function windowsStreamRuntimeAttestationLines() {
  return [
    "[void](Assert-ClosedPInvokeRuntimeMethod $findFirstStream 'FindFirstStreamW' ([IntPtr]) ([Type[]]@([String], [Int32], $streamDataType.MakeByRefType(), [UInt32])) ([System.Runtime.InteropServices.CharSet]::Unicode))",
    "[void](Assert-ClosedPInvokeRuntimeMethod $findNextStream 'FindNextStreamW' ([Boolean]) ([Type[]]@([IntPtr], $streamDataType.MakeByRefType())) ([System.Runtime.InteropServices.CharSet]::Unicode))",
    "[void](Assert-ClosedPInvokeRuntimeMethod $findClose 'FindClose' ([Boolean]) ([Type[]]@([IntPtr])) ([System.Runtime.InteropServices.CharSet]::None))",
  ];
}

const EXPECTED_WINDOWS_FACTORY_CANDIDATE_MATERIALIZATION = [
  '$staticFactoryCandidates = @(',
  '  [System.Reflection.Emit.AssemblyBuilder].GetMethods() |',
  '    Where-Object {',
  "      $_.Name -eq 'DefineDynamicAssembly' -and $_.IsStatic -and",
  '      $_.GetParameters().Length -eq 2',
  '    }',
  ')',
].join('\n').replace('    Where-Object {',
  '    Microsoft.PowerShell.Core\\Where-Object {');
const EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX =
  '$staticFactory = $staticFactoryCandidates[0]';
const EXPECTED_WINDOWS_FACTORY_SELECTION_SOURCE =
  `${EXPECTED_WINDOWS_FACTORY_CANDIDATE_MATERIALIZATION}\n` +
  EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX;
const EXPECTED_WINDOWS_FACTORY_INVOCATION =
  '  $assemblyBuilder = $staticFactory.Invoke($null, @($assemblyName, $assemblyAccess))';

function assertExpectedWindowsFactorySelectionSource(source) {
  const selectionIndex = source.indexOf(EXPECTED_WINDOWS_FACTORY_SELECTION_SOURCE);
  assert.deepEqual({
    exactSelectionCount:countLiteral(source, EXPECTED_WINDOWS_FACTORY_SELECTION_SOURCE),
    candidateVariableCount:countLiteral(source, '$staticFactoryCandidates'),
    directIndexCount:countLiteral(source, EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX),
    selectObjectCount:countLiteral(source, 'Select-Object'),
    ordered:source.indexOf(
      '$assemblyAccess = [System.Reflection.Emit.AssemblyBuilderAccess]::Run') < selectionIndex &&
      selectionIndex >= 0 && selectionIndex < source.indexOf('if ($null -ne $staticFactory)'),
  }, {
    exactSelectionCount:1,
    candidateVariableCount:2,
    directIndexCount:1,
    selectObjectCount:0,
    ordered:true,
  }, 'expected Windows helper factory selection source');
}

function assertWindowsStreamTypeResolveSource(source) {
  assertExpectedWindowsFactorySelectionSource(source);
  const handlerBegin = '# DEEP_WORK_TYPE_RESOLVE_HANDLER_BEGIN';
  const handlerEnd = '# DEEP_WORK_TYPE_RESOLVE_HANDLER_END';
  const scopeBegin = '# DEEP_WORK_TYPE_RESOLVE_SCOPE_BEGIN';
  const scopeEnd = '# DEEP_WORK_TYPE_RESOLVE_SCOPE_END';
  const authenticationBegin = '# DEEP_WORK_TYPE_AUTHENTICATION_BEGIN';
  const authenticationEnd = '# DEEP_WORK_TYPE_AUTHENTICATION_END';
  for (const marker of [handlerBegin, handlerEnd, scopeBegin, scopeEnd,
    authenticationBegin, authenticationEnd]) {
    assert.equal(countLiteral(source, marker), 1, `${marker} count`);
  }
  const handlerStart = source.indexOf(handlerBegin);
  const handlerStop = source.indexOf(handlerEnd);
  const scopeStart = source.indexOf(scopeBegin);
  const scopeStop = source.indexOf(scopeEnd);
  const authenticationStart = source.indexOf(authenticationBegin);
  const authenticationStop = source.indexOf(authenticationEnd);
  assert.equal(handlerStart < handlerStop && handlerStop < scopeStart && scopeStart < scopeStop &&
    scopeStop < authenticationStart && authenticationStart < authenticationStop, true,
  'TypeResolve section order');
  const handler = source.slice(handlerStart, handlerStop);
  const scope = source.slice(scopeStart, scopeStop);
  const authentication = source.slice(authenticationStart, authenticationStop);

  assert.equal(countLiteral(source,
    "$expectedStreamDataTypeName = 'DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA'"),
  1, 'exact expected nested type name');
  assert.equal(countLiteral(source, '.add_TypeResolve($typeResolveHandler)'), 1,
    'TypeResolve registration count');
  assert.equal(countLiteral(source, '.remove_TypeResolve($typeResolveHandler)'), 1,
    'TypeResolve removal count');
  assert.equal(countLiteral(scope, 'try {'), 1, 'TypeResolve scope try count');
  assert.equal(countLiteral(scope, '} finally {'), 1, 'TypeResolve scope finally count');
  assert.equal(scope.indexOf('.add_TypeResolve($typeResolveHandler)') < scope.indexOf('try {') &&
    scope.indexOf('try {') < scope.indexOf('$nativeType = $nativeBuilder.CreateType()') &&
    scope.indexOf('$nativeType = $nativeBuilder.CreateType()') < scope.indexOf('} finally {') &&
    scope.indexOf('} finally {') < scope.indexOf('.remove_TypeResolve($typeResolveHandler)'), true,
  'TypeResolve enclosing CreateType scope');
  assert.match(scope,
    /\} finally \{\n  \$currentDomain\.remove_TypeResolve\(\$typeResolveHandler\)\n\}/u,
    'TypeResolve removal must be inside finally');
  assert.equal(countLiteral(source, '$nativeBuilder.CreateType()'), 1,
    'enclosing CreateType count');
  assert.equal(countLiteral(source, '$streamDataBuilder.CreateType()'), 2,
    'nested CreateType count');
  assert.equal(countLiteral(handler, '$streamDataBuilder.CreateType()'), 1,
    'nested CreateType handler placement');
  assert.equal(countLiteral(authentication, '$streamDataBuilder.CreateType()'), 1,
    'nested CreateType late-bake placement');
  assert.equal(handler.includes('[System.StringComparison]::Ordinal'), true,
    'ordinal TypeResolve name comparison');
  assert.equal(handler.includes('$eventArgs.Name, $expectedStreamDataTypeName'), true,
    'exact TypeResolve event name comparison');
  assert.equal(handler.includes("'stream type resolve name mismatch'"), true,
    'foreign TypeResolve rejection');
  assert.equal(handler.includes('$typeResolveState.Requests -ne 1'), true,
    'duplicate TypeResolve guard');
  assert.equal(handler.includes("'stream type resolve duplicate'"), true,
    'duplicate TypeResolve rejection');
  assert.equal(handler.includes('[Object]::Equals('), true,
    'resolved type assembly identity check');
  assert.equal(handler.includes("'stream type resolve result mismatch'"), true,
    'wrong TypeResolve result rejection');
  assert.equal(handler.includes("'stream type resolve failed'"), true,
    'TypeResolve exception rejection');
  assert.equal(countLiteral(handler, 'return $assemblyBuilder'), 1,
    'expected TypeResolve assembly return');
  assert.equal(countLiteral(handler, 'return $null'), 4,
    'closed TypeResolve null returns');
  assert.equal(handler.indexOf('$typeResolveState.Requests++') <
    handler.indexOf('$eventArgs.Name, $expectedStreamDataTypeName') &&
    handler.indexOf('$eventArgs.Name, $expectedStreamDataTypeName') <
      handler.indexOf('if ($typeResolveState.Requests -ne 1) {') &&
    handler.indexOf('if ($typeResolveState.Requests -ne 1) {') <
      handler.indexOf('$resolvedStreamDataType = $streamDataBuilder.CreateType()') &&
    handler.indexOf('$resolvedStreamDataType = $streamDataBuilder.CreateType()') <
      handler.indexOf("'stream type resolve result mismatch'") &&
    handler.indexOf("'stream type resolve result mismatch'") <
      handler.indexOf('$typeResolveState.Type = $resolvedStreamDataType') &&
    handler.indexOf('$typeResolveState.Type = $resolvedStreamDataType') <
      handler.indexOf('return $assemblyBuilder'), true,
  'TypeResolve handler fail-closed order');

  assert.equal(authentication.includes('$typeResolveState.Requests -eq 1') &&
    authentication.includes('$typeResolveState.Requests -eq 0'), true,
  'closed callback/no-dispatch request selection');
  assert.equal(countLiteral(authentication, '$null -eq $typeResolveState.Failure'), 2,
    'recorded TypeResolve failure rejection');
  assert.equal(authentication.includes('$null -ne $typeResolveState.Type') &&
    authentication.includes('$null -eq $typeResolveState.Type'), true,
  'closed callback/no-dispatch resolved type selection');
  assert.equal(authentication.includes(".GetNestedType('WIN32_FIND_STREAM_DATA',"), true,
    'canonical nested type lookup');
  assert.equal(authentication.includes(
    '$streamDataType.FullName, $expectedStreamDataTypeName'), true,
  'post-bake exact nested type name');
  assert.equal(authentication.includes(
    '[Object]::ReferenceEquals($streamDataType, $selectedStreamDataType)'), true,
  'post-bake resolved type identity');
  assert.equal(authentication.includes(
    '[Object]::ReferenceEquals($streamDataType.DeclaringType, $nativeType)'), true,
  'post-bake declaring type identity');
  assert.equal(authentication.includes(
    '[Object]::Equals($selectedStreamDataType.Assembly, $assemblyBuilder)'), true,
  'post-bake dynamic assembly identity');
  assert.equal(authentication.includes(
    '[Object]::ReferenceEquals($streamDataType.Module, $selectedStreamDataType.Module)'), true,
  'post-bake module identity');
  for (const marker of ["'stream type identity invalid'", "'stream type layout invalid'",
    "'stream type fields invalid'", "'stream type marshal invalid'",
    "'stream native methods invalid'", "'stream native signature invalid'",
    "'stream native import invalid'"]) {
    assert.equal(authentication.includes(marker), true, `${marker} authentication`);
  }
  for (const contract of ['$streamDataType.Module.ScopeName', '$streamDataType.IsValueType',
    '$streamDataType.IsNestedPublic', '$streamDataType.IsSealed',
    '$streamDataType.IsLayoutSequential', '$streamDataType.IsUnicodeClass',
    '[System.Reflection.TypeAttributes]::BeforeFieldInit', '$streamFields.Length -ne 2',
    '$streamSizeField.FieldType -ne [Int64]', '$streamNameRuntimeField.FieldType -ne [String]',
    '[System.Runtime.InteropServices.MarshalAsAttribute]',
    '[System.Runtime.InteropServices.UnmanagedType]::ByValTStr',
    '$streamNameMarshal[0].SizeConst -ne 296', '$nativeMethods.Length -ne 3',
    '$actualParameters[$parameterIndex].ParameterType -ne $ParameterTypes[$parameterIndex]',
    "$imports[0].Value, 'kernel32.dll'", '$imports[0].EntryPoint, $Name',
    '$imports[0].CharSet -ne $CharSet', '$imports[0].SetLastError',
    '$imports[0].ExactSpelling', '$imports[0].PreserveSig']) {
    assert.equal(authentication.includes(contract), true,
      `post-bake runtime contract: ${contract}`);
  }

  const fixedSourceContracts = [
    "Name = 'FindFirstStreamW'",
    'ReturnType = [IntPtr]',
    'ParameterTypes = [Type[]]@([String], [Int32], $streamDataByRef, [UInt32])',
    "Name = 'FindNextStreamW'",
    'ParameterTypes = [Type[]]@([IntPtr], $streamDataByRef)',
    "Name = 'FindClose'",
    'ParameterTypes = [Type[]]@([IntPtr])',
    "[System.Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')",
    "[System.Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling')",
    "[System.Runtime.InteropServices.DllImportAttribute].GetField('PreserveSig')",
    "[Object[]]@('kernel32.dll')",
  ];
  for (const contract of fixedSourceContracts) {
    assert.equal(countLiteral(source, contract), 1, `fixed P/Invoke contract: ${contract}`);
  }
  assert.equal(countLiteral(source,
    '[System.Runtime.InteropServices.CallingConvention]::Winapi'), 2,
  'fixed P/Invoke contract: CallingConvention.Winapi definition and authentication');
  const parserSafeRuntimeAttestations = windowsStreamRuntimeAttestationLines();
  assert.equal(countLiteral(authentication,
    '[void](Assert-ClosedPInvokeRuntimeMethod '), parserSafeRuntimeAttestations.length,
  'PowerShell 5.1 runtime attestation invocation count');
  assert.deepEqual(authentication.split('\n').filter((line) =>
    line.startsWith('[void](Assert-ClosedPInvokeRuntimeMethod ')),
  parserSafeRuntimeAttestations,
  'PowerShell 5.1 runtime attestation calls must each occupy one physical line');
}

function replaceWindowsStreamSourceOnce(source, before, after) {
  assert.equal(countLiteral(source, before), 1, `mutant anchor: ${before}`);
  return source.replace(before, after);
}

function windowsStreamProbeAttestationLines() {
  return [
    '$probeCallbackMode = $typeResolveState.Requests -eq 1 -and $null -eq $typeResolveState.Failure -and $null -ne $typeResolveState.Type -and [Object]::ReferenceEquals($streamDataType, $typeResolveState.Type) -and [Object]::ReferenceEquals($selectedStreamDataType, $typeResolveState.Type)',
    '$probeNoDispatchMode = $typeResolveState.Requests -eq 0 -and $null -eq $typeResolveState.Failure -and $null -eq $typeResolveState.Type -and $null -ne $selectedStreamDataType',
    "if (-not ($probeCallbackMode -or $probeNoDispatchMode)) { throw 'probe resolver state invalid' }",
    "if (-not [String]::Equals($streamDataType.FullName, 'DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA', [System.StringComparison]::Ordinal) -or -not [Object]::ReferenceEquals($selectedStreamDataType, $streamDataType) -or -not [Object]::ReferenceEquals($streamDataType.DeclaringType, $nativeType) -or -not [Object]::Equals($streamDataType.Assembly, $assemblyBuilder)) { throw 'probe stream type identity invalid' }",
    "if (-not $streamDataType.IsValueType -or -not $streamDataType.IsNestedPublic -or -not $streamDataType.IsSealed -or -not $streamDataType.IsLayoutSequential -or -not $streamDataType.IsUnicodeClass) { throw 'probe stream type layout invalid' }",
    '$probeFields = @($streamDataType.GetFields([System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::NonPublic -bor [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::Static -bor [System.Reflection.BindingFlags]::DeclaredOnly))',
    "$probeStreamSize = $streamDataType.GetField('StreamSize')",
    "$probeStreamName = $streamDataType.GetField('cStreamName')",
    "if ($probeFields.Length -ne 2 -or $null -eq $probeStreamSize -or $probeStreamSize.FieldType -ne [Int64] -or -not $probeStreamSize.IsPublic -or $null -eq $probeStreamName -or $probeStreamName.FieldType -ne [String] -or -not $probeStreamName.IsPublic) { throw 'probe stream fields invalid' }",
    '$probeMarshal = @($probeStreamName.GetCustomAttributes([System.Runtime.InteropServices.MarshalAsAttribute], $false))',
    "if ($probeMarshal.Length -ne 1 -or $probeMarshal[0].Value -ne [System.Runtime.InteropServices.UnmanagedType]::ByValTStr -or $probeMarshal[0].SizeConst -ne 296) { throw 'probe stream marshal invalid' }",
    'function Assert-ProbePInvokeMethod([System.Reflection.MethodInfo]$Method, [string]$Name, [Type]$ReturnType, [Type[]]$ParameterTypes, [System.Runtime.InteropServices.CharSet]$CharSet) {',
    "  if ($null -eq $Method -or -not [String]::Equals($Method.Name, $Name, [System.StringComparison]::Ordinal) -or $Method.ReturnType -ne $ReturnType) { throw 'probe native signature invalid' }",
    '  $actualParameters = @($Method.GetParameters())',
    "  if ($actualParameters.Length -ne $ParameterTypes.Length) { throw 'probe native signature invalid' }",
    '  for ($probeIndex = 0; $probeIndex -lt $ParameterTypes.Length; $probeIndex++) {',
    "    if ($actualParameters[$probeIndex].ParameterType -ne $ParameterTypes[$probeIndex]) { throw 'probe native signature invalid' }",
    '  }',
    '  $probeImports = @($Method.GetCustomAttributes([System.Runtime.InteropServices.DllImportAttribute], $false))',
    "  if ($probeImports.Length -ne 1 -or -not [String]::Equals($probeImports[0].Value, 'kernel32.dll', [System.StringComparison]::Ordinal) -or -not [String]::Equals($probeImports[0].EntryPoint, $Name, [System.StringComparison]::Ordinal) -or $probeImports[0].CharSet -ne $CharSet -or $probeImports[0].CallingConvention -ne [System.Runtime.InteropServices.CallingConvention]::Winapi -or -not $probeImports[0].SetLastError -or -not $probeImports[0].ExactSpelling -or -not $probeImports[0].PreserveSig -or ($Method.GetMethodImplementationFlags() -band [System.Reflection.MethodImplAttributes]::PreserveSig) -eq 0) { throw 'probe native import invalid' }",
    '}',
    "Assert-ProbePInvokeMethod $findFirstStream 'FindFirstStreamW' ([IntPtr]) ([Type[]]@([String], [Int32], $streamDataType.MakeByRefType(), [UInt32])) ([System.Runtime.InteropServices.CharSet]::Unicode)",
    "Assert-ProbePInvokeMethod $findNextStream 'FindNextStreamW' ([Boolean]) ([Type[]]@([IntPtr], $streamDataType.MakeByRefType())) ([System.Runtime.InteropServices.CharSet]::Unicode)",
    "Assert-ProbePInvokeMethod $findClose 'FindClose' ([Boolean]) ([Type[]]@([IntPtr])) ([System.Runtime.InteropServices.CharSet]::None)",
    '$probeResolverRequests = $typeResolveState.Requests',
    '$probeResolverType = $typeResolveState.Type',
    '$probeResolverFailure = $typeResolveState.Failure',
    "$leakProbeName = 'DeepWorkStreamInventoryLeakProbeMissingType'",
    '$leakProbeState = [PSCustomObject]@{ Requests = 0 }',
    '$leakProbeCallback = {',
    '  param($sender, $eventArgs)',
    '  if ([String]::Equals($eventArgs.Name, $leakProbeName, [System.StringComparison]::Ordinal)) { $leakProbeState.Requests++ }',
    '  return $null',
    '}.GetNewClosure()',
    '$leakProbeHandler = [System.ResolveEventHandler]$leakProbeCallback',
    '$leakProbeDomain = [AppDomain]::CurrentDomain',
    '$leakProbeDomain.add_TypeResolve($leakProbeHandler)',
    'try {',
    '  $leakProbeType = [Type]::GetType($leakProbeName, $false)',
    '} finally {',
    '  $leakProbeDomain.remove_TypeResolve($leakProbeHandler)',
    '}',
    "if ($null -ne $leakProbeType -or $leakProbeState.Requests -ne 1) { throw 'probe sentinel invalid' }",
    "if ($typeResolveState.Requests -ne $probeResolverRequests -or -not [Object]::ReferenceEquals($typeResolveState.Type, $probeResolverType) -or $typeResolveState.Failure -ne $probeResolverFailure) { throw 'probe resolver leaked' }",
  ];
}

function windowsStreamProbeScripts() {
  const pinvokeSource = windowsStreamPInvokeSource();
  const attestation = windowsStreamProbeAttestationLines();

  const prologue = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true)',
  ].join('\n') + '\n\n';
  const construct = prologue +
    `[Console]::Out.WriteLine('{"version":1,"probe":"construct","stage":"started"}')\n` +
    pinvokeSource + [
      ...attestation,
      "if ($nativeType.FullName -cne 'DeepWorkStreamInventoryNative') { throw 'native type mismatch' }",
      "if ($streamDataType.FullName -cne 'DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA') { throw 'stream data type mismatch' }",
      '$methodNames = [String[]]@($findFirstStream.Name, $findNextStream.Name, $findClose.Name)',
      "if ($methodNames.Length -ne 3 -or $methodNames[0] -cne 'FindFirstStreamW' -or $methodNames[1] -cne 'FindNextStreamW' -or $methodNames[2] -cne 'FindClose') { throw 'native method mismatch' }",
      `[Console]::Out.WriteLine('{"version":1,"probe":"construct","stage":"completed","native_type":"DeepWorkStreamInventoryNative","stream_data_type":"DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA","methods":["FindFirstStreamW","FindNextStreamW","FindClose"]}')`,
      '',
    ].join('\n');
  const parameterBlock = [
    'param(',
    '  [Parameter(Mandatory = $true)]',
    '  [string]$LiteralPath',
    ')',
  ].join('\n') + '\n\n';
  const invokeOnce = parameterBlock + prologue +
    `[Console]::Out.WriteLine('{"version":1,"probe":"invoke-once","stage":"started"}')\n` +
    pinvokeSource + [
      ...attestation,
      `[Console]::Out.WriteLine('{"version":1,"probe":"invoke-once","stage":"constructed"}')`,
      '$data = [Activator]::CreateInstance($streamDataType)',
      '$firstArguments = [Object[]]@($LiteralPath, [Int32]0, $data, [UInt32]0)',
      '$handle = [IntPtr]$findFirstStream.Invoke($null, $firstArguments)',
      '$data = $firstArguments[2]',
      '$invalidHandle = [IntPtr]::new(-1)',
      "if ($handle -eq $invalidHandle) { throw 'FindFirstStreamW returned an invalid handle' }",
      "if ($data.cStreamName -cne '::$DATA') { throw 'FindFirstStreamW returned an unexpected stream name' }",
      "if ([Int64]$data.StreamSize -ne [Int64]13) { throw 'FindFirstStreamW returned an unexpected stream size' }",
      `[Console]::Out.WriteLine('{"version":1,"probe":"invoke-once","stage":"first-returned","method":"FindFirstStreamW","invalid_handle":false,"stream_name":"::$DATA","stream_size":13}')`,
      '$next = [Activator]::CreateInstance($streamDataType)',
      '$nextArguments = [Object[]]@($handle, $next)',
      '$hasNext = [Boolean]$findNextStream.Invoke($null, $nextArguments)',
      "if ($hasNext) { throw 'FindNextStreamW returned an unexpected stream' }",
      '$nextError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()',
      "if ($nextError -ne 38) { throw 'FindNextStreamW returned an unexpected error' }",
      `[Console]::Out.WriteLine('{"version":1,"probe":"invoke-once","stage":"next-returned","method":"FindNextStreamW","has_next":false,"win32_error":38}')`,
      '$closed = [Boolean]$findClose.Invoke($null, [Object[]]@($handle))',
      "if (-not $closed) { throw 'FindClose failed' }",
      `[Console]::Out.WriteLine('{"version":1,"probe":"invoke-once","stage":"completed","method":"FindClose","closed":true}')`,
      '',
    ].join('\n');
  const invokeDirectory = parameterBlock + prologue +
    `[Console]::Out.WriteLine('{"version":1,"probe":"invoke-directory","stage":"started"}')\n` +
    pinvokeSource + [
      ...attestation,
      `[Console]::Out.WriteLine('{"version":1,"probe":"invoke-directory","stage":"constructed"}')`,
      '$data = [Activator]::CreateInstance($streamDataType)',
      '$firstArguments = [Object[]]@($LiteralPath, [Int32]0, $data, [UInt32]0)',
      '$handle = [IntPtr]$findFirstStream.Invoke($null, $firstArguments)',
      '$invalidHandle = [IntPtr]::new(-1)',
      "if ($handle -ne $invalidHandle) { [void]$findClose.Invoke($null, [Object[]]@($handle)); throw 'directory unexpectedly exposed a data stream' }",
      '$firstError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()',
      "if ($firstError -ne 38) { throw 'directory stream probe returned an unexpected error' }",
      `[Console]::Out.WriteLine('{"version":1,"probe":"invoke-directory","stage":"completed","method":"FindFirstStreamW","invalid_handle":true,"win32_error":38}')`,
      '',
    ].join('\n');
  return {construct, invokeOnce, invokeDirectory, parameterBlock, pinvokeSource};
}

function assertPinnedWindowsStreamProbeScript(script, {
  firstInvocationCount,
  nextInvocationCount = 0,
  closeInvocationCount = 0,
  literalPathParameter,
}) {
  const bytes = Buffer.from(script, 'utf8');
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(script.includes('\r'), false);
  assert.equal(countLiteral(script, '$findFirstStream.Invoke('), firstInvocationCount);
  assert.equal(countLiteral(script, '$findNextStream.Invoke('), nextInvocationCount);
  assert.equal(countLiteral(script, '$findClose.Invoke('), closeInvocationCount);
  const forbiddenPatterns = [
    /\bAdd-Type\b/gi,
    /\bGet-Item\b/gi,
    /\bConvertTo-Json\b/gi,
    /\bInvoke-Expression\b/gi,
    /\biex\b/gi,
    /\bInvoke-Command\b/gi,
    /\bStart-Process\b/gi,
    /\bScriptBlock\b/gi,
    /\b(?:cmd|pwsh)(?:\.exe)?\b/gi,
    /(?:^|\n)\s*&\s*/g,
  ];
  assert.equal(forbiddenPatterns.reduce((count, pattern) =>
    count + (script.match(pattern) || []).length, 0), 0);
  assert.equal(countLiteral(script, '$args'), 0);
  assert.equal(countLiteral(script, '[Console]::InputEncoding'), 1);
  assert.equal(countLiteral(script, '[Console]::In.'), 0);
  assert.equal(countLiteral(script, 'Read-Host'), 0);
  assert.equal(countLiteral(script, '[Environment]::'), 0);
  if (literalPathParameter) {
    assert.equal(script.startsWith(literalPathParameter), true);
    assert.equal(countLiteral(script, '[Parameter(Mandatory = $true)]'), 1);
    assert.equal(countLiteral(script, '[string]$LiteralPath'), 1);
    assert.equal(countLiteral(script, '$LiteralPath'), 2);
  } else {
    assert.equal(countLiteral(script, '[Parameter('), 0);
    assert.equal(countLiteral(script, '$LiteralPath'), 0);
  }
}

function nativeWindowsProbeEvidence(probe, result, elapsedMs, expectedStageNames) {
  const stdout = result?.stdout == null ? '' : String(result.stdout);
  const stderr = result?.stderr == null ? '' : String(result.stderr);
  const boundedStdout = boundedUtf8(stdout);
  const allowedStages = new Set(expectedStageNames);
  const stages = [];
  for (const line of boundedStdout.replace(/\r\n/g, '\n').split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.version === 1 && record?.probe === probe &&
        allowedStages.has(record?.stage) && !stages.includes(record.stage)) {
      stages.push(record.stage);
    }
  }
  return {
    probe,
    elapsedMs,
    spawnErrorCode:boundedCode(result?.error?.code),
    status:Number.isInteger(result?.status) ? result.status : null,
    signal:boundedCode(result?.signal),
    stdoutBytes:Buffer.byteLength(stdout),
    stderrBytes:Buffer.byteLength(stderr),
    stdout:boundedStdout,
    stderr:boundedUtf8(stderr),
    stages,
  };
}

function runNativeWindowsStreamProbe({
  probe,
  root,
  script,
  literalPath = null,
  expectedRecords,
  expectedStageNames,
}) {
  assert.equal(probe === 'construct' && literalPath === null ||
    ['invoke-once','invoke-directory'].includes(probe) && typeof literalPath === 'string', true);
  const scriptPath = path.join(root, `${probe}.ps1`);
  const args = literalPath === null ? [] : ['-LiteralPath',literalPath];
  const scriptBytes = Buffer.from(script, 'utf8');
  assert.equal(scriptBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(script.includes('\r'), false);
  fs.writeFileSync(scriptPath, scriptBytes);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const temp = process.env.TEMP || process.env.TMP || os.tmpdir();
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell',
    'v1.0', 'powershell.exe');
  const closedEnv = {
    SystemRoot:systemRoot,
    WINDIR:systemRoot,
    TEMP:temp,
    TMP:temp,
    PATH:'',
    PSModulePath:'',
  };
  const startedAt = Date.now();
  const result = spawnSync(executable,
    ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',scriptPath,...args], {
      cwd:root,
      env:closedEnv,
      encoding:'utf8',
      shell:false,
      windowsHide:true,
      timeout:WINDOWS_STREAM_INVENTORY_TIMEOUT_MS,
      maxBuffer:WINDOWS_STREAM_INVENTORY_MAX_OUTPUT_BYTES,
    });
  const elapsedMs = Date.now() - startedAt;
  const diagnostic = JSON.stringify(nativeWindowsProbeEvidence(
    probe, result, elapsedMs, expectedStageNames));
  assert.equal(result.error === undefined, true, diagnostic);
  assert.equal(result.status === 0, true, diagnostic);
  assert.equal(result.signal === null, true, diagnostic);
  assert.equal(result.stderr === '', true, diagnostic);
  assert.equal(typeof result.stdout === 'string', true, diagnostic);
  const expectedOutput = `${expectedRecords.map(JSON.stringify).join('\n')}\n`;
  assert.equal(result.stdout.replace(/\r\n/g, '\n'), expectedOutput, diagnostic);
  const records = result.stdout.replace(/\r\n/g, '\n').trimEnd().split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(records, expectedRecords, diagnostic);
  return {elapsedMs, scriptSha256:hash(scriptBytes)};
}

const TYPE_RESOLVE_DIAGNOSTIC_MAX_STDOUT_BYTES = 8_192;
const TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS = 64;
const TYPE_RESOLVE_IDENTITY_KEYS = [
  'version','probe','stage','ps_edition','ps_major','ps_minor','ps_build','ps_revision',
  'clr_major','clr_minor','clr_build','clr_revision','framework_release',
  'os_major','os_minor','os_build','os_revision',
];
const TYPE_RESOLVE_STAGE_KEYS = ['version','probe','stage'];
const TYPE_RESOLVE_DISPATCH_GREEN_STAGES = [
  'started','delegate-created','handler-registered','lookup-enter','handler-entered',
  'name-exact','request-1','handler-return-null','lookup-returned','handler-removed','completed',
];
const TYPE_RESOLVE_DISPATCH_ALLOWED_STAGES = [
  ...TYPE_RESOLVE_DISPATCH_GREEN_STAGES,'name-foreign','request-duplicate',
];
const TYPE_RESOLVE_DOCUMENTED_BASE_SCRIPT_SHA256 =
  'c329836684c850a1b87c197defc86ed25966a210c96fab9057127e4d2f1f90b8';
const TYPE_RESOLVE_DOCUMENTED_BASE_SCRIPT_BYTES = 8_425;
const TYPE_RESOLVE_DOCUMENTED_BASE_SCRIPT_LINES = 145;
const TYPE_RESOLVE_DOCUMENTED_SETUP_INSERTED_STAGES = [
  'assembly-name-ready','assembly-access-ready',
  'factory-search-enter','factory-search-return',
  'assembly-create-enter','assembly-create-static','assembly-create-appdomain',
  'assembly-create-return','module-create-enter','module-create-return',
  'outer-builder-enter','outer-builder-return',
  'nested-builder-enter','nested-builder-return',
  'nested-field-enter','nested-field-return',
  'outer-field-enter','outer-field-return',
  'callback-build-enter','callback-closure-ready','delegate-create-enter',
  'domain-ready','handler-register-enter',
];
const TYPE_RESOLVE_DOCUMENTED_PREFIX_BEFORE_ASSEMBLY_BRANCH = [
  'started','assembly-name-ready','assembly-access-ready',
  'factory-search-enter','factory-search-return','assembly-create-enter',
];
const TYPE_RESOLVE_DOCUMENTED_ASSEMBLY_BRANCH_STAGES = [
  'assembly-create-static','assembly-create-appdomain',
];
const TYPE_RESOLVE_DOCUMENTED_PREFIX_AFTER_ASSEMBLY_BRANCH = [
  'assembly-create-return','module-create-enter','module-create-return',
  'outer-builder-enter','outer-builder-return',
  'nested-builder-enter','nested-builder-return',
  'nested-field-enter','nested-field-return',
  'outer-field-enter','outer-field-return','builders-ready',
  'callback-build-enter','callback-closure-ready','delegate-create-enter','delegate-created',
  'domain-ready','handler-register-enter','handler-registered','enclosing-create-enter',
];
const TYPE_RESOLVE_DOCUMENTED_OUTER_SUFFIX = [
  'enclosing-create-return','handler-removed','completed',
];
const TYPE_RESOLVE_DOCUMENTED_ALLOWED_STAGES = [
  ...TYPE_RESOLVE_DOCUMENTED_PREFIX_BEFORE_ASSEMBLY_BRANCH,
  ...TYPE_RESOLVE_DOCUMENTED_ASSEMBLY_BRANCH_STAGES,
  ...TYPE_RESOLVE_DOCUMENTED_PREFIX_AFTER_ASSEMBLY_BRANCH,
  'resolver-entered','request-1','request-2','request-3plus','name-exact','name-other',
  'nested-create-enter','nested-create-return','nested-already-created','return-assembly',
  ...TYPE_RESOLVE_DOCUMENTED_OUTER_SUFFIX,
];
const TYPE_RESOLVE_PINNED_INSERTED_STAGES = [
  'factory-candidates-ready','factory-index-enter','factory-index-return',
  'factory-branch-enter','factory-invoke-enter','factory-invoke-return',
  'factory-fallback-enter','factory-fallback-return',
  'assembly-ready','module-ready','native-builder-ready','stream-builder-ready',
  'stream-fields-ready','byref-ready','methods-defined','callback-build-enter',
  'resolver-entered','resolver-request-incremented','resolver-name-foreign',
  'resolver-reject-name','resolver-name-exact','resolver-reject-duplicate',
  'resolver-request-1','resolver-nested-create-enter','resolver-nested-create-return',
  'resolver-result-authenticated','resolver-return-assembly','resolver-catch',
  'callback-closure-ready','delegate-ready','handler-registered','enclosing-create-enter',
  'enclosing-create-return','enclosing-create-catch','handler-remove-enter','handler-removed',
  'scope-exited','resolver-state-authenticated','nested-type-authenticated',
  'methods-reflected','methods-authenticated',
];
const TYPE_RESOLVE_PINNED_STATE_CLASSIFICATION_STAGES = [
  'state-native-create-succeeded','state-native-create-failed',
  'state-requests-zero','state-requests-one','state-requests-other',
  'state-failure-null','state-failure-name-mismatch','state-failure-duplicate',
  'state-failure-result-mismatch','state-failure-catch','state-failure-other',
  'state-type-null','state-type-present',
];
const TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXES = [
  {
    id:'canonical-present',
    setup:[
      '    $lateBakeIdentityAxisNestedFlags = [System.Reflection.BindingFlags]::Public -bor',
      '      [System.Reflection.BindingFlags]::NonPublic',
      "    $lateBakeIdentityAxisCanonicalType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA',",
      '      $lateBakeIdentityAxisNestedFlags)',
    ],
    predicate:[
      '    $lateBakeIdentityAxisMatch = $null -ne $lateBakeIdentityAxisCanonicalType',
    ],
  },
  {
    id:'canonical-reference',
    predicate:[
      '    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',
      '      $lateBakeType, $lateBakeIdentityAxisCanonicalType)',
    ],
  },
  {
    id:'full-name',
    predicate:[
      "    $lateBakeIdentityAxisMatch = [String]::Equals($lateBakeType.FullName,",
      "      'DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA',",
      '      [System.StringComparison]::Ordinal)',
    ],
  },
  {
    id:'declaring-type',
    predicate:[
      '    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',
      '      $lateBakeType.DeclaringType, $nativeType)',
    ],
  },
  {
    id:'assembly',
    predicate:[
      '    $lateBakeIdentityAxisMatch = [Object]::Equals(',
      '      $lateBakeType.Assembly, $assemblyBuilder)',
    ],
  },
  {
    id:'module',
    predicate:[
      '    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',
      '      $lateBakeType.Module, $nativeType.Module)',
    ],
  },
  {id:'value-type', predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsValueType']},
  {
    id:'nested-public',
    predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsNestedPublic'],
  },
  {id:'sealed', predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsSealed']},
  {
    id:'sequential-layout',
    predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsLayoutSequential'],
  },
  {
    id:'unicode-class',
    predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsUnicodeClass'],
  },
  {
    id:'before-field-init',
    predicate:[
      '    $lateBakeIdentityAxisMatch = ($lateBakeType.Attributes -band',
      '      [System.Reflection.TypeAttributes]::BeforeFieldInit) -ne 0',
    ],
  },
];
const TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES =
  TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXES.flatMap(({id}) => [
    `late-bake-identity-axis-${id}-exception`,
    `late-bake-identity-axis-${id}-mismatch`,
  ]);
const TYPE_RESOLVE_PINNED_LATE_BAKE_STAGES = [
  'late-bake-applicable','late-bake-create-enter','late-bake-create-return',
  'late-bake-create-exception','late-bake-result-null',
  ...TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES,
  'late-bake-identity-authenticated','late-bake-identity-exception',
  'late-bake-identity-mismatch','late-bake-fields-authenticated',
  'late-bake-fields-exception','late-bake-fields-mismatch',
  'late-bake-methods-authenticated','late-bake-methods-exception',
  'late-bake-methods-mismatch','late-bake-interop-authenticated',
  'late-bake-interop-exception','late-bake-interop-mismatch','late-bake-completed',
];
const TYPE_RESOLVE_PINNED_LATE_BAKE_PHASES = [
  ['identity','late-bake-identity-authenticated','late-bake-identity-exception',
    'late-bake-identity-mismatch'],
  ['fields','late-bake-fields-authenticated','late-bake-fields-exception',
    'late-bake-fields-mismatch'],
  ['methods','late-bake-methods-authenticated','late-bake-methods-exception',
    'late-bake-methods-mismatch'],
  ['interop','late-bake-interop-authenticated','late-bake-interop-exception',
    'late-bake-interop-mismatch'],
];
const TYPE_RESOLVE_PINNED_CALLBACK_OUTPUT_GUARDS = [
  ['resolver-entered','before-increment'],
  ['resolver-request-incremented','after-increment'],
  ['resolver-name-foreign','after-increment'],
  ['resolver-reject-name','after-increment'],
  ['resolver-name-exact','after-increment'],
  ['resolver-reject-duplicate','after-increment'],
  ['resolver-request-1','after-increment'],
  ['resolver-nested-create-enter','after-increment'],
  ['resolver-nested-create-return','after-increment'],
  ['resolver-result-authenticated','after-increment'],
  ['resolver-return-assembly','after-increment'],
  ['resolver-catch','after-increment'],
];
const EXPECTED_TYPE_RESOLVE_PINNED_FACTORY_STAGES = [
  'factory-candidates-ready','factory-index-enter','factory-index-return',
  'factory-branch-enter','factory-invoke-enter','factory-invoke-return',
  'factory-fallback-enter','factory-fallback-return',
];
const EXPECTED_TYPE_RESOLVE_PINNED_INSERTED_STAGES = [
  ...EXPECTED_TYPE_RESOLVE_PINNED_FACTORY_STAGES,
  'assembly-ready','module-ready','native-builder-ready','stream-builder-ready',
  'stream-fields-ready','byref-ready','methods-defined','callback-build-enter',
  'resolver-entered','resolver-request-incremented','resolver-name-foreign',
  'resolver-reject-name','resolver-name-exact','resolver-reject-duplicate',
  'resolver-request-1','resolver-nested-create-enter','resolver-nested-create-return',
  'resolver-result-authenticated','resolver-return-assembly','resolver-catch',
  'callback-closure-ready','delegate-ready','handler-registered','enclosing-create-enter',
  'enclosing-create-return','enclosing-create-catch','handler-remove-enter','handler-removed',
  'scope-exited','resolver-state-authenticated','nested-type-authenticated',
  'methods-reflected','methods-authenticated',
];
const TYPE_RESOLVE_PINNED_ALLOWED_STAGES = [
  'started',
  ...TYPE_RESOLVE_PINNED_INSERTED_STAGES.flatMap((stage) =>
    stage === 'scope-exited'
      ? [stage, ...TYPE_RESOLVE_PINNED_STATE_CLASSIFICATION_STAGES,
        ...TYPE_RESOLVE_PINNED_LATE_BAKE_STAGES]
      : [stage]),
  'completed',
];
const TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES = [
  'started',
  'type-token-enter','type-token-return',
  'get-methods-enter','get-methods-return',
  'name-filter-enter','name-filter-return',
  'static-filter-enter','static-filter-return',
  'parameter-filter-enter','parameter-filter-return',
  'index-enter','index-return',
  'indexed-null','indexed-present',
  'completed',
];
const EXPECTED_TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES = [
  'started',
  'type-token-enter','type-token-return',
  'get-methods-enter','get-methods-return',
  'name-filter-enter','name-filter-return',
  'static-filter-enter','static-filter-return',
  'parameter-filter-enter','parameter-filter-return',
  'index-enter','index-return',
  'indexed-null','indexed-present',
  'completed',
];

function typeResolveIdentityFixture(probe) {
  return {
    version:1,
    probe,
    stage:'runtime-identity',
    ps_edition:'Desktop',
    ps_major:5,
    ps_minor:1,
    ps_build:19_041,
    ps_revision:1,
    clr_major:4,
    clr_minor:0,
    clr_build:30_319,
    clr_revision:4_200,
    framework_release:533_320,
    os_major:10,
    os_minor:0,
    os_build:26_100,
    os_revision:4_349,
  };
}

function typeResolveStageLine(probe, stage, indent = '') {
  return `${indent}[Console]::Out.WriteLine('${JSON.stringify({version:1, probe, stage})}')`;
}

const EXPECTED_TYPE_RESOLVE_PINNED_STATE_STAGES = [
  'state-native-create-succeeded','state-native-create-failed',
  'state-requests-zero','state-requests-one','state-requests-other',
  'state-failure-null','state-failure-name-mismatch','state-failure-duplicate',
  'state-failure-result-mismatch','state-failure-catch','state-failure-other',
  'state-type-null','state-type-present',
];
const EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_STAGES = [
  'late-bake-applicable','late-bake-create-enter','late-bake-create-return',
  'late-bake-create-exception','late-bake-result-null',
  'late-bake-identity-authenticated','late-bake-identity-exception',
  'late-bake-identity-mismatch','late-bake-fields-authenticated',
  'late-bake-fields-exception','late-bake-fields-mismatch',
  'late-bake-methods-authenticated','late-bake-methods-exception',
  'late-bake-methods-mismatch','late-bake-interop-authenticated',
  'late-bake-interop-exception','late-bake-interop-mismatch','late-bake-completed',
];
const EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_PHASES = [
  ['identity','late-bake-identity-authenticated','late-bake-identity-exception',
    'late-bake-identity-mismatch'],
  ['fields','late-bake-fields-authenticated','late-bake-fields-exception',
    'late-bake-fields-mismatch'],
  ['methods','late-bake-methods-authenticated','late-bake-methods-exception',
    'late-bake-methods-mismatch'],
  ['interop','late-bake-interop-authenticated','late-bake-interop-exception',
    'late-bake-interop-mismatch'],
];
const EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXES = [
  {
    id:'canonical-present',
    setup:[
      '    $lateBakeIdentityAxisNestedFlags = [System.Reflection.BindingFlags]::Public -bor',
      '      [System.Reflection.BindingFlags]::NonPublic',
      "    $lateBakeIdentityAxisCanonicalType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA',",
      '      $lateBakeIdentityAxisNestedFlags)',
    ],
    predicate:[
      '    $lateBakeIdentityAxisMatch = $null -ne $lateBakeIdentityAxisCanonicalType',
    ],
  },
  {
    id:'canonical-reference',
    predicate:[
      '    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',
      '      $lateBakeType, $lateBakeIdentityAxisCanonicalType)',
    ],
  },
  {
    id:'full-name',
    predicate:[
      "    $lateBakeIdentityAxisMatch = [String]::Equals($lateBakeType.FullName,",
      "      'DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA',",
      '      [System.StringComparison]::Ordinal)',
    ],
  },
  {
    id:'declaring-type',
    predicate:[
      '    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',
      '      $lateBakeType.DeclaringType, $nativeType)',
    ],
  },
  {
    id:'assembly',
    predicate:[
      '    $lateBakeIdentityAxisMatch = [Object]::Equals(',
      '      $lateBakeType.Assembly, $assemblyBuilder)',
    ],
  },
  {
    id:'module',
    predicate:[
      '    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',
      '      $lateBakeType.Module, $nativeType.Module)',
    ],
  },
  {id:'value-type', predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsValueType']},
  {
    id:'nested-public',
    predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsNestedPublic'],
  },
  {id:'sealed', predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsSealed']},
  {
    id:'sequential-layout',
    predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsLayoutSequential'],
  },
  {
    id:'unicode-class',
    predicate:['    $lateBakeIdentityAxisMatch = $lateBakeType.IsUnicodeClass'],
  },
  {
    id:'before-field-init',
    predicate:[
      '    $lateBakeIdentityAxisMatch = ($lateBakeType.Attributes -band',
      '      [System.Reflection.TypeAttributes]::BeforeFieldInit) -ne 0',
    ],
  },
];
const EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES =
  EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXES.flatMap(({id}) => [
    `late-bake-identity-axis-${id}-exception`,
    `late-bake-identity-axis-${id}-mismatch`,
  ]);
const EXPECTED_TYPE_RESOLVE_PINNED_CALLBACK_GUARDS = [
  ['resolver-entered','-lt'],
  ['resolver-request-incremented','-le'],
  ['resolver-name-foreign','-le'],
  ['resolver-reject-name','-le'],
  ['resolver-name-exact','-le'],
  ['resolver-reject-duplicate','-le'],
  ['resolver-request-1','-le'],
  ['resolver-nested-create-enter','-le'],
  ['resolver-nested-create-return','-le'],
  ['resolver-result-authenticated','-le'],
  ['resolver-return-assembly','-le'],
  ['resolver-catch','-le'],
];
const EXPECTED_TYPE_RESOLVE_PINNED_PRE_GREEN_INSERTED_STAGES = [
  'factory-candidates-ready','factory-index-enter','factory-index-return',
  'factory-branch-enter','factory-invoke-enter','factory-invoke-return',
  'factory-fallback-enter','factory-fallback-return',
  'assembly-ready','module-ready','native-builder-ready','stream-builder-ready',
  'stream-fields-ready','byref-ready','methods-defined','callback-build-enter',
  'resolver-entered','resolver-request-incremented','resolver-name-foreign',
  'resolver-reject-name','resolver-name-exact','resolver-reject-duplicate',
  'resolver-request-1','resolver-nested-create-enter','resolver-nested-create-return',
  'resolver-result-authenticated','resolver-return-assembly','resolver-catch',
  'callback-closure-ready','delegate-ready','handler-registered','enclosing-create-enter',
  'enclosing-create-return','enclosing-create-catch','handler-remove-enter','handler-removed',
  'scope-exited','resolver-state-authenticated','nested-type-authenticated',
  'methods-reflected','methods-authenticated',
];
const EXPECTED_TYPE_RESOLVE_PINNED_FIRST_GROUPS = {
  success:[
    'resolver-entered','resolver-request-incremented','resolver-name-exact',
    'resolver-request-1','resolver-nested-create-enter','resolver-nested-create-return',
    'resolver-result-authenticated','resolver-return-assembly',
  ],
  foreign:[
    'resolver-entered','resolver-request-incremented','resolver-name-foreign',
    'resolver-reject-name',
  ],
  result:[
    'resolver-entered','resolver-request-incremented','resolver-name-exact',
    'resolver-request-1','resolver-nested-create-enter','resolver-nested-create-return',
  ],
  catch:[
    'resolver-entered','resolver-request-incremented','resolver-name-exact',
    'resolver-request-1','resolver-nested-create-enter','resolver-catch',
  ],
};
const EXPECTED_TYPE_RESOLVE_PINNED_SECOND_GROUPS = {
  foreign:[
    'resolver-entered','resolver-request-incremented','resolver-name-foreign',
    'resolver-reject-name',
  ],
  duplicate:[
    'resolver-entered','resolver-request-incremented','resolver-name-exact',
    'resolver-reject-duplicate',
  ],
};
const EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT = {
  firstGroups:['success','foreign','result','catch'],
  secondGroups:['foreign','duplicate'],
  finalFailures:['name-mismatch','duplicate'],
  otherCombinationCount:16,
  coupleFinalFailureToSecondGroup:false,
};
const EXPECTED_TYPE_RESOLVE_PINNED_RECORD_PREFIX = [
  'runtime-identity','started','factory-candidates-ready','factory-index-enter',
  'factory-index-return','factory-branch-enter','factory-invoke-enter',
  'factory-invoke-return','assembly-ready','module-ready','native-builder-ready',
  'stream-builder-ready','stream-fields-ready','byref-ready','methods-defined',
  'callback-build-enter','callback-closure-ready','delegate-ready','handler-registered',
  'enclosing-create-enter',
];
const EXPECTED_TYPE_RESOLVE_PINNED_SUCCESS_SUFFIX = [
  'resolver-state-authenticated','nested-type-authenticated','methods-reflected',
  'methods-authenticated','completed',
];

function expectedTypeResolvePinnedStateDiagnosticBlock() {
  const marker = (stage, indent = '') => typeResolveStageLine('pinned', stage, indent);
  return [
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_BEGIN',
    'if ($nativeTypeFailure) {',
    marker('state-native-create-failed', '  '),
    '} else {',
    marker('state-native-create-succeeded', '  '),
    '}',
    'if ($typeResolveState.Requests -eq 0) {',
    marker('state-requests-zero', '  '),
    '} elseif ($typeResolveState.Requests -eq 1) {',
    marker('state-requests-one', '  '),
    '} else {',
    marker('state-requests-other', '  '),
    '}',
    'if ($null -eq $typeResolveState.Failure) {',
    marker('state-failure-null', '  '),
    "} elseif ($typeResolveState.Failure -ceq 'stream type resolve name mismatch') {",
    marker('state-failure-name-mismatch', '  '),
    "} elseif ($typeResolveState.Failure -ceq 'stream type resolve duplicate') {",
    marker('state-failure-duplicate', '  '),
    "} elseif ($typeResolveState.Failure -ceq 'stream type resolve result mismatch') {",
    marker('state-failure-result-mismatch', '  '),
    "} elseif ($typeResolveState.Failure -ceq 'stream type resolve failed') {",
    marker('state-failure-catch', '  '),
    '} else {',
    marker('state-failure-other', '  '),
    '}',
    'if ($null -eq $typeResolveState.Type) {',
    marker('state-type-null', '  '),
    '} else {',
    marker('state-type-present', '  '),
    '}',
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END',
  ].join('\n');
}

function expectedTypeResolvePinnedGuardedMarker(stage, comparison) {
  return [
    `if ($typeResolveState.Requests ${comparison} 2) {`,
    typeResolveStageLine('pinned', stage),
    '}',
  ].join('\n');
}

function expectedPinnedPreGreenDiagnosticBaseline() {
  const original = windowsStreamPInvokeSource();
  const specifications = [
    {id:'factory-candidates-ready', anchor:EXPECTED_WINDOWS_FACTORY_CANDIDATE_MATERIALIZATION},
    {id:'factory-index-enter', anchor:EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX, placement:'before'},
    {id:'factory-index-return', anchor:EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX},
    {id:'factory-branch-enter', anchor:'if ($null -ne $staticFactory) {', placement:'before'},
    {id:'factory-invoke-enter', anchor:'  $assemblyBuilder = $staticFactory.Invoke($null, @($assemblyName, $assemblyAccess))', placement:'before'},
    {id:'factory-invoke-return', anchor:'  $assemblyBuilder = $staticFactory.Invoke($null, @($assemblyName, $assemblyAccess))'},
    {id:'factory-fallback-enter', anchor:'  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)', placement:'before'},
    {id:'factory-fallback-return', anchor:'  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)'},
    {id:'assembly-ready', anchor:`  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)\n${typeResolveStageLine('pinned', 'factory-fallback-return')}\n}`},
    {id:'module-ready', anchor:"$moduleBuilder = $assemblyBuilder.DefineDynamicModule('DeepWorkStreamInventoryNativeModule')"},
    {id:'native-builder-ready', anchor:"$nativeBuilder = $moduleBuilder.DefineType('DeepWorkStreamInventoryNative', $nativeAttributes)"},
    {id:'stream-builder-ready', anchor:"$streamDataBuilder = $nativeBuilder.DefineNestedType('WIN32_FIND_STREAM_DATA',\n  $streamDataAttributes, [ValueType])"},
    {id:'stream-fields-ready', anchor:'$streamNameField.SetCustomAttribute($marshalAttribute)'},
    {id:'byref-ready', anchor:'$streamDataByRef = $streamDataType.MakeByRefType()'},
    {id:'methods-defined', anchor:'[void](Add-ClosedPInvokeMethod @findCloseDefinition)'},
    {id:'callback-build-enter', anchor:'$typeResolveCallback = {', placement:'before'},
    {id:'resolver-entered', anchor:'  param($sender, $eventArgs)'},
    {id:'resolver-request-incremented', anchor:'    $typeResolveState.Requests++'},
    {id:'resolver-name-foreign', anchor:'    if (-not [String]::Equals($eventArgs.Name, $expectedStreamDataTypeName,\n        [System.StringComparison]::Ordinal)) {'},
    {id:'resolver-reject-name', anchor:"      $typeResolveState.Failure = 'stream type resolve name mismatch'"},
    {id:'resolver-name-exact', anchor:'    if ($typeResolveState.Requests -ne 1) {', placement:'before'},
    {id:'resolver-reject-duplicate', anchor:'    if ($typeResolveState.Requests -ne 1) {'},
    {id:'resolver-request-1', anchor:'    $resolvedStreamDataType = $streamDataBuilder.CreateType()', placement:'before'},
    {id:'resolver-nested-create-enter', anchor:'    $resolvedStreamDataType = $streamDataBuilder.CreateType()', placement:'before'},
    {id:'resolver-nested-create-return', anchor:'    $resolvedStreamDataType = $streamDataBuilder.CreateType()'},
    {id:'resolver-result-authenticated', anchor:'    $typeResolveState.Type = $resolvedStreamDataType', placement:'before'},
    {id:'resolver-return-assembly', anchor:'    return $assemblyBuilder', placement:'before'},
    {id:'resolver-catch', anchor:'    return $assemblyBuilder\n  } catch {'},
    {id:'callback-closure-ready', anchor:'}.GetNewClosure()'},
    {id:'delegate-ready', anchor:'$typeResolveHandler = [System.ResolveEventHandler]$typeResolveCallback'},
    {id:'handler-registered', anchor:'$currentDomain.add_TypeResolve($typeResolveHandler)'},
    {id:'enclosing-create-enter', anchor:'  $nativeType = $nativeBuilder.CreateType()', placement:'before'},
    {id:'enclosing-create-return', anchor:'  $nativeType = $nativeBuilder.CreateType()'},
    {id:'enclosing-create-catch', anchor:'  $nativeTypeFailure = $true', placement:'before'},
    {id:'handler-remove-enter', anchor:'} finally {'},
    {id:'handler-removed', anchor:'  $currentDomain.remove_TypeResolve($typeResolveHandler)'},
    {id:'scope-exited', anchor:'# DEEP_WORK_TYPE_RESOLVE_SCOPE_END', placement:'before'},
    {id:'resolver-state-authenticated', anchor:'$nestedTypeFlags = [System.Reflection.BindingFlags]::Public -bor', placement:'before'},
    {id:'nested-type-authenticated', anchor:'$nativeMethodFlags = [System.Reflection.BindingFlags]::Public -bor', placement:'before'},
    {id:'methods-reflected', anchor:"$findClose = $nativeType.GetMethod('FindClose', $nativeMethodFlags)"},
    {id:'methods-authenticated', anchor:windowsStreamRuntimeAttestationLines()[2]},
  ];
  assert.deepEqual(specifications.map(({id}) => id),
    EXPECTED_TYPE_RESOLVE_PINNED_PRE_GREEN_INSERTED_STAGES,
  'expected pinned frozen pre-GREEN marker specification order');
  let transformed = original;
  for (const specification of specifications) {
    transformed = applyPinnedTypeResolveMarker(transformed, specification).source;
  }
  return {original, transformed};
}

function expectedPinnedPostScopeResolverStateFixture() {
  const base = expectedPinnedPreGreenDiagnosticBaseline();
  let transformed = base.transformed;
  for (const [stage, comparison] of EXPECTED_TYPE_RESOLVE_PINNED_CALLBACK_GUARDS) {
    const marker = typeResolveStageLine('pinned', stage);
    assert.equal(countLiteral(transformed, marker), 1,
      `expected pinned fixture callback marker ${stage}`);
    transformed = transformed.replace(marker,
      expectedTypeResolvePinnedGuardedMarker(stage, comparison));
  }
  const insertionAnchor = '# DEEP_WORK_TYPE_AUTHENTICATION_BEGIN\n';
  assert.equal(countLiteral(transformed, insertionAnchor), 1,
    'expected pinned fixture classifier anchor');
  transformed = transformed.replace(insertionAnchor,
    `${insertionAnchor}${expectedTypeResolvePinnedStateDiagnosticBlock()}\n`);
  return {original:base.original, transformed};
}

function expectedPinnedNoDispatchLateBakeBlock() {
  const marker = (stage, indent = '') => typeResolveStageLine('pinned', stage, indent);
  return [
    '# DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_DIAGNOSTIC_BEGIN',
    '$lateBakeApplicable = -not $nativeTypeFailure -and',
    '  $typeResolveState.Requests -eq 0 -and',
    '  $null -eq $typeResolveState.Failure -and',
    '  $null -eq $typeResolveState.Type',
    'if ($lateBakeApplicable) {',
    marker('late-bake-applicable', '  '),
    marker('late-bake-create-enter', '  '),
    '  try {',
    '    $lateBakeType = $streamDataBuilder.CreateType()',
    marker('late-bake-create-return', '    '),
    '  } catch {',
    marker('late-bake-create-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if ($null -eq $lateBakeType) {',
    marker('late-bake-result-null', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  try {',
    '    $lateBakeNestedFlags = [System.Reflection.BindingFlags]::Public -bor',
    '      [System.Reflection.BindingFlags]::NonPublic',
    "    $lateBakeCanonicalType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA',",
    '      $lateBakeNestedFlags)',
    '    $lateBakeIdentityMatch = $null -ne $lateBakeCanonicalType -and',
    '      [Object]::ReferenceEquals($lateBakeType, $lateBakeCanonicalType) -and',
    "      [String]::Equals($lateBakeType.FullName, 'DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA',",
    '        [System.StringComparison]::Ordinal) -and',
    '      [Object]::ReferenceEquals($lateBakeType.DeclaringType, $nativeType) -and',
    '      [Object]::Equals($lateBakeType.Assembly, $assemblyBuilder) -and',
    '      [Object]::ReferenceEquals($lateBakeType.Module, $nativeType.Module) -and',
    '      $lateBakeType.IsValueType -and $lateBakeType.IsNestedPublic -and',
    '      $lateBakeType.IsSealed -and $lateBakeType.IsLayoutSequential -and',
    '      $lateBakeType.IsUnicodeClass -and',
    '      ($lateBakeType.Attributes -band',
    '        [System.Reflection.TypeAttributes]::BeforeFieldInit) -ne 0',
    '  } catch {',
    marker('late-bake-identity-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if (-not $lateBakeIdentityMatch) {',
    marker('late-bake-identity-mismatch', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    marker('late-bake-identity-authenticated', '  '),
    '  try {',
    '    $lateBakeFieldFlags = [System.Reflection.BindingFlags]::Public -bor',
    '      [System.Reflection.BindingFlags]::NonPublic -bor',
    '      [System.Reflection.BindingFlags]::Instance -bor',
    '      [System.Reflection.BindingFlags]::Static -bor',
    '      [System.Reflection.BindingFlags]::DeclaredOnly',
    '    $lateBakeFields = @($lateBakeType.GetFields($lateBakeFieldFlags))',
    "    $lateBakeStreamSizeField = $lateBakeType.GetField('StreamSize', $lateBakeFieldFlags)",
    "    $lateBakeStreamNameField = $lateBakeType.GetField('cStreamName', $lateBakeFieldFlags)",
    '    $lateBakeMarshal = @($lateBakeStreamNameField.GetCustomAttributes(',
    '      [System.Runtime.InteropServices.MarshalAsAttribute], $false))',
    '    $lateBakeFieldsMatch = $lateBakeFields.Length -eq 2 -and',
    '      $null -ne $lateBakeStreamSizeField -and',
    '      $lateBakeStreamSizeField.FieldType -eq [Int64] -and',
    '      $lateBakeStreamSizeField.IsPublic -and -not $lateBakeStreamSizeField.IsStatic -and',
    '      $null -ne $lateBakeStreamNameField -and',
    '      $lateBakeStreamNameField.FieldType -eq [String] -and',
    '      $lateBakeStreamNameField.IsPublic -and -not $lateBakeStreamNameField.IsStatic -and',
    '      $lateBakeMarshal.Length -eq 1 -and',
    '      $lateBakeMarshal[0].Value -eq',
    '        [System.Runtime.InteropServices.UnmanagedType]::ByValTStr -and',
    '      $lateBakeMarshal[0].SizeConst -eq 296',
    '  } catch {',
    marker('late-bake-fields-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if (-not $lateBakeFieldsMatch) {',
    marker('late-bake-fields-mismatch', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    marker('late-bake-fields-authenticated', '  '),
    '  try {',
    '    $lateBakeMethodFlags = [System.Reflection.BindingFlags]::Public -bor',
    '      [System.Reflection.BindingFlags]::Static -bor',
    '      [System.Reflection.BindingFlags]::DeclaredOnly',
    '    $lateBakeMethods = @($nativeType.GetMethods($lateBakeMethodFlags))',
    "    $lateBakeFindFirst = $nativeType.GetMethod('FindFirstStreamW', $lateBakeMethodFlags)",
    "    $lateBakeFindNext = $nativeType.GetMethod('FindNextStreamW', $lateBakeMethodFlags)",
    "    $lateBakeFindClose = $nativeType.GetMethod('FindClose', $lateBakeMethodFlags)",
    '    $lateBakeByRef = $lateBakeType.MakeByRefType()',
    '    $lateBakeFindFirstParameters = @($lateBakeFindFirst.GetParameters())',
    '    $lateBakeFindNextParameters = @($lateBakeFindNext.GetParameters())',
    '    $lateBakeFindCloseParameters = @($lateBakeFindClose.GetParameters())',
    '    $lateBakeMethodsMatch = $lateBakeMethods.Length -eq 3 -and',
    '      $null -ne $lateBakeFindFirst -and $null -ne $lateBakeFindNext -and',
    '      $null -ne $lateBakeFindClose -and',
    '      $lateBakeFindFirst.ReturnType -eq [IntPtr] -and',
    '      $lateBakeFindFirstParameters.Length -eq 4 -and',
    '      $lateBakeFindFirstParameters[0].ParameterType -eq [String] -and',
    '      $lateBakeFindFirstParameters[1].ParameterType -eq [Int32] -and',
    '      $lateBakeFindFirstParameters[2].ParameterType -eq $lateBakeByRef -and',
    '      $lateBakeFindFirstParameters[3].ParameterType -eq [UInt32] -and',
    '      $lateBakeFindNext.ReturnType -eq [Boolean] -and',
    '      $lateBakeFindNextParameters.Length -eq 2 -and',
    '      $lateBakeFindNextParameters[0].ParameterType -eq [IntPtr] -and',
    '      $lateBakeFindNextParameters[1].ParameterType -eq $lateBakeByRef -and',
    '      $lateBakeFindClose.ReturnType -eq [Boolean] -and',
    '      $lateBakeFindCloseParameters.Length -eq 1 -and',
    '      $lateBakeFindCloseParameters[0].ParameterType -eq [IntPtr]',
    '  } catch {',
    marker('late-bake-methods-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if (-not $lateBakeMethodsMatch) {',
    marker('late-bake-methods-mismatch', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    marker('late-bake-methods-authenticated', '  '),
    '  try {',
    '    $lateBakeFindFirstImports = @($lateBakeFindFirst.GetCustomAttributes(',
    '      [System.Runtime.InteropServices.DllImportAttribute], $false))',
    '    $lateBakeFindNextImports = @($lateBakeFindNext.GetCustomAttributes(',
    '      [System.Runtime.InteropServices.DllImportAttribute], $false))',
    '    $lateBakeFindCloseImports = @($lateBakeFindClose.GetCustomAttributes(',
    '      [System.Runtime.InteropServices.DllImportAttribute], $false))',
    '    $lateBakeInteropMatch = $lateBakeFindFirstImports.Length -eq 1 -and',
    '      $lateBakeFindNextImports.Length -eq 1 -and $lateBakeFindCloseImports.Length -eq 1 -and',
    "      [String]::Equals($lateBakeFindFirstImports[0].Value, 'kernel32.dll',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindNextImports[0].Value, 'kernel32.dll',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindCloseImports[0].Value, 'kernel32.dll',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindFirstImports[0].EntryPoint, 'FindFirstStreamW',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindNextImports[0].EntryPoint, 'FindNextStreamW',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindCloseImports[0].EntryPoint, 'FindClose',",
    '        [System.StringComparison]::Ordinal) -and',
    '      $lateBakeFindFirstImports[0].CharSet -eq',
    '        [System.Runtime.InteropServices.CharSet]::Unicode -and',
    '      $lateBakeFindNextImports[0].CharSet -eq',
    '        [System.Runtime.InteropServices.CharSet]::Unicode -and',
    '      $lateBakeFindCloseImports[0].CharSet -eq',
    '        [System.Runtime.InteropServices.CharSet]::None -and',
    '      $lateBakeFindFirstImports[0].CallingConvention -eq',
    '        [System.Runtime.InteropServices.CallingConvention]::Winapi -and',
    '      $lateBakeFindNextImports[0].CallingConvention -eq',
    '        [System.Runtime.InteropServices.CallingConvention]::Winapi -and',
    '      $lateBakeFindCloseImports[0].CallingConvention -eq',
    '        [System.Runtime.InteropServices.CallingConvention]::Winapi -and',
    '      $lateBakeFindFirstImports[0].SetLastError -and',
    '      $lateBakeFindNextImports[0].SetLastError -and',
    '      $lateBakeFindCloseImports[0].SetLastError -and',
    '      $lateBakeFindFirstImports[0].ExactSpelling -and',
    '      $lateBakeFindNextImports[0].ExactSpelling -and',
    '      $lateBakeFindCloseImports[0].ExactSpelling -and',
    '      $lateBakeFindFirstImports[0].PreserveSig -and',
    '      $lateBakeFindNextImports[0].PreserveSig -and',
    '      $lateBakeFindCloseImports[0].PreserveSig -and',
    '      ($lateBakeFindFirst.GetMethodImplementationFlags() -band',
    '        [System.Reflection.MethodImplAttributes]::PreserveSig) -ne 0 -and',
    '      ($lateBakeFindNext.GetMethodImplementationFlags() -band',
    '        [System.Reflection.MethodImplAttributes]::PreserveSig) -ne 0 -and',
    '      ($lateBakeFindClose.GetMethodImplementationFlags() -band',
    '        [System.Reflection.MethodImplAttributes]::PreserveSig) -ne 0',
    '  } catch {',
    marker('late-bake-interop-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if (-not $lateBakeInteropMatch) {',
    marker('late-bake-interop-mismatch', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    marker('late-bake-interop-authenticated', '  '),
    marker('late-bake-completed', '  '),
    '}',
    '# DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_DIAGNOSTIC_END',
  ].join('\n');
}

function expectedPinnedNoDispatchLateBakeAllowedStages() {
  return [
    'started',
    ...EXPECTED_TYPE_RESOLVE_PINNED_PRE_GREEN_INSERTED_STAGES.flatMap((stage) =>
      stage === 'scope-exited'
        ? [stage, ...EXPECTED_TYPE_RESOLVE_PINNED_STATE_STAGES,
          ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_STAGES]
        : [stage]),
    'completed',
  ];
}

function expectedPinnedNoDispatchLateBakeOracleFixtureSource() {
  return [
    "groups.length === 0 && request === 'zero' && failure === 'null' && type === 'null'",
    ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_STAGES.map((stage) => `'${stage}'`),
    'records.length === 36',
    'TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS === 64',
    'terminal records forbid post-terminal records',
  ].join('\n');
}

function expectedPinnedNoDispatchLateBakeFixture() {
  const base = expectedPinnedPostScopeResolverStateFixture();
  const anchor = [
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END',
    "if ($nativeTypeFailure) { throw 'stream native type creation failed' }",
  ].join('\n');
  assert.equal(countLiteral(base.transformed, anchor), 1,
    'expected pinned late-bake fixture insertion anchor');
  return {
    original:base.original,
    transformed:base.transformed.replace(anchor, [
      '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END',
      expectedPinnedNoDispatchLateBakeBlock(),
      "if ($nativeTypeFailure) { throw 'stream native type creation failed' }",
    ].join('\n')),
    allowedStages:expectedPinnedNoDispatchLateBakeAllowedStages(),
    oracleSource:expectedPinnedNoDispatchLateBakeOracleFixtureSource(),
    actualOracleDiscrepancies:[],
  };
}

function expectedPinnedNoDispatchLateBakeBaseFixture() {
  return expectedPinnedStateRecordFixture({
    native:'succeeded', request:'zero', failure:'null', type:'null', groups:[],
  }).records;
}

function expectedPinnedNoDispatchLateBakeRecordFixture(suffix) {
  return [
    ...expectedPinnedNoDispatchLateBakeBaseFixture(),
    ...suffix.map((stage) => ({version:1, probe:'pinned', stage})),
  ];
}

function assertExpectedPinnedNoDispatchLateBakeRecordFixture(records) {
  const base = expectedPinnedNoDispatchLateBakeBaseFixture();
  assert.deepEqual(records.slice(0, base.length), base,
    'expected pinned late-bake record base tuple');
  assert.equal(records.length <= TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, true,
    'expected pinned late-bake parser cap');
  const stages = records.slice(base.length).map((record) => record.stage);
  assert.deepEqual(stages.slice(0, 2),
    ['late-bake-applicable','late-bake-create-enter'],
  'expected pinned late-bake record prefix');
  let index = 2;
  if (stages[index] === 'late-bake-create-exception') {
    assert.equal(index + 1, stages.length, 'expected pinned late-bake create terminal');
    return;
  }
  assert.equal(stages[index], 'late-bake-create-return',
    'expected pinned late-bake create return');
  index += 1;
  if (stages[index] === 'late-bake-result-null') {
    assert.equal(index + 1, stages.length, 'expected pinned late-bake null terminal');
    return;
  }
  for (const [, authenticated, exception, mismatch] of
    EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_PHASES) {
    if (stages[index] === exception || stages[index] === mismatch) {
      assert.equal(index + 1, stages.length, 'expected pinned late-bake phase terminal');
      return;
    }
    assert.equal(stages[index], authenticated,
      'expected pinned late-bake authenticated phase order');
    index += 1;
  }
  assert.equal(stages[index], 'late-bake-completed',
    'expected pinned late-bake completed terminal');
  assert.equal(index + 1, stages.length, 'expected pinned late-bake no post-terminal record');
  assert.equal(records.length, 36, 'expected pinned late-bake exact completed path');
}

function expectedPinnedNoDispatchLateBakeRecordFixtures() {
  const prefix = ['late-bake-applicable','late-bake-create-enter'];
  const fixtures = [
    expectedPinnedNoDispatchLateBakeRecordFixture(
      [...prefix, 'late-bake-create-exception']),
    expectedPinnedNoDispatchLateBakeRecordFixture(
      [...prefix, 'late-bake-create-return', 'late-bake-result-null']),
  ];
  const authenticated = [];
  for (const [, success, exception, mismatch] of
    EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_PHASES) {
    fixtures.push(expectedPinnedNoDispatchLateBakeRecordFixture(
      [...prefix, 'late-bake-create-return', ...authenticated, exception]));
    fixtures.push(expectedPinnedNoDispatchLateBakeRecordFixture(
      [...prefix, 'late-bake-create-return', ...authenticated, mismatch]));
    authenticated.push(success);
  }
  fixtures.push(expectedPinnedNoDispatchLateBakeRecordFixture(
    [...prefix, 'late-bake-create-return', ...authenticated, 'late-bake-completed']));
  return fixtures;
}

function expectedPinnedNoDispatchLateBakeInvalidRecordFixtures() {
  const fixtures = expectedPinnedNoDispatchLateBakeRecordFixtures();
  const completed = fixtures.at(-1);
  const baseLength = expectedPinnedNoDispatchLateBakeBaseFixture().length;
  const reordered = completed.map((record) => ({...record}));
  const identityIndex = reordered.findIndex((record) =>
    record.stage === 'late-bake-identity-authenticated');
  const fieldsIndex = reordered.findIndex((record) =>
    record.stage === 'late-bake-fields-authenticated');
  [reordered[identityIndex], reordered[fieldsIndex]] =
    [reordered[fieldsIndex], reordered[identityIndex]];
  const callbackBase = expectedPinnedStateRecordFixture({
    native:'succeeded', request:'one', failure:'null', type:'present', groups:['success'],
  }).records;
  return [
    {id:'authenticated phases reordered', records:reordered},
    {id:'post-terminal mismatch', records:[
      ...completed,
      {version:1, probe:'pinned', stage:'late-bake-identity-mismatch'},
    ]},
    {id:'callback path is inapplicable', records:[
      ...callbackBase,
      ...completed.slice(baseLength),
    ]},
    {id:'completed path has 37 records', records:[
      ...completed,
      {version:1, probe:'pinned', stage:'late-bake-completed'},
    ]},
    {id:'completed path exceeds parser cap', records:[
      ...completed,
      ...Array.from({length:65 - completed.length}, () =>
        ({version:1, probe:'pinned', stage:'late-bake-completed'})),
    ]},
    {id:'completed path omits authenticated phase', records:completed.filter((record) =>
      record.stage !== 'late-bake-methods-authenticated')},
  ];
}

function actualPinnedNoDispatchLateBakeOracleDiscrepancies() {
  const discrepancies = [];
  const expectedOutcome = {
    native:'succeeded', request:'zero', failure:'null', type:'null', groups:[],
  };
  for (const [index, records] of
    expectedPinnedNoDispatchLateBakeRecordFixtures().entries()) {
    try {
      assert.deepEqual(assertPinnedTypeResolveRecords(records), expectedOutcome,
        `real pinned oracle valid late-bake outcome ${index}`);
    } catch (error) {
      discrepancies.push(`real pinned oracle rejected valid late-bake fixture ${index}: ` +
        error.message);
    }
  }
  for (const fixture of expectedPinnedNoDispatchLateBakeInvalidRecordFixtures()) {
    try {
      assertPinnedTypeResolveRecords(fixture.records);
      discrepancies.push(`real pinned oracle accepted invalid late-bake fixture: ${fixture.id}`);
    } catch {
      // Rejection is the required real-oracle behavior for this invalid fixture.
    }
  }
  return discrepancies;
}

function stripExpectedPinnedNoDispatchLateBakeDiagnostic(diagnostic) {
  const block = expectedPinnedNoDispatchLateBakeBlock();
  assert.equal(countLiteral(diagnostic.transformed, `${block}\n`), 1,
    'expected pinned late-bake block strip');
  return diagnostic.transformed.replace(`${block}\n`, '');
}

function expectedPinnedNoDispatchLateBakeDiscrepancies(diagnostic) {
  const discrepancies = [];
  const requireExactCount = (value, expected, id) => {
    const actual = countLiteral(diagnostic.transformed, value);
    if (actual !== expected) discrepancies.push(`${id}: expected ${expected}, actual ${actual}`);
  };
  const block = expectedPinnedNoDispatchLateBakeBlock();
  requireExactCount(block, 1, 'late-bake exact block');
  const placement = [
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END',
    block,
    "if ($nativeTypeFailure) { throw 'stream native type creation failed' }",
  ].join('\n');
  requireExactCount(placement, 1, 'late-bake post-classifier pre-guard placement');
  for (const stage of EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_STAGES) {
    requireExactCount(typeResolveStageLine('pinned', stage), 1, `late-bake stage ${stage}`);
  }
  if (countLiteral(block, '$streamDataBuilder.CreateType()') !== 1) {
    discrepancies.push('late-bake nested CreateType count');
  }
  if (countLiteral(block, '$nativeBuilder.CreateType()') !== 0) {
    discrepancies.push('late-bake repeats enclosing CreateType');
  }
  const assignments = [...block.matchAll(/\$([A-Za-z][A-Za-z0-9]*)\s*(?:=|\+\+|--)/gu)]
    .map((match) => match[1]);
  if (assignments.some((name) => !name.startsWith('lateBake'))) {
    discrepancies.push('late-bake assigns non-lateBake variable');
  }
  if (/Exception\.Message|WriteLine\([^'\n]|Start-Sleep|Get-Item|Invoke-Expression|\.Invoke\(/u
    .test(block)) {
    discrepancies.push('late-bake exceeds closed diagnostic surface');
  }
  if (JSON.stringify(diagnostic.allowedStages) !==
      JSON.stringify(expectedPinnedNoDispatchLateBakeAllowedStages())) {
    discrepancies.push('late-bake allowed-stage vocabulary mismatch');
  }
  for (const fragment of [
    "groups.length === 0 && request === 'zero' && failure === 'null' && type === 'null'",
    ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_STAGES.map((stage) => `'${stage}'`),
    'records.length === 36','TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS === 64',
    'post-terminal',
  ]) {
    if (!diagnostic.oracleSource.includes(fragment)) {
      discrepancies.push(`late-bake oracle fragment absent: ${fragment}`);
    }
  }
  if (!Array.isArray(diagnostic.actualOracleDiscrepancies)) {
    discrepancies.push('late-bake real record-oracle execution absent');
  } else {
    discrepancies.push(...diagnostic.actualOracleDiscrepancies);
  }
  try {
    const withoutLateBake = stripExpectedPinnedNoDispatchLateBakeDiagnostic(diagnostic);
    if (withoutLateBake !== expectedPinnedPostScopeResolverStateFixture().transformed) {
      discrepancies.push('late-bake reversible reconstruction mismatch');
    }
  } catch (error) {
    discrepancies.push(`late-bake reversible reconstruction rejected: ${error.message}`);
  }
  return discrepancies;
}

function assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic(diagnostic) {
  const fixtures = expectedPinnedNoDispatchLateBakeRecordFixtures();
  assert.equal(fixtures.length, 11, 'expected pinned late-bake terminal fixture count');
  for (const fixture of fixtures) {
    assertExpectedPinnedNoDispatchLateBakeRecordFixture(fixture);
  }
  assert.equal(Math.max(...fixtures.map((fixture) => fixture.length)), 36,
    'expected pinned late-bake exact no-dispatch maximum');
  assert.equal(typeResolvePinnedGreenStages().length, 41,
    'expected pinned late-bake preserved global maximum');
  assert.equal(TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, 64,
    'expected pinned late-bake parser cap');
  assert.deepEqual(expectedPinnedNoDispatchLateBakeDiscrepancies(diagnostic), [],
    'expected pinned late-bake aggregated actual-script discrepancies');
}

function expectedPinnedLateBakeIdentityAxisStep(axis) {
  const exception = `late-bake-identity-axis-${axis.id}-exception`;
  const mismatch = `late-bake-identity-axis-${axis.id}-mismatch`;
  return [
    '  try {',
    ...(axis.setup || []),
    ...axis.predicate,
    '  } catch {',
    typeResolveStageLine('pinned', exception, '    '),
    "    throw 'stream late bake identity-axis diagnostic failed'",
    '  }',
    '  if (-not $lateBakeIdentityAxisMatch) {',
    typeResolveStageLine('pinned', mismatch, '    '),
    "    throw 'stream late bake identity-axis diagnostic failed'",
    '  }',
  ].join('\n');
}

function expectedPinnedLateBakeIdentityAxisBlock() {
  return [
    '  # DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_IDENTITY_AXIS_BEGIN',
    ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXES.map(
      expectedPinnedLateBakeIdentityAxisStep),
    '  # DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_IDENTITY_AXIS_END',
  ].join('\n');
}

function expectedPinnedLateBakeIdentityAxisTransformMetadata() {
  const marker = (stage, indent = '') => typeResolveStageLine('pinned', stage, indent);
  return {
    id:'late-bake-identity-axis',
    before:[
      '  if ($null -eq $lateBakeType) {',
      marker('late-bake-result-null', '    '),
      "    throw 'stream late bake diagnostic failed'",
      '  }',
    ].join('\n'),
    after:[
      '  try {',
      '    $lateBakeNestedFlags = [System.Reflection.BindingFlags]::Public -bor',
    ].join('\n'),
  };
}

function expectedPinnedLateBakeIdentityAxisAllowedStages() {
  return expectedPinnedNoDispatchLateBakeAllowedStages().flatMap((stage) =>
    stage === 'late-bake-result-null'
      ? [stage, ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES]
      : [stage]);
}

function expectedPinnedLateBakeIdentityAxisOracleFixtureSource() {
  return [
    expectedPinnedNoDispatchLateBakeOracleFixtureSource(),
    ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES.map(
      (stage) => `'${stage}'`),
    'records.length === 32',
    'identity-axis terminal records forbid post-terminal records',
  ].join('\n');
}

function expectedPinnedLateBakeIdentityAxisFixture() {
  const base = expectedPinnedNoDispatchLateBakeFixture();
  const block = expectedPinnedLateBakeIdentityAxisBlock();
  const transform = expectedPinnedLateBakeIdentityAxisTransformMetadata();
  const anchor = `${transform.before}\n${transform.after}`;
  assert.equal(countLiteral(base.transformed, anchor), 1,
    'expected pinned identity-axis fixture insertion anchor');
  return {
    ...base,
    transformed:base.transformed.replace(anchor,
      `${transform.before}\n${block}\n${transform.after}`),
    allowedStages:expectedPinnedLateBakeIdentityAxisAllowedStages(),
    oracleSource:expectedPinnedLateBakeIdentityAxisOracleFixtureSource(),
    axisActualOracleDiscrepancies:[],
    lateBakeIdentityAxisTransform:transform,
  };
}

function normalizeExpectedPinnedLateBakeIdentityAxisDiagnostic(diagnostic) {
  assert.equal(diagnostic && typeof diagnostic === 'object', true,
    'expected pinned identity-axis diagnostic object');
  assert.equal(typeof diagnostic.transformed, 'string',
    'expected pinned identity-axis transformed source');
  assert.equal(Array.isArray(diagnostic.allowedStages), true,
    'expected pinned identity-axis allowed stages');
  const block = expectedPinnedLateBakeIdentityAxisBlock();
  const transform = expectedPinnedLateBakeIdentityAxisTransformMetadata();
  assert.deepEqual(diagnostic.lateBakeIdentityAxisTransform, transform,
    'expected pinned identity-axis transform metadata');
  assert.equal(countLiteral(diagnostic.transformed, `${block}\n`), 1,
    'expected pinned identity-axis exact block count');
  assert.equal(countLiteral(diagnostic.transformed,
    '# DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_IDENTITY_AXIS_BEGIN'), 1,
  'expected pinned identity-axis begin count');
  assert.equal(countLiteral(diagnostic.transformed,
    '# DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_IDENTITY_AXIS_END'), 1,
  'expected pinned identity-axis end count');
  const placement = `${transform.before}\n${block}\n${transform.after}`;
  assert.equal(countLiteral(diagnostic.transformed, placement), 1,
    'expected pinned identity-axis exact placement');
  const sourceStages = [...diagnostic.transformed.matchAll(
    /"stage":"(late-bake-identity-axis-[a-z-]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(sourceStages, EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES,
    'expected pinned identity-axis fixed source vocabulary');
  const assignments = [...block.matchAll(/\$([A-Za-z][A-Za-z0-9]*)\s*=/gu)]
    .map((match) => match[1]);
  assert.equal(assignments.length > 0 && assignments.every((name) =>
    name.startsWith('lateBakeIdentityAxis')), true,
  'expected pinned identity-axis assignment boundary');
  assert.doesNotMatch(block,
    /Exception\.Message|WriteLine\([^'\n]|CreateType|DefineType|DefineNestedType|DefineField|DefineMethod|add_TypeResolve|Get-Item|Start-Process|\$env:|Registry|Start-Sleep|retry|fallback|\.Invoke\(/iu,
  'expected pinned identity-axis closed diagnostic surface');
  assert.equal(countLiteral(block,
    "throw 'stream late bake identity-axis diagnostic failed'"), 24,
  'expected pinned identity-axis fixed throw count');

  const axisStages = diagnostic.allowedStages.filter((stage) =>
    stage.startsWith('late-bake-identity-axis-'));
  assert.deepEqual(axisStages, EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES,
    'expected pinned identity-axis allowed vocabulary');
  const resultNullIndex = diagnostic.allowedStages.indexOf('late-bake-result-null');
  const identityIndex = diagnostic.allowedStages.indexOf('late-bake-identity-authenticated');
  assert.equal(resultNullIndex >= 0 && identityIndex > resultNullIndex, true,
    'expected pinned identity-axis vocabulary anchors');
  assert.deepEqual(diagnostic.allowedStages.slice(resultNullIndex + 1, identityIndex),
    EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES,
  'expected pinned identity-axis contiguous vocabulary placement');

  const normalized = {
    ...diagnostic,
    transformed:diagnostic.transformed.replace(`${block}\n`, ''),
    allowedStages:diagnostic.allowedStages.filter((stage) =>
      !stage.startsWith('late-bake-identity-axis-')),
  };
  const expected = expectedPinnedNoDispatchLateBakeFixture();
  assert.equal(normalized.transformed, expected.transformed,
    'expected pinned identity-axis normalized source');
  assert.deepEqual(normalized.allowedStages, expected.allowedStages,
    'expected pinned identity-axis normalized vocabulary');
  return normalized;
}

function expectedPinnedLateBakeIdentityAxisRecordFixture(stage) {
  return expectedPinnedNoDispatchLateBakeRecordFixture([
    'late-bake-applicable','late-bake-create-enter','late-bake-create-return',stage,
  ]);
}

function expectedPinnedLateBakeIdentityAxisRecordFixtures() {
  return EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES.map(
    expectedPinnedLateBakeIdentityAxisRecordFixture);
}

function assertExpectedPinnedLateBakeIdentityAxisRecordFixture(records) {
  const base = expectedPinnedNoDispatchLateBakeBaseFixture();
  assert.equal(records.length <= TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, true,
    'expected pinned identity-axis parser cap');
  assert.equal(records.length, 32, 'expected pinned identity-axis exact terminal length');
  assert.deepEqual(records.slice(0, base.length), base,
    'expected pinned identity-axis authenticated zero/null base tuple');
  assert.deepEqual(records.slice(base.length, base.length + 3), [
    {version:1, probe:'pinned', stage:'late-bake-applicable'},
    {version:1, probe:'pinned', stage:'late-bake-create-enter'},
    {version:1, probe:'pinned', stage:'late-bake-create-return'},
  ], 'expected pinned identity-axis fixed prefix');
  const terminal = records.at(-1);
  assert.equal(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES
    .includes(terminal && terminal.stage), true,
  'expected pinned identity-axis fixed terminal');
  assert.deepEqual(terminal, {version:1, probe:'pinned', stage:terminal.stage},
    'expected pinned identity-axis terminal shape');
}

function expectedPinnedLateBakeIdentityAxisInvalidRecordFixtures() {
  const terminal = EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0];
  const valid = expectedPinnedLateBakeIdentityAxisRecordFixture(terminal);
  const baseLength = expectedPinnedNoDispatchLateBakeBaseFixture().length;
  const callbackBase = expectedPinnedStateRecordFixture({
    native:'succeeded', request:'one', failure:'null', type:'present', groups:['success'],
  }).records;
  const mutatedTuples = (replacements) => {
    const records = valid.map((record) => ({...record}));
    for (const [stage, replacement] of replacements) {
      assert.equal(records.filter((record) => record.stage === stage).length, 1,
        `expected pinned identity-axis invalid tuple ${stage}`);
      const index = records.findIndex((record) => record.stage === stage);
      records[index] = {...records[index], stage:replacement};
    }
    return records;
  };
  const mutatedTuple = (stage, replacement) =>
    mutatedTuples([[stage, replacement]]);
  return [
    {id:'post-terminal record', records:[
      ...valid, {version:1, probe:'pinned', stage:'late-bake-identity-authenticated'},
    ]},
    {id:'callback-present tuple', records:[
      ...callbackBase, ...valid.slice(baseLength),
    ]},
    {id:'internally consistent native-failed tuple', records:mutatedTuples([
      ['enclosing-create-return', 'enclosing-create-catch'],
      ['state-native-create-succeeded', 'state-native-create-failed'],
    ])},
    {id:'non-zero request tuple', records:mutatedTuple(
      'state-requests-zero', 'state-requests-one')},
    {id:'non-null failure tuple', records:mutatedTuple(
      'state-failure-null', 'state-failure-catch')},
    {id:'non-null type tuple', records:mutatedTuple(
      'state-type-null', 'state-type-present')},
    {id:'out-of-vocabulary axis terminal', records:mutatedTuple(
      terminal, 'late-bake-identity-axis-unexpected-mismatch')},
    {id:'33-record axis failure', records:[
      ...valid, {version:1, probe:'pinned', stage:terminal},
    ]},
    {id:'65-record overflow', records:[
      ...valid,
      ...Array.from({length:65 - valid.length}, () =>
        ({version:1, probe:'pinned', stage:terminal})),
    ]},
  ];
}

function actualPinnedLateBakeIdentityAxisOracleDiscrepancies() {
  const discrepancies = [];
  const expectedOutcome = {
    native:'succeeded', request:'zero', failure:'null', type:'null', groups:[],
  };
  for (const [index, records] of
    expectedPinnedLateBakeIdentityAxisRecordFixtures().entries()) {
    try {
      assert.deepEqual(assertPinnedTypeResolveRecords(records), expectedOutcome,
        `real pinned oracle valid identity-axis outcome ${index}`);
    } catch (error) {
      discrepancies.push(`real pinned oracle rejected valid identity-axis fixture ${index}: ` +
        error.message);
    }
  }
  for (const fixture of expectedPinnedLateBakeIdentityAxisInvalidRecordFixtures()) {
    try {
      assertPinnedTypeResolveRecords(fixture.records);
      discrepancies.push(`real pinned oracle accepted invalid identity-axis fixture: ${fixture.id}`);
    } catch {
      // Rejection is the required real-oracle behavior for this invalid fixture.
    }
  }
  return discrepancies;
}

function expectedPinnedLateBakeIdentityAxisDiscrepancies(diagnostic) {
  const discrepancies = [];
  try {
    normalizeExpectedPinnedLateBakeIdentityAxisDiagnostic(diagnostic);
  } catch (error) {
    discrepancies.push(`identity-axis outer normalization rejected: ${error.message}`);
  }
  for (const fragment of [
    ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES.map(
      (stage) => `'${stage}'`),
    'records.length === 32','post-terminal',
  ]) {
    if (typeof diagnostic.oracleSource !== 'string' ||
        !diagnostic.oracleSource.includes(fragment)) {
      discrepancies.push(`identity-axis oracle fragment absent: ${fragment}`);
    }
  }
  if (!Array.isArray(diagnostic.axisActualOracleDiscrepancies)) {
    discrepancies.push('identity-axis real record-oracle execution absent');
  } else {
    discrepancies.push(...diagnostic.axisActualOracleDiscrepancies);
  }
  return discrepancies;
}

function assertExpectedWindowsPinnedLateBakeIdentityAxisDiagnostic(diagnostic) {
  const fixtures = expectedPinnedLateBakeIdentityAxisRecordFixtures();
  assert.equal(fixtures.length, 24, 'expected pinned identity-axis terminal fixture count');
  for (const fixture of fixtures) {
    assertExpectedPinnedLateBakeIdentityAxisRecordFixture(fixture);
  }
  assert.equal(Math.max(...fixtures.map((fixture) => fixture.length)), 32,
    'expected pinned identity-axis exact no-dispatch maximum');
  assert.equal(expectedPinnedNoDispatchLateBakeRecordFixtures().length, 11,
    'expected pinned identity-axis preserved S2.9 terminals');
  assert.equal(typeResolvePinnedGreenStages().length, 41,
    'expected pinned identity-axis preserved global maximum');
  assert.equal(TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, 64,
    'expected pinned identity-axis parser cap');
  assert.deepEqual(expectedPinnedLateBakeIdentityAxisDiscrepancies(diagnostic), [],
    'expected pinned identity-axis aggregated actual-script discrepancies');
  const normalized = normalizeExpectedPinnedLateBakeIdentityAxisDiagnostic(diagnostic);
  assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic(normalized);
}

function expectedTypeResolvePinnedGuardedCallbackBlock() {
  const comparisons = Object.fromEntries(EXPECTED_TYPE_RESOLVE_PINNED_CALLBACK_GUARDS);
  const guard = (stage) => expectedTypeResolvePinnedGuardedMarker(
    stage, comparisons[stage]);
  return [
    '$typeResolveCallback = {',
    '  param($sender, $eventArgs)',
    guard('resolver-entered'),
    '  try {',
    '    $typeResolveState.Requests++',
    guard('resolver-request-incremented'),
    '    if (-not [String]::Equals($eventArgs.Name, $expectedStreamDataTypeName,',
    '        [System.StringComparison]::Ordinal)) {',
    guard('resolver-name-foreign'),
    "      $typeResolveState.Failure = 'stream type resolve name mismatch'",
    guard('resolver-reject-name'),
    '      return $null',
    '    }',
    guard('resolver-name-exact'),
    '    if ($typeResolveState.Requests -ne 1) {',
    guard('resolver-reject-duplicate'),
    "      $typeResolveState.Failure = 'stream type resolve duplicate'",
    '      return $null',
    '    }',
    guard('resolver-request-1'),
    guard('resolver-nested-create-enter'),
    '    $resolvedStreamDataType = $streamDataBuilder.CreateType()',
    guard('resolver-nested-create-return'),
    '    if ($null -eq $resolvedStreamDataType -or',
    '        -not [String]::Equals($resolvedStreamDataType.FullName, $expectedStreamDataTypeName,',
    '          [System.StringComparison]::Ordinal) -or',
    '        -not $resolvedStreamDataType.IsValueType -or',
    '        -not [Object]::Equals($resolvedStreamDataType.Assembly, $assemblyBuilder)) {',
    "      $typeResolveState.Failure = 'stream type resolve result mismatch'",
    '      return $null',
    '    }',
    guard('resolver-result-authenticated'),
    '    $typeResolveState.Type = $resolvedStreamDataType',
    guard('resolver-return-assembly'),
    '    return $assemblyBuilder',
    '  } catch {',
    guard('resolver-catch'),
    "    $typeResolveState.Failure = 'stream type resolve failed'",
    '    return $null',
    '  }',
    '}.GetNewClosure()',
  ].join('\n');
}

function expectedTypeResolvePinnedIncrementGuardAnchor() {
  return [
    '  try {',
    '    $typeResolveState.Requests++',
    expectedTypeResolvePinnedGuardedMarker('resolver-request-incremented', '-le'),
    '    if (-not [String]::Equals($eventArgs.Name, $expectedStreamDataTypeName,',
  ].join('\n');
}

function assertExpectedPinnedAdmissibilityContract(contract) {
  assert.deepEqual(contract, EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT,
    'expected pinned post-scope resolver-state admissibility contract');
  assert.equal(contract.firstGroups.length * contract.secondGroups.length *
    contract.finalFailures.length, contract.otherCombinationCount,
  'expected pinned post-scope resolver-state 4 x 2 x 2 cross product');
  assert.equal(contract.coupleFinalFailureToSecondGroup, false,
    'expected pinned post-scope resolver-state final failure independence');
}

function assertExpectedPinnedStateTuple(tuple) {
  assert.equal(['succeeded','failed'].includes(tuple.native), true,
    'expected pinned post-scope resolver-state native category');
  if (tuple.request === 'zero') {
    assert.deepEqual({failure:tuple.failure, type:tuple.type, groups:tuple.groups},
      {failure:'null', type:'null', groups:[]},
    'expected pinned post-scope resolver-state zero tuple');
    return;
  }
  if (tuple.request === 'one') {
    const outcomes = {
      success:{failure:'null', type:'present'},
      foreign:{failure:'name-mismatch', type:'null'},
      result:{failure:'result-mismatch', type:'null'},
      catch:{failure:'catch', type:'null'},
    };
    assert.equal(tuple.groups.length, 1,
      'expected pinned post-scope resolver-state one group');
    assert.deepEqual({failure:tuple.failure, type:tuple.type}, outcomes[tuple.groups[0]],
      'expected pinned post-scope resolver-state one tuple');
    return;
  }
  assert.equal(tuple.request, 'other',
    'expected pinned post-scope resolver-state request category');
  assert.equal(tuple.groups.length, 2,
    'expected pinned post-scope resolver-state two visible groups');
  assert.equal(EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT.firstGroups
    .includes(tuple.groups[0]), true,
  'expected pinned post-scope resolver-state valid first group');
  assert.equal(EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT.secondGroups
    .includes(tuple.groups[1]), true,
  'expected pinned post-scope resolver-state valid second group');
  assert.equal(EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT.finalFailures
    .includes(tuple.failure), true,
  'expected pinned post-scope resolver-state final failure');
  assert.equal(tuple.type, tuple.groups[0] === 'success' ? 'present' : 'null',
    'expected pinned post-scope resolver-state first-group Type consistency');
}

function expectedPinnedStateTupleStages(tuple) {
  assertExpectedPinnedStateTuple(tuple);
  const callbackStages = tuple.groups.length === 0 ? []
    : tuple.request === 'one' ? EXPECTED_TYPE_RESOLVE_PINNED_FIRST_GROUPS[tuple.groups[0]]
      : [
        ...EXPECTED_TYPE_RESOLVE_PINNED_FIRST_GROUPS[tuple.groups[0]],
        ...EXPECTED_TYPE_RESOLVE_PINNED_SECOND_GROUPS[tuple.groups[1]],
      ];
  const scopeStages = [
    tuple.native === 'failed' ? 'enclosing-create-catch' : 'enclosing-create-return',
    'handler-remove-enter','handler-removed','scope-exited',
  ];
  const stateStages = [
    `state-native-create-${tuple.native}`,
    `state-requests-${tuple.request}`,
    `state-failure-${tuple.failure}`,
    `state-type-${tuple.type}`,
  ];
  const success = tuple.native === 'succeeded' && tuple.request === 'one' &&
    tuple.groups[0] === 'success';
  return [
    ...EXPECTED_TYPE_RESOLVE_PINNED_RECORD_PREFIX,
    ...callbackStages,
    ...scopeStages,
    ...stateStages,
    ...(success ? EXPECTED_TYPE_RESOLVE_PINNED_SUCCESS_SUFFIX : []),
  ];
}

function expectedPinnedStateRecordFixture(tuple) {
  return {
    ...tuple,
    records:expectedPinnedStateTupleStages(tuple).map((stage) =>
      stage === 'runtime-identity' ? typeResolveIdentityFixture('pinned')
        : {version:1, probe:'pinned', stage}),
  };
}

function assertExpectedPinnedStateRecordFixture(fixture) {
  assertExpectedPinnedStateTuple(fixture);
  assert.equal(fixture.records.length <= TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, true,
    'expected pinned post-scope resolver-state parser cap');
  assert.equal(fixture.records.length <= 41, true,
    'expected pinned post-scope resolver-state maximum path');
  assert.deepEqual(fixture.records.map((record) => record.stage),
    expectedPinnedStateTupleStages(fixture),
  'expected pinned post-scope resolver-state record path');
}

function expectedPinnedStateRecordFixtures() {
  const fixtures = [];
  for (const native of ['succeeded','failed']) {
    fixtures.push(expectedPinnedStateRecordFixture({
      native, request:'zero', failure:'null', type:'null', groups:[],
    }));
    for (const first of EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT.firstGroups) {
      const oneOutcome = {
        success:{failure:'null', type:'present'},
        foreign:{failure:'name-mismatch', type:'null'},
        result:{failure:'result-mismatch', type:'null'},
        catch:{failure:'catch', type:'null'},
      }[first];
      fixtures.push(expectedPinnedStateRecordFixture({
        native, request:'one', ...oneOutcome, groups:[first],
      }));
      for (const second of EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT.secondGroups) {
        for (const failure of EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT
          .finalFailures) {
          fixtures.push(expectedPinnedStateRecordFixture({
            native,
            request:'other',
            failure,
            type:first === 'success' ? 'present' : 'null',
            groups:[first,second],
          }));
        }
      }
    }
  }
  return fixtures;
}

function stripExpectedPinnedPostScopeResolverStateDiagnostic(diagnostic) {
  let stripped = diagnostic.transformed;
  const lateBake = `${expectedPinnedNoDispatchLateBakeBlock()}\n`;
  const lateBakeCount = countLiteral(stripped, lateBake);
  assert.equal(lateBakeCount <= 1, true,
    'expected pinned post-scope resolver-state upper-layer block bound');
  if (lateBakeCount === 1) stripped = stripped.replace(lateBake, '');
  const classifier = expectedTypeResolvePinnedStateDiagnosticBlock();
  assert.equal(countLiteral(stripped, `${classifier}\n`), 1,
    'expected pinned post-scope resolver-state classifier strip');
  stripped = stripped.replace(`${classifier}\n`, '');
  for (const [stage, comparison] of [...EXPECTED_TYPE_RESOLVE_PINNED_CALLBACK_GUARDS]
    .reverse()) {
    const wrapper = expectedTypeResolvePinnedGuardedMarker(stage, comparison);
    assert.equal(countLiteral(stripped, wrapper), 1,
      `expected pinned post-scope resolver-state wrapper strip ${stage}`);
    stripped = stripped.replace(wrapper, typeResolveStageLine('pinned', stage));
  }
  const markerLines = new Set(TYPE_RESOLVE_PINNED_INSERTED_STAGES.map((stage) =>
    typeResolveStageLine('pinned', stage)));
  return stripped.split('\n').filter((line) => !markerLines.has(line.trim())).join('\n');
}

function expectedPinnedPostScopeResolverStateDiscrepancies(diagnostic) {
  const discrepancies = [];
  const lateBake = `${expectedPinnedNoDispatchLateBakeBlock()}\n`;
  const lateBakeCount = countLiteral(diagnostic.transformed, lateBake);
  if (lateBakeCount > 1) {
    discrepancies.push(`upper-layer late-bake block: expected at most 1, actual ${lateBakeCount}`);
  }
  const transformed = lateBakeCount === 1
    ? diagnostic.transformed.replace(lateBake, '') : diagnostic.transformed;
  const requireExactCount = (value, expected, id) => {
    const actual = countLiteral(transformed, value);
    if (actual !== expected) discrepancies.push(`${id}: expected ${expected}, actual ${actual}`);
  };
  const classifier = expectedTypeResolvePinnedStateDiagnosticBlock();
  requireExactCount(classifier, 1, 'classifier');
  const placement = [
    '# DEEP_WORK_TYPE_RESOLVE_SCOPE_END',
    '',
    '# DEEP_WORK_TYPE_AUTHENTICATION_BEGIN',
    classifier,
    "if ($nativeTypeFailure) { throw 'stream native type creation failed' }",
  ].join('\n');
  requireExactCount(placement, 1, 'post-scope classifier placement');
  for (const stage of EXPECTED_TYPE_RESOLVE_PINNED_STATE_STAGES) {
    requireExactCount(typeResolveStageLine('pinned', stage), 1, `state stage ${stage}`);
  }
  for (const [stage, comparison] of EXPECTED_TYPE_RESOLVE_PINNED_CALLBACK_GUARDS) {
    requireExactCount(expectedTypeResolvePinnedGuardedMarker(stage, comparison), 1,
      `callback guard ${stage}`);
  }
  requireExactCount(expectedTypeResolvePinnedGuardedCallbackBlock(), 1,
    'exact guarded callback semantic placement');
  requireExactCount(expectedTypeResolvePinnedIncrementGuardAnchor(), 1,
    'request increment before post-increment guard');
  requireExactCount('if ($typeResolveState.Requests -lt 2) {', 1,
    'pre-increment guard count');
  requireExactCount('if ($typeResolveState.Requests -le 2) {', 11,
    'post-increment guard count');
  const classifierStart = transformed.indexOf(
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_BEGIN');
  const classifierEndStart = transformed.indexOf(
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END');
  if (classifierStart < 0 || classifierEndStart < classifierStart) {
    discrepancies.push('classifier boundaries absent or reversed');
  } else {
    const classifierEnd = classifierEndStart +
      '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END'.length;
    const classifierSource = transformed.slice(classifierStart, classifierEnd);
    if (/\$typeResolveState\.(?:Requests|Failure|Type)\s*(?:=|\+\+|--)/u
      .test(classifierSource)) {
      discrepancies.push('classifier mutates resolver state');
    }
    if (/GetNestedType|DefineNestedType|CreateType|Invoke\(|RequestingAssembly/u
      .test(classifierSource)) {
      discrepancies.push('classifier exceeds closed observation surface');
    }
  }
  const allowedOutputLines = new Set([
    ...TYPE_RESOLVE_PINNED_INSERTED_STAGES,
    ...EXPECTED_TYPE_RESOLVE_PINNED_STATE_STAGES,
  ].map((stage) => typeResolveStageLine('pinned', stage)));
  const fixedOutputOnly = transformed.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('[Console]::Out.WriteLine('))
    .every((line) => allowedOutputLines.has(line));
  if (!fixedOutputOnly) discrepancies.push('output exceeds fixed marker vocabulary');
  try {
    if (stripExpectedPinnedPostScopeResolverStateDiagnostic(diagnostic) !==
        diagnostic.original) {
      discrepancies.push('source reconstruction differs from original');
    }
  } catch (error) {
    discrepancies.push(`source reconstruction rejected: ${error.message}`);
  }
  return discrepancies;
}

function assertExpectedWindowsPinnedPostScopeResolverStateDiagnostic(diagnostic) {
  assertExpectedPinnedAdmissibilityContract(
    EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT);
  const pathFixtures = expectedPinnedStateRecordFixtures();
  for (const fixture of pathFixtures) assertExpectedPinnedStateRecordFixture(fixture);
  assert.equal(Math.max(...pathFixtures.map((fixture) => fixture.records.length)), 41,
    'expected pinned post-scope resolver-state exact maximum path');
  assert.equal(TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, 64,
    'expected pinned post-scope resolver-state fixed parser cap');
  assert.deepEqual(expectedPinnedPostScopeResolverStateDiscrepancies(diagnostic), [],
    'expected pinned post-scope resolver-state aggregated actual-script discrepancies');
}

function stripDocumentedSetupDiagnosticMarkers(script) {
  const inserted = new Set(TYPE_RESOLVE_DOCUMENTED_SETUP_INSERTED_STAGES.map((stage) =>
    typeResolveStageLine('documented', stage).trim()));
  return script.split('\n').filter((line) => !inserted.has(line.trim())).join('\n');
}

function assertDocumentedSetupMarkerPlacements(script) {
  const marker = (stage, indent = '') => typeResolveStageLine('documented', stage, indent);
  const placements = [
    ['assembly-name-ready',
      `$assemblyName = [System.Reflection.AssemblyName]::new('DeepWorkTypeResolveDocumentedAssembly')\n${marker('assembly-name-ready')}`],
    ['assembly-access-ready',
      `$assemblyAccess = [System.Reflection.Emit.AssemblyBuilderAccess]::Run\n${marker('assembly-access-ready')}`],
    ['factory-search-enter',
      `${marker('factory-search-enter')}\n$staticFactoryCandidates = @(`],
    ['factory-search-return',
      `$staticFactory = $staticFactoryCandidates[0]\n${marker('factory-search-return')}`],
    ['assembly-create-enter',
      `${marker('assembly-create-enter')}\nif ($null -ne $staticFactory) {`],
    ['assembly-create-static',
      `if ($null -ne $staticFactory) {\n${marker('assembly-create-static', '  ')}\n  $assemblyBuilder = $staticFactory.Invoke($null, @($assemblyName, $assemblyAccess))`],
    ['assembly-create-appdomain',
      `} else {\n${marker('assembly-create-appdomain', '  ')}\n  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)`],
    ['assembly-create-return', `}\n${marker('assembly-create-return')}`],
    ['module-create-enter',
      `${marker('module-create-enter')}\n$moduleBuilder = $assemblyBuilder.DefineDynamicModule('DeepWorkTypeResolveDocumentedModule')`],
    ['module-create-return',
      `$moduleBuilder = $assemblyBuilder.DefineDynamicModule('DeepWorkTypeResolveDocumentedModule')\n${marker('module-create-return')}`],
    ['outer-builder-enter',
      `${marker('outer-builder-enter')}\n$outerAttributes = [System.Reflection.TypeAttributes]::Public`],
    ['outer-builder-return',
      `$outerBuilder = $moduleBuilder.DefineType('DeepWorkTypeResolveDocumentedOuter', $outerAttributes)\n${marker('outer-builder-return')}`],
    ['nested-builder-enter',
      `${marker('nested-builder-enter')}\n$nestedAttributes = [System.Reflection.TypeAttributes](`],
    ['nested-builder-return',
      `$nestedBuilder = $outerBuilder.DefineNestedType('NestedValue', $nestedAttributes, [ValueType])\n${marker('nested-builder-return')}`],
    ['nested-field-enter',
      `${marker('nested-field-enter')}\n$nestedField = $nestedBuilder.DefineField('Value', [Int32], [System.Reflection.FieldAttributes]::Public)`],
    ['nested-field-return',
      `$nestedField = $nestedBuilder.DefineField('Value', [Int32], [System.Reflection.FieldAttributes]::Public)\n${marker('nested-field-return')}`],
    ['outer-field-enter',
      `${marker('outer-field-enter')}\n$outerField = $outerBuilder.DefineField('Nested', $nestedBuilder, [System.Reflection.FieldAttributes]::Public)`],
    ['outer-field-return',
      `$outerField = $outerBuilder.DefineField('Nested', $nestedBuilder, [System.Reflection.FieldAttributes]::Public)\n${marker('outer-field-return')}`],
    ['callback-build-enter',
      `$state = [PSCustomObject]@{ Requests = 0; Type = $null }\n${marker('callback-build-enter')}\n$callback = {`],
    ['callback-closure-ready', `}.GetNewClosure()\n${marker('callback-closure-ready')}`],
    ['delegate-create-enter',
      `${marker('delegate-create-enter')}\n$handler = [System.ResolveEventHandler]$callback`],
    ['domain-ready', `$domain = [AppDomain]::CurrentDomain\n${marker('domain-ready')}`],
    ['handler-register-enter',
      `${marker('handler-register-enter')}\n$domain.add_TypeResolve($handler)`],
  ];
  assert.deepEqual(placements.map(([stage]) => stage),
    TYPE_RESOLVE_DOCUMENTED_SETUP_INSERTED_STAGES,
    'documented marker placement order');
  for (const [stage, fragment] of placements) {
    assert.equal(countLiteral(script, fragment), 1,
      `documented marker placement ${stage}`);
  }
}

function typeResolveIdentityPreamble(probe) {
  const template = String.raw`$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true)

$psVersion = $PSVersionTable.PSVersion
$clrVersion = $PSVersionTable.CLRVersion
if ($PSVersionTable.PSEdition -cne 'Desktop' -or
    $null -eq $psVersion -or $psVersion.Major -ne 5 -or $psVersion.Minor -ne 1 -or
    $psVersion.Build -lt 0 -or $psVersion.Revision -lt 0 -or
    $null -eq $clrVersion -or $clrVersion.Major -ne 4 -or $clrVersion.Minor -lt 0 -or
    $clrVersion.Build -lt 0 -or $clrVersion.Revision -lt 0) {
  throw 'runtime identity invalid'
}
$registryBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
  [Microsoft.Win32.RegistryHive]::LocalMachine,
  [Microsoft.Win32.RegistryView]::Default)
$frameworkKey = $null
$windowsKey = $null
try {
  $frameworkKey = $registryBase.OpenSubKey(
    'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', $false)
  $windowsKey = $registryBase.OpenSubKey(
    'SOFTWARE\Microsoft\Windows NT\CurrentVersion', $false)
  if ($null -eq $frameworkKey -or $null -eq $windowsKey -or
      $frameworkKey.GetValueKind('Release') -ne [Microsoft.Win32.RegistryValueKind]::DWord -or
      $windowsKey.GetValueKind('CurrentMajorVersionNumber') -ne [Microsoft.Win32.RegistryValueKind]::DWord -or
      $windowsKey.GetValueKind('CurrentMinorVersionNumber') -ne [Microsoft.Win32.RegistryValueKind]::DWord -or
      $windowsKey.GetValueKind('CurrentBuildNumber') -ne [Microsoft.Win32.RegistryValueKind]::String -or
      $windowsKey.GetValueKind('UBR') -ne [Microsoft.Win32.RegistryValueKind]::DWord) {
    throw 'runtime identity invalid'
  }
  $frameworkRelease = [int]($frameworkKey.GetValue('Release'))
  $osMajor = [int]($windowsKey.GetValue('CurrentMajorVersionNumber'))
  $osMinor = [int]($windowsKey.GetValue('CurrentMinorVersionNumber'))
  $osBuildText = [string]($windowsKey.GetValue('CurrentBuildNumber'))
  $osRevision = [int]($windowsKey.GetValue('UBR'))
} finally {
  if ($null -ne $windowsKey) { $windowsKey.Close() }
  if ($null -ne $frameworkKey) { $frameworkKey.Close() }
  if ($null -ne $registryBase) { $registryBase.Close() }
}
$osBuild = 0
if ($frameworkRelease -lt 533320 -or $osMajor -lt 10 -or $osMinor -lt 0 -or
    $osRevision -lt 0 -or -not [int]::TryParse($osBuildText,
      [System.Globalization.NumberStyles]::None,
      [System.Globalization.CultureInfo]::InvariantCulture, [ref]$osBuild) -or $osBuild -lt 0) {
  throw 'runtime identity invalid'
}
$identityLine = [string]::Format(
  [System.Globalization.CultureInfo]::InvariantCulture,
  '{{"version":1,"probe":"PROBE_LITERAL","stage":"runtime-identity","ps_edition":"Desktop","ps_major":{0},"ps_minor":{1},"ps_build":{2},"ps_revision":{3},"clr_major":{4},"clr_minor":{5},"clr_build":{6},"clr_revision":{7},"framework_release":{8},"os_major":{9},"os_minor":{10},"os_build":{11},"os_revision":{12}}}',
  [Object[]]@($psVersion.Major, $psVersion.Minor, $psVersion.Build, $psVersion.Revision,
    $clrVersion.Major, $clrVersion.Minor, $clrVersion.Build, $clrVersion.Revision,
    $frameworkRelease, $osMajor, $osMinor, $osBuild, $osRevision))
[Console]::Out.WriteLine($identityLine)
`;
  assert.equal(countLiteral(template, 'PROBE_LITERAL'), 1, 'identity probe sentinel count');
  const preamble = template.replace('PROBE_LITERAL', probe);
  assert.equal(countLiteral(preamble, 'PROBE_LITERAL'), 0, 'identity probe sentinel resolved');
  return preamble;
}

function dispatchTypeResolveDiagnosticScript() {
  const probe = 'dispatch';
  return typeResolveIdentityPreamble(probe) + [
    typeResolveStageLine(probe, 'started'),
    "$expectedName = 'DeepWorkTypeResolveDispatchMissingType'",
    '$state = [PSCustomObject]@{ Requests = 0; Exact = $false }',
    '$callback = {',
    '  param($sender, $eventArgs)',
    typeResolveStageLine(probe, 'handler-entered', '  '),
    '  $state.Requests++',
    '  if ([String]::Equals($eventArgs.Name, $expectedName,',
    '      [System.StringComparison]::Ordinal)) {',
    '    $state.Exact = $true',
    typeResolveStageLine(probe, 'name-exact', '    '),
    '  } else {',
    typeResolveStageLine(probe, 'name-foreign', '    '),
    '  }',
    '  if ($state.Requests -eq 1) {',
    typeResolveStageLine(probe, 'request-1', '    '),
    '  } else {',
    typeResolveStageLine(probe, 'request-duplicate', '    '),
    '  }',
    typeResolveStageLine(probe, 'handler-return-null', '  '),
    '  return $null',
    '}.GetNewClosure()',
    '$handler = [System.ResolveEventHandler]$callback',
    typeResolveStageLine(probe, 'delegate-created'),
    '$domain = [AppDomain]::CurrentDomain',
    '$domain.add_TypeResolve($handler)',
    typeResolveStageLine(probe, 'handler-registered'),
    'try {',
    typeResolveStageLine(probe, 'lookup-enter', '  '),
    '  $resolved = [Type]::GetType($expectedName, $false)',
    typeResolveStageLine(probe, 'lookup-returned', '  '),
    '} finally {',
    '  $domain.remove_TypeResolve($handler)',
    typeResolveStageLine(probe, 'handler-removed', '  '),
    '}',
    'if ($null -ne $resolved -or $state.Requests -ne 1 -or -not $state.Exact) {',
    "  throw 'dispatch control invalid'",
    '}',
    typeResolveStageLine(probe, 'completed'),
    '',
  ].join('\n');
}

function documentedTypeResolveDiagnosticScript() {
  const probe = 'documented';
  return typeResolveIdentityPreamble(probe) + [
    typeResolveStageLine(probe, 'started'),
    "$assemblyName = [System.Reflection.AssemblyName]::new('DeepWorkTypeResolveDocumentedAssembly')",
    typeResolveStageLine(probe, 'assembly-name-ready'),
    '$assemblyAccess = [System.Reflection.Emit.AssemblyBuilderAccess]::Run',
    typeResolveStageLine(probe, 'assembly-access-ready'),
    typeResolveStageLine(probe, 'factory-search-enter'),
    '$staticFactoryCandidates = @(',
    '  [System.Reflection.Emit.AssemblyBuilder].GetMethods() |',
    '    Microsoft.PowerShell.Core\\Where-Object {',
    "      $_.Name -eq 'DefineDynamicAssembly' -and $_.IsStatic -and",
    '      $_.GetParameters().Length -eq 2',
    '    }',
    ')',
    '$staticFactory = $staticFactoryCandidates[0]',
    typeResolveStageLine(probe, 'factory-search-return'),
    typeResolveStageLine(probe, 'assembly-create-enter'),
    'if ($null -ne $staticFactory) {',
    typeResolveStageLine(probe, 'assembly-create-static', '  '),
    '  $assemblyBuilder = $staticFactory.Invoke($null, @($assemblyName, $assemblyAccess))',
    '} else {',
    typeResolveStageLine(probe, 'assembly-create-appdomain', '  '),
    '  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)',
    '}',
    typeResolveStageLine(probe, 'assembly-create-return'),
    typeResolveStageLine(probe, 'module-create-enter'),
    "$moduleBuilder = $assemblyBuilder.DefineDynamicModule('DeepWorkTypeResolveDocumentedModule')",
    typeResolveStageLine(probe, 'module-create-return'),
    typeResolveStageLine(probe, 'outer-builder-enter'),
    '$outerAttributes = [System.Reflection.TypeAttributes]::Public',
    "$outerBuilder = $moduleBuilder.DefineType('DeepWorkTypeResolveDocumentedOuter', $outerAttributes)",
    typeResolveStageLine(probe, 'outer-builder-return'),
    typeResolveStageLine(probe, 'nested-builder-enter'),
    '$nestedAttributes = [System.Reflection.TypeAttributes](',
    '  [System.Reflection.TypeAttributes]::NestedPublic -bor',
    '  [System.Reflection.TypeAttributes]::Sealed -bor',
    '  [System.Reflection.TypeAttributes]::SequentialLayout -bor',
    '  [System.Reflection.TypeAttributes]::BeforeFieldInit)',
    "$nestedBuilder = $outerBuilder.DefineNestedType('NestedValue', $nestedAttributes, [ValueType])",
    typeResolveStageLine(probe, 'nested-builder-return'),
    typeResolveStageLine(probe, 'nested-field-enter'),
    "$nestedField = $nestedBuilder.DefineField('Value', [Int32], [System.Reflection.FieldAttributes]::Public)",
    typeResolveStageLine(probe, 'nested-field-return'),
    typeResolveStageLine(probe, 'outer-field-enter'),
    "$outerField = $outerBuilder.DefineField('Nested', $nestedBuilder, [System.Reflection.FieldAttributes]::Public)",
    typeResolveStageLine(probe, 'outer-field-return'),
    typeResolveStageLine(probe, 'builders-ready'),
    "$expectedName = 'DeepWorkTypeResolveDocumentedOuter+NestedValue'",
    '$state = [PSCustomObject]@{ Requests = 0; Type = $null }',
    typeResolveStageLine(probe, 'callback-build-enter'),
    '$callback = {',
    '  param($sender, $eventArgs)',
    typeResolveStageLine(probe, 'resolver-entered', '  '),
    '  $state.Requests++',
    '  if ($state.Requests -eq 1) {',
    typeResolveStageLine(probe, 'request-1', '    '),
    '  } elseif ($state.Requests -eq 2) {',
    typeResolveStageLine(probe, 'request-2', '    '),
    '  } else {',
    typeResolveStageLine(probe, 'request-3plus', '    '),
    "    if ($state.Requests -gt 3) { throw 'documented resolver request bound' }",
    '  }',
    '  if ([String]::Equals($eventArgs.Name, $expectedName,',
    '      [System.StringComparison]::Ordinal)) {',
    typeResolveStageLine(probe, 'name-exact', '    '),
    '  } else {',
    typeResolveStageLine(probe, 'name-other', '    '),
    '  }',
    '  try {',
    typeResolveStageLine(probe, 'nested-create-enter', '    '),
    '    $state.Type = $nestedBuilder.CreateType()',
    typeResolveStageLine(probe, 'nested-create-return', '    '),
    '  } catch [System.InvalidOperationException] {',
    typeResolveStageLine(probe, 'nested-already-created', '    '),
    '  }',
    typeResolveStageLine(probe, 'return-assembly', '  '),
    '  return $assemblyBuilder',
    '}.GetNewClosure()',
    typeResolveStageLine(probe, 'callback-closure-ready'),
    typeResolveStageLine(probe, 'delegate-create-enter'),
    '$handler = [System.ResolveEventHandler]$callback',
    typeResolveStageLine(probe, 'delegate-created'),
    '$domain = [AppDomain]::CurrentDomain',
    typeResolveStageLine(probe, 'domain-ready'),
    typeResolveStageLine(probe, 'handler-register-enter'),
    '$domain.add_TypeResolve($handler)',
    typeResolveStageLine(probe, 'handler-registered'),
    'try {',
    typeResolveStageLine(probe, 'enclosing-create-enter', '  '),
    '  $outerType = $outerBuilder.CreateType()',
    typeResolveStageLine(probe, 'enclosing-create-return', '  '),
    '} finally {',
    '  $domain.remove_TypeResolve($handler)',
    typeResolveStageLine(probe, 'handler-removed', '  '),
    '}',
    "if ($null -eq $outerType) { throw 'documented control invalid' }",
    '$nestedFlags = [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::NonPublic',
    "$nestedType = $outerType.GetNestedType('NestedValue', $nestedFlags)",
    "if ($null -eq $nestedType) { throw 'documented control invalid' }",
    '$outerFields = @($outerType.GetFields([System.Reflection.BindingFlags]::Public -bor',
    '  [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::DeclaredOnly))',
    '$nestedFields = @($nestedType.GetFields([System.Reflection.BindingFlags]::Public -bor',
    '  [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::DeclaredOnly))',
    "if ($outerType.FullName -cne 'DeepWorkTypeResolveDocumentedOuter' -or",
    '    $nestedType.FullName -cne $expectedName -or',
    '    -not [Object]::ReferenceEquals($nestedType.DeclaringType, $outerType) -or',
    '    -not [Object]::Equals($nestedType.Assembly, $assemblyBuilder) -or',
    "    $outerFields.Length -ne 1 -or $outerFields[0].Name -cne 'Nested' -or",
    '    -not [Object]::ReferenceEquals($outerFields[0].FieldType, $nestedType) -or',
    "    $nestedFields.Length -ne 1 -or $nestedFields[0].Name -cne 'Value' -or",
    '    $nestedFields[0].FieldType -ne [Int32]) {',
    "  throw 'documented control invalid'",
    '}',
    typeResolveStageLine(probe, 'completed'),
    '',
  ].join('\n');
}

function applyPinnedTypeResolveMarker(source, {id, anchor, placement = 'after'}) {
  assert.equal(countLiteral(source, anchor), 1, `pinned anchor ${id}`);
  const marker = typeResolveStageLine('pinned', id);
  const after = placement === 'before' ? `${marker}\n${anchor}` : `${anchor}\n${marker}`;
  return {
    source:source.replace(anchor, after),
    transform:{id, before:anchor, after},
    marker,
  };
}

function pinnedTypeResolveStateDiagnosticBlock() {
  const marker = (stage, indent = '') => typeResolveStageLine('pinned', stage, indent);
  return [
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_BEGIN',
    'if ($nativeTypeFailure) {',
    marker('state-native-create-failed', '  '),
    '} else {',
    marker('state-native-create-succeeded', '  '),
    '}',
    'if ($typeResolveState.Requests -eq 0) {',
    marker('state-requests-zero', '  '),
    '} elseif ($typeResolveState.Requests -eq 1) {',
    marker('state-requests-one', '  '),
    '} else {',
    marker('state-requests-other', '  '),
    '}',
    'if ($null -eq $typeResolveState.Failure) {',
    marker('state-failure-null', '  '),
    "} elseif ($typeResolveState.Failure -ceq 'stream type resolve name mismatch') {",
    marker('state-failure-name-mismatch', '  '),
    "} elseif ($typeResolveState.Failure -ceq 'stream type resolve duplicate') {",
    marker('state-failure-duplicate', '  '),
    "} elseif ($typeResolveState.Failure -ceq 'stream type resolve result mismatch') {",
    marker('state-failure-result-mismatch', '  '),
    "} elseif ($typeResolveState.Failure -ceq 'stream type resolve failed') {",
    marker('state-failure-catch', '  '),
    '} else {',
    marker('state-failure-other', '  '),
    '}',
    'if ($null -eq $typeResolveState.Type) {',
    marker('state-type-null', '  '),
    '} else {',
    marker('state-type-present', '  '),
    '}',
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END',
  ].join('\n');
}

function pinnedTypeResolveLateBakeDiagnosticBlock() {
  const marker = (stage, indent = '') => typeResolveStageLine('pinned', stage, indent);
  return [
    '# DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_DIAGNOSTIC_BEGIN',
    '$lateBakeApplicable = -not $nativeTypeFailure -and',
    '  $typeResolveState.Requests -eq 0 -and',
    '  $null -eq $typeResolveState.Failure -and',
    '  $null -eq $typeResolveState.Type',
    'if ($lateBakeApplicable) {',
    marker('late-bake-applicable', '  '),
    marker('late-bake-create-enter', '  '),
    '  try {',
    '    $lateBakeType = $streamDataBuilder.CreateType()',
    marker('late-bake-create-return', '    '),
    '  } catch {',
    marker('late-bake-create-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if ($null -eq $lateBakeType) {',
    marker('late-bake-result-null', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  try {',
    '    $lateBakeNestedFlags = [System.Reflection.BindingFlags]::Public -bor',
    '      [System.Reflection.BindingFlags]::NonPublic',
    "    $lateBakeCanonicalType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA',",
    '      $lateBakeNestedFlags)',
    '    $lateBakeIdentityMatch = $null -ne $lateBakeCanonicalType -and',
    '      [Object]::ReferenceEquals($lateBakeType, $lateBakeCanonicalType) -and',
    "      [String]::Equals($lateBakeType.FullName, 'DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA',",
    '        [System.StringComparison]::Ordinal) -and',
    '      [Object]::ReferenceEquals($lateBakeType.DeclaringType, $nativeType) -and',
    '      [Object]::Equals($lateBakeType.Assembly, $assemblyBuilder) -and',
    '      [Object]::ReferenceEquals($lateBakeType.Module, $nativeType.Module) -and',
    '      $lateBakeType.IsValueType -and $lateBakeType.IsNestedPublic -and',
    '      $lateBakeType.IsSealed -and $lateBakeType.IsLayoutSequential -and',
    '      $lateBakeType.IsUnicodeClass -and',
    '      ($lateBakeType.Attributes -band',
    '        [System.Reflection.TypeAttributes]::BeforeFieldInit) -ne 0',
    '  } catch {',
    marker('late-bake-identity-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if (-not $lateBakeIdentityMatch) {',
    marker('late-bake-identity-mismatch', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    marker('late-bake-identity-authenticated', '  '),
    '  try {',
    '    $lateBakeFieldFlags = [System.Reflection.BindingFlags]::Public -bor',
    '      [System.Reflection.BindingFlags]::NonPublic -bor',
    '      [System.Reflection.BindingFlags]::Instance -bor',
    '      [System.Reflection.BindingFlags]::Static -bor',
    '      [System.Reflection.BindingFlags]::DeclaredOnly',
    '    $lateBakeFields = @($lateBakeType.GetFields($lateBakeFieldFlags))',
    "    $lateBakeStreamSizeField = $lateBakeType.GetField('StreamSize', $lateBakeFieldFlags)",
    "    $lateBakeStreamNameField = $lateBakeType.GetField('cStreamName', $lateBakeFieldFlags)",
    '    $lateBakeMarshal = @($lateBakeStreamNameField.GetCustomAttributes(',
    '      [System.Runtime.InteropServices.MarshalAsAttribute], $false))',
    '    $lateBakeFieldsMatch = $lateBakeFields.Length -eq 2 -and',
    '      $null -ne $lateBakeStreamSizeField -and',
    '      $lateBakeStreamSizeField.FieldType -eq [Int64] -and',
    '      $lateBakeStreamSizeField.IsPublic -and -not $lateBakeStreamSizeField.IsStatic -and',
    '      $null -ne $lateBakeStreamNameField -and',
    '      $lateBakeStreamNameField.FieldType -eq [String] -and',
    '      $lateBakeStreamNameField.IsPublic -and -not $lateBakeStreamNameField.IsStatic -and',
    '      $lateBakeMarshal.Length -eq 1 -and',
    '      $lateBakeMarshal[0].Value -eq',
    '        [System.Runtime.InteropServices.UnmanagedType]::ByValTStr -and',
    '      $lateBakeMarshal[0].SizeConst -eq 296',
    '  } catch {',
    marker('late-bake-fields-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if (-not $lateBakeFieldsMatch) {',
    marker('late-bake-fields-mismatch', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    marker('late-bake-fields-authenticated', '  '),
    '  try {',
    '    $lateBakeMethodFlags = [System.Reflection.BindingFlags]::Public -bor',
    '      [System.Reflection.BindingFlags]::Static -bor',
    '      [System.Reflection.BindingFlags]::DeclaredOnly',
    '    $lateBakeMethods = @($nativeType.GetMethods($lateBakeMethodFlags))',
    "    $lateBakeFindFirst = $nativeType.GetMethod('FindFirstStreamW', $lateBakeMethodFlags)",
    "    $lateBakeFindNext = $nativeType.GetMethod('FindNextStreamW', $lateBakeMethodFlags)",
    "    $lateBakeFindClose = $nativeType.GetMethod('FindClose', $lateBakeMethodFlags)",
    '    $lateBakeByRef = $lateBakeType.MakeByRefType()',
    '    $lateBakeFindFirstParameters = @($lateBakeFindFirst.GetParameters())',
    '    $lateBakeFindNextParameters = @($lateBakeFindNext.GetParameters())',
    '    $lateBakeFindCloseParameters = @($lateBakeFindClose.GetParameters())',
    '    $lateBakeMethodsMatch = $lateBakeMethods.Length -eq 3 -and',
    '      $null -ne $lateBakeFindFirst -and $null -ne $lateBakeFindNext -and',
    '      $null -ne $lateBakeFindClose -and',
    '      $lateBakeFindFirst.ReturnType -eq [IntPtr] -and',
    '      $lateBakeFindFirstParameters.Length -eq 4 -and',
    '      $lateBakeFindFirstParameters[0].ParameterType -eq [String] -and',
    '      $lateBakeFindFirstParameters[1].ParameterType -eq [Int32] -and',
    '      $lateBakeFindFirstParameters[2].ParameterType -eq $lateBakeByRef -and',
    '      $lateBakeFindFirstParameters[3].ParameterType -eq [UInt32] -and',
    '      $lateBakeFindNext.ReturnType -eq [Boolean] -and',
    '      $lateBakeFindNextParameters.Length -eq 2 -and',
    '      $lateBakeFindNextParameters[0].ParameterType -eq [IntPtr] -and',
    '      $lateBakeFindNextParameters[1].ParameterType -eq $lateBakeByRef -and',
    '      $lateBakeFindClose.ReturnType -eq [Boolean] -and',
    '      $lateBakeFindCloseParameters.Length -eq 1 -and',
    '      $lateBakeFindCloseParameters[0].ParameterType -eq [IntPtr]',
    '  } catch {',
    marker('late-bake-methods-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if (-not $lateBakeMethodsMatch) {',
    marker('late-bake-methods-mismatch', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    marker('late-bake-methods-authenticated', '  '),
    '  try {',
    '    $lateBakeFindFirstImports = @($lateBakeFindFirst.GetCustomAttributes(',
    '      [System.Runtime.InteropServices.DllImportAttribute], $false))',
    '    $lateBakeFindNextImports = @($lateBakeFindNext.GetCustomAttributes(',
    '      [System.Runtime.InteropServices.DllImportAttribute], $false))',
    '    $lateBakeFindCloseImports = @($lateBakeFindClose.GetCustomAttributes(',
    '      [System.Runtime.InteropServices.DllImportAttribute], $false))',
    '    $lateBakeInteropMatch = $lateBakeFindFirstImports.Length -eq 1 -and',
    '      $lateBakeFindNextImports.Length -eq 1 -and $lateBakeFindCloseImports.Length -eq 1 -and',
    "      [String]::Equals($lateBakeFindFirstImports[0].Value, 'kernel32.dll',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindNextImports[0].Value, 'kernel32.dll',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindCloseImports[0].Value, 'kernel32.dll',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindFirstImports[0].EntryPoint, 'FindFirstStreamW',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindNextImports[0].EntryPoint, 'FindNextStreamW',",
    '        [System.StringComparison]::Ordinal) -and',
    "      [String]::Equals($lateBakeFindCloseImports[0].EntryPoint, 'FindClose',",
    '        [System.StringComparison]::Ordinal) -and',
    '      $lateBakeFindFirstImports[0].CharSet -eq',
    '        [System.Runtime.InteropServices.CharSet]::Unicode -and',
    '      $lateBakeFindNextImports[0].CharSet -eq',
    '        [System.Runtime.InteropServices.CharSet]::Unicode -and',
    '      $lateBakeFindCloseImports[0].CharSet -eq',
    '        [System.Runtime.InteropServices.CharSet]::None -and',
    '      $lateBakeFindFirstImports[0].CallingConvention -eq',
    '        [System.Runtime.InteropServices.CallingConvention]::Winapi -and',
    '      $lateBakeFindNextImports[0].CallingConvention -eq',
    '        [System.Runtime.InteropServices.CallingConvention]::Winapi -and',
    '      $lateBakeFindCloseImports[0].CallingConvention -eq',
    '        [System.Runtime.InteropServices.CallingConvention]::Winapi -and',
    '      $lateBakeFindFirstImports[0].SetLastError -and',
    '      $lateBakeFindNextImports[0].SetLastError -and',
    '      $lateBakeFindCloseImports[0].SetLastError -and',
    '      $lateBakeFindFirstImports[0].ExactSpelling -and',
    '      $lateBakeFindNextImports[0].ExactSpelling -and',
    '      $lateBakeFindCloseImports[0].ExactSpelling -and',
    '      $lateBakeFindFirstImports[0].PreserveSig -and',
    '      $lateBakeFindNextImports[0].PreserveSig -and',
    '      $lateBakeFindCloseImports[0].PreserveSig -and',
    '      ($lateBakeFindFirst.GetMethodImplementationFlags() -band',
    '        [System.Reflection.MethodImplAttributes]::PreserveSig) -ne 0 -and',
    '      ($lateBakeFindNext.GetMethodImplementationFlags() -band',
    '        [System.Reflection.MethodImplAttributes]::PreserveSig) -ne 0 -and',
    '      ($lateBakeFindClose.GetMethodImplementationFlags() -band',
    '        [System.Reflection.MethodImplAttributes]::PreserveSig) -ne 0',
    '  } catch {',
    marker('late-bake-interop-exception', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    '  if (-not $lateBakeInteropMatch) {',
    marker('late-bake-interop-mismatch', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
    marker('late-bake-interop-authenticated', '  '),
    marker('late-bake-completed', '  '),
    '}',
    '# DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_DIAGNOSTIC_END',
  ].join('\n');
}

function pinnedTypeResolveLateBakeIdentityAxisStep(axis) {
  const exception = `late-bake-identity-axis-${axis.id}-exception`;
  const mismatch = `late-bake-identity-axis-${axis.id}-mismatch`;
  return [
    '  try {',
    ...(axis.setup || []),
    ...axis.predicate,
    '  } catch {',
    typeResolveStageLine('pinned', exception, '    '),
    "    throw 'stream late bake identity-axis diagnostic failed'",
    '  }',
    '  if (-not $lateBakeIdentityAxisMatch) {',
    typeResolveStageLine('pinned', mismatch, '    '),
    "    throw 'stream late bake identity-axis diagnostic failed'",
    '  }',
  ].join('\n');
}

function pinnedTypeResolveLateBakeIdentityAxisDiagnosticBlock() {
  return [
    '  # DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_IDENTITY_AXIS_BEGIN',
    ...TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXES.map(
      pinnedTypeResolveLateBakeIdentityAxisStep),
    '  # DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_IDENTITY_AXIS_END',
  ].join('\n');
}

function pinnedTypeResolveGuardedMarker(stage, outputGuard) {
  assert.equal(['before-increment','after-increment'].includes(outputGuard), true,
    `pinned output guard class ${stage}`);
  const comparison = outputGuard === 'before-increment' ? '-lt' : '-le';
  return [
    `if ($typeResolveState.Requests ${comparison} 2) {`,
    typeResolveStageLine('pinned', stage),
    '}',
  ].join('\n');
}

function applyPinnedTypeResolveOutputGuard(source, {id, outputGuard}) {
  const before = typeResolveStageLine('pinned', id);
  const after = pinnedTypeResolveGuardedMarker(id, outputGuard);
  assert.equal(countLiteral(source, before), 1, `pinned output guard marker ${id}`);
  return {source:source.replace(before, after), transform:{id, before, after, outputGuard}};
}

function applyPinnedTypeResolveStateClassifier(source) {
  const before = [
    '# DEEP_WORK_TYPE_RESOLVE_SCOPE_END',
    '',
    '# DEEP_WORK_TYPE_AUTHENTICATION_BEGIN',
    '',
  ].join('\n');
  const classifier = pinnedTypeResolveStateDiagnosticBlock();
  const after = `${before}${classifier}\n`;
  assert.equal(countLiteral(source, before), 1, 'pinned state classifier anchor');
  return {
    source:source.replace(before, after),
    transform:{id:'post-scope-state-classifier', before, after},
  };
}

function applyPinnedTypeResolveLateBakeDiagnostic(source) {
  const before = [
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END',
    "if ($nativeTypeFailure) { throw 'stream native type creation failed' }",
  ].join('\n');
  const block = pinnedTypeResolveLateBakeDiagnosticBlock();
  const after = [
    '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END',
    block,
    "if ($nativeTypeFailure) { throw 'stream native type creation failed' }",
  ].join('\n');
  assert.equal(countLiteral(source, before), 1, 'pinned late-bake insertion anchor');
  return {
    source:source.replace(before, after),
    transform:{id:'no-dispatch-late-bake-diagnostic', before, after},
  };
}

function applyPinnedTypeResolveLateBakeIdentityAxisDiagnostic(source) {
  const marker = (stage, indent = '') => typeResolveStageLine('pinned', stage, indent);
  const before = [
    '  if ($null -eq $lateBakeType) {',
    marker('late-bake-result-null', '    '),
    "    throw 'stream late bake diagnostic failed'",
    '  }',
  ].join('\n');
  const after = [
    '  try {',
    '    $lateBakeNestedFlags = [System.Reflection.BindingFlags]::Public -bor',
  ].join('\n');
  const block = pinnedTypeResolveLateBakeIdentityAxisDiagnosticBlock();
  const anchor = `${before}\n${after}`;
  const replacement = `${before}\n${block}\n${after}`;
  assert.equal(countLiteral(source, anchor), 1,
    'pinned late-bake identity-axis insertion anchor');
  return {
    source:source.replace(anchor, replacement),
    transform:{id:'late-bake-identity-axis', before, after},
  };
}

function reversePinnedTypeResolveDiagnosticTransforms(diagnostic) {
  let reconstructed = diagnostic.transformed;
  const identityAxisBlock = pinnedTypeResolveLateBakeIdentityAxisDiagnosticBlock();
  const identityAxisPlacement = `${diagnostic.lateBakeIdentityAxisTransform.before}\n` +
    `${identityAxisBlock}\n${diagnostic.lateBakeIdentityAxisTransform.after}`;
  const identityAxisAnchor = `${diagnostic.lateBakeIdentityAxisTransform.before}\n` +
    diagnostic.lateBakeIdentityAxisTransform.after;
  assert.equal(countLiteral(reconstructed, identityAxisPlacement), 1,
    'pinned reverse late-bake identity-axis diagnostic');
  reconstructed = reconstructed.replace(identityAxisPlacement, identityAxisAnchor);
  assert.equal(countLiteral(reconstructed, diagnostic.lateBakeTransform.after), 1,
    'pinned reverse late-bake diagnostic');
  reconstructed = reconstructed.replace(diagnostic.lateBakeTransform.after,
    diagnostic.lateBakeTransform.before);
  assert.equal(countLiteral(reconstructed, diagnostic.classifierTransform.after), 1,
    'pinned reverse state classifier');
  reconstructed = reconstructed.replace(diagnostic.classifierTransform.after,
    diagnostic.classifierTransform.before);
  for (const transform of [...diagnostic.guardTransforms].reverse()) {
    assert.equal(countLiteral(reconstructed, transform.after), 1,
      `pinned reverse output guard ${transform.id}`);
    reconstructed = reconstructed.replace(transform.after, transform.before);
  }
  for (const transform of [...diagnostic.transforms].reverse()) {
    assert.equal(countLiteral(reconstructed, transform.after), 1,
      `pinned reverse anchor ${transform.id}`);
    reconstructed = reconstructed.replace(transform.after, transform.before);
  }
  return reconstructed;
}

function stripPinnedTypeResolveDiagnostic(source) {
  let stripped = source;
  const identityAxis = `${pinnedTypeResolveLateBakeIdentityAxisDiagnosticBlock()}\n`;
  assert.equal(countLiteral(stripped, identityAxis), 1,
    'pinned late-bake identity-axis strip');
  stripped = stripped.replace(identityAxis, '');
  const lateBake = `${pinnedTypeResolveLateBakeDiagnosticBlock()}\n`;
  assert.equal(countLiteral(stripped, lateBake), 1, 'pinned late-bake strip');
  stripped = stripped.replace(lateBake, '');
  const classifier = `${pinnedTypeResolveStateDiagnosticBlock()}\n`;
  assert.equal(countLiteral(stripped, classifier), 1, 'pinned classifier strip');
  stripped = stripped.replace(classifier, '');
  for (const [stage, outputGuard] of [...TYPE_RESOLVE_PINNED_CALLBACK_OUTPUT_GUARDS]
    .reverse()) {
    const wrapper = pinnedTypeResolveGuardedMarker(stage, outputGuard);
    assert.equal(countLiteral(stripped, wrapper), 1,
      `pinned output guard strip ${stage}`);
    stripped = stripped.replace(wrapper, typeResolveStageLine('pinned', stage));
  }
  const markerLines = new Set(TYPE_RESOLVE_PINNED_INSERTED_STAGES.map((stage) =>
    typeResolveStageLine('pinned', stage)));
  return stripped.split('\n').filter((line) => !markerLines.has(line.trim())).join('\n');
}

function pinnedWindowsTypeResolveDiagnostic() {
  const helperBytes = fs.readFileSync(path.join(__dirname, 'windows-stream-inventory.ps1'));
  assert.equal(hash(helperBytes), WINDOWS_STREAM_INVENTORY_HELPER_SHA256,
    'pinned helper digest');
  const original = windowsStreamPInvokeSource();
  assert.equal(hash(Buffer.from(original, 'utf8')), WINDOWS_STREAM_INVENTORY_PINVOKE_SHA256,
    'pinned source digest');
  assertWindowsStreamTypeResolveSource(original);
  const specifications = [
    {id:'factory-candidates-ready', anchor:EXPECTED_WINDOWS_FACTORY_CANDIDATE_MATERIALIZATION},
    {id:'factory-index-enter', anchor:EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX, placement:'before'},
    {id:'factory-index-return', anchor:EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX},
    {id:'factory-branch-enter', anchor:'if ($null -ne $staticFactory) {', placement:'before'},
    {id:'factory-invoke-enter', anchor:'  $assemblyBuilder = $staticFactory.Invoke($null, @($assemblyName, $assemblyAccess))', placement:'before'},
    {id:'factory-invoke-return', anchor:'  $assemblyBuilder = $staticFactory.Invoke($null, @($assemblyName, $assemblyAccess))'},
    {id:'factory-fallback-enter', anchor:'  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)', placement:'before'},
    {id:'factory-fallback-return', anchor:'  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)'},
    {id:'assembly-ready', anchor:`  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)\n${typeResolveStageLine('pinned', 'factory-fallback-return')}\n}`},
    {id:'module-ready', anchor:"$moduleBuilder = $assemblyBuilder.DefineDynamicModule('DeepWorkStreamInventoryNativeModule')"},
    {id:'native-builder-ready', anchor:"$nativeBuilder = $moduleBuilder.DefineType('DeepWorkStreamInventoryNative', $nativeAttributes)"},
    {id:'stream-builder-ready', anchor:"$streamDataBuilder = $nativeBuilder.DefineNestedType('WIN32_FIND_STREAM_DATA',\n  $streamDataAttributes, [ValueType])"},
    {id:'stream-fields-ready', anchor:'$streamNameField.SetCustomAttribute($marshalAttribute)'},
    {id:'byref-ready', anchor:'$streamDataByRef = $streamDataType.MakeByRefType()'},
    {id:'methods-defined', anchor:'[void](Add-ClosedPInvokeMethod @findCloseDefinition)'},
    {id:'callback-build-enter', anchor:'$typeResolveCallback = {', placement:'before'},
    {id:'resolver-entered', anchor:'  param($sender, $eventArgs)',
      outputGuard:'before-increment'},
    {id:'resolver-request-incremented', anchor:'    $typeResolveState.Requests++',
      outputGuard:'after-increment'},
    {id:'resolver-name-foreign', anchor:'    if (-not [String]::Equals($eventArgs.Name, $expectedStreamDataTypeName,\n        [System.StringComparison]::Ordinal)) {',
      outputGuard:'after-increment'},
    {id:'resolver-reject-name', anchor:"      $typeResolveState.Failure = 'stream type resolve name mismatch'",
      outputGuard:'after-increment'},
    {id:'resolver-name-exact', anchor:'    if ($typeResolveState.Requests -ne 1) {',
      placement:'before', outputGuard:'after-increment'},
    {id:'resolver-reject-duplicate', anchor:'    if ($typeResolveState.Requests -ne 1) {',
      outputGuard:'after-increment'},
    {id:'resolver-request-1', anchor:'    $resolvedStreamDataType = $streamDataBuilder.CreateType()',
      placement:'before', outputGuard:'after-increment'},
    {id:'resolver-nested-create-enter', anchor:'    $resolvedStreamDataType = $streamDataBuilder.CreateType()',
      placement:'before', outputGuard:'after-increment'},
    {id:'resolver-nested-create-return', anchor:'    $resolvedStreamDataType = $streamDataBuilder.CreateType()',
      outputGuard:'after-increment'},
    {id:'resolver-result-authenticated', anchor:'    $typeResolveState.Type = $resolvedStreamDataType',
      placement:'before', outputGuard:'after-increment'},
    {id:'resolver-return-assembly', anchor:'    return $assemblyBuilder',
      placement:'before', outputGuard:'after-increment'},
    {id:'resolver-catch', anchor:'    return $assemblyBuilder\n  } catch {',
      outputGuard:'after-increment'},
    {id:'callback-closure-ready', anchor:'}.GetNewClosure()'},
    {id:'delegate-ready', anchor:'$typeResolveHandler = [System.ResolveEventHandler]$typeResolveCallback'},
    {id:'handler-registered', anchor:'$currentDomain.add_TypeResolve($typeResolveHandler)'},
    {id:'enclosing-create-enter', anchor:'  $nativeType = $nativeBuilder.CreateType()', placement:'before'},
    {id:'enclosing-create-return', anchor:'  $nativeType = $nativeBuilder.CreateType()'},
    {id:'enclosing-create-catch', anchor:'  $nativeTypeFailure = $true', placement:'before'},
    {id:'handler-remove-enter', anchor:'} finally {'},
    {id:'handler-removed', anchor:'  $currentDomain.remove_TypeResolve($typeResolveHandler)'},
    {id:'scope-exited', anchor:'# DEEP_WORK_TYPE_RESOLVE_SCOPE_END', placement:'before'},
    {id:'resolver-state-authenticated', anchor:'$nestedTypeFlags = [System.Reflection.BindingFlags]::Public -bor', placement:'before'},
    {id:'nested-type-authenticated', anchor:'$nativeMethodFlags = [System.Reflection.BindingFlags]::Public -bor', placement:'before'},
    {id:'methods-reflected', anchor:"$findClose = $nativeType.GetMethod('FindClose', $nativeMethodFlags)"},
    {id:'methods-authenticated', anchor:windowsStreamRuntimeAttestationLines()[2]},
  ];
  assert.deepEqual(specifications.map(({id}) => id), TYPE_RESOLVE_PINNED_INSERTED_STAGES,
    'pinned marker specification order');
  assert.deepEqual(specifications.filter(({outputGuard}) => outputGuard)
    .map(({id, outputGuard}) => [id, outputGuard]),
  TYPE_RESOLVE_PINNED_CALLBACK_OUTPUT_GUARDS,
  'pinned callback output guard specification order');
  let transformed = original;
  const transforms = [];
  const markerLines = new Set();
  for (const specification of specifications) {
    const applied = applyPinnedTypeResolveMarker(transformed, specification);
    transformed = applied.source;
    transforms.push(applied.transform);
    markerLines.add(applied.marker);
  }
  const guardTransforms = [];
  for (const specification of specifications.filter(({outputGuard}) => outputGuard)) {
    const applied = applyPinnedTypeResolveOutputGuard(transformed, specification);
    transformed = applied.source;
    guardTransforms.push(applied.transform);
  }
  const classifier = applyPinnedTypeResolveStateClassifier(transformed);
  transformed = classifier.source;
  const lateBake = applyPinnedTypeResolveLateBakeDiagnostic(transformed);
  transformed = lateBake.source;
  const lateBakeIdentityAxis = applyPinnedTypeResolveLateBakeIdentityAxisDiagnostic(transformed);
  transformed = lateBakeIdentityAxis.source;
  const diagnostic = {
    original,
    transformed,
    transforms,
    guardTransforms,
    classifierTransform:classifier.transform,
    lateBakeTransform:lateBake.transform,
    lateBakeIdentityAxisTransform:lateBakeIdentityAxis.transform,
  };
  const reconstructed = reversePinnedTypeResolveDiagnosticTransforms(diagnostic);
  assert.equal(reconstructed, original, 'pinned reverse reconstruction');
  assert.equal(stripPinnedTypeResolveDiagnostic(transformed), original,
    'pinned independent diagnostic stripping');
  assert.equal(transformed.includes('RequestingAssembly'), false,
    'pinned requester observation absent');
  return {
    script:typeResolveIdentityPreamble('pinned') +
      `${typeResolveStageLine('pinned', 'started')}\n${transformed}` +
      `${typeResolveStageLine('pinned', 'completed')}\n`,
    original,
    transformed,
    transforms,
    guardTransforms,
    classifierTransform:classifier.transform,
    lateBakeTransform:lateBake.transform,
    lateBakeIdentityAxisTransform:lateBakeIdentityAxis.transform,
    markerLines,
  };
}

function factoryDiscoveryTypeResolveDiagnosticScript() {
  const probe = 'factory-discovery';
  return typeResolveIdentityPreamble(probe) + [
    typeResolveStageLine(probe, 'started'),
    typeResolveStageLine(probe, 'type-token-enter'),
    '$factoryType = [System.Reflection.Emit.AssemblyBuilder]',
    typeResolveStageLine(probe, 'type-token-return'),
    typeResolveStageLine(probe, 'get-methods-enter'),
    '$allMethods = @($factoryType.GetMethods())',
    typeResolveStageLine(probe, 'get-methods-return'),
    typeResolveStageLine(probe, 'name-filter-enter'),
    "$namedMethods = @($allMethods | Where-Object { $_.Name -ceq 'DefineDynamicAssembly' })",
    typeResolveStageLine(probe, 'name-filter-return'),
    typeResolveStageLine(probe, 'static-filter-enter'),
    '$staticMethods = @($namedMethods | Where-Object { $_.IsStatic })',
    typeResolveStageLine(probe, 'static-filter-return'),
    typeResolveStageLine(probe, 'parameter-filter-enter'),
    '$twoParameterMethods = @($staticMethods | Where-Object { $_.GetParameters().Length -eq 2 })',
    typeResolveStageLine(probe, 'parameter-filter-return'),
    typeResolveStageLine(probe, 'index-enter'),
    '$indexedFactory = $twoParameterMethods[0]',
    typeResolveStageLine(probe, 'index-return'),
    'if ($null -eq $indexedFactory) {',
    typeResolveStageLine(probe, 'indexed-null', '  '),
    '} else {',
    typeResolveStageLine(probe, 'indexed-present', '  '),
    '}',
    typeResolveStageLine(probe, 'completed'),
    '',
  ].join('\n');
}

function windowsTypeResolveDiagnosticScripts() {
  return {
    dispatch:dispatchTypeResolveDiagnosticScript(),
    documented:documentedTypeResolveDiagnosticScript(),
    pinned:pinnedWindowsTypeResolveDiagnostic().script,
    factoryDiscovery:factoryDiscoveryTypeResolveDiagnosticScript(),
  };
}

function assertClosedTypeResolveDiagnosticScript(script, {
  probe,
  requirePinnedSource,
}) {
  assert.equal(['dispatch','documented','pinned','factory-discovery'].includes(probe), true,
    'closed diagnostic probe');
  const bytes = Buffer.from(script, 'utf8');
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false,
    `closed ${probe} bom`);
  assert.equal(script.includes('\r'), false, `closed ${probe} line endings`);
  assert.equal(script.startsWith("$ErrorActionPreference = 'Stop'\n"), true,
    `closed ${probe} prologue`);
  assert.equal(countLiteral(script, '[Console]::InputEncoding'), 1,
    `closed ${probe} input encoding`);
  assert.equal(countLiteral(script, '[Console]::OutputEncoding'), 1,
    `closed ${probe} output encoding`);
  assert.equal(countLiteral(script, '[Console]::In.'), 0, `closed ${probe} stdin`);
  assert.equal(countLiteral(script, '[Parameter('), 0, `closed ${probe} caller parameter`);
  assert.equal(countLiteral(script, '$LiteralPath'), 0, `closed ${probe} caller path`);
  assert.equal(countLiteral(script, '$args'), 0, `closed ${probe} args`);
  assert.equal(countLiteral(script, 'PROBE_LITERAL'), 0, `closed ${probe} sentinel`);
  const forbiddenPatterns = [
    /\bAdd-Type\b/giu,
    /\bGet-Item\b/giu,
    /\bConvertTo-Json\b/giu,
    /\bInvoke-Expression\b/giu,
    /\bInvoke-Command\b/giu,
    /\bStart-Process\b/giu,
    /\b(?:cmd|pwsh)(?:\.exe)?\b/giu,
    /\bRead-Host\b/giu,
    /\[Environment\]::OSVersion/giu,
    /\bGet-CimInstance\b/giu,
    /\bGet-ComputerInfo\b/giu,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.equal(pattern.test(script), false, `closed ${probe} forbidden surface`);
  }
  assert.equal(countLiteral(script, '[Microsoft.Win32.RegistryKey]::OpenBaseKey('), 1,
    `closed ${probe} registry base`);
  assert.equal(countLiteral(script, '[Microsoft.Win32.RegistryView]::Default'), 1,
    `closed ${probe} registry view`);
  assert.equal(countLiteral(script,
    "'SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full'"), 1,
  `closed ${probe} framework key`);
  assert.equal(countLiteral(script,
    "'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'"), 1,
  `closed ${probe} windows key`);
  assert.equal(countLiteral(script, '.OpenSubKey('), 2, `closed ${probe} registry keys`);
  assert.equal(countLiteral(script, '.GetValueKind('), 5,
    `closed ${probe} registry value kinds`);
  assert.equal(countLiteral(script, '.GetValue('), 5, `closed ${probe} registry values`);
  for (const valueName of ['Release','CurrentMajorVersionNumber',
    'CurrentMinorVersionNumber','CurrentBuildNumber','UBR']) {
    assert.equal(countLiteral(script, `'${valueName}'`), 2,
      `closed ${probe} registry value ${valueName}`);
  }
  for (const closure of ['$windowsKey.Close()','$frameworkKey.Close()',
    '$registryBase.Close()']) {
    assert.equal(countLiteral(script, closure), 1, `closed ${probe} registry closure`);
  }
  assert.equal(countLiteral(script, '[string]::Format('), 1,
    `closed ${probe} identity format`);
  assert.equal(countLiteral(script, '[System.Globalization.NumberStyles]::None'), 1,
    `closed ${probe} numeric parse`);
  assert.equal(countLiteral(script, '[System.Globalization.CultureInfo]::InvariantCulture'), 2,
    `closed ${probe} invariant culture`);
  for (const guard of [
    "$PSVersionTable.PSEdition -cne 'Desktop'",
    '$psVersion.Major -ne 5',
    '$psVersion.Minor -ne 1',
    '$clrVersion.Major -ne 4',
    '$frameworkRelease -lt 533320',
    '$osMajor -lt 10',
  ]) {
    assert.equal(countLiteral(script, guard), 1, `closed ${probe} identity guard`);
  }
  const identityFormat = `{{"version":1,"probe":"${probe}","stage":"runtime-identity",` +
    '"ps_edition":"Desktop","ps_major":{0},"ps_minor":{1},"ps_build":{2},' +
    '"ps_revision":{3},"clr_major":{4},"clr_minor":{5},"clr_build":{6},' +
    '"clr_revision":{7},"framework_release":{8},"os_major":{9},"os_minor":{10},' +
    '"os_build":{11},"os_revision":{12}}}';
  assert.equal(countLiteral(script, identityFormat), 1,
    `closed ${probe} identity schema`);
  assert.equal(countLiteral(script, '[Console]::Out.WriteLine($identityLine)'), 1,
    `closed ${probe} identity emitter`);
  const allowedStages = probe === 'dispatch' ? TYPE_RESOLVE_DISPATCH_ALLOWED_STAGES
    : probe === 'documented' ? TYPE_RESOLVE_DOCUMENTED_ALLOWED_STAGES
      : probe === 'pinned' ? TYPE_RESOLVE_PINNED_ALLOWED_STAGES
        : TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES;
  const allowedLines = new Set(allowedStages.map((stage) =>
    typeResolveStageLine(probe, stage)));
  for (const line of script.split('\n').map((item) => item.trim()).filter((item) =>
    item.startsWith('[Console]::Out.WriteLine('))) {
    assert.equal(line === '[Console]::Out.WriteLine($identityLine)' || allowedLines.has(line), true,
      `closed ${probe} output surface`);
  }
  for (const stage of allowedStages) {
    assert.equal(countLiteral(script, typeResolveStageLine(probe, stage)), 1,
      `closed ${probe} stage ${stage}`);
  }
  assert.equal(countLiteral(script, '$findFirstStream.Invoke('), 0,
    `closed ${probe} first invocation`);
  assert.equal(countLiteral(script, '$findNextStream.Invoke('), 0,
    `closed ${probe} next invocation`);
  assert.equal(countLiteral(script, '$findClose.Invoke('), 0,
    `closed ${probe} close invocation`);
  if (requirePinnedSource) {
    assert.equal(probe, 'pinned', 'closed pinned probe');
    const pinned = pinnedWindowsTypeResolveDiagnostic();
    assert.equal(script, pinned.script,
      'closed pinned generated source');
    assert.equal(script.includes('RequestingAssembly'), false,
      'closed pinned requester observation');
    const classifier = pinnedTypeResolveStateDiagnosticBlock();
    const identityAxis = `${pinnedTypeResolveLateBakeIdentityAxisDiagnosticBlock()}\n`;
    assert.equal(countLiteral(pinned.transformed, identityAxis), 1,
      'closed pinned late-bake identity-axis diagnostic count');
    const normalizedPinned = pinned.transformed.replace(identityAxis, '');
    const lateBake = `${pinnedTypeResolveLateBakeDiagnosticBlock()}\n`;
    assert.equal(countLiteral(normalizedPinned, lateBake), 1,
      'closed pinned late-bake diagnostic count');
    const preLateBake = normalizedPinned.replace(lateBake, '');
    const placement = [
      '# DEEP_WORK_TYPE_RESOLVE_SCOPE_END',
      '',
      '# DEEP_WORK_TYPE_AUTHENTICATION_BEGIN',
      classifier,
      "if ($nativeTypeFailure) { throw 'stream native type creation failed' }",
    ].join('\n');
    assert.equal(countLiteral(preLateBake, placement), 1,
      'closed pinned state classifier placement');
    assert.equal(countLiteral(pinned.transformed, classifier), 1,
      'closed pinned state classifier count');
    for (const [stage, outputGuard] of TYPE_RESOLVE_PINNED_CALLBACK_OUTPUT_GUARDS) {
      assert.equal(countLiteral(pinned.transformed,
        pinnedTypeResolveGuardedMarker(stage, outputGuard)), 1,
      `closed pinned callback output guard ${stage}`);
    }
    assert.equal(countLiteral(pinned.transformed,
      'if ($typeResolveState.Requests -lt 2) {'), 1,
    'closed pinned pre-increment output guard count');
    assert.equal(countLiteral(pinned.transformed,
      'if ($typeResolveState.Requests -le 2) {'), 11,
    'closed pinned post-increment output guard count');
    const classifierSource = pinned.transformed.slice(
      pinned.transformed.indexOf('# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_BEGIN'),
      pinned.transformed.indexOf('# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END') +
        '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END'.length);
    assert.doesNotMatch(classifierSource,
      /\$typeResolveState\.(?:Requests|Failure|Type)\s*(?:=|\+\+|--)/u,
    'closed pinned classifier read-only');
    assert.doesNotMatch(classifierSource,
      /GetNestedType|DefineNestedType|CreateType|Invoke\(|RequestingAssembly/u,
    'closed pinned classifier observation-only');
    assert.equal(stripPinnedTypeResolveDiagnostic(pinned.transformed), pinned.original,
      'closed pinned independent source reconstruction');
  }
}

function typeResolveRecordShape(record, keys) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    Object.keys(record).length === keys.length &&
    Object.keys(record).every((key, index) => key === keys[index]);
}

function validNonNegativeIdentityInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function classifyTypeResolveRecord(line, record, probe, allowedStages) {
  if (JSON.stringify(record) !== line) return 'invalid';
  if (typeResolveRecordShape(record, TYPE_RESOLVE_IDENTITY_KEYS)) {
    if (record.version !== 1 || typeof record.probe !== 'string' ||
        typeof record.stage !== 'string' || record.ps_edition !== 'Desktop' ||
        record.ps_major !== 5 || record.ps_minor !== 1 ||
        !validNonNegativeIdentityInteger(record.ps_build) ||
        !validNonNegativeIdentityInteger(record.ps_revision) ||
        record.clr_major !== 4 || !validNonNegativeIdentityInteger(record.clr_minor) ||
        !validNonNegativeIdentityInteger(record.clr_build) ||
        !validNonNegativeIdentityInteger(record.clr_revision) ||
        !Number.isSafeInteger(record.framework_release) || record.framework_release < 533_320 ||
        !Number.isSafeInteger(record.os_major) || record.os_major < 10 ||
        !validNonNegativeIdentityInteger(record.os_minor) ||
        !validNonNegativeIdentityInteger(record.os_build) ||
        !validNonNegativeIdentityInteger(record.os_revision)) {
      return 'invalid';
    }
    return record.probe === probe && record.stage === 'runtime-identity' ? 'exact' : 'foreign';
  }
  if (typeResolveRecordShape(record, TYPE_RESOLVE_STAGE_KEYS)) {
    if (record.version !== 1 || typeof record.probe !== 'string' ||
        typeof record.stage !== 'string') return 'invalid';
    return record.probe === probe && allowedStages.has(record.stage) ? 'exact' : 'foreign';
  }
  return 'invalid';
}

function closedSpawnErrorCode(value) {
  if (value == null) return null;
  return value === 'ETIMEDOUT' || value === 'ENOBUFS' ? value : 'other';
}

function closedSpawnSignal(value) {
  if (value == null) return null;
  return value === 'SIGTERM' ? value : 'other';
}

function lifecycleBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  return value == null ? Buffer.alloc(0) : Buffer.from(String(value), 'utf8');
}

function nativeWindowsLifecycleEvidence(probe, result, elapsedMs, allowedStages) {
  const stdout = lifecycleBuffer(result?.stdout);
  const stderr = lifecycleBuffer(result?.stderr);
  const stdoutBytes = stdout.length;
  const stdoutTruncatedBytes = Math.max(0,
    stdoutBytes - TYPE_RESOLVE_DIAGNOSTIC_MAX_STDOUT_BYTES);
  const stdoutTruncated = stdoutTruncatedBytes !== 0;
  const prefix = stdout.subarray(0, TYPE_RESOLVE_DIAGNOSTIC_MAX_STDOUT_BYTES);
  let stdoutGrammarErrorCount = 0;
  if (stdout.some((byte) => byte > 0x7f)) stdoutGrammarErrorCount += 1;
  let bareCr = false;
  for (let index = 0; index < stdout.length; index += 1) {
    if (stdout[index] === 0x0d && stdout[index + 1] !== 0x0a) {
      bareCr = true;
      break;
    }
  }
  if (bareCr) stdoutGrammarErrorCount += 1;
  const normalized = prefix.toString('ascii').replace(/\r\n/gu, '\n');
  if (!stdoutTruncated && (!normalized.endsWith('\n') || normalized.endsWith('\n\n'))) {
    stdoutGrammarErrorCount += 1;
  }
  let body = normalized;
  if (body.endsWith('\n')) body = body.slice(0, -1);
  const lines = body.length === 0 ? [] : body.split('\n');
  const cutPartialLine = stdoutTruncated && prefix.length > 0 &&
    prefix[prefix.length - 1] !== 0x0a;
  if (lines.some((line) => line.length === 0)) stdoutGrammarErrorCount += 1;
  let invalidLineCount = 0;
  let foreignRecordCount = 0;
  let recordOverflowCount = 0;
  const records = [];
  const allowed = new Set(allowedStages);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (cutPartialLine && index === lines.length - 1) {
      invalidLineCount += 1;
      continue;
    }
    let record;
    try { record = JSON.parse(line); }
    catch {
      invalidLineCount += 1;
      continue;
    }
    const classification = classifyTypeResolveRecord(line, record, probe, allowed);
    if (classification === 'invalid') invalidLineCount += 1;
    else if (classification === 'foreign') foreignRecordCount += 1;
    else if (records.length < TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS) records.push(record);
    else recordOverflowCount += 1;
  }
  const nodeVersion = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
    .test(process.versions.node) ? process.versions.node : 'invalid';
  return {
    probe:['dispatch','documented','pinned','factory-discovery'].includes(probe)
      ? probe : 'invalid',
    nodeVersion,
    elapsedMs:Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
    spawnErrorCode:closedSpawnErrorCode(result?.error === undefined
      ? null : result?.error?.code ?? 'other'),
    status:Number.isInteger(result?.status) ? result.status : null,
    signal:closedSpawnSignal(result?.signal),
    stdoutBytes,
    stderrBytes:stderr.length,
    stdoutSha256:hash(stdout),
    stderrSha256:hash(stderr),
    stdoutTruncated,
    stdoutTruncatedBytes,
    stdoutGrammarErrorCount,
    invalidLineCount,
    foreignRecordCount,
    recordOverflowCount,
    totalLineCount:lines.length,
    records,
  };
}

function assertNativeWindowsLifecyclePreOracle(evidence, diagnostic = null) {
  const message = diagnostic || 'lifecycle pre-oracle';
  assert.equal(evidence.spawnErrorCode, null, message);
  assert.equal(evidence.status, 0, message);
  assert.equal(evidence.signal, null, message);
  assert.equal(evidence.stderrBytes, 0, message);
  assert.notEqual(evidence.nodeVersion, 'invalid', message);
  assert.equal(evidence.stdoutTruncated, false, message);
  assert.equal(evidence.stdoutTruncatedBytes, 0, message);
  assert.equal(evidence.stdoutGrammarErrorCount, 0, message);
  assert.equal(evidence.invalidLineCount, 0, message);
  assert.equal(evidence.foreignRecordCount, 0, message);
  assert.equal(evidence.recordOverflowCount, 0, message);
  assert.equal(evidence.totalLineCount, evidence.records.length,
    message);
}

function assertDispatchTypeResolveRecords(records) {
  assert.equal(records.length, TYPE_RESOLVE_DISPATCH_GREEN_STAGES.length + 1,
    'dispatch oracle length');
  assert.equal(records[0]?.probe, 'dispatch', 'dispatch oracle identity probe');
  assert.equal(records[0]?.stage, 'runtime-identity', 'dispatch oracle identity stage');
  assert.deepEqual(records.slice(1).map((record) => record.stage),
    TYPE_RESOLVE_DISPATCH_GREEN_STAGES, 'dispatch oracle stages');
}

function assertDocumentedTypeResolveRecords(records) {
  assert.equal(records[0]?.probe, 'documented', 'documented oracle identity probe');
  assert.equal(records[0]?.stage, 'runtime-identity', 'documented oracle identity stage');
  const stages = records.slice(1).map((record) => record.stage);
  assert.deepEqual(stages.slice(0,
    TYPE_RESOLVE_DOCUMENTED_PREFIX_BEFORE_ASSEMBLY_BRANCH.length),
  TYPE_RESOLVE_DOCUMENTED_PREFIX_BEFORE_ASSEMBLY_BRANCH,
  'documented oracle prefix before assembly branch');
  let index = TYPE_RESOLVE_DOCUMENTED_PREFIX_BEFORE_ASSEMBLY_BRANCH.length;
  assert.equal(TYPE_RESOLVE_DOCUMENTED_ASSEMBLY_BRANCH_STAGES.includes(stages[index]), true,
    'documented oracle assembly branch');
  index += 1;
  assert.deepEqual(stages.slice(index,
    index + TYPE_RESOLVE_DOCUMENTED_PREFIX_AFTER_ASSEMBLY_BRANCH.length),
  TYPE_RESOLVE_DOCUMENTED_PREFIX_AFTER_ASSEMBLY_BRANCH,
  'documented oracle prefix after assembly branch');
  index += TYPE_RESOLVE_DOCUMENTED_PREFIX_AFTER_ASSEMBLY_BRANCH.length;
  let requests = 0;
  while (stages[index] === 'resolver-entered') {
    requests += 1;
    assert.equal(requests <= 3, true, 'documented oracle request bound');
    assert.equal(stages[index], 'resolver-entered', 'documented oracle resolver entry');
    const expectedRequest = requests === 1 ? 'request-1'
      : requests === 2 ? 'request-2' : 'request-3plus';
    assert.equal(stages[index + 1], expectedRequest, 'documented oracle request class');
    assert.equal(['name-exact','name-other'].includes(stages[index + 2]), true,
      'documented oracle name class');
    assert.equal(stages[index + 3], 'nested-create-enter',
      'documented oracle nested entry');
    assert.equal(['nested-create-return','nested-already-created'].includes(stages[index + 4]),
      true, 'documented oracle nested result');
    assert.equal(stages[index + 5], 'return-assembly',
      'documented oracle assembly return');
    index += 6;
  }
  assert.equal(requests >= 1 && requests <= 3, true, 'documented oracle request count');
  assert.deepEqual(stages.slice(index), TYPE_RESOLVE_DOCUMENTED_OUTER_SUFFIX,
    'documented oracle outer suffix');
}

const TYPE_RESOLVE_PINNED_RECORD_PREFIX = [
  'runtime-identity','started','factory-candidates-ready','factory-index-enter',
  'factory-index-return','factory-branch-enter','factory-invoke-enter',
  'factory-invoke-return','assembly-ready','module-ready','native-builder-ready',
  'stream-builder-ready','stream-fields-ready','byref-ready','methods-defined',
  'callback-build-enter','callback-closure-ready','delegate-ready','handler-registered',
  'enclosing-create-enter',
];
const TYPE_RESOLVE_PINNED_FIRST_CALLBACK_GROUPS = {
  success:[
    'resolver-entered','resolver-request-incremented','resolver-name-exact',
    'resolver-request-1','resolver-nested-create-enter','resolver-nested-create-return',
    'resolver-result-authenticated','resolver-return-assembly',
  ],
  foreign:[
    'resolver-entered','resolver-request-incremented','resolver-name-foreign',
    'resolver-reject-name',
  ],
  result:[
    'resolver-entered','resolver-request-incremented','resolver-name-exact',
    'resolver-request-1','resolver-nested-create-enter','resolver-nested-create-return',
  ],
  catch:[
    'resolver-entered','resolver-request-incremented','resolver-name-exact',
    'resolver-request-1','resolver-nested-create-enter','resolver-catch',
  ],
};
const TYPE_RESOLVE_PINNED_SECOND_CALLBACK_GROUPS = {
  foreign:[
    'resolver-entered','resolver-request-incremented','resolver-name-foreign',
    'resolver-reject-name',
  ],
  duplicate:[
    'resolver-entered','resolver-request-incremented','resolver-name-exact',
    'resolver-reject-duplicate',
  ],
};
const TYPE_RESOLVE_PINNED_SUCCESS_SUFFIX = [
  'resolver-state-authenticated','nested-type-authenticated','methods-reflected',
  'methods-authenticated','completed',
];

function typeResolvePinnedGreenStages() {
  const stages = [
    'runtime-identity','started','factory-candidates-ready','factory-index-enter',
    'factory-index-return','factory-branch-enter','factory-invoke-enter',
    'factory-invoke-return','assembly-ready','module-ready','native-builder-ready',
    'stream-builder-ready','stream-fields-ready','byref-ready','methods-defined',
    'callback-build-enter','callback-closure-ready','delegate-ready','handler-registered',
    'enclosing-create-enter','resolver-entered','resolver-request-incremented',
    'resolver-name-exact','resolver-request-1','resolver-nested-create-enter',
    'resolver-nested-create-return','resolver-result-authenticated',
    'resolver-return-assembly','enclosing-create-return','handler-remove-enter',
    'handler-removed','scope-exited','state-native-create-succeeded',
    'state-requests-one','state-failure-null','state-type-present',
    'resolver-state-authenticated','nested-type-authenticated','methods-reflected',
    'methods-authenticated','completed',
  ];
  assert.equal(stages.length, 41, 'pinned GREEN exact maximum record count');
  return stages;
}

function pinnedCallbackGroupAt(stages, index, groups, terminators, label) {
  const matches = Object.entries(groups).filter(([, candidate]) =>
    candidate.every((stage, offset) => stages[index + offset] === stage) &&
    terminators.has(stages[index + candidate.length]));
  assert.equal(matches.length, 1, `pinned oracle ${label} callback group`);
  const [name, group] = matches[0];
  return {name, next:index + group.length};
}

function assertPinnedTypeResolveRecords(records) {
  assert.equal(records.length <= TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, true,
    'pinned oracle parser cap');
  assert.equal(records[0]?.probe, 'pinned', 'pinned oracle identity probe');
  assert.equal(records[0]?.stage, 'runtime-identity', 'pinned oracle identity stage');
  const stages = records.map((record) => record.stage);
  assert.deepEqual(stages.slice(0, TYPE_RESOLVE_PINNED_RECORD_PREFIX.length),
    TYPE_RESOLVE_PINNED_RECORD_PREFIX, 'pinned oracle fixed prefix');
  let index = TYPE_RESOLVE_PINNED_RECORD_PREFIX.length;
  const groups = [];
  if (stages[index] === 'resolver-entered') {
    const first = pinnedCallbackGroupAt(stages, index,
      TYPE_RESOLVE_PINNED_FIRST_CALLBACK_GROUPS,
      new Set(['resolver-entered','enclosing-create-return','enclosing-create-catch']),
      'first');
    groups.push(first.name);
    index = first.next;
    if (stages[index] === 'resolver-entered') {
      const second = pinnedCallbackGroupAt(stages, index,
        TYPE_RESOLVE_PINNED_SECOND_CALLBACK_GROUPS,
        new Set(['enclosing-create-return','enclosing-create-catch']), 'second');
      groups.push(second.name);
      index = second.next;
    }
  }
  assert.equal(['enclosing-create-return','enclosing-create-catch'].includes(stages[index]),
    true, 'pinned oracle enclosing result');
  const native = stages[index] === 'enclosing-create-return' ? 'succeeded' : 'failed';
  index += 1;
  assert.deepEqual(stages.slice(index, index + 3),
    ['handler-remove-enter','handler-removed','scope-exited'],
  'pinned oracle post-create scope suffix');
  index += 3;

  const nativeStages = {
    'state-native-create-succeeded':'succeeded',
    'state-native-create-failed':'failed',
  };
  const requestStages = {
    'state-requests-zero':'zero',
    'state-requests-one':'one',
    'state-requests-other':'other',
  };
  const failureStages = {
    'state-failure-null':'null',
    'state-failure-name-mismatch':'name-mismatch',
    'state-failure-duplicate':'duplicate',
    'state-failure-result-mismatch':'result-mismatch',
    'state-failure-catch':'catch',
    'state-failure-other':'other',
  };
  const typeStages = {
    'state-type-null':'null',
    'state-type-present':'present',
  };
  const stateNative = nativeStages[stages[index]];
  const request = requestStages[stages[index + 1]];
  const failure = failureStages[stages[index + 2]];
  const type = typeStages[stages[index + 3]];
  assert.notEqual(stateNative, undefined, 'pinned oracle native state category');
  assert.notEqual(request, undefined, 'pinned oracle request state category');
  assert.notEqual(failure, undefined, 'pinned oracle failure state category');
  assert.notEqual(type, undefined, 'pinned oracle type state category');
  assert.equal(stateNative, native, 'pinned oracle enclosing/state consistency');
  index += 4;

  const lateBakePhases = [
    ['identity','late-bake-identity-authenticated','late-bake-identity-exception',
      'late-bake-identity-mismatch'],
    ['fields','late-bake-fields-authenticated','late-bake-fields-exception',
      'late-bake-fields-mismatch'],
    ['methods','late-bake-methods-authenticated','late-bake-methods-exception',
      'late-bake-methods-mismatch'],
    ['interop','late-bake-interop-authenticated','late-bake-interop-exception',
      'late-bake-interop-mismatch'],
  ];
  assert.deepEqual(lateBakePhases, TYPE_RESOLVE_PINNED_LATE_BAKE_PHASES,
    'pinned oracle late-bake phase vocabulary');
  const lateBakeIdentityAxisStages = [
    'late-bake-identity-axis-canonical-present-exception',
    'late-bake-identity-axis-canonical-present-mismatch',
    'late-bake-identity-axis-canonical-reference-exception',
    'late-bake-identity-axis-canonical-reference-mismatch',
    'late-bake-identity-axis-full-name-exception',
    'late-bake-identity-axis-full-name-mismatch',
    'late-bake-identity-axis-declaring-type-exception',
    'late-bake-identity-axis-declaring-type-mismatch',
    'late-bake-identity-axis-assembly-exception',
    'late-bake-identity-axis-assembly-mismatch',
    'late-bake-identity-axis-module-exception',
    'late-bake-identity-axis-module-mismatch',
    'late-bake-identity-axis-value-type-exception',
    'late-bake-identity-axis-value-type-mismatch',
    'late-bake-identity-axis-nested-public-exception',
    'late-bake-identity-axis-nested-public-mismatch',
    'late-bake-identity-axis-sealed-exception',
    'late-bake-identity-axis-sealed-mismatch',
    'late-bake-identity-axis-sequential-layout-exception',
    'late-bake-identity-axis-sequential-layout-mismatch',
    'late-bake-identity-axis-unicode-class-exception',
    'late-bake-identity-axis-unicode-class-mismatch',
    'late-bake-identity-axis-before-field-init-exception',
    'late-bake-identity-axis-before-field-init-mismatch',
  ];
  assert.deepEqual(lateBakeIdentityAxisStages,
    TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES,
  'pinned oracle late-bake identity-axis vocabulary');
  const parseLateBakeSuffix = (start) => {
    assert.equal(TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS === 64, true,
      'pinned oracle late-bake fixed parser cap');
    let lateIndex = start;
    assert.deepEqual(stages.slice(lateIndex, lateIndex + 2),
      ['late-bake-applicable','late-bake-create-enter'],
    'pinned oracle late-bake prefix');
    lateIndex += 2;
    const terminal = (label) => {
      assert.equal(lateIndex + 1, stages.length,
        `pinned oracle late-bake ${label} terminal forbids post-terminal records`);
      assert.equal(records.length < 36, true,
        `pinned oracle late-bake ${label} failure path bound`);
      return {next:stages.length, completed:false};
    };
    if (stages[lateIndex] === 'late-bake-create-exception') {
      return terminal('create-exception');
    }
    assert.equal(stages[lateIndex], 'late-bake-create-return',
      'pinned oracle late-bake create return');
    lateIndex += 1;
    if (stages[lateIndex] === 'late-bake-result-null') {
      return terminal('result-null');
    }
    if (lateBakeIdentityAxisStages.includes(stages[lateIndex])) {
      assert.equal(lateIndex + 1, stages.length,
        'pinned oracle late-bake identity-axis terminal records forbid post-terminal records');
      assert.equal(records.length === 32, true,
        'pinned oracle late-bake identity-axis exact terminal records');
      return {next:stages.length, completed:false};
    }
    for (const [phase, authenticated, exception, mismatch] of lateBakePhases) {
      if (stages[lateIndex] === exception || stages[lateIndex] === mismatch) {
        return terminal(`${phase}-failure`);
      }
      assert.equal(stages[lateIndex], authenticated,
        `pinned oracle late-bake ${phase} authenticated`);
      lateIndex += 1;
    }
    assert.equal(stages[lateIndex], 'late-bake-completed',
      'pinned oracle late-bake completed');
    lateIndex += 1;
    assert.equal(records.length === 36 ||
      records.length === 36 + TYPE_RESOLVE_PINNED_SUCCESS_SUFFIX.length, true,
    'pinned oracle late-bake exact completed path');
    return {next:lateIndex, completed:true};
  };

  let successfulState = false;
  const lateBakeApplicable = groups.length === 0 && request === 'zero' && failure === 'null' && type === 'null';
  if (groups.length === 0) {
    assert.deepEqual({request, failure, type},
      {request:'zero', failure:'null', type:'null'},
    'pinned oracle zero-request tuple');
    if (index < stages.length) {
      assert.equal(native === 'succeeded' && lateBakeApplicable, true,
        'pinned oracle late-bake applicability');
      const lateBake = parseLateBakeSuffix(index);
      index = lateBake.next;
      successfulState = native === 'succeeded' && lateBake.completed &&
        index < stages.length;
    }
  } else if (groups.length === 1) {
    const outcomes = {
      success:{failure:'null', type:'present'},
      foreign:{failure:'name-mismatch', type:'null'},
      result:{failure:'result-mismatch', type:'null'},
      catch:{failure:'catch', type:'null'},
    };
    assert.equal(request, 'one', 'pinned oracle one-request category');
    assert.deepEqual({failure, type}, outcomes[groups[0]],
      'pinned oracle one-request tuple');
    successfulState = native === 'succeeded' && groups[0] === 'success';
  } else {
    assert.equal(groups.length, 2, 'pinned oracle visible callback group bound');
    assert.equal(request, 'other', 'pinned oracle other-request category');
    assert.equal(['name-mismatch','duplicate'].includes(failure), true,
      'pinned oracle other final failure');
    assert.equal(type, groups[0] === 'success' ? 'present' : 'null',
      'pinned oracle other first-group Type consistency');
  }
  const suffix = successfulState ? TYPE_RESOLVE_PINNED_SUCCESS_SUFFIX : [];
  assert.deepEqual(stages.slice(index), suffix, 'pinned oracle terminal suffix');
  return {native, request, failure, type, groups};
}

function assertFactoryDiscoveryTypeResolveRecords(records) {
  const message = 'factory discovery oracle';
  assert.equal(records[0]?.probe, 'factory-discovery', message);
  assert.equal(records[0]?.stage, 'runtime-identity', message);
  const stages = records.slice(1).map((record) => record.stage);
  const indexedBranchIndex = TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES
    .indexOf('indexed-null');
  const prefix = TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES.slice(0,
    indexedBranchIndex);
  assert.deepEqual(stages.slice(0, prefix.length), prefix, message);
  let index = prefix.length;
  assert.equal(stages[index], 'indexed-present', message);
  index += 1;
  assert.equal(stages[index], 'completed', message);
  assert.equal(stages.length, index + 1, message);
}

function runNativeWindowsLifecycleProbe({
  probe,
  root,
  script,
  allowedStages,
  assertRecords,
}) {
  assert.equal(['dispatch','documented','pinned','factory-discovery'].includes(probe), true,
    'lifecycle runner probe');
  assert.equal(typeof assertRecords, 'function', 'lifecycle runner oracle');
  const scriptPath = path.join(root, `${probe}-type-resolve.ps1`);
  const scriptBytes = Buffer.from(script, 'utf8');
  assert.equal(scriptBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false,
    'lifecycle runner bom');
  assert.equal(script.includes('\r'), false, 'lifecycle runner line endings');
  fs.writeFileSync(scriptPath, scriptBytes);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const temp = process.env.TEMP || process.env.TMP || os.tmpdir();
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell',
    'v1.0', 'powershell.exe');
  const startedAt = Date.now();
  const result = spawnSync(executable,
    ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',scriptPath], {
      cwd:root,
      env:{
        SystemRoot:systemRoot,
        WINDIR:systemRoot,
        TEMP:temp,
        TMP:temp,
        PATH:'',
        PSModulePath:'',
      },
      encoding:null,
      shell:false,
      windowsHide:true,
      timeout:WINDOWS_STREAM_INVENTORY_TIMEOUT_MS,
      maxBuffer:WINDOWS_STREAM_INVENTORY_MAX_OUTPUT_BYTES,
    });
  const elapsedMs = Date.now() - startedAt;
  const evidence = nativeWindowsLifecycleEvidence(probe, result, elapsedMs, allowedStages);
  const diagnostic = JSON.stringify(evidence);
  assertNativeWindowsLifecyclePreOracle(evidence, diagnostic);
  assert.equal(evidence.records[0]?.probe, probe, diagnostic);
  assert.equal(evidence.records[0]?.stage, 'runtime-identity', diagnostic);
  try { assertRecords(evidence.records); }
  catch { assert.fail(diagnostic); }
  const identity = evidence.records[0];
  const runtimeIdentity = Object.fromEntries(TYPE_RESOLVE_IDENTITY_KEYS.slice(3)
    .map((key) => [key, identity[key]]));
  return {
    elapsedMs,
    scriptSha256:hash(scriptBytes),
    nodeVersion:evidence.nodeVersion,
    runtimeIdentity,
  };
}

function nativeWrapperFailureEvidence(error) {
  const stages = error?.stages && typeof error.stages === 'object' ? {
    started:error.stages.started === true,
    'tool-result':error.stages['tool-result'] === true,
    termination:boundedCode(error.stages.termination),
  } : null;
  return {
    code:boundedCode(error?.code),
    status:Number.isInteger(error?.status) ? error.status : null,
    signal:boundedCode(error?.signal),
    innerError:{code:boundedCode(error?.innerError?.code)},
    envelopeError:{code:boundedCode(error?.envelopeError?.code)},
    stages,
  };
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessesToExit(pids, timeoutMs = 3_000) {
  const identities = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const deadline = Date.now() + timeoutMs;
  while (identities.some(isProcessAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return identities.filter(isProcessAlive);
}

async function independentlyTerminateFailedTestTree(context) {
  if (!context || !Number.isSafeInteger(context.pid) || context.pid <= 0) return;
  const closed = context.child && context.child.exitCode === null && context.child.signalCode === null
    ? new Promise((resolve) => context.child.once('close', resolve)) : Promise.resolve();
  if (context.platform === 'win32') {
    await terminateWindowsTree(context.pid, {
      systemRoot:process.env.SystemRoot || process.env.SYSTEMROOT,
      knownPids:context.knownPids || [],
    });
  } else {
    try { process.kill(-context.pid, 'SIGKILL'); }
    catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  let timeout;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(
        `process handle ${context.pid} did not close`)), 3_000);
    })]);
  } finally { clearTimeout(timeout); }
}

async function waitForJsonMarker(file, {timeoutMs = 3_000, pollMs = 10} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastCause;
  while (true) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (cause) {
      if (cause?.code !== 'ENOENT' && !(cause instanceof SyntaxError)) {
        const error = new Error(`failed reading JSON marker ${file}: ${cause.message}`, {cause});
        error.code = 'json-marker-read';
        throw error;
      }
      lastCause = cause;
    }
    if (Date.now() >= deadline) {
      const error = new Error(
        `timed out waiting for parseable JSON marker ${file}: ${lastCause?.message || 'unavailable'}`,
        {cause:lastCause});
      error.code = 'json-marker-timeout';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve,
      Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

test('JSON marker waiter waits for partial bytes to become parseable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-json-marker-partial-'));
  const marker = path.join(root, 'marker.json');
  fs.writeFileSync(marker, '{"ready":');
  const completion = new Promise((resolve, reject) => setTimeout(() => {
    try {
      fs.appendFileSync(marker, 'true}');
      resolve();
    } catch (error) { reject(error); }
  }, 30));
  try {
    assert.deepEqual(await waitForJsonMarker(marker, {timeoutMs:500, pollMs:5}), {ready:true});
    await completion;
  } finally {
    await completion.catch(() => {});
    remove(root);
  }
});

test('JSON marker waiter fails loud with path and parse cause after its bound', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-json-marker-invalid-'));
  const marker = path.join(root, 'marker.json');
  try {
    fs.writeFileSync(marker, '{"ready":');
    const error = await waitForJsonMarker(marker, {timeoutMs:30, pollMs:5})
      .then(() => null, (cause) => cause);
    assert.equal(error?.code, 'json-marker-timeout');
    assert.equal(error?.message.includes(marker), true);
    assert.equal(error?.cause instanceof SyntaxError, true);
  } finally { remove(root); }
});

function windowsFixtureFs(base) {
  function map(value) {
    const normalized = path.win32.normalize(value);
    const parsed = path.win32.parse(normalized);
    if (parsed.root.toLowerCase() !== 'c:\\') throw Object.assign(new Error('foreign drive'), {code:'ENOENT'});
    const segments = normalized.slice(parsed.root.length).split('\\').filter(Boolean);
    return path.join(base, 'c-drive', ...segments);
  }
  function canonical(value) {
    fs.realpathSync(map(value));
    const normalized = path.win32.normalize(value);
    return `C:${normalized.slice(2)}`;
  }
  return {
    lstatSync:value => fs.lstatSync(map(value)),
    realpathSync:canonical,
    readFileSync:(value, options) => fs.readFileSync(map(value), options),
    openSync:(value, flags, mode) => fs.openSync(map(value), flags, mode),
    readSync:(...args) => fs.readSync(...args),
    closeSync:fd => fs.closeSync(fd),
    accessSync:(value, mode) => fs.accessSync(map(value), mode),
  };
}

test('public numeric limits and threat model exactly pin the approved contract', () => {
  assert.deepEqual([
    WORKTREE_MANIFEST_MAX_ENTRIES,
    WORKTREE_MANIFEST_MAX_RELATIVE_PATH_BYTES,
    WORKTREE_MANIFEST_MAX_PATH_TOTAL_BYTES,
    WORKTREE_MANIFEST_MAX_FILE_BYTES,
    WORKTREE_MANIFEST_MAX_TOTAL_BYTES,
  ], [100_000, 32_768, 67_108_864, 1_073_741_824, 8_589_934_592]);
  assert.deepEqual([
    INSTALL_ROOT_MAX_ROOTS, INSTALL_ROOT_MAX_DEPTH, INSTALL_ROOT_MAX_ENTRIES_PER_ROOT,
    INSTALL_ROOT_MAX_FILE_BYTES, INSTALL_ROOT_MAX_TOTAL_BYTES_PER_ROOT,
  ], [16, 3, 4096, 1_048_576, 16_777_216]);
  assert.deepEqual([
    CLAIM_TICKET_ONLY_TTL_MS, CLAIM_TICKET_SCAN_MAX_ENTRIES, CLAIM_TICKET_MAX_FILE_BYTES,
    CLAIM_TICKET_SCAN_MAX_TOTAL_BYTES, CLAIM_PRIVATE_SCAN_MAX_ENTRIES,
    CLAIM_TICKET_REPORT_MAX_ENTRIES,
  ], [30_000, 1024, 4096, 1_048_576, 3, 32]);
  assert.deepEqual([WINDOWS_STREAM_INVENTORY_TIMEOUT_MS,
    WINDOWS_STREAM_INVENTORY_MAX_OUTPUT_BYTES], [20_000, 67_108_864]);
  assert.equal(PATH_THREAT_MODEL.concurrentReplacementAfterFinalValidation, 'unsupported');
  assert.equal(PATH_THREAT_MODEL.protected.includes('pre-existing-link-or-reparse'), true);
  assert.equal(Object.isFrozen(PATH_THREAT_MODEL), true);
});

test('sanitize path handles contaminated input while preserving roots', () => {
  assert.equal(sanitizePathInput('/tmp/repo \r\n'), '/tmp/repo');
  assert.equal(sanitizePathInput('/'), '/');
  assert.equal(sanitizePathInput('C:\\'), 'C:\\');
  assert.throws(() => sanitizePathInput('a\0b'), /path-input-control/);
  assert.throws(() => sanitizePathInput(4), /path-input-type/);
});

test('Windows drive and UNC lexical containment reject prefix siblings', () => {
  assert.equal(isPathInside('C:\\repo', 'C:\\repo\\src\\한 글.js', 'win32'), true);
  assert.equal(isPathInside('C:\\repo', 'C:\\repo-evil\\x.js', 'win32'), false);
  assert.equal(isPathInside('\\\\server\\share\\repo', '\\\\server\\share\\repo\\a.js', 'win32'), true);
  assert.equal(normalizeForCompare('C:\\Repo\\', 'win32'), 'c:\\repo');
});

test('portable-path-v1 accepts NFC Unicode and rejects every forbidden segment family', () => {
  assert.deepEqual(canonicalizePortableProjectPathV1('src/한 글.js'), {
    path:'src/한 글.js', windowsKey:'src/한 글.js',
  });
  const invalid = [
    '', '/abs', 'a\\b', 'a//b', './a', 'a/../b', 'a.', 'a ', 'a:b', 'a<b',
    'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'CON', 'con.txt', 'PRN.log', 'AUX', 'NUL',
    'COM1.js', 'COM9', 'LPT1', 'LPT9.log', 'CONIN$', 'CONOUT$.txt',
    'COM¹', 'COM².txt', 'COM³', 'LPT¹', 'LPT².md', 'LPT³', 'e\u0301.txt',
  ];
  for (let code = 0; code <= 0x1f; code++) invalid.push(`a${String.fromCharCode(code)}b`);
  invalid.push(`a${String.fromCharCode(0x7f)}b`);
  for (const value of invalid) assert.throws(() => canonicalizePortableProjectPathV1(value),
    /portable-path-v1/, JSON.stringify(value));
  assert.equal(canonicalizePortableProjectPathV1('Src/A.js').windowsKey, 'src/a.js');
  assert.throws(() => canonicalizePortableProjectPathV1('CON .txt'), /portable-path-v1-device/);
});

test('resolveProjectRoot finds .git without prefix confusion', () => {
  const root = makeRepo();
  try {
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, {recursive:true});
    assert.equal(resolveProjectRoot(nested), fs.realpathSync(root));
    assert.throws(() => resolveProjectRoot(os.tmpdir()), /project-root-not-found/);
  } finally { remove(root); }
});

test('project-state capabilities are frozen branded physically-contained objects', () => {
  const root = makeRepo();
  try {
    const {state} = caps(root);
    assert.deepEqual([state.kind, state.role, state.allowMissingLeaf],
      ['project-state', 'state', true]);
    assert.equal(Object.isFrozen(state), true);
    assert.equal(revalidatePathCapability(state, 'write').path, state.path);
    assert.throws(() => revalidatePathCapability({...state}, 'write'), /path-capability/);
    assert.throws(() => issueProjectStateCapability(root, path.join(root, '..', 'evil'),
      {role:'state', allowMissingLeaf:true}), /path-capability-outside/);
    assert.throws(() => issueProjectStateCapability(root, path.join(root, '.claude', 'x'),
      {role:'owned-temp', allowMissingLeaf:true}), /owned-temp-derived-only/);
    assert.equal(PROJECT_STATE_ROLES.has('state'), true);
  } finally { remove(root); }
});

test('capability issuance and revalidation reject symlink component replacement', () => {
  const root = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-outside-'));
  try {
    const dir = path.join(root, '.claude', 'safe');
    fs.mkdirSync(dir);
    const cap = issueProjectStateCapability(root, path.join(dir, 'state.json'),
      {role:'state', allowMissingLeaf:true});
    fs.rmSync(dir, {recursive:true});
    fs.symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => revalidatePathCapability(cap, 'write'), /path-capability-(link|identity)/);
  } finally { remove(root); remove(outside); }
});

test('owned temp is operation/purpose bound, write-once, adopt-exact, consume, and compare-remove', () => {
  const root = makeRepo();
  try {
    const {work} = caps(root);
    const operationId = `op-${'a'.repeat(32)}`;
    const cap = issueOwnedTempCapability({sessionCapability:work, operationId,
      purpose:'receipt-payload', allowMissingLeaf:true});
    assert.equal(cap.path, path.join(work.path, '.tmp', operationId, 'receipt-payload.tmp'));
    assert.equal(cap.state, 'reserved');
    atomicWriteFile(cap, Buffer.from('payload'));
    assert.equal(cap.state, 'written');
    assert.equal(atomicWriteFile(cap, Buffer.from('payload')).adopted, true);
    assert.throws(() => atomicWriteFile(cap, Buffer.from('other')), /owned-temp-content-conflict/);
    const digest = cap.contentDigest;
    consumeOwnedTemp(cap, {operationId:`op-${'c'.repeat(32)}`,
      purpose:'receipt-payload', expectedDigest:digest});
    assert.equal(cap.state, 'consumed');
    assert.equal(compareRemoveOwnedTemp(cap, digest), true);
    assert.equal(cap.state, 'removed');
    assert.equal(OWNED_TEMP_PURPOSES.has('receipt-payload'), true);
    assert.throws(() => issueOwnedTempCapability({sessionCapability:work, operationId,
      purpose:'foreign'}), /temp-purpose/);
  } finally { remove(root); }
});

test('owned temp rejects a pre-existing byte-identical target without same-operation owner proof', () => {
  const root = makeRepo();
  try {
    const {work} = caps(root);
    const operationId = `op-${'f'.repeat(32)}`;
    const target = path.join(work.path, '.tmp', operationId, 'notes.tmp');
    fs.mkdirSync(path.dirname(target), {recursive:true});
    fs.writeFileSync(target, 'same');
    const cap = issueOwnedTempCapability({sessionCapability:work, operationId, purpose:'notes'});
    assert.throws(() => atomicWriteFile(cap, 'same'), /owned-temp-foreign/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'same');
  } finally { remove(root); }
});

test('a newly issued same-operation owned temp adopts only its matching owner and digest', () => {
  const root = makeRepo();
  try {
    const {work} = caps(root);
    const input = {sessionCapability:work, operationId:`op-${'1'.repeat(32)}`, purpose:'notes'};
    const first = issueOwnedTempCapability(input);
    atomicWriteFile(first, 'same');
    const retry = issueOwnedTempCapability(input);
    assert.deepEqual(atomicWriteFile(retry, 'same'), {
      written:false, adopted:true, sha256:first.contentDigest,
    });
  } finally { remove(root); }
});

test('finalized receipt result is producer-derived and consumed once by envelope-publish', () => {
  const root = makeRepo();
  try {
    const {work} = caps(root);
    const operationId = `op-${'b'.repeat(32)}`;
    const payload = Buffer.from('{"ok":true}\n');
    const payloadPath = path.join(work.path, '.operation-results', operationId,
      'finalized-receipt-payload.json');
    fs.mkdirSync(path.dirname(payloadPath), {recursive:true});
    fs.writeFileSync(payloadPath, payload);
    const producerOperationReceipt = {
      version:1, kind:'implement-slice-complete', operationId,
      sessionId:'s-a1b2c3d4', slice:'SLICE-001', stage:'payload-published',
      sourceTempDigest:'1'.repeat(64), finalizedBytesDigest:
        require('node:crypto').createHash('sha256').update(payload).digest('hex'),
    };
    const cap = issueFinalizedReceiptPayloadCapability({sessionCapability:work,
      producerOperationReceipt, slice:'SLICE-001'});
    assert.equal(cap.role, 'finalized-receipt-payload');
    assert.equal(cap.state, 'published');
    assert.match(cap.path, /\.operation-results/);
    consumeFinalizedReceiptPayload(cap, {kind:'envelope-publish', operationId:`op-${'c'.repeat(32)}`});
    assert.equal(cap.state, 'enveloped');
    assert.doesNotThrow(() => consumeFinalizedReceiptPayload(cap,
      {kind:'envelope-publish', operationId:`op-${'c'.repeat(32)}`}));
    assert.throws(() => consumeFinalizedReceiptPayload(cap,
      {kind:'envelope-publish', operationId:`op-${'d'.repeat(32)}`}), /already-consumed/);
    assert.throws(() => issueFinalizedReceiptPayloadCapability({sessionCapability:work,
      producerOperationReceipt:{...producerOperationReceipt, kind:'slice-complete'}, slice:'SLICE-001'}),
    /producer-kind/);
    const foreignOperation = `op-${'9'.repeat(32)}`;
    assert.throws(() => issueFinalizedReceiptPayloadCapability({sessionCapability:work,
      producerOperationReceipt:{...producerOperationReceipt, operationId:foreignOperation},
      slice:'SLICE-001'}), /finalized-receipt-payload/);
  } finally { remove(root); }
});

test('envelope and handoff outputs have exact route-derived paths', () => {
  const root = makeRepo();
  try {
    const {project, work} = caps(root);
    assert.equal(issueSessionEnvelopeOutputCapability({sessionCapability:work}).path,
      path.join(work.path, 'session-receipt.json'));
    assert.equal(issueSliceEnvelopeOutputCapability({sessionCapability:work, slice:'SLICE-007'}).path,
      path.join(work.path, 'receipts', 'SLICE-007.json'));
    const handoff = issueProjectHandoffOutputCapability({projectCapability:project,
      sessionId:'s-a1b2c3d4', operationId:`op-${'e'.repeat(32)}`});
    assert.equal(handoff.path, path.join(root, '.deep-work', 'handoffs',
      `s-a1b2c3d4-op-${'e'.repeat(32)}.json`));
    assert.throws(() => issueProjectStateCapability(root,
      path.join(root, '.deep-work', 'handoffs', 'caller.json'),
      {role:'project-handoff-output', allowMissingLeaf:true}), /route-derived-only/);
    assert.throws(() => issueProjectStateCapability(root,
      path.join(root, '.claude', 'caller-receipt.json'),
      {role:'session-envelope-output', allowMissingLeaf:true}), /route-derived-only/);
  } finally { remove(root); }
});

test('managed initial and fork worktree capabilities enforce disjoint sibling shapes', () => {
  const root = makeRepo();
  try {
    const parent = path.dirname(root);
    const base = path.basename(root);
    const initial = issueInitialWorktreeCapability({projectRoot:root,
      candidate:path.join(parent, `${base}-wt-a1b2c3d4`), sessionId:'s-a1b2c3d4',
      baseRef:'HEAD', branch:'deep-work-a1b2c3d4', allowMissingLeaf:true});
    assert.equal(initial.purpose, 'initial-session');
    assert.match(initial.baseOid, /^[0-9a-f]{40,64}$/);
    const fork = issueForkWorktreeCapability({projectRoot:root,
      candidate:path.join(parent, `${base}-wt-fork-a1b2c3d4`), sessionId:'s-a1b2c3d4',
      parentBranch:'main', branch:'main-fork-a1b2c3d4', allowMissingLeaf:true});
    assert.equal(fork.purpose, 'fork-session');
    for (const candidate of [path.join(parent, `${base}-evil`),
      path.join(path.dirname(parent), `${base}-wt-fork-a1b2c3d4`)]) {
      assert.throws(() => issueForkWorktreeCapability({projectRoot:root, candidate,
        sessionId:'s-a1b2c3d4', parentBranch:'main', branch:'main-fork-a1b2c3d4',
        allowMissingLeaf:true}), /managed-worktree/);
    }
  } finally { remove(root); }
});

test('existing managed worktree revalidation binds the registered path and exact branch', () => {
  const root = makeRepo();
  const canonicalRoot = fs.realpathSync(root);
  const candidate = path.join(path.dirname(canonicalRoot), `${path.basename(canonicalRoot)}-wt-a1b2c3d4`);
  try {
    execFileSync('git', ['worktree','add','-q','-b','deep-work-a1b2c3d4',candidate,'HEAD'], {cwd:root});
    const cap = issueInitialWorktreeCapability({projectRoot:root, candidate,
      sessionId:'s-a1b2c3d4', baseRef:'HEAD', branch:'deep-work-a1b2c3d4'});
    assert.doesNotThrow(() => revalidatePathCapability(cap, 'git-worktree-remove'));
    execFileSync('git', ['switch','-q','-c','foreign-branch'], {cwd:candidate});
    assert.throws(() => revalidatePathCapability(cap, 'git-worktree-remove'),
      /managed-worktree-registration/);
  } finally {
    try { execFileSync('git', ['worktree','remove','--force',candidate], {cwd:root}); } catch {}
    remove(root);
  }
});

test('managed worktree registration uses physical identity across short aliases before exact branch', () => {
  const root = makeRepo('dw-worktree-physical-');
  const canonicalRoot = fs.realpathSync(root);
  const parent = path.dirname(canonicalRoot);
  const candidate = path.join(parent,
    `${path.basename(canonicalRoot)}-wt-fork-a1b2c3d4`);
  const foreign = path.join(parent, `${path.basename(canonicalRoot)}-foreign`);
  const shortAlias = path.join(parent, 'RUNNER~1');
  const lexicalSpoof = candidate.toUpperCase();
  fs.mkdirSync(candidate);
  fs.mkdirSync(foreign);
  const fsImpl = {
    lstatSync(value) {
      if (value === shortAlias) return fs.lstatSync(candidate);
      if (value === lexicalSpoof) return fs.lstatSync(foreign);
      return fs.lstatSync(value);
    },
    realpathSync(value) {
      if (value === shortAlias || value === lexicalSpoof) return value;
      return fs.realpathSync(value);
    },
  };
  const runtime = createPlatformRuntimeForTest({platform:'win32', fsImpl});
  const cap = runtime.issueForkWorktreeCapability({projectRoot:root, candidate,
    sessionId:'s-a1b2c3d4', parentBranch:'main', branch:'main-fork-a1b2c3d4'});
  const childProcessModule = require('node:child_process');
  const originalExecFileSync = childProcessModule.execFileSync;
  let rowPath = shortAlias;
  let rowBranch = 'refs/heads/main-fork-a1b2c3d4';
  childProcessModule.execFileSync = function(executable, args, options) {
    if (args?.join('\0') === ['worktree','list','--porcelain','-z'].join('\0')) {
      return `worktree ${rowPath}\0HEAD ${'a'.repeat(40)}\0branch ${rowBranch}\0\0`;
    }
    return originalExecFileSync.call(this, executable, args, options);
  };
  try {
    assert.doesNotThrow(() => revalidatePathCapability(cap, 'git-worktree-remove'));
    rowPath = lexicalSpoof;
    assert.throws(() => revalidatePathCapability(cap, 'git-worktree-remove'),
      /managed-worktree-registration/);
    rowPath = shortAlias;
    rowBranch = 'refs/heads/foreign';
    assert.throws(() => revalidatePathCapability(cap, 'git-worktree-remove'),
      /managed-worktree-registration/);
  } finally {
    childProcessModule.execFileSync = originalExecFileSync;
    remove(candidate);
    remove(foreign);
    remove(root);
  }
});

test('worktree manifest includes ignored files and records only exclusion roots', () => {
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, '.gitignore'), '.env.local\ndocs/ignored.md\n');
    fs.writeFileSync(path.join(root, '.env.local'), 'secret');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'ignored.md'), 'plan');
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), {recursive:true});
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'cache.bin'), 'cache');
    const {project, git, state} = caps(root);
    const manifest = captureWorktreeManifest({projectCapability:project, gitCapability:git,
      runtimeExclusions:[state]});
    assert.equal(manifest.entries.some((e) => e.path === '.env.local'), true);
    assert.equal(manifest.entries.some((e) => e.path === 'docs/ignored.md'), true);
    assert.equal(manifest.entries.some((e) => e.path === 'node_modules' && e.excluded), true);
    assert.equal(manifest.entries.some((e) => e.path === 'node_modules/pkg/cache.bin'), false);
    assert.equal(manifest.entries.some((e) => e.path === '.claude/state.json' && e.excluded), true);
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
    assert.match(manifest.head, /^[0-9a-f]{40,64}$/);
    assert.match(manifest.index, /^[0-9a-f]{64}$/);
  } finally { remove(root); }
});

test('worktree manifest accepts the authenticated Git shim in a closed release environment', {
  skip:process.platform === 'win32' ? 'POSIX release environment only' : false,
}, () => {
  const root = makeRepo('dw-release-git-shim-');
  const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-release-git-env-'));
  try {
    const gitTarget = process.env.PATH.split(path.delimiter)
      .map((directory) => path.join(directory, 'git'))
      .find((candidate) => {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return fs.lstatSync(fs.realpathSync(candidate)).isFile();
        } catch { return false; }
      });
    assert.ok(gitTarget, 'physical Git executable is required');
    const bin = path.join(releaseRoot, 'bin');
    const home = path.join(releaseRoot, 'home');
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    const shim = path.join(bin, 'git');
    fs.symlinkSync(fs.realpathSync(gitTarget), shim, 'file');
    const platformPath = path.join(__dirname, 'platform.js');
    const script = [
      `'use strict';`,
      `const path=require('node:path');`,
      `const platform=require(${JSON.stringify(platformPath)});`,
      `const root=process.argv[1];`,
      `const project=platform.issueProjectStateCapability(root,root,{role:'project-root'});`,
      `const git=platform.issueProjectStateCapability(root,path.join(root,'.git'),{role:'git-root'});`,
      `const manifest=platform.captureWorktreeManifest({projectCapability:project,`,
      `  gitCapability:git,runtimeExclusions:[]});`,
      `process.stdout.write(manifest.sha256);`,
    ].join('\n');
    const run = () => spawnSync(process.execPath, ['-e', script, root], {
      cwd:root, env:{LANG:'C', LC_ALL:'C', TZ:'UTC',
        HOME:fs.realpathSync(home), PATH:fs.realpathSync(bin)},
      encoding:'utf8', shell:false, windowsHide:true});
    const result = run();
    assert.deepEqual({status:result.status, signal:result.signal, stderr:result.stderr},
      {status:0, signal:null, stderr:''});
    assert.match(result.stdout, /^[0-9a-f]{64}$/);
    fs.rmSync(shim);
    fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', {mode:0o755});
    const substituted = run();
    assert.equal(substituted.status, 1);
    assert.match(substituted.stderr, /worktree-manifest-git-unavailable/);
  } finally {
    remove(releaseRoot);
    remove(root);
  }
});

test('manifest rejects Windows-key collision and invalid physical path rather than omitting it', () => {
  if (process.platform === 'win32' || process.platform === 'darwin') return test.skip('case-only paths cannot coexist');
  const root = makeRepo();
  try {
    fs.mkdirSync(path.join(root, 'Src'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'Src', 'A.js'), 'A');
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a');
    const {project, git} = caps(root);
    assert.throws(() => captureWorktreeManifest({projectCapability:project, gitCapability:git,
      runtimeExclusions:[]}), /worktree-manifest-case-collision/);
  } finally { remove(root); }
});

test('manifest test seam fails closed on limits and unstable traversal', () => {
  const root = makeRepo();
  try {
    const {project, git} = caps(root);
    const runtime = createPlatformRuntimeForTest({manifestWalkerImpl:() => ({
      entries:Array.from({length:WORKTREE_MANIFEST_MAX_ENTRIES + 1}, (_, i) => ({path:`f${i}`})),
    })});
    assert.throws(() => runtime.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), /worktree-manifest-entry-limit/);
  } finally { remove(root); }
});

test('manifest test walker cannot bypass path and file budgets', () => {
  const root = makeRepo();
  try {
    const {project, git} = caps(root);
    const longPath = createPlatformRuntimeForTest({manifestWalkerImpl:() => ({
      entries:[{path:'a'.repeat(WORKTREE_MANIFEST_MAX_RELATIVE_PATH_BYTES + 1), type:'file',
        size:0, sha256:'0'.repeat(64)}],
    })});
    assert.throws(() => longPath.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), /worktree-manifest-path-limit/);
    const tooLarge = createPlatformRuntimeForTest({manifestWalkerImpl:() => ({
      entries:[{path:'large.bin', type:'file', size:WORKTREE_MANIFEST_MAX_FILE_BYTES + 1,
        sha256:'0'.repeat(64)}],
    })});
    assert.throws(() => tooLarge.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), /worktree-manifest-file-size-limit/);
  } finally { remove(root); }
});

test('physical manifest rejects a reserved Windows device name even on POSIX', () => {
  if (process.platform === 'win32') return test.skip('Windows cannot create reserved device names');
  const root = makeRepo();
  try {
    fs.writeFileSync(path.join(root, 'CON.txt'), 'forbidden');
    const {project, git} = caps(root);
    assert.throws(() => captureWorktreeManifest({projectCapability:project, gitCapability:git,
      runtimeExclusions:[]}), /portable-path-v1-device/);
  } finally { remove(root); }
});

test('trusted install root is read-only, bounded, explicit, and rejects links', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-home-'));
  try {
    const install = path.join(home, '.codex', 'plugins', 'cache', 'deep-work');
    fs.mkdirSync(install, {recursive:true});
    fs.writeFileSync(path.join(install, 'package.json'), '{}');
    const cap = issueTrustedInstallRootCapability({home, candidate:install,
      explicitRoots:[install]});
    const scan = scanTrustedInstallRoot(cap);
    assert.equal(scan.entries.length, 1);
    assert.throws(() => issueTrustedInstallRootCapability({home,
      candidate:path.join(home, 'other'), explicitRoots:[install]}), /install-root-not-allowed/);
  } finally { remove(home); }
});

test('trusted install limits accept exact file/total edges and reject one byte or depth over', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-install-budget-'));
  try {
    const install = path.join(home, '.codex', 'plugins', 'cache', 'deep-work');
    fs.mkdirSync(install, {recursive:true});
    const cap = issueTrustedInstallRootCapability({home, candidate:install, explicitRoots:[install]});
    const oneMiB = Buffer.alloc(INSTALL_ROOT_MAX_FILE_BYTES, 0x61);
    for (let index = 0; index < 16; index++) {
      fs.writeFileSync(path.join(install, `f-${String(index).padStart(2, '0')}.bin`), oneMiB);
    }
    assert.equal(scanTrustedInstallRoot(cap).totalBytes, INSTALL_ROOT_MAX_TOTAL_BYTES_PER_ROOT);
    fs.writeFileSync(path.join(install, 'one-over-total.bin'), 'x');
    assert.throws(() => scanTrustedInstallRoot(cap), /install-root-byte-limit/);
    fs.rmSync(path.join(install, 'one-over-total.bin'));
    fs.rmSync(path.join(install, 'f-00.bin'));
    fs.writeFileSync(path.join(install, 'one-over-file.bin'),
      Buffer.alloc(INSTALL_ROOT_MAX_FILE_BYTES + 1));
    assert.throws(() => scanTrustedInstallRoot(cap), /install-root-file-size-limit/);
    fs.rmSync(path.join(install, 'one-over-file.bin'));
    fs.mkdirSync(path.join(install, 'a', 'b', 'c', 'd'), {recursive:true});
    assert.throws(() => scanTrustedInstallRoot(cap), /install-root-depth-limit/);
    assert.throws(() => issueTrustedInstallRootCapability({home, candidate:install,
      explicitRoots:Array.from({length:INSTALL_ROOT_MAX_ROOTS + 1}, (_, i) =>
        path.join(home, `root-${i}`))}), /install-root-count-limit/);
  } finally { remove(home); }
});

test('node toolchain resolves only authenticated declared JavaScript bins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-toolchain-'));
  try {
    const bin = path.join(root, 'bin');
    const nodeExecutable = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.mkdirSync(path.join(bin, 'node_modules', 'npm', 'bin'), {recursive:true});
    fs.mkdirSync(path.join(bin, 'node_modules', '@openai', 'codex', 'bin'), {recursive:true});
    fs.writeFileSync(nodeExecutable, 'fixture');
    fs.chmodSync(nodeExecutable, 0o755);
    fs.writeFileSync(path.join(bin, 'node_modules', 'npm', 'package.json'), JSON.stringify({
      name:'npm', bin:{npm:'bin/npm-cli.js'},
    }));
    fs.writeFileSync(path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    fs.writeFileSync(path.join(bin, 'node_modules', '@openai', 'codex', 'package.json'),
      JSON.stringify({name:'@openai/codex', bin:{codex:'bin/codex.js'}}));
    fs.writeFileSync(path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
    const cap = await createPlatformRuntimeForTest()
      .issueNodeToolchainCapability({nodeExecutable, home:root, environment:{}});
    const npm = resolveNodePackageBin(cap, {package:'npm', bin:'npm', args:['audit','--json']});
    assert.deepEqual(npm, {executable:fs.realpathSync(nodeExecutable),
      argv:[fs.realpathSync(path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
        'audit','--json']});
    assert.throws(() => resolveNodePackageBin(cap,
      {package:'@google/gemini-cli', bin:'gemini', args:[]}), /node-toolchain-package-unavailable/);
    assert.throws(() => resolveNodePackageBin(cap,
      {package:'../../foreign', bin:'x', args:[]}), /node-toolchain-package-unavailable/);
  } finally { remove(root); }
});

test('static nvm, Homebrew, setup-node, and Windows MSI fixtures resolve declared bins', async () => {
  const base = path.join(fixtureRoot, 'node-toolchain');
  const nvmNode = path.join(base, 'unix-nvm', 'home', 'test', '.nvm', 'versions', 'node',
    'v22.14.0', 'bin', 'node');
  const nvm = await createPlatformRuntimeForTest({platform:'linux'})
    .issueNodeToolchainCapability({nodeExecutable:nvmNode,
      home:path.join(base, 'unix-nvm', 'home', 'test'), environment:{}});
  assert.match(resolveNodePackageBin(nvm,
    {package:'@openai/codex', bin:'codex', args:[]}).argv[0], /unix-nvm/);

  const brewNode = path.join(base, 'macos-homebrew', 'opt', 'homebrew', 'Cellar', 'node',
    '22.14.0', 'bin', 'node');
  const brew = await createPlatformRuntimeForTest({platform:'darwin'})
    .issueNodeToolchainCapability({nodeExecutable:brewNode,
      home:path.join(base, 'macos-homebrew'), environment:{}});
  assert.match(resolveNodePackageBin(brew,
    {package:'@openai/codex', bin:'codex', args:[]}).argv[0], /macos-homebrew/);

  for (const [fixture, nodeExecutable, home, environment, expected] of [
    ['windows-node-msi', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\test',
      {APPDATA:'C:\\Users\\test\\AppData\\Roaming'}, /AppData\\Roaming\\npm\\node_modules/],
    ['windows-setup-node', 'C:\\hostedtoolcache\\windows\\node\\22.14.0\\x64\\node.exe',
      'C:\\Users\\test', {}, /hostedtoolcache/],
  ]) {
    const calls = [];
    const runtime = createPlatformRuntimeForTest({platform:'win32',
      fsImpl:windowsFixtureFs(path.join(base, fixture)),
      prefixProbeImpl:async (request) => {
        calls.push(request);
        return {ok:true, stdout:'C:\\Users\\test\\AppData\\Roaming\\npm\r\n', stderr:''};
      }});
    const capability = await runtime.issueNodeToolchainCapability({nodeExecutable, home, environment});
    const resolved = resolveNodePackageBin(capability,
      {package:'@openai/codex', bin:'codex', args:['--version']});
    assert.match(resolved.argv[0], expected, fixture);
    if (environment.APPDATA) {
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(1), ['prefix','--global']);
      assert.equal(calls[0].shell, false);
    }
  }
});

test('node toolchain rejects a linked package scope even when it resolves inside the root', async () => {
  if (process.platform === 'win32') return test.skip('symlink setup requires elevated mode on Windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-toolchain-link-'));
  try {
    const bin = path.join(root, 'bin');
    const nodeExecutable = path.join(bin, 'node');
    const packages = path.join(bin, 'node_modules');
    const realScope = path.join(packages, 'real-scope');
    fs.mkdirSync(path.join(realScope, 'codex', 'bin'), {recursive:true});
    fs.writeFileSync(nodeExecutable, 'fixture');
    fs.writeFileSync(path.join(realScope, 'codex', 'package.json'),
      JSON.stringify({name:'@openai/codex', bin:{codex:'bin/codex.js'}}));
    fs.writeFileSync(path.join(realScope, 'codex', 'bin', 'codex.js'), '');
    fs.symlinkSync(realScope, path.join(packages, '@openai'));
    const cap = await createPlatformRuntimeForTest()
      .issueNodeToolchainCapability({nodeExecutable, home:root, environment:{}});
    assert.throws(() => resolveNodePackageBin(cap,
      {package:'@openai/codex', bin:'codex', args:[]}), /path-capability-link/);
  } finally { remove(root); }
});

test('production node-toolchain issuer is bound to active Node and real home', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-toolchain-foreign-'));
  try {
    const foreign = path.join(root, 'node');
    fs.writeFileSync(foreign, 'fixture');
    await assert.rejects(() => issueNodeToolchainCapability({nodeExecutable:foreign,
      home:os.homedir(), environment:process.env}), /node-toolchain-active-node/);
    await assert.rejects(() => issueNodeToolchainCapability({nodeExecutable:process.execPath,
      home:root, environment:process.env}), /node-toolchain-home/);
  } finally { remove(root); }
});

test('portable launcher uses process.execPath for project package JS bins and rejects shims', async () => {
  const root = makeRepo();
  try {
    const packageRoot = path.join(root, 'node_modules', 'fixture-tool');
    fs.mkdirSync(path.join(packageRoot, 'bin'), {recursive:true});
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name:'fixture-tool', bin:{fixture:'bin/fixture.js'},
    }));
    fs.writeFileSync(path.join(packageRoot, 'bin', 'fixture.js'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const {project} = caps(root);
    const result = await spawnPortable({kind:'node-package-bin', package:'fixture-tool',
      bin:'fixture', args:['--format','json','한 글.js']}, {projectCapability:project});
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.stdout), ['--format','json','한 글.js']);
    for (const processSpec of [
      {kind:'native-executable', executable:'npm.cmd', args:['test']},
      {kind:'native-executable', executable:'C:\\Tools\\npm.cmd', args:['test']},
      {kind:'native-executable', executable:'tool.exe', args:['a\nb']},
      {kind:'node-package-bin', package:'../../foreign', bin:'x', args:[]},
      {kind:'native-executable', executable:process.execPath, args:[], command:'echo unsafe'},
      {kind:'node-package-bin', package:'fixture-tool', bin:'fixture', args:[],
        callerPackageRoot:path.join(root, 'node_modules')},
    ]) await assert.rejects(() => spawnPortable(processSpec, {projectCapability:project}));
  } finally { remove(root); }
});

test('environment sanitizer applies exact POSIX and case-insensitive Windows key contracts', () => {
  const windows = createPlatformRuntimeForTest({platform:'win32'});
  const accepted = windows.sanitizeEnvironment({
    Path:'C:\\Windows\\System32',
    'CommonProgramFiles(x86)':'C:\\Program Files (x86)\\Common Files',
  });
  assert.deepEqual(accepted, {
    Path:'C:\\Windows\\System32',
    'CommonProgramFiles(x86)':'C:\\Program Files (x86)\\Common Files',
  });
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(windows.environmentValue(accepted, 'PATH'), 'C:\\Windows\\System32');
  assert.equal(windows.environmentValue(accepted, 'commonprogramfiles(X86)'),
    'C:\\Program Files (x86)\\Common Files');
  assert.throws(() => windows.sanitizeEnvironment({PATH:'first', Path:'second'}),
    /process-env-invalid/);
  for (const key of ['', 'BAD=KEY', 'BAD\nKEY', 'BAD\0KEY']) {
    assert.throws(() => windows.sanitizeEnvironment({[key]:'value'}), /process-env-invalid/);
  }
  const linux = createPlatformRuntimeForTest({platform:'linux'});
  assert.deepEqual(linux.sanitizeEnvironment({PATH:'/usr/bin', VALID_2:'yes'}),
    {PATH:'/usr/bin', VALID_2:'yes'});
  assert.throws(() => linux.sanitizeEnvironment({'CommonProgramFiles(x86)':'foreign'}),
    /process-env-invalid/);
});

test('safe Git environment collapses case-insensitive Windows ambient aliases', () => {
  const environment = platform.safeGitEnvironment(process.execPath, {
    HOME:'/tmp/home',
    SystemRoot:'C:\\Windows',
    SYSTEMROOT:'C:\\Windows',
    TEMP:'C:\\Temp',
    TMP:'C:\\Temp',
  }, {
    lstatSync(){ throw Object.assign(new Error('not a release carrier'), {code:'ENOENT'}); },
  });
  assert.deepEqual(Object.keys(environment).filter((key) => key.toLowerCase() === 'systemroot'),
    ['SystemRoot']);
});

test('native Windows launcher preserves the inherited parenthesized environment key', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, async () => {
  const root = makeRepo('dw-process-native-win-env-');
  try {
    const {project} = caps(root);
    const result = await spawnPortable({kind:'native-executable', executable:process.execPath,
      args:['-e', "process.stdout.write(process.env['CommonProgramFiles(x86)'] || '')"]},
    {projectCapability:project, env:{...process.env}, timeoutMs:5_000, maxOutputBytes:4_096});
    assert.equal(result.ok, true);
    assert.equal(result.stdout, process.env['CommonProgramFiles(x86)']);
  } finally { remove(root); }
});

test('atomic write preserves old target when rename never succeeds', () => {
  const root = makeRepo();
  try {
    const {state} = caps(root);
    fs.writeFileSync(state.path, 'old');
    const runtime = createPlatformRuntimeForTest({fsImpl:{...fs,
      renameSync(){ const error = new Error('busy'); error.code = 'EPERM'; throw error; },
    }});
    assert.throws(() => runtime.atomicWriteFile(state, 'new'), /EPERM|busy/);
    assert.equal(fs.readFileSync(state.path, 'utf8'), 'old');
  } finally { remove(root); }
});

test('directory lock publishes and releases an authenticated claim without owned residue', () => {
  const root = makeRepo();
  try {
    const lockPath = path.join(root, '.claude', 'state.lock');
    const lock = issueProjectStateCapability(root, lockPath, {role:'lock', allowMissingLeaf:true});
    const result = withDirectoryLock(lock, {timeoutMs:1_000, staleMs:200, heartbeatMs:25,
      processIdentity:'a'.repeat(32)}, () => 'released');
    assert.equal(result, 'released');
    assert.equal(fs.existsSync(lock.path), false);
    const claims = `${lock.path}.claims`;
    assert.deepEqual(fs.existsSync(claims) ? fs.readdirSync(claims) : [], []);
  } finally { remove(root); }
});

test('owned directory lock inspector authenticates the exact claim child set',async()=>{
  const root=makeRepo('dw-lock-inspect-');
  try{
    const lock=issueProjectStateCapability(root,path.join(root,'.claude','inspect.lock'),
      {role:'lock',allowMissingLeaf:true});
    const processIdentity='a'.repeat(32);
    await withDirectoryLock(lock,{timeoutMs:1_000,staleMs:300,heartbeatMs:25,inspectable:true,
      processIdentity},async(claim)=>{
      const projection=inspectOwnedDirectoryClaim(lock,claim);
      assert.equal(projection.pid,process.pid);
      assert.equal(projection.process_identity,processIdentity);
      assert.match(projection.claim_sha256,/^[0-9a-f]{64}$/);
      fs.writeFileSync(path.join(lock.path,'foreign-child'),'foreign\n');
      assert.throws(()=>inspectOwnedDirectoryClaim(lock,claim),/lock-inspect-children/);
      fs.unlinkSync(path.join(lock.path,'foreign-child'));
      fs.writeFileSync(path.join(`${lock.path}.claims`,'foreign-ticket'),'foreign\n');
      assert.throws(()=>inspectOwnedDirectoryClaim(lock,claim),/lock-inspect-children/);
      fs.unlinkSync(path.join(`${lock.path}.claims`,'foreign-ticket'));
    });
  }finally{remove(root);}
});

test('owned directory lock inspector accepts a completed authenticated heartbeat before inspection',
  async()=>{
    const root=makeRepo('dw-lock-inspect-heartbeat-');
    try{
      const lock=issueProjectStateCapability(root,path.join(root,'.claude','inspect.lock'),
        {role:'lock',allowMissingLeaf:true});
      await withDirectoryLock(lock,{timeoutMs:1_000,staleMs:300,heartbeatMs:25,inspectable:true,
        processIdentity:'b'.repeat(32)},async(claim)=>{
        const before=fs.statSync(path.join(lock.path,'heartbeat.json')).ino;
        await new Promise((resolve)=>setTimeout(resolve,80));
        const after=fs.statSync(path.join(lock.path,'heartbeat.json')).ino;
        assert.notEqual(after,before);
        const projection=inspectOwnedDirectoryClaim(lock,claim);
        assert.equal(projection.process_identity,'b'.repeat(32));
        assert.match(projection.claim_sha256,/^[0-9a-f]{64}$/);
      });
    }finally{remove(root);}
  });

test('owned directory lock inspector rejects same-byte child replacement and transient claims',
  async()=>{
    for(const kind of ['same-byte-replacement','transient-ticket']){
      const root=makeRepo(`dw-lock-inspect-${kind}-`);
      try{
        const lock=issueProjectStateCapability(root,path.join(root,'.claude','inspect.lock'),
          {role:'lock',allowMissingLeaf:true});
        await withDirectoryLock(lock,{timeoutMs:1_000,staleMs:300,heartbeatMs:25,inspectable:true,
          processIdentity:'c'.repeat(32)},async(claim)=>{
          const claims=`${lock.path}.claims`;
          if(kind==='same-byte-replacement'){
            const ticket=path.join(claims,fs.readdirSync(claims)[0]);
            const replacement=`${ticket}.replacement`;
            fs.writeFileSync(replacement,fs.readFileSync(ticket));
            fs.renameSync(replacement,ticket);
          }else{
            const transient=path.join(claims,'transient-ticket');
            fs.writeFileSync(transient,'foreign\n');
            fs.unlinkSync(transient);
          }
          assert.throws(()=>inspectOwnedDirectoryClaim(lock,claim),
            /lock-inspect-(?:claim|children|unstable)/);
        });
      }finally{remove(root);}
    }
  });

test('directory lock retries when a canonical claim disappears during authenticated read', () => {
  const root = makeRepo('dw-lock-release-race-');
  try {
    const lockPath = path.join(root, '.claude', 'release-race.lock');
    const owner = createPlatformRuntimeForTest({nonceFactory:() => '1'.repeat(32)});
    const ownerLock = owner.issueProjectStateCapability(root, lockPath,
      {role:'lock', allowMissingLeaf:true});
    let released = false;
    let contenderResult = null;
    assert.throws(() => owner.withDirectoryLock(ownerLock,
      {timeoutMs:1_000, staleMs:200, heartbeatMs:25, processIdentity:'2'.repeat(32)}, () => {
        const contender = createPlatformRuntimeForTest({nonceFactory:() => '3'.repeat(32),
          fsImpl:{opendirSync(value, options) {
            if (!released && value === lockPath) {
              released = true;
              const releasePath = `${lockPath}.release-race`;
              fs.renameSync(lockPath, releasePath);
              fs.rmSync(releasePath, {recursive:true, force:false});
              for (const name of fs.readdirSync(`${lockPath}.claims`)) {
                if (name.endsWith('.ticket')) fs.unlinkSync(path.join(`${lockPath}.claims`, name));
              }
            }
            return fs.opendirSync(value, options);
          }} });
        const contenderLock = contender.issueProjectStateCapability(root, lockPath,
          {role:'lock', allowMissingLeaf:true});
        contenderResult = contender.withDirectoryLock(contenderLock,
          {timeoutMs:1_000, staleMs:200, heartbeatMs:25, processIdentity:'4'.repeat(32)},
          () => 'contender');
        return 'owner';
      }), /lock-(chain-invalid|ownership-lost)/);
    assert.equal(released, true);
    assert.equal(contenderResult, 'contender');
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(fs.readdirSync(`${lockPath}.claims`), []);
  } finally { remove(root); }
});

test('Windows canonical claim publication retries bounded transient access failures', () => {
  for (const [index, code] of ['EPERM', 'EACCES'].entries()) {
    const root = makeRepo(`dw-lock-win-rename-${code.toLowerCase()}-`);
    try {
      const lockPath = path.join(root, '.claude', 'rename-retry.lock');
      const nonce = String(index + 5).repeat(32);
      let attempts = 0;
      const runtime = createPlatformRuntimeForTest({platform:'win32', nonceFactory:() => nonce,
        fsImpl:{renameSync(source, destination) {
          if (source === `${lockPath}.claim.${nonce}` && destination === lockPath) {
            attempts += 1;
            if (attempts < 3) throw Object.assign(new Error(`transient ${code}`), {code});
          }
          return fs.renameSync(source, destination);
        }}});
      const lock = runtime.issueProjectStateCapability(root, lockPath,
        {role:'lock', allowMissingLeaf:true});
      let callbacks = 0;
      assert.equal(runtime.withDirectoryLock(lock,
        {timeoutMs:2_000, staleMs:1_000, heartbeatMs:50,
          processIdentity:String(index + 7).repeat(32)}, () => {
          callbacks += 1;
          return 'done';
        }), 'done');
      assert.equal(attempts, 3, code);
      assert.equal(callbacks, 1, code);
      assert.equal(fs.existsSync(lockPath), false);
      assert.deepEqual(fs.readdirSync(`${lockPath}.claims`), []);
    } finally { remove(root); }
  }

  const root = makeRepo('dw-lock-win-rename-exhausted-');
  try {
    const lockPath = path.join(root, '.claude', 'rename-exhausted.lock');
    const nonce = '9'.repeat(32);
    let attempts = 0;
    const runtime = createPlatformRuntimeForTest({platform:'win32', nonceFactory:() => nonce,
      fsImpl:{renameSync(source, destination) {
        if (source === `${lockPath}.claim.${nonce}` && destination === lockPath) {
          attempts += 1;
          throw Object.assign(new Error('persistent EPERM'), {code:'EPERM'});
        }
        return fs.renameSync(source, destination);
      }}});
    const lock = runtime.issueProjectStateCapability(root, lockPath,
      {role:'lock', allowMissingLeaf:true});
    let callbacks = 0;
    assert.throws(() => runtime.withDirectoryLock(lock,
      {timeoutMs:2_000, staleMs:1_000, heartbeatMs:50, processIdentity:'a'.repeat(32)},
      () => {
        callbacks += 1;
        return 'never';
      }), /persistent EPERM/);
    assert.equal(attempts, 7);
    assert.equal(callbacks, 0);
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(fs.readdirSync(`${lockPath}.claims`), []);
    assert.equal(fs.readdirSync(path.dirname(lockPath))
      .some((name) => name.startsWith(`${path.basename(lockPath)}.claim.`)), false);
  } finally { remove(root); }
});

test('Windows canonical claim retry reauthenticates private and ticket ownership', () => {
  const root = makeRepo('dw-lock-win-rename-reauth-');
  try {
    const lockPath = path.join(root, '.claude', 'rename-reauth.lock');
    const nonce = 'b'.repeat(32);
    let attempts = 0;
    let callbacks = 0;
    const runtime = createPlatformRuntimeForTest({platform:'win32', nonceFactory:() => nonce,
      fsImpl:{renameSync(source, destination) {
        if (source === `${lockPath}.claim.${nonce}` && destination === lockPath) {
          attempts += 1;
          if (attempts === 1) {
            fs.writeFileSync(path.join(source, 'owner.json'), 'foreign-owner\n');
            throw Object.assign(new Error('transient EPERM after owner drift'), {code:'EPERM'});
          }
        }
        return fs.renameSync(source, destination);
      }}});
    const lock = runtime.issueProjectStateCapability(root, lockPath,
      {role:'lock', allowMissingLeaf:true});
    assert.throws(() => runtime.withDirectoryLock(lock,
      {timeoutMs:2_000, staleMs:1_000, heartbeatMs:50, processIdentity:'c'.repeat(32)},
      () => {
        callbacks += 1;
        return 'never';
      }), /lock-(owner|chain)-invalid/);
    assert.equal(attempts, 1);
    assert.equal(callbacks, 0);
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(fs.readdirSync(`${lockPath}.claims`), []);
    assert.equal(fs.readdirSync(path.dirname(lockPath))
      .some((name) => name.startsWith(`${path.basename(lockPath)}.claim.`)), false);
  } finally { remove(root); }
});

test('claim core, ticket, owner, and heartbeat form an acyclic stable chain', async () => {
  const root = makeRepo();
  try {
    const lock = issueProjectStateCapability(root, path.join(root, '.claude', 'chain.lock'),
      {role:'lock', allowMissingLeaf:true});
    await withDirectoryLock(lock, {timeoutMs:1_000, staleMs:300, heartbeatMs:20,
      processIdentity:'6'.repeat(32)}, async () => {
      const ticketPath = path.join(`${lock.path}.claims`, fs.readdirSync(`${lock.path}.claims`)
        .find((name) => name.endsWith('.ticket')));
      const ownerPath = path.join(lock.path, 'owner.json');
      const heartbeatPath = path.join(lock.path, 'heartbeat.json');
      const ticketBefore = fs.readFileSync(ticketPath);
      const ownerBefore = fs.readFileSync(ownerPath);
      const owner = JSON.parse(ownerBefore);
      assert.deepEqual(Object.keys(owner).sort(), ['claimCoreDigest','createdAt','nonce','pid',
        'processIdentity','ticketDigest','ticketExpiresAt','version']);
      assert.equal(owner.ticketDigest, hash(ticketBefore));
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.deepEqual(fs.readFileSync(ticketPath), ticketBefore);
      assert.deepEqual(fs.readFileSync(ownerPath), ownerBefore);
      const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath));
      assert.equal(heartbeat.ownerCoreDigest, hash(ownerBefore));
      assert.equal(heartbeat.sequence > 0, true);
    });
    assert.deepEqual(fs.readdirSync(`${lock.path}.claims`), []);
  } finally { remove(root); }
});

test('heartbeat replacement never exposes a staging entry inside the canonical claim', () => {
  const root = makeRepo('dw-lock-heartbeat-staging-');
  try {
    const lockPath = path.join(root, '.claude', 'heartbeat-staging.lock');
    const heartbeatPath = path.join(lockPath, 'heartbeat.json');
    let observedReplacement = false;
    const runtime = createPlatformRuntimeForTest({
      nonceFactory: () => 'a'.repeat(32),
      fsImpl: {
        renameSync(source, destination) {
          if (!observedReplacement && destination === heartbeatPath) {
            observedReplacement = true;
            assert.deepEqual(fs.readdirSync(lockPath).sort(), ['heartbeat.json', 'owner.json']);
          }
          return fs.renameSync(source, destination);
        },
      },
    });
    const lock = runtime.issueProjectStateCapability(root, lockPath,
      {role:'lock', allowMissingLeaf:true});
    assert.equal(runtime.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:200, heartbeatMs:25, processIdentity:'b'.repeat(32)},
      () => 'done'), 'done');
    assert.equal(observedReplacement, true);
  } finally { remove(root); }
});

test('production lock clock survives a wall-clock step before the initial heartbeat', () => {
  const root = makeRepo('dw-lock-initial-clock-step-');
  try {
    const lockPath = path.join(root, '.claude', 'initial-clock-step.lock');
    const source = `
      const path = require('node:path');
      const values = [10_000, 10_000, 10_000, 10_000, 10_000, 9_999];
      Date.now = () => values.shift() ?? 9_999;
      const platform = require(${JSON.stringify(path.resolve(__dirname, 'platform.js'))});
      const root = process.argv[1];
      const lock = platform.issueProjectStateCapability(root,
        path.join(root, '.claude', 'initial-clock-step.lock'),
        {role:'lock', allowMissingLeaf:true});
      const result = platform.withDirectoryLock(lock,
        {timeoutMs:1_000, staleMs:200, heartbeatMs:25,
          processIdentity:'a'.repeat(32)}, () => 'done');
      process.stdout.write(JSON.stringify({result}));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', source, root],
      {encoding:'utf8'}));
    assert.deepEqual(result, {result:'done'});
    assert.equal(fs.existsSync(lockPath), false);
  } finally { remove(root); }
});

test('production lock clock survives a wall-clock step during periodic heartbeat', () => {
  const root = makeRepo('dw-lock-periodic-clock-step-');
  try {
    const lockPath = path.join(root, '.claude', 'periodic-clock-step.lock');
    const source = `
      const path = require('node:path');
      const platform = require(${JSON.stringify(path.resolve(__dirname, 'platform.js'))});
      let now = 10_000;
      Date.now = () => now;
      const root = process.argv[1];
      const lock = platform.issueProjectStateCapability(root,
        path.join(root, '.claude', 'periodic-clock-step.lock'),
        {role:'lock', allowMissingLeaf:true});
      (async () => {
        const result = await platform.withDirectoryLock(lock,
          {timeoutMs:1_000, staleMs:200, heartbeatMs:10,
            processIdentity:'b'.repeat(32)}, async () => {
              now = 9_999;
              await new Promise((resolve) => setTimeout(resolve, 35));
              return 'done';
            });
        process.stdout.write(JSON.stringify({result}));
      })().catch((error) => {
        process.stderr.write(error.stack || String(error));
        process.exitCode = 1;
      });
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', source, root],
      {encoding:'utf8'}));
    assert.deepEqual(result, {result:'done'});
    assert.equal(fs.existsSync(lockPath), false);
  } finally { remove(root); }
});

test('routine heartbeat durability does not fsync the sibling staging parent', () => {
  const root = makeRepo('dw-lock-heartbeat-fsync-');
  try {
    const runtime = createPlatformRuntimeForTest();
    const lock = runtime.issueProjectStateCapability(root,
      path.join(root, '.claude', 'heartbeat-fsync.lock'),
      {role:'lock', allowMissingLeaf:true});
    assert.equal(runtime.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:200, heartbeatMs:25,
        processIdentity:'c'.repeat(32)}, () => 'done'), 'done');
    assert.deepEqual(runtime.lockDurability()
      .filter((record) => record.stage.startsWith('first-heartbeat'))
      .map((record) => record.stage), ['first-heartbeat']);
  } finally { remove(root); }
});

test('expired partial ticket is recovered only from its canonical filename and three ESRCH probes', () => {
  const root = makeRepo();
  try {
    const lock = issueProjectStateCapability(root, path.join(root, '.claude', 'partial.lock'),
      {role:'lock', allowMissingLeaf:true});
    const rootStat = fs.lstatSync(root);
    const rootIdentity = {dev:String(rootStat.dev), ino:String(rootStat.ino), mode:rootStat.mode,
      type:'directory'};
    const targetIdentity = hash(Buffer.from(canonicalJsonForTest({version:1,
      projectRoot:lock.canonicalProjectRoot, path:lock.path, rootIdentity})));
    const core = {version:2, targetIdentity, pid:999_999, processIdentity:'7'.repeat(32),
      nonce:'8'.repeat(32), createdAt:1_000, ticketExpiresAt:31_000};
    const ticket = {version:2, claimCoreDigest:hash(Buffer.from(canonicalJsonForTest(core))),
      targetIdentity, pid:core.pid, processIdentity:core.processIdentity, nonce:core.nonce,
      createdAt:core.createdAt, ticketExpiresAt:core.ticketExpiresAt};
    const name = ['v2', hash(Buffer.from(targetIdentity)), core.pid, core.processIdentity, core.nonce,
      core.createdAt, core.ticketExpiresAt, 'ticket'].join('.');
    const claims = `${lock.path}.claims`;
    fs.mkdirSync(claims);
    fs.writeFileSync(path.join(claims, name), Buffer.from(canonicalJsonForTest(ticket)).subarray(0, 23));
    let probes = 0;
    const nonces = ['9'.repeat(32), 'a'.repeat(32)];
    const runtime = createPlatformRuntimeForTest({clock:() => 31_001,
      livenessImpl:() => { probes += 1; return {status:'dead', reason:'ESRCH'}; },
      nonceFactory:() => nonces.shift() || 'b'.repeat(32)});
    assert.equal(runtime.withDirectoryLock(lock, {timeoutMs:1_000, staleMs:200, heartbeatMs:25,
      processIdentity:'c'.repeat(32)}, () => 'recovered'), 'recovered');
    assert.equal(probes, 3);
    assert.deepEqual(fs.readdirSync(claims), []);
  } finally { remove(root); }
});

test('SIGKILL owner is reclaimed only after stale heartbeat and ESRCH', async () => {
  if (process.platform === 'win32') return test.skip('SIGKILL integration is POSIX-only');
  const root = makeRepo();
  try {
    const lockPath = path.join(root, '.claude', 'worker.lock');
    const worker = fork(path.join(fixtureRoot, 'lock-worker.js'),
      [root, lockPath, 'b'.repeat(32)], {stdio:['ignore','ignore','inherit','ipc']});
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    worker.kill('SIGKILL');
    await new Promise((resolve) => worker.once('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 220));
    const lock = issueProjectStateCapability(root, lockPath, {role:'lock', allowMissingLeaf:true});
    assert.equal(withDirectoryLock(lock, {timeoutMs:1_000, staleMs:150, heartbeatMs:25,
      processIdentity:'c'.repeat(32)}, () => 'recovered'), 'recovered');
    const claims = `${lockPath}.claims`;
    assert.deepEqual(fs.existsSync(claims) ? fs.readdirSync(claims) : [], []);
  } finally { remove(root); }
});

test('release ticket unlink failure is typed and retains only its exact ticket', () => {
  const root = makeRepo();
  try {
    const issuer = createPlatformRuntimeForTest({fsImpl:{
      unlinkSync(value) {
        if (String(value).endsWith('.ticket')) throw Object.assign(new Error('busy'), {code:'EPERM'});
        return fs.unlinkSync(value);
      },
    }});
    const lock = issuer.issueProjectStateCapability(root, path.join(root, '.claude', 'release.lock'),
      {role:'lock', allowMissingLeaf:true});
    assert.throws(() => issuer.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:200, heartbeatMs:25, processIdentity:'d'.repeat(32)}, () => 'done'),
    (error) => error.code === 'lock-release-ticket-cleanup-failed' &&
      error.ticketPath.endsWith('.ticket'));
    assert.equal(fs.existsSync(lock.path), false);
    assert.equal(fs.readdirSync(`${lock.path}.claims`).filter((name) => name.endsWith('.ticket')).length, 1);
  } finally { remove(root); }
});

test('pending operations replay in order and failed replay retains draining bytes', () => {
  const root = makeRepo();
  try {
    const target = issueProjectStateCapability(root, path.join(root, '.claude', 'history.jsonl'),
      {role:'history', allowMissingLeaf:true});
    const pending = issueProjectStateCapability(root,
      path.join(root, '.claude', '.pending-append.jsonl'), {role:'pending', allowMissingLeaf:true});
    appendJsonLineLocked(target, {id:'a'}, {pendingCapability:pending});
    appendJsonLineLocked(target, {id:'b'}, {pendingCapability:pending});
    assert.deepEqual(fs.readFileSync(target.path, 'utf8').trim().split('\n').map(JSON.parse),
      [{id:'a'}, {id:'b'}]);
    fs.writeFileSync(pending.path,
      canonicalJsonForTest({version:1,kind:'append-json-line',payload:{id:'c'}}));
    const reducer = (bytes, operations) => Buffer.concat([bytes,
      Buffer.from(operations.map((op) => `${JSON.stringify(op.payload)}\n`).join(''))]);
    const failing = createPlatformRuntimeForTest({pendingIoImpl:{
      beforeCanonicalWrite(){ throw new Error('replay-failure'); },
    }});
    assert.throws(() => failing.drainPendingOperations(target,
      {pendingCapability:pending, applyOperations:reducer}), /replay-failure/);
    assert.equal(fs.readdirSync(path.dirname(pending.path)).some((name) =>
      name.startsWith(`${path.basename(pending.path)}.draining.`)), true);
    assert.equal(drainPendingOperations(target,
      {pendingCapability:pending, applyOperations:reducer}).recovered, 1);
    assert.match(fs.readFileSync(target.path, 'utf8'), /"id":"c"/);
  } finally { remove(root); }
});

test('append-json-line replay is idempotent for an already-applied exact operation', () => {
  const root = makeRepo();
  try {
    const target = issueProjectStateCapability(root, path.join(root, '.claude', 'events.jsonl'),
      {role:'history', allowMissingLeaf:true});
    const pending = issueProjectStateCapability(root,
      path.join(root, '.claude', '.pending-append.jsonl'), {role:'pending', allowMissingLeaf:true});
    appendJsonLineLocked(target, {id:'same'}, {pendingCapability:pending});
    fs.writeFileSync(pending.path,
      canonicalJsonForTest({version:1,kind:'append-json-line',payload:{id:'same'}}));
    drainPendingOperations(target, {pendingCapability:pending,
      applyOperations:(bytes, operations) => Buffer.concat([bytes,
        Buffer.from(operations.map((operation) => `${JSON.stringify(operation.payload)}\n`).join(''))])});
    assert.equal(fs.readFileSync(target.path, 'utf8').trim().split('\n').length, 1);
  } finally { remove(root); }
});

test('noncanonical pending JSONL is retained and never mutates the canonical target', () => {
  const root = makeRepo();
  try {
    const target = issueProjectStateCapability(root, path.join(root, '.claude', 'canonical.jsonl'),
      {role:'history', allowMissingLeaf:true});
    const pending = issueProjectStateCapability(root,
      path.join(root, '.claude', '.pending-append.jsonl'), {role:'pending', allowMissingLeaf:true});
    fs.writeFileSync(pending.path,
      '{"version":1,"kind":"append-json-line","payload":{"id":"wrong-order"}}\n');
    assert.throws(() => drainPendingOperations(target, {pendingCapability:pending,
      applyOperations:(bytes) => bytes}), /pending-operation-invalid/);
    assert.equal(fs.existsSync(target.path), false);
    assert.equal(fs.readdirSync(path.dirname(pending.path)).some((name) =>
      name.startsWith(`${path.basename(pending.path)}.draining.`)), true);
  } finally { remove(root); }
});

test('process supervision removes a grandchild after normal completion and timeout', async () => {
  const root = makeRepo();
  try {
    const {project} = caps(root);
    for (const [mode, timeoutMs] of [['normal', 2_000],
      ['timeout', process.platform === 'win32' ? 1_000 : 150]]) {
      const marker = path.join(root, `.claude/${mode}.pid`);
      const result = await spawnPortable({kind:'native-executable', executable:process.execPath,
        args:[path.join(fixtureRoot, 'process-tree-parent.js'), mode, marker]},
      {cwdCapability:project, timeoutMs, maxOutputBytes:128_000});
      assert.equal(fs.existsSync(marker), true, mode);
      const pid = Number(fs.readFileSync(marker, 'utf8'));
      assert.deepEqual(await waitForProcessesToExit([pid]), []);
      assert.equal(mode === 'normal' ? result.ok : result.timedOut, true, mode);
    }
  } finally { remove(root); }
});

test('output overflow removes the process tree and termination failure is fail-closed', async () => {
  const root = makeRepo();
  try {
    const {project} = caps(root);
    const marker = path.join(root, '.claude', 'overflow.pid');
    const result = await spawnPortable({kind:'native-executable', executable:process.execPath,
      args:[path.join(fixtureRoot, 'process-tree-parent.js'), 'overflow', marker]},
    {cwdCapability:project, timeoutMs:2_000, maxOutputBytes:1_024});
    assert.equal(result.outputOverflow, true);
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    assert.deepEqual(await waitForProcessesToExit([pid]), []);

    let failedTermination;
    const failureMarker = path.join(root, '.claude', 'failure.pid');
    const failing = createPlatformRuntimeForTest({terminationImpl:async (context) => {
      failedTermination = context;
      const error = new Error('cannot terminate');
      error.code = 'process-tree-termination-failed';
      throw error;
    }});
    await assert.rejects(() => failing.spawnPortable({kind:'native-executable',
      executable:process.execPath,
      args:[path.join(fixtureRoot, 'process-tree-parent.js'), 'timeout',
        failureMarker]},
    {cwdCapability:project, timeoutMs:100, maxOutputBytes:1_024}),
    /cannot terminate/);
    const grandchildPid = fs.existsSync(failureMarker)
      ? Number(fs.readFileSync(failureMarker, 'utf8')) : null;
    const observedPids = [failedTermination?.pid, ...(failedTermination?.knownPids || []),
      grandchildPid];
    try {
      await independentlyTerminateFailedTestTree(failedTermination);
      assert.deepEqual(await waitForProcessesToExit(observedPids), []);
    } finally {
      if (observedPids.some((pid) => Number.isSafeInteger(pid) && isProcessAlive(pid))) {
        await independentlyTerminateFailedTestTree(failedTermination).catch(() => {});
      }
    }
  } finally { remove(root); }
});

test('test runtime rejects every injection key outside the closed test-only seam', () => {
  for (const key of ['resolver','io','prefixAnswer','callerPackageRoot','streamInventoryImpl']) {
    assert.throws(() => createPlatformRuntimeForTest({[key]:{}}), /test-runtime-option-invalid/, key);
  }
});

test('expected Windows helper factory selection contract', () => {
  assertExpectedWindowsFactorySelectionSource(windowsStreamPInvokeSource());
});

test('Windows helper factory selection detector rejects the Select-Object mutant', () => {
  const intendedFixture = [
    '$assemblyAccess = [System.Reflection.Emit.AssemblyBuilderAccess]::Run',
    EXPECTED_WINDOWS_FACTORY_SELECTION_SOURCE,
    'if ($null -ne $staticFactory) {',
    '  $assemblyBuilder = $staticFactory.Invoke($null, @($assemblyName, $assemblyAccess))',
    '} else {',
    '  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)',
    '}',
  ].join('\n');
  assertExpectedWindowsFactorySelectionSource(intendedFixture);
  const selectionMutant = replaceWindowsStreamSourceOnce(intendedFixture,
    EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX,
    '$staticFactory = $staticFactoryCandidates | Select-Object -First 1');
  assert.throws(() => assertExpectedWindowsFactorySelectionSource(selectionMutant),
    /expected Windows helper factory selection source/);
});

test('expected Windows factory-discovery direct-index diagnostic contract', () => {
  const script = factoryDiscoveryTypeResolveDiagnosticScript();
  const marker = (stage, indent = '') =>
    typeResolveStageLine('factory-discovery', stage, indent);
  const orderedFragments = [
    marker('started'),
    marker('type-token-enter'),
    '$factoryType = [System.Reflection.Emit.AssemblyBuilder]',
    marker('type-token-return'),
    marker('get-methods-enter'),
    '$allMethods = @($factoryType.GetMethods())',
    marker('get-methods-return'),
    marker('name-filter-enter'),
    "$namedMethods = @($allMethods | Where-Object { $_.Name -ceq 'DefineDynamicAssembly' })",
    marker('name-filter-return'),
    marker('static-filter-enter'),
    '$staticMethods = @($namedMethods | Where-Object { $_.IsStatic })',
    marker('static-filter-return'),
    marker('parameter-filter-enter'),
    '$twoParameterMethods = @($staticMethods | Where-Object { $_.GetParameters().Length -eq 2 })',
    marker('parameter-filter-return'),
    marker('index-enter'),
    '$indexedFactory = $twoParameterMethods[0]',
    marker('index-return'),
    'if ($null -eq $indexedFactory) {',
    marker('indexed-null', '  '),
    '} else {',
    marker('indexed-present', '  '),
    '}',
    marker('completed'),
  ];
  const forbiddenStages = [
    'select-enter','select-return','selected-null','selected-present',
  ];
  assert.deepEqual({
    allowedStagesExact:JSON.stringify(TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES) ===
      JSON.stringify(EXPECTED_TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES),
    expectedStageCounts:EXPECTED_TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES.every(
      (stage) => countLiteral(script, marker(stage)) === 1),
    forbiddenStageCount:forbiddenStages.reduce((total, stage) =>
      total + countLiteral(script, marker(stage)), 0),
    orderedFragments:containsOrderedFragments(script, orderedFragments),
    selectObjectCount:countLiteral(script, 'Select-Object'),
    staticFactoryCount:countLiteral(script, '$staticFactory'),
    twoParameterMethodsCount:countLiteral(script, '$twoParameterMethods'),
  }, {
    allowedStagesExact:true,
    expectedStageCounts:true,
    forbiddenStageCount:0,
    orderedFragments:true,
    selectObjectCount:0,
    staticFactoryCount:0,
    twoParameterMethodsCount:2,
  }, 'expected factory-discovery direct-index diagnostic');
});

test('expected Windows pinned factory-boundary diagnostic contract', () => {
  const script = pinnedWindowsTypeResolveDiagnostic().script;
  const marker = (stage) => typeResolveStageLine('pinned', stage);
  const candidateBoundary = [
    EXPECTED_WINDOWS_FACTORY_CANDIDATE_MATERIALIZATION,
    marker('factory-candidates-ready'),
    marker('factory-index-enter'),
    EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX,
    marker('factory-index-return'),
    marker('factory-branch-enter'),
    'if ($null -ne $staticFactory) {',
  ].join('\n');
  const branchBoundary = [
    'if ($null -ne $staticFactory) {',
    marker('factory-invoke-enter'),
    '  $assemblyBuilder = $staticFactory.Invoke($null, @($assemblyName, $assemblyAccess))',
    marker('factory-invoke-return'),
    '} else {',
    marker('factory-fallback-enter'),
    '  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, $assemblyAccess)',
    marker('factory-fallback-return'),
    '}',
    marker('assembly-ready'),
  ].join('\n');
  assert.deepEqual({
    insertedStagesExact:JSON.stringify(TYPE_RESOLVE_PINNED_INSERTED_STAGES) ===
      JSON.stringify(EXPECTED_TYPE_RESOLVE_PINNED_INSERTED_STAGES),
    stateStagesExact:JSON.stringify(TYPE_RESOLVE_PINNED_STATE_CLASSIFICATION_STAGES) ===
      JSON.stringify(EXPECTED_TYPE_RESOLVE_PINNED_STATE_STAGES),
    allowedStagesExact:JSON.stringify(TYPE_RESOLVE_PINNED_ALLOWED_STAGES) ===
      JSON.stringify([
        'started',
        ...EXPECTED_TYPE_RESOLVE_PINNED_INSERTED_STAGES.flatMap((stage) =>
          stage === 'scope-exited'
            ? [stage, ...EXPECTED_TYPE_RESOLVE_PINNED_STATE_STAGES,
              ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_STAGES.flatMap((lateBakeStage) =>
                lateBakeStage === 'late-bake-result-null'
                  ? [lateBakeStage,
                    ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES]
                  : [lateBakeStage])] : [stage]),
        'completed',
      ]),
    factoryMarkerCounts:EXPECTED_TYPE_RESOLVE_PINNED_FACTORY_STAGES.every(
      (stage) => countLiteral(script, marker(stage)) === 1),
    candidateBoundaryCount:countLiteral(script, candidateBoundary),
    branchBoundaryCount:countLiteral(script, branchBoundary),
    factoryMarkersOrdered:containsOrderedFragments(script,
      EXPECTED_TYPE_RESOLVE_PINNED_FACTORY_STAGES.map(marker)),
  }, {
    insertedStagesExact:true,
    stateStagesExact:true,
    allowedStagesExact:true,
    factoryMarkerCounts:true,
    candidateBoundaryCount:1,
    branchBoundaryCount:1,
    factoryMarkersOrdered:true,
  }, 'expected pinned factory-boundary diagnostic');
});

test('fixed Windows stream helper is closed P/Invoke source without Get-Item or caller code', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-stream-inventory.ps1'), 'utf8');
  for (const name of ['FindFirstStreamW', 'FindNextStreamW', 'FindClose', 'GetLastWin32Error']) {
    assert.match(source, new RegExp(name));
  }
  assert.doesNotMatch(source, /Get-Item\s+-Stream/i);
  assert.doesNotMatch(source, /Invoke-Expression|\biex\b/i);
  assert.doesNotMatch(source, /\bAdd-Type\b/i);
  assert.match(source, /Reflection\.Emit/);
  assert.match(source, /relative_path/);
  const pinvokeSource = windowsStreamPInvokeSource();
  assertWindowsStreamTypeResolveSource(pinvokeSource);
  const [parserSafeFindFirstAttestation] = windowsStreamRuntimeAttestationLines();
  const splitRuntimeAttestation = replaceWindowsStreamSourceOnce(pinvokeSource,
    parserSafeFindFirstAttestation,
    parserSafeFindFirstAttestation.replace(' ([Type[]]@', '\n  ([Type[]]@'));
  const movedNestedCreate = replaceWindowsStreamSourceOnce(pinvokeSource,
    '$resolvedStreamDataType = $streamDataBuilder.CreateType()',
    '$resolvedStreamDataType = $null').replace(
    '# DEEP_WORK_TYPE_RESOLVE_HANDLER_END',
    '# DEEP_WORK_TYPE_RESOLVE_HANDLER_END\n$resolvedStreamDataType = $streamDataBuilder.CreateType()');
  const reorderedNestedCreate = replaceWindowsStreamSourceOnce(pinvokeSource,
    '    $resolvedStreamDataType = $streamDataBuilder.CreateType()\n', '').replace(
    '  try {\n', '  try {\n    $resolvedStreamDataType = $streamDataBuilder.CreateType()\n');
  const mutants = [
    ['PowerShell 5.1 physical-line invocation', splitRuntimeAttestation,
      /must each occupy one physical line/],
    ['registration', replaceWindowsStreamSourceOnce(pinvokeSource,
      '$currentDomain.add_TypeResolve($typeResolveHandler)', ''),
    /TypeResolve registration count/],
    ['finally removal', replaceWindowsStreamSourceOnce(pinvokeSource,
      '$currentDomain.remove_TypeResolve($typeResolveHandler)', ''),
    /TypeResolve removal count/],
    ['exact name', replaceWindowsStreamSourceOnce(pinvokeSource,
      "DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA'",
      "DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA_MUTANT'"),
    /exact expected nested type name/],
    ['duplicate guard', replaceWindowsStreamSourceOnce(pinvokeSource,
      'if ($typeResolveState.Requests -ne 1) {',
      'if ($typeResolveState.Requests -lt 1) {'),
    /duplicate TypeResolve guard/],
    ['nested CreateType placement', movedNestedCreate,
      /nested CreateType handler placement/],
    ['nested CreateType guard order', reorderedNestedCreate,
      /TypeResolve handler fail-closed order/],
    ['assembly return', replaceWindowsStreamSourceOnce(pinvokeSource,
      'return $assemblyBuilder', 'return $streamDataType.Assembly'),
    /expected TypeResolve assembly return/],
    ['post-bake authentication', replaceWindowsStreamSourceOnce(pinvokeSource,
      '$streamDataType.FullName, $expectedStreamDataTypeName',
      '$expectedStreamDataTypeName, $expectedStreamDataTypeName'),
    /post-bake exact nested type name/],
    ['parameter signature', replaceWindowsStreamSourceOnce(pinvokeSource,
      'ParameterTypes = [Type[]]@([IntPtr], $streamDataByRef)',
      'ParameterTypes = [Type[]]@([IntPtr])'),
    /fixed P\/Invoke contract: ParameterTypes/],
    ['return signature', replaceWindowsStreamSourceOnce(pinvokeSource,
      'ReturnType = [IntPtr]', 'ReturnType = [UIntPtr]'),
    /fixed P\/Invoke contract: ReturnType/],
    ['interop attribute', replaceWindowsStreamSourceOnce(pinvokeSource,
      "[System.Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')",
      "[System.Runtime.InteropServices.DllImportAttribute].GetField('BestFitMapping')"),
    /fixed P\/Invoke contract.*SetLastError/],
  ];
  for (const [name, mutant, expected] of mutants) {
    assert.throws(() => assertWindowsStreamTypeResolveSource(mutant), expected, name);
  }
});

test('expected Windows pinned late-bake identity-axis diagnostic contract', () => {
  assertExpectedWindowsPinnedLateBakeIdentityAxisDiagnostic({
    ...pinnedWindowsTypeResolveDiagnostic(),
    allowedStages:TYPE_RESOLVE_PINNED_ALLOWED_STAGES,
    oracleSource:assertPinnedTypeResolveRecords.toString(),
    actualOracleDiscrepancies:actualPinnedNoDispatchLateBakeOracleDiscrepancies(),
    axisActualOracleDiscrepancies:actualPinnedLateBakeIdentityAxisOracleDiscrepancies(),
  });
});

test('Windows pinned late-bake identity-axis detector rejects closed-surface mutants', () => {
  const intended = expectedPinnedLateBakeIdentityAxisFixture();
  assert.doesNotThrow(() =>
    assertExpectedWindowsPinnedLateBakeIdentityAxisDiagnostic(intended));
  for (const fixture of expectedPinnedLateBakeIdentityAxisRecordFixtures()) {
    assert.doesNotThrow(() =>
      assertExpectedPinnedLateBakeIdentityAxisRecordFixture(fixture));
  }

  const block = expectedPinnedLateBakeIdentityAxisBlock();
  const marker = (stage, indent = '') => typeResolveStageLine('pinned', stage, indent);
  const mutateBlock = (before, after) => {
    assert.equal(countLiteral(block, before), 1,
      `expected pinned identity-axis detector mutant anchor ${before}`);
    return {
      ...intended,
      transformed:intended.transformed.replace(block, block.replace(before, after)),
    };
  };
  const firstStep = expectedPinnedLateBakeIdentityAxisStep(
    EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXES[0]);
  const secondStep = expectedPinnedLateBakeIdentityAxisStep(
    EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXES[1]);
  const reorderedBlock = block.replace(`${firstStep}\n${secondStep}`,
    `${secondStep}\n${firstStep}`);
  assert.notEqual(reorderedBlock, block, 'expected pinned identity-axis order mutant');
  const withoutBlock = intended.transformed.replace(`${block}\n`, '');
  const movedBeforeCreateReturn = {
    ...intended,
    transformed:withoutBlock.replace(marker('late-bake-create-return', '    '),
      `${block}\n${marker('late-bake-create-return', '    ')}`),
  };
  const movedAfterAggregateIdentity = {
    ...intended,
    transformed:withoutBlock.replace(marker('late-bake-identity-authenticated', '  '),
      `${marker('late-bake-identity-authenticated', '  ')}\n${block}`),
  };
  const scriptMutants = [
    ...EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXES.map((axis) =>
      mutateBlock(axis.predicate.join('\n'),
        '    $lateBakeIdentityAxisMatch = $true')),
    {...intended, transformed:intended.transformed.replace(block, reorderedBlock)},
    {...intended, transformed:withoutBlock},
    {...intended, transformed:intended.transformed.replace(block, `${block}\n${block}`)},
    movedBeforeCreateReturn,
    movedAfterAggregateIdentity,
    mutateBlock(marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0],
      '    '), ''),
    mutateBlock(marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0],
      '    '), [
      marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0], '    '),
      marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0], '    '),
    ].join('\n')),
    mutateBlock(marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0],
      '    '), '    [Console]::Out.WriteLine($lateBakeIdentityAxisMatch)'),
    mutateBlock(marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0],
      '    '), [
      '    [Console]::Out.WriteLine($_.Exception.Message)',
      marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0], '    '),
    ].join('\n')),
    mutateBlock(marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[1],
      '    '), [
      '    [Console]::Out.WriteLine($lateBakeType.FullName)',
      marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[1], '    '),
    ].join('\n')),
    mutateBlock(
      '    $lateBakeIdentityAxisNestedFlags = [System.Reflection.BindingFlags]::Public -bor', [
      '    $identityAxisForeign = $true',
      '    $lateBakeIdentityAxisNestedFlags = [System.Reflection.BindingFlags]::Public -bor',
    ].join('\n')),
    ...[
      '    $lateBakeIdentityAxisForbidden = $streamDataBuilder.CreateType()',
      "    $lateBakeIdentityAxisForbidden = $moduleBuilder.DefineType('Forbidden')",
      "    $lateBakeIdentityAxisForbidden = $nativeBuilder.DefineNestedType('Forbidden')",
      "    $lateBakeIdentityAxisForbidden = $nativeBuilder.DefineField('Forbidden')",
      "    $lateBakeIdentityAxisForbidden = $nativeBuilder.DefineMethod('Forbidden')",
      '    $currentDomain.add_TypeResolve($typeResolveHandler)',
      "    $lateBakeIdentityAxisForbidden = Get-Item '.'",
      "    $lateBakeIdentityAxisForbidden = Start-Process 'cmd.exe'",
      '    $lateBakeIdentityAxisForbidden = $env:TEMP',
      '    $lateBakeIdentityAxisForbidden = [Microsoft.Win32.Registry]::CurrentUser',
      '    Start-Sleep -Milliseconds 1',
      '    $lateBakeIdentityAxisRetry = 1',
      '    $lateBakeIdentityAxisFallback = $true',
      '    $lateBakeIdentityAxisForbidden = $method.Invoke($null, @())',
    ].map((line) => mutateBlock(
      '    $lateBakeIdentityAxisNestedFlags = [System.Reflection.BindingFlags]::Public -bor',
      `${line}\n` +
        '    $lateBakeIdentityAxisNestedFlags = [System.Reflection.BindingFlags]::Public -bor')),
    mutateBlock([
      marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0], '    '),
      "    throw 'stream late bake identity-axis diagnostic failed'",
    ].join('\n'), [
      marker(EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES[0], '    '),
      "    throw 'stream late bake identity-axis diagnostic changed'",
    ].join('\n')),
  ];
  for (const mutant of scriptMutants) {
    assert.throws(() =>
      assertExpectedWindowsPinnedLateBakeIdentityAxisDiagnostic(mutant));
  }

  const axisStages = EXPECTED_TYPE_RESOLVE_PINNED_LATE_BAKE_IDENTITY_AXIS_STAGES;
  const firstAxisIndex = intended.allowedStages.indexOf(axisStages[0]);
  const allowedStageMutants = [
    intended.allowedStages.filter((stage) => stage !== axisStages[0]),
    [...intended.allowedStages.slice(0, firstAxisIndex), axisStages[0],
      ...intended.allowedStages.slice(firstAxisIndex)],
    [...intended.allowedStages.slice(0, firstAxisIndex), axisStages[1], axisStages[0],
      ...intended.allowedStages.slice(firstAxisIndex + 2)],
    [...intended.allowedStages.slice(0, firstAxisIndex),
      'late-bake-identity-axis-unexpected-mismatch',
      ...intended.allowedStages.slice(firstAxisIndex)],
  ];
  for (const allowedStages of allowedStageMutants) {
    assert.throws(() => assertExpectedWindowsPinnedLateBakeIdentityAxisDiagnostic({
      ...intended, allowedStages,
    }));
  }
  for (const fixture of expectedPinnedLateBakeIdentityAxisInvalidRecordFixtures()) {
    assert.throws(() =>
      assertExpectedPinnedLateBakeIdentityAxisRecordFixture(fixture.records),
    undefined, fixture.id);
  }
});

// DEEP_WORK_S211_STRICT_RED_TESTS_BEGIN
const S211_WRAPPER_AWARE_ASSEMBLY_SURFACES = Object.freeze([
  Object.freeze({
    id:'type-resolve-result',
    count:2,
    reference:'[Object]::ReferenceEquals($resolvedStreamDataType.Assembly, $assemblyBuilder)',
    wrapperAware:'[Object]::Equals($resolvedStreamDataType.Assembly, $assemblyBuilder)',
  }),
  Object.freeze({
    id:'post-bake-stream-data',
    count:1,
    reference:'[Object]::ReferenceEquals($streamDataType.Assembly, $assemblyBuilder)',
    wrapperAware:'[Object]::Equals($streamDataType.Assembly, $assemblyBuilder)',
  }),
  Object.freeze({
    id:'selected-stream-data',
    count:2,
    reference:'[Object]::ReferenceEquals($selectedStreamDataType.Assembly, $assemblyBuilder)',
    wrapperAware:'[Object]::Equals($selectedStreamDataType.Assembly, $assemblyBuilder)',
  }),
  Object.freeze({
    id:'generic-late-bake',
    count:2,
    reference:'[Object]::ReferenceEquals($lateBakeType.Assembly, $assemblyBuilder)',
    wrapperAware:'[Object]::Equals($lateBakeType.Assembly, $assemblyBuilder)',
  }),
  Object.freeze({
    id:'documented-control',
    count:1,
    reference:'[Object]::ReferenceEquals($nestedType.Assembly, $assemblyBuilder)',
    wrapperAware:'[Object]::Equals($nestedType.Assembly, $assemblyBuilder)',
  }),
  Object.freeze({
    id:'ordered-identity-axis',
    count:2,
    reference:[
      "'    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',",
      "      '      $lateBakeType.Assembly, $assemblyBuilder)'",
    ].join('\n'),
    wrapperAware:[
      "'    $lateBakeIdentityAxisMatch = [Object]::Equals(',",
      "      '      $lateBakeType.Assembly, $assemblyBuilder)'",
    ].join('\n'),
  }),
]);

const S211_REFERENCE_IDENTITY_SURFACES = Object.freeze([
  Object.freeze({
    id:'state-type',
    count:1,
    reference:'[Object]::ReferenceEquals($streamDataType, $typeResolveState.Type)',
  }),
  Object.freeze({
    id:'selected-canonical-type',
    count:2,
    reference:'[Object]::ReferenceEquals($streamDataType, $selectedStreamDataType)',
  }),
  Object.freeze({
    id:'canonical-late-bake-type',
    count:2,
    reference:'[Object]::ReferenceEquals($lateBakeType, $lateBakeCanonicalType)',
  }),
  Object.freeze({
    id:'stream-data-declaring-type',
    count:3,
    reference:'[Object]::ReferenceEquals($streamDataType.DeclaringType, $nativeType)',
  }),
  Object.freeze({
    id:'late-bake-declaring-type',
    count:2,
    reference:'[Object]::ReferenceEquals($lateBakeType.DeclaringType, $nativeType)',
  }),
  Object.freeze({
    id:'late-bake-module',
    count:2,
    reference:'[Object]::ReferenceEquals($lateBakeType.Module, $nativeType.Module)',
  }),
  Object.freeze({
    id:'axis-canonical-type',
    count:2,
    reference:[
      "'    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',",
      "      '      $lateBakeType, $lateBakeIdentityAxisCanonicalType)'",
    ].join('\n'),
  }),
  Object.freeze({
    id:'axis-declaring-type',
    count:2,
    reference:[
      "'    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',",
      "      '      $lateBakeType.DeclaringType, $nativeType)'",
    ].join('\n'),
  }),
  Object.freeze({
    id:'axis-module',
    count:2,
    reference:[
      "'    $lateBakeIdentityAxisMatch = [Object]::ReferenceEquals(',",
      "      '      $lateBakeType.Module, $nativeType.Module)'",
    ].join('\n'),
  }),
  Object.freeze({
    id:'documented-declaring-type',
    count:1,
    reference:'[Object]::ReferenceEquals($nestedType.DeclaringType, $outerType)',
  }),
]);

function s211CurrentAssemblyIdentityContractSource() {
  const helperSource = fs.readFileSync(
    path.join(__dirname, 'windows-stream-inventory.ps1'), 'utf8');
  const testSource = fs.readFileSync(__filename, 'utf8').replace(/\r\n/gu, '\n');
  const marker = ['\n// DEEP_WORK_S211', '_STRICT_RED_TESTS_BEGIN'].join('');
  const markerIndex = testSource.lastIndexOf(marker);
  assert.equal(markerIndex > 0, true, 'S2.11 strict RED source boundary');
  return `${helperSource}\n${testSource.slice(0, markerIndex)}`;
}

function assertS211WrapperAwareDynamicAssemblyIdentity(source) {
  for (const surface of S211_WRAPPER_AWARE_ASSEMBLY_SURFACES) {
    assert.deepEqual({
      wrapperAwareCount:countLiteral(source, surface.wrapperAware),
      referenceOnlyCount:countLiteral(source, surface.reference),
    }, {
      wrapperAwareCount:surface.count,
      referenceOnlyCount:0,
    }, `S2.11 wrapper-aware assembly surface: ${surface.id}`);
  }
  for (const surface of S211_REFERENCE_IDENTITY_SURFACES) {
    assert.equal(countLiteral(source, surface.reference), surface.count,
      `S2.11 preserved reference identity surface: ${surface.id}`);
  }
}

function replaceS211ContractSurfaceOnce(source, before, after) {
  const index = source.indexOf(before);
  assert.notEqual(index, -1, `S2.11 mutant anchor: ${before}`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

function s211IntendedWrapperAwareAssemblyIdentityFixture() {
  let source = s211CurrentAssemblyIdentityContractSource();
  for (const surface of S211_WRAPPER_AWARE_ASSEMBLY_SURFACES) {
    const referenceCount = countLiteral(source, surface.reference);
    const wrapperAwareCount = countLiteral(source, surface.wrapperAware);
    assert.deepEqual({
      totalCount:referenceCount + wrapperAwareCount,
      mixedForms:referenceCount > 0 && wrapperAwareCount > 0,
    }, {
      totalCount:surface.count,
      mixedForms:false,
    }, `S2.11 normalizable fixture surface: ${surface.id}`);
    source = source.split(surface.reference).join(surface.wrapperAware);
  }
  return source;
}

test('expected Windows wrapper-aware dynamic assembly identity remediation contract', () => {
  assertS211WrapperAwareDynamicAssemblyIdentity(
    s211CurrentAssemblyIdentityContractSource());
});

test('Windows wrapper-aware dynamic assembly identity detector rejects weak and reference-only mutants',
  () => {
    const intended = s211IntendedWrapperAwareAssemblyIdentityFixture();
    assert.doesNotThrow(() => assertS211WrapperAwareDynamicAssemblyIdentity(intended));

    const assembly = S211_WRAPPER_AWARE_ASSEMBLY_SURFACES[0];
    const state = S211_REFERENCE_IDENTITY_SURFACES.find((surface) =>
      surface.id === 'state-type');
    const canonical = S211_REFERENCE_IDENTITY_SURFACES.find((surface) =>
      surface.id === 'canonical-late-bake-type');
    const declaring = S211_REFERENCE_IDENTITY_SURFACES.find((surface) =>
      surface.id === 'stream-data-declaring-type');
    const moduleIdentity = S211_REFERENCE_IDENTITY_SURFACES.find((surface) =>
      surface.id === 'late-bake-module');
    const assemblyMutants = [
      assembly.reference,
      '[String]::Equals($resolvedStreamDataType.Assembly.FullName, ' +
        '$assemblyBuilder.FullName, [System.StringComparison]::Ordinal)',
      '[String]::Equals($resolvedStreamDataType.Module.ScopeName, ' +
        '$moduleBuilder.ScopeName, [System.StringComparison]::Ordinal)',
      '$resolvedStreamDataType.Assembly.IsDynamic',
      '$true',
      '(1 -eq 1)',
    ].map((replacement) => replaceS211ContractSurfaceOnce(
      intended, assembly.wrapperAware, replacement));
    const referenceIdentityMutants = [state, canonical, declaring, moduleIdentity].map(
      (surface) => replaceS211ContractSurfaceOnce(intended, surface.reference,
        surface.reference.replace('[Object]::ReferenceEquals(', '[Object]::Equals(')));

    for (const mutant of [...assemblyMutants, ...referenceIdentityMutants]) {
      assert.throws(() => assertS211WrapperAwareDynamicAssemblyIdentity(mutant));
    }
  });

const S212_CURRENT_TYPE_RESOLVE_STATE_GUARD = [
  'if ($typeResolveState.Requests -ne 1 -or $null -ne $typeResolveState.Failure -or',
  '    $null -eq $typeResolveState.Type) {',
  "  throw 'stream type resolution state invalid'",
  '}',
].join('\n');
const S212_CURRENT_CANONICAL_TYPE_REFERENCE =
  '    -not [Object]::ReferenceEquals($streamDataType, $typeResolveState.Type) -or';
const S212_SELECTED_CANONICAL_TYPE_REFERENCE =
  '    -not [Object]::ReferenceEquals($streamDataType, $selectedStreamDataType) -or';
const S212_CURRENT_OWNED_ASSEMBLY_IDENTITY =
  '    -not [Object]::Equals($streamDataType.Assembly, $assemblyBuilder) -or';
const S212_SELECTED_OWNED_ASSEMBLY_IDENTITY =
  '    -not [Object]::Equals($selectedStreamDataType.Assembly, $assemblyBuilder) -or';
const S212_SELECTED_MODULE_REFERENCE =
  '    -not [Object]::ReferenceEquals($streamDataType.Module, ' +
  '$selectedStreamDataType.Module) -or';
const S212_NATIVE_CREATE_SUCCESS_GUARD =
  "if ($nativeTypeFailure) { throw 'stream native type creation failed' }";
const S212_TWO_MODE_SELECTION_SOURCE = [
  '$selectedStreamDataType = $null',
  'if ($typeResolveState.Requests -eq 1 -and',
  '    $null -eq $typeResolveState.Failure -and',
  '    $null -ne $typeResolveState.Type) {',
  '  $selectedStreamDataType = $typeResolveState.Type',
  '} elseif ($typeResolveState.Requests -eq 0 -and',
  '    $null -eq $typeResolveState.Failure -and',
  '    $null -eq $typeResolveState.Type) {',
  '  try {',
  '    $selectedStreamDataType = $streamDataBuilder.CreateType()',
  '  } catch {',
  "    throw 'stream late nested type creation failed'",
  '  }',
  '  if ($null -eq $selectedStreamDataType) {',
  "    throw 'stream late nested type creation failed'",
  '  }',
  '} else {',
  "  throw 'stream type resolution state invalid'",
  '}',
].join('\n');
const S212_SELECTION_TO_CANONICAL_LOOKUP_SOURCE = [
  S212_TWO_MODE_SELECTION_SOURCE,
  '$nestedTypeFlags = [System.Reflection.BindingFlags]::Public -bor',
  '  [System.Reflection.BindingFlags]::NonPublic',
  "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', $nestedTypeFlags)",
].join('\n');
const S212_NATIVE_SUCCESS_TO_CANONICAL_LOOKUP_SOURCE = [
  S212_NATIVE_CREATE_SUCCESS_GUARD,
  S212_SELECTION_TO_CANONICAL_LOOKUP_SOURCE,
].join('\n');
const S212_BOUNDED_SIGNATURE_LOOP_SOURCE = [
  '  for ($parameterIndex = 0; $parameterIndex -lt $ParameterTypes.Length; ' +
    '$parameterIndex++) {',
  '    if ($actualParameters[$parameterIndex].ParameterType -ne ' +
    '$ParameterTypes[$parameterIndex]) {',
  "      throw 'stream native signature invalid'",
  '    }',
  '  }',
].join('\n');
const S212_EXACT_AUTHENTICATION_SOURCE = [
  '# DEEP_WORK_TYPE_AUTHENTICATION_BEGIN',
  S212_NATIVE_SUCCESS_TO_CANONICAL_LOOKUP_SOURCE,
  'if ($null -eq $streamDataType -or',
  '    -not [String]::Equals($streamDataType.FullName, $expectedStreamDataTypeName,',
  '      [System.StringComparison]::Ordinal) -or',
  S212_SELECTED_CANONICAL_TYPE_REFERENCE,
  '    -not [Object]::ReferenceEquals($streamDataType.DeclaringType, $nativeType) -or',
  S212_SELECTED_OWNED_ASSEMBLY_IDENTITY,
  S212_SELECTED_MODULE_REFERENCE,
  '    -not [String]::Equals($streamDataType.Module.ScopeName, $moduleBuilder.ScopeName,',
  '      [System.StringComparison]::Ordinal)) {',
  "  throw 'stream type identity invalid'",
  '}',
  'if (-not $streamDataType.IsValueType -or -not $streamDataType.IsNestedPublic -or',
  '    -not $streamDataType.IsSealed -or -not $streamDataType.IsLayoutSequential -or',
  '    -not $streamDataType.IsUnicodeClass -or',
  '    ($streamDataType.Attributes -band ' +
    '[System.Reflection.TypeAttributes]::BeforeFieldInit) -eq 0) {',
  "  throw 'stream type layout invalid'",
  '}',
  '$streamFieldFlags = [System.Reflection.BindingFlags]::Public -bor',
  '  [System.Reflection.BindingFlags]::NonPublic -bor',
  '  [System.Reflection.BindingFlags]::Instance -bor',
  '  [System.Reflection.BindingFlags]::Static -bor',
  '  [System.Reflection.BindingFlags]::DeclaredOnly',
  '$streamFields = @($streamDataType.GetFields($streamFieldFlags))',
  "$streamSizeField = $streamDataType.GetField('StreamSize', $streamFieldFlags)",
  "$streamNameRuntimeField = $streamDataType.GetField('cStreamName', $streamFieldFlags)",
  'if ($streamFields.Length -ne 2 -or $null -eq $streamSizeField -or',
  '    $streamSizeField.FieldType -ne [Int64] -or -not $streamSizeField.IsPublic -or',
  '    $streamSizeField.IsStatic -or $null -eq $streamNameRuntimeField -or',
  '    $streamNameRuntimeField.FieldType -ne [String] -or ' +
    '-not $streamNameRuntimeField.IsPublic -or',
  '    $streamNameRuntimeField.IsStatic) {',
  "  throw 'stream type fields invalid'",
  '}',
  '$streamNameMarshal = @($streamNameRuntimeField.GetCustomAttributes(',
  '  [System.Runtime.InteropServices.MarshalAsAttribute], $false))',
  'if ($streamNameMarshal.Length -ne 1 -or',
  '    $streamNameMarshal[0].Value -ne ' +
    '[System.Runtime.InteropServices.UnmanagedType]::ByValTStr -or',
  '    $streamNameMarshal[0].SizeConst -ne 296) {',
  "  throw 'stream type marshal invalid'",
  '}',
  '$nativeMethodFlags = [System.Reflection.BindingFlags]::Public -bor',
  '  [System.Reflection.BindingFlags]::Static -bor',
  '  [System.Reflection.BindingFlags]::DeclaredOnly',
  '$nativeMethods = @($nativeType.GetMethods($nativeMethodFlags))',
  "$findFirstStream = $nativeType.GetMethod('FindFirstStreamW', $nativeMethodFlags)",
  "$findNextStream = $nativeType.GetMethod('FindNextStreamW', $nativeMethodFlags)",
  "$findClose = $nativeType.GetMethod('FindClose', $nativeMethodFlags)",
  'if ($nativeMethods.Length -ne 3 -or $null -eq $findFirstStream -or',
  '    $null -eq $findNextStream -or $null -eq $findClose) {',
  "  throw 'stream native methods invalid'",
  '}',
  '',
  'function Assert-ClosedPInvokeRuntimeMethod(',
  '  [System.Reflection.MethodInfo]$Method,',
  '  [string]$Name,',
  '  [Type]$ReturnType,',
  '  [Type[]]$ParameterTypes,',
  '  [System.Runtime.InteropServices.CharSet]$CharSet',
  ') {',
  '  if (-not [String]::Equals($Method.Name, $Name, ' +
    '[System.StringComparison]::Ordinal) -or',
  '      $Method.ReturnType -ne $ReturnType) {',
  "    throw 'stream native signature invalid'",
  '  }',
  '  $actualParameters = @($Method.GetParameters())',
  '  if ($actualParameters.Length -ne $ParameterTypes.Length) {',
  "    throw 'stream native signature invalid'",
  '  }',
  S212_BOUNDED_SIGNATURE_LOOP_SOURCE,
  '  $imports = @($Method.GetCustomAttributes(',
  '    [System.Runtime.InteropServices.DllImportAttribute], $false))',
  '  if ($imports.Length -ne 1 -or',
  "      -not [String]::Equals($imports[0].Value, 'kernel32.dll',",
  '        [System.StringComparison]::Ordinal) -or',
  '      -not [String]::Equals($imports[0].EntryPoint, $Name,',
  '        [System.StringComparison]::Ordinal) -or',
  '      $imports[0].CharSet -ne $CharSet -or',
  '      $imports[0].CallingConvention -ne ' +
    '[System.Runtime.InteropServices.CallingConvention]::Winapi -or',
  '      -not $imports[0].SetLastError -or -not $imports[0].ExactSpelling -or',
  '      -not $imports[0].PreserveSig -or',
  '      ($Method.GetMethodImplementationFlags() -band',
  '        [System.Reflection.MethodImplAttributes]::PreserveSig) -eq 0) {',
  "    throw 'stream native import invalid'",
  '  }',
  '}',
  '',
  ...windowsStreamRuntimeAttestationLines(),
  '',
].join('\n');
const S212_RESIDUAL_LOOP_PATTERN =
  /(?:^|[\s;{}])(?:for|foreach|while)\s*\(|(?:^|[\s;{}])do(?=\s*\{)/iu;
const S212_FORBIDDEN_AUTHENTICATION_PATTERNS = [
  {
    label:'file or item-provider access',
    pattern:/\b(?:get|set|new|remove|move|copy|rename|clear)-item(?:property)?\b|\bget-childitem\b|\b(?:get|set|add|clear)-content\b|\[\s*system\.io\.[^\]]+\]\s*::/iu,
  },
  {
    label:'module access',
    pattern:/\b(?:get|import|remove|new)-module\b/iu,
  },
  {
    label:'environment access',
    pattern:/\$env:|\[\s*(?:system\.)?environment\s*\]\s*::/iu,
  },
  {
    label:'registry access',
    pattern:/\b(?:hkcu|hklm|hkcr|hku|hkcc):\s*\\|\bregistry::|\[\s*(?:microsoft\.)?win32\.registry[^\]]*\]\s*::/iu,
  },
  {
    label:'dynamic execution',
    pattern:/\b(?:add-type|invoke-expression|iex|invoke-command|invoke-item|foreach-object)\b|\[\s*(?:system\.)?scriptblock\s*\]\s*::/iu,
  },
  {
    label:'dynamic output',
    pattern:/\bwrite-(?:error|output|host|information|warning|verbose|debug)\b|\[\s*(?:system\.)?console\s*\]\s*::|\bthrow\s+\$/iu,
  },
  {
    label:'external process',
    pattern:/\b(?:start-process|wait-process)\b|\[\s*system\.diagnostics\.process\s*\]\s*::/iu,
  },
  {
    label:'retry or sleep',
    pattern:/\b(?:start-sleep|retry)\b|\[\s*system\.threading\.thread\s*\]\s*::\s*sleep\b/iu,
  },
];

function s212IntendedNoDispatchLateBakeFixture() {
  return [
    "$expectedStreamDataTypeName = 'DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA'",
    '# DEEP_WORK_TYPE_RESOLVE_HANDLER_BEGIN',
    '$typeResolveCallback = {',
    '  param($sender, $eventArgs)',
    '  $typeResolveState.Requests++',
    '  $resolvedStreamDataType = $streamDataBuilder.CreateType()',
    '  $typeResolveState.Type = $resolvedStreamDataType',
    '  return $assemblyBuilder',
    '}.GetNewClosure()',
    '$typeResolveHandler = [System.ResolveEventHandler]$typeResolveCallback',
    '# DEEP_WORK_TYPE_RESOLVE_HANDLER_END',
    '# DEEP_WORK_TYPE_RESOLVE_SCOPE_BEGIN',
    '$currentDomain = [AppDomain]::CurrentDomain',
    '$nativeTypeFailure = $false',
    '$currentDomain.add_TypeResolve($typeResolveHandler)',
    'try {',
    '  $nativeType = $nativeBuilder.CreateType()',
    '} catch {',
    '  $nativeTypeFailure = $true',
    '} finally {',
    '  $currentDomain.remove_TypeResolve($typeResolveHandler)',
    '}',
    '# DEEP_WORK_TYPE_RESOLVE_SCOPE_END',
    `${S212_EXACT_AUTHENTICATION_SOURCE}# DEEP_WORK_TYPE_AUTHENTICATION_END`,
  ].join('\n');
}

function assertS212NoDispatchLateBakeRemediationContract(source) {
  const handlerBegin = '# DEEP_WORK_TYPE_RESOLVE_HANDLER_BEGIN';
  const handlerEnd = '# DEEP_WORK_TYPE_RESOLVE_HANDLER_END';
  const scopeBegin = '# DEEP_WORK_TYPE_RESOLVE_SCOPE_BEGIN';
  const scopeEnd = '# DEEP_WORK_TYPE_RESOLVE_SCOPE_END';
  const authenticationBegin = '# DEEP_WORK_TYPE_AUTHENTICATION_BEGIN';
  const authenticationEnd = '# DEEP_WORK_TYPE_AUTHENTICATION_END';
  for (const marker of [handlerBegin, handlerEnd, scopeBegin, scopeEnd,
    authenticationBegin, authenticationEnd]) {
    assert.equal(countLiteral(source, marker), 1, `S2.12 source marker: ${marker}`);
  }

  const handlerStart = source.indexOf(handlerBegin);
  const handlerStop = source.indexOf(handlerEnd);
  const scopeStart = source.indexOf(scopeBegin);
  const scopeStop = source.indexOf(scopeEnd);
  const authenticationStart = source.indexOf(authenticationBegin);
  const authenticationStop = source.indexOf(authenticationEnd);
  assert.equal(handlerStart < handlerStop && handlerStop < scopeStart &&
    scopeStart < scopeStop && scopeStop < authenticationStart &&
    authenticationStart < authenticationStop, true, 'S2.12 section order');

  const handler = source.slice(handlerStart, handlerStop);
  const scope = source.slice(scopeStart, scopeStop);
  const authentication = source.slice(authenticationStart, authenticationStop);
  assert.equal(authentication, S212_EXACT_AUTHENTICATION_SOURCE,
    'S2.12 exact closed authentication source');
  const nativeSuccessGuardIndex = authentication.indexOf(
    S212_NATIVE_CREATE_SUCCESS_GUARD);
  const selectionIndex = authentication.indexOf(S212_TWO_MODE_SELECTION_SOURCE);
  const canonicalLookupIndex = authentication.indexOf(
    "$nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', $nestedTypeFlags)");
  const modeSelectionRegion = selectionIndex >= 0 && canonicalLookupIndex > selectionIndex
    ? authentication.slice(selectionIndex, canonicalLookupIndex) : '';
  assert.deepEqual({
    exactSelectionCount:countLiteral(authentication, S212_TWO_MODE_SELECTION_SOURCE),
    currentStateGuardCount:countLiteral(authentication,
      S212_CURRENT_TYPE_RESOLVE_STATE_GUARD),
    selectedCanonicalReferenceCount:countLiteral(authentication,
      S212_SELECTED_CANONICAL_TYPE_REFERENCE),
    currentCanonicalReferenceCount:countLiteral(authentication,
      S212_CURRENT_CANONICAL_TYPE_REFERENCE),
    selectedOwnedAssemblyCount:countLiteral(authentication,
      S212_SELECTED_OWNED_ASSEMBLY_IDENTITY),
    currentOwnedAssemblyCount:countLiteral(authentication,
      S212_CURRENT_OWNED_ASSEMBLY_IDENTITY),
    selectedModuleReferenceCount:countLiteral(authentication,
      S212_SELECTED_MODULE_REFERENCE),
    exactSelectionToCanonicalCount:countLiteral(authentication,
      S212_SELECTION_TO_CANONICAL_LOOKUP_SOURCE),
    nativeCreateSuccessGuardCount:countLiteral(authentication,
      S212_NATIVE_CREATE_SUCCESS_GUARD),
    exactNativeSuccessToCanonicalCount:countLiteral(authentication,
      S212_NATIVE_SUCCESS_TO_CANONICAL_LOOKUP_SOURCE),
    boundedSignatureLoopCount:countLiteral(authentication,
      S212_BOUNDED_SIGNATURE_LOOP_SOURCE),
    nativeSuccessBeforeSelection:nativeSuccessGuardIndex >= 0 &&
      nativeSuccessGuardIndex < selectionIndex,
    selectionAfterScope:scopeStop < authenticationStart + selectionIndex,
    selectionBeforeCanonicalLookup:selectionIndex >= 0 &&
      selectionIndex < canonicalLookupIndex,
  }, {
    exactSelectionCount:1,
    currentStateGuardCount:0,
    selectedCanonicalReferenceCount:1,
    currentCanonicalReferenceCount:0,
    selectedOwnedAssemblyCount:1,
    currentOwnedAssemblyCount:0,
    selectedModuleReferenceCount:1,
    exactSelectionToCanonicalCount:1,
    nativeCreateSuccessGuardCount:1,
    exactNativeSuccessToCanonicalCount:1,
    boundedSignatureLoopCount:1,
    nativeSuccessBeforeSelection:true,
    selectionAfterScope:true,
    selectionBeforeCanonicalLookup:true,
  }, 'S2.12 exact callback/no-dispatch selection');

  assert.deepEqual({
    registrationCount:countLiteral(source, '.add_TypeResolve($typeResolveHandler)'),
    removalCount:countLiteral(source, '.remove_TypeResolve($typeResolveHandler)'),
    nativeCreateCount:countLiteral(source, '$nativeBuilder.CreateType()'),
    nestedCreateCount:countLiteral(source, '$streamDataBuilder.CreateType()'),
    handlerNestedCreateCount:countLiteral(handler, '$streamDataBuilder.CreateType()'),
    scopeNestedCreateCount:countLiteral(scope, '$streamDataBuilder.CreateType()'),
    authenticationNestedCreateCount:countLiteral(authentication,
      '$streamDataBuilder.CreateType()'),
  }, {
    registrationCount:1,
    removalCount:1,
    nativeCreateCount:1,
    nestedCreateCount:2,
    handlerNestedCreateCount:1,
    scopeNestedCreateCount:0,
    authenticationNestedCreateCount:1,
  }, 'S2.12 closed construction counts');
  assert.match(scope,
    /\.add_TypeResolve\(\$typeResolveHandler\)[\s\S]*try \{[\s\S]*\$nativeType = \$nativeBuilder\.CreateType\(\)[\s\S]*\} finally \{\n  \$currentDomain\.remove_TypeResolve\(\$typeResolveHandler\)\n\}/u,
    'S2.12 handler lifetime and native creation');

  for (const exact of [
    'if ($typeResolveState.Requests -eq 1 -and',
    '} elseif ($typeResolveState.Requests -eq 0 -and',
    '  $selectedStreamDataType = $typeResolveState.Type',
    '    $selectedStreamDataType = $streamDataBuilder.CreateType()',
    '  if ($null -eq $selectedStreamDataType) {',
    "    throw 'stream late nested type creation failed'",
    "  throw 'stream type resolution state invalid'",
  ]) {
    assert.equal(countLiteral(authentication, exact), exact.includes('late nested') ? 2 : 1,
      `S2.12 exact state-machine surface: ${exact}`);
  }
  assert.equal(countLiteral(authentication, '$null -eq $typeResolveState.Failure'), 2,
    'S2.12 both success modes require null resolver failure');
  assert.equal(countLiteral(authentication, '$null -ne $typeResolveState.Type'), 1,
    'S2.12 callback requires the recorded type');
  assert.equal(countLiteral(authentication, '$null -eq $typeResolveState.Type'), 1,
    'S2.12 no-dispatch requires no recorded type');
  assert.equal(countLiteral(authentication, 'try {'), 1,
    'S2.12 late bake is one fixed attempt');
  assert.equal(countLiteral(authentication, '} catch {'), 1,
    'S2.12 late-bake exception is fail-closed');

  for (const required of [
    "if ($nativeTypeFailure) { throw 'stream native type creation failed' }",
    ".GetNestedType('WIN32_FIND_STREAM_DATA', $nestedTypeFlags)",
    '$streamDataType.FullName, $expectedStreamDataTypeName',
    '[Object]::ReferenceEquals($streamDataType.DeclaringType, $nativeType)',
    S212_SELECTED_OWNED_ASSEMBLY_IDENTITY,
    S212_SELECTED_MODULE_REFERENCE,
    '$streamDataType.Module.ScopeName',
    "'stream type identity invalid'", "'stream type layout invalid'",
    "'stream type fields invalid'", "'stream type marshal invalid'",
    "'stream native methods invalid'", "'stream native signature invalid'",
    "'stream native import invalid'",
  ]) {
    assert.equal(authentication.includes(required), true,
      `S2.12 preserved authentication surface: ${required}`);
  }
  for (const {label, pattern} of S212_FORBIDDEN_AUTHENTICATION_PATTERNS) {
    assert.doesNotMatch(authentication, pattern,
      `S2.12 forbidden authentication surface: ${label}`);
  }
  const authenticationWithoutBoundedSignatureLoop = authentication.replace(
    S212_BOUNDED_SIGNATURE_LOOP_SOURCE, '');
  assert.doesNotMatch(authenticationWithoutBoundedSignatureLoop,
    S212_RESIDUAL_LOOP_PATTERN, 'S2.12 only the fixed bounded signature loop is allowed');
  assert.doesNotMatch(modeSelectionRegion, S212_RESIDUAL_LOOP_PATTERN,
    'S2.12 no loop in mode selection');
}

function s212MoveSelectionBeforeHandlerRemoval(source) {
  const withoutSelection = replaceWindowsStreamSourceOnce(source,
    `${S212_TWO_MODE_SELECTION_SOURCE}\n`, '');
  return replaceWindowsStreamSourceOnce(withoutSelection,
    '# DEEP_WORK_TYPE_RESOLVE_SCOPE_END',
    `${S212_TWO_MODE_SELECTION_SOURCE}\n# DEEP_WORK_TYPE_RESOLVE_SCOPE_END`);
}

function s212AppendAfterCanonicalLookup(source, addition) {
  const canonicalLookup =
    "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', " +
    '$nestedTypeFlags)';
  return replaceWindowsStreamSourceOnce(source, canonicalLookup,
    `${canonicalLookup}\n${addition}`);
}

function s212MoveNativeSuccessGuardAfterCanonicalLookup(source) {
  const withoutGuard = replaceWindowsStreamSourceOnce(source,
    `${S212_NATIVE_CREATE_SUCCESS_GUARD}\n`, '');
  return s212AppendAfterCanonicalLookup(withoutGuard,
    S212_NATIVE_CREATE_SUCCESS_GUARD);
}

const S212_DOCUMENTED_CURRENT_FACTORY_SELECTION_SOURCE = [
  '$staticFactory = [System.Reflection.Emit.AssemblyBuilder].GetMethods() |',
  '  Where-Object {',
  "    $_.Name -eq 'DefineDynamicAssembly' -and $_.IsStatic -and",
  '    $_.GetParameters().Length -eq 2',
  '  } | Select-Object -First 1',
].join('\n');
const S212_DOCUMENTED_FACTORY_FORBIDDEN_COMMANDS = Object.freeze(new Map([
  ['select-object', 'Select-Object/select'],
  ['select', 'Select-Object/select'],
  ['foreach-object', 'ForEach-Object'],
  ['%', 'pipeline iteration alias'],
  ['foreach', 'pipeline iteration alias/loop'],
  ['for', 'loop'],
  ['while', 'loop'],
  ['do', 'loop'],
  ['start-sleep', 'sleep'],
  ['sleep', 'sleep'],
  ['start-process', 'external process command'],
  ['saps', 'external process command'],
  ['start', 'external process command'],
]));
const S212_DOCUMENTED_FACTORY_ALLOWED_KEYWORDS = Object.freeze(new Map([
  ['if', 'PowerShell conditional keyword'],
  ['elseif', 'PowerShell conditional keyword'],
  ['else', 'PowerShell conditional keyword'],
  ['try', 'PowerShell exception keyword'],
  ['catch', 'PowerShell exception keyword'],
  ['finally', 'PowerShell exception keyword'],
  ['param', 'PowerShell parameter keyword'],
  ['return', 'PowerShell return keyword'],
  ['throw', 'PowerShell throw keyword'],
]));
const S212_DOCUMENTED_FACTORY_ALLOWED_CMDLETS = Object.freeze(new Map([
  ['microsoft.powershell.core\\where-object',
    'exact Microsoft.PowerShell.Core\\Where-Object cmdlet identity'],
  ['microsoft.powershell.utility\\write-output',
    'exact Microsoft.PowerShell.Utility\\Write-Output cmdlet identity'],
]));
const S212_DOCUMENTED_FACTORY_ALLOWED_MEMBER_CALLS = Object.freeze(new Set([
  'add_typeresolve',
  'close',
  'createtype',
  'definedynamicassembly',
  'definedynamicmodule',
  'definefield',
  'definenestedtype',
  'definetype',
  'equals',
  'format',
  'getfields',
  'getcurrentprocess',
  'getmethods',
  'getnestedtype',
  'getnewclosure',
  'getparameters',
  'getvalue',
  'getvaluekind',
  'invoke',
  'new',
  'openbasekey',
  'opensubkey',
  'referenceequals',
  'remove_typeresolve',
  'restart',
  'tryparse',
  'writeline',
]));
const S212_POWERSHELL_CODE_ESCAPE = '\u{E000}';
const S212_POWERSHELL_TOKEN_START_BOUNDARY = /[\t\r\n ;|&,(){}=<>]/u;

function s212MaskPowerShellNonExecutable(source) {
  const masked = Array.from(source, (character) =>
    character === '\n' || character === '\r' ? character : ' ');
  const errors = [];
  const keep = (index) => { masked[index] = source[index]; };
  const isHereStringStart = (index) =>
    source[index] === '@' && (source[index + 1] === "'" || source[index + 1] === '"') &&
    (source[index + 2] === '\n' ||
      (source[index + 2] === '\r' && source[index + 3] === '\n'));
  const isLineCommentStart = (index) => index === 0 ||
    S212_POWERSHELL_TOKEN_START_BOUNDARY.test(source[index - 1]);

  function findHereStringEnd(start, quote) {
    for (let index = start; index < source.length - 1; index += 1) {
      if ((index === 0 || source[index - 1] === '\n') &&
          source[index] === quote && source[index + 1] === '@') {
        const after = index + 2;
        if (after === source.length || source[after] === '\n' ||
            (source[after] === '\r' && source[after + 1] === '\n')) return index;
      }
    }
    return -1;
  }

  function scanBacktickEscape(start, end = source.length, preserveCodeEscape = false) {
    let stop = Math.min(start + 2, end);
    if (source[start + 1] === '\r' && source[start + 2] === '\n') {
      stop = Math.min(start + 3, end);
    }
    for (let index = start; index < stop; index += 1) masked[index] = ' ';
    if (stop === start + 1) errors.push(`unterminated backtick escape at ${start}`);
    if (preserveCodeEscape && stop > start + 1) {
      masked[start] = S212_POWERSHELL_CODE_ESCAPE;
    }
    return stop;
  }

  function scanLineComment(start) {
    let index = start;
    while (index < source.length && source[index] !== '\n') index += 1;
    return index;
  }

  function scanBlockComment(start) {
    const end = source.indexOf('#>', start + 2);
    if (end < 0) {
      errors.push(`unterminated block comment at ${start}`);
      return source.length;
    }
    return end + 2;
  }

  function scanQuoted(start, quote) {
    let index = start + 1;
    while (index < source.length) {
      if (quote === "'" && source[index] === "'" && source[index + 1] === "'") {
        index += 2;
        continue;
      }
      if (quote === '"' && source[index] === '`') {
        index = scanBacktickEscape(index);
        continue;
      }
      if (quote === '"' && source[index] === '$' && source[index + 1] === '(') {
        keep(index);
        keep(index + 1);
        index = scanCode(index + 2, true);
        continue;
      }
      if (source[index] === quote) return index + 1;
      index += 1;
    }
    errors.push(`unterminated ${quote} string at ${start}`);
    return source.length;
  }

  function scanHereString(start) {
    const quote = source[start + 1];
    const bodyStart = source[start + 2] === '\r' ? start + 4 : start + 3;
    const end = findHereStringEnd(bodyStart, quote);
    if (end < 0) {
      errors.push(`unterminated ${quote} here-string at ${start}`);
      return source.length;
    }
    if (quote === '"') {
      let index = bodyStart;
      while (index < end) {
        if (source[index] === '`') {
          index = scanBacktickEscape(index, end);
          continue;
        }
        if (source[index] === '$' && source[index + 1] === '(') {
          keep(index);
          keep(index + 1);
          index = scanCode(index + 2, true);
          if (index > end) errors.push(`subexpression escaped here-string at ${start}`);
          continue;
        }
        index += 1;
      }
    }
    return end + 2;
  }

  function scanCode(start, stopAtClosingParen = false) {
    let depth = stopAtClosingParen ? 1 : 0;
    let index = start;
    while (index < source.length) {
      if (source.startsWith('<#', index)) {
        index = scanBlockComment(index);
        continue;
      }
      if (source[index] === '#' && isLineCommentStart(index)) {
        index = scanLineComment(index);
        continue;
      }
      if (isHereStringStart(index)) {
        index = scanHereString(index);
        continue;
      }
      if (source[index] === "'" || source[index] === '"') {
        index = scanQuoted(index, source[index]);
        continue;
      }
      if (source[index] === '`') {
        index = scanBacktickEscape(index, source.length, true);
        continue;
      }
      keep(index);
      if (stopAtClosingParen && source[index] === '(') depth += 1;
      if (stopAtClosingParen && source[index] === ')') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    if (stopAtClosingParen) errors.push(`unterminated subexpression at ${start - 2}`);
    return source.length;
  }

  scanCode(0);
  return Object.freeze({source:masked.join(''), errors:Object.freeze(errors)});
}

function s212FindForbiddenPowerShellCommandSurfaces(source) {
  const lexical = s212MaskPowerShellNonExecutable(source);
  const executable = lexical.source;
  const findings = [];
  const lexicalErrors = [...lexical.errors];
  const braceKinds = [];
  let commandStart = true;

  const nextSignificantIndex = (start) => {
    let index = start;
    while (index < executable.length && /[\t \r\n]/u.test(executable[index])) index += 1;
    return index;
  };
  const nextOriginalNonWhitespaceIndex = (start) => {
    let index = start;
    while (index < source.length && /[\t \r\n]/u.test(source[index])) index += 1;
    return index;
  };
  const previousSignificantCharacter = (start) => {
    let index = start;
    while (index >= 0 && /[\t \r\n]/u.test(executable[index])) index -= 1;
    return index >= 0 ? executable[index] : '';
  };
  const isAssignment = (index) => executable[index] === '=' &&
    !/[=!<>]/u.test(executable[index - 1] ?? '') &&
    !/[=>]/u.test(executable[index + 1] ?? '');
  const isPowerShellLabelStart = (character) => /[\p{L}_]/u.test(character ?? '');
  const isPowerShellLabelContinue = (character) =>
    /[\p{L}\p{M}\p{Nd}_-]/u.test(character ?? '');
  const isCommandTokenCharacter = (character) =>
    /[\p{L}\p{M}\p{Nd}\p{Pc}_.:/\\%-]/u.test(character ?? '');
  const isMergingRedirectionAmpersand = (index) => executable[index - 1] === '>' &&
    /[0-9*]/u.test(executable[index - 2] ?? '') &&
    /[0-9]/u.test(executable[index + 1] ?? '');
  const codeEscapeWidth = (index) =>
    source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2;
  const escapedCodeCharacter = (index) => source[index + 1] ?? '';
  const scanCommandToken = (start) => {
    let index = start;
    let normalized = '';
    let usedCodeEscape = false;
    while (index < executable.length) {
      if (isCommandTokenCharacter(executable[index])) {
        normalized += executable[index];
        index += 1;
        continue;
      }
      if (executable[index] === S212_POWERSHELL_CODE_ESCAPE &&
          isCommandTokenCharacter(escapedCodeCharacter(index))) {
        usedCodeEscape = true;
        normalized += escapedCodeCharacter(index);
        index += codeEscapeWidth(index);
        continue;
      }
      break;
    }
    return {index, normalized, usedCodeEscape};
  };
  const scanMemberIdentifier = (start) => {
    let index = start;
    let normalized = '';
    let usedCodeEscape = false;
    while (index < executable.length) {
      if (isPowerShellLabelContinue(executable[index])) {
        normalized += executable[index];
        index += 1;
        continue;
      }
      if (executable[index] === S212_POWERSHELL_CODE_ESCAPE) {
        usedCodeEscape = true;
        if (isPowerShellLabelContinue(escapedCodeCharacter(index))) {
          normalized += escapedCodeCharacter(index);
        }
        index += codeEscapeWidth(index);
        continue;
      }
      break;
    }
    return {index, normalized, usedCodeEscape};
  };
  const scanBracedVariable = (start) => {
    let index = start + 2;
    while (index < executable.length) {
      if (executable[index] === S212_POWERSHELL_CODE_ESCAPE) {
        index += codeEscapeWidth(index);
        continue;
      }
      if (executable[index] === '}') return index + 1;
      if (executable[index] === '\r' || executable[index] === '\n') {
        lexicalErrors.push(`unterminated braced variable at ${start}`);
        return index;
      }
      index += 1;
    }
    lexicalErrors.push(`unterminated braced variable at ${start}`);
    return executable.length;
  };
  const addFinding = (label, index, token) => findings.push(Object.freeze({
    label, index, token,
  }));

  const memberDelimiterPattern = /(?:::|\.)\s*/gu;
  for (const match of executable.matchAll(memberDelimiterPattern)) {
    const memberStart = match.index + match[0].length;
    const member = scanMemberIdentifier(memberStart);
    const originalMemberStart = nextOriginalNonWhitespaceIndex(memberStart);
    if (member.normalized.length === 0 &&
        /[$('"`@{\[]/u.test(source[originalMemberStart] ?? '')) {
      addFinding('dynamic .NET/member invocation', originalMemberStart,
        source.slice(originalMemberStart, Math.min(source.length, originalMemberStart + 32)));
    }
    if (member.usedCodeEscape && member.normalized.length > 0 &&
        executable[nextSignificantIndex(member.index)] === '(') {
      addFinding('PowerShell code escape in executable member identifier',
        memberStart, source.slice(memberStart, member.index));
    }
    if (member.normalized.length > 0 &&
        executable[nextSignificantIndex(member.index)] === '(' &&
        !S212_DOCUMENTED_FACTORY_ALLOWED_MEMBER_CALLS.has(
          member.normalized.toLowerCase())) {
      addFinding('unapproved .NET/member invocation', memberStart,
        source.slice(memberStart, member.index));
    }
  }

  const processTypePattern =
    /\[\s*(?:(?:system\s*\.\s*)?diagnostics\s*\.\s*)?(?:process\s*\]\s*::\s*start\b|processstartinfo\s*\])/igu;
  for (const match of executable.matchAll(processTypePattern)) {
    addFinding('.NET process launch', match.index, match[0]);
  }
  const processCapableInstanceStartPattern = /\.\s*start\s*\(/igu;
  for (const match of executable.matchAll(processCapableInstanceStartPattern)) {
    addFinding('.NET/process-capable instance launch', match.index, match[0]);
  }
  const powershellExecutionTypePattern =
    /\[\s*(?:(?:system\s*\.\s*)?management\s*\.\s*automation\s*\.\s*)?powershell\s*\]\s*::\s*create\b/igu;
  for (const match of executable.matchAll(powershellExecutionTypePattern)) {
    addFinding('.NET PowerShell script execution', match.index, match[0]);
  }
  const runspaceExecutionTypePattern =
    /\[\s*(?:(?:system\s*\.\s*)?management\s*\.\s*automation\s*\.\s*runspaces\s*\.\s*)?runspacefactory\s*\]\s*::\s*create(?:runspace|runspacepool)\b/igu;
  for (const match of executable.matchAll(runspaceExecutionTypePattern)) {
    addFinding('.NET PowerShell runspace execution', match.index, match[0]);
  }
  const scriptExecutionMethodPattern =
    /\.\s*(?:addscript|addcommand|begininvoke|invokeasync|invokescript|invokereturnasis|invokewithcontext|newscriptblock|createnestedpipeline)\s*\(/igu;
  for (const match of executable.matchAll(scriptExecutionMethodPattern)) {
    addFinding('.NET PowerShell script/runspace method execution', match.index, match[0]);
  }
  const scriptBlockConstructionPattern =
    /\[\s*(?:(?:system\s*\.\s*)?management\s*\.\s*automation\s*\.\s*)?scriptblock\s*\]\s*::\s*create\b/igu;
  for (const match of executable.matchAll(scriptBlockConstructionPattern)) {
    addFinding('.NET PowerShell ScriptBlock construction', match.index, match[0]);
  }
  const allowedFactoryInvokeStart = executable.indexOf(EXPECTED_WINDOWS_FACTORY_INVOCATION);
  const allowedFactoryInvokeDot = allowedFactoryInvokeStart < 0 ? -1 :
    allowedFactoryInvokeStart + EXPECTED_WINDOWS_FACTORY_INVOCATION.indexOf('.Invoke(');
  const reflectionInvokePattern = /\.\s*invoke\s*\(/igu;
  for (const match of executable.matchAll(reflectionInvokePattern)) {
    if (match.index !== allowedFactoryInvokeDot ||
        match[0] !== '.Invoke(' ||
        countLiteral(executable, EXPECTED_WINDOWS_FACTORY_INVOCATION) !== 1) {
      addFinding('.NET reflection/method invocation', match.index, match[0]);
    }
  }
  const reflectionExecutionPattern =
    /(?:::|\.)\s*(?:invokemember|createdelegate|dynamicinvoke)\s*\(/igu;
  for (const match of executable.matchAll(reflectionExecutionPattern)) {
    addFinding('.NET reflection/delegate execution', match.index, match[0]);
  }

  for (let index = 0; index < executable.length;) {
    const character = executable[index];
    if (character === '\n' || character === '\r' || character === ';' ||
        character === '|') {
      commandStart = true;
      index += 1;
      continue;
    }
    if (character === '{') {
      braceKinds.push(previousSignificantCharacter(index - 1) === '@' ? 'hashtable' : 'script');
      commandStart = true;
      index += 1;
      continue;
    }
    if (character === '}') {
      braceKinds.pop();
      commandStart = true;
      index += 1;
      continue;
    }
    if (character === '(') {
      commandStart = true;
      index += 1;
      continue;
    }
    if (isAssignment(index)) {
      commandStart = true;
      index += 1;
      continue;
    }
    if (/[\t ]/u.test(character)) {
      index += 1;
      continue;
    }
    if (commandStart && character === ':' &&
        isPowerShellLabelStart(executable[index + 1])) {
      index += 2;
      while (index < executable.length &&
             isPowerShellLabelContinue(executable[index])) {
        index += 1;
      }
      continue;
    }
    if (character === '&' && executable[index - 1] !== '&' &&
        executable[index + 1] !== '&' && !isMergingRedirectionAmpersand(index)) {
      addFinding('call operator', index, '&');
      commandStart = true;
      index += 1;
      continue;
    }
    if (character === '$') {
      commandStart = false;
      if (executable[index + 1] === '{') {
        index = scanBracedVariable(index);
        continue;
      }
      index += 1;
      while (index < executable.length && /[\w?:]/u.test(executable[index])) index += 1;
      continue;
    }
    if (character === S212_POWERSHELL_CODE_ESCAPE &&
        !isCommandTokenCharacter(escapedCodeCharacter(index))) {
      commandStart = false;
      index += codeEscapeWidth(index);
      continue;
    }
    if (!isCommandTokenCharacter(character) &&
        !(character === S212_POWERSHELL_CODE_ESCAPE &&
          isCommandTokenCharacter(escapedCodeCharacter(index)))) {
      if (commandStart && character.codePointAt(0) > 0x7f) {
        addFinding('unrecognized non-ASCII command start', index, character);
      }
      commandStart = false;
      index += 1;
      continue;
    }

    const tokenStart = index;
    const scannedToken = scanCommandToken(index);
    index = scannedToken.index;
    const token = scannedToken.normalized;
    if (!commandStart) continue;
    const expressionToken = token.toLowerCase();
    if (/^(?:0|[1-9][0-9]*)$/u.test(expressionToken) || expressionToken === '-not' ||
        (expressionToken === '.getnewclosure' &&
         previousSignificantCharacter(tokenStart - 1) === '}' &&
         executable.startsWith('()', index) &&
         (index + 2 === executable.length || /[;\r\n]/u.test(executable[index + 2])))) {
      commandStart = false;
      continue;
    }
    const adjacentOriginal = source[index] ?? '';
    if (scannedToken.usedCodeEscape ||
        adjacentOriginal === '$' || adjacentOriginal === '`' ||
        adjacentOriginal === "'" || adjacentOriginal === '"' ||
        adjacentOriginal === '@') {
      addFinding('dynamic command-token continuation', tokenStart,
        source.slice(tokenStart, Math.min(source.length, index + 2)));
    }
    const next = nextSignificantIndex(index);
    const hashtableKey = braceKinds.at(-1) === 'hashtable' && isAssignment(next);
    if (hashtableKey) {
      commandStart = false;
      continue;
    }
    const commandName = token.toLowerCase();
    const unqualifiedCommandName = commandName.slice(commandName.lastIndexOf('\\') + 1);
    const forbiddenLabel = S212_DOCUMENTED_FACTORY_FORBIDDEN_COMMANDS.get(
      unqualifiedCommandName);
    if (forbiddenLabel) {
      addFinding(forbiddenLabel, tokenStart, token);
    } else if (!S212_DOCUMENTED_FACTORY_ALLOWED_KEYWORDS.has(commandName) &&
               !S212_DOCUMENTED_FACTORY_ALLOWED_CMDLETS.has(commandName)) {
      addFinding('unapproved command start/native resolution', tokenStart, token);
    }
    commandStart = false;
  }
  return Object.freeze({
    lexicalErrors:Object.freeze(lexicalErrors),
    findings:Object.freeze(findings),
  });
}

function s212IntendedDocumentedFactorySelectionFixture() {
  return documentedTypeResolveDiagnosticScript();
}

function assertS212DocumentedFactorySelectionIsBounded(source) {
  const factoryEnter = typeResolveStageLine('documented', 'factory-search-enter');
  const factoryReturn = typeResolveStageLine('documented', 'factory-search-return');
  const selectionIndex = source.indexOf(EXPECTED_WINDOWS_FACTORY_SELECTION_SOURCE);
  const invocationIndex = source.indexOf(EXPECTED_WINDOWS_FACTORY_INVOCATION);
  assert.deepEqual({
    exactSelectionCount:countLiteral(source, EXPECTED_WINDOWS_FACTORY_SELECTION_SOURCE),
    candidateVariableCount:countLiteral(source, '$staticFactoryCandidates'),
    directIndexCount:countLiteral(source, EXPECTED_WINDOWS_FACTORY_DIRECT_INDEX),
    exactInvocationCount:countLiteral(source, EXPECTED_WINDOWS_FACTORY_INVOCATION),
    ordered:source.indexOf(factoryEnter) < selectionIndex && selectionIndex >= 0 &&
      selectionIndex < source.indexOf(factoryReturn) &&
      source.indexOf(factoryReturn) < invocationIndex,
  }, {
    exactSelectionCount:1,
    candidateVariableCount:2,
    directIndexCount:1,
    exactInvocationCount:1,
    ordered:true,
  }, 'S2.12 bounded documented TypeResolve factory selection');
  const commandSurfaces = s212FindForbiddenPowerShellCommandSurfaces(source);
  assert.deepEqual(commandSurfaces.lexicalErrors, [],
    'S2.12 documented factory PowerShell is lexically closed');
  if (commandSurfaces.findings.length > 0) {
    const finding = commandSurfaces.findings[0];
    assert.fail(`S2.12 forbidden documented factory control: ${finding.label} ` +
      `at ${finding.index}: ${finding.token}`);
  }
}

test('expected Windows no-dispatch late-bake remediation contract', () => {
  assertS212NoDispatchLateBakeRemediationContract(windowsStreamPInvokeSource());
});

test('Windows no-dispatch late-bake detector rejects invalid states', () => {
  const intended = s212IntendedNoDispatchLateBakeFixture();
  assert.doesNotThrow(() => assertS212NoDispatchLateBakeRemediationContract(intended));

  const mutants = [
    replaceWindowsStreamSourceOnce(intended,
      '} elseif ($typeResolveState.Requests -eq 0 -and',
      '} elseif ($typeResolveState.Requests -ge 0 -and'),
    replaceWindowsStreamSourceOnce(intended,
      '    $null -eq $typeResolveState.Failure -and\n' +
        '    $null -eq $typeResolveState.Type) {',
      '    $null -eq $typeResolveState.Type) {'),
    replaceWindowsStreamSourceOnce(intended,
      '    $null -eq $typeResolveState.Type) {',
      '    $null -ne $typeResolveState.Type) {'),
    replaceWindowsStreamSourceOnce(intended,
      '  $selectedStreamDataType = $typeResolveState.Type',
      '  $selectedStreamDataType = $streamDataBuilder.CreateType()'),
    replaceWindowsStreamSourceOnce(intended,
      '  try {\n    $selectedStreamDataType = $streamDataBuilder.CreateType()\n  } catch {',
      '  $selectedStreamDataType = $streamDataBuilder.CreateType()\n  if ($false) {'),
    replaceWindowsStreamSourceOnce(intended,
      '  if ($null -eq $selectedStreamDataType) {',
      '  if ($false) {'),
    replaceWindowsStreamSourceOnce(intended,
      S212_SELECTED_CANONICAL_TYPE_REFERENCE,
      S212_SELECTED_CANONICAL_TYPE_REFERENCE.replace(
        '[Object]::ReferenceEquals(', '[Object]::Equals(')),
    replaceWindowsStreamSourceOnce(intended,
      '[Object]::ReferenceEquals($streamDataType.DeclaringType, $nativeType)',
      '[Object]::Equals($streamDataType.DeclaringType, $nativeType)'),
    replaceWindowsStreamSourceOnce(intended,
      S212_SELECTED_OWNED_ASSEMBLY_IDENTITY,
      '    -not [String]::Equals($selectedStreamDataType.Assembly.FullName, ' +
        '$assemblyBuilder.FullName, [System.StringComparison]::Ordinal) -or'),
    replaceWindowsStreamSourceOnce(intended,
      S212_SELECTED_MODULE_REFERENCE,
      S212_SELECTED_MODULE_REFERENCE.replace(
        '[Object]::ReferenceEquals(', '[Object]::Equals(')),
    replaceWindowsStreamSourceOnce(intended,
      S212_TWO_MODE_SELECTION_SOURCE,
      `${S212_TWO_MODE_SELECTION_SOURCE}\nAdd-Type -TypeDefinition $source`),
    replaceWindowsStreamSourceOnce(intended,
      S212_TWO_MODE_SELECTION_SOURCE,
      `${S212_TWO_MODE_SELECTION_SOURCE}\nInvoke-Expression $source`),
    replaceWindowsStreamSourceOnce(intended,
      S212_TWO_MODE_SELECTION_SOURCE,
      `${S212_TWO_MODE_SELECTION_SOURCE}\nwhile ($true) { break }`),
    ...[
      '$ignored = [System.IO.File]::ReadAllText($path)',
      '$ignored = [IO.File]::ReadAllText($path)',
      "Resolve-Path '.'",
      'Out-File -FilePath $path',
      "$ignored = [Diagnostics.ProcessStartInfo]::new('cmd.exe')",
      'gEt-MoDuLe',
      '$ignored = [System.Environment]::GetEnvironmentVariable(\'TEMP\')',
      'Get-ChildItem HKCU:\\',
      '$ignored = [ScriptBlock]::Create(\'Get-Date\').Invoke()',
      '[Console]::WriteLine($selectedStreamDataType)',
      '[System.Diagnostics.Process]::Start(\'cmd.exe\')',
      'while($true) { break }',
      'foreach($item in $items) { break }',
      'do { break } while($false)',
    ].map((addition) => s212AppendAfterCanonicalLookup(intended, addition)),
    replaceWindowsStreamSourceOnce(intended,
      "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', " +
        '$nestedTypeFlags)',
      "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', " +
        "$nestedTypeFlags)\nGet-Item '.'"),
    replaceWindowsStreamSourceOnce(intended,
      "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', " +
        '$nestedTypeFlags)',
      "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', " +
        '$nestedTypeFlags)\n$ignored = $env:TEMP'),
    replaceWindowsStreamSourceOnce(intended,
      "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', " +
        '$nestedTypeFlags)',
      "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', " +
        '$nestedTypeFlags)\n' +
        '$ignored = [Microsoft.Win32.Registry]::CurrentUser'),
    replaceWindowsStreamSourceOnce(intended,
      "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', " +
        '$nestedTypeFlags)',
      "$streamDataType = $nativeType.GetNestedType('WIN32_FIND_STREAM_DATA', " +
        '$nestedTypeFlags)\n' +
        '[Console]::Out.WriteLine($selectedStreamDataType)'),
    s212MoveNativeSuccessGuardAfterCanonicalLookup(intended),
    s212MoveSelectionBeforeHandlerRemoval(intended),
  ];
  for (const mutant of mutants) {
    assert.throws(() => assertS212NoDispatchLateBakeRemediationContract(mutant));
  }
});

test('S2.11 wrapper-aware detector is CRLF-stable', () => {
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readFileSyncWithSyntheticCrlf(file, ...args) {
    const content = originalReadFileSync.call(fs, file, ...args);
    if (path.resolve(String(file)) !== path.resolve(__filename) ||
        typeof content !== 'string') return content;
    return content.replace(/\r?\n/gu, '\r\n');
  };
  try {
    assertS211WrapperAwareDynamicAssemblyIdentity(
      s211CurrentAssemblyIdentityContractSource());
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('documented TypeResolve factory detector rejects forbidden control spellings', () => {
  const intended = s212IntendedDocumentedFactorySelectionFixture();
  assert.doesNotThrow(() => assertS212DocumentedFactorySelectionIsBounded(intended));

  const factoryReturn = typeResolveStageLine('documented', 'factory-search-return');
  for (const addition of [
    'while($true) { break }',
    'WhIlE($true) { break }',
    'for($index = 0; $index -lt 1; $index++) { break }',
    'foreach($item in $items) { break }',
    'do { break } while($false)',
    'sTaRt-SlEeP -Milliseconds 1',
    "sTaRt-PrOcEsS 'cmd.exe'",
    "[Diagnostics.Process]::Start('cmd.exe')",
    "[System.Diagnostics.ProcessStartInfo]::new('cmd.exe')",
    "[Process]::Start('cmd.exe')",
    "[ProcessStartInfo]::new('cmd.exe')",
    "$process = [Diagnostics.Process]::new(); $process.StartInfo.FileName = 'cmd.exe'; " +
      '$null = $process.Start()',
    "$runner = [System.Diagnostics.Process]::new(); " +
      "$runner.StartInfo.FileName = 'cmd.exe'; $null = $runner.Start()",
    "[Diagnostics.Process] $typed = New-Object System.Diagnostics.Process; " +
      "$typed.StartInfo.FileName = 'cmd.exe'; $null = $typed.Start()",
    "$script:process = New-Object -TypeName Diagnostics.Process; " +
      "$null = $script:process.Start()",
    "${process} = New-Object -TypeName System.Diagnostics.Process; " +
      "$null = ${process}.Start()",
    "([Diagnostics.Process]::new()).Start()",
    "$processes = @(New-Object System.Diagnostics.Process); " +
      "$processes[0].StartInfo.FileName = 'cmd.exe'; $null = $processes[0].Start()",
    "$holder = @{ Process = New-Object System.Diagnostics.Process }; " +
      "$holder.Process.StartInfo.FileName = 'cmd.exe'; $null = $holder.Process.Start()",
    "$script:holders = @(@{ Process = New-Object System.Diagnostics.Process }); " +
      "$null = $script:holders[0].Process.Start()",
    "${global:processes} = @(New-Object System.Diagnostics.Process); " +
      "$null = ${global:processes}[0].Start()",
    "$processes = @(New-Object System.Diagnostics.Process); " +
      "$null = (($processes[0])).Start()",
    '$null = $stopwatch.Start()',
    '$null = $timer.Start()',
    "[System.Management.Automation.PowerShell]::Create().AddScript(" +
      "'Start-Process cmd.exe').Invoke()",
    "[PowerShell]::Create().AddCommand('Start-Process').Invoke()",
    '$pipeline.AddScript($script).BeginInvoke()',
    "$ExecutionContext.InvokeCommand.InvokeScript('Start-Process cmd.exe')",
    "$ExecutionContext.InvokeCommand.NewScriptBlock('Start-Process cmd.exe').Invoke()",
    "$callback = { return 1 }.GetNewClosure().InvokeReturnAsIs()",
    "$callback = { param($functions,$variables) }.GetNewClosure().InvokeWithContext(" +
      '$functions,$variables,@())',
    "$method = 'Start'; $process = [Diagnostics.Process]::new(); " +
      "$process.StartInfo.FileName = 'cmd.exe'; $null = $process.$method()",
    "$method = 'Start'; $null = $process.${method}()",
    "$method = 'Start'; $null = $process.$($method)()",
    "$null = $process.('Start')()",
    "$null = $process.'Start'()",
    "$member = 'InvokeReturnAsIs'; $callback = { return 1 }.GetNewClosure(); " +
      '$null = $callback.$member()',
    "$method = 'Run'; $null = $shell.$method('cmd.exe')",
    "$shell = [System.Activator]::CreateInstance(" +
      "[type]::GetTypeFromProgID('WScript.Shell')); $null = $shell.Run('cmd.exe')",
    "[ScriptBlock]::Create('Start-Process cmd.exe').Invoke()",
    "[System.Management.Automation.ScriptBlock]::Create('Start-Process cmd.exe')",
    "[System.Diagnostics.Process].GetMethod('Start',[Type[]]@([String])).Invoke(" +
      "$null,@('cmd.exe'))",
    "[Process].GetMethods() | Microsoft.PowerShell.Core\\Where-Object { " +
      "$_.Name -eq 'Start' } | Microsoft.PowerShell.Core\\Where-Object { " +
      "$_.Invoke($null, @('cmd.exe')) }",
    "$methodInfo = [Process].GetMethod('Start'); $methodInfo.Invoke($null,@('cmd.exe'))",
    "$methodInfo = [Process].GetMethod('Start'); $methodInfo.Inv`oke($null,@('cmd.exe'))",
    "[System.Diagnostics.Process].InvokeMember('Start'," +
      "[System.Reflection.BindingFlags]'Public,Static,InvokeMethod'," +
      "$null,$null,@('cmd.exe'))",
    "[System.Diagnostics.Process].Invo`keMember('Start'," +
      "[System.Reflection.BindingFlags]'Public,Static,InvokeMethod'," +
      "$null,$null,@('cmd.exe'))",
    "$methodInfo = [Process].GetMethod('Start'); " +
      "$methodInfo.CreateDelegate([Func[String,System.Diagnostics.Process]])." +
      "DynamicInvoke('cmd.exe')",
    "$methodInfo = [Process].GetMethod('Start'); " +
      "$methodInfo.Create`Delegate([Func[String,System.Diagnostics.Process]])",
    "$delegate = [Delegate]::CreateDelegate([Func[String,System.Diagnostics.Process]]," +
      "[Process].GetMethod('Start',[Type[]]@([String]))); " +
      "$delegate.DynamicInvoke('cmd.exe')",
    "$delegate = [Delegate]::CreateDelegate([Func[String,System.Diagnostics.Process]]," +
      "[Process].GetMethod('Start',[Type[]]@([String]))); " +
      "$delegate.Dynamic`Invoke('cmd.exe')",
    '[System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()',
    '[RunspaceFactory]::CreateRunspacePool()',
    'SeLeCt-ObJeCt -First 1',
    'FoReAcH-ObJeCt { $_ }',
    'select -First 1',
    '% { $_ }',
    '% -Process { $_ }',
    'foreach { $_ }',
    'foreach -Process { $_ }',
    'sleep 1',
    'Microsoft.PowerShell.Utility\\Start-Sleep 1',
    'Where-Object { $_ }',
    'Write-Output ok',
    'Attacker\\Where-Object { $_ }',
    'Attacker\\Write-Output ok',
    'Write-Output$suffix',
    "Write-Output$('suffix')",
    'Microsoft.PowerShell.Utility\\Write-`Output ok',
    'Microsoft.PowerShell.Utility\\Write-Output$suffix',
    "Microsoft.PowerShell.Utility\\Write-Output$('suffix')",
    "saps 'cmd.exe'",
    "start 'cmd.exe'",
    "Microsoft.PowerShell.Management\\Start-Process 'cmd.exe'",
    "& 'cmd.exe'",
    '& $command',
    'cmd.exe /c exit',
    'cmd /c exit',
    'powershell -NoProfile -Command exit',
    'pwsh -NoProfile -Command exit',
    'notepad',
    'whoami /all',
    'ping 127.0.0.1',
    'C:\\Windows\\System32\\cmd /c exit',
    '.\\deep-work-native /probe',
    'deep-work-native /probe',
    'deep-work-native.COM /probe',
    'deep-work-native.BAT /probe',
    'deep-work-native.CMD /probe',
    'ΔοκιμήFunction -Argument safe',
    '測試別名 value',
    '.\\скрипт.ps1 -Probe',
    '도구.exe --probe',
    '$null = $(while($true) { break })',
    '$null = $(for($index = 0; $index -lt 1; $index++) { break })',
    '$null = $(foreach($item in $items) { break })',
    '$null = $(do { break } while($false))',
    '$null = $(sleep 1)',
    '$null = $(Start-Sleep -Milliseconds 1)',
    "$null = $(saps 'cmd.exe')",
    "$null = $(Start-Process 'cmd.exe')",
    "$null = $(start 'cmd.exe')",
    '$null = $(cmd.exe /c exit)',
    '$null = $(cmd /c exit)',
    "$null = $(& 'cmd.exe')",
    '$null = $(% { $_ })',
    '$null = $(foreach { $_ })',
    '$null = "result $(Start-Sleep -Milliseconds 1)"',
    '$items = % { $_ }',
    '$items = % -Process { $_ }',
    '$items = foreach { $_ }',
    '$items | Microsoft.PowerShell.Core\\ForEach-Object -Process { $_ }',
    '$result = while($true) { break }',
    '$result = for($index = 0; $index -lt 1; $index++) { break }',
    '$result = foreach($item in $items) { break }',
    '$result = do { break } while($false)',
    '$delay = sleep 1',
    '$delay = Start-Sleep -Milliseconds 1',
    "$process = saps 'cmd.exe'",
    "$process = Start-Process 'cmd.exe'",
    "$process = start 'cmd.exe'",
    '$output = cmd.exe /c exit',
    '$output = cmd /c exit',
    "$output = & 'cmd.exe'",
    '$literal = @"\n$(Start-Sleep -Milliseconds 1)\n"@',
    'Start-`Sleep 1',
    "s`aps 'cmd.exe'",
    'cmd.`exe /c exit',
    '$null = $(Start-`Sleep 1)',
    '$null = "result $(s`aps \'cmd.exe\')"',
    '$literal = @"\n$(cmd.`exe /c exit)\n"@',
    "Start-$('Sleep') 1",
    "cm$('d').exe /c exit",
    "Microsoft.PowerShell.Utility\\Start-$('Sleep') 1",
    ':outer while($true) { break }',
    ':outer for($index = 0; $index -lt 1; $index++) { break }',
    ':outer foreach($item in $items) { break }',
    ':outer do { break } while($false)',
    ':outer cmd /c exit',
    ':외부 while($true) { break }',
    ':Δοκιμή for($index = 0; $index -lt 1; $index++) { break }',
    'Microsoft.PowerShell.Utility\\Write-Output `# escaped-comment-marker; Start-Sleep 1',
    'Microsoft.PowerShell.Utility\\Write-Output `"escaped-quote`"; Start-Sleep 1',
  ]) {
    const mutant = replaceWindowsStreamSourceOnce(intended, factoryReturn,
      `${addition}\n${factoryReturn}`);
    assert.throws(() => assertS212DocumentedFactorySelectionIsBounded(mutant),
      /S2\.12 forbidden documented factory control:/u,
      `S2.12 documented factory mutant must be rejected: ${addition}`);
  }

  for (const addition of [
    '$selected = $true',
    '$started = $true',
    '$ready = $left -and $right',
    '$equal = $left -eq $right',
    '$notEqual = $left -ne $right',
    '$record.start = $true',
    '$property = $record.start',
    '$property = $record.select',
    '${sleep}',
    '${start-process}',
    '${sleep}.Length',
    '${global:sleep}',
    '${script:start-process}.Length',
    '${env:PATH}',
    '$global:sleep',
    '$env:PATH',
    "$process = [Diagnostics.Process]::new(); " +
      "$process.StartInfo.FileName = 'cmd.exe'",
    '$process = [Diagnostics.Process]::GetCurrentProcess(); $created = $process.StartTime',
    '$method = $process.Start',
    '$method = $processes[0].Start',
    '$method = $holder.Process.Start',
    '$metadata = $holder.Process.StartInfo',
    '$startedAt = $holders[0].Process.StartTime',
    '$null = $process.Restart()',
    '$null = $holder.Process.Restart()',
    '$method = $pipeline.AddScript',
    "$literal = '[PowerShell]::Create().AddScript(\"Start-Process cmd.exe\").Invoke()'",
    '# [RunspaceFactory]::CreateRunspace(); $pipeline.AddScript($script).Invoke()',
    "$literal = 'cmd.exe sleep start-process foreach'",
    '$literal = "cmd.exe sleep start-process foreach"',
    '# cmd.exe; sleep 1; Start-Process; foreach',
    '<# cmd.exe; sleep 1; Start-Process; foreach #>',
    "@{ select = $true; start = $true; sleep = $false; foreach = $null }",
    "$literal = @'\nsleep 1; Start-Process 'cmd.exe'\n'@",
    '$literal = @"\nsleep 1; Start-Process \'cmd.exe\'\n"@',
    '$literal = @"\n"@not-a-terminator; Start-Sleep 1\nsleep 1\n"@',
    'Microsoft.PowerShell.Utility\\Write-Output `; Start-Sleep 1',
    'Microsoft.PowerShell.Utility\\Write-Output `| Start-Sleep 1',
    'Microsoft.PowerShell.Utility\\Write-Output `# Start-Sleep 1',
    'Microsoft.PowerShell.Utility\\Write-Output `"Start-Sleep 1`"',
    'Microsoft.PowerShell.Utility\\Write-Output escaped` space Start-Sleep 1',
    'Microsoft.PowerShell.Utility\\Write-Output `\nStart-Sleep 1',
    'Microsoft.PowerShell.Utility\\Write-Output value#literal',
    'Microsoft.PowerShell.Utility\\Write-Output value # Start-Sleep 1',
    "Microsoft.PowerShell.Utility\\Write-Output $('safe')",
    "$name = \"Start-$('Sleep')\"",
    "Microsoft.PowerShell.Utility\\Write-Output value$('suffix')",
    ':외부 Microsoft.PowerShell.Utility\\Write-Output ok',
    ':Δοκιμή Microsoft.PowerShell.Utility\\Write-Output ok',
    'if ($true) { Microsoft.PowerShell.Utility\\Write-Output ok }',
    'try { Microsoft.PowerShell.Utility\\Write-Output ok } finally { ' +
      'Microsoft.PowerShell.Utility\\Write-Output done }',
    'param($value); Microsoft.PowerShell.Utility\\Write-Output $value',
    'return $value',
    "throw 'bounded diagnostic failure'",
    'Microsoft.PowerShell.Utility\\Write-Output ok',
    'Microsoft.PowerShell.Utility\\Write-Output ok 2>&1',
  ]) {
    const benign = replaceWindowsStreamSourceOnce(intended, factoryReturn,
      `${addition}\n${factoryReturn}`);
    assert.doesNotThrow(() => assertS212DocumentedFactorySelectionIsBounded(benign),
      `S2.12 documented factory benign token must remain accepted: ${addition}`);
  }

  for (const addition of [
    'Microsoft.PowerShell.Utility\\Write-Output value#literal; Start-Sleep 1',
    'Microsoft.PowerShell.Utility\\Write-Output value#literal; cmd.exe /c exit',
  ]) {
    const mutant = replaceWindowsStreamSourceOnce(intended, factoryReturn,
      `${addition}\n${factoryReturn}`);
    assert.throws(() => assertS212DocumentedFactorySelectionIsBounded(mutant),
      /S2\.12 forbidden documented factory control:/u,
      `S2.12 mid-token hash must not hide executable control: ${addition}`);
  }

  for (const addition of ['${sleep', '${sleep`}']) {
    const malformed = replaceWindowsStreamSourceOnce(intended, factoryReturn,
      `${addition}\n${factoryReturn}`);
    assert.throws(() => assertS212DocumentedFactorySelectionIsBounded(malformed),
      /S2\.12 documented factory PowerShell is lexically closed/u,
      `S2.12 malformed braced variable must fail closed: ${addition}`);
  }
});

test('documented TypeResolve factory selection is bounded', () => {
  assertS212DocumentedFactorySelectionIsBounded(documentedTypeResolveDiagnosticScript());
});

test('Windows pinned late-bake identity-axis outer normalizer preserves lower-layer contracts',
  () => {
    const intended = expectedPinnedLateBakeIdentityAxisFixture();
    const normalized = normalizeExpectedPinnedLateBakeIdentityAxisDiagnostic(intended);
    assert.doesNotThrow(() =>
      assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic(normalized));
    assert.doesNotThrow(() =>
      assertExpectedWindowsPinnedPostScopeResolverStateDiagnostic(normalized));
    assert.doesNotThrow(() => assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic(
      expectedPinnedNoDispatchLateBakeFixture()));
    assert.doesNotThrow(() => assertExpectedWindowsPinnedPostScopeResolverStateDiagnostic(
      expectedPinnedPostScopeResolverStateFixture()));

    const block = expectedPinnedLateBakeIdentityAxisBlock();
    const zeroBlock = expectedPinnedNoDispatchLateBakeFixture();
    const multipleBlocks = {
      ...intended,
      transformed:intended.transformed.replace(block, `${block}\n${block}`),
    };
    const malformedBlock = {
      ...intended,
      transformed:intended.transformed.replace(
        '# DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_IDENTITY_AXIS_END',
        '# DEEP_WORK_TYPE_RESOLVE_LATE_BAKE_IDENTITY_AXIS_MALFORMED'),
    };
    const transform = expectedPinnedLateBakeIdentityAxisTransformMetadata();
    const withoutBlock = intended.transformed.replace(`${block}\n`, '');
    const misplacedBlock = {
      ...intended,
      transformed:withoutBlock.replace(transform.before, `${block}\n${transform.before}`),
    };
    const partialBlock = {
      ...intended,
      transformed:intended.transformed.replace(block,
        block.slice(0, block.indexOf('\n  try {'))),
    };
    const unexpectedStage = {
      ...intended,
      allowedStages:[...intended.allowedStages,
        'late-bake-identity-axis-unexpected-exception'],
    };
    for (const mutant of [zeroBlock, multipleBlocks, malformedBlock, misplacedBlock,
      partialBlock, unexpectedStage]) {
      assert.throws(() =>
        normalizeExpectedPinnedLateBakeIdentityAxisDiagnostic(mutant));
    }
  });

test('expected Windows pinned no-dispatch late-bake diagnostic contract', () => {
  const diagnostic = {
    ...pinnedWindowsTypeResolveDiagnostic(),
    allowedStages:TYPE_RESOLVE_PINNED_ALLOWED_STAGES,
    oracleSource:assertPinnedTypeResolveRecords.toString(),
    actualOracleDiscrepancies:actualPinnedNoDispatchLateBakeOracleDiscrepancies(),
  };
  assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic(
    normalizeExpectedPinnedLateBakeIdentityAxisDiagnostic(diagnostic));
});

test('Windows pinned no-dispatch late-bake detector rejects closed-surface mutants', () => {
  const intended = expectedPinnedNoDispatchLateBakeFixture();
  assert.doesNotThrow(() =>
    assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic(intended));

  const block = expectedPinnedNoDispatchLateBakeBlock();
  const marker = (stage) => typeResolveStageLine('pinned', stage);
  const mutate = (before, after) => {
    assert.equal(countLiteral(block, before), 1,
      `expected pinned late-bake detector mutant anchor ${before}`);
    const mutantBlock = block.replace(before, after);
    return {...intended, transformed:intended.transformed.replace(block, mutantBlock)};
  };
  const movedBeforeEnclosing = {
    ...intended,
    transformed:intended.transformed.replace(`${block}\n`, '').replace(
      marker('enclosing-create-enter'), `${block}\n${marker('enclosing-create-enter')}`),
  };
  const reorderedPhases = {
    ...intended,
    transformed:intended.transformed
      .replace(marker('late-bake-identity-authenticated'), 'LATE_BAKE_PHASE_SWAP')
      .replace(marker('late-bake-fields-authenticated'),
        marker('late-bake-identity-authenticated'))
      .replace('LATE_BAKE_PHASE_SWAP', marker('late-bake-fields-authenticated')),
  };
  const scriptMutants = [
    mutate('$lateBakeApplicable = -not $nativeTypeFailure -and',
      '$lateBakeApplicable = $true -and'),
    mutate('$typeResolveState.Requests -eq 0 -and',
      '$typeResolveState.Requests -ge 0 -and'),
    movedBeforeEnclosing,
    mutate('    $lateBakeType = $streamDataBuilder.CreateType()', [
      '    $lateBakeType = $streamDataBuilder.CreateType()',
      '    $lateBakeType = $streamDataBuilder.CreateType()',
    ].join('\n')),
    mutate('    $lateBakeType = $streamDataBuilder.CreateType()', [
      '    $lateBakeType = $streamDataBuilder.CreateType()',
      '    $lateBakeOtherType = $nativeBuilder.CreateType()',
    ].join('\n')),
    mutate('$lateBakeApplicable = -not $nativeTypeFailure -and', [
      '$typeResolveState.Type = $null',
      '$lateBakeApplicable = -not $nativeTypeFailure -and',
    ].join('\n')),
    mutate(marker('late-bake-create-exception'), [
      '[Console]::Out.WriteLine($_.Exception.Message)',
      marker('late-bake-create-exception'),
    ].join('\n')),
    mutate(marker('late-bake-create-return'), [
      '[Console]::Out.WriteLine($lateBakeType.FullName)',
      marker('late-bake-create-return'),
    ].join('\n')),
    mutate(marker('late-bake-interop-authenticated'), [
      '$lateBakeFindClose.Invoke($null, @([IntPtr]::Zero))',
      marker('late-bake-interop-authenticated'),
    ].join('\n')),
    mutate(marker('late-bake-completed'), ''),
    mutate(marker('late-bake-completed'), [
      marker('late-bake-completed'), marker('late-bake-completed'),
    ].join('\n')),
    reorderedPhases,
    mutate(marker('late-bake-identity-authenticated'), [
      marker('late-bake-identity-authenticated'), marker('late-bake-identity-mismatch'),
    ].join('\n')),
    mutate('$lateBakeType.IsValueType -and $lateBakeType.IsNestedPublic -and',
      '$lateBakeType.IsValueType -and $lateBakeType.IsPublic -and'),
    mutate('$lateBakeType.IsSealed -and $lateBakeType.IsLayoutSequential -and',
      '$true -and $lateBakeType.IsLayoutSequential -and'),
    mutate('[System.Reflection.TypeAttributes]::BeforeFieldInit) -ne 0',
      '[System.Reflection.TypeAttributes]::Serializable) -ne 0'),
    mutate('$lateBakeMethodFlags = [System.Reflection.BindingFlags]::Public -bor',
      '$lateBakeMethodFlags = [System.Reflection.BindingFlags]::NonPublic -bor'),
    mutate([
      '$lateBakeMethodFlags = [System.Reflection.BindingFlags]::Public -bor',
      '      [System.Reflection.BindingFlags]::Static -bor',
      '      [System.Reflection.BindingFlags]::DeclaredOnly',
    ].join('\n'), [
      '$lateBakeMethodFlags = [System.Reflection.BindingFlags]::Public -bor',
      '      [System.Reflection.BindingFlags]::Instance -bor',
      '      [System.Reflection.BindingFlags]::DeclaredOnly',
    ].join('\n')),
    mutate('      [System.Reflection.BindingFlags]::DeclaredOnly\n' +
      '    $lateBakeMethods = @($nativeType.GetMethods($lateBakeMethodFlags))',
    '      [System.Reflection.BindingFlags]::FlattenHierarchy\n' +
      '    $lateBakeMethods = @($nativeType.GetMethods($lateBakeMethodFlags))'),
    mutate('$lateBakeMethods.Length -eq 3 -and',
      '$lateBakeMethods.Length -eq 4 -and'),
    mutate('      $lateBakeFindFirstImports[0].PreserveSig -and',
      '      $lateBakeFindFirstImports[0].ExactSpelling -and'),
    mutate([
      '      ($lateBakeFindFirst.GetMethodImplementationFlags() -band',
      '        [System.Reflection.MethodImplAttributes]::PreserveSig) -ne 0 -and',
    ].join('\n'), [
      '      ($lateBakeFindFirst.GetMethodImplementationFlags() -band',
      '        [System.Reflection.MethodImplAttributes]::Synchronized) -ne 0 -and',
    ].join('\n')),
  ];
  for (const mutant of scriptMutants) {
    assert.throws(() =>
      assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic(mutant));
  }

  assert.throws(() => assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic({
    ...intended,
    allowedStages:intended.allowedStages.filter((stage) =>
      stage !== 'late-bake-identity-mismatch'),
  }));
  assert.throws(() => assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic({
    ...intended,
    oracleSource:intended.oracleSource.replace("'late-bake-methods-mismatch'", ''),
  }));
  assert.throws(() => assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic({
    ...intended,
    actualOracleDiscrepancies:undefined,
  }));
  assert.throws(() => assertExpectedWindowsPinnedNoDispatchLateBakeDiagnostic({
    ...intended,
    actualOracleDiscrepancies:['real pinned oracle accepted invalid late-bake fixture'],
  }));

  const fixtures = expectedPinnedNoDispatchLateBakeRecordFixtures();
  for (const fixture of fixtures) {
    assert.doesNotThrow(() => assertExpectedPinnedNoDispatchLateBakeRecordFixture(fixture));
  }
  for (const fixture of expectedPinnedNoDispatchLateBakeInvalidRecordFixtures()) {
    assert.throws(() => assertExpectedPinnedNoDispatchLateBakeRecordFixture(fixture.records),
      undefined, fixture.id);
  }
});

test('expected Windows pinned post-scope resolver-state diagnostic contract', () => {
  const diagnostic = {
    ...pinnedWindowsTypeResolveDiagnostic(),
    allowedStages:TYPE_RESOLVE_PINNED_ALLOWED_STAGES,
  };
  assertExpectedWindowsPinnedPostScopeResolverStateDiagnostic(
    normalizeExpectedPinnedLateBakeIdentityAxisDiagnostic(diagnostic));
});

test('Windows pinned post-scope resolver-state detector rejects closed-surface mutants', () => {
  const intended = expectedPinnedPostScopeResolverStateFixture();
  assert.doesNotThrow(() =>
    assertExpectedWindowsPinnedPostScopeResolverStateDiagnostic(intended));

  const marker = (stage) => typeResolveStageLine('pinned', stage);
  const mutate = (before, after) => {
    assert.equal(countLiteral(intended.transformed, before), 1,
      `expected pinned detector mutant anchor ${before}`);
    return {...intended, transformed:intended.transformed.replace(before, after)};
  };
  const reorderedAxes = intended.transformed
    .replace(marker('state-native-create-failed'), 'STATE_AXIS_SWAP_SENTINEL')
    .replace(marker('state-requests-zero'), marker('state-native-create-failed'))
    .replace('STATE_AXIS_SWAP_SENTINEL', marker('state-requests-zero'));
  const resolverEnteredWrapper = expectedTypeResolvePinnedGuardedMarker(
    'resolver-entered', '-lt');
  const requestIncrementedWrapper = expectedTypeResolvePinnedGuardedMarker(
    'resolver-request-incremented', '-le');
  const incrementGuardAnchor = [
    '    $typeResolveState.Requests++',
    requestIncrementedWrapper,
  ].join('\n');
  const scriptMutants = [
    mutate(marker('state-requests-zero'),
      '[Console]::Out.WriteLine($typeResolveState.Requests)'),
    mutate(marker('state-failure-null'),
      '[Console]::Out.WriteLine($typeResolveState.Failure)'),
    mutate(marker('state-failure-other'), ''),
    mutate(marker('state-type-present'),
      `${marker('state-type-present')}\n${marker('state-type-present')}`),
    {...intended, transformed:reorderedAxes},
    mutate('# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END',
      '$typeResolveState.Failure = $null\n# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END'),
    mutate('# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END',
      "$nativeType.GetNestedType('WIN32_FIND_STREAM_DATA')\n" +
      '# DEEP_WORK_TYPE_RESOLVE_STATE_DIAGNOSTIC_END'),
    mutate(resolverEnteredWrapper, marker('resolver-entered')),
    mutate(requestIncrementedWrapper,
      requestIncrementedWrapper.replace(marker('resolver-request-incremented'),
        `$typeResolveState.Requests = 2\n${marker('resolver-request-incremented')}`)),
    mutate(requestIncrementedWrapper,
      requestIncrementedWrapper.replace('-le 2', '-le 3')),
    mutate(incrementGuardAnchor, [
      requestIncrementedWrapper,
      '    $typeResolveState.Requests++',
    ].join('\n')),
  ];
  for (const mutant of scriptMutants) {
    assert.throws(() =>
      assertExpectedWindowsPinnedPostScopeResolverStateDiagnostic(mutant));
  }

  const fixtures = expectedPinnedStateRecordFixtures();
  assert.equal(fixtures.length, 42,
    'expected pinned resolver-state native/path fixture count');
  for (const fixture of fixtures) {
    assert.doesNotThrow(() => assertExpectedPinnedStateRecordFixture(fixture));
    assert.doesNotThrow(() => assertPinnedTypeResolveRecords(fixture.records));
  }
  assert.equal(Math.max(...fixtures.map((fixture) => fixture.records.length)), 41);
  assert.equal(TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, 64);
  const duplicateThenHiddenForeign = fixtures.find((fixture) =>
    fixture.native === 'succeeded' && fixture.request === 'other' &&
    fixture.groups[0] === 'success' && fixture.groups[1] === 'duplicate' &&
    fixture.failure === 'name-mismatch');
  const foreignThenHiddenExact = fixtures.find((fixture) =>
    fixture.native === 'succeeded' && fixture.request === 'other' &&
    fixture.groups[0] === 'success' && fixture.groups[1] === 'foreign' &&
    fixture.failure === 'duplicate');
  assert.doesNotThrow(() =>
    assertExpectedPinnedStateRecordFixture(duplicateThenHiddenForeign));
  assert.doesNotThrow(() =>
    assertExpectedPinnedStateRecordFixture(foreignThenHiddenExact));

  assert.throws(() => assertExpectedPinnedStateTuple({
    native:'succeeded', request:'one', failure:'duplicate', type:'null',
    groups:['duplicate'],
  }));
  assert.throws(() => assertExpectedPinnedStateTuple({
    native:'succeeded', request:'other', failure:'duplicate', type:'null',
    groups:['success','foreign'],
  }));
  assert.throws(() => assertExpectedPinnedStateTuple({
    native:'succeeded', request:'other', failure:'name-mismatch', type:'null',
    groups:['foreign','catch'],
  }));
  assert.throws(() => assertExpectedPinnedAdmissibilityContract({
    ...EXPECTED_TYPE_RESOLVE_PINNED_ADMISSIBILITY_CONTRACT,
    coupleFinalFailureToSecondGroup:true,
  }));
  assert.throws(() => assertExpectedPinnedStateRecordFixture({
    ...duplicateThenHiddenForeign,
    records:[
      ...duplicateThenHiddenForeign.records,
      ...Array.from({length:65 - duplicateThenHiddenForeign.records.length}, () =>
        ({version:1, probe:'pinned', stage:'completed'})),
    ],
  }));
  const successfulOne = fixtures.find((fixture) =>
    fixture.native === 'succeeded' && fixture.request === 'one' &&
    fixture.groups[0] === 'success');
  assert.throws(() => assertPinnedTypeResolveRecords(successfulOne.records.map((record) =>
    record.stage === 'state-failure-null'
      ? {...record, stage:'state-failure-duplicate'} : record)));
  assert.throws(() => assertPinnedTypeResolveRecords(duplicateThenHiddenForeign.records
    .map((record) => record.stage === 'state-type-present'
      ? {...record, stage:'state-type-null'} : record)));
  assert.throws(() => assertPinnedTypeResolveRecords([
    ...duplicateThenHiddenForeign.records,
    ...Array.from({length:65 - duplicateThenHiddenForeign.records.length}, () =>
      ({version:1, probe:'pinned', stage:'completed'})),
  ]));
});

test('fixed Windows stream helper TypeResolve diagnostics are closed marker-only contracts', () => {
  const scripts = windowsTypeResolveDiagnosticScripts();
  assert.deepEqual(Object.keys(scripts), ['dispatch','documented','pinned','factoryDiscovery']);
  assertClosedTypeResolveDiagnosticScript(scripts.dispatch, {
    probe:'dispatch',
    requirePinnedSource:false,
  });
  assertClosedTypeResolveDiagnosticScript(scripts.documented, {
    probe:'documented',
    requirePinnedSource:false,
  });
  assertClosedTypeResolveDiagnosticScript(scripts.pinned, {
    probe:'pinned',
    requirePinnedSource:true,
  });
  const expectedFactoryDiscoveryStages = [
    'started',
    'type-token-enter','type-token-return',
    'get-methods-enter','get-methods-return',
    'name-filter-enter','name-filter-return',
    'static-filter-enter','static-filter-return',
    'parameter-filter-enter','parameter-filter-return',
    'index-enter','index-return',
    'indexed-null','indexed-present',
    'completed',
  ];
  assert.deepEqual(TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES,
    expectedFactoryDiscoveryStages);
  assertClosedTypeResolveDiagnosticScript(scripts.factoryDiscovery, {
    probe:'factory-discovery',
    requirePinnedSource:false,
  });
  const factoryDiscoveryMarker = (stage, indent = '') =>
    typeResolveStageLine('factory-discovery', stage, indent);
  const factoryDiscoveryOrderedFragments = [
    factoryDiscoveryMarker('started'),
    factoryDiscoveryMarker('type-token-enter'),
    '$factoryType = [System.Reflection.Emit.AssemblyBuilder]',
    factoryDiscoveryMarker('type-token-return'),
    factoryDiscoveryMarker('get-methods-enter'),
    '$allMethods = @($factoryType.GetMethods())',
    factoryDiscoveryMarker('get-methods-return'),
    factoryDiscoveryMarker('name-filter-enter'),
    "$namedMethods = @($allMethods | Where-Object { $_.Name -ceq 'DefineDynamicAssembly' })",
    factoryDiscoveryMarker('name-filter-return'),
    factoryDiscoveryMarker('static-filter-enter'),
    '$staticMethods = @($namedMethods | Where-Object { $_.IsStatic })',
    factoryDiscoveryMarker('static-filter-return'),
    factoryDiscoveryMarker('parameter-filter-enter'),
    '$twoParameterMethods = @($staticMethods | Where-Object { $_.GetParameters().Length -eq 2 })',
    factoryDiscoveryMarker('parameter-filter-return'),
    factoryDiscoveryMarker('index-enter'),
    '$indexedFactory = $twoParameterMethods[0]',
    factoryDiscoveryMarker('index-return'),
    'if ($null -eq $indexedFactory) {',
    factoryDiscoveryMarker('indexed-null', '  '),
    '} else {',
    factoryDiscoveryMarker('indexed-present', '  '),
    '}',
    factoryDiscoveryMarker('completed'),
  ];
  let factoryDiscoveryCursor = -1;
  for (const fragment of factoryDiscoveryOrderedFragments) {
    const next = scripts.factoryDiscovery.indexOf(fragment, factoryDiscoveryCursor + 1);
    assert.equal(next > factoryDiscoveryCursor, true,
      `factory discovery source order: ${fragment}`);
    factoryDiscoveryCursor = next;
  }
  for (const stage of expectedFactoryDiscoveryStages) {
    assert.equal(countLiteral(scripts.factoryDiscovery,
      factoryDiscoveryMarker(stage)), 1, `factory discovery stage ${stage}`);
  }
  assert.equal(countLiteral(scripts.factoryDiscovery, '$factoryType'), 2);
  assert.equal(countLiteral(scripts.factoryDiscovery, '$allMethods'), 2);
  assert.equal(countLiteral(scripts.factoryDiscovery, '$namedMethods'), 2);
  assert.equal(countLiteral(scripts.factoryDiscovery, '$staticMethods'), 2);
  assert.equal(countLiteral(scripts.factoryDiscovery, '$twoParameterMethods'), 2);
  assert.equal(countLiteral(scripts.factoryDiscovery, '$indexedFactory'), 2);
  assert.equal(countLiteral(scripts.factoryDiscovery, '$staticFactory'), 0);
  assert.equal(countLiteral(scripts.factoryDiscovery, 'DefineDynamicAssembly'), 1,
    'factory discovery may contain only the exact public method-name literal');
  for (const forbidden of [
    /\.DefineDynamicAssembly\s*\(/iu,
    /\.DefineDynamicModule\s*\(/iu,
    /\.DefineType\s*\(/iu,
    /\.DefineNestedType\s*\(/iu,
    /\.CreateType\s*\(/iu,
    /\.add_TypeResolve\s*\(/iu,
    /\.remove_TypeResolve\s*\(/iu,
    /System\.ResolveEventHandler/iu,
    /FindFirstStreamW/iu,
    /FindNextStreamW/iu,
    /FindClose/iu,
    /DefinePInvokeMethod/iu,
    /DllImport/iu,
    /windows-stream-inventory/iu,
    /captureWorktreeManifest/iu,
    /\bgit(?:\.exe)?\b/iu,
    /\bpowershell(?:\.exe)?\b/iu,
    /\$LiteralPath/iu,
    /\$args\b/iu,
    /\$env:/iu,
    /\[System\.Environment\]/iu,
    /\$stream/iu,
    /RequestingAssembly/iu,
  ]) {
    assert.doesNotMatch(scripts.factoryDiscovery, forbidden,
      `factory discovery forbidden surface ${forbidden}`);
  }
  assert.equal(scripts.factoryDiscovery.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('[Console]::Out.WriteLine('))
    .every((line) => line === '[Console]::Out.WriteLine($identityLine)' ||
      expectedFactoryDiscoveryStages.some((stage) =>
        line === factoryDiscoveryMarker(stage))), true,
  'factory discovery output is identity plus fixed markers only');
  assertDocumentedSetupMarkerPlacements(scripts.documented);
  const strippedDocumented = stripDocumentedSetupDiagnosticMarkers(scripts.documented);
  assert.equal(Buffer.byteLength(strippedDocumented),
    TYPE_RESOLVE_DOCUMENTED_BASE_SCRIPT_BYTES);
  assert.equal(strippedDocumented.split('\n').length - 1,
    TYPE_RESOLVE_DOCUMENTED_BASE_SCRIPT_LINES);
  assert.equal(hash(Buffer.from(strippedDocumented, 'utf8')),
    TYPE_RESOLVE_DOCUMENTED_BASE_SCRIPT_SHA256);
  assert.equal(hash(Buffer.from(scripts.factoryDiscovery, 'utf8')),
    '68e5dccf35c706bc5ad1147bc46dcb6c45e4984bed28a4035510dcf048bdbe8a');
  assert.equal(hash(Buffer.from(scripts.dispatch, 'utf8')),
    '2f212bdb6ae76e75f32c9ab4956be457116f8bfb7df1a8a1184d6082aea3d8f8');
  assert.equal(hash(Buffer.from(scripts.pinned, 'utf8')),
    'd5fab60d944fb0a589b5ea7c990f1d203e180e8dd282d0d8f58767e2abe3703c');
  assert.equal(scripts.dispatch.includes(
    `$callback = {\n  param($sender, $eventArgs)\n${typeResolveStageLine('dispatch',
      'handler-entered', '  ')}`), true);
  assert.equal(scripts.documented.includes(
    `$callback = {\n  param($sender, $eventArgs)\n${typeResolveStageLine('documented',
      'resolver-entered', '  ')}`), true);
  assert.equal(scripts.pinned.includes(
    `$typeResolveCallback = {\n  param($sender, $eventArgs)\n${pinnedTypeResolveGuardedMarker(
      'resolver-entered', 'before-increment')}`), true);
  assert.equal(countLiteral(scripts.dispatch, '.add_TypeResolve($handler)'), 1);
  assert.equal(countLiteral(scripts.dispatch, '.remove_TypeResolve($handler)'), 1);
  assert.equal(countLiteral(scripts.dispatch, '[Type]::GetType($expectedName, $false)'), 1);
  assert.equal(countLiteral(scripts.documented, '$outerBuilder.CreateType()'), 1);
  assert.equal(countLiteral(scripts.documented, '$nestedBuilder.CreateType()'), 1);
  assert.equal(countLiteral(scripts.documented, "throw 'documented resolver request bound'"), 1);
  assert.equal(countLiteral(scripts.documented, 'DefinePInvokeMethod'), 0);

  const pinned = pinnedWindowsTypeResolveDiagnostic();
  assert.equal(pinned.original, windowsStreamPInvokeSource());
  assert.equal(hash(Buffer.from(pinned.original, 'utf8')),
    WINDOWS_STREAM_INVENTORY_PINVOKE_SHA256);
  assert.equal(pinned.transforms.length, TYPE_RESOLVE_PINNED_INSERTED_STAGES.length);
  assert.equal(pinned.guardTransforms.length,
    TYPE_RESOLVE_PINNED_CALLBACK_OUTPUT_GUARDS.length);
  assert.equal(pinned.classifierTransform.id, 'post-scope-state-classifier');
  assert.equal(reversePinnedTypeResolveDiagnosticTransforms(pinned), pinned.original);
  assert.equal(stripPinnedTypeResolveDiagnostic(pinned.transformed), pinned.original);
  assert.equal(pinned.transformed.includes('RequestingAssembly'), false);
  assert.equal(countLiteral(scripts.pinned, '$findFirstStream.Invoke('), 0);
  assert.equal(countLiteral(scripts.pinned, '$findNextStream.Invoke('), 0);
  assert.equal(countLiteral(scripts.pinned, '$findClose.Invoke('), 0);
  assert.throws(() => assertClosedTypeResolveDiagnosticScript(
    scripts.dispatch.replace('$frameworkRelease -lt 533320',
      '$frameworkRelease -lt 533319'), {
      probe:'dispatch',
      requirePinnedSource:false,
    }));
  assert.throws(() => assertClosedTypeResolveDiagnosticScript(
    `${scripts.documented}PROBE_LITERAL\n`, {
      probe:'documented',
      requirePinnedSource:false,
    }));
  assert.throws(() => assertClosedTypeResolveDiagnosticScript(
    scripts.pinned.replace(typeResolveStageLine('pinned', 'completed'),
      `$null = $eventArgs.RequestingAssembly\n${typeResolveStageLine('pinned', 'completed')}`), {
      probe:'pinned',
      requirePinnedSource:true,
    }));

  const identity = typeResolveIdentityFixture('documented');
  const documentedRecords = [
    identity,
    ...TYPE_RESOLVE_DOCUMENTED_PREFIX_BEFORE_ASSEMBLY_BRANCH.map((stage) =>
      ({version:1, probe:'documented', stage})),
    {version:1, probe:'documented', stage:'assembly-create-appdomain'},
    ...TYPE_RESOLVE_DOCUMENTED_PREFIX_AFTER_ASSEMBLY_BRANCH.map((stage) =>
      ({version:1, probe:'documented', stage})),
    ...['request-1','request-2','request-3plus'].flatMap((request) => [
      'resolver-entered', request, 'name-exact', 'nested-create-enter',
      request === 'request-1' ? 'nested-create-return' : 'nested-already-created',
      'return-assembly',
    ].map((stage) => ({version:1, probe:'documented', stage}))),
    ...TYPE_RESOLVE_DOCUMENTED_OUTER_SUFFIX.map((stage) =>
      ({version:1, probe:'documented', stage})),
  ];
  assert.equal(documentedRecords.length, 49, 'documented maximum record count');
  assert.equal(documentedRecords.length <= TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, true,
    'documented record cap');
  assert.doesNotThrow(() => assertDocumentedTypeResolveRecords(documentedRecords));
  assert.throws(() => assertDocumentedTypeResolveRecords(
    documentedRecords.filter((record) => record.stage !== 'factory-search-return')),
  /documented oracle/);
  const bothAssemblyBranches = [...documentedRecords];
  const assemblyBranchIndex = bothAssemblyBranches.findIndex((record) =>
    record.stage === 'assembly-create-appdomain');
  bothAssemblyBranches.splice(assemblyBranchIndex, 0,
    {version:1, probe:'documented', stage:'assembly-create-static'});
  assert.throws(() => assertDocumentedTypeResolveRecords(bothAssemblyBranches),
    /documented oracle/);
  assert.throws(() => assertDocumentedTypeResolveRecords([
    ...documentedRecords.slice(0, -3),
    {version:1, probe:'documented', stage:'resolver-entered'},
    ...documentedRecords.slice(-3),
  ]), /documented oracle/);

  const pinnedRecords = typeResolvePinnedGreenStages().map((stage) =>
    stage === 'runtime-identity' ? typeResolveIdentityFixture('pinned')
      : {version:1, probe:'pinned', stage});
  assert.doesNotThrow(() => assertPinnedTypeResolveRecords(pinnedRecords));
  const bothNameBranches = [...pinnedRecords];
  const exactIndex = bothNameBranches.findIndex((record) => record.stage === 'resolver-name-exact');
  bothNameBranches.splice(exactIndex, 0,
    {version:1, probe:'pinned', stage:'resolver-name-foreign'});
  assert.throws(() => assertPinnedTypeResolveRecords(bothNameBranches), /pinned oracle/);
  const fallbackRecords = pinnedRecords.map((record) => {
    if (record.stage === 'factory-invoke-enter') {
      return {...record, stage:'factory-fallback-enter'};
    }
    if (record.stage === 'factory-invoke-return') {
      return {...record, stage:'factory-fallback-return'};
    }
    return record;
  });
  assert.throws(() => assertPinnedTypeResolveRecords(fallbackRecords), /pinned oracle/);
  const bothFactoryBranches = [...pinnedRecords];
  const assemblyReadyIndex = bothFactoryBranches.findIndex((record) =>
    record.stage === 'assembly-ready');
  bothFactoryBranches.splice(assemblyReadyIndex, 0,
    {version:1, probe:'pinned', stage:'factory-fallback-enter'},
    {version:1, probe:'pinned', stage:'factory-fallback-return'});
  assert.throws(() => assertPinnedTypeResolveRecords(bothFactoryBranches), /pinned oracle/);
});

test('fixed Windows stream helper TypeResolve evidence rejects mutants without leaking bytes', () => {
  const identity = typeResolveIdentityFixture('dispatch');
  const expectedRecords = [
    identity,
    ...TYPE_RESOLVE_DISPATCH_GREEN_STAGES.map((stage) =>
      ({version:1, probe:'dispatch', stage})),
  ];
  const allowedStages = TYPE_RESOLVE_DISPATCH_ALLOWED_STAGES;
  const resultFor = (stdout, stderr = Buffer.alloc(0), extra = {}) => ({
    error:undefined,
    status:0,
    signal:null,
    stdout:Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'utf8'),
    stderr:Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr, 'utf8'),
    ...extra,
  });
  const evidenceFor = (stdout, stderr, extra) => nativeWindowsLifecycleEvidence(
    'dispatch', resultFor(stdout, stderr, extra), 7, allowedStages);
  const canonical = `${expectedRecords.map(JSON.stringify).join('\n')}\n`;
  const clean = evidenceFor(canonical);
  assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(clean));
  assert.doesNotThrow(() => assertDispatchTypeResolveRecords(clean.records));
  const cleanCrlf = evidenceFor(canonical.replace(/\n/gu, '\r\n'));
  assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(cleanCrlf));
  assert.doesNotThrow(() => assertDispatchTypeResolveRecords(cleanCrlf.records));

  const extraKey = {...expectedRecords[1], extra:true};
  const foreignProbe = {...expectedRecords[1], probe:'documented'};
  const foreignStage = {...expectedRecords[1], stage:'foreign-stage'};
  const invalidEdition = {...identity, ps_edition:'Core'};
  const invalidFramework = {...identity, framework_release:533_319};
  const invalidWindows = {...identity, os_major:9};
  const invalidNumericType = {...identity, ps_build:'19041'};
  const {version, probe, stage, ...identityRest} = identity;
  const reorderedIdentity = {probe, version, stage, ...identityRest};
  const mutants = [
    ['malformed-json', '{bad\n', 'invalidLineCount'],
    ['non-json', 'not-json\n', 'invalidLineCount'],
    ['non-ascii', `${JSON.stringify(identity)}\n\u00e9\n`, 'stdoutGrammarErrorCount'],
    ['extra-key', `${JSON.stringify(extraKey)}\n`, 'invalidLineCount'],
    ['foreign-probe', `${JSON.stringify(foreignProbe)}\n`, 'foreignRecordCount'],
    ['foreign-stage', `${JSON.stringify(foreignStage)}\n`, 'foreignRecordCount'],
    ['identity-edition', `${JSON.stringify(invalidEdition)}\n`, 'invalidLineCount'],
    ['identity-framework', `${JSON.stringify(invalidFramework)}\n`, 'invalidLineCount'],
    ['identity-windows', `${JSON.stringify(invalidWindows)}\n`, 'invalidLineCount'],
    ['identity-numeric-type', `${JSON.stringify(invalidNumericType)}\n`, 'invalidLineCount'],
    ['identity-key-order', `${JSON.stringify(reorderedIdentity)}\n`, 'invalidLineCount'],
    ['interior-blank', `${JSON.stringify(identity)}\n\n${JSON.stringify(expectedRecords[1])}\n`,
      'stdoutGrammarErrorCount'],
    ['bare-cr', `${JSON.stringify(identity)}\r${JSON.stringify(expectedRecords[1])}\n`,
      'stdoutGrammarErrorCount'],
    ['missing-terminal-lf', JSON.stringify(identity), 'stdoutGrammarErrorCount'],
    ['truncated-8193', `${JSON.stringify(identity)}\n${'x'.repeat(8_193)}`, 'stdoutTruncatedBytes'],
    ['record-overflow', `${[identity, ...Array.from({length:64}, () => expectedRecords[1])]
      .map(JSON.stringify).join('\n')}\n`, 'recordOverflowCount'],
  ];
  for (const [name, stdout, field] of mutants) {
    const evidence = evidenceFor(stdout);
    assert.equal(evidence[field] > 0, true, name);
    assert.throws(() => assertNativeWindowsLifecyclePreOracle(evidence), undefined, name);
  }

  const duplicate = evidenceFor(`${[
    identity,
    expectedRecords[1],
    expectedRecords[1],
    ...expectedRecords.slice(2),
  ].map(JSON.stringify).join('\n')}\n`);
  assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(duplicate));
  assert.throws(() => assertDispatchTypeResolveRecords(duplicate.records), /dispatch oracle/);

  const privateStdout = 'foreign source C:\\private\\helper.ps1\n';
  const privateStderr = 'C:\\Users\\private\\source.ps1: exception secret';
  const privacy = evidenceFor(privateStdout, Buffer.from(privateStderr, 'utf8'), {
    error:Object.assign(new Error('private exception secret'), {code:'PRIVATE_CODE'}),
    signal:'PRIVATE_SIGNAL',
  });
  const serialized = JSON.stringify(privacy);
  for (const secret of ['C:\\private\\helper.ps1', 'C:\\Users\\private\\source.ps1',
    'exception secret', 'PRIVATE_CODE', 'PRIVATE_SIGNAL']) {
    assert.equal(serialized.includes(secret), false, 'privacy evidence');
  }
  assert.equal(privacy.stdoutBytes, Buffer.byteLength(privateStdout));
  assert.equal(privacy.stderrBytes, Buffer.byteLength(privateStderr));
  assert.equal(privacy.stdoutSha256, hash(Buffer.from(privateStdout, 'utf8')));
  assert.equal(privacy.stderrSha256, hash(Buffer.from(privateStderr, 'utf8')));
  assert.equal(privacy.invalidLineCount > 0, true);
  assert.equal(privacy.spawnErrorCode, 'other');
  assert.equal(privacy.signal, 'other');
});

test('factory discovery control evidence rejects grammar, order, branch, and process mutants',
  () => {
    const allowedStages = [
      'started',
      'type-token-enter','type-token-return',
      'get-methods-enter','get-methods-return',
      'name-filter-enter','name-filter-return',
      'static-filter-enter','static-filter-return',
      'parameter-filter-enter','parameter-filter-return',
      'index-enter','index-return',
      'indexed-null','indexed-present',
      'completed',
    ];
    const prefixBeforeIndexed = allowedStages.slice(0, allowedStages.indexOf('indexed-null'));
    const recordsFor = (indexedBranch) => [
      typeResolveIdentityFixture('factory-discovery'),
      ...prefixBeforeIndexed.map((stage) => ({version:1, probe:'factory-discovery', stage})),
      {version:1, probe:'factory-discovery', stage:indexedBranch},
      {version:1, probe:'factory-discovery', stage:'completed'},
    ];
    const resultFor = (stdout, stderr = Buffer.alloc(0), extra = {}) => ({
      error:undefined,
      status:0,
      signal:null,
      stdout:Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'utf8'),
      stderr:Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr, 'utf8'),
      ...extra,
    });
    const evidenceFor = (stdout, stderr, extra) => nativeWindowsLifecycleEvidence(
      'factory-discovery', resultFor(stdout, stderr, extra), 11, allowedStages);
    const serialize = (records) => `${records.map(JSON.stringify).join('\n')}\n`;

    const indexedPresent = recordsFor('indexed-present');
    assert.equal(indexedPresent.length, 16, 'factory discovery maximum runtime records');
    assert.equal(indexedPresent.length <= TYPE_RESOLVE_DIAGNOSTIC_MAX_RECORDS, true,
      'factory discovery record cap');
    const cleanPresent = evidenceFor(serialize(indexedPresent));
    assert.equal(cleanPresent.probe, 'factory-discovery',
      'factory discovery parser probe allowlist');
    assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(cleanPresent));
    assert.doesNotThrow(() => assertFactoryDiscoveryTypeResolveRecords(
      cleanPresent.records));
    const closedNull = evidenceFor(serialize(recordsFor('indexed-null')));
    assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(closedNull));
    assert.throws(() => assertFactoryDiscoveryTypeResolveRecords(closedNull.records),
      /factory discovery oracle/);
    const missingIdentityEvidence = evidenceFor(serialize(indexedPresent.slice(1)));
    assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(
      missingIdentityEvidence));
    assert.throws(() => assertFactoryDiscoveryTypeResolveRecords(
      missingIdentityEvidence.records), /factory discovery oracle/);

    const foreign = [...indexedPresent];
    foreign[3] = {...foreign[3], probe:'dispatch'};
    const foreignEvidence = evidenceFor(serialize(foreign));
    assert.equal(foreignEvidence.foreignRecordCount, 1, 'foreign probe record');
    assert.throws(() => assertNativeWindowsLifecyclePreOracle(foreignEvidence));

    const duplicate = [...indexedPresent];
    duplicate.splice(6, 0, duplicate[5]);
    const duplicateEvidence = evidenceFor(serialize(duplicate));
    assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(duplicateEvidence));
    assert.throws(() => assertFactoryDiscoveryTypeResolveRecords(
      duplicateEvidence.records), /factory discovery oracle/);

    const outOfOrder = [...indexedPresent];
    const indexEnterPosition = outOfOrder.findIndex((record) =>
      record.stage === 'index-enter');
    const indexReturnPosition = outOfOrder.findIndex((record) =>
      record.stage === 'index-return');
    [outOfOrder[indexEnterPosition], outOfOrder[indexReturnPosition]] =
      [outOfOrder[indexReturnPosition], outOfOrder[indexEnterPosition]];
    const outOfOrderEvidence = evidenceFor(serialize(outOfOrder));
    assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(outOfOrderEvidence));
    assert.throws(() => assertFactoryDiscoveryTypeResolveRecords(
      outOfOrderEvidence.records), /factory discovery oracle/);

    const bothIndexedBranches = [...indexedPresent];
    const indexedPresentPosition = bothIndexedBranches.findIndex((record) =>
      record.stage === 'indexed-present');
    bothIndexedBranches.splice(indexedPresentPosition, 0,
      {version:1, probe:'factory-discovery', stage:'indexed-null'});
    const bothIndexedEvidence = evidenceFor(serialize(bothIndexedBranches));
    assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(bothIndexedEvidence));
    assert.throws(() => assertFactoryDiscoveryTypeResolveRecords(
      bothIndexedEvidence.records), /factory discovery oracle/);

    const missingIndexedBranch = indexedPresent.filter((record) =>
      record.stage !== 'indexed-present');
    const missingIndexedEvidence = evidenceFor(serialize(missingIndexedBranch));
    assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(missingIndexedEvidence));
    assert.throws(() => assertFactoryDiscoveryTypeResolveRecords(
      missingIndexedEvidence.records), /factory discovery oracle/);

    const missingIndexEnter = indexedPresent.filter((record) =>
      record.stage !== 'index-enter');
    const missingIndexEnterEvidence = evidenceFor(serialize(missingIndexEnter));
    assert.doesNotThrow(() => assertNativeWindowsLifecyclePreOracle(missingIndexEnterEvidence));
    assert.throws(() => assertFactoryDiscoveryTypeResolveRecords(
      missingIndexEnterEvidence.records), /factory discovery oracle/);

    const malformedEvidence = evidenceFor('{bad\n');
    assert.equal(malformedEvidence.invalidLineCount, 1, 'malformed JSON');
    assert.throws(() => assertNativeWindowsLifecyclePreOracle(malformedEvidence));

    const privateStdout = 'C:\\private\\factory-source.ps1 raw method signature\n';
    const privateStderr = 'C:\\Users\\private\\factory-source.ps1: secret exception';
    const privateEvidence = evidenceFor(privateStdout,
      Buffer.from(privateStderr, 'utf8'), {
        error:Object.assign(new Error('secret exception'), {code:'PRIVATE_FACTORY_CODE'}),
        signal:'PRIVATE_FACTORY_SIGNAL',
      });
    const privateSerialized = JSON.stringify(privateEvidence);
    for (const secret of ['C:\\private\\factory-source.ps1',
      'C:\\Users\\private\\factory-source.ps1', 'raw method signature',
      'secret exception', 'PRIVATE_FACTORY_CODE', 'PRIVATE_FACTORY_SIGNAL']) {
      assert.equal(privateSerialized.includes(secret), false,
        'factory discovery privacy evidence');
    }
    assert.equal(privateEvidence.spawnErrorCode, 'other',
      'non-timeout process error is closed');
    assert.equal(privateEvidence.signal, 'other', 'foreign signal is closed');
    assert.throws(() => assertNativeWindowsLifecyclePreOracle(privateEvidence));

    const nonTimeoutEvidence = evidenceFor(serialize(indexedPresent), Buffer.alloc(0), {
      error:Object.assign(new Error('private access failure'), {code:'EACCES'}),
    });
    assert.equal(nonTimeoutEvidence.spawnErrorCode, 'other',
      'non-timeout process errors are inadmissible');
    assert.throws(() => assertNativeWindowsLifecyclePreOracle(nonTimeoutEvidence));

    const truncatedEvidence = evidenceFor(
      `${JSON.stringify(typeResolveIdentityFixture('factory-discovery'))}\n${'x'.repeat(8_193)}`);
    assert.equal(truncatedEvidence.stdoutTruncated, true, 'truncated prefix');
    assert.equal(truncatedEvidence.stdoutTruncatedBytes > 0, true,
      'truncated byte count');
    assert.throws(() => assertNativeWindowsLifecyclePreOracle(truncatedEvidence));

    const overflowRecords = [
      typeResolveIdentityFixture('factory-discovery'),
      ...Array.from({length:64}, () =>
        ({version:1, probe:'factory-discovery', stage:'started'})),
    ];
    const overflowEvidence = evidenceFor(serialize(overflowRecords));
    assert.equal(overflowEvidence.recordOverflowCount, 1, 'record overflow');
    assert.throws(() => assertNativeWindowsLifecyclePreOracle(overflowEvidence));
  });

test('native Windows PowerShell 5.1 factory discovery control is closed and bounded', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-factory-discovery-'));
  try {
    const {factoryDiscovery} = windowsTypeResolveDiagnosticScripts();
    assertClosedTypeResolveDiagnosticScript(factoryDiscovery, {
      probe:'factory-discovery',
      requirePinnedSource:false,
    });
    const result = runNativeWindowsLifecycleProbe({
      probe:'factory-discovery',
      root,
      script:factoryDiscovery,
      allowedStages:TYPE_RESOLVE_FACTORY_DISCOVERY_ALLOWED_STAGES,
      assertRecords:assertFactoryDiscoveryTypeResolveRecords,
    });
    t.diagnostic(JSON.stringify({
      kind:'native-type-resolve-runtime-identity',
      node_version:result.nodeVersion,
      probe:'factory-discovery',
      runtime_identity:result.runtimeIdentity,
    }));
  } finally { remove(root); }
});

test('native Windows PowerShell 5.1 TypeResolve dispatch control is synchronous and closed', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-type-resolve-dispatch-'));
  try {
    const {dispatch} = windowsTypeResolveDiagnosticScripts();
    assertClosedTypeResolveDiagnosticScript(dispatch, {
      probe:'dispatch',
      requirePinnedSource:false,
    });
    const result = runNativeWindowsLifecycleProbe({
      probe:'dispatch',
      root,
      script:dispatch,
      allowedStages:TYPE_RESOLVE_DISPATCH_ALLOWED_STAGES,
      assertRecords:assertDispatchTypeResolveRecords,
    });
    t.diagnostic(JSON.stringify({
      kind:'native-type-resolve-runtime-identity',
      node_version:result.nodeVersion,
      probe:'dispatch',
      runtime_identity:result.runtimeIdentity,
    }));
  } finally { remove(root); }
});

test('native Windows PowerShell 5.1 TypeResolve documented nested-value control completes', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-type-resolve-documented-'));
  try {
    const {documented} = windowsTypeResolveDiagnosticScripts();
    assertClosedTypeResolveDiagnosticScript(documented, {
      probe:'documented',
      requirePinnedSource:false,
    });
    const result = runNativeWindowsLifecycleProbe({
      probe:'documented',
      root,
      script:documented,
      allowedStages:TYPE_RESOLVE_DOCUMENTED_ALLOWED_STAGES,
      assertRecords:assertDocumentedTypeResolveRecords,
    });
    t.diagnostic(JSON.stringify({
      kind:'native-type-resolve-runtime-identity',
      node_version:result.nodeVersion,
      probe:'documented',
      runtime_identity:result.runtimeIdentity,
    }));
  } finally { remove(root); }
});

test('native Windows PowerShell 5.1 TypeResolve pinned construction lifecycle is localized', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-type-resolve-pinned-'));
  try {
    const {pinned} = windowsTypeResolveDiagnosticScripts();
    assertClosedTypeResolveDiagnosticScript(pinned, {
      probe:'pinned',
      requirePinnedSource:true,
    });
    const result = runNativeWindowsLifecycleProbe({
      probe:'pinned',
      root,
      script:pinned,
      allowedStages:TYPE_RESOLVE_PINNED_ALLOWED_STAGES,
      assertRecords:assertPinnedTypeResolveRecords,
    });
    t.diagnostic(JSON.stringify({
      kind:'native-type-resolve-runtime-identity',
      node_version:result.nodeVersion,
      probe:'pinned',
      runtime_identity:result.runtimeIdentity,
    }));
  } finally { remove(root); }
});

test('native Windows PowerShell 5.1 constructs the pinned stream types without a native invocation', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-pinvoke-construct-'));
  try {
    const {construct} = windowsStreamProbeScripts();
    assertPinnedWindowsStreamProbeScript(construct, {
      firstInvocationCount:0,
      literalPathParameter:null,
    });
    runNativeWindowsStreamProbe({
      probe:'construct',
      root,
      script:construct,
      expectedStageNames:['started','completed'],
      expectedRecords:[
        {version:1, probe:'construct', stage:'started'},
        {version:1, probe:'construct', stage:'completed',
          native_type:'DeepWorkStreamInventoryNative',
          stream_data_type:'DeepWorkStreamInventoryNative+WIN32_FIND_STREAM_DATA',
          methods:['FindFirstStreamW','FindNextStreamW','FindClose']},
      ],
    });
  } finally { remove(root); }
});

test('native Windows PowerShell 5.1 completes one fixed stream API lifecycle after pinned construction', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-pinvoke-once-'));
  try {
    const {invokeOnce, parameterBlock} = windowsStreamProbeScripts();
    assertPinnedWindowsStreamProbeScript(invokeOnce, {
      firstInvocationCount:1,
      nextInvocationCount:1,
      closeInvocationCount:1,
      literalPathParameter:parameterBlock,
    });
    const target = path.join(root, 'target.txt');
    const payload = Buffer.from('deep-work-s1\n', 'utf8');
    assert.equal(payload.length, 13);
    assert.equal(hash(payload), 'c19132bb23e9192a8ceee7166afabb9f57798e26657e9a165c20fcb37a153984');
    fs.writeFileSync(target, payload);
    const canonical = fs.realpathSync.native(target);
    const literalPath = canonical.startsWith('\\\\?\\') ? canonical
      : canonical.startsWith('\\\\') ? `\\\\?\\UNC\\${canonical.slice(2)}`
        : `\\\\?\\${canonical}`;
    runNativeWindowsStreamProbe({
      probe:'invoke-once',
      root,
      script:invokeOnce,
      literalPath,
      expectedStageNames:['started','constructed','first-returned','next-returned','completed'],
      expectedRecords:[
        {version:1, probe:'invoke-once', stage:'started'},
        {version:1, probe:'invoke-once', stage:'constructed'},
        {version:1, probe:'invoke-once', stage:'first-returned', method:'FindFirstStreamW',
          invalid_handle:false, stream_name:'::$DATA', stream_size:13},
        {version:1, probe:'invoke-once', stage:'next-returned', method:'FindNextStreamW',
          has_next:false, win32_error:38},
        {version:1, probe:'invoke-once', stage:'completed', method:'FindClose', closed:true},
      ],
    });
  } finally { remove(root); }
});

test('native Windows PowerShell 5.1 returns the fixed no-stream directory result', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-pinvoke-directory-'));
  try {
    const {invokeDirectory, parameterBlock} = windowsStreamProbeScripts();
    assertPinnedWindowsStreamProbeScript(invokeDirectory, {
      firstInvocationCount:1,
      closeInvocationCount:1,
      literalPathParameter:parameterBlock,
    });
    const canonical = fs.realpathSync.native(root);
    const literalPath = canonical.startsWith('\\\\?\\') ? canonical
      : canonical.startsWith('\\\\') ? `\\\\?\\UNC\\${canonical.slice(2)}`
        : `\\\\?\\${canonical}`;
    runNativeWindowsStreamProbe({
      probe:'invoke-directory',
      root,
      script:invokeDirectory,
      literalPath,
      expectedStageNames:['started','constructed','completed'],
      expectedRecords:[
        {version:1, probe:'invoke-directory', stage:'started'},
        {version:1, probe:'invoke-directory', stage:'constructed'},
        {version:1, probe:'invoke-directory', stage:'completed', method:'FindFirstStreamW',
          invalid_handle:true, win32_error:38},
      ],
    });
  } finally { remove(root); }
});

test('native Windows full stream helper stage probe localizes lifecycle stalls', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, () => {
  const root = makeRepo('dw-native-win-helper-stages-');
  try {
    const helper = path.join(__dirname, 'windows-stream-inventory.ps1');
    let script = fs.readFileSync(helper, 'utf8');
    const stage = (name) =>
      `[Console]::Out.WriteLine('{"version":1,"probe":"helper-stages","stage":"${name}"}'); [Console]::Out.Flush()`;
    for (const [anchor, name] of [
      ["$ErrorActionPreference = 'Stop'", 'started'],
      ['# DEEP_WORK_PINVOKE_SOURCE_END', 'constructed'],
      ['$inputText = [System.Text.UTF8Encoding]::new($false, $true).GetString($inputBuffer)',
        'input-read'],
      ['$row = Microsoft.PowerShell.Utility\\ConvertFrom-Json -InputObject $line -ErrorAction Stop',
        'row-parsed'],
      ['$streams = Get-CompleteStreamSet (Convert-ToExtendedPath $literal)', 'inventory-returned'],
      ['[Console]::Out.WriteLine($json)', 'row-written'],
    ]) {
      script = replaceWindowsStreamSourceOnce(script, anchor, `${anchor}\n${stage(name)}`);
    }
    const scriptPath = path.join(root, 'helper-stages.ps1');
    fs.writeFileSync(scriptPath, script);
    const inputBytes = Buffer.from(
      `${JSON.stringify({version:1, id:0, kind:'root', relative_path:null})}\n`, 'utf8');
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    const temp = process.env.TEMP || process.env.TMP || os.tmpdir();
    const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell',
      'v1.0', 'powershell.exe');
    const result = spawnSync(executable,
      ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
        '-File',scriptPath,'-RootPath',root,'-ExpectedRows','1',
        '-ExpectedInputBytes',String(inputBytes.length)], {
        cwd:root,
        env:{SystemRoot:systemRoot, WINDIR:systemRoot, TEMP:temp, TMP:temp, PATH:'',
          PSModulePath:path.win32.join(systemRoot, 'System32','WindowsPowerShell','v1.0','Modules')},
        input:inputBytes,
        encoding:'utf8',
        shell:false,
        windowsHide:true,
        timeout:WINDOWS_STREAM_INVENTORY_TIMEOUT_MS,
        maxBuffer:WINDOWS_STREAM_INVENTORY_MAX_OUTPUT_BYTES,
      });
    const expectedStages = ['started','constructed','input-read','row-parsed',
      'inventory-returned','row-written'];
    const diagnostic = JSON.stringify(nativeWindowsProbeEvidence(
      'helper-stages', result, WINDOWS_STREAM_INVENTORY_TIMEOUT_MS, expectedStages));
    assert.equal(result.error === undefined, true, diagnostic);
    assert.equal(result.status === 0, true, diagnostic);
    assert.equal(result.signal === null, true, diagnostic);
    assert.equal(result.stderr === '', true, diagnostic);
    const observed = result.stdout.split(/\r?\n/u).flatMap((line) => {
      try { const row = JSON.parse(line); return row.probe === 'helper-stages' ? [row.stage] : []; }
      catch { return []; }
    });
    assert.deepEqual(observed, expectedStages, diagnostic);
  } finally { remove(root); }
});

test('native Windows PowerShell 5.1 executes the fixed helper for exactly one root row', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, () => {
  const root = makeRepo('dw-native-win-direct-helper-');
  try {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    const temp = process.env.TEMP || process.env.TMP || os.tmpdir();
    const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell',
      'v1.0', 'powershell.exe');
    const helper = path.join(__dirname, 'windows-stream-inventory.ps1');
    const input = `${JSON.stringify({version:1, id:0, kind:'root', relative_path:null})}\n`;
    const inputBytes = Buffer.from(input, 'utf8');
    const closedEnv = {
      SystemRoot:systemRoot,
      WINDIR:systemRoot,
      TEMP:temp,
      TMP:temp,
      PATH:'',
      PSModulePath:path.win32.join(systemRoot, 'System32','WindowsPowerShell','v1.0','Modules'),
    };
    const result = spawnSync(executable,
      ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
        '-File',helper,'-RootPath',root,'-ExpectedRows','1',
        '-ExpectedInputBytes',String(inputBytes.length)], {
        cwd:root,
        env:closedEnv,
        input:inputBytes,
        encoding:'utf8',
        shell:false,
        windowsHide:true,
        timeout:WINDOWS_STREAM_INVENTORY_TIMEOUT_MS,
        maxBuffer:WINDOWS_STREAM_INVENTORY_MAX_OUTPUT_BYTES,
      });
    const diagnostic = JSON.stringify(nativeSpawnEvidence(result));
    assert.equal(result.error === undefined, true, diagnostic);
    assert.equal(result.status === 0, true, diagnostic);
    assert.equal(result.signal === null, true, diagnostic);
    assert.equal(result.stderr === '', true, diagnostic);
    assert.equal(typeof result.stdout === 'string' &&
      /^[^\r\n]+(?:\r?\n)?$/u.test(result.stdout), true, diagnostic);
    let row;
    try { row = JSON.parse(result.stdout.trimEnd()); }
    catch (error) {
      assert.fail(`native helper returned malformed JSON: ${diagnostic}; parse=${boundedCode(error?.code)}`);
    }
    const streamNames = new Set();
    const validStreams = Array.isArray(row?.streams) && row.streams.every((stream) => {
      if (!stream || typeof stream !== 'object' || Array.isArray(stream) ||
          Object.keys(stream).sort().join(',') !== 'name,size' ||
          typeof stream.name !== 'string' || /[\uD800-\uDFFF]/u.test(stream.name) ||
          !Number.isSafeInteger(stream.size) || stream.size < 0 || streamNames.has(stream.name)) {
        return false;
      }
      streamNames.add(stream.name);
      return true;
    });
    assert.equal(row && typeof row === 'object' && !Array.isArray(row) &&
      Object.keys(row).sort().join(',') === 'id,kind,streams,version' &&
      row.version === 1 && row.id === 0 && row.kind === 'root' && validStreams, true,
    diagnostic);
  } finally { remove(root); }
});

test('native Windows fixed helper completes a one-row inventory contract within each fixed bound', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, () => {
  const root = makeRepo('dw-native-win-one-row-');
  try {
    const {project, git} = caps(root);
    const stat = fs.lstatSync(root);
    const runtime = createPlatformRuntimeForTest({platform:'win32', manifestWalkerImpl:() => ({
      entries:[], directories:[], typedRows:[{version:1, id:0, kind:'root', relative_path:null,
        absolutePath:root, identity:{dev:String(stat.dev), ino:String(stat.ino), mode:stat.mode,
          type:'directory'}}],
    })});
    const startedAt = Date.now();
    let manifest;
    try {
      manifest = runtime.captureWorktreeManifest({projectCapability:project,
        gitCapability:git, runtimeExclusions:[]});
    } catch (error) {
      assert.fail(`native one-row wrapper failed: ${JSON.stringify(nativeWrapperFailureEvidence(error))}`);
    }
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
    assert.equal(Date.now() - startedAt < WINDOWS_STREAM_INVENTORY_TIMEOUT_MS * 2, true);
  } finally { remove(root); }
});

test('Git attributes preserve exact raw Windows stream helper authority on checkout', () => {
  const helperRelative = 'runtime/windows-stream-inventory.ps1';
  const helperPath = path.join(__dirname, 'windows-stream-inventory.ps1');
  const repositoryRoot = path.resolve(__dirname, '..');
  const attribute = execFileSync('git', ['check-attr','eol','--',helperRelative],
    {cwd:repositoryRoot, encoding:'utf8'}).trim();
  assert.equal(attribute, `${helperRelative}: eol: lf`);
  const helperBytes = fs.readFileSync(helperPath);
  assert.equal(hash(helperBytes), WINDOWS_STREAM_INVENTORY_HELPER_SHA256);
  const source = helperBytes.toString('utf8');
  assert.match(source, /\[Console\]::OpenStandardInput\(\)/u);
  assert.match(source, /\$inputStream\.Read\(\$inputBuffer, \$inputOffset, \$ExpectedInputBytes - \$inputOffset\)/u);
  assert.doesNotMatch(source, /\[Console\]::In(?:\.|\b)/u);
  assert.match(source,
    /Microsoft\.PowerShell\.Utility\\ConvertFrom-Json -InputObject \$line/u);
  assert.match(source,
    /Microsoft\.PowerShell\.Utility\\ConvertTo-Json -InputObject \$outputRow/u);
  assert.doesNotMatch(source, /\|\s*(?:ConvertFrom-Json|ConvertTo-Json)\b/u);
  const begin = source.indexOf('# DEEP_WORK_PINVOKE_SOURCE_BEGIN');
  const end = source.indexOf('# DEEP_WORK_PINVOKE_SOURCE_END');
  const lineStart = source.indexOf('\n', begin) + 1;
  assert.equal(begin >= 0 && end > begin && lineStart > begin, true);
  assert.equal(hash(Buffer.from(source.slice(lineStart, end))),
    WINDOWS_STREAM_INVENTORY_PINVOKE_SHA256);
});

test('Windows stream execution validator rejects the complete helper output/failure mutant matrix', () => {
  const root = makeRepo('dw-stream-mutants-');
  try {
    const directory = path.join(root, 'typed');
    const file = path.join(directory, 'file.txt');
    fs.mkdirSync(directory);
    fs.writeFileSync(file, 'main');
    const {project, git} = caps(root);
    const typedRows = [
      {version:1, id:0, kind:'root', relative_path:null, absolutePath:fs.realpathSync(root)},
      {version:1, id:1, kind:'directory', relative_path:'typed', absolutePath:fs.realpathSync(directory)},
      {version:1, id:2, kind:'file', relative_path:'typed/file.txt', absolutePath:fs.realpathSync(file)},
    ].map((row) => {
      const stat = fs.lstatSync(row.absolutePath);
      return {...row, identity:{dev:String(stat.dev), ino:String(stat.ino), mode:stat.mode,
        type:stat.isDirectory() ? 'directory' : 'file'}};
    });
    const cleanRows = () => typedRows.map((row) => ({version:1, id:row.id, kind:row.kind,
      streams:row.kind === 'file' ? [{name:'::$DATA', size:4}] : []}));
    const output = (rows) => `${rows.map(JSON.stringify).join('\n')}\n`;
    const okExecution = (rows = cleanRows()) => ({error:null, status:0, signal:null, stderr:'',
      result:{ok:true, stdout:output(rows), stderr:''}});
    const scenarios = [
      ['omitted-root', () => okExecution(cleanRows().slice(1)), /stream-result-set/],
      ['omitted-directory', () => okExecution(cleanRows().filter((row) => row.id !== 1)), /stream-result-set/],
      ['omitted-file', () => okExecution(cleanRows().filter((row) => row.id !== 2)), /stream-result-set/],
      ['malformed-json', () => ({...okExecution(), result:{ok:true,
        stdout:`{bad\n${cleanRows().slice(1).map(JSON.stringify).join('\n')}\n`, stderr:''}}),
        /stream-output/],
      ['foreign-id', () => okExecution(cleanRows().map((row) => row.id === 2 ? {...row, id:99} : row)),
        /stream-result-set/],
      ['wrong-kind', () => okExecution(cleanRows().map((row) => row.id === 1 ? {...row, kind:'file'} : row)),
        /stream-result-set/],
      ['duplicate-row', () => okExecution([...cleanRows().slice(0, 2), cleanRows()[1]]), /stream-output/],
      ['duplicate-stream', () => okExecution(cleanRows().map((row) => row.id === 2
        ? {...row, streams:[{name:'::$DATA',size:4},{name:'::$DATA',size:4}]} : row)), /stream-output/],
      ['negative-size', () => okExecution(cleanRows().map((row) => row.id === 2
        ? {...row, streams:[{name:'::$DATA',size:-1}]} : row)), /stream-output/],
      ['malformed-utf16', () => okExecution(cleanRows().map((row) => row.id === 2
        ? {...row, streams:[{name:'bad\ud800',size:1}]} : row)), /stream-output/],
      ['named-stream', () => okExecution(cleanRows().map((row) => row.id === 0
        ? {...row, streams:[{name:':hidden:$DATA',size:1}]} : row)), /alternate-stream/],
      ['missing-unnamed-file-stream', () => okExecution(cleanRows().map((row) => row.id === 2
        ? {...row, streams:[]} : row)), /alternate-stream/],
      ['timeout', () => ({...okExecution(), error:Object.assign(new Error('timeout'), {code:'ETIMEDOUT'})}),
        /stream-timeout/],
      ['nonzero', () => ({...okExecution(), status:7}), /stream-helper-failed/],
      ['signal', () => ({...okExecution(), signal:'SIGTERM'}), /stream-helper-failed/],
      ['outer-stderr', () => ({...okExecution(), stderr:'noise'}), /stream-helper-failed/],
      ['result-nonzero', () => ({...okExecution(), result:{ok:false, stdout:'', stderr:''}}),
        /stream-helper-failed/],
      ['missing-result', () => ({error:null, status:0, signal:null, stderr:'', result:null}),
        /stream-helper-failed/],
      ['result-stderr', () => ({...okExecution(), result:{ok:true, stdout:output(cleanRows()), stderr:'noise'}}),
        /stream-helper-failed/],
      ['overflow', () => ({...okExecution(), result:{ok:true,
        stdout:'x'.repeat(WINDOWS_STREAM_INVENTORY_MAX_OUTPUT_BYTES + 1), stderr:''}}),
        /stream-helper-failed/],
    ];
    for (const [name, execution, pattern] of scenarios) {
      const runtime = createPlatformRuntimeForTest({platform:'win32',
        manifestWalkerImpl:() => ({entries:[], directories:[], typedRows}),
        windowsStreamInventoryImpl:() => execution()});
      assert.throws(() => runtime.captureWorktreeManifest({projectCapability:project,
        gitCapability:git, runtimeExclusions:[]}), pattern, name);
    }

    const innerTimeout = createPlatformRuntimeForTest({platform:'win32',
      manifestWalkerImpl:() => ({entries:[], directories:[], typedRows}),
      windowsStreamInventoryImpl:() => ({error:null, status:0, signal:null, stderr:'',
        envelopeError:null, result:{ok:false, stdout:'', stderr:'', timedOut:true,
          error:{code:'process-timeout', message:'process timed out'},
          stages:{started:true, 'tool-result':false, termination:'complete'}}}),
    });
    assert.throws(() => innerTimeout.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), (error) =>
      error.code === 'worktree-manifest-stream-timeout' &&
      error.innerError?.code === 'process-timeout' &&
      error.stages?.started === true && error.stages?.['tool-result'] === false &&
      error.stages?.termination === 'complete');

    let pass = 0;
    const changing = createPlatformRuntimeForTest({platform:'win32',
      manifestWalkerImpl:() => ({entries:[], directories:[], typedRows}),
      windowsStreamInventoryImpl:() => {
        pass += 1;
        return okExecution(cleanRows().map((row) => row.id === 2
          ? {...row, streams:[{name:'::$DATA',size:pass === 1 ? 4 : 5}]} : row));
      }});
    assert.throws(() => changing.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), /alternate-stream/);

    let removalPasses = 0;
    const removal = createPlatformRuntimeForTest({platform:'win32',
      manifestWalkerImpl:() => ({entries:[], directories:[], typedRows}),
      windowsStreamInventoryImpl:({pass:inventoryPass}) => {
        removalPasses += 1;
        return okExecution(cleanRows().map((row) => row.id === 2 && inventoryPass === 1
          ? {...row, streams:[{name:'::$DATA',size:4},{name:':removed:$DATA',size:1}]} : row));
      }});
    assert.throws(() => removal.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), /alternate-stream/);
    assert.equal(removalPasses, 2, 'removal between complete passes must be observed');

    let identityPass = 0;
    const identityChanging = createPlatformRuntimeForTest({platform:'win32',
      manifestWalkerImpl:() => ({entries:[], directories:[], typedRows}),
      windowsStreamInventoryImpl:() => {
        identityPass += 1;
        if (identityPass === 1) {
          const replacement = `${file}.replacement`;
          fs.writeFileSync(replacement, 'main');
          fs.renameSync(replacement, file);
        }
        return okExecution();
      }});
    assert.throws(() => identityChanging.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), /worktree-manifest-unstable/);
  } finally { remove(root); }
});

test('project-state issuance applies portable-path-v1 before granting authority', () => {
  const root = makeRepo();
  try {
    const accepted = issueProjectStateCapability(root, path.join(root, '.claude', '한 글.json'),
      {role:'state', allowMissingLeaf:true});
    assert.equal(accepted.path, path.join(root, '.claude', '한 글.json'));
    for (const relative of [
      '.claude/CON.txt', '.claude/a:b', '.claude/trailing.', '.claude/trailing ',
      '.claude/e\u0301.json', '.claude/COM¹.log',
    ]) {
      const candidate = path.join(root, ...relative.split('/'));
      assert.throws(() => issueProjectStateCapability(root, candidate,
        {role:'state', allowMissingLeaf:true}), /portable-path-v1/, relative);
    }
  } finally { remove(root); }
});

test('session work-dir capability binds the exact real .deep-work session tuple', () => {
  const root = makeRepo();
  try {
    const exact = path.join(root, '.deep-work', 's-a1b2c3d4');
    fs.mkdirSync(exact, {recursive:true});
    const sessionState = issueProjectStateCapability(root,
      path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
    const cap = issueProjectStateCapability(root, exact,
      {role:'session-work-dir', sessionStateCapability:sessionState});
    assert.deepEqual([cap.role, cap.path], ['session-work-dir', exact]);
    for (const candidate of [
      path.join(root, '.claude', 'sessions', 's-a1b2c3d4'),
      path.join(root, '.deep-work', 'invented', 's-a1b2c3d4'),
      path.join(root, '.deep-work', 's-a1b2c3d4', 'nested'),
      path.join(root, '.deep-work', 's-deadbeef'),
    ]) {
      if (!fs.existsSync(candidate)) fs.mkdirSync(candidate, {recursive:true});
      assert.throws(() => issueProjectStateCapability(root, candidate,
        {role:'session-work-dir', sessionStateCapability:sessionState}),
      /project-state-route|session-capability-identity/);
    }
  } finally { remove(root); }
});

test('owned-temp durable consumer journal survives reissue and rejects a second consumer', () => {
  const root = makeRepo();
  try {
    const workDir = path.join(root, '.deep-work', 's-a1b2c3d4');
    fs.mkdirSync(workDir, {recursive:true});
    const sessionState = issueProjectStateCapability(root,
      path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
    const work = issueProjectStateCapability(root, workDir,
      {role:'session-work-dir', sessionStateCapability:sessionState});
    const producerOperationId = `op-${'1'.repeat(32)}`;
    const consumerOperationId = `op-${'2'.repeat(32)}`;
    const input = {sessionCapability:work, operationId:producerOperationId, purpose:'notes'};
    const first = issueOwnedTempCapability(input);
    atomicWriteFile(first, 'durable');
    consumeOwnedTemp(first, {operationId:consumerOperationId, purpose:'notes',
      expectedDigest:first.contentDigest});
    const retry = issueOwnedTempCapability(input);
    atomicWriteFile(retry, 'durable');
    assert.doesNotThrow(() => consumeOwnedTemp(retry, {operationId:consumerOperationId,
      purpose:'notes', expectedDigest:first.contentDigest}));
    const rival = issueOwnedTempCapability(input);
    atomicWriteFile(rival, 'durable');
    assert.throws(() => consumeOwnedTemp(rival, {operationId:`op-${'3'.repeat(32)}`,
      purpose:'notes', expectedDigest:first.contentDigest}), /owned-temp-already-consumed/);
    assert.notEqual(consumerOperationId, producerOperationId);
  } finally { remove(root); }
});

test('owned-temp terminal tombstone prevents same-producer rewrite after consume/remove/reissue', () => {
  const root = makeRepo();
  try {
    const {work} = caps(root);
    const producerId = `op-${'b'.repeat(32)}`;
    const consumerId = `op-${'c'.repeat(32)}`;
    const input = {sessionCapability:work, operationId:producerId, purpose:'notes'};
    const first = issueOwnedTempCapability(input);
    atomicWriteFile(first, 'terminal-old');
    const digest = first.contentDigest;
    consumeOwnedTemp(first, {operationId:consumerId, purpose:'notes', expectedDigest:digest});
    assert.equal(compareRemoveOwnedTemp(first, digest), true);
    assert.equal(fs.existsSync(first.path), false);
    assert.equal(fs.existsSync(`${first.path}.owner.json`), false);

    const exactRetry = issueOwnedTempCapability(input);
    assert.deepEqual(atomicWriteFile(exactRetry, 'terminal-old'), {
      written:false, adopted:true, terminal:true, sha256:digest,
    });
    assert.equal(exactRetry.state, 'removed');
    assert.equal(fs.existsSync(exactRetry.path), false);
    assert.doesNotThrow(() => consumeOwnedTemp(exactRetry,
      {operationId:consumerId, purpose:'notes', expectedDigest:digest}));
    assert.throws(() => consumeOwnedTemp(exactRetry,
      {operationId:`op-${'d'.repeat(32)}`, purpose:'notes', expectedDigest:digest}),
    /owned-temp-already-consumed/);

    const differentRetry = issueOwnedTempCapability(input);
    assert.throws(() => atomicWriteFile(differentRetry, 'terminal-different'),
      /owned-temp-terminal-conflict/);
    assert.equal(fs.existsSync(differentRetry.path), false);

    const fresh = issueOwnedTempCapability({sessionCapability:work,
      operationId:`op-${'e'.repeat(32)}`, purpose:'notes'});
    assert.equal(atomicWriteFile(fresh, 'terminal-different').written, true);
  } finally { remove(root); }
});

test('owned-temp terminal tombstone is enforced in a fresh Node process', () => {
  const root = makeRepo();
  try {
    const {work} = caps(root);
    const producerId = `op-${'f'.repeat(32)}`;
    const consumerId = `op-${'1'.repeat(32)}`;
    const cap = issueOwnedTempCapability({sessionCapability:work,
      operationId:producerId, purpose:'notes'});
    atomicWriteFile(cap, 'cross-process');
    const digest = cap.contentDigest;
    consumeOwnedTemp(cap, {operationId:consumerId, purpose:'notes', expectedDigest:digest});
    compareRemoveOwnedTemp(cap, digest);
    const worker = path.join(fixtureRoot, 'owned-temp-reissue-worker.js');
    const exact = JSON.parse(execFileSync(process.execPath,
      [worker, root, producerId, 'notes', 'cross-process'], {encoding:'utf8'}));
    assert.deepEqual(exact, {ok:true, result:{written:false, adopted:true, terminal:true,
      sha256:digest}, state:'removed', targetExists:false});
    assert.throws(() => execFileSync(process.execPath,
      [worker, root, producerId, 'notes', 'different'], {encoding:'utf8', stdio:['ignore','pipe','pipe']}),
    /Command failed/);
    assert.equal(fs.existsSync(cap.path), false);
  } finally { remove(root); }
});

test('owned-temp cleanup resumes every process-death boundary before exposing removed', () => {
  const boundaries = [
    'after-cleanup-intent-fsync',
    'after-owner-rename',
    'after-target-rename',
    'after-target-unlink',
    'after-owner-unlink',
    'after-cleanup-directory-fsync',
    'after-terminal-stage-write',
    'after-terminal-stage-fsync',
    'after-terminal-rename',
  ];
  for (const boundary of boundaries) {
    const root = makeRepo(`dw-owned-cleanup-${boundary}-`);
    try {
      let armed = false;
      let fired = false;
      let targetPath;
      let ownerPath;
      const directoryFds = new Set();
      const terminalStageFds = new Set();
      const runtime = createPlatformRuntimeForTest({fsImpl:{
        openSync(value, flags, mode) {
          if (armed && boundary === 'after-cleanup-directory-fsync' &&
              String(value).startsWith(`${targetPath}.terminal.json.publish.`) && flags === 'wx') {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          const fd = fs.openSync(value, flags, mode);
          if (flags === 'r' && value === path.dirname(targetPath || '')) directoryFds.add(fd);
          if (String(value).startsWith(`${targetPath}.terminal.json.publish.`)) {
            terminalStageFds.add(fd);
          }
          return fd;
        },
        closeSync(fd) {
          directoryFds.delete(fd);
          terminalStageFds.delete(fd);
          return fs.closeSync(fd);
        },
        writeFileSync(fd, bytes) {
          const result = fs.writeFileSync(fd, bytes);
          if (armed && !fired && boundary === 'after-terminal-stage-write' &&
              terminalStageFds.has(fd)) {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          return result;
        },
        fsyncSync(fd) {
          const result = fs.fsyncSync(fd);
          if (armed && !fired && boundary === 'after-terminal-stage-fsync' &&
              terminalStageFds.has(fd)) {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          if (armed && !fired && boundary === 'after-owner-unlink' && directoryFds.has(fd) &&
              !fs.existsSync(ownerPath) && !fs.existsSync(targetPath)) {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          return result;
        },
        renameSync(source, destination) {
          if (armed && !fired && boundary === 'after-cleanup-intent-fsync' && source === ownerPath) {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          const result = fs.renameSync(source, destination);
          if (armed && !fired && boundary === 'after-owner-rename' && source === ownerPath) {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          if (armed && !fired && boundary === 'after-target-rename' && source === targetPath) {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          if (armed && !fired && boundary === 'after-terminal-rename' &&
              String(source).startsWith(`${targetPath}.terminal.json.publish.`) &&
              destination === `${targetPath}.terminal.json`) {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          return result;
        },
        unlinkSync(value) {
          const result = fs.unlinkSync(value);
          if (armed && !fired && boundary === 'after-target-unlink' &&
              String(value).startsWith(`${targetPath}.remove.`)) {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          if (armed && !fired && boundary === 'after-owner-unlink' &&
              String(value).startsWith(`${ownerPath}.remove.`)) {
            fired = true;
            throw Object.assign(new Error(boundary), {code:'EIO'});
          }
          return result;
        },
      }});
      const state = runtime.issueProjectStateCapability(root,
        path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
      const work = runtime.issueProjectStateCapability(root,
        path.join(root, '.deep-work', 's-a1b2c3d4'),
        {role:'session-work-dir', sessionStateCapability:state});
      const producerId = `op-${hash(boundary).slice(0, 32)}`;
      const consumerId = `op-${hash(`consumer-${boundary}`).slice(0, 32)}`;
      const first = runtime.issueOwnedTempCapability({sessionCapability:work,
        operationId:producerId, purpose:'notes'});
      targetPath = first.path;
      ownerPath = `${targetPath}.owner.json`;
      runtime.atomicWriteFile(first, `payload-${boundary}`);
      const digest = first.contentDigest;
      consumeOwnedTemp(first, {operationId:consumerId, purpose:'notes', expectedDigest:digest});
      armed = true;
      assert.throws(() => compareRemoveOwnedTemp(first, digest), new RegExp(boundary));
      assert.equal(fired, true, boundary);
      armed = false;

      const retryState = issueProjectStateCapability(root,
        path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
      const retryWork = issueProjectStateCapability(root,
        path.join(root, '.deep-work', 's-a1b2c3d4'),
        {role:'session-work-dir', sessionStateCapability:retryState});
      const retry = issueOwnedTempCapability({sessionCapability:retryWork,
        operationId:producerId, purpose:'notes'});
      assert.equal(retry.state, 'removed', boundary);
      assert.deepEqual(atomicWriteFile(retry, `payload-${boundary}`),
        {written:false, adopted:true, terminal:true, sha256:digest}, boundary);
      assert.equal(fs.existsSync(targetPath), false, boundary);
      assert.equal(fs.existsSync(ownerPath), false, boundary);
      assert.equal(fs.readdirSync(path.dirname(targetPath)).some((name) => name.includes('.remove.')),
        false, boundary);
      const repeated = issueOwnedTempCapability({sessionCapability:retryWork,
        operationId:producerId, purpose:'notes'});
      assert.equal(repeated.state, 'removed', boundary);
    } finally { remove(root); }
  }
});

test('owned-temp cleanup converges from fresh-process death at every durable stage', async () => {
  if (process.platform === 'win32') return test.skip('SIGKILL cleanup matrix is POSIX-only');
  const boundaries = [
    'after-cleanup-intent-fsync',
    'after-owner-rename',
    'after-target-rename',
    'after-target-unlink',
    'after-owner-unlink',
    'after-cleanup-directory-fsync',
    'after-terminal-stage-write',
    'after-terminal-stage-fsync',
    'after-terminal-rename',
    'after-terminal-directory-fsync',
  ];
  for (const boundary of boundaries) {
    const root = makeRepo(`dw-owned-cleanup-process-${boundary}-`);
    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-owned-cleanup-control-'));
    try {
      const producerId = `op-${hash(`producer-${boundary}`).slice(0, 32)}`;
      const consumerId = `op-${hash(`consumer-${boundary}`).slice(0, 32)}`;
      const worker = fork(path.join(fixtureRoot, 'owned-temp-cleanup-worker.js'),
        [root, boundary, producerId, consumerId, control],
        {stdio:['ignore','ignore','inherit','ipc']});
      const markerPath = path.join(control, `${boundary}.json`);
      const marker = await waitForJsonMarker(markerPath);
      assert.deepEqual({boundary:marker.boundary, pid:marker.pid, producerId:marker.producerId,
        consumerId:marker.consumerId}, {boundary, pid:worker.pid, producerId, consumerId});
      worker.kill('SIGKILL');
      const exit = await new Promise((resolve) => worker.once('exit', (code, signal) =>
        resolve({code, signal})));
      assert.equal(exit.signal, 'SIGKILL', boundary);

      const reissue = JSON.parse(execFileSync(process.execPath,
        [path.join(fixtureRoot, 'owned-temp-reissue-worker.js'), root, producerId, 'notes',
          `payload-${boundary}`], {encoding:'utf8'}));
      assert.deepEqual(reissue, {ok:true, result:{written:false, adopted:true, terminal:true,
        sha256:marker.digest}, state:'removed', targetExists:false}, boundary);
      assert.equal(fs.existsSync(`${marker.targetPath}.owner.json`), false, boundary);
      assert.equal(fs.existsSync(`${marker.targetPath}.terminal.json`), true, boundary);
      assert.equal(fs.readdirSync(path.dirname(marker.targetPath)).some((name) =>
        name.includes('.remove.') || name.includes('.terminal.json.publish.')), false, boundary);
    } finally { remove(root); remove(control); }
  }
});

test('all crash-resumable sidecars recover fresh-process open and torn-write death', async (t) => {
  if (process.platform === 'win32') return test.skip('SIGKILL sidecar matrix is POSIX-only');
  for (const sidecarKind of ['cleanup-intent','finalized-consumer','owner','owned-consumer']) {
    for (const boundary of ['after-open','during-write','after-publish']) {
      await t.test(`${sidecarKind}:${boundary}`, async () => {
      const root = makeRepo(`dw-sidecar-${sidecarKind}-${boundary}-`);
      const control = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sidecar-control-'));
      try {
        const producerId = `op-${hash(`producer-${sidecarKind}-${boundary}`).slice(0, 32)}`;
        const consumerId = `op-${hash(`consumer-${sidecarKind}-${boundary}`).slice(0, 32)}`;
        const worker = fork(path.join(fixtureRoot, 'sidecar-crash-worker.js'),
          [root, sidecarKind, boundary, producerId, consumerId, control],
          {stdio:['ignore','ignore','inherit','ipc']});
        const markerPath = path.join(control, `${sidecarKind}-${boundary}.json`);
        const marker = await waitForJsonMarker(markerPath);
        assert.deepEqual({sidecarKind:marker.sidecarKind, boundary:marker.boundary,
          pid:marker.pid, producerId:marker.producerId, consumerId:marker.consumerId},
        {sidecarKind, boundary, pid:worker.pid, producerId, consumerId});
        worker.kill('SIGKILL');
        const exit = await new Promise((resolve) => worker.once('exit', (code, signal) =>
          resolve({code, signal})));
        assert.equal(exit.signal, 'SIGKILL', `${sidecarKind}:${boundary}`);
        const interrupted = fs.readFileSync(marker.actualPath);
        assert.equal(interrupted.length === 0 || interrupted.length < 512, true,
          `${sidecarKind}:${boundary}`);

        const retry = JSON.parse(execFileSync(process.execPath,
          [path.join(fixtureRoot, 'sidecar-retry-worker.js'), root, sidecarKind, boundary,
            producerId, consumerId], {encoding:'utf8', stdio:['ignore','pipe','pipe']}));
        if (sidecarKind === 'finalized-consumer') {
          assert.deepEqual({state:retry.state, envelopeOperationId:retry.envelopeOperationId},
            {state:'enveloped', envelopeOperationId:consumerId}, `${sidecarKind}:${boundary}`);
        } else {
          assert.equal(retry.state, 'removed', `${sidecarKind}:${boundary}`);
          assert.equal(retry.targetExists, false, `${sidecarKind}:${boundary}`);
          assert.equal(retry.ownerExists, false, `${sidecarKind}:${boundary}`);
          assert.deepEqual(retry.removeResidue, [], `${sidecarKind}:${boundary}`);
        }
        assert.equal(fs.readdirSync(path.dirname(marker.sidecarPath))
          .some((name) => name.includes('.publish.')), false, `${sidecarKind}:${boundary}`);
      } finally { remove(root); remove(control); }
      });
    }
  }
});

test('exclusive sidecar staging rejects and preserves foreign mismatched bytes', () => {
  const root = makeRepo('dw-sidecar-foreign-stage-');
  try {
    let armed = false;
    let sidecarPath;
    let foreignPath;
    const foreignBytes = Buffer.from('foreign-sidecar-staging\n');
    const runtime = createPlatformRuntimeForTest({fsImpl:{
      openSync(value, flags, mode) {
        if (armed && flags === 'wx' &&
            (value === sidecarPath || String(value).startsWith(`${sidecarPath}.publish.`))) {
          armed = false;
          foreignPath = value;
          fs.writeFileSync(value, foreignBytes, {flag:'wx'});
        }
        return fs.openSync(value, flags, mode);
      },
    }});
    const state = runtime.issueProjectStateCapability(root,
      path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
    const work = runtime.issueProjectStateCapability(root,
      path.join(root, '.deep-work', 's-a1b2c3d4'),
      {role:'session-work-dir', sessionStateCapability:state});
    const temp = runtime.issueOwnedTempCapability({sessionCapability:work,
      operationId:`op-${'0'.repeat(32)}`, purpose:'notes'});
    sidecarPath = `${temp.path}.owner.json`;
    armed = true;
    assert.throws(() => runtime.atomicWriteFile(temp, 'foreign-stage-safe'),
      /exclusive-sidecar-staging-invalid|owned-temp-foreign/);
    assert.deepEqual(fs.readFileSync(foreignPath), foreignBytes);
    assert.equal(fs.existsSync(sidecarPath), false);
    assert.equal(fs.existsSync(temp.path), false);
  } finally { remove(root); }
});

test('owned-temp cleanup recovery retains drifted authenticated artifacts', () => {
  const root = makeRepo('dw-owned-cleanup-foreign-');
  try {
    let armed = false;
    let ownerPath;
    const runtime = createPlatformRuntimeForTest({fsImpl:{
      renameSync(source, destination) {
        if (armed && source === ownerPath) {
          throw Object.assign(new Error('cleanup-crash'), {code:'EIO'});
        }
        return fs.renameSync(source, destination);
      },
    }});
    const state = runtime.issueProjectStateCapability(root,
      path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
    const work = runtime.issueProjectStateCapability(root,
      path.join(root, '.deep-work', 's-a1b2c3d4'),
      {role:'session-work-dir', sessionStateCapability:state});
    const producerId = `op-${'9'.repeat(32)}`;
    const first = runtime.issueOwnedTempCapability({sessionCapability:work,
      operationId:producerId, purpose:'notes'});
    ownerPath = `${first.path}.owner.json`;
    runtime.atomicWriteFile(first, 'foreign-safe');
    const digest = first.contentDigest;
    consumeOwnedTemp(first, {operationId:`op-${'8'.repeat(32)}`, purpose:'notes',
      expectedDigest:digest});
    armed = true;
    assert.throws(() => compareRemoveOwnedTemp(first, digest), /cleanup-crash/);
    armed = false;
    fs.writeFileSync(ownerPath, 'foreign-owner\n');

    const retryState = issueProjectStateCapability(root,
      path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
    const retryWork = issueProjectStateCapability(root,
      path.join(root, '.deep-work', 's-a1b2c3d4'),
      {role:'session-work-dir', sessionStateCapability:retryState});
    assert.throws(() => issueOwnedTempCapability({sessionCapability:retryWork,
      operationId:producerId, purpose:'notes'}), /owned-temp-(foreign|cleanup)/);
    assert.equal(fs.readFileSync(ownerPath, 'utf8'), 'foreign-owner\n');
    assert.equal(fs.readFileSync(first.path, 'utf8'), 'foreign-safe');
  } finally { remove(root); }
});

test('owned-temp cleanup preserves a foreign terminal staging artifact observed before intent', () => {
  const root = makeRepo('dw-owned-cleanup-foreign-stage-');
  try {
    const {work} = caps(root);
    const producerOperationId = `op-${'a'.repeat(32)}`;
    const consumerOperationId = `op-${'b'.repeat(32)}`;
    const temp = issueOwnedTempCapability({sessionCapability:work,
      operationId:producerOperationId, purpose:'notes'});
    atomicWriteFile(temp, 'foreign-terminal-stage');
    consumeOwnedTemp(temp, {operationId:consumerOperationId, purpose:'notes',
      expectedDigest:temp.contentDigest});
    const cleanupId = hash(Buffer.from(canonicalJsonForTest({version:1,
      sessionId:'s-a1b2c3d4', producerOperationId, consumerOperationId,
      purpose:'notes', contentDigest:temp.contentDigest}))).slice(0, 32);
    const stagingPath = `${temp.path}.terminal.json.publish.${cleanupId}`;
    const foreignBytes = Buffer.from('{"cleanupDigest"');
    fs.writeFileSync(stagingPath, foreignBytes);

    assert.throws(() => compareRemoveOwnedTemp(temp, temp.contentDigest),
      /owned-temp-terminal-staging/);
    assert.deepEqual(fs.readFileSync(stagingPath), foreignBytes);
    assert.equal(fs.readFileSync(temp.path, 'utf8'), 'foreign-terminal-stage');
    assert.equal(fs.existsSync(`${temp.path}.owner.json`), true);
    assert.equal(fs.existsSync(`${temp.path}.cleanup.json`), false);
  } finally { remove(root); }
});

test('project handoff rejects stale root authority before issuance and immediate publication', () => {
  const root = makeRepo();
  const old = `${root}.old`;
  try {
    const project = issueProjectStateCapability(root, root, {role:'project-root'});
    fs.renameSync(root, old);
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q'], {cwd:root});
    assert.throws(() => issueProjectHandoffOutputCapability({projectCapability:project,
      sessionId:'s-a1b2c3d4', operationId:`op-${'2'.repeat(32)}`}),
    /path-capability-identity/);
  } finally { remove(root); remove(old); }

  const second = makeRepo();
  const secondOld = `${second}.old`;
  try {
    const project = issueProjectStateCapability(second, second, {role:'project-root'});
    const handoff = issueProjectHandoffOutputCapability({projectCapability:project,
      sessionId:'s-a1b2c3d4', operationId:`op-${'3'.repeat(32)}`});
    fs.renameSync(second, secondOld);
    fs.mkdirSync(second);
    execFileSync('git', ['init', '-q'], {cwd:second});
    assert.throws(() => atomicWriteFile(handoff, '{}\n'), /path-capability-identity/);
    assert.equal(fs.existsSync(handoff.path), false);
  } finally { remove(second); remove(secondOld); }
});

test('project handoff binds the authenticated Git repository marker across issuance/publication', () => {
  const root = makeRepo();
  const oldGit = path.join(root, '.git.old');
  try {
    const project = issueProjectStateCapability(root, root, {role:'project-root'});
    fs.renameSync(path.join(root, '.git'), oldGit);
    execFileSync('git', ['init', '-q'], {cwd:root});
    assert.throws(() => issueProjectHandoffOutputCapability({projectCapability:project,
      sessionId:'s-a1b2c3d4', operationId:`op-${'4'.repeat(32)}`}),
    /path-capability-identity/);
  } finally { remove(root); }

  const second = makeRepo();
  try {
    const project = issueProjectStateCapability(second, second, {role:'project-root'});
    const handoff = issueProjectHandoffOutputCapability({projectCapability:project,
      sessionId:'s-a1b2c3d4', operationId:`op-${'5'.repeat(32)}`});
    fs.renameSync(path.join(second, '.git'), path.join(second, '.git.old'));
    execFileSync('git', ['init', '-q'], {cwd:second});
    assert.throws(() => atomicWriteFile(handoff, '{}\n'), /path-capability-identity/);
  } finally { remove(second); }
});

test('every session-derived mutation revalidates source state and work-directory authority', () => {
  const root = makeRepo('dw-session-child-drift-');
  try {
    const {sessionState, work} = caps(root);
    const beforeWrite = issueOwnedTempCapability({sessionCapability:work,
      operationId:`op-${'1'.repeat(32)}`, purpose:'notes'});
    const beforeConsume = issueOwnedTempCapability({sessionCapability:work,
      operationId:`op-${'2'.repeat(32)}`, purpose:'notes'});
    atomicWriteFile(beforeConsume, 'consume-after-drift');
    const beforeRemove = issueOwnedTempCapability({sessionCapability:work,
      operationId:`op-${'3'.repeat(32)}`, purpose:'notes'});
    atomicWriteFile(beforeRemove, 'remove-after-drift');
    consumeOwnedTemp(beforeRemove, {operationId:`op-${'4'.repeat(32)}`, purpose:'notes',
      expectedDigest:beforeRemove.contentDigest});
    const sessionOutput = issueSessionEnvelopeOutputCapability({sessionCapability:work});
    const sliceOutput = issueSliceEnvelopeOutputCapability({sessionCapability:work, slice:'SLICE-001'});
    const producerId = `op-${'5'.repeat(32)}`;
    const payload = Buffer.from('{"done":true}\n');
    const payloadPath = path.join(work.path, '.operation-results', producerId,
      'finalized-receipt-payload.json');
    fs.mkdirSync(path.dirname(payloadPath), {recursive:true});
    fs.writeFileSync(payloadPath, payload);
    const finalized = issueFinalizedReceiptPayloadCapability({sessionCapability:work,
      producerOperationReceipt:{version:1, kind:'finish-merge', operationId:producerId,
        sessionId:'s-a1b2c3d4', stage:'payload-published', sourceTempDigest:'a'.repeat(64),
        finalizedBytesDigest:hash(payload)}});

    fs.writeFileSync(sessionState.path,
      '---\nwork_dir: .deep-work/s-a1b2c3d4\ncurrent_phase: finish\n---\n');
    assert.throws(() => atomicWriteFile(beforeWrite, 'write-after-drift'),
      /session-capability-identity/);
    assert.throws(() => consumeOwnedTemp(beforeConsume,
      {operationId:`op-${'6'.repeat(32)}`, purpose:'notes',
        expectedDigest:beforeConsume.contentDigest}), /session-capability-identity/);
    assert.throws(() => compareRemoveOwnedTemp(beforeRemove, beforeRemove.contentDigest),
      /session-capability-identity/);
    assert.throws(() => atomicWriteFile(sessionOutput, '{}\n'), /session-capability-identity/);
    assert.throws(() => atomicWriteFile(sliceOutput, '{}\n'), /session-capability-identity/);
    assert.throws(() => consumeFinalizedReceiptPayload(finalized,
      {kind:'envelope-publish', operationId:`op-${'7'.repeat(32)}`}),
    /session-capability-identity/);
  } finally { remove(root); }

  for (const drift of ['state-file-replacement','work-directory-replacement']) {
    const replacementRoot = makeRepo(`dw-session-child-${drift}-`);
    try {
      const {sessionState, work} = caps(replacementRoot);
      const suffix = drift === 'state-file-replacement' ? 'a' : 'b';
      const beforeWrite = issueOwnedTempCapability({sessionCapability:work,
        operationId:`op-${suffix.repeat(32)}`, purpose:'notes'});
      const beforeConsume = issueOwnedTempCapability({sessionCapability:work,
        operationId:`op-${(suffix === 'a' ? 'c' : 'd').repeat(32)}`, purpose:'notes'});
      atomicWriteFile(beforeConsume, `consume-${drift}`);
      const beforeRemove = issueOwnedTempCapability({sessionCapability:work,
        operationId:`op-${(suffix === 'a' ? 'e' : 'f').repeat(32)}`, purpose:'notes'});
      atomicWriteFile(beforeRemove, `remove-${drift}`);
      consumeOwnedTemp(beforeRemove,
        {operationId:`op-${(suffix === 'a' ? '1' : '2').repeat(32)}`, purpose:'notes',
          expectedDigest:beforeRemove.contentDigest});
      const sessionOutput = issueSessionEnvelopeOutputCapability({sessionCapability:work});
      const sliceOutput = issueSliceEnvelopeOutputCapability({sessionCapability:work,
        slice:'SLICE-003'});
      const producerId = `op-${(suffix === 'a' ? '3' : '4').repeat(32)}`;
      const payload = Buffer.from(`{"drift":"${drift}"}\n`);
      const payloadPath = path.join(work.path, '.operation-results', producerId,
        'finalized-receipt-payload.json');
      fs.mkdirSync(path.dirname(payloadPath), {recursive:true});
      fs.writeFileSync(payloadPath, payload);
      const finalized = issueFinalizedReceiptPayloadCapability({sessionCapability:work,
        producerOperationReceipt:{version:1, kind:'finish-merge', operationId:producerId,
          sessionId:'s-a1b2c3d4', stage:'payload-published', sourceTempDigest:'5'.repeat(64),
          finalizedBytesDigest:hash(payload)}});
      if (drift === 'state-file-replacement') {
        const old = `${sessionState.path}.old`;
        fs.renameSync(sessionState.path, old);
        fs.writeFileSync(sessionState.path, fs.readFileSync(old));
      } else {
        const old = `${work.path}.old`;
        fs.renameSync(work.path, old);
        fs.mkdirSync(work.path, {recursive:true});
      }
      const expected = /(?:session-capability|path-capability)-identity/;
      assert.throws(() => atomicWriteFile(beforeWrite, `write-${drift}`), expected, drift);
      assert.throws(() => consumeOwnedTemp(beforeConsume,
        {operationId:`op-${'6'.repeat(32)}`, purpose:'notes',
          expectedDigest:beforeConsume.contentDigest}), expected, drift);
      assert.throws(() => compareRemoveOwnedTemp(beforeRemove, beforeRemove.contentDigest),
        expected, drift);
      assert.throws(() => atomicWriteFile(sessionOutput, '{}\n'), expected, drift);
      assert.throws(() => atomicWriteFile(sliceOutput, '{}\n'), expected, drift);
      assert.throws(() => consumeFinalizedReceiptPayload(finalized,
        {kind:'envelope-publish', operationId:`op-${'7'.repeat(32)}`}), expected, drift);
    } finally { remove(replacementRoot); }
  }
});

test('session-derived sidecar creation and adoption revalidate at the point of use', () => {
  {
    const root = makeRepo('dw-session-owner-sidecar-');
    try {
      const sessionStatePath = path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md');
      let armed = false;
      let terminalPath;
      const runtime = createPlatformRuntimeForTest({fsImpl:{
        lstatSync(value) {
          if (armed && value === terminalPath) {
            armed = false;
            fs.writeFileSync(sessionStatePath,
              '---\nwork_dir: .deep-work/s-a1b2c3d4\ncurrent_phase: finish\n---\n');
          }
          return fs.lstatSync(value);
        },
      }});
      const state = runtime.issueProjectStateCapability(root, sessionStatePath,
        {role:'session-state'});
      const work = runtime.issueProjectStateCapability(root,
        path.join(root, '.deep-work', 's-a1b2c3d4'),
        {role:'session-work-dir', sessionStateCapability:state});
      const temp = runtime.issueOwnedTempCapability({sessionCapability:work,
        operationId:`op-${'1'.repeat(32)}`, purpose:'notes'});
      terminalPath = `${temp.path}.terminal.json`;
      armed = true;
      assert.throws(() => runtime.atomicWriteFile(temp, 'stale-owner'),
        /session-capability-identity/);
      assert.equal(fs.existsSync(`${temp.path}.owner.json`), false);
      assert.equal(fs.existsSync(temp.path), false);
    } finally { remove(root); }
  }

  {
    const root = makeRepo('dw-session-cleanup-sidecar-');
    try {
      const sessionStatePath = path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md');
      let armed = false;
      let consumerPath;
      const runtime = createPlatformRuntimeForTest({fsImpl:{
        readFileSync(value, options) {
          const bytes = fs.readFileSync(value, options);
          if (armed && value === consumerPath) {
            armed = false;
            fs.writeFileSync(sessionStatePath,
              '---\nwork_dir: .deep-work/s-a1b2c3d4\ncurrent_phase: finish\n---\n');
          }
          return bytes;
        },
      }});
      const state = runtime.issueProjectStateCapability(root, sessionStatePath,
        {role:'session-state'});
      const work = runtime.issueProjectStateCapability(root,
        path.join(root, '.deep-work', 's-a1b2c3d4'),
        {role:'session-work-dir', sessionStateCapability:state});
      const temp = runtime.issueOwnedTempCapability({sessionCapability:work,
        operationId:`op-${'2'.repeat(32)}`, purpose:'notes'});
      runtime.atomicWriteFile(temp, 'stale-cleanup');
      consumeOwnedTemp(temp, {operationId:`op-${'3'.repeat(32)}`, purpose:'notes',
        expectedDigest:temp.contentDigest});
      consumerPath = `${temp.path}.consumer.json`;
      armed = true;
      assert.throws(() => compareRemoveOwnedTemp(temp, temp.contentDigest),
        /session-capability-identity/);
      assert.equal(fs.existsSync(`${temp.path}.cleanup.json`), false);
      assert.equal(fs.readFileSync(temp.path, 'utf8'), 'stale-cleanup');
    } finally { remove(root); }
  }

  {
    const root = makeRepo('dw-session-owned-adoption-');
    try {
      const sessionStatePath = path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md');
      let armed = false;
      let targetPath;
      const runtime = createPlatformRuntimeForTest({fsImpl:{
        openSync(value, flags, mode) {
          if (armed && value === targetPath && flags === 'wx') {
            armed = false;
            fs.writeFileSync(sessionStatePath,
              '---\nwork_dir: .deep-work/s-a1b2c3d4\ncurrent_phase: finish\n---\n');
          }
          return fs.openSync(value, flags, mode);
        },
      }});
      const state = runtime.issueProjectStateCapability(root, sessionStatePath,
        {role:'session-state'});
      const work = runtime.issueProjectStateCapability(root,
        path.join(root, '.deep-work', 's-a1b2c3d4'),
        {role:'session-work-dir', sessionStateCapability:state});
      const input = {sessionCapability:work, operationId:`op-${'4'.repeat(32)}`, purpose:'notes'};
      const first = runtime.issueOwnedTempCapability(input);
      runtime.atomicWriteFile(first, 'adopt-me');
      const retry = runtime.issueOwnedTempCapability(input);
      targetPath = retry.path;
      armed = true;
      assert.throws(() => runtime.atomicWriteFile(retry, 'adopt-me'),
        /session-capability-identity/);
    } finally { remove(root); }
  }

  for (const kind of ['owned-consumer','finalized-consumer']) {
    const root = makeRepo(`dw-session-${kind}-adoption-`);
    try {
      const sessionStatePath = path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md');
      let armed = false;
      let consumerPath;
      const runtime = createPlatformRuntimeForTest({fsImpl:{
        openSync(value, flags, mode) {
          if (armed && flags === 'wx' &&
              (value === consumerPath || String(value).startsWith(`${consumerPath}.publish.`))) {
            armed = false;
            fs.writeFileSync(sessionStatePath,
              '---\nwork_dir: .deep-work/s-a1b2c3d4\ncurrent_phase: finish\n---\n');
          }
          return fs.openSync(value, flags, mode);
        },
      }});
      const state = runtime.issueProjectStateCapability(root, sessionStatePath,
        {role:'session-state'});
      const work = runtime.issueProjectStateCapability(root,
        path.join(root, '.deep-work', 's-a1b2c3d4'),
        {role:'session-work-dir', sessionStateCapability:state});
      if (kind === 'owned-consumer') {
        const temp = runtime.issueOwnedTempCapability({sessionCapability:work,
          operationId:`op-${'5'.repeat(32)}`, purpose:'notes'});
        runtime.atomicWriteFile(temp, 'consumer-adoption');
        const operationId = `op-${'6'.repeat(32)}`;
        consumeOwnedTemp(temp, {operationId, purpose:'notes', expectedDigest:temp.contentDigest});
        consumerPath = `${temp.path}.consumer.json`;
        armed = true;
        assert.throws(() => consumeOwnedTemp(temp,
          {operationId, purpose:'notes', expectedDigest:temp.contentDigest}),
        /session-capability-identity/);
      } else {
        const producerId = `op-${'7'.repeat(32)}`;
        const payload = Buffer.from('{"terminal":true}\n');
        const payloadPath = path.join(work.path, '.operation-results', producerId,
          'finalized-receipt-payload.json');
        fs.mkdirSync(path.dirname(payloadPath), {recursive:true});
        fs.writeFileSync(payloadPath, payload);
        const finalized = runtime.issueFinalizedReceiptPayloadCapability({sessionCapability:work,
          producerOperationReceipt:{version:1, kind:'finish-merge', operationId:producerId,
            sessionId:'s-a1b2c3d4', stage:'payload-published', sourceTempDigest:'d'.repeat(64),
            finalizedBytesDigest:hash(payload)}});
        const operationId = `op-${'8'.repeat(32)}`;
        consumeFinalizedReceiptPayload(finalized, {kind:'envelope-publish', operationId});
        consumerPath = `${finalized.path}.envelope-consumer.json`;
        armed = true;
        assert.throws(() => consumeFinalizedReceiptPayload(finalized,
          {kind:'envelope-publish', operationId}), /session-capability-identity/);
      }
    } finally { remove(root); }
  }
});

test('unchanged session authority permits every derived child transition', () => {
  const root = makeRepo('dw-session-child-unchanged-');
  try {
    const {work} = caps(root);
    const temp = issueOwnedTempCapability({sessionCapability:work,
      operationId:`op-${'8'.repeat(32)}`, purpose:'notes'});
    atomicWriteFile(temp, 'unchanged');
    consumeOwnedTemp(temp, {operationId:`op-${'9'.repeat(32)}`, purpose:'notes',
      expectedDigest:temp.contentDigest});
    assert.equal(compareRemoveOwnedTemp(temp, temp.contentDigest), true);
    assert.equal(atomicWriteFile(issueSessionEnvelopeOutputCapability({sessionCapability:work}),
      '{}\n').written, true);
    assert.equal(atomicWriteFile(issueSliceEnvelopeOutputCapability({sessionCapability:work,
      slice:'SLICE-002'}), '{}\n').written, true);
    const producerId = `op-${'a'.repeat(32)}`;
    const payload = Buffer.from('{"ok":true}\n');
    const payloadPath = path.join(work.path, '.operation-results', producerId,
      'finalized-receipt-payload.json');
    fs.mkdirSync(path.dirname(payloadPath), {recursive:true});
    fs.writeFileSync(payloadPath, payload);
    const finalized = issueFinalizedReceiptPayloadCapability({sessionCapability:work,
      producerOperationReceipt:{version:1, kind:'finish-merge', operationId:producerId,
        sessionId:'s-a1b2c3d4', stage:'payload-published', sourceTempDigest:'b'.repeat(64),
        finalizedBytesDigest:hash(payload)}});
    assert.equal(consumeFinalizedReceiptPayload(finalized,
      {kind:'envelope-publish', operationId:`op-${'b'.repeat(32)}`}).state, 'enveloped');
  } finally { remove(root); }
});

test('finalized-result durable envelope journal survives reissue and rejects a rival envelope', () => {
  const root = makeRepo();
  try {
    const workDir = path.join(root, '.deep-work', 's-a1b2c3d4');
    fs.mkdirSync(workDir, {recursive:true});
    const sessionState = issueProjectStateCapability(root,
      path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
    const work = issueProjectStateCapability(root, workDir,
      {role:'session-work-dir', sessionStateCapability:sessionState});
    const producerId = `op-${'4'.repeat(32)}`;
    const payload = Buffer.from('{"done":true}\n');
    const payloadPath = path.join(work.path, '.operation-results', producerId,
      'finalized-receipt-payload.json');
    fs.mkdirSync(path.dirname(payloadPath), {recursive:true});
    fs.writeFileSync(payloadPath, payload);
    const receipt = {version:1, kind:'finish-merge', operationId:producerId,
      sessionId:'s-a1b2c3d4', stage:'payload-published', sourceTempDigest:'a'.repeat(64),
      finalizedBytesDigest:hash(payload)};
    const consumerId = `op-${'5'.repeat(32)}`;
    const first = issueFinalizedReceiptPayloadCapability({sessionCapability:work,
      producerOperationReceipt:receipt});
    consumeFinalizedReceiptPayload(first, {kind:'envelope-publish', operationId:consumerId});
    const retry = issueFinalizedReceiptPayloadCapability({sessionCapability:work,
      producerOperationReceipt:receipt});
    assert.equal(retry.state, 'enveloped');
    assert.equal(retry.envelopeOperationId, consumerId);
    assert.doesNotThrow(() => consumeFinalizedReceiptPayload(retry,
      {kind:'envelope-publish', operationId:consumerId}));
    const rival = issueFinalizedReceiptPayloadCapability({sessionCapability:work,
      producerOperationReceipt:receipt});
    assert.throws(() => consumeFinalizedReceiptPayload(rival,
      {kind:'envelope-publish', operationId:`op-${'6'.repeat(32)}`}), /already-consumed/);
  } finally { remove(root); }
});

test('finalized-result terminal state survives a fresh process and rejects corrupt durable consumers', () => {
  const root = makeRepo('dw-finalized-reissue-');
  try {
    const {work} = caps(root);
    const producerId = `op-${'c'.repeat(32)}`;
    const consumerId = `op-${'d'.repeat(32)}`;
    const payload = Buffer.from('{"done":"fresh"}\n');
    const payloadPath = path.join(work.path, '.operation-results', producerId,
      'finalized-receipt-payload.json');
    fs.mkdirSync(path.dirname(payloadPath), {recursive:true});
    fs.writeFileSync(payloadPath, payload);
    const receipt = {version:1, kind:'finish-merge', operationId:producerId,
      sessionId:'s-a1b2c3d4', stage:'payload-published', sourceTempDigest:'c'.repeat(64),
      finalizedBytesDigest:hash(payload)};
    const first = issueFinalizedReceiptPayloadCapability({sessionCapability:work,
      producerOperationReceipt:receipt});
    consumeFinalizedReceiptPayload(first, {kind:'envelope-publish', operationId:consumerId});
    const worker = path.join(fixtureRoot, 'finalized-reissue-worker.js');
    const fresh = JSON.parse(execFileSync(process.execPath,
      [worker, root, producerId, receipt.sourceTempDigest, receipt.finalizedBytesDigest],
      {encoding:'utf8'}));
    assert.deepEqual(fresh, {state:'enveloped', envelopeOperationId:consumerId});

    const consumerPath = `${payloadPath}.envelope-consumer.json`;
    const validConsumer = fs.readFileSync(consumerPath);
    for (const corrupt of [Buffer.from('{}\n'), Buffer.from(validConsumer.toString('utf8')
      .replace(producerId, `op-${'e'.repeat(32)}`)),
    Buffer.from(validConsumer.toString('utf8').replace(consumerId, producerId)),
    Buffer.from(validConsumer.toString('utf8').replace('s-a1b2c3d4', 's-deadbeef')),
    Buffer.from(validConsumer.toString('utf8').replace(receipt.finalizedBytesDigest,
      'f'.repeat(64)))]) {
      fs.writeFileSync(consumerPath, corrupt);
      assert.throws(() => issueFinalizedReceiptPayloadCapability({sessionCapability:work,
        producerOperationReceipt:receipt}), /finalized-receipt-(consumer|already-consumed)/);
    }
  } finally { remove(root); }
});

test('owned-temp compare-remove authenticates owner before preserving foreign artifacts', () => {
  const root = makeRepo();
  try {
    const workDir = path.join(root, '.deep-work', 's-a1b2c3d4');
    fs.mkdirSync(workDir, {recursive:true});
    const sessionState = issueProjectStateCapability(root,
      path.join(root, '.claude', 'deep-work.s-a1b2c3d4.md'), {role:'session-state'});
    const work = issueProjectStateCapability(root, workDir,
      {role:'session-work-dir', sessionStateCapability:sessionState});
    const cap = issueOwnedTempCapability({sessionCapability:work,
      operationId:`op-${'7'.repeat(32)}`, purpose:'notes'});
    atomicWriteFile(cap, 'foreign-safe');
    fs.writeFileSync(`${cap.path}.owner.json`, 'foreign\n');
    assert.throws(() => compareRemoveOwnedTemp(cap, cap.contentDigest), /owned-temp-foreign/);
    assert.equal(fs.readFileSync(cap.path, 'utf8'), 'foreign-safe');
    assert.equal(fs.readFileSync(`${cap.path}.owner.json`, 'utf8'), 'foreign\n');
  } finally { remove(root); }
});

test('node-toolchain rejects every linked component in a derived root', async () => {
  if (process.platform === 'win32') return test.skip('POSIX symlink row');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-toolchain-prefix-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-toolchain-prefix-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'), {recursive:true});
    fs.writeFileSync(path.join(root, 'bin', 'node'), 'fixture');
    fs.mkdirSync(path.join(outside, 'node_modules'), {recursive:true});
    fs.symlinkSync(outside, path.join(root, 'lib'), 'dir');
    const cap = await createPlatformRuntimeForTest({platform:'linux'})
      .issueNodeToolchainCapability({nodeExecutable:path.join(root, 'bin', 'node'),
        home:root, environment:{}});
    assert.equal(cap.packageRoots.includes(fs.realpathSync(path.join(outside, 'node_modules'))), false);
  } finally { remove(root); remove(outside); }
});

test('runtime-excluded file records identity only and is stable under content churn', () => {
  const root = makeRepo();
  try {
    const {project, git, state} = caps(root);
    fs.writeFileSync(state.path, 'one');
    const before = captureWorktreeManifest({projectCapability:project, gitCapability:git,
      runtimeExclusions:[state]});
    fs.writeFileSync(state.path, 'two');
    const after = captureWorktreeManifest({projectCapability:project, gitCapability:git,
      runtimeExclusions:[state]});
    const row = after.entries.find((entry) => entry.path === '.claude/state.json');
    assert.deepEqual(Object.hasOwn(row, 'sha256'), false);
    assert.deepEqual(Object.hasOwn(row, 'size'), false);
    assert.equal(after.sha256, before.sha256);
  } finally { remove(root); }
});

test('stale canonical recovery durably adopts a first quarantine after ticket-rename crash', () => {
  const root = makeRepo();
  try {
    const lockPath = path.join(root, '.claude', 'two-stage.lock');
    const lock = issueProjectStateCapability(root, lockPath, {role:'lock', allowMissingLeaf:true});
    const releaseCrash = createPlatformRuntimeForTest({fsImpl:{
      rmSync(value, options) {
        if (String(value).includes('.release.')) {
          throw Object.assign(new Error('leave stale claim'), {code:'EIO'});
        }
        return fs.rmSync(value, options);
      },
    }, nonceFactory:() => '1'.repeat(32)});
    assert.throws(() => releaseCrash.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:100, heartbeatMs:25, processIdentity:'2'.repeat(32)}, () => 'x'),
    /leave stale claim/);
    const releaseName = fs.readdirSync(path.dirname(lockPath))
      .find((name) => name.startsWith(`${path.basename(lockPath)}.release.`));
    assert.ok(releaseName);
    fs.renameSync(path.join(path.dirname(lockPath), releaseName), lockPath);

    let ticketRenameAttempted = false;
    const crash = createPlatformRuntimeForTest({clock:() => Date.now() + 60_000,
      livenessImpl:() => ({status:'dead', reason:'ESRCH'}), nonceFactory:() => '3'.repeat(32),
      fsImpl:{
        renameSync(source, destination) {
          if (String(source).endsWith('.ticket') && String(destination).includes('.quarantine.')) {
            ticketRenameAttempted = true;
            throw Object.assign(new Error('ticket rename crash'), {code:'EIO'});
          }
          return fs.renameSync(source, destination);
        },
      }});
    assert.throws(() => crash.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:100, heartbeatMs:25, processIdentity:'4'.repeat(32)}, () => 'x'),
    /ticket rename crash/);
    assert.equal(ticketRenameAttempted, true);
    assert.equal(fs.readdirSync(path.dirname(lockPath)).some((name) =>
      name.startsWith(`${path.basename(lockPath)}.claim-quarantine.`)), true);

    const nonces = ['5'.repeat(32), '6'.repeat(32), '7'.repeat(32), '8'.repeat(32)];
    const recovery = createPlatformRuntimeForTest({clock:() => Date.now() + 120_000,
      livenessImpl:() => ({status:'dead', reason:'ESRCH'}),
      nonceFactory:() => nonces.shift() || '9'.repeat(32)});
    assert.equal(recovery.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:100, heartbeatMs:25, processIdentity:'a'.repeat(32)},
      () => 'recovered'), 'recovered');
    assert.deepEqual(fs.readdirSync(`${lock.path}.claims`), []);
    assert.equal(fs.readdirSync(path.dirname(lockPath)).some((name) =>
      name.startsWith(`${path.basename(lockPath)}.claim-quarantine.`)), false);
  } finally { remove(root); }
});

test('post-publication directory fsync failure preserves the complete claim for stale recovery', () => {
  const root = makeRepo();
  try {
    const lockPath = path.join(root, '.claude', 'publish-fsync.lock');
    const lock = issueProjectStateCapability(root, lockPath, {role:'lock', allowMissingLeaf:true});
    const parent = path.dirname(lockPath);
    const parentFds = new Set();
    const failing = createPlatformRuntimeForTest({nonceFactory:() => '4'.repeat(32), fsImpl:{
      openSync(value, flags, mode) {
        const fd = fs.openSync(value, flags, mode);
        if (value === parent && flags === 'r') parentFds.add(fd);
        return fd;
      },
      fsyncSync(fd) {
        if (parentFds.has(fd) && fs.existsSync(lockPath)) {
          throw Object.assign(new Error('post-publish-dir-fsync'), {code:'EIO'});
        }
        return fs.fsyncSync(fd);
      },
      closeSync(fd) { parentFds.delete(fd); return fs.closeSync(fd); },
    }});
    assert.throws(() => failing.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:100, heartbeatMs:25, processIdentity:'5'.repeat(32)}, () => 'x'),
    (error) => error.code === 'lock-publication-durability-failed' &&
      error.cause && error.cause.code === 'EIO');
    assert.deepEqual(fs.readdirSync(lockPath).sort(), ['heartbeat.json','owner.json']);
    assert.equal(fs.readdirSync(`${lockPath}.claims`).filter((name) => name.endsWith('.ticket')).length, 1);

    const nonces = ['6'.repeat(32), '7'.repeat(32), '8'.repeat(32)];
    const recovery = createPlatformRuntimeForTest({clock:() => Date.now() + 60_000,
      livenessImpl:() => ({status:'dead', reason:'ESRCH'}),
      nonceFactory:() => nonces.shift() || '9'.repeat(32)});
    assert.equal(recovery.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:100, heartbeatMs:25, processIdentity:'a'.repeat(32)},
      () => 'recovered'), 'recovered');
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(fs.readdirSync(`${lockPath}.claims`), []);
  } finally { remove(root); }
});

test('pre-publication canonical rename failure leaves no unauthenticated residue', () => {
  const root = makeRepo();
  try {
    const lockPath = path.join(root, '.claude', 'publish-rename.lock');
    const runtime = createPlatformRuntimeForTest({nonceFactory:() => 'b'.repeat(32), fsImpl:{
      renameSync(source, destination) {
        if (destination === lockPath && String(source).includes('.claim.')) {
          throw Object.assign(new Error('publish-rename-failed'), {code:'EIO'});
        }
        return fs.renameSync(source, destination);
      },
    }});
    const lock = runtime.issueProjectStateCapability(root, lockPath,
      {role:'lock', allowMissingLeaf:true});
    assert.throws(() => runtime.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:100, heartbeatMs:25, processIdentity:'c'.repeat(32)}, () => 'x'),
    /publish-rename-failed/);
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(fs.readdirSync(`${lockPath}.claims`), []);
  } finally { remove(root); }
});

test('lock process-death seams recover exact owned claim stages without residue', async () => {
  if (process.platform === 'win32') return test.skip('SIGKILL seam matrix is POSIX-only');
  const preCanonical = ['after-ticket-open','after-ticket-fsync','after-private-mkdir',
    'after-owner-write','after-owner-fsync','after-heartbeat-write','after-heartbeat-fsync',
    'before-canonical-rename'];
  const canonical = ['after-canonical-rename','before-first-heartbeat','before-heartbeat-replace',
    'after-first-heartbeat'];
  const release = ['after-release-lock-remove-before-ticket-unlink'];
  for (const seam of [...preCanonical, ...canonical, ...release]) {
    const root = makeRepo(`dw-lock-seam-${seam}-`);
    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-lock-seam-control-'));
    try {
      const lockPath = path.join(root, '.claude', `${seam}.lock`);
      const processIdentity = hash(`identity-${seam}`).slice(0, 32);
      const worker = fork(path.join(fixtureRoot, 'lock-worker.js'),
        [root, lockPath, processIdentity, seam, control],
        {stdio:['ignore','ignore','inherit','ipc']});
      const marker = path.join(control, `${seam}.json`);
      const reached = await waitForJsonMarker(marker);
      assert.deepEqual({seam:reached.seam, pid:reached.pid, processIdentity:reached.processIdentity},
        {seam, pid:worker.pid, processIdentity});
      worker.kill('SIGKILL');
      const exit = await new Promise((resolve) => worker.once('exit', (code, signal) =>
        resolve({code, signal})));
      assert.equal(exit.signal, 'SIGKILL', seam);

      let probes = 0;
      const nonces = Array.from({length:16}, (_, index) =>
        hash(`recovery-${seam}-${index}`).slice(0, 32));
      const recovery = createPlatformRuntimeForTest({clock:() => Date.now() + 120_000,
        livenessImpl:(pid, identity) => {
          assert.equal(pid, worker.pid, seam);
          assert.equal(identity, processIdentity, seam);
          probes += 1;
          return {status:'dead', reason:'ESRCH'};
        }, nonceFactory:() => nonces.shift() || 'f'.repeat(32)});
      const lock = recovery.issueProjectStateCapability(root, lockPath,
        {role:'lock', allowMissingLeaf:true});
      assert.equal(recovery.withDirectoryLock(lock,
        {timeoutMs:1_000, staleMs:100, heartbeatMs:25,
          processIdentity:hash(`contender-${seam}`).slice(0, 32)}, () => 'recovered'),
      'recovered', seam);
      assert.equal(probes, seam === 'before-heartbeat-replace' ? 6 :
        (canonical.includes(seam) ? 5 : 3), seam);
      assert.equal(fs.existsSync(lockPath), false, seam);
      assert.deepEqual(fs.readdirSync(`${lockPath}.claims`), [], seam);
      const residuePrefix = path.basename(lockPath);
      assert.deepEqual(fs.readdirSync(path.dirname(lockPath))
        .filter((name) => name.startsWith(`${residuePrefix}.claim.`) ||
          name.startsWith(`${residuePrefix}.claim-quarantine.`) ||
          name.startsWith(`${residuePrefix}.release.`) ||
          name.startsWith(`.${residuePrefix}.heartbeat.json.tmp.`)), [], seam);
    } finally { remove(root); remove(control); }
  }
});

test('lock recovery preserves foreign live EPERM and corrupt artifacts byte-identically', async () => {
  if (process.platform === 'win32') return test.skip('SIGKILL lock fixture is POSIX-only');
  const root = makeRepo('dw-lock-retained-artifacts-');
  const control = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-lock-retained-control-'));
  let worker;
  try {
    const seam = 'after-first-heartbeat';
    const lockPath = path.join(root, '.claude', 'retained.lock');
    const processIdentity = '5'.repeat(32);
    worker = fork(path.join(fixtureRoot, 'lock-worker.js'),
      [root, lockPath, processIdentity, seam, control],
      {stdio:['ignore','ignore','inherit','ipc']});
    await waitForJsonMarker(path.join(control, `${seam}.json`));
    const claims = `${lockPath}.claims`;
    const ticketPath = path.join(claims, fs.readdirSync(claims)
      .find((name) => name.endsWith('.ticket')));
    const ownerPath = path.join(lockPath, 'owner.json');
    const heartbeatPath = path.join(lockPath, 'heartbeat.json');
    const foreignPath = path.join(claims, 'foreign.ticket');
    fs.writeFileSync(foreignPath, 'foreign-bytes\n');
    const snapshot = () => ({ticket:fs.readFileSync(ticketPath), owner:fs.readFileSync(ownerPath),
      heartbeat:fs.readFileSync(heartbeatPath), foreign:fs.readFileSync(foreignPath)});
    const original = snapshot();
    for (const result of [{status:'alive', reason:'success'}, {status:'alive', reason:'EPERM'}]) {
      const contender = createPlatformRuntimeForTest({clock:() => Date.now() + 120_000,
        livenessImpl:() => result, nonceFactory:() => '6'.repeat(32)});
      const lock = contender.issueProjectStateCapability(root, lockPath,
        {role:'lock', allowMissingLeaf:true});
      assert.throws(() => contender.withDirectoryLock(lock,
        {timeoutMs:25, staleMs:100, heartbeatMs:25, processIdentity:'7'.repeat(32)},
        () => 'no'), /lock-timeout/);
      assert.deepEqual(snapshot(), original, result.reason);
    }

    worker.kill('SIGKILL');
    await new Promise((resolve) => worker.once('exit', resolve));
    worker = null;
    fs.writeFileSync(heartbeatPath, 'corrupt-heartbeat\n');
    const corrupt = snapshot();
    const dead = createPlatformRuntimeForTest({clock:() => Date.now() + 120_000,
      livenessImpl:() => ({status:'dead', reason:'ESRCH'}), nonceFactory:() => '8'.repeat(32)});
    const lock = dead.issueProjectStateCapability(root, lockPath,
      {role:'lock', allowMissingLeaf:true});
    assert.throws(() => dead.withDirectoryLock(lock,
      {timeoutMs:100, staleMs:50, heartbeatMs:25, processIdentity:'9'.repeat(32)},
      () => 'no'), /lock-ambiguous/);
    assert.deepEqual(snapshot(), corrupt);
  } finally {
    if (worker) {
      worker.kill('SIGKILL');
      await new Promise((resolve) => worker.once('exit', resolve));
    }
    remove(root);
    remove(control);
  }
});

test('lock records every supported and native-unsupported directory durability attempt', () => {
  const supportedRoot = makeRepo('dw-lock-durability-supported-');
  try {
    const durabilityProbe = path.join(supportedRoot, 'tracked.txt');
    const runtime = createPlatformRuntimeForTest({platform:'win32', nonceFactory:() => '1'.repeat(32),
      fsImpl:{
        openSync(value, flags, mode) {
          if (flags === 'r') {
            try {
              if (fs.lstatSync(value).isDirectory()) return fs.openSync(durabilityProbe, 'r+');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          return fs.openSync(value, flags, mode);
        },
      }});
    const lock = runtime.issueProjectStateCapability(supportedRoot,
      path.join(supportedRoot, '.claude', 'durability.lock'),
      {role:'lock', allowMissingLeaf:true});
    assert.equal(runtime.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:100, heartbeatMs:25, processIdentity:'2'.repeat(32)},
      () => 'done'), 'done');
    const records = runtime.lockDurability();
    for (const stage of ['claims-parent','ticket-directory','private-claim',
      'canonical-parent','first-heartbeat','release-parent','release-ticket-directory']) {
      assert.equal(records.some((record) => record.stage === stage &&
        record.outcome === 'durable' && record.supported === true), true, stage);
    }
  } finally { remove(supportedRoot); }

  const unsupportedRoot = makeRepo('dw-lock-durability-unsupported-');
  try {
    const runtime = createPlatformRuntimeForTest({platform:'win32', nonceFactory:() => '3'.repeat(32),
      fsImpl:{
        openSync(value, flags, mode) {
          if (flags === 'r') {
            try {
              if (fs.lstatSync(value).isDirectory()) {
                throw Object.assign(new Error('directory fsync unsupported'), {code:'EINVAL'});
              }
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          return fs.openSync(value, flags, mode);
        },
      }});
    const lock = runtime.issueProjectStateCapability(unsupportedRoot,
      path.join(unsupportedRoot, '.claude', 'durability.lock'),
      {role:'lock', allowMissingLeaf:true});
    assert.equal(runtime.withDirectoryLock(lock,
      {timeoutMs:1_000, staleMs:100, heartbeatMs:25, processIdentity:'4'.repeat(32)},
      () => 'done'), 'done');
    const records = runtime.lockDurability();
    assert.equal(records.length >= 7, true);
    assert.equal(records.every((record) => record.outcome === 'unsupported' &&
      record.supported === false && record.code === 'EINVAL'), true);
  } finally { remove(unsupportedRoot); }
});

test('native Windows filename matrix declares accepted and rejected distinct operation rows', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  const nativeMatrix = source.slice(source.lastIndexOf("test('native Windows device aliases"),
    source.lastIndexOf("test('native Windows node-toolchain"));
  for (const token of ['acceptedNameSpellings', 'rejectedNameSpellings',
    'create-new', 'open-existing', 'parent-enumeration']) {
    assert.equal(nativeMatrix.includes(token), true, token);
  }
});

test('native Windows device aliases and ADS inventory are executable contract rows', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, () => {
  const root = makeRepo('dw-native-win-stream-');
  try {
    const {project, git} = caps(root);
    const rejectedNameSpellings = [...new Set(platform.WINDOWS_DEVICE_BASES.flatMap((base) => {
      const stems = [base, base.toLowerCase(), `${base[0].toLowerCase()}${base.slice(1)}`];
      return stems.flatMap((stem) => [stem, `${stem}.txt`, `${stem}.tar.gz`]);
    }))];
    const acceptedNameSpellings = rejectedNameSpellings.map((name, index) =>
      `safe ${String(index).padStart(3, '0')}-${name}`)
      .concat(['ordinary', 'Ordinary.TXT', '한 글.txt', 'Résumé Data.tar.gz']);
    const operationRows = [];
    for (let index = 0; index < acceptedNameSpellings.length; index++) {
      const name = acceptedNameSpellings[index];
      const candidate = path.join(root, name);
      assert.equal(canonicalizePortableProjectPathV1(name).path, name);
      const createFd = fs.openSync(candidate, 'wx');
      operationRows.push({group:'accepted', operation:'create-new', name});
      try { fs.writeFileSync(createFd, Buffer.from(`accepted-${index}`)); }
      finally { fs.closeSync(createFd); }
      const openFd = fs.openSync(candidate, 'r');
      operationRows.push({group:'accepted', operation:'open-existing', name});
      try { assert.equal(fs.readFileSync(openFd, 'utf8'), `accepted-${index}`); }
      finally { fs.closeSync(openFd); }
      operationRows.push({group:'accepted', operation:'parent-enumeration', name});
      assert.equal(fs.readdirSync(root).includes(name), true, name);
      fs.unlinkSync(candidate);
    }
    for (const name of rejectedNameSpellings) {
      const candidate = path.join(root, name);
      let createFd;
      let created = false;
      try { createFd = fs.openSync(candidate, 'wx'); created = true; }
      catch (error) { assert.equal(typeof error.code, 'string', `create-new:${name}`); }
      finally { if (createFd !== undefined) fs.closeSync(createFd); }
      operationRows.push({group:'rejected', operation:'create-new', name});
      let openFd;
      try { openFd = fs.openSync(candidate, 'r'); }
      catch (error) { assert.equal(typeof error.code, 'string', `open-existing:${name}`); }
      finally { if (openFd !== undefined) fs.closeSync(openFd); }
      operationRows.push({group:'rejected', operation:'open-existing', name});
      const enumerated = fs.readdirSync(root)
        .some((entry) => entry.toLowerCase() === name.toLowerCase());
      operationRows.push({group:'rejected', operation:'parent-enumeration', name, enumerated});
      assert.throws(() => canonicalizePortableProjectPathV1(name), /portable-path-v1-device/, name);
      if (created) fs.unlinkSync(candidate);
      assert.equal(fs.readdirSync(root).some((entry) => entry.toLowerCase() === name.toLowerCase()),
        false, name);
    }
    for (const group of ['accepted','rejected']) {
      const expected = group === 'accepted' ? acceptedNameSpellings.length : rejectedNameSpellings.length;
      for (const operation of ['create-new','open-existing','parent-enumeration']) {
        assert.equal(operationRows.filter((row) => row.group === group &&
          row.operation === operation).length, expected, `${group}:${operation}`);
      }
    }

    const fakeBin = path.join(root, 'fake-path-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'powershell.exe'), 'fake');
    const oldPath = process.env.PATH;
    const oldComSpec = process.env.ComSpec;
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath || ''}`;
    process.env.ComSpec = path.join(fakeBin, 'cmd.exe');
    let clean;
    try {
      clean = captureWorktreeManifest({projectCapability:project, gitCapability:git,
        runtimeExclusions:[]});
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldComSpec === undefined) delete process.env.ComSpec; else process.env.ComSpec = oldComSpec;
    }
    assert.match(clean.sha256, /^[0-9a-f]{64}$/);
    const directory = path.join(root, 'ads-dir');
    const file = path.join(directory, 'file.txt');
    fs.mkdirSync(directory);
    fs.writeFileSync(file, 'main');
    for (const target of [root, directory, file]) {
      fs.writeFileSync(`${target}:deep-work-test`, 'hidden');
      assert.throws(() => captureWorktreeManifest({projectCapability:project,
        gitCapability:git, runtimeExclusions:[]}), /alternate-stream/);
      fs.unlinkSync(`${target}:deep-work-test`);
    }

    let walkerActive = false;
    let rootRevalidations = 0;
    const rootStat = fs.lstatSync(root);
    const rootIdentity = {dev:String(rootStat.dev), ino:String(rootStat.ino), mode:rootStat.mode,
      type:'directory'};
    const mutating = createPlatformRuntimeForTest({platform:'win32',
      manifestWalkerImpl:() => {
        walkerActive = true;
        return {entries:[], directories:[], typedRows:[{version:1, id:0, kind:'root',
          relative_path:null, absolutePath:root, identity:rootIdentity}]};
      },
      fsImpl:{
        lstatSync(value) {
          if (walkerActive && value === root && ++rootRevalidations === 2) {
            fs.writeFileSync(`${root}:between-pass`, 'hidden');
          }
          return fs.lstatSync(value);
        },
      }});
    assert.throws(() => mutating.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), /alternate-stream/);
    fs.unlinkSync(`${root}:between-pass`);

    const helperPath = path.join(__dirname, 'windows-stream-inventory.ps1');
    const helperMutant = createPlatformRuntimeForTest({platform:'win32',
      manifestWalkerImpl:() => ({entries:[], directories:[], typedRows:[{version:1, id:0,
        kind:'root', relative_path:null, absolutePath:root, identity:rootIdentity}]}),
      fsImpl:{
        readFileSync(value, options) {
          const bytes = fs.readFileSync(value, options);
          return value === helperPath ? Buffer.concat([Buffer.from(bytes), Buffer.from('# mutant\n')]) : bytes;
        },
      }});
    assert.throws(() => helperMutant.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), /stream-helper-changed/);

    const pinvokeMutant = createPlatformRuntimeForTest({platform:'win32',
      manifestWalkerImpl:() => ({entries:[], directories:[], typedRows:[{version:1, id:0,
        kind:'root', relative_path:null, absolutePath:root, identity:rootIdentity}]}),
      fsImpl:{
        readFileSync(value, options) {
          const bytes = fs.readFileSync(value, options);
          return value === helperPath
            ? Buffer.from(Buffer.from(bytes).toString('utf8').replace('FindFirstStreamW', 'Get-Item -Stream'))
            : bytes;
        },
      }});
    assert.throws(() => pinvokeMutant.captureWorktreeManifest({projectCapability:project,
      gitCapability:git, runtimeExclusions:[]}), /stream-helper-changed/);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-reparse-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'reparse-entry'), 'junction');
      assert.throws(() => captureWorktreeManifest({projectCapability:project,
        gitCapability:git, runtimeExclusions:[]}), /worktree-manifest-reparse/);
      fs.rmSync(path.join(root, 'reparse-entry'), {recursive:true, force:true});
    } finally { remove(outside); }
  } finally { remove(root); }
});

test('native Windows node-toolchain rejects an intermediate junction root', {
  skip:process.platform !== 'win32' ? 'native Windows only' : false,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-junction-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-native-win-junction-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'), {recursive:true});
    fs.writeFileSync(path.join(root, 'bin', 'node.exe'), 'MZfixture');
    fs.mkdirSync(path.join(outside, 'node_modules'), {recursive:true});
    fs.symlinkSync(outside, path.join(root, 'lib'), 'junction');
    const cap = await createPlatformRuntimeForTest({platform:'win32'})
      .issueNodeToolchainCapability({nodeExecutable:path.join(root, 'bin', 'node.exe'),
        home:root, environment:{}});
    assert.equal(cap.packageRoots.includes(fs.realpathSync(path.join(outside, 'node_modules'))), false);
  } finally { remove(root); remove(outside); }
});

test('CI executes the runtime contract on native Windows Node 22', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'tests.yml'),
    'utf8');
  assert.match(workflow, /runtime-windows:/);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /node-version:\s*['"]22['"]/);
  assert.match(workflow, /run:\s*npm run test:runtime/);
});
