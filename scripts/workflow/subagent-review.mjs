import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTIVE_TASK_FILE_NAME, readActiveTask, validateActiveTaskContent } from './active-task.mjs';
import { isProtectedBranch } from './branch-policy.mjs';
import { runTestSuite } from './run-tests.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
export const MAX_REVIEW_ATTEMPTS = 3;
export const DEFAULT_PACKET_FILE_NAME = 'ester-review-packet.md';
export const REVIEW_STATE_FILE_NAME = 'ester-review-state.json';
export const REVIEW_RECEIPT_FILE_NAME = 'ester-review-receipt.json';

const TIER2_RULES = [
  {
    pattern: /^desktop\/(main|preload|portable-.*)\.cjs$/,
    reason: 'Electron main process, preload bridge, or portable profile boundary',
  },
  {
    pattern: /^desktop\/(.*runtime.*|.*host.*)\.cjs$|^desktop\/(chemistry|packaging)\//,
    reason: 'Scientific Python/xTB/Multiwfn/OCR runtime or packaging lock contract',
  },
  {
    pattern: /^desktop\/task-system\//,
    reason: 'Task execution, SSH/Slurm scheduling, or process identity provider',
  },
  {
    pattern: /^(scripts\/(release|upstream|workflow)\/|\.agents\/|\.githooks\/|AGENTS\.md$|REVIEW\.md$|package\.json$)/,
    reason: 'Release packaging, upstream sync, review gate, or governance infrastructure',
  },
];

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function getGitDir(cwd = ROOT) {
  return resolve(cwd, git(['rev-parse', '--git-dir'], cwd));
}

export function getCurrentBranch(cwd = ROOT) {
  try {
    return git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  } catch {
    return 'HEAD';
  }
}

export function getReviewStatePath(cwd = ROOT) {
  return join(getGitDir(cwd), REVIEW_STATE_FILE_NAME);
}

export function getReviewReceiptPath(cwd = ROOT) {
  return join(getGitDir(cwd), REVIEW_RECEIPT_FILE_NAME);
}

export function getDefaultPacketPath(cwd = ROOT) {
  return join(getGitDir(cwd), DEFAULT_PACKET_FILE_NAME);
}

export function readReviewState(cwd = ROOT) {
  const stateFile = getReviewStatePath(cwd);
  if (!existsSync(stateFile)) {
    return { attempts: 0, branch: '', lastVerdict: null };
  }
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return { attempts: 0, branch: '', lastVerdict: null };
  }
}

export function writeReviewState(state, cwd = ROOT) {
  writeFileSync(getReviewStatePath(cwd), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function clearReviewState(cwd = ROOT) {
  for (const file of [getReviewStatePath(cwd), getReviewReceiptPath(cwd), getDefaultPacketPath(cwd)]) {
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {}
    }
  }
}

export function classifyRiskTier(paths) {
  const reasons = new Set();
  let hasNonDocOrTest = false;

  for (const file of paths) {
    if (file === ACTIVE_TASK_FILE_NAME) continue;
    for (const rule of TIER2_RULES) {
      if (rule.pattern.test(file)) {
        reasons.add(rule.reason);
      }
    }
    const isDocOrTest =
      file.startsWith('docs/') ||
      (file.endsWith('.md') && !/^(AGENTS|REVIEW)\.md$/.test(file)) ||
      file.startsWith('tests/') ||
      file.includes('.test.');
    if (!isDocOrTest) {
      hasNonDocOrTest = true;
    }
  }

  const riskTier =
    reasons.size > 0 ? 'Tier 2 (High)' : hasNonDocOrTest ? 'Tier 1 (Medium)' : 'Tier 0 (Low)';
  return { riskTier, tier2Reasons: [...reasons] };
}

export function resolveBaseCommit(cwd = ROOT) {
  const branch = getCurrentBranch(cwd);
  if (branch !== 'main') {
    const mb = spawnSync('git', ['merge-base', 'main', 'HEAD'], { cwd, encoding: 'utf8' });
    if (mb.status === 0 && mb.stdout.trim()) {
      return { branch, baseCommit: mb.stdout.trim() };
    }
  }
  const head = git(['rev-parse', 'HEAD'], cwd);
  return { branch, baseCommit: head };
}

export function collectBranchTouchedFiles(cwd = ROOT, baseCommit = resolveBaseCommit(cwd).baseCommit) {
  const diffBase = spawnSync('git', ['diff', '--name-only', baseCommit], { cwd, encoding: 'utf8' });
  const diffHead = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf8' });
  const diffCached = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
  });

  const all = new Set();
  for (const out of [diffBase.stdout, diffHead.stdout, diffCached.stdout, untracked.stdout]) {
    for (const line of String(out ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) all.add(trimmed);
    }
  }
  return [...all].sort();
}

