import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const TEST_FILE_REGEX = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TS_TEST_REGEX = /\.(?:test|spec)\.[cm]?tsx?$/i;

/**
 * Create a clean environment for child test processes, stripping inherited Git hook
 * variables (`GITHEAD_*`, `GIT_DIR`, `GIT_INDEX_FILE`, etc.) and `NODE_TEST_CONTEXT`
 * so nested Git operations in integration tests are never polluted by outer hooks.
 * @param {NodeJS.ProcessEnv} baseEnv
 */
export function createCleanTestChildEnv(baseEnv = process.env) {
  const childEnv = { ...baseEnv };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.USER_CONFIRMED_MERGE;
  delete childEnv.ALLOW_INITIAL_MAIN_COMMIT;

  for (const key of Object.keys(childEnv)) {
    if (
      key.startsWith('GITHEAD_') ||
      key === 'GIT_DIR' ||
      key === 'GIT_WORK_TREE' ||
      key === 'GIT_INDEX_FILE' ||
      key === 'GIT_OBJECT_DIRECTORY' ||
      key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ||
      key === 'GIT_REFLOG_ACTION' ||
      key === 'GIT_PREFIX'
    ) {
      delete childEnv[key];
    }
  }

  return childEnv;
}

/**
 * Recursively discover all test files under a directory.
 * @param {string} dir
 * @param {string} rootDir
 * @returns {string[]}
 */
export function discoverTestFiles(dir = join(ROOT, 'tests'), rootDir = ROOT) {
  if (!existsSync(dir)) return [];
  const results = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) {
      results.push(...discoverTestFiles(fullPath, rootDir));
    } else if (info.isFile() && TEST_FILE_REGEX.test(entry)) {
      results.push(relative(rootDir, fullPath).replaceAll('\\', '/'));
    }
  }

  return results.sort();
}

/**
 * Run all discovered unit tests cleanly.
 * Dispatches *.test.{mjs,cjs,js} to native `node --test`
 * and *.test.{ts,tsx} to `vitest run` without any cross-mocking hacks.
 * @param {object} options
 */
export function runTestSuite({ cwd = ROOT, env = process.env, files = null } = {}) {
  const allTestFiles = files || discoverTestFiles(join(cwd, 'tests'), cwd);

  if (allTestFiles.length === 0) {
    console.error('[test-runner] ❌ 未在 tests/ 目录下找到任何测试用例文件！');
    return { ok: false, error: 'NO_TEST_FILES_FOUND', passed: 0, failed: 1 };
  }

  const nodeTestFiles = [];
  const vitestFiles = [];

  for (const file of allTestFiles) {
    if (TS_TEST_REGEX.test(file)) {
      vitestFiles.push(file);
    } else {
      nodeTestFiles.push(file);
    }
  }

  const childEnv = createCleanTestChildEnv(env);
  let allPassed = true;

  // 1. Run Node native test files
  if (nodeTestFiles.length > 0) {
    console.log(`[test-runner] 🚀 正在通过 Node.js 原生运行器执行 ${nodeTestFiles.length} 个测试文件...`);
    const nodeProc = spawnSync(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', '--test', ...nodeTestFiles],
      {
        cwd,
        env: childEnv,
        stdio: 'inherit',
      }
    );

    if (nodeProc.status !== 0) {
      allPassed = false;
      console.error(`[test-runner] ❌ Node.js 测试执行失败，退出码: ${nodeProc.status}`);
    }
  }

  // 2. Run Vitest files if any TypeScript test files are present
  if (vitestFiles.length > 0) {
    console.log(`[test-runner] ⚡ 正在通过 Vitest 执行 ${vitestFiles.length} 个 TypeScript/前端测试文件...`);
    const vitestBin = join(cwd, 'node_modules/vitest/vitest.mjs');
    const vitestProc = existsSync(vitestBin)
      ? spawnSync(process.execPath, [vitestBin, 'run', ...vitestFiles], {
          cwd,
          env: childEnv,
          stdio: 'inherit',
        })
      : spawnSync('npx', ['vitest', 'run', ...vitestFiles], {
          cwd,
          env: childEnv,
          stdio: 'inherit',
        });

    if (vitestProc.status !== 0) {
      allPassed = false;
      console.error(`[test-runner] ❌ Vitest 测试执行失败，退出码: ${vitestProc.status}`);
    }
  }

  if (allPassed) {
    console.log('[test-runner] ✅ 单元测试全部通过！');
    return { ok: true, totalFiles: allTestFiles.length };
  } else {
    return { ok: false, error: 'TESTS_FAILED', totalFiles: allTestFiles.length };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = runTestSuite();
  if (!result.ok) {
    process.exit(1);
  }
}
