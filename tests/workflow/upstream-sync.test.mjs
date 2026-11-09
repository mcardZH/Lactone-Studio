import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  initUpstreamTracking,
  checkUpstreamReleases,
  importUpstreamSnapshot,
  analyzeUpstreamDelta,
  prepareUpstreamMergeBranch,
  listLocalUpstreamTags,
} from '../../scripts/upstream/upstream-sync.mjs';
import { createCleanTestChildEnv } from '../../scripts/workflow/run-tests.mjs';

function git(args, cwd, env = process.env) {
  const cleanEnv = createCleanTestChildEnv(env);
  return execFileSync('git', args, { cwd, env: cleanEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('upstream history-less snapshot tracking and 3-way macOS merge workflow tests', () => {
  it('tracks upstream releases, imports history-less snapshots onto upstream/release, classifies 3-way deltas, and preserves macOS adaptations on merge', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'ester-upstream-test-'));
    const repoDir = join(tempRoot, 'repo');
    const upstreamV203Dir = join(tempRoot, 'Ester-Studio-v2.0.3-source-code');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(upstreamV203Dir, { recursive: true });

    try {
      // 1. Create baseline v2.0.2 snapshot commit on main (simulating ab563fb)
      git(['init', '-b', 'main'], repoDir);
      git(['config', 'user.name', 'Tester'], repoDir);
      git(['config', 'user.email', 'test@example.com'], repoDir);

      mkdirSync(join(repoDir, 'desktop'), { recursive: true });
      mkdirSync(join(repoDir, 'src/modeling'), { recursive: true });
      writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'ester-studio', version: '2.0.2' }, null, 2), 'utf8');
      writeFileSync(
        join(repoDir, 'desktop/runtime.cjs'),
        [
          '// Line 1: header',
          'function resolveEngine() {',
          "  return 'engine.exe';",
          '}',
          '// Line 5: middle spacer',
          '// Line 6: middle spacer',
          '// Line 7: middle spacer',
          '// Line 8: middle spacer',
          'function getTimeout() {',
          '  return 5000;',
          '}',
          'module.exports = { resolveEngine, getTimeout };',
        ].join('\n') + '\n',
        'utf8',
      );
      writeFileSync(
        join(repoDir, 'src/modeling/conformer.ts'),
        'export const conformerMode = "v2.0.2";\n',
        'utf8',
      );

      git(['add', '.'], repoDir);
      git(['commit', '-m', 'chore: import Ester Studio v2.0.2 baseline source snapshot'], repoDir);
      const baseCommit = git(['rev-parse', 'HEAD'], repoDir);

      // 2. Simulate our macOS adaptation commits on main
      writeFileSync(
        join(repoDir, 'desktop/runtime.cjs'),
        [
          '// Line 1: header',
          'function resolveEngine(platform = process.platform) {',
          "  return platform === 'win32' ? 'engine.exe' : 'engine';",
          '}',
          '// Line 5: middle spacer',
          '// Line 6: middle spacer',
          '// Line 7: middle spacer',
          '// Line 8: middle spacer',
          'function getTimeout() {',
          '  return 5000;',
          '}',
          'module.exports = { resolveEngine, getTimeout };',
        ].join('\n') + '\n',
        'utf8',
      );
      mkdirSync(join(repoDir, 'scripts/release'), { recursive: true });
      writeFileSync(
        join(repoDir, 'scripts/release/package-macos.mjs'),
        'export const macPackager = true;\n',
        'utf8',
      );
      git(['add', '.'], repoDir);
      git(['commit', '-m', 'feat(mac): adapt runtime.cjs for darwin and add package-macos.mjs'], repoDir);

      // 3. Initialize upstream tracking at baseCommit (v2.0.2) and check releases
      const initRes = initUpstreamTracking({ cwd: repoDir });
      assert.equal(initRes.ok, true);
      assert.equal(initRes.baseCommit, baseCommit);

      const checkBefore = await checkUpstreamReleases({
        cwd: repoDir,
        releasesJson: [
          {
            tag_name: 'v2.0.3',
            name: 'Ester Studio 2.0.3',
            published_at: '2026-11-08T07:11:17Z',
            body: '- 改进构象搜索\n| Ester-Studio-v2.0.3-source-code.zip | 816824081 | b0d73f56622fa74d4329498fa9de8b3a125f56d7b885a75814325f56d7b885a7 |',
            assets: [
              {
                name: 'Ester-Studio-v2.0.3-source-code.zip',
                size: 816824081,
                browser_download_url: 'https://example.com/Ester-Studio-v2.0.3-source-code.zip',
              },
            ],
          },
          {
            tag_name: 'v2.0.2',
            name: 'Ester Studio 2.0.2',
            published_at: '2026-11-05T03:45:53Z',
            body: '',
            assets: [],
          },
        ],
      });
      assert.equal(checkBefore.untrackedReleases.length, 1);
      assert.equal(checkBefore.untrackedReleases[0].version, 'v2.0.3');

      // 4. Construct a history-less v2.0.3 upstream source directory:
      // - Category A (pure upstream change): src/modeling/conformer.ts
      // - Category B (overlap with our macOS adaptation): desktop/runtime.cjs (upstream changed getTimeout at bottom)
      // - Category C (new upstream Windows-specific code): desktop/new-win-helper.cjs
      mkdirSync(join(upstreamV203Dir, 'desktop'), { recursive: true });
      mkdirSync(join(upstreamV203Dir, 'src/modeling'), { recursive: true });
      writeFileSync(
        join(upstreamV203Dir, 'package.json'),
        JSON.stringify({ name: 'ester-studio', version: '2.0.3' }, null, 2),
        'utf8',
      );
      writeFileSync(
        join(upstreamV203Dir, 'src/modeling/conformer.ts'),
        'export const conformerMode = "v2.0.3-alpb-12-presets";\n',
        'utf8',
      );
      writeFileSync(
        join(upstreamV203Dir, 'desktop/runtime.cjs'),
        [
          '// Line 1: header',
          'function resolveEngine() {',
          "  return 'engine.exe';",
          '}',
          '// Line 5: middle spacer',
          '// Line 6: middle spacer',
          '// Line 7: middle spacer',
          '// Line 8: middle spacer',
          'function getTimeout() {',
          '  return 15000;',
          '}',
          'module.exports = { resolveEngine, getTimeout };',
        ].join('\n') + '\n',
        'utf8',
      );
      writeFileSync(
        join(upstreamV203Dir, 'desktop/new-win-helper.cjs'),
        "const { spawn } = require('node:child_process');\nfunction runTool() { return spawn('tool.exe', []); }\n",
        'utf8',
      );

      // 5. Import v2.0.3 snapshot without switching away from main
      const importRes = importUpstreamSnapshot({
        cwd: repoDir,
        version: 'v2.0.3',
        sourcePath: upstreamV203Dir,
      });
      assert.equal(importRes.ok, true);
      assert.equal(importRes.upstreamTag, 'upstream/v2.0.3');
      assert.equal(git(['symbolic-ref', '--short', 'HEAD'], repoDir), 'main');

      const tags = listLocalUpstreamTags(repoDir).map((t) => t.tag);
      assert.deepEqual(tags, ['upstream/v2.0.2', 'upstream/v2.0.3']);

      // 6. Analyze 3-way delta between upstream/v2.0.3 and main
      const analysis = analyzeUpstreamDelta({ cwd: repoDir, version: 'v2.0.3', ourRef: 'main' });
      assert.equal(analysis.ok, true);
      assert.equal(analysis.mergeBase, baseCommit);

      const catAFiles = analysis.categoryA_upstreamOnly.map((i) => i.file);
      assert.ok(catAFiles.includes('src/modeling/conformer.ts'));
      assert.ok(catAFiles.includes('desktop/new-win-helper.cjs'));

      const catBFiles = analysis.categoryB_overlap.map((i) => i.file);
      assert.deepEqual(catBFiles, ['desktop/runtime.cjs']);

      assert.ok(
        analysis.categoryC_platformSensitive.some(
          (c) => c.file === 'desktop/new-win-helper.cjs' && /tool\.exe/.test(c.snippet),
        ),
      );

      // 7. Prepare 3-way merge branch (mac/upstream-v2.0.3) and verify BOTH our macOS adaptation
      // AND upstream's v2.0.3 update in desktop/runtime.cjs are preserved automatically!
      const mergePrep = prepareUpstreamMergeBranch({ cwd: repoDir, version: 'v2.0.3', ourRef: 'main' });
      assert.equal(mergePrep.ok, true);
      assert.equal(mergePrep.branch, 'mac/upstream-v2.0.3');
      assert.equal(mergePrep.cleanMerge, true);
      assert.deepEqual(mergePrep.conflictedFiles, []);

      const mergedRuntime = readFileSync(join(repoDir, 'desktop/runtime.cjs'), 'utf8');
      assert.match(mergedRuntime, /platform === 'win32' \? 'engine\.exe' : 'engine'/);
      assert.match(mergedRuntime, /return 15000;/);

      const mergedConformer = readFileSync(join(repoDir, 'src/modeling/conformer.ts'), 'utf8');
      assert.match(mergedConformer, /v2\.0\.3-alpb-12-presets/);

      // Our macOS-only file (scripts/release/package-macos.mjs) is also preserved
      const macPackagerContent = readFileSync(join(repoDir, 'scripts/release/package-macos.mjs'), 'utf8');
      assert.match(macPackagerContent, /macPackager = true/);

      // And ACTIVE_TASK.md on mac/upstream-v2.0.3 lists Category B and Category C items
      const activeTaskText = readFileSync(join(repoDir, 'ACTIVE_TASK.md'), 'utf8');
      assert.match(activeTaskText, /desktop\/runtime\.cjs/);
      assert.match(activeTaskText, /desktop\/new-win-helper\.cjs/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
