'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { assert, plain } = require('./security.cjs');
const LIMIT = 128 * 1024;
// Canonical real elements, exactly matching core/elements.ts. No atom identities.
const ELEMENTS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' '));
const FLAGS = ['atomNumbers', 'elementNames', 'legend', 'regionHighlights', 'regionLabels', 'frozenMarks', 'scanMarks', 'measurementMarks', 'cell'];
const REQUIRED = ['representation', 'colorMode', ...FLAGS, 'fontSize'];
const OPTIONAL = ['alignment', 'elementColors', 'atomScale', 'bondScale', 'elementScales', 'depthFade', 'structurePreset', 'structureFinish', 'structureLighting', 'structureSizing', 'vdwShell', 'periodicDisplay','showBonds','backgroundColor','bondStyle','cellStyle','axisDisplay','stereochemistry','rotationSpeedPercent'];
const STRUCTURE_FIELDS=['representation','structurePreset','structureFinish','structureLighting','structureSizing','vdwShell','elementColors','elementScales','atomScale','bondScale','depthFade','showBonds','backgroundColor','bondStyle'];
function validateNamedStructurePresets(value){
  assert(Array.isArray(value)&&value.length<=64,'At most 64 named structure presets');const names=new Set();
  return value.map(item=>{exact(item,['name','appearance']);assert(typeof item.name==='string'&&item.name.trim()===item.name&&item.name.length>0&&item.name.length<=80&&!names.has(item.name),'Invalid or duplicate structure preset name');names.add(item.name);
    assert(plain(item.appearance)&&Object.hasOwn(item.appearance,'representation')&&Object.keys(item.appearance).every(key=>STRUCTURE_FIELDS.includes(key)),'Only structure appearance may be named');validateModelDisplay({...createDefaultModelDisplay(),...item.appearance});return structuredClone(item);});
}
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
function exact(value, keys) { assert(plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'Invalid model display preference fields'); }
function validFinish(f){return plain(f)&&Object.keys(f).every(key=>['preset','specular','exponent','ambient','diffuse','outline','outlineWidth'].includes(key))&&['matte','soft','glossy','custom'].includes(f.preset)&&typeof f.specular==='number'&&Number.isFinite(f.specular)&&f.specular>=0&&f.specular<=1&&typeof f.exponent==='number'&&Number.isFinite(f.exponent)&&f.exponent>=1&&f.exponent<=128&&['ambient','diffuse','outline','outlineWidth'].every(key=>!Object.hasOwn(f,key)||typeof f[key]==='number'&&Number.isFinite(f[key])&&f[key]>=0&&f[key]<=1);}
function createDefaultModelDisplay() {
  return { representation: 'ball-stick', colorMode: 'elements', atomNumbers: false, elementNames: false, legend: true, regionHighlights: true, regionLabels: false, frozenMarks: true, scanMarks: true, measurementMarks: true, fontSize: 12, cell: true, alignment: 'auto', bondScale: 1, depthFade: 0,
    structurePreset:'original', stereochemistry:false, rotationSpeedPercent:100 };
}
function validateModelDisplay(value) {
  assert(plain(value) && REQUIRED.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => REQUIRED.includes(key) || OPTIONAL.includes(key)), 'Only model display fields may be stored; model/source/path/atom identities are forbidden');
  assert(Buffer.byteLength(JSON.stringify(value), 'utf8') <= LIMIT, 'Model display preferences exceed 128 KiB');
  assert(['vdw', 'ball-stick', 'stick'].includes(value.representation) && ['elements', 'frozen', 'basis', 'layers', 'fragments'].includes(value.colorMode), 'Invalid representation or color mode');
  assert(FLAGS.every(key => typeof value[key] === 'boolean'), 'Model display flags must be explicit booleans');
  if(Object.hasOwn(value,'stereochemistry'))assert(typeof value.stereochemistry==='boolean','Stereochemistry visibility must be boolean');
  if(Object.hasOwn(value,'rotationSpeedPercent'))assert(typeof value.rotationSpeedPercent==='number'&&Number.isFinite(value.rotationSpeedPercent)&&value.rotationSpeedPercent>0,'Rotation speed must be positive and finite');
  if(Object.hasOwn(value,'showBonds'))assert(typeof value.showBonds==='boolean','Bond visibility must be boolean');
  const hex=v=>typeof v==='string'&&/^#[\da-f]{6}$/i.test(v),range=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  if(Object.hasOwn(value,'backgroundColor'))assert(hex(value.backgroundColor),'Invalid background color');
  if(Object.hasOwn(value,'bondStyle')){const b=value.bondStyle;assert(plain(b)&&Object.keys(b).length===2&&['elements','uniform'].includes(b.colorMode)&&hex(b.color),'Invalid bond style');}
  if(Object.hasOwn(value,'cellStyle')){const c=value.cellStyle;assert(plain(c)&&Object.keys(c).length===3&&['solid','dashed'].includes(c.lineStyle)&&hex(c.color)&&range(c.width,.5,8),'Invalid cell style');}
  if(Object.hasOwn(value,'axisDisplay')){const a=value.axisDisplay;assert(plain(a)&&Object.keys(a).length===4&&plain(a.colors)&&Object.keys(a.colors).length===3&&['X','Y','Z'].every(key=>hex(a.colors[key]))&&range(a.lineWidth,.5,8)&&range(a.length,10,120)&&range(a.fontSize,8,32),'Invalid axis display');}
  assert(typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) && value.fontSize >= 8 && value.fontSize <= 24, 'Model display font size must be in [8, 24]');
  if (Object.hasOwn(value, 'alignment')) assert(['auto', 'heavy', 'off'].includes(value.alignment), 'Invalid observation alignment');
  if (Object.hasOwn(value, 'depthFade')) assert(typeof value.depthFade === 'number' && Number.isFinite(value.depthFade) && value.depthFade >= 0 && value.depthFade <= 1, 'Depth fade must be in [0, 1]');
  if(Object.hasOwn(value,'structurePreset')) assert(['original','pastel','muted','cpk','vmd-glossy','flat','macaron','outlined','vdw-shell','gallery-line-art','gallery-cpk-glossy','gallery-pastel','gallery-vmd-glossy','custom'].includes(value.structurePreset),'Invalid structure appearance preset');
  if(Object.hasOwn(value,'structureLighting')) assert(['pymol-soft','pymol-cpk','vmd'].includes(value.structureLighting),'Invalid structure lighting');
  if(Object.hasOwn(value,'structureFinish')) {
    const f=value.structureFinish;
    assert(validFinish(f),'Invalid structure finish');
  }
  if(Object.hasOwn(value,'vdwShell')){const s=value.vdwShell;assert(plain(s)&&Object.keys(s).every(key=>['color','opacity','finish'].includes(key))&&typeof s.color==='string'&&/^#[\da-f]{6}$/i.test(s.color)&&typeof s.opacity==='number'&&Number.isFinite(s.opacity)&&s.opacity>=0&&s.opacity<=1&&(!Object.hasOwn(s,'finish')||validFinish(s.finish)),'Invalid VDW display shell');}
  if(Object.hasOwn(value,'structureSizing')){const s=value.structureSizing,limits={ballScale:[.05,1],hydrogenBallScale:[.05,1],bondRadiusAngstrom:[.02,.5],bondColorLightening:[0,1]};assert(plain(s)&&Object.keys(s).length===4&&Object.entries(limits).every(([key,[min,max]])=>typeof s[key]==='number'&&Number.isFinite(s[key])&&s[key]>=min&&s[key]<=max),'Invalid structure appearance sizing');}
  if(Object.hasOwn(value,'periodicDisplay')){const p=value.periodicDisplay;assert(plain(p)&&['boundaryStyle','outerColor','images','rangeAngstrom'].every(key=>Object.hasOwn(p,key))&&Object.keys(p).every(key=>['boundaryStyle','outerColor','images','rangeAngstrom','showCrossBoxBonds'].includes(key))&&(!Object.hasOwn(p,'showCrossBoxBonds')||typeof p.showCrossBoxBonds==='boolean')&&['thin','stubs'].includes(p.boundaryStyle)&&typeof p.outerColor==='string'&&/^#[\da-f]{6}$/i.test(p.outerColor)&&typeof p.images==='boolean'&&typeof p.rangeAngstrom==='number'&&Number.isFinite(p.rangeAngstrom)&&p.rangeAngstrom>=0,'Invalid periodic display settings');}
  const validScale = scale => typeof scale === 'number' && Number.isFinite(scale) && scale >= .25 && scale <= 3;
  if (Object.hasOwn(value, 'atomScale')) assert(validScale(value.atomScale), 'Atom display scale must be in [0.25, 3]');
  if (Object.hasOwn(value, 'bondScale')) assert(validScale(value.bondScale), 'Bond display scale must be in [0.25, 3]');
  if (Object.hasOwn(value, 'elementScales')) {
    assert(plain(value.elementScales) && Object.keys(value.elementScales).length <= ELEMENTS.size, 'Invalid element display scale map');
    for (const [element, scale] of Object.entries(value.elementScales)) assert(ELEMENTS.has(element) && validScale(scale), 'Element display scales require canonical elements and values in [0.25, 3]');
  }
  if (Object.hasOwn(value, 'elementColors')) {
    assert(plain(value.elementColors) && Object.keys(value.elementColors).length <= ELEMENTS.size, 'Invalid element color map');
    for (const [element, color] of Object.entries(value.elementColors)) assert(ELEMENTS.has(element) && typeof color === 'string' && /^#[\da-f]{6}$/i.test(color), 'Element colors require canonical element symbols and hex RGB');
  }
  return structuredClone(value);
}
function createModelDisplayPreferencesStore(profileRoot) {
  assert(typeof profileRoot === 'string' && path.isAbsolute(profileRoot), 'Invalid model display profile root');
  const root = path.resolve(profileRoot), file = path.join(root, 'model-display-preferences-v1.json'), baselines = new Map(), epochs = new Map();
  let queue = Promise.resolve(), closed = false;
  const ancestors = []; for (let cursor = root;; cursor = path.dirname(cursor)) { ancestors.unshift(cursor); if (path.dirname(cursor) === cursor) break; }
  const pinned = new Map(); let pinError;
  const directoryKey = (real, stat) => `${real}:${stat.dev}:${stat.ino}`;
  const changed = message => Object.assign(new Error(message), { code: 'PORTABLE_PATH_CHANGED' });
  try { for (const directory of ancestors) { let stat; try { stat = fsSync.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') break; throw error; } if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed('Model display profile ancestors must not be links'); pinned.set(directory, directoryKey(fsSync.realpathSync(directory), stat)); } } catch (error) { pinError = error; }
  async function checkPinned() { if (pinError) throw pinError; for (const [directory, key] of pinned) { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || directoryKey(await fs.realpath(directory), stat) !== key) throw changed('Model display profile ancestor identity changed'); } }
  const epoch = owner => epochs.get(owner) || 0;
  const active = (owner, generation) => assert(!closed && epoch(owner) === generation, 'MODEL_DISPLAY_CLOSED: Preference window or store closed');
  const serialize = operation => { const pending = queue.then(operation); queue = pending.catch(() => {}); return pending; };
  async function parent() { await checkPinned(); for (const directory of ancestors) { if (pinned.has(directory)) continue; await checkPinned(); try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed('Model display profile root cannot be a link'); pinned.set(directory, directoryKey(await fs.realpath(directory), stat)); } await checkPinned(); return pinned.get(root); }
  async function load() {
    const parentIdentity = await parent();
    try {
      const handle = await fs.open(file, 'r'); let bytes;
      try { const [opened, selected] = await Promise.all([handle.stat(), fs.lstat(file)]); assert(opened.isFile() && selected.isFile() && !selected.isSymbolicLink() && identity(opened) === identity(selected) && opened.size <= LIMIT, 'Invalid model display preference file or size'); bytes = await handle.readFile(); assert(bytes.length <= LIMIT && identity(opened) === identity(await fs.lstat(file)), 'Model display preference file changed while reading'); await parent(); }
      finally { await handle.close(); }
      const version = createHash('sha256').update(bytes).digest('hex');
      try { const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); assert(plain(parsed)&&Object.keys(parsed).every(key=>['schemaVersion','display','namedPresets'].includes(key))&&parsed.schemaVersion===1&&Object.hasOwn(parsed,'display'),'Unsupported model display preference schema'); return { version, parentIdentity, writable: true, display: validateModelDisplay(parsed.display),...(Object.hasOwn(parsed,'namedPresets')?{namedPresets:validateNamedStructurePresets(parsed.namedPresets)}:{}) }; }
      catch (error) { return { version, parentIdentity, writable: false, display: createDefaultModelDisplay(), error: `显示偏好格式无法读取，已保留原文件：${error.message}` }; }
    } catch (error) { if (error.code === 'ENOENT') { await parent(); return { version: 'missing', parentIdentity, writable: true, display: createDefaultModelDisplay() }; } throw error; }
  }
  function snapshot(state) { return { version: state.version, display: structuredClone(state.display),...(state.namedPresets?{namedPresets:structuredClone(state.namedPresets)}:{}), writable: state.writable, ...(state.error ? { error: state.error } : {}) }; }
  async function write(owner, generation, request) {
    active(owner, generation); assert(plain(request)&&['baseVersion','display'].every(key=>Object.hasOwn(request,key))&&Object.keys(request).every(key=>['baseVersion','display','namedPresets'].includes(key)),'Invalid display preference request fields'); assert(typeof request.baseVersion === 'string' && request.baseVersion.length <= 64, 'Invalid display preference base version');
    const display = validateModelDisplay(request.display), baseline = baselines.get(owner); assert(baseline && baseline.version === request.baseVersion, 'MODEL_DISPLAY_BASE: Read display preferences before saving');
    const current = await load(); active(owner, generation); assert(baseline.writable && current.writable, 'MODEL_DISPLAY_SCHEMA: Invalid or future file is preserved'); assert(current.version === request.baseVersion && current.parentIdentity === baseline.parentIdentity, 'MODEL_DISPLAY_CONFLICT: Another window changed display defaults; reload before saving');
    const namedPresets=Object.hasOwn(request,'namedPresets')?validateNamedStructurePresets(request.namedPresets):current.namedPresets;
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, display,...(namedPresets?{namedPresets}:{}) }, null, 2)}\n`, 'utf8');assert(bytes.length<=LIMIT,'Model display preferences exceed 128 KiB');
    const temporary = path.join(root, `.model-display-${randomUUID()}.tmp`); let ownedTemporary, writtenTemporary, publicationPerformed = false;
    const publicationError = error => { error.publicationPerformed = true; error.message = '显示偏好写入操作已提交，但后续确认失败；未报告保存成功，请重新读取。' + error.message; return error; };
    const ownedKey = stat => `${stat.dev}:${stat.ino}`;
    async function cleanupTemporary() { if (!ownedTemporary) return; try { await checkPinned(); const stat = await fs.lstat(temporary); if (stat.isFile() && !stat.isSymbolicLink() && ownedKey(stat) === ownedTemporary) await fs.unlink(temporary); } catch { /* Preserve uncertain replacement contents. */ } }
    try {
      const handle = await fs.open(temporary, 'wx'); ownedTemporary = ownedKey(await handle.stat());
      try { active(owner, generation); await handle.writeFile(bytes); await handle.sync(); writtenTemporary = identity(await handle.stat()); } finally { await handle.close(); }
      const beforeReplace = await load(); active(owner, generation); assert(beforeReplace.writable && beforeReplace.version === current.version && beforeReplace.parentIdentity === current.parentIdentity, 'MODEL_DISPLAY_CONFLICT: Display preference file or directory changed during save');
      await checkPinned(); const selected = await fs.lstat(temporary); if (!selected.isFile() || selected.isSymbolicLink() || identity(selected) !== writtenTemporary) throw changed('Model display owned temporary changed before publication');
      active(owner, generation);
      if (current.version === 'missing') { await fs.link(temporary, file); publicationPerformed = true; active(owner, generation); await cleanupTemporary(); } else { await fs.rename(temporary, file); publicationPerformed = true; ownedTemporary = undefined; active(owner, generation); }
    } catch (error) { await cleanupTemporary(); throw publicationPerformed ? publicationError(error) : error; }
    let saved;
    try { saved = await load(); active(owner, generation); if (saved.version !== createHash('sha256').update(bytes).digest('hex')) throw Object.assign(new Error('MODEL_DISPLAY_CONFLICT: Saved display bytes were externally changed; reload before saving'), { code: 'MODEL_DISPLAY_CONFLICT' }); }
    catch (error) { throw publicationError(error); }
    if (!closed && epoch(owner) === generation) baselines.set(owner, saved); return snapshot(saved);
  }
  return {
    read(owner) { const generation = epoch(owner); return serialize(async () => { active(owner, generation); const state = await load(); active(owner, generation); baselines.set(owner, state); return snapshot(state); }); },
    write(owner, request) { const generation = epoch(owner); return serialize(() => write(owner, generation, request)); },
    restoreFactory(owner, baseVersion) { const generation = epoch(owner); return serialize(() => write(owner, generation, { baseVersion, display: createDefaultModelDisplay() })); },
    exclusive(owner, operation) { const generation = epoch(owner); return serialize(async () => { active(owner, generation); return operation({ read: async () => { active(owner, generation); const state = await load(); active(owner, generation); baselines.set(owner, state); return snapshot(state); }, write: request => write(owner, generation, request) }); }); },
    disposeOwner(owner) { epochs.set(owner, epoch(owner) + 1); baselines.delete(owner); }, dispose() { closed = true; baselines.clear(); },
    settle: () => queue,
  };
}
module.exports = { createModelDisplayPreferencesStore, createDefaultModelDisplay, validateModelDisplay, validateNamedStructurePresets, LIMIT };
