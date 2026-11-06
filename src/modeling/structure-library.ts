import { ELEMENTS } from '../core/elements';
import { cellInverse, cellParameters, perceivePeriodicConnections, validatePeriodicEndpointImages } from '../core/periodic';
import type { Structure } from '../core/types';

export const STRUCTURE_LIBRARY_CATEGORIES = [
  { id: 'metals', label: '金属' }, { id: 'nonmetals', label: '非金属' },
  { id: 'metal-oxides', label: '金属氧化物' }, { id: 'nonmetal-oxides', label: '非金属氧化物' },
  { id: 'semiconductors', label: '半导体' }, { id: 'layered-crystals', label: '层状晶体' },
  { id: 'two-dimensional', label: '历史单层' },
  { id: 'mof', label: 'MOF' }, { id: 'cof', label: 'COF' },
  { id: 'catalysts', label: '催化剂' }, { id: 'ceramics', label: '陶瓷' },
  { id: 'glasses', label: '非晶模型' }, { id: 'minerals', label: '矿物' },
  { id: 'molecular-crystals', label: '分子晶体' }, { id: 'nanotubes', label: '纳米管' },
  { id: 'organics', label: '有机分子' }, { id: 'polymers', label: '聚合物' },
  { id: 'repeat-units', label: '重复单元' }, { id: 'zeolites', label: '沸石' },
] as const;
export type StructureLibraryCategory = typeof STRUCTURE_LIBRARY_CATEGORIES[number]['id'];
export interface StructureLibraryReference { name: string; url: string; citation?: string; doi?: string }
export interface StructureLibrarySource extends StructureLibraryReference {
  recordId: string; license: string; licenseUrl: string;
  structureKind: 'experimental' | 'computed' | 'curated' | 'derived';
  version?: string; conditions?: string; retrievedAt?: string;
}
export interface StructureLibraryEntry {
  id: string; category: StructureLibraryCategory; name: string; nameEn: string; formula: string; aliases: string[]; phase: string;
  /** Secondary indexes refer to this one canonical snapshot and never add to the unique count. */
  categories?: StructureLibraryCategory[];
  objectKind?: 'crystal' | 'molecule' | 'amorphous-model';
  family?: 'carbon-nitrides';
  legacyIds?: string[];
  structurePath: string; sourcePath: string; source: StructureLibrarySource;
  normalization: { method: string; details?: string[] };
  spaceGroup?: { symbol: string; number?: number }; pointGroup?: string;
  bandGap?: { value: number; unit: 'eV'; method: string; source: StructureLibraryReference };
}
export interface StructureLibraryManifest { schemaVersion: 1; entries: StructureLibraryEntry[] }
export interface StructureLibrarySnapshot { schemaVersion: 1; entryId: string; structure: Structure }
export interface StructureLibraryCatalog { entries: StructureLibraryEntry[]; issues: { category: StructureLibraryCategory; message: string }[] }
type JsonObject = Record<string, unknown>;
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}无效。`);
  return value as JsonObject;
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}缺失。`);
}
function texts(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${label}无效。`);
}
function webUrl(value: unknown, label: string): void {
  text(value, label);
  try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
  catch { throw new Error(`${label}必须是公开HTTP(S)来源。`); }
}
function reference(value: unknown): JsonObject {
  const source = object(value, '来源'); text(source.name, '来源名称'); webUrl(source.url, '来源链接');
  for (const key of ['citation', 'doi']) if (source[key] !== undefined) text(source[key], `来源${key}`);
  return source;
}
/** All paths stay below their category; URLs and encoded traversal never reach fetch. */
export function structureLibraryAssetPath(category: StructureLibraryCategory, path: unknown, extension: 'json' | 'cif' | 'sdf' | 'xyz' | 'mol' | 'pdb'): string {
  if (!STRUCTURE_LIBRARY_CATEGORIES.some(item => item.id === category) || typeof path !== 'string' || !new RegExp(`^${category}/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\\.${extension}$`).test(path)
    || path.split('/').some(part => part === '.' || part === '..')) throw new Error('结构库文件路径越界或格式无效。');
  return path;
}
export function validateStructureLibraryManifest(raw: unknown, category: StructureLibraryCategory): StructureLibraryManifest {
  const manifest = object(raw, '分类索引');
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) throw new Error('不支持的结构库索引版本。');
  const ids = new Set<string>();
  for (const rawEntry of manifest.entries) {
    const entry = object(rawEntry, '结构条目');
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.id) || ids.has(entry.id)) throw new Error('结构条目标识无效或重复。');
    ids.add(entry.id);
    if (entry.category !== category) throw new Error('结构条目与分类索引不一致。');
    for (const key of ['name', 'nameEn', 'formula', 'phase']) text(entry[key], `条目${key}`);
    texts(entry.aliases, '结构别名');
    structureLibraryAssetPath(category, entry.structurePath, 'json');
    const sourceExtension = typeof entry.sourcePath === 'string' ? entry.sourcePath.split('.').pop() : '';
    if (!['cif', 'sdf', 'xyz', 'mol', 'pdb'].includes(sourceExtension ?? '')) throw new Error('来源结构文件格式无效。');
    structureLibraryAssetPath(category, entry.sourcePath, sourceExtension as 'cif');
    if (entry.objectKind !== undefined && !['crystal', 'molecule', 'amorphous-model'].includes(String(entry.objectKind))) throw new Error('结构对象类型无效。');
    if (entry.family !== undefined && entry.family !== 'carbon-nitrides') throw new Error('结构分组无效。');
    if (entry.categories !== undefined && (!Array.isArray(entry.categories) || entry.categories.some(id => !STRUCTURE_LIBRARY_CATEGORIES.some(item => item.id === id)) || new Set(entry.categories).size !== entry.categories.length)) throw new Error('交叉分类无效。');
    if (entry.legacyIds !== undefined) texts(entry.legacyIds, '历史条目标识');
    const source = reference(entry.source); text(source.recordId, '来源记录号'); text(source.license, '来源许可'); webUrl(source.licenseUrl, '许可链接');
    if (!['experimental', 'computed', 'curated', 'derived'].includes(String(source.structureKind))) throw new Error('缺少可靠的来源结构类型。');
    for (const key of ['version', 'conditions', 'retrievedAt']) if (source[key] !== undefined) text(source[key], `来源${key}`);
    const normalization = object(entry.normalization, '规范化方法'); text(normalization.method, '规范化方法');
    if (normalization.details !== undefined) texts(normalization.details, '规范化步骤');
    if (entry.spaceGroup !== undefined) { const group = object(entry.spaceGroup, '空间群'); text(group.symbol, '空间群符号'); if (group.number !== undefined && (!Number.isInteger(group.number) || Number(group.number) < 1 || Number(group.number) > 230)) throw new Error('空间群编号无效。'); }
    if (entry.pointGroup !== undefined) text(entry.pointGroup, '点群');
    if (entry.bandGap !== undefined) { const gap = object(entry.bandGap, '参考带隙'); if (typeof gap.value !== 'number' || !Number.isFinite(gap.value) || gap.value < 0 || gap.unit !== 'eV') throw new Error('参考带隙数值或单位无效。'); text(gap.method, '带隙方法'); reference(gap.source); }
  }
  return structuredClone(manifest) as unknown as StructureLibraryManifest;
}
export function validateStructureLibrarySnapshot(raw: unknown, entry: StructureLibraryEntry): Structure {
  const snapshot = object(raw, '规范化结构');
  if (snapshot.schemaVersion !== 1 || snapshot.entryId !== entry.id) throw new Error('规范化结构与条目来源身份不一致。');
  const rawStructure = object(snapshot.structure, '来源结构');
  if (rawStructure.id !== entry.id || !Array.isArray(rawStructure.atoms) || !rawStructure.atoms.length) throw new Error('来源结构身份或原子数无效。');
  text(rawStructure.name, '结构名称'); text(rawStructure.format, '结构格式'); texts(rawStructure.notes, '结构说明');
  if (rawStructure.charge !== null && !Number.isSafeInteger(rawStructure.charge)) throw new Error('结构电荷无效。');
  if (rawStructure.multiplicity !== null && (!Number.isSafeInteger(rawStructure.multiplicity) || Number(rawStructure.multiplicity) < 1)) throw new Error('结构多重度无效。');
  const ids = new Set<string>();
  for (const rawAtom of rawStructure.atoms) {
    const atom = object(rawAtom, '来源原子');
    if (typeof atom.id !== 'string' || !atom.id.trim() || ids.has(atom.id)) throw new Error('来源原子稳定身份缺失或重复。');
    ids.add(atom.id);
    if (typeof atom.element !== 'string' || !ELEMENTS.includes(atom.element) || ![atom.x, atom.y, atom.z].every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('来源原子的元素或有限Å坐标无效。');
  }
  const molecular = entry.objectKind === 'molecule';
  if (molecular && rawStructure.cell !== undefined) throw new Error('孤立分子条目不应携带周期晶胞。');
  if (!molecular) {
  const cell = object(rawStructure.cell, '来源晶胞');
  if (!Array.isArray(cell.vectors) || cell.vectors.length !== 3 || cell.vectors.some(vector => !Array.isArray(vector) || vector.length !== 3 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))
    || !Array.isArray(cell.pbc) || cell.pbc.length !== 3 || cell.pbc.some(value => typeof value !== 'boolean')) throw new Error('来源完整晶胞或周期轴无效。');
  if (cell.origin !== undefined && (!Array.isArray(cell.origin) || cell.origin.length !== 3 || cell.origin.some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('来源晶胞原点无效。');
  const provenance = object(cell.pbcProvenance, '周期来源依据');
  if (!['source-explicit', 'format-defined', 'user-confirmed'].includes(String(provenance.kind))) throw new Error('来源周期身份尚未确认。');
  text(provenance.evidence, '周期来源依据');
  }
  const structure = structuredClone(rawStructure) as unknown as Structure;
  if (structure.cell) cellInverse(structure.cell);
  if (structure.bonds !== undefined) {
    if (!Array.isArray(structure.bonds)) throw new Error('来源键表无效。');
    for (const bond of structure.bonds) {
      if (![bond.a, bond.b].every(index => Number.isSafeInteger(index) && index >= 0 && index < structure.atoms.length) || !Number.isFinite(bond.order) || bond.order <= 0) throw new Error('来源键端点或键级无效。');
      validatePeriodicEndpointImages(structure, [structure.atoms[bond.a].id!, structure.atoms[bond.b].id!], bond.image ? [[0, 0, 0], bond.image] : undefined);
    }
  }
  if (structure.sourceAtomIds !== undefined && (!Array.isArray(structure.sourceAtomIds) || structure.sourceAtomIds.length !== ids.size || new Set(structure.sourceAtomIds).size !== ids.size || structure.sourceAtomIds.some(id => !ids.has(id)))) throw new Error('来源原子编号映射无效。');
  return structure;
}
export function normalizeStructureLibrarySearch(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_‐‑–—-]+/g, ''); }
export function searchStructureLibrary(entries: readonly StructureLibraryEntry[], query: string, category: StructureLibraryCategory | 'all' = 'all'): StructureLibraryEntry[] {
  const terms = query.trim().split(/\s+/).map(normalizeStructureLibrarySearch).filter(Boolean);
  return entries.filter(entry => (category === 'all' || entry.category === category || entry.categories?.includes(category)) && terms.every(term => normalizeStructureLibrarySearch([entry.name, entry.nameEn, entry.formula, entry.phase, ...entry.aliases, ...(entry.legacyIds ?? [])].join(' ')).includes(term)));
}
export function structureLibraryCellLabel(structure: Structure): { lengths: string; angles: string } {
  if (!structure.cell) return { lengths: '—', angles: '—' };
  const [a, b, c, alpha, beta, gamma] = cellParameters(structure.cell!);
  return { lengths: `${a.toFixed(3)} / ${b.toFixed(3)} / ${c.toFixed(3)} Å`, angles: `${alpha.toFixed(2)} / ${beta.toFixed(2)} / ${gamma.toFixed(2)}°` };
}
/** Display-only clone using the same default periodic route as coordinate import.
 * An explicit bond list, including an intentional empty list, is authoritative. */
export function createStructureLibraryDisplaySnapshot(snapshot: Structure): Structure {
  const display = structuredClone(snapshot);
  if (display.bonds !== undefined || !display.cell?.pbc.some(Boolean)) return display;
  const perceived = perceivePeriodicConnections(display, { allowUnconfirmedPreview: true });
  delete display.molfile; delete display.bondPerceptionIssues;
  display.bonds = perceived.bonds; display.bondSource = 'inferred';
  if (perceived.issues.length) display.bondPerceptionIssues = perceived.issues;
  return display;
}
export interface StructureLibraryClient { catalog(): Promise<StructureLibraryCatalog>; structure(entry: StructureLibraryEntry): Promise<Structure>; preview(entry: StructureLibraryEntry): Promise<Structure> }
/** Immutable content cache; consumers receive independent snapshots. No model store or science jobs. */
export function createStructureLibraryClient(fetcher: typeof fetch = globalThis.fetch, base = `${import.meta.env.BASE_URL}structure-library/`): StructureLibraryClient {
  const structures = new Map<string, Promise<Structure>>();
  const previews = new Map<string, Promise<Structure>>();
  async function json(path: string): Promise<unknown> { const response = await fetcher(base + path); if (!response.ok) throw new Error(`结构库文件读取失败（${response.status}）。`); return response.json(); }
  function source(entry: StructureLibraryEntry): Promise<Structure> {
    const path = structureLibraryAssetPath(entry.category, entry.structurePath, 'json'), key = JSON.stringify([entry.id, path]);
    let pending = structures.get(key);
    if (!pending) { pending = json(path).then(raw => validateStructureLibrarySnapshot(raw, entry)); structures.set(key, pending); pending.catch(() => structures.delete(key)); }
    return pending;
  }
  let catalog: Promise<StructureLibraryCatalog> | undefined;
  return {
    catalog() {
      catalog ??= Promise.all(STRUCTURE_LIBRARY_CATEGORIES.map(async ({ id }) => {
        try { return { category: id, manifest: validateStructureLibraryManifest(await json(`${id}/manifest.json`), id), message: '' }; }
        catch (error) { return { category: id, manifest: null, message: error instanceof Error ? error.message : String(error) }; }
      })).then(results => {
        const entries: StructureLibraryEntry[] = [], issues: StructureLibraryCatalog['issues'] = [], counts = new Map<string, number>();
        for (const result of results) for (const entry of result.manifest?.entries ?? []) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
        for (const result of results) {
          if (!result.manifest) { issues.push({ category: result.category, message: result.message }); continue; }
          for (const entry of result.manifest.entries) { if (counts.get(entry.id)! > 1) { issues.push({ category: result.category, message: `条目 ${entry.id} 与其他分类重复。` }); continue; } if (entry.category !== 'two-dimensional') entries.push(entry); }
        }
        return { entries, issues };
      });
      return catalog.then(value => { if (value.issues.length) catalog = undefined; return structuredClone(value); });
    },
    async structure(entry) {
      return structuredClone(await source(entry));
    },
    async preview(entry) {
      const path = structureLibraryAssetPath(entry.category, entry.structurePath, 'json'), key = JSON.stringify([entry.id, path]);
      let pending = previews.get(key);
      if (!pending) { pending = source(entry).then(createStructureLibraryDisplaySnapshot); previews.set(key, pending); pending.catch(() => previews.delete(key)); }
      return structuredClone(await pending);
    },
  };
}
