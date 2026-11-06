import { validateCalculationRange } from '../../results/calculation-range';
import type { ModelDocument } from '../../modeling/contracts';
import { CUBE_READ_LIMITS } from '../../results/cube-reader';
import type { SurfaceScalarField } from '../../results/surface-contracts';
import { validateSurfaceScalarField } from '../../results/surface-field';
import type { ModelViewportProps } from './ModelViewport';
import type { SurfaceMeshState, ViewportSurfaceLayer } from './render/surface-layer';
import type {AnalysisColorbarLayout} from '../results/analysis-colorbar-layout';
import { validateMultiframeDisplayPlan, validateSamplingSphereDisplay } from '../../modeling/view-multiframe';
import type { RigidTransform } from './render/alignment';
import { normalizeWorkspaceDocumentJSON, normalizeViewportDisplayMetadataJSON } from '../../modeling/platform/workspace-bridge';
import { validateExtras } from '../../core/modeling/model-document-validation';
import { elementSymbol } from '../../core/elements';
import { validateStructureLibraryProvenance } from '../../core/structure-library-provenance';
import { displayHiddenAtomIds } from './render/trajectory-layer';

type DisplayProperties = Pick<ModelViewportProps,'surfaceLayer'|'viewTransform'|'hiddenAtomIds'|'multiframeDisplay'|'samplingSphere'|'calculationRanges'|'resultAtomLabels'|'resultBondValues'|'resultBondLabels'|'resultHighlights'|'resultColorbar'|'resultColorbarOwnerKey'>;
/** Undefined observation fields mask a detached base view only while an explicit
 * transform is projected. No base observation state or camera is serialized. */
