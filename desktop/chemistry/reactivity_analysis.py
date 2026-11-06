"""Single-source, ordinary frozen-orbital reactivity; no three-state or OW-CDFT route.

Host-owned immutable wavefunction snapshots and SurfaceStamp identities only.
Hirshfeld compositions come from native main-8; algebra retains unrounded energies.
"""
from __future__ import annotations

import copy
import hashlib
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

from orbitals import OrbitalError, inspect_wavefunction, _windows_owned_job, MultiwfnSession
from multiwfn_resources import resolve_resources
from multiwfn_progress import NativeProgressScanner, report_progress
from wavefunction_analysis import SYMBOLS

EV_PER_HARTREE = 27.211386245981
TCE_HOMO_HARTREE = -.335198
DEGENERACY_SCREEN_EV = .01
RAW_INTEGRAL_TOLERANCE = .005
FRACTION_PRECISION = .00001  # Native prints atomic percentage to three decimals.
NUMBER = r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[EeDd][-+]?\d+)?'
CONTEXT_KEYS = ('sourceId', 'sourceRevision', 'jobIndex', 'sourceFrameIndex', 'generation',
                'documentId', 'documentRevision', 'activationEpoch')
METRICS = ('homo', 'lumo', 'gap', 'ip', 'ea', 'chi', 'mu', 'eta', 'softness', 'omega', 'NNu')


class ReactivityError(OrbitalError):
    pass


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def number(raw):
    value = float(raw.replace('D', 'E').replace('d', 'e'))
    if not math.isfinite(value):
        raise ReactivityError('reactivity-number', 'Non-finite native reactivity value.')
    return value


def source_representation(source, text, metadata):
    declared = source.get('orbitalRepresentation', 'unknown')
    evidence = source.get('orbitalRepresentationEvidence', '')
    if declared not in ('canonical', 'natural', 'localized', 'nto', 'unknown'):
        raise ReactivityError('reactivity-orbitals', 'Unknown orbital representation declaration.')
    if declared in ('natural', 'localized', 'nto'):
        return declared, evidence or 'Source explicitly declares noncanonical orbitals.'
    noncanonical = re.search(r'(?:natural (?:transition |bond )?orbitals?|localized (?:molecular )?orbitals?|\bNTO\s*(?:orbitals?|\d)|\bNBO\s*(?:orbitals?|\d)|\bLMO\s*(?:orbitals?|\d)|\[NTO\]|\[Natural Orbitals\])', text, re.I)
    if noncanonical:
        return 'nto' if 'transition' in noncanonical[0].lower() or 'nto' in noncanonical[0].lower() else 'localized' if 'local' in noncanonical[0].lower() or 'lmo' in noncanonical[0].lower() else 'natural', 'Explicit noncanonical orbital marker in source content: '+noncanonical[0]
    # FCHK's actual route/method and SCF density field establish the supported
    # ordinary SCF export profile. Titles/filenames are not method evidence.
    lines = text.splitlines()
    header = lines[1].split() if len(lines) > 1 else []
    method = header[1] if len(header) >= 2 else ''
    if (metadata['format'] == 'fchk' and re.fullmatch(r'R[A-Za-z0-9+()\-]+', method)
            and not re.search(r'MP\d|CC|CAS|NBO|NTO|CIS|CI\b', method, re.I)
            and re.search(r'^Total SCF Density\s+R\s+N=', text, re.M)
            and not re.search(r'^(?:Natural Orbital|NTO|Localized Orbital)', text, re.M | re.I)):
        return 'canonical', 'FCHK method '+method+' and Total SCF Density; ordinary restricted SCF export profile.'
    return 'unknown', 'The source does not establish canonical SCF orbital identity.'


