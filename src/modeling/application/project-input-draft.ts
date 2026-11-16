import type {FileSettings,GaussianSettings,Structure,TaskId} from '../../core/types';
import type {ModelDocument} from '../../core/modeling/contracts';
import {METHODS} from '../../core/catalog';
import {isOptimizationTask,TASKS} from '../../core/tasks';
import {getOrcaMethods,ORCA_VERSIONS} from '../../core/orca/catalog';
import type {OrcaJobRequest,OrcaVersion} from '../../core/orca/types';
import type {OrcaGeneratedDrafts} from './orca-generated-draft';

export interface SavedGaussianInputDraft {
  settings:GaussianSettings;files:FileSettings;charge:number;multiplicity:number;stateConfirmed:boolean;frequencyConfirmed:boolean;
  cores:number;memory:number;resourcesConfirmed:boolean;sourceName:string;jobName:string;title:string;
  output:string;generatedName:string;generatedSignature:string;editorDirty:boolean;step:number;
  activeEngine?:'gaussian'|'orca';owner?:{documentId:string};
  naming?:{systemNameTouched:boolean;nameTouched:boolean;titleTouched:boolean};touched?:(keyof GaussianSettings)[];
  taskDrafts?:[string,unknown][];
}
export type SavedOrcaInputDraft=Omit<OrcaJobRequest,'structure'|'inputSources'>&{step:number;editorDirty:boolean;activeEngine?:'gaussian'|'orca';owner?:{documentId:string};naming?:{systemNameTouched:boolean;outputNameTouched:boolean;titleTouched:boolean};taskDrafts?:[string,unknown][];taskNaming?:[string,unknown][];generatedDrafts?:OrcaGeneratedDrafts};
export type ProjectInputEngine='gaussian'|'orca';
type ProjectInputDrafts=Partial<Record<ProjectInputEngine,unknown>>;
type DraftByEngine={gaussian:SavedGaussianInputDraft;orca:SavedOrcaInputDraft};
export type ProjectInputDraftIssues=Partial<Record<ProjectInputEngine,{message:string;raw:unknown}>>;
export const PROJECT_INPUT_ENGINES=['gaussian','orca'] as const;
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==='string');
const numbers=(value:unknown)=>Array.isArray(value)&&value.every(Number.isFinite);
const rows=(value:unknown,valid:(row:Record<string,unknown>)=>boolean)=>Array.isArray(value)&&value.every(row=>object(row)&&valid(row));
const pairs=(value:unknown)=>value===undefined||Array.isArray(value)&&value.every(row=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&object(row[1]));
const orcaCatalog=getOrcaMethods('6.1');
const orcaCoordinates=(value:unknown)=>rows(value,row=>strings(row.atomIds));
const orcaAssets=(value:unknown)=>rows(value,asset=>typeof asset.id==='string'&&typeof asset.name==='string'&&typeof asset.kind==='string'
  &&(asset.text===undefined||typeof asset.text==='string'));
const atomMapping=(value:unknown)=>rows(value,row=>typeof row.reactantId==='string'&&typeof row.productId==='string');