export type ProjectedDisplayProperties = DisplayProperties & Partial<Pick<ModelViewportProps,'observationReference'|'observationEpoch'|'observationFrame'|'observationFixedFrame'|'observationAnchorAtomIds'|'observationTransform'>> & {displayDocument?:ReadonlyViewportDisplayDocument};
export interface ReadonlyViewportDisplayDocument { sourceDocumentId:string; sourceRevision:number; document:ModelDocument }
export interface ViewportDisplayProjection { documentId:string; revision:number; sourceId:string; sourceRevision:string; sourceKey:string; viewport:DisplayProperties;displayDocument?:ReadonlyViewportDisplayDocument }
export interface ViewportDisplayDescriptor { documentId:string; revision:number; sourceId:string; sourceRevision:string; sourceKey:string; projectionSerial:number }
export interface ViewportDisplayPort { onmessage:((event:{data:any})=>void)|null; postMessage(message:unknown):void; close():void }
type Metadata = { layer:Omit<ViewportSurfaceLayer,'pair'>|null; pair:Record<string,unknown>|null; shapeKey:string|null; mappingKey:string|null; display:Omit<DisplayProperties,'surfaceLayer'>; displayDocument?:ReadonlyViewportDisplayDocument };
// Executable setters stay with the trusted owner and never enter a descriptor or packet.
const colorbarSetters=new WeakMap<ViewportDisplayProjection,NonNullable<ModelViewportProps['onResultColorbarLayoutChange']>>();
function checkedColorbarLayout(value:unknown):AnalysisColorbarLayout|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const record=value as Record<string,unknown>,{x,y,length}=record;
  if(Object.keys(record).some(key=>!['x','y','length'].includes(key))||typeof x!=='number'||typeof y!=='number'||typeof length!=='number'||![x,y,length].every(Number.isFinite)||x<0||x>1||y<0||y>1||length<.12||length>.8)return null;
  return{x,y,length};
}
// Includes the complete prepared display plan, not a live trajectory owner.
const FIELD_COUNT=2;
const fail=(message:string):never=>{throw new Error(message);};
/** Exact display snapshot, not a Store, history, editable replica or run owner. */
function readonlyDisplayDocument(input:ModelDocument,target:Pick<ModelDocument,'id'|'revision'>,trusted=false):ModelDocument {
  const structure=input?.draft?.structure,assignments=input?.draft?.assignments;
  if(!input?.id||!Number.isSafeInteger(input.revision)||input.revision<0||!structure||!Array.isArray(structure.atoms)||!structure.atoms.length
    ||new Set(structure.atoms.map(a=>a.id)).size!==structure.atoms.length||structure.atoms.some(a=>typeof a.id!=='string'||!a.id||![a.x,a.y,a.z].every(Number.isFinite)))fail('只读显示结构需要稳定ID和有限坐标原子。');
  const ids=new Set(structure.atoms.map(a=>a.id));
  for(const atom of structure.atoms){if(elementSymbol(atom.element)!==atom.element||atom.formalCharge!==undefined&&!Number.isInteger(atom.formalCharge))fail('只读显示元素或形式电荷无效。');}
  if(structure.charge!==null&&!Number.isInteger(structure.charge)||structure.multiplicity!==null&&(!Number.isInteger(structure.multiplicity)||structure.multiplicity<1))fail('只读显示电子态无效，未猜测电荷或自旋。');
  if(!assignments||!['layers','basis','fragments','frozenAtomIds'].every(key=>Array.isArray(assignments[key as keyof typeof assignments]))
    ||assignments.frozenAtomIds.some(id=>!ids.has(id))||[...assignments.layers,...assignments.basis,...assignments.fragments].some(row=>!Array.isArray(row.atomIds)||row.atomIds.some(id=>!ids.has(id))))fail('只读显示分区或冻结引用了其他来源原子。');
  if((structure.bonds??[]).some(bond=>![bond.a,bond.b].every(i=>Number.isSafeInteger(i)&&i>=0&&i<structure.atoms.length)))fail('只读显示键端点无效。');
  if(structure.libraryProvenance)validateStructureLibraryProvenance(structure.libraryProvenance);
  const projection:ModelDocument={id:target.id,revision:target.revision,draft:{structure,assignments,revision:target.revision,
    selectedIds:[],touchedIds:[],assignmentIssues:[],createdFrom:{},past:[],future:[],dirty:false,baseAtomIds:structure.atoms.map(a=>a.id!),baseStructure:structure,baseAssignments:assignments},
    selection:{atomIds:[],bonds:[],auxiliaryIds:[],portIds:[]},auxiliaryRelations:input.auxiliaryRelations??[],deletedBonds:input.deletedBonds??[],
    internalCoordinates:input.internalCoordinates,sharedConstraints:input.sharedConstraints,coordinateObjects:input.coordinateObjects,gaussianBoundCoordinates:input.gaussianBoundCoordinates,attachmentPorts:input.attachmentPorts,
    canUndo:false,canRedo:false};
  // Trusted owner snapshots are immutable and stay in this renderer. Copy and
  // JSON admission are reserved for the public/wire boundary, not every frame.
  const document=trusted?projection:normalizeWorkspaceDocumentJSON(projection);
  validateExtras(document);return document;
}
function checkedRigidTransform(value:unknown):RigidTransform {
  const invalid=()=>fail('独立显示变换需要有限proper刚体旋转、平移及稳定锚点ID。');
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['rotation','translation','anchorIds'].includes(key)))return invalid();
  const {rotation:r,translation:t,anchorIds:ids}=value as RigidTransform;
  if(!Array.isArray(r)||r.length!==3||r.some(row=>!Array.isArray(row)||row.length!==3||!row.every(n=>typeof n==='number'&&Number.isFinite(n)))
    ||!Array.isArray(t)||t.length!==3||!t.every(n=>typeof n==='number'&&Number.isFinite(n))
    ||!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)return invalid();
  const dot=(a:number[],b:number[])=>a.reduce((sum,n,i)=>sum+n*b[i],0),det=r[0][0]*(r[1][1]*r[2][2]-r[1][2]*r[2][1])-r[0][1]*(r[1][0]*r[2][2]-r[1][2]*r[2][0])+r[0][2]*(r[1][0]*r[2][1]-r[1][1]*r[2][0]);
  if(Math.abs(det-1)>1e-8||r.some((row,i)=>r.some((other,j)=>Math.abs(dot(row,other)-Number(i===j))>1e-8)))return invalid();
  return {rotation:r.map(row=>[...row]) as RigidTransform['rotation'],translation:[...t],anchorIds:[...ids]};
}
export const viewportDisplayChannelName=(documentId:string,token:string)=>`sciyue-viewport-display:${documentId}:${token}`;
export function openViewportDisplayPort(documentId:string,token:string):ViewportDisplayPort{return new BroadcastChannel(viewportDisplayChannelName(documentId,token)) as unknown as ViewportDisplayPort;}
const fieldKey=(field:SurfaceScalarField)=>JSON.stringify([field.id,field.source.id,field.source.revision,field.context]);
function metadata(projection:ViewportDisplayProjection):Metadata{
  const {surfaceLayer,...display}=projection.viewport,displayDocument=projection.displayDocument;if(!surfaceLayer)return{layer:null,pair:null,shapeKey:null,mappingKey:null,display,...displayDocument?{displayDocument}:{}};
  const {pair,...layer}=surfaceLayer,{shape,mapping,...pairMetadata}=pair;
  return {layer,pair:pairMetadata,shapeKey:fieldKey(shape),mappingKey:mapping?fieldKey(mapping):null,display,...displayDocument?{displayDocument}:{}};
}
export function viewportDisplaySignature(projection:ViewportDisplayProjection):string{return JSON.stringify([projection.documentId,projection.revision,projection.sourceId,projection.sourceRevision,projection.sourceKey,metadata(projection)]);}
function viewportDisplayProjection(document:ModelDocument,viewport:Partial<ModelViewportProps>,observedDocument?:ModelDocument,trusted=false):ViewportDisplayProjection|null{
  const displayDocument=observedDocument?{sourceDocumentId:observedDocument.id,sourceRevision:observedDocument.revision,document:readonlyDisplayDocument(observedDocument,document,trusted)}:undefined;
  displayHiddenAtomIds(viewport.hiddenAtomIds,displayDocument?.document.draft.structure??document.draft.structure);
  const supplied=viewport.surfaceLayer,sourceDocument=observedDocument??document;
  const layer=supplied?.visible&&supplied.documentId===sourceDocument.id&&supplied.geometryRevision===sourceDocument.revision?{...supplied,documentId:document.id,geometryRevision:document.revision}:undefined;
  if(viewport.multiframeDisplay)validateMultiframeDisplayPlan(viewport.multiframeDisplay);
  if(viewport.samplingSphere)validateSamplingSphereDisplay(viewport.samplingSphere);
  if(viewport.calculationRanges)viewport.calculationRanges.forEach(validateCalculationRange);
  const viewTransform=viewport.viewTransform===undefined?undefined:checkedRigidTransform(viewport.viewTransform);
  if(!layer&&!viewport.resultColorbar&&!viewport.multiframeDisplay&&!viewport.samplingSphere&&!viewport.calculationRanges?.length&&!viewTransform&&!displayDocument&&!viewport.hiddenAtomIds)return null;
  const context=layer?.pair.shape.context;
  const projection:ViewportDisplayProjection={documentId:document.id,revision:document.revision,sourceId:context?.sourceId??displayDocument?.sourceDocumentId??document.id,sourceRevision:context?.sourceRevision??String(displayDocument?.sourceRevision??document.revision),sourceKey:JSON.stringify([context??['display',document.id,document.revision,displayDocument?.sourceDocumentId,displayDocument?.sourceRevision],layer?fieldKey(layer.pair.shape):null,layer?.pair.mapping?fieldKey(layer.pair.mapping):null,viewport.resultColorbarOwnerKey??null,viewport.multiframeDisplay?.key,viewport.multiframeDisplay?.activeFrameKey,viewport.samplingSphere,viewport.calculationRanges]),displayDocument,
    viewport:{surfaceLayer:layer,viewTransform,hiddenAtomIds:viewport.hiddenAtomIds,multiframeDisplay:viewport.multiframeDisplay,samplingSphere:viewport.samplingSphere,calculationRanges:viewport.calculationRanges,resultAtomLabels:viewport.resultAtomLabels,resultBondValues:viewport.resultBondValues,resultBondLabels:viewport.resultBondLabels,resultHighlights:viewport.resultHighlights,resultColorbar:viewport.resultColorbar,resultColorbarOwnerKey:viewport.resultColorbarOwnerKey}};
  if(viewport.onResultColorbarLayoutChange&&viewport.resultColorbarOwnerKey)colorbarSetters.set(projection,viewport.onResultColorbarLayoutChange);
  return projection;
}
export function createViewportDisplayProjection(document:ModelDocument,viewport:Partial<ModelViewportProps>,observedDocument?:ModelDocument):ViewportDisplayProjection|null{
  return viewportDisplayProjection(document,viewport,observedDocument);
}
/** Owner-renderer path only: inputs are already validated immutable Store or
 * prepared scientific snapshots. Sending/receiving still uses wire admission. */
