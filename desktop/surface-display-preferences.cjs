'use strict';
const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {assert,plain}=require('./security.cjs');
const LIMIT=64*1024;
const SURFACE_DISPLAY_FAMILIES=Object.freeze(['orbital','electron-hole','surface:esp','surface:alie','surface:hirshfeld','interaction:iri','interaction:rdg','interaction:igmh','interaction:migm','interaction:igm','vibration']);
const families=new Set(SURFACE_DISPLAY_FAMILIES),presets=new Set(['esp','orbital','dual','iri','igmh','density','hirshfeld','gallery-esp','gallery-orbital','gallery-dual','gallery-iri','gallery-igmh','gallery-density','gallery-hirshfeld','custom']);
const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
function exact(value,keys){assert(plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),'SURFACE_DISPLAY_FIELDS: Unexpected preference fields');}
const number=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const color=value=>typeof value==='string'&&/^#[a-f0-9]{6}$/i.test(value);
function validateSurfaceAppearance(family,value){
  assert(families.has(family),'SURFACE_DISPLAY_FAMILY: Unknown appearance family');
  if(family==='vibration'){
    exact(value,['presetId','vector']);assert(['standard','teal','custom'].includes(value.presetId),'SURFACE_DISPLAY_PRESET: Unknown vector preset');exact(value.vector,['color','radius','radiusRatio','mid']);
    const v=value.vector;assert(color(v.color)&&number(v.radius,.001,.5)&&number(v.radiusRatio,1,10)&&number(v.mid,.05,.95),'SURFACE_DISPLAY_VECTOR: Invalid vector appearance');
  }else{
    exact(value,plain(value)&&Object.hasOwn(value,'opacity')?['presetId','colors','finish','opacity']:['presetId','colors','finish']);assert(presets.has(value.presetId),'SURFACE_DISPLAY_PRESET: Unknown mesh preset');
    assert(!Object.hasOwn(value,'opacity')||number(value.opacity,0,1),'SURFACE_DISPLAY_OPACITY: Invalid mesh opacity');
    const minimumColors=['surface:esp','surface:alie'].includes(family)?1:2;
    assert(Array.isArray(value.colors)&&value.colors.length>=minimumColors&&value.colors.length<=16&&Object.keys(value.colors).length===value.colors.length&&Array.from(value.colors).every(color)&&(!['orbital','electron-hole'].includes(family)||value.colors.length===2),'SURFACE_DISPLAY_COLORS: Invalid ordered colors');
    const f=value.finish;assert(plain(f)&&['preset','specular','exponent'].every(key=>Object.hasOwn(f,key))&&Object.keys(f).every(key=>['preset','specular','exponent','ambient','diffuse','outline','outlineWidth'].includes(key)),'SURFACE_DISPLAY_FINISH: Unexpected finish fields');
    assert(['matte','soft','glossy','custom'].includes(f.preset)&&number(f.specular,0,1)&&number(f.exponent,1,128)&&['ambient','diffuse','outline','outlineWidth'].every(key=>!Object.hasOwn(f,key)||number(f[key],0,1)),'SURFACE_DISPLAY_FINISH: Invalid finish');
  }
  return structuredClone(value);
}
function validateOrbitalPresetName(value){assert(typeof value==='string'&&value.trim()&&value===value.trim()&&value.length<=80&&!/[\u0000-\u001f\u007f]/.test(value),'SURFACE_DISPLAY_NAME: Enter a preset name of 1-80 characters');return value;}
function validateNamedOrbitalPresets(value){
  assert(Array.isArray(value)&&value.length<=64&&Object.keys(value).length===value.length,'SURFACE_DISPLAY_NAMED: Invalid named orbital list');const names=new Set();
  return value.map(item=>{exact(item,['name','appearance']);const name=validateOrbitalPresetName(item.name);assert(!names.has(name),'SURFACE_DISPLAY_NAME: Preset name already exists; choose a new name');names.add(name);const appearance=validateSurfaceAppearance('orbital',item.appearance);assert(appearance.opacity!==undefined,'SURFACE_DISPLAY_OPACITY: Named orbital appearance requires opacity');return{name,appearance};});
}

/** The fixed IPC whitelist contains appearance only. Missing defaults are {}:
 * the shared appearance registry, not this store, owns factory appearances. */
