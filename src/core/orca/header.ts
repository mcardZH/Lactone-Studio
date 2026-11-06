import { buildOrcaSolvation } from '../solvents';
import { getOrcaMethodProfile, ORCA_CORRELATION_BASES } from './catalog';
import type { OrcaIssue, OrcaJobRequest, OrcaMethodProfile, OrcaSettings } from './types';

/** Resolve the same method capability for retained form drafts and both writers. */
export function orcaScfGridCapabilities(settings: OrcaSettings) {
  const method = getOrcaMethodProfile(settings.method, settings.version);
  const applicable = !!method && method.family !== 'xtb';
  return { scf: applicable, grid: applicable };
}

/** Explicit form values replace task/method defaults after all keywords merge. */
export function normalizeOrcaScientificKeywords(keywords: readonly string[], settings: OrcaSettings): string[] {
  let result = [...keywords];
  const capabilities = orcaScfGridCapabilities(settings);
  if (!capabilities.scf) result = result.filter(keyword => !/^(?:(?:Loose|Normal|Strong|Tight|VeryTight)SCF|SlowConv|VerySlowConv|KDIIS|SOSCF|TRAH)$/i.test(keyword));
  if (!capabilities.grid) result = result.filter(keyword => !/^DefGrid[123]$/i.test(keyword));
  const convergence = settings.scf?.convergence;
  if (capabilities.scf && convergence && convergence !== 'default') {
    result = result.filter(keyword => !/^(?:Loose|Normal|Strong|Tight|VeryTight)SCF$/i.test(keyword));
    result.push(({ loose: 'LooseSCF', normal: 'NormalSCF', strong: 'StrongSCF', tight: 'TightSCF', verytight: 'VeryTightSCF' } as const)[convergence]);
  }
  if (capabilities.grid && settings.grid && settings.grid !== 'auto') {
    result = result.filter(keyword => !/^DefGrid[123]$/i.test(keyword));
    result.push(settings.grid);
  }
  return [...new Set(result)];
}

export function mergeOrcaScfBlocks(blocks: readonly string[]): string[] {
  const scf = blocks.filter(block => /^%scf\s/i.test(block));
  if (scf.length < 2) return [...blocks];
  const body = scf.flatMap(block => block.split('\n').slice(1, -1));
  const first = blocks.findIndex(block => /^%scf\s/i.test(block));
  return blocks.flatMap((block, index) => index === first ? [['%scf', ...body, 'end'].join('\n')] : /^%scf\s/i.test(block) ? [] : [block]);
}

/** Common scientific header for both validated files and incomplete previews.
 * A preview may substitute missing fields; it never changes method defaults or
 * makes the returned issues suitable for export. */
export function renderOrcaHeader(request: OrcaJobRequest, method: OrcaMethodProfile | undefined, missing?: (label: string) => string) {
  const s = request.settings;
  const capabilities = orcaScfGridCapabilities(s);
  const absent = (label: string) => missing?.(label) ?? '';
  // Native B88 lacks the third functional derivative needed by TD/TDA
  // gradients. LibXC(B3LYP) preserves ORCA's VWN5 variant (ID475).
  const tdB3lypDerivatives = method?.id === 'b3lyp' && s.task === 'tdopt' && !s.excited.useUks && ['td', 'tda'].includes(s.excited.approximation);
  const keywords = method ? method.keywords.map(keyword => tdB3lypDerivatives && keyword === 'B3LYP' ? 'LibXC(B3LYP)' : keyword) : [absent('选方法')];
  const blocks: string[] = [];
  const issues: OrcaIssue[] = [];
  if (!method || method.basisPolicy === 'uniform-def2') keywords.push(s.basis.trim() || absent('选基组'));
  if (method?.basisPolicy === 'uniform-def2') {
    keywords.push(method.family === 'pure' ? s.task === 'stable' ? 'RIJONX' : 'RI' : 'RIJCOSX', 'def2/J');
    if (method.family === 'double-hybrid' || method.family === 'coupled-cluster') keywords.push(ORCA_CORRELATION_BASES[s.basis] ?? absent('选关联辅助基组'));
  }
  if (method?.family === 'coupled-cluster') keywords.push(`${s.pno[0].toUpperCase()}${s.pno.slice(1)}PNO`, 'TightSCF');
  if (method?.id === 'wb97x-2-d3bj') blocks.push('%method\n  D3S6 0.547\n  D3S8 0.000\n  D3A1 3.520\n  D3A2 7.795\nend');
  if (method?.family === 'double-hybrid') keywords.push('TightSCF', 'DefGrid3');
  else if (method && ['sp','bsse'].includes(s.task) && !['xtb', 'composite', 'coupled-cluster'].includes(method.family)) keywords.push('StrongSCF', 'DefGrid3');
  const solvent = buildOrcaSolvation({ ...s, requireRefractiveIndex: ['td', 'tdopt', 'esd'].includes(s.task) });
  if (s.task === 'stable' && (solvent.keywords.length || solvent.blocks.length)) issues.push({ field: 'solvent', severity: 'error', message: s.version === '5' ? 'ORCA 5 稳定性分析不支持溶剂模型。' : '本模块尚未逐一核实 ORCA 6 的溶剂稳定性分析组合，当前只开放气相。' });
  if (method?.family === 'xtb' && (solvent.keywords.length || solvent.blocks.length || solvent.issues.length)) issues.push({ field: 'solvent', severity: 'error', message: 'XTB2 溶剂须使用已核对的专用 ALPB 接口，不能套 DFT 的 CPCM/SMD 参数。' });
  else {
    keywords.push(...solvent.keywords);
    blocks.push(...solvent.blocks);
    issues.push(...solvent.issues.map(issue => ({ ...issue, severity: 'error' as const })));
  }
  keywords.push('NoAutoStart', 'MiniPrint');
  if (capabilities.scf && s.scf?.strategy && s.scf.strategy !== 'default') keywords.push(s.scf.strategy);
  if (capabilities.scf && s.scf?.algorithm && s.scf.algorithm !== 'auto') keywords.push(s.scf.algorithm);
  if (capabilities.scf && s.scf?.maxIterations !== undefined) blocks.push(`%scf\n  MaxIter ${s.scf.maxIterations}\nend`);
  if (s.initialOrbitalsId) {
    const asset = request.assets.find(asset => asset.id === s.initialOrbitalsId && asset.kind === 'gbw');
    if (asset || missing) { keywords.push('MORead'); blocks.push(`%moinp "${asset?.name.trim() || absent('选GBW')}"`); }
  }
  return { keywords, blocks, issues, solvent };
}

/** Kept separate because task variants can carry their own electronic state. */
export function orcaReferenceKeywords(request: OrcaJobRequest, method: OrcaMethodProfile | undefined, multiplicity: number): string[] {
  const s = request.settings;
  const unrestricted = s.unrestricted || multiplicity > 1 || (s.task === 'tdopt' && s.excited.useUks);
  return method?.family === 'coupled-cluster' || method?.id === 'hf-3c' ? [unrestricted ? 'UHF' : 'RHF'] : method?.family !== 'xtb' && unrestricted ? ['UKS'] : [];
}
