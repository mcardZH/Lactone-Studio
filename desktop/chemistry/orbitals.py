"""Local Multiwfn orbital adapter. No generated grid survives session close.

The desktop host owns source access, user-selected executable and session lifetime.
All coordinates and grid vectors crossing this boundary are in Bohr. MO indices
are the source's one-based channel indices, never a guessed frontier label.
"""
from __future__ import annotations

import hashlib
from array import array
import math
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time

import numpy as np
from multiwfn_resources import resolve_resources, total_physical_memory, native_binary_identity


def _windows_owned_job(process, memory_limit=None):
    """Kernel lifetime guard: a killed Python worker cannot orphan Multiwfn."""
    if os.name!='nt': return None
    import ctypes
    from ctypes import wintypes as w
    class Basic(ctypes.Structure):
        _fields_=[('ProcessTime',ctypes.c_longlong),('JobTime',ctypes.c_longlong),('Flags',w.DWORD),
                  ('MinWorkingSet',ctypes.c_size_t),('MaxWorkingSet',ctypes.c_size_t),('ActiveProcesses',w.DWORD),
                  ('Affinity',ctypes.c_size_t),('Priority',w.DWORD),('Scheduling',w.DWORD)]
    class Io(ctypes.Structure):
        _fields_=[(name,ctypes.c_ulonglong) for name in ('ReadOperations','WriteOperations','OtherOperations','ReadBytes','WriteBytes','OtherBytes')]
    class Extended(ctypes.Structure):
        _fields_=[('Basic',Basic),('Io',Io),('ProcessMemoryLimit',ctypes.c_size_t),('JobMemoryLimit',ctypes.c_size_t),
                  ('PeakProcessMemory',ctypes.c_size_t),('PeakJobMemory',ctypes.c_size_t)]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,w.LPCWSTR]; kernel.CreateJobObjectW.restype=w.HANDLE
    kernel.SetInformationJobObject.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]; kernel.SetInformationJobObject.restype=w.BOOL
    kernel.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE]; kernel.AssignProcessToJobObject.restype=w.BOOL
    kernel.CloseHandle.argtypes=[w.HANDLE]; kernel.CloseHandle.restype=w.BOOL
    job=kernel.CreateJobObjectW(None,None); info=Extended(); info.Basic.Flags=0x2000 # KILL_ON_JOB_CLOSE
    if memory_limit:
        info.Basic.Flags |= 0x100 # JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info.ProcessMemoryLimit=int(memory_limit)
    if not job or not kernel.SetInformationJobObject(job,9,ctypes.byref(info),ctypes.sizeof(info)) or not kernel.AssignProcessToJobObject(job,int(process._handle)):
        if job: kernel.CloseHandle(job)
        process.kill(); process.wait(timeout=5)
        raise OrbitalError('backend-lifetime','Cannot attach the owned Multiwfn process to its Windows lifetime guard.')
    return kernel,job


