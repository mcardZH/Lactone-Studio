'use strict';
const { randomUUID } = require('node:crypto');
const { assert } = require('./security.cjs');
const { conformerPesRequest, acceptConformerPesResult, validateAdvancedXtbResult } = require('./conformer-batch-science-runtime.cjs');
const { NATIVE_RF_PRESETS } = require('./xtb-security.cjs');
const { XTB_METHOD_LABELS } = require('./xtb-capabilities.cjs');
const message = error => String(error?.message ?? error).slice(0,8192);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return{promise,resolve,reject}; }

function sharedConformerDiagnosticCode(...diagnostics) {
  const detail = diagnostics.filter(value => typeof value === 'string').join('\n');
  if (/\b(?:PES_SHARED_MEMORY|PES_RESOURCE_CLEANUP|XTB_RESOURCE_GRANT|ENOMEM|out of memory|memory allocation (?:error|failed|failure)|cannot allocate memory|failed to allocate memory|not enough memory|insufficient memory)\b|PES shared resource (?:grant|release)|受管全局资源授权回执/i.test(detail))
    return 'PES_SHARED_MEMORY';
  if (/\b(?:PES_SHARED_STORAGE|STORAGE_UNAVAILABLE|ENOSPC|EDQUOT|EACCES|EPERM|EROFS|EIO|permission denied|access (?:is )?denied|no space left|disk full|read-only file system|i\/o error|input\/output error)\b/i.test(detail))
    return 'PES_SHARED_STORAGE';
  if (/\b(?:PES_SHARED_RUNTIME|XTB_RUNTIME_[A-Z_]+|error while loading shared libraries|missing (?:parameter(?:s| file)?|dynamic librar(?:y|ies))|0xC0000135)\b|Trusted PES worker runtime|required xTB parameters|version does not match the trusted runtime|Native xTB version mismatch|native RF (?:preset or accuracy|terminal settings mismatch)|\bxTB 运行[库组][件]?不可用|需要可信的 xTB 命令行运行组件/i.test(detail))
    return 'PES_SHARED_RUNTIME';
}

function wholeBatchFailure(...diagnostics) {
  const detail=diagnostics.filter(value=>typeof value==='string').join('\n');
  return sharedConformerDiagnosticCode(...diagnostics)
    ?? (/\b(?:CONFORMER_BATCH_OWNER|XTB_OWNER_CLOSED|XTB_DISPOSED|NATIVE_CANCELLED|PORTABLE_BUSY)\b|\b(?:xTB|PES) owner (?:is |was )?(?:unavailable|closed)|closed xTB owner|(?:duplicate owned|run identity is already active or owned)|terminal (?:event |run )?identity mismatch/i.test(detail)
      ? 'CONFORMER_BATCH_OWNER' : undefined)
    ?? (/\b(?:XTB_BATCH_OUTPUT_LIMIT|XTB_OUTPUT_LIMIT: 整批候选)\b/i.test(detail)?'XTB_BATCH_OUTPUT_LIMIT':undefined);
}

function failureReason(primary, detail, fallback) {
  const description=[primary,detail].filter((value,index,items)=>value&&items.indexOf(value)===index).join('\n');
  return (description||fallback).slice(0,8192);
}

/** Trusted adapters reuse the ordinary PES optimization entry and the same scientific
 * acceptance bundle. A separate terminal promise breaks the durable-commit /
 * lease-release handshake without treating a kill request as native close. */
