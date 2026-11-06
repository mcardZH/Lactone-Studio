import { ELEMENTS } from '../../core/elements';
import { builderDoubleBondConfiguration, requestedBuilder2DParity } from '../../core/builder-stereo';
import { builderCovalentValence, builderDefaultValence, validateBuilderValence } from '../../core/builder-geometry';
import type { Structure, Bond } from '../../core/types';
import type { ParseKetDraftOptions, ParseTwoDOptions, RemainingTwoDSourceIssuesInput, TwoDAtom, TwoDComponent, TwoDConversionAssessment, TwoDDraft, TwoDFormat, TwoDIssue, TwoDSourceInput } from './types';
import { auditSourceFacts, readCdxmlFacts, readCdxFacts, TWO_D_SOURCE_LOCAL_CODES } from './source-audit';
export type * from './types';
export { readCdxFacts, readCdxmlFacts } from './source-audit';

type Obj = Record<string, any>;
const object = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const blocked = (code: string, message: string, atomIds?: string[]): TwoDIssue => ({ code, message, severity: 'blocking', ...(atomIds ? { atomIds } : {}) });
const warning = (code: string, message: string): TwoDIssue => ({ code, message, severity: 'warning' });
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('二维读取已取消。', 'AbortError'); };
const atomId = (sourceId: string, key: string) => `2d:${encodeURIComponent(sourceId)}:${encodeURIComponent(key)}`;
const asText = (input: string | Uint8Array) => typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);

/** Content is authoritative. A renamed image or arbitrary JSON is not a chemical drawing. */
export function detectTwoDFormat(input: string | Uint8Array): TwoDFormat | null {
  if (input instanceof Uint8Array && input.length >= 8 && new TextDecoder().decode(input.subarray(0, 8)) === 'VjCD0100') return 'cdx';
  let text: string; try { text = asText(input).replace(/^\uFEFF/, ''); } catch { return null; }
  if (/^\s*VjCD0100/.test(text)) return 'cdx';
  if (/<CDXML(?:\s|>)/i.test(text) && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE[\s\S]*?>\s*)?<CDXML(?:\s|>)/i.test(text)) return 'cdxml';
  if (/^.{0,80}V(?:2000|3000)\s*$/m.test(text) && /(?:^|\n)M  END(?:\r?\n|$)/.test(text)) return 'mol';
  if (/^\s*\{/.test(text)) { try { const value = JSON.parse(text); if (object(value.root) && Array.isArray(value.root.nodes)) return 'ket'; } catch { /* invalid input */ } }
  return null;
}

function makeStructure(component: TwoDComponent, identity: { id?: string; name?: string } = {}): Structure {
  const atoms = component.atoms.map(({ sourceAtomKey: _key, sourceProperties: _props, implicitHydrogens: _hydrogens, ...atom }) => ({ ...atom }));
  const layout2D = Object.fromEntries(atoms.map(atom => [atom.id!, { x: atom.x, y: atom.y }]));
  return { id: identity.id ?? component.id, name: identity.name ?? component.label, format: 'builder', atoms,
    bonds: component.bonds.map(bond => ({ ...bond })), dimension: 2, charge: null, multiplicity: null,
    sourceAtomIds: atoms.map(atom => atom.id!), layout2D, bondSource: 'drawn', notes: ['二维图生成请求；逐原子形式电荷不代表已确认总电荷与自旋。'] };
}

export function selectTwoDComponent(draft: TwoDDraft, id: string): TwoDComponent {
  const selected = draft.components.find(component => component.id === id);
  if (!selected) throw new Error('请选择本次二维草稿中的一个完整结构。');
  return selected;
}

