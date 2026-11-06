import type { Structure } from '../core/types';
import { atomicNumber, electronicStateError } from '../core/elements';
import type { XtbElectronicArtifactBundle, XtbRequest, XtbSolvation, XtbSolvationEvidence } from '../modeling/xtb/contracts';
import type { ResultInputFile } from './contracts';
import type { WavefunctionMetadata } from './orbital-contracts';
import {isGeneratedXtbAnalysisPolicy,type GeneratedXtbAnalysisPolicy} from './generated-xtb-policy';
import { emptyScientificData, SCIENTIFIC_NUMBER, scientificNumber, type ScientificField } from './scientific-contracts';
import { readPostprocessWavefunction, type PostprocessSource } from './postprocess-sources';
import { parseMoldenStructure } from './molden-structure-reader';
import { retainPostprocessSourceText, type PostprocessAttachment } from './postprocess-document';

export interface GeneratedXtbSourcePackage { schema: 1; bundle: XtbElectronicArtifactBundle; expected: GeneratedXtbExpected; analysisPolicy?: GeneratedXtbAnalysisPolicy }
const generatedPackages = new WeakMap<PostprocessSource, () => Promise<GeneratedXtbSourcePackage>>();
/** Source evidence is retained independently from the live orbital session. */
export function retainGeneratedXtbSourcePackage(source: PostprocessSource, read: () => Promise<GeneratedXtbSourcePackage>): void {
  let closed = false;
  generatedPackages.set(source, async () => { if (closed) throw Error('GFN2原始来源包已关闭。'); const value = await read(); if (closed) throw Error('GFN2原始来源包已关闭。'); return structuredClone(value); });
  for (const result of new Set([source.result, ...source.results])) { const dispose = result.dispose.bind(result); result.dispose = async () => { closed = true; generatedPackages.delete(source); await dispose(); }; }
}
export async function readGeneratedXtbSourcePackage(source: PostprocessSource): Promise<GeneratedXtbSourcePackage | undefined> {
  return generatedPackages.get(source)?.();
}

export interface GeneratedXtbExpected {
  sessionId: string;
  request: XtbRequest;
  taskId?: string;
  runId?: string;
  /** Background completion only adds a result; activation needs a fresh UI action. */
  activate?: false;
}
export interface GeneratedXtbProvenance {
  kind: 'trusted-generated-gfn2-sp'; artifactId: string; sessionId: string;
  stamp: XtbElectronicArtifactBundle['stamp'];
  runIdentity?: { taskId: string; runId: string };
  files: readonly { role: string; name: string; bytes: number; sha256: string }[];
  /** Native thresholded observations, not a complete zero-filled bond matrix. */
  nativeBondOrders?: XtbElectronicArtifactBundle['metadata']['bondOrders'];
  solvation?: XtbSolvationEvidence;
  /** Derived methods require their own scientific acceptance; a Molden is not that proof. */
  capabilities: readonly ['native-properties', 'orbitals'];
  /** Exact immutable-host applicability policy; absent legacy sources remain restricted. */
  analysisPolicy?:GeneratedXtbAnalysisPolicy;
}
const filesByRole = { molden: 'molden.input', stdout: 'stdout.log', stderr: 'stderr.log', wbo: 'wbo' } as const;
const fail = (message: string): never => { throw new Error(message); };
const finite = (token: string): number | null => scientificNumber(token);
const sameStamp = (a: XtbElectronicArtifactBundle['stamp'], b: XtbElectronicArtifactBundle['stamp']) =>
  ['documentId', 'revision', 'graphFingerprint', 'coordinatesFingerprint', 'constraintsFingerprint'].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);

