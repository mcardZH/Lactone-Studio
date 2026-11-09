---
name: code-review
description: >-
  Run Anthropic's multi-agent Fresh-Context Code Review pipeline on the current branch for Ester Studio.
  Use this skill before merging any branch into main, or whenever the user asks to review current changes,
  run a subagent code review, or issue a review receipt.
---

# Multi-Agent Code Review (`code-review`)

This skill adapts Anthropic's official `plugins/code-review` workflow for Antigravity and Ester Studio's [`REVIEW.md`](../../../REVIEW.md) + [`ACTIVE_TASK.md`](../../../ACTIVE_TASK.md) governance pipeline. It replaces legacy `review:codex` with deterministic pre-checks, **4 parallel Fresh-Context Subagents**, **confidence-score filtering (`>= 80`)**, a **3-round circuit breaker**, and cryptographic SHA-256 review receipt signing (`npm run review:receipt -- --record`).

---

## Workflow Stages

### Stage 1: Deterministic Gate & Review Packet Preparation

Never waste subagent tokens on code that fails unit tests or lacks a valid `ACTIVE_TASK.md`:

1. Build the self-contained review packet (stored at `.git/ester-review-packet.md` so subagents can read it inside the workspace without polluting `git status`):
   ```bash
   npm run review:prepare
   ```
   *(Note: `npm run review:prepare` automatically validates `ACTIVE_TASK.md`, runs `npm test`, classifies the Risk Tier, checks the 3-round circuit breaker, and writes `.git/ester-review-packet.md`.)*
2. **Gate Check**:
   - If `npm run review:prepare` fails (e.g., invalid `ACTIVE_TASK.md`, failing unit tests, or protected `main` branch), fix the deterministic blockers first and re-run Stage 1.
   - If the changeset is classified as **`Tier 0 (Low)`** (docs/comments/tests only), you may immediately record the receipt (`npm run review:receipt -- --record --summary "Summary: Blockers: 0 | Important: 0 | Nits: 0 | Risk Tier: Tier 0 (Low)"`) without spawning 4 subagents unless the user explicitly requested a deep review.

---

### Stage 2: Launch 4 Parallel Fresh-Context Subagents

For **`Tier 1 (Medium)`** and **`Tier 2 (High)`** changes, read the prompt templates in [references/subagent-prompts.md](./references/subagent-prompts.md) and launch **4 `research` subagents in parallel** in a single turn using `invoke_subagent` (`TypeName: "research"`, `Model: "inherit"`):

1. **Subagent #1 — `Intent & Standards Auditor`** (`Role: "ACTIVE_TASK & REVIEW.md Auditor"`):
   - Audits the diff against `ACTIVE_TASK.md` (user intent alignment + strict Out-of-Scope boundary) and `REVIEW.md`.
2. **Subagent #2 — `Deep Bug & Cross-Platform Scanner`** (`Role: "Deep Logic & macOS Compatibility Reviewer"`):
   - Audits the diff line-by-line for runtime bugs, async/IPC edge cases, and `darwin-arm64` / `darwin-x64` / `win32-x64` cross-platform compatibility (including preserving macOS adaptations during upstream merges).
3. **Subagent #3 — `Git History & Caller Contract Auditor`** (`Role: "Git History & Caller Auditor"`):
   - Inspects upstream/downstream callers across `desktop/`, `src/`, and `scripts/` to detect contract drift, broken IPC channels, or regressions against earlier macOS adaptation commits.
4. **Subagent #4 — `Security, Runtime Isolation & Test Auditor`** (`Role: "Security & Test Coverage Reviewer"`):
   - Audits subprocess/path safety (`python3 -I -S -B`, `xtb`, `multiwfn`, `java` OCR, `ssh2`), symlink/traversal defenses, and verifies that `tests/` genuinely exercises the new/modified code paths.

> [!IMPORTANT]
> After calling `invoke_subagent` for all 4 reviewers, end your turn and wait for the system to wake you up with their reports. Do not poll in a loop.

---

### Stage 3: Verification & Confidence Score Filtering (`>= 80`)

Once all 4 subagents report back, cross-check every candidate finding against the actual codebase using the rubric in [references/subagent-prompts.md](./references/subagent-prompts.md):

1. Verify the cited `file:startLine-endLine` and trigger condition directly in the source files.
2. Assign or validate each finding's **Confidence Score (`0..100`)**:
   - **Drop any finding with Confidence `< 80`** (false positives, stylistic nitpicks, or anything outside `ACTIVE_TASK.md`'s declared scope).
   - Tag pre-existing issues in untouched lines as `[Pre-existing]` (non-blocking).
3. Categorize surviving `>= 80` findings into `[Blocker]` and `[Important]`.

---

### Stage 4: Fix Loop (3-Round Cap), Receipt Signing & Output

1. **Output the Zero-Noise Summary**:
   Start your review report with the exact mandatory header from `REVIEW.md`:
   ```text
   Summary: Blockers: <N> | Important: <M> | Nits: <K> | Risk Tier: <Tier 0|1|2>
   ```
   Followed by hard-cited findings (`file:startLine-endLine`, `[Blocker]`/`[Important]`, `[Confidence: <80-100>]`), or `No actionable issues found.` if `Blockers === 0 && Important === 0`.
2. **If `Blockers > 0` or `Important > 0`**:
   - Record the failed review round so the 3-round circuit breaker tracks progress:
     ```bash
     npm run review:receipt -- --fail --summary "Summary: Blockers: <N> | Important: <M> | Nits: <K> | Risk Tier: <Tier>"
     ```
   - Fix the issues, re-run `npm run review:prepare`, and re-verify with the relevant subagent(s).
   - **3-Round Cap**: Never exceed **3 review-and-fix rounds**. If `npm run review:receipt -- --fail` triggers the circuit breaker (`3/3`), stop automatic patching and escalate to the user.
3. **If `Blockers === 0 && Important === 0` (Clean Pass)**:
   - Record the cryptographic SHA-256 review receipt for the current branch state:
     ```bash
     npm run review:receipt -- --record --summary "Summary: Blockers: 0 | Important: 0 | Nits: 0 | Risk Tier: <Tier>"
     ```
   - Present the summary to the user and wait for explicit confirmation before running `npm run merge:main -- <branch> --confirmed`.
