import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readActiveTask,
  resetActiveTask,
  validateActiveTaskContent,
  INITIAL_ACTIVE_TASK_TEMPLATE,
  ACTIVE_TASK_FILE_NAME,
} from '../../scripts/workflow/active-task.mjs';
import {
  classifyRiskTier,
  prepareReviewPacket,
  recordReviewReceipt,
  recordReviewFailure,
  verifyReviewReceipt,
  writeReviewState,
} from '../../scripts/workflow/subagent-review.mjs';
import { createCleanTestChildEnv } from '../../scripts/workflow/run-tests.mjs';
import { mergeBranchToMain } from '../../scripts/workflow/merge-to-main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function git(args, cwd, env = process.env) {
  const cleanEnv = createCleanTestChildEnv(env);
  return execFileSync('git', args, { cwd, env: cleanEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('ACTIVE_TASK and multi-subagent review workflow tests', () => {
  it('verifies REVIEW.md and .agents/skills (code-review, pr-review-toolkit, upstream-sync) exist', () => {
    for (const relPath of [
      'REVIEW.md',
      '.agents/skills/code-review/SKILL.md',
      '.agents/skills/code-review/references/subagent-prompts.md',
      '.agents/skills/pr-review-toolkit/SKILL.md',
      '.agents/skills/pr-review-toolkit/references/specialist-personas.md',
      '.agents/skills/upstream-sync/SKILL.md',
    ]) {
      const fullPath = join(REPO_ROOT, relPath);
      assert.equal(existsSync(fullPath), true, `Expected ${relPath} to exist`);
      const text = readFileSync(fullPath, 'utf8');
      assert.ok(text.length > 100);
    }
  });

  it('validates ACTIVE_TASK.md content correctly and classifies Risk Tiers', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'active-task-test-'));
    try {
      const missingCheck = validateActiveTaskContent(tempDir);
      assert.equal(missingCheck.ok, false);
      assert.match(missingCheck.message, /不存在或内容为空/);

      resetActiveTask(tempDir);
      assert.equal(readActiveTask(tempDir), INITIAL_ACTIVE_TASK_TEMPLATE);
      assert.equal(validateActiveTaskContent(tempDir).ok, false);

      const taskFile = join(tempDir, ACTIVE_TASK_FILE_NAME);
      writeFileSync(
        taskFile,
        '# Task\n- **任务名称**：测试任务\n## 5. 用户沟通与意图确认记录\n用户已确认需求。\n',
        'utf8',
      );
      assert.equal(validateActiveTaskContent(tempDir).ok, true);

      assert.equal(classifyRiskTier(['docs/README.md', 'tests/foo.test.mjs']).riskTier, 'Tier 0 (Low)');
      assert.equal(classifyRiskTier(['src/web/App.tsx']).riskTier, 'Tier 1 (Medium)');
      assert.equal(classifyRiskTier(['desktop/main.cjs']).riskTier, 'Tier 2 (High)');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces subagent review packet preparation, SHA-256 receipt verification, 3-round circuit breaker, and post-merge ACTIVE_TASK reset', () => {
    const tempRepo = mkdtempSync(join(tmpdir(), 'ester-subagent-review-repo-'));
    const cleanEnv = createCleanTestChildEnv(process.env);

    try {
      git(['init', '-b', 'main'], tempRepo);
      git(['config', 'user.name', 'Tester'], tempRepo);
      git(['config', 'user.email', 'test@example.com'], tempRepo);

      cpSync(join(REPO_ROOT, 'scripts/workflow'), join(tempRepo, 'scripts/workflow'), { recursive: true });
      cpSync(join(REPO_ROOT, 'REVIEW.md'), join(tempRepo, 'REVIEW.md'));
      mkdirSync(join(tempRepo, 'tests'), { recursive: true });
      writeFileSync(
        join(tempRepo, 'tests/smoke.test.mjs'),
        "import test from 'node:test'; import assert from 'node:assert/strict'; test('smoke', () => assert.equal(1, 1));\n",
        'utf8',
      );
      resetActiveTask(tempRepo);

      git(['add', '.'], tempRepo);
      execFileSync('git', ['commit', '-m', 'chore: initial commit on main'], {
        cwd: tempRepo,
        env: { ...cleanEnv, ALLOW_INITIAL_MAIN_COMMIT: '1' },
        stdio: 'pipe',
      });

      git(['checkout', '-b', 'feat/login-module'], tempRepo);

      // 1. prepareReviewPacket should fail if ACTIVE_TASK.md is still blank template
      const emptyPrep = prepareReviewPacket({ cwd: tempRepo, env: cleanEnv });
      assert.equal(emptyPrep.ok, false);
      assert.equal(emptyPrep.error, 'INVALID_ACTIVE_TASK');

      // 2. Fill ACTIVE_TASK.md and add a feature file
      mkdirSync(join(tempRepo, 'src'), { recursive: true });
      writeFileSync(join(tempRepo, 'src/login.ts'), 'export const login = () => true;\n', 'utf8');
      writeFileSync(
        join(tempRepo, ACTIVE_TASK_FILE_NAME),
        [
          '# 当前开发任务规格说明书',
          '## 1. 任务概述',
          '- **任务名称**：登录模块开发',
          '## 5. 用户沟通与意图确认记录',
          '- 用户已确认本次需求。',
        ].join('\n'),
        'utf8',
      );
      git(['add', '.'], tempRepo);
      git(['commit', '-m', 'feat: add login module and task spec'], tempRepo);

      // 3. Prepare review packet succeeds and writes .git/ester-review-packet.md
      const prep = prepareReviewPacket({ cwd: tempRepo, env: cleanEnv });
      assert.equal(prep.ok, true);
      assert.equal(prep.riskTier, 'Tier 1 (Medium)');
      assert.equal(existsSync(prep.packetPath), true);
      const packetText = readFileSync(prep.packetPath, 'utf8');
      assert.match(packetText, /登录模块开发/);
      assert.match(packetText, /src\/login\.ts/);

      // 4. Test 3-round circuit breaker on failures
      const fail1 = recordReviewFailure({ cwd: tempRepo, summary: 'Round 1 fail' });
      assert.equal(fail1.attempts, 1);
      const fail2 = recordReviewFailure({ cwd: tempRepo, summary: 'Round 2 fail' });
      assert.equal(fail2.attempts, 2);
      const fail3 = recordReviewFailure({ cwd: tempRepo, summary: 'Round 3 fail' });
      assert.equal(fail3.attempts, 3);
      assert.equal(fail3.error, 'CIRCUIT_BREAKER_TRIGGERED');

      const blockedPrep = prepareReviewPacket({ cwd: tempRepo, env: cleanEnv, skipTests: true });
      assert.equal(blockedPrep.ok, false);
      assert.equal(blockedPrep.error, 'CIRCUIT_BREAKER_TRIGGERED');

      // 5. Reset circuit breaker state and verify merge is blocked without receipt
      writeReviewState({ attempts: 0, branch: 'feat/login-module', lastVerdict: null }, tempRepo);
      const mergeWithoutReceipt = mergeBranchToMain({
        branch: 'feat/login-module',
        cwd: tempRepo,
        confirmed: true,
      });
      assert.equal(mergeWithoutReceipt.ok, false);
      assert.equal(mergeWithoutReceipt.error, 'MISSING_OR_STALE_REVIEW_RECEIPT');

      // 6. Record valid receipt, then mutate a file to prove stale receipt detection
      const rec1 = recordReviewReceipt({
        cwd: tempRepo,
        summary: 'Summary: Blockers: 0 | Important: 0 | Nits: 0 | Risk Tier: Tier 1 (Medium)',
      });
      assert.equal(rec1.ok, true);
      assert.equal(verifyReviewReceipt(tempRepo).valid, true);

      writeFileSync(join(tempRepo, 'src/login.ts'), 'export const login = () => false;\n', 'utf8');
      const staleCheck = verifyReviewReceipt(tempRepo);
      assert.equal(staleCheck.valid, false);
      assert.match(staleCheck.reason, /复核收据已过期/);

      // Commit the change and re-record receipt
      git(['add', 'src/login.ts'], tempRepo);
      git(['commit', '-m', 'fix: update login return'], tempRepo);
      const rec2 = recordReviewReceipt({
        cwd: tempRepo,
        summary: 'Summary: Blockers: 0 | Important: 0 | Nits: 0 | Risk Tier: Tier 1 (Medium)',
      });
      assert.equal(rec2.ok, true);

      // 7. Merge to main succeeds and resets ACTIVE_TASK.md
      const mergeRes = mergeBranchToMain({
        branch: 'feat/login-module',
        cwd: tempRepo,
        confirmed: true,
      });
      assert.equal(mergeRes.ok, true);
      assert.equal(readActiveTask(tempRepo), INITIAL_ACTIVE_TASK_TEMPLATE);
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });
});
