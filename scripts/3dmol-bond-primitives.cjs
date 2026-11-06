'use strict';
/** SciYue's narrow public geometry-export seam for locked BSD-3-Clause
 * 3Dmol 2.5.5. Original copyright/license/header remain unchanged. This patch
 * does not replace glyph rules: an explicitly requested exporter records the
 * original drawBondSticks/drawBondLines output before GPU submission. Normal
 * rendering never installs the sink and retains its original code path.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = '2.5.5';
const SOURCE_SHA256 = '553ea0ab68182aafd520e598396d3903a354d22d3d02426b09cbc93ea0d28297';
const MARKER = 'SciYue exportBondPrimitives-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const api = `    /** SciYue exportBondPrimitives-v1: original glyph output, no GL resources. */
    exportBondPrimitives(first, second, representation = 'stick') {
        const a = this.atoms[first], b = this.atoms[second];
        if (!a || !b || first === second || !a.bonds.includes(second) || !['stick', 'line'].includes(representation))
            throw new Error('Invalid explicit bond primitive request');
        if (this._sciyueBondSink) throw new Error('Bond primitive export is not reentrant');
        if (a.style.stick?.aromaticStyle === 'circle' || b.style.stick?.aromaticStyle === 'circle')
            throw new Error('Circle aromatic glyphs require a complete ring surface, not bond primitives');
        const primitives = [], previousRings = this._drawnAromaticRings, previousCache = this._ringCache;
        const xyz = point => ({x: point.x, y: point.y, z: point.z});
        this._sciyueBondPair = [Math.min(first, second), Math.max(first, second)];
        this._sciyueBondSink = (kind, from, to, radius, color, fromCap = 0, toCap = 0) => {
            primitives.push({kind, start: xyz(from), end: xyz(to), radius, color: color.getHex(), fromCap, toCap});
        };
        this._drawnAromaticRings = new Set(); this._ringCache = new Map();
        try {
            const atom = this.atoms[this._sciyueBondPair[0]];
            if (representation === 'line') this.drawBondLines(atom, this.atoms, {});
            else this.drawBondSticks(atom, this.atoms, {imposter: false}, null);
            return {schema: 1, primitives};
        } finally {
            delete this._sciyueBondPair; delete this._sciyueBondSink;
            this._drawnAromaticRings = previousRings; this._ringCache = previousCache;
        }
    }