/** Same fixed native setup grammar as the host; never infer liquid-phase settings from a prior result. */
export function parseGeneratedXtbSolvation(text: string, expected?: XtbSolvation): { evidence: XtbSolvationEvidence; sourceLine: number; fields: ScientificField[] } | undefined {
  const output = text.replace(/\r\n?/g, '\n'), markers = [...output.matchAll(/^[ \t]*\*[ \t]+Solvation model:[ \t]+([^\n]+)$/gm)];
  if (expected === undefined) {
    if (/^[ \t]*\*?[ \t]*Solvation model:/m.test(output)) fail('气相GFN2请求的原生输出却包含溶剂模型。');
    return undefined;
  }
  if (!['alpb', 'gbsa'].includes(expected.model) || markers.length !== 1) return fail('GFN2原生溶剂设置缺失或不唯一。');
  const marker = markers[0], tail = output.slice(marker.index, marker.index! + 8192), end = /^[ \t]+Grid points[ \t]+\d+[ \t]+per atom[ \t]*$/m.exec(tail);
  if (!end) return fail('GFN2原生溶剂设置不完整。');
  const block = tail.slice(0, end.index), sourceLine = output.slice(0, marker.index).split('\n').length;
  // Locked Fortran info() uses 8x,a,t40; Solvent mass is a separate label.
  const rows = (label: string) => block.split('\n').map((line, index) => ({ line, index })).filter(row => row.line.startsWith('        ') && row.line.slice(8, 39).trimEnd() === label);
  const fieldRow = (label: string) => { const matches = rows(label); if (matches.length !== 1) return fail(`GFN2原生溶剂字段${label}缺失或不唯一。`); return matches[0]; };
  const field = (label: string) => fieldRow(label).line.slice(39).trim();
  const fieldLine = (label: string) => sourceLine + fieldRow(label).index;
  const parameterSet = `internal GFN2-xTB/${expected.model.toUpperCase()}`, kernel = expected.model === 'alpb' ? 'p16' : 'still';
  const temperature = field('Temperature').match(new RegExp(`^(${SCIENTIFIC_NUMBER})[ \\t]+K$`));
  if (marker[1].trim() !== expected.model.toUpperCase() || field('Solvent') !== expected.solvent || field('Parameter file') !== parameterSet
    || field('Interaction kernel') !== (kernel === 'p16' ? 'P16' : 'Still') || field('Reference state') !== 'gsolv [1 M gas/solution]'
    || !temperature || finite(temperature[1]) !== 298.15) fail('GFN2原生溶剂模型、溶剂、参数集、核、参考态或温度与请求不一致。');
  const evidence: XtbSolvationEvidence = { ...expected, kernel, referenceState: 'gsolv', temperatureKelvin: 298.15, parameterSet, sourceField: 'stdout:solvation-model' };
  const fields: ScientificField[] = [
    { key: 'solvent-model', label: '溶剂模型', value: expected.model.toUpperCase(), sourceLine, frameIndex: 0 },
    { key: 'solvent', label: '溶剂', value: expected.solvent, sourceLine: fieldLine('Solvent'), frameIndex: 0 },
    { key: 'solvation-reference-state', label: '溶剂参考态', value: 'gsolv [1 M gas/solution]', sourceLine: fieldLine('Reference state'), frameIndex: 0 },
    { key: 'solvation-temperature', label: '溶剂温度', value: 298.15, unit: 'K', sourceLine: fieldLine('Temperature'), frameIndex: 0 },
    { key: 'solvation-parameter-set', label: '溶剂参数集', value: parameterSet, sourceLine: fieldLine('Parameter file'), frameIndex: 0 },
    { key: 'solvation-kernel', label: '溶剂作用核', value: kernel, sourceLine: fieldLine('Interaction kernel'), frameIndex: 0 },
  ];
  const dielectric = rows('Dielectric constant'), epsilon = dielectric.length === 1 ? finite(dielectric[0].line.slice(39).trim()) : null;
  if (epsilon !== null && epsilon > 0) fields.push({ key: 'solvent-epsilon', label: '介电常数', value: epsilon, rawValue: dielectric[0].line.slice(39).trim(), sourceLine: sourceLine + dielectric[0].index, frameIndex: 0 });
  return { evidence, sourceLine, fields };
}

