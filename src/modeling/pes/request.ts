import { baseElectronicStateParameterError as baseElectronicStateError } from '../../core/base-electronic-state';
import { pesElectronicConfirmed } from './input-state';
import type { Structure } from '../../core/types';
import type { SharedModelConstraints } from '../../core/modeling/contracts';
import { supportsXtbAlpb } from '../../core/xtb-capabilities';
import { confirmCoordinateSelection } from '../application/coordinate-selection';
import { modelCoordinateKey } from '../constraints';
import { PES_SCHEMA, type PesCard, type PesCoordinate, type PesExpressionDraft, type PesGeometry, type PesGroup,
  type PesMethodDraft, type PesParameters, type PesRequest, type PesRunIdentity } from './contracts';
import { defaultParameters, effectivePesPathParameters, legacyDefaultParameters, parameterVisible, pesParameterSections, usesPesExecutionProfile, isSellaTsAlgorithm, type PesParameterField } from './defaults';
import { compilePesExpression, scanAxisDefinition } from './expressions';
import { resolveScanSource } from './scan-source';
import { createPesFfModel, pesFfModelMatches, pesSourceFfModel } from './ff-model';

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
  if (draft.executionProfile !== undefined && !usesPesExecutionProfile(draft)) throw Error('此计算设置的执行版本暂不受支持，原草稿已保留。');
  const current = usesPesExecutionProfile(draft) || algorithm === 'sella-scan';
  const merged = { ...(current ? defaultParameters(algorithm) : legacyDefaultParameters(algorithm)), ...effectivePesPathParameters(algorithm, draft) };
  if (draft.pathSemantics === undefined) delete merged.pathSemantics;
  const parameters: Record<string, unknown> = {};
  for (const { fields } of pesParameterSections(algorithm, merged)) for (const field of fields) {
    if ((method === 'gfn0' || method === 'gfnff') && ['electronicTemperatureK', 'maxSccIterations'].includes(field.key)) continue;
    if ((allowed && !allowed.has(field.key)) || !parameterVisible(field.key, merged)) continue;
    const value = parameterValue(field, merged[field.key]);
    if (value !== undefined) parameters[field.key] = value;
  }
  if (current && !allowed) {
    parameters.executionProfile = merged.executionProfile;
    parameters.accuracy = parameterValue({ key: 'accuracy', label: '电子结构精度', initial: '0.1', minimum: 0, exclusiveMinimum: true }, merged.accuracy);
    if (method !== 'gfn0' && method !== 'gfnff') {
      parameters.electronicTemperatureK = parameterValue({ key: 'electronicTemperatureK', label: '电子温度', initial: '300', minimum: 0 }, merged.electronicTemperatureK);
      parameters.maxSccIterations = parameterValue({ key: 'maxSccIterations', label: 'SCC迭代上限', initial: '250', minimum: 1, integer: true }, merged.maxSccIterations);
    }
    if (isSellaTsAlgorithm(algorithm) || algorithm === 'sella-scan') {
      if (merged.coordinateSystem !== 'xyz' && merged.coordinateSystem !== 'ric') throw Error('请选择有效的Sella坐标系。');
      if (!['loose', 'medium', 'tight', 'custom'].includes(String(merged.convergencePreset))) throw Error('请选择有效的收敛标准。');
      parameters.coordinateSystem = merged.coordinateSystem;
      parameters.convergencePreset = merged.convergencePreset;
    }
    if (algorithm === 'ci-neb') {
      if (merged.nebOptimizer !== 'fire2' && merged.nebOptimizer !== 'fire') throw Error('请选择有效的路径优化器。');
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
  if (structure.dimension === 2 || structure.periodicSource || structure.cell?.pbc.some(Boolean)) throw Error('请选择非周期的真实三维分子结构。');
  if (!structure.atoms.length || structure.atoms.some(atom => !atom.id || ![atom.x, atom.y, atom.z].every(Number.isFinite)))
    throw Error('所选结构缺少原子、稳定身份或有效的三维坐标。');
  if (new Set(structure.atoms.map(atom => atom.id)).size !== structure.atoms.length) throw Error('所选结构含重复原子身份。');
}

export function resolvePesConstraintTarget(raw:string|undefined,type:PesCoordinate['type'],fallback:number,label='约束目标'):number{
  const value=raw?.trim()?numberDraft(raw,label):fallback;
  if(!Number.isFinite(value)||type==='B'&&value<=0||type==='A'&&(value<=0||value>=180))throw Error(`${label}超出允许范围。`);
  return value;
}
/** Shared by the PES request and the modeling preoptimization handoff. */
export function resolvePesConstraintDefinitions(group:Pick<PesGroup,'constraints'|'constraintTargets'>,structure:Structure):SharedModelConstraints{
  if(group.constraints.enabled===false)return group.constraints;
  const { frozenAtomIds, coordinates } = group.constraints;
  const ids = new Set(structure.atoms.map(atom => atom.id));
  if (frozenAtomIds.some(id => !ids.has(id))) throw Error('所选结构缺少全局冻结定义中的原子，请修改该定义或改选来源。');
  return { ...group.constraints, frozenAtomIds: [...frozenAtomIds], coordinates: coordinates.filter(row => row.action === 'freeze').map((row, index) => {
    if (row.images?.some(image => image.some(value => value !== 0))) throw Error('本任务的全局内坐标约束不支持跨周期映像。');
    const measured = confirmCoordinateSelection(structure, row.atomIds);
    if (measured.type !== row.type) throw Error('全局约束的原子与内坐标类型不匹配。');
    const draft = group.constraintTargets?.[row.id ?? modelCoordinateKey(row)];
    const value=resolvePesConstraintTarget(draft,row.type,draft===undefined?row.value??measured.value:measured.value,`全局约束目标${index+1}`);
    return {...row,atomIds:[...row.atomIds],value};
  }) };
}
function prepareConstraints(group: PesGroup, structure: Structure): PesRequest['constraints'] {
  const resolved=resolvePesConstraintDefinitions(group,structure);
  if(resolved.enabled===false)return {frozenAtomIds:[],coordinates:[]};
  return {frozenAtomIds:resolved.frozenAtomIds,coordinates:resolved.coordinates.map((row,index)=>({
    id:row.id&&/^[A-Za-z0-9_-]{1,100}$/.test(row.id)?row.id:`global-coordinate-${index+1}`,
    type:row.type,atomIds:row.atomIds,value:row.value!,
  }))};
}

function prepareExpression(draft: PesExpressionDraft, source: Structure, constraints: PesRequest['constraints']) {
  const expression = compilePesExpression(draft, source);
  const coordinates = draft.coordinates.filter(row => expression.coordinateIds.has(row.id)).map(({ id, name, type, atomIds }) => ({ id, name, type, atomIds }));
  const frozen = new Set(constraints.frozenAtomIds);
  const fixed = new Set(constraints.coordinates.map(modelCoordinateKey));
  if (coordinates.every(row => row.atomIds.every(id => frozen.has(id)) || fixed.has(modelCoordinateKey(row))))
    throw Error('内坐标表达式引用的定义均被全局冻结或内坐标约束固定。请调整相关定义。');
  return { expression, coordinates };
}

export function cardSource(group: PesGroup, card: PesCard): PesGeometry {
  if (card.kind === 'scan') return resolveScanSource(group, card);
  const slot = card.kind === 'path' ? 'reactant' : 'start';
  if (!card.slots[slot] && card.requiredSlots?.includes(slot)) throw Error('请重新记录或选择起始结构。');
  return card.slots[slot] ?? group.nodes.find(node => node.id === group.initialNodeId)!.geometry;
}

export function pesPathStructureIssue(source: Structure, target: Structure, name: string): string | undefined {
  try { validateStructure(target); } catch (error) { return `${name}：${error instanceof Error ? error.message : String(error)}`; }
  if (source.atoms.length !== target.atoms.length) return `${name}与反应物的原子数不同。`;
  const index = source.atoms.findIndex((atom, index) => atom.element !== target.atoms[index].element);
  if (index >= 0) return `${name}第${index + 1}个原子的元素与反应物不同（${target.atoms[index].element} / ${source.atoms[index].element}）。`;
}

function orderedPathStructure(source: Structure, target: Structure, name: string): Structure {
  const issue = pesPathStructureIssue(source, target, name);
  if (issue) throw Error(issue);
  // Display order is the scientific correspondence. Stable IDs and legacy maps
  // must never sort or permute an endpoint; normalize only this run-owned copy.
  return { ...target, atoms: target.atoms.map((atom, index) => ({ ...atom, id: source.atoms[index].id })) };
}

export function preparePesRequest(group: PesGroup, identity: PesRunIdentity, source: PesGeometry,
  input: { card: PesCard } | { operation: 'ts' | 'hessian' }): PesRequest {
  if ('card' in input && input.card.kind === 'explore') throw Error('单端反应探索已停用，已有结果仍可查看和导出。');
  validateStructure(source.structure);
  const electronic = group.electronic.confirmed;
  if (!electronic || !pesElectronicConfirmed(group, source)) throw Error('请先确定本次输入结构的电荷和自旋多重度。');
  const electronicIssue = baseElectronicStateError(source.structure, electronic);
  if (electronicIssue) throw Error(electronicIssue);
  const card = 'card' in input ? input.card : undefined;
  const operation = 'card' in input ? input.card.kind : input.operation;
  const draft = card ?? group.ts;
  const method: PesMethodDraft = draft.method;
  if (method.solvationModel !== 'none' && (method.solvationModel !== 'alpb' || !supportsXtbAlpb(method.method, method.solvent)))
    throw Error('当前计算级别不支持所选溶剂，请改选气相或可用的ALPB溶剂。');
  const solvation = method.solvationModel === 'alpb' ? { model: 'alpb' as const, solvent: method.solvent } : undefined;
  const constraints = prepareConstraints(group, source.structure);
  const { algorithm } = draft;
  const inputParameters = draft.parametersByAlgorithm[algorithm] ?? {};
  const parameters = compileParameters(algorithm, operation === 'ts' && usesPesExecutionProfile(inputParameters) && isSellaTsAlgorithm(algorithm)
    ? { ...inputParameters, coordinateSystem: group.ts.sellaCoordinateSystem ?? inputParameters.coordinateSystem ?? 'xyz' } : inputParameters,
    operation === 'hessian' ? new Set(['maxSccIterations']) : undefined, method.method);
  const coordinates = new Map<string, PesCoordinate>();
  function includeCoordinates(definitions: readonly PesCoordinate[]) {
    for (const definition of definitions) {
      const old = coordinates.get(definition.id);
      if (old && (old.type !== definition.type || old.atomIds.some((id, index) => definition.atomIds[index] !== id))) throw Error('同一内坐标身份存在冲突定义。');
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
  if (operation === 'path' && card) {
    const product = card.slots.product;
    if (!product) throw Error('请选择产物结构或记录产物快照。');
    parameters.product = pathWireStructure(orderedPathStructure(source.structure, product.structure, '产物'));
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
  return { schema: PES_SCHEMA, id: identity.runId, sourceDocumentId: source.documentId, runIdentity: identity, operation, algorithm: operation === 'hessian' ? 'numeric' : algorithm,
    method: method.method, structure: { ...source.structure, ...electronic }, charge: electronic.charge, uhf: electronic.multiplicity - 1,
    ...(solvation ? { solvation } : {}), ...(ffModel ? { ffModel } : {}), constraints, coordinates: [...coordinates.values()], parameters };
}

function pathWireStructure(structure: Structure): Structure {
  const { id, name, format, charge, multiplicity, dimension } = structure;
  return { id, name, format, charge, multiplicity, notes: [], ...(dimension ? { dimension } : {}),
    atoms: structure.atoms.map(({ id, element, x, y, z }) => ({ id, element, x, y, z })) };
}
