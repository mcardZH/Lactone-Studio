import type {
  AdvancedSettings,
  Dispersion,
  FileSettings,
  GaussianSettings,
  InputStructureSource,
  JobRequest,
  MethodId,
  Structure,
  TaskId
} from '../../core/types';
import { defaultAdvanced } from '../../core/advanced';
import { initialBaseElectronicState } from '../../core/base-electronic-state';
import { basisSize, unsupportedElements } from '../../core/basis';
import { builderCoordinateValue } from '../../core/builder-geometry';
import { BASES, canonicalBasis, METHODS } from '../../core/catalog';
import { atomicNumber, ELEMENTS, electronicStateError, suggestedMultiplicity } from '../../core/elements';
import {
  buildGaussian,
  defaultFiles,
  defaultSettings,
  isSemiempirical,
  methodDefaults,
  previewGaussian,
  previewRoute,
  setUse5D
} from '../../core/gaussian';
import { recommendedExcitedStates } from '../../core/input-recommendations';
import { cleanStem, taskStem } from '../../core/naming';
import {
  buildOrcaCommon,
  createOrcaCommonSettings,
  getOrcaCommonCompatibility,
  getOrcaCommonMethods,
  getOrcaMethodProfile,
  ORCA_BASES,
  ORCA_VERSIONS,
  type OrcaJobRequest,
  type OrcaMethodId,
  type OrcaSettings,
  type OrcaTask,
  type OrcaVersion
} from '../../core/orca';
import { referencedOrcaAssets } from '../../core/orca/assets';
import { ORCA_CORRELATION_BASES } from '../../core/orca/catalog';
import { orcaTaskStem } from '../../core/orca/naming';
import {
  findSolventEntry,
  getSolventEntries,
  searchSolvents,
  solventSelectionForModelChange
} from '../../core/solvents';
import { defaultTaskOptions, isEnergyTask, taskRecommendation, TASKS } from '../../core/tasks';
import { isXtb } from '../../core/xtb';
import { modelCoordinateKey } from '../../modeling/constraints';
import type { ModelCoordinate, ModelDocument, ModelStore } from '../../modeling/contracts';
import {
  applySharedGaussianConstraints,
  captureDesktopAssignments,
  captureGaussianCoordinates,
  integrateDesktopBuilderResult
} from '../../modeling/application/gaussian-bridge';
import {
  applySharedOrcaConstraints,
  captureOrcaAssignments,
  captureOrcaCoordinates,
  integrateOrcaBuilderResult
} from '../../modeling/application/orca-bridge';
import {
  projectCanonicalGaussianFreezes,
  projectCanonicalOrcaFreezes
} from '../../modeling/application/canonical-freezes';
import { orcaImportSystemStem } from '../../modeling/application/orca-import-naming';
import {
  orcaGeneratedSource,
  type OrcaGeneratedDrafts
} from '../../modeling/application/orca-generated-draft';
import {
  readProjectInputDrafts,
  restoredOrcaProjectRequest,
  type SavedGaussianInputDraft,
  type SavedOrcaInputDraft
} from '../../modeling/application/project-input-draft';
import {
  formalInputStructure,
  projectSessionModel
} from '../../modeling/application/session-projection';
import {
  projectGaussianTaskStructure,
  projectOrcaTaskStructure
} from '../../modeling/application/task-structure-projection';
import { defaultTitle, jobSignature } from '../application/input-presentation';

export function computeHillFormula(atoms: ReadonlyArray<{ element: string }>): string {
  if (!atoms.length) return '';
  const counts = new Map<string, number>();
  for (const atom of atoms) {
    const symbol = typeof atom.element === 'string' ? atom.element.trim() : '';
    if (!symbol) continue;
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  if (!counts.size) return '';

  const orderedSymbols: string[] = [];
  if (counts.has('C')) {
    orderedSymbols.push('C');
    if (counts.has('H')) {
      orderedSymbols.push('H');
    }
    const rest = [...counts.keys()]
      .filter(sym => sym !== 'C' && sym !== 'H')
      .sort((a, b) => a.localeCompare(b));
    orderedSymbols.push(...rest);
  } else {
    orderedSymbols.push(...[...counts.keys()].sort((a, b) => a.localeCompare(b)));
  }

  return orderedSymbols
    .map(sym => {
      const count = counts.get(sym) ?? 0;
      return count > 1 ? `${sym}${count}` : sym;
    })
    .join('');
}

export const SUPPORTED_GAUSSIAN_TASKS: ReadonlySet<TaskId> = new Set([
  'sp',
  'opt',
  'freq',
  'optfreq',
  'scan',
  'constrained',
  'ts',
  'irc',
  'td',
  'tdopt',
  't1opt',
  'nmr',
  'stable',
  'bsse'
]);

export const SUPPORTED_ORCA_TASKS: ReadonlySet<OrcaTask> = new Set([
  'sp',
  'opt',
  'freq',
  'optfreq',
  'scan',
  'ts',
  'irc',
  'td',
  'tdopt',
  'nmr',
  'stable',
  'bsse',
  'neb',
  'esd',
  'md'
]);

const GAUSSIAN_METHOD_ALIASES: Readonly<Record<string, MethodId>> = Object.freeze({
  b3lyp: 'b3lyp',
  pbe0: 'pbe0',
  pbe1pbe: 'pbe0',
  m062x: 'm062x',
  'm06-2x': 'm062x',
  wb97xd: 'wb97xd',
  'wb97x-d': 'wb97xd',
  'ωb97xd': 'wb97xd',
  'ωb97x-d': 'wb97xd',
  'cam-b3lyp': 'cam-b3lyp',
  camb3lyp: 'cam-b3lyp',
  tpss: 'tpss',
  tpsstpss: 'tpss',
  tpssh: 'tpssh',
  pm6: 'pm6',
  pm7: 'pm7',
  'gfn2-xtb': 'gfn2-xtb',
  xtb: 'gfn2-xtb',
  xtb2: 'gfn2-xtb',
  custom: 'custom'
});

const ORCA_METHOD_ALIASES: Readonly<Record<string, OrcaMethodId>> = Object.freeze({
  b3lyp: 'b3lyp',
  'b3lyp-d3bj': 'b3lyp',
  'b3lyp-d3(bj)': 'b3lyp',
  pbe0: 'pbe0',
  'pbe0-d3bj': 'pbe0',
  'pbe0-d3(bj)': 'pbe0',
  m062x: 'm062x',
  'm06-2x': 'm062x',
  'cam-b3lyp': 'cam-b3lyp',
  camb3lyp: 'cam-b3lyp',
  'wb97x-d3': 'wb97x-d3',
  wb97xd3: 'wb97x-d3',
  wb97xd: 'wb97x-d3',
  'wb97x-d': 'wb97x-d3',
  'ωb97x-d3': 'wb97x-d3',
  'wb97m-v': 'wb97m-v',
  wb97mv: 'wb97m-v',
  'ωb97m-v': 'wb97m-v',
  'wb97x-v': 'wb97x-v',
  wb97xv: 'wb97x-v',
  'ωb97x-v': 'wb97x-v',
  tpss: 'tpss',
  'tpss-d3bj': 'tpss',
  tpssh: 'tpssh',
  'tpssh-d3bj': 'tpssh',
  'hf-3c': 'hf-3c',
  hf3c: 'hf-3c',
  'pbeh-3c': 'pbeh-3c',
  pbeh3c: 'pbeh-3c',
  'b97-3c': 'b97-3c',
  b973c: 'b97-3c',
  'r2scan-3c': 'r2scan-3c',
  r2scan3c: 'r2scan-3c',
  'wb97x-3c': 'wb97x-3c',
  wb97x3c: 'wb97x-3c',
  'ωb97x-3c': 'wb97x-3c',
  xtb2: 'xtb2',
  'gfn2-xtb': 'xtb2',
  xtb: 'xtb2',
  'pwpb95-d4': 'pwpb95-d4',
  pwpb95: 'pwpb95-d4',
  'revdsd-pbep86-d4-2021': 'revdsd-pbep86-d4-2021',
  'revdsd-pbep86-d4': 'revdsd-pbep86-d4-2021',
  'wb97x-2-d3bj': 'wb97x-2-d3bj',
  'wb97x-2': 'wb97x-2-d3bj',
  'dlpno-ccsd-t': 'dlpno-ccsd-t',
  'dlpno-ccsd(t)': 'dlpno-ccsd-t',
  'dlpno-ccsd-t1': 'dlpno-ccsd-t1',
  'dlpno-ccsd(t1)': 'dlpno-ccsd-t1'
});

const SAFE_STEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const CUSTOM_METHOD_KEYWORD_RE = /^[A-Za-z][A-Za-z0-9()+_.-]*$/;
const FORBIDDEN_CUSTOM_METHOD_RE = /^(opt|freq|irc|qst2|qst3|counterpoise|td|tda|stable|external)(?:\b|\()/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertAllowedObjectKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  parentName: string
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw Object.assign(
        new Error(`Unsupported key "${key}" in settings.${parentName}`),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
  }
}

function validateSafeJobStem(raw: string, fieldName: string): string {
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > 100 ||
    CONTROL_CHAR_RE.test(trimmed) ||
    !SAFE_STEM_RE.test(trimmed) ||
    trimmed.endsWith('.') ||
    trimmed.includes('..') ||
    WINDOWS_RESERVED_DEVICE_RE.test(trimmed)
  ) {
    throw Object.assign(
      new Error(
        `Invalid ${fieldName} "${raw}": must be 1..100 safe ASCII characters (letters, digits, '.', '_', '-'), without '..', trailing '.', control characters, or reserved device names`
      ),
      { code: 'INVALID_CALCULATION_SETTINGS' }
    );
  }
  return trimmed;
}

function validateSafeCheckpointName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (CONTROL_CHAR_RE.test(trimmed) || trimmed.length > 104 || !/\.chk$/i.test(trimmed)) {
    throw Object.assign(
      new Error(`Invalid settings.checkpointName "${raw}": must be a safe ASCII filename ending in .chk`),
      { code: 'INVALID_CALCULATION_SETTINGS' }
    );
  }
  const stem = trimmed.slice(0, -4);
  validateSafeJobStem(stem, 'settings.checkpointName');
  return trimmed;
}

function validateSafeCustomMethod(raw: string): string {
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > 64 ||
    CONTROL_CHAR_RE.test(trimmed) ||
    !CUSTOM_METHOD_KEYWORD_RE.test(trimmed) ||
    FORBIDDEN_CUSTOM_METHOD_RE.test(trimmed)
  ) {
    throw Object.assign(
      new Error(
        `Invalid settings.customMethod "${raw}": must be a single valid Gaussian method keyword without spaces, newlines, or task/execution directives`
      ),
      { code: 'INVALID_METHOD' }
    );
  }
  return trimmed;
}

