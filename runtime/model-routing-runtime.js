'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TIERS, MAIN, resolveTier, mergeCatalog, concreteModelsFor, CATALOG_VERSION } = require('./model-catalog.js');
const {resolveModelCapability}=require('./model-capabilities.js');
const { PROFILE_BY_CLASS, EFFORT_CATALOG, TIER_CATALOG,
  validateMethodologyAuthority } = require('./policy-runtime.js');

const SCALE_SMALL_MAX = 200;
const SCALE_MEDIUM_MAX = 2000;
const FS_WALK_CAP = 5000;
const LOC_SAMPLE_CAP = 200;
const LOC_FILE_BYTE_CAP = 1024 * 1024;
const SOURCE_EXTS = Object.freeze(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.ps1']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.claude', '.deep-work', '.deep-loop']);
const ERRORS_CAP = 20;
const TRUNCATED_MARKER = '…(truncated)';

// errors 배열에 최대 ERRORS_CAP개까지만 기록. 초과분은 버리고 마지막에 truncated 마커를 1회만 남긴다
// (무한 증가 방지 — 리뷰 Important-3).
function pushError(errors, msg) {
  if (errors.length && errors[errors.length - 1] === TRUNCATED_MARKER) return;
  if (errors.length >= ERRORS_CAP - 1) { errors.push(TRUNCATED_MARKER); return; }
  errors.push(msg);
}

function defaultGitLsFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', timeout: 3000 });
    return out.split('\n').filter(Boolean);
  } catch { return null; }
}

function walkFiles(root, cap, errors = []) {
  const out = []; const stack = [root];
  while (stack.length && out.length < cap) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { pushError(errors, `walk-dir: ${dir}: ${e.message}`); continue; }
    for (const e of entries) {
      if (out.length >= cap) break;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(path.join(dir, e.name)); }
      else if (e.isFile()) out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function collectCodebaseSignals(root, deps = {}) {
  const gitLsFiles = deps.gitLsFiles || defaultGitLsFiles;
  const errors = [];
  let files = null;
  let tracked = null;
  try {
    tracked = gitLsFiles(root);
  } catch (e) { pushError(errors, `gitLsFiles: ${e.message}`); }
  if (Array.isArray(tracked)) files = tracked.map((f) => path.join(root, f));
  else {
    try {
      if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
      files = walkFiles(root, FS_WALK_CAP, errors);
    } catch (e) { pushError(errors, `walk: ${e.message}`); }
  }
  if (files === null) {
    return { tracked_files: null, loc_estimate: null, languages: null, has_tests: null, deps_count: null, errors };
  }
  const sourceFiles = files.filter((f) => SOURCE_EXTS.includes(path.extname(f).toLowerCase()));
  const exts = new Set(sourceFiles.map((f) => path.extname(f).toLowerCase()));
  const sample = sourceFiles.slice(0, LOC_SAMPLE_CAP);
  let sampleLoc = 0; let sampled = 0;
  for (const f of sample) {
    try {
      const st = fs.statSync(f);
      if (st.size > LOC_FILE_BYTE_CAP) continue;
      sampleLoc += fs.readFileSync(f, 'utf8').split('\n').length; sampled += 1;
    } catch (e) { pushError(errors, `loc-sample: ${path.basename(f)}: ${e.message}`); }
  }
  const locEstimate = sampled > 0 ? Math.round((sampleLoc / sampled) * sourceFiles.length) : null;
  const hasTests = files.some((f) => {
    const rel = path.relative(root, f);
    return /(^|[\\/])(tests?|__tests__|spec)([\\/])/.test(rel) || /\.(test|spec)\.[a-z]+$/.test(rel);
  });
  let depsCount = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    depsCount = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
  } catch { /* 매니페스트 없음 — null 유지 */ }
  return { tracked_files: files.length, loc_estimate: locEstimate, languages: exts.size,
    has_tests: hasTests, deps_count: depsCount, errors };
}

function classifyRepoScale(signals = {}) {
  const n = signals.tracked_files;
  if (typeof n !== 'number') return 'medium'; // null/부재 → medium 수렴 (리뷰 Low-7: LOC은 보조 신호)
  if (n < SCALE_SMALL_MAX) return 'small';
  if (n < SCALE_MEDIUM_MAX) return 'medium';
  return 'large';
}

const PHASES = Object.freeze(['brainstorm', 'research', 'plan', 'implement', 'test']);
const DIFFICULTY = Object.freeze(['low', 'medium', 'high']);
const NARROW_TASK_RE = /\b(fix|typo|oneline|one-line)\b|한\s*줄|오타/i;

function tierIndex(tier) { return TIERS.indexOf(tier); }
function shiftTier(tier, offset) {
  const i = tierIndex(tier);
  if (i < 0) return tier; // main 등 비-tier는 불변
  return TIERS[Math.min(TIERS.length - 1, Math.max(0, i + offset))];
}

