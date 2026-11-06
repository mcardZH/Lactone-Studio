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
from pathlib import Path
import subprocess
import time

import engine
from ase import units
from conformer_sampling import validate_request
from conformer_gfnff import ordinary_directory, isolated_coordinate_input
from conformer_native_md import (admitted_md_engine_identity, settings, control_input,
    native_arguments, TrajectoryReader, restart_frame, bounded_file, validate_header,
    validate_completion_output, BOHR_ANGSTROM, SHAKE_BOND_TOLERANCE_ANGSTROM)
from orbitals import _windows_owned_job
from dynamics_checkpoint_files import CheckpointFiles

CHECKPOINT_STEPS = 220  # 11-step SCC-accuracy cycle; never a session duration.
CORE_K = 500000 / 9648.533212331


def sampling_request(request, threads, steps=CHECKPOINT_STEPS):
    selected = request.get('protectedAtomIds', [])
    if len(selected) == 1:
        engine.reject('md-single-protected-atom', 'GFN相对距离保护至少需要2个冻结原子；请增加冻结原子，或改用MMFF/UFF。')
    structure = copy.deepcopy(request['structure'])
    if structure.get('cell', {}).get('pbc') == [False, False, False]:
        structure.pop('cell')
    # The conformer validator has a deliberately fixed stamp schema. Keep the
    # modeling permission in this session's original request/returned stamp;
    # sampling's private numerical adapter receives only its supported fields.
    numerical_stamp = {k:v for k,v in request['stamp'].items() if k != 'nativeMDPolicy'}
    raw = dict(schema=1, stamp=numerical_stamp, runIdentity=dict(taskId='modeling-md', runId='modeling-md-run'),
        operation='md', method=request['method'], structure=structure,
        charge=structure.get('charge', 0), uhf=structure.get('multiplicity', 1)-1,
        threads=threads, maxSteps=steps, maxEvaluations=steps+2, maxFrames=steps+1,
        seed=request.get('seed', 731), dtFs=2, reportEvery=10,
        shakeHydrogenBonds=request['method'] != 'gfnff',
        molecularMD=dict(temperatureK=request['temperatureK'], durationFs=steps*2, sampleEveryFs=20))
    if request['method'] == 'gfnff':
        raw['hydrogenMassAmu'] = 4
    if selected:
        raw['nativeProtection'] = dict(core=dict(kind='pairwise-distance', atomIds=selected,
                                               forceConstantEVPerAngstrom2=CORE_K))
    return validate_request(raw)


class Session:
    def __init__(self, request, context, *, checkpoint_steps=CHECKPOINT_STEPS):
        self.request = copy.deepcopy(request)
        self.operation = 'md'; self.paused = False; self.stopped = False
        self.max_wall_seconds = request.get('maxWallTimeSeconds')
        self.target_temperature = request['temperatureK']; self.started = time.monotonic()
        if request.get('constraints'):
            engine.reject('md-internal-constraints', 'MD尚不支持B/A/D动量约束。')
        self.runtime = context['runtime']; self.engine_identity = admitted_md_engine_identity(self.runtime)
        self.workspace = ordinary_directory(context['workspacePath'])
        self.sampling = sampling_request(request, context['threads'], checkpoint_steps)
        self.configuration = settings(self.sampling)
        initial_input = isolated_coordinate_input(self.sampling['structure']['atoms'],
            [[a[k]/BOHR_ANGSTROM for k in ('x','y','z')] for a in self.sampling['structure']['atoms']])
        self.checkpoint_files = CheckpointFiles(self.workspace, dict(schema='ester-modeling-md-source/v1',
            originalRequest=self.request, numericalRequest=self.sampling, configuration=self.configuration,
            resourceGrant=dict(threads=context['threads'],softMemoryBudgetBytes=context.get('memoryBudgetBytes'),nativeMemoryHardLimitApplied=False),
            engineIdentity=self.engine_identity, initialInput=initial_input, initialControl=control_input(self.sampling,self.configuration)))
        self.step = 0; self.segment = 0; self.current = None; self.restart_bytes = None; self.last_potential = None
        self.last_validated = self.snapshot(None, final=True)

    def running_seconds(self):
        return time.monotonic() - self.started

    def snapshot(self, raw, final=False):
        output = copy.deepcopy(self.request['structure'])
        if raw:
            for atom, point in zip(output['atoms'], raw['coordinates']):
                if not all(math.isfinite(v) and abs(v) <= 1e6 for v in point):
                    engine.reject('md-invalid-frame', '原生MD帧包含无效坐标，保留上一有效帧。')
                atom.update(zip(('x', 'y', 'z'), point))
            engine.check_stereo(self.request['structure'], output)
            if self.configuration['shakeHydrogenBonds']:
                for pair in self.configuration['hydrogenBondReferences']:
                    residual = abs(math.dist(raw['coordinates'][pair['a']], raw['coordinates'][pair['b']])-pair['lengthAngstrom'])
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
                segment=self.segment, velocityInitialization='fresh' if self.segment == 0 else 'restart', nativeClosed=self.current is None),
            units=dict(positions='angstrom', energy='eV', time='fs', temperature='K'))
        if raw and 'energyHartree' in raw:
            self.last_potential = dict(value=raw['energyHartree'], unit='hartree',
                definition='native-total-including-protection' if self.request.get('protectedAtomIds') else 'native-physical-potential',
                includesProtection=bool(self.request.get('protectedAtomIds')), sourceArtifact='xtb.trj',
                sourceStep=self.step, sourceTimeFs=self.step*2, segment=self.segment)
            # With protection the native potential includes the added restraint.
            if not self.request.get('protectedAtomIds'):
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
        text = isolated_coordinate_input(self.sampling['structure']['atoms'],
            [[a[k]/BOHR_ANGSTROM for k in ('x','y','z')] for a in self.sampling['structure']['atoms']])
        control = control_input(self.sampling, self.configuration)
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
        reader = TrajectoryReader(self.sampling['structure']['atoms'], self.configuration['dumpSteps'], self.configuration['steps'])
        header = False; process = job = None
        initial = restart_frame(directory/'mdrestart', len(self.sampling['structure']['atoms'])) if self.restart_bytes else None

        def drain(final=False):
            nonlocal header
            output = (directory/'stdout.txt').read_text(encoding='utf-8', errors='replace')
            if not header:
                if 'Berendsen THERMOSTAT on' not in output:
                    return
                validate_header(output, self.sampling, self.configuration, self.runtime['version'])
                if self.restart_bytes:
                    if '\n RESTART' not in output and '\nRESTART' not in output and ' RESTART' not in output:
                        engine.reject('md-restart-not-confirmed', '原生MD未确认读取连续状态。')
                header = True
            for raw in reader.iter_drain(directory/'xtb.trj', final=final):
                if raw['rawIndex'] == 0:
                    expected = initial['coordinates'] if initial else [[a[k] for k in ('x','y','z')] for a in self.sampling['structure']['atoms']]
                    if max(abs(v-w) for p,q in zip(raw['coordinates'], expected) for v,w in zip(p,q)) > 5e-6:
                        engine.reject('md-restart-position-mismatch', 'MD检查点坐标未按原生状态连续恢复。')
                    if initial and max(abs(v-w) for p,q in zip(raw['velocities'], initial['velocities']) for v,w in zip(p,q)) > 1e-8:
                        engine.reject('md-restart-velocity-mismatch', 'MD检查点速度未按原生状态连续恢复。')
                self.step = base_step + raw['step']
                self.last_validated = self.snapshot(raw)
                if raw['step'] % self.sampling['reportEvery'] == 0:
                    emit('frame')

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
