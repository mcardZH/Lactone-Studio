"""Owned finite-cluster HS route in the existing surface worker and lease.

No periodic cluster generator, upstream QM, unverified mapped function or density
fallback is exposed. One explicit analysis exports its quantitative samples and
both original grids before atomically publishing a complete result.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading

from hirshfeld_analysis import (HirshfeldError, require, finite, validate_cluster_geometry,
                                validate_cluster, admit_native_result, validate_native_cube_pair, native_boundary_faces)
from multiwfn_resources import resolve_resources, _values
from multiwfn_progress import report_progress
from surface_analysis import (NativeSurfaceProcess, SurfaceError, retained_size, read_scalar_cube,
                              NUMBER, number, SETUP_END, MAIN_MENU, BOHR_TO_ANGSTROM)
from wavefunction_analysis import SYMBOLS

HS_POST = '20 Fingerprint plot and local contact analyses'
CONTACT_MENU = '3 Calculate contact area between different elements'
FINGER_POST = '5 Export d_i and d_e of surface points to .txt file in current folder'
CONTEXT_KEYS = ('sourceId', 'sourceRevision', 'jobIndex', 'sourceFrameIndex', 'generation',
                'documentId', 'documentRevision', 'activationEpoch')


def context_of(stamp):
    return {key: stamp[key] for key in CONTEXT_KEYS if key in stamp}


def validate_context(context):
    require(isinstance(context, dict) and set(context) <= set(CONTEXT_KEYS), 'context', 'HS context has unknown fields.')
    require(all(isinstance(context.get(key), str) and 0 < len(context[key]) <= 512 for key in ('sourceId', 'sourceRevision')),
            'context', 'HS context requires an immutable source identity.')
    for key in ('jobIndex', 'sourceFrameIndex'):
        require(key in context and (context[key] is None or type(context[key]) is int and context[key] >= 0), 'context', 'HS frame/job ordinals are invalid.')
    require(type(context.get('generation')) is int and context['generation'] >= 0, 'context', 'HS source generation is invalid.')
    for key in ('documentRevision', 'activationEpoch'):
        require(key not in context or type(context[key]) is int and context[key] >= 0, 'context', 'HS document/activation revision is invalid.')
    require('documentId' not in context or isinstance(context['documentId'], str) and 0 < len(context['documentId']) <= 512,
            'context', 'HS document identity is invalid.')


def effective_settings(settings):
    raw = settings.removeprefix(b'\xef\xbb\xbf')
    result = {}
    for key in ('aug3D', 'atomdenscut', 'ispecial'):
        values = _values(raw, key)
        require(len(values) == 1 and re.fullmatch(NUMBER.encode(), values[0]) is not None,
                'settings', f'The actual effective {key} is ambiguous; settings were not replaced.')
        result[key] = number(values[0].decode('ascii'))
    radii = _values(raw, 'vdwrfile')
    require(len(radii) == 1 and radii[0].lower() == b'none', 'radii',
            'The first HS profile requires the native built-in vdW radius set; configured custom files remain unchanged and need separate provenance support.')
    require(result['aug3D'] > 0 and result['atomdenscut'] in (0, 1, 2, 3, 4) and result['ispecial'] == 0,
            'settings', 'The configured native special mode or density/bounding parameters are outside this HS profile.')
    result['vdwRadii'] = 'native built-in Bondi (vdwrfile=none)'
    return result


def plan_analysis(cluster, spacing, parameters, memory_budget, retained_bytes=0):
    require(finite(spacing) and spacing > 0, 'grid', 'An explicit positive finite spacing in Bohr is required.')
    target = [cluster['atoms'][index - 1]['position'] for index in cluster['targetAtomIndices']]
    spans = [(max(p[axis] for p in target) - min(p[axis] for p in target)) / BOHR_TO_ANGSTROM for axis in range(3)]
    # Conservative budgeting, not a promise of native grid definition. Actual
    # dimensions are checked again from the unmodified exported fields.
    extents = [(span + 2 * parameters['aug3D']) / spacing for span in spans]
    require(all(math.isfinite(value) and value >= 0 for value in extents), 'grid',
            'Requested HS geometry/spacing exceeds finite numeric representation.')
    dimensions = [math.ceil(value) + 2 for value in extents]
    points = math.prod(dimensions)
    estimate = points * 128 + len(cluster['atoms']) * 4096 + retained_bytes
    require(points * 8 <= 2**53-1, 'grid', 'Requested HS grid byte count exceeds exact transport integer representation.')
    require(type(memory_budget) is int and memory_budget > 0, 'budget', 'A current positive native memory grant is required.')
    return dict(estimatedDimensions=dimensions, estimatedPoints=points, estimatedBytes=estimate)


class _ObservedQueue(queue.Queue):
    def __init__(self):
        super().__init__(); self.reader_eof = threading.Event()

    def put(self, item, *args, **kwargs):
        if item is None:
            self.reader_eof.set()
        return super().put(item, *args, **kwargs)


class _HirshfeldNativeProcess(NativeSurfaceProcess):
    def stop(self):
        if self.process is not None:
            self.hirshfeld_process = self.process
        return super().stop()


class HirshfeldAnalysisSession:
    family = 'hirshfeld'

    def __init__(self, request):
        self.session_id = request['sessionId']
        require(isinstance(self.session_id, str) and 0 < len(self.session_id) <= 200, 'session', 'HS session identity is invalid.')
        source = request['source']
        require(isinstance(source, dict) and set(source) <= {'kind', 'cluster', 'context'} and source.get('kind') == 'hirshfeld-cluster',
                'source', 'HS accepts an immutable explicit finite-cluster snapshot only.')
        self.context = copy.deepcopy(source['context']); validate_context(self.context)
        self.cluster = validate_cluster_geometry(source['cluster'])
        require(not any(key in self.cluster for key in ('targetAtomIndices', 'environmentAtomIndices')), 'source',
                'Target/environment selection belongs to an explicit analysis request, not the immutable cluster source.')
        require((self.cluster['sourceId'], self.cluster['sourceRevision']) == (self.context['sourceId'], self.context['sourceRevision']),
                'source', 'HS cluster and context source identities disagree.')
        require(all(atom['element'] in SYMBOLS[1:] for atom in self.cluster['atoms']), 'source', 'HS source atoms require supported chemical elements.')
        self.executable = Path(request['executable']).resolve()
        grant = request.get('resources') or {}
        self.resources, self.settings = resolve_resources(self.executable, grant.get('threads'), grant.get('memoryBudgetBytes'))
        self.open_settings_revision = self.resources['settingsRevision']
        require(grant.get('settingsRevision', self.open_settings_revision) == self.open_settings_revision,
                'resource-changed', 'Multiwfn settings changed after planning the HS session.')
        self.parameters = effective_settings(self.settings)
        self.root = Path(request['workspacePath']).resolve(); self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock(); self.cancelled = threading.Event(); self.closed = False; self.epoch = 0
        self.native = None; self.progress_callback = None; self.backend = None
        self.generations = {}; self.fields = {}; self.native_history = []; self.work_count = 0

    def capabilities(self):
        return dict(sessionId=self.session_id, family=self.family, context=copy.deepcopy(self.context), atomCount=len(self.cluster['atoms']),
                    capabilities=[dict(function='hirshfeld', finiteCluster=True, cifNeighbourhood=False, mapping='dnorm', nativeArea=True)],
                    resources=copy.deepcopy(self.resources), retainedMemoryBytes=self.retained_memory_bytes(),
                    planning=dict(extensionBohr=self.parameters['aug3D'], estimated=True))

    def retained_memory_bytes(self):
        return retained_size([self.cluster, self.context, self.resources, self.generations, self.fields, self.native_history])

    def _current(self):
        require(not self.closed and not self.cancelled.is_set(), 'cancelled', 'HS operation was cancelled or its source session closed.')

    def _check_stamp(self, stamp):
        self._current()
        require(isinstance(stamp, dict) and set(stamp) <= set(CONTEXT_KEYS) | {'requestId', 'analysisId'}
                and context_of(stamp) == self.context and all(isinstance(stamp.get(key), str) and 0 < len(stamp[key]) <= 256
                                                            for key in ('requestId', 'analysisId')),
                'stamp', 'HS request source/frame/document or analysis identity differs from its owned session.')

    def apply_resources(self, grant):
        require(isinstance(grant, dict) and all(type(grant.get(key)) is int and grant[key] > 0 for key in ('threads', 'memoryBudgetBytes')),
                'resources', 'A current explicit shared Multiwfn resource grant is required.')
        resources, settings = resolve_resources(self.executable, grant['threads'], grant['memoryBudgetBytes'])
        require(resources['settingsRevision'] == self.open_settings_revision
                and grant.get('settingsRevision', self.open_settings_revision) == self.open_settings_revision,
                'resource-changed', 'Multiwfn settings changed after opening; no HS process was started.')
        for key in ('sharedReservedBytes', 'configuredMemoryBudgetBytes'):
            if key in grant:
                require(type(grant[key]) is int and grant[key] >= 0, 'resources', 'Shared HS resource accounting is invalid.')
                resources[key] = grant[key]
        self.parameters = effective_settings(settings); self.resources, self.settings = resources, settings

    def _spawn(self):
        self._current(); self.stop_native()
        self.work_count += 1
        work = Path(tempfile.mkdtemp(prefix='hirshfeld-', dir=self.root)); source = work / 'source.xyz'
        require(len(str(source)) < 240, 'path', 'The owned HS workspace path exceeds this native profile.')
        rows = [str(len(self.cluster['atoms'])), 'Ester Studio immutable complete finite cluster; native Hirshfeld weight, no quantum wavefunction']
        rows.extend(atom['element'] + ' ' + ' '.join(format(value, '.17g') for value in atom['position']) for atom in self.cluster['atoms'])
        source.write_text('\n'.join(rows) + '\n', encoding='ascii')
        native = _HirshfeldNativeProcess(self.executable, source, work, self.resources, self.settings, self.progress_callback)
        native.queue = _ObservedQueue(); native.hirshfeld_cleanup_lock = threading.Lock()
        with self.lock:
            self._current(); self.native = native
        try:
            native.start(); self.backend = copy.deepcopy(native.backend); return native
        except Exception:
            self._stop_owned(native); raise

    def _stop_owned(self, native):
        with native.hirshfeld_cleanup_lock:
            if getattr(native, 'hirshfeld_recorded', False):
                return
            process = getattr(native, 'hirshfeld_process', native.process)
            native.hirshfeld_process = process; native.stop()
            if process is not None:
                require(process.poll() is not None, 'cleanup', 'HS process has not settled; source and artifacts remain protected.')
                require(native.queue.reader_eof.wait(5), 'cleanup', 'HS process ended but the owned output reader has not settled.')
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()
            with self.lock:
                if self.native is native:
                    self.native = None
                self.native_history.append(dict(pid=process.pid if process else None, exitCode=process.poll() if process else None,
                                                workName=native.work.name, settled=True))
                native.hirshfeld_recorded = True

    def _route(self, native, selection, spacing):
        native.send(['12']); native.wait(SETUP_END, 30)
        native.send(['1']); native.wait('10 Isosurface of a grid data loaded from external file', 30)
        native.send(['5']); native.wait('Input atomic indices.', 30)
        native.send([','.join(map(str, sorted(selection['targetAtomIndices'])))]); native.wait(SETUP_END, 30)
        native.send(['2']); native.wait('22 d_norm:', 30)
        native.send(['22']); setup = native.wait(SETUP_END, 30)
        native.send(['3']); native.wait('Input a value (in Bohr)', 30)
        native.send([format(spacing, '.17g')]); setup += native.wait(SETUP_END, 30)
        require('Hirshfeld surface' in setup and 'current: d_norm' in setup, 'definition', 'Native HS/dnorm setup was not confirmed.')
        native.send(['0']); output = setup + native.wait(HS_POST, 120)
        require('Surface analysis finished!' in output, 'incomplete', 'The native HS analysis did not complete.')
        for answer in ('8', '-2', '13'):
            self._current(); native.send([answer]); native.wait(HS_POST, 120 if answer == '13' else 30)
        native.send(['20']); native.wait(CONTACT_MENU, 30)
        native.send(['3']); output += native.wait(CONTACT_MENU, 30)
        native.send(['0']); output += native.wait(FINGER_POST, 120)
        native.send(['5']); native.wait(FINGER_POST, 30)
        for marker in (CONTACT_MENU, HS_POST, SETUP_END, MAIN_MENU):
            native.send(['-1']); native.wait(marker, 30)
        native.send(['q'])
        self._current()
        # This wait is inside the existing host request deadline; it neither
        # creates another operation nor resets the host timer. Cancellation
        # still calls stop_native immediately from its own control thread and
        # the process exit wakes this wait. Only normal q gets this short grace.
        process = native.process
        if process is not None:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass  # The existing owned stop/settled path is the fallback.
        self._current()
        return output

    def _field(self, cube, role, stamp, domain):
        field_id = 'hirshfeld:' + hashlib.sha256(json.dumps([stamp['analysisId'], stamp['requestId'], role]).encode()).hexdigest()
        name = 'surf.cub' if role == 'shape' else 'mapfunc.cub'
        return dict(id=field_id, context=copy.deepcopy(self.context), source=dict(id=field_id, name=name, revision=cube['revision'], kind='generated-cube', producer='multiwfn', comments=cube['comments']),
                    function='hirshfeld-weight' if role == 'shape' else 'dnorm', functionLabel='Hirshfeld weight' if role == 'shape' else 'd_norm', valueUnit='dimensionless',
                    definitionEvidence=dict(kind='native-output', description='Same native main-12 Hirshfeld-weight 0.5 surface, explicitly selected d_norm, and original post-menu -2/13 Cube roles.'),
                    grid=copy.deepcopy(cube['grid']), atoms=copy.deepcopy(cube['atoms']), precision=copy.deepcopy(cube['precision']), validDomain=copy.deepcopy(domain),
                    valuesBase64=base64.b64encode(cube['values'].astype('<f8', copy=False).tobytes()).decode('ascii'))

    def analyze(self, request):
        self._check_stamp(request.get('stamp'))
        require(set(request) in ({'stamp', 'targetAtomIndices', 'environmentAtomIndices', 'quantitativeGrid', 'mapping'},
                                {'stamp', 'targetAtomIndices', 'environmentAtomIndices', 'quantitativeGrid', 'mapping', 'mode'})
                and request.get('mode', 'closed') in ('closed', 'open-preview') and request['mapping'] == 'dnorm',
                'request', 'HS analysis requires an explicit selection, spacing and dnorm mapping only.')
        mode = request.get('mode', 'closed'); open_preview = mode == 'open-preview'
        grid = request['quantitativeGrid']
        require(isinstance(grid, dict) and set(grid) == {'mode', 'spacingBohr'} and grid['mode'] == 'spacing',
                'grid', 'HS analysis requires explicit Bohr spacing; no native default or display-quality substitution is implicit.')
        selected = validate_cluster({**self.cluster, 'targetAtomIndices': request['targetAtomIndices'], 'environmentAtomIndices': request['environmentAtomIndices']})
        key = request['stamp']['requestId']; epoch = self.epoch
        require(key not in self.generations, 'generation', 'A completed HS generation cannot be replaced by the same request identity.')
        plan = plan_analysis(selected, grid['spacingBohr'], self.parameters, self.resources['memoryBudgetBytes'], self.retained_memory_bytes())
        native = self._spawn()
        try:
            output = self._route(native, selected, grid['spacingBohr'])
            self._stop_owned(native); self._current()
            report_progress(self.progress_callback, 'parse', stageId='hirshfeld-native-data')
            paths = {name: native.work / name for name in ('vtx.pqr', 'di_de_all.txt', 'surf.cub', 'mapfunc.cub')}
            require(all(paths[name].is_file() and not paths[name].is_symlink() for name in (('surf.cub', 'mapfunc.cub') if open_preview else paths)), 'artifacts', 'One or more complete native HS artifacts were not exported.')
            dataset = admit_native_result(selected, output, paths['vtx.pqr'].read_text(encoding='utf-8') if paths['vtx.pqr'].is_file() and not paths['vtx.pqr'].is_symlink() else '',
                                         paths['di_de_all.txt'].read_text(encoding='utf-8') if paths['di_de_all.txt'].is_file() and not paths['di_de_all.txt'].is_symlink() else '',
                                         self.resources['memoryBudgetBytes'], self._current, open_preview=open_preview)
            shape = read_scalar_cube(paths['surf.cub'], self.resources['memoryBudgetBytes'])
            mapping = read_scalar_cube(paths['mapfunc.cub'], self.resources['memoryBudgetBytes'])
            domain = validate_native_cube_pair(shape, mapping, selected, SYMBOLS, None if open_preview else dataset['vertices'], open_preview=open_preview)
            if open_preview and dataset['vertices']:
                try:
                    validate_native_cube_pair(shape, mapping, selected, SYMBOLS, dataset['vertices'], open_preview=True)
                except HirshfeldError as error:
                    if getattr(error, 'code', '') != 'hirshfeld-cube-vertices':
                        raise
                    dataset['vertices'] = []
                    dataset['fingerprint'].update(samplesAvailable=False, sampleDiagnostic=str(error))
            boundary_faces = native_boundary_faces(shape)
            fields = {role: self._field(cube, role, request['stamp'], domain) for role, cube in (('shape', shape), ('mapping', mapping))}
            raw_artifacts = []
            for name, role in [('source.xyz', 'cluster-source'), ('settings.ini', 'effective-settings'), ('native-output.txt', 'native-output'),
                               ('menu-input.txt', 'native-menu'), ('vtx.pqr', 'surface-vertices'), ('di_de_all.txt', 'fingerprint-distances'),
                               ('surf.cub', 'hirshfeld-weight-cube'), ('mapfunc.cub', 'dnorm-cube')]:
                path = native.work / name
                if open_preview and role in ('surface-vertices', 'fingerprint-distances') and not path.is_file():
                    continue
                require(path.is_file() and not path.is_symlink(), 'artifacts', 'A required native provenance artifact is absent.')
                raw_artifacts.append(dict(role=role, name=name, revision=hashlib.sha256(path.read_bytes()).hexdigest()))
            # Dataset's quantitative points and the display pair share one native
            # run but do not claim the same triangulation or vertex indices.
            dataset['surface'] = dict(available=True, representation='native-weight-grid', sampleRelationship=('Current-box native samples, when admitted, are distinct from display vertices; no complete-surface denominator is provided.' if open_preview else 'Native quantitative vertices and display mesh vertices are distinct samplings of the same weight-0.5 surface; contact-area denominator is native and immutable.'))
            dataset['definition']['vdwRadii'] = self.parameters['vdwRadii']
            result = dict(**dataset, mode=mode, stamp=copy.deepcopy(request['stamp']), quantitativeGrid=copy.deepcopy(grid),
                          pair=dict(kind='hirshfeld', definition='hirshfeld-weight', isovalue=.5, inside='above', topology='open' if boundary_faces else 'closed', boundaryFaces=boundary_faces, shape=fields['shape'], mapping=fields['mapping']),
                          provenance=dict(backend=dict(name='Multiwfn', version=self.backend['version']), sourceIds=[self.context['sourceId']],
                                          parameters=dict(mode=mode, mapping='dnorm', definition='hirshfeld-weight', isovalue=.5, spacingBohr=grid['spacingBohr'], threads=self.resources['threads'],
                                                          memoryBudgetBytes=self.resources['memoryBudgetBytes'], settingsRevision=self.open_settings_revision,
                                                          targetAtomIndices=selected['targetAtomIndices'], environmentAtomIndices=selected['environmentAtomIndices'], **self.parameters),
                                          rawArtifacts=raw_artifacts, notices=[]), plan=plan)
            saved = copy.deepcopy({key_: value for key_, value in result.items() if key_ != 'pair'})
            saved['fieldIds'] = {role: value['id'] for role, value in fields.items()}
            additions = {field['id']: dict(path=str(paths['surf.cub' if role == 'shape' else 'mapfunc.cub']), revision=field['source']['revision'],
                                          analysisId=request['stamp']['analysisId'], descriptor={k: copy.deepcopy(v) for k, v in field.items() if k != 'valuesBase64'})
                         for role, field in fields.items()}
            with self.lock:
                self._current(); require(self.epoch == epoch, 'cancelled', 'A late HS result belongs to an obsolete operation.')
                self.generations[key] = saved; self.fields.update(additions)
            return result
        except Exception as error:
            # Persist a small structured diagnostic beside the unchanged native
            # evidence before the host closes this owned workspace.
            (native.work / 'hirshfeld-diagnostic.json').write_text(json.dumps(dict(mode=mode, error=str(error),
                code=getattr(error, 'code', None), selection=selected, quantitativeGrid=grid), ensure_ascii=False), encoding='utf-8')
            raise
        finally:
            self._stop_owned(native)

    def _restore_pair(self, saved, analysis_id):
        fields = {}; cubes = {}
        for role, field_id in saved['fieldIds'].items():
            item = self.fields[field_id]
            require(item['analysisId'] == analysis_id, 'field', 'HS field belongs to another analysis.')
            path = Path(item['path'])
            require(path.is_file() and not path.is_symlink(), 'field-changed', 'Completed HS field is missing or replaced.')
            cubes[role] = read_scalar_cube(path, self.resources['memoryBudgetBytes'])
            require(cubes[role]['revision'] == item['revision'], 'field-changed', 'Completed HS Cube bytes changed.')
            fields[role] = copy.deepcopy(item['descriptor'])
            fields[role]['valuesBase64'] = base64.b64encode(cubes[role]['values'].astype('<f8', copy=False).tobytes()).decode('ascii')
        validate_native_cube_pair(cubes['shape'], cubes['mapping'], saved['source'], SYMBOLS, saved['vertices'], open_preview=saved.get('mode') == 'open-preview')
        faces = native_boundary_faces(cubes['shape'])
        return dict(kind='hirshfeld', definition='hirshfeld-weight', isovalue=.5, inside='above',
                    topology='open' if faces else 'closed', boundaryFaces=faces, **fields)

    def restore(self, request):
        self._check_stamp(request.get('stamp'))
        require(set(request) == {'stamp', 'generationId'}, 'request', 'HS restore reads an explicit completed generation only.')
        saved = self.generations.get(request.get('generationId'))
        require(saved is not None and saved['stamp']['analysisId'] == request['stamp']['analysisId'], 'generation', 'The requested HS generation is not a completed result owned by this analysis.')
        points = sum(math.prod(self.fields[id_]['descriptor']['grid']['dimensions']) for id_ in saved['fieldIds'].values())
        pair = self._restore_pair(saved, request['stamp']['analysisId'])
        result = copy.deepcopy({key: value for key, value in saved.items() if key != 'fieldIds'})
        result.update(stamp=copy.deepcopy(request['stamp']), pair=pair)
        self._current(); return result

    def export_cube(self, request):
        self._check_stamp(request.get('stamp'))
        require(set(request) == {'stamp', 'fieldId'}, 'request', 'HS export reads one existing owned original Cube only.')
        item = self.fields.get(request.get('fieldId'))
        require(item is not None and item['analysisId'] == request['stamp']['analysisId'], 'field', 'HS Cube is absent or belongs to another analysis.')
        path = Path(item['path'])
        require(path.is_file() and not path.is_symlink(), 'field-changed', 'The original owned HS Cube is absent or was replaced.')
        raw = path.read_bytes(); require(hashlib.sha256(raw).hexdigest() == item['revision'], 'field-changed', 'HS Cube bytes changed before export.')
        self._current(); return dict(name=path.name, text=raw.decode('utf-8'))

    def evidence(self):
        native = self.native; process = native.process if native else None
        return dict(sessionId=self.session_id, family=self.family, context=copy.deepcopy(self.context), resources=copy.deepcopy(self.resources), backend=copy.deepcopy(self.backend),
                    nativeHistory=copy.deepcopy(self.native_history), activeNativeCount=int(process is not None and process.poll() is None),
                    retainedMemoryBytes=self.retained_memory_bytes(), artifacts=[dict(path=str(path), name=path.name, bytes=path.stat().st_size)
                    for work in self.root.iterdir() if work.is_dir() and not work.is_symlink() for path in work.iterdir() if path.is_file() and not path.is_symlink()])

    def stop_native(self):
        with self.lock:
            native = self.native
        if native is not None:
            self._stop_owned(native)

    def cancel(self):
        with self.lock:
            self.epoch += 1; self.cancelled.set()
        self.stop_native()

    def close(self):
        with self.lock:
            self.closed = True
        self.cancel()
