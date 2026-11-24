import type { Structure } from '../../core/types';
import type { ModelCommand } from '../contracts';

/** Default placement in a nonempty periodic model. An explicit element
 * connection on H/a port and the one-H tool keep their target. Ordinary
 * fragments still enter the target cell independently. */
export function defaultPlacementCommand(structure: Structure, command: ModelCommand): ModelCommand {
  if (!structure.atoms.length || !structure.cell?.pbc.some(Boolean)) return command;
  if (command.type !== 'place-element' && command.type !== 'place-fragment') return command;
  if (command.type === 'place-element') {
    if (command.targetPortId) return command;
    if (command.targetAtomId) {
      const hit = structure.atoms.find(atom => atom.id === command.targetAtomId);
      if (!hit || hit.element === 'H' || command.element === 'H') return command;
    }
  }
  const { targetAtomId: _atom, targetPortId: _port, ...independent } = command;
  return independent;
}
