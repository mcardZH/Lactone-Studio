import type { Structure, Vector3 } from '../../core/types';
import { isXtbMethod, supportsXtbOperation } from '../../core/xtb-capabilities';
import { builderCoordinateValue } from '../../core/builder-geometry';
import { isPeriodic, minimumImage } from '../../core/periodic';
import type { ModelCoordinate } from '../contracts';
import type { MDHydrogenSettings, MDIntegrator, MDMethod } from './contracts';

export function supportsMDIntegrator(method: string, periodic: boolean, integrator?: MDIntegrator): boolean {
  if (integrator === 'ase') return isXtbMethod(method) && method !== 'gxtb';
  if (integrator === 'xtb' && periodic) return false;
  return supportsXtbOperation(method, 'md', periodic);
}

export function mdHydrogenSettings(method: MDMethod, enabled = false): MDHydrogenSettings {
  const shakeHydrogenBonds = method !== 'gfnff' && enabled;
  return { shakeHydrogenBonds, hydrogenMassAmu: shakeHydrogenBonds ? 1 : 4 };
}

/** Match the editor's current image choice, then hold that branch for the run. */
export function resolveMDConstraint(structure:Structure, row:ModelCoordinate):ModelCoordinate {
  let images = row.images;
  if (isPeriodic(structure) && !images) {
    const indices = row.atomIds.map(id=>structure.atoms.findIndex(atom=>atom.id===id));
    images = [[0,0,0]];
    for (let i=1; i<indices.length; i++) {
      const from = indices[i-1], to = indices[i];
      const bond = structure.bonds?.find(b=>b.a===from&&b.b===to || b.b===from&&b.a===to);
      const shift = bond?.image?.map(n=>bond.a===from?n:-n) ?? minimumImage(structure,from,to).image;
      images.push(images[i-1].map((n,axis)=>n+shift[axis]) as Vector3);
    }
  }
  return {...row,...(images?{images}:{}),value:row.value??builderCoordinateValue(structure,row.type,row.atomIds,images)};
}

/** Preflight presentation only. Never mutates the editor's freeze definitions. */
export function getMDProtectionInfo(structure: Structure, method: MDMethod, movableAtomIds: readonly string[], integrator?: MDIntegrator) {
  const periodic=isPeriodic(structure);
  const selected = periodic||integrator==='ase'?[]:structure.atoms.map(atom=>atom.id!).filter(id=>!movableAtomIds.includes(id));
  const reason=!supportsMDIntegrator(method,periodic,integrator)?'所选方法与积分器不支持当前模型。':selected.length===1?'相对距离保护至少需要两个原子。':undefined;
  return {
    native:integrator!=='ase', protectedAtomIds:selected, requiresConfirmation:selected.length >= 2,
    allowed:!reason,
    reason,
    message:selected.length >= 2 ? `本次GFN MD将${selected.length}个冻结原子按构象搜索的相对距离势保护，允许整体平移和转动；原编辑冻结定义保留。` : undefined,
    dtFs:2,
    thermostat:integrator==='ase'?'Bussi' as const:'Berendsen' as const,
    hydrogenMassAmu:method === 'gfnff' ? 4 : null,
    shakeHydrogenBonds:method!=='gfnff',
    forceConstantKJMolNm2:selected.length >= 2 ? 500000 : undefined,
  };
}