/** Native output parser, never a producer classifier for arbitrary external Molden. */
export function parseGeneratedXtbStdout(text: string, atoms: readonly { element: string }[], sourceId: string, sourceName = 'stdout.log') {
  const data = emptyScientificData(); data.tasks = ['sp']; data.source = { id: sourceId, name: sourceName };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const put = (key: string, label: string, token: string, unit: string | undefined, index: number, target: ScientificField[] = data.properties) => {
    const value = finite(token); if (value === null) return;
    target.push({ key, label, value, rawValue: token, ...(unit ? { unit } : {}), sourceLine: index + 1, frameIndex: 0, sourceId, sourceName });
  };
  let convergenceLine = -1, iterations: number | null = null, energy: { value: number; token: string; sourceLine: number } | null = null;
  let normalTermination = false, failed = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]; let match: RegExpMatchArray | null;
    if ((match = line.match(/\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)/i))) data.version = match[1];
    if (/FAILED TO CONVERGE|convergence criteria cannot be satisfied|ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR|GEOMETRY OPTIMIZATION/i.test(line)) failed = true;
    if (/^\s*normal termination of xtb\s*$/i.test(line)) normalTermination = true;
    if ((match = line.match(/^\s*\*{3}\s+convergence criteria satisfied after\s+(\d+)\s+iterations\s+\*{3}\s*$/i))) {
      if (convergenceLine !== -1) failed = true;
      convergenceLine = index; iterations = Number(match[1]);
      if (!Number.isSafeInteger(iterations) || iterations < 1) { failed = true; iterations = null; }
      else {
        data.summary.push({ key: 'scf-status', label: 'SCC收敛', value: 'converged', frameIndex: 0, sourceLine: index + 1, sourceId, sourceName });
        put('scf-iterations', 'SCC轮数', match[1], undefined, index, data.summary);
      }
    }
    if ((match = line.match(new RegExp(`^\\s*\\|\\s*TOTAL ENERGY\\s+(${SCIENTIFIC_NUMBER})\\s+Eh\\s*\\|`, 'i')))) {
      const value = finite(match[1]);
      if (value !== null && convergenceLine >= 0 && index > convergenceLine) energy = { value, token: match[1], sourceLine: index + 1 };
      else failed = true;
    }
    if ((match = line.match(new RegExp(`^\\s*(?:::|\\|)\\s*HOMO-LUMO (?:gap|GAP)\\s+(${SCIENTIFIC_NUMBER})\\s+eV`, 'i')))) put('homo-lumo-gap', 'HOMO–LUMO间隙', match[1], 'eV', index);
    if ((match = line.match(new RegExp(`^\\s*::\\s*(SCC energy|repulsion energy|-> isotropic ES|-> anisotropic ES|-> anisotropic XC|-> dispersion|add\\. restraining)\\s+(${SCIENTIFIC_NUMBER})\\s+Eh`, 'i')))) {
      const names: Record<string, [string, string]> = { 'scc energy': ['xtb-scc-energy', 'SCC能量'], 'repulsion energy': ['xtb-repulsion-energy', '排斥能'], '-> isotropic es': ['xtb-isotropic-es-energy', '各向同性静电能'], '-> anisotropic es': ['xtb-anisotropic-es-energy', '各向异性静电能'], '-> anisotropic xc': ['xtb-anisotropic-xc-energy', '各向异性交换相关能'], '-> dispersion': ['xtb-dispersion-energy', '色散能'], 'add. restraining': ['xtb-restraining-energy', '附加约束能'] };
      const [key, label] = names[match[1].toLowerCase()]; put(key, label, match[2], 'hartree', index);
    }
    if (/^\s*iter\s+E\s+dE\s+RMSdq\s+gap\s+omega\s+full diag\s*$/i.test(line)) {
      const points = [];
      for (let next = index + 1; next < lines.length; next++) {
        const row = lines[next].trim().split(/\s+/);
        if (!/^\d+$/.test(row[0]) || row.length !== 7) break;
        const iteration = Number(row[0]), values = row.slice(1, 6).map(finite);
        if (!Number.isSafeInteger(iteration) || iteration < 1 || values.some(value => value === null) || !/^[TF]$/.test(row[6])) break;
        points.push({ iteration, energy: values[0], deltaEnergy: values[1], sourceLine: next + 1 });
      }
      if (points.length) data.scfCycles.push({ frameIndex: 0, sourceLine: index + 1, sourceId, sourceName, unit: 'hartree', deltaEnergyUnit: 'hartree', points });
    }
    if (/^\s*molecular dipole:\s*$/i.test(line) && /^\s*x\s+y\s+z\s+tot \(Debye\)\s*$/i.test(lines[index + 1] ?? '')) {
      // x/y/z use native atomic units; only the final column is Debye.
      // The existing Dipole Moment:X contract converts the saved vector for display.
      for (let next = index + 2; next <= index + 4; next++) {
        const full = lines[next]?.match(new RegExp(`^\\s*full:\\s+(${SCIENTIFIC_NUMBER})\\s+(${SCIENTIFIC_NUMBER})\\s+(${SCIENTIFIC_NUMBER})\\s+(${SCIENTIFIC_NUMBER})\\s*$`));
        if (full && full.slice(1).every(token => finite(token) !== null)) {
          ['X', 'Y', 'Z'].forEach((axis, component) => put(`Dipole Moment:${axis}`, `完整偶极矩 μ${axis.toLowerCase()}`, full[component + 1], 'e·bohr', next));
          put('dipole-total', '完整偶极矩 |μ|', full[4], 'Debye', next); break;
        }
      }
    }
    if (/^\s*#\s+Z\s+covCN\s+q\s+C6AA\s+(?:α|alpha)\(0\)\s*$/i.test(line)) {
      const values = [];
      for (let offset = 0; offset < atoms.length; offset++) {
        const row = lines[index + 1 + offset]?.trim().split(/\s+/) ?? [];
        if (row.length !== 7 || Number(row[0]) !== offset + 1 || row[2] !== atoms[offset].element || Number(row[1]) !== atomicNumber(atoms[offset].element) || row.slice(3).some(token => finite(token) === null)) break;
        values.push({ atomIndex: offset, element: row[2], value: finite(row[4])! });
      }
      if (values.length === atoms.length && atoms.length) data.atomicProperties.push({ kind: 'charge', scheme: 'GFN2-xTB', frameIndex: 0, sourceLine: index + 1, sourceId, sourceName, unit: 'e', values });
      else data.notices.push('GFN2原子电荷表不完整或原子对应不符，未发布该表。');
    }
  }
  if (energy) data.properties.push({ key: 'final-energy', label: '总电子能 E', value: energy.value, rawValue: energy.token, unit: 'hartree', sourceLine: energy.sourceLine, frameIndex: 0, sourceId, sourceName });
  return { data, energy, iterations, converged: !failed && iterations !== null && energy !== null, normalTermination, failed };
}

