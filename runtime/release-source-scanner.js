'use strict';

const fs=require('node:fs');
const path=require('node:path');
const childProcess=require('node:child_process');
const toolchain=require('./release-toolchain-runtime.js');

function fail(code,message=code){const error=new Error(`[${code}] ${message}`);
  error.code=code;throw error;}
function byteCompare(left,right){return Buffer.compare(Buffer.from(left),
  Buffer.from(right));}
function compareGraphIdentity(left,right){
  return byteCompare(left.kind,right.kind)||byteCompare(left.path,right.path);
}
function portable(value){return typeof value==='string'&&value.length>0&&
  !value.startsWith('/')&&!value.includes('\\')&&
  !value.split('/').includes('..');}
function shellWords(source){
  if(typeof source!=='string'||!source.trim())fail('release-shell-parse');
  const words=[];let word='',quote=null,escaped=false,active=false;
  for(let index=0;index<source.length;index++){
    const char=source[index];
    if(escaped){word+=char;escaped=false;active=true;continue;}
    if(char==='\\'&&quote!=="'"){escaped=true;active=true;continue;}
    if(quote){
      if(char===quote){quote=null;active=true;}else word+=char;
      continue;
    }
    if(char==="'"||char==='"'){quote=char;active=true;continue;}
    if(/\s/.test(char)){if(active){words.push(word);word='';active=false;}
      continue;}
    if(/[;&|<>`$(){}]/.test(char))fail('release-shell-parse');
    word+=char;active=true;
  }
  if(escaped||quote)fail('release-shell-parse');
  if(active)words.push(word);
  if(words.length===0)fail('release-shell-parse');
  return words;
}
function globRegex(pattern){
  if(!portable(pattern)||!pattern.endsWith('.test.js'))
    fail('release-source-glob');
  let value='^';
  for(let index=0;index<pattern.length;index++){
    const char=pattern[index];
    if(char==='*'&&pattern[index+1]==='*'&&pattern[index+2]==='/'){
      value+='(?:.*/)?';index+=2;
    }else if(char==='*')value+='[^/]*';
    else value+=char.replace(/[.+?^${}()|[\]\\]/g,'\\$&');
  }
  return new RegExp(`${value}$`);
}
function expandTargets(words,files){
  const targets=[];
  for(const word of words){
    const matches=word.includes('*')?[...files.keys()].filter((candidate)=>
      globRegex(word).test(candidate)):[word];
    if(matches.length===0)fail('release-source-glob');
    for(const match of matches.sort(byteCompare)){
      if(!portable(match)||!files.has(match)||!match.endsWith('.test.js'))
        fail('release-source-target');
      targets.push(match);
    }
  }
  const sorted=[...new Set(targets)].sort(byteCompare);
  if(sorted.length!==targets.length)fail('release-source-target');
  return sorted;
}
function fileMap(input){
  if(!input||typeof input!=='object'||Array.isArray(input))
    fail('release-source-files');
  const result=new Map();
  for(const [name,value] of Object.entries(input).sort((a,b)=>
    byteCompare(a[0],b[0]))){
    if(!portable(name)||result.has(name)||
        !(Buffer.isBuffer(value)||typeof value==='string'))
      fail('release-source-files');
    result.set(name,Buffer.isBuffer(value)?Buffer.from(value):
      Buffer.from(value));
  }
  return result;
}
function packageDocument(files){
  const bytes=files.get('package.json');if(!bytes)fail('release-package');
  let value;try{value=JSON.parse(bytes);}catch{fail('release-package');}
  if(!value||typeof value!=='object'||Array.isArray(value)||
      !value.scripts||typeof value.scripts!=='object'||
      Array.isArray(value.scripts))fail('release-package');
  return{bytes,value};
}
function scanPackageScripts(files,document){
  const scripts=document.value.scripts,visiting=new Set(),rows=new Map(),
    nodeTargets=new Set();
  function visit(name){
    if(visiting.has(name))fail('release-source-cycle');
    if(rows.has(name))return;
    const script=scripts[name];
    if(typeof script!=='string'||!script)fail('release-package-script');
    visiting.add(name);const words=shellWords(script),outgoing=[];
    if(words[0]==='npm'&&words[1]==='run'&&words.length===3){
      const target=words[2];visit(target);outgoing.push({
        kind:'package-script',path:`package.json#scripts.${target}`});
    }else if(words[0]==='node'&&words[1]==='--test'){
      const targetWords=words.slice(2).filter((word)=>
        !word.startsWith('--test-concurrency='));
      if(targetWords.length===0||words.slice(2).some((word)=>
        word.startsWith('-')&&!word.startsWith('--test-concurrency=')))
        fail('release-package-script');
      for(const target of expandTargets(targetWords,files)){
        nodeTargets.add(target);outgoing.push({kind:'node-entry',path:target});
      }
      outgoing.sort((a,b)=>byteCompare(a.path,b.path));
    }else fail('release-package-script');
    rows.set(name,{path:`package.json#scripts.${name}`,
      kind:'package-script',sha256:toolchain.sha256(Buffer.from(script)),
      outgoing});visiting.delete(name);
  }
  visit('test');
  return{rows,nodeTargets};
}
function jsTokens(source){
  const tokens=[];let index=0;
  while(index<source.length){
    const char=source[index],next=source[index+1];
    if(/\s/.test(char)){index++;continue;}
    if(char==='/'&&next==='/'){index+=2;while(index<source.length&&
        source[index]!=='\n')index++;continue;}
    if(char==='/'&&next==='*'){index+=2;while(index<source.length&&
        !(source[index]==='*'&&source[index+1]==='/'))index++;
      if(index>=source.length)fail('release-source-js',String(index));index+=2;continue;}
    if(char==='/'&&(()=>{
      const prior=tokens.at(-1);
      return !prior||prior.type==='punct'&&
        ['(','[','{','=',':',',',';','!','?','&','|','+','-','*','%',
          '^','~','>'].includes(prior.value)||
        prior.type==='identifier'&&['return','case','throw','yield']
          .includes(prior.value);
    })()){
      const start=index++;let escaped=false,inClass=false,closed=false;
      for(;index<source.length;index++){
        const current=source[index];
        if(escaped){escaped=false;continue;}
        if(current==='\\'){escaped=true;continue;}
        if(current==='['){inClass=true;continue;}
        if(current===']'){inClass=false;continue;}
        if(current==='/'&&!inClass){index++;closed=true;break;}
        if(current==='\n'||current==='\r')break;
      }
      if(!closed)fail('release-source-js',String(index));
      while(index<source.length&&/[A-Za-z]/.test(source[index]))index++;
      tokens.push({type:'regex',value:null,start});continue;
    }
    if(char==="'"||char==='"'){
      const quote=char,start=index++;let value='',escaped=false;
      for(;index<source.length;index++){
        const current=source[index];
        if(escaped){value+=current;escaped=false;continue;}
        if(current==='\\'){escaped=true;continue;}
        if(current===quote){index++;break;}
        if(current==='\n'||current==='\r')fail('release-source-js',String(index));
        value+=current;
      }
      if(source[index-1]!==quote)fail('release-source-js',String(index));
      tokens.push({type:'string',value,start});continue;
    }
    if(char==='`'){
      const start=index++;let escaped=false;
      for(;index<source.length;index++){
        const current=source[index];
        if(escaped){escaped=false;continue;}
        if(current==='\\'){escaped=true;continue;}
        if(current==='`'){index++;break;}
      }
      if(source[index-1]!=='`')fail('release-source-js',String(index));
      tokens.push({type:'template',value:null,start});continue;
    }
    if(/[A-Za-z_$]/.test(char)){
      const start=index++;while(index<source.length&&
        /[A-Za-z0-9_$]/.test(source[index]))index++;
      tokens.push({type:'identifier',value:source.slice(start,index),start});
      continue;
    }
    tokens.push({type:'punct',value:char,start:index});index++;
  }
  return tokens;
}
function callSourceAt(source,tokens,index){
  let depth=0;
  for(let cursor=index+1;cursor<tokens.length;cursor++){
    const token=tokens[cursor];
    if(token.type!=='punct')continue;
    if(token.value==='(')depth++;
    else if(token.value===')'){
      depth--;
      if(depth===0)return source.slice(tokens[index].start,token.start+1);
    }
  }
  fail('release-source-js',String(tokens[index].start));
}
function enclosingNamedFunction(source,tokens,index,name){
  for(let start=index-1;start>=0;start--){
    if(tokens[start].type!=='identifier'||tokens[start].value!=='function'||
        tokens[start+1]?.type!=='identifier'||tokens[start+1].value!==name)
      continue;
    let parameterDepth=0,parametersClosed=-1;
    for(let cursor=start+2;cursor<index;cursor++){
      const token=tokens[cursor];
      if(token.type!=='punct')continue;
      if(token.value==='(')parameterDepth++;
      else if(token.value===')'){
        parameterDepth--;
        if(parameterDepth===0){parametersClosed=cursor;break;}
      }
    }
    let open=-1;
    for(let cursor=parametersClosed+1;parametersClosed>=0&&cursor<index;
      cursor++)if(tokens[cursor].type==='punct'&&tokens[cursor].value==='{'){
      open=cursor;break;
    }
    if(open<0)continue;
    let depth=0;
    for(let cursor=open;cursor<tokens.length;cursor++){
      const token=tokens[cursor];
      if(token.type!=='punct')continue;
      if(token.value==='{')depth++;
      else if(token.value==='}'){
        depth--;
        if(depth===0){
          if(index>open&&index<cursor)
            return{source:source.slice(tokens[start].start,token.start+1),
              startIndex:start,openIndex:open,closeIndex:cursor};
          break;
        }
      }
    }
  }
  return null;
}
function tokenSequenceIndex(tokens,from,to,values){
  for(let index=from;index+values.length<=to;index++)
    if(values.every((value,offset)=>tokens[index+offset]?.value===value))
      return index;
  return -1;
}
function scanLaunchSites(path,bytes,{platformName=process.platform}={}){
  const source=bytes.toString('utf8');
  if(!Buffer.from(source).equals(bytes))fail('release-source-utf8');
  const required=new Set(),optional=new Set(),platform=[];let activeNode=false;
  let tokens;try{tokens=jsTokens(source);}catch(error){
    if(error.code==='release-source-js')
      fail('release-source-js',`${path}:${error.message}`);throw error;}
  const kinds=new Set(['spawn','spawnSync','execFile','execFileSync','fork']),
    directBindings=new Set(),bindingKinds=new Map(),moduleBindings=new Set();
  if(path==='runtime/process-supervisor.js')kinds.add('spawnImpl');
  for(const match of source.matchAll(
    /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g)){
    for(const item of match[1].split(',')){
      const parts=item.trim().split(/\s*:\s*/);
      if(kinds.has(parts[0])){
        const binding=parts[1]||parts[0];
        directBindings.add(binding);bindingKinds.set(binding,parts[0]);
      }
    }
  }
  for(const match of source.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g))
    moduleBindings.add(match[1]);
  for(const match of source.matchAll(
    /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\b/g)){
    if(!moduleBindings.has(match[2]))continue;
    for(const item of match[1].split(',')){
      const parts=item.trim().split(/\s*:\s*/);
      if(kinds.has(parts[0])){
        const binding=parts[1]||parts[0];
        directBindings.add(binding);bindingKinds.set(binding,parts[0]);
      }
    }
  }
  // Follows exactly these carriers to a fixpoint: identifier and child_process
  // module-member aliases in declaration/default-parameter position, plus
  // declaration destructuring from a literal require or known module binding.
  // Every other carrier is outside the model; measured residual examples are
  // property/object stores, reassignment, array/IIFE and cross-module carriers,
  // and re-export chains.
  for(let changed=true;changed;){
    changed=false;
    for(let index=0;index<tokens.length-2;index++){
      const alias=tokens[index],equals=tokens[index+1],target=tokens[index+2],
        previous=tokens[index-1]?.value,
        declaration=['const','let','var'].includes(previous),
        defaultParameter=['(',',','{','['].includes(previous),
        directAlias=target?.type==='identifier'&&
          tokens[index+3]?.value!=='('&&directBindings.has(target.value),
        memberKind=tokens[index+4],
        memberAlias=target?.type==='identifier'&&
          moduleBindings.has(target.value)&&tokens[index+3]?.value==='.'&&
          memberKind?.type==='identifier'&&kinds.has(memberKind.value)&&
          tokens[index+5]?.value!=='(';
      if(alias.type!=='identifier'||equals?.value!=='='||
          (!declaration&&!defaultParameter)||
          (!directAlias&&!memberAlias)||directBindings.has(alias.value))continue;
      directBindings.add(alias.value);
      bindingKinds.set(alias.value,memberAlias?memberKind.value:
        bindingKinds.get(target.value)||target.value);
      changed=true;
    }
  }
  for(let index=0;index<tokens.length-2;index++){
    const call=tokens[index],open=tokens[index+1],first=tokens[index+2];
    if(call.type!=='identifier'||
        (!kinds.has(call.value)&&!directBindings.has(call.value))||
        open.type!=='punct'||open.value!=='(')continue;
    const member=tokens[index-1]?.value==='.'?
      tokens[index-2]?.value:null,direct=directBindings.has(call.value),
      boundMember=member&&moduleBindings.has(member),
      inlineRequire=tokens[index-1]?.value==='.'&&
        tokens[index-2]?.value===')'&&tokens[index-3]?.type==='string'&&
        /^(?:node:)?child_process$/.test(tokens[index-3].value)&&
        tokens[index-4]?.value==='('&&tokens[index-5]?.value==='require',
      callKind=bindingKinds.get(call.value)||call.value;
    if(call.value!=='spawnImpl'&&!direct&&!boundMember&&!inlineRequire)continue;
    if(callKind==='fork'){activeNode=true;continue;}
    const invocation=callSourceAt(source,tokens,index);
    const expression=[first,tokens[index+3],tokens[index+4],
      tokens[index+5],tokens[index+6]].filter(Boolean)
      .map((token)=>token.value).join('');
    if(expression.startsWith('process.execPath')){
      activeNode=true;continue;
    }
    if(path==='runtime/process-supervisor.js'&&
        (call.value==='spawnImpl'&&
          ['executable','spec.executable'].some((value)=>
            expression.startsWith(value))||
        call.value==='spawn'&&
          expression.startsWith('message.spec.executable')))continue;
    if(path==='runtime/health-runtime.js'&&call.value==='spawnSync'&&
        expression.startsWith('checked.executable')){
      const validations=[...source.matchAll(
        /validateReleaseCarrier\(\s*checked\.executable\s*,\s*environment\s*\)/g)];
      if(validations.length>=2&&
          /const\s+checked\s*=\s*validateNativeSpec\(\s*spec\s*,\s*\{\s*environment\s*\}\s*\)/.test(source)&&
          /\benv\s*:\s*environment\b/.test(source))continue;
    }
    if(path==='runtime/release-source-scanner.js'&&
        call.value==='spawnSync'&&member==='childProcess'&&
        expression.startsWith('identity.target_path')){
      const carrierInfo=enclosingNamedFunction(source,tokens,index,'gitRead'),
        carrier=carrierInfo?.source,
        identityIndex=carrierInfo?tokenSequenceIndex(tokens,
          carrierInfo.openIndex+1,index,
          ['const','identity','=','toolchain','.','validateToolIdentity','(',
            'gitIdentity',')']):-1,
        nameCheckIndex=carrierInfo?tokenSequenceIndex(tokens,
          carrierInfo.openIndex+1,index,
          ['identity','.','name','!','=','=', 'git']):-1,
        postValidationIndex=carrierInfo?tokenSequenceIndex(tokens,index+1,
          carrierInfo.closeIndex,
          ['toolchain','.','validateToolIdentity','(','identity',')']):-1;
      if(carrier&&identityIndex>=0&&nameCheckIndex>=0&&
          postValidationIndex>index&&
          /^spawnSync\(\s*identity\.target_path\s*,\s*args\s*,\s*\{[\s\S]*env\s*:\s*\{\s*LANG\s*:\s*['"]C['"]\s*,\s*LC_ALL\s*:\s*['"]C['"]\s*,\s*TZ\s*:\s*['"]UTC['"]\s*\}[\s\S]*shell\s*:\s*false\b[\s\S]*\}\s*\)$/.test(invocation)){
        required.add('git');continue;
      }
    }
    if(path==='runtime/release-toolchain-runtime.js'&&
        call.value==='spawnSync'&&inlineRequire&&
        expression.startsWith('identity.target_path')){
      const carrierInfo=enclosingNamedFunction(source,tokens,index,
        'runAuthenticatedGit'),carrier=carrierInfo?.source,
        identityIndex=carrierInfo?tokenSequenceIndex(tokens,
          carrierInfo.openIndex+1,index,
          ['const','identity','=','buildToolIdentity','(','{','name',':','git',
            ',','targetPath',':','require','(','./platform.js',')','.',
            'resolveGitExecutable','(','environment',',','fs',')','}',')']):-1,
        postValidationIndex=carrierInfo?tokenSequenceIndex(tokens,index+1,
          carrierInfo.closeIndex,
          ['validateToolIdentity','(','identity',')']):-1;
      if(carrier&&identityIndex>=0&&postValidationIndex>index&&
          /^spawnSync\(\s*identity\.target_path\s*,\s*\[\s*['"]-C['"]\s*,\s*fs\.realpathSync\(\s*root\s*\)\s*,\s*\.\.\.args\s*\]\s*,\s*\{[\s\S]*cwd\s*:\s*fs\.realpathSync\(\s*root\s*\)[\s\S]*env\s*:\s*\{\s*LANG\s*:\s*['"]C['"]\s*,\s*LC_ALL\s*:\s*['"]C['"]\s*,\s*TZ\s*:\s*['"]UTC['"]\s*\}[\s\S]*shell\s*:\s*false\b[\s\S]*\}\s*\)$/.test(invocation)){
        required.add('git');continue;
      }
    }
    if(first.type==='identifier'&&first.value==='git'&&
        path==='runtime/platform.js'&&
        /const git = resolveGitExecutable\(/.test(source)){
      required.add('git');continue;
    }
    if(first.type==='identifier'&&first.value==='executable'&&
        call.value==='execFileSync'&&path==='runtime/platform.js'&&
        /const executable = resolveGitExecutable\(/.test(source)){
      required.add('git');continue;
    }
    if(first.type==='identifier'&&first.value==='binary'&&
        path==='runtime/review-policy-runtime.js'&&
        /probe\(\s*['"]codex['"]\s*,\s*safeEnv\s*\)/.test(source)&&
        /probe\(\s*['"]gemini['"]\s*,\s*safeEnv\s*\)/.test(source)){
      optional.add('codex');optional.add('gemini');continue;
    }
    if(first.type==='string'&&first.value==='python3'&&
        (path==='scripts/router-shadow.js'||
          path==='scripts/lib/locate-deep-model-router.js')&&
        (/spawnSync\(\s*['"]python3['"]/.test(source)||
          /exec\(\s*['"]python3['"]/.test(source))){
      optional.add('python3');continue;
    }
    if(path==='hooks/scripts/hook-runtime-portability.test.js'&&
        call.value==='spawnSync'&&first.type==='identifier'&&
        first.value==='resolveWindowsPowerShell'){
      const carrierInfo=enclosingNamedFunction(source,tokens,index,'runRegistered'),
        planIndex=carrierInfo?tokenSequenceIndex(tokens,
          carrierInfo.openIndex+1,index,
          ['const','plan','=','planLaunch','(','entry',',','options',')']):-1,
        plannerResolveIndex=tokenSequenceIndex(tokens,0,tokens.length,
          ['executable',':','resolveWindowsPowerShell','(','options','.','env',')']),
        plannerInfo=plannerResolveIndex>=0?
          enclosingNamedFunction(source,tokens,plannerResolveIndex,'planLaunch'):null,
        plannerShellIndex=plannerInfo?tokenSequenceIndex(tokens,
          plannerInfo.openIndex+1,plannerInfo.closeIndex,
          ['shell',':','false']):-1;
      // This admission pins the first-argument expression; mutable plan.args remains
      // consumed (-Command script on Windows), and mutable plan.options.env can select
      // SystemRoot. The portability suite owns the resolver's use of child SystemRoot
      // plus its isAbsolute and exists guards; within the resolver, this gate pins only
      // the join line in place. Neither detects redefinition or shadowing itself;
      // behaviour-preserving redefinitions go unnoticed by both.
      if(platformName!=='win32'&&carrierInfo&&planIndex>=0&&
          plannerInfo&&plannerShellIndex>=0&&
          /^spawnSync\(\s*resolveWindowsPowerShell\(plan\.options\.env\)\s*,\s*plan\.args\s*,\s*\{\s*\.\.\.plan\.options\s*,\s*shell: false\s*\}\s*\)$/.test(invocation)&&
          /const executable = path\.win32\.join\(systemRoot,\s*'System32',\s*'WindowsPowerShell',\s*'v1\.0',\s*'powershell\.exe'\);/m
            .test(source))continue;
    }
    if(first.type==='identifier'&&first.value==='executable'&&
        path==='runtime/platform.test.js'&&
        /const executable = path\.win32\.join\(systemRoot,\s*'System32',\s*'WindowsPowerShell',\s*'v1\.0',\s*'powershell\.exe'\);/m
          .test(source)&&platformName!=='win32')continue;
    if(first.type!=='string'||!/^[A-Za-z0-9._/-]+$/.test(first.value))
      fail('release-launch-dynamic',`${path}:${member?`${member}.`:''}${
        call.value}:${first.value||first.type}`);
    required.add(first.value==='/bin/sh'?'sh':first.value);
  }
  if(activeNode)platform.push(toolchain.buildActiveNodeExecutable({
    sourcePath:path,sourceSha256:toolchain.sha256(bytes)}));
  return{required_tools:[...required].sort(byteCompare),
    optional_tools:[...optional].sort(byteCompare),
    platform_executables:platform};
}
function resolveCommittedLiteral(sourcePath,literal,files,extension){
  if(typeof literal!=='string'||!literal.endsWith(extension))return null;
  const directory=path.posix.dirname(sourcePath),relative=path.posix.normalize(
    path.posix.join(directory,literal)),root=path.posix.normalize(literal);
  for(const candidate of [relative,root])
    if(portable(candidate)&&files.has(candidate))return candidate;
  const matches=[...files.keys()].filter((candidate)=>
    candidate.endsWith(`/${path.posix.basename(literal)}`)||
    candidate===path.posix.basename(literal)).sort(byteCompare);
  if(matches.length>1)fail('release-source-ambiguous',
    `${sourcePath}:${literal}`);
  return matches[0]||null;
}
function nodeShellEntrypoints(sourcePath,bytes,files,requiredTools){
  if(!requiredTools.some((name)=>['bash','sh'].includes(name)))return[];
  const source=bytes.toString('utf8');let tokens;
  try{tokens=jsTokens(source);}catch(error){
    if(error.code==='release-source-js')
      fail('release-source-js',`${sourcePath}:${error.message}`);throw error;}
  const targets=new Set();
  for(const token of tokens){
    if(token.type!=='string'||!token.value.endsWith('.sh'))continue;
    const selected=resolveCommittedLiteral(sourcePath,token.value,files,'.sh');
    if(selected)targets.add(selected);
  }
  return[...targets].sort(byteCompare);
}
const SHELL_BUILTINS=new Set(['.','[','[[','break','builtin','caller','case',
  'cd','command','continue','declare','do','done','echo','elif','else','esac',
  'eval','exec','exit','export','false','fi','for','function','getopts','hash',
  'if','in','let','local','mapfile','popd','printf','pushd','pwd','read',
  'readonly','return','select','set','shift','shopt','source','test','then',
  'time','times','trap','true','type','typeset','ulimit','umask','unalias',
  'unset','until','wait','while']);
function maskShellHeredocs(source){
  const lines=source.split(/(?<=\n)/),result=[];let delimiter=null;
  for(const line of lines){
    const body=line.replace(/\r?\n$/,'');
    if(delimiter!==null){
      result.push(line.replace(/[^\r\n]/g,' '));
      if(body===delimiter||body===`\t${delimiter}`)delimiter=null;
      continue;
    }
    const match=line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    result.push(line);
    if(match)delimiter=match[1];
  }
  if(delimiter!==null)fail('release-source-shell-heredoc');
  return result.join('');
}
function maskShellComments(source){
  const chars=source.split('');let quote=null,escaped=false,comment=false;
  for(let index=0;index<source.length;index++){
    const char=source[index];
    if(comment){
      if(char==='\n')comment=false;
      else if(char!=='\r')chars[index]=' ';
      continue;
    }
    if(escaped){escaped=false;continue;}
    if(char==='\\'&&quote!=="'"){escaped=true;continue;}
    if(quote){if(char===quote)quote=null;continue;}
    if(char==="'"||char==='"'){quote=char;continue;}
    if(char==='#'&&(index===0||/[\s;|&({]/.test(source[index-1]))){
      comment=true;chars[index]=' ';
    }
  }
  return chars.join('');
}
function extractShellSubstitutions(source){
  const chars=source.split(''),segments=[];let quote=null,escaped=false;
  function closeParen(start){
    let depth=1,innerQuote=null,innerEscaped=false;
    for(let index=start;index<source.length;index++){
      const char=source[index],next=source[index+1];
      if(innerEscaped){innerEscaped=false;continue;}
      if(innerQuote){
        if(char==='\\'&&innerQuote==='"'){innerEscaped=true;continue;}
        if(char===innerQuote)innerQuote=null;
        continue;
      }
      if(char==="'"||char==='"'){innerQuote=char;continue;}
      if(char==='$'&&next==='('){depth++;index++;continue;}
      if(char==='('){depth++;continue;}
      if(char===')'&&--depth===0)return index;
    }
    fail('release-source-shell-substitution');
  }
  for(let index=0;index<source.length;index++){
    const char=source[index],next=source[index+1];
    if(escaped){escaped=false;continue;}
    if(char==='\\'&&quote!=="'"){escaped=true;continue;}
    if(quote){
      if(char===quote){quote=null;continue;}
      if(quote==="'"||char!=='$'||next!=='(')continue;
    }else if(char==="'"||char==='"'){quote=char;continue;}
    if(char==='$'&&next==='('&&source[index+2]!=='('){
      const end=closeParen(index+2);
      segments.push(source.slice(index+2,end));
      for(let cursor=index;cursor<=end;cursor++)
        if(chars[cursor]!=='\n'&&chars[cursor]!=='\r')chars[cursor]=' ';
      index=end;continue;
    }
    if(char==='`'&&quote!=="'"){
      let end=index+1,backtickEscaped=false;
      for(;end<source.length;end++){
        if(backtickEscaped){backtickEscaped=false;continue;}
        if(source[end]==='\\'){backtickEscaped=true;continue;}
        if(source[end]==='`')break;
      }
      if(end>=source.length)fail('release-source-shell-substitution');
      segments.push(source.slice(index+1,end));
      for(let cursor=index;cursor<=end;cursor++)
        if(chars[cursor]!=='\n'&&chars[cursor]!=='\r')chars[cursor]=' ';
      index=end;
    }
  }
  return{masked:chars.join(''),segments};
}
function shellCommandSegments(source){
  const extracted=extractShellSubstitutions(maskShellComments(
      maskShellHeredocs(source))),
    working=extracted.masked,segments=extracted.segments;
  function maskQuotes(value){
    let result='',quote=null,escaped=false,comment=false;
    for(let index=0;index<value.length;index++){
      const char=value[index];
      if(comment){
        if(char==='\n'){comment=false;result+='\n';}else result+=' ';
        continue;
      }
      if(escaped){result+=' ';escaped=false;continue;}
      if(quote){
        if(char==='\\'&&quote==='"'){result+=' ';escaped=true;continue;}
        if(char===quote){quote=null;result+=' ';continue;}
        result+=char==='\n'?'\n':' ';continue;
      }
      if(char==="'"||char==='"'){quote=char;result+=' ';continue;}
      if(char==='#'){comment=true;result+=' ';continue;}
      result+=char;
    }
    if(quote)fail('release-source-shell-quote');
    return result;
  }
  function maskStructures(value){
    const chars=value.split('');
    for(const match of value.matchAll(
      /\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*\((?!\()/g)){
      let depth=1,index=match.index+match[0].length;
      for(;index<value.length&&depth>0;index++){
        if(value[index]==='(')depth++;
        else if(value[index]===')')depth--;
      }
      if(depth!==0)fail('release-source-shell-array');
      for(let cursor=match.index;cursor<index;cursor++)
        if(chars[cursor]!=='\n'&&chars[cursor]!=='\r')chars[cursor]=' ';
    }
    let caseDepth=0,offset=0;
    for(const line of chars.join('').split(/(?<=\n)/)){
      if(/^\s*case\b.*\bin\s*(?:\r?\n)?$/.test(line))caseDepth++;
      else if(caseDepth>0&&/^\s*esac\b/.test(line))caseDepth--;
      else if(caseDepth>0){
        const label=line.match(/^\s*[^#\r\n]*?\)\s*/);
        if(label)for(let cursor=offset;cursor<offset+label[0].length;cursor++)
          if(chars[cursor]!=='\n'&&chars[cursor]!=='\r')chars[cursor]=' ';
      }
      offset+=line.length;
    }
    return chars.join('')
      .replace(/\$\{[^}\n]*\}/g,(row)=>' '.repeat(row.length))
      .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*/g,(row)=>' '.repeat(row.length))
      .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g,(row)=>' '.repeat(row.length))
      .replace(/\[\[[\s\S]*?\]\]/g,(row)=>row.replace(/[^\r\n]/g,' '))
      .replace(/(^|[\s;|&({])\[(?=\s)[^\]\n]*\]/g,(row)=>
        row.replace(/[^\r\n]/g,' '))
      .replace(/\(\([^)\n]*\)\)/g,(row)=>row.replace(/[^\r\n]/g,' '));
  }
  return[maskStructures(maskQuotes(working)),...segments.flatMap((segment)=>
    shellCommandSegments(segment))];
}
function shellDeclaredFunctions(source){
  return[...new Set([...source.matchAll(
    /(?:^|\n)\s*(?:(?:function\s+)([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?|([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\))\s*\{/g)]
    .map((match)=>match[1]||match[2]))].sort(byteCompare);
}
function shellCommandWords(source){
  const functions=new Set(shellDeclaredFunctions(source)),required=new Set();
  for(const segment of shellCommandSegments(source)){
    for(let clause of segment.split(/(?:&&|\|\||[;|{}\n])/)){
      clause=clause.trim();
      for(;;){
        const control=clause.match(
          /^(?:!|if|then|elif|else|while|until|do)\b\s*/);
        if(!control)break;clause=clause.slice(control[0].length).trim();
      }
      for(;;){
        const assignment=clause.match(
          /^[A-Za-z_][A-Za-z0-9_]*\+?=(?:[^\s]+)?\s*/);
        if(!assignment)break;clause=clause.slice(assignment[0].length).trim();
      }
      const match=clause.match(/^([A-Za-z][A-Za-z0-9._-]*)\b/);
      if(!match)continue;
      const name=match[1];
      if(!SHELL_BUILTINS.has(name)&&!functions.has(name))required.add(name);
    }
  }
  return[...required].sort(byteCompare);
}
function scanShellEntrypoint(sourcePath,bytes,files){
  const source=bytes.toString('utf8');
  if(!Buffer.from(source).equals(bytes))fail('release-source-utf8');
  if(!/^#!\/usr\/bin\/env bash\r?$/m.test(source)&&
      !/^#!\/bin\/(?:ba)?sh\r?$/m.test(source))
    fail('release-source-shell',sourcePath);
  const required=new Set(),shellDependencies=new Set(),
    nodeDependencies=new Set();
  for(const name of shellCommandWords(source))required.add(name);
  for(const match of source.matchAll(
    /\bif\s+command\s+-v\s+([A-Za-z][A-Za-z0-9._-]*)\b/g))
    required.delete(match[1]);
  for(const match of source.matchAll(
    /(?:source|\.|bash|sh|node)\s+["']?[^ \t\r\n"']*?([A-Za-z0-9_.-]+\.(?:sh|js))(?![A-Za-z0-9_.-])/g)){
    const literal=match[1],extension=literal.endsWith('.sh')?'.sh':'.js',
      selected=resolveCommittedLiteral(sourcePath,literal,files,extension);
    if(!selected)continue;
    if(extension==='.sh')shellDependencies.add(selected);
    else nodeDependencies.add(selected);
  }
  return{required_tools:[...required].sort(byteCompare),
    shell_dependencies:[...shellDependencies].sort(byteCompare),
    node_dependencies:[...nodeDependencies].sort(byteCompare),
    declared_functions:shellDeclaredFunctions(source)};
}
function relativeDependencies(sourcePath,bytes,files){
  const source=bytes.toString('utf8');let tokens;
  try{tokens=jsTokens(source);}catch(error){
    if(error.code==='release-source-js')
      fail('release-source-js',`${sourcePath}:${error.message}`);throw error;}
  const dependencies=new Set(),directory=path.posix.dirname(sourcePath);
  function add(specifier){
    if(!specifier.startsWith('.'))return;
    const base=path.posix.normalize(path.posix.join(directory,specifier));
    if(!portable(base))fail('release-source-dependency');
    const candidates=path.posix.extname(base)?[base]:
      [`${base}.js`,`${base}.cjs`,`${base}.mjs`,
        path.posix.join(base,'index.js')];
    const selected=candidates.find((candidate)=>files.has(candidate));
    if(!selected)fail('release-source-dependency',
      `${sourcePath}:${specifier}`);
    if(/\.(?:cjs|mjs|js)$/.test(selected))dependencies.add(selected);
  }
  for(let index=0;index<tokens.length-3;index++){
    const first=tokens[index];
    if(first.type!=='identifier'||first.value!=='require')continue;
    if(tokens[index+1].value==='('&&tokens[index+2].type==='string'){
      add(tokens[index+2].value);continue;
    }
    if(tokens[index+1].value==='.'&&tokens[index+2].value==='resolve'&&
        tokens[index+3]?.value==='('&&tokens[index+4]?.type==='string')
      add(tokens[index+4].value);
  }
  return[...dependencies].sort(byteCompare);
}
function fixtureStringArgument(raw,localVersion){
  const value=raw.trim(),quote=value[0];
  if(!["'",'"','`'].includes(quote)||value.at(-1)!==quote)
    fail('test-fixture-factory-argument');
  let body=value.slice(1,-1);
  if(quote==='`'){
    body=body.replace(/\$\{LOCAL_VERSION\}/g,localVersion);
    if(body.includes('${')||body.includes('`')||body.includes('\\'))
      fail('test-fixture-factory-argument');
    return body;
  }
  if(body.includes('\\')||body.includes(quote))
    fail('test-fixture-factory-argument');
  return body;
}
function updateCheckFixtureExecutables(sourcePath,bytes,document){
  if(sourcePath!=='hooks/scripts/update-check.test.js')
    return{rows:[],shadowed_tools:[]};
  const source=bytes.toString('utf8'),version=document.value.version;
  if(!Buffer.from(source).equals(bytes)||typeof version!=='string'||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
        .test(version)||
      !/function\s+run\(\s*curlBody\s*\)\s*\{/.test(source)||
      !/fs\.writeFileSync\(\s*path\.join\(\s*bin\s*,\s*['"]curl['"]\s*\)\s*,\s*`#!\/bin\/sh\\n\$\{curlBody\}\\n`\s*\)/.test(source)||
      !/fs\.chmodSync\(\s*path\.join\(\s*bin\s*,\s*['"]curl['"]\s*\)\s*,\s*0o755\s*\)/.test(source)||
      !/spawnSync\(\s*['"]bash['"]\s*,\s*\[\s*SCRIPT\s*\]/.test(source)||
      !/PATH\s*:\s*`\$\{bin\}:\$\{process\.env\.PATH\}`/.test(source)||
      !/bin\s*=\s*fs\.mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)\s*,\s*['"]uc-bin-['"]\s*\)\s*\)/.test(source))
    fail('test-fixture-factory');
  const argumentsFound=[...source.matchAll(
    /\bconst\s+r\s*=\s*run\(\s*((?:'[^'\r\n]*'|"[^"\r\n]*"|`[^`\r\n]*`))\s*\)\s*;/g)]
    .map((match)=>fixtureStringArgument(match[1],version));
  if(argumentsFound.length===0||
      new Set(argumentsFound).size!==argumentsFound.length)
    fail('test-fixture-factory');
  const factorySha256=toolchain.sha256(bytes),childPathSha256=
    toolchain.sha256(Buffer.concat([
      Buffer.from('test-fixture-child-path-v1\0'),
      Buffer.from(toolchain.canonical({platform:'posix',
        expression:'${owned_temp_bin}:${authenticated_release_owned_bin}'})),
    ]));
  const rows=argumentsFound.map((argument)=>{
    const fixture=Buffer.from(`#!/bin/sh\n${argument}\n`);
    return toolchain.validateTestFixtureExecutable({
      factory_source_path:sourcePath,
      factory_source_sha256:factorySha256,
      factory_args:[argument],
      fixture_relpath:'curl',
      fixture_sha256:toolchain.sha256(fixture),
      platform:'posix',
      invocation_kind:'child-path-owned-temp-first',
      child_path_sha256:childPathSha256,
    });
  }).sort((left,right)=>byteCompare(toolchain.canonical(left),
    toolchain.canonical(right)));
  return{rows,shadowed_tools:['curl']};
}
function scanReleaseSources({committedFiles}={}){
  const files=fileMap(committedFiles),document=packageDocument(files),
    scanned=scanPackageScripts(files,document),rows=[
      toolchain.commandRootRow('npm-pack-dry-run-json',
        require('./release-gate-runtime.js').RELEASE_GATE_CATALOG.pack.argv,
      [{kind:'package-document',path:'package.json#document'}]),
      {path:'package.json#document',kind:'package-document',
        sha256:toolchain.sha256(document.bytes),outgoing:[]},
      ...scanned.rows.values(),
    ],required=new Set(['node','npm']),optional=new Set(),
    nodeRequired=new Set(['node','npm']),
    platform=[],fixtures=[];
  const nodeRows=new Map(),shellRows=new Map(),visiting=new Set(),
    shellRequired=new Map(),shellFunctions=new Set(),
    shadowedShellTools=new Set();
  function visitShell(target){
    if(shellRows.has(target))return;
    if(visiting.has(target))return;
    visiting.add(target);const bytes=files.get(target);
    if(!bytes)fail('release-source-dependency');
    const shell=scanShellEntrypoint(target,bytes,files);
    for(const name of shell.required_tools){
      if(!shellRequired.has(name))shellRequired.set(name,new Set());
      shellRequired.get(name).add(target);
    }
    for(const name of shell.declared_functions)shellFunctions.add(name);
    for(const dependency of shell.shell_dependencies)visitShell(dependency);
    for(const dependency of shell.node_dependencies)visitNode(dependency);
    const outgoing=[
      ...shell.shell_dependencies.map((dependency)=>({
        kind:'shell-entry',path:dependency})),
      ...shell.node_dependencies.map((dependency)=>({
        kind:'node-entry',path:dependency})),
    ].sort(compareGraphIdentity);
    shellRows.set(target,{path:target,kind:'shell-entry',
      sha256:toolchain.sha256(bytes),outgoing});
    visiting.delete(target);
  }
  function visitNode(target){
    if(nodeRows.has(target))return;
    if(visiting.has(target))return;
    visiting.add(target);const bytes=files.get(target);
    if(!bytes)fail('release-source-dependency');
    const dependencies=relativeDependencies(target,bytes,files);
    for(const dependency of dependencies)visitNode(dependency);
    const launch=scanLaunchSites(target,bytes);
    const fixture=updateCheckFixtureExecutables(target,bytes,document),
      shellEntrypoints=nodeShellEntrypoints(target,bytes,files,
        launch.required_tools);
    fixtures.push(...fixture.rows);
    for(const entrypoint of shellEntrypoints){
      for(const name of fixture.shadowed_tools)
        shadowedShellTools.add(`${entrypoint}\0${name}`);
      visitShell(entrypoint);
    }
    const outgoing=[
      ...dependencies.map((dependency)=>({
        kind:'node-entry',path:dependency})),
      ...shellEntrypoints.map((entrypoint)=>({
        kind:'shell-entry',path:entrypoint})),
    ].sort(compareGraphIdentity);
    nodeRows.set(target,{path:target,kind:'node-entry',
      sha256:toolchain.sha256(bytes),outgoing});
    for(const name of launch.required_tools){
      required.add(name);nodeRequired.add(name);
    }
    for(const name of launch.optional_tools)optional.add(name);
    platform.push(...launch.platform_executables);
    visiting.delete(target);
  }
  for(const target of [...scanned.nodeTargets].sort(byteCompare))
    visitNode(target);
  for(const [name,sources] of shellRequired)
    if(!shellFunctions.has(name)&&
        (nodeRequired.has(name)||[...sources].some((source)=>
          !shadowedShellTools.has(`${source}\0${name}`))))required.add(name);
  rows.push(...nodeRows.values(),...shellRows.values());
  platform.sort((a,b)=>byteCompare(toolchain.canonical(a),
    toolchain.canonical(b)));
  return{graph:toolchain.buildReleaseSourceGraph({rows:rows.sort(
    toolchain.compareGraphRows),platformExecutables:platform,
  testFixtureExecutables:fixtures.sort((left,right)=>byteCompare(
    toolchain.canonical(left),toolchain.canonical(right)))}),
  required_tools:[...required].sort(byteCompare),
  optional_tools:[...optional].filter((name)=>!required.has(name))
    .sort(byteCompare)};
}
function gitRead(gitIdentity,args,{cwd,maxBuffer=32*1024*1024}={}){
  const identity=toolchain.validateToolIdentity(gitIdentity);
  if(identity.name!=='git'||identity.shim_kind!=='none')
    fail('release-source-git');
  const result=childProcess.spawnSync(identity.target_path,args,{cwd,
    env:{LANG:'C',LC_ALL:'C',TZ:'UTC'},encoding:null,shell:false,
    windowsHide:true,maxBuffer});
  toolchain.validateToolIdentity(identity);
  if(result.error||result.status!==0||result.signal!==null)
    fail('release-source-git');
  return Buffer.from(result.stdout);
}
function loadCommittedFiles({root,gitIdentity,
  requireWorktreeMatch=true}={}){
  let physical,stat;try{physical=fs.realpathSync(root);
    stat=fs.lstatSync(physical);}catch{fail('release-source-root');}
  if(!stat.isDirectory()||stat.isSymbolicLink()||
      typeof requireWorktreeMatch!=='boolean')fail('release-source-root');
  const listed=gitRead(gitIdentity,['-C',physical,'ls-files','-z'],{
    cwd:physical}),names=listed.subarray(0,listed.length-
      (listed.at(-1)===0?1:0)).toString('utf8').split('\0');
  if(names.length===0||names.some((name)=>!portable(name))||
      canonicalNames(names)!==canonicalNames([...names].sort(byteCompare)))
    fail('release-source-index');
  const files={};
  for(const name of names){
    const bytes=gitRead(gitIdentity,['-C',physical,'show',`HEAD:${name}`],
      {cwd:physical}),candidate=path.join(physical,...name.split('/'));
    if(requireWorktreeMatch){
      let current,currentStat;try{currentStat=fs.lstatSync(candidate);
        current=fs.readFileSync(candidate);}catch{fail('release-source-drift');}
      if(!currentStat.isFile()||currentStat.isSymbolicLink()||
          !current.equals(bytes))fail('release-source-drift');
    }
    files[name]=bytes;
  }
  return files;
}
function canonicalNames(values){return JSON.stringify(values);}

module.exports={shellWords,globRegex,jsTokens,scanLaunchSites,
  resolveCommittedLiteral,nodeShellEntrypoints,scanShellEntrypoint,
  shellCommandSegments,shellCommandWords,shellDeclaredFunctions,
  relativeDependencies,updateCheckFixtureExecutables,
  scanReleaseSources,loadCommittedFiles};
