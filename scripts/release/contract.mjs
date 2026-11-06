// Public source/self-build metadata. No private receipt is an input.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageLayout} from '../portable-package-layout.mjs';
export const ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url)));
export function productVersionMetadata(pkg){
  const development=pkg.releaseChannel==='development',match=/^(\d+)\.(\d+)\.(\d+)(?:-dev\.([1-9]\d*))?$/.exec(pkg.version??'');
  assert(match,'Invalid product machine version');
  assert(development===Boolean(match[4]),'Development machine versions require the development channel; public versions use three numeric segments');
  const components=match.slice(1,4).map(Number),round=match[4]?Number(match[4]):0;
  assert([...components,round].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=65535),'PE version component exceeds its real 16-bit format');
  const displayVersion=development?components.join('.')+'.dev'+round:pkg.version;
  assert(pkg.displayVersion===undefined&&!development||pkg.displayVersion===displayVersion,'Visible and machine product versions differ');
  return {version:pkg.version,displayVersion,releaseChannel:pkg.releaseChannel??'release',peVersion:[...components,round].join('.'),developmentOnly:development,...(development?{buildPurpose:'internal-development'}:{})};
}
export function createPortableContract({root=ROOT}={}){
  root=resolve(root);const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  const metadata=productVersionMetadata(pkg);
  const applicationFiles=JSON.parse(readFileSync(join(root,'scripts/release/application-files.json'),'utf8'));
  assert(Array.isArray(applicationFiles)&&applicationFiles.includes('desktop/main.cjs')&&applicationFiles.includes('dist'));
  return Object.freeze({root,...metadata,applicationFiles,names:{executableName:'Ester-Studio.exe'},layout:packageLayout(2,pkg.version)});
}
export function runId(value){assert(typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value),'Fresh ASCII run ID required');return value;}
export function assertCurrentRoot(root,path,family){const rel=relative(resolve(root,family),resolve(path));assert(rel&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel),'Input outside declared build family');}
export function validateReleaseDate(value){assert(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value,'Explicit real publication date required');return value;}
export function releaseState({legalReview,windows11='pending',windows10='pending'}={}){
  assert(legalReview&&['blocked','pending','passed'].includes(legalReview.status)&&Array.isArray(legalReview.issues),'Explicit external legal review state required');
  return {publicDistributionApproved:false,legalReview,windows11,windows10,status:legalReview.status==='passed'&&windows11==='passed'?'awaiting-user-publication-decision':'blocked',uploadPerformed:false};
}