function createSurfaceDisplayPreferencesStore(profileRoot){
  assert(typeof profileRoot==='string'&&path.isAbsolute(profileRoot),'SURFACE_DISPLAY_ROOT: Absolute owned profile required');
  const root=path.resolve(profileRoot),file=path.join(root,'surface-display-preferences-v1.json'),baselines=new Map(),epochs=new Map();let queue=Promise.resolve(),closed=false,pinError;
  const directories=[];for(let current=root;;current=path.dirname(current)){directories.unshift(current);if(path.dirname(current)===current)break;}
  const pins=new Map(),directoryKey=(real,s)=>`${real}:${s.dev}:${s.ino}`;
  try{for(const dir of directories){let s;try{s=sync.lstatSync(dir);}catch(error){if(error.code==='ENOENT')break;throw error;}assert(s.isDirectory()&&!s.isSymbolicLink(),'SURFACE_DISPLAY_PATH: Linked profile ancestor');pins.set(dir,directoryKey(sync.realpathSync(dir),s));}}catch(error){pinError=error;}
  const epoch=owner=>epochs.get(owner)||0;
  function active(owner,generation){assert(Number.isSafeInteger(owner)&&owner>=0&&!closed&&epoch(owner)===generation,'SURFACE_DISPLAY_CLOSED: Preference owner/store closed');}
  function serialize(operation){const pending=queue.then(operation);queue=pending.catch(()=>{});return pending;}
  function family(value){assert(families.has(value),'SURFACE_DISPLAY_FAMILY: Unknown appearance family');return value;}
  function appearance(id,value){return validateSurfaceAppearance(family(id),value);}
  function validateValue(value){assert(plain(value)&&Object.keys(value).length<=families.size,'SURFACE_DISPLAY_VALUE: Invalid family map');const result={};for(const [id,item] of Object.entries(value))result[family(id)]=appearance(id,item);return result;}
  async function checkPins(){if(pinError)throw pinError;for(const [dir,key] of pins){const s=await fs.lstat(dir);assert(s.isDirectory()&&!s.isSymbolicLink()&&directoryKey(await fs.realpath(dir),s)===key,'SURFACE_DISPLAY_PATH: Profile ancestor changed');}}
  async function parent(){await checkPins();for(const dir of directories){if(pins.has(dir))continue;await checkPins();try{await fs.mkdir(dir);}catch(error){if(error.code!=='EEXIST')throw error;}const s=await fs.lstat(dir);assert(s.isDirectory()&&!s.isSymbolicLink(),'SURFACE_DISPLAY_PATH: Linked profile directory');pins.set(dir,directoryKey(await fs.realpath(dir),s));}await checkPins();return pins.get(root);}
  async function load(){
    let parentIdentity,version='unavailable';
    try{
      parentIdentity=await parent();let handle;try{handle=await fs.open(file,'r');}catch(error){if(error.code==='ENOENT'){await parent();return{value:{},version:'missing',parentIdentity,writable:true};}throw error;}
      let bytes;try{const a=await handle.stat(),b=await fs.lstat(file);assert(a.isFile()&&b.isFile()&&!b.isSymbolicLink()&&a.nlink===1&&b.nlink===1&&identity(a)===identity(b)&&a.size<=LIMIT,'SURFACE_DISPLAY_FILE: Invalid preference file or size');bytes=await handle.readFile();assert(bytes.length<=LIMIT&&identity(a)===identity(await handle.stat())&&identity(a)===identity(await fs.lstat(file)),'SURFACE_DISPLAY_PATH: File changed while reading');await parent();}finally{await handle.close();}
      version=createHash('sha256').update(bytes).digest('hex');const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));assert(plain(parsed)&&[1,2].includes(parsed.schemaVersion),'SURFACE_DISPLAY_SCHEMA: Unknown preference schema');exact(parsed,parsed.schemaVersion===1?['schemaVersion','value']:['schemaVersion','value','namedOrbitalPresets']);const named=parsed.schemaVersion===2?validateNamedOrbitalPresets(parsed.namedOrbitalPresets):[];return{value:validateValue(parsed.value),...(named.length?{namedOrbitalPresets:named}:{}),version,parentIdentity,writable:true};
    }catch(error){return{value:{},version,parentIdentity,writable:false,error:'表面外观默认无法读取，原内容已保留：'+error.message};}
  }
  const snapshot=state=>({value:structuredClone(state.value),...(state.namedOrbitalPresets?{namedOrbitalPresets:structuredClone(state.namedOrbitalPresets)}:{}),version:state.version,writable:state.writable,...(state.error?{error:state.error}:{})});
  async function update(owner,generation,request,restore=false){
    active(owner,generation);exact(request,restore?['baseVersion','family']:plain(request)&&Object.hasOwn(request,'name')?['baseVersion','family','appearance','name']:['baseVersion','family','appearance']);assert(typeof request.baseVersion==='string'&&(request.baseVersion==='missing'||/^[a-f0-9]{64}$/.test(request.baseVersion)),'SURFACE_DISPLAY_VERSION: Invalid base version');const id=family(request.family),desired=restore?undefined:appearance(id,request.appearance),baseline=baselines.get(owner);const name=Object.hasOwn(request,'name')?validateOrbitalPresetName(request.name):undefined;assert(name===undefined||id==='orbital'&&desired?.opacity!==undefined,'SURFACE_DISPLAY_NAMED: Only orbital appearances with opacity can be named');assert(baseline&&baseline.version===request.baseVersion,'SURFACE_DISPLAY_BASE: Read preferences before save/restore');
    const current=await load();active(owner,generation);assert(baseline.writable&&current.writable,'SURFACE_DISPLAY_SCHEMA: Broken/future preferences must be retained');assert(current.version===baseline.version&&current.parentIdentity===baseline.parentIdentity,'SURFACE_DISPLAY_CONFLICT: Preferences changed; reload before save/restore');
    const value=structuredClone(current.value),namedOrbitalPresets=structuredClone(current.namedOrbitalPresets??[]);if(name!==undefined){assert(!namedOrbitalPresets.some(item=>item.name===name),'SURFACE_DISPLAY_NAME: 该预设名称已存在，请另存新名称。');namedOrbitalPresets.push({name,appearance:desired});validateNamedOrbitalPresets(namedOrbitalPresets);}else if(restore)delete value[id];else value[id]=desired;validateValue(value);const bytes=Buffer.from(JSON.stringify(namedOrbitalPresets.length?{schemaVersion:2,value,namedOrbitalPresets}:{schemaVersion:1,value},null,2)+'\n');assert(bytes.length<=LIMIT,'SURFACE_DISPLAY_SIZE: Preferences exceed 64 KiB');
    const temporary=path.join(root,'.surface-display-'+randomUUID()+'.tmp');let owned,written,published=false;const ownerKey=s=>`${s.dev}:${s.ino}`;
    const publicationError=error=>{error.publicationPerformed=true;error.message='外观默认写入已提交但未能确认，请重新读取。'+error.message;return error;};
    async function cleanup(){if(!owned)return;try{await checkPins();const s=await fs.lstat(temporary);if(s.isFile()&&!s.isSymbolicLink()&&(s.nlink===1||published&&s.nlink===2)&&ownerKey(s)===owned)await fs.unlink(temporary);}catch{/* Preserve uncertain replacement files. */}}
    try{
      const handle=await fs.open(temporary,'wx');owned=ownerKey(await handle.stat());try{active(owner,generation);await handle.writeFile(bytes);await handle.sync();written=identity(await handle.stat());}finally{await handle.close();}
      const again=await load();active(owner,generation);assert(again.writable&&again.version===current.version&&again.parentIdentity===current.parentIdentity,'SURFACE_DISPLAY_CONFLICT: File changed during save/restore');await checkPins();const selected=await fs.lstat(temporary);assert(selected.isFile()&&!selected.isSymbolicLink()&&selected.nlink===1&&identity(selected)===written,'SURFACE_DISPLAY_PATH: Owned temporary changed');active(owner,generation);
      if(current.version==='missing'){await fs.link(temporary,file);published=true;active(owner,generation);await cleanup();}else{await fs.rename(temporary,file);published=true;owned=undefined;active(owner,generation);}
    }catch(error){await cleanup();throw published?publicationError(error):error;}
    let saved;try{saved=await load();active(owner,generation);assert(saved.writable&&saved.version===createHash('sha256').update(bytes).digest('hex'),'SURFACE_DISPLAY_CONFLICT: Published bytes changed');}catch(error){throw publicationError(error);}
    baselines.set(owner,saved);return snapshot(saved);
  }
  return{
    read(owner){const generation=epoch(owner);return serialize(async()=>{active(owner,generation);const state=await load();active(owner,generation);baselines.set(owner,state);return snapshot(state);});},
    write(owner,request){const generation=epoch(owner);return serialize(()=>update(owner,generation,request));},
    restoreFactory(owner,request){const generation=epoch(owner);return serialize(()=>update(owner,generation,request,true));},
    disposeOwner(owner){epochs.set(owner,epoch(owner)+1);baselines.delete(owner);},dispose(){closed=true;baselines.clear();},settle:()=>queue,
  };
}
module.exports={createSurfaceDisplayPreferencesStore,validateSurfaceAppearance,validateNamedOrbitalPresets,validateOrbitalPresetName,SURFACE_DISPLAY_FAMILIES,LIMIT};
