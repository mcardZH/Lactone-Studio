"""Multiwfn AIM basin contract; raw integrals never inherit native normalization.

The first accepted source family is a finite, all-electron Gaussian FCHK. Other
families require their own density/reference/PBC evidence. No independent Bader
executable, promolecular approximation or nearest-atom reassignment is used.
"""
from __future__ import annotations
import math
import os
import queue
import re
import subprocess
import threading
import time
from orbitals import OrbitalError, _number

NUMBER = r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[EeDd][-+]?\d+)?'
BOHR_ANGSTROM = .529177210903
DEFAULTS = dict(spacingBohr=.1, paddingBohr=6., integration='mixed-exact')


def options(raw=None):
    raw = {} if raw is None else raw
    if not isinstance(raw, dict) or set(raw)-set(DEFAULTS):
        raise OrbitalError('bader-options', 'Unknown Bader grid/integration parameter.')
    value = {**DEFAULTS, **raw}
    for key, low, high in [('spacingBohr', .025, .5), ('paddingBohr', 3., 20.)]:
        number = value[key]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or not low <= number <= high:
            raise OrbitalError('bader-options', 'Bader '+key+' is outside its bounded range.')
    if value['integration'] != 'mixed-exact':
        raise OrbitalError('bader-options', 'Bader requires mixed atomic-center grids with exact boundary refinement.')
    return value


def _fields(text, wanted):
    lines = text.splitlines(); found = {}; i = 2
    pattern = re.compile(r'^(.+?)\s+([IR])\s+(?:N=\s*(\d+)|([^\s]+))\s*$')
    while i < len(lines):
        match = pattern.match(lines[i]); i += 1
        if not match or match[1].strip() not in wanted:
            continue
        name, kind, count, scalar = match.groups(); name = name.strip()
        if name in found:
            raise OrbitalError('bader-source', 'Duplicate reference field: '+name)
        values = []
        if count is None:
            values = [_number(scalar)]
        else:
            count = int(count)
            if count > 100000:
                raise OrbitalError('bader-source', 'Reference field exceeds the atom budget.')
            while i < len(lines) and len(values) < count and not pattern.match(lines[i]):
                values.extend(_number(v) for v in lines[i].split()); i += 1
            if len(values) != count:
                raise OrbitalError('bader-source', 'Incomplete reference field: '+name)
        if kind == 'I' and any(v != int(v) for v in values):
            raise OrbitalError('bader-source', 'Noninteger reference field: '+name)
        found[name] = values if count is not None else values[0]
    return found


def source_reference(text, metadata):
    if metadata['format'] != 'fchk':
        raise OrbitalError('bader-source-scope', 'Bader Molden/Cube 输入尚缺已接受的电子表示、核参考与周期证据；当前原生链仅接受全电子非周期 FCHK。')
    fields = _fields(text, {'Nuclear charges', 'ECP-RNFroz', 'ECP-LenNCZ', 'Number of translation vectors', 'Number of electrons'})
    atoms = metadata['atoms']; nuclei = fields.get('Nuclear charges')
    if not isinstance(nuclei, list) or len(nuclei) != len(atoms) or any(abs(z-a['atomicNumber']) > 1e-8 for z, a in zip(nuclei, atoms)):
        raise OrbitalError('bader-reference', 'Bader requires explicit all-electron nuclear charges equal to atomic numbers; ECP/valence reference is not inferred.')
    frozen = fields.get('ECP-RNFroz')
    if frozen is not None and (not isinstance(frozen, list) or len(frozen) != len(atoms) or any(v != 0 for v in frozen)):
        raise OrbitalError('bader-ecp', 'ECP density/EDF reconstruction needs a separately accepted electron/reference convention.')
    if fields.get('ECP-LenNCZ', 0) != 0:
        raise OrbitalError('bader-ecp', 'ECP coefficients are outside the accepted all-electron basin route.')
    if fields.get('Number of translation vectors') != 0:
        raise OrbitalError('bader-periodic', 'Bader requires explicit zero translation vectors; periodic basin integration is not yet accepted.')
    expected = sum(o['occupation'] for o in metadata['orbitals'])
    charge = metadata.get('charge')
    if charge is None or expected <= 0 or fields.get('Number of electrons') != expected or abs(sum(nuclei)-charge-expected) > 1e-8:
        raise OrbitalError('bader-electrons', 'Source occupations, explicit electron count, nuclear references and charge disagree.')
    return dict(electronRepresentation='all-electron', referenceConvention='nuclear-charge', referenceCharges=nuclei, expectedElectronCount=expected, expectedCharge=charge)


