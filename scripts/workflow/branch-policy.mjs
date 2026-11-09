/**
 * Core branch protection and test coverage verification policy.
 * Pure functions exported for unit testing and used by Git hooks & workflow CLI scripts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROTECTED_BRANCHES = Object.freeze(['main', 'master', 'upstream/release']);

const CODE_PATH_PATTERNS = [
  /^src\//,
  /^desktop\//,
  /^scripts\//,
];

// According to AGENTS.md, runnable test files must reside under `tests/`
const TESTS_DIR_RUNNABLE_PATTERN = /^tests\/(?:.+\/)?[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ANY_TEST_SUFFIX_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

const NON_CODE_ASSET_EXTENSIONS = [
  '.md',
  '.txt',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.json',
];

/**
 * Normalize a relative repository path to forward slashes.
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeRepoPath(filePath) {
  return String(filePath || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
}

/**
 * Check whether a relative file path is a runnable test file located under `tests/`.
 * Non-test files inside `tests/` (such as `tests/README.md`) or test files outside `tests/`
 * (such as `src/core/atom.spec.ts`) return false.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isRunnableTestFile(filePath) {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized) return false;
  return TESTS_DIR_RUNNABLE_PATTERN.test(normalized);
}

/**
 * Extract the base stem of a code or test file (stripping `.test.*`, `.spec.*`, and extension).
 * @param {string} filePath
 * @returns {string}
 */
export function extractFileStem(filePath) {
  const normalized = normalizeRepoPath(filePath);
  const baseName = normalized.split('/').pop() || '';
  return baseName
    .replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/i, '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase();
}

const GENERIC_FILE_STEMS = new Set([
  'index',
  'types',
  'utils',
  'common',
  'constants',
  'helpers',
  'protocol',
]);

const REPO_SUBSYSTEM_DIRS = new Set([
  'src',
  'desktop',
  'scripts',
  'core',
  'web',
  'modeling',
  'results',
  'task-system',
  'projects',
  'citations',
  'chemistry',
  'ocr',
  'packaging',
  'workflow',
  'upstream',
  'release',
  'solvents',
  'two-d',
  'engines',
  'execution',
  'transports',
]);

/**
 * Simple module specifier extraction from JS/TS source code.
 * @param {string} source
 * @returns {string[]}
 */
export function extractModuleSpecifiers(source) {
  const specifiers = new Set();
  const text = String(source || '');

  // Match import ... from '...'
  const fromRegex = /(?:import|export)\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = fromRegex.exec(text)) !== null) {
    specifiers.add(match[1]);
  }

  // Match import('...') or require('...')
  const callRegex = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = callRegex.exec(text)) !== null) {
    specifiers.add(match[1]);
  }

  // Match import '...'
  const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g;
  while ((match = sideEffectRegex.exec(text)) !== null) {
    specifiers.add(match[1]);
  }

  return Array.from(specifiers);
}

/**
 * Check whether a test file imports a specific code file.
 * @param {string} testFilePath
 * @param {string} codeFilePath
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function doesTestFileImportCodeFile(testFilePath, codeFilePath, cwd = process.cwd()) {
  const fullTestPath = join(cwd, normalizeRepoPath(testFilePath));
  if (!existsSync(fullTestPath)) return false;

  try {
    const content = readFileSync(fullTestPath, 'utf8');
    const specifiers = extractModuleSpecifiers(content);
    const codeStem = extractFileStem(codeFilePath);
    const normalizedCodePath = normalizeRepoPath(codeFilePath);
    const codePathWithoutExt = normalizedCodePath.replace(/\.[^.]+$/, '');

    for (const spec of specifiers) {
      const cleanSpec = spec.replace(/^\.\//, '').replace(/\.[^.]+$/, '');
      if (cleanSpec.endsWith(codePathWithoutExt) || cleanSpec.endsWith(`/${codeStem}`) || cleanSpec === codeStem) {
        return true;
      }
    }
  } catch {
    // ignore read errors
  }
  return false;
}

/**
 * Determine whether a test file matches a changed code file.
 * Matches by explicit import, matching file stem, or matching directory subsystem.
 * @param {string} codeFilePath
 * @param {string} testFilePath
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function doesTestFileMatchCodeFile(codeFilePath, testFilePath, cwd = process.cwd()) {
  const normCode = normalizeRepoPath(codeFilePath);
  const normTest = normalizeRepoPath(testFilePath);

  if (!isRunnableTestFile(normTest)) return false;

  // 1. Direct or relative import match
  if (doesTestFileImportCodeFile(normTest, normCode, cwd)) {
    return true;
  }

  const codeStem = extractFileStem(normCode);
  const testStem = extractFileStem(normTest);

  // If generic stem (like index.ts), ensure the parent directory or subsystem matches
  if (GENERIC_FILE_STEMS.has(codeStem)) {
    const codeDirParts = normCode.split('/').slice(0, -1);
    const testDirParts = normTest.split('/').slice(0, -1);
    const lastCodeDir = codeDirParts[codeDirParts.length - 1];
    return testDirParts.includes(lastCodeDir) && testStem === lastCodeDir;
  }

  // 2. Exact or substring stem match (e.g. branch-policy.mjs -> branch-policy.test.mjs)
  if (testStem === codeStem || testStem.includes(codeStem) || codeStem.includes(testStem)) {
    return true;
  }

  // 3. Workflow scripts matched by git-hooks-integration or workflow tests
  if (normCode.startsWith('scripts/workflow/') && normTest.startsWith('tests/workflow/')) {
    return true;
  }

  // 4. Subsystem directory match
  const codeParts = normCode.split('/');
  const testParts = normTest.split('/');
  for (const part of codeParts) {
    if (REPO_SUBSYSTEM_DIRS.has(part) && testParts.includes(part)) {
      return true;
    }
  }

  return false;
}

/**
 * Classify a list of repository-relative paths into code, runnable tests, misplaced tests, and others.
 * @param {string[]} files
 */
