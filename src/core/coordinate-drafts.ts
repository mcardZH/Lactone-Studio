import type { GaussianSettings, InternalCoordinate, Structure, Vector3 } from './types';
import { coordinateAction, coordinateAtoms, constraintsEnabled } from './tasks';

/** Display-only image projection. Callers still reject unsupported periodic execution. */
export function coordinateImagePreview(structure:Structure,atomIds:readonly string[],images?:readonly Vector3[]):Structure {
  if(!images)return structure;
  if(images.length!==atomIds.length||images.some(image=>image.length!==3||image.some(value=>!Number.isSafeInteger(value))))throw new Error('内坐标周期镜像身份无效。');
  if(!images.some(image=>image.some(Boolean)))return structure;
  if(!structure.cell)throw new Error('周期镜像缺少真实晶胞。');
  const offsets=new Map(atomIds.map((id,index)=>[id,images[index]]));
  const cell=structure.cell;
  return {...structure,atoms:structure.atoms.map(atom=>{
    const image=offsets.get(atom.id??'');if(!image)return atom;
    if(image.some((value,axis)=>value!==0&&!cell.pbc[axis]))throw new Error('内坐标镜像超出实际周期轴。');
    const delta=[0,1,2].map(axis=>image.reduce((sum,value,i)=>sum+value*cell.vectors[i][axis],0));
    return {...atom,x:atom.x+delta[0],y:atom.y+delta[1],z:atom.z+delta[2]};
  })};
}

/** Editable text remains a draft until a complete, enabled row can be resolved. */
export interface CoordinateDraft {
  id: string;
  objectId?:string;
  type: 'B' | 'A' | 'D';
  action: 'scan' | 'freeze';
  atomText: string;
  stepsText: string;
  incrementText: string;
  enabled: boolean;
}

export function resolveCoordinateDrafts(settings: GaussianSettings): { coordinates: InternalCoordinate[]; errors: string[] } {
  const options = settings.taskOptions;
  if (options?.coordinateDrafts === undefined) return {
    coordinates: (options?.coordinates ?? []).filter(coordinate => coordinateAction(coordinate, settings.task) === 'scan' ? settings.task === 'scan' : constraintsEnabled(settings)),
    errors: [],
  };
  const coordinates: InternalCoordinate[] = [], errors: string[] = [];
  for (const draft of options.coordinateDrafts) {
    if (!draft.enabled || (draft.action === 'scan' ? settings.task !== 'scan' : !constraintsEnabled(settings))) continue;
    try {
      const atoms = coordinateAtoms(draft.atomText), count = { B: 2, A: 3, D: 4 }[draft.type];
      if (atoms.length !== count || new Set(atoms).size !== count) throw new Error(`请按顺序填写${count}个不同的原子编号。`);
      let steps = 1, increment: number | null = null;
      if (draft.action === 'scan') {
        if (!draft.stepsText.trim()) throw new Error('请填写扫描增量次数。');
        steps = Number(draft.stepsText);
        if (!Number.isSafeInteger(steps) || steps < 1) throw new Error('扫描增量次数须为可精确表示的正整数。');
        const text = draft.incrementText.trim() || (settings.method === 'gfn2-xtb' ? draft.type === 'B' ? '0.05' : '5' : '');
        if (!text) throw new Error('请填写扫描增量。');
        increment = Number(text);
        if (!Number.isFinite(increment) || increment === 0) throw new Error('扫描增量须为非零有限数值。');
      }
      coordinates.push({ type: draft.type, atoms, action: draft.action, steps, increment,...(draft.objectId?{objectId:draft.objectId}:{}) });
    } catch (reason) {
      errors.push(`内坐标草稿 ${draft.id}：${reason instanceof Error ? reason.message : '内容不完整。'}`);
    }
  }
  return { coordinates, errors };
}
