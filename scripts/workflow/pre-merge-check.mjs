import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPreMergePolicy } from './branch-policy.mjs';
import { runTestSuite } from './run-tests.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function getCurrentBranch(cwd = ROOT) {
  try {
    return git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd).trim();
  } catch {
    return 'HEAD';
  }
}

export function executePreMergeCheck({ cwd = ROOT, env = process.env } = {}) {
  const targetBranch = getCurrentBranch(cwd);

  console.log(`[pre-merge] 🧪 正在为分支 ${targetBranch} 执行合并前单元测试检查...`);
  const testResult = runTestSuite({ cwd, env });

  const policy = checkPreMergePolicy({
    targetBranch,
    testsPassed: testResult.ok,
  });

  return policy;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = executePreMergeCheck();
  if (!result.ok) {
    console.error(`\n❌ [pre-merge 拦截] ${result.message}\n`);
    process.exit(1);
  }
  console.log(`\n✅ [pre-merge 通过] ${result.message}\n`);
}
