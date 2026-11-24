import { validateCalculationRange } from '../../results/calculation-range';
import type { ModelDocument } from '../../modeling/contracts';
import { CUBE_READ_LIMITS } from '../../results/cube-reader';
import type { SurfaceScalarField } from '../../results/surface-contracts';
import { validateSurfaceScalarField } from '../../results/surface-field';
import { validateNtoField } from '../../results/excitation-field';
import type { NtoField } from '../../results/excitation-contracts';
import type { OrbitalField, ViewportOrbitalLayer } from '../../results/orbital-contracts';
import type { NtoMeshState, ViewportNtoLayer } from './render/orbital-layer';
import { CUBE_PAGE_BYTES } from '../results/cube-display-reader';
import { materializeCubeFields } from '../results/cube-asset-bridge';
import { cipStructureForDisplay } from './render/stereochemistry';
import type { ModelViewportProps } from './ModelViewport';
import {sameViewportRenderIdentity,type ViewportRenderIdentity} from './render/render-completion';
import type { SurfaceLayerMeshState, SurfaceMeshState, ViewportSurfaceLayer } from './render/surface-layer';
import {ANALYSIS_COLORBAR_FONTS,ANALYSIS_COLORBAR_LIMITS,type AnalysisColorbarLayout} from '../results/analysis-colorbar-layout';
import type {ViewportImageExportOptions} from '../results/export-image';
import { validateMultiframeDisplayPlan, validateSamplingSphereDisplay } from '../../modeling/view-multiframe';
import type { RigidTransform } from './render/alignment';
import { normalizeWorkspaceDocumentJSON, normalizeViewportDisplayMetadataJSON } from '../../modeling/platform/workspace-bridge';
import { validateExtras } from '../../core/modeling/model-document-validation';
import { elementSymbol } from '../../core/elements';
import { validateStructureLibraryProvenance } from '../../core/structure-library-provenance';
import { displayHiddenAtomIds } from './render/trajectory-layer';
import {projectStructureExportDocument} from '../../modeling/application/structure-export-snapshot';
import {checkedFrameBondEditing,type FrameBondEditingState,type FrameBondTarget} from './workspace-viewport';

type DisplayProperties = Pick<ModelViewportProps,'surfaceLayer'|'surfaceLayers'|'surfaceExtrema'|'orbitalLayer'|'ntoLayer'|'vibrationVectors'|'dipoleVector'|'atomScalarValues'|'atomScalarColor'|'atomScalarLabels'|'viewTransform'|'fixedCellView'|'hiddenAtomIds'|'multiframeDisplay'|'samplingSphere'|'calculationRanges'|'resultAtomLabels'|'resultBondValues'|'resultBondLabels'|'resultBondColor'|'resultHighlights'|'resultColorbar'|'resultColorbarOwnerKey'|'renderIdentity'>;
/** Undefined observation fields mask a detached base view only while an explicit
 * transform is projected. No base observation state or camera is serialized. */
export type ProjectedDisplayProperties = DisplayProperties & Partial<Pick<ModelViewportProps,'observationReference'|'observationEpoch'|'observationFrame'|'observationFixedFrame'|'observationAnchorAtomIds'|'observationTransform'>> & {displayDocument?:ReadonlyViewportDisplayDocument;exportDocument?:ModelDocument;exportSourceIdentity?:string;projectionSerial?:number;frameBondEditing?:FrameBondEditingState;frameBondTarget?:FrameBondTarget;cipGraph?:CipGraph|null};
type CipGraph=Pick<NonNullable<ModelViewportProps['cipStructure']>,'bonds'|'bondSource'|'bondPerceptionIssues'>;
export interface ReadonlyViewportDisplayDocument { sourceDocumentId:string; sourceRevision:number; document:ModelDocument }
export interface ViewportDisplayProjection { documentId:string; revision:number; sourceId:string; sourceRevision:string; sourceKey:string; viewport:DisplayProperties;displayDocument?:ReadonlyViewportDisplayDocument;exportDocument?:ModelDocument;exportSourceIdentity?:string;frameBondEditing?:FrameBondEditingState;cipGraph?:CipGraph|null }
export interface ViewportDisplayDescriptor { documentId:string; revision:number; sourceId:string; sourceRevision:string; sourceKey:string; projectionSerial:number;exportSourceIdentity?:string;frameBondEditing?:FrameBondEditingState;renderIdentity?:ViewportRenderIdentity }
export interface ViewportDisplayPort { onmessage:((event:{data:any})=>void)|null; postMessage(message:unknown):void; close():void }
interface SharedImageIdentity {documentRevision:number;projectionSerial?:number;sourceKey?:string}
interface SharedImageOptions {format:'png'|'svg';includeAnnotations:boolean;transparent?:boolean;width?:number;height?:number}
interface SharedImageCapture {blob:Blob;provenance:Record<string,unknown>}
function sharedImageOptions(value:unknown):SharedImageOptions{
  const input=value as Partial<SharedImageOptions>|null;
  if(!input||!['png','svg'].includes(String(input.format))||typeof input.includeAnnotations!=='boolean'
    ||input.transparent!==undefined&&typeof input.transparent!=='boolean'
    ||[input.width,input.height].some(size=>size!==undefined&&(!Number.isSafeInteger(size)||size<1)))
    throw new Error('独立视口图像选项无效。');
  const {format,includeAnnotations,transparent,width,height}=input;
  return {format:format!,includeAnnotations,transparent,width,height};
}
type SurfaceReference={layer:Omit<ViewportSurfaceLayer,'pair'>;pair:Record<string,unknown>;shapeKey:string;mappingKey:string|null};
type AmplitudeReference<T>={layer:Omit<T,'field'>;fieldKey:string};
type DisplayField=SurfaceScalarField|OrbitalField|NtoField;
type Metadata = { surfaces?:SurfaceReference[];surface?:SurfaceReference;orbital?:AmplitudeReference<ViewportOrbitalLayer>;nto?:AmplitudeReference<ViewportNtoLayer>;display:Omit<DisplayProperties,'surfaceLayer'|'surfaceLayers'|'orbitalLayer'|'ntoLayer'>; displayDocument?:ReadonlyViewportDisplayDocument;exportDocument?:ModelDocument;exportSourceIdentity?:string;frameBondEditing?:FrameBondEditingState;cipGraph?:CipGraph|null };
// Executable setters stay with the trusted owner and never enter a descriptor or packet.
const sceneObservers=new WeakMap<ViewportDisplayProjection,NonNullable<ModelViewportProps['onSceneSubmitted']>>();
const colorbarSetters=new WeakMap<ViewportDisplayProjection,NonNullable<ModelViewportProps['onResultColorbarLayoutChange']>>();
const surfaceObservers=new WeakMap<ViewportDisplayProjection,NonNullable<ModelViewportProps['onSurfaceMeshStates']>>();
const ntoObservers=new WeakMap<ViewportDisplayProjection,NonNullable<ModelViewportProps['onNtoMeshState']>>();
function checkedColorbarLayout(value:unknown):AnalysisColorbarLayout|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const record=value as Record<string,unknown>,{x,y,length}=record;
  const within=(candidate:unknown,min:number,max:number)=>typeof candidate==='number'&&Number.isFinite(candidate)&&candidate>=min&&candidate<=max;
  const limits=ANALYSIS_COLORBAR_LIMITS;
  if(Object.keys(record).some(key=>!['x','y','length','orientation','thickness','fontFamily','fontSize','ink','numberFormat'].includes(key))
    ||!within(x,0,1)||!within(y,0,1)||!within(length,limits.length.min,limits.length.max))return null;
  const layout=record as unknown as AnalysisColorbarLayout,format=layout.numberFormat;
  if(layout.orientation!==undefined&&layout.orientation!=='horizontal'&&layout.orientation!=='vertical'
    ||layout.thickness!==undefined&&!within(layout.thickness,limits.thickness.min,limits.thickness.max)
    ||layout.fontFamily!==undefined&&!Object.hasOwn(ANALYSIS_COLORBAR_FONTS,layout.fontFamily)
    ||layout.fontSize!==undefined&&!within(layout.fontSize,limits.fontSize.min,limits.fontSize.max)
    ||layout.ink!==undefined&&(typeof layout.ink!=='string'||!/^#[0-9a-f]{6}$/i.test(layout.ink))
    ||format!==undefined&&(!format||!['decimal','significant'].includes(format.mode)||!Number.isSafeInteger(format.digits)
      ||!within(format.digits,format.mode==='significant'?1:0,8)||Object.keys(format).some(key=>key!=='mode'&&key!=='digits')))return null;
  return layout;
}
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
const fieldKey=(field:DisplayField)=>JSON.stringify('orbitalKey' in field
  ? ['orbital',field.sessionId,field.sourceRevision,field.gridKey,field.orbitalKey]
  : 'side' in field?['nto',field.id,field.context,field.state,field.pairIndex,field.spin,field.side]
  : ['surface',field.id,field.source.id,field.source.revision,field.context]);
