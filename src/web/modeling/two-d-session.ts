/** Window-session facts only. Neither this gate nor its callers serialize a draft. */
export class TwoDAutomaticRecognitionGate {
  private sourceId:string|null=null;
  private claimed=false;
  replace(sourceId:string){if(this.sourceId===sourceId)return;this.sourceId=sourceId;this.claimed=false;}
  claim(sourceId:string){if(this.sourceId!==sourceId||this.claimed)return false;this.claimed=true;return true;}
  hasClaimed(sourceId:string){return this.sourceId===sourceId&&this.claimed;}
}
export function recognitionDelivery(input:{sourceId:string;currentSourceId:string;operationId:string;currentOperationId:string|null;aborted:boolean;startedRevision:number;currentRevision:number}):'discard'|'apply'|'pending'{
  if(input.aborted||input.sourceId!==input.currentSourceId||input.operationId!==input.currentOperationId)return'discard';
  return input.startedRevision===input.currentRevision?'apply':'pending';
}