function validateSafeTitle(raw: string): string {
  if (CONTROL_CHAR_RE.test(raw)) {
    throw Object.assign(
      new Error('settings.title must not contain newlines or control characters'),
      { code: 'INVALID_CALCULATION_SETTINGS' }
    );
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) {
    throw Object.assign(
      new Error('settings.title must be a non-empty string of up to 200 characters'),
      { code: 'INVALID_CALCULATION_SETTINGS' }
    );
  }
  return trimmed;
}

function isGasPhaseSolvent(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || /^(gas|none|gas-phase|vacuum|气相)$/i.test(trimmed);
}

export function normalizeGaussianMethodId(raw: string): MethodId {
  const key = raw.trim().toLowerCase();
  const matched = GAUSSIAN_METHOD_ALIASES[key];
  if (!matched) {
    throw Object.assign(
      new Error(
        `Unsupported Gaussian method "${raw}". Supported methods: ${METHODS.map(m => m.id).join(', ')} (or set method="custom" with customMethod).`
      ),
      { code: 'INVALID_METHOD' }
    );
  }
  return matched;
}

export function normalizeOrcaMethodId(raw: string): OrcaMethodId {
  const key = raw.trim().toLowerCase();
  const matched = ORCA_METHOD_ALIASES[key];
  if (!matched) {
    throw Object.assign(
      new Error(
        `Unsupported ORCA method "${raw}". Supported methods: ${getOrcaCommonMethods().map(m => m.id).join(', ')}.`
      ),
      { code: 'INVALID_METHOD' }
    );
  }
  return matched;
}

export function normalizeGaussianBasisName(raw: string): string {
  const canonical = canonicalBasis(raw);
  if (!BASES.some(b => b.value === canonical)) {
    throw Object.assign(
      new Error(
        `Unsupported Gaussian basis "${raw}". Supported verified bases: ${BASES.map(b => b.value).join(', ')}.`
      ),
      { code: 'INVALID_BASIS' }
    );
  }
  return canonical;
}

export function normalizeOrcaBasisName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /^(builtin|none)$/i.test(trimmed)) return '';
  const compact = trimmed.toLowerCase().replace(/[\s_-]+/g, '');
  const aliasMap: Record<string, string> = {
    def2svp: 'def2-SVP',
    'def2sv(p)': 'def2-SV(P)',
    def2svpp: 'def2-SV(P)',
    def2svpd: 'def2-SVPD',
    def2tzvp: 'def2-TZVP',
    def2tzvpp: 'def2-TZVPP',
    def2tzvpd: 'def2-TZVPD',
    def2tzvppd: 'def2-TZVPPD',
    def2qzvp: 'def2-QZVP',
    def2qzvpp: 'def2-QZVPP',
    def2qzvpd: 'def2-QZVPD',
    def2qzvppd: 'def2-QZVPPD'
  };
  const resolved = aliasMap[compact] ?? ORCA_BASES.find(b => b.toLowerCase() === trimmed.toLowerCase());
  if (!resolved) {
    throw Object.assign(
      new Error(
        `Unsupported ORCA basis "${raw}". Supported verified ORCA def2 bases: ${ORCA_BASES.join(', ')}.`
      ),
      { code: 'INVALID_BASIS' }
    );
  }
  return resolved;
}

function resolveSolventForEngine(
  engine: 'gaussian' | 'orca',
  model: 'iefpcm' | 'cpcm' | 'smd',
  query: string,
  orcaVersion: OrcaVersion = '6.1'
) {
  if (isGasPhaseSolvent(query)) {
    return {
      isGas: true as const,
      solvent: '',
      solvation: undefined,
      entry: null
    };
  }
  const found = findSolventEntry(
    engine,
    model,
    query,
    engine === 'orca' ? orcaVersion : undefined
  );
  if (!found) {
    const catalog = getSolventEntries(
      engine,
      model,
      engine === 'orca' ? orcaVersion : undefined
    );
    const candidates = searchSolvents(catalog, query)
      .slice(0, 5)
      .map(e => `${e.englishName} (${e.chineseName})`);
    throw Object.assign(
      new Error(
        `Solvent "${query}" is not in Ester Studio's verified ${engine.toUpperCase()} ${model.toUpperCase()} library.` +
          (candidates.length ? ` Closest matches: ${candidates.join(', ')}.` : '')
      ),
      { code: 'INVALID_SOLVENT' }
    );
  }
  const keyword = engine === 'gaussian'
    ? (model === 'smd' ? found.gaussian!.smd! : found.gaussian!.pcm!)
    : (model === 'smd' ? found.orca!.smd! : found.orca!.cpcm!);
  return {
    isGas: false as const,
    solvent: keyword,
    solvation: { mode: 'builtin' as const, id: found.id },
    entry: {
      id: found.id,
      englishName: found.englishName,
      chineseName: found.chineseName,
      keyword,
      dielectric: found.dielectric ?? found.dielectricReference?.value ?? null
    }
  };
}

function convertCoordinatesForEngine(
  rows: readonly ModelCoordinate[],
  structure: Structure,
  targetEngine: 'gaussian' | 'orca'
): ModelCoordinate[] {
  const existingIds = new Set(structure.atoms.map(a => a.id!));
  const validRows = rows.filter(r => r.atomIds.every(id => existingIds.has(id)));
  if (targetEngine === 'gaussian') {
    return validRows.map(row => {
      if (row.action !== 'scan') return structuredClone(row);
      if (row.source === 'orca') {
        const intervals = Math.max(1, row.steps - 1);
        const derivedInc =
          typeof row.increment === 'number' && Number.isFinite(row.increment) && row.increment !== 0
            ? row.increment
            : (row.start !== undefined && row.end !== undefined && row.steps > 1
              ? Number(((row.end - row.start) / (row.steps - 1)).toFixed(6))
              : 0.1);
        return {
          id: row.id?.startsWith('mcp-scan:') ? row.id : `mcp-scan:${modelCoordinateKey(row)}`,
          type: row.type,
          atomIds: [...row.atomIds],
          action: 'scan',
          steps: intervals,
          increment: derivedInc
        };
      }
      return structuredClone(row);
    });
  }

  let scanIndex = 0;
  return validRows.map(row => {
    if (row.action !== 'scan') return structuredClone(row);
    if (row.source === 'orca' && row.start !== undefined && row.end !== undefined && row.steps >= 2) {
      return {
        ...structuredClone(row),
        id: row.id?.startsWith('orca-constraints-') ? row.id : `orca-constraints-${scanIndex++}`
      };
    }
    const intervals = Math.max(1, row.steps);
    const inc = typeof row.increment === 'number' && Number.isFinite(row.increment) && row.increment !== 0
      ? row.increment
      : 0.1;
    const start = Number(builderCoordinateValue(structure, row.type, row.atomIds, row.images).toFixed(6));
    const end = Number((start + intervals * inc).toFixed(6));
    const validOrcaEndpoint = (val: number) =>
      Number.isFinite(val) &&
      (row.type === 'B' ? val > 0 : row.type === 'A' ? val > 0 && val < 180 : true);
    if (!validOrcaEndpoint(start) || !validOrcaEndpoint(end) || start === end) {
      throw Object.assign(
        new Error(`ORCA scan range [${start}, ${end}] for ${row.type} is physically invalid`),
        { code: 'INVALID_COORDINATE_CONSTRAINT' }
      );
    }
    return {
      id: `orca-constraints-${scanIndex++}`,
      type: row.type,
      atomIds: [...row.atomIds],
      action: 'scan',
      source: 'orca',
      start,
      end,
      steps: intervals + 1,
      increment: inc
    };
  });
}

function resolveAuthoritativeCoordinatesForEngine(
  store: ModelStore,
  modelDoc: ModelDocument,
  structure: Structure,
  targetEngine: 'gaussian' | 'orca'
): ModelCoordinate[] {
  const exportedScope = store.exportProjectState?.()?.contextScope;
  const activeScope: 'gaussian' | 'orca' = exportedScope === 'orca'
    ? 'orca'
    : exportedScope === 'gaussian'
      ? 'gaussian'
      : ((modelDoc.internalCoordinates ?? []).some(c => c.source === 'orca') ? 'orca' : 'gaussian');
  const activeCoords = modelDoc.internalCoordinates ?? [];
  const targetCtxCoords = store.getContext(targetEngine)?.coordinates ?? [];
  const rawSource =
    activeScope === targetEngine
      ? activeCoords
      : activeCoords.some(c => c.action === 'scan')
        ? activeCoords
        : targetCtxCoords;
  return convertCoordinatesForEngine(rawSource, structure, targetEngine);
}

export interface RecommendMethodOptions {
  documentId: string;
  label: string;
  structure: Structure;
  electronicStateConfirmed: boolean;
  engine: 'gaussian' | 'orca' | 'both';
  task: string;
  solvent?: string;
}