`;
const patches = [
  ['    drawBondSticks(atom, atoms, geo, torusGeo) {', api + '    drawBondSticks(atom, atoms, geo, torusGeo) {'],
  ['    addLine(vertexArray, colorArray, offset, p1, p2, c1) {', `    addLine(vertexArray, colorArray, offset, p1, p2, c1) {
        if (this._sciyueBondSink) { this._sciyueBondSink('line', p1, p2, 0, c1); return; }`],
  ['        var p1a, p1b, p2a, p2b;\n        // have a separate geometry for each linewidth\n        var linewidth = (style.linewidth || GLModel.defaultlineWidth);\n        if (!geos[linewidth])\n            geos[linewidth] = new _WebGL__WEBPACK_IMPORTED_MODULE_0__.Geometry();', `        var p1a, p1b, p2a, p2b;
        // have a separate geometry for each linewidth
        var linewidth = (style.linewidth || GLModel.defaultlineWidth);
        if (!geos[linewidth])
            geos[linewidth] = this._sciyueBondSink ? {updateGeoGroup: () => ({vertices: 0, vertexArray: [], colorArray: []})} : new _WebGL__WEBPACK_IMPORTED_MODULE_0__.Geometry();`],
  ['            var j = atom.bonds[i]; // our neighbor\n            var atom2 = atoms[j];', `            var j = atom.bonds[i]; // our neighbor
            if (this._sciyueBondPair && j !== this._sciyueBondPair[1]) continue;
            var atom2 = atoms[j];`],
  ['            const j = atom.bonds[i]; // our neighbor\n            const atom2 = atoms[j];', `            const j = atom.bonds[i]; // our neighbor
            if (this._sciyueBondPair && j !== this._sciyueBondPair[1]) continue;
            const atom2 = atoms[j];`],
  ['            const drawMethod = geo.imposter ? GLModel.drawStickImposter : _GLDraw__WEBPACK_IMPORTED_MODULE_4__.GLDraw.drawCylinder;', `            const drawMethod = this._sciyueBondSink ? (_geo, from, to, radius, color, fromCap, toCap) => this._sciyueBondSink('cylinder', from, to, radius, color, fromCap, toCap) : (geo.imposter ? GLModel.drawStickImposter : _GLDraw__WEBPACK_IMPORTED_MODULE_4__.GLDraw.drawCylinder);`],
  ['                    const multiBondDrawMethod = geo.imposter ? GLModel.drawStickImposter : _GLDraw__WEBPACK_IMPORTED_MODULE_4__.GLDraw.drawCylinder;', `                    const multiBondDrawMethod = this._sciyueBondSink ? (_geo, from, to, radius, color, fromCap, toCap) => this._sciyueBondSink('cylinder', from, to, radius, color, fromCap, toCap) : (geo.imposter ? GLModel.drawStickImposter : _GLDraw__WEBPACK_IMPORTED_MODULE_4__.GLDraw.drawCylinder);`],
  ['        if (drawSphere) {\n            bondR = atomBondR;', '        if (drawSphere && !this._sciyueBondSink) {\n            bondR = atomBondR;'],
];
function replaceExactly(source, from, to) {
  if (source.split(from).length !== 2) throw new Error('Locked 3Dmol patch anchor is missing or ambiguous: ' + JSON.stringify(from.slice(0, 100)));
  return source.replace(from, to);
}
function restoreLocked3Dmol(source) {
  if (typeof source !== 'string') throw new Error('Locked 3Dmol patch requires source text');
  let original = source;
  if (source.includes(MARKER)) for (const [from, to] of [...patches].reverse()) original = replaceExactly(original, to, from);
  if (sha(original) !== SOURCE_SHA256) throw new Error('Locked 3Dmol 2.5.5 original build SHA does not match; refusing to guess a patch');
  return original;
}
function transformLocked3Dmol(source) {
  const original=restoreLocked3Dmol(source);
  const patched = patches.reduce((value, [from, to]) => replaceExactly(value, from, to), original);
  if (source.includes(MARKER) && source !== patched) throw new Error('Locked 3Dmol patched build has unexpected edits');
  return patched;
}
/** Reject path redirection/junctions and shared hardlinks. This deliberately
 * does not claim to classify every possible Windows reparse tag. */
async function checkedBuildTarget(root) {
  const resolved=path.resolve(root),parts=[resolved,path.join(resolved,'node_modules'),path.join(resolved,'node_modules','3dmol'),path.join(resolved,'node_modules','3dmol','build'),path.join(resolved,'node_modules','3dmol','build','3Dmol.js')];
  const comparable=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  let target;
  for(let index=0;index<parts.length;index++){
    const current=parts[index],stat=await fs.lstat(current,{bigint:true});
    if(stat.isSymbolicLink()||comparable(await fs.realpath(current))!==comparable(current))throw new Error('Locked 3Dmol patch refuses redirected/symbolic-link paths');
    if(index<parts.length-1){if(!stat.isDirectory())throw new Error('Locked 3Dmol patch requires ordinary package directories');}
    else {if(!stat.isFile()||stat.nlink!==1n)throw new Error('Locked 3Dmol patch refuses non-regular or shared hardlinked build files');target=stat;}
  }
  return target;
}
function sameBuildIdentity(before,after) {
  const keys=['dev','ino','size','mode','nlink','mtimeNs','ctimeNs'];
  return keys.every(key=>typeof before[key]==='bigint'&&typeof after[key]==='bigint'&&before[key]===after[key]);
}
async function applyLocked3DmolPatch(root = path.resolve(__dirname, '..')) {
  const packageRoot = path.join(root, 'node_modules', '3dmol');
  let pkg, source,identity;
  try { identity=await checkedBuildTarget(root);pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')); source = await fs.readFile(path.join(packageRoot, 'build', '3Dmol.js'), 'utf8'); }
  catch (cause) { if(cause.code==='ENOENT')throw new Error('Locked local 3Dmol package/build is missing; install the existing project lock before preparing runtime assets', {cause});throw cause; }
  if (pkg.version !== VERSION || pkg.main !== 'build/3Dmol.js') throw new Error('Expected locked 3Dmol 2.5.5 build/3Dmol.js; refusing another package/version');
  const patched = transformLocked3Dmol(source), changed = patched !== source;
  if (changed) {
    const current=await checkedBuildTarget(root);
    if(!sameBuildIdentity(identity,current))throw new Error('Locked 3Dmol build identity changed before write; refusing patch');
    await fs.writeFile(path.join(packageRoot, 'build', '3Dmol.js'), patched, 'utf8');
  }
  return {version: VERSION, changed, sourceSha256: SOURCE_SHA256, patchedSha256: sha(patched), api: 'exportBondPrimitives-v1'};
}
module.exports = {SOURCE_SHA256, restoreLocked3Dmol, transformLocked3Dmol, applyLocked3DmolPatch};
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') { console.error('Usage: node scripts/3dmol-bond-primitives.cjs --apply'); process.exitCode = 1; }
  else applyLocked3DmolPatch().then(receipt => console.log(JSON.stringify(receipt))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