/** No unrepresentable field can cross into the public Atom/Bond model. */
export function assessTwoDConversion(component: TwoDComponent): TwoDConversionAssessment {
  const issues = [...component.issues];
  if (!component.atoms.length) issues.push(blocked('empty-component', '所选结构没有可生成三维的原子。'));
  const seen = new Set<string>();
  component.atoms.forEach(atom => {
    if (!ELEMENTS.includes(atom.element)) issues.push(blocked('unknown-element', `未具体化的原子标签 ${atom.element}。`, [atom.id]));
    if (seen.has(atom.id)) issues.push(blocked('duplicate-identity', '二维图包含重复原子身份。', [atom.id])); seen.add(atom.id);
    if (![atom.x, atom.y, atom.z].every(number) || atom.formalCharge !== undefined && !Number.isSafeInteger(atom.formalCharge)) issues.push(blocked('invalid-atom', '原子坐标或形式电荷无效。', [atom.id]));
  });
  const edges = new Set<string>();
  component.bonds.forEach(bond => {
    if (![bond.a, bond.b].every(i => Number.isSafeInteger(i) && i >= 0 && i < component.atoms.length) || bond.a === bond.b) issues.push(blocked('invalid-bond', '化学键端点无效。'));
    const key = [bond.a, bond.b].sort((a, b) => a-b).join(':'); if (edges.has(key)) issues.push(blocked('duplicate-bond', '同一对原子存在重复化学键。')); edges.add(key);
    if (![1, 2, 3, 1.5].includes(bond.order) || bond.kind === 'coordination' || bond.orderKnown === false) issues.push(blocked('unsupported-bond', '查询键、配位键或未确定键级不能生成明确三维。'));
    if (bond.stereo !== undefined && ![0, 1, 6].includes(bond.stereo)) issues.push(blocked('unspecified-stereo', '波浪键或未确定双键构型需要先明确。'));
    if (bond.stereo && bond.order !== 1) issues.push(blocked('invalid-stereo-bond', '楔线仅支持确定的单键。'));
  });
  if(!issues.some(issue=>issue.severity==='blocking')){
    try{validateBuilderValence(makeStructure(component));}catch(error){issues.push(blocked('invalid-valence',error instanceof Error?error.message:'二维原子价态无效。'));}
  }
  return { allowed: !issues.some(issue => issue.severity === 'blocking'), issues };
}

export function componentToStructure(component: TwoDComponent, identity: { id?: string; name?: string } = {}): Structure {
  const result = assessTwoDConversion(component);
  if (!result.allowed) throw new Error(result.issues.filter(issue => issue.severity === 'blocking').map(issue => issue.message).join('\n'));
  return makeStructure(component, identity);
}

/** Source loss cannot be repaired by an arbitrary edit. A representational
 * limitation can be resolved only after that same kind survived the first
 * editor roundtrip and then disappeared from an explicitly edited target. */
export function remainingTwoDSourceIssues({sourceDraft,editorBaselineDraft,currentComponent,edited}:RemainingTwoDSourceIssuesInput):TwoDIssue[]{
  if(!sourceDraft)return [];
  const sourceComponents=sourceDraft.components.filter(component=>component.sourceNodeKey===currentComponent.sourceNodeKey);
  const originalComponent=sourceComponents.length===1?sourceComponents[0]:undefined;
  const baselineComponents=editorBaselineDraft?.components.filter(component=>component.sourceNodeKey===currentComponent.sourceNodeKey)??[];
  const baseline=baselineComponents.length===1?baselineComponents[0]:undefined;
  const sourceIds=new Set(sourceComponents.map(component=>component.id));
  const originals=[...sourceDraft.issues,...sourceDraft.components.flatMap(component=>component.issues)].filter(value=>value.code.startsWith('source-'));
  const unique=new Map<string,TwoDIssue>();
  for(const original of originals){
    const ids=original.componentIds??[];
    // A uniquely identified different source node is independent. Unknown or
    // ambiguous correspondence stays guarded rather than relying on row order.
    if(original.scope==='component'&&sourceComponents.length&&ids.length&&!ids.some(id=>sourceIds.has(id)))continue;
    const key=JSON.stringify([original.code,original.severity,original.scope,original.sourceFragmentKey,ids,original.atomIds,original.message]);
    if(!unique.has(key))unique.set(key,original);
  }
  const currentCodes=new Set(assessTwoDConversion(currentComponent).issues.map(value=>value.code));
  const baselineCodes=baseline?new Set(assessTwoDConversion(baseline).issues.map(value=>value.code)):new Set<string>();
  return [...unique.values()].map(original=>{
    const codes=TWO_D_SOURCE_LOCAL_CODES[original.code];
    const located=original.scope==='component'&&originalComponent&&original.componentIds?.includes(originalComponent.id);
    const resolved=edited&&original.severity==='blocking'&&located&&baseline&&codes?.some(code=>baselineCodes.has(code))&&!codes.some(code=>currentCodes.has(code));
    if(!resolved)return structuredClone(original);
    return {...structuredClone(original),severity:'warning',
      message:`${original.message}（用户已在二维编辑器修改，当前目标已不含该限制；原始来源问题保留。）`,
      resolution:{kind:'explicit-editor-change',originalSeverity:'blocking',originalMessage:original.message,baselineComponentId:baseline.id,currentComponentId:currentComponent.id}};
  });
}

