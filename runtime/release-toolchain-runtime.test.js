'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const gate=require('./release-gate-runtime.js');
const toolchain=require('./release-toolchain-runtime.js');

test('full release gate timeout budget covers hermetic suite overhead',()=>{
  assert.ok(toolchain.COMMAND_TIMEOUT_LIMITS.full>=900000);
});

test('ReleaseToolIdentityV1 binds the active Node executable physical identity',()=>{
  const identity=toolchain.buildToolIdentity({name:'node',
    targetPath:process.execPath});
  assert.equal(identity.target_path,fs.realpathSync(process.execPath));
  assert.equal(identity.shim_kind,'none');
  assert.equal(identity.shim_path,null);
  assert.deepEqual(toolchain.validateToolIdentity(identity),identity);
  assert.throws(()=>toolchain.validateToolIdentity({...identity,target_size:'0'}),
    /release-tool-identity/);
});

test('ReleaseSourceGraphV1 authenticates exact roots, rows, edges, and digest',()=>{
  const packageBytes=Buffer.from('{"scripts":{"test":"npm run test:all"}}\n');
  const rows=[
    toolchain.commandRootRow('npm-pack-dry-run-json',
      gate.RELEASE_GATE_CATALOG.pack.argv,[{kind:'package-document',
        path:'package.json#document'}]),
    {path:'package.json#document',kind:'package-document',
      sha256:toolchain.sha256(packageBytes),outgoing:[]},
    {path:'package.json#scripts.test',kind:'package-script',
      sha256:toolchain.sha256(Buffer.from('npm run test:all')),outgoing:[]},
  ].sort(toolchain.compareGraphRows);
  const graph=toolchain.buildReleaseSourceGraph({rows,
    platformExecutables:[],testFixtureExecutables:[]});
  assert.deepEqual(graph.roots,
    ['command:npm-pack-dry-run-json','package.json#scripts.test']);
  assert.deepEqual(toolchain.validateReleaseSourceGraph(graph),graph);
  const tampered=structuredClone(graph);tampered.rows[0].outgoing=[];
  assert.throws(()=>toolchain.validateReleaseSourceGraph(tampered),
    /release-source-graph/);
});

test('source graph executable carriers use exact platform and fixture schemas',()=>{
  const nodeSource=Buffer.from('spawn(process.execPath, [])\n'),
    platformRow=toolchain.buildActiveNodeExecutable({
      sourcePath:'runtime/example.test.js',
      sourceSha256:toolchain.sha256(nodeSource)});
  assert.equal(platformRow.derivation_kind,
    'active-node-process-exec-path');
  assert.deepEqual(toolchain.validatePlatformDerivedExecutable(platformRow),
    platformRow);
  const fixture={factory_source_path:'runtime/example.test.js',
    factory_source_sha256:toolchain.sha256(nodeSource),
    factory_args:['body',1,true,null],fixture_relpath:'bin/fake-tool',
    fixture_sha256:'7'.repeat(64),platform:'posix',
    invocation_kind:'absolute-owned-temp',child_path_sha256:null};
  assert.deepEqual(toolchain.validateTestFixtureExecutable(fixture),fixture);
  assert.throws(()=>toolchain.validateTestFixtureExecutable({
    ...fixture,caller_note:'forged'}),/test-fixture-executable/);
});

test('ReleaseToolchainManifestV1 rejects an unsorted or graph-drifted entry set',()=>{
  const graph=toolchain.buildReleaseSourceGraph({rows:[
    toolchain.commandRootRow('npm-pack-dry-run-json',
      gate.RELEASE_GATE_CATALOG.pack.argv,[]),
    {path:'package.json#scripts.test',kind:'package-script',
      sha256:'1'.repeat(64),outgoing:[]},
  ].sort(toolchain.compareGraphRows),platformExecutables:[],
  testFixtureExecutables:[]});
  const node=toolchain.buildToolIdentity({name:'node',
    targetPath:process.execPath});
  const manifest=toolchain.buildToolchainManifest({platform:process.platform,
    sourceGraphRef:{kind:'release-source-graph',
      path:'.deep-work/s-aaaaaaaa/release/source-graph.json',
      sha256:toolchain.sha256(toolchain.canonical(graph)),
      producer_operation_id:`op-${'2'.repeat(64)}`},
    sourceGraphSha256:graph.source_graph_sha256,entries:[node]});
  assert.deepEqual(toolchain.validateToolchainManifest(manifest),manifest);
  assert.throws(()=>toolchain.validateToolchainManifest({
    ...manifest,source_graph_sha256:'3'.repeat(64)}),/release-toolchain-manifest/);
});

