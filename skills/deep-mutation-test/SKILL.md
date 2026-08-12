---
name: deep-mutation-test
description: "Mutation testing on changed files to verify AI-generated test quality, with an auto-fix loop that returns to Implement for survived mutants. Triggers on `/deep-mutation-test`, \"mutation test\", \"test quality\", \"mutation score\", \"뮤테이션 테스트\", \"테스트 품질 검증\"."
user-invocable: true
---

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | git diff 기반 changed files (세션 baseline 또는 HEAD~5..HEAD fallback) |
| `--full` | 전체 프로젝트 (expensive) |
| `--files <path>` | 특정 파일/디렉터리 명시 |

빈 args / 매칭되지 않는 토큰 → 본문의 default 분기로 진입.

## Prerequisites


# /deep-mutation-test

Mutation testing for AI-generated test quality verification. Primarily used in Phase 4 (Test) but can be run manually.

## Usage

```
/deep-mutation-test                    # Test changed files (git diff based)
/deep-mutation-test --full             # Test entire project (expensive)
/deep-mutation-test --files src/auth   # Test specific files/directories
```

## How It Works

### Step 1: Determine Scope

**Primary source**: `git diff --name-only <baseline>..HEAD` where baseline is the session's starting commit.
**Fallback**: If no session, use `git diff --name-only HEAD~5..HEAD` (last 5 commits).
**Override**: `--files` flag specifies exact scope.

Filter files by detected ecosystem's file_extensions.

### Step 2: Check Mutation Tool

Read sensor detection cache. If mutation tool is not_installed:
- Display warning: "Mutation testing tool not installed for [ecosystem]. Install [tool] to enable."
- Exit gracefully (not an error).

### Step 3: Execute Mutation Testing

Run mutation tool with budget constraints from registry.json:
- `timeout`: max seconds per round (default 300)
- `max_mutants`: cap mutant count (default 200)

```bash
node "${CLAUDE_PLUGIN_ROOT}/sensors/run-sensors.js" "<mutation_cmd>" "<parser>" "mutation" "advisory" <timeout>
```

### Step 4: Analyze Results

Parse mutation report:
- Mutation Score = killed / (killed + survived) × 100
- Exclude NoCoverage from denominator
- Tag possibly_equivalent mutants (NoCoverage + logging-related StringLiteral)

### Step 5: Auto-Fix Loop (if survived mutants found)

**IMPORTANT**: Follow existing deep-test pattern — Test phase does NOT allow code modifications.

For each round (max 3):

1. **Transition to Implement phase**: Set `current_phase: implement` in session state
2. **Present survived mutant feedback** in agent-readable format:
   ```
   [MUTATION_SURVIVED] N mutants survived (Score: X%)
   Transitioning to Implement phase for test improvement.

   MUTANT 1: file:line
     Mutation: MutatorName — changed `original` to `replacement`
     Impact: What this means for behavior
     ACTION: Specific test to add
   ```
3. **Agent writes tests** following TDD (RED → GREEN)
4. **Transition back**: Set `current_phase: test`
5. **Re-run mutation testing**
6. **Compare**: If score improved, continue. If no improvement after round, stop.

After 3 rounds or all killable mutants eliminated:
- Record final results in session receipt
- Display summary: score, rounds, fixed/remaining mutants

### Step 6: Record Results

Add to session receipt:
```json
{
  "mutation_testing": {
    "tool": "<tool>",
    "status": "completed",
    "total_mutants": 45,
    "killed": 39,
    "survived": 4,
    "equivalent": 2,
    "score": 90.7,
    "auto_fix_rounds": 2,
    "auto_fixed_mutants": 3,
    "remaining_survived": []
  }
}
```

## Not Applicable Handling

If mutation tool is not installed, record in receipt:
```json
{ "mutation_testing": { "status": "not_applicable", "reason": "tool not installed" } }
```
Quality Score treats this as excluded from denominator (no penalty).