export function createTrustedViewportDisplayProjection(document:ModelDocument,viewport:Partial<ModelViewportProps>,observedDocument?:ModelDocument):ViewportDisplayProjection|null{
  return viewportDisplayProjection(document,viewport,observedDocument,true);
}
function checkFieldBudget(field:SurfaceScalarField){
  const count=field?.grid?.dimensions?.reduce((n,value)=>n*value,1);
  if(!Number.isSafeInteger(count)||count<1||count>CUBE_READ_LIMITS.points||!(field.values instanceof Float64Array)||field.values.length!==count||field.values.byteLength>CUBE_READ_LIMITS.bytes||!Array.isArray(field.atoms)||field.atoms.length>CUBE_READ_LIMITS.atoms)fail('独立显示格点超出现有Cube预算。');
  if(field.validDomain?.kind==='node-mask'&&(!(field.validDomain.mask instanceof Uint8Array)||field.validDomain.mask.length!==count||field.validDomain.mask.byteLength>CUBE_READ_LIMITS.points))fail('独立显示mask超出现有Cube预算。');
}
function checkedFields(projection:ViewportDisplayProjection):SurfaceScalarField[]{
  if(!projection.viewport.surfaceLayer)return[];
  const pair=projection.viewport.surfaceLayer!.pair,fields=[pair.shape,...pair.mapping?[pair.mapping]:[]];
  if(fields.length>FIELD_COUNT)fail('独立显示仅接收当前形状格点与映射格点。');
  for(const field of fields){checkFieldBudget(field);validateSurfaceScalarField(field);if(field.context.sourceId!==projection.sourceId||field.context.sourceRevision!==projection.sourceRevision)fail('独立显示格点来源不一致。');}
  return fields.filter((field,index)=>fields.findIndex(other=>fieldKey(other)===fieldKey(field))===index);
}
function checkedMetadata(raw:Metadata,descriptor:ViewportDisplayDescriptor):Metadata{
  const value=normalizeViewportDisplayMetadataJSON(raw);
  const validLayer=value?.layer?value.layer.documentId===descriptor.documentId&&value.layer.geometryRevision===descriptor.revision&&typeof value.shapeKey==='string'&&!!value.pair:value?.layer===null&&value.shapeKey===null&&value.mappingKey===null&&value.pair===null&&!!(value.display?.resultColorbar||value.display?.multiframeDisplay||value.display?.samplingSphere||value.display?.calculationRanges?.length||value.display?.viewTransform||value.displayDocument||value.display?.hiddenAtomIds);
  if(!value||!validLayer||!(value.mappingKey===null||typeof value.mappingKey==='string'))fail('独立显示元数据无效。');
  if(value.displayDocument){const data=value.displayDocument;if(typeof data.sourceDocumentId!=='string'||!data.sourceDocumentId||!Number.isSafeInteger(data.sourceRevision)||data.sourceRevision<0||data.document?.id!==descriptor.documentId||data.document.revision!==descriptor.revision)fail('只读显示快照与已认证容器身份不匹配。');
    const checked=readonlyDisplayDocument(data.document,{id:descriptor.documentId,revision:descriptor.revision},true);if(JSON.stringify(data.document)!==JSON.stringify(checked))fail('只读显示快照包含非显示状态、历史或非空选区。');}
  if(value.display.multiframeDisplay)validateMultiframeDisplayPlan(value.display.multiframeDisplay);
  if(value.displayDocument&&value.display.multiframeDisplay){const plan=value.display.multiframeDisplay,frame=plan.frames.find(frame=>frame.key===plan.activeFrameKey)!,atoms=value.displayDocument.document.draft.structure.atoms,byId=new Map(frame.structure.atoms.map(a=>[a.id,a]));
    if(atoms.length!==byId.size||atoms.some(a=>{const b=byId.get(a.id);return!b||a.element!==b.element||a.x!==b.x||a.y!==b.y||a.z!==b.z;}))fail('只读显示结构与叠合当前源帧不一致，未按容器原子猜测对应。');}
  if(value.display.samplingSphere)validateSamplingSphereDisplay(value.display.samplingSphere);
  if(value.display.calculationRanges){if(!Array.isArray(value.display.calculationRanges))fail('独立显示计算范围格式无效。');value.display.calculationRanges.forEach(validateCalculationRange);}
  if(value.display.viewTransform!==undefined)checkedRigidTransform(value.display.viewTransform);
  displayHiddenAtomIds(value.display.hiddenAtomIds,value.displayDocument?.document.draft.structure);
  return value;
}
const matches=(a:ViewportDisplayDescriptor,b:ViewportDisplayDescriptor)=>a.documentId===b.documentId&&a.revision===b.revision&&a.sourceId===b.sourceId&&a.sourceRevision===b.sourceRevision&&a.sourceKey===b.sourceKey;
/** The caller creates this endpoint only after the existing host has
 * authenticated doc/membershipNonce and identified the actual detached member.
 * This channel name alone never grants access. At most one packet is in flight. */
