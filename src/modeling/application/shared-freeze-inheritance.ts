import type { SharedModelConstraints } from '../contracts';

/** Task-local consumer policy. Omitted flags retain legacy inheritance; this
 * projection never changes the model's freezes or the engine-private rows. */
export function inheritedSharedFreezes(shared: SharedModelConstraints | undefined, policy?: { atoms?: boolean; coordinates?: boolean }): SharedModelConstraints | undefined {
  if(shared?.enabled===false)return {...shared,frozenAtomIds:[],coordinates:[]};
  if (!shared || policy?.atoms !== false && policy?.coordinates !== false) return shared;
  return {
    frozenAtomIds: policy?.atoms === false ? [] : shared.frozenAtomIds,
    coordinates: policy?.coordinates === false ? [] : shared.coordinates,
  };
}