def frontier_channels(metadata):
    channels = []
    for spin in ('restricted', 'alpha', 'beta'):
        orbitals = [o for o in metadata['orbitals'] if o['spin'] == spin]
        if not orbitals:
            continue
        occupied = [o for o in orbitals if o['occupation'] > 1e-7]
        virtual = [o for o in orbitals if o['occupation'] <= 1e-7]
        h = max(occupied, key=lambda o: o['energyHartree']) if occupied else None
        l = min(virtual, key=lambda o: o['energyHartree']) if virtual else None
        def ref(orbital):
            if orbital is not None and not math.isfinite(orbital['energyHartree']*EV_PER_HARTREE):
                raise ReactivityError('reactivity-number', 'Frontier orbital energy conversion exceeds finite numeric range.')
            return None if orbital is None else dict(key=orbital['id'], spin=spin, ordinal=orbital['displayIndex'],
                sourceIndex=orbital.get('sourceIndex', orbital['multiwfnIndex']), nativeIndex=orbital['multiwfnIndex'], energyHartree=orbital['energyHartree'],
                energyEV=orbital['energyHartree']*EV_PER_HARTREE, occupation=orbital['occupation'])
        def degeneracy(group, target):
            return 0 if target is None else sum(abs(o['energyHartree']-target['energyHartree'])*EV_PER_HARTREE <= DEGENERACY_SCREEN_EV for o in group)
        channels.append(dict(spin=spin, homo=ref(h), lumo=ref(l), homoDegeneracy=degeneracy(occupied, h), lumoDegeneracy=degeneracy(virtual, l)))
    return channels


def suitability(metadata, representation, frontier):
    reasons = []
    if representation != 'canonical':
        reasons.append('仅对已确认的 canonical SCF 轨道提供普通 FMO 反应性指标。')
    if len(frontier) != 1 or frontier[0]['spin'] != 'restricted' or metadata.get('multiplicity') not in (None, 1):
        reasons.append('开壳层保留分自旋轨道；本方法不合并为闭壳层反应性标量。')
    if any(min(abs(o['occupation']), abs(o['occupation']-2)) > 1e-7 for o in metadata['orbitals']):
        reasons.append('分数占据或单占据轨道不适用本轮闭壳层 2/0 FMO 定义。')
    eligible = not reasons
    channel = frontier[0] if len(frontier) == 1 else None
    if eligible and (channel is None or channel['homo'] is None):
        reasons.append('来源没有可用的占据前线轨道。')
    global_ready = eligible and bool(channel and channel['homo'])
    condensed = global_ready and bool(channel['lumo'])
    if global_ready and channel['lumo'] is None:
        reasons.append('来源缺少虚轨道；保留可用 HOMO、IP 与 NNu，其他依赖 LUMO 的指标缺失。')
    if condensed and (channel['homoDegeneracy'] > 1 or channel['lumoDegeneracy'] > 1):
        condensed = False
        reasons.append('前线轨道在 0.01 eV 适用性筛选范围内简并；保留全局量与轨道图，本轮不任选单轨道计算局部指标。')
    return dict(orbitalDisplay=bool(frontier), global_=global_ready, condensed=condensed, reasons=reasons)


def global_metrics(frontier, enabled):
    reason = '当前来源不适用闭壳层 canonical FMO 反应性定义。'
    result = {key: dict(value=None, unit='eV^-1' if key == 'softness' else 'eV', reason=reason) for key in METRICS}
    if not enabled:
        return result
    channel = frontier[0]
    h = channel['homo']['energyEV'] if channel['homo'] else None
    l = channel['lumo']['energyEV'] if channel['lumo'] else None
    values = dict(homo=h, lumo=l, ip=-h if h is not None else None, ea=-l if l is not None else None,
                  NNu=h-TCE_HOMO_HARTREE*EV_PER_HARTREE if h is not None else None)
    if h is not None and l is not None:
        gap = l-h
        values.update(gap=gap, chi=-(h+l)/2, mu=(h+l)/2, eta=gap)
        if gap > 1e-10:
            values.update(softness=1/gap, omega=((h+l)/2)**2/(2*gap))
    for key in METRICS:
        value = values.get(key)
        if value is not None and finite(value):
            result[key] = dict(value=value, unit='eV^-1' if key == 'softness' else 'eV')
        else:
            result[key]['reason'] = ('轨道能隙非正或不足以安全求倒数。' if key in ('softness', 'omega') and h is not None and l is not None
                                     else '来源缺少此指标所需的前线轨道。')
    return result


