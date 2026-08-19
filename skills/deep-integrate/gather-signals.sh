#!/usr/bin/env bash
# gather-signals.sh — Phase 5 signal envelope 생성
# Usage:
#   gather-signals.sh <project-root> <installed-missing-json> [<integrate-loop.json-path>]
#   gather-signals.sh <project-root> --plugins-file <plugins-json-path> [--loop-file <loop-json-path>]
# 출력(stdout): signal envelope JSON (spec 섹션 3.2 참조)
# v6.3.0 review C1: 3번째 positional 인자로 integrate-loop.json 경로를 받아 envelope에 `loop` 필드 병합.
#                   미지정/미존재 시 기본값 {round:0, max_rounds:5, already_executed:[]}를 emit.
# v6.3.0 review RC5-1 (SKILL 호환): `--plugins-file` / `--loop-file` 옵션으로 경로를 받도록 확장.
#                    SKILL이 `$(cat <file>)` 같은 command substitution 없이 gather-signals 호출 가능 →
#                    phase-guard의 shell-metacharacter 엄격화와 호환.
set -u

if [[ $# -lt 2 ]]; then
  echo '{"error":"missing arguments: project-root, plugins-json"}'
  exit 1
fi

PROJECT_ROOT="$1"; shift
PLUGINS_JSON=""
LOOP_STATE_PATH=""

# 옵션 기반 vs positional: 첫 인자가 `--plugins-file`이면 옵션 파싱, 아니면 legacy positional.
if [[ "${1:-}" == --plugins-file ]]; then
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plugins-file)
        if [[ $# -lt 2 || -z "${2:-}" ]]; then
          echo '{"error":"--plugins-file requires non-empty value"}'; exit 1
        fi
        if [[ ! -f "$2" ]]; then
          echo '{"error":"--plugins-file path not found: '"$2"'"}'; exit 1
        fi
        PLUGINS_JSON="$(cat "$2")"
        shift 2
        ;;
      --loop-file)
        if [[ $# -lt 2 ]]; then
          echo '{"error":"--loop-file requires value"}'; exit 1
        fi
        LOOP_STATE_PATH="$2"
        shift 2
        ;;
      *) shift ;;
    esac
  done
else
  # legacy positional: plugins-json-string [loop-path]
  PLUGINS_JSON="$1"
  LOOP_STATE_PATH="${2:-}"
fi

if [[ -z "$PLUGINS_JSON" ]]; then
  echo '{"error":"plugins-json not provided"}'; exit 1
fi

# C6 fix: 나중에 deep-work artifacts 섹션에서 참조될 수 있으므로 빈 문자열로 초기화
WORK_DIR_SLUG=""
SESSION_ID=""

warn() { printf '[deep-integrate/warn] %s\n' "$*" >&2; }

# 공용 유틸리티 (read_frontmatter_field)
UTILS_PATH="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/../../hooks/scripts/utils.sh"
if [[ -f "$UTILS_PATH" ]]; then
  # shellcheck disable=SC1090
  source "$UTILS_PATH"
else
  warn "utils.sh not found at $UTILS_PATH — inline fallback"
  read_frontmatter_field() {
    local file="$1"; local field="$2"
    awk -v f="$field" '
      /^---[[:space:]]*$/ { inside=!inside; next }
      inside && $0 ~ "^"f":" {
        sub("^"f":[[:space:]]*", "");
        gsub(/^"|"$/, "");
        print; exit
      }
    ' "$file"
  }
fi

# ─── Session resolution ─────────────────────────────────────
SESSION_ID="${DEEP_WORK_SESSION_ID:-}"
if [[ -z "$SESSION_ID" ]]; then
  pointer="$PROJECT_ROOT/.claude/deep-work-current-session"
  if [[ -f "$pointer" ]]; then
    SESSION_ID="$(<"$pointer")"
  fi
fi

if [[ -z "$SESSION_ID" ]]; then
  warn "no active session — session=null"
  SESSION_JSON='null'
else
  STATE_FILE="$PROJECT_ROOT/.claude/deep-work.${SESSION_ID}.md"
  if [[ ! -f "$STATE_FILE" ]]; then
    warn "state file missing: $STATE_FILE"
    SESSION_JSON='null'
  else
    WORK_DIR_SLUG="$(read_frontmatter_field "$STATE_FILE" "work_dir")"
    GOAL="$(read_frontmatter_field "$STATE_FILE" "task_description")"

    # phases_completed: <phase>_completed_at 필드 스캔 (C7 fix: brainstorm 포함)
    phases_completed=()
    for phase in brainstorm research plan implement test; do
      ts="$(read_frontmatter_field "$STATE_FILE" "${phase}_completed_at")"
      if [[ -n "$ts" ]]; then
        phases_completed+=("$phase")
      fi
    done

    # git changes (cwd가 project-root, non-git이면 null)
    pushd "$PROJECT_ROOT" >/dev/null || true
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      # v6.3.0 review RC3-4: 파이프라인은 마지막 명령 exit code만 반환하므로 `|| echo main`이
      # symbolic-ref 실패 시에도 발동하지 않는다. symbolic-ref 결과를 먼저 받고 빈 값이면 "main"으로 fallback.
      _orig_head="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
      if [[ -n "$_orig_head" ]]; then
        base_ref="${_orig_head#origin/}"
      else
        base_ref="main"
      fi
      # v6.3.0 review W-R1: "base ref 부재(unknown)"와 "on-base zero-diff"를 구분.
      # base_ref가 resolve되면 merge-base가 HEAD여도 legitimate zero-diff (0 값 emit),
      # resolve 실패면 비교 대상 부재 (null emit). 이전 수정은 두 경우를 null로 통합하여
      # LLM 프롬프트의 `files_changed == 0` 분기를 억제하는 회귀를 유발.
      if ! git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
        warn "base ref '$base_ref' not resolvable — changes=null"
        CHANGES_JSON='null'
      elif [[ "$(git merge-base HEAD "$base_ref" 2>/dev/null || echo HEAD)" == "$(git rev-parse HEAD)" ]]; then
        # HEAD가 base_ref의 조상이거나 동일 → 실제로 0 변경 (on-base session)
        CHANGES_JSON=$(jq -n '{files_changed:0, insertions:0, deletions:0, categories:{src:0, test:0, docs:0, config:0}}')
      else
        base="$(git merge-base HEAD "$base_ref")"
        files_changed="$(git diff --name-only "$base"..HEAD 2>/dev/null | wc -l | tr -d ' ')"
        read -r ins dels <<<"$(git diff --numstat "$base"..HEAD 2>/dev/null | awk '{i+=$1; d+=$2} END {printf "%d %d", i+0, d+0}')"
        cat_src=0; cat_test=0; cat_docs=0; cat_config=0
        while IFS= read -r f; do
          case "$f" in
            *test*|*spec*) ((cat_test++)) ;;
            *.md|docs/*|*README*|*CHANGELOG*) ((cat_docs++)) ;;
            *.json|*.yaml|*.yml|*.toml|*.cfg|*.ini) ((cat_config++)) ;;
            *) ((cat_src++)) ;;
          esac
        done < <(git diff --name-only "$base"..HEAD 2>/dev/null)
        CHANGES_JSON=$(jq -n \
          --argjson fc "$files_changed" --argjson ins "$ins" --argjson dels "$dels" \
          --argjson src "$cat_src" --argjson t "$cat_test" \
          --argjson d "$cat_docs" --argjson c "$cat_config" \
          '{files_changed:$fc, insertions:$ins, deletions:$dels,
            categories:{src:$src, test:$t, docs:$d, config:$c}}')
      fi
    else
      warn "not a git repository — changes=null"
      CHANGES_JSON='null'
    fi
    popd >/dev/null || true

    phases_json="["
    for i in "${!phases_completed[@]}"; do
      [[ $i -gt 0 ]] && phases_json+=","
      phases_json+="\"${phases_completed[$i]}\""
    done
    phases_json+="]"

    SESSION_JSON=$(jq -n \
      --arg id "$SESSION_ID" \
      --arg wd "$WORK_DIR_SLUG" \
      --arg goal "$GOAL" \
      --argjson phases "$phases_json" \
      --argjson changes "$CHANGES_JSON" \
      '{id:$id, work_dir:$wd, goal:$goal, phases_completed:$phases, changes:$changes}')
  fi
fi

# ─── Artifacts collection (defensive, envelope-aware v6.5.0) ───────
# read_json_safe <path> [<expected_producer> [<expected_artifact_kind>]]
#
# Detects M3 envelope wrapping (cf. deep-suite/docs/envelope-migration.md
# §1: schema_version === "1.0" + envelope object + payload key) and returns
# `.payload` instead of the wrapped root. Identity guard: when expected_producer
# / expected_artifact_kind are provided, foreign envelopes resolve to null
# (handoff §4 round-4 lesson — defense-in-depth against another plugin's
# artifact landing at the same cache path).
#
# Legacy (non-envelope) JSON passes through unchanged. Invalid JSON also
# resolves to null with a warn message (preserved behavior).
read_json_safe() {
  local path="$1"
  local expected_producer="${2:-}"
  local expected_kind="${3:-}"
  if [[ ! -s "$path" ]]; then echo "null"; return; fi
  if ! jq -e 'type' "$path" >/dev/null 2>&1; then
    warn "invalid JSON at $path — null fallback"
    echo "null"; return
  fi
  jq --arg ep "$expected_producer" --arg ek "$expected_kind" '
    if (.schema_version == "1.0"
        and ((.envelope|type) == "object")
        and has("payload")) then
      if (($ep == "" or .envelope.producer == $ep)
          and ($ek == "" or .envelope.artifact_kind == $ek)
          and (.envelope.schema.name == .envelope.artifact_kind)
          and ((.payload|type) == "object")) then
        .payload
      else
        null
      end
    else
      .
    end
  ' "$path"
}

# C2 fix 원칙: 설치된 플러그인은 **placeholder object(모든 필드 null)** 반환,
# 미설치 플러그인만 whole-null. test가 nested field 접근해도 TypeError 없도록.

# deep-work (C6 fix: SESSION_ID/WORK_DIR_SLUG 미해석 시 whole-null)
# deep-work 자체는 항상 active하므로 plugins.installed 체크는 불필요 (이전 jq 표현식은
# 항상 true였고 의도 전달만 방해했음 — v6.3.0 review W3)
if [[ -n "$SESSION_ID" && -n "$WORK_DIR_SLUG" ]]; then
  sr="$PROJECT_ROOT/$WORK_DIR_SLUG/session-receipt.json"
  # v6.5.0: deep-work emits its own session-receipt as an M3 envelope. Identity
  # guard ensures we don't accept another plugin's envelope at the same path.
  dw_artifact=$(read_json_safe "$sr" "deep-work" "session-receipt")
  dw_json=$(jq -n --argjson sr "$dw_artifact" --arg p "$PROJECT_ROOT/$WORK_DIR_SLUG/report.md" \
    '{session_receipt:$sr, report_md_path:$p}')
else
  dw_json='null'
fi

# deep-review (C2 fix: 설치된 경우 항상 object 반환)
# v6.5.0 envelope-aware: recurring-findings will be wrapped in M3 envelope when
# deep-review adopts it (Phase 2 priority #5). Identity guard prevents
# foreign envelopes at the same path from leaking into our consumption.
if printf '%s' "$PLUGINS_JSON" | jq -e '.installed[]? | select(.=="deep-review")' >/dev/null 2>&1; then
  rf=$(read_json_safe "$PROJECT_ROOT/.deep-review/recurring-findings.json" "deep-review" "recurring-findings")
  fitness=$(read_json_safe "$PROJECT_ROOT/.deep-review/fitness.json")
  latest_report="$(ls -1t "$PROJECT_ROOT"/.deep-review/reports/*-review.md 2>/dev/null | head -1 || true)"
  latest_json=$(jq -n --arg p "$latest_report" 'if $p == "" then null else $p end')
  if [[ "$rf" != "null" ]]; then
    # I4 fix: total + top_cat in one defensive jq pass (non-array .findings safe)
    # v6.3.0 review W5: top_category는 최빈 category여야 함 (a[0]는 sorted 가정에 의존)
    read -r total top_cat < <(
      printf '%s' "$rf" | jq -r '
        def a: (.findings // []);
        (a | length) as $n |
        (a | map(.category // empty) | group_by(.) | max_by(length) | .[0] // "") as $c |
        "\($n) \($c)"
      ' 2>/dev/null || echo "0 "
    )
    # C2 fix: build rf_sum with jq --arg to handle embedded quotes/backslashes
    if [[ -n "$top_cat" ]]; then
      rf_sum=$(jq -n --argjson t "$total" --arg c "$top_cat" '{total:$t, top_category:$c}')
    else
      rf_sum=$(jq -n --argjson t "$total" '{total:$t}')
    fi
  else
    rf_sum='null'
  fi
  dr_json=$(jq -n --argjson rf "$rf_sum" --argjson fit "$fitness" --argjson lr "$latest_json" \
    '{recurring_findings:$rf, fitness:$fit, latest_report_path:$lr}')
else
  dr_json='null'
fi

# deep-docs (C2 fix)
# v6.5.0 envelope-aware: deep-docs already adopted M3 envelope (Phase 2 #1).
# Identity guard rejects foreign envelopes at .deep-docs/last-scan.json.
if printf '%s' "$PLUGINS_JSON" | jq -e '.installed[]? | select(.=="deep-docs")' >/dev/null 2>&1; then
  ls_path="$PROJECT_ROOT/.deep-docs/last-scan.json"
  ls_raw=$(read_json_safe "$ls_path" "deep-docs" "last-scan")
  if [[ "$ls_raw" != "null" ]]; then
    scanned_at=$(printf '%s' "$ls_raw" | jq -r '.scanned_at // empty')
    issues_summary=$(printf '%s' "$ls_raw" | jq '[.documents[]? | {(.path): (.issues | length)}] | add // {}')
    sa_json=$(jq -n --arg v "$scanned_at" 'if $v == "" then null else $v end')
    dd_json=$(jq -n --argjson sa "$sa_json" --argjson is "$issues_summary" \
      '{last_scanned_at:$sa, issues_summary:$is}')
  else
    # 설치되어 있으나 last-scan.json 미생성 → placeholder object
    dd_json='{"last_scanned_at":null,"issues_summary":null}'
  fi
else
  dd_json='null'
fi

# deep-dashboard (C2, C3 fix: `.name` → `.id`)
# v6.5.0 envelope-aware: deep-dashboard already adopted M3 envelope (Phase 2 #2).
# Identity guard rejects foreign envelopes at .deep-dashboard/harnessability-report.json.
if printf '%s' "$PLUGINS_JSON" | jq -e '.installed[]? | select(.=="deep-dashboard")' >/dev/null 2>&1; then
  h_raw=$(read_json_safe "$PROJECT_ROOT/.deep-dashboard/harnessability-report.json" "deep-dashboard" "harnessability-report")
  if [[ "$h_raw" != "null" ]]; then
    score=$(printf '%s' "$h_raw" | jq '.total // null')
    # C3 fix: scorer.js dimension field는 {id, label, weight, score, checks}이며 `.name`은 없음
    weakest=$(printf '%s' "$h_raw" | jq -r '[.dimensions[]?] | min_by(.score) | .id // empty' 2>/dev/null || echo '')
    weak_json=$(jq -n --arg v "$weakest" 'if $v == "" then null else $v end')
    dh_json=$(jq -n --argjson s "$score" --argjson w "$weak_json" \
      '{harnessability_score:$s, weakest_dimension:$w}')
  else
    dh_json='{"harnessability_score":null,"weakest_dimension":null}'
  fi
else
  dh_json='null'
fi

# deep-evolve (C2 fix)
if printf '%s' "$PLUGINS_JSON" | jq -e '.installed[]? | select(.=="deep-evolve")' >/dev/null 2>&1; then
  # current.json is a small index file maintained by deep-evolve — left as legacy
  # (no envelope expected). evolve-insights.json will move to envelope when
  # deep-evolve adopts M3 (Phase 2 priority #4).
  current_json=$(read_json_safe "$PROJECT_ROOT/.deep-evolve/current.json")
  if [[ "$current_json" != "null" ]]; then
    evolve_sid=$(printf '%s' "$current_json" | jq -r '.session_id // empty')
    if [[ -n "$evolve_sid" ]]; then
      insights_json=$(read_json_safe "$PROJECT_ROOT/.deep-evolve/$evolve_sid/evolve-insights.json" "deep-evolve" "evolve-insights")
      de_json=$(jq -n --argjson i "$insights_json" --arg sid "$evolve_sid" \
        '{session_id:$sid, insights:$i}')
    else
      de_json='{"session_id":null,"insights":null}'
    fi
  else
    de_json='{"session_id":null,"insights":null}'
  fi
else
  de_json='null'
fi

# deep-wiki (C2 fix)
# v6.5.0 envelope-aware: wiki index.json will move to envelope when
# deep-wiki adopts M3 (Phase 2 priority #6). Until then, the legacy
# pass-through branch keeps `pages` at the top level. After adoption, the
# read_json_safe envelope unwrap returns the payload, which keeps `pages` at
# the same top level — so the `.pages | length` jq expression remains correct.
if printf '%s' "$PLUGINS_JSON" | jq -e '.installed[]? | select(.=="deep-wiki")' >/dev/null 2>&1; then
  widx="$PROJECT_ROOT/.wiki-meta/index.json"
  if [[ -f "$widx" ]]; then
    widx_payload=$(read_json_safe "$widx" "deep-wiki" "index")
    if [[ "$widx_payload" == "null" ]]; then
      pages_count=0
    else
      pages_count=$(printf '%s' "$widx_payload" | jq 'try (.pages | length) catch 0' 2>/dev/null || echo 0)
    fi
    dwiki_json=$(jq -n --argjson pc "$pages_count" '{pages_count:$pc}')
  else
    dwiki_json='{"pages_count":null}'
  fi
else
  dwiki_json='null'
fi

# W1 fix: envelope 총 예산 ~20KB 체크 — 초과 시 가장 큰 필드부터 축약
# (우선 recurring-findings를 {total, top_category} 요약으로 교체하는 최소 구현)
# 이 체크는 envelope 조립 후 최종 단계에서 수행하므로 아래 jq -n 뒤로 이동.

# ─── Envelope 조립 ──────────────────────────────────────────
ARTIFACTS=$(jq -n \
  --argjson dw "$dw_json" \
  --argjson dr "$dr_json" \
  --argjson dd "$dd_json" \
  --argjson dh "$dh_json" \
  --argjson de "$de_json" \
  --argjson dwiki "$dwiki_json" \
  '{"deep-work":$dw, "deep-review":$dr, "deep-docs":$dd, "deep-dashboard":$dh, "deep-evolve":$de, "deep-wiki":$dwiki}')

# v6.3.0 review C1: loop 필드 — integrate-loop.json에서 투영하거나 기본값.
# "(skip)" 가상 항목은 플러그인이 아니므로 already_executed에서 제외.
LOOP_JSON='{"round":0,"max_rounds":5,"already_executed":[]}'
if [[ -n "$LOOP_STATE_PATH" && -f "$LOOP_STATE_PATH" ]]; then
  loop_raw=$(read_json_safe "$LOOP_STATE_PATH")
  if [[ "$loop_raw" != "null" ]]; then
    parsed=$(printf '%s' "$loop_raw" | jq '{
      round: (.loop_round // 0),
      max_rounds: (.max_rounds // 5),
      already_executed: ([(.executed // [])[] | .plugin // empty] | unique | map(select(. != "(skip)")))
    }' 2>/dev/null || echo '')
    [[ -n "$parsed" ]] && LOOP_JSON="$parsed"
  fi
fi

jq -n \
  --argjson session "$SESSION_JSON" \
  --argjson loop "$LOOP_JSON" \
  --argjson plugins "$PLUGINS_JSON" \
  --argjson artifacts "$ARTIFACTS" \
  '{session:$session, loop:$loop, plugins:$plugins, artifacts:$artifacts}'
