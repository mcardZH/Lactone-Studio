"""Live modeling xTB MD using the conformer native driver and real restart state.

Checkpoints are finite native invocations, not new thermal initializations.
Only the newest complete snapshot and one parser block are retained in memory.
"""
from __future__ import annotations
import copy
import hashlib
import json
import math
import os
import re
import subprocess
import time

import engine
import numpy as np
from ase import units
from conformer_sampling import validate_request
from conformer_gfnff import ordinary_directory, isolated_coordinate_input
from conformer_native_md import (admitted_md_engine_identity, settings, control_input,
    native_arguments, TrajectoryReader, restart_frame, bounded_file, validate_header,
    validate_completion_output, validate_seed, native_constraint_residuals, number,
    apply_posix_library_env, BOHR_ANGSTROM, SHAKE_BOND_TOLERANCE_ANGSTROM)
from conformer_solvation import native_solvation
from xtb_periodic import coordinate_input
from orbitals import _windows_owned_job
from dynamics_checkpoint_files import CheckpointFiles

CHECKPOINT_STEPS = 220  # 11-step SCC-accuracy cycle; never a session duration.
CORE_K = 500000 / 9648.533212331


def sampling_request(request, threads, steps=CHECKPOINT_STEPS):
    selected = request.get('protectedAtomIds', [])
    if len(selected) == 1:
        engine.reject('md-single-protected-atom', 'GFN相对距离保护至少需要2个冻结原子；请增加冻结原子，或改用MMFF/UFF。')
    structure = copy.deepcopy(request['structure'])
    periodic = 'cell' in structure
    # The conformer validator has a deliberately fixed stamp schema. Keep the
    # modeling permission in this session's original request/returned stamp;
    # sampling's private numerical adapter receives only its supported fields.
    numerical_stamp = {k:v for k,v in request['stamp'].items() if k != 'nativeMDPolicy'}
    raw = dict(schema=1, stamp=numerical_stamp, runIdentity=dict(taskId='modeling-md', runId='modeling-md-run'),
        operation='md', method=request['method'], structure=structure,
        charge=structure.get('charge') if structure.get('charge') is not None else 0,
        uhf=0 if request['method']=='gfnff' else (structure.get('multiplicity') or 1)-1,
        threads=threads, maxSteps=steps, maxEvaluations=steps+2, maxFrames=steps+1,
        dtFs=2, reportEvery=10,
        shakeHydrogenBonds=request['method'] != 'gfnff',
        molecularMD=dict(temperatureK=request['temperatureK'], durationFs=steps*2, sampleEveryFs=20))
    if request['method'] == 'gfnff':
        raw['hydrogenMassAmu'] = 4
        structure.pop('multiplicity', None)
    if structure.get('charge') is None:
        structure.pop('charge', None)
    if structure.get('multiplicity') is None:
        structure.pop('multiplicity', None)
    if request['method'] != 'gxtb' and 'seed' in request:
        raw.update(seedMode='specified', seed=request['seed'])
    if request.get('solvation'):
        raw['solvation'] = copy.deepcopy(request['solvation'])
    if request.get('constraints'):
        raw['constraints'] = [{k:row[k] for k in ('id','objectId','type','atomIds','value') if k in row} for row in request['constraints']]
    if selected:
        raw['nativeProtection'] = dict(core=dict(kind='pairwise-distance', atomIds=selected,
                                               forceConstantEVPerAngstrom2=CORE_K))
    if periodic:
        if selected or raw.get('constraints') or raw.get('solvation') or request['method']=='gxtb':
            engine.reject('md-periodic-settings', '周期原生MD只使用固定晶胞，不应用用户保护、约束或隐式溶剂。')
        # The desktop validates the full periodic structure and owns its input.
        # Do not run it through the molecule-only conformer graph contract.
        raw.update(periodic=True, calculator=dict(accuracy=1, maxIterations=250, electronicTemperatureK=300))
        return raw
    return validate_request(raw)


def positions(atoms):
    return [[a[k] for k in ('x','y','z')] for a in atoms]


def md_coordinate_input(request):
    atoms = request['structure']['atoms']
    coordinates = [[v / BOHR_ANGSTROM for v in point] for point in positions(atoms)]
    if not request.get('periodic'):
        return isolated_coordinate_input(atoms, coordinates)
    return coordinate_input(atoms, coordinates,
        [[v / BOHR_ANGSTROM for v in row] for row in request['structure']['cell']['vectors']])


