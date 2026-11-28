import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assistantSkillRoot,
  loadAssistantSkill,
  buildSkillZipBuffer,
  readSkillName,
} = require('../../desktop/mcp-assistant-skill.cjs');

test('assistantSkillRoot resolves dev, macOS/Linux packaged resourcesPath, and Windows portable harness fallback', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-skill-root-'));
  try {
    const devApp = path.join(tmp, 'repo');
    assert.equal(
      assistantSkillRoot({ packaged: false, appPath: devApp, resourcesPath: '/ignored' }),
      path.join(devApp, 'skills', 'ester-studio'),
    );

    const macResources = path.join(tmp, 'Lactone Studio.app', 'Contents', 'Resources');
    const macSkillDir = path.join(macResources, 'skills', 'ester-studio');
    await fs.mkdir(macSkillDir, { recursive: true });
    await fs.writeFile(path.join(macSkillDir, 'SKILL.md'), '# Skill\n', 'utf8');
    assert.equal(
      assistantSkillRoot({
        packaged: true,
        appPath: path.join(macResources, 'app'),
        resourcesPath: macResources,
      }),
      macSkillDir,
    );

    const winResources = path.join(tmp, 'win-portable', 'runtime', 'resources');
    assert.equal(
      assistantSkillRoot({
        packaged: true,
        appPath: path.join(winResources, 'app'),
        resourcesPath: winResources,
      }),
      path.resolve(winResources, '..', '..', 'harness', 'skills', 'ester-studio'),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('loadAssistantSkill and buildSkillZipBuffer package bundled Ester Studio skill chapters cleanly', async () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const skillDir = assistantSkillRoot({ packaged: false, appPath: repoRoot, resourcesPath: repoRoot });

  const loaded = await loadAssistantSkill(skillDir);
  assert.equal(loaded.tool.name, readSkillName);
  assert.ok(loaded.tool.parameters.properties.chapter.enum.includes('references/modeling.md'));

  const modelingChapter = await loaded.read({ chapter: 'references/modeling.md' }, new AbortController().signal);
  assert.equal(modelingChapter.chapter, 'references/modeling.md');
  assert.ok(modelingChapter.content.length > 0);

  const zipBytes = await buildSkillZipBuffer(skillDir);
  assert.equal(zipBytes.subarray(0, 4).toString('binary'), 'PK\x03\x04');

  if (process.platform === 'darwin') {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-skill-zip-'));
    try {
      const zipFile = path.join(tmp, 'ester-studio-skill.zip');
      const extractDir = path.join(tmp, 'out');
      await fs.writeFile(zipFile, zipBytes);
      execFileSync('/usr/bin/ditto', ['-x', '-k', zipFile, extractDir], { stdio: 'pipe' });
      const extractedSkill = await fs.readFile(path.join(extractDir, 'ester-studio', 'SKILL.md'), 'utf8');
      const originalSkill = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
      assert.equal(extractedSkill, originalSkill);
      const extractedChapter = await fs.readFile(
        path.join(extractDir, 'ester-studio', 'references', 'modeling.md'),
        'utf8',
      );
      assert.equal(extractedChapter, modelingChapter.content);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
});

test('loadAssistantSkill and buildSkillZipBuffer enforce symlink, traversal, and chapter validation guards', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-skill-sec-'));
  try {
    // 1. Reject traversal, unknown chapters, and extra keys in loaded.read()
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const skillDir = assistantSkillRoot({ packaged: false, appPath: repoRoot, resourcesPath: repoRoot });
    const loaded = await loadAssistantSkill(skillDir);

    await assert.rejects(
      () => loaded.read({ chapter: '../package.json' }, new AbortController().signal),
      { code: 'invalid_arguments' },
    );
    await assert.rejects(
      () => loaded.read({ chapter: 'references/nonexistent.md' }, new AbortController().signal),
      { code: 'invalid_arguments' },
    );
    await assert.rejects(
      () => loaded.read({ chapter: 'references/modeling.md', extra: true }, new AbortController().signal),
      { code: 'invalid_arguments' },
    );

    // 2. Reject SKILL.md without valid chapter links
    const noChaptersDir = path.join(tmp, 'no-chapters');
    await fs.mkdir(noChaptersDir, { recursive: true });
    await fs.writeFile(path.join(noChaptersDir, 'SKILL.md'), '# Empty guide without links\n', 'utf8');
    await assert.rejects(() => loadAssistantSkill(noChaptersDir), /没有有效的章节链接/);

    // 3. Reject missing referenced chapter file on read with assistant_skill_unavailable
    const missingRefDir = path.join(tmp, 'missing-ref');
    await fs.mkdir(path.join(missingRefDir, 'references'), { recursive: true });
    await fs.writeFile(path.join(missingRefDir, 'SKILL.md'), '- [Model](references/modeling.md)\n', 'utf8');
    const missingRefLoaded = await loadAssistantSkill(missingRefDir);
    await assert.rejects(
      () => missingRefLoaded.read({ chapter: 'references/modeling.md' }, new AbortController().signal),
      { code: 'assistant_skill_unavailable' },
    );
    await assert.rejects(() => buildSkillZipBuffer(missingRefDir), { code: 'ENOENT' });

    if (process.platform !== 'win32') {
      // 4. Reject symlinked SKILL.md
      const secretFile = path.join(tmp, 'secret.md');
      await fs.writeFile(secretFile, '- [Secret](references/modeling.md)\n', 'utf8');
      const symSkillDir = path.join(tmp, 'sym-skill');
      await fs.mkdir(symSkillDir, { recursive: true });
      await fs.symlink(secretFile, path.join(symSkillDir, 'SKILL.md'));
      await assert.rejects(() => loadAssistantSkill(symSkillDir), /需要目录内的常规文件/);
      await assert.rejects(() => buildSkillZipBuffer(symSkillDir), /需要目录内的常规文件/);

      // 5. Reject symlinked chapter file
      const symChapterDir = path.join(tmp, 'sym-chapter');
      await fs.mkdir(path.join(symChapterDir, 'references'), { recursive: true });
      await fs.writeFile(path.join(symChapterDir, 'SKILL.md'), '- [Model](references/modeling.md)\n', 'utf8');
      await fs.symlink(secretFile, path.join(symChapterDir, 'references', 'modeling.md'));
      const symChapterLoaded = await loadAssistantSkill(symChapterDir);
      await assert.rejects(
        () => symChapterLoaded.read({ chapter: 'references/modeling.md' }, new AbortController().signal),
        { code: 'assistant_skill_unavailable' },
      );
      await assert.rejects(() => buildSkillZipBuffer(symChapterDir), /需要目录内的常规文件/);

      // 6. Reject symlinked skill root directory
      const realTargetDir = path.join(tmp, 'real-dir');
      await fs.mkdir(realTargetDir, { recursive: true });
      await fs.writeFile(path.join(realTargetDir, 'SKILL.md'), '- [Model](references/modeling.md)\n', 'utf8');
      const symRootDir = path.join(tmp, 'sym-root');
      await fs.symlink(realTargetDir, symRootDir);
      await assert.rejects(() => loadAssistantSkill(symRootDir), /随包指南目录不可用/);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
