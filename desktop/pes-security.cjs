'use strict';

const { isDeepStrictEqual } = require('node:util');
const { assert, plain, string, validateStructure } = require('./security.cjs');
const { sessionIdentity, SOLVATION_SOLVENTS } = require('./xtb-security.cjs');

const SCHEMA = 'es-pes/v1';
const ALGORITHMS = new Map([
  ['scan', new Set(['slsqp', 'sella-scan'])],
  ['ts', new Set(['prfo', 'rfo', 'qn', 'dimer', 'climb'])],
  ['hessian', new Set(['numeric'])],
  ['path', new Set(['ci-neb', 'de-gsm', 'fsm'])],
]);
const ELEMENTS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn'.split(' ');
const COUNTS = new Map([['B', 2], ['A', 3], ['D', 4]]);
const FRAME_STATUSES = new Set(['accepted', 'available', 'candidate', 'completed', 'converged', 'evaluated', 'failed', 'geometry', 'not-converged', 'partial', 'stopped', 'unconverged']);
const RESULT_STATUSES = new Set(['completed', 'partial', 'not-converged', 'stopped', 'failed']);

function requiresResidentLibrary(request) {
  return request?.operation === 'hessian' && ['gfn0', 'gfnff'].includes(request.method) ||
    ['ts', 'scan', 'path'].includes(request?.operation) && (request.method === 'gfnff' ||
      request.parameters?.executionProfile === 'pes-v222' && ['gfn0', 'gfn1', 'gfn2'].includes(request.method));
}

function keys(value, allowed, label) {
  assert(plain(value) && Object.keys(value).every(key => allowed.includes(key)), label);
}

function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

// Validate the complete JSON tree without a byte, node or collection limit.
// Iterative traversal also avoids treating data nesting as JS call depth.
function validateData(root, label, { request = false } = {}) {
  const pending = [root], seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (value === null || ['string', 'boolean'].includes(typeof value)) continue;
    if (typeof value === 'number') {
      assert(Number.isFinite(value), label);
      continue;
    }
    assert(plain(value) || Array.isArray(value), label);
    // Structured clones can share values. The ancestor-only check in the
    // final JSON.stringify rejects cycles while repeated values remain valid.
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) pending.push(value[i]);
    } else {
      for (const key of Object.keys(value)) {
        assert(!['__proto__', 'constructor', 'prototype'].includes(key), label);
        if (request) assert(!/^(?:workspace|runtime|executable|cwd|filePath|command|argv|env|jobRoot)$/i.test(key), label);
        if (!request || value[key] !== undefined) pending.push(value[key]);
      }
    }
  }
  return root;
}

function validateIdentity(value) {
  keys(value, ['groupId', 'taskId', 'runId'], 'Invalid PES run identity');
  for (const field of ['groupId', 'taskId', 'runId']) sessionIdentity(value[field]);
  return value;
}

function validateStructureScope(value) {
  const ids = validateStructure(value);
  assert(ids.size > 0 && value.dimension !== 2 && !value.periodicSource && !value.cell?.pbc.some(Boolean), 'PES requires a complete isolated 3D structure');
  assert(value.atoms.every(atom => ELEMENTS.includes(atom.element)), 'Unsupported PES element');
  return ids;
}

function atomList(value, ids, length) {
  assert(Array.isArray(value) && (length === undefined || value.length === length)
    && value.every(id => ids.has(id)) && new Set(value).size === value.length, 'Invalid PES atom list');
}

function coordinate(row, ids, field) {
  keys(row, ['id', 'type', 'atomIds', field], 'Invalid PES coordinate');
  sessionIdentity(row.id);
  assert(COUNTS.has(row.type), 'Invalid PES coordinate type');
  atomList(row.atomIds, ids, COUNTS.get(row.type));
  if (field === 'name') assert(string(row.name), 'Invalid PES coordinate name');
  else assert(Number.isFinite(row.value) && (row.type !== 'B' || row.value > 0)
    && (row.type !== 'A' || row.value > 0 && row.value < 180), 'Invalid PES coordinate target');
}

