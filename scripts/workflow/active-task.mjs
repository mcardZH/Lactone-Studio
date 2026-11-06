import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
export const ACTIVE_TASK_FILE_NAME = 'ACTIVE_TASK.md';

export const INITIAL_ACTIVE_TASK_TEMPLATE = `# 当前开发任务规格说明书 (Active Task Specification)

> 本文件用于记录当前开发任务的需求、技术方案、用户讨论记录与验收标准。
> **生命周期说明**：本文件仅服务于单次任务。任务分支合并至主分支（或提交 PR）后，将被自动化脚本重置为初始模板，以防历史记录膨胀。

---

## 1. 任务概述 (Task Overview)
- **任务名称**：[简明扼要的任务标题]
- **关联分支**：[如 feat/xxx, fix/xxx, mac/xxx]
- **目标概要**：[一到两句话描述本次任务核心目标]

---

## 2. 需求细节与范围边界 (Scope & Requirements)
- **核心功能需求**：
  1. [需求点 1]
  2. [需求点 2]
- **边界与非目标 (Out of Scope)**：
  - [明确本次任务不做哪些改动，防止范围蔓延]

---

## 3. 技术设计方案 (Technical Design)
- **涉及模块与文件清单**：
  - [例如：desktop/task-system/...、src/web/...]
- **跨平台适配考量（macOS / Windows / Linux）**：
  - [涉及路径、系统 API、外部工具的跨平台处理]
- **关键实现逻辑与架构影响**：
  - [关键数据结构、IPC Channel 或算法逻辑]

---

## 4. 自动化测试计划 (Testing Plan)
- **单元测试覆盖文件**：
  - [tests/ 下对应的测试文件路径]
- **核心验证场景与边界条件**：
  - [正常路径、异常路径、平台分支]

---

## 5. 用户沟通与意图确认记录 (User Alignment)
- **用户原始诉求**：
  - [用户提问或指令原文要点]
- **澄清细节与确认结论**：
  - [与用户讨论中明确的细节规则与共识]
- **是否已获得用户开发确认**：是 / 否
`;

/**
 * Get the path to ACTIVE_TASK.md for the given working directory.
 * @param {string} cwd
 * @returns {string}
 */
export function getActiveTaskFilePath(cwd = ROOT) {
  return join(cwd, ACTIVE_TASK_FILE_NAME);
}

/**
 * Read the current contents of ACTIVE_TASK.md.
 * @param {string} cwd
 * @returns {string}
 */
export function readActiveTask(cwd = ROOT) {
  const filePath = getActiveTaskFilePath(cwd);
  if (!existsSync(filePath)) {
    return '';
  }
  return readFileSync(filePath, 'utf8');
}

/**
 * Reset ACTIVE_TASK.md back to the initial blank template.
 * @param {string} cwd
 */
export function resetActiveTask(cwd = ROOT) {
  const filePath = getActiveTaskFilePath(cwd);
  writeFileSync(filePath, INITIAL_ACTIVE_TASK_TEMPLATE, 'utf8');
  console.log(`[active-task] 🔄 已将 ${ACTIVE_TASK_FILE_NAME} 重置为初始空模板。`);
}

/**
 * Validate whether ACTIVE_TASK.md contains a real, populated task spec
 * rather than being empty or unedited template.
 * @param {string} cwd
 * @returns {{ ok: boolean, message?: string }}
 */
export function validateActiveTaskContent(cwd = ROOT) {
  const content = readActiveTask(cwd).trim();
  if (!content) {
    return {
      ok: false,
      message: `${ACTIVE_TASK_FILE_NAME} 不存在或内容为空。请按照流程在文件内记录本次开发任务规格。`,
    };
  }

  // Check if still strictly identical to initial template or placeholder brackets remain unmodified
  const hasTaskName = /- \*\*任务名称\*\*：\s*(?!\[简明扼要的任务标题\])(?:\S.+)/.test(content);
  const hasAlignment = /## 5\. 用户沟通与意图确认记录/.test(content);

  if (!hasTaskName) {
    return {
      ok: false,
      message: `${ACTIVE_TASK_FILE_NAME} 尚未填写有效任务名称或仍为初始占位符。请先完善需求与意图记录后再提交复核。`,
    };
  }

  if (!hasAlignment) {
    return {
      ok: false,
      message: `${ACTIVE_TASK_FILE_NAME} 缺少“用户沟通与意图确认记录”章节。请确保已与用户充分对齐意图。`,
    };
  }

  return { ok: true };
}
