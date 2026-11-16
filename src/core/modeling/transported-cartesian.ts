import type { Atom } from '../types';

const axes = ['x', 'y', 'z'] as const;

/** Accept a fixed atom across a numeric transport that can lose the sign of zero. */
export function acceptTransportedFixedAtom(reference: Atom, received: Atom): Atom | null {
  if (reference.id !== received.id || reference.element !== received.element ||
      axes.some(axis => !Number.isFinite(received[axis]) || received[axis] !== reference[axis])) return null;
  if (axes.every(axis => Object.is(received[axis], reference[axis]))) return received;
  return { ...received, x: reference.x, y: reference.y, z: reference.z };
}
