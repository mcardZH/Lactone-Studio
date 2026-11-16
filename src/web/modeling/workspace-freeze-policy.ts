import type {ModelCommand} from '../../modeling/contracts';
import type {AdvancedTaskRecord} from '../../modeling/advanced/contracts';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import type {WorkspaceDocumentEntry} from '../../modeling/workspace-registry';
import {conformerInitialDocument} from './workspace-conformer-initial-owner';
import {workspaceSourceGeometryKey} from './workspace-source-validity';
import {modelCoordinateKey} from '../../modeling/constraints';

/** Freeze commands are distinct from real geometry edits and never open a
 * result-copy prompt. The shell decides permission from the owning page role. */
export function isWorkspaceFreezeCommand(command:ModelCommand):boolean{
 return ['set-shared-atom-freeze','set-shared-freezes-enabled','replace-shared-atom-freezes','replace-shared-coordinate-freezes','set-shared-coordinate-freeze','clear-shared-freezes','delete-source-constraint'].includes(command.type);
}
interface ConformerPageEvidence {trajectory?:unknown;conformerGroup?:{role:string};legacyResult?:unknown;result?:unknown}
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'?value as Record<string,unknown>:undefined;
/** A generic trajectory field is not a conformer discriminator. Legacy pages
 * without the role marker need matching typed result and binding evidence. */
export function isConformerWorkspaceResult(entry:ConformerPageEvidence):boolean{
 if(entry.conformerGroup)return entry.conformerGroup.role==='collection';
 const binding=object(entry.trajectory),identity=object(binding?.identity),ids=binding?.frameIds;
 if(!identity||!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id))return false;
 const fields=['taskId','runId','stageId','collectionId'];
 if(fields.some(key=>typeof identity[key]!=='string'||!identity[key]))return false;
 return [entry.legacyResult,entry.result].some(value=>{const result=object(value),candidate=object(result?.identity),frameIds=result?.frameIds;
  return !!candidate&&fields.every(key=>candidate[key]===identity[key])&&Array.isArray(frameIds)&&frameIds.length===ids.length&&frameIds.every((id,index)=>id===ids[index]);});
}
export function workspaceFreezeEditingAllowed(entry:ConformerPageEvidence):boolean{
 return !isConformerWorkspaceResult(entry);
}

/** A denied F hold still owns its pointer gesture. Safe selection prevents a
 * click from falling through to an already selected modeling tool. `used`
 * also prevents release from becoming a fluorine element tap. */
export function readOnlyFreezeHold(key:string,freezeKey:string,allowed:boolean|undefined){
 return allowed===false&&key===freezeKey?{key,mode:'select' as const,used:true}:null;
}

/** Card edits and F edit the same Store metadata. No controller protection
 * transaction is involved, so existing runs/results retain their snapshots. */
interface ConformerFreezeOwnerInput {task:AdvancedTaskRecord|undefined;documents:readonly WorkspaceDocumentEntry[];activeDocumentId:string|null;source:AdvancedFrameSource;blocked?:boolean}
function currentConformerFreezeOwner(input:ConformerFreezeOwnerInput){
 const entry=conformerInitialDocument(input.task,input.documents),source=input.source;
 if(input.blocked||!entry||entry.id!==input.activeDocumentId||entry.conformerGroup?.role!=='initial'||entry.trajectory)throw Error('仅当前构象初始结构页可修改冻结原子。');
 if(entry.store.hasTransaction?.())throw Error('请先确认或取消初始结构的几何预览。');
 const document=entry.store.getSnapshot();
 if(source.ref.taskId||source.ref.runId||source.ref.collectionId||source.ref.frameId||source.ref.documentId!==entry.id||source.ref.documentEpoch!==entry.epoch||source.ref.revision!==document.revision||source.structure.charge!==document.draft.structure.charge||source.structure.multiplicity!==document.draft.structure.multiplicity||workspaceSourceGeometryKey(source.structure)!==workspaceSourceGeometryKey(document.draft.structure))throw Error('冻结所属初始结构已变化，请重新选择。');
 return {entry,document};
}
export function commitConformerInitialFreezes(input:ConformerFreezeOwnerInput&{atomIds:readonly string[]}):boolean{
 const {entry,document}=currentConformerFreezeOwner(input);
 const known=new Set(document.draft.structure.atoms.map(atom=>atom.id)),ids=[...input.atomIds];
 if(new Set(ids).size!==ids.length||ids.some(id=>!known.has(id)))throw Error('冻结原子选择含缺失或重复身份。');
 const previous=document.sharedConstraints?.frozenAtomIds??[];
 if(previous.length===ids.length&&ids.every(id=>previous.includes(id))&&(!ids.length||document.sharedConstraints?.enabled!==false))return true;
 const commands:ModelCommand[]=[{type:'replace-shared-atom-freezes',atomIds:ids}];
 if(ids.length&&document.sharedConstraints?.enabled===false)commands.push({type:'set-shared-freezes-enabled',enabled:true});
 if(entry.store.executeBatch)entry.store.executeBatch(commands,'修改构象初始冻结');
 else{entry.store.beginTransaction('修改构象初始冻结');try{for(const command of commands)entry.store.execute(command);entry.store.endTransaction();}catch(error){entry.store.cancelTransaction();throw error;}}
 return true;
}