/** Validate only host-returned retained bundles, against the immutable launching request. */
export async function validateGeneratedXtbBundle(bundle: XtbElectronicArtifactBundle, expected: GeneratedXtbExpected) {
  const { request } = expected, metadata = bundle.metadata;
  if (!bundle.artifactId || bundle.artifactId.length > 100 || bundle.sessionId !== expected.sessionId || !sameStamp(bundle.stamp, request.stamp)
    || request.method !== 'gfn2' || request.calculation !== 'singlepoint' || request.electronicProperties !== true || request.structure.cell || metadata.periodic
    || request.structure.periodicSource?.completeness === 'partial' || request.structure.bonds?.some(bond => bond.image?.some(value => value !== 0))
    || metadata.method !== 'gfn2' || metadata.engine !== 'xtb' || metadata.calculation !== 'singlepoint' || metadata.converged !== true
    || metadata.energyUnit !== 'hartree' || metadata.coordinateUnit !== 'angstrom' || !Number.isFinite(metadata.energyHartree)
    || metadata.charge !== request.charge || metadata.uhf !== request.uhf || !Number.isSafeInteger(metadata.uhf) || metadata.uhf! < 0
    || electronicStateError(request.structure.atoms, metadata.charge, metadata.uhf! + 1)) fail('GFN2自产来源与单点请求身份或科学范围不一致。');
  const run = request.runIdentity;
  if ((expected.taskId === undefined) !== (expected.runId === undefined)
    || run && (bundle.runIdentity?.taskId !== run.taskId || bundle.runIdentity?.runId !== run.runId)
    || expected.taskId !== undefined && (bundle.runIdentity?.taskId !== expected.taskId || bundle.runIdentity?.runId !== expected.runId)) fail('GFN2自产来源任务/run身份不一致。');
  const atoms = metadata.orderedAtoms;
  if (!atoms.length || atoms.length !== request.structure.atoms.length || new Set(atoms.map(atom => atom.id)).size !== atoms.length
    || atoms.some((atom, index) => { const original = request.structure.atoms[index]; return !atom.id || atom.id !== original.id || atom.element !== original.element || ['x', 'y', 'z'].some(axis => !Number.isFinite(atom[axis as 'x']) || atom[axis as 'x'] !== original[axis as 'x']); })) fail('GFN2自产来源原子顺序或原始坐标不一致。');
  if (bundle.files.length < 2 || bundle.files.length > 4 || new Set(bundle.files.map(file => file.role)).size !== bundle.files.length) fail('GFN2自产来源文件清单无效。');
  let total = 0;
  for (const file of bundle.files) {
    const encoded = new TextEncoder().encode(file.text); total += encoded.byteLength;
    if (file.name !== filesByRole[file.role] || file.bytes !== encoded.byteLength || total > 64 * 1024 ** 2) fail('GFN2自产来源文件字节或角色不一致。');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== file.sha256) fail('GFN2自产来源SHA与宿主清单不一致。');
  }
  const molden = bundle.files.find(file => file.role === 'molden'), stdout = bundle.files.find(file => file.role === 'stdout');
  if (!molden || !stdout) return fail('GFN2自产来源缺少Molden或原生输出。');
  const lines = molden.text.replace(/\r\n?/g, '\n').split('\n'), atomLine = lines.findIndex(line => /^\s*\[Atoms\]\s+AU\s*$/i.test(line));
  if (atomLine < 0 || !/^\s*\[Molden Format\]/i.test(molden.text) || !/^\[GTO\]\s*$/mi.test(molden.text) || !/^\[MO\]\s*$/mi.test(molden.text) || !molden.text.endsWith('\n')) fail('GFN2自产Molden缺少完整原生包络。');
  const geometry=parseMoldenStructure(molden.text,molden.name,`xtb-${bundle.artifactId}:molden`);
  if(geometry.unit!=='AU'||geometry.structure.atoms.length!==atoms.length)fail('GFN2自产Molden原子数或原子单位不一致。');
  const coordinateTolerance: number[] = [];
  atoms.forEach((atom, index) => {
    const parsedAtom=geometry.structure.atoms[index],allowed=geometry.coordinateRoundingByAxisAngstrom[index].map(value=>value+1e-10);
    if(parsedAtom.element!==atom.element||geometry.sourceLabels[index]!==atom.element)fail('GFN2自产Molden原子对应不一致。');
    if(allowed.some(value=>value>1e-5)||['x','y','z'].some((axis,offset)=>Math.abs(parsedAtom[axis as 'x']-atom[axis as 'x'])>allowed[offset]))fail('GFN2自产Molden几何不匹配或打印精度不足。');
    coordinateTolerance.push(Math.max(1e-10,...allowed));
  });
  const following = lines.slice(atomLine + 1 + atoms.length).find(line => line.trim());
  if (!/^\s*\[/.test(following ?? '')) fail('GFN2自产Molden原子数与请求不一致。');
  const parsed = parseGeneratedXtbStdout(stdout.text, atoms, `xtb-${bundle.artifactId}:stdout`);
  const solvation = parseGeneratedXtbSolvation(stdout.text, request.solvation), evidence = metadata.solvation;
  const solvationKeys = ['model', 'solvent', 'kernel', 'referenceState', 'temperatureKelvin', 'parameterSet', 'sourceField'] as const;
  if (solvation === undefined ? evidence !== undefined : !evidence || Object.keys(evidence).length !== solvationKeys.length || solvationKeys.some(key => solvation.evidence[key] !== evidence[key])) fail('GFN2溶剂宿主元数据与同一原生输出不一致。');
  if (solvation) parsed.data.summary.push(...solvation.fields.map(field => ({ ...field, sourceId: parsed.data.source!.id, sourceName: stdout.name })));
  const stderr = bundle.files.find(file => file.role === 'stderr');
  if (stderr && /FAILED TO CONVERGE|convergence criteria cannot be satisfied|ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR/i.test(stderr.text)) fail('GFN2自产stderr记录原生失败，未接入为已收敛来源。');
  if (stderr && /^\s*normal termination of xtb\s*$/mi.test(stderr.text)) parsed.normalTermination = true;
  if (!parsed.converged || parsed.data.version !== metadata.version || parsed.energy?.value !== metadata.energyHartree) fail('GFN2自产原生输出未证明同一次SCC收敛、版本或最终能量。');
  if (metadata.sccIterations !== undefined && metadata.sccIterations !== parsed.iterations) fail('GFN2自产SCC轮数与宿主元数据不一致。');
  const wbo = bundle.files.find(file => file.role === 'wbo'), bondOrders = metadata.bondOrders;
  if (wbo || bondOrders) {
    if (!wbo || !bondOrders || bondOrders.definition !== 'mayer-ao' || bondOrders.sourceField !== 'wbo' || bondOrders.threshold !== .1 || wbo.text && !wbo.text.endsWith('\n')) fail('GFN2原生键级来源或定义不一致。');
    const entries: { atomIds: [string, string]; value: number }[] = [], seen = new Set<string>();
    for (const line of wbo!.text.trim().split(/\r?\n/).filter(line => line.trim())) {
      const row = line.trim().split(/\s+/), a = Number(row[0]), b = Number(row[1]), value = finite(row[2] ?? '');
      if (row.length !== 3 || !Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || a >= b || b > atoms.length || value === null || value <= .1 || seen.has(`${a}:${b}`)) fail('GFN2原生键级原子或数值无效。');
      seen.add(`${a}:${b}`); entries.push({ atomIds: [atoms[a - 1].id, atoms[b - 1].id], value: value! });
    }
    if (JSON.stringify(entries) !== JSON.stringify(bondOrders!.entries)) fail('GFN2原生键级文本与宿主稳定原子映射不一致。');
  }
  return { molden, stdout, parsed, coordinateTolerance };
}

