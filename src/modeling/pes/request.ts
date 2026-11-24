import { baseElectronicStateParameterError as baseElectronicStateError } from '../../core/base-electronic-state';
import { pesElectronicConfirmed } from './input-state';
import type { Structure } from '../../core/types';
import { isPeriodic, requireConfirmedPeriodicity } from '../../core/periodic';
import { periodicPesOperationAvailable } from './periodic-capabilities';
import type { SharedModelConstraints } from '../../core/modeling/contracts';
import { supportsXtbAlpb, usesXtbSccIterations } from '../../core/xtb-capabilities';
import { confirmCoordinateSelection } from '../application/coordinate-selection';
import { modelCoordinateKey, projectSharedConstraintsByAtomNumber, retainSharedConstraints } from '../constraints';
import { PES_SCHEMA, isPesNetMethod, type PesCard, type PesCoordinate, type PesExpressionDraft, type PesGeometry, type PesGroup,
  type PesHessianReference, type PesMethodDraft, type PesParameters, type PesRequest, type PesRunIdentity } from './contracts';
import { defaultParameters, effectivePesPathParameters, legacyDefaultParameters, nebPresetParameters, parameterVisible, pesParameterSections, usesPesExecutionProfile, isSellaTsAlgorithm, isPesScanOptimizer, effectivePesScanAlgorithm, sellaPresetParameters, projectedForcePreset, PES_CONVERGENCE_OPTIONS, GSM_CONVERGENCE_PRESETS, PES_DEFAULT_HESSIAN_STEP_BOHR, PES_IRC_NUMBER_FIELDS, type PesParameterField } from './defaults';
import { compilePesExpression, scanAxisDefinition } from './expressions';
import { createPesFfModel, pesFfModelMatches, pesSourceFfModel } from './ff-model';
import { pesPathCellAlignment } from './path-cell-alignment';

export function numberDraft(raw: string, label: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) || !Number.isFinite(Number(raw)))
    throw Error(`${label}需要有效数字。`);
  return Number(raw);
}

export function parameterValue(field: PesParameterField, raw: unknown): number | string | boolean | undefined {
  if (field.options) {
    if (typeof raw === 'string' && Object.hasOwn(field.options, raw)) return raw;
    throw Error(`请检查${field.label}。`);
  }
  if (typeof field.initial === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    throw Error(`请检查${field.label}。`);
  }
  if (field.optional && raw === '') return undefined;
  const value = numberDraft(String(raw), field.label);
  if ((field.integer && !Number.isSafeInteger(value)) || (field.minimum !== undefined && (field.exclusiveMinimum ? value <= field.minimum : value < field.minimum)))
    throw Error(`${field.label}超出允许范围。`);
  return value;
}