function surfaceReference({pair,...layer}:ViewportSurfaceLayer):SurfaceReference{
  const {shape,mapping,...style}=pair;
  return {layer,pair:style,shapeKey:fieldKey(shape),mappingKey:mapping?fieldKey(mapping):null};
}
function amplitudeReference<T extends ViewportOrbitalLayer|ViewportNtoLayer>(input:T):AmplitudeReference<T>{
  const {field,...layer}=input;
  return {layer,fieldKey:fieldKey(field)};
}
function metadata(projection:ViewportDisplayProjection):Metadata{
  const {surfaceLayer,surfaceLayers,orbitalLayer,ntoLayer,...display}=projection.viewport,{displayDocument:snapshot,exportDocument,exportSourceIdentity,frameBondEditing,cipGraph}=projection;
  const displayDocument=snapshot?{sourceDocumentId:snapshot.sourceDocumentId,sourceRevision:snapshot.sourceRevision,document:snapshot.document}:undefined;
  return {surface:surfaceLayer&&surfaceReference(surfaceLayer),surfaces:surfaceLayers?.map(surfaceReference),
    orbital:orbitalLayer&&amplitudeReference(orbitalLayer),nto:ntoLayer&&amplitudeReference(ntoLayer),
    display,frameBondEditing,cipGraph,...displayDocument?{displayDocument}:{},...exportDocument?{exportDocument,exportSourceIdentity}:{}};
}
function displayFields({surfaceLayer,surfaceLayers,orbitalLayer,ntoLayer}:DisplayProperties):Map<string,DisplayField>{
  const fields=new Map<string,DisplayField>();
  for(const layer of surfaceLayers??(surfaceLayer?[surfaceLayer]:[])){
    fields.set(fieldKey(layer.pair.shape),layer.pair.shape);
    if(layer.pair.mapping)fields.set(fieldKey(layer.pair.mapping),layer.pair.mapping);
  }
  const amplitude=ntoLayer??orbitalLayer;
  if(amplitude)fields.set(fieldKey(amplitude.field),amplitude.field);
  return fields;
}
export function viewportDisplaySignature(projection:ViewportDisplayProjection):string{return JSON.stringify([projection.documentId,projection.revision,projection.sourceId,projection.sourceRevision,projection.sourceKey,metadata(projection)]);}
function viewportDisplayProjection(document:ModelDocument,viewport:Partial<ModelViewportProps>,observedDocument?:ModelDocument,trusted=false,exportSource?:ModelDocument,exportSourceIdentity?:string,frameBondEditing?:FrameBondEditingState):ViewportDisplayProjection|null{
  let displayDocument:ReadonlyViewportDisplayDocument|undefined;
  if(observedDocument){
    const {id:sourceDocumentId,revision:sourceRevision}=observedDocument;
    if(trusted){
      let snapshot:ModelDocument|undefined;
      // A docked view already owns this frame; construct the detached snapshot
      // only when the shared window or structure capture actually consumes it.
      displayDocument={sourceDocumentId,sourceRevision,get document(){return snapshot??=readonlyDisplayDocument(observedDocument,document,true);}};
    }else displayDocument={sourceDocumentId,sourceRevision,document:readonlyDisplayDocument(observedDocument,document)};
  }
  const exported=exportSource?projectStructureExportDocument(document,exportSource.draft.structure):undefined;
  // The publisher already owns these immutable frame inputs. Validate only at
  // untrusted/wire admission; do not re-copy or re-prove a live frame every tick.
  const exportDocument=exported?(trusted?exported:normalizeWorkspaceDocumentJSON(exported)):undefined;
  if(exportDocument&&!trusted){readonlyDisplayDocument(exportDocument,document,true);const atoms=(displayDocument?.document??document).draft.structure.atoms;if(atoms.length!==exportDocument.draft.structure.atoms.length||atoms.some((atom,index)=>atom.id!==exportDocument.draft.structure.atoms[index].id||atom.element!==exportDocument.draft.structure.atoms[index].element))fail('结构导出快照与当前显示原子不一致。');}
  displayHiddenAtomIds(viewport.hiddenAtomIds,observedDocument?.draft.structure??document.draft.structure);
  const sourceDocument=observedDocument??document;
  const currentLayer=<T extends {visible:boolean;documentId:string;geometryRevision:number}>(layer:T|undefined):T|undefined=>
    layer?.visible&&layer.documentId===sourceDocument.id&&layer.geometryRevision===sourceDocument.revision
      ? {...layer,documentId:document.id,geometryRevision:document.revision}:undefined;
  const surfaceLayer=viewport.surfaceLayers===undefined?currentLayer(viewport.surfaceLayer):undefined;
  const surfaceLayers=viewport.surfaceLayers?.flatMap(layer=>currentLayer(layer)??[]);
  const orbitalLayer=viewport.ntoLayer===undefined?currentLayer(viewport.orbitalLayer):undefined;
  const ntoLayer=currentLayer(viewport.ntoLayer);
  const surfaceExtrema=currentLayer(viewport.surfaceExtrema??undefined);
  const cip=viewport.cipStructure?cipStructureForDisplay(sourceDocument.draft.structure,viewport.cipStructure):undefined;
  const cipGraph=viewport.cipStructure===undefined?undefined:cip?.bonds?{bonds:cip.bonds,bondSource:cip.bondSource,bondPerceptionIssues:cip.bondPerceptionIssues}:null;
  if(viewport.multiframeDisplay)validateMultiframeDisplayPlan(viewport.multiframeDisplay);
  if(viewport.samplingSphere)validateSamplingSphereDisplay(viewport.samplingSphere);
  if(viewport.calculationRanges)viewport.calculationRanges.forEach(validateCalculationRange);
  const fixedCellView=viewport.fixedCellView===true||undefined;
  const viewTransform=fixedCellView||viewport.viewTransform===undefined?undefined:checkedRigidTransform(viewport.viewTransform);
  const display:DisplayProperties={surfaceLayer,surfaceLayers,orbitalLayer,ntoLayer,surfaceExtrema,viewTransform,fixedCellView,hiddenAtomIds:viewport.hiddenAtomIds,
    multiframeDisplay:viewport.multiframeDisplay,samplingSphere:viewport.samplingSphere,calculationRanges:viewport.calculationRanges,
    vibrationVectors:viewport.vibrationVectors,dipoleVector:viewport.dipoleVector,atomScalarValues:viewport.atomScalarValues,atomScalarColor:viewport.atomScalarColor,atomScalarLabels:viewport.atomScalarLabels,
    resultAtomLabels:viewport.resultAtomLabels,resultBondValues:viewport.resultBondValues,resultBondLabels:viewport.resultBondLabels,resultBondColor:viewport.resultBondColor,
    resultHighlights:viewport.resultHighlights,resultColorbar:viewport.resultColorbar,resultColorbarOwnerKey:viewport.resultColorbarOwnerKey,renderIdentity:viewport.renderIdentity?.requestId?viewport.renderIdentity:undefined};
  if(!Object.values(display).some(value=>value!==undefined)&&!displayDocument&&!exportDocument&&cipGraph===undefined)return null;
  const context=(surfaceLayer??surfaceLayers?.[0])?.pair.shape.context??ntoLayer?.field.context;
  const projection:ViewportDisplayProjection={documentId:document.id,revision:document.revision,sourceId:context?.sourceId??displayDocument?.sourceDocumentId??document.id,
    sourceRevision:context?.sourceRevision??orbitalLayer?.field.sourceRevision??String(displayDocument?.sourceRevision??document.revision),
    sourceKey:JSON.stringify([context??['display',document.id,document.revision,displayDocument?.sourceDocumentId,displayDocument?.sourceRevision],[...displayFields(display).keys()],viewport.resultColorbarOwnerKey??null,viewport.multiframeDisplay?.key,viewport.multiframeDisplay?.activeFrameKey,fixedCellView,viewport.samplingSphere,viewport.calculationRanges]),
    displayDocument,exportDocument,exportSourceIdentity,cipGraph,frameBondEditing:frameBondEditing?checkedFrameBondEditing(frameBondEditing):undefined,viewport:display};
  if(viewport.onSceneSubmitted&&projection.viewport.renderIdentity)sceneObservers.set(projection,viewport.onSceneSubmitted);
  if(viewport.onResultColorbarLayoutChange&&viewport.resultColorbarOwnerKey)colorbarSetters.set(projection,viewport.onResultColorbarLayoutChange);
  if(viewport.onSurfaceMeshStates&&surfaceLayers?.length)surfaceObservers.set(projection,viewport.onSurfaceMeshStates);
  if(viewport.onNtoMeshState&&ntoLayer)ntoObservers.set(projection,viewport.onNtoMeshState);
  return projection;
}
export function createViewportDisplayProjection(document:ModelDocument,viewport:Partial<ModelViewportProps>,observedDocument?:ModelDocument,exportDocument?:ModelDocument,exportSourceIdentity?:string,frameBondEditing?:FrameBondEditingState):ViewportDisplayProjection|null{
  return viewportDisplayProjection(document,viewport,observedDocument,false,exportDocument,exportSourceIdentity,frameBondEditing);
}
/** Owner-renderer path only: inputs are already validated immutable Store or
 * prepared scientific snapshots. Sending/receiving still uses wire admission. */