function atomIssues(raw: Obj, atom: TwoDAtom, issues: TwoDIssue[]) {
  const fail = (code: string, text: string) => issues.push(blocked(code, text, [atom.id]));
  if (raw.isotope || ['D', 'T'].includes(raw.label)) fail('isotope', '当前三维模型不支持同位素质量数；原标签保留在二维草稿。');
  if (raw.radical) fail('radical', '当前三维模型不支持自由基标记；请保留二维草稿。');
  if (raw.type && !['atom'].includes(raw.type) || raw.queryProperties || raw.atomList || raw.rglabel) fail('query-atom', 'R基、原子列表和查询原子尚未具体化。');
  if (raw.attachmentPoints || raw.attachmentOrder || raw.attpnt) fail('attachment', '可变连接点尚未具体化。');
  if (raw.explicitValence !== undefined && raw.explicitValence !== -1) fail('explicit-valence', '显式价态约束尚不能由当前三维公共模型完整表达。');
  if (raw.stereoLabel && raw.stereoLabel !== 'abs') fail('enhanced-stereo', '相对或增强立体组尚不能由当前三维模型表达。');
  if (raw.stereoParity !== undefined || raw.stereo !== undefined) fail('unsupported-atom-stereo', '未知原子立体字段不能直接当作ES有序邻居手性。');
  if (raw.alias) fail('unexpanded-alias', '原子别名尚未核实展开映射；请先在二维编辑器明确结构。');
  if (['ringBondCount','substitutionCount','hCount','unsaturatedAtom'].some(key => raw[key] !== undefined)) fail('query-atom-constraint','查询原子的环、取代或氢计数约束尚未具体化。');
}

