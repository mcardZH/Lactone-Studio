import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTestSuite } from './run-tests.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function mergeBranchToMain({ branch, cwd = ROOT, confirmed = false } = {}) {
  if (!branch) {
    return { ok: false, error: 'NO_BRANCH_SPECIFIED', message: '请指定要合并到 main 的分支名。' };
  }

  // 1. Check working directory status
  const dirtyFiles = git(['status', '--porcelain'], cwd);
  if (dirtyFiles) {
    return {
      ok: false,
      error: 'DIRTY_WORKING_TREE',
      message: '工作区存在未提交的更改，请先提交或暂存后再尝试合并。',
    };
  }

  // 2. Run unit tests on current branch
  console.log(`[merge] 🧪 正在验证分支 ${branch} 的单元测试...`);
  const testResult = runTestSuite({ cwd });
  if (!testResult.ok) {
    return {
      ok: false,
      error: 'TESTS_FAILED',
      message: `分支 ${branch} 单元测试未通过，禁止合并。`,
    };
  }

  if (!confirmed) {
    return {
      ok: false,
      error: 'NOT_CONFIRMED',
      message: '合并需要用户确认。请添加 --confirmed 参数执行合并。',
    };
  }

  // 3. Switch to main and merge
  try {
    git(['checkout', 'main'], cwd);
    execFileSync('git', ['merge', '--no-ff', branch, '-m', `merge: merge branch '${branch}' into main`], {
      cwd,
      stdio: 'inherit',
    });
    console.log(`\n🎉 [merge] 分支 ${branch} 已成功安全合并到 main！\n`);
    return { ok: true, message: `分支 ${branch} 已合并到 main。` };
  } catch (err) {
    return {
      ok: false,
      error: 'MERGE_FAILED',
      message: `合并失败: ${err.message}`,
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const branch = args.find((arg) => !arg.startsWith('--'));
  const confirmed = args.includes('--confirmed');

  const result = mergeBranchToMain({ branch, confirmed });
  if (!result.ok) {
    console.error(`\n❌ [merge 错误] ${result.message}\n`);
    process.exit(1);
  }
}
