import type { Atom, Bond, Structure, TwoDStereoSource, Vector3 } from '../../core/types';
import { builderDoubleBondConfiguration } from '../../core/builder-stereo';
import { prepare2DHydrogens } from '../../core/modeling/hydrogen-policy';
import { superposeViewAtoms } from '../view-superposition';
import type { ChemistryPort, ChemistryResult, FragmentSnapshot } from '../contracts';
import { componentSourceStereo, componentToStructure, twoDFormalCharge, type TwoDComponent, type TwoDDraft, type TwoDIssue } from '../two-d';
import { generateTwoDFragment } from './two-d-import';

export interface TwoDAssemblyFragment {
  id: string;
  label: string;
  structure: Structure | null;
  sourceStereo?: TwoDStereoSource;
  issues: TwoDIssue[];
  error?: string;
  /** Independent of translation/rotation of the diagram, but not chemistry. */
  chemistryKey: string;
  anchorIds: string[];
  center: { x: number; y: number };
}
export interface TwoDAssemblyInput {
  sourceId: string;
  key: string;
  name: string;
  fragments: TwoDAssemblyFragment[];
  issues: TwoDIssue[];
  finalGraph: Pick<Structure, 'atoms' | 'bonds' | 'layout2D' | 'charge'>;
  selectedComponentIds: string[];
}
export interface TwoDAssemblyFailure { id: string; label: string; message: string }
export interface TwoDAssemblyResult {
  engine: string;
  engineVersion: string;
  warnings: string[];
  /** Keep each real receipt; never invent a combined native job/stamp. */
  componentResults: { id: string; result: ChemistryResult }[];
}
export interface TwoDAssemblyComplete {
  fragment: FragmentSnapshot;
  result: TwoDAssemblyResult;
  layoutScale: number;
  components: { id: string; label: string; atomIds: string[] }[];
}
export interface TwoDAssemblyState {
  inputKey: string | null;
  displayedInputKey: string | null;
  status: 'idle' | 'updating' | 'ready' | 'partial';
  completed: number;
  total: number;
  preview: FragmentSnapshot | null;
  complete: TwoDAssemblyComplete | null;
  failures: TwoDAssemblyFailure[];
}
type Generated = Awaited<ReturnType<typeof generateTwoDFragment>>;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : 0;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

/** The cache includes explicit tetrahedral, E/Z, ring-wedge and hydrogen
 * intent. Raw diagram XY would regenerate unchanged molecules on every move. */
export function twoDFragmentChemistryKey(structure: Structure, sourceStereo?: TwoDStereoSource): string {
  const atoms = structure.atoms;
  return JSON.stringify({
    atoms: atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0, atom.hydrogenMode ?? null, atom.aromaticHydrogen ?? null, atom.stereoParity ?? null]),
    bonds: (structure.bonds ?? []).map(bond => [atoms[bond.a].id, atoms[bond.b].id, bond.order, bond.aromatic ?? false, bond.stereo ?? 0,
      bond.order === 2 ? builderDoubleBondConfiguration(structure, atoms[bond.a].id!, atoms[bond.b].id!) : null]),
    source: sourceStereo && { atoms: sourceStereo.atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0, atom.hydrogenCount ?? null]),
      bonds: sourceStereo.bonds.map(bond => [bond.a, bond.b, bond.order, bond.stereo ?? 0]), stereoGroups: sourceStereo.stereoGroups, shape: normalizedDiagramShape(sourceStereo) },
    charge: structure.charge, multiplicity: structure.multiplicity,
  });
}
function normalizedDiagramShape(source: TwoDStereoSource) {
  const origin = source.atoms[0]; if (!origin) return [];
  const axis = source.atoms.find(atom => atom.x !== origin.x || atom.y !== origin.y);
  if (!axis) return source.atoms.map(() => [0, 0]);
  const dx = axis.x - origin.x, dy = axis.y - origin.y, norm = dx * dx + dy * dy;
  // The tolerance suppresses arithmetic noise from a rigid canvas gesture;
  // the full diagram still owns placement and every native request.
  const stable = (value: number) => Math.abs(value) < 1e-10 ? 0 : Number(value.toPrecision(11));
  return source.atoms.map(atom => { const x = atom.x - origin.x, y = atom.y - origin.y;
    return [stable((x * dx + y * dy) / norm), stable((y * dx - x * dy) / norm)]; });
}