function splitNode(node: Obj, nodeKey: string, sourceId: string, offset: number, document:Obj): TwoDComponent[] {
  if (!Array.isArray(node.atoms) || node.bonds !== undefined && !Array.isArray(node.bonds)) throw new Error('KET分子缺少原子列表或化学键列表无效。');
  // Ketcher 3.18 moleculeToKet omits bonds when struct.bonds.size is zero.
  // Missing atoms or an explicitly invalid bonds member remain malformed input.
  const sourceBonds:unknown[]=node.bonds??[];
  if (node.atoms.length > 10000 || sourceBonds.length > 30000) throw new Error('二维分子超过本次读取限制。');
  const nodeIssues: TwoDIssue[] = [];
  const atoms: TwoDAtom[] = node.atoms.map((value: unknown, index: number) => {
    if (!object(value)) throw new Error('KET原子记录无效。');
    const location = value.location; if (!Array.isArray(location) || location.length < 2 || !location.slice(0, 2).every(number)) throw new Error('KET原子缺少有效二维坐标。');
    const key = `${nodeKey}/atom/${index}`;
    const isotopeLabelMass=value.label==='D'?2:value.label==='T'?3:undefined;
    const sourceProperties=structuredClone(value);
    // D/T are element H with a specified mass, not extra periodic-table elements.
    // Keep the raw KET label in the provenance and editable KET; 3D remains blocked.
    if(isotopeLabelMass!==undefined){
      if(value.isotope!==undefined&&value.isotope!==isotopeLabelMass)nodeIssues.push(blocked('conflicting-isotope','KET同位素标签与质量数字段冲突。',[atomId(sourceId,key)]));
      else sourceProperties.isotope=isotopeLabelMass;
    }
    const atom: TwoDAtom = { id: atomId(sourceId, key), sourceAtomKey: key, sourceIndex: index + 1,
      element: isotopeLabelMass!==undefined?'H':typeof value.label === 'string' ? value.label : '*', x: location[0], y: location[1], z: 0,
      formalCharge: value.charge ?? 0, sourceProperties };
    if (value.implicitHCount !== undefined) {
      if (!Number.isSafeInteger(value.implicitHCount) || value.implicitHCount < 0 || value.implicitHCount > 12) nodeIssues.push(blocked('invalid-hydrogen-count', '隐式氢计数无效。', [atom.id]));
      else { atom.implicitHydrogens = value.implicitHCount; atom.hydrogenMode = 'explicit'; }
    }
    atomIssues(sourceProperties, atom, nodeIssues); return atom;
  });
  const bondIssues: { issue: TwoDIssue; endpoints: number[] }[] = [];
  const bonds: Bond[] = sourceBonds.map((value: unknown) => {
    if (!object(value) || !Array.isArray(value.atoms) || value.atoms.length !== 2 || !value.atoms.every((i: unknown) => Number.isSafeInteger(i) && (i as number) >= 0 && (i as number) < atoms.length)) throw new Error('KET化学键端点无效。');
    const type = value.type;
    if (![1, 2, 3, 4].includes(type) || value.queryProperties || value.topology) bondIssues.push({ endpoints: value.atoms, issue: blocked('query-bond', '查询键、特殊键或拓扑约束不能进入明确三维。') });
    return { a: value.atoms[0], b: value.atoms[1], order: type === 4 ? 1.5 : type, ...(type === 4 ? { aromatic: true } : {}), ...(value.stereo !== undefined ? { stereo: value.stereo } : {}) };
  });
  const adjacency = atoms.map(() => [] as number[]); bonds.forEach(bond => { adjacency[bond.a].push(bond.b); adjacency[bond.b].push(bond.a); });
  const visited = new Set<number>(), components: TwoDComponent[] = [];
  for (let start = 0; start < atoms.length; start++) {
    if (visited.has(start)) continue;
    const indices: number[] = [], queue = [start]; visited.add(start);
    for (let head = 0; head < queue.length; head++) { const index = queue[head]; indices.push(index); for (const next of adjacency[index]) if (!visited.has(next)) { visited.add(next); queue.push(next); } }
    indices.sort((a, b) => a-b);
    const reindex = new Map(indices.map((index, i) => [index, i]));
    const componentAtoms = indices.map(index => ({ ...atoms[index] }));
    const ids = new Set(componentAtoms.map(atom => atom.id));
    const issues = nodeIssues.filter(issue => !issue.atomIds || issue.atomIds.some(id => ids.has(id)));
    issues.push(...bondIssues.filter(({ endpoints }) => endpoints.some(i => reindex.has(i))).map(({ issue }) => issue));
    const componentBonds = bonds.filter(bond => reindex.has(bond.a)).map(bond => ({ ...bond, a: reindex.get(bond.a)!, b: reindex.get(bond.b)! }));
    const rawNode = structuredClone(node), rawAtoms = indices.map(index => structuredClone(node.atoms[index]));
    rawNode.atoms = rawAtoms;
    rawNode.bonds = (sourceBonds as Obj[]).filter((bond: Obj) => reindex.has(bond.atoms[0])).map((bond: Obj) => ({ ...bond, atoms: bond.atoms.map((i: number) => reindex.get(i)) }));
    if (Array.isArray(node.sgroups) && indices.length !== atoms.length) {
      rawNode.sgroups = node.sgroups.filter((group: Obj) => Array.isArray(group.atoms) && group.atoms.some((i: number) => reindex.has(i))).map((group: Obj) => {
        if (!['SUP', 'superatom', 'GEN', 'generic', 'DAT', 'data'].includes(group.type)) issues.push(blocked('polymer-group', '聚合物或重复单元不能直接转成明确原子模型。'));
        if (!group.atoms.every((i: number) => reindex.has(i))) issues.push(blocked('cross-component-group', '跨组分的结构组需先明确目标。'));
        const bondIndices = new Map<number,number>(); (sourceBonds as Obj[]).forEach((bond: Obj, i: number) => { if(reindex.has(bond.atoms[0])) bondIndices.set(i,bondIndices.size); });
        return { ...group, atoms: group.atoms.map((i: number) => reindex.get(i)),
          ...(Array.isArray(group.bonds) ? { bonds: group.bonds.map((i:number) => bondIndices.get(i)) } : {}),
          ...(Array.isArray(group.attachmentPoints) ? { attachmentPoints: group.attachmentPoints.map((point:Obj) => ({...point,attachmentAtom:reindex.get(point.attachmentAtom),...(point.leavingAtom!==undefined?{leavingAtom:reindex.get(point.leavingAtom)??-1}:{})})) } : {}) };
      });
    }
    if(Array.isArray(node.sgroups)) for(const group of node.sgroups) if(!['SUP','superatom','GEN','generic','DAT','data'].includes(group.type) && (!Array.isArray(group.atoms)||group.atoms.some((i:number)=>reindex.has(i)))) issues.push(blocked('polymer-group','聚合物或重复单元不能直接转成明确原子模型。'));
    const selectedDocument=structuredClone(document);
    selectedDocument.root.nodes=[{$ref:nodeKey},...document.root.nodes.filter((ref:Obj)=>ref.$ref&&document[ref.$ref]?.type==='rgroup')];
    selectedDocument[nodeKey]={...rawNode,type:'molecule'};
    const component: TwoDComponent = { id: `${sourceId}:${nodeKey}:${indices[0]}`, label: `结构 ${offset + components.length + 1}`, sourceId, sourceNodeKey: nodeKey, atoms: componentAtoms, bonds: componentBonds, issues,
      ket: JSON.stringify(selectedDocument) };
    // Follow the established builder valence policy only for an omitted ordinary tetrahedral H.
    // A source explicit H count always wins and is never overridden by this inference.
    for(let index=0;index<component.atoms.length;index++){
      const atom=component.atoms[index];
      const edges=component.bonds.filter(bond=>bond.a===index||bond.b===index);
      if(atom.implicitHydrogens===undefined && ['C','Si'].includes(atom.element) && edges.length===3 && edges.every(edge=>edge.order===1) && edges.some(edge=>edge.a===index&&[1,6].includes(edge.stereo??0)) && builderDefaultValence(atom)-builderCovalentValence(component,index)===1) atom.implicitHydrogens=1;
    }
    materializeHydrogens(component);
    const plane = makeStructure(component);
    for (const atom of component.atoms) {
      const index = component.atoms.indexOf(atom);
      const rawAtom=node.atoms[indices[index]];
      if ((rawAtom?.stereoLabel === 'abs'||rawAtom?.cip) && !component.bonds.some(bond => bond.a === index && [1, 6].includes(bond.stereo ?? 0))) component.issues.push(blocked('stereo-without-wedge', '原子手性标签没有可核验的楔线定义。', [atom.id]));
      if (!component.bonds.some(bond => bond.a === index && [1, 6].includes(bond.stereo ?? 0))) continue;
      const parity = requestedBuilder2DParity(plane, atom.id);
      if (!parity) component.issues.push(blocked('unresolved-tetrahedral', '楔线中心缺少可确定的四面体邻居或二维投影。', [atom.id]));
      else atom.stereoParity = parity;
    }
    // E/Z is retained through actual diagram coordinates; a crossed double bond is rejected above.
    for (const bond of component.bonds) if (bond.order === 2 && !bond.stereo) {
      const left = component.bonds.filter(edge => edge.a === bond.a || edge.b === bond.a).length;
      const right = component.bonds.filter(edge => edge.a === bond.b || edge.b === bond.b).length;
      const configuration=builderDoubleBondConfiguration(plane, component.atoms[bond.a].id, component.atoms[bond.b].id);
      const sourceBond=rawNode.bonds[component.bonds.indexOf(bond)];
      if(['E','Z'].includes(sourceBond?.cip) && sourceBond.cip!==configuration) component.issues.push(blocked('double-bond-configuration','来源双键E/Z标签与可核验二维构型冲突或无法确定。'));
      if (left > 1 && right > 1 && configuration === 'undefined') {
        // Symmetric substituents are not E/Z centres; native generation remains the final graph/stereo check.
        component.issues.push(warning('unassigned-double-bond', '此双键未获得唯一E/Z标签；三维生成仍须保留可判定的实际构型。'));
      }
    }
    components.push(component);
  }
  return components;
}