class PeriodicMDChart:
    """Map fixed-cell native coordinates to the original atom-image chart."""

    def __init__(self, structure):
        self.vectors = np.asarray(structure['cell']['vectors'], dtype=float)
        self.inverse = np.linalg.inv(self.vectors)
        self.wrapped_source, self.source_images = self.wrap(positions(structure['atoms']))
        self.source_offsets = self.source_images @ self.vectors

    def wrap(self, coordinates):
        points = np.asarray(coordinates, dtype=float)
        fractional = points @ self.inverse
        if not np.isfinite(fractional).all() or np.any(np.abs(fractional) >= 2**52):
            engine.reject('md-periodic-chart', '当前周期坐标无法可靠确定整数晶胞镜像。')
        # Match xTB pbc_tools.f90:shift_back_abc, including the cell-edge rule.
        epsilon = 1e-14
        images = np.where((fractional < -epsilon) | (fractional > 1 + epsilon), np.floor(fractional), 0)
        images = np.where(np.abs(fractional - 1) < epsilon, 1, images).astype(np.int64)
        return points - images @ self.vectors, images

    def model_positions(self, coordinates):
        wrapped, _ = self.wrap(coordinates)
        return (wrapped + self.source_offsets).tolist()

    def first_frame_error(self, actual, expected):
        difference = np.asarray(actual, dtype=float) - np.asarray(expected, dtype=float)
        # Restart bytes may use another equivalent cell copy. Only remove an
        # integer lattice translation before checking the Cartesian residual.
        images = np.rint(difference @ self.inverse)
        return float(np.max(np.abs(difference - images @ self.vectors)))

    def evidence(self):
        return dict(schema='ester-md-periodic-coordinate-chart/v1',
                    origin='native-lattice-origin', effectivePbc=[True,True,True],
                    outputRepresentation='source-anchored-cell-images',
                    sourceImages=self.source_images.tolist())


def periodic_hydrogen_references(request, chart=None):
    if not request['shakeHydrogenBonds']:
        return []
    chart = chart if chart is not None else PeriodicMDChart(request['structure'])
    atoms = request['structure']['atoms']; xyz = chart.wrapped_source.tolist(); pairs = {}
    # xTB's generic SHAKE mode 1 selects the closest atom in the supplied
    # Cartesian chart; it does not resolve periodic images for these pairs.
    for i, atom in enumerate(atoms):
        if atom['element']!='H':
            continue
        j = min((j for j in range(len(atoms)) if j!=i), key=lambda j:math.dist(xyz[i],xyz[j]), default=None)
        if j is None or not 1e-8 < math.dist(xyz[i],xyz[j]) < math.sqrt(1000)*BOHR_ANGSTROM:
            engine.reject('md-shake-periodic-identity', '周期X–H约束在原生SHAKE的当前坐标中缺少有效配对。')
        if atoms[j]['element']=='H' and j<i:
            continue
        key = tuple(sorted((i,j)))
        pairs[key] = dict(a=key[0], b=key[1], atomIds=[atoms[k]['id'] for k in key], lengthAngstrom=math.dist(xyz[i],xyz[j]))
    declared = set()
    for bond in request['structure'].get('bonds', []):
        a,b = bond['a'],bond['b']
        if all(atoms[i]['element']!='H' for i in (a,b)):
            continue
        key = tuple(sorted((a,b)))
        native_image = (chart.source_images[a] - chart.source_images[b]).tolist()
        if key not in pairs or key in declared or list(bond.get('image',[0,0,0])) != native_image:
            engine.reject('md-shake-periodic-identity', '周期X–H连接的源镜像与实际SHAKE参考无法对应。')
        declared.add(key)
    return list(pairs.values())