def grid_plan(atoms, basis_count, source_bytes, raw=None, threads=1):
    config = options(raw); spacing = config['spacingBohr']; padding = config['paddingBohr']
    if not atoms:
        raise OrbitalError('bader-grid', 'Bader grid requires source atoms.')
    positions = [a['positionBohr'] for a in atoms]
    if any(len(p) != 3 or any(not math.isfinite(x) or abs(x) > 1e6 for x in p) for p in positions):
        raise OrbitalError('bader-grid', 'Bader source coordinates exceed the finite grid range.')
    origin = [min(p[k] for p in positions)-padding for k in range(3)]
    dimensions = [math.ceil((max(p[k] for p in positions)+padding-origin[k])/spacing-1e-10)+1 for k in range(3)]
    points = math.prod(dimensions)
    # Conservative engineering estimate, not a mathematical allocation proof.
    # The owned Windows job separately enforces the effective process limit.
    padded = math.prod(n+4 for n in dimensions)
    if isinstance(threads,bool) or not isinstance(threads,int) or threads<1:
        raise OrbitalError('bader-memory', 'Bader grid plan requires the effective native thread count.')
    thread_stack_bytes=threads*200*1024**2
    # 320 MiB fixed allowance includes the native main-stack/runtime footprint;
    # 128 MiB underestimated the observed 2026.7.15 two-thread water commit.
    estimated = 320*1024**2 + basis_count**2*128 + source_bytes*5 + padded*256 + len(atoms)*1024**2 + thread_stack_bytes
    return dict(originBohr=origin, spacingBohr=[spacing]*3, dimensions=dimensions, pointCount=points,
                paddedPointCount=padded, estimatedMemoryBytes=estimated, integration=config['integration'],
                paddingBohr=padding, threads=threads, threadStackBytes=thread_stack_bytes)


def assert_budget(plan, budget):
    if isinstance(budget, bool) or not isinstance(budget, int) or budget <= 0:
        raise OrbitalError('bader-memory', 'Bader explicit grid and workspace exceed the effective shared native memory budget.')


