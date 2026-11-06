import { atomicNumber, electronicStateError } from '../elements';
import type { Atom } from '../types';
import type { OrcaAsset, OrcaCoordinate, OrcaJobRequest, OrcaRenderContext, OrcaTaskRender } from './types';
import { recommendedExcitedStates } from '../input-recommendations';
import { orcaOptimizationHessianRoute } from './optimization-hessian';

/** Static input preparation only. Sources: ORCA 5.0.4 and 6.0/6.1 manuals,
 * optimizations/scans/IRC, TDDFT (sTDA: Mode sTDA), EPRNMR and counterpoise.
 * A rendered input is not evidence that ORCA or its scientific result was tested. */
export function renderOrcaTask(request: OrcaJobRequest, context: OrcaRenderContext): OrcaTaskRender {
  const result: OrcaTaskRender = { keywords: [], blocksBeforeCoordinates: [], blocksAfterCoordinates: [], files: [], issues: [] };
  const { settings: s } = request;
  const atoms = request.structure?.atoms ?? [];
  const error = (field: string, message: string) => result.issues.push({ field, message, severity: 'error' });
  const warn = (field: string, message: string) => result.issues.push({ field, message, severity: 'warning' });
  const frequency = () => {
    if (context.method.frequency === 'none') error('method', '当前方法没有已核对的频率路线。');
    else result.keywords.push(context.method.frequency === 'analytic' ? 'Freq' : 'NumFreq', 'TightSCF');
  };
  const atomIndex = (id: string, field: string): number | null => {
    const index = context.atomIndex(id);
    if (!Number.isInteger(index) || index < 0 || index >= atoms.length) {
      error(field, '原子身份已失效或不在当前结构中，请重新选择。');
      return null;
    }
    return index;
  };
  const coordinateIndices = (coordinate: OrcaCoordinate, field: string): number[] | null => {
    const count = { B: 2, A: 3, D: 4 }[coordinate.type];
    if (!count || !Array.isArray(coordinate.atomIds) || coordinate.atomIds.length !== count) {
      error(field, 'B/A/D坐标分别需要2/3/4个不同的原子身份。');
      return null;
    }
    const indices = coordinate.atomIds.map(id => atomIndex(id, field));
    if (indices.some(index => index === null)) return null;
    if (new Set(indices).size !== count) { error(field, '内部坐标不能重复使用同一原子。'); return null; }
    return indices as number[];
  };
  const validValue = (type: OrcaCoordinate['type'], value: unknown) => typeof value === 'number' && Number.isFinite(value)
    && (type === 'B' ? value > 0 : type === 'A' ? value > 0 && value < 180 : true);
  const geometryLines: string[] = [];
  const frozen: string[] = [];
  const scanned: string[] = [];
  const seen = new Map<string, string>();
  for (const [row, coordinate] of s.constraints.entries()) {
    const field = `constraints.${row}`;
    const indices = coordinateIndices(coordinate, field);
    if (!indices) continue;
    const reverse = [...indices].reverse();
    const key = coordinate.type + ':' + [indices.join(','), reverse.join(',')].sort()[0];
    if (seen.has(key)) { error(field, '同一内部坐标存在重复或扫描/冻结冲突，请保留一个定义。'); continue; }
    seen.set(key, coordinate.action);
    if (coordinate.action === 'freeze') {
      if (coordinate.value !== undefined && !validValue(coordinate.type, coordinate.value)) {
        error(field, '冻结坐标值必须有限；键长为正，键角在0到180度之间。'); continue;
      }
      // Omitted value means the actual initial coordinate, not a zero/default target.
      frozen.push(`    { ${coordinate.type} ${indices.join(' ')}${coordinate.value === undefined ? '' : ' ' + coordinate.value} C }`);
    } else if (coordinate.action === 'scan') {
      if (s.task !== 'scan') { error(field, '扫描坐标只在Scan任务中生效，不能当作冻结输出。'); continue; }
      if (coordinate.values !== undefined) {
        if (!Array.isArray(coordinate.values) || coordinate.values.length < 2 || !coordinate.values.every(value => validValue(coordinate.type, value))) {
          error(field, '显式扫描值表至少需要两个有效数值。'); continue;
        }
        if (coordinate.start !== undefined || coordinate.end !== undefined || coordinate.steps !== undefined) {
          error(field, '显式值表与范围/步数互斥，请只保留一种扫描定义。'); continue;
        }
        scanned.push(`    ${coordinate.type} ${indices.join(' ')} [ ${coordinate.values.join(' ')} ]`);
      } else {
        if (!validValue(coordinate.type, coordinate.start) || !validValue(coordinate.type, coordinate.end)
          || coordinate.start === coordinate.end || !Number.isSafeInteger(coordinate.steps) || coordinate.steps! < 2) {
          error(field, '扫描需要不同的有效起止值及至少2个点的整数点数。'); continue;
        }
        scanned.push(`    ${coordinate.type} ${indices.join(' ')} = ${coordinate.start}, ${coordinate.end}, ${coordinate.steps}`);
      }
    } else error(field, '未知的内部坐标操作。');
  }
  const frozenIndices = new Set<number>();
  for (const id of s.frozenAtomIds) {
    const index = atomIndex(id, 'frozenAtomIds');
    if (index !== null) frozenIndices.add(index);
  }
  for (const index of frozenIndices) frozen.unshift(`    { C ${index} C }`);
  const standaloneExcitedFrequency = s.task === 'tdopt' && s.excited.frequency === true && s.excited.frequencyOnly === true;
  const optimizing=['opt','optfreq','scan','ts','tdopt'].includes(s.task)&&!standaloneExcitedFrequency;
  const optimization=s.optimization;
  const optimizationHessian=orcaOptimizationHessianRoute(s);
  if(optimizing&&optimization){
    for(const [key,label] of [['maxIterations','优化步数'],['recalcInterval','Hessian重算间隔']] as const){const n=optimization[key];if(n!==undefined&&(!Number.isSafeInteger(n)||n<1))error('optimization.'+key,label+'须为正整数。');}
    if(optimization.maxStep!==undefined&&(!Number.isFinite(optimization.maxStep)||optimization.maxStep<=0))error('optimization.maxStep','优化步长须为正有限数值。');
    if(optimization.maxIterations!==undefined)geometryLines.push('  MaxIter '+optimization.maxIterations);
    if(optimization.maxStep!==undefined)geometryLines.push('  MaxStep '+optimization.maxStep);
    if(optimization.hessian==='calc'||optimization.hessian==='recalc'){
      if(s.ircHessianId&&s.task==='ts')error('optimization.hessian','初始Hessian读取与重新计算不能同时启用。');
      else if(optimizationHessian==='none')error('optimization.hessian','当前版本、方法及目标态尚无已核定的优化Hessian路线；请恢复程序默认或核对当前设置。');
      else if(s.task!=='ts')geometryLines.push('  Calc_Hess true','  NumHess '+(optimizationHessian==='numeric'));
      if(optimization.hessian==='recalc'){if(!optimization.recalcInterval)error('optimization.recalcInterval','请填写Hessian重算间隔。');else geometryLines.push('  Recalc_Hess '+optimization.recalcInterval);}
    }
  }
  if (frozen.length && standaloneExcitedFrequency) {
    error('constraints', '独立激发态频率尚未支持活动冻结原子或内坐标约束；请先停用冻结，定义会保留，不能用优化约束冒充受约束Hessian。');
  } else if (frozen.length && !['opt', 'optfreq', 'ts', 'scan', 'tdopt'].includes(s.task)) {
    error('constraints', '当前任务不执行受约束几何优化；不能把冻结显示冒充频率、IRC或单点的物理约束。');
  }
  if (scanned.length > 3) error('constraints', 'ORCA relaxed scan最多三个扫描坐标。');
  if (scanned.length) geometryLines.push('  Scan', ...scanned, '  end');
  if (frozen.length && !standaloneExcitedFrequency) geometryLines.push('  Constraints', ...frozen, '  end');

  const dependency = (id: string | undefined, field: string): OrcaAsset | undefined => {
    const asset = context.asset(id, 'hessian');
    if (!asset || asset.kind !== 'hessian') {
      error(field, '请填写同目录Hessian文件名。'); return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.hess$/i.test(asset.name)) {
      error(field, 'Hessian文件名必须为安全ASCII .hess文件名。'); return;
    }
    if (asset.name.toLowerCase() === `${context.stem}.hess`.toLowerCase()) {
      error(field, '来源Hessian不能与新任务输出同名，避免计算覆盖依赖原件。'); return;
    }
    warn(field, '输入将引用同目录Hessian文件；尚未验证文件存在、内容及其与当前任务的物理相容性。');
    return asset;
  };

  switch (s.task) {
    case 'sp': result.keywords.push('SP'); break;
    case 'opt': result.keywords.push('Opt', 'LooseOpt'); break;
    case 'freq': frequency(); break;
    case 'optfreq': result.keywords.push('Opt'); frequency(); break;
    case 'scan':
      result.keywords.push('LooseOpt');
      if (!scanned.length) error('constraints', 'Scan需要至少一个完整的扫描坐标；不会生成普通优化冒充扫描。');
      break;
    case 'ts':
      result.keywords.push('OptTS'); frequency();
      if (s.ircHessianId) {
        const asset = dependency(s.ircHessianId, 'ircHessianId');
        if (asset) geometryLines.push('  InHess Read', `  InHessName "${asset.name}"`);
      } else if (context.method.frequency !== 'none') {
        geometryLines.push('  Calc_Hess true', `  NumHess ${context.method.frequency === 'numeric'}`);
      }
      break;
    case 'irc': {
      result.keywords.push('IRC');
      const lines = ['%irc', '  Direction both'];
      if (s.ircHessianId) {
        const asset = dependency(s.ircHessianId, 'ircHessianId');
        if (asset) lines.push('  InitHess Read', `  Hess_Filename "${asset.name}"`);
      } else if (context.method.frequency === 'none') error('method', '该方法没有已核对的IRC起始Hessian计算路线，请提供适用Hessian。');
      else lines.push(`  InitHess ${context.method.frequency === 'analytic' ? 'calc_anfreq' : 'calc_numfreq'}`);
      if (s.ircMaxIterations !== undefined) {
        if (!Number.isSafeInteger(s.ircMaxIterations) || s.ircMaxIterations < 1) error('ircMaxIterations', 'IRC步数必须为正整数。');
        else lines.push(`  MaxIter ${s.ircMaxIterations}`);
      }
      lines.push('end'); result.blocksBeforeCoordinates.push(lines.join('\n'));
      break;
    }
    case 'td': case 'tdopt': {
      const e = { ...s.excited, roots: s.excited.rootsMode === 'auto' ? recommendedExcitedStates(atoms.length, s.task, s.excited.root) : s.excited.roots };
      const withFrequency = s.task === 'tdopt' && e.frequency === true;
      if (s.task === 'tdopt' && e.frequencyOnly && !e.frequency) error('excited.frequencyOnly', '独立激发态频率须同时启用频率计算，请重新选择计算内容。');
      const targetStructure = () => {
        if (!(withFrequency && e.frequencyOnly)) result.keywords.push('Opt', ...(withFrequency ? [] : ['LooseOpt']));
        // ORCA analytical Hessians apply to SCF energies, not TD/TDA target roots.
        if (withFrequency) {
          if (e.useUks) frequency();
          else result.keywords.push('NumFreq', 'TightSCF');
        }
      };
      if (!['td', 'tda', 'stddft', 'stda'].includes(e.approximation)) { error('excited.approximation', '未知的激发态路线。'); break; }
      if (e.useUks) {
        if (s.task !== 'tdopt' || e.targetSpin !== 'triplet' || e.root !== 1 || request.multiplicity !== 3) {
          error('excited.useUks', 'T1 UKS仅用于目标T1的结构优化，必须Root=1且分子多重度为3。');
        }
        if (e.soc || e.triplets || e.approximation === 'stddft' || e.approximation === 'stda') {
          error('excited.useUks', 'T1 UKS是三重态DFT优化，不能同时请求TD triplets、SOC或简化TD筛选。');
        }
        result.keywords.push('UKS');
        targetStructure();
        break;
      }
      const simplified = e.approximation === 'stddft' || e.approximation === 'stda';
      if (simplified) {
        if (s.task !== 'td') error('excited.approximation', 'sTDA/sTDDFT没有梯度和频率，只用于光谱筛选。');
        if (context.method.family !== 'hybrid') error('method', '本产品sTDA/sTDDFT路线需要已核对的杂化DFT方法。');
        if (['wb97m-v', 'wb97x-v'].includes(context.method.id)) {
          error('method', '该范围分离泛函没有手册列出的sTD预拟合参数；需明确并核对ax/alpha/beta参数，不能静默使用其它泛函参数。');
        }
        if (e.soc) error('excited.soc', '简化TD路线没有本产品已核对的SOC实现，请选择常规TDDFT/TDA。');
        const energy = e.energyWindowEV ?? 7;
        const threshold = e.selectionThresholdEh ?? 1e-4;
        const limit = e.perturbationWindowEV ?? 30;
        if (![energy, threshold, limit].every(value => Number.isFinite(value) && value > 0) || limit < energy) {
          error('excited.energyWindowEV', 'sTD能窗/选择阈值必须为正，PTLimit不得低于EThresh。');
        }
        if ((e.triplets || e.targetSpin === 'triplet') && (s.unrestricted || request.multiplicity !== 1)) {
          error('excited.triplets', '自旋适配triplets需要闭壳层单重态参考。');
        }
        result.blocksBeforeCoordinates.push(['%tddft', `  Mode ${e.approximation === 'stda' ? 'sTDA' : 'sTDDFT'}`,
          `  EThresh ${energy}`, `  PThresh ${threshold}`, `  PTLimit ${limit}`,
          `  triplets ${e.triplets || e.targetSpin === 'triplet'}`, 'end'].join('\n'));
        break;
      }
      if (!Number.isSafeInteger(e.roots) || e.roots < 1) error('excited.roots', 'TD根数必须为正整数。');
      if (s.task === 'tdopt' && (!Number.isSafeInteger(e.root) || e.root < 1 || e.root > e.roots)) {
        error('excited.root', '目标Root必须为正整数且不超过NRoots。');
      }
      const triplets = e.triplets || e.targetSpin === 'triplet' || e.soc;
      if (triplets && (s.unrestricted || request.multiplicity !== 1)) {
        error('excited.triplets', '自旋适配triplets/SOC需要闭壳层单重态参考，不能从UHF/UKS起点直接计算。');
      }
      if (e.soc && !context.method.soc) error('excited.soc', '当前方法没有已核对的TDDFT SOC支持。');
      if (e.soc && atoms.some(atom => atomicNumber(atom.element) > 36)) {
        error('excited.soc', '当前统一def2路线对Rb及以后元素使用ECP；ORCA TDDFT SOC缺少ECP积分，需先选择并核对全电子路线。');
      }
      if (e.soc && s.task === 'tdopt') error('excited.soc', '本输入模块SOC为光谱/耦合路线，SOC混合态优化需单独核对，不用普通IRoot冒充。');
      const block = ['%tddft', `  NRoots ${e.roots}`, `  TDA ${e.approximation === 'tda'}`, `  triplets ${triplets}`];
      if (s.task === 'tdopt') {
        targetStructure();
        block.push(`  IRoot ${e.root}`, `  IRootMult ${e.targetSpin}`);
      }
      if (e.soc) block.push('  DoSOC true');
      if (e.printCoefficients) block.push('  TPrint 0.0001');
      block.push('end'); result.blocksBeforeCoordinates.push(block.join('\n'));
      break;
    }
    case 'nmr': {
      if (s.nmr !== 'shielding' && s.nmr !== 'coupling') { error('nmr', '未知NMR性质。'); break; }
      const nuclei = atoms.map((_, i) => i + 1).join(','); // EPRNMR Nuclei is 1-based.
      const lines = ['%eprnmr', '  Ori = GIAO', `  Nuclei = ${nuclei} { ${s.nmr === 'shielding' ? 'shift' : 'shift, ssall'} }`];
      lines.push('end'); result.blocksAfterCoordinates.push(lines.join('\n'));
      if (request.multiplicity !== 1 || s.unrestricted) warn('nmr', '普通核屏蔽不等于总顺磁化学位移；需单独核对适用性及参考物。');
      break;
    }
    case 'stable': {
      const lines = ['%scf', '  STABPerform true'];
      if (s.stableOptimize) {
        if (!s.unrestricted && request.multiplicity === 1) error('stableOptimize', '稳定轨道恢复仅用于已经确认的UHF/UKS目标，不自动将RKS改为破缺对称UKS。');
        else lines.push('  STABRestartUHFifUnstable true');
      } else lines.push('  STABRestartUHFifUnstable false');
      lines.push('end'); result.blocksBeforeCoordinates.push(lines.join('\n'));
      break;
    }
    case 'bsse': {
      if (s.fragmentStatesConfirmed === false) error('fragmentStatesConfirmed', '请确认全部BSSE片段的原子、电荷和多重度。');
      if (context.method.family === 'composite') error('method', '3c内置gCP不等于Boys–Bernardi CP，不能无解释叠加ghost校正；请选择显式轨道基组方法。');
      if (context.method.basisPolicy !== 'uniform-def2') error('method', 'BB-CP需要显式统一轨道基组，当前方法没有适用的ghost基组路线。');
      if (s.fragments.length < 2) error('fragments', 'BSSE必须定义至少2个完整且不重叠的片段。');
      const assigned = new Set<number>();
      const ids = new Set<string>();
      let charge = 0;
      let fragmentSpinSum = 0;
      let largestFragmentSpin = 0;
      const variants: NonNullable<OrcaTaskRender['variants']> = [{ suffix: 'complex', keywords: ['SP'], coordinateLines: atoms.map(atom => coordinateLine(atom, false)) }];
      for (const [row, fragment] of s.fragments.entries()) {
        const field = `fragments.${row}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(fragment.id) || ids.has(fragment.id)) error(field, '片段ID必须是唯一安全ASCII标识。');
        ids.add(fragment.id);
        if (!fragment.atomIds.length) error(field, '片段不能没有原子。');
        const selected = new Set<number>();
        for (const id of fragment.atomIds) {
          const index = atomIndex(id, field);
          if (index === null) continue;
          if (assigned.has(index)) error(field, '片段定义重叠或重复使用原子。');
          assigned.add(index); selected.add(index);
        }
        const fragmentAtoms = atoms.filter((_, i) => selected.has(i));
        if (fragmentAtoms.length) {
          const stateError = electronicStateError(fragmentAtoms, fragment.charge, fragment.multiplicity);
          if (stateError) error(field, `片段电子态：${stateError}`);
        }
        charge += fragment.charge;
        const spin = fragment.multiplicity - 1;
        if (Number.isInteger(spin) && spin >= 0) {
          fragmentSpinSum += spin;
          largestFragmentSpin = Math.max(largestFragmentSpin, spin);
        }
        variants.push({ suffix: `fragment-${row + 1}-ghost`, keywords: ['SP'], charge: fragment.charge,
          multiplicity: fragment.multiplicity, coordinateLines: atoms.map((atom, i) => coordinateLine(atom, !selected.has(i))) });
        variants.push({ suffix: `fragment-${row + 1}-ownbasis`, keywords: ['SP'], charge: fragment.charge,
          multiplicity: fragment.multiplicity, coordinateLines: fragmentAtoms.map(atom => coordinateLine(atom, false)) });
      }
      if (assigned.size !== atoms.length) error('fragments', 'BSSE所有原子必须恰好归属一个片段。');
      if (charge !== request.charge) error('fragments', '片段电荷之和必须等于全体系电荷。');
      const totalSpin = request.multiplicity - 1;
      const minimumSpin = Math.max(fragmentSpinSum % 2, 2 * largestFragmentSpin - fragmentSpinSum);
      if (!Number.isInteger(totalSpin) || totalSpin < minimumSpin || totalSpin > fragmentSpinSum || (fragmentSpinSum - totalSpin) % 2 !== 0) {
        error('fragments', '全体系自旋不在所给片段自旋允许的耦合范围内。');
      }
      result.variants = variants;
      warn('fragments', '各组件保持当前复合物几何：未校正交互能=Ecomplex−ΣEownbasis；CP交互能=Ecomplex−ΣEghost；BSSE校正量=Σ(Eownbasis−Eghost)。未自动优化单体。');
      if (atoms.some(atom => atomicNumber(atom.element) > 36)) warn('fragments', '重元素ghost/ECP需按目标版本读回核对；本模块保留原顺序与统一def2，不自动打开GhostECP。');
      break;
    }
    default: error('task', `任务${String(s.task)}不属于普通ORCA任务渲染器，须使用对应专用模块。`);
  }
  if(optimizing&&optimization?.convergence&&optimization.convergence!=='default'){
    result.keywords=result.keywords.filter(keyword=>!['LooseOpt','NormalOpt','TightOpt','VeryTightOpt'].includes(keyword));
    result.keywords.push(({loose:'LooseOpt',normal:'NormalOpt',tight:'TightOpt',verytight:'VeryTightOpt'} as const)[optimization.convergence]);
  }
  const hasFrequency=result.keywords.some(keyword=>['Freq','NumFreq'].includes(keyword));
  if(hasFrequency&&s.frequency){
    const lines:string[]=[];
    for(const [key,keyword] of [['temperatureK','Temp'],['pressureAtm','Pressure']] as const){const n=s.frequency[key];if(n!==undefined){if(!Number.isFinite(n)||n<=0)error('frequency.'+key,'热化学温度和压力须为正有限数值。');else lines.push('  '+keyword+' '+n);}}
    if(lines.length)result.blocksBeforeCoordinates.push(['%freq',...lines,'end'].join('\n'));
    if(s.frequency.raman){
      if(context.method.family==='xtb'||s.task==='tdopt'&&!s.excited.useUks||s.version!=='6.1'&&!result.keywords.includes('NumFreq'))error('frequency.raman','当前方法或版本的既有频率路线不支持Raman；本选项不切换数值频率方法。');
      else result.blocksBeforeCoordinates.push('%elprop\n  Polar 1\nend');
    }
  }
  if (geometryLines.length) result.blocksBeforeCoordinates.push(['%geom', ...geometryLines, 'end'].join('\n'));
  return result;
}

function coordinateLine(atom: Atom, ghost: boolean): string {
  return `${atom.element}${ghost ? ':' : ''} ${atom.x} ${atom.y} ${atom.z}`;
}

