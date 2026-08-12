---
name: deep-receipt
description: "View, dashboard, or export deep-work slice receipts (`receipts/SLICE-*.json`). Triggers on `/deep-receipt`, `/deep-status --receipts`, \"receipt dashboard\", \"slice receipt\", \"리시트 보기\", \"리시트 대시보드\", \"에비던스 리시트\". Sub-page of the deep-status hub."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) / `dashboard` | ASCII visual dashboard of all slice receipts |
| `view SLICE-NNN` | 특정 slice 의 receipt 상세 |
| `export` | JSON / Markdown export |
| `validate` | 9-item 검증 (verify-delegated-receipt-runner) |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites

**Hub-spoke 관계**: 본 skill 은 `deep-status` hub 의 sub-page 입니다 — `/deep-status --<flag>` 가 본문 로직을 inline Read 하여 실행하는 것이 주 경로이며, 직접 호출도 동일하게 지원됩니다.


> **Internal** — `/deep-status --receipts`가 이 파일의 display logic을 `Read`하여 실행합니다. 자동 호출이 주 경로이며, 직접 호출도 지원됩니다.
> 참조처: `${CLAUDE_PLUGIN_ROOT}/skills/deep-status/SKILL.md` §6 (`Read ${CLAUDE_PLUGIN_ROOT}/skills/deep-receipt/SKILL.md and follow its display logic inline`).

# Receipt Management

View, export, and manage evidence receipts from the implementation phase.

## Language

Read(`${CLAUDE_PLUGIN_ROOT}/skills/shared/references/user-language.md`) and follow it.

## Usage

- `/deep-receipt` — Show receipt dashboard (same as `/deep-receipt dashboard`)
- `/deep-receipt dashboard` — ASCII visual dashboard of all slice receipts
- `/deep-receipt view SLICE-NNN` — Show detailed receipt for a specific slice
- `/deep-receipt export --format=json` — Export all receipts as single JSON file
- `/deep-receipt export --format=md` — Export as markdown (for PR descriptions)
- `/deep-receipt export --format=ci` — Export CI bundle (session-receipt + all slice receipts in one JSON, for GitHub Actions validation)

## Runtime Setup

Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-resume/references/session-detection.md`) and apply only its **Reusable session-state resolution** section to resolve `$STATE_FILE`; retain this skill's own no-session and standalone-mode behavior.

Read `$STATE_FILE` and extract `work_dir`.
Receipts are stored in `$WORK_DIR/receipts/SLICE-NNN.json`.

**Envelope-aware reads**: deep-work 6.5.0 부터 SLICE-*.json 과
`session-receipt.json` 는 M3 cross-plugin envelope (`{schema_version: "1.0",
envelope: {...}, payload: {...}}`) 로 emit 된다 (cf.
`claude-deep-suite/docs/envelope-migration.md` §1). 본 명령의 모든 receipt
read 단계에서 다음 unwrap 규칙을 적용한다:

1. JSON 파싱 후 root 가 envelope 형태이면 (`schema_version === "1.0"`,
   `envelope` 객체, `payload` 키 모두 존재) identity guard 검증:
   `envelope.producer === "deep-work"` ∧
   `envelope.artifact_kind ∈ {slice-receipt, session-receipt}` ∧
   `envelope.schema.name === envelope.artifact_kind`. 위 조건을 모두 통과하면
   `payload` 객체를 사용 (legacy receipt body). 한 항목이라도 어긋나면
   "foreign envelope at <path>" 경고 후 receipt 무시 (handoff §4 round-4
   identity guard).
2. Legacy(non-envelope) JSON 이면 그대로 사용 (forward-compat).
3. `/deep-receipt export --format=ci` 같은 bundle export 는 envelope wrapping
   을 그대로 유지한 채 묶어 외부 CI 에 전달한다 (envelope 의 run_id chain 이
   audit 용).

## Dashboard

Scan `$WORK_DIR/receipts/` directory for all receipt JSON files. For each receipt, display:

```
Receipt Dashboard

┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│ Slice    │ TDD      │ Tests    │ Spec     │ Contract │ Review   │
├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤
│ SLICE-001│ ✅ GREEN │ 5/5 PASS │ 3/3 ✅   │ 4/4 PASS │ PASS     │
│ SLICE-002│ 🟡 RED_V │ 2/5 FAIL │ 1/3 ⏳   │ 1/3 FAIL │ —        │
│ SLICE-003│ ⬜ PEND  │ —        │ —        │ —        │ —        │
│ SLICE-004│ SPIKE    │ —        │ —        │ —        │ ⚠️       │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘

요약:
  완료: 1/4 (25%)
  TDD 준수: 1 strict, 0 relaxed, 0 override, 1 spike
  총 변경: +142 -23 (8 files)
