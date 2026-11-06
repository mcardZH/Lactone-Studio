import type {FileSettings,GaussianSettings,Structure} from '../../core/types';
import type {ModelDocument} from '../../core/modeling/contracts';
import type {OrcaJobRequest} from '../../core/orca/types';
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
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
/** Read retained form state before mount effects can publish defaults. Source
 * identity and scientific q/M remain owned by the restored model document. */
export function readProjectInputDrafts(drafts:{gaussian?:unknown;orca?:unknown}|undefined,document:ModelDocument){
  function read<T>(value:unknown,engine:'gaussian'|'orca'):T|undefined{
    if(value===undefined)return undefined;
    if(!object(value)||!object(value.settings)||!Number.isInteger(value.step)||Number(value.step)<0||Number(value.step)>3||typeof value.settings.task!=='string'||typeof value.settings.method!=='string'||engine==='gaussian'&&!object(value.files))throw new Error(`项目${engine==='gaussian'?'Gaussian':'ORCA'}输入草稿不完整。`);
    if(object(value.owner)&&value.owner.documentId!==document.id)throw new Error('项目输入草稿不属于当前模型。');
    if(engine==='orca'&&value.generatedDrafts!==undefined){
      if(!object(value.generatedDrafts))throw new Error('项目ORCA生成文本草稿不完整。');
      for(const generated of Object.values(value.generatedDrafts)){
        if(!object(generated)||typeof generated.sourceSignature!=='string'||!Array.isArray(generated.files)||!Array.isArray(generated.editedNames)||generated.editedNames.some(name=>typeof name!=='string')||!Array.isArray(generated.assets)||generated.assets.some(asset=>!object(asset)||typeof asset.id!=='string'||typeof asset.name!=='string'||typeof asset.kind!=='string')||generated.files.some(file=>!object(file)||typeof file.name!=='string'||typeof file.text!=='string'||!['input','structure','dependency'].includes(String(file.role)))||generated.minimumVersion!==undefined&&typeof generated.minimumVersion!=='string'||generated.issues!==undefined&&(!Array.isArray(generated.issues)||generated.issues.some(issue=>!object(issue)||typeof issue.message!=='string')))throw new Error('项目ORCA生成文本草稿不完整。');
      }
    }
    return structuredClone(value) as T;
  }
  const gaussian=read<SavedGaussianInputDraft>(drafts?.gaussian,'gaussian'),orca=read<SavedOrcaInputDraft>(drafts?.orca,'orca');
  const activeEngine=gaussian?.activeEngine??orca?.activeEngine??(orca&&orca.step>0&&(!gaussian||gaussian.step===0)?'orca':'gaussian');
  const structure=document.draft.structure;
  const matches=(q:number,m:number)=>q===structure.charge&&m===structure.multiplicity;
  if(gaussian){const same=matches(gaussian.charge,gaussian.multiplicity);gaussian.stateConfirmed=gaussian.stateConfirmed&&same&&document.electronicStateConfirmed===true;if(!same)gaussian.frequencyConfirmed=false;gaussian.charge=structure.charge??gaussian.charge;gaussian.multiplicity=structure.multiplicity??gaussian.multiplicity;}
  if(orca){orca.electronicStateConfirmed=orca.electronicStateConfirmed===true&&matches(orca.charge,orca.multiplicity)&&document.electronicStateConfirmed===true;orca.charge=structure.charge??orca.charge;orca.multiplicity=structure.multiplicity??orca.multiplicity;}
  return {gaussian,orca,activeEngine,structure:structure as Structure};
}
export function restoredOrcaProjectRequest(saved:SavedOrcaInputDraft,structure:Structure|null):OrcaJobRequest{
  const {step:_step,editorDirty:_dirty,activeEngine:_engine,owner:_owner,naming:_naming,taskDrafts:_tasks,taskNaming:_names,generatedDrafts:_generated,...request}=saved;
  return {...request,structure};
}
