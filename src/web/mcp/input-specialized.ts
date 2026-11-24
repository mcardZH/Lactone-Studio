import type { OrcaAsset, OrcaJobRequest, OrcaSettings } from '../../core/orca';
import type { GaussianSettings, Structure, TaskOptions } from '../../core/types';
import { coordinateAction, coordinateAtoms, defaultTaskOptions } from '../../core/tasks';
import { defaultAdvanced } from '../../core/advanced';
import { effectiveGaussianIntegral } from '../../core/gaussian';
import { safeOrcaFilename } from '../../core/orca/assets';
import { currentHessianSourceFields, defaultHessianPath, hessianPathContext, validateHessianPath } from '../../core/orca/hessian-path';
import { confirmCoordinateSelection, orcaScanRange } from '../../modeling/application/coordinate-selection';
import { updateOrcaFileReference } from '../orca/OrcaAssets';
import type { InputOrcaAssetEdit, InputOrcaAssetKind, InputOrcaHessianPatch, InputScanRow } from './input-drafts';
import { toolError } from './types';
import { mergeInputPatch } from './input-arguments';

/** A section's retained values and its effective writer values are distinct. */
export function gaussianParameterDraftPatch(settings:GaussianSettings,patch:NonNullable<GaussianSettings['parameterDrafts']>):Partial<GaussianSettings>{
  const advanced=settings.advanced??defaultAdvanced(settings.task),memory=settings.parameterDrafts??{};
  const merged=mergeInputPatch({...memory,
    ...(patch.scf?{scf:memory.scf??{enabled:true,advanced,scf:settings.scf}}:{}),
    ...(patch.integration?{integration:memory.integration??{enabled:true,grid:settings.grid,nosymm:settings.nosymm,integral:effectiveGaussianIntegral(settings)}}:{})
  },patch);
  const scf=patch.scf?.enabled===undefined?undefined:merged.scf;
  const integral=patch.integration?.enabled===undefined?undefined:merged.integration;
  let effective=advanced;
  if(scf){
    const active=scf.enabled?scf.advanced:{scfAlgorithm:'default' as const,noVarAcc:false,noIncFock:false,fermi:false,noDIIS:false,vshift:null,scfMaxCycle:null,maxConventional:null};
    const {scfAlgorithm,noVarAcc,noIncFock,fermi,noDIIS,vshift,scfMaxCycle,maxConventional}=active;
    effective={...effective,scfAlgorithm,noVarAcc,noIncFock,fermi,noDIIS,vshift,scfMaxCycle,maxConventional};
  }
  if(patch.vshiftEnabled!==undefined)effective={...effective,vshift:patch.vshiftEnabled?merged.vshift??effective.vshift??400:null};
  if(patch.scfMaxCycleEnabled!==undefined)effective={...effective,scfMaxCycle:patch.scfMaxCycleEnabled?merged.scfMaxCycle??effective.scfMaxCycle??256:null};
  return {parameterDrafts:merged,...(scf?{scf:scf.enabled?scf.scf:'default' as const}:{}),...(effective!==advanced?{advanced:effective}:{}),
    ...(integral?{integral:integral.enabled?integral.integral??{}:{},nosymm:integral.enabled&&integral.nosymm}:{})};
}

export function orcaParameterDraftPatch(settings:OrcaSettings,patch:NonNullable<OrcaSettings['parameterDrafts']>):Partial<OrcaSettings>{
  const memory=settings.parameterDrafts??{};
  const merged=mergeInputPatch({...memory,
    ...(patch.scf?{scf:memory.scf??{enabled:true,values:settings.scf??{}}}:{}),
    ...(patch.grid?{grid:memory.grid??{enabled:true,value:settings.grid??'auto'}}:{})
  },patch);
  return {parameterDrafts:merged,
    ...(patch.scf?.enabled===undefined?{}:{scf:merged.scf?.enabled?merged.scf.values:{}}),
    ...(patch.grid?.enabled===undefined?{}:{grid:merged.grid?.enabled?merged.grid.value:'auto'})};
}

