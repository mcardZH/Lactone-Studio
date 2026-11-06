import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installGitHooks } from '../../scripts/workflow/install-hooks.mjs';
import { createCleanTestChildEnv } from '../../scripts/workflow/run-tests.mjs';
import { mergeBranchToMain } from '../../scripts/workflow/merge-to-main.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function git(args, cwd, env = process.env) {
  const cleanEnv = createCleanTestChildEnv(env);
  return execFileSync('git', args, { cwd, env: cleanEnv, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('git hooks integration tests', () => {
  it('installs hooks and verifies git config', () => {
    const tempRepo = mkdtempSync(join(tmpdir(), 'ester-install-test-'));
    try {
      git(['init', '-b', 'main'], tempRepo);
      mkdirSync(join(tempRepo, '.githooks'), { recursive: true });
      writeFileSync(join(tempRepo, '.githooks/pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
      writeFileSync(join(tempRepo, '.githooks/pre-merge-commit'), '#!/bin/sh\nexit 0\n', 'utf8');

      installGitHooks(tempRepo);

      const configuredHooks = git(['config', '--get', 'core.hooksPath'], tempRepo);
      assert.equal(configuredHooks, '.githooks');
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('enforces branch isolation, test coverage, and pre-commit checks in sandbox repository', () => {
    const tempRepo = mkdtempSync(join(tmpdir(), 'ester-sandbox-repo-'));
    const cleanEnv = createCleanTestChildEnv(process.env);

    try {
      // 1. Initialize git repo
      git(['init', '-b', 'main'], tempRepo);
      git(['config', 'user.name', 'Test Committer'], tempRepo);
      git(['config', 'user.email', 'test@example.com'], tempRepo);

      // Copy workflow scripts & hooks into sandbox
      cpSync(join(REPO_ROOT, 'scripts/workflow'), join(tempRepo, 'scripts/workflow'), {
        recursive: true,
      });
      cpSync(join(REPO_ROOT, '.githooks'), join(tempRepo, '.githooks'), {
        recursive: true,
      });
      mkdirSync(join(tempRepo, 'tests'), { recursive: true });
      writeFileSync(
        join(tempRepo, 'tests/smoke.test.mjs'),
        "import test from 'node:test'; import assert from 'node:assert/strict'; test('smoke', () => assert.equal(1, 1));\n",
        'utf8'
      );

      // Install hooks
      installGitHooks(tempRepo);

      // Initial commit on main using ALLOW_INITIAL_MAIN_COMMIT=1
      git(['add', '.'], tempRepo);
      const initialCommitEnv = { ...cleanEnv, ALLOW_INITIAL_MAIN_COMMIT: '1' };
      execFileSync('git', ['commit', '-m', 'chore: initial commit'], {
        cwd: tempRepo,
        env: initialCommitEnv,
        stdio: 'pipe',
      });

      // 2. Direct commit to main must be rejected
      writeFileSync(join(tempRepo, 'test-doc.md'), '# Title\n', 'utf8');
      git(['add', 'test-doc.md'], tempRepo);

      let directCommitFailed = false;
      try {
        execFileSync('git', ['commit', '-m', 'docs: direct commit to main'], {
          cwd: tempRepo,
          env: cleanEnv,
          stdio: 'pipe',
        });
      } catch (err) {
        directCommitFailed = true;
        const output = String(err.stderr || '') + String(err.stdout || '');
        assert.match(output, /严禁在受保护的主分支 \(main\) 直接提交代码/);
      }
      assert.equal(directCommitFailed, true, 'Direct commit to main must be rejected by pre-commit hook');

      // 3. Checkout feature branch
      git(['checkout', '-b', 'feat/add-calculator'], tempRepo);

      // 4. Modify code file without adding tests -> must be rejected
      mkdirSync(join(tempRepo, 'scripts'), { recursive: true });
      writeFileSync(join(tempRepo, 'scripts/calc.mjs'), 'export function add(a, b) { return a + b; }\n', 'utf8');
      git(['add', 'scripts/calc.mjs'], tempRepo);

      let missingTestFailed = false;
      try {
        execFileSync('git', ['commit', '-m', 'feat: add calc without test'], {
          cwd: tempRepo,
          env: cleanEnv,
          stdio: 'pipe',
        });
      } catch (err) {
        missingTestFailed = true;
        const output = String(err.stderr || '') + String(err.stdout || '');
        assert.match(output, /检测到修改了代码文件.*但暂存区未包含 tests\/ 下的自动化测试用例/);
      }
      assert.equal(missingTestFailed, true, 'Commit with code changes but no tests must be rejected');

      // 5. Add failing test -> must be rejected by pre-commit test runner
      writeFileSync(
        join(tempRepo, 'tests/calc.test.mjs'),
        "import test from 'node:test'; import assert from 'node:assert/strict'; test('calc fails', () => assert.equal(1, 2));\n",
        'utf8'
      );
      git(['add', 'tests/calc.test.mjs'], tempRepo);

      let failingTestCommitBlocked = false;
      try {
        execFileSync('git', ['commit', '-m', 'feat: add calc with failing test'], {
          cwd: tempRepo,
          env: cleanEnv,
          stdio: 'pipe',
        });
      } catch (err) {
        failingTestCommitBlocked = true;
        const output = String(err.stderr || '') + String(err.stdout || '');
        assert.match(output, /硬性单元测试未通过/);
      }
      assert.equal(failingTestCommitBlocked, true, 'Commit with failing tests must be rejected');

      // 6. Fix test -> commit must succeed
      writeFileSync(
        join(tempRepo, 'tests/calc.test.mjs'),
        "import test from 'node:test'; import assert from 'node:assert/strict'; test('calc passes', () => assert.equal(1, 1));\n",
        'utf8'
      );
      git(['add', 'tests/calc.test.mjs'], tempRepo);

      execFileSync('git', ['commit', '-m', 'feat: add calc with passing test'], {
        cwd: tempRepo,
        env: cleanEnv,
        stdio: 'pipe',
      });

      const headSubject = git(['log', '-1', '--format=%s'], tempRepo);
      assert.equal(headSubject, 'feat: add calc with passing test');

      // 7. Verify merge to main using merge-to-main script
      const mergeResult = mergeBranchToMain({
        branch: 'feat/add-calculator',
        cwd: tempRepo,
        confirmed: true,
      });
      assert.equal(mergeResult.ok, true, 'Branch should merge successfully when tests pass');

      const currentBranchAfterMerge = git(['symbolic-ref', '--short', 'HEAD'], tempRepo);
      assert.equal(currentBranchAfterMerge, 'main');
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });
});
