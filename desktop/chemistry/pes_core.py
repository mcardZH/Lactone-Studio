"""Physical PES energy/gradient transport and shared scientific result identity."""

import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time

import numpy as np

from pes_coordinates import CoordinateSet, ConstraintSpace
from pes_periodic import FixedCellGeometry


BOHR_ANGSTROM = 0.529177210903
HARTREE_EV = 27.211386245988


class PesError(ValueError):
    def __init__(self, message, code='PES_INVALID', diagnostics=None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics


class PesCancelled(PesError):
    def __init__(self):
        super().__init__('PES run was stopped', 'PES_STOPPED')


def require(condition, message, code='PES_INVALID'):
    if not condition:
        raise PesError(message, code)


def initial_positions(request):
    atoms = request['structure']['atoms']
    return np.array([[atom[key] for key in ('x', 'y', 'z')] for atom in atoms], dtype=float)


def atom_numbers(request):
    from ase.data import atomic_numbers
    return np.array([atomic_numbers[atom['element']] for atom in request['structure']['atoms']], dtype=int)


def uses_resident_eg(request):
    operation = request.get('operation')
    method = request.get('method')
    return ((operation in ('opt', 'irc') and method in ('gfn0', 'gfn1', 'gfn2', 'gfnff'))
            or (operation == 'hessian' and uses_v212_policy(request) and method in ('gfn1', 'gfn2'))
            or (request.get('parameters', {}).get('executionProfile') == 'pes-v222'
             and method in ('gfn0', 'gfn1', 'gfn2', 'gfnff')
             and operation in ('ts', 'scan', 'path'))
            or method == 'gfnff' and operation in ('ts', 'scan', 'path')
            or operation == 'hessian' and method in ('gfn0', 'gfnff'))


def uses_v212_policy(request):
    return (request.get('operation') in ('opt', 'irc')
            or request.get('parameters', {}).get('policyVersion') == 'v212')


def electronic_accuracy(request, *, hessian=False):
    if uses_v212_policy(request):
        return .1 if hessian or request.get('operation') in ('ts', 'irc', 'hessian') else 1.
    return request.get('parameters', {}).get('accuracy', .1)


def frame(request, positions, energy, step, phase, series_id, status, **details):
    return dict(
        id=f'{request["runIdentity"]["runId"]}:{series_id}:{step}',
        positions=np.asarray(positions, dtype=float).tolist(),
        energyHartree=None if energy is None else float(energy),
        step=step,
        phase=phase,
        seriesId=series_id,
        status=status,
        **details,
    )


class PathRecords:
    """Publish immutable whole-round assets without evaluating any geometry.

    The producer separates complete rounds from partial observations. A partial
    observation never replaces the most recent unrecorded complete round.
    """

    def __init__(self, ctx, series_id='path'):
        self.ctx, self.series_id = ctx, series_id
        value = ctx.request.get('parameters', {}).get('recordInterval', 5)
        require(type(value) is int and value > 0, 'recordInterval must be a positive integer')
        self.interval = value
        self.records = {}
        self.has_physical_round = False
        self.latest = None
        self.previous_complete = None
        self.latest_partial = None
        self.last_complete_id = None
        self.last_partial_id = None
        # Contexts without a workspace are in-process callers and own these
        # assets themselves. The worker always supplies an owned workspace.
        self.memory_assets = {}
        if not hasattr(ctx, 'path_recorders'):
            ctx.path_recorders = []
        ctx.path_recorders.append(self)

    def consider(self, frames, phase, step, *, initial=False, first_physical=False,
                 retain_previous=False, milestone=False, completed_phase=False):
        if not frames:
            return
        batch = json.loads(json.dumps(frames, allow_nan=False))
        self.previous_complete = self.latest if retain_previous and self.has_physical_round else None
        self.latest = (batch, phase, step)
        first = not initial and (first_physical or not self.has_physical_round)
        if not initial:
            self.has_physical_round = True
        if initial or first or milestone or completed_phase or step > 0 and step % self.interval == 0:
            kind = 'initial' if initial else 'final' if completed_phase else 'first-energy' if first else 'interval'
            self._record(batch, phase, step, kind)

    def consider_partial(self, frames, phase, step):
        if not frames:
            return
        batch = json.loads(json.dumps(frames, allow_nan=False))
        for item in batch:
            item['status'] = 'partial'
        self.latest_partial = (batch, phase, step)
        if step > 0 and step % self.interval == 0:
            self.last_partial_id = self._record(batch, phase, step, 'interval', partial=True)['id']

    def _record(self, frames, phase, step, kind, *, partial=False):
        identity = f'{self.ctx.request["runIdentity"]["runId"]}:{self.series_id}:{phase}:{step}'
        if identity in self.records:
            return self.records[identity]
        for index, item in enumerate(frames):
            item.update(id=f'{identity}:{item.get("bead", index + 1)}', seriesId=self.series_id,
                        phase=phase, step=step, pathRole='reactant' if item.get('bead') == 1 else 'node')
        length = 0. if frames[0].get('bead') == 1 else None
        frames[0]['arcLengthAngstrom'] = length
        connections = []
        for left, right in zip(frames, frames[1:]):
            adjacent = right.get('bead') == left.get('bead', 0) + 1
            if adjacent:
                connections.append([left['id'], right['id']])
            length = (length + float(np.linalg.norm(np.asarray(right['positions']) - left['positions']))) if adjacent and length is not None else None
            right['arcLengthAngstrom'] = length
        for left, middle, right in zip(frames, frames[1:], frames[2:]):
            energies = [item.get('energyHartree') for item in (left, middle, right)]
            if (not partial and all(value is not None for value in energies)
                    and right.get('bead') == middle.get('bead', 0) + 1 == left.get('bead', 0) + 2
                    and energies[1] >= max(energies[0], energies[2]) and energies[1] > min(energies[0], energies[2])):
                middle['localEnergyMaximum'] = True
        record = dict(id=identity, pathId=self.series_id, seriesId=self.series_id, phase=phase, step=step, kind=kind,
                      frames=[{key: value for key, value in item.items() if key != 'positions'} for item in frames],
                      connections=connections)
        reactant = next((item for item in frames if item.get('bead') == 1), None)
        if reactant is not None:
            record['reactantFrameId'] = reactant['id']
        artifact = None
        if self.ctx.workspace is not None:
            directory = Path(self.ctx.workspace) / 'path-records'
            directory.mkdir(exist_ok=True)
            name = hashlib.sha256(identity.encode('utf-8')).hexdigest() + '.json'
            data = json.dumps(frames, allow_nan=False, separators=(',', ':')).encode('utf-8')
            temporary = directory / (name + '.tmp')
            with temporary.open('xb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(directory / name)
            artifact = dict(name=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        else:
            self.memory_assets[identity] = frames
        self.records[identity] = record
        self.ctx.emit('path-record', dict(record=record, artifact=artifact))
        return record

    def finish(self):
        if self.latest is None and self.latest_partial is None:
            return None
        if self.latest is not None:
            if self.previous_complete is not None:
                previous, phase, step = self.previous_complete
                self._record(previous, phase, step, 'interval')
            frames, phase, step = self.latest
            record = self._record(frames, phase, step, 'final')
            if self.has_physical_round:
                # A prior cadence may have already published the final round.
                # Write the index in round order and keep that same asset ID.
                self.records.pop(record['id'])
                self.records[record['id']] = dict(record, kind='final')
            self.last_complete_id = record['id']
            self.latest = None
            self.previous_complete = None
        if self.latest_partial is not None:
            frames, phase, step = self.latest_partial
            self.last_partial_id = self._record(frames, phase, step, 'interval', partial=True)['id']
            self.latest_partial = None
        if self.has_physical_round:
            return self.last_complete_id
        return self.last_partial_id or self.last_complete_id


class PesContext:
    """Own one accepted input, cancellation and one exact-geometry E/G cache."""

    def __init__(self, request, evaluator, *, cancelled=None, emit=None):
        self.request = request
        self._evaluator = evaluator
        self._cancelled = cancelled or (lambda: False)
        self._emit = emit or (lambda kind, payload: None)
        self.initial = initial_positions(request)
        self.atom_ids = tuple(atom['id'] for atom in request['structure']['atoms'])
        require(self.initial.shape == (len(self.atom_ids), 3) and len(self.atom_ids) > 0
                and np.isfinite(self.initial).all(), 'Invalid or empty PES source geometry')
        require(len(set(self.atom_ids)) == len(self.atom_ids), 'PES atoms must have distinct stable IDs')
        self.geometry = FixedCellGeometry.from_structure(request['structure'])
        self.constraints = ConstraintSpace(self.initial, self.atom_ids, request.get('constraints'), geometry=self.geometry)
        self.coordinates = CoordinateSet(self.atom_ids, request.get('coordinates', ()), geometry=self.geometry)
        self.evaluations = 0
        self.evaluation_attempts = 0
        self.runtime = None
        self.workspace = None
        self._last_positions = self._last_value = None
        self.last_hessian = None
        self._node_cache = {}
        self._node_serial = 0
        self._closed = False
        self._evaluation_lock = threading.RLock()

    def cancelled(self):
        return bool(self._cancelled())

    def check_cancelled(self):
        if self.cancelled():
            raise PesCancelled()

    def emit(self, kind, payload):
        self._emit(kind, payload)

    def new_node_id(self, namespace='node'):
        require(isinstance(namespace, str) and namespace, 'PES node namespace must be a nonempty string')
        with self._evaluation_lock:
            require(not self._closed, 'PES context is closed')
            self._node_serial += 1
            return f'owned:{namespace}:{self._node_serial}'

    def release_node(self, node_id):
        require(isinstance(node_id, str) and node_id, 'PES node identity must be a nonempty string')
        with self._evaluation_lock:
            self._node_cache.pop(('node', node_id), None)
            self._last_positions = self._last_value = None
            release = getattr(self._evaluator, 'release_node', None)
            if release is not None:
                release(node_id)

    def close(self):
        with self._evaluation_lock:
            if self._closed:
                return
            self._closed = True
            self._node_cache.clear()
            self._last_positions = self._last_value = None
            close = getattr(self._evaluator, 'close', None)
            if close is not None:
                close()

    def evaluate(self, positions, need_bond_orders=False, *, node_id=None):
        require(node_id is None or isinstance(node_id, str) and node_id, 'PES node identity must be a nonempty string')
        with self._evaluation_lock:
            require(not self._closed, 'PES context is closed')
            return self._evaluate(positions, need_bond_orders, node_id)

    @property
    def supports_evaluation_batch(self):
        return callable(getattr(self._evaluator, 'evaluate_many', None))

    def evaluate_many(self, nodes):
        """Return ordered E/G results or independent failures for owned nodes."""
        with self._evaluation_lock:
            require(not self._closed, 'PES context is closed')
            self.check_cancelled()
            result = [None] * len(nodes)
            pending = []
            for index, (node_id, positions) in enumerate(nodes):
                try:
                    require(isinstance(node_id, str) and node_id, 'PES node identity must be a nonempty string')
                    xyz = self._geometry(positions)
                    key = ('node', node_id)
                    previous = self._node_cache.get(key)
                    if previous is not None and np.array_equal(previous[0], xyz):
                        result[index] = dict(previous[1])
                    elif self.supports_evaluation_batch:
                        pending.append((index, key, xyz.copy()))
                    else:
                        result[index] = self._evaluate(xyz, False, node_id)
                except PesCancelled:
                    raise
                except Exception as error:
                    result[index] = error
            if not pending:
                return result
            self.evaluation_attempts += len(pending)
            evaluated = self._evaluator.evaluate_many([xyz for _, _, xyz in pending])
            require(len(evaluated) == len(pending), 'PES batch E/G result count differs from the candidate count')
            self.check_cancelled()
            for (index, key, xyz), raw in zip(pending, evaluated):
                try:
                    if isinstance(raw, Exception):
                        raise raw
                    result[index] = self._accept_evaluation(xyz, False, key, raw)
                except PesCancelled:
                    raise
                except Exception as error:
                    result[index] = error
            return result

    def _geometry(self, positions):
        xyz = np.asarray(positions, dtype=float)
        require(xyz.shape == self.initial.shape and np.isfinite(xyz).all(), 'Invalid PES evaluation geometry')
        return xyz

    def _evaluate(self, positions, need_bond_orders, node_id):
        self.check_cancelled()
        xyz = self._geometry(positions)
        key = ('default', None) if node_id is None else ('node', node_id)
        previous = self._node_cache.get(key)
        if (previous is not None and np.array_equal(previous[0], xyz)
                and (not need_bond_orders or 'bondOrders' in previous[1])):
            return dict(previous[1])
        self.evaluation_attempts += 1
        evaluate_node = getattr(self._evaluator, 'evaluate_node', None)
        raw = (evaluate_node(xyz.copy(), node_id=node_id, need_bond_orders=need_bond_orders) if evaluate_node is not None
               else self._evaluator(xyz.copy(), need_bond_orders=need_bond_orders))
        self.check_cancelled()
        return self._accept_evaluation(xyz, need_bond_orders, key, raw)

    def _accept_evaluation(self, xyz, need_bond_orders, key, raw):
        energy = float(raw['energyHartree'])
        gradient = np.array(raw['gradientHartreePerBohr'], dtype=float, copy=True)
        require(math.isfinite(energy) and gradient.shape == xyz.shape and np.isfinite(gradient).all(),
                'PES calculator returned an invalid energy or gradient', 'PES_EVALUATOR_INVALID')
        gradient.flags.writeable = False
        value = {**raw, 'energyHartree': energy, 'gradientHartreePerBohr': gradient}
        if need_bond_orders or 'bondOrders' in raw:
            orders = np.array(raw.get('bondOrders'), dtype=float, copy=True)
            require(orders.shape == (len(xyz), len(xyz)) and np.isfinite(orders).all()
                    and np.allclose(orders, orders.T),
                    'PES calculator did not return atom-pair bond orders', 'PES_BOND_ORDERS_INVALID')
            orders.flags.writeable = False
            value['bondOrders'] = orders
        self.evaluations += 1
        self._last_positions, self._last_value = xyz.copy(), value
        self._node_cache[key] = self._last_positions, value
        return dict(value)

    def provenance(self):
        evidence = dict(
            method=self.request.get('method'),
            charge=self.request.get('charge'),
            uhf=self.request.get('uhf'),
            solvation=self.request.get('solvation'),
            threads=self.request.get('threads'),
            memoryBudgetBytes=self.request.get('memoryBudgetBytes'),
            energyUnit='hartree',
            gradientUnit='hartree/bohr',
            coordinateUnit='angstrom',
            physicalEvaluations=self.evaluations,
            attemptedPhysicalEvaluations=self.evaluation_attempts,
        )
        if hasattr(self._evaluator, 'evidence'):
            evidence.update(self._evaluator.evidence())
        return evidence

    def physical_hessian(self, positions, step):
        with self._evaluation_lock:
            require(not self._closed, 'PES context is closed')
            self.check_cancelled()
            provider = getattr(self._evaluator, 'physical_hessian', None)
            return provider(positions, step) if provider is not None else None


def number(token):
    value = float(token.replace('D', 'e').replace('d', 'e'))
    require(math.isfinite(value), 'Invalid native xTB number', 'PES_XTB_OUTPUT')
    return value


def native_solvation(output, expected, method):
    markers = list(re.finditer(r'^[ \t]*\*[ \t]+Solvation model:[ \t]+([^\n]+)$', output, re.M))
    if expected is None:
        require(not markers, 'Unexpected native xTB solvation model', 'PES_XTB_SOLVATION')
        return None
    require(len(markers) == 1 and markers[0][1].strip() == 'ALPB',
            'Expected native ALPB block missing or ambiguous', 'PES_XTB_SOLVATION')
    tail = output[markers[0].start():]
    end = re.search(r'^[ \t]+Grid points[ \t]+\d+[ \t]+per atom[ \t]*$', tail, re.M)
    require(end is not None, 'Incomplete native ALPB block', 'PES_XTB_SOLVATION')
    fields = {}
    for line in tail[:end.start()].splitlines()[1:]:
        if line.startswith('        '):
            label = line[8:39].rstrip()
            require(label not in fields, 'Ambiguous native ALPB field', 'PES_XTB_SOLVATION')
            fields[label] = line[39:].strip()
    parameter_set = f'internal {method.upper()}-xTB/ALPB'
    temperature = re.fullmatch(r'([-+\d.eEdD]+)\s+K', fields.get('Temperature', ''))
    require(fields.get('Solvent') == expected['solvent'] and fields.get('Parameter file') == parameter_set
            and fields.get('Interaction kernel') == 'P16'
            and fields.get('Reference state') == 'gsolv [1 M gas/solution]'
            and temperature is not None and number(temperature[1]) == 298.15,
            'Actual native ALPB configuration differs from the request', 'PES_XTB_SOLVATION')
    return dict(model='alpb', solvent=expected['solvent'], kernel='p16', referenceState='gsolv',
                temperatureKelvin=298.15, parameterSet=parameter_set, sourceField='stdout:solvation-model')


def native_electronic_failure(log, *, has_scc):
    geometry_failure = re.search(r'\b(?:Diagonalization of (?:the )?Hamiltonian failed|'
                                 r'failed to diagonalize (?:the )?Hamiltonian)\b', log, re.I)
    if geometry_failure:
        return 'PES_XTB_GEOMETRY', geometry_failure.group()
    scc_failure = re.search(r'\b(?:SCC|SCF) (?:not (?:fully )?converged|'
                            r'(?:did not|failed to|could not) converge)\b(?: in \d+ (?:cycles|iterations))?|'
                            r'\b(?:SCC|SCF) (?:iteration )?failed\b|'
                            r'\belectronic structure (?:was )?not converged\b|'
                            r'\bconvergence criteria cannot be satisfied\b', log, re.I)
    if has_scc and scc_failure:
        return 'PES_XTB_SCC', scc_failure.group()
    return None


def native_shared_failure(log):
    return re.search(r'\b(?:out of memory|memory allocation|allocation (?:error|failed|failure)|'
                     r'cannot allocate|failed to allocate|not enough memory|insufficient memory|permission denied|'
                     r'access is denied|no space left|disk full|i/o error|input/output error|'
                     r'no such file|(?:cannot|could not|failed to) (?:open|load|read|write)|'
                     r'missing (?:parameter(?:s| file)?|dynamic librar(?:y|ies))|error while loading shared libraries)\b',
                     log, re.I) is not None


def native_scc_started(output):
    """A numbered row under the native electronic-iteration header."""
    numeric = r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?'
    return re.search(r'^[ \t]*(?:cycle[ \t]+total energy[ \t]+energy error[ \t]+density error|'
                     r'iter[ \t]+E[ \t]+dE[ \t]+RMSdq)[^\r\n]*\r?\n'
                     r'[ \t]*1[ \t]+' + numeric + r'(?:[ \t]+' + numeric + r'){2}(?:[ \t]|\r?$)',
                     output, re.I | re.M) is not None


def native_status(output, errors, runtime_version, request, scc_limit, exit_code=0):
    output = output.replace('\r\n', '\n')
    version = re.search(r'\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)', output, re.I)
    require(version is not None and version.group(1) == runtime_version, 'Native xTB version mismatch', 'PES_XTB_FAILED')
    log = output + '\n' + errors
    failure = native_electronic_failure(log, has_scc=request['method'] != 'gfn0')
    shared_failure = native_shared_failure(log)
    if failure and not shared_failure:
        code, detail = failure
        raise PesError(detail, code)
    method = request['method'].upper() + '-XTB'
    headings = [re.sub(r'\s+', '', title).upper() for title in
                re.findall(r'^\s*\|\s*([^|\r\n]+?)\s*\|\s*$', output, re.M)]
    methods = [title for title in headings if re.fullmatch(r'GFN(?:\d+-XTB|-FF)', title)]
    if (exit_code == 1 and not shared_failure and request.get('parameters', {}).get('batchFinalOnly') is True
            and request['method'] in ('gfn1', 'gfn2') and methods == [method] and native_scc_started(output)):
        raise PesError('Native xTB stopped during this structure’s electronic evaluation (exit code 1)',
                       'PES_XTB_EVALUATION')
    require(exit_code == 0 and 'normal termination of xtb' in log.lower(),
            f'Native xTB termination mismatch (exit code {exit_code})', 'PES_XTB_FAILED')
    require(not re.search(r'ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR|Single point calculation terminated|'
                          r'FAILED TO CONVERGE|convergence criteria cannot be satisfied|SCC (?:iteration )?failed',
                          output + '\n' + errors, re.I),
            'Native xTB energy/gradient evaluation failed', 'PES_XTB_FAILED')
    require(methods == [method]
            and not re.search(r'Periodic properties|GEOMETRY OPTIMIZATION|Fast Inertial Relaxation Engine|RF solver',
                              output, re.I),
            'Native gradient does not belong to the requested isolated GFN method', 'PES_XTB_OUTPUT')
    energies = re.findall(r'\|\s*TOTAL ENERGY\s+([-+\d.eEdD]+)\s+Eh\s*\|', output)
    require(len(energies) == 1, 'Native gradient energy is absent or ambiguous', 'PES_XTB_OUTPUT')
    iterations = None
    if request['method'] != 'gfn0':
        counts = re.findall(r'^\s*\*{3}\s+convergence criteria satisfied after\s+(\d+)\s+iterations\s+\*{3}\s*$', output, re.M)
        require(len(counts) == 1 and 1 <= int(counts[0]) <= scc_limit,
                'Native GFN SCC convergence evidence missing or exceeds the requested limit', 'PES_XTB_OUTPUT')
        iterations = int(counts[0])
    return number(energies[0]), native_solvation(output, request.get('solvation'), request['method']), iterations


def sparse_bond_orders(text, atom_count):
    """The native WBO writer omits pairs <= 0.1; retain that bound explicitly."""
    require(not text or text.endswith('\n'), 'Truncated native xTB WBO', 'PES_BOND_ORDERS_INVALID')
    matrix = np.zeros((atom_count, atom_count))
    seen = set()
    for row in text.splitlines():
        fields = row.split()
        require(len(fields) == 3 and fields[0].isdigit() and fields[1].isdigit(),
                'Invalid native xTB WBO row', 'PES_BOND_ORDERS_INVALID')
        left, right = int(fields[0]), int(fields[1])
        value = number(fields[2])
        pair = (left, right)
        require(1 <= left < right <= atom_count and pair not in seen and value > .1,
                'Invalid or duplicate native xTB WBO pair', 'PES_BOND_ORDERS_INVALID')
        seen.add(pair)
        matrix[left - 1, right - 1] = matrix[right - 1, left - 1] = value
    return matrix


class NativeGfnEvaluator:
    """Evaluate a geometry with the trusted xTB 6.8.0 binary and real ALPB."""

    def __init__(self, request, runtime, workspace):
        from conformer_gfnff import ordinary_directory
        method = request.get('method')
        require(method in ('gfn0', 'gfn1', 'gfn2', 'gfnff'), 'Unsupported PES GFN method')
        require(runtime.get('version') == '6.8.0', 'PES requires the locked xTB 6.8.0 runtime')
        for key in ('executable', 'directory', 'dataDirectory'):
            require(isinstance(runtime.get(key), str) and Path(runtime[key]).is_absolute(),
                    'Trusted host must resolve xTB runtime paths')
        variant = runtime.get('engineIdentity', {}).get('runtimeVariant')
        allowed_variants = (('gfn0-stack64' if method == 'gfn0' else 'official'),) if os.name == 'nt' else (('gfn0-stack64', 'official') if method == 'gfn0' else ('official',))
        require(variant in allowed_variants,
                'Native xTB runtime variant does not match the requested GFN method')
        require(type(request.get('threads')) is int and request['threads'] > 0, 'Missing PES thread grant')
        require(type(request.get('charge')) is int and type(request.get('uhf')) is int and request['uhf'] >= 0,
                'Missing confirmed PES electronic state')
        electron_count = int(sum(atom_numbers(request))) - request['charge']
        require(electron_count >= request['uhf'] and (electron_count - request['uhf']) % 2 == 0,
                'PES charge and spin are incompatible with the source atoms')
        solv = request.get('solvation')
        require(solv is None or (method in ('gfn1', 'gfn2', 'gfnff') and isinstance(solv, dict) and solv.get('model') == 'alpb'
                                 and re.fullmatch(r'[a-z0-9_-]+', str(solv.get('solvent', '')))),
                'Selected GFN method does not support this solvent')
        settings = request.get('parameters', {})
        self.scc_limit = settings.get('maxSccIterations', request.get('maxSccIterations', 250)) if method in ('gfn1', 'gfn2') else None
        require(self.scc_limit is None or type(self.scc_limit) is int and self.scc_limit > 0,
                'SCC iteration limit must be a positive integer')
        self.request, self.runtime = request, runtime
        self.workspace = ordinary_directory(Path(workspace))
        self.evaluations = 0
        self.last = None
        self.solvation = None
        self.bond_order_used = False
        self.native_invocations = 0
        self.hessian_attempts = 0
        self.hessian_evaluations = 0
        self.last_hessian = None
        self.hessian_fallbacks = []

    def bind(self, context):
        self.ctx = context

    def evidence(self):
        result = dict(engine='native-xtb', version=self.runtime['version'], engineIdentity=self.runtime['engineIdentity'],
                      solvationEvidence=self.solvation, spinTreatment='requested-unpaired-electrons',
                      maxSccIterations=self.scc_limit,
                      lastEvaluation=self.last, nativeInvocations=self.native_invocations,
                      nativeHessianCalls=self.hessian_evaluations,
                      attemptedNativeHessianCalls=self.hessian_attempts)
        if self.last_hessian is not None:
            result['lastHessianEvaluation'] = self.last_hessian
        if self.hessian_fallbacks:
            result['hessianFallbacks'] = self.hessian_fallbacks
        if self.bond_order_used:
            result['bondOrderEvidence'] = dict(definition='mayer-ao', sourceField='wbo',
                                               nativeThreshold=.1, missingPairUpperBound=.1)
        if getattr(self, 'last_requested_electronic_settings', None) is not None:
            result['requestedElectronicSettings'] = self.last_requested_electronic_settings
        return result

    def _environment(self, directory):
        threads = str(self.request['threads'])
        env = {key: value for key, value in os.environ.items()
               if key.upper() in ('SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE')}
        env.update(PATH=self.runtime['directory'], XTBPATH=self.runtime['dataDirectory'],
                   HOME=str(directory), USERPROFILE=str(directory), TEMP=str(directory), TMP=str(directory),
                   LANG='C', LC_ALL='C', OMP_NUM_THREADS=threads, OMP_MAX_ACTIVE_LEVELS='1', OMP_DYNAMIC='FALSE',
                   MKL_NUM_THREADS=threads, OPENBLAS_NUM_THREADS=threads)
        if os.name != 'nt':
            runtime_root = Path(self.runtime['root']) if isinstance(self.runtime.get('root'), str) and self.runtime['root'] else Path(self.runtime['directory']).parent
            lib_dir = runtime_root / 'lib'
            if lib_dir.exists() or lib_dir.is_symlink():
                require(lib_dir.is_dir() and not lib_dir.is_symlink(),
                        'xTB lib directory must be an ordinary directory, not a symlink')
                lib_paths = [str(lib_dir), self.runtime['directory']]
            else:
                lib_paths = [self.runtime['directory']]
            if sys.platform == 'darwin':
                lib_paths.append('/usr/lib')
                env['DYLD_FALLBACK_LIBRARY_PATH'] = os.pathsep.join(lib_paths)
            else:
                env['LD_LIBRARY_PATH'] = os.pathsep.join(lib_paths)
        return env

    def _arguments(self, operation):
        method = self.request['method']
        require(method != 'gfnff', 'Fixed-model GFN-FF PES E/G requires the resident provider')
        argv = [self.runtime['executable'], 'input.coord', '--gfn', method[-1], operation, '--norestart',
                '--chrg', str(self.request['charge']), '--uhf', str(self.request['uhf']),
                '--parallel', str(self.request['threads'])]
        if method in ('gfn1', 'gfn2'):
            argv.extend(['--iterations', str(self.scc_limit)])
        settings = self.request.get('parameters', {})
        if uses_resident_eg(self.request) or uses_v212_policy(self.request):
            accuracy = electronic_accuracy(self.request, hessian=operation == '--hess')
            require(type(accuracy) in (int, float) and math.isfinite(accuracy) and accuracy > 0,
                    'Electronic accuracy must be positive')
            argv.extend(['--acc', format(accuracy, '.17g')])
            self.last_requested_electronic_settings = dict(accuracy=accuracy, sourceField='CLI:argv')
            if method in ('gfn1', 'gfn2'):
                temperature = settings.get('electronicTemperatureK', 300.)
                require(type(temperature) in (int, float) and math.isfinite(temperature) and temperature >= 0,
                        'Electronic temperature must be nonnegative')
                argv.extend(['--etemp', format(temperature, '.17g')])
                self.last_requested_electronic_settings.update(electronicTemperatureK=temperature, maxSccIterations=self.scc_limit)
        if self.request.get('solvation'):
            argv.extend(['--alpb', self.request['solvation']['solvent']])
        return argv

    def __call__(self, positions, *, need_bond_orders=False):
        from conformer_gfnff import (isolated_coordinate_input, ordinary_directory,
                                    ordinary_file, parse_isolated_engrad)
        from task_files import clean_evaluation
        self.evaluations += 1
        directory = self.workspace / f'eg-{self.evaluations:08d}'
        directory.mkdir()
        ordinary_directory(directory)
        xyz_bohr = positions / BOHR_ANGSTROM
        atoms = self.request['structure']['atoms']
        source = directory / 'input.coord'
        coordinate_input = isolated_coordinate_input(atoms, xyz_bohr)
        with source.open('x', encoding='ascii', newline='\n') as stream:
            stream.write(coordinate_input)
        argv, env = self._arguments('--grad'), self._environment(directory)
        try:
            output, errors, evidence = self._invoke(argv, env, directory)
            summary, solvation, iterations = native_status(output, errors, self.runtime['version'], self.request, self.scc_limit, evidence['code'])
            require(ordinary_file(source).read_text(encoding='ascii') == coordinate_input,
                    'Native gradient input changed during evaluation', 'PES_XTB_OUTPUT')
            outputs = [path for path in directory.iterdir() if path.suffix == '.engrad']
            require(len(outputs) == 1, 'Exactly one native engrad is required', 'PES_XTB_OUTPUT')
            gradient_source = ordinary_file(outputs[0]).read_bytes()
            energy, gradient, _ = parse_isolated_engrad(gradient_source.decode('ascii'), atoms, xyz_bohr)
            require(abs(summary - energy) <= 1e-9, 'Native engrad and stdout energies differ', 'PES_XTB_OUTPUT')
            result = dict(energyHartree=energy, gradientHartreePerBohr=gradient)
            if need_bond_orders:
                path = directory / 'wbo'
                require(path.is_file() and not path.is_symlink() and path.lstat().st_nlink == 1,
                        'This native evaluation did not produce xTB WBO', 'PES_BOND_ORDERS_INVALID')
                result['bondOrders'] = sparse_bond_orders(path.read_text(encoding='ascii'), len(atoms))
                result['bondOrderMissingPairUpperBound'] = .1
                self.bond_order_used = True
            self.last = dict(evidence, energyHartree=energy, sccIterations=iterations,
                             inputSha256=hashlib.sha256(coordinate_input.encode('ascii')).hexdigest(),
                             engradSha256=hashlib.sha256(gradient_source).hexdigest())
            self.solvation = solvation
        except PesCancelled:
            raise
        except (ValueError, OSError) as error:
            raise PesError(str(error), getattr(error, 'code', 'PES_XTB_FAILED'),
                           {'directory': str(directory), 'evaluation': self.evaluations}) from error
        try:
            clean_evaluation(directory)
        except (ValueError, OSError) as error:
            self.last['retainedNativeEvidence'] = {'directory': str(directory), 'reason': str(error)}
        return result

    def physical_hessian(self, positions, step):
        # GFN2 uses the validated native unprojected writer. Other GFN levels
        # retain the physical-gradient difference path through the same context.
        if self.request['method'] != 'gfn2':
            return None
        from conformer_gfnff import isolated_coordinate_input, ordinary_file
        from task_files import clean_evaluation
        self.ctx.check_cancelled()
        self.hessian_attempts += 1
        directory = self.workspace / f'hessian-{self.hessian_attempts:08d}'
        directory.mkdir()
        xyz = np.asarray(positions, dtype=float)
        text = isolated_coordinate_input(self.request['structure']['atoms'], xyz / BOHR_ANGSTROM)
        source = directory / 'input.coord'
        source.write_text(text, encoding='ascii', newline='\n')
        scc_accuracy = f' sccacc={electronic_accuracy(self.request, hessian=True):.17g}\n' if uses_v212_policy(self.request) else ''
        control = f'$hess\n step={step:.17g}\n{scc_accuracy}$write\n hessian.out=true\n$end\n'
        (directory / 'hessian.inp').write_text(control, encoding='ascii', newline='\n')
        argv = self._arguments('--hess') + ['--input', 'hessian.inp']
        try:
            output, errors, receipt = self._invoke(argv, self._environment(directory), directory)
            energy, solvation, iterations = native_status(output, errors, self.runtime['version'],
                                                        self.request, self.scc_limit, receipt['code'])
            require(ordinary_file(source).read_text(encoding='ascii') == text,
                    'Native Hessian input changed during evaluation', 'PES_XTB_OUTPUT')
            target = directory / 'hessian.out'
            if not target.exists():
                self.hessian_fallbacks.append(dict(reason='Native unprojected Hessian output unavailable',
                                                    directory=str(directory), **receipt))
                return None
            data = ordinary_file(target).read_bytes()
            values = np.array([number(token) for token in data.decode('ascii').split()])
            require(values.size == xyz.size ** 2,
                    'Native unprojected Hessian has an incomplete matrix', 'PES_XTB_OUTPUT')
            matrix = values.reshape((xyz.size, xyz.size), order='F')
            asymmetry = float(np.max(np.abs(matrix - matrix.T)))
            self.hessian_evaluations += 1
            self.solvation = solvation
            self.last_hessian = dict(receipt, energyHartree=energy, sccIterations=iterations,
                                     inputSha256=hashlib.sha256(text.encode('ascii')).hexdigest(),
                                     controlSha256=hashlib.sha256(control.encode('ascii')).hexdigest(),
                                     hessianSha256=hashlib.sha256(data).hexdigest(),
                                     sourceField='hessian.out', coordinateUnit='angstrom',
                                     hessianUnit='hartree/bohr^2', displacementBohr=step,
                                     derivativeEvaluations=2 * xyz.size)
            self.ctx.last_hessian = dict(derivativeMethod='native-xtb-unprojected-hessian.out',
                                         displacementBohr=step, derivativeEvaluations=2 * xyz.size,
                                         nativeHessianCalls=1,
                                         maximumReportedAntisymmetryHartreePerBohr2=asymmetry)
        except PesCancelled:
            raise
        except (ValueError, OSError) as error:
            raise PesError(str(error), getattr(error, 'code', 'PES_XTB_FAILED'),
                           {'directory': str(directory), 'operation': 'hessian'}) from error
        try:
            clean_evaluation(directory)
        except (ValueError, OSError) as error:
            self.last_hessian['retainedNativeEvidence'] = {'directory': str(directory), 'reason': str(error)}
        return .5 * (matrix + matrix.T), asymmetry

    def _invoke(self, argv, env, directory):
        from orbitals import _windows_owned_job
        process = job = None
        stdout = stderr = b''
        started = time.monotonic()
        record = dict(argv=argv, evaluation=self.evaluations, code=None, nativeClosed=False)
        try:
            process = subprocess.Popen(argv, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       creationflags=0x08000000 if os.name == 'nt' else 0)
            self.native_invocations += 1
            job = _windows_owned_job(process)
            record['pid'] = process.pid
            while True:
                self.ctx.check_cancelled()
                try:
                    stdout, stderr = process.communicate(timeout=.1)
                    break
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                    stdout, stderr = process.communicate()
                record.update(code=process.returncode, nativeClosed=True)
            if job:
                job[0].CloseHandle(job[1])
            record['processSeconds'] = time.monotonic() - started
            (directory / 'stdout.txt').write_bytes(stdout)
            (directory / 'stderr.txt').write_bytes(stderr)
            (directory / 'process.json').write_text(json.dumps(record, allow_nan=False), encoding='utf-8')
        self.ctx.check_cancelled()
        return stdout.decode('utf-8', errors='replace'), stderr.decode('utf-8', errors='replace'), record


class ResidentTblitePes:
    """Use the common fixed-cell tblite evaluator with PES node ownership."""

    def __init__(self, request, descriptor):
        from pes_libxtb import TbliteEvaluator
        options = request.get('parameters', {})
        self.settings = dict(accuracy=.1 if request['operation'] in ('ts', 'hessian', 'irc') else 1.,
                             maxSccIterations=options.get('maxSccIterations', 250),
                             electronicTemperatureK=300.)
        self.provider = TbliteEvaluator({**request, 'parameters': self.settings}, descriptor)
        self.native_invocations = 0

    def bind(self, context):
        self.ctx = context

    def evaluation_started(self):
        self.native_invocations += 1
        if self.native_invocations == 1:
            self.ctx.emit('evaluation-started', dict(physicalEvaluationStartedAtMs=time.time_ns() / 1e6,
                          backend='tblite', clockSource='native-boundary'))

    def evaluate_node(self, positions, *, node_id=None, need_bond_orders=False):
        require(not need_bond_orders, 'Periodic bond orders require image identities', 'PES_BOND_ORDERS_INVALID')
        try:
            return self.provider.evaluate_node(positions, node_id=node_id, on_start=self.evaluation_started)
        except RuntimeError as error:
            message = str(error)
            failure = (native_electronic_failure(message, has_scc=True)
                       if message.startswith('tblite energy and gradient:') and not native_shared_failure(message) else None)
            raise PesError(message, failure[0] if failure else 'PES_XTB_FAILED') from error

    def release_node(self, node_id):
        self.provider.release_node(node_id)

    def evidence(self):
        provider_identity = self.provider.evidence()
        engine_identity = dict(engine='tblite', providerInterface='c-api', version=provider_identity['version'],
                               librarySha256=provider_identity['librarySha256'])
        return dict(engine='tblite', provider='tblite', providerInterface='c-api', fixedCell=True,
                    sourceCell=self.ctx.request['structure']['cell'], providerSettings=self.settings,
                    nativeInvocations=self.native_invocations, engineIdentity=engine_identity, **provider_identity)

    def close(self):
        self.provider.close()


def make_context(request, runtime, workspace, *, cancelled=None, emit=None):
    method = request.get('method')
    require(method != 'mcgfnff', 'mcGFN-FF is available in saved results only')
    cell = request['structure'].get('cell')
    periodic = cell and any(cell.get('pbc', ()))
    require(method in ('gfn0', 'gfn1', 'gfn2', 'gfnff', 'gxtb'),
            'This calculation method is unavailable in this edition of Ester Studio', 'PES_METHOD_UNAVAILABLE')
    if periodic and method in ('gfn1', 'gfn2') and 'tblite' in runtime:
        evaluator = ResidentTblitePes(request, runtime['tblite'])
    elif (request['operation'] == 'opt' and method == 'gxtb') or (periodic and method in ('gfn1', 'gfn2')):
        from pes_opt_evaluator import NativeOptEvaluator
        evaluator = NativeOptEvaluator(request, runtime, workspace, cancelled=cancelled)
    else:
        evaluator = NativeGfnEvaluator(request, runtime, workspace)
        if uses_resident_eg(request):
            from pes_libxtb import LibXtbEvaluator
            evaluator = LibXtbEvaluator(request, runtime, workspace, native=evaluator)
    try:
        context = PesContext(request, evaluator, cancelled=cancelled, emit=emit)
        context.runtime, context.workspace = runtime, Path(workspace)
        evaluator.bind(context)
        return context
    except BaseException:
        close = getattr(evaluator, 'close', None)
        if close is not None:
            close()
        raise
