import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTIVE_TASK_FILE_NAME } from '../workflow/active-task.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
export const UPSTREAM_REPO = 'Ahey1/Ester-Studio';
export const UPSTREAM_RELEASES_API = `https://api.github.com/repos/${UPSTREAM_REPO}/releases`;
export const UPSTREAM_BRANCH = 'upstream/release';
export const BASELINE_VERSION = 'v2.0.2';

const IGNORED_SNAPSHOT_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', '.cache', '.local']);
const IGNORED_SNAPSHOT_FILES = new Set(['.DS_Store']);

const GOVERNANCE_ONLY_PREFIXES = [
  '.agents/',
  '.githooks/',
  'scripts/workflow/',
  'scripts/upstream/',
  'tests/workflow/',
  'docs/MACOS_PORTING_ROADMAP.md',
  'docs/PROJECT_STRUCTURE.md',
  'AGENTS.md',
  'REVIEW.md',
  'CONTRIBUTING.md',
  'ACTIVE_TASK.md',
];

const PLATFORM_SENSITIVE_RULES = [
  {
    id: 'win32-platform-branch',
    label: 'Windows 平台分支判断 (win32 / process.platform)',
    regex: /\b(?:win32|process\.platform)\b/,
  },
  {
    id: 'windows-binary-extension',
    label: 'Windows 可执行或动态库后缀 (.exe / .dll / .cmd / .bat)',
    regex: /\.(?:exe|dll|cmd|bat|ps1)\b/i,
  },
  {
    id: 'windows-shell-or-wsl',
    label: 'Windows Shell / WSL 调用 (powershell / cmd.exe / wsl / taskkill / where.exe)',
    regex: /\b(?:powershell|pwsh|cmd\.exe|wsl(?:\.exe)?|taskkill|where\.exe)\b/i,
  },
  {
    id: 'portable-profile-api',
    label: 'Windows 便携模式 API (portableProfile / portableTools / resolvePortableLayout)',
    regex: /\b(?:portableProfile|portableTools|resolvePortableLayout|createPortableProfile)\b/,
  },
  {
    id: 'subprocess-invocation',
    label: '子进程调用 (spawn / execFile / execSync)',
    regex: /\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/,
  },
];

function git(args, cwd = ROOT, extraEnv = {}) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
}

export function normalizeVersionTag(rawVersion) {
  const cleaned = String(rawVersion || '')
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/^upstream\//, '');
  if (!cleaned) {
    throw new Error('请提供有效的上游版本号（如 v2.0.3）。');
  }
  const version = cleaned.startsWith('v') ? cleaned : `v${cleaned}`;
  return {
    version,
    upstreamTag: `upstream/${version}`,
    tagRef: `refs/tags/upstream/${version}`,
  };
}