export function recommendCalculationMethod(options: RecommendMethodOptions): Record<string, unknown> {
  const { documentId, label, structure, electronicStateConfirmed, engine, task, solvent } = options;
  const uniqueElements = [...new Set(structure.atoms.map(a => a.element))];
  const heavyEcpElements = uniqueElements.filter(el => atomicNumber(el) >= 37);
  const standardDef2EcpElements = uniqueElements.filter(el => {
    const z = atomicNumber(el);
    return z >= 37 && z <= 86 && (z < 58 || z > 71);
  });
  const lanthanideElements = uniqueElements.filter(el => {
    const z = atomicNumber(el);
    return z >= 58 && z <= 71;
  });
  const superheavyElements = uniqueElements.filter(el => atomicNumber(el) > 86);
  const isPeriodic = Boolean(structure.cell && structure.cell.pbc?.some(Boolean));

  const charge = structure.charge ?? initialBaseElectronicState(structure).charge;
  const multiplicity = structure.multiplicity ?? suggestedMultiplicity(structure.atoms, charge);
  const spinParityError = structure.atoms.length > 0
    ? electronicStateError(structure.atoms, charge, multiplicity)
    : null;

  const warnings: string[] = [];
  if (!structure.atoms.length) {
    warnings.push('当前文档尚未导入原子结构；以下为通用任务推荐，导入结构后可核验具体元素基组覆盖度。');
  }
  if (isPeriodic) {
    warnings.push(
      '当前模型包含周期边界晶胞（PBC）；Gaussian 与 ORCA 输入模块仅面向有限分子体系，需先提取团簇/无盒分子模型后再生成输入。'
    );
  }
  if (structure.dimension === 2) {
    warnings.push('当前结构为二维坐标（2D），生成量化输入前请先构建真实三维几何。');
  }
  if (spinParityError) {
    warnings.push(`当前电荷/自旋多重度奇偶不自洽：${spinParityError}`);
  }
  if (standardDef2EcpElements.length > 0) {
    warnings.push(
      `检测到第 5–6 周期重元素（${standardDef2EcpElements.join(', ')}）：Gaussian 使用 def2 系列基组时将自动切换 GenECP 写入赝势，ORCA 将自动匹配 def2-ECP。`
    );
  }
  if (lanthanideElements.length > 0) {
    warnings.push(
      `检测到镧系元素（${lanthanideElements.join(', ')}）：Gaussian 内置单一全局基组不直接覆盖 Ce–Lu，需在界面配置混合/外部 ECP 基组，或使用 ORCA 6.1 的 def2 / 3c 方案。`
    );
  }
  if (superheavyElements.length > 0) {
    warnings.push(
      `检测到超重/锕系元素（${superheavyElements.join(', ')}，Z>86）：超出标准 def2 基组上限（H–Rn）；ORCA 几何任务可考虑 r2SCAN-3c（Z<=103），或提供经核实的外部相对论基组/ECP。`
    );
  }

  let gaussianRecommendation: Record<string, unknown> | undefined;
  if (engine === 'gaussian' || engine === 'both') {
    if (!SUPPORTED_GAUSSIAN_TASKS.has(task as TaskId)) {
      if (engine === 'gaussian') {
        throw Object.assign(
          new Error(
            `Task "${task}" is not supported by Gaussian input builder (supported: ${[...SUPPORTED_GAUSSIAN_TASKS].join(', ')})`
          ),
          { code: 'INVALID_CALCULATION_TASK' }
        );
      }
      gaussianRecommendation = {
        supported: false,
        reason: `Gaussian 输入模块不支持任务 "${task}"（如 NEB/ESD/MD 请选择 engine="orca"）。`
      };
    } else {
      const gTask = task as TaskId;
      const baseDefaults = defaultSettings(gTask);
      let recBasis = baseDefaults.basis;
      let basisUpgradedReason: string | undefined;

      if (uniqueElements.length > 0 && unsupportedElements(recBasis, uniqueElements).length > 0) {
        const fallbackCandidates = isEnergyTask(gTask) || gTask === 'nmr'
          ? ['def2TZVP', 'ma-def2TZVP', 'def2SVP']
          : ['def2SVP', 'def2TZVP'];
        const viable = fallbackCandidates.find(b => unsupportedElements(b, uniqueElements).length === 0);
        if (viable) {
          basisUpgradedReason = `默认基组 ${baseDefaults.basis} 不覆盖元素 [${unsupportedElements(baseDefaults.basis, uniqueElements).join(', ')}]，已自动切换为全覆盖基组 ${viable}。`;
          recBasis = viable;
        }
      }

      const recUnsupported = uniqueElements.length > 0 ? unsupportedElements(recBasis, uniqueElements) : [];
      const basisSupported = recUnsupported.length === 0;
      const sizeInfo = structure.atoms.length > 0 && basisSupported ? basisSize(structure, recBasis) : null;
      const compatibleBases = BASES.map(entry => {
        const missing = uniqueElements.length > 0 ? unsupportedElements(entry.value, uniqueElements) : [];
        const bSize = structure.atoms.length > 0 && missing.length === 0
          ? basisSize(structure, entry.value)
          : null;
        return {
          basis: entry.value,
          label: entry.label,
          size: entry.size,
          diffuse: Boolean(entry.diffuse),
          supported: missing.length === 0,
          ...(missing.length > 0 ? { unsupportedElements: missing } : {}),
          basisFunctionCount: bSize?.count ?? null
        };
      });

      const compatibleMethods = METHODS.filter(m => m.id !== 'custom').map(m => {
        let supported = true;
        let reason: string | undefined;
        if (m.id === 'pm6' || m.id === 'pm7') {
          const limit = m.id === 'pm6' ? 56 : 57;
          const bad = uniqueElements.filter(el => {
            const z = atomicNumber(el);
            return !(z <= limit || (z >= 71 && z <= 83));
          });
          if (bad.length > 0) {
            supported = false;
            reason = `${m.label} 半经验参数不覆盖元素: ${bad.join(', ')}`;
          }
        }
        return {
          id: m.id,
          label: m.label,
          keyword: m.keyword,
          family: m.family,
          defaultDispersion: m.dispersion,
          supported,
          ...(reason ? { reason } : {}),
          caution: m.caution
        };
      });

      let solventResolution: Record<string, unknown> | undefined;
      if (solvent && !isGasPhaseSolvent(solvent)) {
        try {
          const resolved = resolveSolventForEngine('gaussian', baseDefaults.solventModel, solvent);
          solventResolution = {
            matched: true,
            solventModel: baseDefaults.solventModel,
            ...resolved.entry
          };
        } catch (err) {
          solventResolution = {
            matched: false,
            solventModel: baseDefaults.solventModel,
            message: err instanceof Error ? err.message : String(err)
          };
        }
      }

      gaussianRecommendation = {
        supported: true,
        task: gTask,
        taskName: TASKS.find(t => t.id === gTask)?.name ?? gTask,
        recommended: {
          method: baseDefaults.method,
          methodLabel: METHODS.find(m => m.id === baseDefaults.method)?.label ?? baseDefaults.method,
          basis: recBasis,
          basisSupported,
          ...(recUnsupported.length > 0 ? { unsupportedElements: recUnsupported } : {}),
          dispersion: baseDefaults.dispersion,
          grid: baseDefaults.grid,
          scf: baseDefaults.scf,
          solventModel: baseDefaults.solventModel,
          requiresGenEcp: basisSupported && /^def2/i.test(recBasis) && standardDef2EcpElements.length > 0,
          basisFunctionCount: sizeInfo?.count ?? null,
          ...(gTask === 'td' || gTask === 'tdopt'
            ? { recommendedNStates: recommendedExcitedStates(structure.atoms.length || 20, gTask, 1) }
            : {}),
          rationale: basisSupported
            ? taskRecommendation(gTask)
            : `${taskRecommendation(gTask)} 注意：当前内置单一基组未覆盖 [${recUnsupported.join(', ')}]，需使用混合/外部基组。`,
          ...(basisUpgradedReason ? { basisUpgradedReason } : {})
        },
        ...(solventResolution ? { solventResolution } : {}),
        compatibleMethods,
        compatibleBases
      };
    }
  }

  let orcaRecommendation: Record<string, unknown> | undefined;
  if (engine === 'orca' || engine === 'both') {
    if (!SUPPORTED_ORCA_TASKS.has(task as OrcaTask)) {
      if (engine === 'orca') {
        throw Object.assign(
          new Error(
            `Task "${task}" is not supported by ORCA input builder (supported: ${[...SUPPORTED_ORCA_TASKS].join(', ')})`
          ),
          { code: 'INVALID_CALCULATION_TASK' }
        );
      }
      orcaRecommendation = {
        supported: false,
        reason: `ORCA 输入模块不支持任务 "${task}"（如 constrained/t1opt 请选择 engine="gaussian" 或使用 task="opt"/"tdopt"）。`
      };
    } else {
      const oTask = task as OrcaTask;
      const oDefaults = createOrcaCommonSettings(oTask, structure);
      const taskMethods = getOrcaCommonMethods(oTask).map(m => {
        let supported = true;
        let reason: string | undefined;
        if (superheavyElements.length > 0) {
          if (m.basisPolicy === 'uniform-def2' || m.family === 'xtb') {
            supported = false;
            reason = `元素 ${superheavyElements.join(', ')} 超出 H–Rn (Z<=86) 覆盖范围`;
          } else if (m.family === 'composite') {
            const limit = m.id === 'wb97x-3c' ? 86 : m.id === 'r2scan-3c' ? 103 : 94;
            const over = uniqueElements.filter(el => ELEMENTS.indexOf(el) >= limit);
            if (over.length > 0) {
              supported = false;
              reason = `元素 ${over.join(', ')} 超出 ${m.label} 覆盖上限`;
            }
          }
        }
        if (m.family === 'double-hybrid' && multiplicity !== 1) {
          supported = false;
          reason = '双杂化泛函当前仅开放闭壳层单重态组合';
        }
        return {
          id: m.id,
          label: m.label,
          family: m.family,
          keywords: m.keywords,
          basisPolicy: m.basisPolicy,
          frequency: m.frequency,
          supported,
          ...(reason ? { reason } : {})
        };
      });

      let recMethodId = oDefaults.method;
      let recBasis = oDefaults.basis;
      let methodUpgradedReason: string | undefined;
      const defaultMethodEntry = taskMethods.find(m => m.id === recMethodId);
      if (defaultMethodEntry && !defaultMethodEntry.supported) {
        const preferredFallback =
          taskMethods.find(m => m.supported && m.id === 'r2scan-3c') ??
          taskMethods.find(m => m.supported);
        if (preferredFallback) {
          methodUpgradedReason = `默认方法 ${defaultMethodEntry.label} 不支持当前体系（${defaultMethodEntry.reason ?? '元素超限'}），已自动切换为 ${preferredFallback.label}。`;
          recMethodId = preferredFallback.id;
          recBasis = preferredFallback.basisPolicy === 'uniform-def2'
            ? (oTask === 'sp' || oTask === 'bsse' ? 'def2-TZVP' : 'def2-SVP')
            : '';
        }
      }

      const recProfile = getOrcaMethodProfile(recMethodId, '6.1')!;
      const recMethodSupported = taskMethods.find(m => m.id === recMethodId)?.supported ?? false;

      const compatibleBases = ORCA_BASES.map(b => {
        const requiresCorrAux = recProfile.family === 'double-hybrid' || recProfile.family === 'coupled-cluster';
        const hasCorrAux = Boolean(ORCA_CORRELATION_BASES[b]);
        const lanthanideDiffuseBlocked = lanthanideElements.length > 0 && b.endsWith('D') && requiresCorrAux;
        const supported =
          superheavyElements.length === 0 &&
          (!requiresCorrAux || hasCorrAux) &&
          !lanthanideDiffuseBlocked;
        return {
          basis: b,
          diffuse: b.endsWith('D'),
          correlationAuxBasis: ORCA_CORRELATION_BASES[b] ?? null,
          supported
        };
      });

      let solventResolution: Record<string, unknown> | undefined;
      if (solvent && !isGasPhaseSolvent(solvent)) {
        try {
          const resolved = resolveSolventForEngine('orca', oDefaults.solventModel, solvent, '6.1');
          solventResolution = {
            matched: true,
            solventModel: oDefaults.solventModel,
            ...resolved.entry
          };
        } catch (err) {
          solventResolution = {
            matched: false,
            solventModel: oDefaults.solventModel,
            message: err instanceof Error ? err.message : String(err)
          };
        }
      }

      orcaRecommendation = {
        supported: true,
        task: oTask,
        recommended: {
          version: oDefaults.version,
          method: recMethodId,
          methodLabel: recProfile.label,
          methodSupported: recMethodSupported,
          keywords: recProfile.keywords,
          basis: recBasis,
          basisPolicy: recProfile.basisPolicy,
          frequencyType: recProfile.frequency,
          solventModel: oDefaults.solventModel,
          unrestricted: oDefaults.unrestricted,
          ...(methodUpgradedReason ? { methodUpgradedReason } : {}),
          ...(oTask === 'td' || oTask === 'tdopt'
            ? { recommendedRoots: oDefaults.excited.roots }
            : {})
        },
        ...(solventResolution ? { solventResolution } : {}),
        compatibleMethods: taskMethods,
        compatibleBases
      };
    }
  }

  return {
    documentId,
    label,
    formula: computeHillFormula(structure.atoms),
    atomCount: structure.atoms.length,
    elements: uniqueElements,
    heavyEcpElements,
    lanthanideElements,
    superheavyElements,
    isPeriodic,
    electronicState: {
      charge,
      multiplicity,
      confirmed: electronicStateConfirmed,
      valid: spinParityError === null,
      ...(spinParityError ? { error: spinParityError } : {})
    },
    warnings,
    ...(gaussianRecommendation ? { gaussian: gaussianRecommendation } : {}),
    ...(orcaRecommendation ? { orca: orcaRecommendation } : {})
  };
}

