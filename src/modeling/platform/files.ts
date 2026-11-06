import type { BuilderAssignments } from '../../core/builder-draft';
import { builderMaterialSignature, integrateBuilderResult } from '../../core/builder-integration';
import { buildGaussian } from '../../core/gaussian';
import { buildOrcaCommon } from '../../core/orca/common';
import { applySharedOrcaConstraints, integrateOrcaBuilderResult, invalidateOrcaRequestForModel } from '../application/orca-bridge';
import { applySharedGaussianConstraints } from '../application/gaussian-bridge';
import { bindImportedSourceAtomIds, sourceModelState, validateOrcaModelSource, validateSourceAtomIdentity } from '../application/source-model-state';
import { requiresElectronicStateConfirmation } from '../application/electronic-state-context';
import { getInputLayerDraftRole, inputLayerCapabilityError } from '../../core/input-layer-capability';
import { electronCount, electronicStateError, elementSymbol } from '../../core/elements';
import { parseStructures } from '../../core/parsers';
import { assertNoMol2Source, parsePeriodicStructures, validatePeriodicSourceMetadata } from '../../core/periodic-parsers';
import { exportStructure } from '../../core/structure-export';
import { makeDocumentStamp } from '../../core/modeling';
import { canonicalPeriodicBond, cellInverse, validatePeriodicEndpointImages } from '../../core/periodic';
import { validateStructureLibraryProvenance } from '../../core/structure-library-provenance';
import { validateBondSemantics, validateBondPerceptionIssues } from '../../core/bond-semantics';
import { validateAttachmentPorts } from '../../core/modeling/attachment-ports';
import { effectiveModelConstraints, effectiveModelCoordinates, modelCoordinateKey, validateGaussianBoundCoordinates, validateSharedConstraints } from '../constraints';
import { defaultTaskOptions, supportsConstraints } from '../../core/tasks';
import type { Bond, Structure } from '../../core/types';
import type { ChemistryPort, FormatDescriptor, FragmentSnapshot, ModelDocument, ModelFormat, OpenedModelFile, SaveContext } from '../contracts';

const clone = <T,>(value: T): T => structuredClone(value);
const emptyAssignments = (): BuilderAssignments => ({ layers: [], basis: [], fragments: [], frozenAtomIds: [] });
const formats: FormatDescriptor[] = [
  { id: 'sciyue', label: 'Ester Studio模型（完整保留键级与建模信息）', extensions: ['sciyue'] },
  { id: 'gjf', label: 'Gaussian GJF', extensions: ['gjf'] },
  { id: 'com', label: 'Gaussian COM', extensions: ['com'] },
  { id: 'inp', label: 'ORCA INP', extensions: ['inp'] },
  { id: 'sdf', label: 'SDF（含本应用建模元数据）', extensions: ['sdf'] },
  { id: 'mol', label: 'MDL MOL', extensions: ['mol'] },
  { id: 'pdb', label: 'PDB', extensions: ['pdb'] },
  { id: 'xyz', label: 'XYZ', extensions: ['xyz'] },
  { id: 'extxyz', label: 'Extended XYZ', extensions: ['extxyz'] },
  { id: 'cif', label: 'CIF', extensions: ['cif'] },
  { id: 'poscar', label: 'VASP POSCAR（需要真实晶胞）', extensions: ['poscar', 'vasp'] },
];
export function getFormatDescriptors(context?: { orcaJobRequest?: unknown; purpose?: SaveContext['purpose'] }): FormatDescriptor[] {
  return clone(formats.filter(format => context?.purpose === 'structure' ? format.id !== 'inp' : context?.orcaJobRequest ? !['gjf', 'com'].includes(format.id) : format.id !== 'inp'));
}

/** Raw source scientific definitions remain evidence. Only a saved model's
 * explicit assignments or a user adoption populate the current task domains. */
function sourceAssignments(_structure: Structure): BuilderAssignments { return emptyAssignments(); }

/** Connectivity is a distinct Gaussian section, before ModRedundant/basis.
 * The general parser remains authoritative for Cartesian/state/F/S/Gen syntax. */
function parseGaussianFiles(text: string, name: string): Structure[] {
  return text.replace(/\r\n?/g, '\n').split(/^\s*--Link1--\s*$/im).map((job, index) => {
    const lines = job.split('\n');
    const routeStart = lines.findIndex(line => /^\s*#/.test(line));
    let routeEnd = routeStart;
    while (routeEnd >= 0 && routeEnd < lines.length && lines[routeEnd].trim()) routeEnd++;
    const route = lines.slice(routeStart, routeEnd).join(' ');
    const geom = route.match(/\bgeom\s*=\s*(\([^)]*\)|[^\s]+)/i);
    if (!geom || !/(?:^|[,(])(?:connectivity|connect)(?:[,)]|$)/i.test(geom[1])) {
      const structure = parseStructures(job, name)[0];
      if (structure.gaussianSource) { structure.gaussianSource.jobIndex = index; structure.gaussianSource.id = `${name}:${index}`; structure.gaussianSource.routeOverrides.sourceId = `${name}:${index}`; }
      return structure;
    }
    let cursor = routeEnd;
    while (cursor < lines.length && !lines[cursor].trim()) cursor++;
    while (cursor < lines.length && lines[cursor].trim()) cursor++; // title
    while (cursor < lines.length && !lines[cursor].trim()) cursor++;
    cursor++; // electronic state
    const atomStart = cursor;
    while (cursor < lines.length && lines[cursor].trim()) cursor++;
    const count = cursor - atomStart;
    while (cursor < lines.length && !lines[cursor].trim()) cursor++;
    const start = cursor, bonds: Bond[] = [], seen = new Set<string>();
    for (let center = 1; center <= count; center++) {
      const row = lines[cursor++]?.trim().split(/\s+/);
      if (!row || Number(row[0]) !== center || row.length % 2 !== 1) throw new Error('Gaussian Connectivity须按原子顺序逐行提供，不能猜测缺失中心。');
      for (let j = 1; j < row.length; j += 2) {
        const other = Number(row[j]), order = Number(row[j + 1]);
        if (!Number.isSafeInteger(other) || other < 1 || other > count || other === center || ![0.5, 1, 1.5, 2, 3].includes(order)) throw new Error('Gaussian连接表含未支持的端点/键级。');
        const key = [center, other].sort((a, b) => a - b).join(':');
        const previous = bonds.find(bond => [bond.a + 1, bond.b + 1].sort((a, b) => a - b).join(':') === key);
        if (seen.has(key)) { if (previous?.order !== order) throw new Error('Gaussian连接表同一键的键级冲突。'); continue; }
        seen.add(key); bonds.push({ a: center - 1, b: other - 1, order, ...(order === 0.5 ? { fractional: true } : order === 1.5 ? { aromatic: true } : {}) });
      }
    }
    if (lines[cursor]?.trim()) throw new Error('Gaussian连接表末尾缺少空行。');
    const remaining = geom[1].replace(/[()]/g, '').split(',').map(v => v.trim()).filter(v => !/^(connect|connectivity)$/i.test(v));
    lines.splice(start, cursor - start);
    const originalRoute = lines.slice(routeStart, routeEnd).join('\n');
    const strippedRoute = originalRoute.replace(geom[0], remaining.length ? `geom=(${remaining.join(',')})` : '');
    lines.splice(routeStart, routeEnd - routeStart, strippedRoute);
    const structure = parseStructures(lines.join('\n'), name)[0];
    structure.bonds = bonds; structure.bondSource = 'file';
    structure.sourceRoute = route;
    if (structure.gaussianSource) { structure.gaussianSource.route = route; structure.gaussianSource.jobIndex = index; structure.gaussianSource.id = `${name}:${index}`; structure.gaussianSource.routeOverrides.sourceId = `${name}:${index}`; }
    return structure;
  });
}

