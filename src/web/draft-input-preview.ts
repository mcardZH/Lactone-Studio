import { basisPlan, defaultFiles, headerLines, routeLine } from '../core/gaussian';
import { gaussianRealToken } from '../core/gaussian-real-token';
import { mixedBasisErrors } from '../core/mixed-basis';
import { activeFrozenAtoms, coordinateAction, constraintsEnabled, defaultTaskOptions, isOptimizationTask } from '../core/tasks';
import { isQstTask } from '../core/gaussian-qst';
import { buildGaussianSolvation } from '../core/solvents';
import { getOrcaCommonCompatibility } from '../core/orca/common';
import { getOrcaMethodProfile } from '../core/orca/catalog';
import { renderOrcaTask } from '../core/orca/tasks';
import { mergeOrcaScfBlocks, normalizeOrcaScientificKeywords, orcaReferenceKeywords, renderOrcaHeader } from '../core/orca/header';
import type { OrcaJobRequest, OrcaCoordinate } from '../core/orca/types';
import type { Atom, JobRequest, Structure } from '../core/types';

const missing = (label: string) => `[待${label}]`;
const selected = (value: string | undefined, label: string) => value?.trim() || missing(label);
const numeric = (value: number | null | undefined, label: string) => value != null && Number.isFinite(value) ? String(value) : missing(label);
const positiveInteger = (value: number | null | undefined, label: string) => value != null && Number.isSafeInteger(value) && value > 0 ? String(value) : missing(label);
const charge = (value: number) => Number.isSafeInteger(value) ? String(value) : missing('填电荷');
const state = (q: number, m: number) => `${charge(q)} ${positiveInteger(m, '填多重度')}`;
const coordinate = (value: number) => Number.isFinite(value) ? value.toFixed(10) : missing('补坐标');

function atoms(structure: Structure | null): Atom[] | null {
  return structure?.atoms.length && structure.dimension !== 2 && !structure.cell?.pbc.some(Boolean) ? structure.atoms : null;
}
function cartesian(structure: Structure | null, gaussian: boolean, frozen: number[] = []): string[] {
  const source = atoms(structure);
  if (!source) return [missing('补三维坐标')];
  return source.map((atom, i) => gaussian
    ? `${atom.element.padEnd(3)}${frozen.includes(i + 1) ? ' -1' : ''} ${coordinate(atom.x).padStart(16)} ${coordinate(atom.y).padStart(16)} ${coordinate(atom.z).padStart(16)}`
    : `${atom.element} ${coordinate(atom.x)} ${coordinate(atom.y)} ${coordinate(atom.z)}`);
}

function gaussianCoordinateTail(request: JobRequest): string[] {
  const s = request.settings, o = s.taskOptions;
  if (!o) return [];
  if (o.coordinateDrafts !== undefined) return o.coordinateDrafts.filter(row => row.enabled && (row.action === 'scan' ? s.task === 'scan' : constraintsEnabled(s))).map(row => {
    const indices = row.atomText.trim() || missing('选原子');
    return `${row.type} ${indices}${row.action === 'scan' ? ` S ${selected(row.stepsText, '填步数')} ${gaussianRealToken(selected(row.incrementText, '填增量'))}` : ' F'}`;
  });
  return o.coordinates.filter(row => coordinateAction(row, s.task) === 'scan' ? s.task === 'scan' : constraintsEnabled(s)).map(row => `${row.type} ${row.atoms.join(' ') || missing('选原子')}${coordinateAction(row, s.task) === 'scan' ? ` S ${positiveInteger(row.steps, '填步数')} ${gaussianRealToken(numeric(row.increment, '填增量'))}` : ' F'}`);
}

