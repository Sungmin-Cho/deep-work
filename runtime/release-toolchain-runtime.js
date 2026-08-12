'use strict';

const fs=require('node:fs');
const crypto=require('node:crypto');
const path=require('node:path');
const journal=require('./operation-journal.js');

const DIGEST=/^[0-9a-f]{64}$/;
const OPERATION=/^op-[0-9a-f]{64}$/;
const COMMAND_TIMEOUT_LIMITS=Object.freeze({carrier:120000,tdd:120000,
  replan:120000,integration:120000,targeted:120000,full:900000,
  pack:120000});
function fail(code,message=code){const error=new Error(`[${code}] ${message}`);
  error.code=code;throw error;}
function canonical(value){return journal.canonicalJson(value);}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}
function semanticDigest(domain,value,omitted){
  const copy=structuredClone(value);if(omitted)delete copy[omitted];
  return sha256(Buffer.concat([Buffer.from(`${domain}\0`),
    Buffer.from(canonical(copy))]));
}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&
  canonical(Object.keys(value).sort())===canonical([...keys].sort());}
function decimal(value){return String(typeof value==='bigint'?value:BigInt(value));}
function statNanos(stat){return decimal(stat.mtimeNs===undefined?
  BigInt(Math.trunc(stat.mtimeMs*1e6)):stat.mtimeNs);}
function byteCompare(left,right){return Buffer.compare(Buffer.from(left),Buffer.from(right));}
function portable(value){return typeof value==='string'&&value.length>0&&
  !value.startsWith('/')&&!value.includes('\\')&&!value.split('/').includes('..');}
function operationId(domain,value){return `op-${semanticDigest(domain,value)}`;}

