import type { Structure } from '../../core/types';
import type { WorkspaceActivationStamp } from '../workspace-contracts';

export interface InputExportGuardState<InputIdentity=WorkspaceActivationStamp> {
  alive:boolean;active:boolean;generation:number;documentId:string;revision:number;conditions:string;
  structure:Structure|null;
  runtimeOwner?:unknown;
  runtimeSessionId?:string;
  activationStamp?():InputIdentity;
  assertIdentityCurrent?(stamp:InputIdentity):void;
}
export interface GuardedInputRequest<T> {request:T;assertCurrent():void;snapshot?:InputExportSnapshot}
/** A detached MD frame belongs to its unchanged working source, not the live Store geometry. */
export interface InputExportSnapshot { structure:Structure;seq?:number;sessionId?:string;detached?:true;workingSource?:{documentId:string;revision:number} }
const structureIdentity=(structure:Structure|null)=>JSON.stringify(structure&&[structure.id,structure.atoms.map(atom=>[atom.id,atom.element,atom.formalCharge??0,atom.x,atom.y,atom.z]),structure.bonds??[],structure.cell??null,structure.charge,structure.multiplicity,structure.dimension]);
const graphIdentity=(structure:Structure|null)=>JSON.stringify(structure&&[structure.id,structure.atoms.map(({x:_x,y:_y,z:_z,...atom})=>atom),structure.bonds??[],structure.cell??null,structure.charge,structure.multiplicity,structure.dimension]);

/** Pause may commit a final frame. Only that boundary admits a new revision;
 * after sealing, every continuation must retain its exact document and settings. */
export function createInputExportGuard<InputIdentity=WorkspaceActivationStamp>(read:()=>InputExportGuardState<InputIdentity>) {
  const start={...read()},startStructure=structureIdentity(start.structure),lease=start.activationStamp?.();let sealedRevision:number|undefined,sealedStructure:string|undefined;
  function checkIdentity(){
    const current=read();
    if(!current.alive||!current.active||current.generation!==start.generation||current.documentId!==start.documentId||current.runtimeOwner!==start.runtimeOwner||current.runtimeSessionId!==start.runtimeSessionId)throw new Error('输入准备期间文档、引擎或活动视图已变化，请重新生成或导出。');
    if(lease){if(!current.assertIdentityCurrent)throw new Error('输入导出的活动身份校验不可用。');current.assertIdentityCurrent(lease);}
    if(current.conditions!==start.conditions)throw new Error('等待期间输入条件或编辑文本已变化，请核对后重新生成或导出。');
    return current;
  }
  checkIdentity();
  function afterPause(snapshot?:Structure){
      const current=checkIdentity();
      if(snapshot){if(structureIdentity(snapshot)!==structureIdentity(current.structure))throw new Error('暂停快照与当前文档不一致，未导出。');}
      else if(current.revision!==start.revision||structureIdentity(current.structure)!==startStructure)throw new Error('等待期间模型已变化，未取得对应暂停快照。');
      sealedRevision=current.revision;sealedStructure=structureIdentity(current.structure);
  }
  return {
    afterPause,
    afterSnapshot(snapshot?:InputExportSnapshot){
      if(!snapshot?.detached){afterPause(snapshot?.structure);return;}
      const current=checkIdentity(),source=snapshot.workingSource;
      if(!source||source.documentId!==start.documentId||source.revision!==start.revision||current.revision!==start.revision||structureIdentity(current.structure)!==startStructure)throw new Error('MD快照的工作源已变化，请重新捕获。');
      if(!start.runtimeOwner||!start.runtimeSessionId||snapshot.sessionId!==start.runtimeSessionId||!Number.isSafeInteger(snapshot.seq)||snapshot.seq!<0)throw new Error('MD快照的运行身份或帧序号不符，请重新捕获。');
      if(graphIdentity(snapshot.structure)!==graphIdentity(current.structure)||snapshot.structure.atoms.some(atom=>![atom.x,atom.y,atom.z].every(Number.isFinite)))throw new Error('MD快照的原子、连接或电子态与工作源不一致。');
      sealedRevision=current.revision;sealedStructure=startStructure;
    },
    assertCurrent(){const current=checkIdentity();if(sealedRevision===undefined||current.revision!==sealedRevision||structureIdentity(current.structure)!==sealedStructure)throw new Error('导出快照之后模型已变化，请重新生成或导出。');},
  };
}