export function createTrustedViewportDisplayProjection(document:ModelDocument,viewport:Partial<ModelViewportProps>,observedDocument?:ModelDocument,exportDocument?:ModelDocument,exportSourceIdentity?:string,frameBondEditing?:FrameBondEditingState):ViewportDisplayProjection|null{
  return viewportDisplayProjection(document,viewport,observedDocument,true,exportDocument,exportSourceIdentity,frameBondEditing);
}
function fieldPointCount(field:DisplayField):number{
  const dimensions=field?.grid?.dimensions;
  const count=Array.isArray(dimensions)&&dimensions.length===3&&dimensions.every(n=>Number.isSafeInteger(n)&&n>0)?dimensions.reduce((n,value)=>n*value,1):0;
  if(!Number.isSafeInteger(count)||count<1||count>CUBE_READ_LIMITS.points||!Number.isSafeInteger(count*8)||count*8>CUBE_READ_LIMITS.bytes)fail('独立显示格点超出现有Cube预算。');
  return count;
}
function checkField(field:DisplayField,descriptor:ViewportDisplayDescriptor){
  const count=fieldPointCount(field);
  if(!(field.values instanceof Float64Array)||field.values.length!==count)fail('独立显示格点超出现有Cube预算。');
  if('orbitalKey' in field){
    const {grid}=field,vec=(value:unknown)=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);
    if(!field.sessionId||!field.sourceRevision||!field.gridKey||!field.orbitalKey||field.valueUnit!=='bohr^-3/2'||grid.coordinateUnit!=='bohr'||grid.ordering!=='z-fastest'||!vec(grid.origin)||
      !Array.isArray(grid.axes)||grid.axes.length!==3||!grid.axes.every(vec)||!field.values.every(Number.isFinite))fail('独立显示轨道格点身份、坐标或数值无效。');
  }else{
    if(!Array.isArray(field.atoms)||field.atoms.length>CUBE_READ_LIMITS.atoms)fail('独立显示格点超出现有Cube预算。');
    if('side' in field)validateNtoField(field);else validateSurfaceScalarField(field);
    if(field.context.sourceId!==descriptor.sourceId||field.context.sourceRevision!==descriptor.sourceRevision)fail('独立显示格点来源不一致。');
  }
}
const maskOf=(field:DisplayField)=>'validDomain' in field&&field.validDomain.kind==='node-mask'?field.validDomain.mask:undefined;
interface PackedDisplayBytes { binaryAsset:{id:string;bytesLength:number};encoding:'float64-le'|'uint8' }
function packDisplayFields(fields:ReadonlyMap<string,DisplayField>,assets:Map<string,Uint8Array>){
  return [...fields.values()].map((field,index)=>{
    const pack=(value:Float64Array|Uint8Array,encoding:PackedDisplayBytes['encoding']):PackedDisplayBytes=>{
      const id=`${index}:${encoding}`,bytesLength=value.byteLength;
      assets.set(id,new Uint8Array(value.buffer,value.byteOffset,bytesLength));
      return {binaryAsset:{id,bytesLength},encoding};
    };
    const mask=maskOf(field);
    return {...field,values:pack(field.values,'float64-le'),...(mask&&'validDomain' in field?{validDomain:{...field.validDomain,mask:pack(mask,'uint8')}}:{})};
  });
}
function fieldReferences(small:Metadata):Set<string>{
  const keys=new Set<string>();
  for(const surface of small.surfaces??(small.surface?[small.surface]:[])){
    keys.add(surface.shapeKey);if(surface.mappingKey)keys.add(surface.mappingKey);
  }
  const amplitude=small.nto??small.orbital;if(amplitude)keys.add(amplitude.fieldKey);
  return keys;
}
function checkedPackedFields(raw:unknown,keys:ReadonlySet<string>){
  if(!Array.isArray(raw)||!raw.length||raw.length!==keys.size)fail('独立显示格点数量或身份不一致。');
  const fields=normalizeViewportDisplayMetadataJSON(raw) as DisplayField[];
  const remaining=new Set(keys),assets=new Set<string>();
  for(const field of fields){
    const count=fieldPointCount(field);
    if(!remaining.delete(fieldKey(field)))fail('独立显示拒绝非当前格点缓存。');
    const check=(value:unknown,encoding:PackedDisplayBytes['encoding'],bytes:number)=>{
      const packed=value as PackedDisplayBytes,id=packed?.binaryAsset?.id;
      if(typeof id!=='string'||!id||assets.has(id)||packed.encoding!==encoding||packed.binaryAsset.bytesLength!==bytes)fail('独立显示格点分页类型或长度无效。');
      assets.add(id);
    };
    check(field.values,'float64-le',count*8);
    if('validDomain' in field&&field.validDomain.kind==='node-mask')check(field.validDomain.mask,'uint8',count);
  }
  return fields;
}
export function projectedCipStructure(document:ModelDocument,cipGraph:CipGraph|null|undefined):ModelViewportProps['cipStructure']{
  if(!cipGraph)return cipGraph;
  const base=document.draft.structure;
  if(!Array.isArray(cipGraph.bonds)||cipGraph.bonds.some(bond=>![bond.a,bond.b].every(index=>Number.isSafeInteger(index)&&index>=0&&index<base.atoms.length)))
    return null;
  const {bonds,bondSource,bondPerceptionIssues}=cipGraph;
  return {...base,bonds,bondSource,bondPerceptionIssues};
}
function checkedMetadata(raw:Metadata,descriptor:ViewportDisplayDescriptor):Metadata{
  const value=normalizeViewportDisplayMetadataJSON(raw);
  if(value.frameBondEditing)checkedFrameBondEditing(value.frameBondEditing);
  if(JSON.stringify(value.frameBondEditing)!==JSON.stringify(descriptor.frameBondEditing))fail('帧显示键编辑能力与可信投影身份不匹配。');
  const validLayer=(layer:{documentId:string;geometryRevision:number;visible:boolean}|undefined)=>layer?.documentId===descriptor.documentId&&layer.geometryRevision===descriptor.revision&&layer.visible===true;
  if(!value.display||value.surfaces!==undefined&&(!Array.isArray(value.surfaces)||value.surface!==undefined)||value.nto&&value.orbital)fail('独立显示元数据无效。');
  for(const surface of value.surfaces??(value.surface?[value.surface]:[])){
    if(!validLayer(surface.layer)||typeof surface.shapeKey!=='string'||surface.mappingKey!==null&&typeof surface.mappingKey!=='string'||!surface.pair||
      !Number.isFinite(surface.pair.isovalue))fail('独立显示表面元数据无效。');
  }
  const amplitude=value.nto??value.orbital;
  if(amplitude&&(!validLayer(amplitude.layer)||typeof amplitude.fieldKey!=='string'||!Number.isFinite(amplitude.layer.isovalue)||amplitude.layer.isovalue<=0))fail('独立显示轨道元数据无效。');
  if(value.display.surfaceExtrema&&!validLayer(value.display.surfaceExtrema))fail('独立显示极值点来自其他几何。');
  if(value.displayDocument){const data=value.displayDocument;if(typeof data.sourceDocumentId!=='string'||!data.sourceDocumentId||!Number.isSafeInteger(data.sourceRevision)||data.sourceRevision<0||data.document?.id!==descriptor.documentId||data.document.revision!==descriptor.revision)fail('只读显示快照与已认证容器身份不匹配。');
    const checked=readonlyDisplayDocument(data.document,{id:descriptor.documentId,revision:descriptor.revision},true);if(JSON.stringify(data.document)!==JSON.stringify(checked))fail('只读显示快照包含非显示状态、历史或非空选区。');}
  if(value.exportDocument){const data=value.exportDocument;if(data.id!==descriptor.documentId||data.revision!==descriptor.revision)fail('结构导出快照与已认证容器身份不匹配。');
    const checked=readonlyDisplayDocument(data,{id:descriptor.documentId,revision:descriptor.revision},true);if(JSON.stringify(data)!==JSON.stringify(projectStructureExportDocument(checked)))fail('结构导出快照包含非显示状态、历史或非空选区。');
    const atoms=value.displayDocument?.document.draft.structure.atoms;if(atoms&&(atoms.length!==data.draft.structure.atoms.length||atoms.some((atom,index)=>atom.id!==data.draft.structure.atoms[index].id||atom.element!==data.draft.structure.atoms[index].element)))fail('结构导出快照与当前显示原子不一致。');}
  if(value.exportSourceIdentity!==undefined&&(typeof value.exportSourceIdentity!=='string'||!value.exportSourceIdentity))fail('结构导出来源身份无效。');
  if(value.display.multiframeDisplay)validateMultiframeDisplayPlan(value.display.multiframeDisplay);
  if(value.displayDocument&&value.display.multiframeDisplay){const plan=value.display.multiframeDisplay,frame=plan.frames.find(frame=>frame.key===plan.activeFrameKey)!,atoms=value.displayDocument.document.draft.structure.atoms,byId=new Map(frame.structure.atoms.map(a=>[a.id,a]));
    if(atoms.length!==byId.size||atoms.some(a=>{const b=byId.get(a.id);return!b||a.element!==b.element||a.x!==b.x||a.y!==b.y||a.z!==b.z;}))fail('只读显示结构与叠合当前源帧不一致，未按容器原子猜测对应。');}
  if(value.display.samplingSphere)validateSamplingSphereDisplay(value.display.samplingSphere);
  if(value.display.calculationRanges){if(!Array.isArray(value.display.calculationRanges))fail('独立显示计算范围格式无效。');value.display.calculationRanges.forEach(validateCalculationRange);}
  if(value.display.viewTransform!==undefined)checkedRigidTransform(value.display.viewTransform);
  if(value.display.fixedCellView!==undefined&&typeof value.display.fixedCellView!=='boolean')fail('固定晶胞显示标记无效。');
  const identity=value.display.renderIdentity;
  if(identity!==undefined&&(typeof identity.sourceId!=='string'||!identity.sourceId||typeof identity.sourceRevision!=='string'||
      !Number.isSafeInteger(identity.frameIndex)||identity.frameIndex<0||
      (identity.jobIndex!=null&&(!Number.isSafeInteger(identity.jobIndex)||identity.jobIndex<0))||
      (identity.generation!==undefined&&!Number.isSafeInteger(identity.generation))||typeof identity.requestId!=='string'||!identity.requestId))
    fail('独立显示轨迹请求身份无效。');
  displayHiddenAtomIds(value.display.hiddenAtomIds,value.displayDocument?.document.draft.structure);
  return value;
}
const matches=(a:ViewportDisplayDescriptor,b:ViewportDisplayDescriptor)=>a.documentId===b.documentId&&a.revision===b.revision&&a.sourceId===b.sourceId&&a.sourceRevision===b.sourceRevision&&a.sourceKey===b.sourceKey&&a.exportSourceIdentity===b.exportSourceIdentity;
function validMeshState(state:SurfaceMeshState|undefined):state is SurfaceMeshState{
  return !!state&&['empty','pending','committed','failed'].includes(state.status)&&
    [state.shapeCount,state.vertexCount,state.triangleCount].every(count=>Number.isSafeInteger(count)&&count>=0)&&typeof state.submitted==='boolean';
}
function matchingSurfaceMesh(state:SurfaceMeshState,layer:ViewportSurfaceLayer):boolean{
  const {shape,mapping}=layer.pair;
  return state.sourceId===shape.context.sourceId&&state.sourceRevision===shape.context.sourceRevision&&state.shapeId===shape.id&&(state.mappingId??null)===(mapping?.id??null);
}
/** The caller creates this endpoint only after the existing host has
 * authenticated doc/membershipNonce and identified the actual detached member.
 * This channel name alone never grants access. At most one packet is in flight. */
