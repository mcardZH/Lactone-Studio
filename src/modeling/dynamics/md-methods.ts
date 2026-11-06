import type { Structure } from '../../core/types';
import { NATIVE_CONFORMER_CORE_PROTECTION, getConformerSamplingCapability } from '../advanced/sampling-contracts';
import type { MDMethod } from './contracts';

/** Preflight presentation only. Never mutates the editor's freeze definitions. */
export function getMDProtectionInfo(structure: Structure, method: MDMethod, movableAtomIds: readonly string[]) {
  const native = method.startsWith('gfn');
  const selected = structure.atoms.map(atom=>atom.id!).filter(id=>!movableAtomIds.includes(id));
  const capability = native ? getConformerSamplingCapability({ operation:'md', method:method as 'gfnff'|'gfn0'|'gfn1'|'gfn2' }) : undefined;
  return {
    native, protectedAtomIds:selected, requiresConfirmation:native && selected.length >= 2,
    allowed:!native || selected.length !== 1,
    reason:native && selected.length === 1 ? 'GFN相对距离保护至少需要2个冻结原子；请增加冻结原子，或改用MMFF/UFF。' : undefined,
    message:native && selected.length >= 2 ? `本次GFN MD将${selected.length}个冻结原子按构象搜索的相对距离势保护，允许整体平移和转动；原编辑冻结定义保留。` : undefined,
    dtFs:native ? NATIVE_CONFORMER_CORE_PROTECTION.dtFs : 1,
    thermostat:native ? 'Berendsen' as const : 'Langevin' as const,
    hydrogenMassAmu:method === 'gfnff' ? 4 : null,
    shakeHydrogenBonds:capability?.shakeDefaultEnabled ?? false,
    forceConstantKJMolNm2:native && selected.length >= 2 ? NATIVE_CONFORMER_CORE_PROTECTION.forceConstantKJMolNm2 : undefined,
  };
}
