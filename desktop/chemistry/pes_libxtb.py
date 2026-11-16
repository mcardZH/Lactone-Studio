"""Owned, sequential libxtb PES E/G with one mutable electronic state per node.

The desktop resolver supplies the verified runtime root. This module never
searches the user PATH, imports a research installation, or spawns CLI E/G.
Native Hessian and explicit bond-order requests keep their existing provider.
"""
from __future__ import annotations

import ctypes as C
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import time

import numpy as np

from pes_core import BOHR_ANGSTROM, PesCancelled, PesError, atom_numbers, require

P = C.c_void_p


def _digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _member(root, relative):
    from conformer_gfnff import ordinary_file
    require(isinstance(relative, str) and not Path(relative).is_absolute(), 'Invalid libxtb runtime member', 'PES_LIBXTB_RUNTIME')
    file = root / relative
    require(file.resolve().is_relative_to(root), 'libxtb runtime member escaped its root', 'PES_LIBXTB_RUNTIME')
    return ordinary_file(file)


class LibXtbApi:
    def __init__(self, root, threads, expected_manifest=None):
        from conformer_gfnff import ordinary_directory
        require(isinstance(root, str) and Path(root).is_absolute(), 'Missing trusted libxtb runtime root', 'PES_LIBXTB_RUNTIME')
        self.root = ordinary_directory(Path(root))
        manifest_file = _member(self.root, 'runtime.json')
        self.manifest_sha256 = _digest(manifest_file)
        require(expected_manifest is None or expected_manifest == self.manifest_sha256,
                'libxtb runtime manifest identity changed', 'PES_LIBXTB_RUNTIME')
        manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
        require(manifest.get('schema') == 'ester-pes-libxtb-runtime/v1' and manifest.get('version') == '6.8.0'
                and manifest.get('apiVersion') == 20000 and isinstance(manifest.get('files'), list),
                'Unsupported libxtb runtime identity', 'PES_LIBXTB_RUNTIME')
        self.members = {}
        for entry in manifest['files']:
            relative = entry.get('path')
            require(relative not in self.members, 'Duplicate libxtb runtime member', 'PES_LIBXTB_RUNTIME')
            file = _member(self.root, relative)
            require(file.stat().st_size == entry.get('bytes') and _digest(file) == entry.get('sha256'),
                    'libxtb runtime member identity changed', 'PES_LIBXTB_RUNTIME')
            self.members[relative] = entry
        default_lib = 'bin/libxtb.dll' if os.name == 'nt' else ('lib/libxtb.dylib' if sys.platform == 'darwin' else 'lib/libxtb.so')
        library_relative = manifest.get('libraryRelativePath', default_lib)
        parameter_relative = manifest.get('parameterDirectory', 'data')
        require(library_relative in self.members, 'libxtb library is absent from its manifest', 'PES_LIBXTB_RUNTIME')
        self.library_relative = library_relative
        self.library_file = _member(self.root, library_relative)
        self.parameter_files = {}
        self.parameter_sha256 = {}
        for method in ('gfn0', 'gfn1', 'gfn2', 'gfnff'):
            filename = '.param_gfnff.xtb' if method == 'gfnff' else f'param_{method}-xtb.txt'
            relative = manifest.get('parameters', {}).get(method, f'{parameter_relative}/{filename}')
            require(relative in self.members, 'libxtb parameter file is absent from its manifest', 'PES_LIBXTB_RUNTIME')
            self.parameter_files[method] = _member(self.root, relative)
            self.parameter_sha256[method] = _digest(self.parameter_files[method])
        self.identity = dict(manifest.get('identity', {}), version='6.8.0', apiVersion=20000,
                             manifestSha256=self.manifest_sha256, librarySha256=_digest(self.library_file))
        self._directories = []
        self._closed = False
        try:
            if os.name == 'nt':
                self._directories.append(os.add_dll_directory(str(self.library_file.parent)))
            self.lib = C.CDLL(str(self.library_file))
            self._bind()
            require(self.lib.xtb_getAPIVersion() == 20000, 'Loaded libxtb API version mismatch', 'PES_LIBXTB_RUNTIME')
            self.loaded_modules = self._loaded_modules()
            self._configure_threads(threads)
        except BaseException:
            self.close()
            raise

    def _bind(self):
        def bind(name, result, arguments):
            function = getattr(self.lib, name)
            function.restype, function.argtypes = result, arguments
        bind('xtb_getAPIVersion', C.c_int, [])
        for name in ('Environment', 'Calculator', 'Results'):
            bind('xtb_new' + name, P, [])
            bind('xtb_del' + name, None, [C.POINTER(P)])
        bind('xtb_delMolecule', None, [C.POINTER(P)])
        bind('xtb_checkEnvironment', C.c_int, [P])
        bind('xtb_getError', None, [P, C.c_char_p, C.POINTER(C.c_int)])
        bind('xtb_setOutput', None, [P, C.c_char_p])
        bind('xtb_releaseOutput', None, [P])
        bind('xtb_setVerbosity', None, [P, C.c_int])
        bind('xtb_newMolecule', P, [P, C.POINTER(C.c_int), P, P, P, P, P, P])
        bind('xtb_updateMolecule', None, [P, P, P, P])
        for method in ('0', '1', '2'):
            bind('xtb_loadGFN' + method + 'xTB', None, [P, P, P, C.c_char_p])
        bind('xtb_loadGFNFF', None, [P, P, P, C.c_char_p])
        bind('xtb_setSolvent', None, [P, P, C.c_char_p, P, P, P, C.c_char_p])
        bind('xtb_setAccuracy', None, [P, P, C.c_double])
        bind('xtb_setElectronicTemp', None, [P, P, C.c_double])
        bind('xtb_setMaxIter', None, [P, P, C.c_int])
        bind('xtb_singlepoint', None, [P, P, P, P])
        bind('xtb_getEnergy', None, [P, P, P])
        bind('xtb_getGradient', None, [P, P, P])

    def _loaded_modules(self):
        if os.name != 'nt':
            modules = {}
            library_relative = getattr(self, 'library_relative', None)
            for relative, entry in self.members.items():
                name = Path(relative).name
                if not (relative == library_relative or name == self.library_file.name
                        or re.fullmatch(r'.+\.(?:dylib|so(?:\.[^/\\]+)*)', name, re.I)):
                    continue
                actual = _member(self.root, relative)
                require(actual.stat().st_size == entry.get('bytes') and _digest(actual) == entry['sha256'],
                        'Loaded libxtb dependency identity mismatch', 'PES_LIBXTB_RUNTIME')
                modules[name] = str(actual.resolve())
            require(self.library_file.name in modules,
                    'Loaded libxtb module was not identified', 'PES_LIBXTB_RUNTIME')
            return modules
        kernel = C.WinDLL('kernel32', use_last_error=True)
        kernel.GetModuleHandleW.argtypes, kernel.GetModuleHandleW.restype = [C.c_wchar_p], P
        kernel.GetModuleFileNameW.argtypes, kernel.GetModuleFileNameW.restype = [P, C.c_wchar_p, C.c_uint32], C.c_uint32
        modules = {}
        for relative, entry in self.members.items():
            name = Path(relative).name
            if Path(name).suffix.lower() != '.dll' or name.lower().startswith(('api-ms-', 'ext-ms-')):
                continue
            handle = self.lib._handle if name.lower() == 'libxtb.dll' else kernel.GetModuleHandleW(name)
            if not handle:
                continue
            buffer = C.create_unicode_buffer(32768)
            require(kernel.GetModuleFileNameW(handle, buffer, len(buffer)) > 0,
                    'Cannot identify a loaded libxtb module', 'PES_LIBXTB_RUNTIME')
            actual = Path(buffer.value)
            require(_digest(actual) == entry['sha256'], 'Loaded libxtb dependency identity mismatch', 'PES_LIBXTB_RUNTIME')
            if name.lower() in ('libxtb.dll', 'libopenblas.dll'):
                require(actual.resolve() == (self.root / relative).resolve(),
                        'The libxtb/BLAS module was loaded from another runtime', 'PES_LIBXTB_RUNTIME')
            modules[name] = str(actual)
        require('libxtb.dll' in modules and 'libopenblas.dll' in modules,
                'Loaded libxtb/BLAS modules were not identified', 'PES_LIBXTB_RUNTIME')
        return modules

    def _configure_threads(self, threads):
        require(type(threads) is int and threads > 0, 'Missing PES thread grant')
        self.thread_settings = {'grantThreads': threads}
        self._thread_controls = []
        if os.name == 'nt':
            targets = (
                (self.loaded_modules.get('libopenblas.dll'), 'openblas_set_num_threads', 'openblas_get_num_threads', 'blasThreads', True),
                (self.loaded_modules.get('libgomp-1.dll'), 'omp_set_num_threads', 'omp_get_max_threads', 'ompThreads', True),
            )
        else:
            blas_file = next((p for name, p in self.loaded_modules.items() if 'libopenblas' in name.lower()), str(self.library_file))
            omp_file = next((p for name, p in self.loaded_modules.items() if 'libomp' in name.lower() or 'libgomp' in name.lower()), str(self.library_file))
            targets = (
                (blas_file, 'openblas_set_num_threads', 'openblas_get_num_threads', 'blasThreads', False),
                (omp_file, 'omp_set_num_threads', 'omp_get_max_threads', 'ompThreads', False),
            )
        for file, symbol, getter, label, required in targets:
            if required:
                require(file is not None, 'libxtb threading runtime was not identified', 'PES_LIBXTB_RUNTIME')
            elif file is None:
                continue
            library = C.CDLL(file)
            function = getattr(library, symbol) if required else getattr(library, symbol, None)
            observe = getattr(library, getter) if required else getattr(library, getter, None)
            if function is None or observe is None:
                continue
            function.argtypes, function.restype = [C.c_int], None
            function(threads)
            observe.argtypes, observe.restype = [], C.c_int
            actual = observe()
            require(0 < actual <= threads, 'libxtb threading exceeds its actual resource grant', 'PES_LIBXTB_RUNTIME')
            self.thread_settings[label] = actual
            self._thread_controls.append((function, observe, label))

    def bind_current_thread(self):
        # libgomp's ICV is local to the calling thread. Even when callers use a
        # serialized helper pool, every actual C invocation keeps this grant.
        for configure, observe, label in self._thread_controls:
            configure(self.thread_settings['grantThreads'])
            actual = observe()
            require(0 < actual <= self.thread_settings['grantThreads'],
                    'libxtb threading exceeds its actual resource grant', 'PES_LIBXTB_RUNTIME')
            self.thread_settings[label] = actual

    def close(self):
        if self._closed:
            return
        self._closed = True
        for handle in self._directories:
            handle.close()
        self._directories.clear()