def parse_hirshfeld_compositions(output, metadata, expected):
    """Accept complete native normalized tables only after raw quadrature checks."""
    found = {}
    header = re.compile(r'Orbital:\s*(\d+)\s+Energy\(a\.u\.\):\s*('+NUMBER+r')\s+Occ:\s*('+NUMBER+r')\s+Type:\s*Alpha&Beta')
    matches = list(header.finditer(output))
    expected_map = {o['nativeIndex']: o for o in expected}
    for i, match in enumerate(matches):
        index = int(match[1])
        if index not in expected_map or index in found:
            raise ReactivityError('reactivity-orbital-table', 'Unexpected or duplicate native orbital table.')
        orbital = expected_map[index]
        if abs(number(match[2])-orbital['energyHartree']) > .00000051 or abs(number(match[3])-orbital['occupation']) > .0000051:
            raise ReactivityError('reactivity-orbital-identity', 'Native orbital energy/occupation differs from its source identity.')
        block = output[match.end():matches[i+1].start() if i+1 < len(matches) else len(output)]
        raw = re.search(r'The sum of contributions before normalization\s+('+NUMBER+r')\s*%', block)
        table = re.search(r'Contributions after normalization:\s*(.*?)Orbital delocalization index:', block, re.S)
        if raw is None or table is None:
            raise ReactivityError('reactivity-integral', 'Native raw integral or normalized Hirshfeld table is missing.')
        raw_sum = number(raw[1])/100
        if abs(raw_sum-1) > RAW_INTEGRAL_TOLERANCE:
            raise ReactivityError('reactivity-integral', 'Raw Hirshfeld orbital integral is not sufficiently close to one; no result was normalized in Ester Studio.')
        rows = list(re.finditer(r'Atom\s+(\d+)\(\s*([A-Za-z]+)\s*\)\s*:\s*('+NUMBER+r')\s*%', table[1]))
        if len(rows) != len(metadata['atoms']):
            raise ReactivityError('reactivity-atom-table', 'Incomplete native Hirshfeld atom table.')
        values = []; seen = set()
        for atom_index, row in enumerate(rows):
            source_index = int(row[1]); element = SYMBOLS[metadata['atoms'][atom_index]['atomicNumber']]
            if source_index != atom_index+1 or source_index in seen or row[2] != element:
                raise ReactivityError('reactivity-atom-table', 'Native Hirshfeld atom identities differ from the immutable source.')
            seen.add(source_index); value = number(row[3])/100
            if value < 0 or value > 1+FRACTION_PRECISION:
                raise ReactivityError('reactivity-population', 'Invalid normalized Hirshfeld population.')
            values.append(value)
        printed_sum = sum(values)
        if abs(printed_sum-1) > len(values)*FRACTION_PRECISION/2 + 1e-9:
            raise ReactivityError('reactivity-integral', 'Printed Hirshfeld populations do not sum to one within native rounding precision.')
        found[index] = dict(values=values, integral=dict(orbitalKey=orbital['key'], sourceIndex=index, rawSum=raw_sum,
            normalizedPrintedSum=printed_sum, rawSumUnit='fraction', nativeNormalization=True, printedFractionPrecision=FRACTION_PRECISION))
    if set(found) != set(expected_map):
        raise ReactivityError('reactivity-orbital-table', 'Missing requested frontier orbital tables.')
    return found


def condensed_atoms(metadata, h_values, l_values, metrics):
    atoms = []
    for i, (minus, plus) in enumerate(zip(h_values, l_values)):
        def scaled(key, value):
            factor = metrics[key]['value']
            result = factor*value if factor is not None else None
            if result is not None and not finite(result):
                raise ReactivityError('reactivity-number', 'Non-finite local descriptor.')
            return result
        zero = (minus+plus)/2
        atoms.append(dict(sourceIndex=i+1, element=SYMBOLS[metadata['atoms'][i]['atomicNumber']],
            fPlus=plus, fMinus=minus, fZero=zero, dual=plus-minus, omega=scaled('omega', plus), NNu=scaled('NNu', minus),
            sPlus=scaled('softness', plus), sMinus=scaled('softness', minus), sZero=scaled('softness', zero)))
    return atoms