function gaussianCoordinateRows(settings:GaussianSettings){
  const options=settings.taskOptions??defaultTaskOptions();
  return options.coordinateDrafts??options.coordinates.map((coordinate,index)=>({
    id:`coordinate-${index}`,type:coordinate.type,action:coordinateAction(coordinate,settings.task),atomText:coordinate.atoms.join(','),
    enabled:true,objectId:coordinate.objectId,stepsText:String(coordinate.steps),incrementText:coordinate.increment===null?'':String(coordinate.increment)
  }));
}

export function gaussianScanRead(settings:GaussianSettings,structure:Structure|null){
  return gaussianCoordinateRows(settings).filter(row=>row.action==='scan').map(row=>{
    try{
      const numbers=coordinateAtoms(row.atomText),ids=numbers.map(index=>structure?.atoms[index-1]?.id),
        increments=row.stepsText.trim()?Number(row.stepsText):null,increment=row.incrementText.trim()?Number(row.incrementText):null;
      return {...row,atomIds:ids,...(Number.isSafeInteger(increments)?{increments}:{}),...(Number.isFinite(increment)?{increment}:{})};
    }catch{return {...row,atomIds:[]};}
  });
}

export function gaussianScanOptions(settings:GaussianSettings,structure:Structure,rows:InputScanRow[]):TaskOptions{
  if(settings.task!=='scan')throw Error('请选择 Gaussian Scan 任务。');
  const options=settings.taskOptions??defaultTaskOptions(),existing=gaussianCoordinateRows(settings);
  const scans=rows.map(row=>{
    if(!('increments' in row))throw Error('Gaussian 使用从当前几何出发的增量次数与每次增量。');
    const coordinate=confirmCoordinateSelection(structure,row.atomIds);
    if(!Number.isSafeInteger(row.increments)||row.increments<1||!Number.isFinite(row.increment)||row.increment===0)
      throw Error('Gaussian 扫描需正整数增量次数和非零有限增量。');
    const atomText=coordinate.atoms.join(',');
    const match=existing.find(current=>current.action==='scan'&&current.type===coordinate.type&&current.atomText===atomText);
    return {id:match?.id??crypto.randomUUID(),type:coordinate.type,action:'scan' as const,atomText,enabled:true,
      ...(match?.objectId?{objectId:match.objectId}:{}),stepsText:String(row.increments),incrementText:String(row.increment)};
  });
  if(new Set(scans.map(row=>row.atomText)).size!==scans.length)throw Error('同一扫描内坐标请只提供一行。');
  return {...options,coordinateDrafts:[...existing.filter(row=>row.action!=='scan'),...scans]};
}

export function orcaScanSettings(settings:OrcaSettings,structure:Structure,rows:InputScanRow[]):OrcaSettings{
  if(settings.task!=='scan')throw Error('请选择 ORCA Scan 任务。');
  const scanned=rows.map(row=>{
    if('increments' in row)throw Error('ORCA 使用范围的总点数或显式数值表。');
    const coordinate=confirmCoordinateSelection(structure,row.atomIds);
    const range='values' in row?{values:row.values}:{start:row.start,end:row.end,steps:row.points};
    if(!orcaScanRange(range))throw Error('ORCA 扫描需有效起止值和总点数，或至少两个显式点值。');
    const prior=settings.constraints.find(item=>item.action==='scan'&&item.type===coordinate.type&&item.atomIds.join(',')===coordinate.atomIds.join(','));
    return {type:coordinate.type,atomIds:coordinate.atomIds,action:'scan' as const,...range,...(prior?.objectId?{objectId:prior.objectId}:{})};
  });
  if(new Set(scanned.map(row=>row.atomIds.join(','))).size!==scanned.length)throw Error('同一扫描内坐标请只提供一行。');
  return {...settings,constraints:[...settings.constraints.filter(row=>row.action!=='scan'),...scanned]};
}

export function orcaSelectedInputAsset(request:OrcaJobRequest,kind:InputOrcaAssetKind){
  return kind==='restart'?request.settings.md.restartAssetId:kind==='hessian'?request.settings.ircHessianId:request.settings.initialOrbitalsId;
}

export function canSelectOrcaHessian(task:OrcaSettings['task']){
  return task==='ts'||task==='irc';
}