export function createViewportDisplayOwner(options:{port:ViewportDisplayPort;documentId:string;token:string;onMesh(state:Readonly<SurfaceMeshState>,document:Pick<ModelDocument,'id'|'revision'>):void;onError(message:string):void}){
  let disposed=false,active=false,current:ViewportDisplayProjection|null=null,serial=0,inflight=0,sentKey:string|null=null,validatedKey:string|null=null,requestPending=false,requireFields=false,submittedSerial=0;
  const pageAssets=new Map<string,Uint8Array>();
  let image:{id:string;identity:SharedImageIdentity;format:SharedImageOptions['format'];settle(error:unknown,result?:SharedImageCapture):void}|undefined;
  const post=(payload:Record<string,unknown>)=>options.port.postMessage({...payload,token:options.token,documentId:options.documentId});
  const descriptor=():ViewportDisplayDescriptor|null=>current?{documentId:current.documentId,revision:current.revision,sourceId:current.sourceId,sourceRevision:current.sourceRevision,sourceKey:current.sourceKey,projectionSerial:serial,exportSourceIdentity:current.exportSourceIdentity,frameBondEditing:current.frameBondEditing,renderIdentity:current.viewport.renderIdentity}:null;
  function send(){
    if(disposed||!active||inflight)return;
    const description=descriptor();
    if(!description||!current){sentKey=null;options.port.postMessage({kind:'clear',token:options.token,documentId:options.documentId,serial});return;}
    try{
      const small=checkedMetadata(metadata(current),description);
      const fields=sentKey===current.sourceKey?new Map<string,DisplayField>():displayFields(current.viewport);
      if(validatedKey!==current.sourceKey){for(const field of fields.values())checkField(field,description);validatedKey=current.sourceKey;}
      pageAssets.clear();
      const bytes=[...fields.values()].reduce((sum,field)=>sum+field.values.byteLength+(maskOf(field)?.byteLength??0),0);
      const payload=bytes>CUBE_PAGE_BYTES?{pagedFields:packDisplayFields(fields,pageAssets)}:fields.size?{fields:[...fields.values()]}:{};
      inflight=serial;sentKey=current.sourceKey;
      options.port.postMessage({kind:'projection',token:options.token,descriptor:description,metadata:small,...payload});
    }catch(error){inflight=0;sentKey=null;pageAssets.clear();options.onError(error instanceof Error?error.message:String(error));}
  }
  options.port.onmessage=({data})=>{
    if(disposed||!data||data.token!==options.token||data.documentId!==options.documentId)return;
    if(data.kind==='request'){active=true;requireFields||=data.haveSourceKey!==current?.sourceKey;if(inflight){requestPending=true;return;}if(requireFields)sentKey=null;requireFields=false;send();}
    else if(data.kind==='pause'){active=false;inflight=0;sentKey=null;requestPending=false;requireFields=false;pageAssets.clear();image?.settle(new Error('独立视口已暂停或关闭。'));}
    else if(data.kind==='image-capture-result'&&active&&image&&data.id===image.id){
      const own=image;
      if(data.documentRevision!==own.identity.documentRevision||data.projectionSerial!==own.identity.projectionSerial||data.sourceKey!==own.identity.sourceKey
        ||own.identity.projectionSerial!==undefined&&(!current||serial!==own.identity.projectionSerial||current.sourceKey!==own.identity.sourceKey)){
        own.settle(new Error('独立视口来源在图像捕获期间已变化。'));return;
      }
      if(typeof data.error==='string'){own.settle(new Error(data.error));return;}
      const mime=own.format==='png'?'image/png':'image/svg+xml';
      if(!(data.blob instanceof Blob)||data.blob.type!==mime||!data.blob.size||!data.provenance||typeof data.provenance!=='object'||Array.isArray(data.provenance)){
        own.settle(new Error('独立视口未返回可验证的图像。'));return;
      }
      own.settle(null,{blob:data.blob,provenance:data.provenance});
    }
    else if(data.kind==='ack'&&data.serial===inflight){inflight=0;pageAssets.clear();if(requireFields||data.needFields===true)sentKey=null;requireFields=false;if(requestPending||data.serial!==serial){requestPending=false;send();}}
    else if(data.kind==='read-field-page'&&active&&data.serial===inflight){
      const {id,offset,length}=data,asset=pageAssets.get(id);
      if(asset&&Number.isSafeInteger(offset)&&offset>=0&&offset%CUBE_PAGE_BYTES===0&&offset<asset.byteLength&&length===Math.min(CUBE_PAGE_BYTES,asset.byteLength-offset))
        options.port.postMessage({kind:'field-page',token:options.token,documentId:options.documentId,serial:inflight,id,offset,bytes:asset.slice(offset,offset+length).buffer});
    }
    else if(data.kind==='scene-submitted'&&active&&data.serial===serial&&submittedSerial!==serial&&current&&data.sourceKey===current.sourceKey&&data.revision===current.revision){
      const identity=current.viewport.renderIdentity;
      if(identity?.requestId&&sameViewportRenderIdentity(identity,data.identity)){
        submittedSerial=serial;
        try{sceneObservers.get(current)?.(identity);}catch(error){options.onError(error instanceof Error?error.message:String(error));}
      }
    }
    else if(data.kind==='colorbar-layout'&&active&&data.serial===serial&&current&&data.sourceKey===current.sourceKey&&data.revision===current.revision&&data.ownerKey===current.viewport.resultColorbarOwnerKey&&typeof data.ownerKey==='string'){
      const layout=checkedColorbarLayout(data.layout),setter=colorbarSetters.get(current);
      if(layout&&setter)try{setter(layout);}catch(error){options.onError(error instanceof Error?error.message:String(error));}
    }
    else if(active&&data.serial===serial&&current&&data.sourceKey===current.sourceKey&&data.revision===current.revision){
      const {surfaceLayer,surfaceLayers,ntoLayer}=current.viewport,source=current.displayDocument;
      const actual={id:source?.sourceDocumentId??current.documentId,revision:source?.sourceRevision??current.revision};
      if(data.kind==='mesh'&&surfaceLayer&&validMeshState(data.state)&&matchingSurfaceMesh(data.state,surfaceLayer))
        options.onMesh(data.state,actual);
      if(data.kind==='meshes'&&surfaceLayers&&Array.isArray(data.states)&&data.states.length===surfaceLayers.length){
        const states=data.states as SurfaceLayerMeshState[];
        if(surfaceLayers.every(layer=>states.some(state=>validMeshState(state)&&state.layerId===layer.id&&matchingSurfaceMesh(state,layer))))
          surfaceObservers.get(current)?.(states,actual);
      }
      if(data.kind==='nto-mesh'&&ntoLayer&&validMeshState(data.state)){
        const state=data.state as NtoMeshState,field=ntoLayer.field;
        if(state.fieldId===field.id&&state.sourceId===field.context.sourceId&&state.sourceRevision===field.context.sourceRevision)
          ntoObservers.get(current)?.(state,actual);
      }
    }
  };
  return {publish(projection:ViewportDisplayProjection|null,projectionSerial:number){if(disposed||projectionSerial<serial||projectionSerial===serial&&projection===current)return;if(projectionSerial===serial){if(projection&&current&&viewportDisplaySignature(projection)===viewportDisplaySignature(current))current=projection;return;}current=projection;serial=projectionSerial;send();},
    captureImage(value:ViewportImageExportOptions,signal:AbortSignal,requested:{documentRevision:number}):Promise<SharedImageCapture>{
      signal.throwIfAborted();
      if(disposed||!active||current&&current.revision!==requested.documentRevision)throw new Error('当前独立视口尚未连接到此模型版本。');
      if(image)throw new Error('当前独立视口正在捕获图像。');
      const captureOptions=sharedImageOptions(value),id=crypto.randomUUID();
      const identity={documentRevision:requested.documentRevision,projectionSerial:current?serial:undefined,sourceKey:current?.sourceKey};
      return new Promise((resolve,reject)=>{
        const stop=()=>{post({kind:'image-capture-cancel',id});image?.settle(signal.reason);};
        const settle=(error:unknown,result?:SharedImageCapture)=>{if(image?.id===id)image=undefined;signal.removeEventListener('abort',stop);result?resolve(result):reject(error);};
        image={id,identity,format:captureOptions.format,settle};signal.addEventListener('abort',stop,{once:true});
        try{post({kind:'image-capture',id,...identity,options:captureOptions});}catch(error){settle(error);}
      });
    },
    close(){if(disposed)return;post({kind:'clear',serial:serial+1});image?.settle(new Error('独立视口已关闭。'));disposed=true;active=false;current=null;pageAssets.clear();options.port.onmessage=null;options.port.close();}};
}
/** One read-only renderer cache. Authorization is completed by the existing
 * host command receipt before request() is called. No compute API is exposed. */