function baselineTiers(signals = {}, taskText = '') {
  const scale = classifyRepoScale(signals);
  const reasons = [`규모 ${scale} (tracked_files=${signals.tracked_files ?? 'null'})`];
  const tiers = { brainstorm: MAIN, research: 'standard', plan: MAIN, implement: 'standard', test: 'light' };
  if (scale === 'small') tiers.research = 'light';
  if (scale === 'large') { tiers.implement = 'deep'; tiers.test = 'standard'; }
  if (scale === 'large' && (signals.languages ?? 0) >= 4) {
    tiers.research = 'deep'; reasons.push(`다언어(${signals.languages}) → research deep`);
  }
  if (scale === 'small' && NARROW_TASK_RE.test(String(taskText))) {
    tiers.implement = 'light'; reasons.push('좁은 task 키워드 → implement light');
  }
  return { tiers, scale, reasons };
}

function applyDifficulty(tiers, difficulty) {
  if (difficulty !== 'high' && difficulty !== 'low') return { ...tiers };
  const offset = difficulty === 'high' ? 1 : -1;
  const out = { ...tiers };
  for (const phase of ['research', 'implement', 'test']) out[phase] = shiftTier(out[phase], offset);
  return out;
}

function sizeToTier(size) {
  if (size === 'S') return 'light';
  if (size === 'M' || size === 'L') return 'standard';
  if (size === 'XL') return 'deep';
  return null;
}

function sliceModelTier(sessionImplementTier, size) {
  // 세션 tier가 tier 어휘가 아니면(main/error 등) per-slice 재도출을 하지 않고 그대로 반환 —
  // 'main'(세션 모델 inline)이 tierIndex=-1로 인해 light로 붕괴하는 것을 차단 (final review #1)
  if (tierIndex(sessionImplementTier) < 0) return sessionImplementTier;
  const base = sizeToTier(size);
  if (base === null) return sessionImplementTier;
  const offset = tierIndex(sessionImplementTier) - tierIndex('standard');
  return shiftTier(base, offset);
}

function maxTier(current, floor) {
  if (tierIndex(current) < 0 || tierIndex(floor) < 0) return current;
  return tierIndex(current) >= tierIndex(floor) ? current : floor;
}

function sliceModelTierWithRisk(sessionImplementTier, size, sliceRiskClass) {
  const tier = sliceModelTier(sessionImplementTier, size);
  const profile = PROFILE_BY_CLASS[sliceRiskClass];
  if (!profile) return tier;
  return maxTier(tier, TIER_CATALOG[profile].implement);
}