function stageHydrogens(structure: Structure): Structure {
  const staged = prepare2DHydrogens(structuredClone(structure)), occupied = new Set(structure.atoms.map(atom => atom.id!));
  const perParent = new Map<string, number>(), replacements = new Map<string, string>();
  for (const [oldId, parentId] of Object.entries(staged.createdFrom)) {
    let index = perParent.get(parentId) ?? 0, id: string;
    do { id = `2d-added-h:${parentId}:${index++}`; } while (occupied.has(id));
    perParent.set(parentId, index); occupied.add(id); replacements.set(oldId, id);
  }
  staged.structure.atoms = staged.structure.atoms.map(atom => ({ ...atom, ...(replacements.has(atom.id!) ? { id: replacements.get(atom.id!)! } : {}) }));
  if (staged.structure.layout2D) staged.structure.layout2D = Object.fromEntries(Object.entries(staged.structure.layout2D).map(([id, xy]) => [replacements.get(id) ?? id, xy]));
  staged.structure.sourceAtomIds = staged.structure.atoms.map(atom => atom.id!);
  return staged.structure;
}

/** Prepare every connected component. A local invalid component remains an
 * explicit failure, while valid neighbours can still produce a preview. */
export function prepareTwoDAssembly(draft: TwoDDraft, options: {
  name?: string;
  sourceIssues?(component: TwoDComponent): TwoDIssue[];
} = {}): TwoDAssemblyInput {
  const fragments: TwoDAssemblyFragment[] = [], atoms: Atom[] = [], bonds: Bond[] = [], layout2D: NonNullable<Structure['layout2D']> = {};
  const allIssues: TwoDIssue[] = [...structuredClone(draft.issues)];
  const seenIds = new Set<string>();
  for (const component of draft.components) {
    const issues = [...structuredClone(component.issues), ...structuredClone(options.sourceIssues?.(component) ?? [])];
    let structure: Structure | null = null, sourceStereo: TwoDStereoSource | undefined, error: string | undefined;
    try {
      structure = componentToStructure({ ...component, issues }, { name: options.name ?? draft.source.name ?? 'drawing' });
      sourceStereo = componentSourceStereo(component);
      structure = stageHydrogens(structure);
    } catch (cause) { structure = null; error = errorMessage(cause); }
    // This graph is provenance, including invalid components which must not be
    // silently omitted when the user eventually commits all components.
    const offset = atoms.length;
    const componentAtoms: Atom[] = structure?.atoms ?? component.atoms.map(({ sourceAtomKey: _key, sourceProperties: _properties, implicitHydrogens: _implicit, ...atom }) => atom);
    for (const atom of componentAtoms) {
      if (!atom.id || seenIds.has(atom.id)) throw new Error('二维组分缺少原子身份或含重复原子身份，无法合并。');
      seenIds.add(atom.id); atoms.push(structuredClone(atom)); layout2D[atom.id] = { x: atom.x, y: atom.y };
    }
    bonds.push(...(structure?.bonds ?? component.bonds).map(bond => ({ ...structuredClone(bond), a: bond.a + offset, b: bond.b + offset })));
    allIssues.push(...issues);
    const originalIds = new Set(sourceStereo?.atoms.map(atom => atom.id) ?? component.atoms.filter(atom => !atom.sourceProperties.generatedFromImplicitH).map(atom => atom.id));
    const originalAtoms = component.atoms.filter(atom => originalIds.has(atom.id));
    const heavy = originalAtoms.filter(atom => atom.element !== 'H');
    const anchors = heavy.length >= 2 ? heavy : originalAtoms;
    const centerAtoms = heavy.length ? heavy : originalAtoms;
    fragments.push({ id: component.id, label: component.label, structure, sourceStereo, issues, ...(error ? { error } : {}),
      chemistryKey: structure ? twoDFragmentChemistryKey(structure, sourceStereo) : JSON.stringify(['invalid', component.id, error]),
      anchorIds: anchors.map(atom => atom.id), center: { x: mean(centerAtoms.map(atom => atom.x)), y: mean(centerAtoms.map(atom => atom.y)) } });
  }
  const name = options.name ?? draft.source.name ?? 'drawing';
  const input: TwoDAssemblyInput = { sourceId: draft.source.id, key: '', name, fragments, issues: allIssues,
    finalGraph: { atoms, bonds, layout2D, charge: twoDFormalCharge(atoms) }, selectedComponentIds: fragments.map(fragment => fragment.id) };
  input.key = JSON.stringify([input.sourceId, name, fragments.map(fragment => [fragment.id, fragment.chemistryKey, fragment.error ?? null,
    fragment.structure?.atoms.map(atom => [atom.id, atom.x, atom.y, atom.z]) ?? componentPositions(draft, fragment.id)])]);
  return input;
}
function componentPositions(draft: TwoDDraft, id: string) { return draft.components.find(component => component.id === id)?.atoms.map(atom => [atom.id, atom.x, atom.y, atom.z]); }

