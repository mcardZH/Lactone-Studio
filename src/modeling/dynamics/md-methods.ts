import type { Structure } from '../../core/types';
import { isXtbMethod, supportsXtbOperation } from '../../core/xtb-capabilities';
import type { MDMethod } from './contracts';

/** Preflight presentation only. Never mutates the editor's freeze definitions. */
export function getMDProtectionInfo(structure: Structure, method: MDMethod, movableAtomIds: readonly string[]) {
  const native = isXtbMethod(method), periodic=Boolean(structure.cell);
  const selected = periodic&&native?[]:structure.atoms.map(atom=>atom.id!).filter(id=>!movableAtomIds.includes(id));
  const reason=periodic&&!supportsXtbOperation(method,'md',true)?'周期MD需选择支持固定晶胞的GFN方法。':native&&selected.length===1?'相对距离保护至少需要2个冻结原子；请增加冻结原子，或改用MMFF/UFF。':undefined;
  return {
    native, protectedAtomIds:selected, requiresConfirmation:native && selected.length >= 2,
    allowed:!reason,
    reason,
    message:native && selected.length >= 2 ? `本次GFN MD将${selected.length}个冻结原子按构象搜索的相对距离势保护，允许整体平移和转动；原编辑冻结定义保留。` : undefined,
    dtFs:native ? 2 : 1,
    thermostat:native ? 'Berendsen' as const : 'Langevin' as const,
    hydrogenMassAmu:method === 'gfnff' ? 4 : null,
    shakeHydrogenBonds:native&&method!=='gfnff',
    forceConstantKJMolNm2:native && selected.length >= 2 ? 500000 : undefined,
  };
}
