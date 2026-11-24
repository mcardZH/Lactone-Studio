import type { Vector3, Structure } from '../../core/types';
import { elementSymbol } from '../../core/elements';
import { BUILDER_TEMPLATES } from '../../core/builder-templates';
import { defaultElementPresetId, getElementPreset } from '../../core/modeling/element-presets';
import { createModelStore, getFrozenAtomIds } from '../../core/modeling/model-store';
import { referenceKey } from '../../core/modeling/graph';
import { editBuilderGeometryBalanced, type GeometrySideMode } from '../../core/builder-geometry';
import { createCopiedFragmentSeed } from '../../core/modeling/copied-fragment';
import { newModelId } from '../../core/modeling/hydrogen-policy';
import type { CellEditorRequest } from '../../core/modeling/cell-editor';
import type { StructureTransformEdit } from '../../core/modeling/structure-transform';
import type { BondOrder, ClipboardPayload, DisplaySettings, FragmentSnapshot, ModelCommand, ModelDocument, ModelSelection } from '../../modeling/contracts';
import type { CrystalParameters } from '../../modeling/crystal-contracts';
import { expandAtomSelectionByBonds, parseAtomSelectionText } from '../../modeling/application/atom-selection-tools';
import { confirmCoordinateSelection } from '../../modeling/application/coordinate-selection';
import { protectedPesDocument, type WorkspaceDocumentEntry, type WorkspaceRegistry } from '../../modeling/workspace-registry';
import { applyStructureAppearancePreset, isSelectableStructureAppearancePreset, STRUCTURE_APPEARANCE_PRESETS } from '../../modeling/appearance-presets';
import { createStructureLibraryClient, searchStructureLibrary, STRUCTURE_LIBRARY_CATEGORIES, type StructureLibraryEntry } from '../../modeling/structure-library';
import { readModelDisplayPreferences, validateModelDisplay, applyStructureAppearanceSnapshot } from '../../modeling/platform/display-preferences';
import { desktopBridge } from '../../modeling/platform/desktop';
import { createPersonalFragment, deletePersonalFragment, importPersonalFragments, personalFragmentClipboard, savePersonalFragment, validatePersonalFragmentLibrary } from '../../modeling/personal-fragments';
import type { PeriodicModelingRequest } from '../modeling/PeriodicModelingPanel';
import type { TwoDCommitGuard, TwoDImportRuntime } from '../modeling/TwoDSessionWorkspace';
import type { ModelBondPerceptionRequest, ModelCameraCommand, WorkspaceViewportController } from '../modeling/workspace-viewport';
import { displayedCoordinateObjects } from '../modeling/coordinate-objects';
import {carbonCipSource,prepareCarbonCipLabels,preparedCarbonCipUsage} from '../modeling/render/stereochemistry';
import { objectSchema, presentationFields, presentationMode, toolError, type McCall, type McpPresentationMode, type McTool } from './types';
import { tabTools,type TabToolContext } from './tab-tools';
import { patchSketchStereoGroup,sketchStereoGroups } from './sketch-stereochemistry';

export interface ModelToolContext {
  registry: WorkspaceRegistry;
  tabs?:TabToolContext;
  currentModel?():string|undefined;
  isDetached?(id:string):boolean;
  assertTarget(id:string|undefined, kind:'read'|'edit'|'data-edit'|'view'):void;
  viewport(id:string): WorkspaceViewportController | undefined;
  currentFrame?(id:string): {frameRef:string; targetId:string; collectionId?:string|null} | null;
  display(): DisplaySettings;
  changeDisplay(settings:DisplaySettings): unknown | Promise<unknown>;
  createModel(label?:string, presentation?:McpPresentationMode):WorkspaceDocumentEntry;
  presentModel?(id:string,presentation:McpPresentationMode,call?:McCall):unknown|Promise<unknown>;
  openSketch():void;
  sketch():TwoDImportRuntime | null;
  captureSketchGuard(modelRef?:string, revision?:number):TwoDCommitGuard;
  loadLibrary(entry:StructureLibraryEntry, snapshot:Structure):Promise<unknown>;
}

type Args = Record<string, unknown>;
const emptySelection:ModelSelection = {atomIds:[], bonds:[], auxiliaryIds:[]};
const stringSchema = {type:'string'};
const integerSchema = {type:'integer'};
const revisionSchema = {...integerSchema,minimum:0,description:'Use the most recent revision read from this exact target. Zero is a valid revision.'};
const booleanSchema = {type:'boolean'};
const numberSchema = {type:'number'};
const stringsSchema = {type:'array', items:stringSchema};
const numbersSchema = {type:'array', items:numberSchema};
const vectorSchema = {...numbersSchema,minItems:3,maxItems:3};
const matrixSchema = {type:'array',items:vectorSchema,minItems:3,maxItems:3};
const imagesSchema = {type:'array',items:vectorSchema};
const axesSchema = {type:'array',items:booleanSchema,minItems:3,maxItems:3};
const enumeration = <T extends string>(...values:T[]) => ({type:'string',enum:values});
const targetSchema = {modelRef:stringSchema};
const editSchema = {...targetSchema,expectedRevision:revisionSchema};
const frameSchema = {frameKey:{...stringSchema,description:'Copy the exact opaque frameKey from the current native read; this is distinct from a frameRef or frame index.'}};
const selectionVersionSchema = {selectionVersion:{...stringSchema,description:'Exact selectionVersion returned by model_read or model_select.'}};
const sketchSchema = {draftId:stringSchema,expectedRevision:revisionSchema};