class ReactivityAnalysisService:
    def __init__(self, work_dir, *, progress_callback=None, cancel_callback=None):
        self.root = Path(work_dir).resolve(); self.root.mkdir(parents=True, exist_ok=True)
        self.progress_callback = progress_callback; self.cancel_callback = cancel_callback
        self.native = None; self.job = None; self.closed = False; self.cancelled = threading.Event()
        self.native_start_count = 0
        self.source = None; self.metadata = None; self.last_result = None; self.work_count = 0
        self._native_lock = threading.Lock()

    def _current(self):
        if self.closed or self.cancelled.is_set() or (self.cancel_callback is not None and self.cancel_callback()):
            raise ReactivityError('reactivity-cancelled', 'The FMO operation was stopped; no partial result was published.')

    def _check_stamp(self, stamp):
        self._current()
        if not self.source or not isinstance(stamp, dict) or not all(isinstance(stamp.get(k), str) and stamp[k] for k in ('analysisId', 'requestId')):
            raise ReactivityError('reactivity-stamp', 'Open a source and provide a complete FMO request stamp.')
        if {k: stamp.get(k) for k in CONTEXT_KEYS if k != 'activationEpoch'} != {k: self.context.get(k) for k in CONTEXT_KEYS if k != 'activationEpoch'}:
            raise ReactivityError('reactivity-stamp', 'FMO request source/frame/document identity differs from the session.')
        if stamp.get('activationEpoch') is not None and (type(stamp['activationEpoch']) is not int or not 0 <= stamp['activationEpoch'] <= 2**53-1):
            raise ReactivityError('reactivity-stamp', 'FMO activation epoch must be a nonnegative integer.')
        raw = self.source_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != self.source_revision:
            raise ReactivityError('reactivity-source-changed', 'The immutable FMO source snapshot changed.')

    def apply_resources(self, grant):
        if not isinstance(grant, dict) or type(grant.get('threads')) is not int or type(grant.get('memoryBudgetBytes')) is not int:
            raise ReactivityError('reactivity-resources', 'A current shared resource grant is required.')
        resources, settings = resolve_resources(self.executable, grant['threads'], grant['memoryBudgetBytes'])
        if resources['settingsRevision'] != self.open_settings_revision or (grant.get('settingsRevision') is not None and grant['settingsRevision'] != resources['settingsRevision']):
            raise ReactivityError('reactivity-resources', 'Multiwfn settings changed after opening this FMO source.')
        for key in ('sharedReservedBytes', 'configuredMemoryBudgetBytes'):
            if key in grant:
                resources[key] = grant[key]
        self.resources, self.settings = resources, settings

    def open(self, request):
        self._current()
        if self.source is not None:
            raise ReactivityError('reactivity-open', 'This service already owns a source; close it before replacing it.')
        source = copy.deepcopy(request['source'])
        if source.get('kind') != 'wavefunction' or not isinstance(source.get('context'), dict):
            raise ReactivityError('reactivity-source', 'FMO analysis requires a wavefunction source snapshot and context.')
        self.executable = Path(request['executable']).resolve()
        grant = request.get('resources') or {}
        self.resources, self.settings = resolve_resources(self.executable, grant.get('threads'), grant.get('memoryBudgetBytes'))
        self.open_settings_revision = self.resources['settingsRevision']
        if grant.get('settingsRevision') is not None and grant['settingsRevision'] != self.open_settings_revision:
            raise ReactivityError('reactivity-resources', 'Multiwfn settings changed after resource planning.')
        path = Path(source['sourcePath']).resolve()
        self.metadata = inspect_wavefunction(path)
        self.source_revision = self.metadata['sourceSha256']
        if not isinstance(source.get('sourceId'), str) or not source['sourceId']:
            raise ReactivityError('reactivity-source', 'FMO wavefunction snapshot requires its actual source identity.')
        if source.get('sourceRevision') != self.source_revision or source['context'].get('sourceRevision') != self.source_revision:
            raise ReactivityError('reactivity-source-changed', 'FMO source SHA-256 or source context differs from the registered snapshot.')
        text = path.read_text(encoding='utf-8', errors='strict')
        self.representation, self.representation_evidence = source_representation(source, text, self.metadata)
        self.frontier = frontier_channels(self.metadata)
        suitable = suitability(self.metadata, self.representation, self.frontier)
        self.capabilities = dict(orbitalDisplay=suitable['orbitalDisplay'], global_=suitable['global_'], condensed=suitable['condensed'], reasons=suitable['reasons'])
        self.capabilities['global'] = self.capabilities.pop('global_')
        self.context = copy.deepcopy(source['context']); self.session_id = request['sessionId']
        self.source = {k: v for k, v in source.items() if k != 'text'}; self.source_path = path
        self.metrics = global_metrics(self.frontier, self.capabilities['global'])
        self.notices = ['FMO 估计：IP≈−εH，EA≈−εL；不含轨道弛豫。',
                        'NNu 使用固定 TCE HOMO −0.335198 Eh（B3LYP/6-31G*）参考。']
        self.tce_level_match = 'unknown'
        lines = text.splitlines(); fields = lines[1].split() if self.metadata['format'] == 'fchk' and len(lines) > 1 else []
        if len(fields) >= 3:
            self.tce_level_match = 'matched' if fields[1].upper() == 'RB3LYP' and fields[2].upper() in ('6-31G(D)', '6-31G*') else 'unmatched'
        if self.tce_level_match != 'matched':
            self.notices.append('来源计算级别与固定 TCE 参考'+('不一致。' if self.tce_level_match == 'unmatched' else '尚未确认一致。'))
        if self.metrics['gap']['value'] is not None and self.metrics['gap']['value'] <= 1e-10:
            self.notices.append('轨道能隙非正或不足以安全求倒数；未给出软度与亲电指数。')
        return dict(sessionId=self.session_id, context=copy.deepcopy(self.context), atomCount=len(self.metadata['atoms']),
                    frontier=copy.deepcopy(self.frontier), capabilities=copy.deepcopy(self.capabilities), notices=self.notices[:], resources=self.resources)

    def _run_native(self, work, answers):
        self._current()
        (work/'settings.ini').write_bytes(self.settings)
        source = work/('source.molden' if self.metadata['format'] == 'molden' else 'source.fchk')
        shutil.copyfile(self.source_path, source)
        log = work/'native-output.txt'
        threads = str(self.resources['threads'])
        env = dict(os.environ, Multiwfnpath=str(self.executable.parent), OMP_NUM_THREADS=threads,
                   OPENBLAS_NUM_THREADS=threads, MKL_NUM_THREADS=threads, OMP_STACKSIZE='200M')
        offset = 0; scanner = NativeProgressScanner(self.progress_callback, 'reactivity-hirshfeld')
        with log.open('wb') as stream:
            with self._native_lock:
                self.native = subprocess.Popen([str(self.executable), source.name], cwd=work, env=env, stdin=subprocess.PIPE,
                    stdout=stream, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.native_start_count += 1
                self.job = _windows_owned_job(self.native, self.resources['memoryBudgetBytes'])
                process = self.native
            try:
                process.stdin.write(('\n'.join(answers)+'\n').encode('ascii')); process.stdin.close()
                while process.poll() is None:
                    self._current()
                    with log.open('rb') as reader:
                        reader.seek(offset); chunk = reader.read(65536)
                    offset += len(chunk); scanner.feed(chunk.decode('utf-8', errors='replace'))
                    time.sleep(.05)
                self._current()
                if process.returncode != 0:
                    raise ReactivityError('reactivity-native', 'Native Hirshfeld orbital analysis failed.')
            finally:
                self.stop_native()
        output = log.read_text(encoding='utf-8', errors='replace').replace('\r', '')
        scanner.feed(output[offset:]+'\n')
        if (output.count('************ Main function menu') != 2 or 'This is a restricted single-determinant wavefunction' not in output
                or 'Generating density matrix based on SCF orbitals' not in output):
            raise ReactivityError('reactivity-native-state', 'Native SCF wavefunction identity or complete menu return was not confirmed.')
        version = re.search(r'Version\s+([^\n]+)', output); actual_threads = re.search(r'Number of parallel threads:\s*(\d+)', output)
        if not version or not actual_threads or int(actual_threads[1]) != self.resources['threads']:
            raise ReactivityError('reactivity-native-version', 'Native version and effective thread count were not confirmed.')
        backend = dict(name='Multiwfn', version=version[1].strip(), threads=int(actual_threads[1]))
        return output, backend, log

    def analyze(self, request):
        self._check_stamp(request['stamp'])
        if request.get('resources') is not None:
            self.apply_resources(request['resources'])
        self._current(); report_progress(self.progress_callback, 'reading', stageId='reactivity-source')
        atoms = []; integrals = []; artifacts = []; backend = None; settlement = 'not-started'
        parameters = dict(hardnessConvention='eta=IP-EA;S=1/eta;omega=mu^2/(2eta)', tceHomoHartree=TCE_HOMO_HARTREE,
            tceReferenceLevel='B3LYP/6-31G*', tceLevelMatch=self.tce_level_match, degeneracyScreenEV=DEGENERACY_SCREEN_EV,
            orbitalRepresentation=self.representation, orbitalRepresentationEvidence=self.representation_evidence)
        if self.capabilities['condensed']:
            self.work_count += 1; work = Path(tempfile.mkdtemp(prefix='fmo-', dir=self.root))
            channel = self.frontier[0]; h = channel['homo']; l = channel['lumo']
            answers = ['8', '8', '1', str(h['nativeIndex']), str(l['nativeIndex']), '0', '-10', 'q']
            report_progress(self.progress_callback, 'running', stageId='reactivity-hirshfeld')
            output, backend, log = self._run_native(work, answers)
            self._current(); report_progress(self.progress_callback, 'parse', stageId='reactivity-integrals')
            tables = parse_hirshfeld_compositions(output, self.metadata, [h, l])
            atoms = condensed_atoms(self.metadata, tables[h['nativeIndex']]['values'], tables[l['nativeIndex']]['values'], self.metrics)
            integrals = [tables[o['nativeIndex']]['integral'] for o in (h, l)]
            raw = log.read_bytes(); artifacts = [dict(role='native-output', name=log.name, revision=hashlib.sha256(raw).hexdigest(), bytes=len(raw))]
            parameters.update(nativeMenu=' → '.join(answers), rawIntegralTolerance=RAW_INTEGRAL_TOLERANCE)
            points = re.search(r'(\d+) quadrature points are used for each atom', output)
            if points:
                parameters['quadraturePointsPerAtom'] = int(points[1])
            settlement = 'native-settled'
        self._check_stamp(request['stamp'])
        result = dict(stamp=copy.deepcopy(request['stamp']), approximation='frozen-orbital', partition='hirshfeld', globalMetrics=copy.deepcopy(self.metrics),
            frontier=copy.deepcopy(self.frontier), atoms=atoms, capabilities=copy.deepcopy(self.capabilities), notices=self.notices[:], integrals=integrals,
            provenance=dict(sourceId=self.source['sourceId'], sourceRevision=self.source_revision, sourceName=self.source.get('name', self.source_path.name),
                backend=backend, parameters=parameters, resources=copy.deepcopy(self.resources), rawArtifacts=artifacts, settlement=settlement))
        self.last_result = result
        return copy.deepcopy(result)

    def retained_memory_bytes(self):
        # Inspector retains metadata only; snapshot bytes and native output stay on disk.
        import json
        return len(json.dumps([self.source, self.metadata, self.last_result], ensure_ascii=False).encode('utf-8'))*2

    def stop_native(self):
        """Synchronous: owned process is terminated/waited before return, even on errors."""
        with self._native_lock:
            process, job = self.native, self.job
            if process is not None:
                MultiwfnSession._terminate(process, job)
                self.job = None  # Existing helper closes the lifetime guard.
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired as exc:
                    raise ReactivityError('reactivity-native-unsettled', 'Owned native process has not settled; no completion was reported.') from exc
            self.native = None; self.job = None

    def cancel(self):
        self.cancelled.set(); self.stop_native()

    def close(self):
        self.closed = True; self.cancel(); self.source = None; self.metadata = None; self.last_result = None

    def handle(self, payload):
        command = payload.get('command')
        try:
            if command == 'open':
                return self.open(payload)
            if command in ('run', 'analyze'):
                # Worker serializes commands and clears its own stop event for a
                # fresh explicit run. Clearing this service flag never resumes
                # a previous process or bypasses the external cancel callback.
                self.cancelled.clear()
                return self.analyze(payload)
            if command == 'close':
                self.close(); return dict(closed=True)
            raise ReactivityError('reactivity-command', 'Unsupported FMO analysis command.')
        finally:
            self.stop_native()