export function createViewportDisplayOwner(options:{port:ViewportDisplayPort;documentId:string;token:string;onMesh(state:Readonly<SurfaceMeshState>,document:Pick<ModelDocument,'id'|'revision'>):void;onError(message:string):void}){
  let disposed=false,active=false,current:ViewportDisplayProjection|null=null,serial=0,inflight=0,sentKey:string|null=null,validatedKey:string|null=null,requestPending=false,requireFields=false;
  const descriptor=():ViewportDisplayDescriptor|null=>current?{documentId:current.documentId,revision:current.revision,sourceId:current.sourceId,sourceRevision:current.sourceRevision,sourceKey:current.sourceKey,projectionSerial:serial}:null;
  function send(){
    if(disposed||!active||inflight)return;
    const description=descriptor();
    if(!description||!current){sentKey=null;options.port.postMessage({kind:'clear',token:options.token,documentId:options.documentId,serial});return;}
    try{
      const small=checkedMetadata(metadata(current),description);
      const changed=sentKey!==current.sourceKey;
      let fields:SurfaceScalarField[]|undefined;
      if(changed&&current.viewport.surfaceLayer){const pair=current.viewport.surfaceLayer.pair;checkFieldBudget(pair.shape);if(pair.mapping)checkFieldBudget(pair.mapping);if(validatedKey!==current.sourceKey){checkedFields(current);validatedKey=current.sourceKey;}fields=[pair.shape,...pair.mapping&&fieldKey(pair.mapping)!==fieldKey(pair.shape)?[pair.mapping]:[]];}
      options.port.postMessage({kind:'projection',token:options.token,descriptor:description,metadata:small,...fields?{fields}:{}});inflight=serial;sentKey=current.sourceKey;
    }catch(error){options.onError(error instanceof Error?error.message:String(error));}
  }
  options.port.onmessage=({data})=>{
    if(disposed||!data||data.token!==options.token||data.documentId!==options.documentId)return;
    if(data.kind==='request'){active=true;requireFields||=data.haveSourceKey!==current?.sourceKey;if(inflight){requestPending=true;return;}if(requireFields)sentKey=null;requireFields=false;send();}
    else if(data.kind==='pause'){active=false;inflight=0;sentKey=null;requestPending=false;requireFields=false;}
    else if(data.kind==='ack'&&data.serial===inflight){inflight=0;if(requireFields||data.needFields===true)sentKey=null;requireFields=false;if(requestPending||data.serial!==serial){requestPending=false;send();}}
    else if(data.kind==='colorbar-layout'&&active&&data.serial===serial&&current&&data.sourceKey===current.sourceKey&&data.revision===current.revision&&data.ownerKey===current.viewport.resultColorbarOwnerKey&&typeof data.ownerKey==='string'){
      const layout=checkedColorbarLayout(data.layout),setter=colorbarSetters.get(current);
      if(layout&&setter)try{setter(layout);}catch(error){options.onError(error instanceof Error?error.message:String(error));}
    }
    else if(data.kind==='mesh'&&data.serial===serial&&current?.viewport.surfaceLayer&&data.sourceKey===current.sourceKey&&data.revision===current.revision){
      const state=data.state as SurfaceMeshState,pair=current.viewport.surfaceLayer!.pair;
      if(state&&['empty','pending','committed','failed'].includes(state.status)&&['shapeCount','vertexCount','triangleCount'].every(key=>Number.isSafeInteger(state[key as 'shapeCount'])&&state[key as 'shapeCount']>=0)&&typeof state.submitted==='boolean'&&state.sourceId===current.sourceId&&state.sourceRevision===current.sourceRevision&&state.shapeId===pair.shape.id&&(state.mappingId??null)===(pair.mapping?.id??null))options.onMesh(state,{id:current.documentId,revision:current.revision});
    }
  };
  return {publish(projection:ViewportDisplayProjection|null,projectionSerial:number){if(disposed||projectionSerial<serial||projectionSerial===serial&&projection===current)return;if(projectionSerial===serial){if(projection&&current&&viewportDisplaySignature(projection)===viewportDisplaySignature(current))current=projection;return;}current=projection;serial=projectionSerial;send();},close(){if(disposed)return;options.port.postMessage({kind:'clear',token:options.token,documentId:options.documentId,serial:serial+1});disposed=true;active=false;current=null;options.port.onmessage=null;options.port.close();}};
}
/** One read-only renderer cache. Authorization is completed by the existing
 * host command receipt before request() is called. No compute API is exposed. */
