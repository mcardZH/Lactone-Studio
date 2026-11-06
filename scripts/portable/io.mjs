// Version-neutral, no-overwrite filesystem boundary shared by current tools.
import assert from 'node:assert/strict';
import {lstat,open,mkdir,readdir} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,parse,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {packageRelativePath} from '../portable-artifact-identity.mjs';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const encoded=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
export const identity=(path,bytes)=>({path,bytes:bytes.length,sha256:sha(bytes)});
export function within(root,path){const rel=relative(resolve(root),resolve(path));assert(rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel),'Path must stay strictly below its declared root');return resolve(path);}
export function projectPath(root,name){return within(root,resolve(root,name));}
export async function ancestors(path){let cursor=parse(resolve(path)).root;const rows=[];for(const part of [null,...relative(cursor,resolve(path)).split(sep).filter(Boolean)]){if(part!==null)cursor=join(cursor,part);const stat=await lstat(cursor,{bigint:true});assert(!stat.isSymbolicLink(),'Linked path forbidden');rows.push({path:cursor,dev:stat.dev,ino:stat.ino,directory:stat.isDirectory()});}return rows;}
export async function stable(rows){for(const row of rows){const stat=await lstat(row.path,{bigint:true});assert(!stat.isSymbolicLink());assert.deepEqual({dev:stat.dev,ino:stat.ino,directory:stat.isDirectory()},{dev:row.dev,ino:row.ino,directory:row.directory},'Path identity changed');}}
export async function readFileChecked(path,expected){path=resolve(path);const parents=await ancestors(path),fd=await open(path,'r');let bytes;try{const before=await fd.stat({bigint:true});assert(before.isFile()&&before.nlink===1n,'Private ordinary input required');assert.equal(before.ino,parents.at(-1).ino);assert.equal(before.dev,parents.at(-1).dev);bytes=await fd.readFile();const after=await fd.stat({bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs','nlink'])assert.equal(after[key],before[key],'Input changed while reading');}finally{await fd.close();}await stable(parents);if(expected){assert.equal(bytes.length,expected.bytes);assert.equal(sha(bytes),expected.sha256,'Input bytes changed');}return bytes;}
async function readExactReference(root,reference,{json=true}={}){assert.deepEqual(Object.keys(reference).sort(),['bytes','path','sha256']);const bytes=await readFileChecked(projectPath(root,reference.path),reference);return json?JSON.parse(bytes):bytes;}
export async function readReference(root,reference,options){const path=projectPath(root,reference.path),name=relative(root,path).replaceAll('\\','/');assert(!/^\.cache\/(?:v\d{3,4}|engine-slim)(?:\/|$)/.test(name),'Historical receipt trees are not current operational inputs');return readExactReference(root,reference,options);}
// Facts may retain their original current/historical cache location. This only
// reads exact bytes; it is never the build/source/dependency input reader.
export async function readEvidenceReference(root,reference,options){return readExactReference(root,reference,options);}
export async function readInput(root,path){path=projectPath(root,path);const bytes=await readFileChecked(path);return{reference:identity(path,bytes),data:JSON.parse(bytes)};}
export async function absent(path){try{await lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}throw Error('Target exists; no overwrite, resume or automatic cleanup: '+path);}
export async function createTree(path){path=resolve(path);await absent(path);const parents=await ancestors(dirname(path));assert(parents.at(-1).directory);await stable(parents);await mkdir(path);const rootRows=await ancestors(path),directories=new Map([[path,rootRows.at(-1)]]);
  return{path,async put(name,bytes){name=packageRelativePath(name);await stable(rootRows);let cursor=path;for(const part of name.split('/').slice(0,-1)){cursor=join(cursor,part);if(!directories.has(cursor)){await stable([...rootRows,...directories.values()]);await mkdir(cursor);directories.set(cursor,(await ancestors(cursor)).at(-1));}}await stable([...rootRows,...directories.values()]);const target=join(path,name),fd=await open(target,'wx');try{const before=await fd.stat({bigint:true});assert(before.isFile()&&before.nlink===1n);await fd.writeFile(bytes);await fd.sync();const after=await fd.stat({bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.size,BigInt(bytes.length));}finally{await fd.close();}await stable([...rootRows,...directories.values()]);await readFileChecked(target,identity(name,bytes));return identity(name,bytes);}};
}
export async function inventory(root,{exclude=()=>false}={}){await ancestors(root);const files=[];async function walk(path,name){if(exclude(name))return;const stat=await lstat(path);assert(!stat.isSymbolicLink(),'Inventory links forbidden');if(stat.isDirectory()){for(const child of (await readdir(path)).sort())await walk(join(path,child),name?name+'/'+child:child);}else{assert(stat.isFile());const bytes=await readFileChecked(path);files.push(identity(packageRelativePath(name),bytes));}}await walk(resolve(root),'');return files.sort((a,b)=>a.path.localeCompare(b.path));}
export function matchFiles(actual,expected){
  for(const rows of [actual,expected]){const paths=new Set();for(const row of rows){const key=row.path.toLowerCase();assert(!paths.has(key),'Duplicate/case-colliding inventory path');paths.add(key);}}
  const ordered=rows=>[...rows].sort((a,b)=>a.path.localeCompare(b.path));
  assert.deepEqual(ordered(actual),ordered(expected),'Exact complete file membership and identities required');
}