function buildToolIdentity({name,targetPath,shimKind='none',shimPath=null,
  shimSha256=null}={}){
  if(typeof name!=='string'||!/^[A-Za-z0-9._-]+$/.test(name)||
      !require('node:path').isAbsolute(targetPath||''))fail('release-tool-identity');
  let physical,stat,bytes;try{physical=fs.realpathSync(targetPath);
    stat=fs.lstatSync(physical,{bigint:true});bytes=fs.readFileSync(physical);}
  catch{fail('release-tool-identity');}
  if(!stat.isFile()||stat.isSymbolicLink()||
      (process.platform!=='win32'&&(stat.mode&0o111n)===0n))
    fail('release-tool-identity');
  return validateToolIdentity({name,target_path:physical,target_sha256:sha256(bytes),
    target_dev:decimal(stat.dev),target_ino:decimal(stat.ino),
    target_mode:decimal(stat.mode),target_size:decimal(stat.size),
    target_mtime_ns:statNanos(stat),shim_kind:shimKind,shim_path:shimPath,
    shim_sha256:shimSha256});
}
function resolveReleaseToolIdentities(names,{environment=process.env,
  platformName=process.platform}={}){
  if(!Array.isArray(names)||names.length===0||
      canonical(names)!==canonical([...names].sort(byteCompare))||
      new Set(names).size!==names.length||
      names.some((name)=>!/^[A-Za-z0-9._-]+$/.test(name)))
    fail('release-tool-resolution');
  if(platformName==='win32')fail('release-tool-resolution-platform');
  const pathEntries=String(environment.PATH||'').split(path.delimiter)
    .filter((entry)=>entry&&path.isAbsolute(entry));
  return names.map((name)=>{
    if(name==='node')return buildToolIdentity({name,targetPath:process.execPath});
    if(name==='git')return buildToolIdentity({name,targetPath:
      require('./platform.js').resolveGitExecutable(environment,fs)});
    for(const directory of pathEntries){
      const candidate=path.join(directory,name);
      try{
        const stat=fs.lstatSync(candidate);
        if(!stat.isFile()&&!stat.isSymbolicLink())continue;
        fs.accessSync(candidate,fs.constants.X_OK);
        return buildToolIdentity({name,targetPath:candidate});
      }catch(error){
        if(!['ENOENT','EACCES','ENOTDIR','release-tool-identity']
          .includes(error.code))throw error;
      }
    }
    fail('release-tool-missing',name);
  });
}
function resolveOptionalReleaseToolIdentities(names,options={}){
  if(!Array.isArray(names)||
      canonical(names)!==canonical([...names].sort(byteCompare))||
      new Set(names).size!==names.length||
      names.some((name)=>!/^[A-Za-z0-9._-]+$/.test(name)))
    fail('release-tool-resolution');
  const resolved=[];
  for(const name of names){
    try{resolved.push(resolveReleaseToolIdentities([name],options)[0]);}
    catch(error){if(error.code!=='release-tool-missing')throw error;}
  }
  return resolved;
}
function runAuthenticatedGit({root,args,environment=process.env,
  maxOutputBytes=4_194_304}={}){
  if(!path.isAbsolute(root||'')||!Array.isArray(args)||
      args.some((value)=>typeof value!=='string'||value.includes('\0'))||
      !Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1024||
      maxOutputBytes>16_777_216)fail('release-git-command');
  const identity=buildToolIdentity({name:'git',targetPath:
    require('./platform.js').resolveGitExecutable(environment,fs)});
  const result=require('node:child_process').spawnSync(identity.target_path,
    ['-C',fs.realpathSync(root),...args],{cwd:fs.realpathSync(root),
      env:{LANG:'C',LC_ALL:'C',TZ:'UTC'},encoding:null,shell:false,
      windowsHide:true,maxBuffer:maxOutputBytes});
  validateToolIdentity(identity);
  if(result.error||result.status!==0||result.signal!==null)
    fail('release-git-command');
  return Buffer.from(result.stdout);
}
function validateToolIdentity(value){
  const keys=['name','target_path','target_sha256','target_dev','target_ino',
    'target_mode','target_size','target_mtime_ns','shim_kind','shim_path',
    'shim_sha256'];
  if(!exactKeys(value,keys)||!/^[A-Za-z0-9._-]+$/.test(value.name||'')||
      !require('node:path').isAbsolute(value.target_path||'')||
      !DIGEST.test(value.target_sha256||'')||
      ![value.target_dev,value.target_ino,value.target_mode,value.target_size,
        value.target_mtime_ns].every((row)=>/^(?:0|[1-9]\d*)$/.test(row||''))||
      !['none','posix-symlink','windows-cmd'].includes(value.shim_kind)||
      (value.shim_kind==='none'?
        value.shim_path!==null||value.shim_sha256!==null:
        !require('node:path').isAbsolute(value.shim_path||'')||
          !DIGEST.test(value.shim_sha256||'')))
    fail('release-tool-identity');
  let physical,stat,bytes;try{physical=fs.realpathSync(value.target_path);
    stat=fs.lstatSync(physical,{bigint:true});bytes=fs.readFileSync(physical);}
  catch{fail('release-tool-identity');}
  if(physical!==value.target_path||!stat.isFile()||stat.isSymbolicLink()||
      (process.platform!=='win32'&&(stat.mode&0o111n)===0n)||
      sha256(bytes)!==value.target_sha256||
      decimal(stat.dev)!==value.target_dev||decimal(stat.ino)!==value.target_ino||
      decimal(stat.mode)!==value.target_mode||decimal(stat.size)!==value.target_size||
      statNanos(stat)!==value.target_mtime_ns)fail('release-tool-identity');
  if(value.shim_kind==='posix-symlink'){
    let shimStat,link,shimTarget;try{shimStat=fs.lstatSync(value.shim_path);
      link=fs.readlinkSync(value.shim_path);shimTarget=fs.realpathSync(value.shim_path);}
    catch{fail('release-tool-identity');}
    if(!shimStat.isSymbolicLink()||shimTarget!==value.target_path||
        sha256(Buffer.from(link))!==value.shim_sha256)
      fail('release-tool-identity');
  }
  return structuredClone(value);
}
function graphIdentity(row){return{kind:row.kind,path:row.path};}
function compareGraphIdentity(left,right){return byteCompare(left.kind,right.kind)||
  byteCompare(left.path,right.path);}
function compareGraphRows(left,right){return compareGraphIdentity(left,right);}
function commandRootRow(id,argv,outgoing=[]){
  if(id!=='npm-pack-dry-run-json'||canonical(argv)!==
      canonical(require('./release-gate-runtime.js').RELEASE_GATE_CATALOG.pack.argv))
    fail('release-source-graph');
  return{path:`command:${id}`,kind:'command-root',
    sha256:semanticDigest('release-command-root-v1',argv),
    outgoing:structuredClone(outgoing).sort(compareGraphIdentity)};
}
function graphDigest(value){return semanticDigest('release-source-graph-v1',value,
  'source_graph_sha256');}
