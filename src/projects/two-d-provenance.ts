import type { TwoDCommitData, TwoDFormat, TwoDSourceInput } from '../modeling/two-d/types';

export type TwoDProvenanceJSON = null | boolean | number | string | TwoDProvenanceJSON[] | { [key:string]:TwoDProvenanceJSON };
export interface TwoDProvenanceArtifact { role:string;name:string;bytes:Uint8Array;mime?:string }
export interface TwoDProvenanceEngine { engine:string;version:string;method?:string }
export interface TwoDRecognitionProvenance extends TwoDProvenanceEngine {
  crop?:{x:number;y:number;width:number;height:number;imageWidth?:number;imageHeight?:number};
  originalImageRole?:string;inputImageRole?:string;rawCandidateRoles?:string[];
  model?:{name?:string;version?:string;sha256?:string};details?:{[key:string]:TwoDProvenanceJSON};
}
export interface CreateTwoDProvenanceFilesInput {
  source:TwoDSourceInput;commit:TwoDCommitData;artifacts?:readonly TwoDProvenanceArtifact[];
  recognition?:TwoDRecognitionProvenance;
  engines?:{parser?:TwoDProvenanceEngine;editor?:TwoDProvenanceEngine;generator?:TwoDProvenanceEngine};
}
export interface TwoDProvenanceFileRecord { role:string;name:string;sha256:string;size:number;mime:string }
interface FrozenArtifact {role:string;name:string;bytes:Uint8Array<ArrayBuffer>;mime:string}
const encoder=new TextEncoder();
function fail(message:string):never{throw new Error('二维来源留存：'+message);}
const checkUTF8=(value:string,label:string)=>{if(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))fail(label+'含无法无损编码为UTF-8的字符。');};
const requireText=(value:unknown,label:string):string=>{if(typeof value!=='string'||!value.trim())return fail(label+'须为非空文本。');checkUTF8(value,label);return value;};
function safeName(value:string,label:string){
  if(typeof value!=='string'||value.length>240||!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)||value.includes('..')||value.endsWith('.')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))fail(label+'须为唯一、安全的ASCII名称。');
}
/** Copy data before the first await. Never invoke a getter/toJSON or turn
 * unsupported runtime objects into silently incomplete project provenance. */
