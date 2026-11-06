import type { Structure } from '../../core/types';
import type { ModelCommand } from '../contracts';

/** Default pointer-tool intent only. Explicit graft commands and first/new
 * document placement keep their own semantics. Shared viewports call this at
 * the same authoritative workspace boundary as the main viewport. */
export function defaultPlacementCommand(structure: Structure, command: ModelCommand): ModelCommand {
  if (!structure.atoms.length || !structure.cell?.pbc.some(Boolean) || !['place-element', 'place-fragment'].includes(command.type)) return command;
  if (command.type !== 'place-element' && command.type !== 'place-fragment') return command;
  const { targetAtomId: _atom, targetPortId: _port, ...independent } = command;
  return independent;
}