function compileParameters(algorithm: string, draft: PesParameters, allowed?: ReadonlySet<string>, method?: PesMethodDraft['method']) {
  const current = usesPesExecutionProfile(draft) || isPesScanOptimizer(algorithm);
  const merged = { ...(current ? defaultParameters(algorithm) : legacyDefaultParameters(algorithm)), ...effectivePesPathParameters(algorithm, draft) };
  if (draft.pathSemantics === undefined) delete merged.pathSemantics;
  const parameters: Record<string, unknown> = {};
  for (const { fields } of pesParameterSections(algorithm, merged)) for (const field of fields) {
    if (method!==undefined&&!usesXtbSccIterations(method)&&['electronicTemperatureK', 'maxSccIterations'].includes(field.key)) continue;
    if ((allowed && !allowed.has(field.key)) || !parameterVisible(field.key, merged)) continue;
    const value = parameterValue(field, merged[field.key]);
    if (value !== undefined) parameters[field.key] = value;
  }
  if (current && !allowed) {
    parameters.executionProfile = merged.executionProfile;
    if (method===undefined||usesXtbSccIterations(method)) {
      parameters.electronicTemperatureK = parameterValue({ key: 'electronicTemperatureK', label: '电子温度', initial: '300', minimum: 0 }, merged.electronicTemperatureK);
      parameters.maxSccIterations = parameterValue({ key: 'maxSccIterations', label: 'SCC迭代上限', initial: '250', minimum: 1, integer: true }, merged.maxSccIterations);
    }
    if (isSellaTsAlgorithm(algorithm) || isPesScanOptimizer(algorithm)) {
      if (merged.coordinateSystem !== 'xyz' && merged.coordinateSystem !== 'ric') throw Error('请选择有效的Sella坐标系。');
      parameters.coordinateSystem = merged.coordinateSystem;
    }
    if (merged.convergencePreset !== undefined) parameters.convergencePreset = merged.convergencePreset;
    if (algorithm === 'ci-neb') {
      if (merged.nebOptimizer !== 'fire2' && merged.nebOptimizer !== 'fire' && merged.nebOptimizer !== 'lbfgs') throw Error('请选择有效的路径优化器。');
      if (!['loose', 'medium', 'tight', 'custom'].includes(String(merged.nebConvergencePreset))) throw Error('请选择有效的路径收敛标准。');
      parameters.coordinateSystem = 'xyz'; parameters.nebOptimizer = merged.nebOptimizer; parameters.nebConvergencePreset = merged.nebConvergencePreset;
      if (merged.pathInitializer !== 'sidpp' && merged.pathInitializer !== 'fsm') throw Error('请选择有效的路径初猜方式。');
      parameters.pathInitializer = merged.pathInitializer;
    }
    if (algorithm === 'de-gsm') {
      if (merged.gsmGrowth !== 'native' && merged.gsmGrowth !== 'sidpp') throw Error('请选择有效的GSM生长方式。');
      parameters.gsmGrowth = merged.gsmGrowth;
    }
    if (algorithm === 'fsm') {
      if (merged.fsmGrowth !== 'native' && merged.fsmGrowth !== 'sidpp') throw Error('请选择有效的FSM生长方式。');
      parameters.fsmGrowth = merged.fsmGrowth;
    }
    if (['ci-neb','fsm','de-gsm'].includes(algorithm) && merged.pathSemantics !== undefined) {
      if (merged.pathSemantics !== 'v223') throw Error('路径初始化设置的版本不受支持。');
      parameters.pathSemantics = merged.pathSemantics;
    }
  }
  return parameters;
}

function validateStructure(structure: Structure) {
  if (structure.dimension === 2 || structure.periodicSource?.completeness === 'partial') throw Error('请选择真实三维结构或具有完整晶胞的周期结构。');
  if (isPeriodic(structure)) requireConfirmedPeriodicity(structure);
  if (!structure.atoms.length || structure.atoms.some(atom => !atom.id || ![atom.x, atom.y, atom.z].every(Number.isFinite)))
    throw Error('所选结构缺少原子、稳定身份或有效的三维坐标。');
  if (new Set(structure.atoms.map(atom => atom.id)).size !== structure.atoms.length) throw Error('所选结构含重复原子身份。');
}

export function resolvePesConstraintTarget(raw:string|undefined,type:PesCoordinate['type'],fallback:number,label='约束目标'):number{
  const value=raw?.trim()?numberDraft(raw,label):fallback;
  if(!Number.isFinite(value)||type==='B'&&value<=0||type==='A'&&(value<=0||value>=180))throw Error(`${label}超出允许范围。`);
  return value;
}
type PesConstraintOwner=Pick<PesGroup,'constraints'|'constraintTargets'>&Partial<Pick<PesGroup,'initialNodeId'|'nodes'|'cards'|'runs'>>;
export function pesConstraintReference(group:PesConstraintOwner,fallback:Structure):Structure{
  return group.nodes?.find(node=>node.id===group.initialNodeId)?.geometry.structure??fallback;
}