/** Determine one drawing-unit -> angstrom placement scale from actual native
 * bond lengths. This moves component centres only; no generated molecule is
 * stretched. An entirely bondless diagram has no intrinsic length standard. */
function assemblyLayoutScale(input: TwoDAssemblyInput, generated: Map<string, Generated>): number {
  const ratios: number[] = [];
  for (const part of input.fragments) {
    const ready = generated.get(part.id), source = part.structure;
    if (!ready || !source) continue;
    const originalIds = new Set(part.sourceStereo?.atoms.map(atom => atom.id) ?? part.anchorIds);
    const actual = new Map(ready.fragment.structure.atoms.map(atom => [atom.id!, atom]));
    for (const bond of source.bonds ?? []) {
      const a = source.atoms[bond.a], b = source.atoms[bond.b], ga = actual.get(a.id!), gb = actual.get(b.id!);
      if (!originalIds.has(a.id!) || !originalIds.has(b.id!) || !ga || !gb) continue;
      const drawnLength = Math.hypot(a.x - b.x, a.y - b.y), nativeLength = Math.hypot(ga.x - gb.x, ga.y - gb.y, ga.z - gb.z);
      if (drawnLength > 0 && nativeLength > 0 && Number.isFinite(drawnLength) && Number.isFinite(nativeLength)) ratios.push(nativeLength / drawnLength);
    }
  }
  return ratios.length ? median(ratios) : 1;
}
const rotate = (matrix: [Vector3, Vector3, Vector3], atom: Atom): Vector3 => matrix.map(row => row[0] * atom.x + row[1] * atom.y + row[2] * atom.z) as Vector3;

/** Compose copied native coordinates with proper rigid transformations only.
 * Existing 2D and Cartesian coordinates use Y-up; the renderer handles screen
 * Y-down. Negating diagram Y here would invert the requested layout. */
