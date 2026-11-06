"""Owned main-20 native adapter. No upstream QM, cropped WF or silent approximation."""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
from pathlib import Path
import queue
import re
import shutil
import tempfile
import threading
import time

import numpy as np
from multiwfn_progress import report_progress
from multiwfn_resources import resolve_resources, _values
from orbitals import inspect_wavefunction
from surface_analysis import (SurfaceError, NativeSurfaceProcess, read_scalar_cube,
                              require_cube_pair, retained_size, number, half_last_digit, NUMBER, MAIN_MENU, BOHR_TO_ANGSTROM, target_grid_dimensions)

METHODS = {'iri': '4', 'rdg': '1', 'igmh': '11', 'migm': '-10', 'igm': '10'}
FUNCTIONS = {'iri': 'iri', 'rdg': 'rdg', 'inter': 'delta-g-inter', 'intra': 'delta-g-intra', 'total': 'delta-g'}
WEAK_END = '-12 amIGM:'
GRID_END = '11 Select a set of atoms'
POST_GLOBAL = '8 Output sign(lambda2)rho'
POST_FRAGMENT = '8 Set delta-g_inter'
SYMBOLS = ('X H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr '
           'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu '
           'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split()


class InteractionError(SurfaceError):
    pass


class _ObservedOutputQueue(queue.Queue):
    """Observe existing reader EOF, without replacing its byte/protocol reader."""
    def __init__(self):
        super().__init__(); self.reader_eof = threading.Event()

    def put(self, item, *args, **kwargs):
        if item is None:
            self.reader_eof.set()
        return super().put(item, *args, **kwargs)


class _InteractionNativeProcess(NativeSurfaceProcess):
    def stop(self):
        # The existing start() may itself stop on a backend/thread mismatch.
        # Retain the original handle owner for pipe cleanup even in that branch.
        if self.process is not None:
            self.interaction_process = self.process
        return super().stop()


def reject(code, message):
    raise InteractionError('interaction-' + code, message)


def bounded_id(value):
    return isinstance(value, str) and 0 < len(value) <= 200 and not any(ord(c) < 32 for c in value)


def context_of(stamp):
    return {key: value for key, value in stamp.items() if key not in ('requestId', 'analysisId')}


def validate_context(context):
    if not isinstance(context, dict) or not all(bounded_id(context.get(k)) for k in ('sourceId', 'sourceRevision')):
        reject('context', 'A precise immutable source context is required.')
    if type(context.get('generation')) is not int or context['generation'] < 0:
        reject('context', 'Context generation must be a nonnegative integer.')
    for key in ('jobIndex', 'sourceFrameIndex'):
        if key not in context or context[key] is not None and (type(context[key]) is not int or context[key] < 0):
            reject('context', 'Source job/frame indices must be explicit null or nonnegative integers.')
    allowed = {'sourceId', 'sourceRevision', 'jobIndex', 'sourceFrameIndex', 'generation', 'documentId', 'documentRevision', 'activationEpoch'}
    if set(context) - allowed or 'documentId' in context and not bounded_id(context['documentId']):
        reject('context', 'Source context contains unknown or invalid document identity fields.')
    for key in ('documentRevision', 'activationEpoch'):
        if key in context and (type(context[key]) is not int or context[key] < 0):
            reject('context', 'Document revision/activation epoch must be nonnegative integers.')


def validate_fragments(method, fragments, atom_count):
    if method not in METHODS:
        reject('method', 'Only the approved main-20 methods are supported.')
    if not isinstance(fragments, list):
        reject('fragments', 'Fragments must be an explicit list.')
    if method in ('iri', 'rdg'):
        if fragments:
            reject('fragments', 'Global IRI/RDG does not accept fragment definitions.')
        return []
    if not 1 <= len(fragments) <= atom_count:
        reject('fragments', 'Define at least one nonempty disjoint fragment.')
    seen, ids = set(), set()
    result = []
    for fragment in fragments:
        if not isinstance(fragment, dict) or not bounded_id(fragment.get('id')) or fragment['id'] in ids or not bounded_id(fragment.get('label')):
            reject('fragments', 'Fragment identities/labels must be bounded and unique.')
        indices = fragment.get('atomIndices')
        if not isinstance(indices, list) or not indices or any(type(i) is not int or not 1 <= i <= atom_count for i in indices):
            reject('fragments', 'Fragment atom indices must be one-based explicit source ordinals.')
        if len(set(indices)) != len(indices) or seen.intersection(indices):
            reject('fragments', 'Fragments cannot contain duplicates or share source atoms.')
        seen.update(indices); ids.add(fragment['id'])
        result.append(dict(id=fragment['id'], label=fragment['label'], atomIndices=list(indices)))
    return result


def grid_answers(quality):
    if not isinstance(quality, dict):
        reject('grid', 'An explicit native grid quality is required.')
    mode = quality.get('mode')
    if mode == 'target-points' and set(quality) == {'mode', 'targetPoints'} and quality.get('targetPoints') in (32768, 4096000):
        return ['target-points', str(quality['targetPoints'])]
    if mode in ('low', 'medium', 'high') and set(quality) == {'mode'}:
        return [{'low': '1', 'medium': '2', 'high': '3'}[mode]]
    spacing = quality.get('spacingBohr')
    if mode == 'spacing' and set(quality) == {'mode', 'spacingBohr'} and type(spacing) in (int, float) and math.isfinite(spacing) and spacing > 0:
        return ['4', np.format_float_positional(float(spacing), unique=True, trim='k')]
    dimensions = quality.get('dimensions')
    if mode == 'dimensions' and set(quality) == {'mode', 'dimensions'} and isinstance(dimensions, list) and len(dimensions) == 3 and all(type(value) is int and value >= 2 for value in dimensions):
        return ['4', ','.join(map(str, dimensions))]
    reject('grid', 'Use native low/medium/high, a finite positive Bohr spacing or bounded explicit XYZ point counts; no quality was substituted.')


def effective_parameters(settings):
    """No guessed effective defaults: unknown/duplicate settings fail before spawn."""
    result = {}
    for key in ('RDG_maxrho', 'IRI_rhocut', 'IGMvdwscl', 'uservar', 'atomdenscut', 'expcutoff', 'ispecial', 'igenP'):
        values = _values(settings.removeprefix(b'\xef\xbb\xbf'), key)
        if len(values) != 1 or re.fullmatch(NUMBER.encode(), values[0]) is None:
            reject('settings', f'Cannot establish the actual effective {key}; settings were not changed.')
        result[key] = number(values[0].decode('ascii'))
    if result['RDG_maxrho'] < 0 or result['IRI_rhocut'] < 0:
        reject('settings', 'Density cutoffs must be nonnegative.')
    if result['IGMvdwscl'] < 0:
        reject('domain', 'Unknown negative IGMvdwscl overlap-domain setting.')
    if result['atomdenscut'] not in (0, 1, 2, 3, 4):
        reject('settings', 'Unknown promolecular atom-density cutoff profile.')
    if result['ispecial'] != 0 or result['igenP'] != 1:
        reject('settings', 'Special native modes or disabled density-matrix generation are outside this verified profile; settings were not changed.')
    result['IRI_exponent'] = result['uservar'] or 1.1
    return result


def scalar_rounding_interval(values):
    """Native main-20 Cube has six significant decimal digits, not exact density."""
    absolute = np.abs(values)
    error = np.zeros_like(absolute)
    nonzero = absolute > 0
    error[nonzero] = .5 * np.power(10., np.floor(np.log10(absolute[nonzero])) - 5)
    return error


def density_domain(method, signed_density, parameters, intervals=None):
    key = 'IRI_rhocut' if method == 'iri' else 'RDG_maxrho'
    threshold = parameters[key]
    if threshold == 0:
        return dict(kind='full-grid', evidence=f'Native {key}=0 disables density shielding; every requested node is evaluated.')
    rho = np.abs(signed_density); error = scalar_rounding_interval(signed_density) if intervals is None else intervals
    # By the native definition sign(lambda2)*rho, a NONZERO signed value has
    # magnitude rho. Zero/threshold-print-boundary nodes cannot establish rho
    # eligibility and are conservatively excluded, never inferred from fills.
    mask = ((rho - error > threshold) if method == 'iri' else (rho + error < threshold)) & (rho > 0)
    return dict(kind='node-mask', maskBase64=base64.b64encode(mask.astype(np.uint8).tobytes()).decode('ascii'),
                evidence=f'Native {key}={threshold}; abs(nonzero sign(lambda2)rho)=rho by native function definition. '
                         'Original Cube decimal-print intervals wholly outside the shielding predicate are admitted; '
                         'zero signed-density/threshold-overlap nodes are excluded. Mask is not inferred from method sentinels or zero fill.')


def parse_integrals(output):
    found = re.findall(r'Integral of (delta-g(?:_inter|_intra)?) over whole space:\s*(' + NUMBER + r')\s+a\.u\.', output)
    if len(found) != 3 or {name for name, _ in found} != {'delta-g', 'delta-g_inter', 'delta-g_intra'}:
        reject('integrals', 'Native main-20 integral records are absent or ambiguous.')
    names = {'delta-g': 'total', 'delta-g_inter': 'inter', 'delta-g_intra': 'intra'}
    return [dict(component=names[name], value=number(raw), rawValue=raw, unit='a.u.') for name, raw in found]


def parse_contributions(text, fragments, pair, elements):
    selected = [next(f for f in fragments if f['id'] == i) for i in pair]
    positions = [fragments.index(f) + 1 for f in selected]
    blocks = re.split(r'Atomic delta-g indices of fragment\s+(\d+) and percentage contributions', text)
    if len(blocks) != 5:
        reject('contribution', 'Expected exactly two selected native fragment atom blocks.')
    atoms = []
    for offset, fragment in zip((1, 3), selected):
        if int(blocks[offset]) != fragments.index(fragment) + 1:
            reject('contribution', 'Native contribution fragment selection differs from the requested pair.')
        section = blocks[offset + 1].split('Atomic pair delta-g')[0]
        percent_token = r'(?:' + NUMBER + r'|NaN|[+-]?Infinity|\*+)'
        rows = re.findall(r'Atom\s+(\d+)\s*:\s*(' + NUMBER + r')\s*\(\s*(' + percent_token + r')\s*%\s*\)', section, re.I)
        indices = [int(row[0]) for row in rows]
        if len(indices) != len(set(indices)) or set(indices) != set(fragment['atomIndices']):
            reject('contribution', 'Native atomic contribution inventory differs from the selected fragment.')
        atoms.extend(dict(sourceIndex=int(i), element=elements[int(i) - 1], fragmentId=fragment['id'], value=number(v), percent=_percent(p)) for i, v, p in rows)
    tail = text.split('Atomic pair delta-g indices and percentage contributions')
    if len(tail) != 2:
        reject('contribution', 'Native atomic pair contribution block is absent or duplicated.')
    rows = re.findall(r'^\s*(\d+)\s+(\d+)\s*:\s*(' + NUMBER + r')\s*\(\s*(' + percent_token + r')\s*%\s*\)', tail[1], re.M | re.I)
    pairs = [dict(sourceIndex1=int(i), sourceIndex2=int(j), value=number(v), percent=_percent(p)) for i, j, v, p in rows]
    seen = set()
    for row in pairs:
        indices = (row['sourceIndex1'], row['sourceIndex2'])
        if indices in seen or indices[0] not in selected[0]['atomIndices'] or indices[1] not in selected[1]['atomIndices']:
            reject('contribution', 'Native atomic pair inventory is duplicated or outside the requested pair.')
        seen.add(indices)
    totals = re.findall(r'Sum of all atomic pair delta-g indices:\s*(' + NUMBER + ')', text)
    if len(totals) != 1:
        reject('contribution', 'Native pair-sum denominator is missing or ambiguous.')
    total = number(totals[0])
    if total < 0 or any(row['value'] < 0 or row['percent'] is not None and not 0 <= row['percent'] <= 100 for row in atoms + pairs):
        reject('contribution', 'Native contribution values violate their nonnegative/percentage definition.')
    # Native indices are printed to six decimals and percentages to two.
    if abs(sum(row['value'] for row in pairs) - total) > (len(pairs) + 1) * .5001e-6:
        reject('contribution', 'Printed pair values disagree with their native sum beyond print precision.')
    if total > 0:
        for row in atoms + pairs:
            tolerance = .0051 + 100 * .5001e-6 * (1 + row['value'] / total) / total
            if row['percent'] is not None and abs(row['percent'] - 100 * row['value'] / total) > tolerance:
                reject('contribution', 'Native contribution percentage does not use the selected-pair denominator.')
    return atoms, pairs, total


def _percent(raw):
    return None if re.fullmatch(r'(?:NaN|[+-]?Infinity|\*+)', raw, re.I) else number(raw)


class InteractionAnalysisSession:
    def __init__(self, request):
        self.session_id = request['sessionId']; self.source = copy.deepcopy(request['source'])
        self.context = copy.deepcopy(self.source['context']); validate_context(self.context)
        if not bounded_id(self.session_id):
            reject('session', 'A bounded session identity is required.')
        self.executable = Path(request['executable']).resolve()
        self.resources, self.settings = resolve_resources(self.executable, **self._resource_args(request.get('resources', {})))
        self.open_settings_revision = self.resources['settingsRevision']
        if request.get('resources', {}).get('settingsRevision', self.open_settings_revision) != self.open_settings_revision:
            reject('resource-changed', 'The configured settings changed after planning.')
        self.parameters = effective_parameters(self.settings)
        self.root = Path(request['workspacePath']).resolve(); self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock(); self.cancelled = threading.Event(); self.closed = False; self.epoch = 0
        self.native = None; self.progress_callback = None; self.backend = dict(name='Multiwfn', version='not-started')
        self.fields = {}; self.generations = {}; self.work_count = 0; self.native_history = []; self.source_stat = None
        if self.source.get('kind') == 'wavefunction':
            self.source_path = Path(self.source['sourcePath']).resolve()
            self.metadata = inspect_wavefunction(self.source_path)
            # The physical WF id can differ from its paired OUT logical owner; all content revisions must still agree.
            if not bounded_id(self.source.get('sourceId')) or self.source.get('sourceRevision') != self.context['sourceRevision'] or self.metadata['sourceSha256'] != self.source.get('sourceRevision'):
                reject('source-changed', 'Wavefunction content identity and source context disagree.')
            stat = self.source_path.stat(); self.source_stat = (stat.st_size, stat.st_mtime_ns)
            self.atoms = self.metadata['atoms']
            if any(not 1 <= a['atomicNumber'] < len(SYMBOLS) for a in self.atoms):
                reject('elements', 'Wavefunction centers must map to explicit supported chemical elements.')
            self.elements = [SYMBOLS[a['atomicNumber']] for a in self.atoms]
        elif self.source.get('kind') == 'structure':
            structure = self.source.get('structure', {})
            if structure.get('cell') is not None or structure.get('periodicSource') is not None:
                reject('periodic', 'Periodic interaction input is outside this verified molecular route.')
            atoms = structure.get('atoms')
            if not isinstance(atoms, list) or not 1 <= len(atoms):
                reject('structure', 'IGM/mIGM requires explicit source atoms.')
            self.atoms = []; self.elements = []
            for atom in atoms:
                element = atom.get('element'); position = [atom.get(axis) for axis in ('x', 'y', 'z')]
                if element not in SYMBOLS[1:] or any(type(v) not in (int, float) or not math.isfinite(v) for v in position):
                    reject('structure', 'Structure elements and Cartesian Å coordinates must be explicit and finite.')
                self.elements.append(element); self.atoms.append(dict(atomicNumber=SYMBOLS.index(element), positionBohr=[v / BOHR_TO_ANGSTROM for v in position]))
            self.metadata = dict(atoms=self.atoms, basisCount=0, sourceBytes=0, format='xyz')
        else:
            reject('source', 'Only a full wavefunction snapshot or explicit structure is accepted.')
        self.atom_count = len(self.atoms)
        if self.atom_count < 1:
            reject('size', 'Interaction analysis requires explicit source atoms.')

    @staticmethod
    def _resource_args(grant):
        return dict(threads=grant.get('threads'), memory_budget_bytes=grant.get('memoryBudgetBytes'))

    def capabilities(self):
        return dict(sessionId=self.session_id, context=self.context, methods=[key for key in METHODS if key != 'igm'] if self.source['kind'] == 'wavefunction' else ['migm', 'igm'],
                    backend=self.backend, atomCount=self.atom_count, resources=self.resources, retainedMemoryBytes=self.retained_memory_bytes())

    def retained_memory_bytes(self):
        return retained_size([self.source, self.context, self.metadata, self.fields, self.generations, self.native_history])

    def apply_resources(self, grant):
        if not isinstance(grant, dict) or any(type(grant.get(k)) is not int or grant[k] <= 0 for k in ('threads', 'memoryBudgetBytes')):
            reject('resources', 'A current explicit shared Multiwfn resource grant is required.')
        resources, settings = resolve_resources(self.executable, **self._resource_args(grant))
        if resources['settingsRevision'] != self.open_settings_revision or grant.get('settingsRevision', self.open_settings_revision) != self.open_settings_revision:
            reject('resource-changed', 'Global Multiwfn settings changed after opening; no native work was started.')
        for key in ('sharedReservedBytes', 'configuredMemoryBudgetBytes'):
            if key in grant:
                if type(grant[key]) is not int or grant[key] < 0:
                    reject('resources', 'Shared resource accounting metadata is invalid.')
                resources[key] = grant[key]
        self.resources = resources; self.settings = settings; self.parameters = effective_parameters(settings)

    def _current(self, epoch=None):
        if self.closed or self.cancelled.is_set() or epoch is not None and epoch != self.epoch:
            reject('cancelled', 'This interaction operation is closed, stopped or no longer current.')
        if self.source_stat is not None:
            stat = self.source_path.stat()
            if (stat.st_size, stat.st_mtime_ns) != self.source_stat:
                reject('source-changed', 'The immutable registered wavefunction changed; open a new session.')

    def _check_stamp(self, stamp):
        self._current()
        if not isinstance(stamp, dict) or not bounded_id(stamp.get('requestId')) or not bounded_id(stamp.get('analysisId')) or context_of(stamp) != self.context:
            reject('stamp', 'Interaction request belongs to another source/frame/document generation.')

    def _validate_request(self, request):
        self._check_stamp(request['stamp']); method = request.get('method')
        fragments = validate_fragments(method, request.get('fragments'), self.atom_count)
        if method not in ('migm', 'igm') and self.source['kind'] != 'wavefunction':
            reject('wavefunction', 'Only IGM/mIGM accepts structure-only input; no approximate fallback was selected.')
        if method == 'igm' and self.source['kind'] != 'structure':
            reject('structure', 'The verified original IGM route requires an explicit finite structure snapshot.')
        if method in ('igmh', 'migm', 'igm') and self.parameters['IGMvdwscl'] != 0:
            reject('domain', 'Enabled IGMvdwscl skips an unverified overlap domain; it was not silently disabled.')
        return method, fragments

    def _spawn(self, purpose):
        self._current(); self.stop_native()
        self.work_count += 1
        work = Path(tempfile.mkdtemp(prefix=purpose + '-', dir=self.root))
        source = work / ('source.molden' if self.metadata['format'] == 'molden' else 'source.fchk' if self.source['kind'] == 'wavefunction' else 'source.xyz')
        if len(str(source)) >= 240:
            reject('path', 'The owned native workspace is too long; choose a short owned workspace without changing the scientific source.')
        if self.source['kind'] == 'wavefunction':
            shutil.copyfile(self.source_path, source)
            if hashlib.sha256(source.read_bytes()).hexdigest() != self.metadata['sourceSha256']:
                reject('source-changed', 'The safe owned wavefunction copy does not match the registered full source.')
        else:
            rows = [str(self.atom_count), 'Ester Studio explicit source structure; promolecular IGM/mIGM route, no quantum wavefunction']
            rows.extend(element + ' ' + ' '.join(format(v * BOHR_TO_ANGSTROM, '.17g') for v in atom['positionBohr']) for element, atom in zip(self.elements, self.atoms))
            source.write_text('\n'.join(rows) + '\n', encoding='ascii')
        with self.lock:
            self._current()
            native = _InteractionNativeProcess(self.executable, source, work, self.resources, self.settings, progress_callback=self.progress_callback)
            native.queue = _ObservedOutputQueue(); native.interaction_cleanup_lock = threading.Lock()
            self.native = native
        try:
            native.start(); self.backend = dict(name='Multiwfn', version=native.backend['version']); return native
        except Exception:
            self._stop_owned(native); raise

    def _stop_owned(self, native):
        with native.interaction_cleanup_lock:
            if getattr(native, 'interaction_recorded', False):
                return
            process = getattr(native, 'interaction_process', native.process)
            native.interaction_process = process
            native.stop()
            if process is not None:
                if process.poll() is None:
                    reject('cleanup', 'Owned native process is still active; stop is not acknowledged as settled.')
                if not native.queue.reader_eof.wait(5):
                    reject('cleanup', 'Owned native process ended but its output reader has not settled.')
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()
            with self.lock:
                if self.native is native:
                    self.native = None
                self.native_history.append(dict(pid=process.pid if process else None, exitCode=process.poll() if process else None, workName=native.work.name,
                                                settled=process is None or process.poll() is not None,
                                                pipesClosed=process is None or all(s is None or s.closed for s in (process.stdin, process.stdout))))
                native.interaction_recorded = True

    def _route(self, native, method, fragments, answers):
        native.send(['20']); native.wait(WEAK_END)
        native.send([METHODS[method]])
        if method in ('igmh', 'migm', 'igm'):
            native.wait('How many fragments will be defined?'); native.send([len(fragments)])
            for ordinal, fragment in enumerate(fragments, 1):
                native.wait(f'Input atom indices for fragment {ordinal:2d}')
                native.send([','.join(map(str, fragment['atomIndices']))])
            if method in ('migm', 'igm') and self.source['kind'] == 'wavefunction':
                native.wait('2 sign(lambda2)rho based on promolecular density'); native.send(['2'])
        grid_prompt = native.wait(GRID_END)
        extension = re.search(r'current:\s*(' + NUMBER + r')\s*Bohr', grid_prompt)
        if extension is None:
            reject('grid', 'The actual native grid extension could not be established.')
        if answers[0] == 'target-points':
            dimensions = target_grid_dimensions([a['positionBohr'] for a in self.atoms], number(extension[1]), int(answers[1]))
            native.target_grid_plan = dict(targetPoints=int(answers[1]), actualExtensionBohr=number(extension[1]), dimensions=dimensions)
            answers = ['4', ','.join(map(str, dimensions))]
        if answers[0] == '4' and ',' not in answers[1]:
            spacing = float(answers[1]); positions = np.array([a['positionBohr'] for a in self.atoms])
            ratios = (positions.max(axis=0) - positions.min(axis=0) + 2 * number(extension[1])) / spacing
            if not np.isfinite(ratios).all():
                reject('memory', 'Custom grid dimensions exceed the scalar profile before native allocation.')
            points = math.prod(max(2, math.ceil(float(v)) + 2) for v in ratios)
        elif answers[0] == '4':
            dimensions = [int(value) for value in answers[1].split(',')]
            if len(dimensions) != 3 or any(value < 2 for value in dimensions):
                reject('grid', 'Explicit XYZ dimensions must each contain at least two nodes.')
            points = math.prod(dimensions)
        else:
            points = {'1': 250000, '2': 1024000, '3': 3456000}.get(answers[0], 8)
        field_count = 2 if method in ('iri', 'rdg') else 4
        source_work = self.metadata.get('basisCount', 0) ** 2 * 64 + self.metadata.get('sourceBytes', 0) * 5
        if answers[0] == '4':
            native.send(['4']); native.wait('or input grid spacing (Bohr)')
            native.send([answers[1]])
        else:
            native.send(answers)
        return native.wait(POST_GLOBAL if method in ('iri', 'rdg') else POST_FRAGMENT)

    def _finish(self, native):
        native.send(['0']); native.wait(WEAK_END)
        native.send(['0']); native.wait(MAIN_MENU)
        native.send(['q'])
        process = native.process
        process.wait(timeout=5)
        if process.returncode != 0:
            reject('native-exit', 'Native main-20 did not exit successfully after its completed output.')
        # Drain to reader EOF so the immutable provenance log includes the actual
        # terminal bytes, not a file snapshot racing the output observer.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if native.queue.get(timeout=.1) is None:
                    return
            except queue.Empty:
                pass
        reject('native-output', 'Native exited but its owned output reader did not settle.')

    def _provenance(self, native, parameters, roles):
        artifacts = []
        for role, name in [('native-output', native.log.name), ('native-menu', native.menu_log.name), ('effective-settings', 'settings.ini'), *roles]:
            path = native.work / name
            if path.is_file():
                artifacts.append(dict(role=role, name=name, revision=hashlib.sha256(path.read_bytes()).hexdigest()))
        return dict(backend=self.backend, sourceIds=[self.context['sourceId']], parameters=dict(threads=self.resources['threads'],
                    memoryBudgetBytes=self.resources['memoryBudgetBytes'], settingsRevision=self.resources['settingsRevision'],
                    **(getattr(native, 'source_prerequisites', None) or {}), **self.parameters, **parameters), rawArtifacts=artifacts,
                    notices=['Native main-20 scalar fields and delta-G indices are not interaction energies.',
                             'Original full source is retained. Native fragment union is explicit; no wavefunction was cropped.',
                             'Native printed whole-space field integrals retain their finite exported-grid sampling context.'])

    def _field(self, native, name, component, stamp, domain):
        cube = read_scalar_cube(native.work / name, self.resources['memoryBudgetBytes'])
        identity = json.dumps([stamp['analysisId'], stamp['requestId'], component], separators=(',', ':'), ensure_ascii=True)
        field_id = 'interaction:' + hashlib.sha256(identity.encode('ascii')).hexdigest()
        function = 'sign-lambda2-rho' if component == 'mapping' else FUNCTIONS[component]
        field = dict(id=field_id, context=context_of(stamp), source=dict(id=field_id, name=name, revision=cube['revision'],
                     kind='generated-cube', producer='multiwfn', comments=cube['comments']), function=function,
                     functionLabel={'mapping': 'sign(λ₂)ρ', 'inter': 'δg_inter', 'intra': 'δg_intra', 'total': 'δg'}.get(component, component.upper()),
                     valueUnit='a.u.', definitionEvidence=dict(kind='native-output', description='Actual Multiwfn main-20 method, native output role and unmodified original Cube.'),
                     grid=cube['grid'], atoms=cube['atoms'], precision=cube['precision'], validDomain=domain,
                     valuesBase64=base64.b64encode(cube['values'].astype('<f8', copy=False).tobytes()).decode('ascii'))
        return field, cube

    def generate(self, request):
        method, fragments = self._validate_request(request); answers = grid_answers(request.get('quality')); epoch = self.epoch
        if request['stamp']['requestId'] in self.generations:
            reject('generation', 'A generation request id cannot replace an existing completed generation.')
        mode = request['quality']['mode']; approximate = math.prod(request['quality']['dimensions']) if mode == 'dimensions' else {'low': 150000, 'medium': 650000, 'high': 2100000}.get(mode, 0)
        field_count = 2 if method in ('iri', 'rdg') else 4
        source_work = self.metadata.get('basisCount', 0) ** 2 * 64 + self.metadata.get('sourceBytes', 0) * 5 if mode == 'dimensions' else 0
        native = self._spawn('interaction-fields')
        try:
            output = self._route(native, method, fragments, answers)
            native.send(['2']); native.wait(POST_GLOBAL if method in ('iri', 'rdg') else POST_FRAGMENT)
            report_progress(self.progress_callback, 'write', stageId='interaction-cube-export')
            native.send(['3']); native.wait(POST_GLOBAL if method in ('iri', 'rdg') else POST_FRAGMENT)
            self._finish(native)
            report_progress(self.progress_callback, 'parse', stageId='interaction-field-validation')
            names = {method: 'func2.cub'} if method in ('iri', 'rdg') else {'inter': 'dg_inter.cub', 'intra': 'dg_intra.cub', 'total': 'dg.cub'}
            mapping_name = 'func1.cub' if method in ('iri', 'rdg') else 'sl2r.cub'
            full = dict(kind='full-grid', evidence='Actual main-20 evaluated the complete requested box; IGMvdwscl=0 and no post-screening was selected.')
            mapping, mapped_cube = self._field(native, mapping_name, 'mapping', request['stamp'], full)
            if mode == 'target-points' and mapped_cube['grid']['dimensions'] != native.target_grid_plan['dimensions']:
                reject('grid', 'Actual native grid differs from the allocation over its verified box; no substitute was published.')
            if mode == 'dimensions' and mapped_cube['grid']['dimensions'] != request['quality']['dimensions']:
                reject('grid', 'Native XYZ grid dimensions differ from the exact requested point counts; no substitute quality was published.')
            mapping_lines = (native.work / mapping_name).read_text(encoding='utf-8').splitlines()
            intervals = np.fromiter((half_last_digit(token) for line in mapping_lines[6 + len(mapped_cube['atoms']):] for token in line.split()), dtype=np.float64)
            if len(intervals) != len(mapped_cube['values']):
                reject('precision', 'Native signed-density print intervals do not match scalar nodes.')
            fields, cubes = {}, {}
            for component, name in names.items():
                domain = density_domain(method, mapped_cube['values'], self.parameters, intervals) if method in ('iri', 'rdg') else full
                field, cube = self._field(native, name, component, request['stamp'], domain)
                require_cube_pair(cube, mapped_cube); fields[component] = field; cubes[component] = cube
            if len(mapped_cube['atoms']) != self.atom_count or [a['atomicNumber'] for a in mapped_cube['atoms']] != [a['atomicNumber'] for a in self.atoms]:
                reject('atoms', 'Native Cube source atom inventory differs from the full registered source.')
            for i, (actual, expected) in enumerate(zip(mapped_cube['atoms'], self.atoms)):
                if any(abs(a-b) > error + 1e-10 for a,b,error in zip(actual['position'], expected['positionBohr'], mapped_cube['precision']['atomCoordinates'][i])):
                    reject('atoms', 'Native Cube source coordinates differ from the registered immutable frame beyond print precision.')
            integrals = [] if method in ('iri', 'rdg') else parse_integrals(output)
            roles = [('mapping-cube', mapping_name), ('native-scatter', 'output.txt')] + [(component + '-cube', name) for component, name in names.items()]
            provenance = self._provenance(native, dict(method=method, quality=mode, actualDimensions=mapped_cube['grid']['dimensions'], **(dict(targetGridPointCount=native.target_grid_plan['targetPoints'], nativeGridExtensionBohr=native.target_grid_plan['actualExtensionBohr']) if hasattr(native, 'target_grid_plan') else {}),
                         densitySource='promolecular' if method in ('migm', 'igm') else 'actual-wavefunction',
                         mappingDensitySource='promolecular' if method in ('migm', 'igm') else 'actual-wavefunction',
                         selectedAtomIndices=sorted(i for f in fragments for i in f['atomIndices']),
                         unassignedAtomCount=self.atom_count - len({i for f in fragments for i in f['atomIndices']}) if fragments else 0,
                         nativeScatterOrdering='x-fastest' if method in ('iri', 'rdg') else 'z-fastest',
                         scatterPublication='same-read-Cube-paired-fields; original native scatter preserved'), roles)
            result = dict(stamp=copy.deepcopy(request['stamp']), method=method, fragments=fragments, quality=copy.deepcopy(request['quality']), fields=fields, mapping=mapping, integrals=integrals, provenance=provenance)
            descriptors = {}
            for field in [mapping, *fields.values()]:
                descriptor = {key: value for key, value in field.items() if key != 'valuesBase64'}
                sidecar = dict(schema='sciyue-surface-domain/v1', sourceRevision=field['source']['revision'], validDomain=field['validDomain'], context=self.context,
                               function=field['function'], valueUnit=field['valueUnit'], method=method, fragments=fragments, parameters=provenance['parameters'])
                path = native.work / field['source']['name']; meta = path.with_name(path.name + '.domain.json')
                meta.write_text(json.dumps(sidecar, allow_nan=False, separators=(',', ':')), encoding='utf-8')
                descriptors[field['id']] = dict(path=str(path), revision=field['source']['revision'], metadataPath=str(meta), metadataBytes=meta.stat().st_size,
                                              metadataRevision=hashlib.sha256(meta.read_bytes()).hexdigest(), descriptor=descriptor, analysisId=request['stamp']['analysisId'])
            saved = {key: value for key, value in result.items() if key not in ('fields', 'mapping', 'stamp')}
            saved.update(analysisId=request['stamp']['analysisId'], fieldIds={key: field['id'] for key, field in fields.items()}, mappingId=mapping['id'])
            with self.lock:
                self._current(epoch)
                if request['stamp']['requestId'] in self.generations:
                    reject('generation', 'A generation request id cannot replace an existing completed generation.')
                self.fields.update(descriptors); self.generations[request['stamp']['requestId']] = saved
            return result
        finally:
            self._stop_owned(native)

    def contributions(self, request):
        method, fragments = self._validate_request(request); pair = request.get('pair'); epoch = self.epoch
        if method not in ('igmh', 'migm') or not isinstance(pair, list) or len(pair) != 2 or pair[0] == pair[1] or any(i not in [f['id'] for f in fragments] for i in pair):
            reject('pair', 'Contributions require two distinct defined IGMH/mIGM fragments.')
        quality = request.get('integrationQuality')
        if type(quality) is not int or quality not in (2, 3, 4):
            reject('integration-quality', 'Use native integration grid 2, 3 or 4; deprecated quality1 was not substituted.')
        # The native contribution menu requires a field-stage predecessor, but
        # its Becke integral does not consume this rectangular visualization grid.
        native = self._spawn('interaction-contributions')
        try:
            self._route(native, method, fragments, ['4', '2,2,2'])
            native.send(['6'])
            indices = [next(i for i, f in enumerate(fragments, 1) if f['id'] == id_) for id_ in pair]
            # For exactly two fragments native uses definition order, not a new
            # pair prompt. Preserve caller pair order by validating/reordering
            # the parsed selected-fragment blocks after native evaluation.
            native_indices = sorted(indices)
            native_pair = [fragments[i - 1]['id'] for i in native_indices]
            if len(fragments) > 2:
                native.wait('Input fragment index to select two fragments'); native.send([','.join(map(str, native_indices))])
            native.wait('5 Use "radpot" and "sphpot" defined in settings.ini')
            report_progress(self.progress_callback, 'running', stageId='interaction-pair-integration')
            native.send([quality]); integration_output = native.wait('atomic properties correspond to atomic delta-g index multiplied by')
            actual_grid = re.search(r'Radial points:\s*(\d+)\s+Angular points:\s*(\d+)', integration_output)
            expected_grid = {2: (40, 170), 3: (60, 302), 4: (75, 434)}[quality]
            if actual_grid is None or tuple(map(int, actual_grid.groups())) != expected_grid:
                reject('integration-quality', 'Actual native quadrature differs from the requested verified quality; no result was relabelled.')
            native.send(['n']); native.wait(POST_FRAGMENT)
            self._finish(native)
            report_progress(self.progress_callback, 'parse', stageId='interaction-contribution-validation')
            atoms, pairs, total = parse_contributions((native.work / 'atmdg.txt').read_text(encoding='utf-8'), fragments, native_pair, self.elements)
            if native_pair != pair:
                atoms.sort(key=lambda row: pair.index(row['fragmentId']))
                pairs = [dict(row, sourceIndex1=row['sourceIndex2'], sourceIndex2=row['sourceIndex1']) for row in pairs]
            provenance = self._provenance(native, dict(method=method, integrationQuality=quality, selectedFragmentIndices=native_indices, requestedFragmentIndices=indices,
                          contributionGrid='Becke multi-center quadrature independent of prerequisite 2x2x2 display grid',
                          densitySource='promolecular' if method == 'migm' else 'actual-wavefunction', prerequisiteGridOnly=True), [('atomic-pair-contributions', 'atmdg.txt'), ('native-additional-IBSIW', 'IBSIW.txt')])
            self._current(epoch)
            return dict(stamp=copy.deepcopy(request['stamp']), method=method, fragments=fragments, pair=pair, integrationQuality=quality,
                        atoms=atoms, pairs=pairs, pairSum=total, unit='a.u.', percentageDefinition='atoms-within-each-fragment;pairs-within-selected-pair', provenance=provenance)
        finally:
            self._stop_owned(native)

    def _restore_field(self, field_id, analysis_id):
        item = self.fields.get(field_id)
        if item is None or item['analysisId'] != analysis_id:
            reject('field', 'This field is not a completed artifact owned by the requested analysis.')
        path = Path(item['path']); metadata_path = Path(item['metadataPath'])
        if path.is_symlink() or metadata_path.is_symlink() or metadata_path.stat().st_size != item['metadataBytes']:
            reject('field-changed', 'Owned Cube/domain artifacts were replaced or their bounded size changed.')
        cube = read_scalar_cube(path, self.resources['memoryBudgetBytes'])
        raw_metadata = metadata_path.read_bytes()
        if cube['revision'] != item['revision'] or hashlib.sha256(raw_metadata).hexdigest() != item['metadataRevision']:
            reject('field-changed', 'Completed Cube or bound domain metadata changed; no cached result was restored.')
        metadata = json.loads(raw_metadata)
        if metadata.get('sourceRevision') != cube['revision'] or metadata.get('context') != self.context:
            reject('domain', 'Cached domain/source identity is inconsistent.')
        field = copy.deepcopy(item['descriptor']); field['validDomain'] = metadata['validDomain']
        field['valuesBase64'] = base64.b64encode(cube['values'].astype('<f8', copy=False).tobytes()).decode('ascii')
        return field, cube

    def restore_fields(self, request):
        self._check_stamp(request['stamp']); saved = self.generations.get(request.get('generationId'))
        if saved is None or saved['analysisId'] != request['stamp']['analysisId']:
            reject('generation', 'Only a completed generation owned by this analysis may be restored.')
        ids = [saved['mappingId'], *saved['fieldIds'].values()]
        points = sum(math.prod(self.fields[id_]['descriptor']['grid']['dimensions']) for id_ in ids)
        mapping, mapped_cube = self._restore_field(saved['mappingId'], request['stamp']['analysisId'])
        fields = {}
        for component, id_ in saved['fieldIds'].items():
            field, cube = self._restore_field(id_, request['stamp']['analysisId']); require_cube_pair(cube, mapped_cube); fields[component] = field
        self._current()
        return dict(stamp=copy.deepcopy(request['stamp']), method=saved['method'], fragments=copy.deepcopy(saved['fragments']), quality=copy.deepcopy(saved['quality']),
                    fields=fields, mapping=mapping, integrals=copy.deepcopy(saved['integrals']), provenance=copy.deepcopy(saved['provenance']))

    def export_cube(self, request):
        self._check_stamp(request['stamp'])
        item = self.fields.get(request.get('fieldId'))
        if item is None or item['analysisId'] != request['stamp']['analysisId']:
            reject('field', 'Only a completed field owned by this analysis can be exported.')
        self._restore_field(request.get('fieldId'), request['stamp']['analysisId'])
        item = self.fields[request['fieldId']]; path = Path(item['path'])
        return dict(name=path.name, text=path.read_bytes().decode('utf-8'), domain=dict(name=path.name + '.sciyue-domain.json', text=Path(item['metadataPath']).read_bytes().decode('utf-8')))

    def evidence(self):
        native = self.native; process = native.process if native else None
        return dict(sessionId=self.session_id, context=self.context, backend=self.backend, resources=self.resources, nativeHistory=list(self.native_history),
                    nativeProcessId=process.pid if process and process.poll() is None else None,
                    nativeOutputPath=str(native.log) if native else None, activeNativeCount=int(process is not None and process.poll() is None),
                    retainedMemoryBytes=self.retained_memory_bytes(), artifacts=[dict(path=str(p), name=p.name, bytes=p.stat().st_size) for work in self.root.iterdir() if work.is_dir() and not work.is_symlink() for p in work.iterdir() if p.is_file() and not p.is_symlink()])

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