class OrbitalError(ValueError):
    def __init__(self, code, message, diagnostics=None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics


def _native_memory_snapshot(process):
    """Read OS counters, not PE virtual sizes or an inferred resident size."""
    if os.name != 'nt' or process is None: return {}
    import ctypes
    from ctypes import wintypes as w
    class Counters(ctypes.Structure):
        _fields_ = [('cb', w.DWORD), ('faults', w.DWORD)] + [(name, ctypes.c_size_t) for name in
            ('peakWorkingSetBytes', 'workingSetBytes', 'peakPagedPool', 'pagedPool',
             'peakNonPagedPool', 'nonPagedPool', 'privateCommitBytes', 'peakPrivateCommitBytes', 'privateUsage')]
    try:
        counters = Counters(); counters.cb = ctypes.sizeof(counters)
        api = ctypes.WinDLL('psapi', use_last_error=True).GetProcessMemoryInfo
        api.argtypes = [w.HANDLE, ctypes.POINTER(Counters), w.DWORD]; api.restype = w.BOOL
        if not api(int(process._handle), ctypes.byref(counters), counters.cb): return {}
        return {key: int(getattr(counters, key)) for key in
                ('peakWorkingSetBytes', 'workingSetBytes', 'privateCommitBytes', 'peakPrivateCommitBytes')}
    except (AttributeError, OSError, ValueError):
        return {}


def _number(raw):
    try:
        value = float(raw.replace('D', 'E').replace('d', 'e'))
    except (ValueError, AttributeError):
        raise OrbitalError('source-number', 'Wavefunction contains an invalid number.')
    if not math.isfinite(value):
        raise OrbitalError('source-number', 'Wavefunction contains a non-finite number.')
    return value


def _integer(value, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value or value < minimum:
        raise OrbitalError('integer', 'Expected a finite integer in the supported range.')
    return int(value)


class _FileLines:
    """Compact byte offsets, with on-demand UTF-8 decoding of source records.

    Coefficient blocks are validated in their original order without retaining
    a second full wavefunction string or a list of every coefficient line.
    """
    def __init__(self, path):
        self.stream=Path(path).open('rb');self.offsets=array('Q',[0]);digest=hashlib.sha256();offset=0;previous_cr=False
        for raw in iter(lambda:self.stream.read(1024*1024),b''):
            digest.update(raw)
            skip=1 if previous_cr and raw.startswith(b'\n') else 0
            if skip:self.offsets[-1]+=1
            for match in re.finditer(rb'\r\n|\r|\n',raw[skip:]):self.offsets.append(offset+skip+match.end())
            previous_cr=raw.endswith(b'\r');offset+=len(raw)
        if self.offsets[-1]==offset:self.offsets.pop()
        self.bytes=offset;self.sha256=digest.hexdigest()
    def splitlines(self):return self
    def __len__(self):return len(self.offsets)
    def __iter__(self):
        for index in range(len(self)):yield self[index]
    def __getitem__(self,index):
        if isinstance(index,slice):return (self[i] for i in range(*index.indices(len(self))))
        if index<0:index+=len(self)
        if not 0<=index<len(self):raise IndexError(index)
        self.stream.seek(self.offsets[index]);end=self.offsets[index+1] if index+1<len(self) else self.bytes;raw=self.stream.read(end-self.offsets[index])
        try:return raw.decode('utf-8-sig' if index==0 else 'utf-8').rstrip('\r\n')
        except UnicodeDecodeError as exc:raise OrbitalError('source-encoding','Wavefunction must be valid UTF-8/ASCII text.') from exc
    def close(self):self.stream.close()


def _fchk_metadata(text):
    lines = text.splitlines()
    fields, provenance = {}, {}
    pattern = re.compile(r'^(.+?)\s+([IR])\s+(?:N=\s*(\d+)|([^\s]+))\s*$')
    wanted = {'Charge', 'Multiplicity', 'Number of atoms', 'Atomic numbers', 'Current cartesian coordinates', 'Number of basis functions',
              'Number of independent functions', 'Number of independant functions', 'Number of alpha electrons',
              'Number of beta electrons', 'Shell types', 'Number of primitives per shell', 'Shell to atom map',
              'Primitive exponents', 'Contraction coefficients', 'P(S=P) Contraction coefficients',
              'Alpha Orbital Energies', 'Beta Orbital Energies', 'Alpha MO coefficients', 'Beta MO coefficients',
              'Alpha Orbital Occupation Numbers', 'Beta Orbital Occupation Numbers'}
    i = 2
    while i < len(lines):
        m = pattern.match(lines[i]); line = i + 1; i += 1
        if not m:
            continue
        label, kind, count, scalar = m.groups(); label = label.strip()
        if label not in wanted:
            continue
        if label in fields:
            raise OrbitalError('duplicate-field', 'Duplicate FCHK wavefunction field: ' + label)
        provenance[label] = line
        if count is None:
            fields[label] = _number(scalar)
            continue
        count = _integer(int(count))
        values = []; seen = 0; coefficient_count_only = label.endswith('MO coefficients')
        while seen < count and i < len(lines):
            if pattern.match(lines[i]):
                break
            row = [_number(v) for v in lines[i].split()]; seen += len(row)
            if not coefficient_count_only: values.extend(row)
            i += 1
        if seen != count:
            raise OrbitalError('truncated-field', 'Incomplete FCHK wavefunction field: ' + label)
        if kind == 'I' and any(v != int(v) for v in values):
            raise OrbitalError('source-integer', 'Non-integer FCHK integer field.')
        fields[label] = count if coefficient_count_only else values
    def required(label):
        if label not in fields:
            raise OrbitalError('missing-field', 'Required FCHK wavefunction field is missing: ' + label)
        return fields[label]
    natoms = _integer(required('Number of atoms'), 1)
    numbers = required('Atomic numbers'); positions = required('Current cartesian coordinates')
    if len(numbers) != natoms or len(positions) != 3 * natoms:
        raise OrbitalError('atom-count', 'FCHK atom arrays disagree.')
    basis = _integer(required('Number of basis functions'), 1)
    shells = required('Shell types'); counts = required('Number of primitives per shell'); mapping = required('Shell to atom map')
    def shell_size(shell):
        shell = int(shell)
        if shell == -1:
            return 4
        if abs(shell) > 6:
            raise OrbitalError('basis-shell', 'Unsupported FCHK angular momentum declaration.')
        return (shell + 1) * (shell + 2) // 2 if shell >= 0 else 2 * abs(shell) + 1
    if not (len(shells) == len(counts) == len(mapping)) or sum(map(shell_size, shells)) != basis:
        raise OrbitalError('basis-count', 'FCHK shell declarations disagree with the basis count.')
    for count, atom in zip(counts, mapping):
        _integer(count, 1)
        if not 1 <= _integer(atom, 1) <= natoms:
            raise OrbitalError('basis-atom', 'FCHK shell references an absent atom.')
    nprimitive = sum(map(int, counts))
    if len(required('Primitive exponents')) != nprimitive or len(required('Contraction coefficients')) != nprimitive:
        raise OrbitalError('primitive-count', 'FCHK primitive arrays disagree.')
    if any(v <= 0 for v in fields['Primitive exponents']):
        raise OrbitalError('primitive-exponent', 'Primitive exponents must be positive.')
    if -1 in shells and len(required('P(S=P) Contraction coefficients')) != nprimitive:
        raise OrbitalError('primitive-count', 'FCHK SP coefficient array disagrees.')
    unrestricted = 'Beta MO coefficients' in fields or 'Beta Orbital Energies' in fields
    orbitals = []
    for channel, prefix in ([('alpha', 'Alpha'), ('beta', 'Beta')] if unrestricted else [('restricted', 'Alpha')]):
        energies = required(prefix + ' Orbital Energies'); coeff = required(prefix + ' MO coefficients')
        if coeff != basis * len(energies) or not energies or len(energies)>basis:
            raise OrbitalError('coefficient-count', 'FCHK MO coefficient count disagrees with the declared basis and orbitals.')
        explicit = fields.get(prefix + ' Orbital Occupation Numbers')
        if explicit is not None and (len(explicit) != len(energies) or any(v < 0 or v > (2 if channel == 'restricted' else 1) for v in explicit)):
            raise OrbitalError('occupation', 'Invalid FCHK orbital occupation array.')
        na = _integer(required('Number of alpha electrons')); nb = _integer(required('Number of beta electrons'))
        occupied = na if prefix == 'Alpha' else nb
        if max(na, nb) > len(energies):
            raise OrbitalError('spin-count', 'FCHK electron counts disagree with the orbital channels.')
        for index, energy in enumerate(energies, 1):
            occupation = explicit[index-1] if explicit is not None else ((int(index<=na)+int(index<=nb)) if channel=='restricted' else int(index<=occupied))
            orbitals.append(dict(id=f'{channel}:{index}', spin=channel, index=index, sourceIndex=index, displayIndex=index,
                                 multiwfnIndex=index+(len(fields.get('Alpha Orbital Energies',[])) if channel=='beta' else 0), energyHartree=energy, occupation=occupation,
                                 sourceLine=provenance[prefix + ' Orbital Energies'], sourceField=prefix + ' Orbital Energies',
                                 occupationSource=prefix + ' Orbital Occupation Numbers' if explicit is not None else 'Number of alpha/beta electrons'))
    charge=fields.get('Charge'); multiplicity=fields.get('Multiplicity')
    if charge is not None and int(charge)!=charge: raise OrbitalError('charge','FCHK charge must be an integer.')
    if multiplicity is not None: multiplicity=_integer(multiplicity,1)
    return dict(format='fchk', charge=int(charge) if charge is not None else None, multiplicity=multiplicity,
                atoms=[dict(atomicNumber=_integer(z, 1), positionBohr=positions[3*i:3*i+3]) for i,z in enumerate(numbers)],
                basisCount=basis, shellTypes=sorted(set(map(int, shells))), orbitals=orbitals,
                basisConvention='Gaussian FCHK shell type/order; evaluation delegated to Multiwfn')


def _molden_metadata(text):
    lines = text.splitlines()
    sections = []
    for i, line in enumerate(lines):
        m = re.match(r'^\s*\[([^]]+)\](.*)$', line)
        if m:
            if m[1].strip().lower() == 'cell' and not m[2].strip():
                raise OrbitalError('molden-periodic-unsupported', 'Molden [Cell] is not supported by this entry; the cell cannot be discarded to read an isolated molecule.')
            sections.append((m[1].strip().lower(), m[2].strip(), i))
    def section(name):
        found = [(suffix, start+1, sections[k+1][2] if k+1 < len(sections) else len(lines)) for k,(tag,suffix,start) in enumerate(sections) if tag == name]
        if len(found) != 1:
            raise OrbitalError('molden-section', 'Molden needs exactly one [' + name + '] section.')
        return found[0]
    units, start, end = section('atoms')
    if units.upper() not in ('AU', 'ANGS'):
        raise OrbitalError('coordinate-unit', 'Molden atom units must explicitly be AU or Angs.')
    factor = 1 if units.upper() == 'AU' else 1 / 0.529177210903
    atoms = []
    for line in lines[start:end]:
        if not line.strip(): continue
        p = line.split()
        if len(p) != 6 or _integer(_number(p[1]), 1) != len(atoms)+1:
            raise OrbitalError('molden-atoms', 'Molden atom order is incomplete or ambiguous.')
        atoms.append(dict(atomicNumber=_integer(_number(p[2]),1), positionBohr=[_number(v)*factor for v in p[3:]]))
    if not atoms:
        raise OrbitalError('molden-atoms', 'Molden has no atoms.')
    tags = {tag.upper() for tag,_,_ in sections}
    # Molden's unmarked higher shells are Cartesian; explicit combined tags are supported.
    spherical = {2: any('5D' in t for t in tags), 3: any('7F' in t for t in tags), 4: any('9G' in t for t in tags)}
    for l, a, b in [(2,'5D','6D'),(3,'7F','10F'),(4,'9G','15G')]:
        if any(a in t for t in tags) and any(b in t for t in tags):
            raise OrbitalError('basis-convention', 'Conflicting Molden spherical/Cartesian declarations.')
    _, start, end = section('gto'); basis = 0; i = start; atom = None; shell_types = []
    while i < end:
        p = lines[i].split(); i += 1
        if not p: continue
        if len(p) == 2 and p[0].isdigit() and p[1] == '0':
            atom = _integer(int(p[0]),1)
            if atom > len(atoms): raise OrbitalError('basis-atom', 'Molden GTO references an absent atom.')
            continue
        shell = p[0].lower()
        if atom is None or shell not in ('s','p','d','f','g','sp') or len(p) != 3:
            raise OrbitalError('molden-basis', 'Unsupported or incomplete Molden GTO declaration.')
        n = _integer(_number(p[1]),1); _number(p[2])
        for _ in range(n):
            if i >= end: raise OrbitalError('molden-basis', 'Truncated Molden primitive list.')
            row = lines[i].split(); i += 1
            if len(row) != (3 if shell == 'sp' else 2) or _number(row[0]) <= 0:
                raise OrbitalError('molden-basis', 'Invalid Molden primitive row.')
            [_number(v) for v in row[1:]]
        l = 'spdfg'.find(shell)
        basis += 4 if shell == 'sp' else (2*l+1 if spherical.get(l,False) else (l+1)*(l+2)//2)
        shell_types.append(shell)
    _, start, end = section('mo'); orbitals=[]; current=None; rows={}
    def finish():
        if current is None: return
        if not all(k in current for k in ('energyHartree','spin','occupation')) or set(rows) != set(range(1,basis+1)):
            raise OrbitalError('molden-mo', 'Molden MO metadata or coefficient indices are incomplete.')
        if current['occupation'] < 0 or current['occupation'] > 2:
            raise OrbitalError('occupation', 'Molden MO occupation is outside 0..2.')
        orbitals.append(current.copy())
    for i in range(start,end):
        line=lines[i].strip()
        if not line: continue
        match=re.match(r'^(Sym|Ene|Spin|Occup)\s*=\s*(.*)$',line,re.I)
        if match:
            key,value=match.groups(); key=key.lower()
            if key=='sym' or (key=='ene' and current and 'energyHartree' in current):
                finish(); current=None; rows={}
            if current is None: current=dict(sourceLine=i+1,sourceField='[MO]',occupationSource='[MO] Occup')
            if key=='ene': current['energyHartree']=_number(value)
            elif key=='occup': current['occupation']=_number(value)
            elif key=='spin':
                if value.lower() not in ('alpha','beta'): raise OrbitalError('spin','Molden MO spin must be Alpha or Beta.')
                current['spin']=value.lower()
            continue
        p=line.split()
        if current is None or len(p)!=2: raise OrbitalError('molden-mo','Invalid Molden MO coefficient row.')
        index=_integer(_number(p[0]),1)
        if index in rows or index>basis: raise OrbitalError('molden-mo','Duplicate/out-of-range Molden coefficient index.')
        rows[index]=_number(p[1])
    finish()
    if not orbitals: raise OrbitalError('molden-mo','Molden has no molecular orbitals.')
    restricted = not any(o['spin']=='beta' for o in orbitals) and any(o['occupation']>1 for o in orbitals)
    beta_seen=False
    for orbital in orbitals:
        if orbital['spin']=='beta': beta_seen=True
        elif beta_seen: raise OrbitalError('molden-spin-order','Interleaved Molden spin channels are not verified; grouped Alpha then Beta MO blocks are required.')
        if beta_seen and orbital['occupation']>1: raise OrbitalError('occupation','Unrestricted Molden occupations must lie in 0..1.')
    if beta_seen and any(o['occupation']>1 for o in orbitals): raise OrbitalError('occupation','Unrestricted Molden occupations must lie in 0..1.')
    counts={}
    for source_index, orbital in enumerate(orbitals,1):
        spin='restricted' if restricted else orbital['spin']; counts[spin]=counts.get(spin,0)+1
        orbital.update(spin=spin,index=counts[spin],sourceIndex=source_index,displayIndex=counts[spin],multiwfnIndex=source_index,id=f'{spin}:{counts[spin]}')
    if any(count>basis for count in counts.values()): raise OrbitalError('molden-mo','Molden has more channel orbitals than basis functions.')
    return dict(format='molden',charge=None,multiplicity=None,atoms=atoms,basisCount=basis,shellTypes=sorted(set(shell_types)),orbitals=orbitals,
                basisConvention='Molden GTO and explicit angular tags; ORCA normalization/order delegated to Multiwfn')


def _wavefunction_format(raw):
    # Keep the same bounded, complete-line evidence as the desktop host.
    limit=1024*1024
    head=raw[:limit].decode('utf-8-sig',errors='replace').replace('\r\n','\n').replace('\r','\n')
    if len(raw)>limit: head=head[:head.rfind('\n')+1]
    molden=re.search(r'^[^\S\n]*\[Molden Format\][^\S\n]*$',head,re.I|re.M) is not None
    fchk=re.search(r'^Atomic numbers\s+I\s+N=\s*\d+',head,re.M) is not None and re.search(r'^Number of atoms\s+I\s+\d+',head,re.M) is not None
    if molden and fchk:
        raise OrbitalError('source-format-conflict','Wavefunction contains both Molden and FCHK format evidence.')
    return 'molden' if molden else 'fchk'


def inspect_wavefunction(path):
    source=Path(path).resolve()
    if not source.is_file():
        raise OrbitalError('source-limit','Wavefunction is absent.')
    initial=source.stat();lines=_FileLines(source)
    try:
        with source.open('rb') as stream:head=stream.read(1024*1024+1)
        metadata=_molden_metadata(lines) if _wavefunction_format(head)=='molden' else _fchk_metadata(lines)
        stat=source.stat()
        if (stat.st_size,stat.st_mtime_ns)!=(initial.st_size,initial.st_mtime_ns) or lines.bytes!=stat.st_size:
            raise OrbitalError('source-changed','Wavefunction changed during metadata inspection.')
        metadata.update(sourcePath=str(source),sourceName=source.name,sourceBytes=lines.bytes,sourceMtimeNs=stat.st_mtime_ns,
                        sourceSha256=lines.sha256,coordinateUnit='bohr',energyUnit='hartree')
    finally:lines.close()
    return metadata


def validate_grid(grid):
    origin=grid.get('originBohr'); axes=grid.get('axesBohr'); dims=grid.get('dimensions')
    if not isinstance(origin,list) or len(origin)!=3 or not isinstance(axes,list) or len(axes)!=3 or any(not isinstance(v,list) or len(v)!=3 for v in axes):
        raise OrbitalError('grid','Grid needs an origin and three explicit Bohr vectors.')
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in origin+[v for row in axes for v in row]):
        raise OrbitalError('grid','Grid coordinates must be finite.')
    if not isinstance(dims,list) or len(dims)!=3:
        raise OrbitalError('grid','Grid needs three dimensions.')
    dims=[_integer(v,2) for v in dims]
    if any(axes[i][i]<=0 or any(axes[i][j]!=0 for j in range(3) if i!=j) for i in range(3)):
        raise OrbitalError('grid-axis','Orbital generation currently requires positive orthogonal XYZ steps.')
    points=math.prod(dims)
    return points


def plan_grid(metadata,grid,memory_budget_bytes=None,mode='all',cache_count=0,native_static_image_bytes=0):
    if mode not in ('all','selected'): raise OrbitalError('mode','Explicit orbital generation mode must be all or selected.')
    points=validate_grid(grid); budget=_integer(total_physical_memory() if memory_budget_bytes is None else memory_budget_bytes,1)
    field_bytes=points*8; total=field_bytes*(len(metadata['orbitals']) if mode=='all' else max(1,_integer(cache_count)))
    # Final Float64 cache plus Cube parsing/transfer scratch, source arrays and one native grid.
    static_image=_integer(native_static_image_bytes)
    scratch=points*128 + metadata['sourceBytes']*4 + metadata['basisCount']**2*24 + 64*1024*1024 + static_image
    return dict(points=points,orbitalCount=len(metadata['orbitals']),fieldBytes=field_bytes,cacheBytes=total,
                workingBytes=scratch,estimatedPeakBytes=total+scratch,memoryBudgetBytes=budget,
                requiresMemoryConfirmation=total+scratch>budget,nativeStaticImageBytes=static_image,valueType='float64',valueUnit='bohr^-3/2',order='x-y-z; z fastest',mode=mode)


def read_cube(path, expected_grid, return_header=False):
    """Read scalar MW Cube and reject geometry/data shape mismatches before caching."""
    lines=Path(path).read_text(encoding='ascii').splitlines()
    if len(lines)<6: raise OrbitalError('cube','Multiwfn produced an incomplete Cube.')
    row=lines[2].split(); natoms=int(row[0])
    if natoms<0 or len(row)!=4: raise OrbitalError('cube','Expected a scalar Multiwfn Cube.')
    origin=[_number(v) for v in row[1:]]; dims=[]; axes=[]
    for line in lines[3:6]:
        p=line.split()
        if len(p)!=4: raise OrbitalError('cube','Malformed Cube grid header.')
        dims.append(int(p[0])); axes.append([_number(v) for v in p[1:]])
    if dims!=expected_grid['dimensions'] or not np.allclose(origin,expected_grid['originBohr'],rtol=0,atol=0.00000051) or not np.allclose(axes,expected_grid['axesBohr'],rtol=0,atol=0.00000051):
        raise OrbitalError('cube-grid','Multiwfn Cube grid differs from the requested grid.')
    tokens=' '.join(lines[6+natoms:]).replace('D','E').replace('d','e').split()
    if len(tokens)!=math.prod(dims): raise OrbitalError('cube-count','Multiwfn Cube value count disagrees with the grid.')
    values=np.array([_number(token) for token in tokens],dtype=np.float64)
    if not np.isfinite(values).all(): raise OrbitalError('cube-values','Multiwfn Cube has non-finite values.')
    return (values,lines[:6+natoms]) if return_header else values


class MultiwfnSession:
    """One owned native process, one grid and a session-only in-memory MO cache.

    generate() is a generator so the caller can publish a finished MO before
    requesting the next. stop() may be called from another thread. Continuing
    generate() reuses completed entries and restarts the native process if needed.
    """
    def __init__(self, executable, source_path, grid, threads, memory_budget_bytes, workspace_path, mode='all',expected_settings_revision=None,progress_callback=None,native_start_callback=None):
        self.progress_callback=progress_callback
        self.native_start_callback=native_start_callback
        self.executable=Path(executable).resolve()
        if not self.executable.is_file(): raise OrbitalError('backend-missing','Configure a local Multiwfn executable before generating orbitals.')
        self.resources,settings=resolve_resources(self.executable,threads,memory_budget_bytes)
        if expected_settings_revision is not None and self.resources['settingsRevision']!=expected_settings_revision: raise OrbitalError('resource-changed','Multiwfn settings changed after planning; refresh the resource configuration.')
        self.metadata=inspect_wavefunction(source_path); self.grid=grid; self.threads=self.resources['threads']
        self.mode=mode; self.plan=plan_grid(self.metadata,grid,self.resources['memoryBudgetBytes'],mode,native_static_image_bytes=self.resources['nativeStaticImageBytes'])
        self.cache={}; self.cube_header=None; self.process=None; self._job=None; self.closed=False; self.stopped=threading.Event(); self._lock=threading.Lock(); self._lifecycle=threading.RLock()
        root=Path(workspace_path).resolve(); root.mkdir(parents=True,exist_ok=True)
        self.work=Path(tempfile.mkdtemp(prefix='orbital-session-',dir=root)); self.backend=None
        self.input_path=self.work/('source.fchk' if self.metadata['format']=='fchk' else 'source.molden')
        shutil.copyfile(self.metadata['sourcePath'],self.input_path)
        (self.work/'settings.ini').write_bytes(settings)
        self._queue=queue.Queue()
        self._output_tail=''; self._native_phase='idle'; self._memory={}; self.last_diagnostics=None

    def _diagnostics(self, process=None):
        process = self.process if process is None else process
        snapshot = _native_memory_snapshot(process)
        for key, value in snapshot.items():
            self._memory[key] = max(self._memory.get(key, 0), value) if key.startswith('peak') else value
        exit_code = process.poll() if process is not None else None
        self.last_diagnostics = dict(phase=self._native_phase, exitCode=exit_code,
            exitCodeHex=f'0x{exit_code & 0xffffffff:08X}' if exit_code is not None else None,
            nativeMemoryBudgetBytes=self.plan['memoryBudgetBytes'], threads=self.threads,
            memory=dict(self._memory), outputTail=self._output_tail[-4096:])
        return self.last_diagnostics

    def _backend_failure(self, code, message):
        diagnostics = self._diagnostics()
        suffix = f" Phase={diagnostics['phase']}; exit={diagnostics['exitCodeHex'] or 'running'}; native grant={diagnostics['nativeMemoryBudgetBytes']} B"
        if diagnostics['memory'].get('peakPrivateCommitBytes') is not None:
            suffix += f"; peak private commit={diagnostics['memory']['peakPrivateCommitBytes']} B"
        return OrbitalError(code, message + suffix + '. ' + diagnostics['outputTail'][-1600:], diagnostics)

    def apply_resources(self, grant):
        """An admitted next run may update resources while keeping completed MOs."""
        if self.process is not None and self.process.poll() is None:
            raise OrbitalError('resource-active', 'An active native orbital run retains its admitted resources.')
        executable = Path(grant.get('executable',str(self.executable))).resolve()
        if not executable.is_file(): raise OrbitalError('backend-missing','The admitted Multiwfn executable is unavailable.')
        resources, settings = resolve_resources(executable, grant.get('threads'), grant.get('memoryBudgetBytes'))
        if grant.get('settingsRevision') != resources['settingsRevision']:
            raise OrbitalError('resource-changed', 'Multiwfn settings changed after the current resource grant.')
        proposed = plan_grid(self.metadata, self.grid, resources['memoryBudgetBytes'], self.mode, len(self.cache),resources['nativeStaticImageBytes'])
        self.executable, self.resources, self.threads, self.plan = executable, resources, resources['threads'], proposed
        (self.work/'settings.ini').write_bytes(settings)

    def _start(self):
        from multiwfn_progress import NativeProgressScanner, native_output_lines, report_progress
        report_progress(self.progress_callback,'reading',stageId='orbital-source')
        with self._lifecycle:
            if self.closed or self.stopped.is_set(): raise OrbitalError('aborted','Orbital session stopped before starting its native process.')
        if native_binary_identity(self.executable)!=self.resources.get('nativeBinaryIdentity'):
            raise OrbitalError('resource-changed','Multiwfn executable changed after admission; refresh the orbital resource plan before starting it.')
        stat=Path(self.metadata['sourcePath']).stat()
        if stat.st_size!=self.metadata['sourceBytes'] or stat.st_mtime_ns!=self.metadata['sourceMtimeNs']:
            raise OrbitalError('source-changed','Source wavefunction changed; create a new orbital session.')
        self._queue=queue.Queue()
        self._output_tail=''; self._memory={}; self._native_phase='source-load'; self.last_diagnostics=None
        env=dict(os.environ,Multiwfnpath=str(self.executable.parent),OMP_NUM_THREADS=str(self.threads),OPENBLAS_NUM_THREADS=str(self.threads),MKL_NUM_THREADS=str(self.threads))
        process=subprocess.Popen([str(self.executable),self.input_path.name],cwd=self.work,env=env,
                                      stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                                      creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        # Observe actual Popen success, including a subsequent ownership/close
        # race. An optional observer must never interrupt process ownership.
        if self.native_start_callback is not None:
            try: self.native_start_callback(process)
            except Exception: pass
        job=_windows_owned_job(process,self.plan['memoryBudgetBytes'])
        with self._lifecycle:
            if self.closed or self.stopped.is_set():
                self._terminate(process,job)
                raise OrbitalError('aborted','Orbital session stopped while starting its native process.')
            self.process=process; self._job=job
        q=self._queue
        scanner=NativeProgressScanner(self.progress_callback)
        def observe_output(chunk):
            text=chunk.decode('utf-8',errors='replace')
            if self.process is process: self._output_tail=(self._output_tail+text)[-8192:]
            scanner.feed(text)
        def read_output():
            for line in native_output_lines(process.stdout,observe_output):
                q.put(line.decode('utf-8',errors='replace'))
            q.put(None)
        threading.Thread(target=read_output,daemon=True).start()
        output=self._wait('************ Main function menu',120)
        version=re.search(r'Version\s+([^\r\n]+)',output); threads=re.search(r'Number of parallel threads:\s*(\d+)',output)
        if not version or not threads or int(threads[1])!=self.threads:
            self.stop(); raise OrbitalError('backend-identity','Multiwfn version/actual thread count could not be verified.')
        self.backend=dict(name='Multiwfn',version=version[1].strip(),threads=int(threads[1]),executable=str(self.executable),resources=self.resources)

    def _write(self, answers):
        process=self.process
        if process is None or self.stopped.is_set():
            raise OrbitalError('aborted','Orbital generation was stopped; completed fields are retained.')
        try:
            process.stdin.write(answers); process.stdin.flush()
        except (BrokenPipeError, OSError):
            if self.stopped.is_set(): raise OrbitalError('aborted','Orbital generation was stopped; completed fields are retained.') from None
            try: process.wait(timeout=.2)
            except subprocess.TimeoutExpired: pass
            raise self._backend_failure('backend-exit','Multiwfn closed its input before completing the requested field.') from None

    def _wait(self,marker,timeout=None):
        deadline=None; output=''  # Scientific operations have no wall-clock deadline.
        while deadline is None or time.monotonic()<deadline:
            if self.stopped.is_set(): raise OrbitalError('aborted','Orbital generation was stopped; completed fields are retained.')
            try: line=self._queue.get(timeout=.1 if deadline is None else min(.1,max(.001,deadline-time.monotonic())))
            except queue.Empty:
                self._diagnostics()
                continue
            if line is None:
                if self.process is not None:
                    try: self.process.wait(timeout=.2)
                    except subprocess.TimeoutExpired: pass
                raise self._backend_failure('backend-exit','Multiwfn exited before completing the requested field.')
            output+=line
            if marker in line: return output
            if len(output)>100_000: output=output[-50_000:]
        error=self._backend_failure('backend-timeout','Multiwfn exceeded the bounded operation deadline.')
        self.stop(); raise error

    def reserve_selected(self,key=None):
        count=len(self.cache)+(1 if key is not None and key not in self.cache else 0)
        proposed=plan_grid(self.metadata,self.grid,self.plan['memoryBudgetBytes'],'selected',count,self.resources['nativeStaticImageBytes'])
        return proposed

    def generate(self,priority_ids=None,selected_only=False):
        if self.closed: raise OrbitalError('session-closed','Orbital session is closed.')
        if self.mode=='selected' and not selected_only: raise OrbitalError('mode','Selected mode requires an explicit selected orbital request.')
        if not self._lock.acquire(blocking=False): raise OrbitalError('session-busy','Only one orbital generation batch may run per session.')
        try:
            by_id={o['id']:o for o in self.metadata['orbitals']}
            priority=list(dict.fromkeys(priority_ids or []))
            if any(key not in by_id for key in priority): raise OrbitalError('orbital-id','Requested orbital is absent from the source.')
            if selected_only and len(priority)!=1: raise OrbitalError('orbital-id','Single-orbital generation requires exactly one source key.')
            if selected_only: self.plan=self.reserve_selected(priority[0])
            order=priority if selected_only else priority+[key for key in by_id if key not in priority]
            for key in order:
                if self.stopped.is_set(): break
                if key in self.cache: continue
                if self.process is None or self.process.poll() is not None: self._start()
                process=self.process
                if process is None or self.stopped.is_set(): raise OrbitalError('aborted','Orbital generation was stopped.')
                orbital=by_id[key]
                # Multiwfn alpha indices start at one; beta indices follow all alpha MOs.
                native_index=orbital['multiwfnIndex']
                grid=self.grid
                answers=['5','4',str(native_index),'5',','.join(map(str,grid['originBohr'])),
                         ','.join(str(grid['axesBohr'][i][i]) for i in range(3)),','.join(map(str,grid['dimensions'])),'2']
                start=time.perf_counter()
                from multiwfn_progress import report_progress
                report_progress(self.progress_callback,'running',stageId='orbital:'+key)
                self._native_phase='orbital:'+key
                self._write(('\n'.join(answers)+'\n').encode('ascii'))
                self._wait('Done! Grid data has been exported to MOvalue.cub',600)
                report_progress(self.progress_callback,'parse',stageId='orbital-cube:'+key)
                temporary=self.work/'MOvalue.cub'
                try: values,header=read_cube(temporary,grid,return_header=True)
                finally:
                    if temporary.exists(): temporary.unlink()
                with self._lifecycle:
                    if self.stopped.is_set() or self.closed: break
                    self.cache[key]=values
                    self.cube_header=header
                self._write(b'0\n')
                self._native_phase='return-main-menu'
                self._wait('************ Main function menu',30)
                self._native_phase='idle'; self._diagnostics()
                yield dict(orbital=orbital,grid=grid,values=values,backend=self.backend,elapsedSeconds=time.perf_counter()-start,
                           completed=len(self.cache),total=len(by_id))
        finally:
            self._lock.release()

    @staticmethod
    def _terminate(process,job):
        if process is not None and process.poll() is None:
            process.kill()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: pass
        if job:
            kernel,handle=job; kernel.CloseHandle(handle)

    def resume(self):
        with self._lifecycle:
            if self.closed: raise OrbitalError('session-closed','Orbital session is closed.')
            self.stopped.clear()

    def stop(self):
        with self._lifecycle:
            self.stopped.set(); process=self.process; job=self._job
            if process is not None: self._diagnostics(process)
            self.process=None; self._job=None
        self._terminate(process,job)

    def export_cube(self,key):
        values=self.cache.get(key)
        if values is None or self.cube_header is None:
            raise OrbitalError('field-pending','Requested orbital has not completed.')
        header=list(self.cube_header)
        header[0]='Ester Studio orbital '+key+'; psi [bohr^-3/2]; Multiwfn '+self.backend['version']
        header[1]='Source '+self.metadata['sourceName']+' sha256='+self.metadata['sourceSha256']
        rows=[' '.join(f'{v: .12E}' for v in values[i:i+6]) for i in range(0,len(values),6)]
        return '\n'.join(header+rows)+'\n'

    def close(self):
        with self._lifecycle: self.closed=True
        self.stop(); self.cache.clear(); self.cube_header=None
        work=getattr(self,'work',None)
        if work and work.exists():
            # Only the known files this adapter creates; never recursively delete user data.
            for name in ('settings.ini','MOvalue.cub','source.fchk','source.molden'):
                target=work/name
                if target.is_file() and not target.is_symlink(): target.unlink()
            try: work.rmdir()
            except OSError: pass

    def __enter__(self): return self
    def __exit__(self,*args): self.close()