function validateExecutableRows(rows,code){
  if(!Array.isArray(rows)||canonical(rows)!==canonical([...rows].sort((a,b)=>
      byteCompare(canonical(a),canonical(b)))))fail(code);
  return rows;
}
function validatePlatformDerivedExecutable(value){
  if(!exactKeys(value,['source_path','source_sha256','derivation_kind',
      'derivation_input_sha256','platform','target_identity'])||
      !portable(value.source_path)||!DIGEST.test(value.source_sha256||'')||
      !['active-node-process-exec-path','windows-systemroot-system32-tool',
        'windows-systemroot-windows-powershell-v1','windows-comspec']
        .includes(value.derivation_kind)||
      !DIGEST.test(value.derivation_input_sha256||'')||
      !['posix','win32'].includes(value.platform))
    fail('platform-derived-executable');
  const identity=validateToolIdentity(value.target_identity);
  if(value.derivation_kind==='active-node-process-exec-path'){
    if(identity.target_path!==fs.realpathSync(process.execPath)||
        value.derivation_input_sha256!==semanticDigest(
          'active-node-process-exec-path',identity))
      fail('platform-derived-executable');
  }else if(value.platform!=='win32')fail('platform-derived-executable');
  return structuredClone(value);
}
function buildActiveNodeExecutable({sourcePath,sourceSha256,
  name='node'}={}){
  const targetIdentity=buildToolIdentity({name,targetPath:process.execPath});
  return validatePlatformDerivedExecutable({source_path:sourcePath,
    source_sha256:sourceSha256,
    derivation_kind:'active-node-process-exec-path',
    derivation_input_sha256:semanticDigest(
      'active-node-process-exec-path',targetIdentity),
    platform:'posix',target_identity:targetIdentity});
}
function scalar(value){return value===null||typeof value==='string'||
  typeof value==='boolean'||Number.isSafeInteger(value);}