function refExists(refName, cwd = ROOT) {
  const res = spawnSync('git', [' show-ref', '--verify', '--quiet', refName], { cwd });
  if (res.status === 0) return true;
  const rev = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${refName}^{commit}`], { cwd });
  return rev.status === 0;
}

export function resolveInitialBaselineCommit(cwd = ROOT) {
  const roots = git(['rev-list', '--max-parents=0', 'HEAD'], cwd)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (roots.length === 0) {
    throw new Error('无法在当前 Git 仓库中找到初始根提交。');
  }
  return roots[0];
}

export function initUpstreamTracking({
  cwd = ROOT,
  baseCommit = resolveInitialBaselineCommit(cwd),
  baselineVersion = BASELINE_VERSION,
} = {}) {
  const { version, upstreamTag, tagRef } = normalizeVersionTag(baselineVersion);
  const branchRef = `refs/heads/${UPSTREAM_BRANCH}`;

  if (!refExists(tagRef, cwd)) {
    git(['update-ref', tagRef, baseCommit], cwd);
  }
  if (!refExists(branchRef, cwd)) {
    git(['update-ref', branchRef, baseCommit], cwd);
  }

  return {
    ok: true,
    baseCommit,
    baselineVersion: version,
    baselineTag: upstreamTag,
    upstreamBranch: UPSTREAM_BRANCH,
  };
}

export function listLocalUpstreamTags(cwd = ROOT) {
  const res = spawnSync(
    'git',
    ['for-each-ref', '--sort=creatordate', '--format=%(refname:short)\t%(objectname)', 'refs/tags/upstream/'],
    { cwd, encoding: 'utf8' },
  );
  if (res.status !== 0 || !res.stdout.trim()) return [];
  return res.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [tag, commit] = line.split('\t');
      return {
        tag: tag.trim(),
        version: tag.trim().replace(/^upstream\//, ''),
        commit: (commit || '').trim(),
      };
    });
}

function parseReleaseSha256Table(body = '') {
  const map = new Map();
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(/\|\s*([^\s|]+\.zip)\s*\|\s*(\d+)\s*\|\s*([a-fA-F0-9]{64})\s*\|/);
    if (match) {
      map.set(match[1].trim(), {
        bytes: Number(match[2]),
        sha256: match[3].toLowerCase(),
      });
    }
  }
  return map;
}

export async function checkUpstreamReleases({ cwd = ROOT, releasesJson = null } = {}) {
  initUpstreamTracking({ cwd });
  const localTags = listLocalUpstreamTags(cwd);
  const trackedSet = new Set(localTags.map((t) => t.version));

  let rawReleases = releasesJson;
  if (!rawReleases) {
    const response = await fetch(UPSTREAM_RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Ester-Studio-macOS-Upstream-Tracker',
      },
    });
    if (!response.ok) {
      throw new Error(`查询 GitHub Releases 失败: HTTP ${response.status}`);
    }
    rawReleases = await response.json();
  }

  const releases = (Array.isArray(rawReleases) ? rawReleases : []).map((rel) => {
    const { version, upstreamTag } = normalizeVersionTag(rel.tag_name || rel.name || 'v0.0.0');
    const shaTable = parseReleaseSha256Table(rel.body || '');
    const sourceAsset = (rel.assets || []).find((a) => /source-code\.zip$/i.test(a.name || ''));
    const shaInfo = sourceAsset ? shaTable.get(sourceAsset.name) : null;

    return {
      version,
      upstreamTag,
      name: rel.name || version,
      publishedAt: rel.published_at || null,
      tracked: trackedSet.has(version),
      sourceAsset: sourceAsset
        ? {
            name: sourceAsset.name,
            size: sourceAsset.size,
            url: sourceAsset.browser_download_url,
            sha256: shaInfo?.sha256 || null,
          }
        : null,
      summaryLines: String(rel.body || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- '))
        .slice(0, 12),
    };
  });

  const untrackedReleases = releases.filter((r) => !r.tracked);
  return {
    ok: true,
    upstreamRepo: UPSTREAM_REPO,
    localTags,
    releases,
    untrackedReleases,
  };
}

function collectSnapshotFiles(rootDir) {
  const files = [];
  function walk(currentDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (IGNORED_SNAPSHOT_FILES.has(entry.name)) continue;
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(rootDir, fullPath).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (IGNORED_SNAPSHOT_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const mode = (statSync(fullPath).mode & 0o111) !== 0 ? '100755' : '100644';
        files.push({ relPath, fullPath, mode });
      }
    }
  }
  walk(rootDir);
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function resolveSnapshotSourceRoot(extractedDir) {
  if (existsSync(join(extractedDir, 'package.json')) && existsSync(join(extractedDir, 'desktop'))) {
    return extractedDir;
  }
  const children = readdirSync(extractedDir, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && !d.name.startsWith('.'),
  );
  if (children.length === 1) {
    const candidate = join(extractedDir, children[0].name);
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return extractedDir;
}

export function importUpstreamSnapshot({
  cwd = ROOT,
  version,
  sourcePath,
  parentRef = `refs/heads/${UPSTREAM_BRANCH}`,
} = {}) {
  initUpstreamTracking({ cwd });
  const { version: normVersion, upstreamTag, tagRef } = normalizeVersionTag(version);
  const resolvedSource = resolve(cwd, String(sourcePath || ''));
  if (!sourcePath || !existsSync(resolvedSource)) {
    throw new Error(`上游源码路径不存在: ${resolvedSource}`);
  }

  let tempExtractDir = null;
  let tempIndexDir = null;

  try {
    let snapshotRoot = resolvedSource;
    if (lstatSync(resolvedSource).isFile() && resolvedSource.toLowerCase().endsWith('.zip')) {
      tempExtractDir = mkdtempSync(join(tmpdir(), 'ester-upstream-zip-'));
      execFileSync('/usr/bin/ditto', ['-x', '-k', resolvedSource, tempExtractDir], { stdio: 'pipe' });
      snapshotRoot = resolveSnapshotSourceRoot(tempExtractDir);
    } else {
      snapshotRoot = resolveSnapshotSourceRoot(resolvedSource);
    }

    if (!existsSync(join(snapshotRoot, 'package.json'))) {
      throw new Error(`无效的上游源码快照目录（缺少 package.json）: ${snapshotRoot}`);
    }

    const parentCommit = git(['rev-parse', `${parentRef}^{commit}`], cwd);
    const files = collectSnapshotFiles(snapshotRoot);

    tempIndexDir = mkdtempSync(join(tmpdir(), 'ester-upstream-idx-'));
    const tempIndexFile = join(tempIndexDir, 'index');
    const indexEnv = { GIT_INDEX_FILE: tempIndexFile };

    // Read parent commit tree so cached binary archives under third-party/build-inputs/archives/ can be retained if omitted
    git(['read-tree', parentCommit], cwd, indexEnv);
    const existingTracked = git(['ls-files'], cwd, indexEnv)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const newFileSet = new Set(files.map((f) => f.relPath));
    const hasArchivesInSnapshot = files.some((f) =>
      f.relPath.startsWith('third-party/build-inputs/archives/'),
    );

    const toRemove = existingTracked.filter((relPath) => {
      if (newFileSet.has(relPath)) return false;
      if (!hasArchivesInSnapshot && relPath.startsWith('third-party/build-inputs/archives/')) {
        return false;
      }
      return true;
    });

    if (toRemove.length > 0) {
      execFileSync('git', ['update-index', '--force-remove', '--stdin'], {
        cwd,
        env: { ...process.env, ...indexEnv },
        input: `${toRemove.join('\n')}\n`,
        encoding: 'utf8',
      });
    }

    if (files.length > 0) {
      const hashInput = `${files.map((f) => f.fullPath).join('\n')}\n`;
      const oids = execFileSync('git', ['hash-object', '-w', '--stdin-paths'], {
        cwd,
        env: { ...process.env, ...indexEnv },
        input: hashInput,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      })
        .trim()
        .split(/\r?\n/);

      const indexLines = files.map((file, idx) => `${file.mode} ${oids[idx]}\t${file.relPath}`);
      execFileSync('git', ['update-index', '--index-info'], {
        cwd,
        env: { ...process.env, ...indexEnv },
        input: `${indexLines.join('\n')}\n`,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      });
    }

    const treeOid = git(['write-tree'], cwd, indexEnv);
    const commitMsg = `chore(upstream): import Ester Studio ${normVersion} source snapshot`;
    const commitOid = git(['commit-tree', treeOid, '-p', parentCommit, '-m', commitMsg], cwd);

    git(['update-ref', `refs/heads/${UPSTREAM_BRANCH}`, commitOid], cwd);
    git(['update-ref', tagRef, commitOid], cwd);

    return {
      ok: true,
      version: normVersion,
      upstreamTag,
      commit: commitOid,
      parentCommit,
      fileCount: files.length,
    };
  } finally {
    if (tempExtractDir) rmSync(tempExtractDir, { recursive: true, force: true });
    if (tempIndexDir) rmSync(tempIndexDir, { recursive: true, force: true });
  }
}

export function scanPlatformSensitiveDiff(diffText) {
  const findings = [];
  let currentFile = null;
  let currentNewLine = 0;

  for (const rawLine of String(diffText || '').split(/\r?\n/)) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice(6).trim();
      continue;
    }
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = Number(hunkMatch[1]);
      continue;
    }
    if (!currentFile) continue;

    const isCodeOrConfig =
      currentFile.startsWith('desktop/') ||
      currentFile.startsWith('src/') ||
      currentFile.startsWith('scripts/') ||
      currentFile === 'package.json';
    if (!isCodeOrConfig) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const codeLine = rawLine.slice(1);
      for (const rule of PLATFORM_SENSITIVE_RULES) {
        if (rule.regex.test(codeLine)) {
          findings.push({
            file: currentFile,
            line: currentNewLine,
            ruleId: rule.id,
            ruleLabel: rule.label,
            snippet: codeLine.trim().slice(0, 140),
          });
          break;
        }
      }
      currentNewLine += 1;
    } else if (!rawLine.startsWith('-') && !rawLine.startsWith('\\')) {
      currentNewLine += 1;
    }
  }

  return findings;
}

function parseNameStatus(output) {
  const map = new Map();
  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const status = parts[0];
    const filePath = (parts[parts.length - 1] || '').trim();
    if (filePath) {
      map.set(filePath, status);
    }
  }
  return map;
}

function isGovernanceOnlyFile(relPath) {
  return GOVERNANCE_ONLY_PREFIXES.some(
    (prefix) => relPath === prefix || (prefix.endsWith('/') && relPath.startsWith(prefix)),
  );
}

export function analyzeUpstreamDelta({
  cwd = ROOT,
  version,
  ourRef = 'main',
  baseRef = null,
  outFile = null,
} = {}) {
  const { version: normVersion, upstreamTag } = normalizeVersionTag(version);
  if (!refExists(`refs/tags/${upstreamTag}`, cwd)) {
    throw new Error(`未找到上游标签 ${upstreamTag}，请先运行 npm run upstream:import -- --version ${normVersion}`);
  }

  const mergeBase =
    baseRef || git(['merge-base', ourRef, `refs/tags/${upstreamTag}`], cwd);

  const upstreamChanges = parseNameStatus(
    git(['diff', '--name-status', `${mergeBase}..refs/tags/${upstreamTag}`], cwd),
  );
  const ourChanges = parseNameStatus(
    git(['diff', '--name-status', `${mergeBase}..${ourRef}`], cwd),
  );

  const categoryA_upstreamOnly = [];
  const categoryB_overlap = [];
  const ourMacAdaptedFiles = [];

  for (const [file, ourStatus] of ourChanges.entries()) {
    if (!isGovernanceOnlyFile(file)) {
      ourMacAdaptedFiles.push({ file, ourStatus });
    }
  }

  for (const [file, upstreamStatus] of upstreamChanges.entries()) {
    if (ourChanges.has(file) && !isGovernanceOnlyFile(file)) {
      categoryB_overlap.push({
        file,
        upstreamStatus,
        ourStatus: ourChanges.get(file),
      });
    } else {
      categoryA_upstreamOnly.push({
        file,
        upstreamStatus,
      });
    }
  }

  const upstreamDiffText = git(
    ['diff', '-U0', `${mergeBase}..refs/tags/${upstreamTag}`, '--', 'desktop', 'src', 'scripts', 'package.json'],
    cwd,
  );
  const categoryC_platformSensitive = scanPlatformSensitiveDiff(upstreamDiffText);

  const reportLines = [
    `# 上游版本三方差异与 macOS 适配评估报告 (${normVersion})`,
    '',
    `- **对比基线 (Merge Base)**: \`${mergeBase}\``,
    `- **上游目标版本**: \`${upstreamTag}\` (共变更 ${upstreamChanges.size} 个文件)`,
    `- **本仓目标分支**: \`${ourRef}\` (已完成 macOS 适配文件 ${ourMacAdaptedFiles.length} 个)`,
    '',
    `## 1. 分类 A：仅上游修改文件 (${categoryA_upstreamOnly.length} 个，可直接无损合入)`,
    ...(categoryA_upstreamOnly.length > 0
      ? categoryA_upstreamOnly.map((item) => `- \`[${item.upstreamStatus}]\` \`${item.file}\``)
      : ['- (无)']),
    '',
    `## 2. 分类 B：双方共改 / 重叠文件 (${categoryB_overlap.length} 个，合并时必须保留我方 macOS 适配)`,
    ...(categoryB_overlap.length > 0
      ? categoryB_overlap.map(
          (item) => `- \`[上游:${item.upstreamStatus} / 我方:${item.ourStatus}]\` \`${item.file}\``,
        )
      : ['- (无重叠修改文件)']),
    '',
    `## 3. 分类 C：上游新增的平台敏感代码 (${categoryC_platformSensitive.length} 处，需核查并补充 macOS 适配)`,
    ...(categoryC_platformSensitive.length > 0
      ? categoryC_platformSensitive.map(
          (item) =>
            `- \`${item.file}:${item.line}\` — **${item.ruleLabel}**: \`${item.snippet}\``,
        )
      : ['- (未检测到新增平台敏感代码行)']),
    '',
  ];

  const reportContent = reportLines.join('\n');
  const gitDir = resolve(cwd, git(['rev-parse', '--git-dir'], cwd));
  const targetOut = outFile
    ? resolve(cwd, outFile)
    : join(gitDir, `upstream-analysis-${normVersion}.md`);
  writeFileSync(targetOut, reportContent, 'utf8');

  return {
    ok: true,
    version: normVersion,
    upstreamTag,
    mergeBase,
    ourRef,
    reportPath: targetOut,
    categoryA_upstreamOnly,
    categoryB_overlap,
    categoryC_platformSensitive,
    ourMacAdaptedFiles,
  };
}

