import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isProtectedBranch,
  isRunnableTestFile,
  extractModuleSpecifiers,
  doesTestFileMatchCodeFile,
  classifyChangedFiles,
  checkTestCoveragePolicy,
  checkPreCommitPolicy,
  checkPreMergePolicy,
} from '../../scripts/workflow/branch-policy.mjs';

describe('branch-policy unit tests', () => {
  it('identifies protected primary branches correctly', () => {
    assert.equal(isProtectedBranch('main'), true);
    assert.equal(isProtectedBranch('master'), true);
    assert.equal(isProtectedBranch('feat/mac-port'), false);
    assert.equal(isProtectedBranch('mac/process-identity'), false);
    assert.equal(isProtectedBranch('fix/ssh-path'), false);
  });

  it('only accepts runnable test files located inside tests/', () => {
    assert.equal(isRunnableTestFile('tests/workflow/branch-policy.test.mjs'), true);
    assert.equal(isRunnableTestFile('tests/unit/parser.test.ts'), true);
    assert.equal(isRunnableTestFile('src/core/atom.spec.ts'), false);
    assert.equal(isRunnableTestFile('desktop/runtime.test.mjs'), false);
    assert.equal(isRunnableTestFile('tests/README.md'), false);
    assert.equal(isRunnableTestFile('tests/fixtures/sample.json'), false);
  });

  it('classifies code files, runnable test files, misplaced test files, and docs accurately', () => {
    const result = classifyChangedFiles([
      'src/core/molecule.ts',
      'src/modeling/中文分子建模.ts',
      'src/core/atom.spec.ts',
      'desktop/runtime.cjs',
      'scripts/workflow/branch-policy.mjs',
      'tests/workflow/branch-policy.test.mjs',
      'tests/README.md',
      'AGENTS.md',
    ]);

    assert.deepEqual(result.codeFiles, [
      'src/core/molecule.ts',
      'src/modeling/中文分子建模.ts',
      'src/core/atom.spec.ts',
      'desktop/runtime.cjs',
      'scripts/workflow/branch-policy.mjs',
    ]);
    assert.deepEqual(result.misplacedTestFiles, ['src/core/atom.spec.ts']);
    assert.deepEqual(result.testFiles, ['tests/workflow/branch-policy.test.mjs']);
    assert.deepEqual(result.otherFiles, ['tests/README.md', 'AGENTS.md']);
  });

  it('verifies module-to-test mapping and rejects unrelated or misplaced test files', () => {
    assert.equal(
      doesTestFileMatchCodeFile('desktop/xtb-runtime.cjs', 'tests/workflow/branch-policy.test.mjs'),
      false
    );
    assert.equal(
      doesTestFileMatchCodeFile('desktop/xtb-runtime.cjs', 'tests/desktop/xtb-runtime.test.ts'),
      true
    );
    assert.equal(
      doesTestFileMatchCodeFile('scripts/workflow/run-tests.mjs', 'tests/workflow/git-hooks-integration.test.mjs'),
      true
    );

    // Changing desktop/xtb-runtime.cjs with an unrelated workflow test must be rejected
    const unrelatedTest = checkTestCoveragePolicy({
      changedFiles: ['desktop/xtb-runtime.cjs', 'tests/workflow/branch-policy.test.mjs'],
    });
    assert.equal(unrelatedTest.ok, false);
    assert.equal(unrelatedTest.code, 'UNMATCHED_TESTS_FOR_CODE_CHANGES');
    assert.deepEqual(unrelatedTest.uncoveredCodeFiles, ['desktop/xtb-runtime.cjs']);

    // Misplaced test file under src/ must be rejected
    const misplaced = checkTestCoveragePolicy({
      changedFiles: ['src/core/atom.ts', 'src/core/atom.spec.ts'],
    });
    assert.equal(misplaced.ok, false);
    assert.equal(misplaced.code, 'MISPLACED_TEST_FILES');

    // Matching test under tests/ passes
    const matched = checkTestCoveragePolicy({
      changedFiles: ['desktop/xtb-runtime.cjs', 'tests/desktop/xtb-runtime.test.ts'],
    });
    assert.equal(matched.ok, true);
    assert.equal(matched.code, 'OK');
  });

  it('enforces branch commit policy (rejects direct commit to main unless initial commit)', () => {
    const mainDirect = checkPreCommitPolicy({
      branch: 'main',
      hasHeadCommit: true,
      allowInitialMainCommit: false,
      changedFiles: ['src/core/atom.ts', 'tests/core/atom.test.ts'],
    });
    assert.equal(mainDirect.ok, false);
    assert.equal(mainDirect.code, 'DIRECT_MAIN_COMMIT_NOT_ALLOWED');

    const featureBranch = checkPreCommitPolicy({
      branch: 'feat/chemistry-engine',
      hasHeadCommit: true,
      changedFiles: ['src/core/atom.ts', 'tests/core/atom.test.ts'],
    });
    assert.equal(featureBranch.ok, true);

    // Initial commit allowed if flag set and no head commit
    const initialCommit = checkPreCommitPolicy({
      branch: 'main',
      hasHeadCommit: false,
      allowInitialMainCommit: true,
      changedFiles: ['README.md'],
    });
    assert.equal(initialCommit.ok, true);
  });

  it('enforces pre-merge check policy for protected branches', () => {
    const failedMerge = checkPreMergePolicy({
      targetBranch: 'main',
      testsPassed: false,
    });
    assert.equal(failedMerge.ok, false);
    assert.equal(failedMerge.code, 'TESTS_FAILED');

    const passedMerge = checkPreMergePolicy({
      targetBranch: 'main',
      testsPassed: true,
    });
    assert.equal(passedMerge.ok, true);
  });
});
