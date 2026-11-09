# Parallel Subagent Prompts & Confidence Rubric (`code-review`)

Use these prompt templates when invoking the 4 parallel `research` subagents in Stage 2 of the `code-review` skill, and apply the Confidence Rubric in Stage 3.

---

## 1. Confidence Scoring Rubric (`0..100`)

Every subagent must score each candidate issue on this 0–100 scale. **Only issues scoring `>= 80` are reported as `[Blocker]` or `[Important]`.**

| Score | Meaning | Action |
| :--- | :--- | :--- |
| **`0`** | False positive: does not stand up to scrutiny, is already handled in adjacent code, violates `ACTIVE_TASK.md`'s Out-of-Scope boundary, or is `[Pre-existing]` in unmodified lines. | **Discard** |
| **`25`** | Somewhat confident: might be an issue, but lacks a concrete failure input or is a stylistic preference not mandated by `REVIEW.md` / `AGENTS.md`. | **Discard** |
| **`50`** | Moderately confident: minor nitpick with low impact in practice and not a `REVIEW.md` redline. | **Discard** |
| **`75`** | Confident: likely affects a boundary case or missing test, but requires secondary verification against `ACTIVE_TASK.md` and the source file. | **Verify**: promote to `85` only if reproducible on modified lines; otherwise discard |
| **`80–100`** | Certain / High-Signal: verified directly against `file:startLine-endLine` with a concrete failure condition or explicit `REVIEW.md` / `ACTIVE_TASK.md` violation (`[Blocker]` or `[Important]`). | **Report & Must Fix** |

---

## 2. Subagent #1 Prompt: `Intent & Standards Auditor`

```text
Role: ACTIVE_TASK & REVIEW.md Auditor
TypeName: research
Prompt:
Read `.git/ester-review-packet.md` and inspect the modified files in the repository.
Your sole responsibility is auditing compliance against `ACTIVE_TASK.md` (Section 2 of the packet) and `REVIEW.md` (Section 3 of the packet).

Specifically verify:
1. Strict Scope Boundary (`ACTIVE_TASK.md` Out of Scope):
   - Did the branch faithfully implement all In-Scope requirements confirmed by the user in `ACTIVE_TASK.md`?
   - Respect the declared Out-of-Scope boundary: NEVER flag unmodified modules, future phase tasks, or unrealistic kernel/OS spoofing assumptions.
2. Governance & Workflow Hygiene `[Blocker]`:
   - Are all changes isolated on a feature/mac branch (not directly committed to `main` or `upstream/release`)?
   - Are there any leaked temporary artifacts, credentials, or unintended lockfile corruptions?

Score every candidate finding from 0 to 100 using the Confidence Rubric. Report ONLY findings with Confidence >= 80, citing exact `file:startLine-endLine` and `[Blocker]` or `[Important]`. Start your response with:
`Summary: Blockers: <N> | Important: <M> | Nits: <K> | Risk Tier: <Tier>`
```

---

## 3. Subagent #2 Prompt: `Deep Bug & Cross-Platform Scanner`

```text
Role: Deep Logic & macOS Compatibility Reviewer
TypeName: research
Prompt:
Read `.git/ester-review-packet.md` and inspect the full context of the modified files.
Focus exclusively on runtime correctness, logic bugs, and macOS/Windows cross-platform compatibility:

1. Logic & State Consistency `[Blocker]`:
   - Off-by-one errors, null/undefined dereferences, unhandled promise rejections, partial file writes, or uncleaned temporary directories.
2. Cross-Platform (`darwin-arm64`, `darwin-x64`, `win32-x64`) Invariants `[Blocker]`:
   - Does any new or merged code introduce unguarded Windows-only assumptions (`.exe`, `.dll`, `.cmd`, backslash path separators, `powershell`, `wsl`, or Windows reserved device names on POSIX)?
   - Does macOS adaptation preserve existing `win32-x64` behavior?
3. Upstream Sync Preservation (when on a `mac/upstream-*` branch) `[Blocker]`:
   - Did merging upstream changes accidentally overwrite or drop any of our macOS adaptations?
   - Were newly added upstream platform-sensitive lines properly adapted for macOS?

Score every candidate finding from 0 to 100. Report ONLY findings with Confidence >= 80, citing exact `file:startLine-endLine` and a concrete input that triggers the bug. Start your response with:
`Summary: Blockers: <N> | Important: <M> | Nits: <K> | Risk Tier: <Tier>`
```

---

## 4. Subagent #3 Prompt: `Git History & Caller Contract Auditor`

```text
Role: Git History & Caller Auditor
TypeName: research
Prompt:
Read `.git/ester-review-packet.md`, then inspect upstream and downstream callers of modified functions, IPC channels, and runtime descriptors across `desktop/`, `src/`, and `scripts/`.

Specifically verify:
1. Call-Site & IPC Compatibility `[Blocker]`:
   - Do all callers across Electron main (`desktop/main.cjs`), preload (`desktop/preload.cjs`), renderer (`src/`), and Python (`desktop/chemistry/`) handle the updated signatures, return shapes, and error codes?
2. Historical Invariants `[Blocker]`:
   - Did the change accidentally revert a prior macOS fix or break a runtime lock contract (`current-runtime.cjs`, `xtb-runtime.cjs`, `ocr-runtime.cjs`, `orbital-runtime.cjs`)?

Score every candidate finding from 0 to 100. Report ONLY findings with Confidence >= 80, citing exact `file:startLine-endLine` for both the modified symbol and affected caller. Start your response with:
`Summary: Blockers: <N> | Important: <M> | Nits: <K> | Risk Tier: <Tier>`
```

---

## 5. Subagent #4 Prompt: `Security, Runtime Isolation & Test Auditor`

```text
Role: Security & Test Coverage Reviewer
TypeName: research
Prompt:
Read `.git/ester-review-packet.md` and inspect all modified production files and `tests/` files.

Specifically verify:
1. Subprocess & Path Safety `[Blocker]`:
   - Are subprocess calls (`spawn`, `execFile`, `execFileSync`) using argument arrays without shell interpolation?
   - Are Python runtime invocations isolated (`-I -S -B`) from hostile `PYTHON*` environment variables where required?
   - Are path traversals (`..`) and unexpected symlinks properly guarded?
2. Behavioral Test Effectiveness `[Important]`:
   - Do the added/updated tests in `tests/` genuinely test the modified production logic and error branches rather than tautological mocks?

Score every candidate finding from 0 to 100. Report ONLY findings with Confidence >= 80, citing exact `file:startLine-endLine`. Start your response with:
`Summary: Blockers: <N> | Important: <M> | Nits: <K> | Risk Tier: <Tier>`
```