function distinctIds(rows, label) {
  assert(new Set(rows.map(row => row.id)).size === rows.length, label);
}

function validateStart(raw) {
  keys(raw, ['schema', 'id', 'runIdentity', 'sourceDocumentId', 'operation', 'algorithm', 'method', 'structure', 'charge', 'uhf',
    'solvation', 'constraints', 'coordinates', 'parameters', 'threads', 'memoryBudgetBytes', 'ffModel'], 'Invalid PES request fields');
  assert(raw.schema === SCHEMA && ALGORITHMS.get(raw.operation)?.has(raw.algorithm), 'PES method is unavailable in this version');
  sessionIdentity(raw.id);
  validateIdentity(raw.runIdentity);
  assert(string(raw.sourceDocumentId), 'Missing PES source document');
  assert(['gfn0', 'gfn1', 'gfn2', 'gfnff'].includes(raw.method), 'Invalid PES electronic method');
  const ids = validateStructureScope(raw.structure);
  const electrons = raw.structure.atoms.reduce((sum, atom) => sum + ELEMENTS.indexOf(atom.element) + 1, 0) - raw.charge;
  assert(Number.isSafeInteger(raw.charge) && integer(electrons) && integer(raw.uhf) && raw.uhf <= electrons
    && (electrons - raw.uhf) % 2 === 0, 'PES charge and spin do not match the source atoms');
  if (raw.method === 'gfnff') validateFfModel(raw.ffModel, raw);
  else assert(raw.ffModel === undefined, 'Unexpected PES force-field model');
  assert((raw.threads === undefined || integer(raw.threads, 1))
    && (raw.memoryBudgetBytes === undefined || integer(raw.memoryBudgetBytes, 1)), 'Invalid requested PES resources');
  if (raw.solvation !== undefined) {
    keys(raw.solvation, ['model', 'solvent'], 'Invalid PES solvation');
    assert(raw.solvation.model === 'alpb' && SOLVATION_SOLVENTS.alpb[raw.method]?.includes(raw.solvation.solvent), 'Unsupported PES method/solvent');
  }
  keys(raw.constraints, ['frozenAtomIds', 'coordinates', 'centroids'], 'Invalid PES constraints');
  atomList(raw.constraints.frozenAtomIds, ids);
  assert(Array.isArray(raw.constraints.coordinates) && Array.isArray(raw.coordinates), 'Invalid PES coordinate collections');
  for (const row of raw.constraints.coordinates) coordinate(row, ids, 'value');
  for (const row of raw.coordinates) coordinate(row, ids, 'name');
  const centroids = raw.constraints.centroids ?? [];
  assert(Array.isArray(centroids), 'Invalid PES centroid constraints');
  for (const row of centroids) {
    keys(row, ['id', 'atomIds', 'value'], 'Invalid PES centroid');
    sessionIdentity(row.id);
    atomList(row.atomIds, ids);
    assert(row.atomIds.length > 0 && (row.value === undefined || finiteVector(row.value, 3)), 'Invalid PES centroid target');
  }
  distinctIds([...raw.constraints.coordinates, ...centroids], 'Duplicate PES constraint identity');
  distinctIds(raw.coordinates, 'Duplicate PES coordinate identity');
  assert(plain(raw.parameters), 'Invalid PES parameters');
  assert(raw.parameters.executionProfile === undefined || raw.parameters.executionProfile === 'pes-v222', 'Unsupported PES execution profile');
  assert(raw.algorithm !== 'sella-scan' || raw.parameters.executionProfile === 'pes-v222', 'Sella scan requires its PES execution profile');
  // Optional fields are omitted from the JSON request. All user values in
  // parameters are finite JSON and remain independent of runtime paths.
  validateData(raw.parameters, 'Invalid PES parameter data', { request: true });
  if (raw.operation === 'path') {
    assert(raw.parameters.keyframes === undefined || Array.isArray(raw.parameters.keyframes), 'Invalid PES path keyframes');
    const endpoints = [raw.parameters.reactant ?? raw.structure, ...(raw.parameters.keyframes ?? []).map(row => row?.structure), raw.parameters.product];
    for (const snapshot of endpoints) {
      const target = validateStructureScope(snapshot);
      assert(target.size === ids.size && snapshot.atoms.every((atom, index) => atom.id === raw.structure.atoms[index].id &&
        atom.element === raw.structure.atoms[index].element), 'PES path atom order changed');
    }
  }
  // Serialize once at the trust boundary. This also rejects cycles and any
  // truly unrepresentable input without limiting legitimate science sizes.
  return JSON.parse(JSON.stringify(raw));
}

