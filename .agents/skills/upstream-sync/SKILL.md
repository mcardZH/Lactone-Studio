---
name: upstream-sync
description: >-
  Track, diff, merge, and adapt new upstream Ester Studio source releases (from https://github.com/Ahey1/Ester-Studio/releases)
  that are published as source-code.zip snapshots without Git history. Use this skill whenever the user asks to check
  upstream updates, import a new upstream source archive, or merge a new upstream version while preserving our macOS adaptations.
---

# Upstream Source Snapshot Tracking & 3-Way macOS Merge (`upstream-sync`)

The upstream author of Ester Studio (`https://github.com/Ahey1/Ester-Studio`) publishes each release as a standalone `Ester-Studio-vX.Y.Z-source-code.zip` archive without a `.git` commit history.

To merge upstream new features into our macOS-adapted `main` branch **without losing our macOS adaptations** and **while systematically adapting upstream's new code for macOS**, this repository maintains a synthetic upstream vendor branch (`upstream/release`) anchored at the original `v2.0.2` baseline commit (`ab563fb`).

---

## 1. Architecture: How 3-Way Snapshot Merging Works

```text
ab563fb (tag: upstream/v2.0.2)  <--- Common Ancestor (Merge Base)
 ├──► upstream/release:  upstream/v2.0.3  ──►  upstream/v2.0.4  (Pure unmodified author snapshots)
 └──► main:              Phase 1..3B macOS adaptations ──► merge mac/upstream-v2.0.3
```

Because `upstream/v2.0.2` (`ab563fb`) is the common ancestor of both `upstream/release` and `main`, Git's 3-way merge (`git merge upstream/v2.0.3`) automatically computes:
- **Upstream Delta (`upstream/v2.0.2..upstream/v2.0.3`)**: Exactly what the author changed in the new version.
- **Our macOS Delta (`upstream/v2.0.2..main`)**: Every file we added or modified for macOS (`darwin-arm64` / `darwin-x64`).

---

## 2. Step-by-Step Workflow

### Step 1: Check for New Upstream Releases
Run the upstream release checker against GitHub Releases (`https://api.github.com/repos/Ahey1/Ester-Studio/releases`):
```bash
npm run upstream:check
```
This compares upstream releases against local `upstream/v*` tags and displays any unimported release (version tag, release notes, `Ester-Studio-vX.Y.Z-source-code.zip` download URL, size, and SHA-256).

### Step 2: Import the New Upstream Source Snapshot onto `upstream/release`
Once you have downloaded `Ester-Studio-vX.Y.Z-source-code.zip` (or extracted it to a local directory), import it onto `upstream/release` without disturbing your working tree:
```bash
# From an extracted directory or .zip archive:
npm run upstream:import -- --version v2.0.3 --source /path/to/Ester-Studio-v2.0.3-source-code
```
What this does under the hood:
- Ensures `upstream/v2.0.2` and `upstream/release` are initialized at `ab563fb`.
- Uses a temporary `GIT_INDEX_FILE` + `git write-tree` + `git commit-tree` to commit the pristine upstream source tree directly onto `refs/heads/upstream/release` and tags `refs/tags/upstream/v2.0.3`.
- Automatically preserves the existing `third-party/build-inputs/archives/` binary cache blobs from the parent `upstream/release` tree if omitted during extraction, avoiding redundant 800 MB re-hashing when unchanged.

### Step 3: Run 3-Way Delta & macOS Adaptation Analysis
Before merging, generate the 3-way analysis report (`.git/upstream-analysis-v2.0.3.md`):
```bash
npm run upstream:analyze -- --version v2.0.3
```
The analyzer classifies every upstream change into 3 actionable categories:
1. **Category A — Pure Upstream Changes (Clean Auto-Merge)**:
   Files modified by upstream between `v2.0.2` and `v2.0.3` that were **not** modified by our macOS adaptation on `main`.
2. **Category B — Dual-Modified / Overlap Files (Preserve macOS Adaptation)**:
   Files modified by **BOTH** upstream (`v2.0.2..v2.0.3`) and our `main` branch (`v2.0.2..main`). During merge, you MUST verify that every macOS adaptation in these files is preserved alongside upstream's new logic.
3. **Category C — Newly Added Platform-Sensitive Code (Needs New macOS Adaptation)**:
   Every added line (`+`) in `upstream/v2.0.2..upstream/v2.0.3` matching Windows/platform-specific patterns (`win32`, `.exe`, `.dll`, `.cmd`, `.bat`, `powershell`, `wsl`, `spawn`/`execFile`, hardcoded `\\` paths, or runtime lock files). You must inspect each flagged `file:line` and add macOS support if needed.

### Step 4: Prepare the Merge Branch & Populate `ACTIVE_TASK.md`
Create the dedicated integration branch `mac/upstream-v2.0.3` from `main`, run the 3-way Git merge, and auto-populate `ACTIVE_TASK.md`:
```bash
npm run upstream:prepare-merge -- --version v2.0.3
```
Then:
1. Review `ACTIVE_TASK.md` with the user and confirm the adaptation plan for Category B (overlap files) and Category C (new platform-sensitive code).
2. Resolve any 3-way merge conflicts on `mac/upstream-v2.0.3`, ensuring both our macOS adaptations and upstream's new features are intact.
3. Add/update unit tests in `tests/` covering any new macOS adaptation logic and run `npm test`.
4. Run the `code-review` skill (`npm run review:prepare` + 4 parallel subagents + `npm run review:receipt -- --record`).
5. After user confirmation, merge to `main` via `npm run merge:main -- mac/upstream-v2.0.3 --confirmed`.
