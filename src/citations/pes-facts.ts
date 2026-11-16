import type { PesFrame, PesFrameIndex, PesProjectSnapshot, PesRun } from '../modeling/pes/contracts';
import { validPesPathRecord } from '../modeling/pes/path-records';
import { stableToken } from './identity';
import type { CitationFact } from './types';
import { gxtbRuntimeFacts, normalizeCitationMethod } from './workspace-facts';

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const positiveCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
type EvidenceFrame = PesFrame | PesFrameIndex;
const physicalFrame = (frame: PesFrame, atoms: number) =>
  Boolean(frame?.id && frame.seriesId && frame.phase !== 's-idpp' && frame.seriesId !== 's-idpp' &&
    Number.isFinite(frame.energyHartree) &&
    Array.isArray(frame.positions) && atoms > 0 && frame.positions.length === atoms &&
    frame.positions.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)));
const supported: Readonly<Partial<Record<PesRun['request']['operation'], readonly string[]>>> = {
  scan: ['slsqp', 'sella-scan'], ts: ['prfo', 'rfo', 'qn', 'dimer', 'climb'], hessian: ['numeric'],
  path: ['ci-neb', 'de-gsm', 'fsm'], explore: ['se-gsm', 'afir'],
};

/** CALC observes the existing optimizer. Its receipt, not the selected menu,
 * identifies the method and software; no PES solver is inferred from its page. */
function collectOrdinaryOptimization(run: PesRun, output: CitationFact[]) {
  const { request, result, source } = run;
  if (request.operation !== 'opt' || !result || !source.documentId ||
      !['completed','stopped','failed','interrupted'].includes(run.status)) return;
  const provenance = result.provenance;
  if (provenance.coordinateUnit !== 'angstrom' || provenance.energyUnit !== 'hartree') return;
  const finalObservation=record(result.finalObservation),finalAtoms=rows(record(result.finalStructure)?.atoms).map(record);
  const finalFrame=finalObservation&&finalAtoms.length===request.structure.atoms.length&&finalAtoms.every((atom,index)=>
    atom&&atom.id===request.structure.atoms[index].id&&atom.element===request.structure.atoms[index].element&&
    [atom.x,atom.y,atom.z].every(value=>typeof value==='number'&&Number.isFinite(value)))
    ?{...finalObservation,positions:finalAtoms.map(atom=>[atom!.x,atom!.y,atom!.z])} as unknown as PesFrame:undefined;
  const valid = [...result.frames,...(finalFrame?[finalFrame]:[])].filter(frame => physicalFrame(frame, request.structure.atoms.length));
  const fact = (frame: PesFrame, method: string, software: string | undefined, version: unknown, detail: unknown) => {
    const sourceId = `pes:${request.runIdentity.groupId}:${request.id}`;
    const base: Omit<CitationFact,'id'|'feature'> = {
      documentId:source.documentId,sourceId,taskId:request.runIdentity.taskId,jobId:request.id,frameId:frame.id,
      kind:'retained-result',stage:frame.phase,software,version:text(version),
      purpose:'CALC保留的普通优化结果；优化器与方法沿实际来源',
      evidence:[{kind:'metadata',locator:`${sourceId}:ordinary:${frame.id}`,detail:JSON.stringify(detail)}],
    };
    const add = (feature:string, value:string, entry=base) => output.push({...entry,feature,method:value,
      id:`citation:${stableToken(JSON.stringify([sourceId,frame.id,feature,value,entry.software,entry.version]))}`});
    add('method',normalizeCitationMethod(method,software));
    if(software){add('software',software);add('runtime-dependency',software,{...base,kind:'runtime-dependency'});}
    return {base,add};
  };
  if (request.algorithm === 'ordinary-xtb') {
    const input=record(provenance.nativeRequest),metadata=record(provenance.metadata),session=text(provenance.nativeSessionId);
    if(!session || input?.method!==request.method || input.calculation!=='optimize' ||
       record(input.stamp)?.documentId!==request.sourceDocumentId ||
       metadata && (metadata.engine!=='xtb'||metadata.method!==request.method))return;
    const frame=valid.find(row=>row.nativeSessionId===session||row.id===`${session}:final`);
    if(!frame)return;
    const {base,add}=fact(frame,request.method,'xTB',metadata?.version,{input,metadata,session,sourceRevision:source.revision});
    gxtbRuntimeFacts(output,base,request.method,metadata?.engineIdentity);
    const solvent=record(metadata?.solvation);
    if(solvent?.model==='alpb'&&solvent.sourceField==='stdout:solvation-model'&&text(solvent.solvent))add('solvation','alpb');
    return;
  }
  if(request.algorithm!=='workspace-forcefield'||provenance.driver!=='workspace-forcefield')return;
  const sessions=new Set(rows(provenance.phases).map(value=>text(record(value)?.sessionId)).filter(Boolean));
  for(const frame of valid){
    const method=text(frame.forcefield),engine=text(frame.engine);
    if(!method||!['uff','mmff94','mmff94s'].includes(method.toLowerCase())||!sessions.has(text(frame.nativeSessionId))||frame.hybridGeometry)continue;
    const software=engine&&/rdkit/i.test(engine)?'RDKit':undefined;
    const {base,add}=fact(frame,method,software,frame.engineVersion,{frame,phases:provenance.phases});
    if(text(frame.aseVersion))add('runtime-dependency','ASE',{...base,software:'ASE',version:text(frame.aseVersion),kind:'runtime-dependency'});
    break;
  }
}