/** Old groups can contain rows recorded with another member's IDs. Retain ambiguous rows for correction. */
export function pesTaskConstraintDefinitions(group:PesConstraintOwner,fallback:Structure):SharedModelConstraints{
  const reference=pesConstraintReference(group,fallback),definitions=group.constraints;
  const ids=new Set(reference.atoms.map(atom=>atom.id));
  if(definitions.frozenAtomIds.every(id=>ids.has(id))&&definitions.coordinates.every(row=>row.atomIds.every(id=>ids.has(id))))return definitions;
  const sources=[...(group.nodes??[]).map(node=>node.geometry.structure),
    ...(group.cards??[]).flatMap(card=>Object.values(card.slots).flatMap(slot=>slot?[slot.structure]:[])),
    ...Object.values(group.runs??{}).map(run=>run.request.structure)];
  const map=(path:string[])=>{
    if(path.every(id=>ids.has(id)))return path;
    const alternatives=new Map<string,string[]>();
    for(const source of sources){
      const projected=projectSharedConstraintsByAtomNumber({frozenAtomIds:path,coordinates:[]},source,reference);
      if(!projected.unmatchedAtomIds.length)alternatives.set(JSON.stringify(projected.constraints.frozenAtomIds),projected.constraints.frozenAtomIds);
    }
    return alternatives.size===1?[...alternatives.values()][0]:path;
  };
  return {...definitions,frozenAtomIds:[...new Set(definitions.frozenAtomIds.map(id=>map([id])[0]))],coordinates:definitions.coordinates.map(row=>{
    const atomIds=map(row.atomIds);
    return atomIds===row.atomIds?row:{...row,id:row.id??modelCoordinateKey(row),atomIds};
  })};
}

export function projectPesConstraintDefinitions(group:PesConstraintOwner,structure:Structure,sourceDocumentId?:string){
  const reference=pesConstraintReference(group,structure),definitions=pesTaskConstraintDefinitions(group,structure);
  const coordinates=definitions.coordinates.map(row=>row.id||reference===structure?row:{...row,id:modelCoordinateKey(row)});
  const ownerDocument=group.nodes?.find(node=>node.id===group.initialNodeId)?.geometry.documentId;
  if(sourceDocumentId && sourceDocumentId===ownerDocument && reference.atoms.length!==structure.atoms.length){
    // In the same editable source, surviving stable identities still own the definitions after insertion or deletion.
    const elements=new Map(structure.atoms.map(atom=>[atom.id,atom.element]));
    const ids=new Set(reference.atoms.flatMap(atom=>atom.id&&elements.get(atom.id)===atom.element?[atom.id]:[]));
    return {constraints:retainSharedConstraints({...definitions,coordinates},ids),
      unmatchedAtomIds:definitions.frozenAtomIds.filter(id=>!ids.has(id)),
      unmatchedCoordinates:coordinates.filter(row=>row.atomIds.some(id=>!ids.has(id)))};
  }
  return projectSharedConstraintsByAtomNumber({...definitions,coordinates},reference,structure);
}