/** The generated opener accepts only an owned host artifact and a new session ID. */
export async function readGeneratedXtbSource(bundle: XtbElectronicArtifactBundle, expected: GeneratedXtbExpected, nativeSessionId: string,
  open: (artifactId: string, sessionId: string) => Promise<WavefunctionMetadata>): Promise<PostprocessAttachment> {
  const snapshot = structuredClone(bundle), launching = structuredClone(expected);
  const checked = await validateGeneratedXtbBundle(snapshot, launching);
  const { molden, parsed } = checked, bytes = new TextEncoder().encode(molden.text);
  const metadata = await open(snapshot.artifactId, nativeSessionId), sourceId = metadata.sourceId;
  if (sourceId !== `xtb-${snapshot.artifactId}:molden` || metadata.sourceRevision !== molden.sha256 || metadata.format !== 'molden' || metadata.name !== molden.name
    || !Number.isSafeInteger(metadata.basisCount) || metadata.basisCount < 1 || !metadata.orbitals.length || metadata.structure.atoms.length !== snapshot.metadata.orderedAtoms.length) fail('真实波函数后端未返回相符的Molden/基组/MO身份。');
  if(metadata.analysisPolicy!==undefined&&(!isGeneratedXtbAnalysisPolicy(metadata.analysisPolicy,molden.sha256)||metadata.analysisPolicy.requestedUhf!==launching.request.uhf))fail('宿主分析许可与自产波函数身份或请求UHF不一致。');
  let closed = false;
  const input: ResultInputFile = { id: sourceId, name: molden.name, size: bytes.length,
    stream: () => new Blob([bytes]).stream(), async readRange(start, end) { if (closed) fail('自产波函数来源已关闭。'); return bytes.slice(start, end); }, close() { closed = true; } };
  metadata.structure.atoms.forEach((atom, index) => {
    const original = snapshot.metadata.orderedAtoms[index];
    if (atom.element !== original.element || ['x', 'y', 'z'].some(axis => !Number.isFinite(atom[axis as 'x']) || Math.abs(atom[axis as 'x'] - original[axis as 'x']) > checked.coordinateTolerance[index])) fail('波函数后端几何与宿主来源不一致。');
  });
  const source = await readPostprocessWavefunction(input, metadata);
  const structure: Structure = { ...structuredClone(launching.request.structure), format: 'molden', charge: snapshot.metadata.charge, multiplicity: snapshot.metadata.uhf! + 1,
    atoms: snapshot.metadata.orderedAtoms.map(atom => ({ ...atom })), name: 'GFN2-xTB 单点' };
  parsed.data.summary.push({ key: 'method', label: '方法', value: 'GFN2-xTB', sourceLine: 1, frameIndex: 0, sourceId: parsed.data.source!.id, sourceName: 'stdout.log' });
  parsed.data.orbitals = source.result.scientific?.orbitals ?? [];
  parsed.data.orbitals = parsed.data.orbitals.map(channel => ({ ...channel, sourceId, sourceName: molden.name }));
  parsed.data.notices.push(...metadata.messages);
  const originalDispose = source.result.dispose;
  const result = { ...source.result, label: 'GFN2-xTB 单点', source: { ...source.result.source, software: 'xtb' as const }, status: parsed.normalTermination ? 'completed' as const : 'incomplete' as const,
    scientific: parsed.data, initialStructure: structure, frames: [{ index: 0, sourceStep: null, time: null, energy: { value: parsed.energy!.value, unit: 'hartree' }, convergence: [], sourceLine: parsed.energy!.sourceLine }],
    async getFrame(index: number) { if (closed || index !== 0) fail('自产单点来源已关闭或帧序号越界。'); return structuredClone(structure); }, dispose: originalDispose };
  const generatedXtb: GeneratedXtbProvenance = { kind: 'trusted-generated-gfn2-sp', artifactId: snapshot.artifactId, sessionId: snapshot.sessionId, stamp: snapshot.stamp,
    ...(snapshot.runIdentity ? { runIdentity: snapshot.runIdentity } : {}), files: snapshot.files.map(({ role, name, bytes, sha256 }) => ({ role, name, bytes, sha256 })),
    ...(snapshot.metadata.bondOrders ? { nativeBondOrders: snapshot.metadata.bondOrders } : {}), capabilities: ['native-properties', 'orbitals'] };
  if (snapshot.metadata.solvation) generatedXtb.solvation = structuredClone(snapshot.metadata.solvation);
  if(metadata.analysisPolicy)generatedXtb.analysisPolicy=structuredClone(metadata.analysisPolicy);
  const generated: PostprocessSource = { ...source, software: 'xtb', generatedXtb, result, results: [result], tasks: ['sp'] };
  retainGeneratedXtbSourcePackage(generated, async () => ({ schema: 1, bundle: snapshot, expected: launching, ...(metadata.analysisPolicy ? { analysisPolicy: metadata.analysisPolicy } : {}) }));
  return retainPostprocessSourceText({ source: generated, nativeSessionId }, molden.text, input);
}