export function composeTwoDAssembly(input: TwoDAssemblyInput, generated: ReadonlyMap<string, Generated>): TwoDAssemblyComplete | null {
  const available = input.fragments.filter(part => part.structure && generated.has(part.id));
  if (!available.length) return null;
  const ready = new Map(generated), layoutScale = assemblyLayoutScale(input, ready);
  const globalCenter = { x: mean(input.fragments.map(part => part.center.x)), y: mean(input.fragments.map(part => part.center.y)) };
  const atoms: Atom[] = [], bonds: Bond[] = [], layout2D: NonNullable<Structure['layout2D']> = {}, components: TwoDAssemblyComplete['components'] = [], results: TwoDAssemblyResult['componentResults'] = [];
  for (const part of available) {
    const source = part.structure!, result = generated.get(part.id)!, native = result.fragment.structure;
    const nativeMap = new Map(native.atoms.map(atom => [atom.id!, atom])), sourceMap = new Map(source.atoms.map(atom => [atom.id!, atom]));
    // Confirm exact identity, graph and electronic state independently of the
    // orientation fit. A fit must never "repair" a changed molecule.
    if (native.atoms.some(atom => !atom.id || ![atom.x, atom.y, atom.z].every(Number.isFinite)) || new Set(native.atoms.map(atom => atom.id)).size !== native.atoms.length)
      throw new Error(`${part.label} 的三维原子身份或坐标无效。`);
    if (native.atoms.length !== source.atoms.length || native.atoms.some((atom, index) => atom.id !== source.atoms[index].id)) throw new Error(`${part.label} 的三维结果改变了原子数或顺序。`);
    for (const atom of source.atoms) { const other = nativeMap.get(atom.id!); if (!other || atom.element !== other.element || (atom.formalCharge ?? 0) !== (other.formalCharge ?? 0)) throw new Error(`${part.label} 的三维结果改变了源原子。`); }
    // Store.acceptCoordinates regenerates display wedges against the accepted
    // 3D orientation. A wedge can move to another bond or reverse its stored
    // endpoints without changing chemistry. Native sourceStereo validation
    // already established stereochemistry; compare chemical edges here, not
    // their 2D depiction or array serialization order.
    const graph = (structure: Structure) => JSON.stringify((structure.bonds ?? []).map(bond => {
      const endpoints = [structure.atoms[bond.a]?.id, structure.atoms[bond.b]?.id];
      if (endpoints.some(id => !id)) throw new Error(`${part.label} 的三维化学键端点无效。`);
      endpoints.sort(); const aromatic = Boolean(bond.aromatic) || bond.order === 1.5;
      return JSON.stringify([endpoints, aromatic ? 1.5 : bond.order, aromatic, bond.kind ?? 'covalent']);
    }).sort());
    if (graph(native) !== graph(source)) throw new Error(`${part.label} 的三维结果改变了化学连接或键型。`);
    if (native.charge !== source.charge || native.multiplicity !== source.multiplicity || twoDFormalCharge(native.atoms) !== source.charge) throw new Error(`${part.label} 的三维结果改变了形式电荷或电子态。`);
    const moving = part.anchorIds.map(id => nativeMap.get(id)!), reference = part.anchorIds.map(id => sourceMap.get(id)!);
    if (moving.some(atom => !atom) || reference.some(atom => !atom) || !moving.length) throw new Error(`${part.label} 缺少二维与三维原子对应。`);
    const fit = superposeViewAtoms({ movingAtoms: moving, referenceAtoms: reference.map(atom => ({ ...atom, x: (atom.x - part.center.x) * layoutScale, y: (atom.y - part.center.y) * layoutScale, z: 0 })), mappingConfirmed: true });
    if (!fit.ok) throw new Error(`${part.label} 无法保持原图方向：${fit.issues.map(issue => issue.message).join('；')}`);
    // Keep the requested centroid exact even when only one H-free anchor exists.
    const centerIds = (part.sourceStereo?.atoms ?? []).filter(atom => atom.element !== 'H').map(atom => atom.id);
    const actualCenterAtoms = (centerIds.length ? centerIds : part.anchorIds).map(id => nativeMap.get(id)!);
    const rotatedCenter: Vector3 = [0, 1, 2].map(axis => mean(actualCenterAtoms.map(atom => rotate(fit.transform.rotation, atom)[axis]))) as Vector3;
    const desiredCenter: Vector3 = [(part.center.x - globalCenter.x) * layoutScale, (part.center.y - globalCenter.y) * layoutScale, 0];
    const offset = atoms.length;
    atoms.push(...native.atoms.map(atom => { const p = rotate(fit.transform.rotation, atom); return { ...structuredClone(atom), x: p[0] - rotatedCenter[0] + desiredCenter[0], y: p[1] - rotatedCenter[1] + desiredCenter[1], z: p[2] - rotatedCenter[2] }; }));
    bonds.push(...(native.bonds ?? []).map(bond => ({ ...structuredClone(bond), a: bond.a + offset, b: bond.b + offset })));
    for (const [id, xy] of Object.entries(source.layout2D ?? {})) layout2D[id] = { ...xy };
    components.push({ id: part.id, label: part.label, atomIds: native.atoms.map(atom => atom.id!) });
    results.push({ id: part.id, result: result.result });
  }
  const versions = new Map(results.map(({ result }) => [`${result.engine}\0${result.engineVersion}`, result]));
  const first = results[0].result;
  const warnings = [...new Set(results.flatMap(({ result }) => result.warnings))];
  const structure: Structure = { id: `two-d-assembly:${input.sourceId}`, name: input.name, format: 'builder', dimension: 3, atoms, bonds,
    charge: twoDFormalCharge(atoms), multiplicity: null, sourceAtomIds: atoms.map(atom => atom.id!), bondSource: 'drawn', layout2D,
    preparation: { status: 'ETKDGv3 初始三维结构' }, notes: ['二维各片段独立生成三维构型；按原图相对位置进行刚性摆放，片段间未添加化学键。',
      ...new Set(input.issues.filter(issue=>issue.code==='relative-stereo-representative').map(issue=>issue.message))] };
  return { fragment: { structure, assignments: { layers: [], basis: [], fragments: [], frozenAtomIds: [] }, auxiliaryRelations: [], deletedBonds: [] }, layoutScale, components,
    result: { engine: versions.size === 1 ? first.engine : [...new Set(results.map(item => item.result.engine))].join(' / '),
      engineVersion: versions.size === 1 ? first.engineVersion : [...new Set(results.map(item => item.result.engineVersion))].join(' / '), warnings, componentResults: results } };
}