/** Explicit source H counts become actual H atoms, never a valence guess. */
function materializeHydrogens(component: TwoDComponent) {
  const originals = [...component.atoms];
  originals.forEach((atom, index) => {
    const count = atom.implicitHydrogens; if (count === undefined) return;
    const aromatic = component.bonds.some(bond => (bond.a === index || bond.b === index) && bond.aromatic);
    if (atom.element === 'N' && aromatic && count === 1) atom.aromaticHydrogen = true;
    const existing = component.bonds.filter(bond => bond.a === index || bond.b === index).map(bond => component.atoms[bond.a === index ? bond.b : bond.a]);
    for (let h = 0; h < count; h++) {
      // Place diagram H away from current neighbours. Position is display-only; native ETKDG supplies XYZ.
      const angles = existing.map(other => Math.atan2(other.y-atom.y, other.x-atom.x)).sort((a, b) => a-b);
      const angle = angles.length ? angles[0] + Math.PI + (h-(count-1)/2)*0.8 : h*2*Math.PI/Math.max(1,count);
      const key = `${atom.sourceAtomKey}/implicitH/${h}`;
      const id = atomId(component.sourceId, key);
      component.atoms.push({ id, sourceAtomKey: key, element: 'H', x: atom.x+Math.cos(angle), y: atom.y+Math.sin(angle), z: 0, formalCharge: 0, hydrogenMode: 'explicit', sourceProperties: { generatedFromImplicitH: atom.sourceAtomKey } });
      component.bonds.push({ a: index, b: component.atoms.length-1, order: 1 });
    }
  });
}