/** Check the shapes the form and its input projection dereference directly. */
function gaussianShape(value:Record<string,unknown>,settings:Record<string,unknown>){
  const options=settings.taskOptions,oniom=settings.oniom,mixed=settings.mixedBasis;
  const files=value.files;
  return object(files)&&['sourceElements','checkpointName','oldCheckpoint','hessian'].every(key=>typeof files[key]==='string')
    &&['customMethod','basis','solvent','solventModel'].every(key=>typeof settings[key]==='string')
    &&METHODS.some(method=>method.id===settings.method)&&(TASKS.some(task=>task.id===settings.task)||isOptimizationTask(settings.task as TaskId))
    &&['sourceName','jobName','title','output','generatedName','generatedSignature'].every(key=>typeof value[key]==='string')
    &&(value.touched===undefined||strings(value.touched))
    &&(settings.inheritanceIssues===undefined||rows(settings.inheritanceIssues,row=>typeof row.message==='string'))
    &&(options===undefined||object(options)&&rows(options.coordinates,row=>numbers(row.atoms))&&numbers(options.frozenAtoms)
      &&(options.inactiveFrozenAtoms===undefined||numbers(options.inactiveFrozenAtoms))&&rows(options.fragments,row=>numbers(row.atoms))
      &&['irc','excited','nmr','stable'].every(key=>object(options[key]))
      &&(options.coordinateDrafts===undefined||rows(options.coordinateDrafts,row=>['id','atomText','stepsText','incrementText'].every(key=>typeof row[key]==='string'))))
    &&(mixed===undefined||object(mixed)&&rows(mixed.regions,row=>typeof row.name==='string'&&typeof row.basis==='string'&&numbers(row.atoms)))
    &&(oniom===undefined||object(oniom)&&strings(oniom.qmAtomIds)&&object(oniom.atomTypes)&&object(oniom.partialCharges)
      &&rows(oniom.boundaries,row=>typeof row.qmAtomId==='string'&&typeof row.lowAtomId==='string')&&object(oniom.modelHigh)&&object(oniom.modelLow));
}
function orcaShape(value:Record<string,unknown>,settings:Record<string,unknown>){
  const {multiscale,md,neb}=settings;
  return ORCA_VERSIONS.includes(settings.version as OrcaVersion)
    &&orcaCatalog.some(method=>method.id===settings.method)&&orcaCatalog.some(method=>method.tasks.some(task=>task===settings.task))
    &&['basis','solvent'].every(key=>typeof settings[key]==='string')
    &&typeof value.name==='string'&&typeof value.title==='string'&&orcaAssets(value.assets)&&pairs(value.taskNaming)
    &&orcaCoordinates(settings.constraints)&&strings(settings.frozenAtomIds)&&rows(settings.fragments,row=>strings(row.atomIds))
    &&object(settings.excited)&&object(settings.esd)&&object(neb)&&atomMapping(neb.mapping)
    &&(neb.tsGuessMapping===undefined||atomMapping(neb.tsGuessMapping))
    &&object(md)&&strings(md.activeAtomIds)&&orcaCoordinates(md.constraints)
    &&object(multiscale)&&strings(multiscale.qmAtomIds)&&(multiscale.activeAtomIds===undefined||strings(multiscale.activeAtomIds))
    &&rows(multiscale.boundaries,row=>typeof row.qmAtomId==='string'&&typeof row.lowAtomId==='string');
}

const numericFields=(engine:ProjectInputEngine)=>['charge','multiplicity','cores',engine==='gaussian'?'memory':'memoryGB'];
function validateDraft(value:unknown,engine:ProjectInputEngine,documentId:string):Record<string,unknown>|undefined{
  if(value===undefined)return undefined;
  if(object(value)&&value.owner!==undefined&&(!object(value.owner)||value.owner.documentId!==documentId))throw new Error('项目输入草稿不属于当前模型。');
  if(!object(value)||!object(value.settings)||!Number.isInteger(value.step)||Number(value.step)<0||Number(value.step)>3
    ||numericFields(engine).some(key=>value[key]!==null&&!Number.isFinite(value[key]))
    ||value.activeEngine!==undefined&&value.activeEngine!=='gaussian'&&value.activeEngine!=='orca'||!pairs(value.taskDrafts)
    ||!(engine==='gaussian'?gaussianShape(value,value.settings):orcaShape(value,value.settings)))throw new Error(`项目${engine==='gaussian'?'Gaussian':'ORCA'}输入草稿不完整。`);
  if(engine==='orca'&&value.generatedDrafts!==undefined){
    if(!object(value.generatedDrafts))throw new Error('项目ORCA生成文本草稿不完整。');
    for(const generated of Object.values(value.generatedDrafts)){
      if(!object(generated)||typeof generated.sourceSignature!=='string'||!strings(generated.editedNames)||!orcaAssets(generated.assets)
        ||!rows(generated.files,file=>typeof file.name==='string'&&typeof file.text==='string'&&['input','structure','dependency'].includes(String(file.role)))
        ||generated.minimumVersion!==undefined&&typeof generated.minimumVersion!=='string'
        ||generated.issues!==undefined&&!rows(generated.issues,issue=>typeof issue.message==='string'))throw new Error('项目ORCA生成文本草稿不完整。');
    }
  }
  return value;
}
function readDraft<E extends ProjectInputEngine>(value:unknown,engine:E,document:ModelDocument):DraftByEngine[E]|undefined{
  const validated=validateDraft(value,engine,document.id);
  if(!validated)return undefined;
  const draft=structuredClone(validated);
  // Blank numeric controls serialize their NaN editing state as null. Restore
  // the blank state so an unfinished value continues to block confirmation.
  for(const key of numericFields(engine))if(draft[key]===null)draft[key]=Number.NaN;
  return draft as unknown as DraftByEngine[E];
}

