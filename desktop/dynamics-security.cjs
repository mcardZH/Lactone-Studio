'use strict';
const { isDeepStrictEqual } = require('node:util');
const { sameSourceStamp } = require('./native-source-stamp.cjs');
const { assert, plain, string, boundedJSON, validateStampedChemistryModel, validateStructure, validateAttachmentPorts } = require('./security.cjs');
const { isXtbMethod, supportsXtbOperation, supportsXtbAlpb, XTB_METHOD_LABELS } = require('./xtb-capabilities.cjs');

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
  const bonds = (structure.bonds ?? []).map(bond => {
    const row = [reference(bond), bond.aromatic || bond.order === 1.5 || bond.order === 4 ? 1.5 : bond.order,
      bond.kind ?? 'covalent', ...(bond.fractional === true ? ['fractional'] : []),
      ...(bond.orderKnown === false ? ['unknown-order', bond.perception] : []), bond.stereo ?? 0];
    return { row, key: JSON.stringify(row) };
  });
  return canonical({
    atoms: structure.atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0, atom.aromaticHydrogen ?? false]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    bonds: bonds.sort((a, b) => a.key.localeCompare(b.key)).map(entry => entry.row),
    cell: structure.cell ?? null, periodicSource: structure.periodicSource ?? null, charge: structure.charge, multiplicity: structure.multiplicity,
  });
}
// Native frame topology normally keeps the exact submitted row order.
// Use the existing canonical comparison when a legitimate reordered or
// equivalent representation needs the slower path.
function sameOrderedGraph(frame, initial) {
  if (frame.charge !== initial.charge || frame.multiplicity !== initial.multiplicity
      || !isDeepStrictEqual(frame.cell ?? null, initial.cell ?? null)
      || !isDeepStrictEqual(frame.periodicSource ?? null, initial.periodicSource ?? null)) return false;
  if (!frame.atoms.every((atom, index) => {
    const before = initial.atoms[index];
    return atom.element === before.element
      && (atom.formalCharge ?? 0) === (before.formalCharge ?? 0)
      && (atom.aromaticHydrogen ?? false) === (before.aromaticHydrogen ?? false);
  })) return false;
  const before = initial.bonds ?? [], current = frame.bonds ?? [];
  if (current.length !== before.length) return false;
  const order = bond => bond.aromatic || bond.order === 1.5 || bond.order === 4 ? 1.5 : bond.order;
  return current.every((bond, index) => {
    const base = before[index];
    return bond.a === base.a && bond.b === base.b && order(bond) === order(base)
      && (bond.kind ?? 'covalent') === (base.kind ?? 'covalent')
      && (bond.fractional === true) === (base.fractional === true)
      && (bond.orderKnown === false) === (base.orderKnown === false)
      && (bond.orderKnown !== false || bond.perception === base.perception)
      && (bond.stereo ?? 0) === (base.stereo ?? 0)
      && [0, 1, 2].every(axis => (bond.image?.[axis] ?? 0) === (base.image?.[axis] ?? 0));
  });
}
function sessionIdentity(value) {
  assert(string(value, 100) && /^[a-zA-Z0-9_-]+$/.test(value), 'Invalid dynamics session identity');
  return value;
}
function validateStart(value) {
  boundedJSON(value);
  assert(plain(value), 'Invalid dynamics request');
  const allowed = new Set(['stamp', 'operation', 'structure', 'movableAtomIds', 'constraints', 'method', 'integrator', 'shakeHydrogenBonds', 'hydrogenMassAmu', 'untilStopped', 'protectedAtomIds', 'solvation', 'maxSteps', 'maxWallTimeSeconds', 'temperatureK', 'seed', 'frictionPerFs', 'dtFs', 'reportEvery', 'attachmentPorts']);
  assert(Object.keys(value).every(key => allowed.has(key)), 'Unknown dynamics request field');
  assert(value.operation === 'md', 'Invalid dynamics operation');
  assert(value.untilStopped === true && isXtbMethod(value.method), 'Invalid native MD method');
  assert(value.integrator === undefined || ['ase','xtb'].includes(value.integrator), 'Invalid MD integrator');
  let hydrogen;
  if (value.integrator === undefined) assert(value.shakeHydrogenBonds === undefined && value.hydrogenMassAmu === undefined, 'Explicit MD hydrogen settings require an integrator');
  else {
    const shakeHydrogenBonds=value.shakeHydrogenBonds===undefined?false:value.shakeHydrogenBonds;
    const hydrogenMassAmu=shakeHydrogenBonds?1:4;
    assert(typeof shakeHydrogenBonds==='boolean'&&(value.method!=='gfnff'||!shakeHydrogenBonds)
      && (value.hydrogenMassAmu===undefined||value.hydrogenMassAmu===hydrogenMassAmu), 'MD hydrogen mass and bond constraints do not match');
    hydrogen={shakeHydrogenBonds,hydrogenMassAmu};
  }
  validateStampedChemistryModel(value);
  const ase = value.integrator === 'ase';
  if (ase) assert(value.method !== 'gxtb' && (value.protectedAtomIds === undefined || Array.isArray(value.protectedAtomIds) && !value.protectedAtomIds.length)
    && !value.stamp.nativeMDPolicy, 'ASE MD requires a supported calculator and exact freezes');
  else {
    assert(value.protectedAtomIds === undefined || Array.isArray(value.protectedAtomIds) && new Set(value.protectedAtomIds).size === value.protectedAtomIds.length && value.protectedAtomIds.length !== 1 && value.protectedAtomIds.every(id=>value.structure.atoms.some(atom=>atom.id===id)), 'Relative-distance protection needs at least two distinct atoms');
    assert(value.movableAtomIds.length === value.structure.atoms.length, 'Native soft protection does not impose XYZ freezes');
  }
  validateAttachmentPorts(value.attachmentPorts, new Set(value.structure.atoms.map(atom => atom.id)));
  assert(!value.attachmentPorts?.length, 'MD requires completed construction ports');
  assert(!value.structure.bonds?.some(bond => bond.fractional === true), 'Explicit fractional connections have no validated MD potential');
  assert(value.structure.atoms.length > 0, 'Dynamics requires a nonempty molecule');
  assert(value.structure.periodicSource?.completeness !== 'partial', 'Incomplete periodic cell cannot run dynamics');
  const periodic = value.structure.cell?.pbc.some(Boolean) === true;
  if (periodic) {
    const cell = value.structure.cell;
    // The shared structure validator already checks vectors, invertibility,
    // legal image identities and axis provenance syntax.
    assert(cell.pbcProvenance?.kind !== 'unconfirmed', 'Periodic source axes are unconfirmed');
    if (ase) assert(cell.pbc.every(Boolean), 'Fixed-cell ASE MD requires three enabled working periodic axes');
  }
  if (periodic && !ase) {
    assert(value.integrator === undefined, 'Periodic MD requires the fixed-cell ASE integrator');
    assert(supportsXtbOperation(value.method,'md',true)&&!value.protectedAtomIds?.length&&!value.constraints?.length,'Periodic native MD requires a supported method and excludes user protection or constraints');
  }
  assert(value.structure.dimension === undefined || value.structure.dimension === 3, 'Dynamics requires three-dimensional coordinates');
  assert(periodic || !value.structure.bonds?.some(bond => bond.image?.some(number => number !== 0)), 'Dynamics does not support periodic bonds without a periodic cell');
  assert(value.movableAtomIds.length > 0, 'Dynamics requires movable atoms');
  if(value.constraints?.length){
    assert(value.constraints.every(row=>row.action==='freeze'&&Number.isFinite(row.value)
      && (ase||!row.images?.some(image=>image.some(Boolean)))),'MD B/A/D constraints require finite freeze targets and a compatible integrator');
  }
  if(value.solvation!==undefined)assert(plain(value.solvation)&&Object.keys(value.solvation).length===2&&value.solvation.model==='alpb'&&supportsXtbAlpb(value.method,value.solvation.solvent,periodic),'Invalid native MD solvation');
  assert(value.dtFs === undefined || value.dtFs === 2, 'Dynamics timestep differs from selected driver');
  assert(value.reportEvery === undefined || value.reportEvery === 10, 'Dynamics report interval must be 10 steps');
  const maxSteps = value.maxSteps ?? 100000;
  assert(Number.isSafeInteger(maxSteps) && maxSteps >= 1, 'Invalid dynamics step budget');
  const maxWallTimeSeconds = value.maxWallTimeSeconds;
  assert((maxWallTimeSeconds === undefined || Number.isFinite(maxWallTimeSeconds) && maxWallTimeSeconds > 0), 'Invalid dynamics wall budget');
  assert(value.temperatureK === undefined || Number.isFinite(value.temperatureK) && value.temperatureK >= 0 && value.temperatureK <= 5000, 'Invalid dynamics temperature');
  assert((value.temperatureK ?? 300)>0, 'MD requires a positive temperature');
  assert(value.seed === undefined || value.method!=='gxtb'&&Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 0x7fffffff, 'Invalid dynamics RNG seed');
  assert(value.frictionPerFs === undefined || Number.isFinite(value.frictionPerFs) && value.frictionPerFs >= 0 && value.frictionPerFs <= 1, 'Invalid dynamics friction');
  // Detached copies prevent a caller mutating the identity while a worker runs.
  return JSON.parse(boundedJSON({ ...value, ...hydrogen, maxSteps, maxWallTimeSeconds, temperatureK:value.temperatureK??300, dtFs: 2, reportEvery: 10 }));
}
function validateCommand(value) {
  assert(plain(value) && ['pause', 'resume', 'stop', 'set-temperature'].includes(value.command), 'Invalid dynamics command');
  assert(Object.keys(value).every(key => ['command', 'temperatureK'].includes(key)), 'Unknown dynamics command field');
  if (value.command === 'set-temperature') assert(Number.isFinite(value.temperatureK) && value.temperatureK >= 0 && value.temperatureK <= 5000, 'Invalid dynamics temperature');
  else assert(value.temperatureK === undefined, 'Temperature requires set-temperature command');
  return value;
}
function validateAseEvidence(value, session) {
  const r = session.request, m = value.aseMD;
  const frozen = r.structure.atoms.filter(atom=>!session.movable.has(atom.id)).map(atom=>atom.id);
  assert(!value.nativeMD&&plain(m)&&m.driver==='ase-bussi'&&m.method===r.method&&['libxtb','tblite'].includes(m.backend)
    && (session.aseBackend===undefined||m.backend===session.aseBackend)&&string(m.aseVersion,100)
    && m.dtFs===2&&m.thermostat==='Bussi'&&m.thermostatTimeConstantFs===500
    && m.hydrogenMassAmu===r.hydrogenMassAmu&&m.shakeHydrogenBonds===r.shakeHydrogenBonds
    && m.periodic===(r.structure.cell?.pbc.some(Boolean)===true)&&canonical(m.frozenAtomIds)===canonical(frozen)&&typeof m.nativeClosed==='boolean',
  'ASE MD integrator or frozen atom evidence differs');
  if (value.event === 'stopped' || value.event === 'completed') assert(m.nativeClosed, 'ASE MD termination requires the calculator to close');
  assert(canonical(m.solvation)===canonical(r.solvation), 'ASE MD solvation evidence differs');
  assert(Number.isSafeInteger(m.degreesOfFreedom)&&m.degreesOfFreedom>0&&m.degreesOfFreedom<=3*r.movableAtomIds.length,
  'ASE MD degrees of freedom are invalid');
  assert(Number.isSafeInteger(m.effectiveSeed)&&m.effectiveSeed>=0&&m.effectiveSeed<=0xffffffff
    && (r.seed===undefined?m.seedTreatment==='program-random':m.seedTreatment==='specified'&&m.effectiveSeed===r.seed),
  'ASE MD seed evidence differs');
  // The initial snapshot and early stop can predate the first calculator call.
  if (value.step===0&&value.energyEV===undefined) return;
  const expected = r.constraints ?? [];
  const rows = m.internalConstraints;
  assert(Array.isArray(rows)&&rows.length===expected.length&&rows.every((row,i)=>plain(row)
    && row.type===expected[i].type&&row.id===expected[i].id&&canonical(row.atomIds)===canonical(expected[i].atomIds)
    && canonical(row.images)===canonical(expected[i].images)&&row.action==='freeze'&&row.target===expected[i].value
    && [row.actual,row.residual,row.velocityResidual].every(Number.isFinite)&&row.unit===(row.type==='B'?'angstrom':'degree')
    && row.mode==='ase-rattle'), 'ASE MD internal-coordinate evidence differs');
  assert(m.fixedPositionResidualAngstrom===0&&m.fixedVelocityResidualAngstromPerFs===0, 'ASE MD fixed position or velocity changed');
  const shake=m.shake;
  assert(plain(shake)&&shake.enabled===r.shakeHydrogenBonds&&shake.algorithm==='ASE-RATTLE'
    && Number.isSafeInteger(shake.hydrogenBondCount)&&shake.hydrogenBondCount>=0
    && Array.isArray(shake.observedBondLengthsAngstrom)&&shake.observedBondLengthsAngstrom.length===shake.hydrogenBondCount
    && shake.observedBondLengthsAngstrom.every(n=>Number.isFinite(n)&&n>0)
    && [shake.maxBondResidualAngstrom,shake.maxBondVelocityResidualAngstromPerFs].every(n=>Number.isFinite(n)&&n>=0)
    && (shake.enabled||shake.hydrogenBondCount===0), 'ASE MD hydrogen bond constraint evidence differs');
  assert(plain(m.calculatorEvidence)&&Number.isFinite(m.physicalEnergyEV)&&value.energyEV===m.physicalEnergyEV,
  'ASE MD calculator or physical energy evidence differs');
}
function validateEvent(value, session) {
  assert(plain(value) && value.schema === 1 && value.sessionId === session.sessionId && EVENTS.has(value.event), 'Invalid dynamics event identity');
  assert(value.displayFrames === undefined && value.displayByteLength === undefined, 'Display batches may only be created by the trusted host');
  assert(Number.isSafeInteger(value.seq) && value.seq > session.lastSeq, 'Dynamics event sequence is not increasing');
  if (value.event === 'ready') return value;
  assert(sameSourceStamp(value.stamp, session.request.stamp) && value.operation === session.request.operation, 'Dynamics document stamp changed');
  assert(Number.isSafeInteger(value.step) && value.step >= session.lastStep && (session.request.untilStopped || value.step <= session.request.maxSteps), 'Invalid dynamics step');
  assert(Number.isFinite(value.timeFs) && value.timeFs >= session.lastTimeFs, 'Invalid dynamics physical time');
  assert(value.timeFs === value.step*(session.request.dtFs ?? 1), 'Dynamics physical time must equal step times actual timestep');
  if(session.request.untilStopped){assert(!['paused','resumed','temperature'].includes(value.event),'Continuous MD cannot pause or change temperature');assert(value.targetTemperatureK===undefined||value.targetTemperatureK===(session.request.temperatureK??300),'Continuous MD target temperature changed');}
  if (session.request.integrator==='ase') {
    assert(value.nativeMD===undefined,'ASE MD cannot publish native integration evidence');
    if(value.structure||value.event==='stopped'||value.event==='completed')validateAseEvidence(value,session);
  } else {
    assert(value.aseMD===undefined,'Native MD cannot publish ASE integration evidence');
  }
  if(session.request.integrator!=='ase'&&session.request.method&&value.structure){
    const r=session.request,m=value.nativeMD;
    assert(plain(m)&&m.method===r.method&&m.dtFs===2&&m.thermostat==='Berendsen'&&m.hydrogenMassAmu===(r.hydrogenMassAmu??(m.method==='gfnff'?4:null))&&m.shakeHydrogenBonds===(r.shakeHydrogenBonds??(m.method!=='gfnff'))&&canonical(m.protectedAtomIds)===canonical(r.protectedAtomIds??[])&&m.protection===(m.protectedAtomIds.length?'pairwise-distance':'none')&&m.forceConstantKJMolNm2===500000&&Number.isSafeInteger(m.segment)&&m.segment>=0&&m.velocityInitialization===(m.segment===0?'fresh':'restart')&&typeof m.nativeClosed==='boolean','Native MD method or protection evidence differs');
    assert(Boolean(m.periodic)===(r.structure.cell?.pbc.some(Boolean)===true),'Native MD fixed-cell mode differs');
    assert(m.effectiveSeed===undefined||m.method!=='gxtb'&&m.seedTreatment==='verified'&&m.effectiveSeed===r.seed,'Native MD effective seed differs');
    assert(m.seedTreatment===undefined||(m.method==='gxtb'?m.seedTreatment==='program-random':value.engineVersion==='6.8.0'?m.seedTreatment==='verified':m.seedTreatment==='native-internal-initialization'),'Native MD seed treatment differs');
    if(m.solvation!==undefined)assert(r.solvation&&m.solvation.model==='alpb'&&m.solvation.solvent===r.solvation.solvent&&m.solvation.kernel==='p16'&&m.solvation.referenceState==='gsolv'&&m.solvation.temperatureKelvin===Number(r.temperatureK.toExponential(4))&&m.solvation.parameterSet===`internal ${XTB_METHOD_LABELS[m.method]}/ALPB`,'Native MD solvation differs');
    if(value.step>0&&r.solvation)assert(m.solvation,'Native MD solvation readback is missing');
    if(m.degreesOfFreedom!==undefined)assert(Number.isSafeInteger(m.degreesOfFreedom)&&m.degreesOfFreedom>=0&&m.degreesOfFreedom<=3*r.structure.atoms.length,'Native MD degrees of freedom are invalid');
    if(m.restartInputSha256!==undefined)assert(m.segment>0&&/^[a-f0-9]{64}$/.test(m.restartInputSha256),'Native MD restart identity differs');
    if(m.internalConstraints!==undefined||value.step>0){
      const expected=r.constraints??[],rows=m.internalConstraints??[];
      assert(Array.isArray(rows)&&rows.length===expected.length&&rows.every((row,i)=>plain(row)&&row.type===expected[i].type&&row.id===expected[i].id&&canonical(row.atomIds)===canonical(expected[i].atomIds)&&row.target===expected[i].value&&Number.isFinite(row.actual)&&Number.isFinite(row.residual)&&row.unit===(row.type==='B'?'angstrom':'degree')&&row.mode==='native-harmonic'),'Native MD constraint observations differ');
    }
  }
  if(session.request.integrator!=='ase'&&session.request.method&&value.event==='stopped')assert(value.nativeMD?.nativeClosed===true,'Native MD Stop requires actual native process closure');
  if(session.request.method&&value.nativeMD?.rawPotential!==undefined){const p=value.nativeMD.rawPotential,protectedRun=Boolean(session.request.protectedAtomIds?.length||session.request.constraints?.length);assert(plain(p)&&Number.isFinite(p.value)&&p.unit==='hartree'&&p.definition===(protectedRun?'native-total-including-protection':'native-physical-potential')&&p.includesProtection===protectedRun&&p.sourceArtifact==='xtb.trj'&&Number.isSafeInteger(p.sourceStep)&&p.sourceStep>=0&&p.sourceStep<=value.step&&p.sourceTimeFs===p.sourceStep*2&&Number.isSafeInteger(p.segment)&&p.segment>=0&&p.segment<=value.nativeMD.segment,'Native MD raw potential source or definition differs');}
  if (value.event === 'completed' && value.reason !== undefined) assert(value.reason === 'step-limit' && value.converged === false, 'Invalid MD completion reason');
  for (const key of ['energyEV', 'kineticEnergyEV', 'temperatureK', 'targetTemperatureK']) assert(value[key] === undefined || Number.isFinite(value[key]), `Nonfinite dynamics ${key}`);
  if (value.event === 'frame' || value.event === 'completed' || value.event === 'stopped') assert(value.structure, 'Dynamics snapshot missing');
  if (value.structure) {
    validateStructure(value.structure);
    assert(value.structure.id === session.request.structure.id && value.structure.dimension === session.request.structure.dimension && value.structure.atoms.length === session.request.structure.atoms.length && value.structure.atoms.every((atom, index) => atom.id === session.request.structure.atoms[index].id && atom.stereoParity === session.request.structure.atoms[index].stereoParity), 'Dynamics ordered atom or structure identity changed');
    assert(sameOrderedGraph(value.structure, session.request.structure) || graph(value.structure) === session.graph, 'Dynamics graph or stable atom identities changed');
    value.structure.atoms.forEach((atom, index) => {
      const original = session.request.structure.atoms[index];
      assert(Math.max(Math.abs(atom.x), Math.abs(atom.y), Math.abs(atom.z)) <= 1e6, 'Dynamics coordinate outside finite safety bound');
      if (!session.movable.has(atom.id)) assert(atom.x === original.x && atom.y === original.y && atom.z === original.z, 'Dynamics frozen atom moved');
    });
  }
  if (value.error !== undefined) assert(plain(value.error) && string(value.error.code, 100) && string(value.error.message, 8192), 'Invalid dynamics error');
  return value;
}
module.exports = { MAX_EVENT_BYTES, TERMINAL_EVENTS, canonical, graph, sessionIdentity, validateStart, validateCommand, validateEvent };
