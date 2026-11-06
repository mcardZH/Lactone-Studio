import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readActiveTask, validateActiveTaskContent, ACTIVE_TASK_FILE_NAME } from './active-task.mjs';
import { isProtectedBranch } from './branch-policy.mjs';
import { runTestSuite } from './run-tests.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
export const REQUIRED_REVIEW_MODEL = 'gpt-6.1-terra';
export const MAX_REVIEW_ATTEMPTS = 3;

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function getGitDir(cwd = ROOT) {
  return resolve(cwd, git(['rev-parse', '--git-dir'], cwd));
}

function getCurrentBranch(cwd = ROOT) {
  try {
    return git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  } catch {
    return 'HEAD';
  }
}

export function getReviewStatePath(cwd = ROOT) {
  return join(getGitDir(cwd), 'codex-review-state.json');
}

export function getReviewReceiptPath(cwd = ROOT) {
  return join(getGitDir(cwd), 'codex-review-receipt.json');
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
  const stateFile = getReviewStatePath(cwd);
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

export function clearReviewState(cwd = ROOT) {
  const stateFile = getReviewStatePath(cwd);
  const receiptFile = getReviewReceiptPath(cwd);
  if (existsSync(stateFile)) {
    try { unlinkSync(stateFile); } catch {}
  }
  if (existsSync(receiptFile)) {
    try { unlinkSync(receiptFile); } catch {}
  }
}

/**
 * Build the review prompt for gpt-6.1-terra using ACTIVE_TASK.md and Git Diff.
 */
export function buildReviewPrompt({ branch, activeTaskContent, changedFilesSummary, diffText, gitLogText }) {
  return [
    `你是一名极其严谨的代码审核专家，由 ${REQUIRED_REVIEW_MODEL} 驱动，正在对当前分支 [${branch}] 进行合并前独立代码复核。`,
    `本次审核使用的基准要求是开发者在 ${ACTIVE_TASK_FILE_NAME} 中与用户确认的需求规格说明。`,
    '',
    '==================== 1. 任务规格说明书 (ACTIVE_TASK.md) ====================',
    activeTaskContent,
    '',
    '==================== 2. 本分支变更文件清单 ====================',
    changedFilesSummary,
    '',
    '==================== 3. 本分支提交日志 ====================',
    gitLogText || '(无提交日志)',
    '',
    '==================== 4. 详细代码 DIFF (相对于 main) ====================',
    diffText || '(无代码变更)',
    '',
    '==================== 5. 审核要求与评判标准 ====================',
    '0. 严格范围边界（核心铁律，严禁无限扩大范围）：',
    '   - 你的审查必须严格聚焦于“本分支变更文件清单”与“详细代码 DIFF (相对于 main)”中实际修改的部分；',
    `   - 必须严格尊重 ${ACTIVE_TASK_FILE_NAME} 中声明的“非目标边界 (Out of Scope)”与分阶段拆分计划，绝不允许因为本分支未修改的其他模块、后续分支才实现的宿主集成功能、或脱离真实运行环境的极端假设（如假设攻击者已控制本机内核或任意伪造操作系统盘符）而判定 FAIL 或提出越界要求；`,
    '   - 在多轮复核修复中，仅验证本分支 Diff 的实际缺陷是否已修复，严禁顺着修复代码不断衍生新的外延假设或无限扩大审查范围。',
    `1. 需求与意图符合度：比对 ${ACTIVE_TASK_FILE_NAME} 中记录的核心功能需求与用户确认记录，检查本分支修改代码是否忠实实现、有无遗漏，是否存在超出范围的无关变更。`,
    '2. 代码质量与健壮性：检查本分支修改代码是否存在实质性逻辑缺陷、未捕获异常、边界处理不全、内存泄漏或安全性隐患。',
    '3. 跨平台兼容性：本项目为 macOS (Apple Silicon/Intel) 及跨平台桌面端应用，检查本分支修改代码是否包含未经跨平台抽象的 Windows 专属硬编码路径或命令（除非存在明确的分支防御）。',
    '4. 自动化测试有效性：检查 tests/ 下新增或修改的测试用例是否真实覆盖了本次修改代码的关键逻辑与异常路径。',
    '',
    '请输出符合以下 JSON Schema 的严格 JSON 格式审查报告：',
    '{',
    '  "verdict": "PASS" | "FAIL",',
    '  "summary": "简明扼要的审核总结",',
    '  "intent_alignment": "关于是否符合 ACTIVE_TASK.md 用户意图的评估",',
    '  "features_verified": ["已验证的功能点1", "已验证的功能点2"],',
    '  "test_coverage_assessment": "对单元测试覆盖度的评价",',
    '  "issues": [',
    '    {',
    '      "severity": "error" | "warning",',
    '      "file": "涉及文件路径",',
    '      "description": "问题详细描述",',
    '      "suggestion": "具体的修复建议"',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

/**
 * Execute independent code review using gpt-6.1-terra.
 */
export function runCodexReview({ cwd = ROOT, env = process.env } = {}) {
  const branch = getCurrentBranch(cwd);

  if (isProtectedBranch(branch)) {
    return {
      ok: false,
      error: 'PROTECTED_BRANCH',
      message: `无法在主分支 (${branch}) 上发起复核，请在特性分支上执行。`,
    };
  }

  // 1. Check ACTIVE_TASK.md
  console.log(`[codex-review] 📄 正在检查 ${ACTIVE_TASK_FILE_NAME} 任务规格说明...`);
  const taskValidation = validateActiveTaskContent(cwd);
  if (!taskValidation.ok) {
    return {
      ok: false,
      error: 'INVALID_ACTIVE_TASK',
      message: taskValidation.message,
    };
  }
  const activeTaskContent = readActiveTask(cwd);

  // 2. Run unit tests first
  console.log('[codex-review] 🧪 正在验证单元测试套件...');
  const testResult = runTestSuite({ cwd, env });
  if (!testResult.ok) {
    return {
      ok: false,
      error: 'TESTS_FAILED',
      message: '单元测试未全部通过，请先修复所有测试用例后再发起复核。',
    };
  }

  // 3. Inspect review state & circuit breaker
  let state = readReviewState(cwd);
  if (state.branch !== branch) {
    state = { attempts: 0, branch, lastVerdict: null };
  }

  if (state.attempts >= MAX_REVIEW_ATTEMPTS) {
    console.error(`\n🚨 [复核熔断] 该分支已连续 ${state.attempts} 次复核未通过！`);
    console.error('请立即停止自动循环，向人工反馈：请与用户重新审视项目架构设计，评估是否一次性改动过大，建议拆分为更小粒度的分支。\n');
    return {
      ok: false,
      error: 'CIRCUIT_BREAKER_TRIGGERED',
      attempts: state.attempts,
      message: `已连续 ${state.attempts} 次审核与修复未通过，触发熔断。已停止自动修复，请人工介入。`,
    };
  }

  // 4. Gather git diff against main
  let baseBranch = 'main';
  try {
    git(['rev-parse', '--verify', 'main'], cwd);
  } catch {
    baseBranch = 'HEAD~1';
  }

  const changedFilesSummary = git(['diff', '--name-status', `${baseBranch}...HEAD`], cwd) || '(无文件变更)';
  const diffText = git(['diff', '-U5', `${baseBranch}...HEAD`], cwd);
  const gitLogText = git(['log', '--oneline', `${baseBranch}...HEAD`], cwd);

  const prompt = buildReviewPrompt({
    branch,
    activeTaskContent,
    changedFilesSummary,
    diffText,
    gitLogText,
  });

  // 5. Invoke review agent (supports mock for testing and real codex CLI)
  console.log(`[codex-review] 🤖 正在启动复核子代理 (${REQUIRED_REVIEW_MODEL}) 审查代码变更与意图一致性...`);
  
  let reviewPayload = null;
  const mockVerdict = env.MOCK_CODEX_VERDICT;
  const mockBin = env.MOCK_CODEX_BIN;

  if (mockBin) {
    const tmpOut = join(getGitDir(cwd), `review-${Date.now()}.json`);
    const proc = spawnSync('node', [mockBin, '-o', tmpOut, prompt], {
      cwd,
      env,
      encoding: 'utf8',
    });
    if (existsSync(tmpOut)) {
      try {
        reviewPayload = JSON.parse(readFileSync(tmpOut, 'utf8'));
      } catch {}
      try { unlinkSync(tmpOut); } catch {}
    }
  } else if (mockVerdict) {
    reviewPayload = {
      verdict: mockVerdict,
      summary: mockVerdict === 'PASS' ? '代码实现完整契合 ACTIVE_TASK.md，测试覆盖充分。' : '发现代码逻辑缺陷。',
      intent_alignment: '功能符合预期需求',
      features_verified: ['已核对需求规格'],
      test_coverage_assessment: '单元测试覆盖充分',
      issues: mockVerdict === 'PASS' ? [] : [
        { severity: 'error', file: 'src/example.ts', description: '存在潜在空指针', suggestion: '增加可选链判断' }
      ],
    };
  } else {
    // Real codex invocation
    try {
      const execResult = execFileSync(
        'codex',
        ['exec', '-m', REQUIRED_REVIEW_MODEL, prompt],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      // Extract json block from output
      const jsonMatch = execResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        reviewPayload = JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      return {
        ok: false,
        error: 'CODEX_EXEC_FAILED',
        message: `Codex 复核执行失败: ${err.message}`,
      };
    }
  }

  if (!reviewPayload || !reviewPayload.verdict) {
    return {
      ok: false,
      error: 'INVALID_REVIEW_RESPONSE',
      message: '未能解析有效的复核审查响应。',
    };
  }

  // 6. Handle Verdict
  if (reviewPayload.verdict === 'PASS') {
    state.attempts = 0;
    state.lastVerdict = 'PASS';
    writeReviewState(state, cwd);

    const receipt = {
      branch,
      model: REQUIRED_REVIEW_MODEL,
      timestamp: new Date().toISOString(),
      summary: reviewPayload.summary,
      intent_alignment: reviewPayload.intent_alignment,
      features_verified: reviewPayload.features_verified || [],
      test_coverage_assessment: reviewPayload.test_coverage_assessment,
    };
    writeFileSync(getReviewReceiptPath(cwd), JSON.stringify(receipt, null, 2), 'utf8');

    console.log('\n==================== 独立代码复核结果：PASS ✅ ====================');
    console.log(`📝 审核总结: ${reviewPayload.summary}`);
    console.log(`🎯 意图对齐: ${reviewPayload.intent_alignment}`);
    console.log(`🧪 测试评估: ${reviewPayload.test_coverage_assessment}`);
    console.log('===================================================================\n');
    console.log('✅ 复核凭证已生成，所有单元测试均已通过。请向用户汇报并等待明确确认后执行合并。\n');

    return { ok: true, verdict: 'PASS', receipt };
  } else {
    state.attempts += 1;
    state.lastVerdict = 'FAIL';
    writeReviewState(state, cwd);

    console.warn(`\n==================== 独立代码复核结果：FAIL ❌ (第 ${state.attempts}/${MAX_REVIEW_ATTEMPTS} 次) ====================`);
    console.warn(`📝 总结: ${reviewPayload.summary}`);
    if (reviewPayload.issues && reviewPayload.issues.length > 0) {
      console.warn('⚠️ 发现以下问题需修复：');
      for (const issue of reviewPayload.issues) {
        console.warn(`  - [${issue.severity || 'error'}] ${issue.file}: ${issue.description}`);
        if (issue.suggestion) {
          console.warn(`    💡 修复建议: ${issue.suggestion}`);
        }
      }
    }
    console.warn('====================================================================================\n');

    if (state.attempts >= MAX_REVIEW_ATTEMPTS) {
      console.error(`🚨 [复核熔断] 已达到最大重试次数 (${MAX_REVIEW_ATTEMPTS} 次)！已停止自动循环，请人工介入处理。`);
      return {
        ok: false,
        error: 'CIRCUIT_BREAKER_TRIGGERED',
        attempts: state.attempts,
        message: `连续 ${MAX_REVIEW_ATTEMPTS} 次审核与修复未通过，已停止自动修复，请人工介入。`,
        issues: reviewPayload.issues || [],
      };
    }

    return {
      ok: false,
      verdict: 'FAIL',
      attempts: state.attempts,
      message: `复核未通过 (第 ${state.attempts} 次)。请主 Agent 根据上述反馈修复代码后再次提审。`,
      issues: reviewPayload.issues || [],
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = runCodexReview();
  if (!result.ok) {
    process.exit(1);
  }
}