/** Commit just the authored change, so a stale peer cannot replace the whole task set. */
export function mergePesConstraintEdit(group:PesConstraintOwner,structure:Structure,previous:SharedModelConstraints,next:SharedModelConstraints):SharedModelConstraints{
  const reference=pesConstraintReference(group,structure),definitions=pesTaskConstraintDefinitions(group,structure);
  const beforeIds=new Set(previous.frozenAtomIds),afterIds=new Set(next.frozenAtomIds);
  const beforeRows=new Map(previous.coordinates.map(row=>[modelCoordinateKey(row),row]));
  const afterRows=new Map(next.coordinates.map(row=>[modelCoordinateKey(row),row]));
  const project=(constraints:SharedModelConstraints)=>{
    const result=projectSharedConstraintsByAtomNumber(constraints,structure,reference);
    if(result.unmatchedAtomIds.length||result.unmatchedCoordinates.length)throw Error('当前结构的原子编号与任务初始结构无法对应，未更改全局定义。');
    return result.constraints;
  };
  const removed=project({frozenAtomIds:previous.frozenAtomIds.filter(id=>!afterIds.has(id)),coordinates:previous.coordinates.filter(row=>!afterRows.has(modelCoordinateKey(row)))});
  const updated=project({frozenAtomIds:next.frozenAtomIds.filter(id=>!beforeIds.has(id)),coordinates:next.coordinates.filter(row=>{
    const old=beforeRows.get(modelCoordinateKey(row));
    return !old||old.value!==row.value||old.action!==row.action||JSON.stringify([old.atomIds,old.images])!==JSON.stringify([row.atomIds,row.images]);
  })});
  const excludedIds=new Set(removed.frozenAtomIds),excludedRows=new Set(removed.coordinates.map(modelCoordinateKey));
  const replacements=new Map(updated.coordinates.map(row=>[modelCoordinateKey(row),row]));
  const replacementsById=new Map(updated.coordinates.filter(row=>row.id).map(row=>[row.id,row]));
  const coordinates=definitions.coordinates.flatMap(row=>{
    const key=modelCoordinateKey(row);
    const replacement=replacements.get(key)??(row.id?replacementsById.get(row.id):undefined);
    if(excludedRows.has(key)&&!replacement)return [];
    if(!replacement)return [row];
    const replacementKey=modelCoordinateKey(replacement);
    replacements.delete(replacementKey);
    return [{...replacement,id:row.id??replacement.id,objectId:replacementKey===key?row.objectId:replacement.objectId}];
  });
  coordinates.push(...replacements.values());
  const knownIds=new Set(reference.atoms.map(atom=>atom.id)),knownCoordinate=(row:SharedModelConstraints['coordinates'][number])=>row.atomIds.every(id=>knownIds.has(id));
  const frozenAtomIds=[...new Set([...definitions.frozenAtomIds.filter(id=>!excludedIds.has(id)),...updated.frozenAtomIds])];
  return {...definitions,canonical:next.canonical??definitions.canonical,
    ...(previous.enabled!==next.enabled?{enabled:next.enabled}:{}),
    frozenAtomIds:[...frozenAtomIds.filter(id=>knownIds.has(id)),...frozenAtomIds.filter(id=>!knownIds.has(id))],
    coordinates:[...coordinates.filter(knownCoordinate),...coordinates.filter(row=>!knownCoordinate(row))]};
}

/** Shared by the PES request and the modeling preoptimization handoff. */
export function resolvePesConstraintDefinitions(group:PesConstraintOwner,structure:Structure,sourceDocumentId?:string):SharedModelConstraints{
  if(group.constraints.enabled===false)return group.constraints;
  const {constraints,unmatchedAtomIds,unmatchedCoordinates}=projectPesConstraintDefinitions(group,structure,sourceDocumentId);
  if(unmatchedAtomIds.length||unmatchedCoordinates.some(row=>row.action==='freeze'))throw Error('所选结构的原子编号与全局冻结或内坐标定义无法对应，请核对原子顺序或改选来源。');
  return { ...constraints, coordinates: constraints.coordinates.filter(row => row.action === 'freeze').map((row, index) => {
    const measured = confirmCoordinateSelection(structure, row.atomIds, row.images);
    if (measured.type !== row.type) throw Error('全局约束的原子与内坐标类型不匹配。');
    const draft = group.constraintTargets?.[row.id ?? modelCoordinateKey(row)];
    const value=resolvePesConstraintTarget(draft,row.type,draft===undefined?row.value??measured.value:measured.value,`全局约束目标${index+1}`);
    return {...row,atomIds:[...row.atomIds],value};
  }) };
}
function prepareConstraints(group: PesGroup, source: PesGeometry): PesRequest['constraints'] {
  const resolved=resolvePesConstraintDefinitions(group,source.structure,source.documentId);
  if(resolved.enabled===false)return {frozenAtomIds:[],coordinates:[]};
  const used = new Set(resolved.coordinates.map(row => row.id));
  return {frozenAtomIds:resolved.frozenAtomIds,coordinates:resolved.coordinates.map((row, index) => {
    let id = row.id;
    if (!id) {
      let nextFallback = index + 1;
      do { id = `global-coordinate-${nextFallback++}`; } while (used.has(id));
      used.add(id);
    }
    return { id, type:row.type,atomIds:row.atomIds,value:row.value!,...(row.images ? { images: row.images } : {}) };
  })};
}