class BaderDialogue:
    """Fail-closed prompt protocol, with bounded explicit NNA acknowledgements.

    The main-17 menu was inspected on 2026.7.15: explicit origin/vector/dimensions
    is option 7, NOT main-5's option 5. Subsequent prompts must identify their
    meaning before any coordinate/dimension response is sent.
    """
    def __init__(self, plan, atom_count):
        self.plan = plan; self.state = 'main'; self.pending = ''; self.nna = set()
        self.max_nna = min(10000, max(32, atom_count*8)); self.done = False

    def feed(self, chunk):
        self.pending += chunk.replace('\r', '')
        if len(self.pending) > 1024*1024:
            raise OrbitalError('bader-menu', 'Unrecognized Bader prompt/output exceeds its bounded window.')
        text = self.pending; answer = None; next_state = None
        nna = re.search(r'Unable to determine the attractor\s+(\d+)\s+belongs to which atom!(.*?)Else you should input q to return[^\n]*', text, re.S)
        if nna:
            basin = int(nna[1])
            if self.state != 'integrating' or basin in self.nna or len(self.nna) >= self.max_nna or 'non-nuclear attractor' not in nna[2]:
                raise OrbitalError('bader-nna-prompt', 'Unexpected, repeated or excessive basin ownership prompt.')
            self.nna.add(basin); self.pending = text[nna.end():]
            # Empty acknowledgement preserves a native NNA. Parser still requires
            # every real nucleus to have its own uniquely evidenced basin.
            return ['']
        if self.state == 'main' and '************ Main function menu' in text:
            answer, next_state = '17', 'basin'
        elif self.state == 'basin' and '1 Generate basins and locate attractors' in text:
            answer, next_state = '1', 'density'
        elif self.state == 'density' and '1 Electron density (rho)' in text:
            answer, next_state = '1', 'grid'
        elif self.state == 'grid' and '7 Input original point, translation vector and the number of points' in text:
            answer, next_state = '7', 'origin'
        elif self.state == 'origin' and re.search(r'Input[^\n]*(?:original point|origin(?:al)? coordinate)', text, re.I):
            answer, next_state = ','.join(map(str, self.plan['originBohr'])), 'spacing'
        elif self.state == 'spacing' and re.search(r'Input[^\n]*(?:translation vector|grid spacings)', text, re.I):
            answer, next_state = ','.join(map(str, self.plan['spacingBohr'])), 'dimensions'
        elif self.state == 'dimensions' and re.search(r'Input[^\n]*(?:number of points|number of grids)[^\n]*(?:X|three)', text, re.I):
            answer, next_state = ','.join(map(str, self.plan['dimensions'])), 'generated'
        elif self.state == 'generated':
            if re.search(r'1\s+Do nothing', text, re.I) and 'insignificant' in text.lower():
                self.pending = ''; return ['1']  # Retain rather than reassign to nearest attractors.
            if re.search(r'7\s+Integrate real space functions in AIM basins', text):
                answer, next_state = '7', 'integration-options'
        elif self.state == 'integration-options' and re.search(r'2[^\n]*exact refinement', text, re.I):
            answer, next_state = '2', 'integrand'
        elif self.state == 'integrand' and '1 Electron density (rho)' in text:
            answer, next_state = '1', 'integrating'
        elif self.state == 'integrating' and 'The atomic charges after normalization and atomic volumes:' in text and re.search(r'7\s+Integrate real space functions in AIM basins', text):
            answer, next_state = '-10', 'return-main'
        elif self.state == 'return-main' and '************ Main function menu' in text:
            answer, next_state = 'q', 'closed'; self.done = True
        if answer is None:
            return []
        self.state = next_state; self.pending = ''; return [answer]