function copyJSON(value:unknown,path:string,stack=new Set<object>()):unknown{
  if(value===undefined||value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){checkUTF8(value,path);return value;}
  if(typeof value==='number'){if(!Number.isFinite(value))fail(path+'含非有限数字。');return value;}
  if(typeof value!=='object'||(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))return fail(path+'只接受普通JSON；原始载荷应作为独立artifact。');
  if(stack.has(value))return fail(path+'含循环引用。');stack.add(value);
  try{
    const keys=Object.keys(value);if(Array.isArray(value)&&(keys.length!==value.length||keys.some(key=>!/^\d+$/.test(key))))fail(path+'含稀疏或附加属性数组。');
    if(Object.getOwnPropertySymbols(value).length)fail(path+'含非JSON属性。');
    const result:unknown[]|Record<string,unknown>=Array.isArray(value)?[]:{};
    for(const key of keys){if(['__proto__','constructor','prototype'].includes(key))fail(path+'含不安全字段。');const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value'in descriptor))fail(path+'不能包含访问器。');const entry=copyJSON(descriptor.value,path+'.'+key,stack);if(Array.isArray(value)&&entry===undefined)fail(path+'数组含未定义项。');if(entry!==undefined)(result as Record<string,unknown>)[key]=entry;}
    return result;
  }finally{stack.delete(value);}
}
function checkEngine(value:TwoDProvenanceEngine,label:string){requireText(value.engine,label+'引擎');requireText(value.version,label+'版本');if(value.method!==undefined)requireText(value.method,label+'方法');}
const isImage=(artifact:FrozenArtifact)=>artifact.mime.startsWith('image/')||/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(artifact.name);
const mimeFor:(format:TwoDFormat)=>string=format=>({cdx:'application/octet-stream',cdxml:'application/xml',mol:'chemical/x-mdl-molfile',ket:'application/json'})[format];

/** Creates immutable File payloads for registerImportedModelSources. It does
 * not register sources, mutate Structure, create a document or recognize an
 * image. The manifest lists all payloads except itself (no self-referential
 * hash); the existing project asset writer hashes the manifest independently. */
export async function createTwoDProvenanceFiles(input:CreateTwoDProvenanceFilesInput):Promise<File[]>{
  const {source,commit}=input;
  requireText(source.id,'来源ID');if(commit.source.id!==source.id)fail('提交与原始来源ID不一致。');
  const format=source.format??commit.source.format;
  if(!['cdx','cdxml','mol','ket'].includes(format)||source.format&&source.format!==commit.source.format)fail('提交与原始格式不一致。');
  requireText(commit.selectedComponentId,'所选组分ID');requireText(commit.originalKet,'原始候选KET');requireText(commit.finalKet,'最终KET');
  if(typeof commit.edited!=='boolean')fail('缺少明确的编辑标记。');
  const graph=copyJSON(commit.finalGraph,'最终二维图') as TwoDCommitData['finalGraph'];
  if(!Array.isArray(graph.atoms)||!Array.isArray(graph.bonds))fail('最终二维图缺少明确原子和连接列表。');
  const atomIds=new Set<string>();
  const atomMapping=graph.atoms.map(atom=>{const atomId=requireText(atom.id,'稳定原子ID');if(atomIds.has(atomId))fail('最终二维图存在重复稳定原子ID。');atomIds.add(atomId);const sourceAtomKey=(atom as typeof atom&{sourceAtomKey?:unknown}).sourceAtomKey;if(sourceAtomKey!==undefined)requireText(sourceAtomKey,'原始原子键');return{atomId,...(sourceAtomKey!==undefined?{sourceAtomKey}:{}),...(atom.sourceIndex!==undefined?{sourceIndex:atom.sourceIndex}:{})};});
  if(!atomIds.size)fail('最终二维图不能为空。');
  for(const bond of graph.bonds)if(!Number.isSafeInteger(bond.a)||!Number.isSafeInteger(bond.b)||bond.a<0||bond.b<0||bond.a>=graph.atoms.length||bond.b>=graph.atoms.length)fail('最终二维图连接端点失效。');
  const recognition=copyJSON(input.recognition,'识别记录') as TwoDRecognitionProvenance|undefined;
  const engines=copyJSON(input.engines,'处理引擎') as CreateTwoDProvenanceFilesInput['engines'];
  if(recognition){checkEngine(recognition,'识别');if(recognition.model?.sha256!==undefined&&!/^[a-f0-9]{64}$/i.test(recognition.model.sha256))fail('识别模型SHA256无效。');const crop=recognition.crop;if(crop){if(![crop.x,crop.y,crop.width,crop.height].every(Number.isFinite)||crop.x<0||crop.y<0||crop.width<=0||crop.height<=0)fail('原图像素裁切范围无效。');const bounds:[number|undefined,number][]=[[crop.imageWidth,crop.x+crop.width],[crop.imageHeight,crop.y+crop.height]];for(const[size,end]of bounds)if(size!==undefined&&(!Number.isFinite(size)||size<=0||end>size))fail('裁切超出原图尺寸。');}}
  for(const engine of Object.values(engines??{}))if(engine)checkEngine(engine,'处理');
  const payloads:FrozenArtifact[]=[],roles=new Set<string>(),names=new Set<string>();
  const add=(role:string,name:string,bytes:Uint8Array,mime:string)=>{safeName(role,'角色');safeName(name,'文件名');if(roles.has(role.toLowerCase())||names.has(name.toLowerCase()))fail('来源角色或逻辑文件名重复：'+role+' / '+name);const type=requireText(mime,'MIME类型').toLowerCase();if(/[^\x20-\x7e]/.test(type))fail('MIME类型含无效字符。');roles.add(role.toLowerCase());names.add(name.toLowerCase());payloads.push({role,name,bytes:new Uint8Array(bytes),mime:type});};
  if(format==='cdx'&&typeof source.data==='string')fail('二进制CDX须提供原始Uint8Array字节，不能用文本编码替代。');
  const raw=typeof source.data==='string'?encoder.encode(requireText(source.data,'原始来源')):source.data;
  if(!(raw instanceof Uint8Array)||!raw.byteLength)fail('原始来源须包含完整非空字节。');
  add('original',`original.${format}`,raw,mimeFor(format));
  add('initial-ket','initial.ket',encoder.encode(commit.originalKet),'application/json');
  add('final-ket','final.ket',encoder.encode(commit.finalKet),'application/json');
  add('final-graph','final-2d.json',encoder.encode(JSON.stringify(graph)),'application/json');
  // Reserve the manifest too; an extra must not shadow it by role or case.
  roles.add('provenance');names.add('2d-provenance.json');
  for(const artifact of input.artifacts??[]){if(!(artifact.bytes instanceof Uint8Array))fail('artifact须提供实际字节。');add(artifact.role,artifact.name,artifact.bytes,artifact.mime??'application/octet-stream');}
  if(recognition){
    const byRole=new Map(payloads.map(artifact=>[artifact.role,artifact]));
    if(!payloads.some(artifact=>isImage(artifact)&&artifact.bytes.byteLength>0))fail('图片识别来源缺少原图或实际识别输入图像artifact。');
    for(const role of[recognition.originalImageRole,recognition.inputImageRole])if(role!==undefined&&(!byRole.has(role)||!isImage(byRole.get(role)!)))fail('图像角色必须指向实际图像artifact：'+role);
    for(const role of recognition.rawCandidateRoles??[])if(!byRole.has(role))fail('原始候选角色不存在：'+role);
  }
  const sourceRecord={id:source.id,format,customerName:source.name??commit.source.name,
    sourceKind:recognition?'image-recognition':format==='ket'&&!source.name&&!commit.source.name?'draw':'file-import',payloadRole:'original'};
  const manifestBase={schema:'ester-two-d-provenance',version:1,source:sourceRecord,selectedComponentId:commit.selectedComponentId,edited:commit.edited,
    issues:copyJSON(commit.issues,'来源问题'),atomMapping,engines,recognition:recognition?{...recognition,...(recognition.crop?{crop:{...recognition.crop,coordinateSpace:'original-image-pixels'}}:{})}:undefined,
    relationships:{originalRole:'original',initialKetRole:'initial-ket',finalKetRole:'final-ket',finalGraphRole:'final-graph',...(recognition?{recognitionImageRoles:payloads.filter(isImage).map(artifact=>artifact.role)}:{})}};
  // Everything above is a synchronous copy. Caller edits after this point can
  // no longer change the hashed bytes, graph, engine or crop being delivered.
  const records:TwoDProvenanceFileRecord[]=await Promise.all(payloads.map(async artifact=>{const digest=await crypto.subtle.digest('SHA-256',artifact.bytes.buffer);return{role:artifact.role,name:artifact.name,sha256:[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join(''),size:artifact.bytes.byteLength,mime:artifact.mime};}));
  const files=payloads.map(artifact=>Object.freeze(new File([artifact.bytes.buffer],artifact.name,{type:artifact.mime,lastModified:0})));
  files.push(Object.freeze(new File([JSON.stringify({...manifestBase,artifacts:records},null,2)+'\n'],'2d-provenance.json',{type:'application/json',lastModified:0})));
  Object.freeze(files);return files;
}
