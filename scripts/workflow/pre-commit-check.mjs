import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPreCommitPolicy } from './branch-policy.mjs';
import { runTestSuite } from './run-tests.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

function git(args, cwd = ROOT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function splitNullSeparated(rawOutput) {
  return String(rawOutput || '')
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getGitDir(cwd = ROOT) {
  return resolve(cwd, git(['rev-parse', '--git-dir'], cwd).trim());
}

function getCurrentBranch(cwd = ROOT) {
  try {
    return git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd).trim();
  } catch {
    return 'HEAD';
  }
}

function hasExistingHeadCommit(cwd = ROOT) {
  try {
    git(['rev-parse', '--verify', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

function getStagedChangedFiles(cwd = ROOT) {
  return splitNullSeparated(
    git(['diff', '-z', '--cached', '--name-only', '--diff-filter=ACMR'], cwd)
  );
}

export function executePreCommitCheck({ cwd = ROOT, env = process.env } = {}) {
  const branch = getCurrentBranch(cwd);
  const gitDir = getGitDir(cwd);
  const isMergeInProgress = existsSync(join(gitDir, 'MERGE_HEAD'));
  const hasHeadCommit = hasExistingHeadCommit(cwd);
  const allowInitialMainCommit = env.ALLOW_INITIAL_MAIN_COMMIT === '1';
  const changedFiles = getStagedChangedFiles(cwd);

  const policy = checkPreCommitPolicy({
    branch,
    isMergeInProgress,
    allowInitialMainCommit,
    hasHeadCommit,
    changedFiles,
    cwd,
  });

  if (!policy.ok) {
    return policy;
  }

  // Run hard unit tests
  console.log('[pre-commit] 🧪 正在执行硬性单元测试套件...');
  const testResult = runTestSuite({ cwd, env });
  if (!testResult.ok) {
    return {
      ok: false,
      code: 'PRE_COMMIT_TESTS_FAILED',
      message: '提交前硬性单元测试未通过，请修复失败的测试用例后再提交。',
    };
  }

  return { ok: true, code: 'OK', message: '提交前所有检查通过。' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = executePreCommitCheck();
  if (!result.ok) {
    console.error(`\n❌ [pre-commit 拦截] ${result.message}\n`);
    process.exit(1);
  }
  console.log(`\n✅ [pre-commit 通过] ${result.message}\n`);
}