function validateFfModel(model, request) {
  keys(model, ['schemaVersion', 'modelId', 'method', 'reference', 'atomOrder', 'parameterIdentity', 'solvation'], 'Invalid PES force-field model');
  assert(model.schemaVersion === 1 && model.method === 'gfnff' && string(model.modelId), 'Invalid PES force-field model identity');
  keys(model.reference, ['atoms', 'charge', 'multiplicity'], 'Invalid PES force-field reference');
  assert(model.reference.charge === request.charge && model.reference.multiplicity === request.uhf + 1, 'PES force-field reference electronic state changed');
  assert(isDeepStrictEqual(model.solvation, request.solvation), 'PES force-field reference solvation changed');
  assert(Array.isArray(model.reference.atoms) && model.reference.atoms.length === request.structure.atoms.length &&
    Array.isArray(model.atomOrder) && model.atomOrder.length === request.structure.atoms.length, 'Invalid PES force-field reference atoms');
  model.reference.atoms.forEach((atom, index) => {
    keys(atom, ['id', 'element', 'x', 'y', 'z'], 'Invalid PES force-field reference atom');
    const current = request.structure.atoms[index];
    assert(atom.id === current.id && atom.element === current.element && model.atomOrder[index] === current.id &&
      [atom.x, atom.y, atom.z].every(Number.isFinite), 'PES force-field reference atom order changed');
  });
  if (model.parameterIdentity !== undefined) {
    assert(plain(model.parameterIdentity), 'Invalid PES force-field parameter identity');
    validateData(model.parameterIdentity, 'Invalid PES force-field parameter identity', { request: true });
  }
}

function frameId(value) { return string(value, 1024) && /^[A-Za-z0-9_.:-]+$/.test(value); }

function validateFrame(frame, request) {
  assert(plain(frame) && frameId(frame.id) && frameId(frame.seriesId) && frameId(frame.phase)
    && frame.id.startsWith(`${request.runIdentity.runId}:${frame.seriesId}:`)
    && integer(frame.step) && FRAME_STATUSES.has(frame.status), 'Invalid PES frame identity/status');
  const atoms = request.structure.atoms;
  assert(Array.isArray(frame.positions) && frame.positions.length === atoms.length
    && frame.positions.every(row => finiteVector(row, 3)), 'Invalid PES frame geometry');
  assert(frame.energyHartree === undefined || frame.energyHartree === null || Number.isFinite(frame.energyHartree), 'Invalid PES frame energy');
  assert(frame.converged === undefined || typeof frame.converged === 'boolean', 'Invalid PES convergence status');
  assert(frame.cv === undefined || Array.isArray(frame.cv) && frame.cv.every(Number.isFinite), 'Invalid PES frame coordinates');
  const frozen = new Set(request.constraints.frozenAtomIds);
  for (const [index, atom] of atoms.entries()) {
    if (frozen.has(atom.id)) assert(['x', 'y', 'z'].every((axis, i) => atom[axis] === frame.positions[index][i]), 'PES frame moved a frozen atom');
  }
  return frame;
}

