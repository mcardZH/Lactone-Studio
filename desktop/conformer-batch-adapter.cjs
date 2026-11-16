'use strict';
const { randomUUID } = require('node:crypto');
const { assert } = require('./security.cjs');
const { XTB_METHOD_LABELS } = require('./xtb-capabilities.cjs');
const { createAdvancedForcefieldAdapter, validateAdvancedXtbResult, effectiveSharedFreezes } = require('./conformer-batch-science-runtime.cjs');
const message = error => String(error?.message ?? error).slice(0,8192);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const localXtbFailures = new Set(['XTB_CANDIDATE_SCC', 'XTB_CANDIDATE_GEOMETRY', 'XTB_CANDIDATE_OPTIMIZER', 'XTB_CANDIDATE_RESULT']);
const localForcefieldFailures = new Set(['fractional-parameterization', 'parameterization', 'constraint-geometry',
  'constraint-solver', 'constraint-residual', 'energy', 'gradient', 'coordinates', 'fixed-atom-moved']);
function ownedForcefieldFailure(evidence,input,code){
  if(!['forcefield-numerical','graph-change'].includes(code)||evidence?.code!==1||evidence.signal!==null
    ||!same(evidence.request?.stamp,input.source.stamp)||evidence.request?.operation!=='optimize')return false;
  try{
    const result=JSON.parse(evidence.stdout);
    return same(result.stamp,input.source.stamp)&&result.operation==='optimize'&&result.error?.code===code
      &&(code==='graph-change'||['initialize','initial-energy','minimize','final-energy','constraint-energy','constraint-gradient','constraint-minimize'].includes(result.error.diagnostic?.phase));
  }catch{return false;}
}
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
      if(receipt?.committed)ack.resolve({discardDiagnostics:receipt.preserveDiagnostics!==true});else ack.reject(Error(receipt?.error?.message??'Canonical batch result was not committed'));
      await closing;
    }
    if(method.backend==='xtb') {
      const request=structuredClone(input.request?.request);
      assert(input.request?.backend==='xtb'&&request&&request.calculation==='optimize'&&request.method===method.options.method
        &&request.maxSteps===method.options.maxSteps&&request.optimizationStepPolicy===method.options.optimizationStepPolicy
        &&request.threads===1&&request.runIdentity?.taskId===identity.taskId&&request.runIdentity.runId===identity.runId
        &&request.optimizationPool?.stageId===identity.stageId&&request.optimizationPool.candidateId===input.candidateId
        &&request.stamp.documentId===input.source.stamp.documentId&&request.stamp.revision===input.source.stamp.revision
        &&same(request.structure.atoms,input.source.structure.atoms)&&same(request.structure.bonds,input.source.structure.bonds),'Batch xTB input/source/method identity mismatch');
      const starting=xtb.startBatch(owner,request,sessionId,()=>assertCurrent(owner,input.source),async event=>{
        nativeStarted=event.nativeStarted===true;settled=true;
        try {
          if(event.event==='completed'){
            const structure=validateAdvancedXtbResult(request,event.coordinates,event.metadata,event.effectiveResources);
            const converged=event.metadata.converged;
            if(!converged||event.metadata.stepLimitExceeded===true){
              terminal.resolve({status:'discarded',reason:{code:'XTB_STEP_LIMIT',message:`原生优化${converged?'已收敛':'未收敛'}，实际${event.metadata.iterations}步，本级上限${event.metadata.maxSteps}步；本候选已弃用。`},preserveDiagnostics:true});
            }else terminal.resolve({status:'succeeded',
              result:{structure,energyHartree:event.metadata.energyHartree,metadata:event.metadata,resourceGrant:event.effectiveResources,sessionId,
              identity:{method:`${XTB_METHOD_LABELS[request.method]}:${event.metadata.version}`,solvent:request.solvation?`${request.solvation.model}:${request.solvation.solvent}`:'none',energyKind:request.method==='gfnff'?'forcefield-potential':'electronic',charge:request.charge,multiplicity:structure.multiplicity,settingsKey:JSON.stringify({constraints:request.constraints,frozenAtomIds:request.frozenAtomIds,runtime:event.metadata.engineIdentity})}}});
          }else if(event.event==='stopped'||['XTB_STEP_LIMIT','XTB_NOT_CONVERGED'].includes(event.error?.code))terminal.resolve({status:nativeStarted?'discarded':'pending',reason:{code:event.error?.code??'CANCELLED',message:event.error?.message??event.reason??'Native optimization stopped'}});
          else if(nativeStarted&&localXtbFailures.has(event.error?.code))terminal.resolve({status:'discarded',reason:{code:event.error.code,message:message(event.error)},preserveDiagnostics:true});
          else terminal.reject(Object.assign(Error(event.error?.message??'Native optimization failed'),{code:event.error?.code??'XTB_BATCH_PROTOCOL',nativeStarted}));
        }catch(error){terminal.reject(Object.assign(error,{nativeStarted}));}
        return ack.promise;
      },args.capturedRuntime);
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
    const promise=job.promise.then(async value=>{
      settled=true;
      if(!value.converged){
        await preserveFailure?.(owner,{schema:1,sessionId,identity,input,method,resources,nativeStarted,error:'Force-field optimization did not converge',native:nativeEvidence});
        return{status:'discarded',reason:{code:'FORCEFIELD_NOT_CONVERGED',message:'力场优化未收敛，本候选已弃用。'},preserveDiagnostics:true};
      }
      return{status:'succeeded',
        result:{structure:value.structure,energyHartree:value.energyHartree,resourceGrant:value.resourceGrant,sessionId,
        ...(value.optimization?{forcefieldOptimization:value.optimization}:{}),
        identity:{method:`${value.engine}:${value.version}:${value.forcefield}`,solvent:'none',energyKind:'forcefield-potential',charge:value.structure.charge,multiplicity:value.structure.multiplicity,settingsKey:JSON.stringify({energyKind:'forcefield-potential',actualForcefield:value.forcefield,constraints:effectiveSharedFreezes(input.source.constraints).coordinates,frozenAtomIds:[...effectiveSharedFreezes(input.source.constraints).frozenAtomIds]})}}};
    }).catch(async error=>{
      settled=true;
      const detail=message(error);
      if(/CHEMISTRY_CANCELLED|NATIVE_CANCELLED|力场优化已取消/.test(detail))
        return{status:nativeStarted?'discarded':'pending',reason:{code:'CANCELLED',message:detail}};
      await preserveFailure?.(owner,{schema:1,sessionId,identity,input,method,resources,nativeStarted,error:detail,native:nativeEvidence});
      const code=error?.code??/^([a-z-]+):/.exec(detail)?.[1];
      if(nativeStarted&&(localForcefieldFailures.has(code)||ownedForcefieldFailure(nativeEvidence,input,code)))
        return{status:'discarded',reason:{code,message:detail},preserveDiagnostics:true};
      throw Object.assign(error,{nativeStarted});
    });
    return{promise,stop:async()=>{if(!rawSettled&&!settled)await job.stop();},release};
  };
}
module.exports={createConformerBatchAdapter};
