'use strict';
const path=require('node:path');
const {assert,plain}=require('./security.cjs');
const {directoryIdentity,currentFile,atomicWrite}=require('./portable-storage.cjs');
const {assertUnmanagedDestination}=require('./portable-export.cjs');
const MAX_CITATION_BYTES=8*1024*1024;
/** A bounded bibliography-only writer. Selection and live-owner checks remain host-owned. */
function createCitationExport({fs,select,assertOwner,roots}) {
 return async function exportCitations(window,request){
  assert(plain(request)&&Object.keys(request).every(k=>['format','text'].includes(k))&&['csv','bib','ris'].includes(request.format)&&typeof request.text==='string'&&Buffer.byteLength(request.text,'utf8')<=MAX_CITATION_BYTES,'Invalid citation export');
  const owner=window.webContents.id;assertOwner(owner);
  const selection=await select(window,request.format);assertOwner(owner);
  if(selection.cancelled||!selection.path)return {cancelled:true};
  let destination=selection.path;if(!path.extname(destination))destination+='.'+request.format;
  assert(path.extname(destination).toLowerCase()==='.'+request.format,'文献导出文件扩展名与所选格式不符。');
  assertUnmanagedDestination(destination,roots());
  const parent=await directoryIdentity(path.dirname(destination),fs),previous=await currentFile(destination,fs,MAX_CITATION_BYTES);
  assert(!previous||selection.overwriteConfirmed===true,'Existing citation export requires overwrite confirmation');
  assertOwner(owner);assertUnmanagedDestination(destination,roots());
  await atomicWrite(destination,Buffer.from(request.text,'utf8'),previous,parent,fs,MAX_CITATION_BYTES);assertOwner(owner);
  return {cancelled:false,path:destination};
 };
}
module.exports={createCitationExport,MAX_CITATION_BYTES};
