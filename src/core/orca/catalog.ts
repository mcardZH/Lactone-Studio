import type { OrcaMethodId, OrcaMethodProfile, OrcaTask, OrcaVersion } from './types';

const ordinary: OrcaTask[] = ['sp', 'opt', 'freq', 'optfreq', 'scan', 'ts', 'irc', 'td', 'tdopt', 'nmr', 'stable', 'bsse', 'neb', 'esd', 'md'];
const geometry: OrcaTask[] = ['sp', 'opt', 'freq', 'optfreq', 'scan', 'ts', 'irc', 'neb', 'md'];
const base = 'https://www.faccts.de/docs/orca/6.1/manual/contents/';
function profile(id: OrcaMethodId, label: string, family: OrcaMethodProfile['family'], keywords: string[], frequency: OrcaMethodProfile['frequency'] = 'analytic'): OrcaMethodProfile {
  return { id, label, family, keywords, frequency, basisPolicy: family === 'composite' ? 'builtin' : family === 'xtb' ? 'none' : 'uniform-def2', tasks: family === 'coupled-cluster' || family === 'double-hybrid' ? ['sp', 'bsse'] : family === 'xtb' || family === 'composite' ? [...geometry] : [...ordinary], soc: family === 'pure' || family === 'hybrid', sources: [base + (family === 'coupled-cluster' ? 'modelchemistries/mdci.html' : family === 'composite' ? 'modelchemistries/3cmethods.html' : 'modelchemistries/DensityFunctionalTheory.html')] };
}
const profiles: OrcaMethodProfile[] = [
  profile('b3lyp', 'B3LYP-D3(BJ)', 'hybrid', ['B3LYP', 'D3BJ']),
  profile('pbe0', 'PBE0-D3(BJ)', 'hybrid', ['PBE0', 'D3BJ']),
  profile('m062x', 'M06-2X', 'hybrid', ['M062X'], 'numeric'),
  profile('wb97x-d3', 'wB97X-D3', 'hybrid', ['wB97X-D3'], 'numeric'),
  profile('cam-b3lyp', 'CAM-B3LYP-D3(BJ)', 'hybrid', ['CAM-B3LYP', 'D3BJ'], 'numeric'),
  profile('wb97m-v', 'wB97M-V', 'hybrid', ['wB97M-V'], 'numeric'),
  profile('wb97x-v', 'wB97X-V', 'hybrid', ['wB97X-V'], 'numeric'),
  profile('tpss', 'TPSS-D3(BJ)', 'pure', ['TPSS', 'D3BJ'], 'numeric'),
  profile('tpssh', 'TPSSh-D3(BJ)', 'hybrid', ['TPSSh', 'D3BJ'], 'numeric'),
  profile('hf-3c', 'HF-3c', 'composite', ['HF-3c'], 'numeric'),
  profile('pbeh-3c', 'PBEh-3c', 'composite', ['PBEh-3c'], 'numeric'),
  profile('b97-3c', 'B97-3c', 'composite', ['B97-3c'], 'numeric'),
  profile('r2scan-3c', 'r2SCAN-3c', 'composite', ['r2SCAN-3c'], 'numeric'),
  profile('wb97x-3c', 'wB97X-3c', 'composite', ['wB97X-3c'], 'numeric'),
  profile('xtb2', 'GFN2-xTB', 'xtb', ['XTB2'], 'numeric'),
  profile('pwpb95-d4', 'PWPB95-D4', 'double-hybrid', ['PWPB95', 'D4'], 'none'),
  profile('revdsd-pbep86-d4-2021', 'revDSD-PBEP86-D4/2021', 'double-hybrid', ['revDSD-PBEP86-D4/2021'], 'none'),
  profile('wb97x-2-d3bj', 'wB97X-2-D3(BJ)', 'double-hybrid', ['wB97X-2', 'D3BJ'], 'none'),
  profile('dlpno-ccsd-t', 'DLPNO-CCSD(T)', 'coupled-cluster', ['DLPNO-CCSD(T)'], 'none'),
  profile('dlpno-ccsd-t1', 'DLPNO-CCSD(T1)', 'coupled-cluster', ['DLPNO-CCSD(T1)'], 'none'),
];
export const ORCA_VERSIONS: OrcaVersion[] = ['5', '6.0', '6.1'];
export const ORCA_BASES = ['def2-SVP', 'def2-SV(P)', 'def2-SVPD', 'def2-TZVP', 'def2-TZVPP', 'def2-TZVPD', 'def2-TZVPPD', 'def2-QZVP', 'def2-QZVPP', 'def2-QZVPD', 'def2-QZVPPD'] as const;
/** Only actual AuxC names listed by both reviewed manuals. */
export const ORCA_CORRELATION_BASES: Readonly<Record<string, string>> = Object.freeze({
  'def2-SVP': 'def2-SVP/C', 'def2-SVPD': 'def2-SVPD/C', 'def2-TZVP': 'def2-TZVP/C', 'def2-TZVPP': 'def2-TZVPP/C',
  'def2-TZVPD': 'def2-TZVPD/C', 'def2-TZVPPD': 'def2-TZVPPD/C', 'def2-QZVPP': 'def2-QZVPP/C', 'def2-QZVPPD': 'def2-QZVPPD/C',
});
export function getOrcaMethodProfile(method: OrcaMethodId, version: OrcaVersion): OrcaMethodProfile | undefined {
  if (!ORCA_VERSIONS.includes(version)) return undefined;
  if (version === '5' && (method === 'wb97x-3c' || method === 'revdsd-pbep86-d4-2021')) return undefined;
  const found = profiles.find(item => item.id === method);
  return found && { ...found, keywords: [...found.keywords], tasks: found.tasks.filter(task => task !== 'stable' || ['b3lyp', 'pbe0'].includes(method)), sources: [...found.sources] };
}
export function getOrcaMethods(version: OrcaVersion, task?: OrcaTask): OrcaMethodProfile[] {
  return profiles.map(item => getOrcaMethodProfile(item.id, version)).filter((item): item is OrcaMethodProfile => !!item && (!task || item.tasks.includes(task)));
}