function validatePathRecord(record, request) {
  assert(plain(record) && frameId(record.id) && frameId(record.seriesId) && frameId(record.phase)
    && record.id === `${request.runIdentity.runId}:${record.seriesId}:${record.phase}:${record.step}`
    && integer(record.step) && ['initial', 'first-energy', 'interval', 'final'].includes(record.kind)
    && Array.isArray(record.frames) && record.frames.length > 0, 'Invalid PES path record');
  const ids = new Set();
  for (const item of record.frames) {
    assert(plain(item) && !Object.hasOwn(item, 'positions') && frameId(item.id) && !ids.has(item.id)
      && item.id.startsWith(`${record.id}:`) && item.seriesId === record.seriesId && item.phase === record.phase
      && item.step === record.step && FRAME_STATUSES.has(item.status) && integer(item.bead, 1)
      && (item.energyHartree === null || Number.isFinite(item.energyHartree)), 'Invalid PES path frame index');
    ids.add(item.id);
  }
  assert(record.pathId === undefined || frameId(record.pathId), 'Invalid PES logical path identity');
  assert(record.reactantFrameId === undefined || record.frames.some(item => item.id === record.reactantFrameId
    && item.bead === 1), 'Invalid PES reactant frame identity');
  assert(record.connections === undefined || Array.isArray(record.connections)
    && record.connections.every(edge => Array.isArray(edge) && edge.length === 2 && edge.every(id => ids.has(id))
      && record.frames.find(item => item.id === edge[1]).bead === record.frames.find(item => item.id === edge[0]).bead + 1),
  'Invalid PES path connections');
  return record;
}

function validateScanPoint(point) {
  assert(plain(point) && integer(point.pointIndex) && Array.isArray(point.indices)
    && point.indices.length >= 1 && point.indices.length <= 2 && point.indices.every(value => integer(value))
    && finiteVector(point.targets, point.indices.length)
    && ['converged', 'unconverged', 'stopped', 'failed', 'missing'].includes(point.status)
    && (point.energyHartree === null || Number.isFinite(point.energyHartree))
    && (point.actual === undefined || finiteVector(point.actual, point.indices.length))
    && (point.frameId === undefined || frameId(point.frameId)), 'Invalid PES scan point');
  return point;
}

function validateHessian(result, request, frames) {
  const atomIds = request.structure.atoms.map(atom => atom.id);
  const hessian = result.hessian, n = atomIds.length * 3;
  assert(plain(hessian) && isDeepStrictEqual(hessian.atomIds, atomIds) && frames.has(hessian.frameId)
    && isDeepStrictEqual(hessian.geometryAngstrom, frames.get(hessian.frameId).positions)
    && Array.isArray(hessian.matrixHartreePerBohr2) && hessian.matrixHartreePerBohr2.length === n
    && hessian.matrixHartreePerBohr2.every(row => finiteVector(row, n)), 'Invalid PES Hessian source/matrix');
  assert(Array.isArray(result.frequencies) && result.frequencies.length === hessian.vibrationalDegreesOfFreedom
    && result.frequencies.every((mode, i) => plain(mode) && mode.mode === i + 1 && Number.isFinite(mode.wavenumberCm1)
      && mode.imaginary === (mode.wavenumberCm1 < 0) && Array.isArray(mode.displacements)
      && mode.displacements.length === atomIds.length && mode.displacements.every(row => finiteVector(row, 3))), 'Invalid PES vibration modes');
}