export function computeBranchStateHash(cwd = ROOT) {
  const { branch, baseCommit } = resolveBaseCommit(cwd);
  const touchedFiles = collectBranchTouchedFiles(cwd, baseCommit);
  const { riskTier, tier2Reasons } = classifyRiskTier(touchedFiles);
  const hasher = createHash('sha256');
  hasher.update(`base:${baseCommit}\n`);

  for (const relPath of touchedFiles) {
    const absPath = join(cwd, relPath);
    if (existsSync(absPath) && statSync(absPath).isFile()) {
      const fileHash = createHash('sha256').update(readFileSync(absPath)).digest('hex');
      hasher.update(`FILE:${relPath}:${fileHash}\n`);
    } else {
      hasher.update(`DELETED:${relPath}\n`);
    }
  }

  return {
    branch,
    baseCommit,
    touchedFiles,
    riskTier,
    tier2Reasons,
    stateHash: hasher.digest('hex'),
  };
}

function readBaselineDoc(cwd, relPath) {
  const fromMain = spawnSync('git', ['show', `main:${relPath}`], { cwd, encoding: 'utf8' });
  if (fromMain.status === 0 && fromMain.stdout.trim()) {
    return { source: `main:${relPath}`, content: fromMain.stdout };
  }
  const diskPath = join(cwd, relPath);
  if (existsSync(diskPath)) {
    return { source: `worktree:${relPath}`, content: readFileSync(diskPath, 'utf8') };
  }
  return { source: `${relPath} (missing)`, content: '' };
}

export function verifyReviewReceipt(cwd = ROOT) {
  const state = computeBranchStateHash(cwd);
  const receiptPath = getReviewReceiptPath(cwd);
  let existing = null;
  if (existsSync(receiptPath)) {
    try {
      const parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (parsed && typeof parsed.stateHash === 'string' && typeof parsed.summary === 'string') {
        existing = parsed;
      }
    } catch {}
  }

  if (!existing) {
    return {
      valid: false,
      riskTier: state.riskTier,
      touchedFiles: state.touchedFiles,
      currentStateHash: state.stateHash,
      receipt: null,
      reason: `缺少当前分支 (${state.branch}) 的多子代理复核收据 (${state.riskTier})。请运行 code-review 技能并执行 npm run review:receipt -- --record。`,
    };
  }

  if (existing.branch !== state.branch) {
    return {
      valid: false,
      riskTier: state.riskTier,
      touchedFiles: state.touchedFiles,
      currentStateHash: state.stateHash,
      receipt: existing,
      reason: `复核收据分支不匹配：收据属于 ${existing.branch}，当前分支为 ${state.branch}。`,
    };
  }

  if (existing.stateHash !== state.stateHash) {
    return {
      valid: false,
      riskTier: state.riskTier,
      touchedFiles: state.touchedFiles,
      currentStateHash: state.stateHash,
      receipt: existing,
      reason: `复核收据已过期：自 ${existing.recordedAtUtc} 签发收据后代码已发生变更 (期望指纹 ${state.stateHash.slice(0, 12)}，实际为 ${existing.stateHash.slice(0, 12)})。`,
    };
  }

  return {
    valid: true,
    riskTier: state.riskTier,
    touchedFiles: state.touchedFiles,
    currentStateHash: state.stateHash,
    receipt: existing,
    reason: `有效的子代理复核收据 (${existing.recordedAtUtc}: ${existing.summary})。`,
  };
}