function record(value:unknown,label:string):Args {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${label} 需要对象。`);
  return value as Args;
}
function text(value:unknown,label:string):string {
  if(typeof value!=='string'||!value.trim())throw Error(`${label} 需要非空字符串。`);
  return value;
}
function optionalText(value:unknown,label:string){return value===undefined?undefined:text(value,label);}
function number(value:unknown,label:string):number {
  if(typeof value!=='number'||!Number.isFinite(value))throw Error(`${label} 需要有限数值。`);
  return value;
}
function integer(value:unknown,label:string,minimum=Number.MIN_SAFE_INTEGER):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<minimum)throw Error(`${label} 的整数范围无效。`);
  return value;
}
function boolean(value:unknown,label:string):boolean {
  if(typeof value!=='boolean')throw Error(`${label} 需要布尔值。`);
  return value;
}
function list(value:unknown,label:string):unknown[] {
  if(!Array.isArray(value))throw Error(`${label} 需要数组。`);
  return value;
}
function ids(value:unknown,label:string){return list(value,label).map(id=>text(id,label));}
function vector(value:unknown,label:string):Vector3 {
  const values=list(value,label);
  if(values.length!==3)throw Error(`${label} 需要三个分量。`);
  return values.map(component=>number(component,label)) as Vector3;
}
function image(value:unknown,label:string){return vector(value,label).map(component=>integer(component,label)) as Vector3;}
function axes(value:unknown,label:string):[boolean,boolean,boolean] {
  const values=list(value,label);
  if(values.length!==3)throw Error(`${label} 需要三个轴的周期状态。`);
  return values.map(axis=>boolean(axis,label)) as [boolean,boolean,boolean];
}
function pair(value:unknown,label:string):[string,string] {
  const values=ids(value,label);
  if(values.length!==2)throw Error(`${label} 需要两个原子 ID。`);
  return [values[0],values[1]];
}
function choice<T extends string>(value:unknown,label:string,...allowed:T[]):T {
  if(typeof value!=='string'||!allowed.includes(value as T))throw Error(`${label} 的值无效。`);
  return value as T;
}
function order(value:unknown):BondOrder {
  if(value!==0.5&&value!==1&&value!==1.5&&value!==2&&value!==3)throw Error('键级需要 0.5、1、1.5、2 或 3。');
  return value;
}
function perceptionRequest(args:Args):ModelBondPerceptionRequest {
  const request:ModelBondPerceptionRequest={mode:args.mode===undefined?'rebuild':choice(args.mode,'mode','rebuild','supplement')};
  if(args.method!==undefined)request.method=choice(args.method,'method','empirical','gfn2');
  if(args.solvent!==undefined)request.solvent=text(args.solvent,'solvent');
  if(args.maxSccIterations!==undefined)request.maxSccIterations=integer(args.maxSccIterations,'maxSccIterations',1);
  if(args.electronic!==undefined){
    const electronic=record(args.electronic,'electronic');
    request.electronic={charge:integer(electronic.charge,'charge'),multiplicity:integer(electronic.multiplicity,'multiplicity',1)};
  }
  if(args.parameters!==undefined){
    const raw=record(args.parameters,'parameters'),params:NonNullable<ModelBondPerceptionRequest['parameters']>={};
    if(raw.minDistanceFactor!==undefined)params.minDistanceFactor=number(raw.minDistanceFactor,'minDistanceFactor');
    if(raw.maxDistanceFactor!==undefined)params.maxDistanceFactor=number(raw.maxDistanceFactor,'maxDistanceFactor');
    if(raw.bondOrderMode!==undefined)params.bondOrderMode=choice(raw.bondOrderMode,'bondOrderMode','auto-organic','connectivity-only');
    if(raw.excludedElements!==undefined)params.excludedElements=ids(raw.excludedElements,'excludedElements').map(elementSymbol);
    if(raw.pairOverrides!==undefined)params.pairOverrides=list(raw.pairOverrides,'pairOverrides').map(value=>{
      const item=record(value,'pairOverride'),[a,b]=pair(item.elements,'elements');
      return {elements:[elementSymbol(a),elementSymbol(b)],minDistance:number(item.minDistance,'minDistance'),maxDistance:number(item.maxDistance,'maxDistance')};
    });
    request.parameters=params;
  }
  return request;
}
function selection(value:unknown):ModelSelection {
  const raw=record(value,'selection');
  return {
    atomIds:raw.atomIds===undefined?[]:ids(raw.atomIds,'atomIds'),
    bonds:raw.bonds===undefined?[]:list(raw.bonds,'bonds').map(value=>{
      const bond=record(value,'bond');
      return {kind:'bond',atomIds:pair(bond.atomIds,'bond.atomIds'),...(bond.image===undefined?{}:{image:image(bond.image,'bond.image')})};
    }),
    auxiliaryIds:raw.auxiliaryIds===undefined?[]:ids(raw.auxiliaryIds,'auxiliaryIds'),
    ...(raw.coordinateIds===undefined?{}:{coordinateIds:ids(raw.coordinateIds,'coordinateIds')}),
    ...(raw.portIds===undefined?{}:{portIds:ids(raw.portIds,'portIds')}),
  };
}
const bondSchema = objectSchema({atomIds:{...stringsSchema,minItems:2,maxItems:2},image:vectorSchema}, ['atomIds']);
const selectionSchema = objectSchema({atomIds:stringsSchema,bonds:{type:'array',items:bondSchema},auxiliaryIds:stringsSchema,coordinateIds:stringsSchema,portIds:stringsSchema});

function modelCommand(value:unknown, document:ModelDocument, resolveFragment:(value:Args)=>ClipboardPayload):ModelCommand {
  const args=record(value,'command');
  const bondImage=args.image===undefined?{}:{image:image(args.image,'image')};
  switch(args.type){
    case 'place-element': {
      const element=elementSymbol(text(args.element,'element'));
      const presetId=optionalText(args.presetId,'presetId')??defaultElementPresetId(element);
      if(presetId&&getElementPreset(presetId).element!==element)throw Error('指定几何预设与元素不一致。');
      const position=vector(args.position,'position'),targetAtomId=optionalText(args.targetAtomId,'targetAtomId'),targetPortId=optionalText(args.targetPortId,'targetPortId');
      if(targetAtomId&&targetPortId)throw Error('请指定一个连接目标。');
      if(element==='H'&&targetAtomId)return {type:'add-single-hydrogen',atomId:targetAtomId};
      return {type:'place-element',element,presetId,position,targetAtomId,targetPortId};
    }
    case 'place-fragment': return {type:'place-fragment',templateId:text(args.templateId,'templateId'),activeAtomIndex:args.activeAtomIndex===undefined?undefined:integer(args.activeAtomIndex,'activeAtomIndex',0),position:vector(args.position,'position'),targetAtomId:optionalText(args.targetAtomId,'targetAtomId'),targetPortId:optionalText(args.targetPortId,'targetPortId')};
    case 'add-single-hydrogen': return {type:'add-single-hydrogen',atomId:text(args.atomId,'atomId')};
    case 'delete-objects': return {type:'delete-objects',selection:args.selection===undefined?document.selection:selection(args.selection)};
    case 'set-bond-order': return {type:'set-bond-order',atomIds:pair(args.atomIds,'atomIds'),order:order(args.order),...bondImage};
    case 'break-bond': return {type:'break-bond',atomIds:pair(args.atomIds,'atomIds'),...bondImage};
    case 'set-electronic-state': return {type:'set-electronic-state',charge:integer(args.charge,'charge'),multiplicity:integer(args.multiplicity,'multiplicity',1),confirmed:args.confirmed===undefined?true:boolean(args.confirmed,'confirmed')};
    case 'set-periodic-axes': return {type:'set-periodic-axes',pbc:axes(args.pbc,'pbc'),evidence:optionalText(args.evidence,'evidence')};
    case 'remove-cell': case 'save-cell-checkpoint': case 'restore-cell-checkpoint': return {type:args.type};
    case 'manual-coordinates': return {type:'manual-coordinates',documentId:document.id,expectedRevision:document.revision,atoms:list(args.atoms,'atoms').map(value=>{
      const atom=record(value,'atom');return {id:text(atom.id,'atom.id'),position:vector(atom.position,'atom.position')};
    })};
    case 'reorder-atoms': return {type:'reorder-atoms',documentId:document.id,expectedRevision:document.revision,atomIds:ids(args.atomIds,'atomIds')};
    case 'translate-atoms': return {type:'transform-fragment',atomIds:ids(args.atomIds,'atomIds'),delta:vector(args.delta,'delta'),unwrapPeriodic:args.unwrapPeriodic===undefined?undefined:boolean(args.unwrapPeriodic,'unwrapPeriodic')};
    case 'rotate-atoms': return {type:'transform-fragment',atomIds:ids(args.atomIds,'atomIds'),rotation:{axis:vector(args.axis,'axis'),pivot:vector(args.pivot,'pivot'),degrees:number(args.degrees,'degrees')},unwrapPeriodic:args.unwrapPeriodic===undefined?undefined:boolean(args.unwrapPeriodic,'unwrapPeriodic')};
    case 'change-element': return {type:'legacy',command:{type:'change-element',atomIds:ids(args.atomIds,'atomIds'),element:text(args.element,'element')}};
    case 'change-formal-charge': return {type:'legacy',command:{type:'change-charge',atomIds:ids(args.atomIds,'atomIds'),charge:integer(args.charge,'charge')}};
    case 'invert-stereocenter': return {type:'legacy',command:{type:'invert-center',atomId:text(args.atomId,'atomId')}};
    case 'reflect-atoms': return {type:'legacy',command:{type:'reflect',atomIds:ids(args.atomIds,'atomIds'),axis:choice(args.axis,'axis','x','y','z'),pivot:args.pivot===undefined?undefined:vector(args.pivot,'pivot')}};
    case 'place-copied-fragment': {
      const payload=resolveFragment(args);
      const activeIndex=args.activeAtomIndex===undefined?0:integer(args.activeAtomIndex,'activeAtomIndex',0);
      createCopiedFragmentSeed(payload,activeIndex);
      const targetAtomId=optionalText(args.targetAtomId,'targetAtomId'),targetPortId=optionalText(args.targetPortId,'targetPortId');
      if(targetAtomId&&targetPortId)throw Error('请指定一个连接目标。');
      return {type:args.type,payload,activeIndex,position:vector(args.position,'position'),mode:targetAtomId||targetPortId?'graft':'independent',targetAtomId,targetPortId};
    }
    case 'delete-coordinate': return {type:'delete-coordinate-object',objectId:text(args.objectId,'objectId')};
    default: throw Error('当前版本不提供该模型编辑操作。');
  }
}
const commandShape = (type:string,fields:Args={},required=Object.keys(fields))=>objectSchema({type:{const:type},...fields},['type',...required]);
const placementSchema = {position:vectorSchema,
  targetAtomId:{...stringSchema,description:'Stable ID of the target atom to REPLACE. For substitution on a carbon, select its leaving H, not that carbon. Omit both target fields for independent placement.'},
  targetPortId:{...stringSchema,description:'Stable ID of the target construction port to consume and attach to its host. Use this or targetAtomId.'}};
const attachmentPortSchema=objectSchema({id:stringSchema,hostAtomId:stringSchema,direction:vectorSchema,order:{enum:[1,1.5,2,3]},displayLength:numberSchema,presetId:stringSchema,slotId:stringSchema},['id','hostAtomId','direction','order','displayLength']);
const clipboardSchema={...objectSchema({schema:{const:'sciyue-model-fragment'},version:{const:1},sourceDocumentId:stringSchema,
  fragment:{type:'object',properties:{
    structure:{type:'object',properties:{dimension:{const:3},atoms:{type:'array',minItems:1,items:{type:'object',properties:{id:stringSchema,element:stringSchema,x:numberSchema,y:numberSchema,z:numberSchema},required:['id','element','x','y','z'],additionalProperties:true}},bonds:{type:'array',items:{type:'object',properties:{a:revisionSchema,b:revisionSchema,order:numberSchema},required:['a','b','order'],additionalProperties:true}}},required:['dimension','atoms','bonds'],additionalProperties:true},
    assignments:{type:'object',properties:{layers:{type:'array',items:{type:'object'}},basis:{type:'array',items:{type:'object'}},fragments:{type:'array',items:{type:'object'}},frozenAtomIds:stringsSchema},required:['layers','basis','fragments','frozenAtomIds'],additionalProperties:true},
    auxiliaryRelations:{type:'array',items:{type:'object'}},deletedBonds:{type:'array',items:bondSchema},attachmentPorts:{type:'array',items:attachmentPortSchema},
  },required:['structure','assignments','auxiliaryRelations','deletedBonds'],additionalProperties:true},
},['schema','version','sourceDocumentId','fragment']),description:'Exact portable fragment returned by model_fragment. Keep its nested fragment.attachmentPorts and all native metadata. Prefer fragmentRef within this ES window.'};
const modeSchema=enumeration('fixed','atom','branch');
const geometryFields={atomIds:stringsSchema,images:imagesSchema,value:numberSchema,
  moving:enumeration('branch','selected','atom'),movingAtomIds:stringsSchema,
  sides:objectSchema({first:modeSchema,last:modeSchema},['first','last']),
  sideAtomIds:objectSchema({first:stringsSchema,last:stringsSchema},['first','last'])};
const cropSchema=objectSchema({x:revisionSchema,y:revisionSchema,width:{...integerSchema,minimum:1},height:{...integerSchema,minimum:1}},['x','y','width','height']);
const electronicSchema=objectSchema({charge:integerSchema,multiplicity:{...integerSchema,minimum:1}},['charge','multiplicity']);
const pairOverride=objectSchema({elements:{...stringsSchema,minItems:2,maxItems:2},minDistance:numberSchema,maxDistance:numberSchema},['elements','minDistance','maxDistance']);
const empiricalSchema=objectSchema({minDistanceFactor:numberSchema,maxDistanceFactor:numberSchema,bondOrderMode:enumeration('auto-organic','connectivity-only'),excludedElements:stringsSchema,pairOverrides:{type:'array',items:pairOverride}});
const commandSchema = {oneOf:[
  commandShape('place-element',{element:stringSchema,presetId:stringSchema,...placementSchema},['element','position']),
  commandShape('place-fragment',{templateId:stringSchema,activeAtomIndex:integerSchema,...placementSchema},['templateId','position']),
  commandShape('add-single-hydrogen',{atomId:stringSchema}),commandShape('delete-objects',{selection:selectionSchema},[]),
  commandShape('set-bond-order',{...bondSchema.properties,order:{type:'number',enum:[0.5,1,1.5,2,3]}},['atomIds','order']),
  commandShape('break-bond',bondSchema.properties,['atomIds']),
  commandShape('set-electronic-state',{charge:integerSchema,multiplicity:integerSchema,confirmed:booleanSchema},['charge','multiplicity']),
  commandShape('set-periodic-axes',{pbc:axesSchema,evidence:stringSchema},['pbc']),
  ...['remove-cell','save-cell-checkpoint','restore-cell-checkpoint'].map(type=>commandShape(type)),
  commandShape('manual-coordinates',{atoms:{type:'array',items:objectSchema({id:stringSchema,position:vectorSchema},['id','position'])}}),
  commandShape('reorder-atoms',{atomIds:stringsSchema}),
  commandShape('translate-atoms',{atomIds:stringsSchema,delta:vectorSchema,unwrapPeriodic:booleanSchema},['atomIds','delta']),
  commandShape('rotate-atoms',{atomIds:stringsSchema,axis:vectorSchema,pivot:vectorSchema,degrees:numberSchema,unwrapPeriodic:booleanSchema},['atomIds','axis','pivot','degrees']),
  commandShape('change-element',{atomIds:stringsSchema,element:stringSchema}),commandShape('change-formal-charge',{atomIds:stringsSchema,charge:integerSchema}),
  commandShape('invert-stereocenter',{atomId:stringSchema}),commandShape('reflect-atoms',{atomIds:stringsSchema,axis:enumeration('x','y','z'),pivot:vectorSchema},['atomIds','axis']),
  {...commandShape('place-copied-fragment',{fragment:clipboardSchema,fragmentRef:{...stringSchema,description:'Exact immutable capture reference from model_fragment in this window. Use fragmentRef or fragment.'},activeAtomIndex:{...integerSchema,minimum:0},...placementSchema},['position']),oneOf:[{required:['fragment']},{required:['fragmentRef']}]},
  commandShape('delete-coordinate',{objectId:stringSchema}),
]};

function crystalParameters(raw:unknown):CrystalParameters {
  if(raw===undefined)return {};
  const args=record(raw,'parameters'),parameters:CrystalParameters={};
  const numeric=['symprec','angleTolerance','thickness','start','position','vacuum'] as const;
  for(const key of numeric)if(args[key]!==undefined)parameters[key]=number(args[key],key);
  if(args.termination!==undefined)parameters.termination=integer(args.termination,'termination',0);
  if(args.miller!==undefined)parameters.miller=image(args.miller,'miller');
  if(args.matrix!==undefined)parameters.matrix=matrix(args.matrix,'matrix');
  if(args.thicknessMode!==undefined)parameters.thicknessMode=choice(args.thicknessMode,'thicknessMode','angstrom','layers','fractional');
  if(args.repeat!==undefined){
    const repeat=list(args.repeat,'repeat');
    if(repeat.length!==2)throw Error('repeat 需要两个面内重复数。');
    parameters.repeat=[integer(repeat[0],'repeat',1),integer(repeat[1],'repeat',1)];
  }
  return parameters;
}
const crystalSchema=objectSchema({symprec:numberSchema,angleTolerance:numberSchema,thickness:numberSchema,start:numberSchema,
  position:{...numberSchema,description:'Lower-side slab vacuum in Å. Omit to center the slab at half the total vacuum.'},
  vacuum:{...numberSchema,description:'Total slab vacuum in Å across both sides.'},termination:integerSchema,miller:vectorSchema,matrix:matrixSchema,thicknessMode:enumeration('angstrom','layers','fractional'),repeat:{...numbersSchema,minItems:2,maxItems:2}});
function matrix(value:unknown,label:string):[Vector3,Vector3,Vector3]{
  const rows=list(value,label);
  if(rows.length!==3)throw Error(`${label} 需要三行。`);
  return [vector(rows[0],label),vector(rows[1],label),vector(rows[2],label)];
}
function transformRequest(value:unknown): StructureTransformEdit|PeriodicModelingRequest|CellEditorRequest {
  const args=record(value,'transform'), pivot=args.pivot===undefined?undefined:vector(args.pivot,'pivot');
  const scope=args.atomIds===undefined?{}:{atomIds:ids(args.atomIds,'atomIds')};
  switch(args.type){
    case 'translate': return {type:args.type,...scope,delta:vector(args.delta,'delta')};
    case 'center': return {type:args.type,...scope,mode:choice(args.mode,'mode','geometry','mass'),target:args.target===undefined?undefined:vector(args.target,'target')};
    case 'rotate': return {type:args.type,...scope,pivot,axis:vector(args.axis,'axis'),degrees:number(args.degrees,'degrees')};
    case 'matrix': return {type:args.type,...scope,pivot,matrix:matrix(args.matrix,'matrix')};
    case 'align': return {type:args.type,...scope,pivot,from:vector(args.from,'from'),to:vector(args.to,'to')};
    case 'principal-axes': return {type:args.type,...scope,pivot,massWeighted:args.massWeighted===undefined?undefined:boolean(args.massWeighted,'massWeighted')};
    case 'mirror': return {type:args.type,...scope,pivot,normal:vector(args.normal,'normal')};
    case 'invert': return {type:args.type,...scope,pivot};
    case 'scale': return {type:args.type,...scope,pivot,factors:Array.isArray(args.factors)?vector(args.factors,'factors'):number(args.factors,'factors')};
    case 'crop': return {type:args.type,min:vector(args.min,'min'),max:vector(args.max,'max'),space:args.space===undefined?undefined:choice(args.space,'space','cartesian','fractional')};
    case 'reorder': return {type:args.type,atomIds:ids(args.atomIds,'atomIds')};
    case 'wrap': return {type:args.type};
    case 'finite-cluster': return {type:args.type,keepCell:args.keepCell===undefined?undefined:boolean(args.keepCell,'keepCell')};
    case 'axes': {
      const indices=image(args.order,'order');
      if(new Set(indices).size!==3||indices.some(index=>index<0||index>2))throw Error('order 需要 0、1、2 的排列。');
      return {type:args.type,order:indices as [0|1|2,0|1|2,0|1|2],signs:args.signs===undefined?undefined:image(args.signs,'signs')};
    }
    case 'supercell': return {type:args.type,repeat:image(args.repeat,'repeat')};
    case 'vacuum': {
      const axis=integer(args.axis,'axis',0);
      if(axis>2)throw Error('axis 需要 0、1 或 2。');
      return {type:args.type,axis:axis as 0|1|2,vacuum:number(args.vacuum,'vacuum'),center:args.center===undefined?true:boolean(args.center,'center')};
    }
    case 'cell': {
      const cell=record(args.cell,'cell');
      return {type:args.type,cell:{vectors:matrix(cell.vectors,'cell.vectors'),pbc:axes(cell.pbc,'cell.pbc'),origin:cell.origin===undefined?undefined:vector(cell.origin,'cell.origin')},keep:choice(args.keep,'keep','cartesian','fractional')};
    }
    case 'assign-cell': {
      const mode=choice(args.mode,'mode','lengths','padding');
      return {type:args.type,mode,lengths:mode==='lengths'?vector(args.lengths,'lengths'):[1,1,1],padding:mode==='padding'?number(args.padding,'padding'):0,shape:args.shape===undefined?'orthogonal':choice(args.shape,'shape','orthogonal','cube'),center:args.center===undefined?true:boolean(args.center,'center')};
    }
    case 'edit-cell': {
      const handling=list(args.handling,'handling');
      if(handling.length!==3)throw Error('handling 需要三个晶轴的处理方式。');
      return {type:args.type,lengths:vector(args.lengths,'lengths'),handling:handling.map(value=>choice(value,'handling','cartesian','stretch')) as ['cartesian'|'stretch','cartesian'|'stretch','cartesian'|'stretch']};
    }
    case 'crystal': return {type:args.type,operation:choice(args.operation,'operation','primitive','conventional','p1','idealize','supercell','slab'),parameters:crystalParameters(args.parameters)};
    default: throw Error('未知结构变换操作。');
  }
}
const pivotScope = {pivot:vectorSchema,atomIds:stringsSchema};
const transformSchema = {oneOf:[
  commandShape('translate',{delta:vectorSchema,atomIds:stringsSchema},['delta']),
  commandShape('center',{mode:enumeration('geometry','mass'),target:vectorSchema,atomIds:stringsSchema},['mode']),
  commandShape('rotate',{axis:vectorSchema,degrees:numberSchema,...pivotScope},['axis','degrees']),
  commandShape('matrix',{matrix:matrixSchema,...pivotScope},['matrix']),commandShape('align',{from:vectorSchema,to:vectorSchema,...pivotScope},['from','to']),
  commandShape('principal-axes',{massWeighted:booleanSchema,...pivotScope},[]),commandShape('mirror',{normal:vectorSchema,...pivotScope},['normal']),
  commandShape('invert',pivotScope,[]),commandShape('scale',{factors:{oneOf:[numberSchema,vectorSchema]},...pivotScope},['factors']),
  commandShape('crop',{min:vectorSchema,max:vectorSchema,space:enumeration('cartesian','fractional')},['min','max']),
  commandShape('reorder',{atomIds:stringsSchema}),commandShape('wrap'),commandShape('finite-cluster',{keepCell:booleanSchema},[]),
  commandShape('axes',{order:vectorSchema,signs:vectorSchema},['order']),commandShape('supercell',{repeat:vectorSchema}),
  commandShape('vacuum',{axis:integerSchema,vacuum:numberSchema,center:booleanSchema},['axis','vacuum']),
  commandShape('cell',{cell:objectSchema({vectors:matrixSchema,pbc:axesSchema,origin:vectorSchema},['vectors','pbc']),keep:enumeration('cartesian','fractional')}),
  commandShape('assign-cell',{mode:enumeration('lengths','padding'),lengths:vectorSchema,padding:numberSchema,shape:enumeration('orthogonal','cube'),center:booleanSchema},['mode']),
  commandShape('edit-cell',{lengths:vectorSchema,handling:{type:'array',items:enumeration('cartesian','stretch'),minItems:3,maxItems:3}}),
  commandShape('crystal',{operation:enumeration('primitive','conventional','p1','idealize','supercell','slab'),parameters:crystalSchema},['operation']),
]};

function resultBound(entry:WorkspaceDocumentEntry){
  return Boolean(entry.result||entry.legacyResult||entry.trajectory||protectedPesDocument(entry)||entry.conformerGroup?.role==='collection'||entry.store.getSnapshot().analysisBindingId);
}
function ordinaryDataOwner(entry:WorkspaceDocumentEntry){
  return !resultBound(entry)&&!entry.conformerGroup&&!entry.pesGroup;
}
function stamp(entry:WorkspaceDocumentEntry){
  return {modelRef:entry.id,documentEpoch:entry.epoch,revision:entry.store.getSnapshot().revision,sourceEpoch:entry.sourceEpoch};
}
function modelFragmentSnapshot(source:ModelDocument):FragmentSnapshot {
  const {draft,auxiliaryRelations,deletedBonds,attachmentPorts,internalCoordinates,sharedConstraints,coordinateObjects,gaussianBoundCoordinates,cellCheckpoint}=source;
  return {structure:draft.structure,assignments:draft.assignments,auxiliaryRelations,deletedBonds,attachmentPorts,internalCoordinates,sharedConstraints,coordinateObjects,gaussianBoundCoordinates,cellCheckpoint};
}
function sameStructureContext(entry:WorkspaceDocumentEntry, expected:ReturnType<typeof stamp>){
  const current=stamp(entry);
  return current.documentEpoch===expected.documentEpoch&&current.sourceEpoch===expected.sourceEpoch&&current.revision===expected.revision;
}
function mergeSelection(previous:ModelSelection,next:ModelSelection,mode:'add'|'remove'):ModelSelection {
  function merge<T>(before:T[],changes:T[],key:(item:T)=>string){
    const items=new Map(before.map(value=>[key(value),value]));
    for(const value of changes){if(mode==='add')items.set(key(value),value);else items.delete(key(value));}
    return [...items.values()];
  }
  const byId=(id:string)=>id;
  return {atomIds:merge(previous.atomIds,next.atomIds,byId),bonds:merge(previous.bonds,next.bonds,referenceKey),auxiliaryIds:merge(previous.auxiliaryIds,next.auxiliaryIds,byId),portIds:merge(previous.portIds??[],next.portIds??[],byId),coordinateIds:merge(previous.coordinateIds??[],next.coordinateIds??[],byId)};
}
function asCameraCommand(args:Args):ModelCameraCommand {
  switch(args.action){
    case 'reset':case 'standard': return {kind:args.action};
    case 'step': return {kind:args.action,direction:choice(args.direction,'direction','left','right','up','down')};
    case 'cell': return {kind:args.action,preset:choice(args.preset,'preset','a','a*','b','b*','c','c*')};
    case 'zoom': {
      const factor=args.factor;
      if(typeof factor!=='number'||!Number.isFinite(factor)||factor<=0)throw toolError('INVALID_ZOOM_FACTOR','factor 需要有限正数；1.2 表示相对当前画面放大 20%，0.8 表示缩小 20%。');
      return {kind:'zoom',factor};
    }
    case 'set': {
      const view=list(args.view,'view').map(value=>number(value,'view'));
      if(view.length!==8||Math.hypot(...view.slice(4))<1e-12)throw Error('视角需要 8 个数值及有效四元数。');
      return {kind:'view',view};
    }
    default: throw Error('未知视角操作。');
  }
}

export function modelTools(ctx:ModelToolContext):McTool[] {
  const library=createStructureLibraryClient();
  const captures=new Map<string,{fragment:ClipboardPayload;source:ReturnType<typeof stamp>&{frameKey?:string}}>();
  const def=(name:string,description:string,properties:Args,required:string[],call:McTool['call']):McTool=>({name,description,inputSchema:objectSchema(properties,required),call});
  const exactlyOneInput=(tool:McTool,fields:string[]):McTool=>({...tool,inputSchema:{...tool.inputSchema,oneOf:fields.map(field=>({required:[field]}))}});
  const activeRef=()=>{
    const current=ctx.registry.getSnapshot();
    return current.views.find(view=>view.id===current.activeViewId)?.documentId;
  };
  const currentModel=()=>ctx.currentModel?ctx.currentModel():activeRef();
  function resolveFragment(args:Args):ClipboardPayload {
    if((args.fragment===undefined)===(args.fragmentRef===undefined))throw toolError('invalid-fragment-input','请提供 fragment 或 fragmentRef 中的一项。',{fields:['fragment','fragmentRef']});
    if(args.fragmentRef!==undefined){
      const ref=text(args.fragmentRef,'fragmentRef'),capture=captures.get(ref);
      if(!capture)throw toolError('fragment-unavailable','片段引用不属于当前窗口或已释放，请重新捕获。',{fragmentRef:ref});
      return structuredClone(capture.fragment);
    }
    const payload=record(args.fragment,'fragment');
    if(payload.attachmentPorts!==undefined)throw toolError('invalid-fragment-input','片段端口位于 fragment.fragment.attachmentPorts，请传回完整捕获值。',{path:'fragment.fragment.attachmentPorts'});
    try{createCopiedFragmentSeed(payload as unknown as ClipboardPayload);}
    catch(cause){throw toolError('invalid-fragment-input',cause instanceof Error?cause.message:String(cause),{path:'fragment',expectedSchema:'sciyue-model-fragment',expectedVersion:1});}
    return payload as unknown as ClipboardPayload;
  }
  function target(args:Args,kind:Parameters<ModelToolContext['assertTarget']>[1]='read'){
    const id=optionalText(args.modelRef,'modelRef')??currentModel();
    if(!id)throw toolError('model-unavailable','当前窗口没有模型。');
    ctx.assertTarget(id,kind);
    const entry=ctx.registry.document(id),document=entry.store.getSnapshot(),controller=ctx.viewport(id);
    if(kind!=='read'&&integer(args.expectedRevision,'expectedRevision',0)!==document.revision)throw toolError('model-conflict','模型修订已变化，请重新读取。',stamp(entry));
    return {entry,document,controller,port:controller?.model};
  }
  function editTarget(args:Args){
    const row=target(args);
    const kind=args.modelRef!==undefined&&ordinaryDataOwner(row.entry)&&args.disposition!=='copy'?'data-edit':'edit';
    ctx.assertTarget(row.entry.id,kind);
    if(integer(args.expectedRevision,'expectedRevision',0)!==row.document.revision)throw toolError('model-conflict','模型修订已变化，请重新读取。',stamp(row.entry));
    return row;
  }
  function requirePort(row:ReturnType<typeof target>){
    if(!row.port)throw toolError('viewport-unavailable','当前窗口尚无目标模型的操作宿主。');
    return row.port;
  }
  function assertFrame(args:Args,row:ReturnType<typeof target>){
    const expected=optionalText(args.frameKey,'frameKey'),actual=row.port?.frameKey();
    if((expected!==undefined||resultBound(row.entry))&&(!expected||expected!==actual)){
      const scientificFrame=ctx.currentFrame?.(row.entry.id);
      const modelRef=row.entry.id;
      throw toolError('frame-conflict',!actual?'当前模型没有已准备的原生编辑帧。':!expected?'请传入当前科学帧身份 frameKey。':'科学帧身份已变化，请重新读取当前原生编辑帧。',{
        ...stamp(row.entry),frameKey:actual,scientificFrame,committed:false,
        reason:!actual?'edit-frame-unavailable':!expected?'frame-key-required':'frame-key-changed',
        recovery:actual?{tool:'model_read',arguments:{modelRef}}:scientificFrame?{tool:'frame_extract',arguments:{frameRef:scientificFrame.frameRef}}:
          {tool:'frames_select',arguments:{targetId:modelRef}},
      });
    }
    return actual;
  }
  function editSource(row:ReturnType<typeof target>,compute:()=>ModelDocument){
    try{return compute();}
    catch(cause){
      if(!(cause instanceof Error)||!('code'in cause)||!['MODEL_EDIT_BLOCKED','MODEL_VIEW_UNAVAILABLE'].includes(String(cause.code)))throw cause;
      const data='data'in cause&&cause.data&&typeof cause.data==='object'?cause.data:{};
      const scientificFrame=ctx.currentFrame?.(row.entry.id);
      const copyFrom=scientificFrame&&resultBound(row.entry)?{tool:'frame_extract',arguments:{frameRef:scientificFrame.frameRef}}:undefined;
      throw toolError(String(cause.code),cause.message,{
        ...stamp(row.entry),...data,scientificFrame,committed:false,
        recovery:('recovery'in data?data.recovery:undefined)??copyFrom,copyFrom,
      });
    }
  }
  function selectionVersion(row:ReturnType<typeof target>,selection:ModelSelection){
    return JSON.stringify([row.entry.epoch,row.port?.frameKey()??null,selection]);
  }
  function assertSelection(args:Args,row:ReturnType<typeof target>,required=false){
    const selection=row.port?.selection()??row.document.selection,version=selectionVersion(row,selection);
    if((required||args.selectionVersion!==undefined)&&args.selectionVersion!==version)throw toolError('selection-conflict','模型选区已变化或缺少选区版本，请重新读取。',{...stamp(row.entry),selectionVersion:version,selection});
    return selection;
  }
  function runEdit(args:Args, build:(document:ModelDocument)=>ModelCommand[],activateCopy=true){
    const row=editTarget(args),frameKey=assertFrame(args,row),port=requirePort(row);
    const picked=assertSelection(args,row,Array.isArray(args.commands)&&args.commands.some(value=>{
      const command=record(value,'command');return command.type==='delete-objects'&&command.selection===undefined;
    })||(['freeze','unfreeze'].some(action=>args.action===action)&&args.atomIds===undefined&&args.coordinateIds===undefined));
    const useCopy=resultBound(row.entry)&&args.disposition!=='current';
    if(args.disposition!==undefined)choice(args.disposition,'disposition','current','copy');
    if(!useCopy&&args.disposition!=='copy'){
      const background=Boolean(ctx.isDetached?.(row.entry.id))||row.entry.id!==currentModel();
      if(background&&!ordinaryDataOwner(row.entry))ctx.assertTarget(row.entry.id,'view');
      const commands=build({...row.document,selection:picked});
      const after=commands.length?editSource(row,()=>port.edit(row.document.revision,commands,background)):row.document;
      return {...stamp(row.entry),status:after.revision===row.document.revision?'unchanged':'committed',frameKey,selection:after.selection,...placementReceipt(row.document,after,commands)};
    }
    ctx.assertTarget(row.entry.id,'view');
    const source=editSource(row,()=>port.source(row.document.revision));
    const fragment=modelFragmentSnapshot(source);
    const pending=ctx.registry.prepareFragmentDocument({...fragment,structure:{...fragment.structure,id:newModelId()}},`${row.entry.label}-model`);
    try{
      const staged=pending.store, baseline=staged.getSnapshot();
      const commands=build({...baseline,selection:picked});
      if(!commands.length){pending.cancel();return {...stamp(row.entry),status:'unchanged',frameKey,selection:picked};}
      const edited=staged.executeBatch!(commands,'修改模型');
      const created=pending.commit(activateCopy);
      return {...stamp(created),status:'committed',source:{...stamp(row.entry),frameKey},selection:edited.selection,...placementReceipt(baseline,edited,commands)};
    }catch(error){if(pending.state()==='prepared')pending.cancel();throw error;}
  }
  async function followEdit(receipt:ReturnType<typeof runEdit>,mode:McpPresentationMode,call?:McCall){
    if(mode==='background')return {...receipt,presentation:{mode,status:'background'}};
    if(call?.signal.aborted)return {...receipt,presentation:{mode,status:'cancelled'}};
    try{return {...receipt,presentation:await ctx.presentModel?.(receipt.modelRef,mode,call)};}
    catch(cause){return {...receipt,presentation:{mode,status:'unavailable',message:cause instanceof Error?cause.message:String(cause)}};}
  }
  function placementReceipt(before:ModelDocument,after:ModelDocument,commands:ModelCommand[]){
    const placements=commands.flatMap((command,index)=>command.type==='place-copied-fragment'?[{
      commandIndex:index,sourceDocumentId:command.payload.sourceDocumentId,sourceAtomIds:command.payload.fragment.structure.atoms.map(atom=>atom.id!),
      activeSourceAtomId:command.payload.fragment.structure.atoms[command.activeIndex??0].id!,
      mode:command.mode,targetAtomId:command.targetAtomId,targetPortId:command.targetPortId,
    }]:[]);
    if(!placements.length)return {};
    const oldAtoms=new Map(before.draft.structure.atoms.map(atom=>[atom.id!,atom])),newAtoms=new Map(after.draft.structure.atoms.map(atom=>[atom.id!,atom]));
    return {placements,atomChanges:{
      addedAtomIds:[...newAtoms.keys()].filter(id=>!oldAtoms.has(id)),removedAtomIds:[...oldAtoms.keys()].filter(id=>!newAtoms.has(id)),
      changedAtomIds:[...newAtoms.keys()].filter(id=>oldAtoms.has(id)&&JSON.stringify(oldAtoms.get(id))!==JSON.stringify(newAtoms.get(id))),
    }};
  }
  function sketch(){
    ctx.assertTarget(undefined,'edit');
    const runtime=ctx.sketch();
    if(!runtime)throw toolError('sketch-unavailable','二维画板尚未打开或编辑器正在载入。');
    return runtime.sketch;
  }
  async function sketchOperation<T>(work:()=>T|Promise<T>):Promise<T>{
    try{return await work();}
    catch(cause){
      const owner=ctx.sketch()?.sketch;
      const current=await owner?.read?.().catch(()=>undefined),image=owner?.image?.();
      const state=current?.status==='ready'?{draftId:current.snapshot.documentKey,revision:current.snapshot.revision,busy:current.busy}:current;
      const error=cause instanceof Error?cause:new Error(String(cause));
      throw toolError('code' in error?String(error.code):'sketch-operation-failed',error.message,{current:state,image,
        ...('data' in error?{detail:error.data}:{})});
    }
  }
  function captureFragment(args:Args,row:ReturnType<typeof target>){
    const explicit=args.atomIds===undefined?undefined:ids(args.atomIds,'atomIds');
    const frameKey=assertFrame(args,row),scope=args.scope===undefined?(explicit?'selection':'all'):choice(args.scope,'scope','all','selection');
    const source=resultBound(row.entry)?requirePort(row).source(row.document.revision):row.document;
    const selected=scope==='selection'&&!explicit?assertSelection(args,row,true):{...emptySelection,atomIds:explicit??[]};
    if(scope==='all'&&explicit)throw toolError('invalid_arguments','scope=all 与明确的 atomIds 冲突。',{path:'arguments.scope',expected:{values:['selection']}});
    if(source===row.document&&scope==='all')return {frameKey,fragment:row.entry.store.copy('all')};
    const snapshot=modelFragmentSnapshot(source),staged=createModelStore(snapshot.structure,snapshot.assignments,snapshot.internalCoordinates,snapshot);
    if(scope==='selection'){
      const known=new Set(source.draft.structure.atoms.map(atom=>atom.id));
      if(selected.atomIds.some(id=>!known.has(id)))throw Error('片段原子身份已变化。');
      staged.select(selected);
    }
    const fragment=staged.copy(scope);createCopiedFragmentSeed(fragment);
    return {frameKey,fragment:{...fragment,sourceDocumentId:row.entry.id}};
  }
  const fragmentScopeSchema={...editSchema,...frameSchema,...selectionVersionSchema,scope:enumeration('all','selection'),atomIds:stringsSchema};
  const disposition=enumeration('current','copy');
  return [
    ...tabTools(()=>ctx.tabs),
    def('model_create','Open a new editable model in the attached ES workbench. The default follows the new model in the bound window, and background retains the current view.',{label:stringSchema,...presentationFields},[],async args=>{
      ctx.assertTarget(undefined,'edit');
      const presentation=presentationMode(args),entry=ctx.createModel(optionalText(args.label,'label'),presentation);
      try{return {...stamp(entry),status:'committed',view:await ctx.presentModel?.(entry.id,presentation)};}
      catch(error){return {...stamp(entry),status:'committed',presentationWarning:error instanceof Error?error.message:String(error)};}
    }),
    def('model_read','Read the working model or prepared scientific frame, including stable atom IDs, bonds, electronic state, freezes and history.',{...targetSchema,source:enumeration('working','frame')},[],args=>{
      const row=target(args), model=args.source==='frame'?requirePort(row).source(row.document.revision):row.document;
      const selected=row.port?.selection()??model.selection;
      return {...stamp(row.entry),frameKey:row.port?.frameKey(),scientificFrame:resultBound(row.entry)?ctx.currentFrame?.(row.entry.id):undefined,label:row.entry.label,geometryUnits:'angstrom',structure:model.draft.structure,selection:selected,selectionVersion:selectionVersion(row,selected),auxiliaryRelations:model.auxiliaryRelations,attachmentPorts:model.attachmentPorts??[],coordinates:displayedCoordinateObjects(model),sharedConstraints:model.sharedConstraints,effectiveFrozenAtomIds:getFrozenAtomIds(model),electronicStateConfirmed:model.electronicStateConfirmed===true,canUndo:ctx.registry.canUndo(row.entry.id),canRedo:ctx.registry.canRedo(row.entry.id)};
    }),
    def('model_stereochemistry','Read native A13 carbon CIP assignments on an exact working model or prepared scientific frame. The geometry and bond graph remain unchanged.',{...targetSchema,...frameSchema,source:enumeration('working','frame')},[],async(args,call)=>{
      const before=target(args),identity=stamp(before.entry),view=args.source==='frame';
      const key=view?assertFrame(args,before):undefined,geometry=(view?requirePort(before).source(identity.revision):before.document).draft.structure;
      if(!carbonCipSource(geometry))return {...identity,frameKey:key,status:'unavailable',assignments:[]};
      await prepareCarbonCipLabels(geometry,call?.signal);
      call?.signal.throwIfAborted();const current=target({...args,modelRef:identity.modelRef});
      if(!sameStructureContext(current.entry,identity)||view&&current.port?.frameKey()!==key)throw toolError('revision_conflict','准备标注时模型或实际帧已变化。');
      const native=carbonCipSource(geometry),warning=native?.failure?.warning,receipt=preparedCarbonCipUsage(geometry);
      return {...identity,frameKey:key,status:warning?(warning.partial?'partial':'failed'):'ready',assignments:receipt?.assignments??[],source:receipt?.sourceId,warning:warning?.reason};
    }),
    def('model_edit','Commit model edits in one undoable transaction. Successful edits follow the edited model in this window by default. Set presentation to background to keep the visible workbench. Coordinates use Å and rotations use degrees. For copied-fragment grafting, pass the captured fragmentRef and targetAtomId of the leaving atom (commonly H), or targetPortId. Source atom IDs belong to the incoming fragment; read the returned added/removed IDs before later edits. Result frames default to editing a new copy. Supply frameKey for a result frame and selectionVersion when deleting the current selection.',{...editSchema,...frameSchema,...selectionVersionSchema,...presentationFields,disposition,commands:{type:'array',items:commandSchema,minItems:1}},['expectedRevision','commands'],(args,call)=>{
      const mode=presentationMode(args);
      call?.signal.throwIfAborted();
      const receipt=runEdit(args,document=>{
        const commands=list(args.commands,'commands');
        if(!commands.length)throw Error('请提供要提交的模型操作。');
        return commands.map(command=>modelCommand(command,document,resolveFragment));
      },mode!=='background'&&!ctx.presentModel);
      return receipt.status==='committed'&&(ctx.presentModel||mode==='background')?followEdit(receipt,mode,call):receipt;
    }),
    def('model_select','Read or change the shared visible selection by stable IDs, 1-based atom numbers/ranges, bond-neighbor expansion, or clear/all.',{...editSchema,...frameSchema,...selectionVersionSchema,selection:selectionSchema,numbers:stringSchema,neighborDepth:{...integerSchema,minimum:0},mode:enumeration('read','replace','add','remove','all','clear')},[],args=>{
      if(args.mode==='read'){
        const row=target(args),selected=row.port?.selection()??row.document.selection;
        return {...stamp(row.entry),frameKey:row.port?.frameKey(),selection:selected,selectionVersion:selectionVersion(row,selected)};
      }
      const row=target(args,'view'),port=requirePort(row);assertFrame(args,row);
      const structure=row.document.draft.structure,previous=assertSelection(args,row);
      const mode=args.mode===undefined?'replace':choice(args.mode,'mode','replace','add','remove','all','clear');
      let next=args.selection===undefined?emptySelection:selection(args.selection);
      if(args.numbers!==undefined){
        const parsed=parseAtomSelectionText(text(args.numbers,'numbers'),structure);
        if(parsed.status!=='valid')throw Error(parsed.message);
        next={...next,atomIds:parsed.atomIds};
      }
      if(args.neighborDepth!==undefined)next={...next,atomIds:expandAtomSelectionByBonds(structure,next.atomIds.length?next.atomIds:previous.atomIds,integer(args.neighborDepth,'neighborDepth',0))};
      if(mode==='all')next={...emptySelection,atomIds:structure.atoms.map(atom=>atom.id!)};
      if(mode==='clear')next=emptySelection;
      if(mode==='add'||mode==='remove')next=mergeSelection(previous,next,mode);
      const committed=port.select(row.document.revision,next);
      return {...stamp(row.entry),frameKey:row.port?.frameKey(),selection:committed,selectionVersion:selectionVersion(row,committed)};
    }),
    def('model_constraints','Change shared modeling freezes. Atoms and coordinates commit together. Supply selectionVersion to use the current selection, or provide explicit atomIds and/or coordinateIds.',{...editSchema,...frameSchema,...selectionVersionSchema,disposition,action:enumeration('freeze','unfreeze','enable','disable','clear'),atomIds:stringsSchema,coordinateIds:stringsSchema},['expectedRevision','action'],args=>runEdit(args,document=>{
      const action=choice(args.action,'action','freeze','unfreeze','enable','disable','clear');
      if(action==='enable'||action==='disable')return [{type:'set-shared-freezes-enabled',enabled:action==='enable'}];
      if(action==='clear')return [{type:'clear-shared-freezes'}];
      const useSelection=args.atomIds===undefined&&args.coordinateIds===undefined;
      const atomIds=useSelection?document.selection.atomIds:args.atomIds===undefined?[]:ids(args.atomIds,'atomIds');
      const coordinateIds=useSelection?document.selection.coordinateIds??[]:args.coordinateIds===undefined?[]:ids(args.coordinateIds,'coordinateIds');
      const available=new Map(displayedCoordinateObjects(document).map(object=>[object.id,object]));
      const frozen=action==='freeze',commands:ModelCommand[]=atomIds.length?[{type:'set-shared-atom-freeze',atomIds,frozen}]:[];
      for(const id of coordinateIds){
        const object=available.get(id);if(!object)throw Error('坐标对象已变化，请重新读取。');
        commands.push({type:'set-shared-coordinate-freeze',object,frozen});
      }
      if(!commands.length)throw Error('请指定原子或内坐标。');
      return commands;
    })),
    def('model_measure','Measure a distance, angle or dihedral using 2, 3 or 4 ordered atom IDs. Supply periodic endpoint images when relevant. Save optionally adds a model measurement object.',{...editSchema,...frameSchema,atomIds:stringsSchema,images:imagesSchema,save:booleanSchema,disposition},['atomIds'],args=>{
      const row=target(args),atomIds=ids(args.atomIds,'atomIds');
      const images=args.images===undefined?undefined:list(args.images,'images').map(value=>image(value,'images'));
      const source=resultBound(row.entry)?(assertFrame(args,row),requirePort(row).source(row.document.revision)):row.document;
      const value=confirmCoordinateSelection(source.draft.structure,atomIds,images);
      if(args.save!==true)return {...stamp(row.entry),frameKey:row.port?.frameKey(),...value};
      const id=newModelId();
      const receipt=runEdit(args,()=>[{type:'upsert-coordinate-object',object:{id,type:value.type,atomIds,...(images?{images}:{})}}]);
      return {...receipt,...value,coordinateId:id};
    }),
    def('model_geometry','Set an internal distance, angle or dihedral through ES’s balanced geometry editor. Values are Å for distance and degrees for angles. Side modes or explicit side atom IDs mirror the modeling controls.',{...editSchema,...frameSchema,disposition,...geometryFields},['expectedRevision','atomIds','value'],args=>{
      const atomIds=ids(args.atomIds,'atomIds'),value=number(args.value,'value');
      const images=args.images===undefined?undefined:list(args.images,'images').map(item=>image(item,'images'));
      const sides=args.sides===undefined?undefined:record(args.sides,'sides');
      const sideAtomIds=args.sideAtomIds===undefined?undefined:record(args.sideAtomIds,'sideAtomIds');
      const sideMode=(value:unknown,label:string):GeometrySideMode=>choice(value,label,'fixed','atom','branch');
      return runEdit(args,document=>{
        const structure=document.draft.structure,coordinate=confirmCoordinateSelection(structure,atomIds,images);
        if(coordinate.type!=='B'&&images?.some(offset=>offset.some(Boolean)))throw Error('手工 A/D 几何编辑未支持跨胞镜像路径。');
        const geometry=editBuilderGeometryBalanced(structure,{coordinate:coordinate.type,atomIds,value,images,
          moving:args.moving===undefined?undefined:choice(args.moving,'moving','branch','selected','atom'),
          selectedAtomIds:args.movingAtomIds===undefined?undefined:ids(args.movingAtomIds,'movingAtomIds'),
          sideModes:sides?{first:sideMode(sides.first,'first'),last:sideMode(sides.last,'last')}:undefined,
          sideAtomIds:sideAtomIds?{first:ids(sideAtomIds.first,'first'),last:ids(sideAtomIds.last,'last')}:undefined,
          fixedAtomIds:getFrozenAtomIds(document)});
        const touched=new Set(geometry.touchedIds);
        if(!touched.size)return [];
        return [{type:'manual-coordinates',documentId:document.id,expectedRevision:document.revision,
          atoms:geometry.structure.atoms.filter(atom=>touched.has(atom.id!)).map(atom=>({id:atom.id!,position:[atom.x,atom.y,atom.z]}))}];
      });
    }),
    def('model_bond_perception','Run native empirical or GFN2 bond perception on the selected working model. Effective empirical settings, electronic state and native phase are returned. For an observation use model_fragment to extract an editable source.',{...editSchema,...frameSchema,method:enumeration('empirical','gfn2'),mode:enumeration('rebuild','supplement'),parameters:empiricalSchema,electronic:electronicSchema,solvent:stringSchema,maxSccIterations:{...integerSchema,minimum:1}},['expectedRevision'],async(args,call)=>{
      const row=target(args,'view');assertFrame(args,row);
      if(resultBound(row.entry))throw toolError('model-source-is-readonly','请从结果画面提取可编辑模型，再运行自动成键。');
      const receipt=await requirePort(row).perceiveBonds(row.document.revision,perceptionRequest(args),call?.signal);
      return {modelRef:row.entry.id,documentEpoch:row.entry.epoch,receipt};
    }),
    def('model_fragment','Capture a whole model or explicit atomIds into an immutable fragmentRef scoped to this ES window and a portable fragment value. Selecting atoms across a cut bond creates a real attachment port. Pass fragmentRef unchanged to model_edit place-copied-fragment, activeAtomIndex of the incoming attachment atom, and targetAtomId of the leaving H. read retrieves a captured snapshot; release frees only that capture. extract creates an editable model.',{...fragmentScopeSchema,action:enumeration('capture','extract','read','release'),fragmentRef:stringSchema,label:stringSchema},['action'],args=>{
      const action=choice(args.action,'action','capture','extract','read','release');
      if(action==='read'||action==='release'){
        ctx.assertTarget(undefined,'read');
        const ref=text(args.fragmentRef,'fragmentRef'),capture=captures.get(ref);
        if(!capture)throw toolError('fragment-unavailable','片段引用不属于当前窗口或已释放，请重新捕获。',{fragmentRef:ref});
        if(action==='release'){captures.delete(ref);return {status:'released',fragmentRef:ref};}
        return {status:'captured',fragmentRef:ref,...structuredClone(capture)};
      }
      const row=target(args,action==='extract'?'edit':'read');
      if(args.expectedRevision!==undefined&&integer(args.expectedRevision,'expectedRevision',0)!==row.document.revision)throw toolError('model-conflict','模型修订已变化，请重新读取。',stamp(row.entry));
      const captured=captureFragment(args,row),source={...stamp(row.entry),frameKey:captured.frameKey};
      if(action==='capture'){
        const fragmentRef=`es-fragment:${newModelId()}`;
        captures.set(fragmentRef,{source:structuredClone(source),fragment:structuredClone(captured.fragment)});
        return {status:'captured',source,fragmentRef,fragment:captured.fragment};
      }
      const fragment=captured.fragment.fragment,label=optionalText(args.label,'label');
      const child=ctx.registry.addFragmentDocument({...fragment,structure:{...fragment.structure,id:newModelId()}},label);
      return {...stamp(child),status:'committed',source};
    }),
    def('history_action','Undo or redo one native model, selection, derived-structure or exact frame bond history operation.',{...editSchema,...frameSchema,direction:enumeration('undo','redo')},['expectedRevision','direction'],args=>{
      const row=target(args,'view');assertFrame(args,row);
      const changed=requirePort(row).history(row.document.revision,choice(args.direction,'direction','undo','redo'));
      const current=activeRef();
      return {status:changed?'committed':'unchanged',modelRef:row.entry.id,activeModelRef:current,revision:row.entry.store.getSnapshot().revision};
    }),
    def('model_transform','Apply a native geometry or crystal transformation to the active source. Focus an explicit source with es_show before transforming it after a different derived model opens. Defaults to a derived model, except assign/edit cell on an ordinary working model.',{...editSchema,...frameSchema,disposition,transform:transformSchema},['expectedRevision','transform'],async args=>{
      const row=target(args,'view'),before=stamp(row.entry),frameKey=assertFrame(args,row),request=transformRequest(args.transform);
      const cellEdit=request.type==='assign-cell'||request.type==='edit-cell';
      const mode=args.disposition===undefined?(cellEdit&&!resultBound(row.entry)?'current':'copy'):choice(args.disposition,'disposition','current','copy');
      if(mode==='current'&&!cellEdit)throw Error('此变换的原生工作流会生成独立派生模型。');
      await requirePort(row).transform(row.document.revision,request,mode==='copy');
      const created=activeRef();
      if(mode==='copy'){
        if(!created||created===before.modelRef)throw Error('本次变换未提交派生模型。');
        const entry=ctx.registry.document(created);
        if(entry.derivation?.parentDocumentId!==before.modelRef||entry.derivation.parentRevision!==before.revision)throw Error('本次变换未取得同来源的派生模型回执。');
        return {...stamp(entry),status:'committed',source:{...before,frameKey},operation:entry.derivation.operation};
      }
      return {...stamp(row.entry),frameKey,status:before.revision===row.entry.store.getSnapshot().revision?'unchanged':'committed'};
    }),
    def('model_crystal_inspect','Inspect symmetry or available slab terminations with the configured native crystal modeler. An explicit ordinary modelRef can be inspected in the background without changing the visible model.',{...targetSchema,...frameSchema,operation:enumeration('symmetry','slab-terminations'),parameters:crystalSchema},['operation'],async(args,call)=>{
      const row=target(args);assertFrame(args,row);
      const request={operation:choice(args.operation,'operation','symmetry','slab-terminations'),parameters:crystalParameters(args.parameters)};
      if(args.modelRef!==undefined&&ordinaryDataOwner(row.entry)&&(ctx.isDetached?.(row.entry.id)||row.entry.id!==currentModel())){
        const before=stamp(row.entry),bridge=desktopBridge();
        if(!bridge?.runCrystalModeling)throw Error('当前运行环境未提供晶体建模后端。');
        call?.signal.throwIfAborted();
        const result=await bridge.runCrystalModeling({...request,documentId:before.modelRef,expectedRevision:before.revision,structure:structuredClone(row.document.draft.structure)});
        call?.signal.throwIfAborted();ctx.assertTarget(before.modelRef,'read');
        if(!sameStructureContext(ctx.registry.document(before.modelRef),before))throw toolError('model-conflict','晶体检查期间模型已变化，请重新读取。');
        if(result.documentId!==before.modelRef||result.expectedRevision!==before.revision||result.operation!==request.operation)throw toolError('crystal-result-conflict','晶体检查回执不属于本次模型和版本。');
        return result;
      }
      return requirePort(row).inspectCrystal(row.document.revision,request);
    }),
    def('model_library','Find curated structures, built-in construction fragments or personal fragments.',{kind:enumeration('structure','fragment','personal'),query:stringSchema,category:{type:'string',enum:['all',...STRUCTURE_LIBRARY_CATEGORIES.map(category=>category.id)]}},[],async args=>{
      ctx.assertTarget(undefined,'read');
      const kind=args.kind===undefined?'structure':choice(args.kind,'kind','structure','fragment','personal');
      if(args.query!==undefined&&typeof args.query!=='string')throw Error('query 需要字符串。');
      const query=args.query?.trim()??'';
      if(kind==='fragment')return {entries:BUILDER_TEMPLATES.filter(item=>`${item.id} ${item.label} ${item.category??''} ${item.family??''}`.toLowerCase().includes(query.toLowerCase())).map(({id,label,category,family,connectionAnchor,independentOnly})=>({id,label,category,family,connectionAnchor,independentOnly}))};
      if(kind==='personal'){
        const bridge=desktopBridge();if(!bridge?.readPersonalFragments)throw Error('当前工作台没有个人片段存储。');
        const snapshot=await bridge.readPersonalFragments(),catalog=validatePersonalFragmentLibrary(snapshot.library);
        return {version:snapshot.version,writable:snapshot.writable,entries:catalog.fragments.filter(item=>`${item.name} ${item.category}`.toLowerCase().includes(query.toLowerCase())).map(({id,name,category,activeIndex})=>({id,name,category,activeIndex})),issue:snapshot.error};
      }
      const category=args.category===undefined?'all':choice(args.category,'category','all',...STRUCTURE_LIBRARY_CATEGORIES.map(item=>item.id));
      const catalog=await library.catalog();return {entries:searchStructureLibrary(catalog.entries,query,category),issues:catalog.issues};
    }),
    def('model_personal_library','Save a model fragment, replace an exact same-name entry, delete an exact entry, or import/export the personal catalogue value. Writes need expectedVersion from model_library.',{...fragmentScopeSchema,action:enumeration('save','delete','import','export'),expectedVersion:stringSchema,name:stringSchema,category:stringSchema,fragmentId:stringSchema,activeAtomIndex:revisionSchema,library:{type:'object'}},['action'],async(args,call)=>{
      const action=choice(args.action,'action','save','delete','import','export');
      ctx.assertTarget(undefined,action==='export'?'read':'edit');
      const bridge=desktopBridge();if(!bridge?.readPersonalFragments)throw Error('当前工作台没有个人片段存储。');
      const snapshot=await bridge.readPersonalFragments(),base=validatePersonalFragmentLibrary(snapshot.library);
      if(action==='export')return {version:snapshot.version,library:base};
      if(!bridge.updatePersonalFragments||!snapshot.writable)throw Error(snapshot.error??'当前个人片段库不可写入。');
      if(text(args.expectedVersion,'expectedVersion')!==snapshot.version)throw toolError('library-conflict','个人片段库已变化，请重新读取。',{version:snapshot.version});
      call?.signal.throwIfAborted();ctx.assertTarget(undefined,'edit');
      let next=base;
      if(action==='delete')next=deletePersonalFragment(base,text(args.fragmentId,'fragmentId'));
      else if(action==='import')next=importPersonalFragments(base,args.library);
      else{
        const row=target(args,'edit'),captured=captureFragment(args,row),replace=optionalText(args.fragmentId,'fragmentId');
        const fragment=createPersonalFragment(captured.fragment,{name:text(args.name,'name'),category:text(args.category,'category'),
          activeIndex:args.activeAtomIndex===undefined?undefined:integer(args.activeAtomIndex,'activeAtomIndex',0)});
        next=savePersonalFragment(base,fragment,replace);
      }
      const receipt=await bridge.updatePersonalFragments({baseVersion:snapshot.version,library:next});
      if(receipt.error)throw Error(receipt.error);
      return {status:'committed',version:receipt.version,entries:validatePersonalFragmentLibrary(receipt.library).fragments.map(({id,name,category})=>({id,name,category}))};
    }),
    def('model_library_open','Load a curated structure as a new model through ES, including its recorded source and normalization.',{entryId:stringSchema},['entryId'],async(args,call)=>{
      ctx.assertTarget(undefined,'edit');
      const before=ctx.registry.stamp(),catalog=await library.catalog(),id=text(args.entryId,'entryId');
      const entry=catalog.entries.find(item=>item.id===id||item.legacyIds?.includes(id));
      if(!entry)throw Error('结构库没有指定条目。');
      const structure=await library.structure(entry);
      call?.signal.throwIfAborted();ctx.assertTarget(undefined,'edit');ctx.registry.assertCurrent(before);
      await ctx.loadLibrary(entry,structure);
      const current=activeRef(),created=current?ctx.registry.document(current):undefined;
      if(!created||created.id===before.documentId||created.store.getSnapshot().draft.structure.libraryProvenance?.entryId!==entry.id)throw Error('未取得本次结构库载入的模型回执。');
      return {...stamp(created),entryId:entry.id};
    }),
    def('model_personal_fragment_place','Attach or place a personal fragment from the customer’s ES library using its saved geometry and connection anchor.',{...editSchema,...frameSchema,disposition,fragmentId:stringSchema,activeAtomIndex:integerSchema,...placementSchema},['expectedRevision','fragmentId','position'],async(args,call)=>{
      const before=editTarget(args),identity=stamp(before.entry);
      assertFrame(args,before);
      const bridge=desktopBridge();if(!bridge?.readPersonalFragments)throw Error('当前工作台没有个人片段存储。');
      const snapshot=await bridge.readPersonalFragments(),catalog=validatePersonalFragmentLibrary(snapshot.library),id=text(args.fragmentId,'fragmentId');
      const fragment=catalog.fragments.find(item=>item.id===id);if(!fragment)throw Error('个人库没有指定片段。');
      call?.signal.throwIfAborted();if(!sameStructureContext(ctx.registry.document(identity.modelRef),identity))throw Error('片段载入期间模型已变化。');
      const targetAtomId=optionalText(args.targetAtomId,'targetAtomId'),targetPortId=optionalText(args.targetPortId,'targetPortId');
      return runEdit({...args,modelRef:identity.modelRef},()=>[{type:'place-copied-fragment',payload:personalFragmentClipboard(fragment),activeIndex:args.activeAtomIndex===undefined?fragment.activeIndex:integer(args.activeAtomIndex,'activeAtomIndex',0),mode:targetAtomId||targetPortId?'graft':'independent',position:vector(args.position,'position'),targetAtomId,targetPortId}]);
    }),
    def('view_style','Read window structure display settings, or apply a preset and only the changed fields on its native display settings. Example patch: {representation:"ball-stick",backgroundColor:"#ffffff",atomScale:1.25,bondScale:0.8}. Use a six-digit CSS color with #. Patch takes the display fields directly.',{patch:{type:'object',properties:{representation:enumeration('vdw','ball-stick','stick'),backgroundColor:{...stringSchema,pattern:'^#[0-9a-fA-F]{6}$'},atomScale:numberSchema,bondScale:numberSchema},additionalProperties:true},preset:stringSchema,personalPreset:stringSchema},[],async(args,call)=>{
      ctx.assertTarget(undefined,'read');
      const previous=ctx.display();
      if(args.patch===undefined&&args.preset===undefined&&args.personalPreset===undefined)return {display:previous,presets:STRUCTURE_APPEARANCE_PRESETS.map(item=>item.id)};
      ctx.assertTarget(undefined,'view');
      let display=previous;
      if(args.preset!==undefined){
        if(!isSelectableStructureAppearancePreset(args.preset))throw Error('未知内置显示预设。');
        display=applyStructureAppearancePreset(display,args.preset);
      }
      if(args.personalPreset!==undefined){
        const name=text(args.personalPreset,'personalPreset'),preferences=await readModelDisplayPreferences();
        const preset=preferences.namedPresets?.find(item=>item.name===name);if(!preset)throw Error('未找到个人显示预设。');
        call?.signal.throwIfAborted();ctx.assertTarget(undefined,'view');
        if(ctx.display()!==previous)throw toolError('display-conflict','读取预设期间窗口显示已变化。');
        display=applyStructureAppearanceSnapshot(display,preset.appearance);
      }
      display=validateModelDisplay({...display,...(args.patch===undefined?{}:record(args.patch,'patch'))});
      await ctx.changeDisplay(display);
      return {status:'submitted',requestedDisplay:display,display:ctx.display()};
    }),
    def('view_camera','Read the live camera with action=read before a scientific-frame camera edit. Copy its modelRef, revision as expectedRevision, and exact frameKey. Rotate once with action=step and direction; use action=zoom with factor=1.2 for 20% magnification. The zoom receipt gives the actual multiplier and native limit. Restore an exact saved 8-number raw view with action=set.',{...editSchema,...frameSchema,action:enumeration('read','reset','standard','cell','step','set','zoom'),factor:{...numberSchema,exclusiveMinimum:0,description:'Relative native zoom multiplier, only for action=zoom. Example: 1.2 enlarges by 20%; 0.8 reduces by 20%.'},direction:enumeration('left','right','up','down'),preset:enumeration('a','a*','b','b*','c','c*'),view:{...numbersSchema,minItems:8,maxItems:8}},[],args=>{
      const action=args.action??'read';
      if(args.factor!==undefined&&action!=='zoom')throw toolError('INVALID_CAMERA_ARGUMENTS','factor 仅用于 action=zoom；读取视角或恢复 raw view 时请省略该字段。');
      const row=target(args,action==='read'?'read':'view');
      const view=row.controller?.getCameraView?.();
      if(action==='read')return {...stamp(row.entry),status:view?'ready':'preparing',frameKey:row.port?.frameKey(),view,perceivedDistance:row.controller?.getCameraZoomDistance?.()};
      assertFrame(args,row);
      const command=asCameraCommand(args),receipt=requirePort(row).camera(row.document.revision,command);
      if(command.kind==='zoom'){
        if(!receipt)throw toolError('CAMERA_ZOOM_UNAVAILABLE','目标视口未返回原生缩放回执。');
        return {...stamp(row.entry),status:'applied',frameKey:row.port?.frameKey(),command,...receipt};
      }
      return {...stamp(row.entry),status:'submitted',frameKey:row.port?.frameKey(),command,previousView:view};
    }),
    def('sketch_open','Open the window’s existing 2D molecular editor, retaining its draft and history.',{},[],async()=>{
      ctx.assertTarget(undefined,'view');ctx.openSketch();
      const current=await ctx.sketch()?.sketch.read();
      if(current?.status==='ready')return {status:'ready',draftId:current.snapshot.documentKey,revision:current.snapshot.revision};
      return {status:'opening'};
    }),
    def('sketch_read','Read the actual 2D editor KET, draft identity and revision, or opening status.',{},[],async()=>{
      ctx.assertTarget(undefined,'read');return await ctx.sketch()?.sketch.read()??{status:'closed'};
    }),
    def('sketch_stereochemistry','Read or toggle native 2D R/S labels and inspect each atom’s actual enhanced stereo group. ABS defines absolute stereo, AND a mixture, OR an unknown member. To change an explicitly selected group, pass atomRefs from this receipt and group:{type:"ABS"} or {type:"AND"|"OR",id:1}. The native editor commits one undo step with the existing drawn geometry and source.',
      {...sketchSchema,shown:booleanSchema,retry:booleanSchema,
        atomRefs:{type:'array',minItems:1,items:objectSchema({nodeId:stringSchema,atomIndex:revisionSchema},['nodeId','atomIndex'])},
        group:objectSchema({type:enumeration('ABS','AND','OR'),id:{...integerSchema,minimum:1}},['type'])},['draftId','expectedRevision'],args=>sketchOperation(async()=>{
        const owner=sketch(),draftId=text(args.draftId,'draftId'),expected=integer(args.expectedRevision,'expectedRevision',0);
        if((args.atomRefs===undefined)!==(args.group===undefined))throw toolError('invalid-sketch-stereo','修改立体组需要同时指定 atomRefs 和 group。');
        let revision=expected, edit:{draftId:string;revision:number;status:'committed'|'unchanged'}|undefined;
        let editedKet:string|undefined;
        if(args.group!==undefined){
          const current=await owner.read();
          if(current.status!=='ready'||current.snapshot.documentKey!==draftId||current.snapshot.revision!==expected||current.busy)throw toolError('sketch-conflict','二维草稿身份、版本或操作状态已变化，请重新读取。');
          const refs=list(args.atomRefs,'atomRefs').map(value=>{const ref=record(value,'atomRef');return {nodeId:text(ref.nodeId,'atomRef.nodeId'),atomIndex:integer(ref.atomIndex,'atomRef.atomIndex',0)};});
          const raw=record(args.group,'group'),type=choice(raw.type,'group.type','ABS','AND','OR');
          const ket=patchSketchStereoGroup(current.snapshot.ket,refs,{type,...(raw.id===undefined?{}:{id:integer(raw.id,'group.id',1)})});
          const applied=await owner.apply(draftId,expected,ket);
          revision=applied.revision;
          edit={draftId,revision,status:revision===expected?'unchanged':'committed'};
          editedKet=applied.ket;
        }
        try{
          const result=await owner.stereochemistry(draftId,revision,args.shown===undefined?undefined:boolean(args.shown,'shown'),args.retry===true);
          const current=await owner.read();
          if(current.status!=='ready'||current.snapshot.documentKey!==draftId||current.snapshot.revision!==revision)throw toolError('sketch-conflict','读取立体组时草稿已变化，请重新读取。');
          return {...record(result,'stereochemistry'),draftId,revision,edit,atoms:sketchStereoGroups(current.snapshot.ket)};
        }catch(error){
          if(!edit)throw error;
          return {...edit,edit,ket:editedKet,labelStatus:'unavailable',
            warning:error instanceof Error?error.message:String(error),recovery:{tool:'sketch_read',arguments:{}}};
        }
      })),
    exactlyOneInput(def('sketch_edit','Replace the drawn graph in the same 2D draft with one native undo step. Pass exactly one of ket (valid 2D coordinates) or smiles (native Indigo layout). The loaded source provenance is retained. Example: {draftId:"<from sketch_read>",expectedRevision:0,smiles:"c1ccccc1"}.',
      {...sketchSchema,ket:{...stringSchema,description:'Ketcher KET with finite atom location coordinates. Supply ket or smiles, never both.'},smiles:{...stringSchema,description:'SMILES to parse and lay out natively into the current draft. Example: c1ccccc1. Supply smiles or ket, never both.'}},['draftId','expectedRevision'],async(args,call)=>sketchOperation(async()=>{
      if((args.ket!==undefined)===(args.smiles!==undefined))throw toolError('INVALID_SKETCH_INPUT','请只提供 ket 或 smiles 中的一项，原草稿已保留。');
      const expected=integer(args.expectedRevision,'expectedRevision',0);
      const draftId=text(args.draftId,'draftId');
      if(args.smiles!==undefined&&typeof args.smiles!=='string')throw toolError('INVALID_SKETCH_SMILES','SMILES 需要字符串，原草稿已保留。');
      const {documentKey,revision,dirty,hasContent,ket}=args.smiles!==undefined
        ?await sketch().applySmiles(draftId,expected,args.smiles as string,call?.signal)
        :await sketch().apply(draftId,expected,text(args.ket,'ket'));
      return {draftId:documentKey,revision,dirty,hasContent,ket,status:revision===expected?'unchanged':'committed'};
    })),['ket','smiles']),
    def('sketch_history','Undo or redo in the native 2D editor history.',{...sketchSchema,direction:enumeration('undo','redo')},['draftId','expectedRevision','direction'],async args=>{
      const expected=integer(args.expectedRevision,'expectedRevision',0);
      const {documentKey,revision,dirty,hasContent,ket}=await sketch().history(text(args.draftId,'draftId'),expected,choice(args.direction,'direction','undo','redo'));
      return {draftId:documentKey,revision,dirty,hasContent,ket,status:revision===expected?'unchanged':'committed'};
    }),
    def('sketch_image','Read image orientation, crop, recognitionState and pendingCandidateId. When recognizing is busy, wait for the draft change before writing. A committed recognition is already applied; accept/discard only the exact pendingCandidateId of a review result. Set a crop in oriented pixels or recognize with the latest draft revision.',{...sketchSchema,action:enumeration('read','crop','recognize','accept','discard'),rectangle:cropSchema,replaceEdited:booleanSchema,candidateId:stringSchema},[],(args,call)=>sketchOperation(()=>{
      const action=args.action===undefined?'read':choice(args.action,'action','read','crop','recognize','accept','discard');
      if(action==='read'){ctx.assertTarget(undefined,'read');return ctx.sketch()?.sketch.image()??{status:'unavailable'};}
      const owner=sketch(),draftId=text(args.draftId,'draftId'),revision=integer(args.expectedRevision,'expectedRevision',0);
      if(action==='crop'){
        const value=args.rectangle===undefined?undefined:record(args.rectangle,'rectangle');
        const rectangle=value?{x:integer(value.x,'x',0),y:integer(value.y,'y',0),width:integer(value.width,'width',1),height:integer(value.height,'height',1)}:undefined;
        return {status:'committed',draftId,revision,crop:owner.setCrop(draftId,revision,rectangle)};
      }
      if(action==='recognize')return owner.recognize(draftId,revision,args.replaceEdited===undefined?false:boolean(args.replaceEdited,'replaceEdited'),call?.signal);
      return owner.resolveRecognition(draftId,revision,text(args.candidateId,'candidateId'),action==='accept');
    })),
    def('sketch_to_3d','Generate 3D through the current native 2D workflow. Defaults to a new model. Explicit replacement requires modelRef and modelRevision.',{...sketchSchema,...targetSchema,modelRevision:revisionSchema},['draftId','expectedRevision'],async(args,call)=>{
      const owner=sketch(),id=optionalText(args.modelRef,'modelRef'),modelRevision=args.modelRevision===undefined?undefined:integer(args.modelRevision,'modelRevision',0);
      if(Boolean(id)!==(modelRevision!==undefined))throw Error('替换模型需要同时指定 modelRef 和 modelRevision。');
      if(id)ctx.assertTarget(id,'edit');
      const guard=ctx.captureSketchGuard(id,modelRevision);
      const guarded=Object.assign(()=>{call?.signal.throwIfAborted();guard();},{target:guard.target});
      const created=await owner.generate(text(args.draftId,'draftId'),integer(args.expectedRevision,'expectedRevision',0),guarded,call?.signal);
      if(!created)throw Error('二维生成未取得模型提交回执。');
      return {...stamp(ctx.registry.document(created)),status:'committed',draftId:args.draftId,draftRevision:args.expectedRevision};
    }),
  ];
}