function validateResult(result, request) {
  assert(plain(result) && RESULT_STATUSES.has(result.status) && plain(result.provenance) && Array.isArray(result.frames), 'Invalid PES result');
  const frames = new Map();
  for (const frame of result.frames) {
    validateFrame(frame, request);
    assert(!frames.has(frame.id), 'Duplicate PES result frame');
    frames.set(frame.id, frame);
  }
  if (result.pathRecords !== undefined) {
    assert(Array.isArray(result.pathRecords), 'Invalid PES path records');
    distinctIds(result.pathRecords, 'Duplicate PES path record');
    result.pathRecords.forEach(record => validatePathRecord(record, request));
    assert(result.lastPathRecordId == null || result.pathRecords.some(record => record.id === result.lastPathRecordId),
      'Invalid PES final path record');
  }
  if (result.scanPoints !== undefined) {
    assert(Array.isArray(result.scanPoints), 'Invalid PES scan points');
    const seen = new Set();
    for (const point of result.scanPoints) {
      validateScanPoint(point);
      assert(!seen.has(point.pointIndex), 'Duplicate PES scan point');
      seen.add(point.pointIndex);
    }
  }
  if (result.series !== undefined) {
    assert(Array.isArray(result.series) && result.series.every(item => plain(item) && frameId(item.id)), 'Invalid PES series');
    distinctIds(result.series, 'Duplicate PES result series');
    for (const item of result.series) {
      if (item.frameIds !== undefined) assert(Array.isArray(item.frameIds)
        && item.frameIds.every(id => frames.get(id)?.seriesId === item.id), 'PES result series has an invalid frame reference');
    }
  }
  if ((request.operation === 'hessian' && result.status === 'completed') || result.hessian !== undefined || result.frequencies !== undefined) {
    validateHessian(result, request, frames);
  }
  return result;
}

function validateEvent(value, request, nextSeq) {
  assert(plain(value) && value.schema === SCHEMA && isDeepStrictEqual(value.runIdentity, request.runIdentity)
    && integer(value.seq) && value.seq === nextSeq, 'PES worker identity/sequence changed');
  const base = ['schema', 'runIdentity', 'seq', 'event'];
  validateData(value, 'Invalid PES worker data');
  if (value.event === 'progress') {
    keys(value, [...base, 'stage', 'completed', 'total', 'elapsedSeconds'], 'Invalid PES progress fields');
    assert(frameId(value.stage) && (value.completed === undefined || integer(value.completed))
      && (value.total === undefined || integer(value.total, 1) && integer(value.completed) && value.completed <= value.total)
      && (value.elapsedSeconds === undefined || Number.isFinite(value.elapsedSeconds) && value.elapsedSeconds >= 0), 'Invalid PES progress');
  } else if (value.event === 'frame') {
    keys(value, [...base, 'frame'], 'Invalid PES frame envelope');
    validateFrame(value.frame, request);
  } else if (value.event === 'path-record') {
    keys(value, [...base, 'record', 'artifact'], 'Invalid PES path record envelope');
    validatePathRecord(value.record, request);
    const artifact = value.artifact;
    assert(plain(artifact) && /^[a-f0-9]{64}\.json$/.test(artifact.name)
      && /^[a-f0-9]{64}$/.test(artifact.sha256) && integer(artifact.bytes, 1), 'Invalid PES path asset');
    keys(artifact, ['name', 'sha256', 'bytes'], 'Invalid PES path asset fields');
  } else if (value.event === 'scan-point') {
    keys(value, [...base, 'point'], 'Invalid PES scan point envelope');
    validateScanPoint(value.point);
  } else {
    keys(value, [...base, 'status', 'result', 'error'], 'Invalid PES worker terminal fields');
    assert(value.event === 'terminal' && ['completed', 'stopped', 'failed'].includes(value.status), 'Invalid PES worker terminal');
    if (value.result !== undefined) {
      validateResult(value.result, request);
      const incomplete = ['partial', 'not-converged'].includes(value.result.status);
      assert(value.result.status === value.status || incomplete && value.status !== 'stopped', 'PES worker terminal/result status mismatch');
      assert(value.status === 'failed' || value.result.error == null, 'PES worker cannot complete or stop with a result failure');
    }
    if (value.error !== undefined) {
      keys(value.error, ['message', 'detail'], 'Invalid PES worker error');
      assert(value.status === 'failed' && string(value.error.message, 8192)
        && (value.error.detail === undefined || typeof value.error.detail === 'string'), 'Invalid PES worker failure');
    }
    assert(value.status !== 'completed' || value.result !== undefined, 'Missing completed PES result');
  }
  return value;
}

module.exports = { SCHEMA, validateStart, validateIdentity, validateEvent, validateFrame, validatePathRecord, requiresResidentLibrary };