export function recordReviewReceipt({ cwd = ROOT, summary = '' } = {}) {
  const branch = getCurrentBranch(cwd);
  if (isProtectedBranch(branch) || branch === 'upstream/release') {
    return {
      ok: false,
      error: 'PROTECTED_BRANCH',
      message: `禁止在受保护分支 (${branch}) 上签发复核收据。`,
    };
  }

  const taskValidation = validateActiveTaskContent(cwd);
  if (!taskValidation.ok) {
    return {
      ok: false,
      error: 'INVALID_ACTIVE_TASK',
      message: taskValidation.message,
    };
  }

  let reviewState = readReviewState(cwd);
  if (reviewState.branch !== branch) {
    reviewState = { attempts: 0, branch, lastVerdict: null };
  }
  if (reviewState.attempts >= MAX_REVIEW_ATTEMPTS) {
    return {
      ok: false,
      error: 'CIRCUIT_BREAKER_TRIGGERED',
      attempts: reviewState.attempts,
      message: `该分支已连续 ${reviewState.attempts} 次复核未通过并触发熔断，请先与用户沟通重置状态。`,
    };
  }

  const state = computeBranchStateHash(cwd);
  const receipt = {
    version: 1,
    branch: state.branch,
    baseCommit: state.baseCommit,
    stateHash: state.stateHash,
    riskTier: state.riskTier,
    touchedFiles: state.touchedFiles,
    summary:
      summary.trim() || `Summary: Blockers: 0 | Important: 0 | Nits: 0 | Risk Tier: ${state.riskTier}`,
    recordedAtUtc: new Date().toISOString(),
  };

  reviewState.attempts = 0;
  reviewState.lastVerdict = 'PASS';
  writeReviewState(reviewState, cwd);
  writeFileSync(getReviewReceiptPath(cwd), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  return { ok: true, verdict: 'PASS', receipt };
}

export function recordReviewFailure({ cwd = ROOT, summary = '', issues = [] } = {}) {
  const branch = getCurrentBranch(cwd);
  let reviewState = readReviewState(cwd);
  if (reviewState.branch !== branch) {
    reviewState = { attempts: 0, branch, lastVerdict: null };
  }

  reviewState.attempts += 1;
  reviewState.lastVerdict = 'FAIL';
  writeReviewState(reviewState, cwd);

  const receiptPath = getReviewReceiptPath(cwd);
  if (existsSync(receiptPath)) {
    try {
      unlinkSync(receiptPath);
    } catch {}
  }

  if (reviewState.attempts >= MAX_REVIEW_ATTEMPTS) {
    return {
      ok: false,
      verdict: 'FAIL',
      error: 'CIRCUIT_BREAKER_TRIGGERED',
      attempts: reviewState.attempts,
      issues,
      message: `连续 ${MAX_REVIEW_ATTEMPTS} 次子代理复核与修复未通过，触发熔断！请立即停止自动修复并向用户汇报。`,
    };
  }

  return {
    ok: false,
    verdict: 'FAIL',
    attempts: reviewState.attempts,
    issues,
    message:
      summary.trim() ||
      `子代理复核未通过 (第 ${reviewState.attempts}/${MAX_REVIEW_ATTEMPTS} 次)。请修复问题后重新复核。`,
  };
}

export function buildReviewPacketContent({
  branch,
  state,
  receiptStatus,
  activeTaskContent,
  reviewDoc,
  changedFilesSummary,
  gitLogText,
  diffText,
}) {
  const maxDiffChars = 85_000;
  const trimmedDiff =
    diffText.length > maxDiffChars
      ? `${diffText.slice(0, maxDiffChars)}\n\n... [Diff truncated at ${maxDiffChars} chars; read remaining files directly] ...`
      : diffText;

  return [
    '# Fresh-Context Subagent Code Review Packet (Ester Studio)',
    '',
    'You are an independent, fresh-context Code Review Subagent for Ester Studio.',
    'Follow the Zero-Noise Protocol in `REVIEW.md` and Confidence Rubric (`0..100`, report only `>= 80`):',
    '1. Line 1 MUST be: `Summary: Blockers: <N> | Important: <M> | Nits: <K> | Risk Tier: <Tier 0|1|2>`',
    '2. Tag every finding with `[Blocker]`, `[Important]`, `[Nit]`, or `[Pre-existing]` and `[Confidence: <80-100>]`.',
    '3. Cite exact `file:startLine-endLine` and concrete failure conditions. Respect the Out-of-Scope boundary in `ACTIVE_TASK.md`.',
    '4. If there are zero actionable issues (`>= 80`), output `No actionable issues found.`',
    '',
    '## 1. Risk Classification & Branch State',
    `- **Branch**: \`${branch}\``,
    `- **Base Commit**: \`${state.baseCommit}\``,
    `- **Risk Tier**: ${state.riskTier}`,
    `- **Branch State Hash**: \`${state.stateHash}\``,
    `- **Receipt Status**: ${receiptStatus.valid ? 'VALID' : 'MISSING/STALE'} (${receiptStatus.reason})`,
    `- **Touched Files (${state.touchedFiles.length})**: ${state.touchedFiles.join(', ') || '(none)'}`,
    ...(state.tier2Reasons.length > 0
      ? ['- **Tier 2 High-Risk Triggers**:', ...state.tier2Reasons.map((r) => `  - ${r}`)]
      : []),
    '',
    `## 2. Task Specification & Scope Boundary (${ACTIVE_TASK_FILE_NAME})`,
    '```markdown',
    activeTaskContent.trim(),
    '```',
    '',
    `## 3. Baseline Review Specification (${reviewDoc.source})`,
    '```markdown',
    reviewDoc.content.trim(),
    '```',
    '',
    '## 4. Commit Log & Changed Files Summary',
    '```text',
    gitLogText || '(No commits yet on branch)',
    '',
    changedFilesSummary || '(No file changes)',
    '```',
    '',
    '## 5. Unified Diff (Against Base Commit)',
    '```diff',
    trimmedDiff.trim() || '(Empty diff)',
    '```',
    '',
  ].join('\n');
}

export function prepareReviewPacket({ cwd = ROOT, env = process.env, outFile, skipTests = false } = {}) {
  const branch = getCurrentBranch(cwd);
  if (isProtectedBranch(branch) || branch === 'upstream/release') {
    return {
      ok: false,
      error: 'PROTECTED_BRANCH',
      message: `无法在主分支或上游跟踪分支 (${branch}) 上发起复核，请在开发分支上执行。`,
    };
  }

  const taskValidation = validateActiveTaskContent(cwd);
  if (!taskValidation.ok) {
    return {
      ok: false,
      error: 'INVALID_ACTIVE_TASK',
      message: taskValidation.message,
    };
  }

  let reviewState = readReviewState(cwd);
  if (reviewState.branch !== branch) {
    reviewState = { attempts: 0, branch, lastVerdict: null };
  }
  if (reviewState.attempts >= MAX_REVIEW_ATTEMPTS) {
    return {
      ok: false,
      error: 'CIRCUIT_BREAKER_TRIGGERED',
      attempts: reviewState.attempts,
      message: `该分支已连续 ${reviewState.attempts} 次复核未通过，触发 3 轮熔断。请停止自动修补并人工介入。`,
    };
  }

  if (!skipTests) {
    console.log('[review:prepare] 🧪 正在验证单元测试套件...');
    const testResult = runTestSuite({ cwd, env });
    if (!testResult.ok) {
      return {
        ok: false,
        error: 'TESTS_FAILED',
        message: '单元测试未全部通过，请先修复所有测试用例后再生成子代理审查包。',
      };
    }
  }

  const state = computeBranchStateHash(cwd);
  const receiptStatus = verifyReviewReceipt(cwd);
  const activeTaskContent = readActiveTask(cwd);
  const reviewDoc = readBaselineDoc(cwd, 'REVIEW.md');
  const changedFilesSummary =
    spawnSync('git', ['diff', '--name-status', state.baseCommit], { cwd, encoding: 'utf8' }).stdout.trim() ||
    '(无文件变更)';
  const gitLogText =
    spawnSync('git', ['log', '--oneline', `${state.baseCommit}..HEAD`], { cwd, encoding: 'utf8' }).stdout.trim() ||
    '(工作区未提交变更)';
  const diffText =
    spawnSync('git', ['diff', '-U3', state.baseCommit], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }).stdout || '';

  const packetContent = buildReviewPacketContent({
    branch,
    state,
    receiptStatus,
    activeTaskContent,
    reviewDoc,
    changedFilesSummary,
    gitLogText,
    diffText,
  });

  const targetOut = outFile ? resolve(cwd, outFile) : getDefaultPacketPath(cwd);
  writeFileSync(targetOut, packetContent, 'utf8');
  console.log(`[review:prepare] ✅ 已生成独立上下文子代理审查包: ${targetOut} (${state.riskTier})`);

  return {
    ok: true,
    packetPath: targetOut,
    riskTier: state.riskTier,
    stateHash: state.stateHash,
    touchedFiles: state.touchedFiles,
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--prepare';

  if (mode === '--prepare' || args.includes('--prepare')) {
    const outIdx = args.indexOf('--out');
    const outFile = outIdx >= 0 ? args[outIdx + 1] : undefined;
    const skipTests = args.includes('--skip-tests');
    const res = prepareReviewPacket({ outFile, skipTests });
    if (!res.ok) {
      console.error(`\n❌ [review:prepare 失败] ${res.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (args.includes('--clear')) {
    clearReviewState();
    console.log('[review:receipt] 🧹 已清除子代理复核状态与收据。');
    return;
  }

  if (args.includes('--fail') || args.includes('-f')) {
    const sumIdx = args.indexOf('--summary');
    const summary = sumIdx >= 0 ? args[sumIdx + 1] || '' : '';
    const res = recordReviewFailure({ summary });
    console.warn(`\n⚠️ [review:receipt] ${res.message}\n`);
    process.exit(1);
  }

  if (args.includes('--record')) {
    const sumIdx = args.indexOf('--summary');
    const summary = sumIdx >= 0 ? args[sumIdx + 1] || '' : '';
    const res = recordReviewReceipt({ summary });
    if (!res.ok) {
      console.error(`\n❌ [review:receipt 失败] ${res.message}\n`);
      process.exit(1);
    }
    console.log(
      `\n✅ [review:receipt] 已签发子代理复核收据 (${res.receipt.riskTier}, stateHash=${res.receipt.stateHash.slice(0, 12)})。\n`,
    );
    return;
  }

  const verification = verifyReviewReceipt();
  console.log(JSON.stringify(verification, null, 2));
  if (args.includes('--verify') && !verification.valid) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli();
}
