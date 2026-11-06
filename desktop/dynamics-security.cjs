'use strict';
const { assert, plain, string, boundedJSON, validateChemistry, validateStructure, validateAttachmentPorts } = require('./security.cjs');

const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const EVENTS = new Set(['ready', 'started', 'heartbeat', 'frame', 'paused', 'resumed', 'temperature', 'stopped', 'completed', 'error']);
const TERMINAL_EVENTS = new Set(['stopped', 'completed', 'error']);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function graph(structure) {
  // Same physical graph fields as core/modeling/graph.ts. Cache metadata,
  // display layers, molfile text and revision are intentionally excluded.
  const reference = bond => {
    const ids = [structure.atoms[bond.a].id, structure.atoms[bond.b].id];
    const reverse = ids[0] > ids[1] || ids[0] === ids[1] && ((bond.image ?? []).find(number => number !== 0) ?? 0) < 0;
    return JSON.stringify([...(reverse ? [ids[1], ids[0]] : ids), (bond.image ?? [0, 0, 0]).map(number => reverse ? -number : number)]);
  };
  return canonical({
    atoms: structure.atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0, atom.aromaticHydrogen ?? false]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    bonds: (structure.bonds ?? []).map(bond => [reference(bond), bond.aromatic || bond.order === 1.5 || bond.order === 4 ? 1.5 : bond.order, bond.kind ?? 'covalent', ...(bond.fractional === true ? ['fractional'] : []), ...(bond.orderKnown === false ? ['unknown-order', bond.perception] : []), bond.stereo ?? 0]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    cell: structure.cell ?? null, periodicSource: structure.periodicSource ?? null, charge: structure.charge, multiplicity: structure.multiplicity,
  });
}
function sessionIdentity(value) {
  assert(string(value, 100) && /^[a-zA-Z0-9_-]+$/.test(value), 'Invalid dynamics session identity');
  return value;
}
function connectionKey(atomIds, image = [0,0,0]) {
  const forward = JSON.stringify([atomIds, image]), reverse = JSON.stringify([[atomIds[1], atomIds[0]], image.map(v => -v)]);
  return forward < reverse ? forward : reverse;
}
function connectionIndex(structure) {
  return new Map((structure.bonds ?? []).map(edge => [connectionKey([structure.atoms[edge.a].id, structure.atoms[edge.b].id], edge.image), edge]));
}
function targetEndpoint(row, structure) {
  const ids = new Set(structure.atoms.map(a => a.id)), image = row.image ?? [0,0,0];
  assert(Array.isArray(row.atomIds) && row.atomIds.length === 2 && row.atomIds.every(id => typeof id === 'string' && ids.has(id)) && Array.isArray(image) && image.length === 3 && image.every((v,i) => Number.isSafeInteger(v) && Math.abs(v) <= 1000000 && (!v || structure.cell?.pbc[i])), 'Invalid mechanical distance endpoints or image');
  return connectionKey(row.atomIds, image);
}
function validateGeometryDistanceTargets(value, request) {
  if (value === undefined) return;
  assert(request.operation === 'geometry' && request.geometryMode === undefined, 'Explicit mechanical distances require pure geometry mode');
  assert(Array.isArray(value), 'Invalid mechanical distance target inventory');
  const edges = connectionIndex(request.structure), seen = new Set();
  for (const row of value) {
    assert(plain(row) && Object.keys(row).every(k => ['atomIds','image','distanceAngstrom'].includes(k)) && Number.isFinite(row.distanceAngstrom) && row.distanceAngstrom > 0 && row.distanceAngstrom <= 1000000, 'Invalid explicit mechanical distance');
    const key = targetEndpoint(row, request.structure), edge = edges.get(key);
    assert(edge && edge.order !== .5 && !seen.has(key), 'Mechanical distance must identify one existing nonweak connection'); seen.add(key);
  }
}
function validateGeometryTargetStatus(value, request) {
  assert(request.operation === 'geometry' && request.geometryMode === undefined && plain(value), 'Unrequested mechanical target status');
  const counts = ['targetedConnectionCount','movableConnectionTargetCount','untargetedCoordinationCount','weakConnectionCount','unresolvedImmovableConnectionCount','angleTargetCount','planeTargetCount','activeCollisionCount'];
  assert(Object.keys(value).length === counts.length + 2 && Object.keys(value).every(k => [...counts,'status','connectionTargets'].includes(k)) && counts.every(k => Number.isSafeInteger(value[k]) && value[k] >= 0), 'Invalid mechanical target status fields');
  assert(Array.isArray(value.connectionTargets) && value.connectionTargets.length === (request.structure.bonds ?? []).length, 'Invalid mechanical target term inventory');
  const edges = connectionIndex(request.structure), explicit = new Map((request.geometryDistanceTargets ?? []).map(row => [connectionKey(row.atomIds, row.image), row.distanceAngstrom])), seen = new Set();
  const movable = new Set(request.movableAtomIds); let targeted = 0, active = 0, unsupported = 0, weak = 0;
  for (const row of value.connectionTargets) {
    assert(plain(row) && Object.keys(row).length === 5 && Object.keys(row).every(k => ['atomIds','image','targetAngstrom','source','orderKnown'].includes(k)), 'Invalid mechanical connection target fields');
    const key = targetEndpoint(row, request.structure), edge = edges.get(key);
    assert(edge && !seen.has(key) && row.orderKnown === (edge.orderKnown !== false), 'Mechanical target changed connection identity or known order'); seen.add(key);
    if (edge.order === .5) { assert(row.source === 'weak-relation' && row.targetAngstrom === null, 'Weak connection acquired covalent target'); weak++; }
    else if (explicit.has(key)) assert(row.source === 'user-distance' && row.targetAngstrom === explicit.get(key), 'Explicit mechanical distance was not respected');
    else if (edge.kind === 'coordination') { assert(row.source === 'unavailable-coordination' && row.targetAngstrom === null, 'Coordination acquired an unrequested covalent target'); unsupported++; }
    else assert(['typical-covalent','covalent-radii'].includes(row.source) && (edge.orderKnown !== false || row.source === 'covalent-radii'), 'Unknown order was promoted to a typed covalent target');
    if (row.targetAngstrom !== null) {
      assert(Number.isFinite(row.targetAngstrom) && row.targetAngstrom > 0 && row.targetAngstrom <= 1000000, 'Invalid mechanical target distance'); targeted++;
      if (row.atomIds[0] !== row.atomIds[1] && row.atomIds.some(id => movable.has(id))) active++;
    }
  }
  assert(value.targetedConnectionCount === targeted && value.movableConnectionTargetCount === active && value.untargetedCoordinationCount === unsupported && value.weakConnectionCount === weak && value.unresolvedImmovableConnectionCount <= targeted-active, 'Mechanical target summary differs from actual connections');
  const hasTargets = active + value.angleTargetCount + value.planeTargetCount > 0;
  const expected = hasTargets ? unsupported || value.unresolvedImmovableConnectionCount ? 'partial-targets' : 'targeted' : value.activeCollisionCount ? 'collision-only' : 'no-targets';
  assert(value.status === expected, 'Mechanical target status differs from actual available goals');
}
function validateStart(value) {
  boundedJSON(value);
  assert(plain(value), 'Invalid dynamics request');
  const allowed = new Set(['stamp', 'operation', 'structure', 'movableAtomIds', 'constraints', 'forcefield', 'method', 'untilStopped', 'protectedAtomIds', 'maxSteps', 'maxWallTimeSeconds', 'temperatureK', 'seed', 'frictionPerFs', 'dtFs', 'reportEvery', 'attachmentPorts', 'geometryMode', 'hybridScalePolicy', 'allowPureGeometryFallback', 'geometryDistanceTargets']);
  assert(Object.keys(value).every(key => allowed.has(key)), 'Unknown dynamics request field');
  assert(['md', 'optimize', 'geometry'].includes(value.operation), 'Invalid dynamics operation');
  assert(value.untilStopped === undefined || value.operation === 'md' && value.untilStopped === true, 'Continuous execution requires MD');
  const nativeMD = value.method !== undefined;
  assert(!nativeMD || value.operation === 'md' && value.untilStopped === true && ['gfnff','gfn0','gfn1','gfn2'].includes(value.method) && value.forcefield === undefined, 'Invalid native MD method');
  assert(value.protectedAtomIds === undefined || nativeMD && Array.isArray(value.protectedAtomIds) && new Set(value.protectedAtomIds).size === value.protectedAtomIds.length && value.protectedAtomIds.length !== 1 && value.protectedAtomIds.every(id=>value.structure.atoms.some(atom=>atom.id===id)), 'Relative-distance protection needs at least two distinct atoms');
  if(nativeMD) assert(value.movableAtomIds.length === value.structure.atoms.length, 'Native soft protection does not impose XYZ freezes');
  if (value.geometryMode !== undefined || value.hybridScalePolicy !== undefined) assert(value.operation === 'geometry' && value.geometryMode === 'hybrid-local' && value.hybridScalePolicy === 'uff-bond-stiffness-v1', 'Invalid local hybrid mode or scale policy');
  if (value.allowPureGeometryFallback !== undefined) assert(value.allowPureGeometryFallback === true && value.operation === 'geometry' && value.geometryMode === 'hybrid-local', 'Pure geometry fallback requires explicit hybrid permission');
  // Reuse graph/constraint validation, not the separate short chemistry-job
  // wall limit. The dynamic request's existing <=1800s budget is checked below.
  const { maxWallTimeSeconds: dynamicWallBudget, ...chemistryShape } = value;
  validateChemistry({ ...chemistryShape, operation: 'optimize' });
  validateGeometryDistanceTargets(value.geometryDistanceTargets, value);
  validateAttachmentPorts(value.attachmentPorts, new Set(value.structure.atoms.map(atom => atom.id)));
  assert(value.operation !== 'md' || !value.attachmentPorts?.length, 'MD requires completed construction ports');
  // Optimize receives the native before-frame coverage rejection so AUTO can
  // retain trustworthy UFF locally; MD must never start on a fractional graph.
  assert(value.operation !== 'md' || !value.structure.bonds?.some(bond => bond.fractional === true), 'Explicit fractional connections have no validated MD potential');
  if (value.operation === 'geometry') assert(['forcefield', 'temperatureK', 'seed', 'frictionPerFs', 'dtFs', 'reportEvery'].every(key => value[key] === undefined), 'Geometry has no force field, temperature or physical timestep');
  assert(value.structure.atoms.length > 0, 'Dynamics requires a nonempty molecule');
  assert(value.structure.periodicSource?.completeness !== 'partial', 'Incomplete periodic cell cannot run dynamics');
  const periodic = value.structure.cell?.pbc.some(Boolean) === true;
  if (value.structure.cell !== undefined) {
    const cell = value.structure.cell;
    // The shared structure validator already checks vectors, invertibility,
    // legal image identities and axis provenance syntax.
    assert(cell.pbcProvenance?.kind !== 'unconfirmed', 'Periodic source axes are unconfirmed');
  }
  if (periodic) {
    assert(value.operation === 'geometry' && value.geometryMode === undefined && value.hybridScalePolicy === undefined && value.allowPureGeometryFallback === undefined, 'Dynamics requires a nonperiodic molecule except for pure fixed-cell mechanical geometry');
    assert(!(value.constraints ?? []).length, 'Periodic mechanical geometry supports atomic freezes only, not B/A/D constraints');
    assert(!value.attachmentPorts?.length, 'Periodic mechanical geometry does not support attachment ports');
    assert(!value.structure.atoms.some(atom => atom.stereoParity) && !value.structure.bonds?.some(bond => bond.stereo), 'Periodic declared molecular stereo is unsupported');
  }
  assert(value.structure.dimension === undefined || value.structure.dimension === 3, 'Dynamics requires three-dimensional coordinates');
  assert(periodic || !value.structure.bonds?.some(bond => bond.image?.some(number => number !== 0)), 'Dynamics does not support periodic bonds without a periodic cell');
  assert(value.movableAtomIds.length > 0, 'Dynamics requires movable atoms');
  assert(!(value.constraints ?? []).some(coordinate => coordinate.action === 'scan'), 'Dynamics cannot run a potential-energy scan');
  assert(value.operation !== 'md' || !(value.constraints ?? []).length, 'B/A/D momentum constraints have not been validated for MD; use XYZ freezes');
  assert(value.dtFs === undefined || value.dtFs === (nativeMD ? 2 : 1), 'Dynamics timestep differs from selected driver');
  assert(value.reportEvery === undefined || value.reportEvery === 10, 'Dynamics report interval must be 10 steps');
  const maxSteps = value.maxSteps ?? (value.operation === 'md' ? 100000 : 500);
  assert(Number.isSafeInteger(maxSteps) && maxSteps >= 1, 'Invalid dynamics step budget');
  const maxWallTimeSeconds = value.maxWallTimeSeconds;
  assert((maxWallTimeSeconds === undefined || Number.isFinite(maxWallTimeSeconds) && maxWallTimeSeconds > 0), 'Invalid dynamics wall budget');
  assert(value.temperatureK === undefined || Number.isFinite(value.temperatureK) && value.temperatureK >= 0 && value.temperatureK <= 5000, 'Invalid dynamics temperature');
  assert(!nativeMD || (value.temperatureK ?? 300)>0, 'Native MD requires a positive temperature');
  assert(value.seed === undefined || Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 0xffffffff, 'Invalid dynamics RNG seed');
  assert(value.frictionPerFs === undefined || Number.isFinite(value.frictionPerFs) && value.frictionPerFs >= 0 && value.frictionPerFs <= 1, 'Invalid dynamics friction');
  // Detached copies prevent a caller mutating the identity while a worker runs.
  return JSON.parse(boundedJSON({ ...value, maxSteps, maxWallTimeSeconds, ...(nativeMD?{temperatureK:value.temperatureK??300}:{}), ...(value.operation === 'geometry' ? {} : { dtFs: nativeMD ? 2 : 1, reportEvery: 10 }) }));
}
function validateCommand(value) {
  assert(plain(value) && ['pause', 'resume', 'stop', 'set-temperature'].includes(value.command), 'Invalid dynamics command');
  assert(Object.keys(value).every(key => ['command', 'temperatureK'].includes(key)), 'Unknown dynamics command field');
  if (value.command === 'set-temperature') assert(Number.isFinite(value.temperatureK) && value.temperatureK >= 0 && value.temperatureK <= 5000, 'Invalid dynamics temperature');
  else assert(value.temperatureK === undefined, 'Temperature requires set-temperature command');
  return value;
}
function validateEvent(value, session) {
  assert(plain(value) && value.schema === 1 && value.sessionId === session.sessionId && EVENTS.has(value.event), 'Invalid dynamics event identity');
  assert(value.displayFrames === undefined, 'Display batches may only be created by the trusted host');
  assert(Number.isSafeInteger(value.seq) && value.seq > session.lastSeq, 'Dynamics event sequence is not increasing');
  if (value.event === 'ready') return value;
  assert(canonical(value.stamp) === canonical(session.request.stamp) && value.operation === session.request.operation, 'Dynamics document stamp changed');
  assert(Number.isSafeInteger(value.step) && value.step >= session.lastStep && (session.request.untilStopped || value.step <= session.request.maxSteps), 'Invalid dynamics step');
  assert(Number.isFinite(value.timeFs) && value.timeFs >= session.lastTimeFs, 'Invalid dynamics physical time');
  if (value.operation === 'md') assert(value.timeFs === value.step*(session.request.dtFs ?? 1), 'Dynamics physical time must equal step times actual timestep');
  if(session.request.untilStopped){assert(!['paused','resumed','temperature'].includes(value.event),'Continuous MD cannot pause or change temperature');assert(value.targetTemperatureK===undefined||value.targetTemperatureK===(session.request.temperatureK??300),'Continuous MD target temperature changed');}
  if(session.request.method&&value.structure){const m=value.nativeMD;assert(plain(m)&&m.method===session.request.method&&m.dtFs===2&&m.thermostat==='Berendsen'&&m.hydrogenMassAmu===(m.method==='gfnff'?4:null)&&m.shakeHydrogenBonds===(m.method!=='gfnff')&&canonical(m.protectedAtomIds)===canonical(session.request.protectedAtomIds??[])&&m.protection===(m.protectedAtomIds.length?'pairwise-distance':'none')&&m.forceConstantKJMolNm2===500000&&Number.isSafeInteger(m.segment)&&m.segment>=0&&m.velocityInitialization===(m.segment===0?'fresh':'restart')&&typeof m.nativeClosed==='boolean','Native MD method or protection evidence differs');}
  if(session.request.method&&value.event==='stopped')assert(value.nativeMD?.nativeClosed===true,'Native MD Stop requires actual native process closure');
  if(session.request.method&&value.nativeMD?.rawPotential!==undefined){const p=value.nativeMD.rawPotential,protectedRun=(session.request.protectedAtomIds??[]).length>0;assert(plain(p)&&Number.isFinite(p.value)&&p.unit==='hartree'&&p.definition===(protectedRun?'native-total-including-protection':'native-physical-potential')&&p.includesProtection===protectedRun&&p.sourceArtifact==='xtb.trj'&&Number.isSafeInteger(p.sourceStep)&&p.sourceStep>=0&&p.sourceStep<=value.step&&p.sourceTimeFs===p.sourceStep*2&&Number.isSafeInteger(p.segment)&&p.segment>=0&&p.segment<=value.nativeMD.segment,'Native MD raw potential source or definition differs');}
  if (value.operation === 'geometry') {
    assert(value.timeFs === 0, 'Geometry has no elapsed physical time');
    assert(value.event !== 'temperature' && ['energyEV', 'kineticEnergyEV', 'temperatureK', 'targetTemperatureK', 'forcefield'].every(key => value[key] === undefined), 'Geometry cannot report physical energy, temperature or force field');
    if (value.hybridGeometry !== undefined) {
      assert(session.request.geometryMode === 'hybrid-local', 'Unrequested hybrid result');
      validateHybridMetadata(value.hybridGeometry, session.request.structure, value.geometryObjective);
      if (value.hybridGeometry.mode === 'geometry-only') assert(session.request.allowPureGeometryFallback === true, 'Unrequested pure geometry fallback');
    }
    if (session.request.geometryMode === 'hybrid-local' && value.structure) assert(value.hybridGeometry, 'Hybrid snapshot missing actual partition metadata');
    assert(value.geometryObjective === undefined || Number.isFinite(value.geometryObjective) && (value.hybridGeometry || value.geometryObjective >= 0), 'Invalid geometry objective');
    assert(!value.structure || value.geometryObjective !== undefined, 'Geometry snapshot requires a mechanical objective');
    if (value.geometryTargetStatus !== undefined) validateGeometryTargetStatus(value.geometryTargetStatus, session.request);
    if (value.reason === 'no-targets') assert(value.event === 'completed' && value.converged === false && value.geometryTargetStatus?.status === 'no-targets', 'No-targets cannot claim mechanical convergence');
  } else assert(value.geometryObjective === undefined && value.hybridGeometry === undefined && value.geometryTargetStatus === undefined && value.reason !== 'no-targets', 'Physical dynamics cannot report a mechanical objective or target status');
  if (value.event === 'completed' && value.reason !== undefined) assert(['converged','step-limit','no-targets'].includes(value.reason) && (value.reason !== 'converged' || value.converged === true) && (value.reason !== 'step-limit' || value.converged === false), 'Invalid dynamics completion reason');
  if (value.event === 'completed' && value.geometryTargetStatus?.status === 'no-targets') assert(value.reason === 'no-targets' && value.converged === false, 'Mechanical no-targets completion must stay explicit');
  for (const key of ['energyEV', 'kineticEnergyEV', 'temperatureK', 'targetTemperatureK']) assert(value[key] === undefined || Number.isFinite(value[key]), `Nonfinite dynamics ${key}`);
  if (value.event === 'frame' || value.event === 'completed' || value.event === 'stopped') assert(value.structure, 'Dynamics snapshot missing');
  if (value.structure) {
    validateStructure(value.structure);
    assert(value.structure.id === session.request.structure.id && value.structure.dimension === session.request.structure.dimension && value.structure.atoms.length === session.request.structure.atoms.length && value.structure.atoms.every((atom, index) => atom.id === session.request.structure.atoms[index].id && atom.stereoParity === session.request.structure.atoms[index].stereoParity), 'Dynamics ordered atom or structure identity changed');
    assert(graph(value.structure) === session.graph, 'Dynamics graph or stable atom identities changed');
    value.structure.atoms.forEach((atom, index) => {
      const original = session.request.structure.atoms[index];
      if (value.operation === 'geometry') assert(atom.geometryPresetId === original.geometryPresetId, 'Geometry construction preset identity changed');
      assert(Math.max(Math.abs(atom.x), Math.abs(atom.y), Math.abs(atom.z)) <= 1e6, 'Dynamics coordinate outside finite safety bound');
      if (!session.movable.has(atom.id)) assert(atom.x === original.x && atom.y === original.y && atom.z === original.z, 'Dynamics frozen atom moved');
    });
  }
  if (value.error !== undefined) assert(plain(value.error) && string(value.error.code, 100) && string(value.error.message, 8192), 'Invalid dynamics error');
  return value;
}
function validateHybridMetadata(value, structure, objective) {
  assert(plain(value) && value.schema === 1 && ['partial-uff-local','geometry-only'].includes(value.mode) && value.physicalPotential === false, 'Invalid hybrid metadata');
  const pure = value.mode === 'geometry-only';
  assert(value.scalePolicy === (pure ? 'pure-geometry-v1' : 'uff-bond-stiffness-v1') && value.objective === (pure ? 'mechanicalGeometry' : 'partialUFF(kcal/mol)/energyScale(kcal/mol)+localMechanical') && string(value.triggerCode,100) && typeof value.regionsOverlap === 'boolean', 'Invalid hybrid objective identity');
  const ids = new Set(structure.atoms.map(atom => atom.id));
  for (const key of ['problemAtomIds','mechanicalAtomIds','uffAtomIds','boundaryAtomIds']) assert(Array.isArray(value[key]) && new Set(value[key]).size === value[key].length && value[key].every(id => ids.has(id)), 'Invalid hybrid region identities');
  assert(value.problemAtomIds.length && value.mechanicalAtomIds.length, 'Empty hybrid regions');
  assert(value.problemAtomIds.every(id => value.mechanicalAtomIds.includes(id)) && value.regionsOverlap === value.mechanicalAtomIds.some(id => value.uffAtomIds.includes(id)), 'Invalid region membership or overlap');
  if (pure) assert(value.uffAtomIds.length === 0 && value.uffEnergyKcalMol === 0 && value.energyScaleKcalMol === 1 && value.mechanicalAtomIds.length === ids.size && value.boundaryAtomIds.length === 0 && value.regionsOverlap === false && value.fallbackReason === 'no-uff-region', 'Pure geometry cannot claim retained UFF');
  else assert(value.uffAtomIds.length > 0 && value.fallbackReason === undefined, 'Hybrid needs actual UFF region');
  assert(Number.isFinite(value.uffEnergyKcalMol) && Number.isFinite(value.localMechanicalObjective) && value.localMechanicalObjective >= 0 && Number.isFinite(value.energyScaleKcalMol) && value.energyScaleKcalMol > 0, 'Invalid hybrid components');
  assert(plain(value.termCounts) && Object.values(value.termCounts).every(count => Number.isSafeInteger(count) && count >= 0), 'Invalid hybrid term inventory');
  if (value.typingProof !== undefined || value.typingIsolationAtomIds !== undefined) {
    assert(['bounded-neutral-saturated-CH-chain-v1','bounded-neutral-saturated-CHF-chain-v2','native-null-typing-mask-v3'].includes(value.typingProof) && Array.isArray(value.typingIsolationAtomIds) && value.typingIsolationAtomIds.length > 0 && new Set(value.typingIsolationAtomIds).size === value.typingIsolationAtomIds.length && value.typingIsolationAtomIds.every(id => value.mechanicalAtomIds.includes(id)), 'Invalid hybrid typing proof');
    if(value.typingProof === 'bounded-neutral-saturated-CHF-chain-v2') assert(JSON.stringify([...value.typingIsolationAtomIds].sort()) === JSON.stringify([...value.problemAtomIds].sort()), 'CHF typing isolation must identify only the actual problem roots');
    if(value.typingProof === 'native-null-typing-mask-v3') assert(value.typingIsolationAtomIds.every(id => !value.uffAtomIds.includes(id)), 'Excluded types cannot claim UFF coverage');
  }
  if (objective !== undefined) { const expected = value.uffEnergyKcalMol / value.energyScaleKcalMol + value.localMechanicalObjective; assert(Number.isFinite(objective) && Math.abs(expected-objective) <= 1e-8*Math.max(1,Math.abs(expected)), 'Hybrid objective differs from actual components'); }
}
module.exports = { MAX_EVENT_BYTES, TERMINAL_EVENTS, canonical, graph, sessionIdentity, validateStart, validateCommand, validateEvent, validateGeometryDistanceTargets, validateGeometryTargetStatus };
