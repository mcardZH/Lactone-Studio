'use strict';
const { randomUUID } = require('node:crypto');
const { assert } = require('./security.cjs');
const { conformerPesRequest, acceptConformerPesResult } = require('./conformer-batch-science-runtime.cjs');
const message = error => String(error?.message ?? error).slice(0,8192);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return{promise,resolve,reject}; }

/** Trusted adapters reuse the ordinary PES optimization entry and the same scientific
 * acceptance bundle. A separate terminal promise breaks the durable-commit /
 * lease-release handshake without treating a kill request as native close. */
function createConformerBatchAdapter({ pes, assertCurrent = () => {}, createId = randomUUID }) {
  return function launch(owner,args) {
    const {input,identity,method}=args,sessionId=createId();
    assertCurrent(owner,input.source);
    const terminal=deferred(),ack=deferred();let closing,settled=false,nativeStarted=false;
    async function release(receipt) {
      if(receipt?.committed)ack.resolve({discardDiagnostics:receipt.preserveDiagnostics!==true});else ack.reject(Error(receipt?.error?.message??'Canonical batch result was not committed'));
      await closing;
    }
    assert(method.backend === 'xtb' && method.optimizer,'Shared optimization batch settings are required');
    const request=structuredClone(input.request?.request);
    assert(input.request?.backend===method.backend&&request&&request.calculation==='optimize'&&request.method===method.options.method
      &&request.maxSteps===method.options.maxSteps&&request.optimizationStepPolicy===method.options.optimizationStepPolicy
      &&request.threads===1&&request.runIdentity?.taskId===identity.taskId&&request.runIdentity.runId===identity.runId
      &&request.optimizationPool?.stageId===identity.stageId&&request.optimizationPool.candidateId===input.candidateId
      &&request.stamp.documentId===input.source.stamp.documentId&&request.stamp.revision===input.source.stamp.revision
      &&same(request.structure.atoms,input.source.structure.atoms)&&same(request.structure.bonds,input.source.structure.bonds)
      &&same(request.structure.cell,input.source.structure.cell)&&same(request.structure.periodicSource,input.source.structure.periodicSource),
      'Batch optimization input/source/method identity mismatch');
    assert(same(request.solvation,method.options.solvation)&&request.charge===input.source.structure.charge
      &&request.structure.multiplicity===input.source.structure.multiplicity
      &&request.maxSccIterations===method.options.maxSccIterations
      &&request.device===undefined
      &&(!request.structure.cell?.pbc.some(Boolean)||request.method!=='gfnff'||request.ffModel),
      'Shared optimization electronics or solvation changed');
    const sourceConstraints = input.source.constraints;
    const effective = sourceConstraints.enabled === false ? { frozenAtomIds: [], coordinates: [] } : sourceConstraints;
    assert(same(request.frozenAtomIds, effective.frozenAtomIds) && request.constraints.length === effective.coordinates.length
      && request.constraints.every((row, index) => {
        const original = effective.coordinates[index];
        return row.type === original.type && row.action === 'freeze' && row.id === original.id
          && same(row.atomIds, original.atomIds) && same(row.images, original.images)
          && (original.value === undefined || row.value === original.value);
      }), 'Batch optimization freeze inventory differs from the source');
    const sharedRequest=conformerPesRequest(request,method.optimizer,sessionId);
    closing=pes.startCandidate(owner,sharedRequest,request,()=>assertCurrent(owner,input.source),async event=>{
      nativeStarted=event.nativeStarted;settled=true;
      const failure=event.candidateFailure;
      try {
        if(event.status==='completed'){
          const result=event.result,converged=result.status==='completed',frame=result.frames[0];
          assert((converged||result.status==='not-converged')&&result.frames.length===1,'Invalid shared optimization terminal inventory');
          const accepted=acceptConformerPesResult(request,method.optimizer,sessionId,frame,result.provenance,converged,event.resourceGrant);
          const value={structure:accepted.structure,energyHartree:frame.energyHartree,sharedOptimization:accepted.evidence,
            resourceGrant:event.resourceGrant,sessionId,identity:accepted.identity};
          terminal.resolve(converged?{status:'succeeded',result:value,
            ...(accepted.evidence.maxFrozenDisplacementAngstrom ? {preserveDiagnostics:true} : {})}:{status:'discarded',result:value,
            reason:{code:'PES_OPT_NOT_CONVERGED',message:`共用优化未收敛，实际 ${frame.step} 步。`},preserveDiagnostics:true});
        }else if(event.status==='stopped'){
          terminal.resolve({status:nativeStarted?'discarded':'pending',reason:{code:'CANCELLED',message:'构象优化已停止。'}});
        }else if(nativeStarted&&failure){
          terminal.resolve({status:'discarded',reason:{code:failure.code,message:message(failure)},preserveDiagnostics:true});
        }else throw Object.assign(Error(event.error?.detail||event.error?.message||'构象共用优化执行失败。'),
          {code:event.result?.error?.code??'CONFORMER_SHARED_OPT_FAILED'});
      }catch(error){terminal.reject(Object.assign(error,{nativeStarted}));}
      return ack.promise;
    },args.capturedRuntime);
    void closing.catch(error=>{settled=true;terminal.reject(Object.assign(error,{nativeStarted}));});
    return{promise:terminal.promise,stop:async()=>{if(!settled)await pes.stop(owner,sharedRequest.runIdentity);else await closing;},release};
  };
}
module.exports={createConformerBatchAdapter};