function prepareExpression(draft: PesExpressionDraft, source: Structure, constraints: PesRequest['constraints']) {
  const expression = compilePesExpression(draft, source);
  const coordinates = draft.coordinates.filter(row => expression.coordinateIds.has(row.id)).map(({ id, name, type, atomIds, images }) => ({ id, name, type, atomIds, ...(images ? { images } : {}) }));
  const frozen = new Set(constraints.frozenAtomIds);
  const fixed = new Set(constraints.coordinates.map(modelCoordinateKey));
  if (coordinates.every(row => row.atomIds.every(id => frozen.has(id)) || fixed.has(modelCoordinateKey(row))))
    throw Error('内坐标表达式引用的定义均被全局冻结或内坐标约束固定。请调整相关定义。');
  return { expression, coordinates };
}

export function cardSource(group: PesGroup, card: PesCard, currentScanGeometry?: PesGeometry): PesGeometry {
  if (card.kind === 'scan') {
    if (!currentScanGeometry) throw Error('当前科学帧尚未显示。');
    return currentScanGeometry;
  }
  const slot = card.kind === 'path' ? 'reactant' : 'start';
  if (!card.slots[slot] && card.requiredSlots?.includes(slot)) throw Error('请重新记录或选择起始结构。');
  return card.slots[slot] ?? group.nodes.find(node => node.id === group.initialNodeId)!.geometry;
}

export function pesStructureCompatibilityIssues(source: Structure, target: Structure, name: string, referenceName = '反应物'): string[] {
  try { validateStructure(target); } catch (error) { return [`${name}：${error instanceof Error ? error.message : String(error)}`]; }
  const issues: string[] = [];
  if (source.atoms.length !== target.atoms.length)
    issues.push(`${name}与${referenceName}的原子数不同（${target.atoms.length} / ${source.atoms.length}）。`);
  const index = target.atoms.findIndex((atom, index) => source.atoms[index] && atom.element !== source.atoms[index].element);
  if (index >= 0)
    issues.push(`${name}第${index + 1}个原子的元素与${referenceName}不同（${target.atoms[index].element} / ${source.atoms[index].element}）。`);
  if (isPeriodic(source) !== isPeriodic(target)) issues.push(`${name}与${referenceName}的周期性不同。`);
  else if (isPeriodic(source)) {
    try {
      const alignment = pesPathCellAlignment(requireConfirmedPeriodicity(source), target.cell!);
      if (alignment.issue) issues.push(`${name}与${referenceName}${alignment.issue}`);
    } catch (error) { issues.push(`${referenceName}：${error instanceof Error ? error.message : String(error)}`); }
  }
  return issues;
}

export function pesPathStructureIssue(source: Structure, target: Structure, name: string): string | undefined {
  return pesStructureCompatibilityIssues(source, target, name)[0];
}

function orderedPathStructure(source: Structure, target: Structure, name: string): Structure {
  const issue = pesPathStructureIssue(source, target, name);
  if (issue) throw Error(issue);
  const cell = isPeriodic(source) ? source.cell : undefined;
  const transform = cell ? pesPathCellAlignment(cell, target.cell!).transform : undefined;
  // Display order is the scientific correspondence. Stable IDs and legacy maps
  // must never sort or permute an endpoint; normalize only this run-owned copy.
  return { ...target, ...(cell ? { cell } : {}), atoms: target.atoms.map((atom, index) => {
    const [x, y, z] = transform ? transform([atom.x, atom.y, atom.z]) : [atom.x, atom.y, atom.z];
    return { ...atom, id: source.atoms[index].id, x, y, z };
  }) };
}

