---
name: deep-sensor-scan
description: "Run computational sensors (linter, type checker, coverage) inside or outside a deep-work session. Triggers on `/deep-sensor-scan`, \"run sensors\", \"lint check\", \"type check\", \"coverage\", \"센서 실행\", \"린트 검사\", \"타입 검사\". Flags: `--detect`, `--lint`, `--typecheck`, `--coverage`."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | Full sensor scan (detect + lint + typecheck + coverage) |
| `--detect` | Ecosystem detection 만 |
| `--lint` | Linter 만 |
| `--typecheck` | Type checker 만 |
| `--coverage` | Coverage 만 |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites


# /deep-sensor-scan

Manual computational sensor scanning. Can be used inside or outside deep-work sessions.

## Usage

```
/deep-sensor-scan              # Full sensor scan (detect + run all)
/deep-sensor-scan --detect     # Show detected ecosystems only (no sensor execution)
/deep-sensor-scan --lint       # Run linter only
/deep-sensor-scan --typecheck  # Run type checker only
/deep-sensor-scan --coverage   # Run coverage measurement only
```

## How It Works

### Step 1: Ecosystem Detection

Run detection engine:
```bash
node "${CLAUDE_PLUGIN_ROOT}/sensors/detect.js" "$PROJECT_ROOT"
```

Display detected ecosystems and tool availability. If `--detect` flag, stop here.

### Step 2: Sensor Execution

For each detected ecosystem with available tools, run sensors in order:

1. **Linter** (if available and not `--typecheck`/`--coverage` only):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/sensors/run-sensors.js" "<lint_cmd>" "<parser>" "lint" "required" 30
   ```

2. **Type checker** (if available and not `--lint`/`--coverage` only):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/sensors/run-sensors.js" "<typecheck_cmd>" "<parser>" "typecheck" "required" 60
   ```

3. **Coverage** (if available and not `--lint`/`--typecheck` only):
   Run test command with coverage flag appended.

### Step 3: Results Display

Show results in a clear format:
- Per-sensor: status (pass/fail/not_installed/timeout), error count, warning count
- Per-error: file:line, rule, message, FIX suggestion
- Summary: total errors, total warnings, ecosystems scanned