export function hessianSelectionError(task:OrcaSettings['task'],assetId?:string){
  return toolError('HESSIAN_TASK_UNSUPPORTED','当前 ORCA 任务可留存 HESS，但初始 HESS 只在 TS 或 IRC 任务中选用。',{
    completion:'not_submitted',task,assetId,canRetain:true,canSelect:false,selectableTasks:['ts','irc']
  });
}

function bindAsset(request:OrcaJobRequest,kind:InputOrcaAssetKind,id?:string):OrcaJobRequest{
  const {task}=request.settings;
  if(id&&kind==='hessian'&&!canSelectOrcaHessian(task))throw hessianSelectionError(task,id);
  if(id&&kind==='restart'&&task!=='md')throw Error('仅 ORCA MD 任务读取 MD 重启。');
  if(kind==='restart')return {...request,settings:{...request.settings,md:{...request.settings.md,restartAssetId:id,restartConfirmed:false}}};
  return {...request,settings:{...request.settings,[kind==='hessian'?'ircHessianId':'initialOrbitalsId']:id}};
}

function patchHessian(request:OrcaJobRequest,asset:OrcaAsset,patch:InputOrcaHessianPatch):OrcaAsset{
  const {fromCurrent,path,...fields}=patch;
  const previous=fromCurrent?currentHessianSourceFields(request,asset):asset.hessianEvidence??{
    state:'',source:'',charge:NaN,multiplicity:NaN,geometryUnits:'bohr' as const,minimumConfirmed:false,atomOrderConfirmed:false
  };
  const oldPath=previous.path??defaultHessianPath(request),pathChanges=Object.keys(path??{}).filter(key=>!['compatibilityConfirmed','transitionStateConfirmed'].includes(key));
  const changed=fromCurrent||Object.keys(fields).length>0||pathChanges.length>0;
  const evidence={...previous,...fields,path:{...oldPath,...path,
    compatibilityConfirmed:path?.compatibilityConfirmed??(!changed&&oldPath.compatibilityConfirmed),
    transitionStateConfirmed:path?.transitionStateConfirmed??(!changed&&oldPath.transitionStateConfirmed),targetContext:changed?'':oldPath.targetContext}};
  const next={...asset,hessianEvidence:evidence};
  if(path?.compatibilityConfirmed===true||path?.transitionStateConfirmed===true){
    const targetContext=hessianPathContext(request,next);
    if(targetContext!==oldPath.targetContext){
      evidence.path.compatibilityConfirmed=path.compatibilityConfirmed===true;
      evidence.path.transitionStateConfirmed=path.transitionStateConfirmed===true;
    }
    evidence.path.targetContext=targetContext;
    const validation={...next,hessianEvidence:{...evidence,path:{...evidence.path,compatibilityConfirmed:true,transitionStateConfirmed:true}}};
    const problems=validateHessianPath(request,validation);
    if(problems.length)throw toolError('HESSIAN_EVIDENCE_INVALID','当前 HESS 文件与已声明的路径来源条件需要核对。',{issues:problems});
  }
  return next;
}

