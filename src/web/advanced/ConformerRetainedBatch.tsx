import { useEffect, useRef, useState } from 'react';
import type { AdvancedController } from '../../modeling/advanced/controller';
import type { AdvancedStageRun } from '../../modeling/advanced/contracts';
import { DismissibleNotice } from '../DismissibleNotice';
import { InputSettingsRow } from '../InputSettingsFields';
import { InputSettingsAction } from '../InputSettingsLayout';
import { confirmSynchronousOperation } from '../confirmation';
import {useGxtbBackend,gxtbRunBlocked,GxtbAvailability} from '../results/GxtbPathControl';

export default function ConformerRetainedBatch({ controller, taskId, runId, stage, active, busy }: {
  controller: AdvancedController; taskId: string; runId: string; stage: AdvancedStageRun; active: boolean; busy: boolean;
}) {
  const gxtbBackend=useGxtbBackend();
  const error = stage.adoptionError;
  const batchId = error?.batchId, detail = error?.message;
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [recoveryError,setRecoveryError]=useState('');
  const root=useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    setAvailable(false);
    if (active && !busy && !loading && batchId) {
      void controller.canReloadConformerBatch(taskId, runId, stage.id).then(value => { if (current) setAvailable(value); });
    }
    return () => { current = false; };
  }, [active, busy, loading, batchId, detail, controller, taskId, runId, stage.id]);
  if (!error) return null;

  const registered = new Set(stage.batchCandidateIds ?? stage.inputCandidateIds);
  const loaded = stage.results.filter(result => !result.reusedFromRunId && registered.has(result.candidateId)).length;
  const terminal = stage.batchProgress;
  const total = terminal ? terminal.succeeded + terminal.discarded : undefined;
  const summary = error.kind === 'integrity' ? '部分结果未通过校验，原始结果已保留。' : '结果未完成载入，计算结果已保留。';
  const continued=stage.projectResultContinuation;
  const recovery=active&&!busy&&!loading&&!continued&&error.kind!=='integrity'?controller.projectConformerRecoveryPreview(taskId,runId,stage.id):undefined;
  const recoveryBlocked=Boolean(recovery&&recovery.recalculate>0&&gxtbRunBlocked(gxtbBackend,recovery.method));
  function recover() {
    if(recoveryBlocked)return;
    if(!recovery||!confirmSynchronousOperation(`从项目内结果继续：复用已核实成功 ${recovery.completed} 项、已核实弃用 ${recovery.discarded} 项；其余 ${recovery.recalculate} 项没有可靠终态（含旧批取消或未提交项），将重新计算。旧批报错与原始记录继续保留。是否继续？`,root.current?.ownerDocument))return;
    try{controller.continueConformerFromProject(taskId,runId,stage.id);setRecoveryError('');}
    catch(error){setRecoveryError(error instanceof Error?error.message:String(error));}
  }
  async function reload() {
    setLoading(true);
    try { await controller.reloadConformerBatch(taskId, runId, stage.id); }
    catch { /* The result owner publishes the failure in this card. */ }
    finally { setLoading(false); }
  }
  return <div ref={root} data-testid="conformer-retained-batch">
    <DismissibleNotice identity={`${runId}:${batchId}:${detail}`}>{summary}</DismissibleNotice>
    <p role="status">已载入 {loaded}{total !== undefined ? ` / ${total}` : ''}</p>
    {continued&&<p role="status">已从项目内结果继续；旧批报错与原始记录保留。</p>}
    {recovery&&<p role="status">可复用成功 {recovery.completed} 项、弃用 {recovery.discarded} 项；未获可靠终态的 {recovery.recalculate} 项需重新计算。</p>}
    {recoveryError&&<DismissibleNotice identity={`${runId}:project-recovery:${recoveryError}`}>{recoveryError}</DismissibleNotice>}
    {recoveryBlocked&&<GxtbAvailability method={recovery!.method}/>}
    <InputSettingsRow>
      <InputSettingsAction disabled={!active || busy || !available || loading || !!continued} onClick={() => void reload()}>
        {loading ? '正在载入结果' : '重新载入结果'}
      </InputSettingsAction>
      {recovery&&<InputSettingsAction disabled={recoveryBlocked} onClick={recover}>从项目内结果继续</InputSettingsAction>}
      <details><summary>详情</summary><pre>{error.batchId}{'\n'}{error.message}</pre></details>
    </InputSettingsRow>
  </div>;
}
