'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const {createHash}=require('node:crypto');
const { assert, plain } = require('./security.cjs');
const nativeField = Symbol('verified-native-field');
const exportFile = Symbol('verified-native-export');
const packed = new Set(['float64-le', 'uint8']);

/** Attachments are worker outputs under this operation's host-owned directory.
 * Never accept a renderer path or delete files outside that exact directory. */
async function readManagedResult(value, directory, options = {}) {
  const owned = new Set();
  try { return await read(value, directory, options, owned); }
  catch (error) { await Promise.allSettled([...owned].map(removeVerifiedFile)); throw error; }
}
async function read(value, directory, options, owned) {
  if (Array.isArray(value)) {
    const result=[];for(const entry of value)result.push(await read(entry,directory,options,owned));return result;
  }
  if (!plain(value)) return value;
  if (!Object.hasOwn(value,'esResultAttachment')) {
    const result={};for(const [key,entry] of Object.entries(value))result[key]=await read(entry,directory,options,owned);return result;
  }
  assert(typeof directory==='string' && path.isAbsolute(directory),'Missing owned analysis result directory');
  assert(/^es-result-[a-f0-9]{32}\.(?:json|jsonl|bin|txt)$/.test(value.esResultAttachment) && (['json','jsonl','bytes','utf8','verified-export'].includes(value.encoding)||packed.has(value.encoding)),'Invalid managed analysis result');
  assert(Number.isSafeInteger(value.bytes)&&value.bytes>=0,'Invalid managed result byte count');
  const {directoryIdentity,checkDirectory}=require('./portable-storage.cjs');
  const parent=await directoryIdentity(directory);
  const target=path.join(directory,value.esResultAttachment),stat=await fs.lstat(target);
  assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size===value.bytes,'Managed analysis result identity changed');
  if (value.encoding==='verified-export' || packed.has(value.encoding) && options.deferBinary) {
    if (value.encoding==='verified-export') {
      assert(target.endsWith('.bin')&&/^[a-f0-9]{64}$/.test(value.sha256),'Invalid scientific export source identity');
      const file=await inspectManagedSource(target);
      assert(file.bytesLength===value.bytes&&file.sha256===value.sha256,'Cube export source identity differs');
      owned.add(file);
      options.files?.add(file);
      return { [exportFile]: file };
    }
    assert(target.endsWith('.bin') && value.bytes>0 && (value.encoding!=='float64-le'||value.bytes%8===0),'Invalid packed scientific array');
    const file=await inspectManagedSource(target);
    assert(file.bytesLength===value.bytes && file.identity===require('./portable-storage.cjs').identity(stat),'Packed scientific array changed');
    owned.add(file);
    options.files?.add(file);
    return { [nativeField]: file, encoding: value.encoding };
  }
  const handle=await fs.open(target,'r');
  try {
    const opened=await handle.stat();assert(opened.dev===stat.dev&&opened.ino===stat.ino&&opened.size===stat.size,'Managed result was replaced');
    let result;
    if(value.encoding==='jsonl') {
      assert(Number.isSafeInteger(value.count)&&value.count>=0,'Invalid managed result count');
      result=[];
      const lines=readline.createInterface({input:handle.createReadStream({autoClose:false,encoding:'utf8'}),crlfDelay:Infinity});
      try {for await(const line of lines)result.push(await read(JSON.parse(line),directory,options,owned));} finally {lines.close();}
      assert(result.length===value.count,'Incomplete managed analysis result');
    } else {
      const data=await handle.readFile();
      assert(data.length===value.bytes,'Incomplete managed analysis attachment');
      result=value.encoding==='bytes'||packed.has(value.encoding)?data:value.encoding==='utf8'?data.toString('utf8'):await read(JSON.parse(data.toString('utf8')),directory,options,owned);
    }
    const current=await fs.lstat(target);assert(current.dev===stat.dev&&current.ino===stat.ino&&current.size===stat.size&&!current.isSymbolicLink(),'Managed result changed during read');
    await checkDirectory(directory,parent);await handle.close();await fs.unlink(target);return result;
  } finally {await handle.close().catch(()=>{});}
}
async function inspectManagedSource(target,{signal}={}) {
  signal?.throwIfAborted();
  const {identity,directoryIdentity,checkDirectory}=require('./portable-storage.cjs');
  const parent=await directoryIdentity(path.dirname(target)),selected=await fs.lstat(target);
  assert(selected.isFile()&&!selected.isSymbolicLink()&&selected.nlink===1,'Managed source is not an owned regular file');
  const handle=await fs.open(target,'r');
  try {
    assert(identity(await handle.stat())===identity(selected),'Managed source changed before hashing');
    const digest=createHash('sha256');let bytesLength=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){signal?.throwIfAborted();digest.update(chunk);bytesLength+=chunk.length;}
    signal?.throwIfAborted();
    assert(identity(await fs.lstat(target))===identity(selected)&&bytesLength===selected.size,'Managed source changed during hashing');
    await checkDirectory(path.dirname(target),parent);
    return {path:target,parent,identity:identity(selected),sha256:digest.digest('hex'),bytesLength};
  }finally{await handle.close();}
}
async function removeVerifiedFile(file) {
  const {identity,checkDirectory}=require('./portable-storage.cjs');
  await checkDirectory(path.dirname(file.path),file.parent);
  const stat=await fs.lstat(file.path);
  assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&identity(stat)===file.identity,'Packed scientific file changed before cleanup');
  await fs.unlink(file.path);
}
function packedFieldLength(value, encoding) {
  return value?.[nativeField] && value.encoding===encoding ? value[nativeField].bytesLength : undefined;
}
function fieldBytesIdentity(value, encoding) {
  if (packedFieldLength(value,encoding)!==undefined) return value[nativeField];
  const Type=encoding==='float64-le'?Float64Array:Uint8Array;
  assert(value instanceof Type,'Invalid scientific array type');
  const bytes=Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  return {bytesLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
async function publishManagedFields(value,{files,owner,signal,adopt,release}) {
  if (!files.size) return value;
  const adopted=[];
  async function publish(item) {
    if (item?.[nativeField]) {
      signal?.throwIfAborted();
      const file=item[nativeField];
      const result=await adopt(owner,file,{kind:item.encoding});
      files.delete(file);
      adopted.push(result.binaryAsset.id);
      signal?.throwIfAborted();
      return result;
    }
    if (Array.isArray(item)) { for(let index=0;index<item.length;index++)item[index]=await publish(item[index]); }
    else if(plain(item)) { for(const key of Object.keys(item))item[key]=await publish(item[key]); }
    return item;
  }
  try { return await publish(value); }
  catch(error){await Promise.allSettled(adopted.map(id=>release?.(owner,id)));throw error;}
}
async function discardManagedFields(files) {
  await Promise.allSettled([...files].map(removeVerifiedFile));
  files.clear();
}
function takeCubeExport(value, files) {
  const owned=[];
  function part(entry) {
    assert(plain(entry)&&typeof entry.name==='string'&&entry.name.length>0&&entry.name.length<=512&&path.basename(entry.name)===entry.name,'Invalid Cube export name');
    const file=entry.file?.[exportFile];
    if(!file){assert(typeof entry.text==='string','Invalid completed Cube export');return {name:entry.name,text:entry.text};}
    assert(files.has(file),'Cube export file was transferred twice');
    owned.push(file);
    let cleanup;
    return {name:entry.name,file:{...file,cleanup:()=>cleanup??=removeVerifiedFile(file)}};
  }
  const result=part(value);
  if(value.domain)result.domain=part(value.domain);
  for(const file of owned)files.delete(file);
  return result;
}
module.exports={readManagedResult,inspectManagedSource,packedFieldLength,fieldBytesIdentity,publishManagedFields,discardManagedFields,takeCubeExport};