export function prepareUpstreamMergeBranch({
  cwd = ROOT,
  version,
  ourRef = 'main',
  branchName = null,
} = {}) {
  const dirty = git(['status', '--porcelain'], cwd);
  if (dirty) {
    throw new Error('当前工作区存在未提交变更，请先保持工作区干净后再准备上游合并分支。');
  }

  const analysis = analyzeUpstreamDelta({ cwd, version, ourRef });
  const targetBranch = branchName || `mac/upstream-${analysis.version}`;

  git(['checkout', '-B', targetBranch, ourRef], cwd);

  const mergeRes = spawnSync(
    'git',
    ['merge', '--no-commit', '--no-ff', `refs/tags/${analysis.upstreamTag}`],
    { cwd, encoding: 'utf8' },
  );

  const conflictedFiles = git(['diff', '--name-only', '--diff-filter=U'], cwd)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const activeTaskLines = [
    '# ACTIVE_TASK.md — 当前开发任务规格说明书 (Current Task Specification)',
    '',
    '## 1. 任务概述 (Task Overview)',
    '',
    `- **任务名称**：同步并合并上游 Ester Studio ${analysis.version} 源码快照与 macOS 增量适配`,
    `- **关联分支**：\`${targetBranch}\``,
    '- **当前状态**：`DRAFT`',
    `- **核心目标**：基于共同祖先 \`${analysis.mergeBase.slice(0, 8)}\` 将上游 \`${analysis.upstreamTag}\` 三方合并入本仓，保留全部既有 macOS 适配逻辑，并对上游新增功能完成 macOS 兼容性核查与单元测试。`,
    '',
    '## 2. 需求细节与范围边界 (Requirements & Scope Boundary)',
    '',
    '### 2.1 核心功能点 (In Scope)',
    `- [ ] **合入分类 A（仅上游修改文件，共 ${analysis.categoryA_upstreamOnly.length} 个）**`,
    `- [ ] **核查分类 B（双方共改重叠文件，共 ${analysis.categoryB_overlap.length} 个，确保保留我方 macOS 适配）**：`,
    ...(analysis.categoryB_overlap.length > 0
      ? analysis.categoryB_overlap.map((i) => `  - \`${i.file}\` (上游:${i.upstreamStatus}, 我方:${i.ourStatus})`)
      : ['  - (无双方共改重叠文件)']),
    `- [ ] **适配分类 C（上游新增平台敏感代码，共 ${analysis.categoryC_platformSensitive.length} 处）**：`,
    ...(analysis.categoryC_platformSensitive.length > 0
      ? analysis.categoryC_platformSensitive.map(
          (i) => `  - \`${i.file}:${i.line}\` (${i.ruleLabel}): \`${i.snippet}\``,
        )
      : ['  - (无新增平台敏感代码)']),
    ...(conflictedFiles.length > 0
      ? [
          `- [ ] **解决三方合并冲突文件（共 ${conflictedFiles.length} 个）**：`,
          ...conflictedFiles.map((f) => `  - \`${f}\``),
        ]
      : []),
    '',
    '### 2.2 非目标边界 (Out of Scope)',
    '- 仅同步并适配上游本次版本增量，不引入与本次上游更新无关的重构。',
    '',
    '## 3. 技术设计方案 (Technical Design)',
    '',
    `- **评估报告路径**：\`${analysis.reportPath}\``,
    '- **三方合并策略**：利用 `upstream/release` 分支与 `main` 的共同祖先执行 Git 3-Way Merge，保留 `main` 上的 macOS 运行时与 UI 适配，同时合入上游新特性。',
    '',
    '## 4. 自动化测试计划 (Automated Test Plan)',
    '',
    '- 运行全量 `npm test` 并针对分类 B/C 涉及的模块补充或更新单元测试。',
    '',
    '## 5. 用户沟通与意图确认记录 (User Intent Confirmation)',
    '',
    `- 用户请求同步上游 ${analysis.version} 并保留 macOS 适配。`,
    '- **用户是否已确认**：`PENDING`',
    '',
  ];

  writeFileSync(join(cwd, ACTIVE_TASK_FILE_NAME), activeTaskLines.join('\n'), 'utf8');

  return {
    ok: true,
    branch: targetBranch,
    cleanMerge: mergeRes.status === 0 && conflictedFiles.length === 0,
    conflictedFiles,
    analysis,
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'check';
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : null;
  };

  if (cmd === 'init') {
    const res = initUpstreamTracking();
    console.log(`[upstream:init] ✅ 已锚定上游基准 ${res.baselineTag} -> ${res.baseCommit}`);
    return;
  }

  if (cmd === 'check') {
    const res = await checkUpstreamReleases();
    console.log(`\n=== 上游仓库 (${res.upstreamRepo}) 版本跟踪状态 ===`);
    console.log(`本地已跟踪标签: ${res.localTags.map((t) => t.tag).join(', ') || '(无)'}`);
    for (const rel of res.releases) {
      const status = rel.tracked ? '✅ 已跟踪' : '🆕 未同步新版';
      console.log(`- ${rel.version} (${rel.name}) [${status}] 发布于: ${rel.publishedAt || 'unknown'}`);
      if (!rel.tracked && rel.sourceAsset) {
        console.log(`  📦 源码包: ${rel.sourceAsset.url}`);
        if (rel.sourceAsset.sha256) {
          console.log(`  🔒 SHA-256: ${rel.sourceAsset.sha256}`);
        }
      }
    }
    return;
  }

  if (cmd === 'import') {
    const version = getArg('--version') || getArg('-v');
    const sourcePath = getArg('--source') || getArg('-s');
    const res = importUpstreamSnapshot({ version, sourcePath });
    console.log(
      `[upstream:import] ✅ 已导入上游快照 ${res.upstreamTag} (${res.fileCount} 个文件) -> ${res.commit}`,
    );
    return;
  }

  if (cmd === 'analyze') {
    const version = getArg('--version') || getArg('-v');
    const ourRef = getArg('--ours') || 'main';
    const outFile = getArg('--out');
    const res = analyzeUpstreamDelta({ version, ourRef, outFile });
    console.log(`[upstream:analyze] ✅ 三方差异分析完成: ${res.reportPath}`);
    console.log(
      `  - 分类 A (仅上游修改): ${res.categoryA_upstreamOnly.length} 个文件\n` +
        `  - 分类 B (双方共改重叠): ${res.categoryB_overlap.length} 个文件\n` +
        `  - 分类 C (新增平台敏感点): ${res.categoryC_platformSensitive.length} 处`,
    );
    return;
  }

  if (cmd === 'prepare-merge') {
    const version = getArg('--version') || getArg('-v');
    const ourRef = getArg('--ours') || 'main';
    const branchName = getArg('--branch');
    const res = prepareUpstreamMergeBranch({ version, ourRef, branchName });
    console.log(
      `[upstream:prepare-merge] ✅ 已切出三方合并分支 ${res.branch} (冲突文件: ${res.conflictedFiles.length} 个)，并已更新 ACTIVE_TASK.md。`,
    );
    return;
  }

  throw new Error(`未知子命令: ${cmd} (支持: init | check | import | analyze | prepare-merge)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((err) => {
    console.error(`\n❌ [upstream 错误] ${err.message}\n`);
    process.exit(1);
  });
}