function createConformerBatchAdapter({ pes, xtb, assertCurrent = () => {}, createId = randomUUID }) {
  return function launch(owner,args) {
    const {input,identity,method}=args,sessionId=createId();
    assertCurrent(owner,input.source);
    const terminal=deferred(),ack=deferred();let closing,settled=false,nativeStarted=false;
    async function release(receipt) {
      if(receipt?.committed)ack.resolve({discardDiagnostics:receipt.preserveDiagnostics!==true});else ack.reject(Error(receipt?.error?.message??'Canonical batch result was not committed'));
      await closing;
    }
    function beforeStart() {
      try { assertCurrent(owner,input.source); }
      catch (error) { throw Object.assign(Error(message(error)),{code:'CONFORMER_BATCH_OWNER'}); }
    }
    function stopped(warning={}) {
      return {status:nativeStarted?'discarded':'pending',reason:{code:'CANCELLED',message:'构象优化已停止。'},...warning};
    }
    function failure({ code, message: summary, detail, warning={} }, fallbackCode) {
      const fatalCode=wholeBatchFailure(code,summary,detail);
      const description=failureReason(summary,detail,'构象共用优化执行失败。');
      if (method.backend==='xtb'&&!fatalCode) {
        terminal.resolve({status:'discarded',reason:{code:code??fallbackCode,message:description},...warning,preserveDiagnostics:true});
        return true;
      }
      terminal.reject(Object.assign(Error(description),{code:fatalCode??code??fallbackCode,nativeStarted,...warning}));
      return false;
    }
    function observeStart(starting) {
      // A genuine close/acknowledgement error remains fatal after the terminal
      // callback. Before it, a constructor/validation error can be local.
      closing=Promise.resolve(starting).catch(error=>{
        if(settled)throw error;
        settled=true;
        if(!failure({code:error?.code,message:message(error)},'XTB_CANDIDATE_START'))throw error;
      });
      void closing.catch(error=>terminal.reject(Object.assign(error,{nativeStarted})));
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
      &&same(request.resourceOverrides,method.options.resourceOverrides)
      &&request.netGpuBatchLimit===undefined
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
    if(method.optimizer.algorithm==='native-rf'){
      const preset=NATIVE_RF_PRESETS[method.optimizer.convergencePreset];
      assert(method.backend==='xtb'&&preset&&typeof xtb?.startBatch==='function','Dedicated native RF candidate adapter required');
      request.nativeOptimizationPreset=preset;
      // The stage already captured this choice and holds its trusted grant.
      delete request.resourceOverrides;
      const onTerminal=async event=>{
        nativeStarted=event.nativeStarted===true;settled=true;
        try {
          assert(event.sessionId===sessionId&&same(event.stamp,request.stamp)&&same(event.runIdentity,request.runIdentity)
            &&event.method===request.method,'Native RF terminal event identity mismatch');
          if(event.event==='completed'){
            const {metadata}=event;
            const structure=validateAdvancedXtbResult(request,event.coordinates,metadata,event.effectiveResources);
            assert(metadata.optimizer==='rf'&&metadata.nativeOptimizationPreset===preset&&metadata.electronicAccuracy===1,
              'Native RF terminal settings mismatch');
            const result={structure,energyHartree:metadata.energyHartree,metadata,resourceGrant:event.effectiveResources,sessionId,
              identity:{method:`${XTB_METHOD_LABELS[request.method]}:${metadata.version}`,solvent:request.solvation?`${request.solvation.model}:${request.solvation.solvent}`:'none',
                energyKind:request.method==='gfnff'?'forcefield-potential':'electronic',charge:request.charge,multiplicity:structure.multiplicity,
                settingsKey:JSON.stringify({constraints:request.constraints,frozenAtomIds:request.frozenAtomIds,runtime:metadata.engineIdentity,
                  nativeOptimizationPreset:metadata.nativeOptimizationPreset,electronicAccuracy:metadata.electronicAccuracy})}};
            terminal.resolve(metadata.converged&&!metadata.stepLimitExceeded?{status:'succeeded',result}:{status:'discarded',result,
              reason:{code:'XTB_STEP_LIMIT',message:`原生优化${metadata.converged?'已收敛':'未收敛'}，实际 ${metadata.iterations} 步，本级上限 ${metadata.maxSteps} 步。`},preserveDiagnostics:true});
          }else if(event.event==='stopped')terminal.resolve(stopped());
          else failure(event.error??{},'XTB_CANDIDATE_FAILED');
        }catch(error){failure({code:error?.code,message:message(error)},'XTB_CANDIDATE_RESULT');}
        return ack.promise;
      };
      try {
        const starting=xtb.startBatch(owner,request,sessionId,beforeStart,onTerminal,args.capturedRuntime);
        const closed=xtb.waitForSession(owner,sessionId);
        // Start validates before ownership exists. Preserve that original
        // rejection in preference to the missing-session look-up.
        void closed.catch(()=>{});
        observeStart(Promise.resolve(starting).then(()=>closed));
      }catch(error){observeStart(Promise.reject(error));}
      return{promise:terminal.promise,stop:async()=>{if(!settled)await xtb.command(owner,sessionId,{command:'stop'});else await closing;},release};
    }
    let sharedRequest;
    const onTerminal=async event=>{
      nativeStarted=event.nativeStarted;settled=true;
      const candidateFailure=event.candidateFailure;
      const warning = event.diagnosticWarning ? { diagnosticWarning: event.diagnosticWarning } : {};
      try {
        if(event.status==='completed'){
          const result=event.result,converged=result.status==='completed',frame=result.frames[0];
          assert((converged||result.status==='not-converged')&&result.frames.length===1,'Invalid shared optimization terminal inventory');
          const claimedSource=result.provenance?.sourceDocumentId;
          assert((claimedSource===undefined||claimedSource===sharedRequest.sourceDocumentId)
            &&(frame?.id===undefined||frame.id===`${sessionId}:opt:${frame.step}`),'Shared optimization terminal run identity mismatch');
          const accepted=acceptConformerPesResult(request,method.optimizer,sessionId,frame,result.provenance,converged,event.resourceGrant);
          const value={structure:accepted.structure,energyHartree:frame.energyHartree,sharedOptimization:accepted.evidence,
            resourceGrant:event.resourceGrant,sessionId,identity:accepted.identity};
          const invalidFixedAtom=method.backend==='xtb'&&accepted.evidence.maxFrozenDisplacementAngstrom>1e-7;
          if(invalidFixedAtom)terminal.resolve({status:'discarded',result:value,...warning,preserveDiagnostics:true,
            reason:{code:'XTB_CANDIDATE_RESULT',message:`本构象固定原子实际移动 ${accepted.evidence.maxFrozenDisplacementAngstrom} Å。`}});
          else terminal.resolve(converged?{status:'succeeded',result:value,...warning,
            ...(accepted.evidence.maxFrozenDisplacementAngstrom ? {preserveDiagnostics:true} : {})}:{status:'discarded',result:value,
            reason:{code:'PES_OPT_NOT_CONVERGED',message:`共用优化未收敛，实际 ${frame.step} 步。`},...warning,preserveDiagnostics:true});
        }else if(event.status==='stopped'){
          terminal.resolve(stopped(warning));
        }else {
          const code = event.error?.code ?? event.result?.error?.code;
          const sharedCode = wholeBatchFailure(code,event.error?.detail,event.error?.message,candidateFailure?.message);
          const eligible = nativeStarted && candidateFailure && !sharedCode && (!code
            || code === candidateFailure.code);
          if (eligible) terminal.resolve({status:'discarded',reason:{code:candidateFailure.code,message:message(candidateFailure)},...warning,preserveDiagnostics:true});
          else if(method.backend==='xtb'&&!sharedCode){
            terminal.resolve({status:'discarded',reason:{code:code??'XTB_CANDIDATE_FAILED',
              message:failureReason(event.error?.message,event.error?.detail,'构象共用优化执行失败。')},...warning,preserveDiagnostics:true});
          }else throw Object.assign(Error(event.error?.detail||event.error?.message||'构象共用优化执行失败。'),
            {code:sharedCode ?? code ?? 'CONFORMER_SHARED_OPT_FAILED',...warning});
        }
      }catch(error){
        failure({code:error?.code,message:message(error),warning},'XTB_CANDIDATE_RESULT');
      }
      return ack.promise;
    };
    try {
      sharedRequest=conformerPesRequest(request,method.optimizer,sessionId);
      observeStart(pes.startCandidate(owner,sharedRequest,request,beforeStart,onTerminal,args.capturedRuntime));
    }catch(error){observeStart(Promise.reject(error));}
    return{promise:terminal.promise,stop:async()=>{if(!settled)await pes.stop(owner,sharedRequest.runIdentity);else await closing;},release};
  };
}
module.exports={createConformerBatchAdapter,sharedConformerDiagnosticCode};
