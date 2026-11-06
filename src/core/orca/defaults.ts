import type { Structure } from '../types';
import type { OrcaSettings, OrcaTask } from './types';
import { recommendedExcitedStates } from '../input-recommendations';

export function createOrcaSettings(task: OrcaTask = 'opt', structure?: Structure | null): OrcaSettings {
  const quick = task === 'neb' || task === 'md';
  const energy = task === 'sp' || task === 'bsse';
  return {
    version: '6.1', task, method: quick ? 'xtb2' : energy ? 'wb97m-v' : 'b3lyp', basis: quick ? '' : energy ? 'def2-TZVP' : 'def2-SVP',
    solventModel: energy ? 'smd' : 'cpcm', solvent: '', unrestricted: (structure?.multiplicity ?? 1) > 1, pno: 'normal', constraints: [], frozenAtomIds: [],
    excited: { approximation: 'td', roots: recommendedExcitedStates(structure?.atoms.length ?? 0, task === 'tdopt' ? 'tdopt' : 'td'), rootsMode: 'auto', root: 1, targetSpin: 'singlet', useUks: false, soc: false, triplets: false, printCoefficients: false },
    neb: { variant: 'ci-neb', product: null, mapping: [], mappingConfirmed: false, images: 32, freeEnds: true, preOptimize: false, interpolation: 'sidpp', customConvergenceEnabled: false },
    esd: { channel: 'abs', temperatureK: null, initialState: '', finalState: '', useDuschinsky: true, herzbergTeller: true, coupling: 'inline', externalCouplingConfirmed: false },
    md: { timestepFs: null, steps: null, initialTemperatureK: null, targetTemperatureK: null, thermostat: 'none', couplingTimeFs: null, trajectoryStride: 1, activeAtomIds: [], constraints: [], taskIdentity: '', restartConfirmed: false },
    multiscale: { mode: 'none', qmAtomIds: [], freezeLowLayer: false, qmCharge: structure?.charge ?? 0, qmMultiplicity: structure?.multiplicity ?? 1, lowMethod: '', embedding: 'mechanical', boundaries: [], configurationConfirmed: false },
    nmr: 'shielding', stableOptimize: false, fragments: [], fragmentStatesConfirmed: false, ircMaxIterations: 100,
  };
}