function validateTestFixtureExecutable(value){
  if(!exactKeys(value,['factory_source_path','factory_source_sha256',
      'factory_args','fixture_relpath','fixture_sha256','platform',
      'invocation_kind','child_path_sha256'])||
      !portable(value.factory_source_path)||
      !DIGEST.test(value.factory_source_sha256||'')||
      !Array.isArray(value.factory_args)||!value.factory_args.every(scalar)||
      !portable(value.fixture_relpath)||!DIGEST.test(value.fixture_sha256||'')||
      !['posix','win32'].includes(value.platform)||
      !['absolute-owned-temp','child-path-owned-temp-first']
        .includes(value.invocation_kind)||
      (value.invocation_kind==='absolute-owned-temp'?
        value.child_path_sha256!==null:
        !DIGEST.test(value.child_path_sha256||'')))
    fail('test-fixture-executable');
  return structuredClone(value);
}
function validateReleaseSourceGraph(value){
  const rowKeys=['path','kind','sha256','outgoing'];
  if(!exactKeys(value,['schema_version','roots','rows','platform_executables',
      'test_fixture_executables','source_graph_sha256'])||
      value.schema_version!==1||canonical(value.roots)!==canonical(
        ['command:npm-pack-dry-run-json','package.json#scripts.test'])||
      !Array.isArray(value.rows)||value.rows.length<2||
      canonical(value.rows)!==canonical([...value.rows].sort(compareGraphRows))||
      new Set(value.rows.map((row)=>`${row.kind}\0${row.path}`)).size!==
        value.rows.length||!DIGEST.test(value.source_graph_sha256||''))
    fail('release-source-graph');
  const identities=new Set(value.rows.map((row)=>`${row.kind}\0${row.path}`));
  for(const row of value.rows){
    if(!exactKeys(row,rowKeys)||
        !['command-root','package-document','package-script','node-entry',
          'shell-entry'].includes(row.kind)||
        !(row.kind==='command-root'?/^command:[a-z0-9-]+$/.test(row.path):
          portable(row.path))||!DIGEST.test(row.sha256||'')||
        !Array.isArray(row.outgoing)||
        canonical(row.outgoing)!==canonical([...row.outgoing]
          .sort(compareGraphIdentity))||
        new Set(row.outgoing.map((edge)=>`${edge.kind}\0${edge.path}`)).size!==
          row.outgoing.length||
        row.outgoing.some((edge)=>!exactKeys(edge,['kind','path'])||
          !identities.has(`${edge.kind}\0${edge.path}`)))
      fail('release-source-graph');
    if(row.path==='command:npm-pack-dry-run-json'&&row.sha256!==
        commandRootRow('npm-pack-dry-run-json',
          require('./release-gate-runtime.js').RELEASE_GATE_CATALOG.pack.argv).sha256)
      fail('release-source-graph');
  }
  if(!value.rows.some((row)=>row.path==='command:npm-pack-dry-run-json')||
      !value.rows.some((row)=>row.path==='package.json#scripts.test')||
      graphDigest(value)!==value.source_graph_sha256)
    fail('release-source-graph');
  validateExecutableRows(value.platform_executables,'release-source-graph')
    .forEach(validatePlatformDerivedExecutable);
  validateExecutableRows(value.test_fixture_executables,'release-source-graph')
    .forEach(validateTestFixtureExecutable);
  return structuredClone(value);
}
function buildReleaseSourceGraph({rows,platformExecutables=[],
  testFixtureExecutables=[]}={}){
  const graph={schema_version:1,
    roots:['command:npm-pack-dry-run-json','package.json#scripts.test'],
    rows:structuredClone(rows),platform_executables:
      structuredClone(platformExecutables),test_fixture_executables:
      structuredClone(testFixtureExecutables),source_graph_sha256:null};
  graph.source_graph_sha256=graphDigest(graph);
  return validateReleaseSourceGraph(graph);
}
function validateSourceGraphRef(value){
  return exactKeys(value,['kind','path','sha256','producer_operation_id'])&&
    value.kind==='release-source-graph'&&portable(value.path)&&
    DIGEST.test(value.sha256||'')&&OPERATION.test(value.producer_operation_id||'');
}
function manifestDigest(value){return semanticDigest('release-toolchain-manifest-v1',
  value,'manifest_sha256');}