export interface ConfigureCalculationResult {
  engine: 'gaussian' | 'orca';
  step: number;
  gaussianDraft?: SavedGaussianInputDraft;
  orcaDraft?: SavedOrcaInputDraft;
  orcaGeneratedDrafts?: OrcaGeneratedDrafts;
  response: {
    engine: 'gaussian' | 'orca';
    task: string;
    method: string;
    basis: string;
    dispersion?: string;
    solventModel: string;
    solvent: string;
    charge: number;
    multiplicity: number;
    electronicStateConfirmed: boolean;
    cores: number;
    memoryGB: number;
    jobName: string;
    title: string;
    workflowStep: number;
    valid: boolean;
    validationErrors: string[];
    validationWarnings: string[];
    routeOrKeywords: string;
    fileName: string;
    script: string;
    files?: Array<{ name: string; role: string; text: string }>;
    minimumOrcaVersion?: string;
  };
}

const GAUSSIAN_INTEGRAL_KEYS = new Set(['grid', 'acc2e']);
const GAUSSIAN_ADVANCED_KEYS = new Set([
  'scfAlgorithm',
  'noVarAcc',
  'noIncFock',
  'fermi',
  'noDIIS',
  'vshift',
  'scfMaxCycle',
  'maxConventional',
  'optConvergence',
  'maxStep',
  'optMaxCycles'
]);
const GAUSSIAN_SCF_OBJECT_KEYS = new Set(['convergence', 'algorithm', 'maxCycles']);
const ORCA_SCF_OBJECT_KEYS = new Set(['convergence', 'strategy', 'algorithm', 'maxIterations']);
const ORCA_OPTIMIZATION_KEYS = new Set(['convergence', 'hessian', 'recalcInterval', 'maxIterations', 'maxStep']);
const EXCITED_KEYS = new Set([
  'nstates',
  'roots',
  'root',
  'approximation',
  'spin',
  'targetSpin',
  'useUks',
  'frequency',
  'soc',
  'triplets',
  'printCoefficients'
]);
const FREQUENCY_KEYS = new Set(['raman', 'temperatureK', 'pressureAtm']);
const IRC_KEYS = new Set(['maxPoints', 'stepSize', 'lqa', 'confirmed', 'maxIterations']);

function validateNullablePositiveInteger(value: unknown, fieldLabel: string, max = 100000): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw Object.assign(
      new Error(`${fieldLabel} must be an integer in 1..${max} or null`),
      { code: 'INVALID_CALCULATION_SETTINGS' }
    );
  }
  return value;
}

function validateNullablePositiveNumber(value: unknown, fieldLabel: string, max = 1e6): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw Object.assign(
      new Error(`${fieldLabel} must be a positive finite number <= ${max} or null`),
      { code: 'INVALID_CALCULATION_SETTINGS' }
    );
  }
  return value;
}

