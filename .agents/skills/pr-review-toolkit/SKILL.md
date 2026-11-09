---
name: pr-review-toolkit
description: >-
  Run Anthropic's PR Review Toolkit of 6 specialized subagents (silent-failure-hunter,
  type-design-analyzer, pr-test-analyzer, comment-analyzer, code-reviewer, and code-simplifier)
  tailored for Ester Studio. Use this skill when the user wants targeted deep-dive audits on
  error handling, TypeScript/IPC contracts, behavioral test coverage, comment accuracy, or code simplification.
---

# PR Review Toolkit (`pr-review-toolkit`)

This skill adapts Anthropic's official `plugins/pr-review-toolkit` into 6 specialized subagents tailored for Ester Studio (`Electron + React 19 + TypeScript + Python/xTB/Multiwfn/OCR scientific runtimes`). You can invoke a single specialist on demand or run the recommended subset for the files touched in the current branch.

---

## 1. The 6 Specialist Subagents

Read [references/specialist-personas.md](./references/specialist-personas.md) for the exact prompt and scoring rubric of each specialist:

| Specialist ID | Subagent Type | When to Dispatch | Output / Scoring Metric |
| :--- | :--- | :--- | :--- |
| **`silent-failure-hunter`** | `research` | Any change with `try/catch`, subprocess calls (`python3`, `xtb`, `multiwfn`, `java`, `ssh2`), or IPC handlers | Zero-tolerance audit of swallowed errors, silent fallbacks, and missing error codes |
| **`type-design-analyzer`** | `research` | Changes to `src/**/*.ts`, IPC payload contracts, or runtime descriptor schemas | **4 ratings (`1–10`)**: Encapsulation, Invariant Expression, Invariant Usefulness, Invariant Enforcement |
| **`pr-test-analyzer`** | `research` | Any feature, macOS adaptation, upstream merge, or bugfix touching production code | **Criticality rating (`1–10`)** for each missing behavioral or cross-platform boundary test |
| **`comment-analyzer`** | `research` | Changes to scientific algorithms, runtime locks, or platform-specific workarounds | Comment-rot detection + verification that non-obvious platform/scientific invariants are documented |
| **`code-reviewer`** | `research` | General pre-merge check against `ACTIVE_TASK.md`, `REVIEW.md`, and `AGENTS.md` | **Confidence score (`0–100`)**, reporting only findings `>= 80` |
| **`code-simplifier`** | `self` (or direct) | **After** tests pass (`npm test`), to clean up complex conditionals or duplicated logic | Behavior-preserving simplification verified by `npm test` |

---

## 2. Execution Procedure

### Step 1: Prepare Diff Context
Run `npm run review:prepare` so all specialist subagents share a consistent snapshot of `ACTIVE_TASK.md`, `REVIEW.md`, and the unified diff in `.git/ester-review-packet.md`.

### Step 2: Select & Dispatch Specialists
- **Explicit Request**: If the user names specific specialists (e.g., `silent-failure-hunter`), launch those specialists.
- **Auto-Selection ("run pr-review-toolkit")**:
  1. Always dispatch `silent-failure-hunter`, `pr-test-analyzer`, and `code-reviewer`.
  2. If any `.ts`/`.tsx` types or runtime lock schemas changed, also dispatch `type-design-analyzer`.
  3. Launch all selected `research` subagents **in parallel** using `invoke_subagent` with the prompts from [references/specialist-personas.md](./references/specialist-personas.md).

### Step 3: Synthesize & Sign Receipt
1. Consolidate the specialist reports into a single structured summary grouped by specialist, preserving exact `file:startLine-endLine` citations and numeric ratings.
2. Once all `[Blocker]` and `[Important]` findings are resolved and `npm test` passes, record the review receipt via:
   ```bash
   npm run review:receipt -- --record --summary "Summary: Blockers: 0 | Important: 0 | Nits: 0 | Risk Tier: <Tier>"
   ```