const SDF_FIELD = 'SCIYUE_MODEL_METADATA_V1';
interface SdfMetadata {
  version: 1;
  atoms: Omit<Structure['atoms'][number], 'x' | 'y' | 'z'>[];
  structure: Pick<Structure, 'name' | 'charge' | 'multiplicity' | 'cell' | 'periodicSource' | 'periodicWorkingSource' | 'libraryProvenance' | 'groups' | 'modelLayers' | 'layout2D' | 'dimension' | 'gaussianSource' | 'gaussianSources' | 'orcaSource' | 'sourceAtomIds' | 'sourceRoute' | 'mapping' | 'bondPerceptionIssues' | 'bondSource'>;
  bonds?: Bond[];
  assignments: BuilderAssignments;
  auxiliaryRelations: FragmentSnapshot['auxiliaryRelations'];
  deletedBonds: FragmentSnapshot['deletedBonds'];
  internalCoordinates?: FragmentSnapshot['internalCoordinates'];
  sharedConstraints?: FragmentSnapshot['sharedConstraints'];
  coordinateObjects?: FragmentSnapshot['coordinateObjects'];
  gaussianBoundCoordinates?: FragmentSnapshot['gaussianBoundCoordinates'];
  attachmentPorts?: FragmentSnapshot['attachmentPorts'];
  /** Native connection-table chemistry/stereo at save time; coordinate edits
   * remain valid but an external chemistry edit cannot revive stale metadata. */
  connectionTable?: string;
}

