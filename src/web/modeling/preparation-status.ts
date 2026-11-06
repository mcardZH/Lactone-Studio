import type { Structure } from '../../core/types';

/** Construction notices are visible, but are never re-labelled as force-field
 * convergence or a physical observation. Keep the existing footer compact. */
export function preparationPortNotice(structure: Structure): string {
  const status = structure.preparation?.status;
  if (typeof status !== 'string') return '';
  const start = status.indexOf('端口提示：');
  return start < 0 ? '' : status.slice(start).trim().slice(0, 1200);
}