export interface TwoDAssemblyGenerator {
  update(input: TwoDAssemblyInput, options?: { retryFailed?: boolean }): Promise<TwoDAssemblyState>;
  getState(): TwoDAssemblyState;
  cancel(): void;
  dispose(): void;
}

/** One queue per visible 2D session. Native work is sequential, cancellation
 * settles before newer work starts, and only the latest requested key can
 * publish. Successful chemistry stays cached until the session is disposed. */
export function createTwoDAssemblyGenerator(options: { port: ChemistryPort; onState?(state: TwoDAssemblyState): void }): TwoDAssemblyGenerator {
  let state: TwoDAssemblyState = { inputKey: null, displayedInputKey: null, status: 'idle', completed: 0, total: 0, preview: null, complete: null, failures: [] };
  const cache = new Map<string, Generated>();
  let generation = 0, disposed = false, active: AbortController | null = null, tail: Promise<unknown> = Promise.resolve(), pending: { key: string; promise: Promise<TwoDAssemblyState> } | null = null;
  const publish = (next: TwoDAssemblyState) => { state = next; options.onState?.(next); return next; };
  const cancel = () => { generation++; active?.abort(); active = null; pending = null; if (!disposed) publish({ ...state, status: 'idle', complete: null }); };
  return {
    getState: () => state,
    cancel,
    dispose() { if (disposed) return; cancel(); disposed = true; cache.clear(); state = { inputKey: null, displayedInputKey: null, status: 'idle', completed: 0, total: 0, preview: null, complete: null, failures: [] }; },
    update(input, updateOptions = {}) {
      if (disposed) return Promise.reject(new Error('二维三维预览会话已关闭。'));
      if (pending?.key === input.key) return pending.promise;
      if (state.inputKey === input.key && ['ready', 'partial'].includes(state.status) && !updateOptions.retryFailed) return Promise.resolve(state);
      active?.abort(); const own = ++generation, captured = structuredClone(input), controller = new AbortController(); active = controller;
      publish({ ...state, inputKey: input.key, status: 'updating', completed: 0, total: input.fragments.length, complete: null, failures: [] });
      const current = () => !disposed && generation === own && !controller.signal.aborted;
      const promise = tail.catch(() => {}).then(async () => {
        if (!current()) return state;
        const generated = new Map<string, Generated>(), failures: TwoDAssemblyFailure[] = [];
        for (const [index, part] of captured.fragments.entries()) {
          if (!current()) return state;
          if (!part.structure || part.error) failures.push({ id: part.id, label: part.label, message: part.error ?? '当前片段不能生成明确三维结构。' });
          else {
            try {
              let ready = cache.get(part.chemistryKey);
              if (!ready) {
                ready = await generateTwoDFragment(part.structure, { port: options.port, sourceStereo: part.sourceStereo, signal: controller.signal,
                  guard() { if (!current()) throw new Error('二维图已经变化，旧的三维结果不再采用。'); } });
                if (!current()) return state;
                cache.set(part.chemistryKey, ready);
              }
              generated.set(part.id, ready);
            } catch (cause) { if (!current()) return state; failures.push({ id: part.id, label: part.label, message: errorMessage(cause) }); }
          }
          if (current()) publish({ ...state, completed: index + 1, failures: [...failures] });
        }
        if (!current()) return state;
        let assembled: TwoDAssemblyComplete | null = null;
        try { assembled = composeTwoDAssembly(captured, generated); }
        catch (cause) { failures.push({ id: 'assembly', label: '整体结构', message: errorMessage(cause) }); }
        const complete = assembled && !failures.length && generated.size === captured.fragments.length ? assembled : null;
        return publish({ inputKey: captured.key, displayedInputKey: assembled ? captured.key : null, status: complete ? 'ready' : 'partial',
          completed: captured.fragments.length, total: captured.fragments.length, preview: assembled?.fragment ?? null, complete, failures });
      }).finally(() => { if (generation === own) { active = null; pending = null; } });
      pending = { key: input.key, promise }; tail = promise; return promise;
    },
  };
}