class Session:
    def __init__(self, request, context, *, checkpoint_steps=CHECKPOINT_STEPS):
        self.request = copy.deepcopy(request)
        self.operation = 'md'; self.paused = False; self.stopped = False
        self.max_wall_seconds = request.get('maxWallTimeSeconds')
        self.target_temperature = request['temperatureK']; self.started = time.monotonic()
        self.runtime = context['runtime']; self.engine_identity = admitted_md_engine_identity(self.runtime, request['method'])
        self.workspace = ordinary_directory(context['workspacePath'])
        self.sampling = sampling_request(request, context['threads'], checkpoint_steps)
        self.periodic = self.sampling.get('periodic', False)
        self.periodic_chart = PeriodicMDChart(self.sampling['structure']) if self.periodic else None
        self.seed_verifiable = self.request['method'] != 'gxtb' and self.runtime.get('version') == '6.8.0'
        self.configuration = settings(self.sampling, periodic_hydrogen_bond_references=periodic_hydrogen_references(self.sampling,self.periodic_chart) if self.periodic else None)
        self.control_configuration = self.configuration if self.seed_verifiable else dict(self.configuration, nativeSeed=None)
        self.initial_input = md_coordinate_input(self.sampling)
        self.verified_header = None
        self.seed = None; self.solvation = None; self.restart_sha = None
        self.checkpoint_files = CheckpointFiles(self.workspace, dict(schema='ester-modeling-md-source/v1',
            originalRequest=self.request, numericalRequest=self.sampling, configuration=self.configuration,
            resourceGrant=dict(threads=context['threads'],softMemoryBudgetBytes=context.get('memoryBudgetBytes'),nativeMemoryHardLimitApplied=False),
            engineIdentity=self.engine_identity, initialInput=self.initial_input, initialControl=control_input(self.sampling,self.control_configuration),
            **({'periodicCoordinateChart':self.periodic_chart.evidence()} if self.periodic_chart else {})))
        self.step = 0; self.segment = 0; self.current = None; self.restart_bytes = None; self.last_potential = None
        self.last_validated = self.snapshot(None, final=True)

    def running_seconds(self):
        return time.monotonic() - self.started

    def snapshot(self, raw, final=False):
        output = copy.deepcopy(self.request['structure'])
        if raw:
            coordinates = self.periodic_chart.model_positions(raw['coordinates']) if self.periodic_chart else raw['coordinates']
            for atom, point in zip(output['atoms'], coordinates):
                if not all(math.isfinite(v) and abs(v) <= 1e6 for v in point):
                    engine.reject('md-invalid-frame', '原生MD帧包含无效坐标，保留上一有效帧。')
                atom.update(zip(('x', 'y', 'z'), point))
            if self.configuration['shakeHydrogenBonds']:
                for pair in self.configuration['hydrogenBondReferences']:
                    pa,pb = [raw['coordinates'][pair[key]] for key in ('a','b')]
                    residual = abs(math.dist(pa,pb)-pair['lengthAngstrom'])
                    if residual > SHAKE_BOND_TOLERANCE_ANGSTROM:
                        engine.reject('md-shake-residual', '原生MD含氢键长约束未通过实际残差检查。')
            output.pop('molfile', None)
        result = dict(stamp=self.request['stamp'], operation='md', step=self.step, timeFs=self.step*2,
            structure=output, movableAtomIds=self.request['movableAtomIds'],
            engine='xTB native MD', engineVersion=self.runtime['version'],
            targetTemperatureK=self.target_temperature, timestepFs=2,
            nativeMD=dict(method=self.request['method'], dtFs=2, thermostat='Berendsen',
                hydrogenMassAmu=self.configuration['hydrogenMassAmu'], shakeHydrogenBonds=self.configuration['shakeHydrogenBonds'],
                protection='pairwise-distance' if self.request.get('protectedAtomIds') else 'none',
                protectedAtomIds=self.request.get('protectedAtomIds', []), forceConstantKJMolNm2=500000,
                segment=self.segment, velocityInitialization='fresh' if self.segment == 0 else 'restart', nativeClosed=self.current is None,
                engineIdentity=self.engine_identity),
            units=dict(positions='angstrom', energy='eV', time='fs', temperature='K'))
        receipt = result['nativeMD']
        if self.periodic:
            receipt['periodic'] = True
        if self.verified_header is not None:
            if self.seed is not None:
                receipt.update(seedTreatment='verified', effectiveSeed=self.seed)
            elif self.request['method'] == 'gxtb':
                receipt['seedTreatment'] = 'program-random'
            else:
                receipt['seedTreatment'] = 'native-internal-initialization'
            if self.solvation is not None:
                receipt['solvation'] = self.solvation
            if 'degreesOfFreedom' in self.verified_header:
                receipt['degreesOfFreedom'] = self.verified_header['degreesOfFreedom']
            if self.restart_sha is not None:
                receipt['restartInputSha256'] = self.restart_sha
        if raw and self.sampling.get('constraints'):
            residuals = native_constraint_residuals(self.configuration['nativeProtection'], raw['coordinates'])
            rows = []
            for request_row, measured in zip(self.sampling['constraints'], residuals, strict=True):
                actual=measured['actual']; target=request_row['value']; delta=actual-target
                if request_row['type']=='D':
                    delta=(delta+180)%360-180
                rows.append(dict(request_row, action='freeze', target=target, actual=actual, residual=delta,
                    unit='angstrom' if request_row['type']=='B' else 'degree', mode='native-harmonic'))
            receipt['internalConstraints'] = rows
        if raw and 'energyHartree' in raw:
            protected = bool(self.request.get('protectedAtomIds') or self.sampling.get('constraints'))
            self.last_potential = dict(value=raw['energyHartree'], unit='hartree',
                definition='native-total-including-protection' if protected else 'native-physical-potential',
                includesProtection=protected, sourceArtifact='xtb.trj',
                sourceStep=self.step, sourceTimeFs=self.step*2, segment=self.segment)
            # With protection the native potential includes the added restraint.
            if not protected:
                result['energyEV'] = raw['energyHartree']*units.Hartree
        if self.last_potential is not None:
            result['nativeMD']['rawPotential'] = copy.deepcopy(self.last_potential)
        return result

    def run(self, emit, controls):
        base_step = 0
        while True:
            controls()
            try:
                self._segment(base_step, emit, controls)
            except Exception as exc:
                if self.stopped:
                    raise
                # One failure receipt, no unbounded per-frame/history metadata.
                with (self.workspace/'failure.json').open('x', encoding='utf-8') as handle:
                    json.dump(dict(segment=self.segment, step=self.step, timeFs=self.step*2,
                        nativeClosed=self.current is None, exceptionType=type(exc).__name__,
                        code=getattr(exc,'code',None), message=str(exc)),handle,allow_nan=False)
                engine.reject(getattr(exc,'code',None) or 'md-native-failure', '原生MD未能继续；已保留末有效帧、当前段和前检查点。')
            base_step += self.configuration['steps']; self.segment += 1

    def _segment(self, base_step, emit, controls):
        directory = self.workspace / ('segment-%08d' % self.segment); directory.mkdir()
        text = self.initial_input
        control = control_input(self.sampling, self.control_configuration)
        if self.restart_bytes is not None:
            control = control.replace('restart=false', 'restart=true')
            (directory/'mdrestart').write_bytes(self.restart_bytes)
        for name, content in [('input.coord', text), ('md.inp', control)]:
            (directory/name).write_text(content, encoding='ascii', newline='\n')
        argv = native_arguments(self.sampling, self.runtime)
        env = {k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','SYSTEMDRIVE')}
        env.update(PATH=self.runtime['directory'], XTBPATH=self.runtime['dataDirectory'], HOME=str(directory), USERPROFILE=str(directory),
            TEMP=str(directory), TMP=str(directory), LANG='C', LC_ALL='C', OMP_NUM_THREADS=str(self.sampling['threads']),
            OMP_MAX_ACTIVE_LEVELS='1', OMP_DYNAMIC='FALSE', MKL_NUM_THREADS=str(self.sampling['threads']), OPENBLAS_NUM_THREADS=str(self.sampling['threads']))
        apply_posix_library_env(env, self.runtime)
        reader = TrajectoryReader(self.sampling['structure']['atoms'], self.configuration['dumpSteps'], self.configuration['steps'],
            positions_only=self.configuration.get('positionsOnly',False), frame_header=self._periodic_frame_header if self.periodic else None)
        header = False; process = job = None
        initial = restart_frame(directory/'mdrestart', len(self.sampling['structure']['atoms'])) if self.restart_bytes else None

        def drain(final=False):
            nonlocal header
            output = (directory/'stdout.txt').read_text(encoding='utf-8', errors='replace')
            if not header:
                if 'Berendsen THERMOSTAT on' not in output:
                    return
                if self.restart_bytes and not re.search(r'^[ \t]*RESTART[ \t]*$', output, re.M):
                    if final:
                        engine.reject('md-restart-not-confirmed', '原生MD未确认读取连续状态。')
                    return
                effective = validate_header(output, self.sampling, self.configuration, self.runtime['version'])
                self.seed = validate_seed(output, dict(self.sampling, seed=self.configuration['nativeSeed'])) if self.seed_verifiable else None
                self.solvation = native_solvation(output, self.sampling)
                self.restart_sha = hashlib.sha256(self.restart_bytes).hexdigest() if self.restart_bytes else None
                self.verified_header = effective
                header = True
            for raw in reader.iter_drain(directory/'xtb.trj', final=final):
                if raw['rawIndex'] == 0:
                    expected = initial['coordinates'] if initial else source_positions
                    if self.periodic_chart:
                        error = self.periodic_chart.first_frame_error(raw['coordinates'],expected)
                        record['initialPositionComparison'] = dict(representation='same-fixed-cell-lattice', maxCartesianErrorAngstrom=error)
                    else:
                        error = max(abs(v-w) for p,q in zip(raw['coordinates'], expected) for v,w in zip(p,q))
                    if not math.isfinite(error) or error > 5e-6:
                        engine.reject('md-restart-position-mismatch', 'MD检查点坐标未按原生状态连续恢复。')
                    if initial and raw.get('velocities') and max(abs(v-w) for p,q in zip(raw['velocities'], initial['velocities']) for v,w in zip(p,q)) > 1e-8:
                        engine.reject('md-restart-velocity-mismatch', 'MD检查点速度未按原生状态连续恢复。')
                self.step = base_step + raw['step']
                self.last_validated = self.snapshot(raw)
                if raw['step'] % self.sampling['reportEvery'] == 0:
                    emit('frame')

        source_positions = self.periodic_chart.wrapped_source if self.periodic_chart else positions(self.sampling['structure']['atoms'])
        record = dict(argv=argv, engineIdentity=self.engine_identity, segment=self.segment, startStep=base_step,
            restartInputSha256=hashlib.sha256(self.restart_bytes).hexdigest() if self.restart_bytes else None,
            inputSha256=hashlib.sha256(text.encode('ascii')).hexdigest(), control=control,
            velocityInitialization='restart' if self.restart_bytes else 'fresh', threads=self.sampling['threads'])
        try:
            with (directory/'stdout.txt').open('xb') as stdout, (directory/'stderr.txt').open('xb') as stderr:
                process = self.current = subprocess.Popen(argv, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                    stdout=stdout, stderr=stderr, shell=False, creationflags=0x08000000 if os.name == 'nt' else 0)
                job = _windows_owned_job(process)
                record['pid'] = process.pid
                while process.poll() is None:
                    controls(); drain(); time.sleep(.025)
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    if job:
                        job[0].CloseHandle(job[1]); job = None
                    process.wait(timeout=1)
                self.current = None
                self.last_validated['nativeMD']['nativeClosed'] = True
                record.update(exitCode=process.returncode, nativeClosed=process.poll() is not None)
                # Publish only complete valid records after actual writer close.
                try:
                    drain()
                finally:
                    if job:
                        job[0].CloseHandle(job[1])
                    (directory/'process.json').write_text(json.dumps(record, allow_nan=False), encoding='utf-8')
        output = (directory/'stdout.txt').read_text(encoding='utf-8', errors='replace')
        errors = (directory/'stderr.txt').read_text(encoding='utf-8', errors='replace')
        if process.returncode != 0:
            engine.reject('md-native-exit', '原生MD异常退出；保留最后有效帧及原始证据。')
        validate_completion_output(output, errors, self.sampling, self.configuration, self.runtime['version'])
        drain(final=True)
        if reader.raw_index != self.configuration['rawFrames']:
            engine.reject('md-incomplete-checkpoint', '原生MD检查点轨迹不完整。')
        bounded_file(directory/'xtbmdok', 1024, allow_empty=True)
        final = restart_frame(directory/'mdrestart', len(self.sampling['structure']['atoms']))
        self.step = base_step + self.configuration['steps']
        self.last_validated = self.snapshot(final, final=True)
        self.restart_bytes = (directory/'mdrestart').read_bytes()
        emit('frame')
        self.checkpoint_files.accept(directory, dict(segment=self.segment, step=self.step, timeFs=self.step*2,
            restartSha256=hashlib.sha256(self.restart_bytes).hexdigest(), inputSha256=record['inputSha256'],
            rawPotential=self.last_potential), native_closed=self.current is None, restart_accepted=True, readers_closed=True)

    def _periodic_frame_header(self, comment):
        lattice = re.search(r'\bLattice="([^"]+)"', comment)
        if not lattice or not re.search(r'\bpbc="T T T"', comment) or not re.search(r'\bProperties=species:S:1:pos:R:3\b', comment):
            engine.reject('md-periodic-trajectory-format', '周期MD轨迹缺少有效的晶胞和坐标元数据。')
        cell = [number(value) for value in lattice[1].split()]
        source = [value for row in self.request['structure']['cell']['vectors'] for value in row]
        if len(cell)!=9 or any(abs(a-b)>1e-8 for a,b in zip(cell,source)):
            engine.reject('md-periodic-cell-changed', '周期MD轨迹晶胞与本次固定晶胞不符。')