function validateToolchainManifest(value){
  if(!exactKeys(value,['schema_version','platform','source_graph_ref',
      'source_graph_sha256','entries','manifest_sha256'])||
      value.schema_version!==1||typeof value.platform!=='string'||!value.platform||
      !validateSourceGraphRef(value.source_graph_ref)||
      !DIGEST.test(value.source_graph_sha256||'')||
      !Array.isArray(value.entries)||value.entries.length===0||
      canonical(value.entries)!==canonical([...value.entries].sort((a,b)=>
        byteCompare(a.name,b.name)))||
      new Set(value.entries.map((row)=>row.name)).size!==value.entries.length||
      !DIGEST.test(value.manifest_sha256||'')||
      manifestDigest(value)!==value.manifest_sha256)
    fail('release-toolchain-manifest');
  for(const entry of value.entries)validateToolIdentity(entry);
  return structuredClone(value);
}
function buildToolchainManifest({platform,sourceGraphRef,sourceGraphSha256,
  entries}={}){
  const value={schema_version:1,platform,
    source_graph_ref:structuredClone(sourceGraphRef),
    source_graph_sha256:sourceGraphSha256,
    entries:structuredClone(entries).sort((a,b)=>byteCompare(a.name,b.name)),
    manifest_sha256:null};
  value.manifest_sha256=manifestDigest(value);
  return validateToolchainManifest(value);
}
function materializeOwnedBin({parent,entries,platformName=process.platform}={}){
  let physicalParent,parentStat;try{physicalParent=fs.realpathSync(parent);
    parentStat=fs.lstatSync(physicalParent);}catch{fail('release-owned-bin');}
  if(!require('node:path').isAbsolute(parent||'')||!parentStat.isDirectory()||
      parentStat.isSymbolicLink()||!Array.isArray(entries)||entries.length===0)
    fail('release-owned-bin');
  if(!['posix','darwin','linux','freebsd','openbsd','aix','sunos'].includes(
      platformName))fail('release-owned-bin-platform');
  const binPath=fs.mkdtempSync(require('node:path').join(physicalParent,'bin-'));
  const names=new Set(),materialized=[];
  try{
    for(const source of [...entries].sort((a,b)=>byteCompare(a.name,b.name))){
      const identity=validateToolIdentity(source);
      if(names.has(identity.name))fail('release-owned-bin');names.add(identity.name);
      const shimPath=require('node:path').join(binPath,identity.name);
      fs.symlinkSync(identity.target_path,shimPath,'file');
      const link=fs.readlinkSync(shimPath);
      materialized.push(validateToolIdentity({...identity,
        shim_kind:'posix-symlink',shim_path:shimPath,
        shim_sha256:sha256(Buffer.from(link))}));
    }
    validateMaterializedBin(binPath,materialized);
    return{binPath,entries:materialized};
  }catch(error){fs.rmSync(binPath,{recursive:true,force:true});throw error;}
}
function validateMaterializedBin(binPath,entries){
  let stat,names;try{stat=fs.lstatSync(binPath);names=fs.readdirSync(binPath)
    .sort(byteCompare);}catch{fail('release-owned-bin');}
  const expected=entries.map((row)=>row.name).sort(byteCompare);
  if(!stat.isDirectory()||stat.isSymbolicLink()||
      canonical(names)!==canonical(expected))fail('release-owned-bin');
  for(const entry of entries){
    validateToolIdentity(entry);
    if(entry.shim_path!==require('node:path').join(binPath,entry.name))
      fail('release-owned-bin');
  }
  return true;
}
function pathIdentity(target,kind){
  let physical,stat,bytes=null;try{physical=fs.realpathSync(target);
    stat=fs.lstatSync(physical,{bigint:true});if(kind==='file')bytes=fs.readFileSync(physical);}
  catch{fail('release-path-identity');}
  if(kind==='file'&&(!stat.isFile()||stat.isSymbolicLink())||
      kind==='directory'&&(!stat.isDirectory()||stat.isSymbolicLink())||
      !['file','directory'].includes(kind))fail('release-path-identity');
  return{path:physical,kind,dev:decimal(stat.dev),ino:decimal(stat.ino),
    mode:decimal(stat.mode),size:decimal(stat.size),mtime_ns:statNanos(stat),
    sha256:bytes?sha256(bytes):null};
}
function validatePathIdentity(value){
  if(!exactKeys(value,['path','kind','dev','ino','mode','size','mtime_ns',
      'sha256'])||!['file','directory'].includes(value.kind)||
      !require('node:path').isAbsolute(value.path||'')||
      ![value.dev,value.ino,value.mode,value.size,value.mtime_ns].every((row)=>
        /^(?:0|[1-9]\d*)$/.test(row||''))||
      (value.kind==='file'?!DIGEST.test(value.sha256||''):value.sha256!==null)||
      canonical(pathIdentity(value.path,value.kind))!==canonical(value))
    fail('release-path-identity');
  return structuredClone(value);
}
function validateDirectoryAnchor(value){
  if(!exactKeys(value,['path','kind','dev','ino','mode','size','mtime_ns',
      'sha256'])||value.kind!=='directory'||value.sha256!==null)
    fail('release-path-identity');
  const current=pathIdentity(value.path,'directory');
  for(const key of ['path','kind','dev','ino','mode'])
    if(current[key]!==value[key])fail('release-path-identity');
  return structuredClone(value);
}
function environmentDigest(value){return semanticDigest('release-command-env-v1',
  value);}