/** Preview uses the native serializers; placeholders do not validate or repair the request. */
export function gaussianDraftInputPreview(request: JobRequest): string {
  const s = request.settings, f = request.files ?? defaultFiles(), o = s.taskOptions ?? defaultTaskOptions();
  let plan: { keyword: string; tail: string };
  if (s.mixedBasis?.enabled && mixedBasisErrors(request).length) plan = { keyword: 'gen', tail: missing('补基组/ECP附加段') + '\n\n' };
  else if (s.basis === 'ma-def2TZVP' && !atoms(request.structure) && f.geometry === 'explicit') plan = { keyword: 'genecp', tail: missing('补基组/ECP附加段') + '\n\n' };
  else {
    // Only a missing external basis section is converted into a draft placeholder.
    // Other failures propagate; all scientific errors remain outside the input.
    try { plan = basisPlan(request); }
    catch (cause) { if (!(cause instanceof Error) || !/ma-def2-TZVP缺少元素/.test(cause.message)) throw cause; plan = { keyword: 'genecp', tail: missing('补基组/ECP附加段') + '\n\n' }; }
  }
  if (!plan.keyword && !['pm6', 'pm7', 'gfn2-xtb'].includes(s.method) && !(s.task === 'td' && o.excited.approximation === 'zindo') && !(s.task === 'freq' && f.hessian === 'readfc')) plan.keyword = missing('选基组');
  const methodSettings = s.method === 'custom' && !s.customMethod.trim() ? { ...s, customMethod: missing('选方法') } : s;
  let route = routeLine(methodSettings, f, plan.keyword, request.structure?.atoms.length);
  const coordinateTail = gaussianCoordinateTail(request);
  if (coordinateTail.length && !/modredundant/.test(route)) {
    if (isOptimizationTask(s.task)) route = route.replace(/\bopt(?:=(\([^)]*\)|[^\s]+))?/, (_, options:string|undefined) => `opt=(${options ? options.replace(/^\(|\)$/g,'') + ',' : ''}modredundant)`);
    else if (s.task === 'freq') route = route.replace(/\bfreq(?:=([^\s]+))?/, (_, options:string|undefined) => options ? `freq=(${options},modredundant)` : 'freq=modredundant');
    else if (s.task === 'irc') route += ' geom=modredundant';
  }
  // Null is the current automatic mode. Other invalid values, including an
  // omitted legacy field, match the generation validator and remain placeholders.
  if (s.task === 'irc' && o.irc.maxPoints !== null && (!Number.isSafeInteger(o.irc.maxPoints) || o.irc.maxPoints < 1 || o.irc.maxPoints > 10000)) route = route.replace(/maxpoints=[^,)\s]+/, 'maxpoints=' + missing('填点数'));
  route = route.replace(/(?:NaN|Infinity|-Infinity)/g, missing('补数值'));
  const validMemory = Number.isSafeInteger(request.memoryGB) && request.memoryGB > 0;
  const validCores = Number.isSafeInteger(request.cores) && request.cores > 0;
  const headers = headerLines({...request, memoryGB:validMemory?request.memoryGB:0, cores:validCores?request.cores:0});
  if (f.saveCheckpoint && !f.checkpointName.trim() && !request.name.trim()) headers.splice(headers.findIndex(line => line.startsWith('%chk=')), 1, '%chk=' + missing('填CHK名称'));
  if (f.writeMemory && !validMemory) headers.push('%mem=' + missing('填内存') + 'GB');
  if (f.writeCores && !validCores && s.method !== 'gfn2-xtb') headers.push('%nprocshared=' + missing('填核数'));
  const sections = [...headers, route, ''];
  if (isQstTask(s.task)) {
    const sources = [s.qst?.reactantSource, s.qst?.product, ...(s.task === 'qst3' ? [s.qst?.tsGuess] : [])];
    sources.forEach((source, i) => sections.push(selected(i === 0 ? request.title : source?.label, i === 0 ? '填标题' : i === 1 ? '选产物' : '选TS猜测'), '', state(source?.charge ?? request.charge, source?.multiplicity ?? request.multiplicity), ...cartesian(source?.structure ?? null, true), ''));
  } else if (f.geometry !== 'allcheck') {
    const fragmentState = s.task === 'bsse' ? ' ' + o.fragments.map(fragment => state(fragment.charge, fragment.multiplicity)).join(' ') : '';
    sections.push('Generated by Ester Studio', '', state(request.charge, request.multiplicity) + fragmentState);
    if (f.geometry === 'explicit') {
      if (s.oniom?.enabled) sections.push(missing('补ONIOM原子类型及层定义'));
      else {
        const rows = cartesian(request.structure, true, activeFrozenAtoms(request));
        sections.push(...(s.task === 'bsse' && atoms(request.structure) ? rows.map((row, i) => row.replace(/^\S+/, request.structure!.atoms[i].element + `(Fragment=${o.fragments.findIndex(fragment => fragment.atoms.includes(i + 1)) + 1 || missing('分片')})`)) : rows));
      }
    }
    sections.push('');
  }
  const solvent = buildGaussianSolvation({ ...s, requireRefractiveIndex: ['td', 'tdopt'].includes(s.task) });
  if (solvent.issues.length && (s.solvent.trim() || s.solvation)) {
    if (!/\bscrf=/i.test(route)) sections[headers.length] += ` scrf=(${s.solventModel},solvent=${s.solvation?.mode === 'custom' ? 'generic,read' : missing('选溶剂')})`;
    if (s.solvation?.mode === 'custom') sections.push('Eps=' + numeric(s.solvation.custom?.dielectric, '填介电常数'), missing('补溶剂参数'), '');
  }
  sections.push(...coordinateTail);
  return (sections.join('\n') + '\n' + plan.tail + (s.inheritedRoute?.solvent || s.task === 'freq' && f.hessian === 'readfc' ? '' : solvent.tail)).trimEnd() + '\n\n\n';
}