def run_bader_native(executable, work, plan, atom_count, budget, env, progress=None, timeout=None, telemetry=None):
    """One owned native process. Unknown prompts cannot consume guessed answers."""
    from orbitals import _windows_owned_job, MultiwfnSession
    from multiwfn_progress import NativeProgressScanner, native_output_chunks
    assert_budget(plan, budget)
    dialogue = BaderDialogue(plan, atom_count); pending = queue.Queue(); output = bytearray()
    process = subprocess.Popen([str(executable), 'source.fchk'], cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    job = _windows_owned_job(process, budget); scanner = NativeProgressScanner(progress)
    usage=dict(pid=process.pid,hardBudgetBytes=budget,windowsJobAttached=job is not None,limitType='JOB_OBJECT_LIMIT_PROCESS_MEMORY',killOnJobClose=job is not None)
    def sample_memory():
        if os.name!='nt': return
        import ctypes
        class Counters(ctypes.Structure):
            _fields_=[('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong)]+[(name,ctypes.c_size_t) for name in ('PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage')]
        counters=Counters();counters.cb=ctypes.sizeof(counters)
        psapi=ctypes.WinDLL('psapi',use_last_error=True);psapi.GetProcessMemoryInfo.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong]
        if psapi.GetProcessMemoryInfo(int(process._handle),ctypes.byref(counters),counters.cb):
            usage['peakWorkingSetBytes']=max(usage.get('peakWorkingSetBytes',0),int(counters.PeakWorkingSetSize))
            usage['peakCommitBytes']=max(usage.get('peakCommitBytes',0),int(counters.PeakPagefileUsage))
    def read():
        try:
            for chunk in native_output_chunks(process.stdout):
                pending.put(chunk)
        finally:
            pending.put(None)
    threading.Thread(target=read, daemon=True).start(); deadline = None if timeout is None else time.monotonic()+timeout
    try:
        while deadline is None or time.monotonic() < deadline:
            sample_memory()
            try: chunk = pending.get(timeout=.1)
            except queue.Empty: continue
            if chunk is None:
                break
            output.extend(chunk)
            text = chunk.decode('utf-8', errors='replace'); scanner.feed(text)
            for answer in dialogue.feed(text):
                process.stdin.write((answer+'\n').encode('ascii')); process.stdin.flush()
        if process.poll() is None:
            try: process.wait(timeout=None if deadline is None else min(1., max(.001, deadline-time.monotonic())))
            except subprocess.TimeoutExpired:
                raise OrbitalError('bader-menu-timeout', 'Bader stopped at an unrecognized prompt or exceeded its bounded deadline; no guessed response was sent.')
        if process.returncode != 0 or not dialogue.done:
            raise OrbitalError('bader-native', 'Bader did not complete the recognized basin integration protocol.')
        return output.decode('utf-8', errors='replace').replace('\r', '')
    finally:
        sample_memory()
        MultiwfnSession._terminate(process, job)
        usage.update(closed=process.poll() is not None,returncode=process.returncode,dialogueState=dialogue.state)
        if telemetry is not None:
            try: telemetry(usage)
            except Exception: pass  # Observation never changes scientific work.
        (work/'native-output.txt').write_bytes(output)


def parse_bader(output, metadata, reference, plan):
    """Parse complete native basin evidence, not .chg or normalized charge alone."""
    header = re.search(r'Total/Alpha/Beta electrons:\s*('+NUMBER+r')\s*('+NUMBER+r')\s*('+NUMBER+r')', output)
    if not header or abs(_number(header[1])-reference['expectedElectronCount']) > 1e-6 or abs(_number(header[2])+_number(header[3])-_number(header[1])) > 1e-6:
        raise OrbitalError('bader-native-electrons', 'Native loaded electron count disagrees with the immutable all-electron source.')
    if not re.search(r'Integrate[^\n]*exact refinement|Integrate and meantime refine basin boundary|exact refinement of basin boundary', output, re.I):
        raise OrbitalError('bader-integration', 'Native exact boundary refinement was not confirmed.')
    grids = re.findall(r'Number of points in X,Y,Z\s*(?:is|:)\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+Total:\s*\d+)?\s*$', output, re.M)
    if not grids or list(map(int, grids[-1])) != plan['dimensions']:
        raise OrbitalError('bader-grid-proof', 'Native grid dimensions differ or are unconfirmed.')
    for label,key in [('Coordinate of origin in X,Y,Z is','originBohr'),('Grid spacing in X,Y,Z is','spacingBohr')]:
        found=re.findall(re.escape(label)+r'\s+('+NUMBER+r')\s+('+NUMBER+r')\s+('+NUMBER+r')\s+Bohr',output)
        if not found or any(abs(_number(n)-v)>6e-7 for n,v in zip(found[-1],plan[key])):
            raise OrbitalError('bader-grid-proof','Native grid origin/spacing differs or has no explicit Bohr evidence.')
    tables = re.findall(r'#Basin\s+Integral\(a\.u\.\)\s+Vol\(Bohr\^3\)\s+Vol\(rho>0\.001\)\s*\n(.*?)Sum of above integrals:\s*('+NUMBER+r')', output, re.S)
    if not tables:
        raise OrbitalError('bader-output', 'Complete raw mixed-grid basin integral table is absent.')
    body, reported = tables[-1]; basins = {}; table_sum = _number(reported)
    for line in body.splitlines():
        if not line.strip():
            continue
        row = re.fullmatch(r'\s*(\d+)\s+('+NUMBER+r')\s+('+NUMBER+r')\s+('+NUMBER+r')\s*', line)
        if not row or int(row[1]) in basins:
            raise OrbitalError('bader-output', 'Malformed or duplicate raw basin row.')
        basin_id = int(row[1]); population = _number(row[2]); volume = _number(row[3]); vdvolume = _number(row[4])
        if basin_id < 1 or population < 0 or volume < 0 or vdvolume < 0 or vdvolume > volume+1e-5:
            raise OrbitalError('bader-output', 'Invalid raw basin population/volume.')
        basins[basin_id] = dict(basinId=basin_id, electronPopulation=population, volumeBohr3=volume, vdWVolumeBohr3=vdvolume)
    raw_sum=sum(b['electronPopulation'] for b in basins.values())
    if not basins or abs(raw_sum-table_sum) > max(2e-7, len(basins)*1e-9):
        raise OrbitalError('bader-integral-sum', 'Native raw basin sum disagrees with its individual integrals.')
    attractors = re.findall(r'Attractor\s+X,Y,Z coordinate \((Angstrom|Bohr)\)\s+Value\s*\n(.*?)(?=\n\s*\n|\n\s*(?:The number|Detecting boundary)|\n\s*[-*]|\Z)', output, re.S)
    if not attractors:
        raise OrbitalError('bader-attractors', 'Native attractor coordinates and units are absent.')
    unit, body = attractors[-1]; coordinates = {}
    for line in body.splitlines():
        row = re.fullmatch(r'\s*(\d+)\s+('+NUMBER+r')\s+('+NUMBER+r')\s+('+NUMBER+r')\s+('+NUMBER+r')\s*', line)
        if not row or int(row[1]) in coordinates:
            raise OrbitalError('bader-attractors', 'Ambiguous attractor coordinate table.')
        coordinates[int(row[1])] = [_number(row[k])/(BOHR_ANGSTROM if unit == 'Angstrom' else 1) for k in (2, 3, 4)]
    if set(coordinates) != set(basins):
        raise OrbitalError('bader-attractors', 'Attractor IDs and integrated basin IDs differ.')
    factors = re.findall(r'Normalization factor of the integral of electron density is\s*('+NUMBER+r')', output)
    if not factors:
        raise OrbitalError('bader-normalization', 'Native normalization provenance is absent.')
    factor = _number(factors[-1])
    if factor <= 0 or abs(factor-table_sum/reference['expectedElectronCount']) > 1e-6:
        raise OrbitalError('bader-normalization', 'Native normalization factor disagrees with raw integrals.')
    # Native prints only six decimal places for this factor. Use the full raw
    # ratio to cross-check its normalized charges, retaining the printed factor
    # separately rather than amplifying its rounding error for heavy nuclei.
    ratio = raw_sum/reference['expectedElectronCount']
    charge_tables = re.findall(r'The atomic charges after normalization and atomic volumes:\s*\n(.*?)(?=\n\s*\n|\n\s*[-*]|\Z)', output, re.S)
    if not charge_tables:
        raise OrbitalError('bader-normalization', 'Native normalized charges are absent.')
    atom_charges = {}; nna_charges = {}
    for line in charge_tables[-1].splitlines():
        row = re.fullmatch(r'\s*(\d+)\s*\(\s*([A-Za-z]+)\s*\)\s+Charge:\s*('+NUMBER+r')\s+Volume:\s*('+NUMBER+r')\s+Bohr\^3\s*', line)
        if not row:
            raise OrbitalError('bader-normalization', 'Malformed native normalized charge table.')
        target = nna_charges if row[2] == 'NNA' else atom_charges; index = int(row[1])
        if index in target:
            raise OrbitalError('bader-normalization', 'Duplicate normalized atom/basin identity.')
        target[index] = (row[2], _number(row[3]))
    from wavefunction_analysis import SYMBOLS
    atoms = []; seen_atoms = set(); native_mapping={}
    for basin_id,source_index,element in re.findall(r'Attractor\s+(\d+)\s+corresponds to atom\s+(\d+)\s*\(\s*([A-Za-z]+)\s*\)',output):
        basin_id=int(basin_id)
        if basin_id in native_mapping:
            raise OrbitalError('bader-atom-map','Duplicate native attractor/atom correspondence.')
        native_mapping[basin_id]=(int(source_index),element)
    # A sampled nuclear maximum must lie within its own grid voxel. This is a
    # bounded unique proximity proof, not an unconditional nearest-atom mapping.
    radius = math.sqrt(sum(x*x for x in plan['spacingBohr']))+1e-7
    for basin_id, basin in basins.items():
        position = coordinates[basin_id]; basin['attractorPositionBohr'] = position
        candidates = [i for i, a in enumerate(metadata['atoms']) if math.dist(position, a['positionBohr']) <= radius]
        if len(candidates) > 1:
            raise OrbitalError('bader-atom-map', 'Attractor lies within multiple nuclear grid neighborhoods.')
        if not candidates:
            if basin_id not in nna_charges or abs(nna_charges[basin_id][1]+basin['electronPopulation']/ratio) > 2e-5:
                raise OrbitalError('bader-nna', 'Non-atomic basin lacks native NNA identity/charge evidence; it was not assigned to a nearby atom.')
            if basin_id in native_mapping:raise OrbitalError('bader-nna','Native nuclear mapping contradicts non-nuclear basin identity.')
            basin.update(role='non-nuclear', referenceCharge=0., netCharge=-basin['electronPopulation'],mappingEvidence='native-nna-and-nonnuclear-position')
            continue
        index = candidates[0]; source_index = index+1; element = SYMBOLS[metadata['atoms'][index]['atomicNumber']]
        if source_index in seen_atoms or source_index not in atom_charges or atom_charges[source_index][0] != element or basin_id in nna_charges or native_mapping.get(basin_id)!=(source_index,element):
            raise OrbitalError('bader-atom-map', 'Native atom identity or unique atomic basin mapping is incomplete.')
        seen_atoms.add(source_index); nuclear = reference['referenceCharges'][index]; population = basin['electronPopulation']; value = nuclear-population
        if abs(nuclear-population/ratio-atom_charges[source_index][1]) > 2e-5:
            raise OrbitalError('bader-atom-map', 'Raw population, nuclear reference and native normalized charge disagree for an atom.')
        basin.update(role='atomic', sourceIndex=source_index, atomId=f'a{source_index}', referenceCharge=nuclear, netCharge=value,mappingEvidence='native-atom-and-voxel')
        atoms.append(dict(atomId=f'a{source_index}', sourceIndex=source_index, element=element, value=value, electronPopulation=population, referenceCharge=nuclear, basinIds=[basin_id]))
    if seen_atoms != set(range(1, len(metadata['atoms'])+1)) or set(atom_charges) != seen_atoms or set(nna_charges) != {i for i, b in basins.items() if b['role'] == 'non-nuclear'}:
        raise OrbitalError('bader-atom-map', 'Not every source atom and native non-nuclear basin has a unique complete result.')
    def remainder(kind, label):
        counts = re.findall(label+r':\s*(\d+)', output)
        if not counts:
            raise OrbitalError('bader-unassigned', 'Native '+kind+' grid count is absent; no zero was invented.')
        count = int(counts[-1]); integrals = re.findall(r'Integral of '+kind+r' grids:\s*('+NUMBER+r')', output, re.I)
        if not integrals and count:
            raise OrbitalError('bader-unassigned', 'Nonzero '+kind+' grids lack a raw integral.')
        population = _number(integrals[-1]) if integrals else 0.
        if population < 0 or (count == 0 and population != 0):
            raise OrbitalError('bader-unassigned', 'Remainder grid count and population disagree.')
        return dict(gridCount=count, electronPopulation=population, evidence='native-integral' if integrals else 'explicit-zero-grid-count')
    unassigned = remainder('unassigned', r'The number of unassigned grids')
    boundary = remainder('boundary', r'The number of grids travelled to box boundary')
    total = raw_sum+unassigned['electronPopulation']+boundary['electronPopulation']; expected = reference['expectedElectronCount']
    atoms.sort(key=lambda a: a['sourceIndex'])
    return dict(unit='e', quantity='net-charge', atoms=atoms, sum=sum(a['value'] for a in atoms), spinAvailable=False,
                chargeConvention='raw: nuclear charge minus unnormalized basin electron population',
                bader=dict(electronRepresentation='all-electron', referenceConvention='nuclear-charge', basins=list(basins.values()), unassigned=unassigned, boundary=boundary,
                           expectedElectronCount=expected, integratedElectronCount=total, electronResidual=expected-total,
                           chargeIncludingNonAtomicBasins=sum(reference['referenceCharges'])-total,
                           normalizationFactor=factor, nativeNormalizedCharges=[dict(sourceIndex=i, value=q) for i, (_, q) in sorted(atom_charges.items())],
                           grid=plan, integrationMethod='mixed-exact', scientificAcceptance='pending-native-calibration'))
