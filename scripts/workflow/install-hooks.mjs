import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const REQUIRED_HOOKS = Object.freeze(['pre-commit', 'pre-merge-commit']);

export function installGitHooks(cwd = ROOT) {
  const hooksDir = join(cwd, '.githooks');
  for (const hookName of REQUIRED_HOOKS) {
    const hookPath = join(hooksDir, hookName);
    if (existsSync(hookPath)) {
      try {
        chmodSync(hookPath, 0o755);
      } catch {
        // ignore chmod errors on systems that do not support it
      }
    }
  }
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd, stdio: 'inherit' });
  execFileSync('git', ['config', 'merge.ff', 'false'], { cwd, stdio: 'inherit' });
  execFileSync('git', ['config', 'branch.main.mergeoptions', '--no-ff'], { cwd, stdio: 'inherit' });
  execFileSync('git', ['config', 'branch.master.mergeoptions', '--no-ff'], { cwd, stdio: 'inherit' });
  console.log('✅ 已配置 Git hooks (.githooks: pre-commit, pre-merge-commit) 并配置禁用 fast-forward 合并。');
}

export function verifyGitHooksInstalled(cwd = ROOT) {
  try {
    const configuredPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (configuredPath !== '.githooks') {
      return false;
    }
    const hooksDir = join(cwd, '.githooks');
    return REQUIRED_HOOKS.every((hookName) => existsSync(join(hooksDir, hookName)));
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  installGitHooks();
}