export function parseKetDraft(input: string, options: ParseKetDraftOptions): TwoDDraft {
  const ket: unknown = JSON.parse(input);
  if (!object(ket) || !object(ket.root)) throw new Error('不是有效的KET二维结构。');
  // Indigo/Ketcher may serialize a cleared graph as either root:{} or nodes:[].
  // Only the explicit editor contract accepts the omitted empty nodes member.
  const nodes=Array.isArray(ket.root.nodes)?ket.root.nodes:options.allowEmpty&&Object.keys(ket.root).length===0?[]:null;
  if(!nodes)throw new Error('不是有效的KET二维结构。');
  const components: TwoDComponent[] = [], issues: TwoDIssue[] = [], seen = new Set<string>();
  for (const ref of nodes) {
    if (!object(ref)) throw new Error('KET根节点无效。');
    if (typeof ref.$ref !== 'string') {
      let text=ref.data?.content??ref.content;
      if(typeof text==='string' && text.trim().startsWith('{'))try{const rich=JSON.parse(text);text=Array.isArray(rich.blocks)?rich.blocks.map((block:Obj)=>block.text??'').join(''):text;}catch{/* Nonchemical text stays as source decoration. */}
      if(ref.type==='plus'||ref.type==='text'&&typeof text==='string'&&/^[+−-]$/.test(text.trim())){
        issues.push({...warning('unassociated-sign','图纸含独立 +/− 符号；该符号未绑定原子形式电荷，也可能是反应分隔符。请对照原图核对逐原子电荷；程序不会据此猜测电荷。'),scope:'document'});
      }else issues.push(warning('non-molecule', '图中文字、箭头或装饰保留在原文件；仅分子组分可选为三维目标。'));
      continue;
    }
    if (seen.has(ref.$ref)) throw new Error('KET包含重复分子引用。'); seen.add(ref.$ref);
    const node = ket[ref.$ref];
    if (!object(node)) throw new Error('KET分子引用不存在。');
    if (node.type !== 'molecule') { issues.push(blocked('non-atomic-node', `未具体化的${String(node.type)}对象仅保留在二维原稿。`)); continue; }
    components.push(...splitNode(node, ref.$ref, options.sourceId, components.length,ket));
    if(components.reduce((sum,component)=>sum+component.atoms.length,0)>20000)throw new Error('二维图纸总原子数超过本次读取限制。');
  }
  if(!options.allowEmpty&&!components.some(component=>component.atoms.length))throw new Error('文件未返回任何可读取分子结构；空二维画布不算解析成功。');
  return { source: { id: options.sourceId, name: options.filename, format: 'ket' }, raw: input, ket: input, components, issues };
}