export type PesWorkbenchInput = { operation: 'ts' | 'hessian' | 'irc' };

function initialIrcHessian(group: PesGroup, source: PesGeometry) {
  const run = source.source?.runId ? group.runs[source.source.runId] : undefined;
  const candidates = run ? [run, ...Object.values(group.runs).filter(item => item !== run).reverse()] : Object.values(group.runs).reverse();
  const atoms = source.structure.atoms;
  for (const candidate of candidates) {
    const h = candidate.result?.hessian as Partial<PesHessianReference> | undefined;
    if (!h?.matrixHartreePerBohr2 || h.atomIds?.length !== atoms.length || h.geometryAngstrom?.length !== atoms.length || !atoms.every((atom, i) =>
      h.atomIds?.[i] === atom.id && h.geometryAngstrom?.[i]?.length === 3 && h.geometryAngstrom[i].every((value, axis) => value === [atom.x, atom.y, atom.z][axis]))) continue;
    return { matrixHartreePerBohr2: h.matrixHartreePerBohr2, atomIds: h.atomIds, geometryAngstrom: h.geometryAngstrom,
      ...(h.space ? { space: h.space } : {}), ...(h.cell ? { cell: h.cell } : {}),
      source: { runId: candidate.request.id, frameId: h.frameId ?? '', method: candidate.request.method } };
  }
}

