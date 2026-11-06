"""Isolated GFN-FF energy/gradient adapter with one fixed initial topology.

The host, never the renderer, supplies runtime and workspace paths. No periodic
cell, native MD/optimizer, sampling bias, wall or source translation is written.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import time

import numpy as np
from ase import units
from ase.calculators.calculator import Calculator, all_changes
from gfnff_topology import prepare_topology, accept_topology, runtime_seed_identity
from task_files import clean_evaluation
from orbitals import _windows_owned_job
from xtb_periodic import BOHR_ANGSTROM, ELEMENTS, finite_number, native_timings


class GfnffError(ValueError):
    def __init__(self, message, code='SAMPLING_GFNFF_REJECTED'):
        super().__init__(message); self.code = code


def require(condition, message):
    if not condition: raise GfnffError(message)


def ordinary_directory(directory):
    directory = Path(directory)
    require(directory.is_absolute() and directory.is_dir() and not directory.is_symlink()
            and os.path.normcase(os.path.realpath(directory)) == os.path.normcase(os.path.abspath(directory)),
            'Owned GFN-FF workspace must not traverse links')
    return directory


def ordinary_file(member, limit=None):
    info = member.lstat()
    require(not member.is_symlink() and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and 0 < info.st_size and (limit is None or info.st_size <= limit), 'Native GFN-FF member is not an owned bounded regular file')
    return member


def isolated_coordinate_input(atoms, positions_bohr):
    return '\n'.join(['$coord'] + [' '.join(format(float(v), '.17g') for v in row)+' '+atom['element'].lower()
                                  for atom, row in zip(atoms, positions_bohr)] + ['$end', ''])


def parse_isolated_engrad(text, atoms, positions_bohr):
    require('The current total energy in Eh' in text and 'The current gradient in Eh/bohr' in text
            and 'current coordinates in Bohr' in text, 'Native isolated gradient units missing')
    rows = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith('#')]
    n = len(atoms)
    require(len(rows) == 2+4*n and re.fullmatch(r'\d+', rows[0]) is not None and int(rows[0]) == n,
            'Incomplete native isolated gradient inventory')
    energy = finite_number(rows[1]); gradient = np.array([finite_number(v) for v in rows[2:2+3*n]]).reshape(n, 3)
    native_coordinates = []
    for atom, expected, row in zip(atoms, positions_bohr, rows[2+3*n:]):
        fields = row.split()
        require(len(fields) == 4 and fields[0].isdigit() and int(fields[0]) == ELEMENTS.index(atom['element'])+1,
                'Native isolated gradient atom order/element changed')
        point = np.array([finite_number(v) for v in fields[1:]])
        # The native ORCA-format writer prints f12.7 Bohr. No lattice lift,
        # recentering, fitted rotation, reorder or gradient modification is allowed.
        require(np.max(np.abs(point-expected)) <= 5.1e-8, 'Native isolated gradient belongs to another geometry')
        native_coordinates.append(point.tolist())
    return energy, gradient, native_coordinates


def isolated_native_status(output, errors, runtime_version):
    combined = output+'\n'+errors
    require('normal termination of xtb' in errors.lower(), 'Native isolated GFN-FF did not terminate normally')
    version = re.search(r'\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)', output, re.I)
    require(version is not None and version.group(1) == runtime_version, 'Native GFN-FF version differs from host runtime')
    require('GFN-FF' in output and not re.search(r'Periodic properties|GEOMETRY OPTIMIZATION|Fast Inertial Relaxation Engine|RF solver', output, re.I),
            'Expected an isolated GFN-FF gradient, never periodic physics or a native optimizer')
    require(not re.search(r'ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR|Single point calculation terminated|FAILED TO CONVERGE', combined, re.I),
            'Native isolated GFN-FF calculation failed')
    energies = re.findall(r'\|\s*TOTAL ENERGY\s+([-+\d.eEdD]+)\s+Eh\s*\|', output)
    require(len(energies) == 1, 'Native isolated total energy is absent or ambiguous')
    return finite_number(energies[0])


class IsolatedGfnffCalculator(Calculator):
    implemented_properties = ['energy', 'forces']
    method = 'gfnff'
    def __init__(self, request, context):
        super().__init__(); self.request = request
        require(isinstance(context, dict) and all(k in context for k in ('runtime', 'workspacePath', 'emit', 'check', 'cancelled')),
                'Host-owned GFN-FF runtime/workspace context is required')
        self.runtime = context['runtime']; self.workspace = ordinary_directory(Path(context['workspacePath']))
        for key in ('executable', 'directory', 'dataDirectory'):
            require(isinstance(self.runtime.get(key), str) and Path(self.runtime[key]).is_absolute(), 'Native runtime must be host-resolved')
        require(Path(self.runtime['executable']).name.lower() in ('xtb', 'xtb.exe') and isinstance(self.runtime.get('version'), str),
                'Only the locked xTB runtime is accepted')
        require(request['method'] == self.method and type(request['threads']) is int and 1 <= request['threads'] <= 2**53-1
                and (self.method != 'gfnff' or request['uhf'] == 0),
                'Invalid native sampling method/spin/thread range')
        require(not request.get('solvation'), 'Native sampling solvation is not enabled for this method')
        self.emit, self.check, self.cancelled = context['emit'], context['check'], context['cancelled']
        self.seed = self.seed_sha256 = self.seed_identity = None; self.evaluations = 0; self.current = None; self.last_evidence = None

    def evidence(self):
        return dict(engine='native-xtb', method='gfnff', version=self.runtime['version'],
                    forceFieldTopologySha256=self.seed_sha256, evaluations=self.evaluations,
                    spinTreatment='not-supported', coordinateTransform=dict(kind='identity', offsetAngstrom=[0, 0, 0]),
                    lastEvaluation=self.last_evidence)

    def prepare_seed(self, directory):
        current = runtime_seed_identity(self.runtime, self.request, require)
        if self.seed is not None: require(self.seed_identity == current, 'Owned GFN-FF seed belongs to another engine/build/parameter set')
        return prepare_topology(directory, self.seed, self.seed_sha256, require)

    def accept_seed(self, directory, output, seeded):
        current = runtime_seed_identity(self.runtime, self.request, require)
        if seeded: require(self.seed_identity == current, 'Owned GFN-FF seed belongs to another engine/build/parameter set')
        self.seed, self.seed_sha256 = accept_topology(directory, output, seeded, self.seed, self.seed_sha256, require)
        self.seed_identity = current

    def method_arguments(self):
        return ['--gfnff']

    def native_status(self, output, errors):
        return isolated_native_status(output, errors, self.runtime['version'])

    def topology_evidence(self, seeded):
        return dict(forceFieldTopologySha256=self.seed_sha256, topologyReadFromOwnedSeed=seeded)

    def calculate(self, atoms=None, properties=None, system_changes=all_changes):
        self.evaluation_directory = None
        try:
            return self._calculate_owned(atoms, properties, system_changes)
        finally:
            if self.evaluation_directory is not None and self.current is None:
                clean_evaluation(self.evaluation_directory)

    def _calculate_owned(self, atoms=None, properties=None, system_changes=all_changes):
        self.check(); super().calculate(atoms, properties, system_changes)
        positions = np.asarray(atoms.positions, dtype=float)
        require(positions.shape == (len(self.request['structure']['atoms']), 3) and np.isfinite(positions).all(), 'Invalid isolated GFN-FF coordinates')
        require(self.evaluations < self.request['maxEvaluations'], 'GFN-FF energy/gradient evaluation budget exhausted')
        directory = self.workspace / f'eval-{self.evaluations:06d}'; directory.mkdir(); ordinary_directory(directory)
        self.evaluation_directory = directory
        self.evaluations += 1
        seeded = self.prepare_seed(directory)
        xyz_bohr = positions/BOHR_ANGSTROM; text = isolated_coordinate_input(self.request['structure']['atoms'], xyz_bohr)
        source = directory/'input.coord'
        with source.open('x', encoding='ascii', newline='\n') as stream: stream.write(text)
        argv = [self.runtime['executable'], 'input.coord', *self.method_arguments(), '--grad', '--chrg', str(self.request['charge'])]
        if not seeded: argv.append('--norestart')
        argv += ['--parallel', str(self.request['threads'])]
        env = {k: v for k, v in os.environ.items() if k.upper() in ('SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE')}
        env.update(PATH=self.runtime['directory'], XTBPATH=self.runtime['dataDirectory'], HOME=str(directory), USERPROFILE=str(directory),
                   TEMP=str(directory), TMP=str(directory), LANG='C', LC_ALL='C', OMP_NUM_THREADS=str(self.request['threads']),
                   OMP_MAX_ACTIVE_LEVELS='1', OMP_DYNAMIC='FALSE', MKL_NUM_THREADS=str(self.request['threads']), OPENBLAS_NUM_THREADS=str(self.request['threads']))
        process = job = None; stdout = stderr = b''; started = time.monotonic()
        record = dict(evaluation=self.evaluations, argv=argv, inputSha256=hashlib.sha256(text.encode('ascii')).hexdigest(),
                      topologyReadFromOwnedSeed=seeded, pid=None, closed=False)
        try:
            process = self.current = subprocess.Popen(argv, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                                       creationflags=0x08000000 if os.name == 'nt' else 0)
            record['pid'] = process.pid; self.emit(dict(kind='native-started', pid=process.pid))
            job = _windows_owned_job(process)
            while True:
                self.check()
                try: stdout, stderr = process.communicate(timeout=.1); break
                except subprocess.TimeoutExpired:
                    # Polling is for owned cancellation, not a calculation
                    # deadline. self.check applies only an explicit old limit.
                    continue
            require(process.returncode == 0, 'Native isolated GFN-FF process failed')
        finally:
            if process is not None:
                if process.poll() is None: process.kill(); stdout, stderr = process.communicate(timeout=5)
                record.update(code=process.returncode, closed=process.poll() is not None)
                if process.stdout: process.stdout.close()
                if process.stderr: process.stderr.close()
            if job: job[0].CloseHandle(job[1])
            self.current = None if process is None or record['closed'] else process
            record['processSeconds'] = time.monotonic()-started
            if process is not None and record['closed']:
                self.emit(dict(kind='native-closed', pid=process.pid, code=process.returncode))
            for name, content in [('stdout.txt', stdout), ('stderr.txt', stderr)]:
                with (directory/name).open('xb') as stream: stream.write(content)
            with (directory/'process.json').open('x', encoding='utf-8') as stream: json.dump(record, stream, allow_nan=False)
        self.check()
        output = stdout.decode('utf-8', errors='replace'); errors = stderr.decode('utf-8', errors='replace')
        summary = self.native_status(output, errors)
        require(ordinary_file(source).read_text(encoding='ascii') == text, 'Native isolated coordinates changed')
        artifacts = [p for p in directory.iterdir() if p.suffix == '.engrad']
        require(len(artifacts) == 1, 'Exactly one native isolated engrad is required')
        engrad = ordinary_file(artifacts[0])
        energy, gradient, coordinates = parse_isolated_engrad(engrad.read_text(encoding='ascii'), self.request['structure']['atoms'], xyz_bohr)
        require(abs(energy-summary) <= 1e-9, 'Native isolated engrad and stdout total energies differ')
        self.accept_seed(directory, output, seeded)
        self.results = dict(energy=energy*units.Hartree, forces=-gradient*units.Hartree/BOHR_ANGSTROM)
        self.last_evidence = dict(evaluation=self.evaluations, inputSha256=record['inputSha256'], engradSha256=hashlib.sha256(engrad.read_bytes()).hexdigest(),
                                  energyHartree=energy, gradientHartreePerBohr=gradient.tolist(), coordinatesBohr=coordinates,
                                  returnedEnergyEV=self.results['energy'], returnedForcesEVPerAngstrom=self.results['forces'].tolist(),
                                  returnedUnits=dict(energy='eV', forces='eV/angstrom'),
                                  **self.topology_evidence(seeded), nativeClosed=True,
                                  nativeReportedTimings=native_timings(output))
        with (directory/'gradient-evidence.json').open('x', encoding='utf-8') as stream: json.dump(self.last_evidence, stream, allow_nan=False)