const sdfBondOrder = (bond: Bond): number => bond.aromatic || bond.order === 4 || bond.order === 1.5 ? 1.5 : bond.order;
const sdfGraph = (bonds: Bond[] = []): string => JSON.stringify(bonds.map(bond => [Math.min(bond.a, bond.b), Math.max(bond.a, bond.b), sdfBondOrder(bond)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
function assertSdfChemicalAgreement(actual: Structure, atoms: SdfMetadata['atoms'], bonds: Bond[] = []): void {
  if (atoms.length !== actual.atoms.length || actual.atoms.some((atom, i) => atom.element !== atoms[i]?.element || (atom.formalCharge ?? 0) !== (atoms[i]?.formalCharge ?? 0))) throw new Error('SDF连接表与建模元数据的元素顺序/形式电荷冲突；请明确选择要保留的版本。');
  if (sdfGraph(actual.bonds) !== sdfGraph(bonds)) throw new Error('SDF连接表与建模元数据的化学键端点/键级冲突；请明确选择要保留的版本。');
}

/** Preserve representable MDL stereo separately from the model's stable-ID
 * parity convention. Native writers may derive wedges/CFG from 3D chirality;
 * comparing their own saved representation avoids treating those as changes.
 * Direction-free endpoint reversal is canonical; a wedge's narrow endpoint is
 * meaningful and is retained. Periodic image vectors are extension metadata. */
function sdfConnectionSignature(actual: Structure, record: string): string {
  const sourceLines = record.split('\n'), lines: string[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    let line = sourceLines[i];
    while (/^M\s+V30\b.*-\s*$/.test(line)) line = line.replace(/-\s*$/, '') + (sourceLines[++i] ?? '').replace(/^M\s+V30\s*/, '');
    lines.push(line);
  }
  const parity = actual.atoms.map(() => 0), stereo: (number | string)[][] = [];
  if (/V3000/.test(record)) {
    const start = lines.findIndex(line => /M\s+V30\s+BEGIN ATOM/.test(line)), end = lines.findIndex(line => /M\s+V30\s+END ATOM/.test(line));
    const numbers = new Map<string, number>();
    lines.slice(start + 1, end).forEach((line, index) => { const row = line.trim().split(/\s+/); numbers.set(row[2], index); parity[index] = Number(line.match(/\bCFG=(\d+)/)?.[1] ?? 0); });
    const bondStart = lines.findIndex(line => /M\s+V30\s+BEGIN BOND/.test(line)), bondEnd = lines.findIndex(line => /M\s+V30\s+END BOND/.test(line));
    if (bondStart >= 0) for (const line of lines.slice(bondStart + 1, bondEnd)) {
      const row = line.trim().split(/\s+/), a = numbers.get(row[4])!, b = numbers.get(row[5])!, cfg = Number(line.match(/\bCFG=(\d+)/)?.[1] ?? 0);
      const code = ({ 0: 'none', 1: 'up', 2: 'either', 3: 'down' } as Record<number, string>)[cfg] ?? `cfg:${cfg}`;
      stereo.push([Math.min(a, b), Math.max(a, b), code, cfg ? a : -1]);
    }
  } else {
    const countIndex = lines.findIndex(line => /V2000/.test(line)), count = actual.atoms.length;
    for (let i = 0; i < count; i++) parity[i] = Number(lines[countIndex + 1 + i]?.slice(39, 42).trim() || 0);
    for (let i = 0; i < (actual.bonds?.length ?? 0); i++) {
      const line = lines[countIndex + 1 + count + i], a = Number(line.slice(0, 3)) - 1, b = Number(line.slice(3, 6)) - 1, cfg = Number(line.slice(9, 12).trim() || 0);
      const code = ({ 0: 'none', 1: 'up', 6: 'down', 4: 'either', 3: 'cis-trans' } as Record<number, string>)[cfg] ?? `stereo:${cfg}`;
      stereo.push([Math.min(a, b), Math.max(a, b), code, [1, 4, 6].includes(cfg) ? a : -1]);
    }
  }
  return JSON.stringify([actual.atoms.map((atom, i) => [atom.element, atom.formalCharge ?? 0, parity[i]]), JSON.parse(sdfGraph(actual.bonds)), stereo.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}

function validateFragment(fragment: FragmentSnapshot): void {
  const s = fragment.structure, ids = new Set(s.atoms.map(atom => atom.id));
  validateBondPerceptionIssues(s);
  for(const layer of s.modelLayers??[]){const role=getInputLayerDraftRole(layer);if(role.status==='invalid')throw new Error(role.error);}
  if (!s.atoms.length || ids.has(undefined) || ids.has('') || ids.size !== s.atoms.length) throw new Error('文件原子ID缺失或重复。');
  if (s.atoms.some(a => ![a.x, a.y, a.z].every(Number.isFinite))) throw new Error('结构含非有限坐标。');
  if (s.charge !== null && !Number.isSafeInteger(s.charge) || s.multiplicity !== null && (!Number.isSafeInteger(s.multiplicity) || s.multiplicity < 1)) throw new Error('文件元数据电荷/多重度无效。');
  if (s.cell) cellInverse(s.cell);
  validatePeriodicSourceMetadata(s);
  if(s.libraryProvenance!==undefined)validateStructureLibraryProvenance(s.libraryProvenance);
  if (s.bondSource !== undefined && !['file', 'inferred', 'drawn'].includes(s.bondSource)) throw new Error('文件连接来源无效。');
  if (s.orcaSource) validateOrcaModelSource(s.orcaSource);
  validateSourceAtomIdentity(s);
  const refs = (values: string[]) => { if (!Array.isArray(values) || values.some(id => typeof id !== 'string' || !ids.has(id)) || new Set(values).size !== values.length) throw new Error('文件元数据引用无效或重复的原子ID。'); };
  const assignments = fragment.assignments;
  if (!assignments || !Array.isArray(assignments.frozenAtomIds)) throw new Error('文件冻结元数据无效。');
  refs(assignments.frozenAtomIds);
  for (const key of ['basis', 'layers', 'fragments'] as const) {
    if (!Array.isArray(assignments[key])) throw new Error('文件分区元数据无效。');
    const seen = new Set<string>();
    const entryIds = new Set<string>();
    for (const entry of assignments[key]) {
      const role=getInputLayerDraftRole(entry);if(role.status==='invalid')throw new Error(role.error);if(key!=='layers'&&role.status!=='none')throw new Error('输入层草稿角色不能放在基组或计算分片域。');
      if (!entry.id || typeof entry.id !== 'string' || entryIds.has(entry.id)) throw new Error('文件分区标识缺失或重复。');
      entryIds.add(entry.id); refs(entry.atomIds);
      if (entry.frozen !== undefined && typeof entry.frozen !== 'boolean' || entry.basis !== undefined && typeof entry.basis !== 'string' || entry.kind !== undefined && !['qm', 'mm', 'middle'].includes(entry.kind) || entry.charge !== undefined && !Number.isSafeInteger(entry.charge) || entry.multiplicity !== undefined && (!Number.isSafeInteger(entry.multiplicity) || entry.multiplicity < 1)) throw new Error('文件分区属性无效。');
      for (const id of entry.atomIds) { if (seen.has(id)) throw new Error('文件同类分区重叠，不能静默恢复。'); seen.add(id); }
    }
  }
  for (const relation of fragment.auxiliaryRelations) { refs([relation.a, relation.b]); if (relation.order !== 0.5 || relation.kind !== 'auxiliary' || !relation.id) throw new Error('辅助线元数据无效。'); }
  for (const relation of fragment.deletedBonds) {
    if (!Array.isArray(relation.atomIds) || relation.atomIds.length !== 2 || Object.keys(relation).some(key => !['atomIds', 'image'].includes(key))) throw new Error('已删除连接元数据端点/字段无效。');
    validatePeriodicEndpointImages(s, relation.atomIds, relation.image ? [[0, 0, 0], relation.image] : undefined);
  }
  validateAttachmentPorts(fragment.attachmentPorts,s);
  if (fragment.coordinateObjects !== undefined && !Array.isArray(fragment.coordinateObjects) || fragment.sharedConstraints !== undefined && (!fragment.sharedConstraints || !Array.isArray(fragment.sharedConstraints.coordinates))) throw new Error('文件共有约束/BAD对象元数据无效。');
  const onlyKeys = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
  if ((fragment.coordinateObjects ?? []).some(object => !object || !onlyKeys(object, ['id', 'type', 'atomIds', 'images'])) || fragment.sharedConstraints && !onlyKeys(fragment.sharedConstraints, ['frozenAtomIds', 'coordinates', 'canonical', 'enabled'])) throw new Error('文件共有约束/BAD对象含未支持的字段。');
  const sharedIds = new Set<string>();
  for (const row of fragment.sharedConstraints?.coordinates ?? []) {
    if (!row || !onlyKeys(row, ['id', 'objectId', 'type', 'atomIds', 'images', 'action', 'steps', 'increment', 'value', 'source']) || typeof row.id !== 'string' || !row.id || sharedIds.has(row.id)) throw new Error('文件共有内坐标标识无效、重复或含未支持的字段。');
    sharedIds.add(row.id);
  }
  validateSharedConstraints(fragment.sharedConstraints ?? { frozenAtomIds: [], coordinates: [] }, fragment.coordinateObjects ?? [], s);
  if (fragment.gaussianBoundCoordinates !== undefined) {
    if (!Array.isArray(fragment.gaussianBoundCoordinates) || fragment.gaussianBoundCoordinates.length > 1000 || fragment.gaussianBoundCoordinates.some(row => !row || !onlyKeys(row, ['rowId', 'objectId', 'type', 'atomIds', 'action', 'rowEnabled', 'stepsText', 'incrementText']))) throw new Error('Gaussian已绑定行元数据格式无效或含未支持的字段。');
    validateGaussianBoundCoordinates(fragment.gaussianBoundCoordinates, fragment.coordinateObjects ?? [], s);
  }
  const coordinateIds = new Set<string>();
  for (const coordinate of fragment.internalCoordinates ?? []) {
    if (!coordinate || !onlyKeys(coordinate, ['id', 'type', 'atomIds', 'images', 'objectId', 'action', 'steps', 'increment', 'source', 'value', 'start', 'end', 'values'])) throw new Error('内坐标元数据含未支持的字段。');
    if (coordinate.id !== undefined) { if (typeof coordinate.id !== 'string' || !coordinate.id || coordinateIds.has(coordinate.id)) throw new Error('内坐标元数据标识无效或重复。'); coordinateIds.add(coordinate.id); }
    if (coordinate.objectId !== undefined) {
      const object = fragment.coordinateObjects?.find(object => object.id === coordinate.objectId);
      if (!object || modelCoordinateKey(object) !== modelCoordinateKey(coordinate)) throw new Error('内坐标元数据关联BAD对象缺失或不一致。');
    }
    if (!['B', 'A', 'D'].includes(coordinate.type) || !Array.isArray(coordinate.atomIds) || coordinate.atomIds.length !== ({ B: 2, A: 3, D: 4 }[coordinate.type])) throw new Error('内坐标元数据类型/原子数无效。');
    validatePeriodicEndpointImages(s, coordinate.atomIds, coordinate.images);
    if (!['freeze', 'scan'].includes(coordinate.action)) throw new Error('内坐标元数据动作无效。');
    if (coordinate.source === 'orca') {
      const valid = (value: number | undefined) => value !== undefined && Number.isFinite(value) && (coordinate.type === 'B' ? value > 0 : coordinate.type === 'A' ? value > 0 && value < 180 : true);
      if (coordinate.action === 'freeze' && coordinate.value !== undefined && !valid(coordinate.value)) throw new Error('ORCA冻结元数据无效。');
      if (coordinate.action === 'scan' && (!Number.isSafeInteger(coordinate.steps) || (coordinate.values !== undefined
        ? !Array.isArray(coordinate.values) || coordinate.values.length < 2 || coordinate.steps !== coordinate.values.length || !coordinate.values.every(valid) || coordinate.values.every(value => value === coordinate.values![0]) || coordinate.start !== undefined || coordinate.end !== undefined
        : !valid(coordinate.start) || !valid(coordinate.end) || coordinate.start === coordinate.end || coordinate.steps < 2))) throw new Error('ORCA扫描元数据无效。');
    } else if (coordinate.action === 'scan' && (!Number.isSafeInteger(coordinate.steps) || coordinate.steps < 1 || coordinate.increment === null || !Number.isFinite(coordinate.increment) || coordinate.increment === 0)) throw new Error('扫描元数据无效。');
  }
  const edges = new Set<string>();
  for (const bond of s.bonds ?? []) {
    if (!bond || !onlyKeys(bond, ['a', 'b', 'order', 'aromatic', 'stereo', 'kind', 'orderKnown', 'fractional', 'image', 'perception', 'mbo'])) throw new Error('文件化学键含未支持的字段。');
    if (![bond.a, bond.b].every(n => Number.isSafeInteger(n) && n >= 0 && n < s.atoms.length) || bond.a === bond.b && !bond.image?.some(Boolean) || ![0.5, 1, 1.5, 2, 3, 4].includes(bond.order)) throw new Error('文件化学键端点或键级无效；0.5辅助线须独立保存。');
    if (bond.kind !== undefined && !['covalent', 'coordination'].includes(bond.kind) || bond.stereo !== undefined && (!Number.isSafeInteger(bond.stereo) || bond.stereo < 0 || bond.stereo > 6) || bond.image !== undefined && (!Array.isArray(bond.image) || bond.image.length !== 3 || !bond.image.every(Number.isSafeInteger))) throw new Error('文件化学键类型/构型/跨胞映像无效。');
    validatePeriodicEndpointImages(s, [s.atoms[bond.a].id!, s.atoms[bond.b].id!], bond.image ? [[0, 0, 0], bond.image] : undefined);
    const key = canonicalPeriodicBond(bond.a, bond.b, bond.image).key;
    if (edges.has(key)) throw new Error('文件含重复化学键。'); edges.add(key);
    if (bond.order === .5 && bond.fractional !== true) throw new Error('0.5辅助线须独立保存；化学分数键必须显式标记fractional。');
    validateBondSemantics(bond, s);
  }
}

const NATIVE_SCHEMA = 'sciyue-model/v1';
const fragmentFields = ['structure', 'assignments', 'auxiliaryRelations', 'deletedBonds', 'internalCoordinates', 'sharedConstraints', 'coordinateObjects', 'gaussianBoundCoordinates', 'attachmentPorts', 'cellCheckpoint'];
function knownObject(value: unknown, keys: string[], required: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('Ester Studio模型含未支持的字段或缺少必要字段。');
}
/** Decode only native model data. Document selection, live calculation caches,
 * task execution state and runtime observations are deliberately outside v1. */
function parseNativeModel(text: string): FragmentSnapshot {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Ester Studio模型JSON损坏。'); }
  knownObject(value, ['schema', 'fragment'], ['schema', 'fragment']);
  if (value.schema !== NATIVE_SCHEMA) throw new Error('Ester Studio模型schema版本不支持。');
  const fragment = value.fragment;
  knownObject(fragment, fragmentFields, ['structure', 'assignments', 'auxiliaryRelations', 'deletedBonds']);
  const structure = fragment.structure;
  knownObject(structure, ['id', 'name', 'format', 'atoms', 'charge', 'multiplicity', 'notes', 'sourceRoute', 'gaussianSource', 'gaussianSources', 'orcaSource', 'sourceAtomIds', 'bonds', 'bondSource', 'bondPerceptionIssues', 'dimension', 'molfile', 'groups', 'mapping', 'preparation', 'cell', 'periodicSource', 'periodicWorkingSource', 'libraryProvenance', 'layout2D', 'revision', 'modelLayers'], ['id', 'name', 'format', 'atoms', 'charge', 'multiplicity', 'notes']);
  if (typeof structure.id !== 'string' || !structure.id || typeof structure.name !== 'string' || typeof structure.format !== 'string' || !Array.isArray(structure.atoms) || !Array.isArray(structure.notes) || structure.notes.some(note => typeof note !== 'string') || structure.bonds !== undefined && !Array.isArray(structure.bonds) || !Array.isArray(fragment.auxiliaryRelations) || !Array.isArray(fragment.deletedBonds)) throw new Error('Ester Studio模型结构/列表格式无效。');
  for (const atom of structure.atoms) {
    knownObject(atom, ['id', 'sourceIndex', 'formalCharge', 'element', 'x', 'y', 'z', 'hydrogenMode', 'aromaticHydrogen', 'stereoParity', 'geometryPresetId'], ['id', 'element', 'x', 'y', 'z']);
    if (typeof atom.id !== 'string' || !atom.id || typeof atom.element !== 'string' || !/^[A-Z][a-z]?$/.test(atom.element) || atom.formalCharge !== undefined && !Number.isSafeInteger(atom.formalCharge) || atom.sourceIndex !== undefined && (!Number.isSafeInteger(atom.sourceIndex) || (atom.sourceIndex as number) < 1) || atom.hydrogenMode !== undefined && !['auto', 'explicit'].includes(atom.hydrogenMode as string) || atom.aromaticHydrogen !== undefined && typeof atom.aromaticHydrogen !== 'boolean' || atom.stereoParity !== undefined && ![-1, 0, 1].includes(atom.stereoParity as number) || atom.geometryPresetId !== undefined && (typeof atom.geometryPresetId !== 'string' || !atom.geometryPresetId)) throw new Error('Ester Studio模型原子属性无效。');
    elementSymbol(atom.element);
  }
  for (const bond of (structure.bonds ?? []) as unknown[]) knownObject(bond, ['a', 'b', 'order', 'aromatic', 'stereo', 'kind', 'orderKnown', 'fractional', 'image', 'perception', 'mbo'], ['a', 'b', 'order']);
  knownObject(fragment.assignments, ['layers', 'basis', 'fragments', 'frozenAtomIds'], ['layers', 'basis', 'fragments', 'frozenAtomIds']);
  const knownRows = (rows: unknown, keys: string[]): void => { if (!Array.isArray(rows)) throw new Error('Ester Studio模型列表格式无效。'); for (const row of rows) knownObject(row, keys); };
  for (const key of ['layers', 'basis', 'fragments']) knownRows(fragment.assignments[key], ['id', 'atomIds', 'label', 'kind', 'basis', 'charge', 'multiplicity', 'frozen', 'draftRole']);
  knownRows(fragment.auxiliaryRelations, ['id', 'a', 'b', 'order', 'kind']);
  knownRows(fragment.deletedBonds, ['atomIds', 'image']);
  if (fragment.internalCoordinates !== undefined) knownRows(fragment.internalCoordinates, ['id', 'type', 'atomIds', 'images', 'objectId', 'action', 'steps', 'increment', 'source', 'value', 'start', 'end', 'values']);
  if (structure.groups !== undefined) knownRows(structure.groups, ['name', 'atomIds']);
  if (structure.modelLayers !== undefined) knownRows(structure.modelLayers, ['id', 'label', 'kind', 'atomIds', 'frozen', 'draftRole']);
  if (structure.mapping !== undefined) knownRows(structure.mapping, ['original', 'current']);
  if (structure.preparation !== undefined) knownObject(structure.preparation, ['forcefield', 'before', 'after', 'unit', 'status'], ['status']);
  if (structure.cell !== undefined) knownObject(structure.cell, ['vectors', 'pbc', 'origin', 'source', 'pbcProvenance'], ['vectors', 'pbc']);
  const finiteTree = (node: unknown, depth = 0): void => {
    if (depth > 64 || typeof node === 'number' && !Number.isFinite(node)) throw new Error('Ester Studio模型含非有限数字或嵌套超出范围。');
    if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Ester Studio模型含不支持的对象字段。'); finiteTree(child, depth + 1); }
  };
  finiteTree(fragment);
  const result = fragment as unknown as FragmentSnapshot;
  if (fragment.cellCheckpoint !== undefined) {
    knownObject(fragment.cellCheckpoint, fragmentFields.filter(key => key !== 'cellCheckpoint'), ['structure', 'assignments', 'auxiliaryRelations', 'deletedBonds']);
    result.cellCheckpoint = parseNativeModel(nativeJSON({ schema: NATIVE_SCHEMA, fragment: fragment.cellCheckpoint })!);
  }
  validateFragment(result); return result;
}

function modelFragment(document: ModelDocument): FragmentSnapshot {
  return { structure: document.draft.structure, assignments: document.draft.assignments, auxiliaryRelations: document.auxiliaryRelations, deletedBonds: document.deletedBonds, internalCoordinates: document.internalCoordinates, sharedConstraints: document.sharedConstraints, coordinateObjects: document.coordinateObjects, gaussianBoundCoordinates: document.gaussianBoundCoordinates, attachmentPorts: document.attachmentPorts, cellCheckpoint: document.cellCheckpoint };
}
/** Plain JSON with exact Cartesian -0 components, never tagged runtime values. */
function nativeJSON(value: unknown): string | undefined {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Ester Studio模型含非有限数字。');
  if (typeof value === 'number' && Object.is(value, -0)) return '-0';
  if (Array.isArray(value)) return '[' + value.map(item => nativeJSON(item) ?? 'null').join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => JSON.stringify(key) + ':' + nativeJSON(child)).join(',') + '}';
  return JSON.stringify(value);
}

function restoreSdfMetadata(fragment: FragmentSnapshot, record: string): FragmentSnapshot {
  const fields = [...record.matchAll(new RegExp(`^>[^\\n]*<${SDF_FIELD}>[^\\n]*\\n([^\\n]+)`, 'gm'))];
  if (!fields.length) return fragment;
  if (fields.length !== 1) throw new Error('SDF建模元数据字段重复。');
  let meta: SdfMetadata;
  try { meta = JSON.parse(fields[0][1]); } catch { throw new Error('SDF建模元数据JSON损坏。'); }
  if (meta?.version !== 1 || !Array.isArray(meta.atoms) || meta.atoms.length !== fragment.structure.atoms.length || !meta.structure || !Array.isArray(meta.auxiliaryRelations) || !Array.isArray(meta.deletedBonds)) throw new Error('SDF建模元数据版本/原子数无效。');
  if (Object.keys(meta).some(key => !['version', 'atoms', 'structure', 'bonds', 'assignments', 'auxiliaryRelations', 'deletedBonds', 'internalCoordinates', 'sharedConstraints', 'coordinateObjects', 'gaussianBoundCoordinates', 'attachmentPorts', 'connectionTable'].includes(key))) throw new Error('SDF元数据含未支持的字段。');
  const structureFields = ['name', 'charge', 'multiplicity', 'cell', 'periodicSource', 'periodicWorkingSource', 'libraryProvenance', 'groups', 'modelLayers', 'layout2D', 'dimension', 'gaussianSource', 'gaussianSources', 'orcaSource', 'sourceAtomIds', 'sourceRoute', 'mapping', 'bondPerceptionIssues', 'bondSource'];
  const atomFields = ['id', 'sourceIndex', 'formalCharge', 'element', 'hydrogenMode', 'aromaticHydrogen', 'stereoParity', 'geometryPresetId'];
  if (Object.keys(meta.structure).some(key => !structureFields.includes(key))) throw new Error('SDF元数据含未支持的结构字段。');
  const structure = fragment.structure;
  const restoredAtoms = structure.atoms.map((atom, index) => {
    const props = meta.atoms[index];
    if (!props || Object.keys(props).some(key => !atomFields.includes(key)) || props.element !== atom.element) throw new Error('SDF建模元数据与连接表原子顺序不一致或含未知字段。');
    if (props.formalCharge !== undefined && !Number.isSafeInteger(props.formalCharge) || props.sourceIndex !== undefined && !Number.isSafeInteger(props.sourceIndex) || props.hydrogenMode !== undefined && !['auto', 'explicit'].includes(props.hydrogenMode) || props.stereoParity !== undefined && ![-1, 0, 1].includes(props.stereoParity)) throw new Error('SDF原子元数据属性无效。');
    if(props.geometryPresetId!==undefined&&(typeof props.geometryPresetId!=='string'||!props.geometryPresetId||props.geometryPresetId.length>200))throw new Error('SDF几何模板标记无效。');
    return { ...props, x: atom.x, y: atom.y, z: atom.z };
  });
  // The real connection table is authoritative for chemistry. Data fields are
  // opaque to many external editors and can outlive an edited bond/M CHG row.
  assertSdfChemicalAgreement(structure, restoredAtoms, meta.bonds);
  const signature = sdfConnectionSignature(structure, record);
  if (meta.connectionTable !== undefined) {
    if (typeof meta.connectionTable !== 'string' || meta.connectionTable !== signature) throw new Error('SDF连接表立体/化学定义与保存元数据冲突；请明确选择要保留的版本。');
  } else {
    // Earlier local data fields had no native stereo baseline. Only restore
    // them when the directly expressible wedge fields agree exactly.
    const stereoGraph = (bonds: Bond[] = []) => JSON.stringify(bonds.map(b => [Math.min(b.a, b.b), Math.max(b.a, b.b), b.stereo ?? 0, b.stereo ? b.a : -1]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if (stereoGraph(structure.bonds) !== stereoGraph(meta.bonds) || /\bCFG=[1-9]/.test(record) || /V2000/.test(record) && record.split('\n').some(line => /^[ -+\d.]{30} [A-Za-z]/.test(line) && Number(line.slice(39, 42).trim() || 0) !== 0)) throw new Error('旧SDF元数据缺少可核验的原生立体定义；请明确选择连接表后重新保存。');
  }
  structure.atoms = restoredAtoms;
  Object.assign(structure, meta.structure);
  if (structure.gaussianSource || structure.gaussianSources?.length) structure.sourceRoute = undefined;
  if (meta.bonds !== undefined) structure.bonds = meta.bonds;
  const result = { structure, assignments: meta.assignments, auxiliaryRelations: meta.auxiliaryRelations, deletedBonds: meta.deletedBonds, internalCoordinates: meta.internalCoordinates, sharedConstraints:meta.sharedConstraints, coordinateObjects:meta.coordinateObjects, gaussianBoundCoordinates:meta.gaussianBoundCoordinates, attachmentPorts:meta.attachmentPorts };
  validateFragment(result); return result;
}

/** GJF/COM and supported source formats use their own readers. */
export function parseModelFiles(files: OpenedModelFile[]): FragmentSnapshot[] {
  return files.flatMap((file, fileIndex) => {
    if (file.text === undefined) throw new Error('该文件需要流式模型导入入口。');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error(`${file.name}字节数无效。`);
    if (file.text.includes('\0')) throw new Error(`${file.name}不是可读UTF-8文本。`);
    const text = file.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (/\.sciyue$/i.test(file.name)) return [parseNativeModel(text)];
    assertNoMol2Source(text, file.name);
    const isGaussian = /\.(gjf|com)$/i.test(file.name) || /(?:\.txt|^[^.]+)$/i.test(file.name) && /^\s*#[pnt]?\s/im.test(text);
    const structures = isGaussian ? parseGaussianFiles(text, file.name) : parsePeriodicStructures(text, file.name, Object.fromEntries(files.map(f => [f.name, f.text ?? '']))) ?? parseStructures(text, /\.extxyz$/i.test(file.name) ? file.name.replace(/\.extxyz$/i, '.xyz') : file.name);
    const sdfRecords = /\.sdf$/i.test(file.name) ? text.split(/^\$\$\$\$\s*$/m).filter(record => record.trim()) : [];
    return structures.map((structure, index) => {
      structure.id = globalThis.crypto?.randomUUID?.() ?? `file-${fileIndex}-${index}-${Date.now()}`;
      structure.atoms = structure.atoms.map((atom, atomIndex) => ({ ...atom, id: atom.id ?? `${structure.id}:atom:${atomIndex + 1}`, sourceIndex: atom.sourceIndex ?? atomIndex + 1 }));
      structure = bindImportedSourceAtomIds(structure);
      const fragment: FragmentSnapshot = { structure, assignments: sourceAssignments(structure), auxiliaryRelations: [], deletedBonds: [],
        ...sourceModelState(structure) };
      const result = sdfRecords[index] ? restoreSdfMetadata(fragment, sdfRecords[index]) : fragment;
      validateFragment(result); return result;
    });
  });
}

/** Streaming readers already identify complete job/frame choices; retain each one. */
export function modelFragmentsFromStructures(structures: Structure[]): FragmentSnapshot[] {
  return structures.map((structure, index) => {
    structure = clone(structure); structure.id = globalThis.crypto?.randomUUID?.() ?? `import-${index}-${Date.now()}`;
    structure.atoms = structure.atoms.map((atom, atomIndex) => ({ ...atom, id: atom.id ?? `${structure.id}:atom:${atomIndex + 1}`, sourceIndex: atom.sourceIndex ?? atomIndex + 1 }));
    structure = bindImportedSourceAtomIds(structure);
    const fragment: FragmentSnapshot = { structure, assignments: sourceAssignments(structure), auxiliaryRelations: [], deletedBonds: [],
      ...sourceModelState(structure) };
    validateFragment(fragment); return fragment;
  });
}

function metadataLosses(document: ModelDocument, format: ModelFormat): string[] {
  if (format === 'sdf') return ['SDF连接表坐标精度由原生转换器决定；本应用元数据由其它软件另存时可能移除。'];
  const losses: string[] = [], s = document.draft.structure, a = document.draft.assignments;
  if(document.attachmentPorts?.length)losses.push('该格式不保留建模待接端口。');
  if(s.atoms.some(atom=>atom.geometryPresetId))losses.push('该格式不保留建模几何模板。');
  if (effectiveModelConstraints(document).frozenAtomIds.length || effectiveModelCoordinates(document).length) losses.push('该格式不保存本应用冻结/扫描定义。');
  if (document.coordinateObjects?.length) losses.push('该格式不保存本应用B/A/D对象身份与关联。');
  if (document.gaussianBoundCoordinates?.length) losses.push('该格式不保存Gaussian已绑定行的开关与编辑文本。');
  if (a.layers.length || a.basis.length || a.fragments.length) losses.push('该格式不保存本应用层/基组/片段分区。');
  if (document.auxiliaryRelations.length) losses.push('0.5辅助虚线不会导出为普通化学键。');
  if (document.deletedBonds.length) losses.push('显式删键记录不保存；重新推断连接时须重新核对。');
  if (s.atoms.some(atom => atom.hydrogenMode || atom.aromaticHydrogen)) losses.push('手动氢策略/芳香氢意图不保存。');
  if (s.layout2D) losses.push('独立二维草稿坐标不保存。');
  if (s.dimension === 2) losses.push('该格式不保留二维建模维度标记；这些坐标不能代替真实三维生成。');
  if (s.bonds?.length && ['xyz', 'extxyz', 'cif', 'poscar'].includes(format)) losses.push('此导出只保存结构坐标与适用晶胞，不保存化学键。');
  if (['xyz', 'extxyz', 'cif', 'poscar'].includes(format) && (s.atoms.some(atom => atom.stereoParity !== undefined) || s.bonds?.some(bond => bond.stereo))) losses.push('该格式不保存逐原子立体标签和键的楔线／未指定构型标记；三维坐标仍按当前模型保存。');
  if (s.bonds?.length && format === 'pdb') losses.push('当前PDB读取器只恢复显式原子坐标，不恢复CONECT键级/芳香语义。');
  if (s.bonds?.some(bond => bond.kind === 'coordination' || bond.image?.some(Boolean)) && ['mol', 'pdb'].includes(format)) losses.push('配位键类型/跨胞键映像元数据不保证保留。');
  if (!['xyz', 'extxyz'].includes(format) && (s.charge !== null || s.multiplicity !== null)) losses.push('总电荷/多重度不能保证由该格式重新读取。');
  if (s.atoms.some(atom => atom.formalCharge) && ['xyz', 'extxyz', 'cif', 'poscar', 'pdb'].includes(format)) losses.push('逐原子形式电荷不能保证重载恢复。');
  if (['mol', 'pdb'].includes(format)) losses.push('稳定原子ID/来源序号不保存；坐标精度由原生格式写出器决定。');
  if (s.cell && ['mol', 'pdb'].includes(format)) losses.push('该原生导出不保证晶胞方向/原点/周期边界与跨胞键完整保留；保留真实晶胞请用extXYZ/CIF/POSCAR/SDF。');
  return losses;
}

/** A geometry interchange file, deliberately independent of task settings.
 * It carries no selected method, optimization or frequency calculation. */
function gaussianStructureExport(document: ModelDocument): { text: string; losses: string[] } {
  const s = document.draft.structure;
  if (s.charge === null || s.multiplicity === null) throw new Error('结构GJF/COM需要明确模型电荷和多重度；请先确认模型电子态。');
  const stateError = electronicStateError(s.atoms, s.charge, s.multiplicity);
  if (stateError) throw new Error(stateError);
  if (s.bonds?.some(bond => bond.kind === 'coordination' || bond.image?.some(Boolean))) throw new Error('普通Gaussian连接表不表达配位语义/跨胞键；请使用Ester Studio模型格式完整保存。');
  const title = s.name.replace(/[\r\n\x00-\x1f]/g, ' ').trim() || 'Ester Studio structure';
  const route = s.bonds === undefined ? '#' : '# geom=connectivity';
  const coordinates = s.atoms.map(atom => `${atom.element} ${atom.x} ${atom.y} ${atom.z}`).join('\n');
  const connection = s.bonds === undefined ? '' : '\n' + s.atoms.map((_atom, index) => [String(index + 1), ...s.bonds!.filter(bond => Math.min(bond.a, bond.b) === index).flatMap(bond => [String(Math.max(bond.a, bond.b) + 1), String(bond.aromatic || bond.order === 4 ? 1.5 : bond.order)])].join(' ')).join('\n') + '\n';
  const text = `${route}\n\n${title} - Generated by Ester Studio; structure only; calculation method and task not specified\n\n${s.charge} ${s.multiplicity}\n${coordinates}\n\n${connection}\n`;
  const losses = metadataLosses(document, 'gjf').filter(loss => !loss.startsWith('总电荷/多重度'));
  losses.unshift('这是结构交换GJF/COM，仅保存坐标、电子态及可表达连接；尚未指定计算方法或任务，不能直接作为已确认的计算输入。');
  if (s.cell) losses.push('结构GJF/COM不保存晶胞；有限坐标仍按当前模型原样保存。');
  if (s.bonds?.some(bond => bond.order === 0.5)) losses.push('0.5分数化学键按原数值写入连接表；不取整，也不等于0.5辅助虚线。');
  if (s.bonds?.some(bond => bond.order === 1.5 || bond.order === 4 || bond.aromatic)) losses.push('GJF/COM的1.5连接表数值不能区分非芳香分数键与芳香键；重载按已有芳香兼容规则读取，请用Ester Studio模型格式完整保留语义。');
  if (s.bonds?.some(bond => bond.perception || bond.mbo !== undefined)) losses.push('GJF/COM不保留逐键识别来源与原始MBO数值。');
  if (s.atoms.some(atom => atom.formalCharge || atom.stereoParity !== undefined)) losses.push('Gaussian坐标不保存逐原子形式电荷或二维立体标签。');
  losses.push('结构GJF/COM不保存来源任务的科学设置；稳定ID、来源/删键历史及显示设置请用Ester Studio模型格式保存。');
  return { text, losses };
}

function gaussianExport(document: ModelDocument, context: SaveContext): { text: string; losses: string[] } {
  if (!context.jobRequest) throw new Error('保存GJF/COM需要当前Gaussian任务设置；请选择任务与确认电子态，不会猜测计算方法。');
  const request = clone(context.jobRequest), s = clone(document.draft.structure);
  const capability = inputLayerCapabilityError(s, document.draft.assignments.layers, { enabled: request.settings.oniom?.enabled ?? false, qmAtomIds: request.settings.oniom?.qmAtomIds ?? [],engine:'gaussian' });
  if (capability) throw new Error(capability);
  // A newly opened modeling window has not necessarily applied any structure to
  // the Gaussian form. Its immutable draft baseline still supplies the existing
  // stable-ID -> numeric-center bridge; scientific settings remain explicit.
  const original = request.structure ?? clone(document.draft.baseStructure);
  const integrated = integrateBuilderResult(original, {
    structure: s, assignments: clone(document.draft.assignments), baseAtomIds: original.atoms.map(a => a.id!), baseRevision: original.revision ?? 0,
    baseStructure: clone(original), removedIds: [], touchedIds: [], assignmentIssues: document.draft.assignmentIssues,
  }, request.settings);
  request.structure = integrated.structure; request.settings = integrated.settings;
  if (integrated.warnings.length) throw new Error(integrated.warnings.join('\n'));
  if ((request.files?.geometry ?? 'explicit') !== 'explicit') throw new Error('建模保存GJF/COM必须使用显式坐标；不能以CHK引用代替当前模型。');
  const options = request.settings.taskOptions ?? defaultTaskOptions();
  const numbers = new Map(s.atoms.map((atom, index) => [atom.id!, index + 1]));
  const number = (id: string): number => { const n = numbers.get(id); if (!n) throw new Error('冻结/分区定义含已删除原子。'); return n; };
  const losses: string[] = [];
  effectiveModelCoordinates(document); // Refuse cross-scope F/S conflicts before any task-specific filtering.
  if (document.internalCoordinates !== undefined) {
    if (document.internalCoordinates.some(c => c.action === 'scan') && request.settings.task !== 'scan') losses.push('当前任务不使用来源S扫描，S未转换为F冻结。');
    options.coordinates = document.internalCoordinates.filter(c => c.action !== 'scan' || request.settings.task === 'scan').map(c => ({ type: c.type, atoms: c.atomIds.map(number), action: c.action, steps: c.steps, increment: c.increment }));
    options.coordinateDrafts = undefined;
  }
  if (document.draft.assignments.frozenAtomIds.length || options.coordinates.some(c => c.action === 'freeze')) {
    if (!supportsConstraints(request.settings.task)) throw new Error('当前Gaussian任务不支持本页冻结输入，请选择支持冻结的任务或主动解除冻结。');
    options.constraintsEnabled = true;
  }
  options.frozenAtoms = document.draft.assignments.frozenAtomIds.map(number);
  if (request.settings.task === 'bsse') options.fragments = document.draft.assignments.fragments.map(fragment => {
    if (fragment.charge === undefined || fragment.multiplicity === undefined) throw new Error('片段电荷/多重度缺失，不能用默认值冒充已确认值。');
    return { atoms: fragment.atomIds.map(number), charge: fragment.charge, multiplicity: fragment.multiplicity };
  });
  else if (document.draft.assignments.fragments.length) losses.push('当前非Counterpoise任务，不写片段标签/片段电子态。');
  request.settings.taskOptions = options;
  if (document.draft.assignments.basis.length) request.settings.mixedBasis = {
    enabled: true, dForm: request.settings.mixedBasis?.dForm ?? '5D',
    regions: document.draft.assignments.basis.map(region => { if (!region.basis) throw new Error('基组区域缺少实际基组。'); return { id: region.id, name: region.label ?? region.id, basis: region.basis, atoms: region.atomIds.map(number) }; }),
  };
  const shared = applySharedGaussianConstraints(request.structure, request.settings, document.sharedConstraints);
  if (shared.errors.length) throw new Error(shared.errors.join('\n'));
  request.settings = shared.settings;
  let text = buildGaussian(request);
  if (s.bonds !== undefined) {
    if (s.bonds.some(b => b.kind === 'coordination' || b.image?.some(Boolean))) throw new Error('普通Gaussian连接表不表达配位语义/跨胞键，请先明确处理这些键。');
    const sections = text.trimEnd().split('\n\n');
    sections[0] = /\bgeom=modredundant\b/i.test(sections[0]) ? sections[0].replace(/\bgeom=modredundant\b/i, 'geom=(connectivity,modredundant)') : sections[0] + ' geom=connectivity';
    const connection = s.atoms.map((_atom, index) => [String(index + 1), ...s.bonds!.filter(b => Math.min(b.a, b.b) === index).flatMap(b => [String(Math.max(b.a, b.b) + 1), String(b.aromatic || b.order === 4 ? 1.5 : b.order)])].join(' ')).join('\n');
    sections.splice(3, 0, connection); text = sections.join('\n\n') + '\n\n\n';
  }
  if (document.draft.assignments.layers.length) losses.push('模型层分区仅供显示；本轮未生成ONIOM层/封端/MM参数。');
  if (s.cell) losses.push('GJF/COM显式有限分子坐标不保存晶胞；周期模型由既有Gaussian校验拒绝。');
  if (document.auxiliaryRelations.length) losses.push('0.5辅助虚线不写成Gaussian连接表化学键。');
  if (document.deletedBonds.length) losses.push('显式删键历史不保存；连接表只表示当前实际键。');
  if (document.attachmentPorts?.length) losses.push('GJF/COM不保留建模待接端口。');
  if (s.bonds?.some(bond => bond.perception || bond.mbo !== undefined)) losses.push('GJF/COM不保留逐键识别来源与原始MBO数值；请用Ester Studio模型格式保存这些信息。');
  if (s.bonds?.some(bond => bond.fractional && bond.order === 1.5)) losses.push('GJF/COM的1.5连接表数值不区分非芳香分数键与芳香键；重载按已有芳香兼容规则读取，请用Ester Studio模型格式完整保留语义。');
  if (s.atoms.some(atom => atom.formalCharge || atom.stereoParity !== undefined)) losses.push('Gaussian坐标不保存逐原子形式电荷或二维立体标签；总电子态沿已确认任务设置。');
  losses.push('GJF/COM保存原子顺序及可表达输入定义，重载重新分配稳定ID；独立二维草稿、手动氢策略与显示设置不保存。');
  return { text, losses };
}

function orcaExport(document: ModelDocument, context: SaveContext): { text: string; losses: string[] } {
  if (!context.orcaJobRequest) throw new Error('保存INP需要当前ORCA任务设置；不会把Gaussian任务转换为ORCA。');
  const request = clone(context.orcaJobRequest), structure = clone(document.draft.structure);
  const capability = inputLayerCapabilityError(structure, document.draft.assignments.layers, { enabled: request.settings.multiscale.mode !== 'none', qmAtomIds: request.settings.multiscale.qmAtomIds,engine:'orca' });
  if (capability) throw new Error(capability);
  // The realtime workbench has already projected this exact geometry into its
  // current task. Private unsubmitted drafts still use their immutable base.
  const original = clone(request.structure && builderMaterialSignature(request.structure)===builderMaterialSignature(structure)?request.structure:document.draft.baseStructure);
  const integrated = integrateOrcaBuilderResult(original, { structure, assignments: clone(document.draft.assignments),
    internalCoordinates: clone(document.internalCoordinates), baseAtomIds: original.atoms.map(atom => atom.id!), baseRevision: original.revision ?? 0,
    baseStructure: clone(original), removedIds: [], touchedIds: [], assignmentIssues: document.draft.assignmentIssues }, request.settings);
  if (integrated.warnings.length) throw new Error(integrated.warnings.join('\n'));
  // The UI supplies an explicitly confirmed one-save state against the draft.
  if(requiresElectronicStateConfirmation(structure,request))throw new Error('请重新确认当前ORCA模型的电荷和多重度。');
  const electrons = electronCount(structure.atoms, request.charge);
  if (!Number.isSafeInteger(request.charge) || !Number.isSafeInteger(request.multiplicity) || request.multiplicity < 1 || electrons < 0
    || request.multiplicity > electrons + 1 || (electrons - request.multiplicity + 1) % 2 !== 0) throw new Error('当前ORCA模型的电荷/多重度与电子数不匹配。');
  const mapped = invalidateOrcaRequestForModel(request, integrated); mapped.electronicStateConfirmed = true;
  mapped.structure!.charge = request.charge; mapped.structure!.multiplicity = request.multiplicity;
  const shared = applySharedOrcaConstraints(mapped.structure, mapped.settings, document.sharedConstraints);
  if (shared.errors.length) throw new Error(shared.errors.join('\n'));
  mapped.settings = shared.settings;
  const output = buildOrcaCommon(mapped), errors = output.issues.filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(errors.map(issue => issue.message).join('\n'));
  const actualDependency = mapped.settings.initialOrbitalsId || mapped.settings.ircHessianId
    || mapped.settings.multiscale.mode !== 'none' || mapped.settings.md.restartAssetId || mapped.settings.task === 'esd' || mapped.settings.task === 'neb';
  if (output.files.length !== 1 || output.files[0]?.role !== 'input' || actualDependency) throw new Error('当前ORCA任务需要完整文件组或外部依赖；请在ORCA输出页导出全部输入与依赖，通用模型保存不会只写第一份INP。');
  const losses = output.issues.filter(issue => issue.severity === 'warning').map(issue => issue.message);
  if (document.draft.assignments.basis.length) losses.push('ORCA使用任务页统一基组，模型基组区域不会变成混合基组。');
  if (document.auxiliaryRelations.length) losses.push('0.5辅助虚线不写成ORCA化学键。');
  if (document.attachmentPorts?.length) losses.push('INP不保留建模待接端口。');
  losses.push('INP保存当前三维坐标和任务定义；稳定ID、独立二维草稿、显示设置和手动氢策略不保存。');
  return { text: output.files[0].text, losses };
}

export async function exportModel(document: ModelDocument, format: ModelFormat, context: SaveContext, chemistry: ChemistryPort): Promise<{ text: string; losses: string[] }> {
  if ((format as string) === 'mol2') throw new Error('已移除MOL2导入与导出；请使用MOL或SDF。');
  const snapshot = clone(document), s = snapshot.draft.structure;
  validateFragment(modelFragment(snapshot));
  if (!formats.some(entry => entry.id === format)) throw new Error('不支持的模型保存格式。');
  if (format === 'sciyue') {
    const text = nativeJSON({ schema: NATIVE_SCHEMA, fragment: modelFragment(snapshot) })! + '\n';
    if (new TextEncoder().encode(text).length > 16 * 1024 * 1024) throw new Error('Ester Studio模型超出当前桌面保存16MiB范围。');
    parseNativeModel(text);
    return { text, losses: s.cell && context.withCell === false ? ['Ester Studio模型格式始终完整保存晶胞；“不含晶胞”仅适用于结构导出格式。'] : [] };
  }
  if(s.periodicSource&&!['sdf','xyz','extxyz','cif'].includes(format))throw new Error('该格式不能保留来源部分Tv平移信息；请选择Ester Studio模型或支持周期来源元数据的SDF/XYZ/extXYZ/CIF，未改写为有限分子。');
  if(s.bonds?.some(bond=>bond.fractional===true)&&['mol','sdf','pdb'].includes(format))throw new Error('该格式的当前原生写出器不能无损表达非芳香0.5/1.5分数键；请使用Ester Studio模型格式完整保存。');
  const withCell = context.withCell !== false;
  const cellLoss = s.cell && !withCell ? ['已明确选择无盒保存；真实晶胞向量、原点与周期边界不写入此文件。'] : [];
  if (format === 'inp') {
    if (context.purpose === 'structure') throw new Error('建模区仅保存结构；完整ORCA计算输入请在输入模块导出。');
    if (!withCell) delete s.cell;
    const output = orcaExport(snapshot, context); return { text: output.text, losses: [...cellLoss, ...output.losses] };
  }
  if (format === 'gjf' || format === 'com') {
    if (!withCell) delete s.cell;
    const output = context.purpose === 'structure' ? gaussianStructureExport(snapshot) : gaussianExport(snapshot, context);
    return { text: output.text, losses: [...cellLoss, ...output.losses] };
  }
  const losses = metadataLosses(snapshot, format);
  if (format === 'xyz' || format === 'extxyz' || format === 'cif' || format === 'poscar') return { text: exportStructure(s, format, withCell), losses: [...cellLoss, ...losses] };
  if (!withCell) {
    if (s.bonds?.some(bond => bond.image?.some(Boolean))) throw new Error('无盒分子文件不能保留跨胞键映像；请保留晶胞导出SDF/extXYZ/CIF/POSCAR，或明确重建有限模型。');
    delete s.cell;
  }
  const capabilities = await chemistry.capabilities();
  if (!capabilities.native || !capabilities.operations.includes('convert')) throw new Error('该格式需要可用的本机原生格式转换器。');
  const stamp = makeDocumentStamp(snapshot, []), result = await chemistry.start({ operation: 'convert', stamp, structure: s, movableAtomIds: [], format }).promise;
  if (result.operation !== 'convert' || result.format !== format || JSON.stringify(result.stamp) !== JSON.stringify(stamp) || !result.text?.trim()) throw new Error('原生转换响应身份/格式不匹配或没有文本。');
  if (result.structure.atoms.length !== s.atoms.length || result.structure.atoms.some((atom, index) => atom.id !== s.atoms[index].id || atom.element !== s.atoms[index].element)) throw new Error('原生转换改变了显式原子身份或顺序。');
  let text = result.text.replace(/\r\n?/g, '\n');
  if (format === 'sdf') {
    const parsed = parseStructures(text, 'converted.sdf');
    if (parsed.length !== 1 || parsed[0].atoms.length !== s.atoms.length || parsed[0].atoms.some((atom, i) => atom.element !== s.atoms[i].element || Math.hypot(atom.x - s.atoms[i].x, atom.y - s.atoms[i].y, atom.z - s.atoms[i].z) > 0.002)) throw new Error('SDF写出连接表改变了原子顺序/坐标，拒绝附加身份元数据。');
    assertSdfChemicalAgreement(parsed[0], s.atoms, s.bonds);
    const meta: SdfMetadata = { version: 1, connectionTable: sdfConnectionSignature(parsed[0], text), atoms: s.atoms.map(({ x: _x, y: _y, z: _z, ...props }) => props),
      structure: { name: s.name, charge: s.charge, multiplicity: s.multiplicity, cell: s.cell, periodicSource:s.periodicSource,periodicWorkingSource:s.periodicWorkingSource,libraryProvenance:s.libraryProvenance,groups: s.groups, modelLayers: s.modelLayers, layout2D: s.layout2D, dimension: s.dimension, gaussianSource: s.gaussianSource, gaussianSources: s.gaussianSources, orcaSource: s.orcaSource, sourceAtomIds: s.sourceAtomIds, sourceRoute: s.sourceRoute, mapping: s.mapping, bondPerceptionIssues: s.bondPerceptionIssues, bondSource:s.bondSource },
      bonds: s.bonds, assignments: snapshot.draft.assignments, auxiliaryRelations: snapshot.auxiliaryRelations, deletedBonds: snapshot.deletedBonds, internalCoordinates: snapshot.internalCoordinates, sharedConstraints:snapshot.sharedConstraints, coordinateObjects:snapshot.coordinateObjects,gaussianBoundCoordinates:snapshot.gaussianBoundCoordinates,attachmentPorts:snapshot.attachmentPorts };
    text = text.replace(/^\$\$\$\$\s*$/m, '').trimEnd() + `\n\n>  <${SDF_FIELD}>\n${JSON.stringify(meta)}\n\n$$$$\n`;
  }
  return { text, losses: [...cellLoss, ...losses, ...result.warnings] };
}
