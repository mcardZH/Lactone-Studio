'use strict';
const { inspectWriterOwners } = require('./task-system/platform/process-identity.cjs');

function createStorageOwnerIdentity(inspect = inspectWriterOwners) {
  async function snapshot(pids) {
    return Promise.resolve().then(() => inspect(pids)).catch(() => null);
  }
  let self;
  return {
    snapshot,
    current() {
      return self ??= snapshot([process.pid]).then(state => {
        const record = state?.processes?.find(row => row.pid === process.pid && row.status === 'alive');
        return record && state.hostId && state.bootId && record.creationFileTime
          ? { hostId: state.hostId, bootId: state.bootId, creationFileTime: record.creationFileTime }
          : undefined;
      });
    }
  };
}

function ownerState(record, state) {
  const identity = record.ownerIdentity;
  if (!identity?.hostId || !identity?.bootId || !/^\d+$/.test(identity?.creationFileTime ?? '') || !state?.hostId || !state?.bootId) return 'unknown';
  if (identity.hostId !== state.hostId) return 'foreign';
  if (identity.bootId !== state.bootId) return 'dead';
  const live = state.processes?.find(row => row.pid === record.pid);
  if (live?.status === 'alive' && /^\d+$/.test(live.creationFileTime ?? ''))
    return live.creationFileTime === identity.creationFileTime ? 'alive' : 'dead';
  return live?.status === 'dead' ? 'dead' : 'unknown';
}

module.exports = { createStorageOwnerIdentity, storageOwnerIdentity: createStorageOwnerIdentity(), ownerState };