/** The sampling card edits the same B/A/D Store objects as the modeling tools. */
export function commitConformerInitialCoordinateFreeze(input:ConformerFreezeOwnerInput&{coordinate:{type:'B'|'A'|'D';atomIds:string[]};frozen:boolean;previousCoordinate?:{type:'B'|'A'|'D';atomIds:string[]}}):boolean{
 const {entry,document}=currentConformerFreezeOwner(input),coordinate=input.coordinate;
 const known=new Set(document.draft.structure.atoms.map(atom=>atom.id));
 if(!['B','A','D'].includes(coordinate.type)||coordinate.atomIds.length!=={B:2,A:3,D:4}[coordinate.type]
  ||new Set(coordinate.atomIds).size!==coordinate.atomIds.length||coordinate.atomIds.some(id=>!known.has(id)))throw Error('内坐标冻结含缺失或重复原子身份。');
 if(input.previousCoordinate){
  if(!input.frozen)throw Error('替换内坐标须明确提交新冻结定义。');
  const previousKey=modelCoordinateKey(input.previousCoordinate),nextKey=modelCoordinateKey(coordinate),rows=document.sharedConstraints?.coordinates??[];
  const previous=rows.find(row=>modelCoordinateKey(row)===previousKey);
  if(!previous||previous.type!==input.previousCoordinate.type||JSON.stringify(previous.atomIds)!==JSON.stringify(input.previousCoordinate.atomIds))throw Error('原内坐标冻结已变化，请重新编辑。');
  if(rows.some(row=>modelCoordinateKey(row)!==previousKey&&modelCoordinateKey(row)===nextKey))throw Error('该内坐标已有冻结定义，请保留或解除相应条目后再编辑。');
  if(previous.type===coordinate.type&&JSON.stringify(previous.atomIds)===JSON.stringify(coordinate.atomIds))return true;
  // Exact reverse keeps the same physical target. A new path gets a new
  // object and takes its own current-value freeze, without renaming old objects.
  const replacement=nextKey===previousKey?{...previous,atomIds:[...coordinate.atomIds]}:{type:coordinate.type,atomIds:[...coordinate.atomIds],action:'freeze' as const,steps:1,increment:null};
  const commands:ModelCommand[]=[{type:'replace-shared-coordinate-freezes',coordinates:rows.map(row=>row===previous?replacement:row)}];
  if(document.sharedConstraints?.enabled===false)commands.push({type:'set-shared-freezes-enabled',enabled:true});
  if(entry.store.executeBatch)entry.store.executeBatch(commands,'修改构象初始内坐标冻结');
  else{entry.store.beginTransaction('修改构象初始内坐标冻结');try{for(const command of commands)entry.store.execute(command);entry.store.endTransaction();}catch(error){entry.store.cancelTransaction();throw error;}}
  return true;
 }
 const key=modelCoordinateKey(coordinate),existing=document.coordinateObjects?.find(object=>modelCoordinateKey(object)===key);
 if(input.frozen&&document.sharedConstraints?.coordinates.some(row=>modelCoordinateKey(row)===key))
  throw Error(document.sharedConstraints.enabled===false?'此内坐标已有保留定义，当前模型冻结已停用；请在输入文件的冻结卡启用模型冻结后再编辑。':'该内坐标已有冻结定义，请编辑现有条目。');
 const object=existing??{id:`conformer-coordinate-${crypto.randomUUID()}`,type:coordinate.type,atomIds:[...coordinate.atomIds]};
 entry.store.execute({type:'set-shared-coordinate-freeze',object,frozen:input.frozen});
 return true;
}