export function buildConfiguredCalculation(options: {
  documentId: string;
  label: string;
  store: ModelStore;
  existingDrafts?: { gaussian?: unknown; orca?: unknown };
  sources?: InputStructureSource[];
  engine: 'gaussian' | 'orca';
  patch: Record<string, unknown>;
  generateOutput: boolean;
  isAnalysisBound: boolean;
}): ConfigureCalculationResult {
  const {
    documentId,
    label,
    store,
    existingDrafts,
    sources,
    engine,
    patch,
    generateOutput,
    isAnalysisBound
  } = options;

  let modelDoc = store.getSnapshot();
  const initialRawStructure = modelDoc.draft.structure;

  if (!initialRawStructure.atoms.length) {
    throw Object.assign(
      new Error(`Document "${label}" (${documentId}) has no atoms; open or build a molecular structure before configuring calculation`),
      { code: 'MCP_EMPTY_STRUCTURE' }
    );
  }
  if (initialRawStructure.dimension === 2) {
    throw Object.assign(
      new Error(`Document "${label}" (${documentId}) contains a 2D structure; generate 3D coordinates before configuring quantum chemistry input`),
      { code: 'MCP_2D_STRUCTURE_NOT_READY' }
    );
  }
  if (initialRawStructure.cell && initialRawStructure.cell.pbc?.some(Boolean)) {
    throw Object.assign(
      new Error(`Document "${label}" (${documentId}) is a periodic crystal structure; Gaussian and ORCA input builders only support finite non-periodic molecules`),
      { code: 'MCP_STRUCTURE_IS_PERIODIC' }
    );
  }

  // Guard electronic-state modification on analysis-bound documents BEFORE any ModelStore write
  if (isAnalysisBound) {
    const triesToMutateCharge = patch.charge !== undefined && patch.charge !== initialRawStructure.charge;
    const triesToMutateMult = patch.multiplicity !== undefined && patch.multiplicity !== initialRawStructure.multiplicity;
    const triesToMutateConfirm =
      patch.confirmElectronicState !== undefined &&
      patch.confirmElectronicState !== Boolean(modelDoc.electronicStateConfirmed);
    if (triesToMutateCharge || triesToMutateMult || triesToMutateConfirm) {
      throw Object.assign(
        new Error(
          `Document "${label}" is bound to an active calculation/analysis result; extract a frame to a new modeling document before changing electronic state`
        ),
        { code: 'MCP_READ_ONLY_RESULT' }
      );
    }
  }

  const baseState = initialBaseElectronicState(initialRawStructure);
  const currentCharge = initialRawStructure.charge ?? baseState.charge;
  const currentMultiplicity = initialRawStructure.multiplicity ?? baseState.multiplicity;
  const requestedCharge = typeof patch.charge === 'number' ? patch.charge : currentCharge;
  const requestedMultiplicity = typeof patch.multiplicity === 'number'
    ? patch.multiplicity
    : (typeof patch.charge === 'number'
      ? suggestedMultiplicity(initialRawStructure.atoms, requestedCharge)
      : currentMultiplicity);

  const parityErr = electronicStateError(initialRawStructure.atoms, requestedCharge, requestedMultiplicity);
  if (parityErr && (patch.charge !== undefined || patch.multiplicity !== undefined)) {
    throw Object.assign(new Error(parityErr), { code: 'INVALID_ELECTRONIC_STATE' });
  }

  const canAutoConfirmState = parityErr === null;
  const nextStateConfirmed = typeof patch.confirmElectronicState === 'boolean'
    ? patch.confirmElectronicState
    : (canAutoConfirmState ? true : Boolean(modelDoc.electronicStateConfirmed));

  // Up-front string/injection validations common to both engines
  const validatedPatchName = typeof patch.name === 'string'
    ? validateSafeJobStem(patch.name, 'settings.name')
    : undefined;
  const validatedPatchTitle = typeof patch.title === 'string'
    ? validateSafeTitle(patch.title)
    : undefined;
  const validatedCheckpointName = typeof patch.checkpointName === 'string'
    ? validateSafeCheckpointName(patch.checkpointName)
    : undefined;
  const validatedCustomMethod = typeof patch.customMethod === 'string'
    ? validateSafeCustomMethod(patch.customMethod)
    : undefined;

  let restored: ReturnType<typeof readProjectInputDrafts> | undefined;
  try {
    restored = readProjectInputDrafts(existingDrafts, modelDoc);
  } catch {
    restored = undefined;
  }

  const previewStructure = formalInputStructure({
    ...initialRawStructure,
    charge: requestedCharge,
    multiplicity: requestedMultiplicity
  })!;

  function commitElectronicStateIfAllowed(): Structure {
    if (!isAnalysisBound) {
      const snap = store.getSnapshot();
      const raw = snap.draft.structure;
      const rawStateDiffers = raw.charge !== requestedCharge || raw.multiplicity !== requestedMultiplicity;
      const explicitPatch = patch.charge !== undefined || patch.multiplicity !== undefined;
      if (explicitPatch && rawStateDiffers) {
        store.execute({
          type: 'set-electronic-state',
          charge: requestedCharge,
          multiplicity: requestedMultiplicity,
          confirmed: nextStateConfirmed
        });
      } else if (rawStateDiffers || nextStateConfirmed !== Boolean(snap.electronicStateConfirmed)) {
        store.setElectronicState(requestedCharge, requestedMultiplicity, nextStateConfirmed);
      }
    }
    modelDoc = store.getSnapshot();
    const latestRaw = modelDoc.draft.structure;
    return formalInputStructure(
      isAnalysisBound && (latestRaw.charge === null || latestRaw.multiplicity === null)
        ? { ...latestRaw, charge: requestedCharge, multiplicity: requestedMultiplicity }
        : latestRaw
    )!;
  }

  if (engine === 'gaussian') {
    const savedG = restored?.gaussian;
    const engineCoords = resolveAuthoritativeCoordinatesForEngine(store, modelDoc, previewStructure, 'gaussian');
    const hasScanInStore = engineCoords.some(c => c.action === 'scan');

    const requestedTaskRaw = typeof patch.task === 'string'
      ? patch.task
      : (hasScanInStore ? 'scan' : (savedG?.settings.task ?? 'optfreq'));
    if (!SUPPORTED_GAUSSIAN_TASKS.has(requestedTaskRaw as TaskId)) {
      throw Object.assign(
        new Error(
          `Task "${requestedTaskRaw}" is not supported by Gaussian (supported: ${[...SUPPORTED_GAUSSIAN_TASKS].join(', ')})`
        ),
        { code: 'INVALID_CALCULATION_TASK' }
      );
    }
    const targetTask = requestedTaskRaw as TaskId;
    const taskChanged = !savedG || savedG.settings.task !== targetTask;

    let settings: GaussianSettings = taskChanged
      ? defaultSettings(targetTask)
      : structuredClone(savedG.settings);
    let files: FileSettings = taskChanged
      ? {
          ...defaultFiles(),
          hessian: targetTask === 'ts' || targetTask === 'irc' ? 'calcfc' : 'none'
        }
      : structuredClone(savedG.files);

    if (!isEnergyTask(targetTask) && taskChanged) {
      settings.scf = 'default';
    }

    // Project ModelStore context & converted scan coordinates onto Gaussian settings
    const gCtx = store.getContext('gaussian');
    const gDoc: ModelDocument = {
      ...modelDoc,
      draft: {
        ...modelDoc.draft,
        structure: previewStructure,
        ...(gCtx ? { assignments: gCtx.assignments } : {})
      },
      internalCoordinates: engineCoords
    };
    const projected = projectSessionModel(
      gDoc,
      previewStructure,
      captureDesktopAssignments(previewStructure, settings),
      captureGaussianCoordinates(previewStructure, settings),
      true
    );
    settings = integrateDesktopBuilderResult(previewStructure, projected, settings).settings;
    if (engineCoords.some(r => r.action === 'scan') && settings.task !== 'scan' && patch.task === undefined) {
      settings = { ...settings, task: 'scan' };
    }
    settings = projectCanonicalGaussianFreezes(
      previewStructure,
      settings,
      modelDoc.sharedConstraints ?? { frozenAtomIds: [], coordinates: [] }
    );

    if (typeof patch.method === 'string') {
      const methodId = normalizeGaussianMethodId(patch.method);
      Object.assign(settings, methodDefaults(methodId, settings.task));
      if (methodId === 'custom') {
        if (!validatedCustomMethod) {
          throw Object.assign(
            new Error('Gaussian method="custom" requires a valid settings.customMethod keyword'),
            { code: 'INVALID_METHOD' }
          );
        }
        settings.customMethod = validatedCustomMethod;
      } else {
        settings.customMethod = '';
      }
      if (isXtb(methodId)) {
        files = {
          ...files,
          saveCheckpoint: false,
          readCheckpoint: false,
          oldCheckpoint: '',
          geometry: 'explicit',
          guessRead: false,
          hessian: 'none',
          basisFromCheckpoint: false,
          writeCores: false
        };
      } else if (isSemiempirical(methodId)) {
        files = { ...files, guessRead: false };
      }
    } else if (validatedCustomMethod !== undefined) {
      if (settings.method !== 'custom') {
        throw Object.assign(
          new Error('settings.customMethod can only be set when method="custom"'),
          { code: 'INVALID_METHOD' }
        );
      }
      settings.customMethod = validatedCustomMethod;
    }

    if (typeof patch.basis === 'string') {
      if (!isSemiempirical(settings.method) && !isXtb(settings.method)) {
        settings.basis = normalizeGaussianBasisName(patch.basis);
      }
    }

    if (typeof patch.dispersion === 'string') {
      if (!['gd3bj', 'gd3', 'none'].includes(patch.dispersion)) {
        throw Object.assign(
          new Error('Gaussian settings.dispersion must be "gd3bj", "gd3", or "none"'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      settings.dispersion = patch.dispersion as Dispersion;
    }

    if (typeof patch.solventModel === 'string') {
      if (patch.solventModel !== 'iefpcm' && patch.solventModel !== 'smd') {
        throw Object.assign(
          new Error('Gaussian settings.solventModel must be "iefpcm" or "smd"'),
          { code: 'INVALID_SOLVENT_MODEL' }
        );
      }
      const nextModel = patch.solventModel;
      if (nextModel !== settings.solventModel && patch.solvent === undefined) {
        settings.solvation = solventSelectionForModelChange({
          engine: 'gaussian',
          selection: settings.solvation,
          currentModel: settings.solventModel,
          nextModel
        });
      }
      settings.solventModel = nextModel;
      settings.solventModelManuallySelected = true;
    }

    if (typeof patch.solvent === 'string') {
      const resolved = resolveSolventForEngine('gaussian', settings.solventModel, patch.solvent);
      settings.solvent = resolved.solvent;
      settings.solvation = resolved.solvation;
    }

    if (typeof patch.unrestricted === 'boolean') {
      settings.unrestricted = patch.unrestricted;
    }
    if (typeof patch.use5D === 'boolean') {
      settings = setUse5D(settings, patch.use5D);
    }
    if (typeof patch.nosymm === 'boolean') {
      settings.nosymm = patch.nosymm;
    }

    if (patch.scf !== undefined) {
      if (typeof patch.scf === 'string') {
        if (patch.scf !== 'default' && patch.scf !== 'conver6') {
          throw Object.assign(
            new Error('Gaussian settings.scf must be "default" or "conver6"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        settings.scf = patch.scf;
      } else if (isPlainRecord(patch.scf)) {
        assertAllowedObjectKeys(patch.scf, GAUSSIAN_SCF_OBJECT_KEYS, 'scf');
        if (patch.scf.convergence !== undefined) {
          if (patch.scf.convergence !== 'default' && patch.scf.convergence !== 'conver6') {
            throw Object.assign(
              new Error('Gaussian settings.scf.convergence must be "default" or "conver6"'),
              { code: 'INVALID_CALCULATION_SETTINGS' }
            );
          }
          settings.scf = patch.scf.convergence;
        }
        const adv = { ...(settings.advanced ?? defaultAdvanced(settings.task)) };
        if (patch.scf.algorithm !== undefined) {
          if (!['default', 'qc', 'xqc'].includes(String(patch.scf.algorithm))) {
            throw Object.assign(
              new Error('Gaussian settings.scf.algorithm must be "default", "qc", or "xqc"'),
              { code: 'INVALID_CALCULATION_SETTINGS' }
            );
          }
          adv.scfAlgorithm = patch.scf.algorithm as 'default' | 'qc' | 'xqc';
        }
        if (patch.scf.maxCycles !== undefined) {
          adv.scfMaxCycle = validateNullablePositiveInteger(patch.scf.maxCycles, 'settings.scf.maxCycles');
        }
        settings.advanced = adv;
      } else {
        throw Object.assign(
          new Error('Gaussian settings.scf must be "default", "conver6", or an options object'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
    }

    if (typeof patch.grid === 'string') {
      if (patch.grid === 'default' || patch.grid === 'efficient') {
        settings.grid = patch.grid;
      } else if (['fine', 'ultrafine', 'superfinegrid'].includes(patch.grid)) {
        settings.integral = { ...(settings.integral ?? {}), grid: patch.grid as 'fine' | 'ultrafine' | 'superfinegrid' };
      } else {
        throw Object.assign(
          new Error('Gaussian settings.grid must be "default", "efficient", "fine", "ultrafine", or "superfinegrid"'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
    }

    if (patch.integral !== undefined) {
      if (!isPlainRecord(patch.integral)) {
        throw Object.assign(
          new Error('Gaussian settings.integral must be an object'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      assertAllowedObjectKeys(patch.integral, GAUSSIAN_INTEGRAL_KEYS, 'integral');
      const nextIntegral = { ...(settings.integral ?? {}) };
      if (patch.integral.grid !== undefined) {
        if (!['fine', 'ultrafine', 'superfinegrid'].includes(String(patch.integral.grid))) {
          throw Object.assign(
            new Error('Gaussian settings.integral.grid must be "fine", "ultrafine", or "superfinegrid"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextIntegral.grid = patch.integral.grid as 'fine' | 'ultrafine' | 'superfinegrid';
      }
      if (patch.integral.acc2e !== undefined) {
        const acc2e = validateNullablePositiveInteger(patch.integral.acc2e, 'settings.integral.acc2e', 30);
        if (acc2e === null) delete nextIntegral.acc2e;
        else nextIntegral.acc2e = acc2e;
      }
      settings.integral = nextIntegral;
    }

    if (patch.advanced !== undefined) {
      if (!isPlainRecord(patch.advanced)) {
        throw Object.assign(
          new Error('Gaussian settings.advanced must be an object'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      assertAllowedObjectKeys(patch.advanced, GAUSSIAN_ADVANCED_KEYS, 'advanced');
      const nextAdv: AdvancedSettings = { ...(settings.advanced ?? defaultAdvanced(settings.task)) };
      const advIn = patch.advanced;
      if (advIn.scfAlgorithm !== undefined) {
        if (!['default', 'qc', 'xqc'].includes(String(advIn.scfAlgorithm))) {
          throw Object.assign(
            new Error('Gaussian settings.advanced.scfAlgorithm must be "default", "qc", or "xqc"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextAdv.scfAlgorithm = advIn.scfAlgorithm as 'default' | 'qc' | 'xqc';
      }
      if (advIn.optConvergence !== undefined) {
        if (!['default', 'loose', 'tight', 'verytight'].includes(String(advIn.optConvergence))) {
          throw Object.assign(
            new Error('Gaussian settings.advanced.optConvergence must be "default", "loose", "tight", or "verytight"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextAdv.optConvergence = advIn.optConvergence as 'default' | 'loose' | 'tight' | 'verytight';
      }
      for (const boolKey of ['noVarAcc', 'noIncFock', 'fermi', 'noDIIS'] as const) {
        if (advIn[boolKey] !== undefined) {
          if (typeof advIn[boolKey] !== 'boolean') {
            throw Object.assign(
              new Error(`Gaussian settings.advanced.${boolKey} must be a boolean`),
              { code: 'INVALID_CALCULATION_SETTINGS' }
            );
          }
          nextAdv[boolKey] = advIn[boolKey];
        }
      }
      for (const intKey of ['vshift', 'scfMaxCycle', 'maxConventional', 'maxStep', 'optMaxCycles'] as const) {
        if (advIn[intKey] !== undefined) {
          nextAdv[intKey] = validateNullablePositiveInteger(advIn[intKey], `settings.advanced.${intKey}`);
        }
      }
      settings.advanced = nextAdv;
    }

    if (patch.optimization !== undefined) {
      throw Object.assign(
        new Error('settings.optimization is an ORCA option; for Gaussian use settings.advanced (optConvergence, maxStep, optMaxCycles)'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }

    const taskOptions = { ...(settings.taskOptions ?? defaultTaskOptions()) };
    if (patch.excited !== undefined) {
      if (!isPlainRecord(patch.excited)) {
        throw Object.assign(
          new Error('settings.excited must be an object'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      assertAllowedObjectKeys(patch.excited, EXCITED_KEYS, 'excited');
      const ex = patch.excited;
      const nextExcited = { ...taskOptions.excited };
      if (ex.nstates !== undefined) {
        nextExcited.nstates = validateNullablePositiveInteger(ex.nstates, 'settings.excited.nstates', 1000);
        nextExcited.nstatesMode = nextExcited.nstates === null ? 'auto' : 'manual';
      } else if (ex.roots !== undefined) {
        nextExcited.nstates = validateNullablePositiveInteger(ex.roots, 'settings.excited.roots', 1000);
        nextExcited.nstatesMode = nextExcited.nstates === null ? 'auto' : 'manual';
      }
      if (ex.root !== undefined) {
        const root = validateNullablePositiveInteger(ex.root, 'settings.excited.root', 1000);
        if (root === null) {
          throw Object.assign(
            new Error('settings.excited.root must be a positive integer'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextExcited.root = root;
      }
      if (ex.approximation !== undefined) {
        if (!['td', 'tda', 'zindo'].includes(String(ex.approximation))) {
          throw Object.assign(
            new Error('Gaussian settings.excited.approximation must be "td", "tda", or "zindo"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextExcited.approximation = ex.approximation as 'td' | 'tda' | 'zindo';
      }
      if (ex.spin !== undefined) {
        if (!['default', 'singlets', 'triplets', '50-50'].includes(String(ex.spin))) {
          throw Object.assign(
            new Error('Gaussian settings.excited.spin must be "default", "singlets", "triplets", or "50-50"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextExcited.spin = ex.spin as 'default' | 'singlets' | 'triplets' | '50-50';
      }
      if (ex.targetSpin !== undefined) {
        if (ex.targetSpin === 'singlet' || ex.targetSpin === 'singlets') nextExcited.targetSpin = 'singlets';
        else if (ex.targetSpin === 'triplet' || ex.targetSpin === 'triplets') nextExcited.targetSpin = 'triplets';
        else {
          throw Object.assign(
            new Error('Gaussian settings.excited.targetSpin must be "singlet(s)" or "triplet(s)"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
      }
      for (const boolKey of ['useUks', 'frequency', 'printCoefficients'] as const) {
        if (ex[boolKey] !== undefined) {
          if (typeof ex[boolKey] !== 'boolean') {
            throw Object.assign(
              new Error(`settings.excited.${boolKey} must be a boolean`),
              { code: 'INVALID_CALCULATION_SETTINGS' }
            );
          }
          nextExcited[boolKey] = ex[boolKey];
        }
      }
      taskOptions.excited = nextExcited;
    }

    if (patch.frequency !== undefined) {
      if (!isPlainRecord(patch.frequency)) {
        throw Object.assign(
          new Error('settings.frequency must be an object'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      assertAllowedObjectKeys(patch.frequency, FREQUENCY_KEYS, 'frequency');
      const freq = patch.frequency;
      if (freq.raman !== undefined && typeof freq.raman !== 'boolean') {
        throw Object.assign(
          new Error('settings.frequency.raman must be a boolean'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      const temperatureK = freq.temperatureK !== undefined
        ? validateNullablePositiveNumber(freq.temperatureK, 'settings.frequency.temperatureK', 100000)
        : taskOptions.frequency?.temperatureK;
      const pressureAtm = freq.pressureAtm !== undefined
        ? validateNullablePositiveNumber(freq.pressureAtm, 'settings.frequency.pressureAtm', 100000)
        : taskOptions.frequency?.pressureAtm;
      taskOptions.frequency = {
        ...(taskOptions.frequency ?? {}),
        ...(freq.raman !== undefined ? { raman: freq.raman } : {}),
        ...(freq.temperatureK !== undefined ? { temperatureK } : {}),
        ...(freq.pressureAtm !== undefined ? { pressureAtm } : {})
      };
    }

    if (typeof patch.nmr === 'string') {
      if (!['giao', 'spinspin', 'mixed'].includes(patch.nmr)) {
        throw Object.assign(
          new Error('Gaussian settings.nmr must be "giao", "spinspin", or "mixed"'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      taskOptions.nmr = { mode: patch.nmr as 'giao' | 'spinspin' | 'mixed' };
    }

    if (patch.irc !== undefined) {
      if (!isPlainRecord(patch.irc)) {
        throw Object.assign(
          new Error('settings.irc must be an object'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      assertAllowedObjectKeys(patch.irc, IRC_KEYS, 'irc');
      const irc = patch.irc;
      if (irc.lqa !== undefined && typeof irc.lqa !== 'boolean') {
        throw Object.assign(
          new Error('settings.irc.lqa must be a boolean'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      if (irc.confirmed !== undefined && typeof irc.confirmed !== 'boolean') {
        throw Object.assign(
          new Error('settings.irc.confirmed must be a boolean'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      taskOptions.irc = {
        ...taskOptions.irc,
        ...(irc.maxPoints !== undefined
          ? { maxPoints: validateNullablePositiveInteger(irc.maxPoints, 'settings.irc.maxPoints', 10000) }
          : {}),
        ...(irc.stepSize !== undefined
          ? { stepSize: validateNullablePositiveInteger(irc.stepSize, 'settings.irc.stepSize', 10000) }
          : {}),
        ...(irc.lqa !== undefined ? { lqa: irc.lqa } : {}),
        ...(irc.confirmed !== undefined ? { confirmed: irc.confirmed } : {})
      };
    }
    settings.taskOptions = taskOptions;

    const cores = typeof patch.cores === 'number' ? patch.cores : (savedG?.cores ?? 0);
    const memory = typeof patch.memoryGB === 'number' ? Math.trunc(patch.memoryGB) : (savedG?.memory ?? 0);
    if (typeof patch.writeCores === 'boolean') {
      files.writeCores = patch.writeCores;
    } else if (typeof patch.cores === 'number') {
      files.writeCores = patch.cores > 0 && !isXtb(settings.method);
    }
    if (typeof patch.writeMemory === 'boolean') {
      files.writeMemory = patch.writeMemory;
    } else if (typeof patch.memoryGB === 'number') {
      files.writeMemory = memory > 0;
    }
    if (typeof patch.saveCheckpoint === 'boolean') {
      files.saveCheckpoint = patch.saveCheckpoint;
    }
    if (validatedCheckpointName !== undefined) {
      files.checkpointName = validatedCheckpointName;
    }

    const resourcesConfirmed = typeof patch.confirmResources === 'boolean'
      ? patch.confirmResources
      : true;

    const sourceName = savedG?.sourceName ?? previewStructure.name ?? cleanStem(label || 'molecule');
    const nameTouched = validatedPatchName !== undefined || Boolean(savedG?.naming?.nameTouched && !taskChanged);
    const titleTouched = validatedPatchTitle !== undefined || Boolean(savedG?.naming?.titleTouched && !taskChanged);
    const jobName = validatedPatchName
      ?? (nameTouched && savedG?.jobName
        ? savedG.jobName
        : taskStem(sourceName, settings.task, settings.method, settings.xtb?.level, settings));
    const title = validatedPatchTitle
      ?? (titleTouched && savedG?.title
        ? savedG.title
        : defaultTitle(sourceName, settings.task, settings.method, settings));

    // All validations succeeded: commit electronic state & context atomically
    const structure = commitElectronicStateIfAllowed();
    store.synchronizeContext(
      captureDesktopAssignments(structure, settings),
      captureGaussianCoordinates(structure, settings),
      'gaussian'
    );

    const sharedProjected = applySharedGaussianConstraints(
      structure,
      settings,
      store.getSnapshot().sharedConstraints
    );
    const privateReq: JobRequest = {
      structure,
      settings: sharedProjected.settings,
      charge: requestedCharge,
      multiplicity: requestedMultiplicity,
      electronicStateConfirmed: nextStateConfirmed,
      cores,
      memoryGB: memory,
      resourcesConfirmed,
      name: jobName,
      title,
      frequencyConditionsConfirmed: settings.task === 'freq' ? true : (savedG?.frequencyConfirmed ?? false),
      files,
      ...(sources ? { inputSources: sources } : {})
    };
    const effectiveReq = projectGaussianTaskStructure(privateReq);
    const preview = sharedProjected.errors.length
      ? { text: '', errors: [...sharedProjected.errors] }
      : previewGaussian(effectiveReq);
    const validationErrors = [...preview.errors];
    const valid = validationErrors.length === 0;
    const finalText = valid ? buildGaussian(effectiveReq) : preview.text;
    const step = generateOutput && valid ? 3 : 2;
    const sig = jobSignature(effectiveReq);

    const gaussianDraft: SavedGaussianInputDraft = {
      settings,
      files,
      charge: requestedCharge,
      multiplicity: requestedMultiplicity,
      stateConfirmed: nextStateConfirmed,
      frequencyConfirmed: effectiveReq.frequencyConditionsConfirmed ?? false,
      cores,
      memory,
      resourcesConfirmed,
      sourceName,
      jobName,
      title,
      output: generateOutput && valid ? finalText : '',
      generatedName: generateOutput && valid ? jobName : '',
      generatedSignature: generateOutput && valid ? sig : '',
      editorDirty: false,
      step,
      activeEngine: 'gaussian',
      owner: { documentId: store.getSnapshot().id },
      naming: {
        systemNameTouched: Boolean(savedG?.naming?.systemNameTouched),
        nameTouched,
        titleTouched
      },
      touched: ['method', 'basis', 'dispersion', 'grid', 'solvent', 'solventModel'],
      taskDrafts: savedG?.taskDrafts ?? []
    };

    return {
      engine: 'gaussian',
      step,
      gaussianDraft,
      ...(restored?.orca ? { orcaDraft: { ...restored.orca, activeEngine: 'gaussian' } } : {}),
      response: {
        engine: 'gaussian',
        task: settings.task,
        method: settings.method === 'custom' ? settings.customMethod : settings.method,
        basis: isSemiempirical(settings.method) || isXtb(settings.method) ? '' : settings.basis,
        dispersion: settings.dispersion,
        solventModel: settings.solventModel,
        solvent: settings.solvent || 'gas',
        charge: requestedCharge,
        multiplicity: requestedMultiplicity,
        electronicStateConfirmed: nextStateConfirmed,
        cores,
        memoryGB: memory,
        jobName,
        title,
        workflowStep: step,
        valid,
        validationErrors,
        validationWarnings: [],
        routeOrKeywords: previewRoute(effectiveReq),
        fileName: `${jobName}.gjf`,
        script: finalText,
        files: [{ name: `${jobName}.gjf`, role: 'input', text: finalText }]
      }
    };
  }

  // ORCA engine configuration
  if (patch.advanced !== undefined) {
    throw Object.assign(
      new Error('settings.advanced is a Gaussian option; for ORCA use settings.scf and settings.optimization'),
      { code: 'INVALID_CALCULATION_SETTINGS' }
    );
  }
  if (patch.integral !== undefined) {
    throw Object.assign(
      new Error('settings.integral is a Gaussian option; for ORCA use settings.grid ("auto", "DefGrid1", "DefGrid2", "DefGrid3")'),
      { code: 'INVALID_CALCULATION_SETTINGS' }
    );
  }

  const savedO = restored?.orca;
  const engineCoords = resolveAuthoritativeCoordinatesForEngine(store, modelDoc, previewStructure, 'orca');
  const hasOrcaScanInStore = engineCoords.some(c => c.action === 'scan');

  const requestedTaskRaw = typeof patch.task === 'string'
    ? patch.task
    : (hasOrcaScanInStore ? 'scan' : (savedO?.settings.task ?? 'optfreq'));
  if (!SUPPORTED_ORCA_TASKS.has(requestedTaskRaw as OrcaTask)) {
    throw Object.assign(
      new Error(
        `Task "${requestedTaskRaw}" is not supported by ORCA (supported: ${[...SUPPORTED_ORCA_TASKS].join(', ')})`
      ),
      { code: 'INVALID_CALCULATION_TASK' }
    );
  }
  const targetTask = requestedTaskRaw as OrcaTask;
  const taskChanged = !savedO || savedO.settings.task !== targetTask;

  const baseOrcaReq: OrcaJobRequest = savedO && !taskChanged
    ? restoredOrcaProjectRequest(savedO, previewStructure)
    : {
        structure: previewStructure,
        settings: createOrcaCommonSettings(targetTask, previewStructure),
        charge: requestedCharge,
        multiplicity: requestedMultiplicity,
        electronicStateConfirmed: nextStateConfirmed,
        systemName: orcaImportSystemStem(previewStructure.name ?? label ?? 'molecule'),
        name: '',
        title: '',
        cores: savedO?.cores ?? 4,
        memoryGB: savedO?.memoryGB ?? 4,
        resourcesConfirmed: true,
        assets: savedO && !taskChanged ? [...savedO.assets] : []
      };

  let oSettings: OrcaSettings = structuredClone(baseOrcaReq.settings);

  const oCtx = store.getContext('orca');
  const oDoc: ModelDocument = {
    ...modelDoc,
    draft: {
      ...modelDoc.draft,
      structure: previewStructure,
      ...(oCtx ? { assignments: oCtx.assignments } : {})
    },
    internalCoordinates: engineCoords
  };
  const projected = projectSessionModel(
    oDoc,
    previewStructure,
    captureOrcaAssignments(previewStructure, oSettings),
    captureOrcaCoordinates(previewStructure, oSettings),
    true
  );
  oSettings = integrateOrcaBuilderResult(previewStructure, projected, oSettings).settings;
  if (
    engineCoords.some(r => r.action === 'scan' && r.source === 'orca') &&
    oSettings.task !== 'scan' &&
    oSettings.task !== 'md' &&
    patch.task === undefined
  ) {
    oSettings = { ...oSettings, task: 'scan' };
  }
  oSettings = projectCanonicalOrcaFreezes(
    previewStructure,
    oSettings,
    modelDoc.sharedConstraints ?? { frozenAtomIds: [], coordinates: [] }
  );

  if (typeof patch.version === 'string') {
    if (!ORCA_VERSIONS.includes(patch.version as OrcaVersion)) {
      throw Object.assign(
        new Error(`ORCA settings.version must be one of: ${ORCA_VERSIONS.join(', ')}`),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
    oSettings.version = patch.version as OrcaVersion;
  }

  if (typeof patch.method === 'string') {
    const methodId = normalizeOrcaMethodId(patch.method);
    const profile = getOrcaMethodProfile(methodId, oSettings.version);
    if (!profile) {
      throw Object.assign(
        new Error(`Method "${methodId}" is not available in ORCA ${oSettings.version}`),
        { code: 'INVALID_METHOD' }
      );
    }
    oSettings.method = methodId;
    if (profile.basisPolicy !== 'uniform-def2') {
      oSettings.basis = '';
    } else if (!oSettings.basis) {
      oSettings.basis = oSettings.task === 'sp' || oSettings.task === 'bsse' ? 'def2-TZVP' : 'def2-SVP';
    }
  }

  const currentProfile = getOrcaMethodProfile(oSettings.method, oSettings.version);
  if (typeof patch.basis === 'string') {
    const normalizedBasis = normalizeOrcaBasisName(patch.basis);
    if (currentProfile && currentProfile.basisPolicy !== 'uniform-def2' && normalizedBasis) {
      throw Object.assign(
        new Error(
          `ORCA method "${currentProfile.label}" uses ${currentProfile.basisPolicy === 'builtin' ? 'its built-in basis set' : 'no orbital basis set'}; omit basis or pass ""`
        ),
        { code: 'INVALID_BASIS' }
      );
    }
    oSettings.basis = normalizedBasis;
  }

  if (typeof patch.solventModel === 'string') {
    if (patch.solventModel !== 'cpcm' && patch.solventModel !== 'smd') {
      throw Object.assign(
        new Error('ORCA settings.solventModel must be "cpcm" or "smd"'),
        { code: 'INVALID_SOLVENT_MODEL' }
      );
    }
    const nextModel = patch.solventModel;
    if (nextModel !== oSettings.solventModel && patch.solvent === undefined) {
      oSettings.solvation = solventSelectionForModelChange({
        engine: 'orca',
        selection: oSettings.solvation,
        currentModel: oSettings.solventModel,
        nextModel,
        version: oSettings.version
      });
    }
    oSettings.solventModel = nextModel;
    oSettings.solventModelManuallySelected = true;
  }

  if (typeof patch.solvent === 'string') {
    const resolved = resolveSolventForEngine('orca', oSettings.solventModel, patch.solvent, oSettings.version);
    oSettings.solvent = resolved.solvent;
    oSettings.solvation = resolved.solvation;
  }

  if (typeof patch.unrestricted === 'boolean') {
    oSettings.unrestricted = patch.unrestricted;
  } else if (patch.multiplicity !== undefined) {
    oSettings.unrestricted = requestedMultiplicity > 1;
  }

  if (patch.pno !== undefined) {
    if (typeof patch.pno !== 'string' || !['normal', 'tight', 'loose'].includes(patch.pno)) {
      throw Object.assign(
        new Error('ORCA settings.pno must be "normal", "tight", or "loose"'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
    oSettings.pno = patch.pno as 'normal' | 'tight' | 'loose';
  }
  if (typeof patch.grid === 'string') {
    if (!['auto', 'DefGrid1', 'DefGrid2', 'DefGrid3'].includes(patch.grid)) {
      throw Object.assign(
        new Error('ORCA settings.grid must be "auto", "DefGrid1", "DefGrid2", or "DefGrid3"'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
    oSettings.grid = patch.grid as OrcaSettings['grid'];
  }

  if (patch.scf !== undefined) {
    if (typeof patch.scf === 'string') {
      const normalizedConv = patch.scf.trim().toLowerCase().replace(/scf$/i, '');
      if (!['default', 'loose', 'normal', 'strong', 'tight', 'verytight'].includes(normalizedConv)) {
        throw Object.assign(
          new Error('ORCA settings.scf string must be one of: default, loose, normal, strong, tight, verytight'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      oSettings.scf = {
        ...(oSettings.scf ?? {}),
        convergence: normalizedConv as NonNullable<OrcaSettings['scf']>['convergence']
      };
    } else if (isPlainRecord(patch.scf)) {
      assertAllowedObjectKeys(patch.scf, ORCA_SCF_OBJECT_KEYS, 'scf');
      const nextScf: NonNullable<OrcaSettings['scf']> = { ...(oSettings.scf ?? {}) };
      if (patch.scf.convergence !== undefined) {
        if (!['default', 'loose', 'normal', 'strong', 'tight', 'verytight'].includes(String(patch.scf.convergence))) {
          throw Object.assign(
            new Error('ORCA settings.scf.convergence must be one of: default, loose, normal, strong, tight, verytight'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextScf.convergence = patch.scf.convergence as NonNullable<OrcaSettings['scf']>['convergence'];
      }
      if (patch.scf.strategy !== undefined) {
        if (!['default', 'SlowConv', 'VerySlowConv'].includes(String(patch.scf.strategy))) {
          throw Object.assign(
            new Error('ORCA settings.scf.strategy must be "default", "SlowConv", or "VerySlowConv"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextScf.strategy = patch.scf.strategy as NonNullable<OrcaSettings['scf']>['strategy'];
      }
      if (patch.scf.algorithm !== undefined) {
        if (!['auto', 'KDIIS', 'SOSCF', 'TRAH'].includes(String(patch.scf.algorithm))) {
          throw Object.assign(
            new Error('ORCA settings.scf.algorithm must be "auto", "KDIIS", "SOSCF", or "TRAH"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextScf.algorithm = patch.scf.algorithm as NonNullable<OrcaSettings['scf']>['algorithm'];
      }
      if (patch.scf.maxIterations !== undefined) {
        const maxIter = validateNullablePositiveInteger(patch.scf.maxIterations, 'settings.scf.maxIterations');
        if (maxIter === null) delete nextScf.maxIterations;
        else nextScf.maxIterations = maxIter;
      }
      oSettings.scf = nextScf;
    } else {
      throw Object.assign(
        new Error('ORCA settings.scf must be a convergence string or options object'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
  }

  if (patch.optimization !== undefined) {
    if (!isPlainRecord(patch.optimization)) {
      throw Object.assign(
        new Error('ORCA settings.optimization must be an object'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
    assertAllowedObjectKeys(patch.optimization, ORCA_OPTIMIZATION_KEYS, 'optimization');
    const optIn = patch.optimization;
    const nextOpt: NonNullable<OrcaSettings['optimization']> = { ...(oSettings.optimization ?? {}) };
    if (optIn.convergence !== undefined) {
      if (!['default', 'loose', 'normal', 'tight', 'verytight'].includes(String(optIn.convergence))) {
        throw Object.assign(
          new Error('ORCA settings.optimization.convergence must be "default", "loose", "normal", "tight", or "verytight"'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      nextOpt.convergence = optIn.convergence as NonNullable<OrcaSettings['optimization']>['convergence'];
    }
    if (optIn.hessian !== undefined) {
      if (!['default', 'calc', 'recalc'].includes(String(optIn.hessian))) {
        throw Object.assign(
          new Error('ORCA settings.optimization.hessian must be "default", "calc", or "recalc"'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      nextOpt.hessian = optIn.hessian as NonNullable<OrcaSettings['optimization']>['hessian'];
    }
    if (optIn.recalcInterval !== undefined) {
      const recalc = validateNullablePositiveInteger(optIn.recalcInterval, 'settings.optimization.recalcInterval');
      if (recalc === null) delete nextOpt.recalcInterval;
      else nextOpt.recalcInterval = recalc;
    }
    if (optIn.maxIterations !== undefined) {
      const maxIter = validateNullablePositiveInteger(optIn.maxIterations, 'settings.optimization.maxIterations');
      if (maxIter === null) delete nextOpt.maxIterations;
      else nextOpt.maxIterations = maxIter;
    }
    if (optIn.maxStep !== undefined) {
      const maxStep = validateNullablePositiveNumber(optIn.maxStep, 'settings.optimization.maxStep', 100);
      if (maxStep === null) delete nextOpt.maxStep;
      else nextOpt.maxStep = maxStep;
    }
    oSettings.optimization = nextOpt;
  }

  if (patch.excited !== undefined) {
    if (!isPlainRecord(patch.excited)) {
      throw Object.assign(
        new Error('settings.excited must be an object'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
    assertAllowedObjectKeys(patch.excited, EXCITED_KEYS, 'excited');
    const ex = patch.excited;
    const nextEx = { ...oSettings.excited };
    const rootsInput = ex.roots ?? ex.nstates;
    if (rootsInput !== undefined) {
      const roots = validateNullablePositiveInteger(rootsInput, 'settings.excited.roots', 1000);
      if (roots === null) {
        throw Object.assign(
          new Error('ORCA settings.excited.roots must be a positive integer'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      nextEx.roots = roots;
      nextEx.rootsMode = 'manual';
    }
    if (ex.root !== undefined) {
      const root = validateNullablePositiveInteger(ex.root, 'settings.excited.root', 1000);
      if (root === null) {
        throw Object.assign(
          new Error('ORCA settings.excited.root must be a positive integer'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      nextEx.root = root;
    }
    if (ex.approximation !== undefined) {
      if (!['td', 'tda', 'stddft', 'stda'].includes(String(ex.approximation))) {
        throw Object.assign(
          new Error('ORCA settings.excited.approximation must be "td", "tda", "stddft", or "stda"'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      nextEx.approximation = ex.approximation as 'td' | 'tda' | 'stddft' | 'stda';
    }
    if (ex.targetSpin !== undefined) {
      if (ex.targetSpin === 'singlet' || ex.targetSpin === 'singlets') nextEx.targetSpin = 'singlet';
      else if (ex.targetSpin === 'triplet' || ex.targetSpin === 'triplets') nextEx.targetSpin = 'triplet';
      else {
        throw Object.assign(
          new Error('ORCA settings.excited.targetSpin must be "singlet(s)" or "triplet(s)"'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
    }
    for (const boolKey of ['useUks', 'frequency', 'soc', 'triplets', 'printCoefficients'] as const) {
      if (ex[boolKey] !== undefined) {
        if (typeof ex[boolKey] !== 'boolean') {
          throw Object.assign(
            new Error(`settings.excited.${boolKey} must be a boolean`),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        nextEx[boolKey] = ex[boolKey];
      }
    }
    oSettings.excited = nextEx;
  }

  if (patch.frequency !== undefined) {
    if (!isPlainRecord(patch.frequency)) {
      throw Object.assign(
        new Error('settings.frequency must be an object'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
    assertAllowedObjectKeys(patch.frequency, FREQUENCY_KEYS, 'frequency');
    const freq = patch.frequency;
    if (freq.raman !== undefined && typeof freq.raman !== 'boolean') {
      throw Object.assign(
        new Error('settings.frequency.raman must be a boolean'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
    const nextFreq: NonNullable<OrcaSettings['frequency']> = { ...(oSettings.frequency ?? {}) };
    if (freq.raman !== undefined) nextFreq.raman = freq.raman;
    if (freq.temperatureK !== undefined) {
      const t = validateNullablePositiveNumber(freq.temperatureK, 'settings.frequency.temperatureK', 100000);
      if (t === null) delete nextFreq.temperatureK;
      else nextFreq.temperatureK = t;
    }
    if (freq.pressureAtm !== undefined) {
      const p = validateNullablePositiveNumber(freq.pressureAtm, 'settings.frequency.pressureAtm', 100000);
      if (p === null) delete nextFreq.pressureAtm;
      else nextFreq.pressureAtm = p;
    }
    oSettings.frequency = nextFreq;
  }

  if (typeof patch.nmr === 'string') {
    if (patch.nmr !== 'shielding' && patch.nmr !== 'coupling') {
      throw Object.assign(
        new Error('ORCA settings.nmr must be "shielding" or "coupling"'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
    oSettings.nmr = patch.nmr;
  }

  if (patch.irc !== undefined) {
    if (!isPlainRecord(patch.irc)) {
      throw Object.assign(
        new Error('settings.irc must be an object'),
        { code: 'INVALID_CALCULATION_SETTINGS' }
      );
    }
    assertAllowedObjectKeys(patch.irc, IRC_KEYS, 'irc');
    const irc = patch.irc;
    if (irc.maxIterations !== undefined) {
      const maxIter = validateNullablePositiveInteger(irc.maxIterations, 'settings.irc.maxIterations', 10000);
      if (maxIter === null) delete oSettings.ircMaxIterations;
      else oSettings.ircMaxIterations = maxIter;
    }
    if (irc.confirmed !== undefined) {
      if (typeof irc.confirmed !== 'boolean') {
        throw Object.assign(
          new Error('settings.irc.confirmed must be a boolean'),
          { code: 'INVALID_CALCULATION_SETTINGS' }
        );
      }
      oSettings.ircStartEvidence = {
        confirmed: irc.confirmed,
        context: 'Configured via MCP'
      };
    }
  }

  const oCores = typeof patch.cores === 'number' && patch.cores >= 1
    ? patch.cores
    : Math.max(1, baseOrcaReq.cores || 1);
  const oMemoryGB = typeof patch.memoryGB === 'number' && patch.memoryGB > 0
    ? patch.memoryGB
    : Math.max(1, baseOrcaReq.memoryGB || 1);
  const oResourcesConfirmed = typeof patch.confirmResources === 'boolean'
    ? patch.confirmResources
    : true;

  const systemStem = baseOrcaReq.systemName || orcaImportSystemStem(previewStructure.name ?? label ?? 'molecule');
  const outputNameTouched = validatedPatchName !== undefined || Boolean(savedO?.naming?.outputNameTouched && !taskChanged);
  const titleTouched = validatedPatchTitle !== undefined || Boolean(savedO?.naming?.titleTouched && !taskChanged);
  const rawName = validatedPatchName
    ?? (outputNameTouched && savedO?.name
      ? savedO.name
      : orcaTaskStem(systemStem, oSettings));
  const oTitle = validatedPatchTitle
    ?? (titleTouched && savedO?.title
      ? savedO.title
      : `${systemStem} - ORCA ${oSettings.task.toUpperCase()}`);

  // All validations succeeded: commit electronic state & ORCA context atomically
  const structure = commitElectronicStateIfAllowed();
  store.synchronizeContext(
    captureOrcaAssignments(structure, oSettings),
    captureOrcaCoordinates(structure, oSettings),
    'orca'
  );

  const orcaReq: OrcaJobRequest = {
    structure,
    ...(sources ? { inputSources: sources } : {}),
    settings: oSettings,
    charge: requestedCharge,
    multiplicity: requestedMultiplicity,
    electronicStateConfirmed: nextStateConfirmed,
    systemName: systemStem,
    name: rawName,
    title: oTitle,
    cores: oCores,
    memoryGB: oMemoryGB,
    resourcesConfirmed: oResourcesConfirmed,
    assets: baseOrcaReq.assets
  };

  const projectedTaskReq = projectOrcaTaskStructure(orcaReq);
  const sharedOrca = applySharedOrcaConstraints(
    projectedTaskReq.structure,
    projectedTaskReq.settings,
    store.getSnapshot().sharedConstraints
  );
  const effectiveOrcaReq: OrcaJobRequest = {
    ...projectedTaskReq,
    settings: sharedOrca.settings
  };

  const compatibility = getOrcaCommonCompatibility(effectiveOrcaReq);
  const built = buildOrcaCommon(effectiveOrcaReq);
  const errorIssues = [
    ...sharedOrca.errors.map(msg => ({ field: 'constraints', severity: 'error' as const, message: msg })),
    ...built.issues.filter(i => i.severity === 'error')
  ];
  const warningIssues = built.issues.filter(i => i.severity === 'warning');
  const valid = errorIssues.length === 0 && built.files.length > 0;
  const step = generateOutput && valid ? 3 : 2;

  const orcaGeneratedDrafts: OrcaGeneratedDrafts = { ...(savedO?.generatedDrafts ?? {}) };
  if (generateOutput && valid) {
    orcaGeneratedDrafts[oSettings.task] = {
      sourceSignature: orcaGeneratedSource(effectiveOrcaReq),
      files: structuredClone(built.files),
      minimumVersion: compatibility.minimumVersion,
      issues: structuredClone(built.issues),
      editedNames: [],
      assets: structuredClone(referencedOrcaAssets(effectiveOrcaReq))
    };
  } else {
    delete orcaGeneratedDrafts[oSettings.task];
  }

  const { structure: _dropStruct, inputSources: _dropSources, ...savedRest } = orcaReq;
  const orcaDraft: SavedOrcaInputDraft = {
    ...savedRest,
    step,
    editorDirty: false,
    activeEngine: 'orca',
    owner: { documentId: store.getSnapshot().id },
    naming: {
      systemNameTouched: Boolean(savedO?.naming?.systemNameTouched),
      outputNameTouched,
      titleTouched
    },
    taskDrafts: savedO?.taskDrafts ?? [],
    taskNaming: savedO?.taskNaming ?? [],
    generatedDrafts: orcaGeneratedDrafts
  };

  const bangLine = built.preview
    .split('\n')
    .find(line => line.startsWith('! '))
    ?? `! ${(currentProfile?.keywords ?? [oSettings.method]).join(' ')}${oSettings.basis ? ` ${oSettings.basis}` : ''}`;

  return {
    engine: 'orca',
    step,
    ...(restored?.gaussian ? { gaussianDraft: { ...restored.gaussian, activeEngine: 'orca' } } : {}),
    orcaDraft,
    orcaGeneratedDrafts,
    response: {
      engine: 'orca',
      task: oSettings.task,
      method: oSettings.method,
      basis: oSettings.basis,
      solventModel: oSettings.solventModel,
      solvent: oSettings.solvent || 'gas',
      charge: requestedCharge,
      multiplicity: requestedMultiplicity,
      electronicStateConfirmed: nextStateConfirmed,
      cores: oCores,
      memoryGB: oMemoryGB,
      jobName: rawName,
      title: oTitle,
      workflowStep: step,
      valid,
      validationErrors: errorIssues.map(i => i.message),
      validationWarnings: warningIssues.map(i => i.message),
      routeOrKeywords: bangLine,
      fileName: `${rawName}.inp`,
      script: built.preview,
      files: built.files.map(f => ({ name: f.name, role: f.role, text: f.text })),
      minimumOrcaVersion: compatibility.minimumVersion
    }
  };
}