function buildReleaseEnvironment({platformName=process.platform,homePath,binPath,
  manifestPath,manifest}={}){
  if(!['posix','darwin','linux','freebsd','openbsd','aix','sunos'].includes(
      platformName))fail('release-environment-platform');
  const home=pathIdentity(homePath,'directory'),ownedBin=
    pathIdentity(binPath,'directory'),manifestIdentity=pathIdentity(manifestPath,'file');
  if(manifestIdentity.sha256!==sha256(canonical(manifest)))fail('release-environment');
  const environment={platform:'posix',mode:'closed',values:{LANG:'C',LC_ALL:'C',
    TZ:'UTC',HOME:home.path,PATH:ownedBin.path},identities:{home,owned_bin:ownedBin,
    toolchain_manifest:{path:manifestIdentity.path,sha256:manifestIdentity.sha256,
      source_graph_sha256:manifest.source_graph_sha256}}};
  return{...environment,release_environment_sha256:
    environmentDigest(environment)};
}
function validateReleaseEnvironment(value,manifest,{allowHomeMetadataDrift=false}={}){
  const core={platform:value?.platform,mode:value?.mode,values:value?.values,
    identities:value?.identities};
  if(!exactKeys(value,['platform','mode','values','identities',
      'release_environment_sha256'])||value.platform!=='posix'||
      value.mode!=='closed'||!exactKeys(value.values,
        ['LANG','LC_ALL','TZ','HOME','PATH'])||
      canonical({LANG:value.values.LANG,LC_ALL:value.values.LC_ALL,
        TZ:value.values.TZ})!==canonical({LANG:'C',LC_ALL:'C',TZ:'UTC'})||
      !exactKeys(value.identities,['home','owned_bin','toolchain_manifest'])||
      (allowHomeMetadataDrift?validateDirectoryAnchor(value.identities.home):
        validatePathIdentity(value.identities.home)).path!==value.values.HOME||
      validatePathIdentity(value.identities.owned_bin).path!==value.values.PATH||
      !exactKeys(value.identities.toolchain_manifest,
        ['path','sha256','source_graph_sha256'])||
      value.identities.toolchain_manifest.sha256!==sha256(canonical(manifest))||
      value.identities.toolchain_manifest.source_graph_sha256!==
        manifest.source_graph_sha256||
      environmentDigest(core)!==value.release_environment_sha256)
    fail('release-environment');
  return structuredClone(value);
}
async function runHermetic({manifest,environment,executableName,args,cwd,
  timeoutMs,maxOutputBytes}={}){
  validateToolchainManifest(manifest);validateReleaseEnvironment(environment,manifest);
  validateMaterializedBin(environment.values.PATH,manifest.entries);
  const entry=manifest.entries.find((row)=>row.name===executableName);
  if(!entry||entry.shim_path!==require('node:path').join(environment.values.PATH,
      executableName)||!Array.isArray(args)||args.some((arg)=>typeof arg!=='string'))
    fail('release-command');
  const result=await require('./process-supervisor.js').runSupervisedProcess({
    executable:entry.shim_path,args},{cwd,timeoutMs,maxOutputBytes,
    env:structuredClone(environment.values)});
  validateMaterializedBin(environment.values.PATH,manifest.entries);
  validateReleaseEnvironment(environment,manifest,{allowHomeMetadataDrift:true});
  return result;
}
async function executeCatalogCommand({commandId,cwd,sourceGraphRef,
  sourceGraphSha256,entries,platformName=process.platform,timeoutMs,
  maxOutputBytes=1048576}={}){
  const catalog=require('./release-gate-runtime.js').RELEASE_GATE_CATALOG[commandId];
  const timeoutLimit=COMMAND_TIMEOUT_LIMITS[commandId],
    effectiveTimeout=timeoutMs===undefined?timeoutLimit:timeoutMs;
  let physicalCwd,cwdStat;try{physicalCwd=fs.realpathSync(cwd);
    cwdStat=fs.lstatSync(physicalCwd);}catch{fail('release-command');}
  if(!catalog||!cwdStat.isDirectory()||cwdStat.isSymbolicLink()||
      !Number.isSafeInteger(effectiveTimeout)||effectiveTimeout<100||
      effectiveTimeout>timeoutLimit||
      !Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1024||
      maxOutputBytes>1048576)fail('release-command');
  const executableName=catalog.argv[0],args=catalog.argv.slice(1);
  if(!Array.isArray(entries)||!entries.some((row)=>row.name===executableName))
    fail('release-command-tool');
  const parent=fs.mkdtempSync(require('node:path').join(
    require('node:os').tmpdir(),'deep-work-release-'));
  let materialized,home,manifestPath,manifest,environment;
  try{
    materialized=materializeOwnedBin({parent,entries,platformName});
    home=fs.mkdtempSync(require('node:path').join(parent,'home-'));
    manifest=buildToolchainManifest({platform:platformName,sourceGraphRef,
      sourceGraphSha256,entries:materialized.entries});
    manifestPath=require('node:path').join(parent,'toolchain.json');
    fs.writeFileSync(manifestPath,canonical(manifest),{flag:'wx',mode:0o600});
    environment=buildReleaseEnvironment({platformName,homePath:home,
      binPath:materialized.binPath,manifestPath,manifest});
    const result=await runHermetic({manifest,environment,executableName,args,
      cwd:physicalCwd,timeoutMs:effectiveTimeout,maxOutputBytes});
    return{command_id:commandId,argv:[...catalog.argv],
      release_environment_sha256:environment.release_environment_sha256,
      process_result:{exit_code:result.exitCode,signal:result.signal,
        timed_out:result.timedOut,output_overflow:result.outputOverflow,
        stdout_sha256:sha256(Buffer.from(result.stdout)),
        stderr_sha256:sha256(Buffer.from(result.stderr))},
      stdout:result.stdout,stderr:result.stderr};
  }finally{
    if(materialized)validateMaterializedBin(materialized.binPath,
      manifest?.entries||materialized.entries);
    if(environment&&manifest)validateReleaseEnvironment(environment,manifest,
      {allowHomeMetadataDrift:true});
    fs.rmSync(parent,{recursive:true,force:true});
    if(fs.existsSync(parent))fail('release-command-cleanup');
  }
}