export function classifyChangedFiles(files) {
  const codeFiles = [];
  const testFiles = [];
  const misplacedTestFiles = [];
  const otherFiles = [];

  for (const file of files) {
    const normalized = normalizeRepoPath(file);
    if (!normalized) continue;

    if (isRunnableTestFile(normalized)) {
      testFiles.push(normalized);
      continue;
    }

    if (ANY_TEST_SUFFIX_PATTERN.test(normalized) && !normalized.startsWith('tests/')) {
      misplacedTestFiles.push(normalized);
      codeFiles.push(normalized);
      continue;
    }

    const isCodePath = CODE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
    const isNonCodeAsset = NON_CODE_ASSET_EXTENSIONS.some((ext) =>
      normalized.toLowerCase().endsWith(ext)
    );

    if (isCodePath && !isNonCodeAsset) {
      codeFiles.push(normalized);
    } else {
      otherFiles.push(normalized);
    }
  }

  return { codeFiles, testFiles, misplacedTestFiles, otherFiles };
}

/**
 * Verify that all changed code files are covered by at least one test file in the changeset.
 * @param {{ changedFiles: string[], cwd?: string }} params
 */
export function checkTestCoveragePolicy({ changedFiles, cwd = process.cwd() }) {
  const { codeFiles, testFiles, misplacedTestFiles } = classifyChangedFiles(changedFiles);

  if (misplacedTestFiles.length > 0) {
    return {
      ok: false,
      code: 'MISPLACED_TEST_FILES',
      message: `发现放置在 tests/ 目录之外的测试文件：${misplacedTestFiles.join(', ')}。根据规范，所有自动化测试必须位于 tests/ 目录下。`,
      misplacedTestFiles,
    };
  }

  if (codeFiles.length === 0) {
    return { ok: true, code: 'OK', message: '无业务代码变更，无需强制新增测试用例。' };
  }

  if (testFiles.length === 0) {
    return {
      ok: false,
      code: 'MISSING_TEST_FILES',
      message: `检测到修改了代码文件（${codeFiles.slice(0, 3).join(', ')}${codeFiles.length > 3 ? '等' : ''}），但暂存区未包含 tests/ 下的自动化测试用例。根据规范：无测试不提交。`,
      uncoveredCodeFiles: codeFiles,
    };
  }

  const uncoveredCodeFiles = [];
  for (const codeFile of codeFiles) {
    const matched = testFiles.some((testFile) =>
      doesTestFileMatchCodeFile(codeFile, testFile, cwd)
    );
    if (!matched) {
      uncoveredCodeFiles.push(codeFile);
    }
  }

  if (uncoveredCodeFiles.length > 0) {
    return {
      ok: false,
      code: 'UNMATCHED_TESTS_FOR_CODE_CHANGES',
      message: `以下修改的代码文件未找到匹配的测试用例：${uncoveredCodeFiles.join(', ')}。请在 tests/ 下补充对应测试。`,
      uncoveredCodeFiles,
    };
  }

  return { ok: true, code: 'OK', message: '所有代码变更均有对应的测试覆盖。' };
}

/**
 * Check whether a branch name is protected against direct commits.
 * @param {string} branchName
 * @returns {boolean}
 */
export function isProtectedBranch(branchName) {
  const clean = String(branchName || '').trim();
  return PROTECTED_BRANCHES.includes(clean);
}

/**
 * Validate pre-commit policy:
 * - Reject direct commits to main/master (unless ALLOW_INITIAL_MAIN_COMMIT is set for empty repo)
 * - Require test files when code is modified
 * @param {object} params
 */
export function checkPreCommitPolicy({
  branch,
  isMergeInProgress = false,
  allowInitialMainCommit = false,
  allowSystemResetCommit = false,
  hasHeadCommit = true,
  changedFiles = [],
  cwd = process.cwd(),
}) {
  if (isProtectedBranch(branch)) {
    if (!hasHeadCommit && allowInitialMainCommit) {
      return { ok: true, code: 'OK', message: '允许首次初始提交到主分支。' };
    }
    if (allowSystemResetCommit) {
      return { ok: true, code: 'OK', message: '允许系统自动重置任务规格说明书。' };
    }
    if (isMergeInProgress) {
      return { ok: true, code: 'OK', requiresMergeGateCheck: true };
    }
    return {
      ok: false,
      code: 'DIRECT_MAIN_COMMIT_NOT_ALLOWED',
      message: `严禁在受保护的主分支 (${branch}) 直接提交代码！请从 ${branch} 切出新分支（如 mac/*, feat/*, fix/*）后再提交。`,
    };
  }

  return checkTestCoveragePolicy({ changedFiles, cwd });
}

/**
 * Validate pre-merge policy for protected branches:
 * - Must pass unit tests
 * @param {object} params
 */
export function checkPreMergePolicy({
  targetBranch,
  testsPassed = false,
}) {
  if (isProtectedBranch(targetBranch)) {
    if (!testsPassed) {
      return {
        ok: false,
        code: 'TESTS_FAILED',
        message: '合并被拦截：单元测试未全部通过，请修复测试后再尝试合并。',
      };
    }
  }

  return { ok: true, code: 'OK', message: '合并前检查通过。' };
}