```

TDD state icons:
- ✅ GREEN/REFACTOR — TDD cycle complete
- 🔴 RED — failing test written, not yet green
- 🟡 RED_VERIFIED — verified failing test, implementation pending
- 🟢 GREEN_ELIGIBLE — production code written, verification pending
- ⬜ PENDING — not started
- SPIKE — spike mode (not merge-eligible)
- override — TDD skipped by user (merge-eligible with warning)
- 🔍 SENSOR_RUN — Computational sensor running
- 🔧 SENSOR_FIX — Fixing sensor errors (self-correction loop active)
- ✅ SENSOR_CLEAN — All sensors passed

## Health Check Display

When displaying any receipt (dashboard or view), if the session state file contains `health_report`, include the Health Check section:

```
### Health Check (Phase 1 진단)
- 🔍 드리프트: dead-export {count}건 | coverage {delta}%p | vuln {critical+high}건 | stale {count}건
- 📐 Fitness: {passed}/{total} 통과 | 위반 delta: {delta}건
- ⚠️ Required: {acknowledged ? "acknowledged" : "미해결 N건"}
```

**Steps**:
1. Read `health_report` from the session state file
2. Extract drift metrics: `health_report.drift.dead_exports.count`, `health_report.drift.coverage_trend.delta`, `health_report.drift.dependency_vuln.critical + health_report.drift.dependency_vuln.high`, `health_report.drift.stale_config.count`
3. Extract fitness metrics: `health_report.fitness.passed`, `health_report.fitness.total_rules`, `health_report.fitness.required_missing`
4. Extract required status: check `acknowledged_required_issues` in the state file
5. If `health_report` is absent from the state file, skip this section silently

## View

`/deep-receipt view SLICE-NNN`:

Read `$WORK_DIR/receipts/SLICE-NNN.json` and display formatted:

```
Receipt: SLICE-NNN — [Goal from plan.md]

TDD Cycle:
  🔴 RED:   [timestamp] — [test name]
  🟢 GREEN: [timestamp] — [N tests passing]

Changes:
  Files: [file1, file2]
  Diff:  +[N] -[N] lines

Spec Compliance:
  ✅ [requirement 1]
  ✅ [requirement 2]
  ❌ [requirement 3]

Contract Compliance:
  ✅ [contract item 1]
  ✅ [contract item 2]
  ❌ [contract item 3]
  Threshold: [all/majority]
  Result: [PASS/FAIL]

Code Review:
  결과: [PASS/WARN]
  Findings: [N] (critical: [N], important: [N])

Sensor Results:
  생태계: [ecosystem, e.g. typescript]
  Lint ([tool]): [pass|fail|not_applicable] — errors: [N], warnings: [N], correction_rounds: [N]
  Typecheck ([tool]): [pass|fail|not_applicable] — errors: [N], correction_rounds: [N]
  Coverage ([tool]): [pass|fail|not_applicable] — line: [N]%, branch: [N]%

Debug Log:
  [None / RC-NNN: root cause description]
```

If `sensor_results` is absent from the receipt, skip the Sensor Results block silently.

## Export — JSON

`/deep-receipt export --format=json`:

Read all receipt files, combine into a single JSON array, and write to `$WORK_DIR/receipts-export.json`:

```json
{
  "session": {
    "task": "[task_description]",
    "branch": "[git_branch]",
    "timestamp": "[ISO]",
    "tdd_mode": "[strict/relaxed/spike]"
  },
  "summary": {
    "total_slices": N,
    "completed": N,
    "tdd_compliance": { "strict": N, "relaxed": N, "override": N, "spike": N },
    "total_changes": { "added": N, "removed": N, "files": N },
    "debug_count": N,
    "contract_compliance": {
      "total_items": N,
      "passed": N,
      "failed": N,
      "pass_rate": "N%"
    }
  },
  "slices": [
    {
      "...other receipt fields...",
      "contract_compliance": {
        "items": { "item1": true, "item2": true, "item3": false },
        "threshold": "all",
        "result": "FAIL"
      }
    }
  ]
}
```

Display: `Exported: $WORK_DIR/receipts-export.json`

## Export — Markdown

`/deep-receipt export --format=md`:

Generate a markdown summary suitable for PR descriptions. Write to `$WORK_DIR/receipts-export.md`:

```markdown
## Evidence Summary

| Slice | Goal | TDD | Tests | Spec | Contract | Review |
|-------|------|-----|-------|------|----------|--------|
| SLICE-001 | [goal] | ✅ strict | 5/5 | 3/3 | 4/4 PASS | PASS |
| SLICE-002 | [goal] | ✅ strict | 3/3 | 2/2 | 3/3 PASS | PASS |

### TDD Compliance
- Strict mode: N/N slices (100%)
- Average RED→GREEN time: [Nm]

### Changes
- Total: +[N] -[N] lines across [N] files
- Debug sessions: [N] (root causes documented)

### Spec Compliance
- All requirements met: [N/N] slices
```

Display: `Exported: $WORK_DIR/receipts-export.md`

Copy to clipboard suggestion:
```
PR 디스크립션에 붙여넣으려면:
   cat $WORK_DIR/receipts-export.md | pbcopy
```

## Receipt Schema: Sensor Fields

These fields are written by the sensor infrastructure during Phase 4 (implement) and are consumed by deep-test Quality Gates (Section 4-6/4-7) and deep-review integration.

### Per-slice sensor_results

```json
{
  "ecosystem": "typescript",
  "lint": {
    "tool": "eslint",
    "status": "pass|fail|not_applicable|timeout",
    "errors": 0,
    "warnings": 0,
    "correction_rounds": 0
  },
  "typecheck": {
    "tool": "tsc",
    "status": "pass|fail|not_applicable|timeout",
    "errors": 0,
    "correction_rounds": 0
  },
  "coverage": {
    "tool": "jest",
    "status": "pass|fail|not_applicable|timeout",
    "line_pct": 87.3,
    "branch_pct": 72.1
  }
}
```

### Session mutation_testing

Written to the session state file after Phase 4 Mutation Score gate (Section 4-7).

```json
{
  "tool": "stryker",
  "status": "completed|not_applicable",
  "total_mutants": 45,
  "killed": 39,
  "survived": 4,
  "equivalent": 2,
  "score": 90.7,
  "auto_fix_rounds": 2,
  "remaining_survived": [
    {
      "file": "src/auth/jwt.ts",
      "line": 42,
      "mutator": "ConditionalExpression",
      "tag": "possibly_equivalent"
    }
  ]
}
```
