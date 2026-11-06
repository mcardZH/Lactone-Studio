import { atomicNumber, electronicStateError } from '../elements';
import { sha256Utf8 } from '../file-identity';
import { hasSolvation } from '../solvents';
import type { Atom } from '../types';
import type { OrcaJobRequest, OrcaRenderContext, OrcaTaskRender } from './types';

/** Static molecular multiscale input preparation, not an ORCA parser or force-field
 * parameterizer. Reviewed: 5.0.4 PDF404–428/435–436; 6.0 PDF384–388,
 * 392–406/412; 6.1 qmmm-general and qmmm-molecules (explicit region interface).
 * ORCA creates native H links; they must never enter the real atom coordinate list.
 */
export function renderOrcaMultiscale(req: OrcaJobRequest, ctx: OrcaRenderContext): OrcaTaskRender {
  const result: OrcaTaskRender = { keywords: [], blocksBeforeCoordinates: [], blocksAfterCoordinates: [], files: [], issues: [] };
  const s = req.settings;
  const m = s.multiscale;
  if (m.mode === 'none') return result;
  const error = (field: string, message: string) => result.issues.push({ field, message, severity: 'error' });
  const warn = (field: string, message: string) => result.issues.push({ field, message, severity: 'warning' });
  if (!['5', '6.0', '6.1'].includes(s.version)) error('version', '多尺度只支持已核对的ORCA 5.0.4/6.0/6.1配置，未知版本不推测兼容。');
  if (m.mode !== 'qm-mm' && m.mode !== 'qm-xtb') error('multiscale.mode', '未知的多尺度路线。');
  if (!['sp', 'opt', 'freq', 'optfreq', 'scan', 'ts'].includes(s.task)) {
    error('multiscale', '当前多尺度导出已核对SP/Opt/Freq/OptFreq/Scan/TS；其它专项任务的区域、性质或依赖映射仍需单独核对，不能输出全QM输入冒充。');
  }
  const atoms = req.structure?.atoms ?? [];
  const ids = atoms.map(atom => atom.id);
  if (!atoms.length || ids.some(id => !id) || new Set(ids).size !== ids.length) {
    error('multiscale.qmAtomIds', '多尺度需要完整、唯一的真实稳定原子身份；不能用显示编号代替。');
    return result;
  }
  const actualIds = ids as string[];
  const indices = new Map(actualIds.map((id, index) => [id, index]));
  const select = (values: string[], field: string) => {
    if (!Array.isArray(values)) { error(field, '原子集合格式无效。'); return new Set<string>(); }
    const selected = new Set<string>();
    for (const id of values) {
      if (!indices.has(id) || ctx.atomIndex(id) !== indices.get(id)) error(field, '原子身份或导出顺序已经失效，请重新选择。');
      if (selected.has(id)) error(field, '原子集合包含重复身份。');
      selected.add(id);
    }
    return selected;
  };
  const qm = select(m.qmAtomIds, 'multiscale.qmAtomIds');
  if (!qm.size || qm.size >= atoms.length) error('multiscale.qmAtomIds', '高层QM区域和低层区域都必须非空。');
  if (!m.configurationConfirmed) error('multiscale.configurationConfirmed', '请确认分区、包含原生link H的高层电荷/多重度、总体系电子态与嵌入选择。');
  if (!['mechanical', 'electrostatic'].includes(m.embedding)) error('multiscale.embedding', '必须明确选择机械或静电嵌入。');
  if (m.mode === 'qm-xtb' && !['xtb2', 'gfn2-xtb', 'gfn2', 'xtb'].includes(m.lowMethod.trim().toLowerCase())) {
    error('multiscale.lowMethod', 'QM/XTB的已核对低层为GFN2-xTB；不会把其它低层名称替换为GFN2。');
  }
  if (m.mode === 'qm-xtb' && atoms.some(atom => atomicNumber(atom.element) > 86)) {
    error('multiscale.lowMethod', 'GFN2-xTB会计算完整体系，所有真实原子（包括低层）都必须在H–Rn元素范围内。');
  }
  if (m.mode === 'qm-xtb' && ctx.method.id === 'xtb2') error('method', '当前高层与低层均为GFN2-xTB；请选择实际需要的不同高层方法。');
  if (m.mode === 'qm-mm' && !['orcaff', 'orca-ff'].includes(m.lowMethod.trim().toLowerCase())) {
    error('multiscale.lowMethod', 'QM/MM低层由真实ORCAFF参数定义，不能把UFF或makeff标签当作完整柔性力场。');
  }
  // Ordinary DFT solvation is not the QM/XTB ALPB/ddCOSMO/CPCM-X interface.
  if (hasSolvation(s)) error('solvent', '多尺度溶剂需专用区域/模型接口；当前导出不把普通CPCM/SMD设置移植到多尺度计算。');
  if (s.ircHessianId) error('ircHessianId', '多尺度Hessian还需核对activeRegionExt和link布局；不复用普通全体系Hessian。');

  const graph = m.graphEvidence;
  const graphValid = graph?.confirmed && ['explicit', 'user-reviewed'].includes(graph.source)
    && graph.atomIds.length === actualIds.length && graph.atomIds.every((id, i) => id === actualIds[i]);
  if (!graphValid) error('multiscale.graphEvidence', '必须提供与当前真实原子顺序一致且已确认的显式/人工复核共价图；距离推断、辅助线和缺少图不能证明无跨层键。');
  // The review snapshot is evidence for the current graph, not a second graph that
  // may silently supersede it. An explicit empty graph is meaningful for atoms/ions.
  if (graphValid) {
    const bonds = req.structure?.bonds;
    if (!bonds || !['file', 'drawn', 'inferred'].includes(req.structure?.bondSource ?? '')
      || (req.structure?.bondSource === 'inferred' && graph!.source !== 'user-reviewed')) {
      error('multiscale.graphEvidence', '当前结构缺少明确图来源；推断图必须经过人工复核。');
    } else {
      const current = new Map<string, number>();
      for (const bond of bonds) {
        if (bond.kind === 'coordination') {
          if (qm.has(actualIds[bond.a]) !== qm.has(actualIds[bond.b])) {
            error('multiscale.graphEvidence', 'QM/低层之间存在配位边界；不能将其当作无成键非共价切分或自动H-link，须重新确定区域。');
          }
          continue;
        }
        if (!Number.isInteger(bond.a) || !Number.isInteger(bond.b) || bond.a < 0 || bond.b < 0
          || bond.a >= atoms.length || bond.b >= atoms.length || bond.a === bond.b
          || (bond.image && bond.image.some(value => value !== 0))) {
          error('multiscale.graphEvidence', '当前共价图含失效索引或周期跨胞键，不能按分子ORCA多尺度导出。'); continue;
        }
        const key = [actualIds[bond.a], actualIds[bond.b]].sort().join('\0');
        if (current.has(key)) error('multiscale.graphEvidence', '当前共价图存在重复键。');
        current.set(key, bond.aromatic ? 1.5 : bond.order);
      }
      const reviewed = new Map(graph!.bonds.map(bond => [[bond.a, bond.b].sort().join('\0'), bond.order]));
      if (current.size !== reviewed.size || [...current].some(([key, order]) => reviewed.get(key) !== order)) {
        error('multiscale.graphEvidence', '已确认的图快照与当前真实共价图不同；请重新复核，不能用旧快照覆盖当前拓扑。');
      }
    }
  }
  const cuts: { qmAtomId: string; lowAtomId: string }[] = [];
  const seenBonds = new Set<string>();
  if (graphValid) for (const [row, bond] of graph!.bonds.entries()) {
    const field = `multiscale.graphEvidence.bonds.${row}`;
    const key = [bond.a, bond.b].sort().join('\0');
    if (!indices.has(bond.a) || !indices.has(bond.b) || bond.a === bond.b || seenBonds.has(key)
      || ![1, 1.5, 2, 3].includes(bond.order)) {
      error(field, '共价图含失效身份、自键、重复键或不支持的真实键级。'); continue;
    }
    seenBonds.add(key);
    if (qm.has(bond.a) === qm.has(bond.b)) continue;
    if (bond.order !== 1) error(field, 'ORCA多尺度边界只允许切单键，不能切芳香/双/三键。');
    const q = qm.has(bond.a) ? bond.a : bond.b;
    const low = qm.has(bond.a) ? bond.b : bond.a;
    if (atoms[indices.get(q)!].element === 'H' || atoms[indices.get(low)!].element === 'H') error(field, '不得把含H的键作为QM/低层切口，请调整区域。');
    if (m.mode === 'qm-mm' && !['C', 'N', 'O'].includes(atoms[indices.get(q)!].element)) {
      error(field, '该QM/MM边界高层元素需要已核对的原生H_Dist参数文件；当前仅具C/N/O原生默认H-link距离。');
    }
    cuts.push({ qmAtomId: q, lowAtomId: low });
  }
  const confirmedCuts = new Set<string>();
  for (const [row, boundary] of m.boundaries.entries()) {
    const field = `multiscale.boundaries.${row}`;
    const key = `${boundary.qmAtomId}\0${boundary.lowAtomId}`;
    if (!cuts.some(cut => cut.qmAtomId === boundary.qmAtomId && cut.lowAtomId === boundary.lowAtomId)
      || confirmedCuts.has(key)) error(field, 'link边界必须逐一对应当前共价图中的跨层单键，不能多出、重复或连接错误目标。');
    confirmedCuts.add(key);
    if (!boundary.confirmed || boundary.linkElement !== 'H') error(field, '必须明确确认ORCA原生自动H-link；不移植Gaussian手工link元素语法。');
    if (boundary.scaleFactors?.length) error(field, 'ORCA原生按平衡键长决定link缩放；不能将Gaussian逐原子scale字段直接输出。');
  }
  if (cuts.some(cut => !confirmedCuts.has(`${cut.qmAtomId}\0${cut.lowAtomId}`))) error('multiscale.boundaries', '每条跨层键都需要独立确认原生H-link与高层电子态，不能静默丢失切口。');
  const qmModel: Atom[] = [...atoms.filter((_, i) => qm.has(actualIds[i])), ...cuts.map(() => ({ element: 'H', x: 0, y: 0, z: 0 }))];
  if (qmModel.length) {
    const state = electronicStateError(qmModel, m.qmCharge, m.qmMultiplicity);
    if (state) error('multiscale.qmMultiplicity', `含原生link H的高层模型电子态：${state}`);
  }
  const totalState = electronicStateError(atoms, req.charge, req.multiplicity);
  if (totalState) error('electronicState', `总体系电子态：${totalState}`);

  // Product convention (shared with MD): [] and undefined both mean all. Apply
  // physical freezes afterwards; an emptied nonempty selection never reverts to all.
  const hasExplicitActive = Boolean(m.activeAtomIds?.length);
  let active = !hasExplicitActive ? new Set(actualIds) : select(m.activeAtomIds!, 'multiscale.activeAtomIds');
  if (m.freezeLowLayer) {
    active = new Set([...active].filter(id => qm.has(id)));
  }
  for (const id of s.frozenAtomIds) {
    if (!indices.has(id)) error('frozenAtomIds', '冻结原子身份已经失效。');
    active.delete(id);
  }
  if (!active.size) error('multiscale.activeAtomIds', '空ActiveAtoms在ORCA不表示全部冻结；当前接口要求至少一个活动原子。');

  const block = ['%qmmm', `  QMAtoms {${actualIds.flatMap((id, i) => qm.has(id) ? [i] : []).join(' ')}} end`,
    `  Embedding ${m.embedding === 'mechanical' ? 'Mechanical' : 'Electrostatic'}`];
  if (active.size < atoms.length || hasExplicitActive || m.freezeLowLayer) {
    block.push(`  ActiveAtoms {${actualIds.flatMap((id, i) => active.has(id) ? [i] : []).join(' ')}} end`);
  }
  if (m.mode === 'qm-xtb') {
    result.keywords.push('QM/XTB');
    block.push(`  Charge_Total ${req.charge}`, `  Mult_Total ${req.multiplicity}`);
    warn('multiscale', 'QM/XTB原生拓扑与link准备会在实际ORCA运行时进行；本软件只准备输入，不启动XTB或证明其运行环境就绪。');
  } else {
    result.keywords.push('QMMM');
    const asset = ctx.asset(m.parametersAssetId, 'mm-parameters');
    const evidence = asset?.mmEvidence;
    if (!asset || asset.kind !== 'mm-parameters' || !asset.text?.trim()) error('multiscale.parametersAssetId', 'QM/MM必须提供真实ORCAFF文本内容，只有文件名不够。');
    else if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.prms$/i.test(asset.name) || asset.text.includes('\0')) error('multiscale.parametersAssetId', 'ORCAFF依赖必须为安全ASCII .prms文件名及有效文本。');
    else if (!asset.sha256 || !/^[A-Fa-f0-9]{64}$/.test(asset.sha256)
      || sha256Utf8(asset.text) !== asset.sha256.toLowerCase()) {
      error('multiscale.parametersAssetId', 'ORCAFF必须保留与实际UTF-8文件内容一致的SHA256；哈希缺失或内容改变须重新导入核对。');
    }
    else if (!evidence?.atomOrderConfirmed || !evidence.source.trim() || evidence.atomCount !== atoms.length
      || evidence.atomIds.length !== actualIds.length || !evidence.atomIds.every((id, i) => id === actualIds[i])) {
      error('multiscale.parametersAssetId', 'ORCAFF来源、实际原子数与逐原子身份/顺序必须已核对，不能按同名文件猜测匹配。');
    } else if (!evidence.bondedParametersConfirmed) {
      error('multiscale.parametersAssetId', '必须确认当前区域所需的实际键合参数；makeff的UFF-LJ/电荷不构成完整柔性UFF。');
    } else {
      block.push(`  ORCAFFFilename "${asset.name}"`);
      result.files.push({ name: asset.name, text: asset.text, role: 'dependency', sourceAssetId: asset.id });
      warn('multiscale.parametersAssetId', 'ORCAFF作为来源已确认的opaque依赖按原始内容与SHA256保留；本软件没有解析其原生参数格式，未执行原生ORCA参数解析或力场正确性验收。');
    }
    if (cuts.length && m.embedding === 'electrostatic') block.push('  ChargeAlteration CS');
  }
  block.push('end');
  if (['freq', 'optfreq', 'ts'].includes(s.task) && active.size < atoms.length) {
    warn('multiscale.activeAtomIds', '非活动原子存在时ORCA使用扩展活动区PHVA；这不是完整体系Hessian或全体系驻点/热化学证明。');
  }
  if (result.issues.some(issue => issue.severity === 'error')) {
    result.keywords = []; result.files = []; return result;
  }
  result.blocksBeforeCoordinates.push(block.join('\n'));
  result.coordinateLines = atoms.map(atom => `${atom.element} ${atom.x.toFixed(10)} ${atom.y.toFixed(10)} ${atom.z.toFixed(10)}`);
  return result;
}