export function createViewportDisplayConsumer(options:{port:ViewportDisplayPort;token:string;expected:ViewportDisplayDescriptor;onProjection(viewport:ProjectedDisplayProperties|null):void;onError(message:string):void}){
  let disposed=false,authorized=false,expected=options.expected,accepted=0,acceptedOwnerKey:string|undefined,cache=new Map<string,SurfaceScalarField>();
  const post=(value:Record<string,unknown>)=>options.port.postMessage({...value,token:options.token,documentId:expected.documentId});
  function request(){if(authorized&&!disposed)post({kind:'request',haveSourceKey:cache.size?expected.sourceKey:null});}
  options.port.onmessage=({data})=>{
    if(disposed||!authorized||!data||data.token!==options.token)return;
    if(data.kind==='clear'&&data.documentId===expected.documentId&&data.serial>=Math.max(accepted,expected.projectionSerial)){accepted=data.serial;acceptedOwnerKey=undefined;cache.clear();options.onProjection(null);return;}
    if(data.kind!=='projection')return;
    const description=data.descriptor as ViewportDisplayDescriptor;
    if(!description||!Number.isSafeInteger(description.projectionSerial)||description.projectionSerial<=accepted||description.projectionSerial<expected.projectionSerial||!matches(description,expected)){if(description?.projectionSerial)post({kind:'ack',serial:description.projectionSerial,needFields:cache.size===0});return;}
    try{
      const small=checkedMetadata(data.metadata,description);
      if(data.fields!==undefined){
        if(!Array.isArray(data.fields)||!data.fields.length||data.fields.length>FIELD_COUNT)fail('独立显示格点数量超出预算。');
        const next=new Map<string,SurfaceScalarField>();for(const field of data.fields as SurfaceScalarField[]){checkFieldBudget(field);validateSurfaceScalarField(field);if(field.context.sourceId!==description.sourceId||field.context.sourceRevision!==description.sourceRevision||next.has(fieldKey(field)))fail('独立显示格点来源或身份不一致。');next.set(fieldKey(field),field);}if([...next.keys()].some(key=>key!==small.shapeKey&&key!==small.mappingKey))fail('独立显示拒绝非当前格点缓存。');cache=next;
      }
      const shape=small.shapeKey?cache.get(small.shapeKey):null,mapping=small.mappingKey?cache.get(small.mappingKey):null;
      if(small.layer&&(!shape||small.mappingKey&&!mapping))fail('独立显示格点尚未收到，未显示其他来源。');
      const layer=small.layer?{...small.layer,pair:{...small.pair,shape,mapping}} as ViewportSurfaceLayer:undefined;
      accepted=description.projectionSerial;acceptedOwnerKey=small.display.resultColorbarOwnerKey;
      options.onProjection({...small.display,surfaceLayer:layer,displayDocument:small.displayDocument,...small.display.viewTransform||small.displayDocument?{observationReference:undefined,observationEpoch:undefined,observationFrame:undefined,observationFixedFrame:undefined,observationAnchorAtomIds:undefined,observationTransform:undefined}:{}});
    }catch(error){cache.clear();acceptedOwnerKey=undefined;options.onProjection(null);options.onError(error instanceof Error?error.message:String(error));}
    finally{post({kind:'ack',serial:description.projectionSerial});}
  };
  return {authorize(){authorized=true;request();},expect(next:ViewportDisplayDescriptor){if(!matches(expected,next)){cache.clear();accepted=0;acceptedOwnerKey=undefined;options.onProjection(null);}expected=next;request();},colorbarLayout(value:AnalysisColorbarLayout){const layout=checkedColorbarLayout(value);if(disposed||!authorized||!layout||!acceptedOwnerKey||accepted!==expected.projectionSerial)return false;post({kind:'colorbar-layout',serial:accepted,sourceKey:expected.sourceKey,revision:expected.revision,ownerKey:acceptedOwnerKey,layout});return true;},mesh(state:Readonly<SurfaceMeshState>,document:Pick<ModelDocument,'id'|'revision'>){if(!disposed&&authorized&&document.id===expected.documentId&&document.revision===expected.revision)post({kind:'mesh',serial:accepted,sourceKey:expected.sourceKey,revision:document.revision,state});},close(){if(disposed)return;if(authorized)post({kind:'pause'});disposed=true;acceptedOwnerKey=undefined;cache.clear();options.onProjection(null);options.port.onmessage=null;options.port.close();}};
}
export type ViewportDisplayOwner=ReturnType<typeof createViewportDisplayOwner>;
export type ViewportDisplayConsumer=ReturnType<typeof createViewportDisplayConsumer>;