export function createViewportDisplayConsumer(options:{port:ViewportDisplayPort;token:string;expected:ViewportDisplayDescriptor;onProjection(viewport:ProjectedDisplayProperties|null):void;onError(message:string):void;
  captureImage?(options:ViewportImageExportOptions,signal:AbortSignal,identity:SharedImageIdentity):Promise<SharedImageCapture>}){
  let disposed=false,authorized=false,expected=options.expected,accepted=0,acceptedOwnerKey:string|undefined,cache=new Map<string,DisplayField>();
  let acceptedIdentity:ViewportRenderIdentity|undefined, submittedSerial=0;
  let receiving:AbortController|undefined;
  let pendingPage:{serial:number;id:string;offset:number;finish:(bytes?:ArrayBuffer)=>void}|undefined;
  let image:{id:string;controller:AbortController}|undefined;
  const post=(value:Record<string,unknown>)=>options.port.postMessage({...value,token:options.token,documentId:expected.documentId});
  function request(){if(authorized&&!disposed)post({kind:'request',haveSourceKey:cache.size?expected.sourceKey:null});}
  function meshDocumentCurrent(document:Pick<ModelDocument,'id'|'revision'>){
    return !disposed&&authorized&&document.id===expected.documentId&&document.revision===expected.revision;
  }
  function acceptFields(fields:unknown,description:ViewportDisplayDescriptor,keys:ReadonlySet<string>){
    if(!Array.isArray(fields)||!fields.length||fields.length!==keys.size)fail('独立显示格点数量或身份不一致。');
    const next=new Map<string,DisplayField>();
    for(const field of fields as DisplayField[]){
      checkField(field,description);
      const key=fieldKey(field);
      if(!keys.has(key)||next.has(key))fail('独立显示拒绝非当前格点缓存。');
      next.set(key,field);
    }
    cache=next;
  }
  function apply(small:Metadata,description:ViewportDisplayDescriptor){
    function getField(key:string,type:'surface'|'orbital'|'nto'){
      const field=cache.get(key);
      if(!field||('orbitalKey' in field?'orbital':'side' in field?'nto':'surface')!==type) return fail('独立显示格点尚未收到，未显示其他来源。');
      return field;
    }
    const surface=(ref:SurfaceReference):ViewportSurfaceLayer=>({...ref.layer,pair:{...ref.pair,shape:getField(ref.shapeKey,'surface'),mapping:ref.mappingKey?getField(ref.mappingKey,'surface'):null}} as ViewportSurfaceLayer);
    const orbitalLayer=small.orbital?{...small.orbital.layer,field:getField(small.orbital.fieldKey,'orbital') as OrbitalField}:undefined;
    const ntoLayer=small.nto?{...small.nto.layer,field:getField(small.nto.fieldKey,'nto') as NtoField}:undefined;
    accepted=description.projectionSerial;acceptedIdentity=small.display.renderIdentity;acceptedOwnerKey=small.display.resultColorbarOwnerKey;
    options.onProjection({...small.display,surfaceLayer:small.surface&&surface(small.surface),surfaceLayers:small.surfaces?.map(surface),orbitalLayer,ntoLayer,cipGraph:small.cipGraph,
      displayDocument:small.displayDocument,exportDocument:small.exportDocument,exportSourceIdentity:small.exportSourceIdentity,frameBondEditing:small.frameBondEditing,projectionSerial:description.projectionSerial,
      frameBondTarget:small.frameBondEditing?{frameKey:small.frameBondEditing.frameKey,projectionSerial:description.projectionSerial}:undefined,
      ...small.display.viewTransform||small.displayDocument?{observationReference:undefined,observationEpoch:undefined,observationFrame:undefined,observationFixedFrame:undefined,observationAnchorAtomIds:undefined,observationTransform:undefined}:{}});
  }
  function report(error:unknown){
    cache.clear();acceptedIdentity=undefined;acceptedOwnerKey=undefined;options.onProjection(null);options.onError(error instanceof Error?error.message:String(error));
  }
  function receivePages(fields:DisplayField[],small:Metadata,description:ViewportDisplayDescriptor,keys:ReadonlySet<string>){
    const own=new AbortController(),serial=description.projectionSerial;
    receiving=own;
    void materializeCubeFields(fields,{
      readBinaryAsset:(id,offset,length)=>new Promise((resolve,reject)=>{
        const finish=(bytes?:ArrayBuffer)=>{
          pendingPage=undefined;own.signal.removeEventListener('abort',abort);
          if(bytes instanceof ArrayBuffer&&bytes.byteLength===length)resolve(bytes);
          else reject(new Error('完整精度格点分页回执长度不符。'));
        };
        const abort=()=>finish();
        if(own.signal.aborted){abort();return;}
        pendingPage={serial,id,offset,finish};own.signal.addEventListener('abort',abort,{once:true});
        post({kind:'read-field-page',serial,id,offset,length});
      }),
      releaseBinaryAsset:async()=>{},
    },own.signal).then(result=>{
      if(disposed||own.signal.aborted||!matches(description,expected)||serial<expected.projectionSerial)return;
      acceptFields(result,description,keys);apply(small,description);
    }).catch(error=>{if(!disposed&&!own.signal.aborted)report(error);}).finally(()=>{
      if(receiving===own)receiving=undefined;
      if(!disposed)post({kind:'ack',serial,needFields:!cache.size});
    });
  }
  options.port.onmessage=({data})=>{
    if(disposed||!authorized||!data||data.token!==options.token)return;
    if(data.kind==='image-capture-cancel'&&data.documentId===expected.documentId&&image?.id===data.id){image?.controller.abort();return;}
    if(data.kind==='image-capture'&&data.documentId===expected.documentId&&typeof data.id==='string'){
      const {id,documentRevision,projectionSerial,sourceKey}=data,identity={documentRevision,projectionSerial,sourceKey};
      const reply=(payload:Record<string,unknown>)=>post({kind:'image-capture-result',id,...identity,...payload});
      if(image||!options.captureImage||documentRevision!==expected.revision
        ||projectionSerial!==undefined&&(projectionSerial!==accepted||projectionSerial!==expected.projectionSerial||sourceKey!==expected.sourceKey)){
        reply({error:'当前独立视口尚未显示指定来源，或已有图像捕获。'});return;
      }
      const controller=new AbortController();image={id,controller};
      void Promise.resolve().then(()=>options.captureImage!(sharedImageOptions(data.options),controller.signal,identity)).then(result=>{
        if(!disposed&&!controller.signal.aborted)reply(result as unknown as Record<string,unknown>);
      }).catch(error=>{if(!disposed&&!controller.signal.aborted)reply({error:error instanceof Error?error.message:String(error)});})
        .finally(()=>{if(image?.id===id)image=undefined;});
      return;
    }
    if(data.kind==='clear'&&data.documentId===expected.documentId&&data.serial>=Math.max(accepted,expected.projectionSerial)){receiving?.abort();accepted=data.serial;acceptedIdentity=undefined;acceptedOwnerKey=undefined;cache.clear();options.onProjection(null);return;}
    if(data.kind==='field-page'&&data.documentId===expected.documentId){
      const page=pendingPage;
      if(page&&page.serial===data.serial&&page.id===data.id&&page.offset===data.offset)page.finish(data.bytes);
      return;
    }
    if(data.kind!=='projection')return;
    const description=data.descriptor as ViewportDisplayDescriptor;
    if(!description||!Number.isSafeInteger(description.projectionSerial)||description.projectionSerial<=accepted||description.projectionSerial<expected.projectionSerial||!matches(description,expected)){if(description?.projectionSerial)post({kind:'ack',serial:description.projectionSerial,needFields:cache.size===0});return;}
    try{
      const small=checkedMetadata(data.metadata,description),keys=fieldReferences(small);
      if(data.pagedFields!==undefined){
        if(data.fields!==undefined||receiving)fail('独立显示重复发送格点。');
        receivePages(checkedPackedFields(data.pagedFields,keys),small,description,keys);
        return;
      }
      if(data.fields!==undefined){
        acceptFields(data.fields,description,keys);
        if([...cache.values()].reduce((sum,field)=>sum+field.values.byteLength+(maskOf(field)?.byteLength??0),0)>CUBE_PAGE_BYTES)fail('完整精度格点须分段传输。');
      }
      apply(small,description);
    }catch(error){report(error);}
    if(!receiving)post({kind:'ack',serial:description.projectionSerial});
  };
  return {authorize(){authorized=true;request();},expect(next:ViewportDisplayDescriptor){if(!matches(expected,next)){receiving?.abort();cache.clear();accepted=0;acceptedIdentity=undefined;acceptedOwnerKey=undefined;options.onProjection(null);}expected=next;request();},colorbarLayout(value:AnalysisColorbarLayout){const layout=checkedColorbarLayout(value);if(disposed||!authorized||!layout||!acceptedOwnerKey||accepted!==expected.projectionSerial)return false;post({kind:'colorbar-layout',serial:accepted,sourceKey:expected.sourceKey,revision:expected.revision,ownerKey:acceptedOwnerKey,layout});return true;},
    sceneSubmitted(identity:ViewportRenderIdentity){
      if(!disposed&&authorized&&accepted>=expected.projectionSerial&&accepted!==submittedSerial&&acceptedIdentity?.requestId&&sameViewportRenderIdentity(acceptedIdentity,identity)){
        submittedSerial=accepted;post({kind:'scene-submitted',serial:accepted,sourceKey:expected.sourceKey,revision:expected.revision,identity});
      }
    },mesh(state:Readonly<SurfaceMeshState>,document:Pick<ModelDocument,'id'|'revision'>){if(meshDocumentCurrent(document))post({kind:'mesh',serial:accepted,sourceKey:expected.sourceKey,revision:document.revision,state});},
    meshes(states:readonly SurfaceLayerMeshState[],document:Pick<ModelDocument,'id'|'revision'>){if(meshDocumentCurrent(document))post({kind:'meshes',serial:accepted,sourceKey:expected.sourceKey,revision:document.revision,states});},
    ntoMesh(state:Readonly<NtoMeshState>,document:Pick<ModelDocument,'id'|'revision'>){if(meshDocumentCurrent(document))post({kind:'nto-mesh',serial:accepted,sourceKey:expected.sourceKey,revision:document.revision,state});},
    close(){if(disposed)return;if(authorized)post({kind:'pause'});disposed=true;image?.controller.abort();receiving?.abort();acceptedOwnerKey=undefined;cache.clear();options.onProjection(null);options.port.onmessage=null;options.port.close();}};
}
export type ViewportDisplayOwner=ReturnType<typeof createViewportDisplayOwner>;
export type ViewportDisplayConsumer=ReturnType<typeof createViewportDisplayConsumer>;