export function preparePesRequest(group: PesGroup, identity: PesRunIdentity, source: PesGeometry,
  input: { card: PesCard } | PesWorkbenchInput): PesRequest {
  if ('card' in input && input.card.kind === 'explore') throw Error('单端反应探索已停用，已有结果仍可查看和导出。');
  validateStructure(source.structure);
  const card = 'card' in input ? input.card : undefined;
  let pathProduct: Structure | undefined;
  if (card?.kind === 'path') {
    const product = card.slots.product;
    if (!product) throw Error('请选择产物结构或记录产物快照。');
    pathProduct = orderedPathStructure(source.structure, product.structure, '产物');
  }
  const electronic = group.electronic.confirmed;
  if (!electronic || !pesElectronicConfirmed(group, source)) throw Error('请先确定本次输入结构的电荷和自旋多重度。');
  const electronicIssue = baseElectronicStateError(source.structure, electronic);
  if (electronicIssue) throw Error(electronicIssue);
  const operation = 'card' in input ? input.card.kind : input.operation;
  const draft = card ?? group.ts;
  const method: PesMethodDraft = group.sharedMethod ?? draft.method;
  const net = isPesNetMethod(method.method);
  if (net) throw Error('此版本提供 xTB 计算，请选择本次计算级别。');
  const periodic = isPeriodic(source.structure);
  if (method.method === 'mcgfnff') throw Error('mcGFN-FF 已停用，请重新选择计算级别。');
  const calculationAlgorithm = operation === 'hessian' ? 'numeric' : operation === 'irc' ? 'sella-irc'
    : operation === 'scan' ? effectivePesScanAlgorithm(draft.algorithm, periodic) : draft.algorithm;
  if (periodic && !periodicPesOperationAvailable(method.method, operation, calculationAlgorithm))
    throw Error('所选计算级别尚未开放该周期计算入口。');
  if (operation === 'irc' && method.method === 'gfnff') throw Error('请选择支持反应路径追踪的 GFN-xTB 计算级别。');
  if (!periodic && !net && method.solvationModel !== 'none' && (method.solvationModel !== 'alpb' || !supportsXtbAlpb(method.method, method.solvent)))
    throw Error('当前计算级别不支持所选溶剂，请改选气相或可用的ALPB溶剂。');
  const solvation = !periodic && !net && method.solvationModel === 'alpb' ? { model: 'alpb' as const, solvent: method.solvent } : undefined;
  const constraints = prepareConstraints(group, source);
  const algorithm = operation === 'scan' ? calculationAlgorithm : draft.algorithm;
  const inputParameters = draft.parametersByAlgorithm[draft.algorithm] ?? {};
  if (inputParameters.executionProfile !== undefined && !usesPesExecutionProfile(inputParameters)) throw Error('此计算设置的执行版本暂不受支持，原草稿已保留。');
  let selected = inputParameters;
  if(algorithm==='ci-neb'&&usesPesExecutionProfile(inputParameters)){
    const preset=inputParameters.nebConvergencePreset??'loose';
    if(preset==='loose'||preset==='medium'||preset==='tight')selected=nebPresetParameters(inputParameters,preset);
  }
  if (operation === 'scan' || operation === 'ts') {
    const defaultPreset = operation === 'scan' ? 'loose' : 'medium';
    const preset = projectedForcePreset(inputParameters, card?.scanConvergencePreset ?? defaultPreset);
    selected = sellaPresetParameters(algorithm, inputParameters, preset);
    if (operation === 'scan' && algorithm !== 'sella-scan') selected.coordinateSystem = 'xyz';
    if (operation === 'ts' && isSellaTsAlgorithm(algorithm)) selected.coordinateSystem = group.ts.sellaCoordinateSystem ?? selected.coordinateSystem ?? 'xyz';
  }
  const parameters = compileParameters(algorithm, selected, operation === 'hessian' ? new Set(['maxSccIterations']) : undefined, method.method);
  parameters.policyVersion = 'v212';
  if (!net) parameters.accuracy = operation === 'ts' || operation === 'hessian' || operation === 'irc' ? .1 : 1;
  parameters.hessianStepBohr = group.hessianStepBohr ?? PES_DEFAULT_HESSIAN_STEP_BOHR;
  if (periodic) parameters.coordinateSystem = 'xyz';
  if (net) {
    parameters.device = method.device ?? 'gpu';
    delete parameters.maxSccIterations;
    delete parameters.electronicTemperatureK;
  }
  if (algorithm === 'de-gsm') {
    const preset = inputParameters.gsmConvergencePreset ?? 'loose';
    if (typeof preset !== 'string' || !Object.hasOwn(PES_CONVERGENCE_OPTIONS, preset)) throw Error('请选择有效的节点收敛标准。');
    parameters.gsmConvergencePreset = preset;
    if (preset !== 'custom') {
      const limits = GSM_CONVERGENCE_PRESETS[preset as keyof typeof GSM_CONVERGENCE_PRESETS];
      parameters.gsmMaxGradient = Number(limits.gsmMaxGradient);
      parameters.gsmRmsGradient = Number(limits.gsmRmsGradient);
    }
  }
  if (operation === 'irc') {
    const settings = group.ircParameters ?? {};
    for (const [key, field] of Object.entries(PES_IRC_NUMBER_FIELDS)) {
      const value = numberDraft(String(settings[key] ?? field.initial), key);
      if ('integer' in field ? !Number.isSafeInteger(value) || value < field.minimum : value <= field.exclusiveMinimum)
        throw Error(`IRC 参数 ${key} 无效。`);
      parameters[key] = value;
    }
    const mode = settings.mode;
    if (mode !== undefined && mode !== 'auto' && mode !== '') {
      if (!Number.isSafeInteger(Number(mode)) || Number(mode) < 1) throw Error('请选择有效的 IRC 起始模态。');
      parameters.mode = Number(mode);
    }
    const hessian = initialIrcHessian(group, source);
    if (hessian) parameters.initialHessian = hessian;
  }
  const coordinates = new Map<string, PesCoordinate>();
  function includeCoordinates(definitions: readonly PesCoordinate[]) {
    for (const definition of definitions) {
      const old = coordinates.get(definition.id);
      if (old && (old.type !== definition.type || old.atomIds.some((id, index) => definition.atomIds[index] !== id)
        || old.atomIds.some((_, index) => [0, 1, 2].some(axis => (old.images?.[index]?.[axis] ?? 0) !== (definition.images?.[index]?.[axis] ?? 0)))))
        throw Error('同一内坐标身份存在冲突定义。');
      if (!old) coordinates.set(definition.id, definition);
    }
  }
  if (operation === 'scan' && card) {
    const axes = card.axes.slice(0, card.dimension).map((axis, index) => {
      const { expression, coordinates: definitions } = prepareExpression(scanAxisDefinition(card, axis), source.structure, constraints);
      const automatic = axis.lowerMode === 'automatic' || axis.lowerMode === undefined && !axis.lower;
      const start = automatic ? expression.value : numberDraft(axis.lower, `坐标${index + 1}起点`);
      const end = numberDraft(axis.upper, `坐标${index + 1}终点`);
      if (axis.rangeDriver === 'step' && numberDraft(axis.step ?? '', `坐标${index + 1}步长`) <= 0) throw Error('扫描步长须大于零。');
      const points = numberDraft(axis.points, `坐标${index + 1}点数`);
      if (!Number.isSafeInteger(points) || points < 2 || start === end) throw Error('扫描坐标需要至少两点及不同的起止值。');
      includeCoordinates(definitions);
      return { ...(expression.coordinateId ? { coordinateId: expression.coordinateId } : {}), expression: expression.wire, start, end, points, name: axis.name, unit: expression.unit };
    });
    if (!Number.isSafeInteger(axes.reduce((product, axis) => product * axis.points, 1))) throw Error('扫描总点数超出整数表示范围。');
    parameters.axes = axes;
  }
  if (card && pathProduct) {
    parameters.product = pathWireStructure(pathProduct);
    const beads = Number(parameters.beads);
    if (card.keys.length > beads - 2) throw Error('珠子数量不足以容纳已选关键构型。');
    let previous = 1;
    parameters.keyframes = card.keys.map((key, index) => {
      const geometry = card.slots[key.id];
      if (!geometry) throw Error(`请选择第${index + 1}个关键构型。`);
      const position = key.position.trim() ? numberDraft(key.position, '关键构型位置') : 'auto';
      if (position !== 'auto') {
        if (!Number.isSafeInteger(position) || position <= previous || position >= beads) throw Error('关键构型的显式珠子位置须按列表严格递增，且位于两端之间。');
        previous = position;
      }
      return { position, structure: pathWireStructure(orderedPathStructure(source.structure, geometry.structure, `关键构型${index + 1}`)) };
    });
  }
  if (operation === 'ts' && algorithm === 'climb') {
    const reaction = prepareExpression(group.ts.reaction, source.structure, constraints);
    parameters.expression = reaction.expression.wire;
    if (reaction.expression.coordinateId) parameters.coordinateId = reaction.expression.coordinateId;
    includeCoordinates(reaction.coordinates);
  }
  const inherited = !card ? pesSourceFfModel(group, source) : undefined;
  const ffModel = method.method === 'gfnff' ? (pesFfModelMatches(inherited, source.structure, electronic.charge, electronic.multiplicity, solvation)
    ? structuredClone(inherited) : createPesFfModel(identity.runId, source.structure, electronic.charge, electronic.multiplicity, solvation)) : undefined;
  return { schema: PES_SCHEMA, id: identity.runId, sourceDocumentId: source.documentId, runIdentity: identity, operation, algorithm: calculationAlgorithm,
    method: method.method, structure: { ...source.structure, ...electronic }, charge: electronic.charge, uhf: electronic.multiplicity - 1,
    ...(solvation ? { solvation } : {}), ...(ffModel ? { ffModel } : {}), constraints, coordinates: [...coordinates.values()], parameters };
}

function pathWireStructure(structure: Structure): Structure {
  const { id, name, format, charge, multiplicity, dimension, cell } = structure;
  return { id, name, format, charge, multiplicity, notes: [], ...(dimension ? { dimension } : {}), ...(cell ? { cell } : {}),
    atoms: structure.atoms.map(({ id, element, x, y, z }) => ({ id, element, x, y, z })) };
}