function writeExclusive(file,bytes,code){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  let fd;try{fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|
    fs.constants.O_WRONLY,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}
  catch(error){if(error.code!=='EEXIST'||!fs.readFileSync(file).equals(bytes))
    fail(code);}finally{if(fd!==undefined)fs.closeSync(fd);}
  if(!fs.readFileSync(file).equals(bytes))fail(code);
}
async function publishReleaseSourceGraph({stateCapability,cwd}={}){
  const transaction=require('./transaction-runtime.js');
  if(!stateCapability?.projectRoot||fs.realpathSync(cwd)!==
      fs.realpathSync(stateCapability.projectRoot))
    fail('release-source-root');
  const sessionId=transaction.sessionIdFromState(stateCapability);
  const gitIdentity=buildToolIdentity({name:'git',targetPath:
    require('./platform.js').resolveGitExecutable(process.env,fs)});
  const scanner=require('./release-source-scanner.js');
  const committedFiles=scanner.loadCommittedFiles({root:cwd,gitIdentity,
    requireWorktreeMatch:true});
  const scanned=scanner.scanReleaseSources({committedFiles});
  const graph=validateReleaseSourceGraph(scanned.graph);
  const graphBytes=Buffer.from(canonical(graph));
  const graphArtifactSha256=sha256(graphBytes);
  const id=operationId('release-source-graph-publish-v1',{
    session_id:sessionId,source_graph_sha256:graph.source_graph_sha256,
    source_graph_artifact_sha256:graphArtifactSha256});
  const relative=`.deep-work/${sessionId}/release/source-graph-${
    graph.source_graph_sha256}.json`;
  const project=transaction.projectCapabilityFor(stateCapability);
  const existing=journal.lookupCompletedOperation({projectCapability:project,
    operationId:id,sessionId,kind:'release-source-graph-publish'});
  if(existing){
    const result=existing.result,target=path.join(stateCapability.projectRoot,
      ...relative.split('/'));
    if(existing.stage!=='completed-ledger'||!exactKeys(result,
      ['source_graph_path','source_graph_sha256',
        'source_graph_artifact_sha256','required_tools','optional_tools'])||
        result.source_graph_path!==relative||
        result.source_graph_sha256!==graph.source_graph_sha256||
        result.source_graph_artifact_sha256!==graphArtifactSha256||
        canonical(result.required_tools)!==canonical(scanned.required_tools)||
        canonical(result.optional_tools)!==canonical(scanned.optional_tools)||
        !fs.readFileSync(target).equals(graphBytes))
      fail('release-source-graph-replay');
    return{graph,graph_ref:{kind:'release-source-graph',path:relative,
      sha256:graphArtifactSha256,producer_operation_id:id},
    required_tools:[...scanned.required_tools],operation_id:id,
    optional_tools:[...scanned.optional_tools],
    operation_receipt:existing,adopted:true};
  }
  const operation=await journal.beginOperation({projectCapability:project,
    sessionId,kind:'release-source-graph-publish',operationId:id,
    preconditions:{source_graph_sha256:graph.source_graph_sha256,
      source_graph_artifact_sha256:graphArtifactSha256}});
  writeExclusive(path.join(stateCapability.projectRoot,...relative.split('/')),
    graphBytes,'release-source-graph-publish');
  await journal.recordOperationStage(operation,'graph-published',{owned:{
    path:relative,sha256:graphArtifactSha256,
    sourceGraphSha256:graph.source_graph_sha256}});
  const result={source_graph_path:relative,
    source_graph_sha256:graph.source_graph_sha256,
    source_graph_artifact_sha256:graphArtifactSha256,
    required_tools:[...scanned.required_tools],
    optional_tools:[...scanned.optional_tools]};
  const receipt=await journal.completeOperation(operation,result);
  return{graph,graph_ref:{kind:'release-source-graph',path:relative,
    sha256:graphArtifactSha256,producer_operation_id:id},
  required_tools:[...scanned.required_tools],operation_id:id,
  optional_tools:[...scanned.optional_tools],
  operation_receipt:receipt,adopted:false};
}
function authenticateReleaseSourceGraphRef({stateCapability,ref}={}){
  const transaction=require('./transaction-runtime.js');
  if(!validateSourceGraphRef(ref))fail('release-source-graph-ref');
  const sessionId=transaction.sessionIdFromState(stateCapability);
  const receipt=journal.lookupCompletedOperation({projectCapability:
    transaction.projectCapabilityFor(stateCapability),
  operationId:ref.producer_operation_id,sessionId,
  kind:'release-source-graph-publish'});
  const result=receipt?.result;
  if(receipt?.stage!=='completed-ledger'||!exactKeys(result,
    ['source_graph_path','source_graph_sha256',
      'source_graph_artifact_sha256','required_tools','optional_tools'])||
      result.source_graph_path!==ref.path||
      result.source_graph_artifact_sha256!==ref.sha256||
      !Array.isArray(result.required_tools)||
      canonical(result.required_tools)!==canonical([...result.required_tools]
        .sort(byteCompare))||new Set(result.required_tools).size!==
        result.required_tools.length||
      !Array.isArray(result.optional_tools)||
      canonical(result.optional_tools)!==canonical([...result.optional_tools]
        .sort(byteCompare))||new Set(result.optional_tools).size!==
        result.optional_tools.length||
      result.optional_tools.some((name)=>result.required_tools.includes(name))||
      ref.path!==`.deep-work/${sessionId}/release/source-graph-${
        result.source_graph_sha256}.json`)
    fail('release-source-graph-producer');
  const target=path.join(stateCapability.projectRoot,...ref.path.split('/'));
  let stat,bytes,value;try{stat=fs.lstatSync(target);bytes=fs.readFileSync(target);
    value=JSON.parse(bytes);}catch{fail('release-source-graph-producer');}
  const graph=validateReleaseSourceGraph(value);
  if(!stat.isFile()||stat.isSymbolicLink()||
      !bytes.equals(Buffer.from(canonical(graph)))||sha256(bytes)!==ref.sha256||
      graph.source_graph_sha256!==result.source_graph_sha256)
    fail('release-source-graph-producer');
  return{graph,receipt,required_tools:[...result.required_tools],
    optional_tools:[...result.optional_tools]};
}

module.exports={canonical,sha256,buildToolIdentity,validateToolIdentity,
  COMMAND_TIMEOUT_LIMITS,
  resolveReleaseToolIdentities,resolveOptionalReleaseToolIdentities,
  commandRootRow,compareGraphRows,buildReleaseSourceGraph,
  validateReleaseSourceGraph,buildToolchainManifest,validateToolchainManifest,
  buildActiveNodeExecutable,validatePlatformDerivedExecutable,
  validateTestFixtureExecutable,runAuthenticatedGit,
  publishReleaseSourceGraph,authenticateReleaseSourceGraphRef,
  materializeOwnedBin,validateMaterializedBin,pathIdentity,
  validatePathIdentity,buildReleaseEnvironment,validateReleaseEnvironment,
  runHermetic,executeCatalogCommand};
