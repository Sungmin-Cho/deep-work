'use strict';

const TIERS = Object.freeze(['light', 'standard', 'deep']);
const MAIN = 'main';
const CATALOG_VERSION = 3;
const EXPLICIT_MODELS=Object.freeze({codex:Object.freeze(['gpt-6-astra'])});
// codex 슬롯은 로컬 catalog(~/.codex/models_cache.json, fetched_at 2026-10-14T05:00Z, client_version 0.162.1)에 따라 pin됨.
// 규칙: visibility:"list"(비-hidden/비-deprecated) 모델 중 "각 라인(luna/terra/sol)의 최신 세대"를 tier에 매핑한다.
//   gpt-6-luna    (priority 4, "Fast and affordable model for easier tasks.")        → light
//   gpt-6.1-sol   (priority 1, "Latest workhorse model for coding and everyday work.") → standard + deep
// terra는 6세대 후속이 없다(2026-09-25 live probe: gpt-6-terra는 ChatGPT 계정이 거부). Codex 자체가 gpt-5.6-terra를
// "Older balanced model"로 표기하고, 가격도 2.00/12.00 per MTok(입력/출력)으로 gpt-6.1-sol의 2.00/10.00보다 싸지 않으며,
// "everyday work" 설명은 6.1 Sol로 넘어갔다 → standard도 6.1 Sol로 옮긴다.
// 그 결과 codex의 standard와 deep은 같은 모델이므로 두 tier 사이의 이동은 Codex 모델을 바꾸지 않는다. effort는 tier가 아니라
// risk profile과 role(EFFORT_CATALOG)로 정해진다.
// gpt-6-astra는 EXPLICIT_MODELS에만 두어 명시 pin으로만 쓰인다. gpt-5.6-* 와 gpt-6-sol id는 기존 receipt/pin이 계속
// 해석되도록 model-capabilities.js에서 계속 인식한다(기본값이 아닐 뿐).
// 가격 자체는 routing formula에 넣지 않는다. stakes/error cost는 기존 methodology risk floor가 담당한다.
const DEFAULT_CATALOG = Object.freeze({
  claude: Object.freeze({ light: 'haiku', standard: 'sonnet', deep: 'opus', main: MAIN }),
  codex: Object.freeze({ light: 'gpt-6-luna', standard: 'gpt-6.1-sol', deep: 'gpt-6.1-sol', main: MAIN }),
});

// Overrides are shared with the public CLI --catalog-override input.
function mergeCatalog(override) {
  const merged = {};
  for (const runtime of Object.keys(DEFAULT_CATALOG)) {
    merged[runtime] = { ...DEFAULT_CATALOG[runtime] };
    const layer = override && typeof override === 'object' ? override[runtime] : null;
    if (!layer || typeof layer !== 'object') continue;
    for (const tier of [...TIERS, MAIN]) {
      if (typeof layer[tier] === 'string' && layer[tier]) merged[runtime][tier] = layer[tier];
    }
  }
  return merged;
}

function resolveTier(tier, runtime, catalog = DEFAULT_CATALOG) {
  if (tier === MAIN) return { model: MAIN, warning: null };
  if (!TIERS.includes(tier)) {
    return { model: MAIN, warning: `'${tier}'은(는) 유효한 tier가 아님 — main(세션 모델) fallback` };
  }
  const layer = catalog && catalog[runtime];
  if (!layer) return { model: MAIN, warning: `런타임 '${runtime}' 카탈로그 없음(unknown 포함) — main fallback` };
  const model = layer[tier];
  if (typeof model !== 'string' || !model) {
    return { model: MAIN, warning: `${runtime} 카탈로그의 '${tier}' 미지정(pin 전) — main fallback` };
  }
  return { model, warning: null };
}

function concreteModelsFor(runtime, catalog = DEFAULT_CATALOG) {
  const layer = catalog[runtime] || {};
  return [...new Set([...TIERS.map((t) => layer[t]),...(EXPLICIT_MODELS[runtime]||[])])].filter((v) => typeof v === 'string' && v && v !== MAIN);
}

function allConcreteModels(catalog = DEFAULT_CATALOG) {
  return Object.keys(catalog).flatMap((r) => concreteModelsFor(r, catalog));
}

// 카탈로그가 비단사(standard/deep이 같은 모델)일 수 있으므로, 모델은 pin된 tier 중 가장 높은 tier를 맡는다.
function tierForModel(model, runtime, catalog = DEFAULT_CATALOG) {
  if (typeof model !== 'string' || !model || model === MAIN) return null;
  const layer = catalog && catalog[runtime];
  if (!layer) return null;
  return [...TIERS].reverse().find((tier) => layer[tier] === model) || null;
}

module.exports = { TIERS, MAIN, CATALOG_VERSION, DEFAULT_CATALOG, mergeCatalog, resolveTier,
  concreteModelsFor, allConcreteModels, tierForModel };
