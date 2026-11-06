import type { OrcaJobRequest, OrcaRenderContext, OrcaTaskRender, OrcaAsset } from './types';
import { dependencyFile, hessianMatchesGeometry, inspectOrcaHessian, safeOrcaFilename } from './assets';
import { ELEMENTS } from '../elements';
import { renderOrcaNeb } from './neb';

const empty = (): OrcaTaskRender => ({ keywords: [], blocksBeforeCoordinates: [], blocksAfterCoordinates: [], files: [], issues: [] });
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const integer = (n: unknown): n is number => positive(n) && Number.isInteger(n);
const issue = (result: OrcaTaskRender, field: string, message: string): void => { result.issues.push({ field, message, severity: 'error' }); };

function renderNeb(req: OrcaJobRequest, ctx: OrcaRenderContext): OrcaTaskRender {
  return renderOrcaNeb(req, ctx);
}

function renderEsd(req: OrcaJobRequest, ctx: OrcaRenderContext): OrcaTaskRender {
  const result = empty();
  const settings = req.settings.esd;
  const channel = settings.channel;
  if (!['abs', 'fluor', 'phosp', 'ic', 'isc'].includes(channel)) { issue(result, 'esd.channel', '未知ESD通道。'); return result; }
  if (!finite(settings.temperatureK) || settings.temperatureK < 0) issue(result, 'esd.temperatureK', 'ESD温度必须由用户给出，不能套用程序默认温度。');
  const state = (label: string): string => label.trim().toUpperCase();
  const initial = state(settings.initialState);
  const final = state(settings.finalState);
  const statePattern = /^(S[0-9]+|T[1-9][0-9]*)$/;
  if (!statePattern.test(initial) || !statePattern.test(final) || initial === final) issue(result, 'esd.initialState', '必须明确两个不同物理态，如S0/S1/T1。');
  if (channel === 'abs' && (initial !== 'S0' || !/^S[1-9][0-9]*$/.test(final))) issue(result, 'esd.channel', 'ABS要求S0到指定激发单重态。');
  if ((channel === 'fluor' || channel === 'ic') && (!/^S[1-9][0-9]*$/.test(initial) || final !== 'S0')) issue(result, 'esd.channel', 'FLUOR/IC要求指定激发单重态到S0。');
  if (channel === 'phosp' && (initial !== 'T1' || final !== 'S0')) issue(result, 'esd.channel', '本PHOSP工作流限定T1→S0三个SOC子能级。');
  if (channel === 'isc' && (initial[0] === final[0] || !initial || !final)) issue(result, 'esd.channel', 'ISC/rISC需要明确单重态与三重态的初末态方向。');
  if (['phosp', 'isc'].includes(channel) && !finite(settings.energyGapCm1)) issue(result, 'esd.energyGapCm1', '必须提供初态减末态各自极小点的绝热电子能差(cm⁻¹，无ZPE)，保留正负号。');
  if (!['inline', 'external'].includes(settings.coupling)) issue(result, 'esd.coupling', '耦合来源必须明确选择内联或外部。');
  if (settings.coupling === 'external' && channel !== 'isc') issue(result, 'esd.coupling', '当前外部耦合接口仅完整支持ISC的零阶SOCME；其它通道需独立跃迁矩/导数数据，不能虚构。');
  if (settings.coupling === 'external' && (settings.herzbergTeller || !settings.externalCouplingConfirmed || !Array.isArray(settings.externalSocAu) || settings.externalSocAu.length !== 2 || !settings.externalSocAu.every(finite))) issue(result, 'esd.externalSocAu', '外部ISC须确认同源复SOCME(a.u.)与无HT零阶路线；恒定SOCME不提供HT核导数。');
  if (settings.coupling === 'inline' && (req.multiplicity !== 1 || req.settings.unrestricted || !ctx.method.soc && ['phosp', 'isc'].includes(channel))) issue(result, 'esd.coupling', '内联ESD需要已支持的方法和适用单重态电子参考；不能把末态多重度机械复制给SOC参考。');
  if (settings.coupling === 'inline' && ['phosp', 'isc'].includes(channel) && req.structure?.atoms.some(atom => ELEMENTS.indexOf(atom.element) >= 36)) issue(result, 'esd.coupling', '当前def2-ECP重原子SOC积分未核实；内联PHOSP/ISC需要已支持全电子相对论方法，不能忽略重要SOC。');
  const references: { key: string; id?: string; state: string; main?: boolean }[] = channel === 'isc'
    ? [{ key: 'ISCISHESSIAN', id: settings.initialHessianId, state: initial }, { key: 'ISCFSHESSIAN', id: settings.finalHessianId, state: final, main: true }]
    : [{ key: 'GSHESSIAN', id: settings.groundHessianId, state: 'S0', main: true }, { key: channel === 'phosp' ? 'TSHESSIAN' : 'ESHESSIAN', id: channel === 'phosp' ? settings.tripletHessianId : settings.excitedHessianId, state: channel === 'abs' ? final : initial }];
  const consumed: { asset: OrcaAsset; data: ReturnType<typeof inspectOrcaHessian> }[] = [];
  const hessianLines: string[] = [];
  for (const reference of references) {
    const asset = ctx.asset(reference.id, 'hessian');
    if (!asset || asset.kind !== 'hessian' || !asset.text?.trim() || !safeOrcaFilename(asset.name)) { issue(result, `esd.${reference.key}`, `${reference.key}需要实际提供且文件名安全的Hessian全文。`); continue; }
    const data = inspectOrcaHessian(asset.text);
    for (const error of data.issues) issue(result, `esd.${reference.key}`, `${asset.name}: ${error}`);
    const evidence = asset.hessianEvidence;
    if (!evidence || state(evidence.state) !== reference.state || !evidence.source.trim() || evidence.geometryUnits !== 'bohr' || !evidence.minimumConfirmed || !evidence.atomOrderConfirmed || evidence.charge !== req.charge || !integer(evidence.multiplicity)) issue(result, `esd.${reference.key}`, '须核对Hessian物理态、来源、电荷/多重度、Bohr单位、真实极小点及原子身份。');
    // A TD triplet is a physical triplet response of a singlet electronic
    // reference. $multiplicity records that reference, not the target spin.
    const referenceMultiplicity = evidence?.referenceMultiplicity ?? evidence?.multiplicity;
    if (evidence?.stateSource === 'td' && (reference.state === 'S0' || evidence.referenceMultiplicity !== 1)) issue(result, `esd.${reference.key}`, 'TD Hessian必须明确适用的单重态电子参考，S0不是TD激发目标。');
    if (evidence && referenceMultiplicity !== evidence.multiplicity && evidence.stateSource !== 'td') issue(result, `esd.${reference.key}`, '只有明确的TD目标/参考态来源可区分两种多重度，不能改标签绕过正文。');
    if (data.multiplicity !== undefined && evidence && data.multiplicity !== referenceMultiplicity || data.charge !== undefined && data.charge !== req.charge) issue(result, `esd.${reference.key}`, 'Hessian正文电子参考态与来源声明矛盾。');
    if (evidence && (reference.state.startsWith('S') && evidence.multiplicity !== 1 || reference.state.startsWith('T') && evidence.multiplicity !== 3)) issue(result, `esd.${reference.key}`, '来源物理多重度与目标单重/三重态矛盾，不能用电子参考态替代物理目标。');
    const atoms = req.structure?.atoms ?? [];
    if (data.atoms.length !== atoms.length || data.atoms.some((a, i) => a.element !== atoms[i]?.element)) issue(result, `esd.${reference.key}`, 'Hessian与主结构原子数/元素逐序不一致。');
    if (reference.main && (!req.structure || !hessianMatchesGeometry(data, req.structure))) issue(result, `esd.${reference.key}`, `${reference.key}几何必须与主输入逐坐标一致；不能只重排/旋转坐标而不变换Hessian。`);
    if (data.frequencies.some(f => f < -1)) issue(result, `esd.${reference.key}`, 'Hessian存在负频率，须先检查模式与极小点；本完整双态路线不自动删除或掩盖。');
    const normalizedMethod = (method: string): string => method.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (evidence?.method && ![req.settings.method, ctx.method.keywords.join(' '), ctx.method.label].map(normalizedMethod).includes(normalizedMethod(evidence.method))) issue(result, `esd.${reference.key}`, 'Hessian方法来源与选定ESD方法不一致；混合级别需独立确认方案。');
    if (evidence?.basis && evidence.basis.trim().toLowerCase() !== req.settings.basis.toLowerCase()) issue(result, `esd.${reference.key}`, 'Hessian基组来源与ESD链不一致。');
    if (evidence?.solvent !== undefined && evidence.solvent.trim().toLowerCase() !== req.settings.solvent.trim().toLowerCase()) issue(result, `esd.${reference.key}`, 'Hessian溶剂来源与ESD链不一致。');
    consumed.push({ asset, data });
    hessianLines.push(`  ${reference.key} "${asset.name}"`);
  }
  if (consumed.length === 2 && (consumed[0].asset.id === consumed[1].asset.id || consumed[0].asset.name === consumed[1].asset.name)) issue(result, 'esd.hessians', '两个物理态需要各自真实Hessian文件，不能复用同一文件或覆盖同名依赖。');
  if (consumed.length === 2 && consumed[0].data.atoms.some((atom, i) => !consumed[1].data.atoms[i] || Math.abs(atom.mass - consumed[1].data.atoms[i].mass) > 1e-7)) issue(result, 'esd.hessians', '两个Hessian逐原子质量/同位素必须相同。');
  const roots = req.settings.excited.roots;
  const root = settings.root ?? Number((channel === 'abs' ? final : initial).slice(1));
  if (settings.coupling === 'inline' && (!integer(roots) || !integer(root) && channel !== 'isc' || channel !== 'isc' && channel !== 'phosp' && root > roots || channel === 'phosp' && roots < 3)) issue(result, 'esd.roots', 'NRoots须覆盖明确目标根；PHOSP需覆盖三个SOC后子能级且SOC混合空间另核对。');
  if (channel === 'isc' && settings.coupling === 'inline') {
    const sRoot = settings.singletRoot;
    const tRoot = settings.tripletRoot;
    if (!Number.isInteger(sRoot) || sRoot! < 0 || sRoot! > roots || !integer(tRoot) || tRoot > roots || ![-1, 0, 1].includes(settings.tripletSublevel!)) issue(result, 'esd.roots', 'ISC内联需要真实SRoot/TRoot与TRootSSL=-1/0/1，根数必须覆盖。');
    if (sRoot !== Number((initial.startsWith('S') ? initial : final).slice(1)) || tRoot !== Number((initial.startsWith('T') ? initial : final).slice(1))) issue(result, 'esd.roots', 'ISC的单重/三重根与初末物理态标签不一致。');
  } else if (channel !== 'phosp' && channel !== 'isc' && root !== Number((channel === 'abs' ? final : initial).slice(1))) issue(result, 'esd.root', '目标IRoot与Hessian所代表的激发物理态不一致。');
  if (result.issues.some(i => i.severity === 'error')) return result;
  const esd = `%esd\n${hessianLines.join('\n')}\n  USEJ ${settings.useDuschinsky}\n  TEMP ${settings.temperatureK}${['phosp', 'isc'].includes(channel) ? `\n  DELE ${settings.energyGapCm1}` : ''}${channel !== 'ic' && settings.coupling === 'inline' ? `\n  DOHT ${settings.herzbergTeller}` : ''}${settings.coupling === 'external' ? `\n  SOCME ${settings.externalSocAu![0]},${settings.externalSocAu![1]}` : ''}\nend`;
  const tddft = (target: number): string => `%tddft\n  NRoots ${roots}\n${channel === 'isc' ? `  SRoot ${settings.singletRoot}\n  TRoot ${settings.tripletRoot}\n  TRootSSL ${settings.tripletSublevel}` : `  IRoot ${target}`}\n  TDA false${['isc', 'phosp'].includes(channel) ? '\n  DOSOC true' : ''}${channel === 'ic' ? '\n  NACME true\n  ETF true' : ''}\nend`;
  result.keywords = [`ESD(${channel.toUpperCase()})`, 'TightSCF', ...(channel === 'phosp' ? ['RI-SOMF(1X)'] : []), ...(settings.coupling === 'external' ? ['NOITER'] : [])];
  result.blocksBeforeCoordinates = settings.coupling === 'external' ? [esd] : [tddft(root), esd];
  if (channel === 'phosp') result.variants = [1, 2, 3].map(root => ({ suffix: `phosp-${root}`, blocksBeforeCoordinates: [tddft(root), esd] }));
  result.files = consumed.map(({ asset }) => dependencyFile(asset)!).filter(Boolean);
  return result;
}

