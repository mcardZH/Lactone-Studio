import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
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
  buildReviewPrompt,
  runCodexReview,
  MAX_REVIEW_ATTEMPTS,
  readReviewState,
} from '../../scripts/workflow/codex-review.mjs';
import { createCleanTestChildEnv } from '../../scripts/workflow/run-tests.mjs';
import { mergeBranchToMain } from '../../scripts/workflow/merge-to-main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function git(args, cwd, env = process.env) {
  const cleanEnv = createCleanTestChildEnv(env);
  return execFileSync('git', args, { cwd, env: cleanEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('ACTIVE_TASK and codex-review workflow tests', () => {
  it('validates ACTIVE_TASK.md content correctly and handles reset', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'active-task-test-'));
    try {
      // 1. Missing file
      const missingCheck = validateActiveTaskContent(tempDir);
      assert.equal(missingCheck.ok, false);
      assert.match(missingCheck.message, /不存在或内容为空/);

      // 2. Initial unmodified template
      resetActiveTask(tempDir);
      const templateContent = readActiveTask(tempDir);
      assert.equal(templateContent, INITIAL_ACTIVE_TASK_TEMPLATE);

      const uneditedCheck = validateActiveTaskContent(tempDir);
      assert.equal(uneditedCheck.ok, false);
      assert.match(uneditedCheck.message, /尚未填写有效任务名称/);

      // 3. Populated task without alignment section
      const taskFile = join(tempDir, ACTIVE_TASK_FILE_NAME);
      writeFileSync(taskFile, '# Task\n- **任务名称**：测试任务\n', 'utf8');
      const missingAlignCheck = validateActiveTaskContent(tempDir);
      assert.equal(missingAlignCheck.ok, false);
      assert.match(missingAlignCheck.message, /缺少“用户沟通与意图确认记录”章节/);

      // 4. Properly populated task
      writeFileSync(
        taskFile,
        '# Task\n- **任务名称**：测试任务\n## 5. 用户沟通与意图确认记录\n用户已确认需求。\n',
        'utf8'
      );
      const validCheck = validateActiveTaskContent(tempDir);
      assert.equal(validCheck.ok, true);

      // 5. Reset reverts to template
      resetActiveTask(tempDir);
      assert.equal(readActiveTask(tempDir), INITIAL_ACTIVE_TASK_TEMPLATE);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('buildReviewPrompt includes active task content, diff, and intent alignment criteria', () => {
    const prompt = buildReviewPrompt({
      branch: 'feat/test',
      activeTaskContent: '## 1. 任务概述\n- **任务名称**：开发新模块',
      changedFilesSummary: 'M src/index.ts',
      diffText: '+ const x = 1;',
      gitLogText: 'abc1234 feat: add x',
    });

    assert.match(prompt, /开发新模块/);
    assert.match(prompt, /M src\/index\.ts/);
    assert.match(prompt, /\+ const x = 1;/);
    assert.match(prompt, /严格范围边界（核心铁律，严禁无限扩大范围）/);
    assert.match(prompt, /需求与意图符合度/);
    assert.match(prompt, /gpt-6\.1-terra/);
  });

  it('enforces review workflow, circuit breaker, and post-merge ACTIVE_TASK auto-reset', () => {
    const tempRepo = mkdtempSync(join(tmpdir(), 'ester-review-repo-'));
    const cleanEnv = createCleanTestChildEnv(process.env);

    try {
      // 1. Initialize repo
      git(['init', '-b', 'main'], tempRepo);
      git(['config', 'user.name', 'Tester'], tempRepo);
      git(['config', 'user.email', 'test@example.com'], tempRepo);

      // Copy scripts and initial structure
      cpSync(join(REPO_ROOT, 'scripts/workflow'), join(tempRepo, 'scripts/workflow'), { recursive: true });
      mkdirSync(join(tempRepo, 'tests'), { recursive: true });
      writeFileSync(
        join(tempRepo, 'tests/smoke.test.mjs'),
        "import test from 'node:test'; import assert from 'node:assert/strict'; test('smoke', () => assert.equal(1, 1));\n",
        'utf8'
      );
      resetActiveTask(tempRepo);

      git(['add', '.'], tempRepo);
      execFileSync('git', ['commit', '-m', 'chore: initial commit on main'], {
        cwd: tempRepo,
        env: { ...cleanEnv, ALLOW_INITIAL_MAIN_COMMIT: '1' },
        stdio: 'pipe',
      });

      // 2. Checkout feature branch
      git(['checkout', '-b', 'feat/login-module'], tempRepo);

      // 3. Review should fail if ACTIVE_TASK.md is still blank template
      const emptyReview = runCodexReview({ cwd: tempRepo, env: cleanEnv });
      assert.equal(emptyReview.ok, false);
      assert.equal(emptyReview.error, 'INVALID_ACTIVE_TASK');

      // 4. Fill ACTIVE_TASK.md with valid spec
      const taskFile = join(tempRepo, ACTIVE_TASK_FILE_NAME);
      writeFileSync(
        taskFile,
        [
          '# 当前开发任务规格说明书',
          '## 1. 任务概述',
          '- **任务名称**：登录模块开发',
          '- **目标概要**：实现用户认证',
          '## 5. 用户沟通与意图确认记录',
          '- 用户已确认本次需求。',
        ].join('\n'),
        'utf8'
      );
      git(['add', ACTIVE_TASK_FILE_NAME], tempRepo);
      git(['commit', '-m', 'docs: specify task in ACTIVE_TASK.md'], tempRepo);

      // 5. Test review failure loop & circuit breaker (3 attempts)
      const failEnv = { ...cleanEnv, MOCK_CODEX_VERDICT: 'FAIL' };

      const attempt1 = runCodexReview({ cwd: tempRepo, env: failEnv });
      assert.equal(attempt1.ok, false);
      assert.equal(attempt1.attempts, 1);

      const attempt2 = runCodexReview({ cwd: tempRepo, env: failEnv });
      assert.equal(attempt2.ok, false);
      assert.equal(attempt2.attempts, 2);

      const attempt3 = runCodexReview({ cwd: tempRepo, env: failEnv });
      assert.equal(attempt3.ok, false);
      assert.equal(attempt3.error, 'CIRCUIT_BREAKER_TRIGGERED');
      assert.equal(attempt3.attempts, 3);

      // 6. Test review pass
      const passEnv = { ...cleanEnv, MOCK_CODEX_VERDICT: 'PASS' };
      // Reset attempts by switching to fresh attempt count simulation
      const passReview = runCodexReview({ cwd: tempRepo, env: passEnv });
      // When circuit breaker is already active, it rejects; so we verify state handling
      assert.equal(passReview.error, 'CIRCUIT_BREAKER_TRIGGERED');

      // Now reset state for successful branch review
      const stateFile = join(tempRepo, '.git/codex-review-state.json');
      writeFileSync(stateFile, JSON.stringify({ attempts: 0, branch: 'feat/login-module' }), 'utf8');

      const passAfterFix = runCodexReview({ cwd: tempRepo, env: passEnv });
      assert.equal(passAfterFix.ok, true);
      assert.equal(passAfterFix.verdict, 'PASS');
      assert.ok(passAfterFix.receipt);

      // 7. Verify merge to main and automatic ACTIVE_TASK.md reset
      const mergeRes = mergeBranchToMain({
        branch: 'feat/login-module',
        cwd: tempRepo,
        confirmed: true,
      });
      assert.equal(mergeRes.ok, true);

      // On main, ACTIVE_TASK.md must have been reset to template automatically
      const mainActiveTask = readActiveTask(tempRepo);
      assert.equal(mainActiveTask, INITIAL_ACTIVE_TASK_TEMPLATE);
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });
});
