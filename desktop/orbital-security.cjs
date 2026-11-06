'use strict';
const { createHash } = require('node:crypto');
const { assert, plain, string } = require('./security.cjs');
// Representation ceilings only; transport uses owned files and bounded reads.
const MAX_SOURCE_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_POINTS = Number.MAX_SAFE_INTEGER;
const MAX_CUBE_BYTES = Number.MAX_SAFE_INTEGER;
/** Per analysis: selected Float64 + Float32 render grid, both marching-cubes
 * phases at 5 triangles/cell with 3 vertices and position/normal Float32 data,
 * plus a conservative corresponding GPU copy: 2 * 2 * 5 * 3 * 6 * 4 = 1440.
 * This is an orbital-feature estimate, not an application hard memory cap;
 * additional 3Dmol object overhead can remain implementation-dependent. */
function rendererReserveBytes(grid) {
  const points=grid.dimensions.reduce((a,b)=>a*b,1),cells=grid.dimensions.reduce((a,b)=>a*(b-1),1);
  // Two recent Float64 reads and two CPU meshes, capped by frontend limits.
  // Each sign has at most five triangles/cell; 256 bytes/vertex + 16/index
  // conservatively covers the retained JS geometry. Read cache is shared,
  // so reserving it for every view is deliberately conservative.
  const readCache=Math.min(32*1024**2,16*points);
  const meshCache=Math.min(16*1024**2,16*points+16320*cells);
  return 12*points+1440*cells+readCache+meshCache;
}
/** Refuse before asking the worker to build a full string/JSON packet. */
function cubeExportUpperBound(grid,atomCount) {
  return 24*grid.dimensions.reduce((a,b)=>a*b,1)+4096*atomCount+65536;
}
function identity(value) { assert(string(value, 128) && /^[a-zA-Z0-9_-]+$/.test(value), 'Invalid orbital session identity'); return value; }
function nativeDiagnostics(value) {
  assert(plain(value)&&Object.keys(value).every(key=>['phase','exitCode','exitCodeHex','nativeMemoryBudgetBytes','threads','memory','outputTail'].includes(key)),'Invalid orbital native diagnostics');
  assert(string(value.phase,256)&&typeof value.outputTail==='string'&&value.outputTail.length<=4096,'Invalid orbital native diagnostic text');
  assert(value.exitCode===null||Number.isSafeInteger(value.exitCode),'Invalid orbital native exit code');
  assert(value.exitCodeHex===null||typeof value.exitCodeHex==='string'&&/^0x[0-9A-F]{8}$/.test(value.exitCodeHex),'Invalid orbital native exit status');
  assert(Number.isSafeInteger(value.nativeMemoryBudgetBytes)&&value.nativeMemoryBudgetBytes>0&&Number.isSafeInteger(value.threads)&&value.threads>0,'Invalid orbital native diagnostic grant');
  assert(plain(value.memory)&&Object.keys(value.memory).every(key=>['peakWorkingSetBytes','workingSetBytes','privateCommitBytes','peakPrivateCommitBytes'].includes(key)&&Number.isSafeInteger(value.memory[key])&&value.memory[key]>=0),'Invalid orbital native memory counters');
  return value;
}
function resourceInfo(value){
  assert(plain(value)&&Number.isSafeInteger(value.threads)&&value.threads>0&&value.threads<=2147483647,'Invalid effective thread count');
  for(const key of ['memoryBudgetBytes','totalPhysicalMemoryBytes','logicalCpuCount'])assert(Number.isSafeInteger(value[key])&&value[key]>0,'Invalid effective resource budget');
  assert(['settings','logical-cpus','request'].includes(value.threadSource)&&['physical-ram','request'].includes(value.memorySource),'Invalid resource provenance');
  assert(typeof value.settingsPresent==='boolean'&&(value.settingsPath===null||string(value.settingsPath,4096))&&/^[a-f0-9]{64}$/.test(value.settingsRevision),'Invalid source settings identity');
  assert(Array.isArray(value.temporaryOverrides)&&value.temporaryOverrides.length===6&&value.temporaryOverrides.every(v=>plain(v)&&['nthreads','idelvirorb','compthres','bndordthres','isilent','iaddprefix'].includes(v.key)&&Number.isSafeInteger(v.value)&&v.value>=0&&string(v.reason,256)&&typeof v.changed==='boolean'),'Invalid temporary settings summary');
  return value;
}
function sourceRequest(value) {
  assert(plain(value) && Object.keys(value).every(key => ['sessionId','sourceId','name','text','sourceToken'].includes(key)), 'Invalid orbital source request');
  identity(value.sessionId); assert(string(value.sourceId, 256) && string(value.name, 256) && !/[\\/]/.test(value.name), 'Invalid orbital source name');
  assert(value.sourceToken===undefined?string(value.text,MAX_SOURCE_BYTES):string(value.sourceToken,256)&&value.text===undefined,'A complete text or owned source token is required');
  return { ...value };
}
function planRequest(value) {
  assert(plain(value) && Object.keys(value).every(key => ['grid','threads','memoryBudgetBytes','mode'].includes(key)), 'Invalid orbital grid request');
  assert(value.mode===undefined||['all','selected'].includes(value.mode),'Invalid orbital generation mode');
  const grid = value.grid;
  const vector = v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6);
  assert(plain(grid) && grid.coordinateUnit === 'bohr' && grid.ordering === 'z-fastest' && vector(grid.origin), 'Invalid orbital grid units/origin');
  assert(Object.keys(grid).every(key => ['coordinateUnit','ordering','origin','axes','dimensions'].includes(key)), 'Unknown orbital grid field');
  assert(Array.isArray(grid.axes) && grid.axes.length === 3 && grid.axes.every(vector), 'Invalid orbital grid axes');
  assert(grid.axes.every((axis,i) => axis.every((n,j) => i === j ? n > 0 : n === 0)), 'Multiwfn requires a positive orthogonal orbital grid');
  assert(Array.isArray(grid.dimensions) && grid.dimensions.length === 3 && grid.dimensions.every(n => Number.isSafeInteger(n) && n >= 2), 'Invalid orbital grid dimensions');
  assert(Number.isSafeInteger(grid.dimensions.reduce((a,b) => a*b,1)*8), 'Orbital grid exceeds integer representation');
  assert(value.threads===undefined||(Number.isSafeInteger(value.threads)&&value.threads>=1&&value.threads<=2147483647), 'Invalid orbital thread budget');
  assert(value.memoryBudgetBytes===undefined||(Number.isSafeInteger(value.memoryBudgetBytes)&&value.memoryBudgetBytes>=1), 'Invalid orbital memory budget');
  const detached = JSON.parse(JSON.stringify(value));
  return { ...detached, mode:detached.mode??'all', gridKey: createHash('sha256').update(JSON.stringify(detached.grid)).digest('hex') };
}
function commandRequest(value, keys) {
  assert(plain(value) && ['generate','continue','prioritize','generate-one','stop','status','close'].includes(value.operation) && Object.keys(value).every(key => ['operation','priorityKeys','orbitalKey'].includes(key)), 'Invalid orbital command');
  assert(value.operation==='generate-one'?keys.has(value.orbitalKey):value.orbitalKey===undefined,'Single-orbital generation requires an existing source key');
  const priorityKeys = value.priorityKeys ?? [];
  assert(Array.isArray(priorityKeys) && priorityKeys.length <= keys.size && new Set(priorityKeys).size === priorityKeys.length && priorityKeys.every(key => keys.has(key)), 'Invalid orbital priority keys');
  assert(!priorityKeys.length || ['generate','continue','prioritize'].includes(value.operation), 'Priority requires a generation command');
  return { operation: value.operation, priorityIds: [...priorityKeys],...(value.operation==='generate-one'?{orbitalId:value.orbitalKey}:{}) };
}
function decodeField(value, session, orbitalKey) {
  assert(value.orbitalId === orbitalKey && value.encoding === 'float64-le-base64' && value.valueUnit === 'bohr^-3/2', 'Invalid orbital field identity/units');
  const expectedGrid = { originBohr: session.plan.grid.origin, axesBohr: session.plan.grid.axes, dimensions: session.plan.grid.dimensions };
  assert(plain(value.grid) && ['originBohr','axesBohr','dimensions'].every(key => JSON.stringify(value.grid[key]) === JSON.stringify(expectedGrid[key])), 'Orbital field grid changed');
  const byteLength = expectedGrid.dimensions.reduce((a,b) => a*b,1)*8;
  assert(value.dataBase64 instanceof Uint8Array?value.dataBase64.byteLength===byteLength:typeof value.dataBase64 === 'string' && value.dataBase64.length === Math.ceil(byteLength/3)*4 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64), 'Invalid orbital field encoding/length');
  const bytes = typeof value.dataBase64==='string'?Buffer.from(value.dataBase64, 'base64'):value.dataBase64; assert(bytes.length === byteLength, 'Orbital field byte count changed');
  assert(require('node:os').endianness() === 'LE', 'Unsupported orbital field host byte order');
  const array = bytes.byteOffset%8===0?new Float64Array(bytes.buffer,bytes.byteOffset,byteLength/8):new Float64Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+byteLength));
  for (const number of array) assert(Number.isFinite(number), 'Nonfinite orbital field');
  return { sessionId: session.sessionId, sourceRevision: session.sourceRevision, gridKey: session.plan.gridKey, orbitalKey, grid: session.plan.grid, valueUnit: 'bohr^-3/2', values: array };
}
module.exports = { MAX_SOURCE_BYTES, MAX_POINTS, MAX_CUBE_BYTES, rendererReserveBytes, cubeExportUpperBound, identity, nativeDiagnostics, resourceInfo, sourceRequest, planRequest, commandRequest, decodeField };
