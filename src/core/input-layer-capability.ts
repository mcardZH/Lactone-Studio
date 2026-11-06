import type { BuilderAssignment } from './builder-draft';
import type { InputLayerDraftRole, Structure } from './types';

export const inputLayerPrefix = (engine: 'gaussian' | 'orca') => `input-layer-${engine}-`;
export type InputLayerDraftRoleResult={status:'none'}|{status:'valid';role:InputLayerDraftRole}|{status:'invalid';error:string};
export function getInputLayerDraftRole(layer:BuilderAssignment):InputLayerDraftRoleResult{
  if(!layer||typeof layer!=='object'||Array.isArray(layer))return {status:'invalid',error:'输入区域草稿声明必须是对象。'};
  if(layer.draftRole!==undefined){
    const role=layer.draftRole as unknown;
    if(!role||typeof role!=='object'||Array.isArray(role))return {status:'invalid',error:'输入区域草稿角色元数据形状无效。'};
    const r=role as Record<string,unknown>;
    if(r.type!=='input-layer'||!['gaussian','orca'].includes(r.engine as string)||!['active','cleared'].includes(r.state as string)||Object.keys(r).some(key=>!['type','engine','state'].includes(key)))return {status:'invalid',error:'输入区域草稿角色元数据的类型、引擎或状态无效。'};
    return {status:'valid',role:{type:'input-layer',engine:r.engine as InputLayerDraftRole['engine'],state:r.state as InputLayerDraftRole['state']}};
  }
  const legacy=typeof layer.id==='string'?layer.id.match(/^input-layer-(gaussian|orca)-(.+)$/):null;
  if(legacy)return {status:'valid',role:{type:'input-layer',engine:legacy[1] as InputLayerDraftRole['engine'],state:legacy[2]==='empty'&&Array.isArray(layer.atomIds)&&layer.atomIds.length===0?'cleared':'active'}};
  if(typeof layer.id==='string'&&layer.id.startsWith('input-layer-'))return {status:'invalid',error:'旧输入区域草稿身份缺少明确引擎或行标识。'};
  return {status:'none'};
}
export const isInputLayerDraft = (layer: BuilderAssignment) => getInputLayerDraftRole(layer).status!=='none';
export function isInputLayerDraftForEngine(layer:BuilderAssignment,engine:InputLayerDraftRole['engine']):boolean{
  const result=getInputLayerDraftRole(layer);return result.status==='invalid'||result.status==='valid'&&result.role.engine===engine;
}
export function isEmptyInputLayerDraft(layer:BuilderAssignment):boolean{
  const result=getInputLayerDraftRole(layer);return result.status==='valid'&&result.role.state==='cleared';
}
export function migrateInputLayerDraft<T extends BuilderAssignment>(layer:T):T{
  const result=getInputLayerDraftRole(layer);return layer.draftRole===undefined&&result.status==='valid'?{...layer,draftRole:result.role}:{...layer};
}
/** Called only by an explicit draft edit. An untouched legacy [] remains legacy;
 * deletion of the final draft row is represented, rather than silently forgotten. */
export function editInputLayerDrafts(engine:'gaussian'|'orca',layers:BuilderAssignment[]):BuilderAssignment[]{
  const rows=layers.filter(layer=>!isEmptyInputLayerDraft(layer)).map(layer=>getInputLayerDraftRole(layer).status==='none'?{...layer,draftRole:{type:'input-layer' as const,engine,state:'active' as const}}:migrateInputLayerDraft(layer));
  return rows.length?rows:[{id:inputLayerPrefix(engine)+'empty',kind:'qm',label:'草稿已清空，尚未定义',atomIds:[],draftRole:{type:'input-layer',engine,state:'cleared'}}];
}
/** Explicit abandonment restores scientific memberships, not the source's stale
 * UI draft metadata. No method, state, or atom coordinate is changed. */
export function structureWithoutInputLayerDrafts(structure:Structure|null,engine:'gaussian'|'orca'):Structure|null{
  return structure?{...structure,modelLayers:structure.modelLayers?.filter(layer=>!isInputLayerDraftForEngine(layer,engine))}:null;
}
export function inputLayerPartition(structure: Structure | null, layers: BuilderAssignment[],engine?:InputLayerDraftRole['engine']): { error: string | null; qmAtomIds: string[] } {
  const fail = (error: string) => ({ error, qmAtomIds: [] });
  if (!structure?.atoms.length) return fail('请先提供结构。');
  for(const layer of layers){const result=getInputLayerDraftRole(layer);if(result.status==='invalid')return fail(result.error);if(result.status==='valid'&&engine&&result.role.engine!==engine)return fail('区域草稿属于另一引擎，请保留来源范围，不会自动转换为当前科学分区。');}
  if(layers.some(isEmptyInputLayerDraft))return fail('草稿已清空，尚未定义；请新建区域，或显式放弃草稿以使用现有科学分区。');
  const known = new Set(structure.atoms.map(atom => atom.id));
  if (known.has(undefined) || known.size !== structure.atoms.length) return fail('模型原子身份缺失或重复。');
  const seen = new Set<string>(), rows = new Set<string>(), qmAtomIds: string[] = [];
  for (const layer of layers) {
    if(!Array.isArray(layer.atomIds))return fail('区域原子成员声明必须是数组。');
    if (!layer.id || rows.has(layer.id)) return fail('区域身份缺失或重复。');
    rows.add(layer.id);
    if (layer.kind !== 'qm' && layer.kind !== 'mm') return fail('中间层或未明确理论层目前仅保留草稿，不支持生成输入。');
    if (!layer.atomIds.length) return fail('区域尚未指定原子，请选择或删除空区域。');
    for (const id of layer.atomIds) {
      if (!known.has(id)) return fail('区域引用的原子已失效，请重新选择。');
      if (seen.has(id)) return fail('区域原子重叠，请明确每个原子的唯一分区。');
      seen.add(id);
      if (layer.kind === 'qm') qmAtomIds.push(id);
    }
  }
  if (!qmAtomIds.length || !layers.some(layer => layer.kind === 'mm')) return fail('当前两层输入需要明确 QM 高层和低层区域。');
  if (seen.size !== known.size) return fail('还有未分配原子，请显式选择剩余原子的区域，不会自动归入 MM。');
  return { error: null, qmAtomIds };
}

/** Draft geometry groups are not independent scientific theory layers. Mapping
 * must be an explicit user action under the existing common high-level settings. */
export function inputLayerCapabilityError(structure: Structure | null, layers: BuilderAssignment[], scientific: { enabled: boolean; qmAtomIds: string[]; engine?:InputLayerDraftRole['engine'] }): string | null {
  if (!layers.some(isInputLayerDraft)) return null;
  const partition = inputLayerPartition(structure, layers,scientific.engine);
  if (partition.error) return partition.error;
  if (!scientific.enabled) return '区域草稿已保留，请先明确启用当前引擎受支持的两层计算设置。';
  const actual = new Set(scientific.qmAtomIds);
  if (actual.size !== scientific.qmAtomIds.length || actual.size !== partition.qmAtomIds.length || partition.qmAtomIds.some(id => !actual.has(id)))
    return '区域草稿与科学 QM 集合尚未一致，请显式映射到当前同一高层，或修改草稿。';
  return null;
}