function orcaGeometry(request: OrcaJobRequest): string[] {
  const s = request.settings;
  const index = (id: string) => { const value = request.structure?.atoms.findIndex((atom, i) => (atom.id ?? `atom-${i + 1}`) === id) ?? -1; return value < 0 ? missing('选原子') : String(value); };
  const indices = (row: OrcaCoordinate) => Array.from({length:{B:2,A:3,D:4}[row.type]}, (_, i) => row.atomIds[i] ? index(row.atomIds[i]) : missing('选原子')).join(' ');
  const scans = s.constraints.filter(row => row.action === 'scan' && s.task === 'scan').map(row => `    ${row.type} ${indices(row)} ${row.values ? `[ ${row.values.map(value => numeric(value, '补扫描值')).join(' ')} ]` : `= ${numeric(row.start, '填起点')}, ${numeric(row.end, '填终点')}, ${positiveInteger(row.steps, '填点数')}`}`);
  if (s.task === 'scan' && !scans.length) scans.push('    ' + missing('选扫描坐标'));
  const frozen = [...s.frozenAtomIds.map(id => `    { C ${index(id)} C }`), ...s.constraints.filter(row => row.action === 'freeze').map(row => `    { ${row.type} ${indices(row)}${row.value === undefined ? '' : ' ' + numeric(row.value, '补冻结值')} C }`)];
  return scans.length || frozen.length ? ['%geom', ...(scans.length ? ['  Scan', ...scans, '  end'] : []), ...(frozen.length ? ['  Constraints', ...frozen, '  end'] : []), 'end'] : [];
}