class _Node:
    def __init__(self, owner, key, positions):
        self.owner, self.key, self.lib = owner, key, owner.api.lib
        self.env = self.mol = self.calc = self.res = None
        self.output_open = False
        self.calls = 0
        self.closed = False
        self.path = owner.log_directory / (hashlib.sha256(json.dumps(key).encode()).hexdigest() + '.log')
        self.numbers = owner.numbers
        # Each calculator parameterizes the same task reference, then updates
        # only its own molecule. Current node coordinates never define a new FF.
        reference = owner.reference_positions if owner.ff_model is not None else positions
        self.positions = np.ascontiguousarray(reference / BOHR_ANGSTROM, dtype=np.float64)
        self.gradient = np.zeros_like(self.positions)
        try:
            self.env = P(self.lib.xtb_newEnvironment())
            require(bool(self.env), 'libxtb could not create an environment', 'PES_LIBXTB_FAILED')
            self._output()
            self.lib.xtb_setVerbosity(self.env, 2)
            count, charge, spin = C.c_int(len(self.numbers)), C.c_double(owner.request['charge']), C.c_int(owner.request['uhf'])
            self.mol = P(self.lib.xtb_newMolecule(self.env, C.byref(count), self.numbers.ctypes.data,
                self.positions.ctypes.data, C.byref(charge), C.byref(spin), None, None))
            self.check()
            self.calc = P(self.lib.xtb_newCalculator())
            self.res = P(self.lib.xtb_newResults())
            require(bool(self.mol) and bool(self.calc) and bool(self.res), 'libxtb native allocation failed', 'PES_LIBXTB_FAILED')
            method = owner.request['method']
            loader = 'xtb_loadGFNFF' if method == 'gfnff' else 'xtb_loadGFN' + method[-1] + 'xTB'
            parameter = owner.api.parameter_files[method]
            getattr(self.lib, loader)(self.env, self.mol, self.calc,
                                     str(parameter).encode('utf-8'))
            self.check()
            solvent = owner.request.get('solvation')
            if solvent:
                self.lib.xtb_setSolvent(self.env, self.calc, solvent['solvent'].encode('ascii'), None, None, None, b'alpb')
                self.check()
            self.lib.xtb_setAccuracy(self.env, self.calc, owner.accuracy)
            if owner.has_scc:
                self.lib.xtb_setElectronicTemp(self.env, self.calc, owner.temperature)
                self.lib.xtb_setMaxIter(self.env, self.calc, owner.scc_limit)
            self.check()
        except BaseException:
            self.close()
            raise
        finally:
            self._release_output()

    def check(self):
        if self.lib.xtb_checkEnvironment(self.env):
            length = C.c_int(16384)
            text = C.create_string_buffer(length.value)
            self.lib.xtb_getError(self.env, text, C.byref(length))
            message = text.value.decode('utf-8', errors='replace')
            code = 'PES_XTB_SCC' if self.owner.has_scc and re.search(r'converg|SCC|SCF', message, re.I) else 'PES_XTB_GEOMETRY' if re.search(r'diagonali|Hamiltonian', message, re.I) else 'PES_LIBXTB_FAILED'
            raise PesError(message or 'libxtb reported an electronic calculation failure', code)

    def _output(self):
        self.path.write_bytes(b'')
        self.lib.xtb_setOutput(self.env, str(self.path).encode('utf-8'))
        self.output_open = True

    def _release_output(self):
        if self.output_open and self.env:
            self.lib.xtb_releaseOutput(self.env)
            self.output_open = False

    def evaluate(self, positions):
        self.owner.ctx.check_cancelled()
        self._output()
        started = time.perf_counter()
        cold = self.calls == 0
        try:
            self.positions[:] = positions / BOHR_ANGSTROM
            self.lib.xtb_updateMolecule(self.env, self.mol, self.positions.ctypes.data, None)
            self.check()
            self.owner.invocations += 1
            self.lib.xtb_singlepoint(self.env, self.mol, self.calc, self.res)
            self.check()
            self.owner.ctx.check_cancelled()
            energy = C.c_double()
            self.lib.xtb_getEnergy(self.env, self.res, C.byref(energy))
            self.lib.xtb_getGradient(self.env, self.res, self.gradient.ctypes.data)
            self.check()
            require(math.isfinite(energy.value) and np.isfinite(self.gradient).all(),
                    'libxtb returned nonfinite energy or gradient', 'PES_EVALUATOR_INVALID')
        finally:
            self._release_output()
        log = self.path.read_text(encoding='utf-8', errors='replace')
        iterations = re.findall(r'convergence criteria satisfied after\s+(\d+) iterations', log)
        if self.owner.has_scc:
            require(bool(iterations), 'libxtb did not confirm electronic convergence', 'PES_XTB_SCC')
        self.calls += 1
        electronic = dict(provider='libxtb', nodeId=self.key[1], coldStart=cold,
                          sccIterations=int(iterations[-1]) if self.owner.has_scc else None,
                          convergenceCriterion='scc-log-and-environment' if self.owner.has_scc else 'environment-and-finite-eg',
                          seconds=time.perf_counter() - started, settingsId=self.owner.settings_id)
        if self.owner.ff_model is not None:
            electronic['ffModelId'] = self.owner.ff_model['modelId']
        return dict(energyHartree=float(energy.value), gradientHartreePerBohr=self.gradient.copy(), electronicState=electronic)

    def close(self):
        if self.closed:
            return
        self.closed = True
        errors = []
        try:
            self._release_output()
        except Exception as error:
            errors.append(str(error))
        for name, field in (('Results', 'res'), ('Calculator', 'calc'), ('Molecule', 'mol'), ('Environment', 'env')):
            pointer = getattr(self, field)
            if pointer:
                try:
                    getattr(self.lib, 'xtb_del' + name)(C.byref(pointer))
                except Exception as error:
                    errors.append(str(error))
                setattr(self, field, None)
        if errors:
            raise PesError('; '.join(errors), 'PES_RESOURCE_CLEANUP')