function collectRun(run: PesRun, output: CitationFact[]) {
  if(run.request.operation==='opt'){collectOrdinaryOptimization(run,output);return;}
  const { request, result, source } = run;
  if (!result || !['completed', 'stopped', 'failed', 'interrupted'].includes(run.status) ||
      !Object.hasOwn(supported, request.operation) || !supported[request.operation]?.includes(request.algorithm) ||
      !source.documentId) return;
  const provenance = result.provenance;
  if (provenance?.energyUnit !== 'hartree' || provenance.coordinateUnit !== 'angstrom' ||
      provenance.algorithm !== undefined && provenance.algorithm !== request.algorithm ||
      provenance.sourceDocumentId !== undefined && provenance.sourceDocumentId !== request.sourceDocumentId) return;
  const { runId, taskId, groupId } = request.runIdentity;
  const count = request.structure.atoms.length;
  const pathRecords = (result.pathRecords ?? run.pathRecords ?? []).filter(validPesPathRecord);
  // Published path indexes have already passed the host's coordinate, identity
  // and checksum transaction. Citation usage consumes their independent energy
  // and stage evidence without reading or inventing lazy XYZ coordinates.
  const indexed = pathRecords.filter(path => path.kind !== 'initial').flatMap(path => path.frames.filter(frame => count > 0 &&
    frame.phase !== 's-idpp' && frame.seriesId !== 's-idpp' && Number.isFinite(frame.energyHartree)));
  const evidenceFrames: EvidenceFrame[] = [...result.frames.filter(frame => physicalFrame(frame, count)), ...indexed];
  const findFrame = (match: (frame: EvidenceFrame) => boolean) => evidenceFrames.find(match);
  const first = findFrame(() => true);
  if (!first) return;

  function add(feature: string, method: string, frame: EvidenceFrame, detail: Record<string, unknown>,
    purpose: string, software?: string, version?: unknown) {
    const sourceId = `pes:${groupId}:${runId}`;
    output.push({
      id: `citation:${stableToken(JSON.stringify([source.documentId, sourceId, feature, method, software, purpose]))}`,
      documentId: source.documentId, sourceId, taskId, jobId: runId, frameId: frame.id,
      kind: feature === 'runtime-dependency' ? 'runtime-dependency' : 'retained-result',
      feature, method, software, version: text(version), stage: frame.phase, purpose,
      evidence: [{ kind: 'metadata', locator: `${sourceId}:result:${frame.seriesId}:${frame.id}`,
        detail: JSON.stringify({ ...detail, ...(indexed.includes(frame as PesFrameIndex) ? {
          pathRecordId: pathRecords.find(path => path.frames.includes(frame as PesFrameIndex))?.id,
          coordinateEvidence: 'host-validated-path-record-index',
        } : {}), operation: request.operation, algorithm: request.algorithm,
          framePhase: frame.phase, frameStep: frame.step, energyHartree: frame.energyHartree, sourceRevision: source.revision }) }],
    });
  }
  const dependency = (name: string, version: unknown, frame: EvidenceFrame, detail: Record<string, unknown>, purpose: string) =>
    add('runtime-dependency', name, frame, detail, purpose, name, version);
  const method = (name: string, frame: EvidenceFrame, detail: Record<string, unknown>, purpose: string) =>
    add('pes-method', name, frame, detail, purpose);

  const resident = provenance.engine === 'libxtb' && ['gfn0', 'gfn1', 'gfn2', 'gfnff'].includes(request.method)
    && record(provenance.engineIdentity)?.provider === 'libxtb' && positiveCount(provenance.libxtbEvaluations);
  const native = provenance.engine === 'native-xtb' && positiveCount(provenance.physicalEvaluations);
  if ((native || resident) && provenance.method === request.method) {
    const evidence = { physicalEvaluations: provenance.physicalEvaluations, engine: provenance.engine,
      engineIdentity: provenance.engineIdentity, libxtbEvaluations: provenance.libxtbEvaluations,
      providerSettings: provenance.providerSettings, charge: provenance.charge, uhf: provenance.uhf };
    add('method', request.method === 'gfnff' ? 'gfn-ff' : `${request.method}-xtb`, first, evidence, 'PES 已保留帧的物理能量与梯度', 'xTB', provenance.version);
    add('software', 'xTB', first, evidence, 'PES 物理能量与梯度的 xTB 程序或库接口', 'xTB', provenance.version);
    const solvation = record(provenance.solvationEvidence);
    if (solvation?.model === 'alpb' && (native && solvation.sourceField === 'stdout:solvation-model'
      || resident && solvation.sourceField === 'libxtb:xtb_setSolvent') && text(solvation.solvent)) {
      add('solvation', 'alpb', first, solvation, 'PES 实际 xTB 输出或成功库求值确认的 ALPB 溶剂模型', 'xTB', provenance.version);
    }
  }

  if (request.operation === 'scan' && provenance.optimizer === 'scipy-slsqp') {
    const optimized = findFrame(frame => frame.phase === 'scan' && positiveCount(record(frame.optimizer)?.steps));
    if (optimized) dependency('scipy', provenance.scipyVersion, optimized, { optimizer: optimized.optimizer }, '使用 SciPy SLSQP 松弛扫描点');
  }
  if (request.operation === 'scan' && request.algorithm === 'sella-scan' && provenance.optimizer === 'sella') {
    const optimized = findFrame(frame => frame.phase === 'scan' && record(frame.optimizer)?.name === 'sella'
      && record(frame.optimizer)?.initialized === true);
    if (optimized) dependency('Sella', record(optimized.optimizer)?.version ?? provenance.optimizerVersion, optimized,
      { optimizer: optimized.optimizer, coordinateSystem: provenance.coordinateSystem, order: provenance.order },
      'Sella order=0 实际初始化并求解松弛扫描点');
  }
  if (request.operation === 'ts') {
    const optimized = findFrame(frame => frame.phase === 'ts' && positiveCount(frame.step));
    const curvature = rows(provenance.hessianEvents).find(event => record(event)?.use === 'sella-curvature-reset');
    const { optimizer, optimizerVersion } = provenance;
    if (optimizer === 'sella' && ['prfo', 'rfo', 'qn'].includes(request.algorithm) && (optimized || curvature)) {
      const evidence = { optimizer, acceptedGeometryStep: Boolean(optimized), curvature };
      dependency('Sella', optimizerVersion, optimized ?? first, evidence,
        optimized ? `Sella 的 ${request.algorithm} 过渡态优化` : '使用 Sella 接收数值曲率矩阵');
    } else if (optimized && request.algorithm === 'dimer' && optimizer === 'ase-improved-dimer') {
      method('dimer', optimized, { optimizer }, '改进 Dimer 过渡态优化');
      dependency('ASE', optimizerVersion, optimized, { optimizer }, 'ASE Dimer 的模态旋转与几何步');
    } else if (optimized && request.algorithm === 'climb' && optimizer === 'ase-bfgs-generalized-coordinate-climb') {
      dependency('ASE', optimizerVersion, optimized, { optimizer }, '指定内坐标爬坡的 ASE BFGS 优化');
    }
  }
  const hessian = record(result.hessian);
  if (hessian && (hessian.derivativeMethod === 'central-unprojected-physical-gradient-difference' ||
      hessian.derivativeMethod === 'native-xtb-unprojected-hessian.out') && Array.isArray(result.frequencies)) {
    const harmonic = findFrame(frame => frame.id === hessian.frameId);
    if (harmonic) {
      const evidence = { derivativeMethod: hessian.derivativeMethod, displacementBohr: hessian.displacementBohr };
      dependency('ASE', provenance.aseVersion, harmonic, evidence, '数值 Hessian 频率分析的原子质量数据');
      dependency('scipy', provenance.scipyVersion, harmonic, evidence, '数值 Hessian 频率分析的物理常数');
    }
  }
  if (request.operation === 'path') {
    const { driver, tangent, aseVersion } = provenance;
    const fsmEvidence = request.algorithm === 'fsm' ? provenance
      : request.algorithm === 'ci-neb' && provenance.pathInitializer === 'fsm'
        ? record(provenance.initializer) ?? provenance : undefined;
    if (fsmEvidence?.driver === 'two-ended freezing string' && fsmEvidence.optimizer === 'SciPy L-BFGS-B') {
      const node = findFrame(frame => frame.role === 'frozen-node' && positiveCount(frame.localEvaluations)
        && (request.algorithm === 'fsm' || frame.phase.startsWith('ci-fsm-initialization')));
      if (node) {
        const evidence = { driver: fsmEvidence.driver, optimizer: fsmEvidence.optimizer,
          localEvaluations: node.localEvaluations, purpose: request.algorithm === 'fsm' ? 'independent-path' : 'ci-neb-initializer' };
        method('fsm', node, evidence, request.algorithm === 'fsm' ? '冻结弦实际生长与优化局部节点' : 'FSM 实际生成 CI-NEB 初始路径');
        dependency('scipy', fsmEvidence.scipyVersion, node, evidence, 'FSM 使用 SciPy L-BFGS-B 优化节点');
      }
    }
    const segment = rows(record(provenance.sIdpp)?.segments).find(value => {
      const row = record(value);
      return row?.converged === true && typeof row.firstBead === 'number' &&
        typeof row.lastBead === 'number' && row.lastBead - row.firstBead > 1;
    });
    if (segment && [...result.frames, ...pathRecords.flatMap(path => path.frames)].some(frame => frame.phase === 's-idpp' && frame.initialAnchor === false)) {
      method('s-idpp', first, { segment }, 'S-IDPP 生成两端路径的初始几何');
    }
    if (request.algorithm === 'ci-neb' && ['ASE NEB/FIRE', 'ASE NEB/FIRE2'].includes(String(driver)) && tangent === 'improvedtangent') {
      const band = findFrame(frame => frame.phase === 'ci-neb-ordinary' || frame.phase === 'ci-neb-climb');
      if (band) {
        dependency('ASE', aseVersion, band, { driver, tangent }, 'ASE NEB 评估路径力');
        method('neb-improved-tangent', band, { tangent }, 'NEB 使用改进切向量估计');
        if (positiveCount(provenance.totalIterations)) {
          const optimizer = driver === 'ASE NEB/FIRE2' ? 'fire2' : 'fire';
          method(optimizer, band, { totalIterations: provenance.totalIterations, optimizer: provenance.optimizer },
            `${optimizer === 'fire2' ? 'FIRE2' : 'FIRE'} 更新 NEB 路径几何`);
        }
        const climb = findFrame(frame => frame.climbingImage === true);
        if (climb) method('ci-neb', climb, { climbActivation: provenance.climbActivation }, 'NEB 实际启用并评估爬坡珠子');
      }
    } else if (request.algorithm === 'de-gsm' && driver === 'pyGSM DE_GSM') {
      const grown = findFrame(frame => frame.phase.startsWith('de-gsm') && frame.role === 'grown-node');
      if (grown) {
        const evidence = { driver, growthRounds: provenance.growthRounds, optimizationRounds: provenance.optimizationRounds };
        method('de-gsm', grown, evidence, '双端生长弦生成并评估内部节点');
        dependency('pyGSM', provenance.pygsmVersion, grown, evidence, 'pyGSM 执行双端生长弦');
      }
    }
  }
  if (request.operation === 'explore') {
    const { driver } = provenance;
    if (request.algorithm === 'se-gsm' && driver === 'pyGSM-SE_GSM') {
      const grown = findFrame(frame => frame.phase === 'se-gsm-string' && positiveCount(frame.step));
      if (grown) {
        method('se-gsm', grown, { driver }, '单端生长弦生成并评估反应路径节点');
        dependency('pyGSM', provenance.pyGsmVersion, grown, { driver }, 'pyGSM 执行单端生长弦');
      }
    } else if (request.algorithm === 'afir' && driver === 'pysisyphus-sc-mc-afir') {
      const biased = findFrame(frame => frame.phase === 'afir-path' && Number.isFinite(frame.artificialEnergyHartree) &&
        Number.isFinite(frame.biasedEnergyHartree));
      if (biased) {
        const evidence = { driver, gammaKjMol: biased.gammaKjMol, artificialEnergyHartree: biased.artificialEnergyHartree };
        method('afir', biased, evidence, 'AFIR 实际评估人工力势及物理能量');
        dependency('pysisyphus', provenance.pysisyphusVersion, biased, evidence, 'pysisyphus 提供 AFIR 人工力');
        if (provenance.localOptimizer === 'ASE-FIRE') {
          dependency('ASE', provenance.aseVersion, biased, { ...evidence, optimizer: provenance.localOptimizer }, 'ASE FIRE 评估 AFIR 路径');
          const stepped = findFrame(frame => frame.phase === 'afir-path' && positiveCount(frame.optimizationStep));
          if (stepped) method('fire', stepped, { optimizationStep: stepped.optimizationStep }, 'FIRE 更新 AFIR 路径几何');
        }
      }
    }
  }
}

/** Read retained scientific evidence for citation collection, without starting or inspecting a live worker. */
export function collectPesCitationFacts(snapshot?: PesProjectSnapshot): CitationFact[] {
  const output: CitationFact[] = [];
  for (const group of snapshot?.groups ?? []) for (const run of Object.values(group.runs)) {
    if (run.request.runIdentity.groupId === group.id) collectRun(run, output);
  }
  return output;
}