export function orcaDraftInputPreview(request: OrcaJobRequest): string {
  const version = getOrcaCommonCompatibility(request).syntaxVersion;
  request = { ...request, settings: { ...request.settings, version } };
  const s = request.settings, profile = getOrcaMethodProfile(s.method, version);
  const header = renderOrcaHeader(request, profile, missing);
  const keywords = [...header.keywords, ...orcaReferenceKeywords(request, profile, s.multiscale.mode === 'none' ? request.multiplicity : s.multiscale.qmMultiplicity)];
  const before: string[] = [...header.blocks], after: string[] = [];
  if (profile && !['neb', 'esd', 'md'].includes(s.task)) {
    const rendered = renderOrcaTask({ ...request, settings: { ...s, constraints: [], frozenAtomIds: [] } }, { stem: request.name, method: profile, atomIndex: id => request.structure?.atoms.findIndex((atom, i) => (atom.id ?? `atom-${i + 1}`) === id) ?? -1, asset: (id, kind) => request.assets.find(asset => asset.id === id && asset.kind === kind) });
    keywords.push(...rendered.keywords); before.push(...rendered.blocksBeforeCoordinates); after.push(...rendered.blocksAfterCoordinates);
    if (s.task === 'bsse') keywords.push('SP');
  }
  const solvent = header.solvent;
  if (solvent.issues.length && (s.solvent.trim() || s.solvation)) before.push(`%cpcm\n  ${s.solvation?.mode === 'custom' ? 'epsilon ' + numeric(s.solvation.custom?.dielectric, '填介电常数') : 'solvent "' + missing('选溶剂') + '"'}\n  ${missing('补溶剂参数')}\nend`);
  if (s.ircHessianId && ['ts', 'irc'].includes(s.task) && !before.some(block => /Hess(?:Name|_Filename)/.test(block))) {
    const name = selected(request.assets.find(asset => asset.id === s.ircHessianId)?.name, '选Hessian');
    const lines = s.task === 'ts' ? `  InHess Read\n  InHessName "${name}"` : `  InitHess Read\n  Hess_Filename "${name}"`;
    const block = s.task === 'ts' ? '%geom' : '%irc', existing = before.findIndex(value => value.startsWith(block+'\n'));
    if (existing >= 0) before[existing] = before[existing].replace(/\nend$/, '\n'+lines+'\nend');
    else before.push(block+'\n'+lines+'\nend');
  }
  if (s.task === 'neb') { keywords.push('NEB-CI'); before.push(`%neb\n  NEB_END_XYZFILE "${missing('补产物XYZ')}"\n  NImages ${Number.isSafeInteger(s.neb.images) && s.neb.images >= 3 ? s.neb.images - 2 : missing('填图像数')}\nend`); }
  if (s.task === 'esd') { keywords.push(`ESD(${s.esd.channel.toUpperCase()})`); before.push(`%esd\n  TEMP ${numeric(s.esd.temperatureK, '填温度')}\n  ${missing('补双态Hessian及来源')}\nend`); }
  if (s.task === 'md') { keywords.push('MD'); before.push(`%md\n  Timestep ${numeric(s.md.timestepFs, '填步长')}_fs\n  Initvel ${numeric(s.md.initialTemperatureK, '填温度')}_K No_Overwrite\n  ${s.md.thermostat === 'none' ? 'Thermostat None' : `Thermostat ${s.md.thermostat.toUpperCase()} ${numeric(s.md.targetTemperatureK, '填目标温度')}_K Timecon ${numeric(s.md.couplingTimeFs, '填耦合时间')}_fs`}\n  Run ${positiveInteger(s.md.steps, '填步数')} CenterCOM\nend`); }
  before.push(...orcaGeometry(request));
  if (s.multiscale.mode !== 'none') before.push('%qmmm\n  ' + missing('补QM/MM层定义') + '\nend');
  const cores = positiveInteger(request.cores, '填核数');
  const maxcore = Number.isSafeInteger(request.cores) && request.cores > 0 && Number.isFinite(request.memoryGB) && request.memoryGB > 0 ? String(Math.floor(request.memoryGB * 1024 * .75 / request.cores)) : missing('填每核内存');
  const text = ['# Generated by Ester Studio', `! ${normalizeOrcaScientificKeywords(keywords, s).join(' ')}`, `%pal nprocs ${cores} end`, `%maxcore ${maxcore}`, ...mergeOrcaScfBlocks(before), `* xyz ${state(request.charge, request.multiplicity)}`, ...cartesian(request.structure, false), '*', ...after, '', ''].join('\n');
  let output = text.replace(/(?:NaN|Infinity|-Infinity)/g, missing('补数值')).replace(/(NRoots|IRoot) (?:0|null|undefined)(?=\n)/g, '$1 ' + missing('填态数'));
  if (['stda','stddft'].includes(s.excited.approximation)) {
    for (const [key,keyword] of [['energyWindowEV','EThresh'],['selectionThresholdEh','PThresh'],['perturbationWindowEV','PTLimit']] as const) {
      if (s.excited[key] == null) output = output.replace(new RegExp(`(${keyword}) [^\\n]+`), '$1 ' + missing('填参数'));
    }
  }
  return output;
}
