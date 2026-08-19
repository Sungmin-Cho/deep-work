#!/usr/bin/env bash
# update-check.sh — periodic version check for deep-work plugin (git-based)
#
# Output (one line, or nothing):
#   JUST_UPGRADED <old> <new>       — marker found from recent upgrade
#   UPGRADE_AVAILABLE <old> <new>   — remote VERSION differs from local
#   (nothing)                       — up to date, snoozed, disabled, or check skipped
#
# Modeled after gstack's update-check pattern.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Reuse the hardened find_project_root / sanitize_project_path from utils.sh
# instead of a local copy. This SessionStart hook previously carried its own
# unsanitized root walk that could spin on Windows drive roots (D:/) — the same
# CRLF/backslash bug class fixed centrally in utils.sh. utils.sh is a pure
# function library (no top-level side effects), safe to source under set -e.
source "$SCRIPT_DIR/utils.sh"
STATE_DIR="$HOME/.claude"
CACHE_FILE="$STATE_DIR/.deep-work-update-cache"
MARKER_FILE="$STATE_DIR/.deep-work-just-upgraded"
SNOOZE_FILE="$STATE_DIR/.deep-work-update-snoozed"
# package.json lives at the repo root (the local version at $PLUGIN_DIR/package.json
# is read the same way). The previous `.../main/plugins/deep-work/package.json`
# path 404'd — the repo has no plugins/ subtree — so every fetch failed and the
# "up to date" cache below was written from an empty response (see Step 4).
REMOTE_URL="https://raw.githubusercontent.com/Sungmin-Cho/deep-work/main/package.json"

# ─── Read local version from package.json ─────────────────────
LOCAL=""
if [ -f "$PLUGIN_DIR/package.json" ]; then
  LOCAL=$(node -e 'const p=process.argv[1]; console.log(JSON.parse(require("fs").readFileSync(p+"/package.json","utf8")).version)' "$PLUGIN_DIR" 2>/dev/null || true)
fi
if [ -z "$LOCAL" ]; then
  exit 0  # can't determine version
fi

# ─── Read profile for update settings ─────────────────────────
# Check deep-work-profile.yaml for auto_update and update_check settings
PROFILE_FILE=""
# find_project_root / sanitize_project_path come from utils.sh (sourced above).
# `|| true` absorbs the not-found exit 1 under set -e; sanitize covers the
# $PWD fallback. Mirrors init_deep_work_state's hardened derivation.
PROJECT_ROOT="$(find_project_root 2>/dev/null || true)"
PROJECT_ROOT="$(sanitize_project_path "${PROJECT_ROOT:-$PWD}")"
PROFILE_FILE="$PROJECT_ROOT/.claude/deep-work-profile.yaml"

# Check if updates are disabled
UPDATE_CHECK="true"
AUTO_UPDATE="false"
if [ -f "$PROFILE_FILE" ]; then
  _UC=$(grep '^update_check:' "$PROFILE_FILE" 2>/dev/null | head -1 | sed 's/update_check:[[:space:]]*//' | tr -d '"'"'" || true)
  [ "$_UC" = "false" ] && UPDATE_CHECK="false"
  _AU=$(grep '^auto_update:' "$PROFILE_FILE" 2>/dev/null | head -1 | sed 's/auto_update:[[:space:]]*//' | tr -d '"'"'" || true)
  [ "$_AU" = "true" ] && AUTO_UPDATE="true"
fi

if [ "$UPDATE_CHECK" = "false" ]; then
  exit 0
fi

# ─── Step 1: Check for just-upgraded marker ───────────────────
if [ -f "$MARKER_FILE" ]; then
  OLD_VER=$(cat "$MARKER_FILE" 2>/dev/null || true)
  rm -f "$MARKER_FILE"
  echo "JUST_UPGRADED $OLD_VER $LOCAL"
  exit 0
fi

# ─── Step 2: Check snooze ────────────────────────────────────
check_snooze() {
  local target_ver="$1"
  if [ ! -f "$SNOOZE_FILE" ]; then return 1; fi
  local snoozed_ver snoozed_level snoozed_ts
  snoozed_ver=$(awk '{print $1}' "$SNOOZE_FILE")
  snoozed_level=$(awk '{print $2}' "$SNOOZE_FILE")
  snoozed_ts=$(awk '{print $3}' "$SNOOZE_FILE")
  # Different version = new release, reset snooze
  if [ "$snoozed_ver" != "$target_ver" ]; then return 1; fi
  # Check TTL: level 1=24h, level 2=48h, level 3+=168h (1 week)
  local now ttl elapsed
  now=$(date +%s)
  case "$snoozed_level" in
    1) ttl=86400 ;;
    2) ttl=172800 ;;
    *) ttl=604800 ;;
  esac
  elapsed=$((now - snoozed_ts))
  if [ "$elapsed" -lt "$ttl" ]; then return 0; fi  # still snoozed
  return 1  # snooze expired
}

# ─── Step 3: Check cache (5-minute TTL) ──────────────────────
CACHE_TTL=5  # minutes
if [ -f "$CACHE_FILE" ]; then
  CACHED=$(cat "$CACHE_FILE" 2>/dev/null || true)
  STALE=$(find "$CACHE_FILE" -mmin +$CACHE_TTL 2>/dev/null || true)
  if [ -z "$STALE" ] && [ "$CACHE_TTL" -gt 0 ]; then
    case "$CACHED" in
      UP_TO_DATE*)
        CACHED_VER=$(echo "$CACHED" | awk '{print $2}')
        if [ "$CACHED_VER" = "$LOCAL" ]; then exit 0; fi
        ;;
      UPGRADE_AVAILABLE*)
        CACHED_OLD=$(echo "$CACHED" | awk '{print $2}')
        if [ "$CACHED_OLD" = "$LOCAL" ]; then
          CACHED_NEW=$(echo "$CACHED" | awk '{print $3}')
          if check_snooze "$CACHED_NEW"; then exit 0; fi
          echo "$CACHED"
          exit 0
        fi
        ;;
    esac
  fi
fi

# ─── Step 4: Fetch remote version ────────────────────────────
# A failed fetch (404, network error, empty body) or an unparseable/non-version
# response must be treated as "check skipped", NOT as "up to date". Writing
# UP_TO_DATE from an empty REMOTE poisons the 5-minute cache: every subsequent
# session reads the cached UP_TO_DATE and never re-fetches, so the update prompt
# is suppressed permanently. On any failure we exit without touching the cache
# so the next session retries the fetch.
REMOTE_JSON=$(curl -sf --max-time 5 "$REMOTE_URL" 2>/dev/null || true)
if [ -z "$REMOTE_JSON" ]; then
  exit 0  # fetch failed / empty body — retry next session, do not cache
fi

REMOTE=$(printf '%s' "$REMOTE_JSON" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).version)}catch(e){}})" 2>/dev/null || true)

# A non-version response (HTML error page, truncated JSON) is a fetch failure,
# not "up to date" — skip without caching.
if ! printf '%s' "$REMOTE" | grep -qE '^[0-9]+\.[0-9.]+$'; then
  exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "UP_TO_DATE $LOCAL" > "$CACHE_FILE"
  exit 0
fi

# Versions differ
echo "UPGRADE_AVAILABLE $LOCAL $REMOTE" > "$CACHE_FILE"
if check_snooze "$REMOTE"; then
  exit 0
fi

echo "UPGRADE_AVAILABLE $LOCAL $REMOTE"
