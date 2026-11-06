"""Locked xTB RMSD-MTD input and observable history (no Python integration)."""
import copy

BOHR = .529177210903
HARTREE = 27.211386024367243


def settings(request, exact_steps, require):
    if request['operation'] != 'metadynamics':
        return None
    m = request['metadynamics']; atoms = request['structure']['atoms']
    indices = [next(i for i, a in enumerate(atoms) if a['id'] == atom_id) for atom_id in m['atomIds']]
    interval = exact_steps(m['depositEveryFs'], request['dtFs'])
    require(interval >= 2, 'Native MTD deposition interval must contain at least two MD steps')
    count = exact_steps(m['durationFs'], request['dtFs'])
    require(1 + (count-1)//interval <= m['maxHistory'], 'Native MTD complete history exceeds its explicit capacity')
    return dict(atomIds=copy.deepcopy(m['atomIds']), nativeAtomIndices=[i+1 for i in indices],
                heightEV=m['heightEV'], sigmaAngstrom=m['sigmaAngstrom'],
                factorHartree=m['heightEV']/HARTREE, alphaInverseBohr2=BOHR**2/(2*m['sigmaAngstrom']**2),
                depositSteps=interval, depositEveryFs=m['depositEveryFs'], maxHistory=m['maxHistory'],
                scoordFs=(interval-1)*request['dtFs'], rampPerStep=.03,
                definition='V=sum(K_i(t)*exp(-alpha*RMSD_Bohr^2)); deposited K starts at peak; on following steps newest K=peak*tanh(0.03*ageSteps/2)',
                initialReference='explicit-input-geometry', historyPolicy='complete-no-rolling',
                depositTiming='pre-step', instantaneousBiasEnergy='not-reported')


def control(configuration):
    m = configuration.get('metadynamics')
    if m is None:
        return ''
    return ('$metadyn\n save=' + str(m['maxHistory']) + '\n factor=' + format(m['factorHartree'], '.17g')
            + '\n width=' + format(m['alphaInverseBohr2'], '.17g')
            + '\n coord=mtd-reference.xyz\n static=false\n ramp=0.03\n atoms: '
            + ','.join(map(str, m['nativeAtomIndices'])) + '\n$end\n')


def reference_xyz(atoms, offset):
    return str(len(atoms)) + '\nExplicit initial RMSD reference\n' + ''.join(
        a['element'] + ' ' + ' '.join(format(a[k]+offset[i], '.17g') for i, k in enumerate(('x','y','z'))) + '\n'
        for a in atoms)


def entry(configuration, atoms, coordinates, step, index, dt):
    m = configuration['metadynamics']; by_id = {a['id']: i for i, a in enumerate(atoms)}
    return dict(index=index, step=step, timeFs=step*dt, atomIds=copy.deepcopy(m['atomIds']),
                coordinatesAngstrom=[copy.deepcopy(coordinates[by_id[i]]) for i in m['atomIds']],
                heightEV=m['heightEV'], sigmaAngstrom=m['sigmaAngstrom'])