export function editOrcaInputAsset(request:OrcaJobRequest,edit:InputOrcaAssetEdit):OrcaJobRequest{
  if(edit.action==='clear')return bindAsset(request,edit.kind);
  if(edit.action==='reference'){
    const expected=edit.kind==='hessian'?/\.hess$/i:/\.gbw$/i;
    if(!safeOrcaFilename(edit.name)||!expected.test(edit.name))throw Error('依赖名称需为同目录安全文件名及对应扩展名。');
    if(edit.kind==='hessian'&&!canSelectOrcaHessian(request.settings.task))throw hessianSelectionError(request.settings.task);
    if(edit.kind==='hessian'){
      const sameName=request.assets.find(asset=>asset.name.toLowerCase()===edit.name.toLowerCase());
      if(sameName?.kind==='hessian')return bindAsset(request,edit.kind,sameName.id);
      if(sameName)throw toolError('INPUT_ASSET_NAME_CONFLICT','已有不同类型的同名依赖。',{
        completion:'not_submitted',name:edit.name,existing:{assetId:sameName.id,kind:sameName.kind},canReplace:false
      });
      const reference={id:crypto.randomUUID(),name:edit.name,kind:edit.kind};
      return bindAsset({...request,assets:[...request.assets,reference]},edit.kind,reference.id);
    }
    return updateOrcaFileReference(request,edit.kind,true,edit.name);
  }
  if(edit.action==='import'){
    const asset=edit.asset;
    if(!safeOrcaFilename(asset.name)||!['gbw','hessian','restart'].includes(asset.kind))throw Error('输入依赖文件名或类型不受支持。');
    const prior=request.assets.find(item=>item.name.toLowerCase()===asset.name.toLowerCase());
    // A name-only HESS reference has no bytes to overwrite. Binding imported
    // bytes uses a new identity so old scientific evidence is not inherited.
    const fillHessianReference=prior?.kind==='hessian'&&asset.kind==='hessian'&&prior.text===undefined&&!prior.sha256;
    if(prior&&(prior.kind!==asset.kind||!edit.replace&&!fillHessianReference))
      throw toolError('INPUT_ASSET_NAME_CONFLICT','已有同名输入依赖。已有文件的替换需要明确确认，同名依赖须为同类。',{
        completion:'not_submitted',name:asset.name,canReplace:prior.kind===asset.kind,existing:{
          assetId:prior.id,kind:prior.kind,sha256:prior.sha256??null,
          retention:prior.text!==undefined?'retained-text':prior.sha256?'identified-file':'reference-only',
          ...(prior.kind==='hessian'?{hasFileBytes:!!prior.text?.length}:{}),
          selected:orcaSelectedInputAsset(request,prior.kind as InputOrcaAssetKind)===prior.id
        }
      });
    const kind=asset.kind as InputOrcaAssetKind;
    const next={...request,assets:prior?request.assets.map(item=>item.id===prior.id?asset:item):[...request.assets,asset]};
    const selected=prior&&orcaSelectedInputAsset(request,kind)===prior.id;
    return edit.select?bindAsset(next,kind,asset.id):selected?bindAsset(next,kind):next;
  }
  const asset=request.assets.find(item=>item.id===edit.assetId);
  if(!asset)throw Error('未找到指定的输入依赖身份。');
  const kind=asset.kind as InputOrcaAssetKind;
  if(edit.action==='select')return bindAsset(request,kind,asset.id);
  if(edit.action==='remove'){
    const next={...request,assets:request.assets.filter(item=>item.id!==asset.id)};
    return orcaSelectedInputAsset(request,kind)===asset.id?bindAsset(next,kind):next;
  }
  let next=asset;
  if(edit.hessian&&asset.kind==='hessian')next=patchHessian(request,asset,edit.hessian);
  else if(edit.orbital&&asset.kind==='gbw'){
    const previous=asset.orbitalEvidence??{source:'',version:'6.1' as const,method:'',basis:'',charge:NaN,multiplicity:NaN,atomIds:[],compatibilityConfirmed:false};
    next={...asset,orbitalEvidence:{...previous,...edit.orbital,compatibilityConfirmed:edit.orbital.compatibilityConfirmed??false}};
  }else if(edit.restart&&asset.kind==='restart'){
    const previous=asset.restartEvidence??{taskIdentity:'',atomIds:[],conditionsConfirmed:false};
    next={...asset,restartEvidence:{...previous,...edit.restart,conditionsConfirmed:edit.restart.conditionsConfirmed??false}};
  }else throw Error('依赖类型与证据类型不一致。');
  return {...request,assets:request.assets.map(item=>item.id===asset.id?next:item)};
}

export function orcaInputAssetDetails(request:OrcaJobRequest){
  return request.assets.filter(asset=>['gbw','hessian','restart'].includes(asset.kind)).map(({text,...asset})=>({
    ...asset,retainedText:text!==undefined,selected:orcaSelectedInputAsset(request,asset.kind as InputOrcaAssetKind)===asset.id,
    ...(asset.kind==='hessian'?{canRetain:true,canSelect:canSelectOrcaHessian(request.settings.task),
      retention:text!==undefined?'retained-text':asset.sha256?'identified-file':'reference-only',
      hasFileBytes:!!text?.length,selectableTasks:['ts','irc']}:{}),
    ...(asset.kind==='hessian'&&asset.hessianEvidence?.path&&canSelectOrcaHessian(request.settings.task)
      ?{pathIssues:validateHessianPath(request,{...asset,text})}:{})
  }));
}
