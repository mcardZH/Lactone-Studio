'use strict';
const { randomUUID } = require('node:crypto');
const { assert } = require('./security.cjs');
const { createAdvancedForcefieldAdapter, validateAdvancedXtbResult, effectiveSharedFreezes } = require('./conformer-batch-science-runtime.cjs');
const message = error => String(error?.message ?? error).slice(0,8192);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return{promise,resolve,reject}; }

/** Trusted adapters reuse the ordinary chemistry entry and the same TS science
 * acceptance bundle. A separate terminal promise breaks the durable-commit /
 * lease-release handshake without treating a kill request as native close. */
function createConformerBatchAdapter({ xtb, runChemistry, cancelChemistry, preserveFailure, assertCurrent = () => {}, createId = randomUUID }) {
  return function launch(owner,args) {
    const {input,identity,method,resources}=args,sessionId=createId();
    assertCurrent(owner,input.source);
    const terminal=deferred(),ack=deferred();let closing,settled=false,nativeStarted=false;
    async function release(receipt) {
      if(receipt?.committed)ack.resolve({discardDiagnostics:true});else ack.reject(Error(receipt?.error?.message??'Canonical batch result was not committed'));
      await closing;
    }
    if(method.backend==='xtb') {
      const request=structuredClone(input.request?.request);
      assert(input.request?.backend==='xtb'&&request&&request.calculation==='optimize'&&request.method===method.options.method
        &&request.maxSteps===method.options.maxSteps&&request.threads===1&&request.runIdentity?.taskId===identity.taskId&&request.runIdentity.runId===identity.runId
        &&request.optimizationPool?.stageId===identity.stageId&&request.optimizationPool.candidateId===input.candidateId
        &&request.stamp.documentId===input.source.stamp.documentId&&request.stamp.revision===input.source.stamp.revision
        &&same(request.structure.atoms,input.source.structure.atoms)&&same(request.structure.bonds,input.source.structure.bonds),'Batch xTB input/source/method identity mismatch');
      const starting=xtb.startBatch(owner,request,sessionId,()=>assertCurrent(owner,input.source),async event=>{
        nativeStarted=event.nativeStarted===true;settled=true;
        try {
          if(event.event==='completed'){
            const structure=validateAdvancedXtbResult(request,event.coordinates,event.metadata,event.effectiveResources);
            terminal.resolve({status:'succeeded',result:{structure,energyHartree:event.metadata.energyHartree,metadata:event.metadata,resourceGrant:event.effectiveResources,sessionId,
              identity:{method:`${{gfn0:'GFN0-xTB',gfn1:'GFN1-xTB',gfn2:'GFN2-xTB',gfnff:'GFN-FF'}[request.method]}:${event.metadata.version}`,solvent:request.solvation?`${request.solvation.model}:${request.solvation.solvent}`:'none',energyKind:request.method==='gfnff'?'forcefield-potential':'electronic',charge:request.charge,multiplicity:structure.multiplicity,settingsKey:JSON.stringify({constraints:request.constraints,frozenAtomIds:request.frozenAtomIds})}}});
          }else if(event.event==='stopped'||['XTB_STEP_LIMIT','XTB_NOT_CONVERGED'].includes(event.error?.code))terminal.resolve({status:nativeStarted?'discarded':'pending',reason:{code:event.error?.code??'CANCELLED',message:event.error?.message??event.reason??'Native optimization stopped'}});
          else terminal.reject(Object.assign(Error(event.error?.message??'Native optimization failed'),{code:event.error?.code??'XTB_BATCH_PROTOCOL',nativeStarted}));
        }catch(error){terminal.reject(Object.assign(error,{nativeStarted}));}
        return ack.promise;
      });
      const closed=xtb.waitForSession(owner,sessionId);
      closing=Promise.all([starting,closed]);void closing.catch(error=>terminal.reject(error));
      return{promise:terminal.promise,stop:async()=>{if(!settled)await xtb.command(owner,sessionId,{command:'stop'});else await closing;},release};
    }
    assert(method.backend==='forcefield','Unsupported optimization batch method');
    let rawSettled=false,nativeEvidence;
    const port={capabilities:async()=>({engine:'native-desktop',native:true,operations:['optimize']}),start(request){
      const raw=deferred();
      closing=runChemistry(owner,request,sessionId,{
        onStarted(){nativeStarted=true;},
        onNativeEvidence(value){nativeEvidence=value;},
        async onResult(value){rawSettled=true;raw.resolve(value);await ack.promise;},
        async onError(error){rawSettled=true;raw.reject(error);await ack.promise;},
      });void closing.catch(error=>raw.reject(error));
      return{promise:raw.promise,cancel:()=>cancelChemistry(owner,sessionId)};
    }};
    const adapter=createAdvancedForcefieldAdapter(port);
    const job=adapter.optimize({source:input.source,method:{...method,threads:1},taskId:identity.taskId,runId:identity.runId,
      optimizationPool:{stageId:identity.stageId,candidateId:input.candidateId},memoryBudgetBytes:resources?.memoryBudgetBytes});
    const promise=job.promise.then(value=>{
      settled=true;
      if(!value.converged)return{status:'discarded',reason:{code:'NOT_CONVERGED',message:'Native forcefield optimization did not converge'}};
      return{status:'succeeded',result:{structure:value.structure,energyHartree:value.energyHartree,resourceGrant:value.resourceGrant,sessionId,
        identity:{method:`${value.engine}:${value.version}:${value.forcefield}`,solvent:'none',energyKind:'forcefield-potential',charge:value.structure.charge,multiplicity:value.structure.multiplicity,settingsKey:JSON.stringify({energyKind:'forcefield-potential',actualForcefield:value.forcefield,constraints:effectiveSharedFreezes(input.source.constraints).coordinates,frozenAtomIds:[...effectiveSharedFreezes(input.source.constraints).frozenAtomIds]})}}};
    }).catch(async error=>{settled=true;if(/CHEMISTRY_CANCELLED|NATIVE_CANCELLED|力场优化已取消/.test(message(error)))return{status:nativeStarted?'discarded':'pending',reason:{code:'CANCELLED',message:message(error)}};await preserveFailure?.(owner,{schema:1,sessionId,identity,input,method,resources,nativeStarted,error:message(error),native:nativeEvidence});throw Object.assign(error,{nativeStarted});});
    return{promise,stop:async()=>{if(!rawSettled&&!settled)await job.stop();},release};
  };
}
module.exports={createConformerBatchAdapter};
