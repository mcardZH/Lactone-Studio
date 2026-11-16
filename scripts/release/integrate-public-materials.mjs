// Integrate an explicitly reviewed material projection. Never run old generators.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const encoded=x=>Buffer.from(JSON.stringify(x,null,2)+'\n');
const prefix='third-party/corresponding-sources/pes/';
const safe=p=>{assert(typeof p==='string'&&p&&!p.includes('\\')&&!p.includes(':')&&!p.startsWith('/')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'),'Unsafe material path');return p;};
const id=(path,b)=>({path,bytes:b.length,sha256:hash(b)});
async function ordinary(p){for(let at=resolve(p);;at=dirname(at)){assert(!(await lstat(at)).isSymbolicLink(),'Linked material path');if(dirname(at)===at)break;}}
async function put(root,path,b){safe(path);const p=join(root,path);await mkdir(dirname(p),{recursive:true});await ordinary(dirname(p));try{await ordinary(p);const old=await readFile(p);if(old.equals(b))return;}catch(e){if(e.code!=='ENOENT')throw e;}await writeFile(p,b);}
async function inventory(root,pre=''){const rows=[];for(const name of(await readdir(join(root,pre))).sort()){const path=pre+name,full=join(root,path),s=await lstat(full);assert(!s.isSymbolicLink());if(s.isDirectory())rows.push(...await inventory(root,path+'/'));else rows.push(id(path,await readFile(full)));}return rows;}
export async function integratePublicMaterials({root,preparedRoot,version}){
 root=resolve(root);preparedRoot=resolve(preparedRoot);assert(/^\d+\.\d+\.\d+$/.test(version));await ordinary(preparedRoot);
 const projectionBytes=await readFile(join(preparedRoot,'PUBLIC-MATERIALS.json')),projection=JSON.parse(projectionBytes),sourceData=JSON.parse(await readFile(join(preparedRoot,'sources/SOURCE-MATERIALS.json')));
 assert.equal(projection.schema,'ester-public-material-projection/v1');const seen=new Set(),rows=[];
 // Verify the complete input projection before the first product write.
 for(const r of projection.files){safe(r.path);assert(!seen.has(r.path.toLowerCase()));seen.add(r.path.toLowerCase());await ordinary(join(preparedRoot,r.path));const b=await readFile(join(preparedRoot,r.path));assert.equal(b.length,r.bytes);assert.equal(hash(b),r.sha256);rows.push({r,b});}
 for(const {r,b}of rows){const target=r.path.startsWith('sources/')?prefix+r.path.slice(8):r.path;assert(target.startsWith('licenses/')||target.startsWith(prefix));await put(root,target,b);}
 // Relocate generated path indexes by field; archive and preferred-source bytes stay intact.
 const sourceIndex=structuredClone(sourceData);sourceIndex.version=version;
 sourceIndex.archives=sourceIndex.archives.map(r=>({...r,path:prefix+r.path.slice(8)}));
 if(sourceIndex.libxtbSourceEvidence?.startsWith('sources/'))sourceIndex.libxtbSourceEvidence=prefix+sourceIndex.libxtbSourceEvidence.slice(8);
 await put(root,prefix+'SOURCE-MATERIALS.json',encoded(sourceIndex));
 const fireIdentity=JSON.parse(await readFile(join(root,prefix,'fire-build-controls/IDENTITY.json')));
 await put(root,prefix+'fire-build-controls/IDENTITY.json',encoded(fireIdentity.map(r=>({...r,path:prefix+r.path.slice(8)}))));
 let guide=await readFile(join(root,prefix,'BUILD-AND-REPLACE.md'),'utf8');
 guide=guide.replace('pins thirteen original source archives','pins sixteen original source archives');
 guide=guide.replace(/`project\/scripts\/relink-pes-libxtb\.mjs` and its two local helper modules are included unchanged, together with the lock under `project\/desktop\/packaging\/`\./,'The independent `relink.py` and its lock are included. Historical copied Node controls are excluded; the maintained product source exports its required control modules separately.');
 guide=guide.replace(/The official static objects were extracted[\s\S]*?The final candidate's replacement test is Main's integration work\./,'The official static objects were extracted from the xTB 6.8 official Windows archive. LIBXTB-SOURCE-AND-RELINK-EVIDENCE.json binds all seven direct upstream tags and all 867 static objects to the provided sources. This source-material evidence and the saved provider loading result retain their stated scope. The desktop local modification route is scripts/release/derive-pes-library.mjs in the source attachment; BUILDING.md describes the derived locks and reassembly. Actual candidate loading and numerical validation are separately recorded.');
 await put(root,prefix+'BUILD-AND-REPLACE.md',Buffer.from(guide));
 // Relocate only generated indexes/guides. Original license/source bytes stay intact.
 for(const name of ['licenses/README.md','licenses/COMPONENT_SOURCES.json','licenses/PES-LGPL-REPLACEMENT-NOTICE.md']){
  let text=(await readFile(join(root,name),'utf8')).replaceAll('../sources/','../'+prefix).replaceAll('2.0.24',version);
  if(name.endsWith('README.md'))text=text.replace('第三方材料准备集','第三方许可与来源材料').replace('本目录为下次公开候选准备的许可和署名材料。','本目录提供本版本的许可和署名材料。')+`\n源码、构建和替换材料见同版本配套附件 \`Ester-Studio-v${version}-source.zip\`。文中 \`../third-party/\` 与 \`../scripts/\` 路径相对于该源码附件，不表示它们已嵌入便携目录。\n`;
  await put(root,name,Buffer.from(text));
 }
 const notice='licenses/PES-LGPL-REPLACEMENT-NOTICE.md';let text=await readFile(join(root,notice),'utf8');text+='\n兼容修改版采用配套源码中的 `scripts/release/derive-pes-library.mjs`：生成独立的库目录、派生 component/PES 锁和完整性清单，再沿本地重新装配路径使用。该工具不自动加载库或宣称科学验收。具体命令与阶段见配套源码 `BUILDING.md`。便携目录内的源码路径指同版本源码附件，不表示这些文件已嵌入便携目录。\n';await put(root,notice,Buffer.from(text));
 const samePath='licenses/SAME_BODY_INDEX.json',same=JSON.parse(await readFile(join(root,samePath)));same.version=version;same.files=same.files.filter(r=>!['README.md','COMPONENT_SOURCES.json','PES-LGPL-REPLACEMENT-NOTICE.md'].includes(r.path));await put(root,samePath,encoded(same));
 const publicLicenseNames=new Set(projection.files.filter(r=>r.path.startsWith('licenses/')).map(r=>r.path.slice(9)));
 const licenseFiles=(await inventory(join(root,'licenses'))).filter(r=>r.path!=='SOURCE_INDEX.json'&&publicLicenseNames.has(r.path));await put(root,'licenses/SOURCE_INDEX.json',encoded({schema:'ester-public-license-materials/v2',version,publicDistributionApproved:false,indexSelfExcluded:true,files:licenseFiles}));
 const sourceFiles=await inventory(join(root,prefix));const supplemental={schema:'ester-pes-corresponding-sources/v1',version,publicDistributionApproved:false,sourceStatus:'provided-and-identity-verified',desktopModifiedLibraryAdmission:'pending-actual-candidate-check',scope:'PES libraries, static dependencies, exact patches and re-link/build materials',preparedProjectionSha256:hash(projectionBytes),archives:sourceData.archives.map(r=>({...r,path:prefix+r.path.slice(8)})),files:sourceFiles.map(r=>({...r,path:prefix+r.path}))};
 const supplementalPath='third-party/pes-corresponding-source-index.json',supplementalBytes=encoded(supplemental);await put(root,supplementalPath,supplementalBytes);
 const centralPath='third-party/corresponding-source-index.json',central=JSON.parse(await readFile(join(root,centralPath)));central.supplementalSourceIndexes=[id(supplementalPath,supplementalBytes)];
 // The established central index uses CRLF; keep that byte convention so this
 // scope extension does not rewrite the 684 unchanged member declarations.
 const centralBytes=Buffer.from(encoded(central).toString('utf8').replaceAll('\n','\r\n'));await put(root,centralPath,centralBytes);
 const componentPath='licenses/COMPONENT_SOURCES.json',component=JSON.parse(await readFile(join(root,componentPath)));
 component.correspondingSourceIndex={...component.correspondingSourceIndex,...id('../'+centralPath,centralBytes)};
 component.pesCorrespondingSourceIndex={...id('../'+supplementalPath,supplementalBytes),scope:supplemental.scope,desktopModifiedLibraryAdmission:supplemental.desktopModifiedLibraryAdmission};
 component.sourceMaterialLocation=`References to ../third-party/ and ../scripts/ resolve in companion Ester-Studio-v${version}-source.zip; these are not bundled portable-local paths.`;
 await put(root,componentPath,encoded(component));
 const finalLicenses=(await inventory(join(root,'licenses'))).filter(r=>r.path!=='SOURCE_INDEX.json'&&publicLicenseNames.has(r.path));
 await put(root,'licenses/SOURCE_INDEX.json',encoded({schema:'ester-public-license-materials/v2',version,publicDistributionApproved:false,indexSelfExcluded:true,files:finalLicenses}));
 return{version,projectionMembers:rows.length,licenseMembers:licenseFiles.length+1,pesSourceMembers:sourceFiles.length,supplementalIndex:id(supplementalPath,supplementalBytes),scientificEvaluations:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const [options]=process.argv.slice(2);assert(options,'Supply an explicit JSON options file');console.log(JSON.stringify(await integratePublicMaterials(JSON.parse(await readFile(options))),null,2));}