function projectDrafts(gaussian:SavedGaussianInputDraft|undefined,orca:SavedOrcaInputDraft|undefined,document:ModelDocument){
  const activeEngine=gaussian?.activeEngine??orca?.activeEngine??(orca&&orca.step>0&&(!gaussian||gaussian.step===0)?'orca':'gaussian');
  const structure=document.draft.structure;
  const matches=(q:number,m:number)=>q===structure.charge&&m===structure.multiplicity;
  if(gaussian){const same=matches(gaussian.charge,gaussian.multiplicity);gaussian.stateConfirmed=gaussian.stateConfirmed&&same&&document.electronicStateConfirmed===true;if(!same)gaussian.frequencyConfirmed=false;gaussian.charge=structure.charge??gaussian.charge;gaussian.multiplicity=structure.multiplicity??gaussian.multiplicity;}
  if(orca){orca.electronicStateConfirmed=orca.electronicStateConfirmed===true&&matches(orca.charge,orca.multiplicity)&&document.electronicStateConfirmed===true;orca.charge=structure.charge??orca.charge;orca.multiplicity=structure.multiplicity??orca.multiplicity;}
  return {gaussian,orca,activeEngine,structure:structure as Structure};
}
/** Strict callers can reject the whole read before any publication. */
export function readProjectInputDrafts(drafts:ProjectInputDrafts|undefined,document:ModelDocument){
  return projectDrafts(readDraft(drafts?.gaussian,'gaussian',document),readDraft(drafts?.orca,'orca',document),document);
}

/** A bad engine form retains its original value independently of the other engine. */
export function readProjectInputDraftsForUi(drafts:ProjectInputDrafts|undefined,document:ModelDocument){
  const issues:ProjectInputDraftIssues={};
  function read<E extends ProjectInputEngine>(engine:E){
    const raw=drafts?.[engine];
    try{return readDraft(raw,engine,document);}
    catch(cause){issues[engine]={message:cause instanceof Error?cause.message:String(cause),raw};return undefined;}
  }
  const result=projectDrafts(read('gaussian'),read('orca'),document);
  // Navigation can be recovered independently of the rejected form data.
  function savedEngine(raw:unknown){
    const engine=object(raw)?raw.activeEngine:undefined;
    return engine==='gaussian'||engine==='orca'?engine:undefined;
  }
  const activeEngine=savedEngine(drafts?.gaussian)??savedEngine(drafts?.orca)??result.activeEngine;
  return {...result,activeEngine,issues};
}

/** Registry preflight checks retained values without cloning large input text. */
export function inspectProjectInputDraftIssues(drafts:ProjectInputDrafts|undefined,documentId:string):ProjectInputDraftIssues{
  const issues:ProjectInputDraftIssues={};
  for(const engine of PROJECT_INPUT_ENGINES){
    const raw=drafts?.[engine];
    try{validateDraft(raw,engine,documentId);}
    catch(cause){issues[engine]={message:cause instanceof Error?cause.message:String(cause),raw};}
  }
  return issues;
}
export function restoredOrcaProjectRequest(saved:SavedOrcaInputDraft,structure:Structure|null):OrcaJobRequest{
  const {step:_step,editorDirty:_dirty,activeEngine:_engine,owner:_owner,naming:_naming,taskDrafts:_tasks,taskNaming:_names,generatedDrafts:_generated,...request}=saved;
  return {...request,structure};
}