class LibXtbEvaluator:
    def __init__(self, request, runtime, workspace, *, native):
        from conformer_gfnff import ordinary_directory
        self.request, self.native = copy.deepcopy(request), native
        self.workspace = ordinary_directory(Path(workspace))
        require(request.get('method') in ('gfn0', 'gfn1', 'gfn2', 'gfnff'), 'Unsupported libxtb E/G method')
        self.has_scc = request['method'] in ('gfn1', 'gfn2')
        parameters = request.get('parameters', {})
        self.accuracy = parameters.get('accuracy', .1)
        self.temperature = parameters.get('electronicTemperatureK', 300.) if self.has_scc else None
        self.scc_limit = parameters.get('maxSccIterations', request.get('maxSccIterations', 250)) if self.has_scc else None
        require(type(self.accuracy) in (int, float) and math.isfinite(self.accuracy) and self.accuracy > 0,
                'Electronic accuracy must be positive')
        require(not self.has_scc or type(self.temperature) in (int, float) and math.isfinite(self.temperature) and self.temperature >= 0,
                'Electronic temperature must be nonnegative')
        require(not self.has_scc or type(self.scc_limit) is int and 0 < self.scc_limit <= 2147483647,
                'SCC iteration limit must fit the positive libxtb C-int argument')
        self.ff_model = copy.deepcopy(request.get('ffModel')) if request['method'] == 'gfnff' else None
        self.reference_positions = None
        if request['method'] == 'gfnff':
            model = self.ff_model
            require(isinstance(model, dict) and model.get('schemaVersion') == 1 and model.get('method') == 'gfnff'
                    and isinstance(model.get('modelId'), str) and model['modelId'], 'Missing fixed GFN-FF model', 'PES_FF_MODEL')
            reference = model.get('reference', {})
            atoms = reference.get('atoms', [])
            source = request['structure']['atoms']
            require(model.get('atomOrder') == [atom['id'] for atom in source]
                    and [(a.get('id'), a.get('element')) for a in atoms] == [(a['id'], a['element']) for a in source]
                    and reference.get('charge') == request['charge'] and reference.get('multiplicity') == request['uhf'] + 1
                    and model.get('solvation') == request.get('solvation'),
                    'GFN-FF reference atom order, electronic state or solvent mismatch', 'PES_FF_MODEL')
            self.reference_positions = np.asarray([[a.get(key) for key in ('x', 'y', 'z')] for a in atoms], dtype=float)
            require(self.reference_positions.shape == (len(source), 3) and np.isfinite(self.reference_positions).all(),
                    'Invalid GFN-FF reference geometry', 'PES_FF_MODEL')
        self.api = LibXtbApi(runtime.get('libxtbRoot'), request['threads'], runtime.get('libxtbManifestSha256'))
        self.parameter_identity = dict(provider='libxtb', parameterSource='locked-runtime-file',
            parameterSha256=self.api.parameter_sha256[request['method']],
            librarySha256=self.api.identity.get('librarySha256'), version=self.api.identity['version'],
            apiVersion=self.api.identity.get('apiVersion'))
        if self.ff_model is not None and self.ff_model.get('parameterIdentity') is not None:
            if self.ff_model['parameterIdentity'] != self.parameter_identity:
                self.api.close()
                raise PesError('GFN-FF model parameters differ from the loaded runtime', 'PES_FF_MODEL_RUNTIME')
        self.numbers = np.ascontiguousarray(atom_numbers(request), dtype=np.int32)
        self.settings = dict(runIdentity=request.get('runIdentity'), atomIds=[atom['id'] for atom in request['structure']['atoms']],
                             method=request['method'], charge=request['charge'], uhf=request['uhf'], solvation=request.get('solvation'),
                             accuracy=self.accuracy, electronicTemperatureK=self.temperature, maxSccIterations=self.scc_limit,
                             threads=request['threads'], memoryBudgetBytes=request.get('memoryBudgetBytes'),
                             threading=self.api.thread_settings,
                             engineIdentity=self.api.identity)
        if self.ff_model is not None:
            self.settings['ffModel'] = self.ff_model
        self.settings_id = hashlib.sha256(json.dumps(self.settings, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.log_directory = self.workspace / 'libxtb'
        self.log_directory.mkdir(exist_ok=True)
        ordinary_directory(self.log_directory)
        self.nodes, self.lock = {}, threading.RLock()
        self.closed = False
        self.calls = self.cold_starts = self.warm_starts = self.failures = self.releases = 0
        self.invocations = self.cancelled_calls = self.created_nodes = self.reset_nodes = 0
        self.last = None
        self.last_failure = None

    def bind(self, context):
        self.ctx = context
        self.native.bind(context)

    def __call__(self, positions, *, need_bond_orders=False):
        return self.evaluate_node(positions, node_id=None, need_bond_orders=need_bond_orders)

    def evaluate_node(self, positions, *, node_id=None, need_bond_orders=False):
        with self.lock:
            require(not self.closed, 'libxtb evaluator is closed')
            self.ctx.check_cancelled()
            if need_bond_orders:
                require(self.request['method'] != 'gfnff', 'GFN-FF has no wavefunction bond orders', 'PES_BOND_ORDERS_INVALID')
                # WBO is still the independently validated native provider.
                return self.native(positions, need_bond_orders=True)
            self.api.bind_current_thread()
            key = ('default', None) if node_id is None else ('node', node_id)
            node = self.nodes.get(key)
            try:
                if node is None:
                    node = _Node(self, key, np.asarray(positions, dtype=float))
                    self.nodes[key] = node
                    self.created_nodes += 1
                result = node.evaluate(np.asarray(positions, dtype=float))
                state = result['electronicState']
                self.calls += 1
                self.cold_starts += int(state['coldStart'])
                self.warm_starts += int(not state['coldStart'])
                self.last = dict(state, energyHartree=result['energyHartree'])
                return result
            except BaseException as error:
                if isinstance(error, PesCancelled):
                    self.cancelled_calls += 1
                else:
                    self.failures += 1
                if node is not None:
                    try:
                        if not isinstance(error, PesCancelled):
                            self._retain_failure(node, positions, error)
                    finally:
                        self.nodes.pop(key, None)
                        node.close()
                        self.releases += 1
                        self.reset_nodes += 1
                raise

    def _retain_failure(self, node, positions, error):
        # One latest failure per physical node, not a per-E/G coordinate/log
        # history. Accepted scientific results are owned by the outer workflow.
        evidence = dict(nodeId=node.key[1], settings=self.settings, settingsId=self.settings_id,
                        positionsAngstrom=np.asarray(positions).tolist(), error=str(error),
                        code=getattr(error, 'code', 'PES_LIBXTB_FAILED'))
        self.last_failure = evidence
        target = node.path.with_suffix('.failure.json')
        try:
            target.write_text(json.dumps(evidence, allow_nan=False), encoding='utf-8')
            if node.path.exists():
                node.path.with_suffix('.failure.log').write_bytes(node.path.read_bytes())
        except OSError as storage:
            if isinstance(error, PesError):
                error.diagnostics = dict(error.diagnostics or {}, recoveryWarning=str(storage))

    def release_node(self, node_id):
        with self.lock:
            node = self.nodes.pop(('node', node_id), None)
            if node is not None:
                node.close()
                self.releases += 1
                try:
                    node.path.unlink(missing_ok=True)
                except OSError:
                    pass  # The owned task cache still holds this rebuildable log.

    def physical_hessian(self, positions, step):
        if self.request['method'] in ('gfn0', 'gfnff'):
            return None  # Existing central differences use this same task model.
        return self.native.physical_hessian(positions, step)

    def evidence(self):
        result = dict(engine='libxtb', version='6.8.0', engineIdentity=self.api.identity,
                    loadedModules=self.api.loaded_modules, providerSettings=self.settings, settingsId=self.settings_id,
                    spinTreatment='requested-unpaired-electrons', maxSccIterations=self.scc_limit,
                    accuracy=self.accuracy, electronicTemperatureK=self.temperature,
                    libxtbEvaluations=self.calls, coldStarts=self.cold_starts, warmStarts=self.warm_starts,
                    attemptedLibxtbEvaluations=self.invocations, cancelledElectronicEvaluations=self.cancelled_calls,
                    createdElectronicNodes=self.created_nodes, resetElectronicNodes=self.reset_nodes,
                    activeElectronicNodes=len(self.nodes), releasedElectronicNodes=self.releases,
                    failedElectronicEvaluations=self.failures, lastEvaluation=self.last,
                    lastElectronicFailure=self.last_failure,
                    nativeHessianCalls=self.native.hessian_evaluations,
                    attemptedNativeHessianCalls=self.native.hessian_attempts,
                    solvationEvidence=(dict(model='alpb', solvent=self.request['solvation']['solvent'],
                        sourceField='libxtb:xtb_setSolvent', settingsId=self.settings_id)
                        if self.calls > 0 and self.request.get('solvation') else None),
                    nativeAuxiliaryProvider=self.native.evidence())
        if self.ff_model is not None:
            result['ffModel'] = copy.deepcopy(self.ff_model)
            result['ffModelRuntime'] = dict(initialization='shared-reference-geometry-per-node',
                modelId=self.ff_model['modelId'], parameterSource='locked-runtime-file', engineIdentity=self.api.identity,
                parameterIdentity=self.parameter_identity,
                referenceSha256=hashlib.sha256(json.dumps(self.ff_model['reference'], sort_keys=True,
                    separators=(',', ':')).encode()).hexdigest())
        return result

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            errors = []
            for key, node in list(self.nodes.items()):
                try:
                    node.close()
                    self.releases += 1
                except Exception as error:
                    errors.append(str(error))
                finally:
                    self.nodes.pop(key, None)
            try:
                self.api.close()
            except Exception as error:
                errors.append(str(error))
            if errors:
                raise PesError('; '.join(errors), 'PES_RESOURCE_CLEANUP')
