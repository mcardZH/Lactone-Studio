'use strict';
const path = require('node:path');
const { validateStructureLibraryProvenance } = require('./structure-library-provenance-runtime.cjs');

const FORMATS = Object.freeze({ sciyue: ['sciyue'], gjf: ['gjf'], com: ['com'], inp: ['inp'], xyz: ['xyz'], extxyz: ['extxyz'], mol: ['mol'], sdf: ['sdf'], pdb: ['pdb'], cif: ['cif'], poscar: ['vasp', 'poscar'] });
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FINGERPRINT_BYTES = 1024 * 1024;
function assert(condition, message = 'Invalid desktop request') { if (!condition) throw new Error(message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function string(value, max = 1024) { return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'); }
function boundedJSON(value) { const text = JSON.stringify(value); assert(typeof text === 'string', 'Payload must be JSON serializable'); return text; }
function within(root, target) { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function validateLayerDraftRoles(layers) {
  if (layers === undefined) return;
  assert(Array.isArray(layers), 'Invalid layer metadata');
  for (const layer of layers) {
    assert(plain(layer), 'Invalid layer metadata');
    if (layer.draftRole === undefined) continue;
    const role = layer.draftRole;
    assert(plain(role) && Object.keys(role).length === 3 && Object.keys(role).every(key => ['type', 'engine', 'state'].includes(key)) && role.type === 'input-layer' && ['gaussian', 'orca'].includes(role.engine) && ['active', 'cleared'].includes(role.state), 'Invalid input-layer draftRole metadata');
  }
}
function validateCell(value) {
  if(value===undefined)return;
  assert(plain(value)&&Array.isArray(value.vectors)&&value.vectors.length===3&&value.vectors.every(row=>Array.isArray(row)&&row.length===3&&row.every(Number.isFinite))&&Array.isArray(value.pbc)&&value.pbc.length===3&&value.pbc.every(flag=>typeof flag==='boolean'),'Invalid periodic cell');
  const [a,b,c]=value.vectors,det=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
  assert(Number.isFinite(det)&&Math.abs(det)>=1e-10,'Singular periodic cell');
  assert(value.origin===undefined||Array.isArray(value.origin)&&value.origin.length===3&&value.origin.every(Number.isFinite),'Invalid periodic cell origin');
  if(value.pbcProvenance!==undefined){const source=value.pbcProvenance;assert(plain(source)&&Object.keys(source).every(key=>['kind','evidence'].includes(key))&&['source-explicit','format-defined','user-confirmed','unconfirmed'].includes(source.kind)&&string(source.evidence,4096)&&source.evidence.trim(),'Invalid periodic source-axis provenance');}
}
function validateImage(image,cell){
  assert(Array.isArray(image)&&image.length===3&&image.every(Number.isSafeInteger),'Invalid finite integer image');
  assert(image.every((value,axis)=>value===0||cell?.pbc[axis]===true),'Image requires a real cell and a periodic source axis');
}
function imageReferenceKey(a,b,image=[0,0,0]){const forward=JSON.stringify([a,b,image]),reverse=JSON.stringify([b,a,image.map(n=>-n)]);return forward<reverse?forward:reverse;}
function validateCoordinateImages(object,atomIds,structure){
  assert(Array.isArray(object.atomIds)&&object.atomIds.every(id=>typeof id==='string'&&atomIds.has(id)),'Invalid coordinate atom identities');
  if(object.images===undefined){assert(new Set(object.atomIds).size===object.atomIds.length,'Repeated base atoms require explicit distinct image endpoints');return;}
  assert(Array.isArray(object.images)&&object.images.length===object.atomIds.length,'Invalid coordinate endpoint images');
  for(const image of object.images)validateImage(image,structure?.cell);
  assert(object.images[0].every(value=>value===0),'First coordinate endpoint must be in the base cell');
  assert(new Set(object.atomIds.map((id,i)=>JSON.stringify([id,object.images[i]]))).size===object.atomIds.length,'Duplicate coordinate image endpoint');
}
function validateStructure(value, budget = {}) {
  const { maxAtoms, maxBonds, maxIssues } = budget;
  assert(plain(budget) && Object.keys(budget).every(key=>['maxAtoms','maxBonds','maxIssues'].includes(key)) && [maxAtoms,maxBonds,maxIssues].every(value=>value===undefined||Number.isSafeInteger(value)&&value>=0), 'Invalid structure validation budget');
  assert(plain(value) && string(value.id) && typeof value.name === 'string' && Array.isArray(value.atoms), 'Invalid molecular structure');
  assert(maxAtoms === undefined || value.atoms.length <= maxAtoms, 'Molecular structure exceeds the explicitly supplied budget');
  const ids = new Set();
  for (const atom of value.atoms) {
    assert(plain(atom) && string(atom.id) && /^[A-Z][a-z]?$/.test(atom.element) && [atom.x, atom.y, atom.z].every(Number.isFinite), 'Invalid atom');
    assert(!ids.has(atom.id), 'Duplicate atom identity'); ids.add(atom.id);
    assert(atom.geometryPresetId === undefined || string(atom.geometryPresetId, 100), 'Invalid atom geometry preset');
  }
  validateCell(value.cell);
  if(value.libraryProvenance!==undefined)validateStructureLibraryProvenance(value.libraryProvenance);
  if(value.periodicSource!==undefined){const source=value.periodicSource;assert(plain(source)&&source.completeness==='partial'&&string(source.evidence,4096)&&Array.isArray(source.translationVectors)&&[1,2].includes(source.translationVectors.length)&&source.translationVectors.every(row=>Array.isArray(row)&&row.length===3&&row.every(Number.isFinite)),'Invalid partial translation source');}
  assert(!value.bonds || (Array.isArray(value.bonds) && (maxBonds === undefined || value.bonds.length <= maxBonds)), 'Invalid bonds or bond budget');
  const bondKeys=new Set();
  for (const bond of value.bonds || []) {
    assert(plain(bond) && Number.isInteger(bond.a) && Number.isInteger(bond.b) && bond.a >= 0 && bond.b >= 0 && bond.a < value.atoms.length && bond.b < value.atoms.length && [0.5, 1, 1.5, 2, 3].includes(bond.order), 'Invalid bond');
    const image=bond.image??[0,0,0];validateImage(image,value.cell);assert(bond.a!==bond.b||image.some(Boolean),'Self connection requires a nonzero valid image');
    const key=imageReferenceKey(bond.a,bond.b,image);assert(!bondKeys.has(key),'Duplicate bond image identity');bondKeys.add(key);
    assert(bond.fractional === undefined || typeof bond.fractional === 'boolean', 'Invalid fractional bond marker');
    assert(bond.aromatic === undefined || typeof bond.aromatic === 'boolean', 'Invalid aromatic bond marker');
    assert(bond.kind === undefined || ['covalent', 'coordination'].includes(bond.kind), 'Invalid bond kind');
    assert(bond.fractional !== true || [0.5, 1.5].includes(bond.order) && bond.aromatic !== true, 'Fractional connection must be explicitly non-aromatic order 0.5 or 1.5');
    assert(bond.order !== 0.5 || bond.fractional === true, 'Order 0.5 requires explicit fractional connection; auxiliary lines are separate');
    assert(bond.perception === undefined || ['gfn2-mbo', 'metal-distance','periodic-distance','periodic-gfn2','empirical-distance','empirical-organic'].includes(bond.perception), 'Invalid bond perception source');
    assert(bond.orderKnown===undefined||bond.orderKnown===false,'Invalid unknown-order marker');
    if(bond.orderKnown===false)assert(bond.order===1&&bond.fractional!==true&&bond.aromatic!==true&&bond.mbo===undefined,'Unknown order cannot impersonate a measured/aromatic/multiple bond');
    if(bond.perception==='periodic-distance')assert(value.cell&&bond.orderKnown===false,'Periodic distance connectivity requires a cell and explicit unknown order');
    if(bond.perception==='empirical-distance')assert(bond.orderKnown===false&&bond.order===1&&!bond.aromatic&&!bond.fractional&&bond.mbo===undefined,'Empirical distance connectivity cannot claim measured order');
    if(bond.perception==='empirical-organic')assert(bond.orderKnown!==false&&[1,1.5,2,3].includes(bond.order)&&!bond.fractional&&bond.mbo===undefined&&bond.kind!=='coordination'&&Boolean(bond.aromatic)===(bond.order===1.5),'Invalid empirical organic order');
    assert(bond.mbo === undefined || Number.isFinite(bond.mbo) && bond.mbo > .1, 'Invalid raw MBO');
    assert(bond.mbo === undefined || bond.perception !== undefined, 'Raw MBO requires bond perception source');
    if (bond.perception === 'gfn2-mbo') {
      const raw = bond.mbo, order = raw <= .25 ? 0 : raw <= .75 ? .5 : raw <= 1.25 ? 1 : raw <= 1.75 ? 1.5 : raw <= 2.5 ? 2 : 3;
      assert(Number.isFinite(raw) && raw > .25 && order === bond.order && bond.aromatic !== true && bond.kind !== 'coordination' && Boolean(bond.fractional) === [.5, 1.5].includes(order) && !bond.image?.some(Boolean), 'Invalid quantized GFN2 MBO bond');
    }
    if(bond.perception==='periodic-gfn2'){
      const raw=bond.mbo,order=raw<=.25?0:raw<=.75?.5:raw<=1.25?1:raw<=1.75?1.5:raw<=2.5?2:3;
      assert(Number.isFinite(raw)&&raw>.25&&order===bond.order&&bond.aromatic!==true&&bond.kind!=='coordination'&&bond.orderKnown!==false&&Boolean(bond.fractional)===[.5,1.5].includes(order),'Invalid periodic GFN2 order');
      validatePeriodicAggregateBond(value,bond);
    }
    if (bond.perception === 'metal-distance') assert(bond.kind === 'coordination' && bond.order === 1 && bond.fractional !== true && bond.aromatic !== true && !bond.image?.some(Boolean) && (bond.mbo === undefined || bond.mbo <= .25), 'Invalid metal-distance contact');
  }
  validateLayerDraftRoles(value.modelLayers);
  if (value.bondPerceptionIssues !== undefined) {
    assert(Array.isArray(value.bondPerceptionIssues) && (maxIssues === undefined || value.bondPerceptionIssues.length <= maxIssues), 'Invalid bond perception issue budget');
    const pairs = new Set();
    for (const issue of value.bondPerceptionIssues) {
      assert(plain(issue) && Object.keys(issue).every(key => ['atomIds', 'image', 'kind', 'reason'].includes(key)) && Array.isArray(issue.atomIds) && issue.atomIds.length === 2 && issue.atomIds.every(id => typeof id === 'string' && ids.has(id)) && ['partial', 'weak-contact', 'unresolved'].includes(issue.kind) && string(issue.reason, 1000) && issue.reason.trim(), 'Invalid bond perception issue');
      const image=issue.image??[0,0,0];validateImage(image,value.cell);assert(issue.atomIds[0]!==issue.atomIds[1]||image.some(Boolean),'Self issue requires a valid image');
      const pair = imageReferenceKey(issue.atomIds[0],issue.atomIds[1],image); assert(!pairs.has(pair), 'Duplicate bond perception issue'); pairs.add(pair);
    }
  }
  return ids;
}
function validatePeriodicAggregateBond(structure,bond){
  const cell=structure.cell;assert(cell&&cell.pbc.some(Boolean)&&cell.pbcProvenance?.kind!=='unconfirmed'&&bond.a!==bond.b&&Array.isArray(bond.image),'Periodic GFN2 needs confirmed cell and distinct atoms');
  const [a,b,c]=cell.vectors,cross=(u,v)=>[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],dot=(u,v)=>u.reduce((sum,x,i)=>sum+x*v[i],0),volume=dot(a,cross(b,c));
  assert(Number.isFinite(volume)&&Math.abs(volume)>1e-10,'Singular periodic GFN2 cell');const inverse=[cross(b,c),cross(c,a),cross(a,b)].map(row=>row.map(x=>x/volume));
  const first=structure.atoms[bond.a],second=structure.atoms[bond.b],q=['x','y','z'].map(key=>second[key]-first[key]),distance=image=>Math.hypot(...q.map((x,k)=>x+image.reduce((sum,n,i)=>sum+n*cell.vectors[i][k],0))),f=inverse.map(row=>dot(row,q)),guess=f.map((x,i)=>cell.pbc[i]?-Math.round(x):0),upper=distance(guess),tolerance=1e-7*Math.max(1,upper),radius=upper+tolerance;
  const bounds=inverse.map((row,i)=>cell.pbc[i]?[Math.ceil(-f[i]-Math.hypot(...row)*radius-1e-9),Math.floor(-f[i]+Math.hypot(...row)*radius+1e-9)]:[0,0]);assert(bounds.flat().every(Number.isSafeInteger),'Periodic GFN2 image search exceeds bounds');
  const visit=callback=>{for(let i=bounds[0][0];i<=bounds[0][1];i++)for(let j=bounds[1][0];j<=bounds[1][1];j++)for(let k=bounds[2][0];k<=bounds[2][1];k++)callback([i,j,k]);};
  let best=upper;visit(image=>{best=Math.min(best,distance(image));});let count=0;visit(image=>{if(Math.abs(distance(image)-best)<=1e-7*Math.max(1,best))count++;});
  assert(count===1&&Math.abs(distance(bond.image)-best)<=1e-7*Math.max(1,best),'Periodic GFN2 must identify the unique nearest image');
}
function validateAttachmentPorts(value, atomIds, maximum) {
  if (value === undefined) return;
  assert(Array.isArray(value) && (maximum === undefined || value.length <= maximum), 'Invalid attachment ports or port budget');
  const ids = new Set();
  for (const port of value) {
    assert(plain(port) && string(port.id, 200) && !ids.has(port.id) && !atomIds.has(port.id) && string(port.hostAtomId) && atomIds.has(port.hostAtomId), 'Invalid attachment port identity or host');
    assert(Object.keys(port).every(key => ['id', 'hostAtomId', 'direction', 'order', 'displayLength', 'presetId', 'slotId'].includes(key)), 'Unknown attachment port field');
    assert(Array.isArray(port.direction) && port.direction.length === 3 && port.direction.every(Number.isFinite) && Math.abs(Math.hypot(...port.direction) - 1) <= 1e-6, 'Invalid attachment port direction');
    assert([1, 1.5, 2, 3].includes(port.order) && Number.isFinite(port.displayLength) && port.displayLength > 0 && port.displayLength <= 10, 'Invalid attachment port order or length');
    assert([port.presetId, port.slotId].every(value => value === undefined || string(value, 200)), 'Invalid attachment port provenance');
    ids.add(port.id);
  }
}
const coordinateKey = coordinate => {
  if(coordinate.images?.some(image=>image.some(Boolean))){const normalize=indices=>JSON.stringify(indices.map(i=>[coordinate.atomIds[i],coordinate.images[i].map((n,axis)=>{const delta=n-coordinate.images[indices[0]][axis];assert(Number.isSafeInteger(delta),'Coordinate image difference exceeds exact integer identity');return delta;})]));const indices=coordinate.atomIds.map((_,i)=>i),forward=normalize(indices),reverse=normalize([...indices].reverse());return coordinate.type+':'+(forward<reverse?forward:reverse);}
  const forward = JSON.stringify(coordinate.atomIds), reverse = JSON.stringify([...coordinate.atomIds].reverse());
  return coordinate.type + ':' + (forward < reverse ? forward : reverse);
};
function validateCoordinateObjects(value, atomIds, structure) {
  assert(value === undefined || Array.isArray(value), 'Invalid coordinate objects');
  const objects = new Map(), keys = new Set();
  for (const object of value || []) {
    assert(plain(object) && Object.keys(object).every(key => ['id', 'type', 'atomIds','images'].includes(key)) && string(object.id) && !objects.has(object.id) && ['B', 'A', 'D'].includes(object.type), 'Invalid or duplicate coordinate object identity');
    const count = { B: 2, A: 3, D: 4 }[object.type];
    assert(Array.isArray(object.atomIds) && object.atomIds.length === count,'Invalid coordinate object endpoint count');validateCoordinateImages(object,atomIds,structure);
    const key = coordinateKey(object); assert(!keys.has(key), 'Duplicate coordinate object'); keys.add(key); objects.set(object.id, object);
  }
  return objects;
}
function validateConstraints(value, atomIds, objects, structure) {
  if (value === undefined) return;
  assert(Array.isArray(value), 'Invalid internal coordinates');
  const ids = new Set();
  for (const coordinate of value) {
    assert(plain(coordinate) && ['B', 'A', 'D'].includes(coordinate.type) && ['freeze', 'scan'].includes(coordinate.action), 'Invalid internal coordinate');
    const count = { B: 2, A: 3, D: 4 }[coordinate.type];
    assert(Array.isArray(coordinate.atomIds) && coordinate.atomIds.length === count, 'Invalid internal-coordinate atom count');validateCoordinateImages(coordinate,atomIds,structure);
    assert(Number.isInteger(coordinate.steps) && coordinate.steps >= 0 && coordinate.steps <= 10000 && (coordinate.increment === null || Number.isFinite(coordinate.increment)), 'Invalid internal-coordinate parameters');
    assert(coordinate.id === undefined || string(coordinate.id) && !ids.has(coordinate.id), 'Invalid or duplicate internal-coordinate identity');
    if (coordinate.id !== undefined) ids.add(coordinate.id);
    assert(coordinate.objectId === undefined || string(coordinate.objectId), 'Invalid internal-coordinate object identity');
    if (objects && coordinate.objectId !== undefined) assert(objects.has(coordinate.objectId) && coordinateKey(objects.get(coordinate.objectId)) === coordinateKey(coordinate), 'Dangling or mismatched internal-coordinate object reference');
  }
}
function validateSharedConstraints(value, atomIds, objects, structure) {
  if (value === undefined) return;
  assert(plain(value) && Object.keys(value).every(key => ['frozenAtomIds', 'coordinates', 'canonical', 'enabled'].includes(key)) && (value.canonical === undefined || value.canonical === true) && (value.enabled === undefined || typeof value.enabled === 'boolean'), 'Invalid shared constraints');
  assert(Array.isArray(value.frozenAtomIds) && value.frozenAtomIds.length <= atomIds.size && new Set(value.frozenAtomIds).size === value.frozenAtomIds.length && value.frozenAtomIds.every(id => typeof id === 'string' && atomIds.has(id)), 'Invalid shared frozen atom identities');
  validateConstraints(value.coordinates, atomIds, objects,structure);
  assert(Array.isArray(value.coordinates), 'Invalid shared coordinates');
  const seen = new Set();
  for (const row of value.coordinates) {
    const validTarget = row.value === undefined || value.canonical === true && row.source === 'orca' && Number.isFinite(row.value) && (row.type === 'B' ? row.value > 0 : row.type === 'A' ? row.value > 0 && row.value < 180 : true);
    assert(Object.keys(row).every(key => ['id', 'objectId', 'type', 'atomIds','images', 'action', 'steps', 'increment', 'value', 'source'].includes(key)) && (row.source === undefined || row.source === 'orca') && validTarget && string(row.id) && string(row.objectId) && objects.has(row.objectId) && row.action === 'freeze' && row.steps === 1 && row.increment === null, 'Shared coordinate freeze requires a bound object and valid target');
    const key = coordinateKey(row); assert(!seen.has(key), 'Duplicate shared coordinate freeze'); seen.add(key);
  }
}
function validateGaussianBoundCoordinates(value, atomIds, objects) {
  if (value === undefined) return;
  assert(Array.isArray(value), 'Invalid Gaussian bound coordinate definitions');
  const ids = new Set(), fields = ['rowId', 'objectId', 'type', 'atomIds', 'action', 'rowEnabled', 'stepsText', 'incrementText'];
  for (const row of value) {
    assert(plain(row) && Object.keys(row).length === fields.length && Object.keys(row).every(key => fields.includes(key)) && string(row.rowId) && !ids.has(row.rowId) && string(row.objectId) && ['B', 'A', 'D'].includes(row.type) && ['freeze', 'scan'].includes(row.action) && typeof row.rowEnabled === 'boolean' && typeof row.stepsText === 'string' && typeof row.incrementText === 'string', 'Invalid or duplicate Gaussian bound coordinate identity or fields');
    ids.add(row.rowId); const count = { B: 2, A: 3, D: 4 }[row.type];
    assert(Array.isArray(row.atomIds) && row.atomIds.length === count && new Set(row.atomIds).size === count && row.atomIds.every(id => typeof id === 'string' && atomIds.has(id)), 'Invalid Gaussian bound coordinate atom identities');
    assert(objects.has(row.objectId) && coordinateKey(objects.get(row.objectId)) === coordinateKey(row), 'Dangling or mismatched Gaussian bound coordinate object reference');
    if (row.action === 'scan') {
      const steps = Number(row.stepsText), increment = Number(row.incrementText);
      assert(row.stepsText.trim() && row.incrementText.trim() && Number.isSafeInteger(steps) && steps >= 1 && steps <= 10000 && Number.isFinite(increment) && increment !== 0, 'Incomplete Gaussian bound scan definition');
    }
  }
}
function validateClipboard(value, structureBudget) {
  boundedJSON(value);
  assert(plain(value) && value.schema === 'sciyue-model-fragment' && value.version === 1 && string(value.sourceDocumentId) && plain(value.fragment), 'Unsupported clipboard payload');
  const ids = validateStructure(value.fragment.structure, structureBudget);
  assert(plain(value.fragment.assignments) && Array.isArray(value.fragment.auxiliaryRelations) && Array.isArray(value.fragment.deletedBonds), 'Invalid fragment metadata');
  validateLayerDraftRoles(value.fragment.assignments.layers);
  const objects = validateCoordinateObjects(value.fragment.coordinateObjects, ids,value.fragment.structure);
  validateConstraints(value.fragment.internalCoordinates, ids, objects,value.fragment.structure);
  validateSharedConstraints(value.fragment.sharedConstraints, ids, objects,value.fragment.structure);
  validateGaussianBoundCoordinates(value.fragment.gaussianBoundCoordinates, ids, objects);
  validateAttachmentPorts(value.fragment.attachmentPorts, ids);
  return value;
}
function validateBondOrderEvidence(value,ids,observation=false) {
  const fields=['definition','sourceField','threshold','entries',...(observation?['runId','engine','version','method','calculation','charge','uhf']:[])];
  const aggregate=observation&&value?.definition==='mayer-wiberg'&&value.sourceField==='tblite:bond-orders'&&value.threshold===0;
  assert(plain(value)&&Object.keys(value).every(key=>fields.includes(key))&&(aggregate||value.definition==='mayer-ao'&&value.sourceField==='wbo'&&value.threshold===.1)&&Array.isArray(value.entries),'Invalid MBO definition');
  assert(value.entries.length<=ids.size*(ids.size-1)/2,'Invalid MBO pair count');const pairs=new Set();
  if(aggregate)assert(value.entries.length===ids.size*(ids.size-1)/2,'Periodic aggregate requires every atom pair');
  for(const row of value.entries){
    assert(plain(row)&&Object.keys(row).every(key=>['atomIds','value'].includes(key))&&Array.isArray(row.atomIds)&&row.atomIds.length===2&&row.atomIds[0]!==row.atomIds[1]&&row.atomIds.every(id=>typeof id==='string'&&ids.has(id))&&Number.isFinite(row.value)&&(aggregate||row.value>=.1),'Invalid MBO pair');
    const key=JSON.stringify([...row.atomIds].sort());assert(!pairs.has(key),'Duplicate MBO pair');pairs.add(key);
  }
  if(observation)assert(string(value.runId,100)&&value.engine===(aggregate?'tblite':'xtb')&&string(value.version,100)&&value.method==='gfn2'&&['optimize','singlepoint'].includes(value.calculation)&&(!aggregate||value.calculation==='singlepoint')&&Number.isSafeInteger(value.charge)&&Number.isSafeInteger(value.uhf)&&value.uhf>=0,'Invalid MBO provenance');
}
function validateChemistry(value) {
  boundedJSON(value);
  assert(plain(value) && ['generate3d', 'optimize', 'perceive-bonds', 'convert'].includes(value.operation), 'Invalid chemistry operation');
  // Domain fingerprints intentionally contain canonical full JSON, not hashes.
  // Preserve the complete canonical identity independently of payload size.
  assert(plain(value.stamp) && string(value.stamp.documentId) && Number.isInteger(value.stamp.revision) && value.stamp.revision >= 0 && ['graphFingerprint', 'coordinatesFingerprint', 'constraintsFingerprint'].every(k => typeof value.stamp[k] === 'string'), 'Invalid document stamp');
  const ids = validateStructure(value.structure);
  if (value.empiricalBondParameters !== undefined) {
    assert(value.operation === 'perceive-bonds', 'Empirical parameters require explicit bond perception');
    validateEmpiricalBondParameters(value.empiricalBondParameters);
  }
  assert(value.bondPerceptionPolicy === undefined || value.operation === 'perceive-bonds' && (value.bondPerceptionPolicy === 'coordinate-import' && value.structure.bonds === undefined || value.bondPerceptionPolicy === 'composite-v1'), 'Invalid bond-perception policy or existing connection table');
  if(value.bondOrderEvidence!==undefined){
    assert(value.bondPerceptionPolicy==='composite-v1','MBO evidence requires composite perception');
    validateBondOrderEvidence(value.bondOrderEvidence,ids);
  }
  validateConstraints(value.constraints, ids,undefined,value.structure);
  assert(Array.isArray(value.movableAtomIds) && value.movableAtomIds.length <= ids.size && new Set(value.movableAtomIds).size === value.movableAtomIds.length && value.movableAtomIds.every(id => ids.has(id)), 'Invalid movable atom identities');
  assert(value.forcefield === undefined || ['auto', 'MMFF94', 'MMFF94s', 'UFF'].includes(value.forcefield), 'Invalid force field');
  assert(value.steps === undefined || Number.isSafeInteger(value.steps) && value.steps >= 1 && value.steps <= 2147483647, 'Optimization steps must fit RDKit signed 32-bit maxIts');
  assert(value.maxWallTimeSeconds === undefined || Number.isInteger(value.maxWallTimeSeconds) && value.maxWallTimeSeconds >= 1 && Number.isFinite(value.maxWallTimeSeconds), 'Invalid chemistry wall budget');
  if (value.runIdentity !== undefined) {
    assert(value.operation === 'optimize' && plain(value.runIdentity) && Object.keys(value.runIdentity).length === 2 && ['taskId', 'runId'].every(key => string(value.runIdentity[key], 100) && /^[A-Za-z0-9_-]+$/.test(value.runIdentity[key])), 'Invalid advanced chemistry run identity');
  }
  if (value.optimizationPool !== undefined) {
    const pool = value.optimizationPool;
    assert(value.operation === 'optimize' && value.runIdentity && plain(pool) && Object.keys(pool).length === 2
      && ['stageId', 'candidateId'].every(key => string(pool[key], 200) && /^[A-Za-z0-9_:-]+$/.test(pool[key])), 'Invalid chemistry optimization pool identity');
  }
  assert(value.aggression === undefined || ['conservative', 'standard', 'aggressive'].includes(value.aggression), 'Invalid bond aggression');
  assert(value.format === undefined || Object.hasOwn(FORMATS, value.format), 'Invalid output format');
  return value;
}
function validateEmpiricalBondParameters(value) {
  const keys = ['minDistanceFactor', 'maxDistanceFactor', 'bondOrderMode', 'pairOverrides', 'excludedElements'];
  const elements = new Set('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' '));
  assert(plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'Invalid empirical parameter fields');
  assert(Number.isFinite(value.minDistanceFactor) && Number.isFinite(value.maxDistanceFactor) && value.minDistanceFactor >= 0 && value.maxDistanceFactor > value.minDistanceFactor && value.maxDistanceFactor <= 3 && ['auto-organic', 'connectivity-only'].includes(value.bondOrderMode), 'Invalid empirical distance bounds or bond typing');
  assert(Array.isArray(value.excludedElements) && value.excludedElements.length <= elements.size && new Set(value.excludedElements).size === value.excludedElements.length && value.excludedElements.every(element => elements.has(element)), 'Invalid excluded elements');
  assert(Array.isArray(value.pairOverrides) && value.pairOverrides.length <= 500, 'Empirical pair override budget exceeded');
  const seen = new Set();
  for (const pair of value.pairOverrides) {
    assert(plain(pair) && Object.keys(pair).length === 3 && ['elements', 'minDistance', 'maxDistance'].every(key => Object.hasOwn(pair, key)) && Array.isArray(pair.elements) && pair.elements.length === 2 && pair.elements.every(element => elements.has(element)) && Number.isFinite(pair.minDistance) && Number.isFinite(pair.maxDistance) && pair.minDistance >= 0 && pair.maxDistance > pair.minDistance && pair.maxDistance <= 20, 'Invalid empirical pair override');
    const key = [...pair.elements].sort().join(':'); assert(!seen.has(key), 'Duplicate empirical pair override'); seen.add(key);
  }
  return value;
}
function validateSaveRequest(value) {
  assert(plain(value) && string(value.name, 180) && !/[\\/<>:"|?*\x00-\x1f]/.test(value.name), 'Invalid suggested filename');
  assert(Array.isArray(value.formats) && value.formats.length >= 1 && value.formats.length <= Object.keys(FORMATS).length, 'Invalid formats');
  for (const format of value.formats) assert(plain(format) && Object.hasOwn(FORMATS, format.id) && string(format.label, 80) && Array.isArray(format.extensions) && format.extensions.length > 0 && format.extensions.every(ext => FORMATS[format.id].includes(ext.toLowerCase())), 'Invalid format descriptor');
  assert(value.defaultFormat === undefined || value.formats.some(format => format.id === value.defaultFormat), 'Invalid default save format');
  return value;
}
function suggestedSaveName(name, format) {
  assert(typeof name === 'string' && Object.hasOwn(FORMATS, format), 'Invalid suggested save name or format');
  let base = name.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  // Strip only a recognized prior file suffix: dots within document labels
  // (including Chinese labels) are meaningful and must survive another save.
  const extension = path.extname(base).slice(1).toLowerCase();
  if (Object.values(FORMATS).some(extensions => extensions.includes(extension))) base = base.slice(0, -(extension.length + 1));
  if (!base) base = 'model';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = 'model_' + base;
  return base.slice(0, 160) + '.' + FORMATS[format][0];
}
function formatForPath(filePath, requested) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  const match = requested.find(format => FORMATS[format.id].includes(extension) || format.id === 'poscar' && basename === 'poscar');
  assert(match, 'Filename extension does not match a selected output format'); return match.id;
}
function allowedURL(raw, development) {
  try { const url = new URL(raw); if (url.username || url.password) return false; return development ? url.origin === 'http://127.0.0.1:4181' : url.protocol === 'app:' && url.hostname === 'studio' && !url.port; } catch { return false; }
}
function createNavigationGuard(development) {
  // Electron 44 puts url on the first Event<...> argument for both events.
  // will-frame-navigate has no positional second argument; will-navigate's
  // historical positional arguments are deprecated and deliberately ignored.
  return details => {
    const allowed = allowedURL(details.url, development);
    if (!allowed) details.preventDefault();
    return allowed;
  };
}
/** A small scientific-use receipt, never an editable document or arbitrary
 * JSON tunnel. Complete shared snapshots retain their own separate rules. */
function validateCipUsageEvent(event) {
  const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
  assert(exact(event, ['type', 'documentEpoch', 'projectionSerial', 'receipt']) && event.type === 'cip-used'
    && string(event.documentEpoch, 200) && (event.projectionSerial === null || Number.isSafeInteger(event.projectionSerial) && event.projectionSerial >= 0), 'Invalid CIP usage event');
  const receipt = event.receipt;
  assert(exact(receipt, ['documentId', 'sourceId', 'sourceRevision', 'software', 'version', 'operation', 'status', 'assignments'])
    && string(receipt.documentId, 200) && string(receipt.sourceRevision, 200)
    && typeof receipt.sourceId === 'string' && /^cip-geometry-sha256:[a-f0-9]{64}$/.test(receipt.sourceId)
    && receipt.software === 'Indigo' && receipt.version === '1.46.0' && receipt.operation === 'calculateCip' && receipt.status === 'succeeded'
    && Array.isArray(receipt.assignments) && receipt.assignments.length > 0, 'Invalid CIP usage receipt');
  const ids = new Set();
  for (const row of receipt.assignments) {
    assert(exact(row, ['atomId', 'element', 'label']) && string(row.atomId, 200) && row.element === 'C'
      && (row.label === 'R' || row.label === 'S') && !ids.has(row.atomId), 'Invalid CIP carbon assignment');
    ids.add(row.atomId);
  }
  assert(Buffer.byteLength(JSON.stringify(event), 'utf8') <= 512 * 1024, 'CIP usage control receipt is too large');
  return event;
}
module.exports = { FORMATS, MAX_BYTES, MAX_FINGERPRINT_BYTES, assert, plain, string, boundedJSON, within, validateStructure, validateAttachmentPorts, validateCoordinateObjects, validateSharedConstraints, validateClipboard, validateBondOrderEvidence, validateEmpiricalBondParameters, validateChemistry, validateSaveRequest, suggestedSaveName, formatForPath, allowedURL, createNavigationGuard, validateCipUsageEvent };