/** MOL/OCR output uses the same Indigo adapter as the editor, without a second chemistry reader. */
export function parseMolDraft(input: string, options: ParseTwoDOptions): Promise<TwoDDraft> { return parseTwoDDraft(input,options); }

/** Source-only CDXML audit: cannot infer missing fields from a converted parser output. */
export function auditCdxml(input: string): TwoDIssue[] {
  return auditSourceFacts(readCdxmlFacts(input));
}

export async function parseTwoDDraft(input: string | Uint8Array | TwoDSourceInput, options?: ParseTwoDOptions): Promise<TwoDDraft> {
  const sourceInput = object(input) && !(input instanceof Uint8Array) ? input as TwoDSourceInput : null;
  const data = sourceInput ? sourceInput.data : input as string | Uint8Array;
  const opts: ParseTwoDOptions = options ?? { sourceId: sourceInput?.id ?? 'drawing', filename: sourceInput?.name };
  cancelled(opts.signal);
  const format = detectTwoDFormat(data); if (!format) throw new Error('文件内容不是受支持的CDX、CDXML、MOL或KET二维结构。');
  if (sourceInput?.format && sourceInput.format !== format) throw new Error('二维文件声明格式与真实内容不符。');
  let draft: TwoDDraft;
  if (format === 'ket') draft=parseKetDraft(asText(data),{sourceId:opts.sourceId,filename:opts.filename});
  else {
    if (!opts.indigo) throw new Error('离线Indigo二维解析组件尚未准备好。');
    const sourceFacts=format==='cdxml'?readCdxmlFacts(asText(data)):format==='cdx'?(data instanceof Uint8Array?readCdxFacts(data):(()=>{throw new Error('CDX二进制必须以原始字节读取，不能从文本还原。');})()):null;
    const ket = await opts.indigo.convert(data,{inputFormat:format,outputFormat:'ket',signal:opts.signal}); cancelled(opts.signal);
    draft=parseKetDraft(ket,{sourceId:opts.sourceId,filename:opts.filename});
    if(sourceFacts) {
      const sourceIssues=auditSourceFacts(sourceFacts,draft); draft.issues.push(...sourceIssues);
      draft.components.forEach(component=>component.issues.push(...sourceIssues.filter(issue=>issue.scope==='document'||issue.componentIds?.includes(component.id))));
    }
  }
  cancelled(opts.signal);
  if(!draft.components.some(component=>component.atoms.length))throw new Error('文件未返回任何可读取分子结构；空二维画布不算解析成功。');
  draft.source={id:opts.sourceId,name:opts.filename,format}; draft.raw=data; return draft;
}
