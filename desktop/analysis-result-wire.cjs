'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const {createHash}=require('node:crypto');
const { assert, plain } = require('./security.cjs');

/** Attachments are worker outputs under this operation's host-owned directory.
 * Never accept a renderer path or delete files outside that exact directory. */
async function readManagedResult(value, directory) {
  if (Array.isArray(value)) {
    const result=[];for(const entry of value)result.push(await readManagedResult(entry,directory));return result;
  }
  if (!plain(value)) return value;
  if (!Object.hasOwn(value,'esResultAttachment')) {
    const result={};for(const [key,entry] of Object.entries(value))result[key]=await readManagedResult(entry,directory);return result;
  }
  assert(typeof directory==='string' && path.isAbsolute(directory),'Missing owned analysis result directory');
  assert(/^es-result-[a-f0-9]{32}\.(?:json|jsonl|bin|txt)$/.test(value.esResultAttachment) && ['json','jsonl','bytes','utf8'].includes(value.encoding),'Invalid managed analysis result');
  assert(Number.isSafeInteger(value.bytes)&&value.bytes>=0,'Invalid managed result byte count');
  const {directoryIdentity,checkDirectory}=require('./portable-storage.cjs');
  const parent=await directoryIdentity(directory);
  const target=path.join(directory,value.esResultAttachment),stat=await fs.lstat(target);
  assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size===value.bytes,'Managed analysis result identity changed');
  const handle=await fs.open(target,'r');
  try {
    const opened=await handle.stat();assert(opened.dev===stat.dev&&opened.ino===stat.ino&&opened.size===stat.size,'Managed result was replaced');
    let result;
    if(value.encoding==='jsonl') {
      assert(Number.isSafeInteger(value.count)&&value.count>=0,'Invalid managed result count');
      result=[];
      const lines=readline.createInterface({input:handle.createReadStream({autoClose:false,encoding:'utf8'}),crlfDelay:Infinity});
      try {for await(const line of lines)result.push(await readManagedResult(JSON.parse(line),directory));} finally {lines.close();}
      assert(result.length===value.count,'Incomplete managed analysis result');
    } else {
      const data=await handle.readFile();
      assert(data.length===value.bytes,'Incomplete managed analysis attachment');
      result=value.encoding==='bytes'?data:value.encoding==='utf8'?data.toString('utf8'):await readManagedResult(JSON.parse(data.toString('utf8')),directory);
    }
    const current=await fs.lstat(target);assert(current.dev===stat.dev&&current.ino===stat.ino&&current.size===stat.size&&!current.isSymbolicLink(),'Managed result changed during read');
    await checkDirectory(directory,parent);await handle.close();await fs.unlink(target);return result;
  } finally {await handle.close().catch(()=>{});}
}
async function inspectManagedSource(target) {
  const {identity,directoryIdentity,checkDirectory}=require('./portable-storage.cjs');
  const parent=await directoryIdentity(path.dirname(target)),selected=await fs.lstat(target);
  assert(selected.isFile()&&!selected.isSymbolicLink()&&selected.nlink===1,'Managed source is not an owned regular file');
  const handle=await fs.open(target,'r');
  try {
    assert(identity(await handle.stat())===identity(selected),'Managed source changed before hashing');
    const digest=createHash('sha256');let bytesLength=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){digest.update(chunk);bytesLength+=chunk.length;}
    assert(identity(await fs.lstat(target))===identity(selected)&&bytesLength===selected.size,'Managed source changed during hashing');
    await checkDirectory(path.dirname(target),parent);
    return {path:target,parent,identity:identity(selected),sha256:digest.digest('hex'),bytesLength};
  }finally{await handle.close();}
}
module.exports={readManagedResult,inspectManagedSource};