function decideModelRouting({ signals = {}, taskText = '', difficulty = null, runtime = 'unknown',
  catalogOverride = null, pinned = {}, riskClass = null, policyMode = 'adaptive', floorBaseline = null,
  methodologyPolicy=null,now = null } = {}) {
  const warnings = [];
  const authority=methodologyPolicy===null?null:
    validateMethodologyAuthority(methodologyPolicy);
  if(authority&&riskClass!==null&&riskClass!==authority.risk_class)
    warnings.push(`legacy riskClass '${riskClass}' ignored; methodology policy authority is '${authority.risk_class}'`);
  if(authority&&floorBaseline!==null)
    warnings.push('legacy floorBaseline ignored; methodology policy authority supplies floors');
  const authoritativeRisk=authority?.risk_class??riskClass;
  const authoritativeMode=authority?.mode??policyMode;
  const authoritativeFloors=authority?.floors_effective??floorBaseline;
  const catalog = mergeCatalog(catalogOverride);
  const base = baselineTiers(signals, taskText);
  const tiers = applyDifficulty(base.tiers, DIFFICULTY.includes(difficulty) ? difficulty : null);
  const beforeFloors = { ...tiers };
  const validRiskClass = Object.hasOwn(PROFILE_BY_CLASS, authoritativeRisk) ? authoritativeRisk : null;
  const validFloorBaseline = {};
  if (authoritativeFloors && typeof authoritativeFloors === 'object' && !Array.isArray(authoritativeFloors)) {
    for (const phase of ['research', 'implement', 'test']) {
      if (TIERS.includes(authoritativeFloors[phase])) validFloorBaseline[phase] = authoritativeFloors[phase];
    }
  }
  const hasPolicyInput = validRiskClass !== null || Object.keys(validFloorBaseline).length > 0;
  const effectiveFloors = {};
  if (authoritativeMode !== 'shadow') {
    if (validRiskClass !== null) {
      const policyTiers = TIER_CATALOG[PROFILE_BY_CLASS[validRiskClass]];
      for (const phase of ['research', 'implement', 'test']) {
        tiers[phase] = maxTier(tiers[phase], policyTiers[phase]);
        effectiveFloors[phase] = policyTiers[phase];
      }
    }
    for (const phase of ['research', 'implement', 'test']) {
      if (!validFloorBaseline[phase]) continue;
      tiers[phase] = maxTier(tiers[phase], validFloorBaseline[phase]);
      effectiveFloors[phase] = effectiveFloors[phase]
        ? maxTier(effectiveFloors[phase], validFloorBaseline[phase]) : validFloorBaseline[phase];
    }
  }
  const floorsApplied = {};
  for (const phase of ['research', 'implement', 'test']) {
    if (tiers[phase] !== beforeFloors[phase]) floorsApplied[phase] = { from: beforeFloors[phase], to: tiers[phase] };
  }
  const appliedPinned = {};
  const floorOverriddenByPin = {};
  const routing = {};
  const modelIdentity = {};
  const runtimeConcrete = new Set(concreteModelsFor(runtime, catalog));
  for (const phase of PHASES) {
    const pin = pinned && typeof pinned === 'object' ? pinned[phase] : undefined;
    if (pin !== undefined) {
      if(resolveModelCapability({runtime,model:pin,catalogOverride}).status==='foreign')throw new Error(`foreign-model: ${pin} on ${runtime}`);
      if (phase === 'brainstorm' || phase === 'plan') {
        warnings.push(`--model-routing: '${phase}'은 main 고정 — '${pin}' 무시`);
      } else if (TIERS.includes(pin) || pin === MAIN) {
        tiers[phase] = pin; appliedPinned[phase] = pin;
      } else if (runtimeConcrete.has(pin)) {
        routing[phase] = pin; appliedPinned[phase] = pin;
      } else {
        const capability=resolveModelCapability({runtime,model:pin,catalogOverride});
        if(capability.status==='foreign')throw new Error(`foreign-model: ${pin} on ${runtime}`);
        if(typeof pin!=='string'||! /^[A-Za-z0-9._-]+$/.test(pin))throw new Error('invalid-model');
        routing[phase]=pin;appliedPinned[phase]=pin;
        if(capability.status==='unverified')warnings.push(`model '${pin}' unverified; explicit pin preserved`);
      }
      let pinTier = TIERS.includes(pin) ? pin : null;
      // model_identity.nominal_tier와 같은 출처로 floor와 비교한다: capability 표의 tier가 우선이고,
      // 표에 없는 커스텀 모델만 카탈로그 위치(가장 높은 tier)를 쓴다. 기본값에서 빠진 gpt-5.6-* pin도 여기서 비교된다.
      if (!pinTier && pin !== MAIN) {
        pinTier = resolveModelCapability({ runtime, model: pin, catalogOverride }).nominal_tier || null;
      }
      if (effectiveFloors[phase] && pinTier && tierIndex(pinTier) < tierIndex(effectiveFloors[phase])) {
        floorOverriddenByPin[phase] = true;
      }
    }
    if (routing[phase] === undefined) {
      const { model, warning } = resolveTier(tiers[phase], runtime, catalog);
      routing[phase] = model;
      if (warning) warnings.push(warning);
    }
  }
  for(const phase of PHASES){const capability=resolveModelCapability({runtime,model:routing[phase],catalogOverride});
    modelIdentity[phase]={requested_model:appliedPinned[phase]||null,effective_model:routing[phase],observed_model:null,status:capability.status,nominal_tier:capability.nominal_tier};}
  if(authority){tiers.spec=MAIN;routing.spec=MAIN;}
  const meta = { model_identity:modelIdentity, tiers, scale: base.scale, signals_summary: { tracked_files: signals.tracked_files ?? null,
      loc_estimate: signals.loc_estimate ?? null, languages: signals.languages ?? null },
    difficulty: DIFFICULTY.includes(difficulty) ? difficulty : null, reasons: base.reasons,
    runtime, catalog_version: CATALOG_VERSION, pinned: appliedPinned,
    decided_at: now === null ? new Date().toISOString() : (now instanceof Date ? now.toISOString() : new Date(now).toISOString()) };
  if(authority){meta.authority=authority.authority;meta.compatibility_mode='policy-facade';
    meta.methodology_policy_sha256=authority.policy_sha256;}
  if (hasPolicyInput) {
    const effectiveRiskClass = validRiskClass || 'medium';
    const profile = PROFILE_BY_CLASS[effectiveRiskClass];
    meta.policy = { risk_class: validRiskClass, profile, mode: authoritativeMode === 'shadow' ? 'shadow' : 'adaptive',
      floors_applied: floorsApplied, floors_effective: effectiveFloors,
      floor_overridden_by_pin: floorOverriddenByPin };
    meta.efforts = {
      research: { role: 'author', effort: EFFORT_CATALOG[profile].author },
      implement: { role: 'implementer', effort: EFFORT_CATALOG[profile].implementer },
      test: { role: 'implementer', effort: EFFORT_CATALOG[profile].implementer },
    };
  }
  return {
    model_routing: routing,
    meta,
    warnings: [...new Set(warnings)], // unknown 런타임 등 phase 반복 경고 dedupe (리뷰 Low-5)
  };
}

module.exports = { SCALE_SMALL_MAX, SCALE_MEDIUM_MAX, FS_WALK_CAP, LOC_SAMPLE_CAP, LOC_FILE_BYTE_CAP,
  collectCodebaseSignals, classifyRepoScale,
  PHASES, DIFFICULTY, tierIndex, shiftTier, baselineTiers, applyDifficulty, sizeToTier, sliceModelTier,
  maxTier, sliceModelTierWithRisk,
  decideModelRouting };