test('POSIX owned bin exposes only authenticated tools through the closed environment',
  {skip:process.platform==='win32'},async(t)=>{
    const parent=fs.mkdtempSync(path.join(os.tmpdir(),'dw-release-bin-'));
    t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
    const materialized=toolchain.materializeOwnedBin({parent,
      entries:[toolchain.buildToolIdentity({name:'node',
        targetPath:process.execPath})],platformName:'posix'});
    const graph=toolchain.buildReleaseSourceGraph({rows:[
      toolchain.commandRootRow('npm-pack-dry-run-json',
        gate.RELEASE_GATE_CATALOG.pack.argv,[]),
      {path:'package.json#scripts.test',kind:'package-script',
        sha256:'1'.repeat(64),outgoing:[]},
    ].sort(toolchain.compareGraphRows),platformExecutables:[],
    testFixtureExecutables:[]});
    const graphPath=path.join(parent,'source-graph.json');
    fs.writeFileSync(graphPath,toolchain.canonical(graph));
    const manifest=toolchain.buildToolchainManifest({platform:'posix',
      sourceGraphRef:{kind:'release-source-graph',
        path:'.deep-work/s-aaaaaaaa/release/source-graph.json',
        sha256:toolchain.sha256(toolchain.canonical(graph)),
        producer_operation_id:`op-${'2'.repeat(64)}`},
      sourceGraphSha256:graph.source_graph_sha256,
      entries:materialized.entries});
    const manifestPath=path.join(parent,'toolchain.json');
    fs.writeFileSync(manifestPath,toolchain.canonical(manifest));
    const home=fs.mkdtempSync(path.join(parent,'home-'));
    const environment=toolchain.buildReleaseEnvironment({platformName:'posix',
      homePath:home,binPath:materialized.binPath,manifestPath,manifest});
    assert.deepEqual(Object.keys(environment.values),
      ['LANG','LC_ALL','TZ','HOME','PATH']);
    const ran=await toolchain.runHermetic({manifest,environment,
      executableName:'node',args:['-e',
        'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'],
      cwd:parent,timeoutMs:5000,maxOutputBytes:65536});
    assert.equal(ran.exitCode,0);
    const childKeys=JSON.parse(ran.stdout);
    assert.deepEqual(childKeys.filter((key)=>key!=='__CF_USER_TEXT_ENCODING'),
      ['HOME','LANG','LC_ALL','PATH','TZ']);
    assert.equal(childKeys.includes('__CF_USER_TEXT_ENCODING'),process.platform==='darwin');
    toolchain.validateMaterializedBin(materialized.binPath,manifest.entries);
  });

test('catalog command execution rejects caller argv and cleans its owned runtime',
  {skip:process.platform==='win32'},async()=>{
    const npmPath=process.env.PATH.split(path.delimiter).map((directory)=>
      path.join(directory,'npm')).find((candidate)=>{
      try{return fs.lstatSync(candidate).isFile()||
        fs.lstatSync(candidate).isSymbolicLink();}catch{return false;}
    });
    assert.ok(npmPath,'npm must be available for the release oracle');
    const graph=toolchain.buildReleaseSourceGraph({rows:[
      toolchain.commandRootRow('npm-pack-dry-run-json',
        gate.RELEASE_GATE_CATALOG.pack.argv,[]),
      {path:'package.json#scripts.test',kind:'package-script',
        sha256:'1'.repeat(64),outgoing:[]},
    ].sort(toolchain.compareGraphRows),platformExecutables:[],
    testFixtureExecutables:[]});
    const execution=await toolchain.executeCatalogCommand({commandId:'pack',
      cwd:path.resolve(__dirname,'..'),sourceGraphRef:{
        kind:'release-source-graph',
        path:'.deep-work/s-aaaaaaaa/release/source-graph.json',
        sha256:toolchain.sha256(toolchain.canonical(graph)),
        producer_operation_id:`op-${'2'.repeat(64)}`},
      sourceGraphSha256:graph.source_graph_sha256,entries:[
        toolchain.buildToolIdentity({name:'node',targetPath:process.execPath}),
        toolchain.buildToolIdentity({name:'npm',targetPath:npmPath}),
      ],timeoutMs:30000,maxOutputBytes:1048576});
    assert.deepEqual(execution.argv,['npm','pack','--dry-run','--json']);
    assert.equal(execution.process_result.exit_code,0,execution.stderr);
    assert.equal(Array.isArray(JSON.parse(execution.stdout)),true);
    await assert.rejects(()=>toolchain.executeCatalogCommand({commandId:'unknown',
      cwd:path.resolve(__dirname,'..')}),/release-command/);
    const fullAtMeasuredBound=toolchain.executeCatalogCommand({
      commandId:'full',cwd:path.resolve(__dirname,'..'),
      sourceGraphRef:{kind:'release-source-graph',
        path:'.deep-work/s-aaaaaaaa/release/source-graph.json',
        sha256:'1'.repeat(64),producer_operation_id:`op-${'2'.repeat(64)}`},
      sourceGraphSha256:'3'.repeat(64),entries:[],timeoutMs:480000,
      maxOutputBytes:1048576});
    await assert.rejects(fullAtMeasuredBound,(error)=>
      error.code==='release-command-tool');
    await assert.rejects(()=>toolchain.executeCatalogCommand({
      commandId:'pack',cwd:path.resolve(__dirname,'..'),
      timeoutMs:480000}),error=>error.code==='release-command');
  });