function renderMd(req: OrcaJobRequest, ctx: OrcaRenderContext): OrcaTaskRender {
  const result = empty();
  const settings = req.settings.md;
  const atoms = req.structure?.atoms ?? [];
  if (req.settings.frozenAtomIds.length || req.settings.constraints.length) issue(result, 'md.constraints', 'MD使用专用active region与MD约束；普通%geom冻结/扫描不能静默忽略或当MD约束。');
  if (!positive(settings.timestepFs)) issue(result, 'md.timestepFs', '必须提供正数时间步，单位fs。');
  if (!integer(settings.steps)) issue(result, 'md.steps', '必须提供准确正整数步数，不能代入默认时长。');
  if (settings.durationFs !== undefined && (!positive(settings.durationFs) || !positive(settings.timestepFs) || !integer(settings.steps) || Math.abs(settings.durationFs / settings.timestepFs - settings.steps) > 1e-8)) issue(result, 'md.durationFs', '给定时长必须按已确认时间步换算为准确整数Run步数，不能静默舍入。');
  if (!finite(settings.initialTemperatureK) || settings.initialTemperatureK < 0) issue(result, 'md.initialTemperatureK', '必须提供初速度温度，单位K。');
  if (!['none', 'csvr', 'nhc'].includes(settings.thermostat)) issue(result, 'md.thermostat', '须明确选择支持的恒温器或None。');
  if (settings.thermostat !== 'none' && (!positive(settings.targetTemperatureK) || !positive(settings.couplingTimeFs))) issue(result, 'md.targetTemperatureK', '恒温器目标温度和耦合时间须明确且为正数。');
  if (!integer(settings.trajectoryStride)) issue(result, 'md.trajectoryStride', '轨迹输出步距须为正整数。');
  const activeIndices = settings.activeAtomIds.map(ctx.atomIndex);
  if (activeIndices.some(i => i < 0 || i >= atoms.length) || new Set(activeIndices).size !== activeIndices.length) issue(result, 'md.activeAtomIds', 'MD活动原子含失效或重复身份。');
  const active = new Set(settings.activeAtomIds.length ? activeIndices : atoms.map((_, i) => i));
  const constraintLines: string[] = [];
  const seen = new Set<string>();
  for (const constraint of settings.constraints) {
    const size = { B: 2, A: 3, D: 4 }[constraint.type];
    const indices = constraint.atomIds.map(ctx.atomIndex);
    if (!size || constraint.action !== 'freeze' || indices.length !== size || new Set(indices).size !== size || indices.some(i => i < 0 || i >= atoms.length || !active.has(i)) || !finite(constraint.value) || (constraint.type === 'B' && constraint.value <= 0) || (constraint.type === 'A' && (constraint.value <= 0 || constraint.value >= 180))) { issue(result, 'md.constraints', 'MD约束须明确目标值、正确索引且所有参与原子在活动区域；扫描不能当MD约束。'); continue; }
    // Only a full reversal preserves the same internal coordinate; sorting
    // would conflate different angle centres and different torsions.
    const forward = indices.join(',');
    const reverse = [...indices].reverse().join(',');
    const key = `${constraint.type}:${forward < reverse ? forward : reverse}`;
    if (seen.has(key)) { issue(result, 'md.constraints', 'MD约束重复或冲突。'); continue; }
    seen.add(key);
    if (constraint.type === 'B' && !(req.structure?.bondSource === 'file' || req.structure?.bondSource === 'drawn')) issue(result, 'md.constraints', '距离约束必须有已确认实际成键证据，不能仅凭距离自动猜键。');
    else if (constraint.type === 'B' && !req.structure?.bonds?.some(b => b.a === indices[0] && b.b === indices[1] || b.a === indices[1] && b.b === indices[0])) issue(result, 'md.constraints', '距离约束原子对未在真实成键图中。');
    constraintLines.push(`  Constraint Add ${{ B: 'Distance', A: 'Angle', D: 'Dihedral' }[constraint.type]} ${indices.join(' ')} Target ${constraint.value}_${constraint.type === 'B' ? 'Angstrom' : 'Deg'}`);
  }
  let restart: OrcaAsset | undefined;
  if (settings.restartAssetId) {
    restart = ctx.asset(settings.restartAssetId, 'restart');
    const evidence = restart?.restartEvidence;
    if (!restart || restart.kind !== 'restart' || !restart.text?.trim() || !safeOrcaFilename(restart.name) || !/\.mdrestart$/i.test(restart.name) || !settings.restartConfirmed || !settings.taskIdentity.trim() || !evidence || evidence.taskIdentity !== settings.taskIdentity || !evidence.conditionsConfirmed || evidence.atomIds.length !== atoms.length || evidence.atomIds.some((id, i) => id !== atoms[i].id)) issue(result, 'md.restartAssetId', 'MD重启需实际文件、同一任务身份、全部同序原子及同条件确认，未知来源不得启用Restart。');
  }
  if (result.issues.length) return result;
  const trajectory = `${ctx.stem}-trajectory.xyz`;
  if (!safeOrcaFilename(trajectory)) { issue(result, 'name', 'MD轨迹文件名必须为安全ASCII basename。'); return result; }
  result.keywords = ['MD'];
  const thermostat = settings.thermostat === 'none' ? '  Thermostat None' : `  Thermostat ${settings.thermostat.toUpperCase()} ${settings.targetTemperatureK}_K Timecon ${settings.couplingTimeFs}_fs`;
  result.blocksBeforeCoordinates.push(`%md\n  Timestep ${settings.timestepFs}_fs${activeIndices.length ? `\n  Manage_Region active Define ${activeIndices.join(' ')}` : ''}\n  Initvel ${settings.initialTemperatureK}_K No_Overwrite\n${thermostat}\n  Dump Position Stride ${settings.trajectoryStride} Format XYZ Filename "${trajectory}"${constraintLines.length ? `\n${constraintLines.join('\n')}` : ''}${restart ? `\n  Restart "${restart.name}" IfExists` : ''}\n  Run ${settings.steps} CenterCOM\nend`);
  if (restart) result.files.push(dependencyFile(restart)!);
  if (restart) result.issues.push({ field: 'md.restartAssetId', severity: 'warning', message: '重启仅按提供的原任务来源、原子顺序和条件确认；mdrestart内部格式未在此解析，尚未通过原生ORCA消费验收。' });
  if (atoms.some(atom => atom.element === 'H') && settings.timestepFs! > 0.5) result.issues.push({ field: 'md.timestepFs', severity: 'warning', message: '体系含H且时间步超过0.5 fs；须按实际稳定性核对，输入准备未验收轨迹。' });
  return result;
}

export function renderOrcaWorkflow(req: OrcaJobRequest, ctx: OrcaRenderContext): OrcaTaskRender {
  if (req.settings.task === 'neb') return renderNeb(req, ctx);
  if (req.settings.task === 'md') return renderMd(req, ctx);
  if (req.settings.task === 'esd') return renderEsd(req, ctx);
  return empty();
}
