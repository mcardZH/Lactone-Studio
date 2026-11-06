"""Resolve user Multiwfn resources and create only job-local settings.

The memory figure is an allocation budget, never an eager allocation. Unknown
settings and their original bytes are retained; only the documented overrides
and an explicit per-request resource override may change inside the job copy.
"""
from __future__ import annotations
import ctypes
import hashlib
import os
from pathlib import Path
import re
import struct

MAX_NATIVE_INTEGER=2**31-1
MAX_SAFE_INTEGER=2**53-1

class ResourceError(ValueError):
    code='resource-configuration'


def native_binary_identity(executable):
    if executable is None: return None
    path=Path(executable).resolve()
    try: stat=path.stat()
    except FileNotFoundError: return None
    return dict(path=str(path),bytes=stat.st_size,modifiedNs=str(stat.st_mtime_ns),fileId=str(stat.st_ino))


def native_static_image_bytes(executable, *, platform=None):
    """Estimate Windows private image commit from nonshared writable PE sections.

    This is not RSS or the PE SizeOfImage/stack reserve. Only bounded headers
    are read; the estimate is additive to the existing dynamic scratch budget.
    """
    if executable is None or (os.name if platform is None else platform) != 'nt': return 0
    path=Path(executable)
    try:
        before=path.stat()
        with path.open('rb') as stream:
            dos=stream.read(64)
            if len(dos)!=64 or dos[:2]!=b'MZ': return 0
            offset=struct.unpack_from('<I',dos,60)[0]
            if not 64<=offset<=1024*1024: return 0
            stream.seek(offset); coff=stream.read(24)
            if len(coff)!=24 or coff[:4]!=b'PE\0\0': return 0
            count=struct.unpack_from('<H',coff,6)[0]; optional_size=struct.unpack_from('<H',coff,20)[0]
            if not 1<=count<=96 or not 36<=optional_size<=4096: return 0
            optional=stream.read(optional_size); sections=stream.read(count*40)
            if len(optional)!=optional_size or len(sections)!=count*40: return 0
            if struct.unpack_from('<H',optional)[0] not in (0x10b,0x20b): return 0
            alignment=struct.unpack_from('<I',optional,32)[0]
            if alignment<1 or alignment>1024*1024 or alignment&(alignment-1): return 0
            total=0
            for index in range(count):
                start=index*40; flags=struct.unpack_from('<I',sections,start+36)[0]
                if flags&0x80000000 and not flags&0x10000000:
                    size=max(struct.unpack_from('<I',sections,start+8)[0],struct.unpack_from('<I',sections,start+16)[0])
                    total+=((size+alignment-1)//alignment)*alignment
        after=path.stat()
        if (before.st_size,before.st_mtime_ns,before.st_ino)!=(after.st_size,after.st_mtime_ns,after.st_ino):
            raise ResourceError('Multiwfn executable changed while reading its memory estimate; refresh the resource configuration.')
        return total
    except FileNotFoundError:
        return 0

def logical_cpu_count():
    if hasattr(os,'process_cpu_count'):
        count=os.process_cpu_count()
    elif hasattr(os,'sched_getaffinity'):
        count=len(os.sched_getaffinity(0))
    else:
        count=os.cpu_count()
    if not isinstance(count,int) or count<1: raise ResourceError('Cannot determine available logical processors.')
    return count

def total_physical_memory():
    if os.name=='nt':
        class MemoryStatus(ctypes.Structure):
            _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(name,ctypes.c_ulonglong) for name in ('totalPhysical','availablePhysical','totalPageFile','availablePageFile','totalVirtual','availableVirtual','availableExtendedVirtual')]
        status=MemoryStatus();status.length=ctypes.sizeof(status)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)): raise ResourceError('Cannot read total physical RAM.')
        value=int(status.totalPhysical)
    else:
        value=int(os.sysconf('SC_PHYS_PAGES'))*int(os.sysconf('SC_PAGE_SIZE'))
    if not 0<value<=MAX_SAFE_INTEGER: raise ResourceError('Physical RAM is outside the supported integer representation.')
    return value

def _positive_integer(value,maximum,label):
    if isinstance(value,bool) or not isinstance(value,int) or not 0<value<=maximum: raise ResourceError(label+' must be a positive representable integer.')
    return value

def _values(raw,key):
    pattern=rb'(?mi)^[ \t]*'+key.encode('ascii')+rb'[ \t]*=[ \t]*([^\r\n]*)'
    return [part.split(b'//',1)[0].strip() for part in re.findall(pattern,raw)]

def _override(raw,key,value):
    bom=b'\xef\xbb\xbf' if raw.startswith(b'\xef\xbb\xbf') else b''
    raw=raw[len(bom):]
    encoded=str(value).encode('ascii'); key_bytes=key.encode('ascii')
    pattern=rb'(?mi)^([ \t]*'+key_bytes+rb'[ \t]*=[ \t]*)([^\r\n]*)'
    def replace(match):
        old=match[2]; marker=old.find(b'//')
        return match[1]+encoded+(b' '+old[marker:] if marker>=0 else b'')
    updated,count=re.subn(pattern,replace,raw)
    if not count: updated+= (b'' if not updated or updated.endswith(b'\n') else b'\n')+key_bytes+b'= '+encoded+b'\n'
    return bom+updated

def resolve_resources(executable=None,threads=None,memory_budget_bytes=None,*,cpu_count=None,physical_bytes=None):
    cpus=logical_cpu_count() if cpu_count is None else _positive_integer(cpu_count,MAX_NATIVE_INTEGER,'Logical CPU count')
    physical=total_physical_memory() if physical_bytes is None else _positive_integer(physical_bytes,MAX_SAFE_INTEGER,'Physical RAM')
    settings_path=Path(executable).resolve().parent/'settings.ini' if executable else None
    present=False;raw=b''
    if settings_path is not None:
        try:
            if settings_path.stat().st_size>4*1024*1024: raise ResourceError('Multiwfn settings.ini exceeds the 4 MiB configuration limit.')
            raw=settings_path.read_bytes();present=True
        except FileNotFoundError: pass
    values=_values(raw.removeprefix(b'\xef\xbb\xbf'),'nthreads')
    configured=None
    if len(values)==1 and re.fullmatch(rb'\+?\d+',values[0]):
        parsed=int(values[0])
        if 0<parsed<=MAX_NATIVE_INTEGER: configured=parsed
    effective_threads=configured if configured is not None else cpus
    thread_source='settings' if configured is not None else 'logical-cpus'
    if threads is not None:
        requested=_positive_integer(threads,MAX_NATIVE_INTEGER,'Thread count')
        if requested!=effective_threads: thread_source='request'
        effective_threads=requested
    effective_memory=physical if memory_budget_bytes is None else _positive_integer(memory_budget_bytes,MAX_SAFE_INTEGER,'Memory budget')
    memory_source='physical-ram' if effective_memory==physical else 'request'
    overrides=[];updated=raw
    rules=[('nthreads',effective_threads,'explicit-resource' if thread_source=='request' else 'logical-cpu-fallback' if configured is None else 'configured-resource'),
           ('idelvirorb',0,'retain-all-source-orbitals'),('compthres',0,'retain-all-composition-values'),('bndordthres',0,'retain-all-bond-order-values'),
           ('isilent',1,'owned-headless-process'),('iaddprefix',0,'owned-output-file-names')]
    for key,value,reason in rules:
        old=_values(raw.removeprefix(b'\xef\xbb\xbf'),key)
        changed=old!=[str(value).encode('ascii')]
        if key=='nthreads' and configured==effective_threads: changed=False
        # A valid user nthreads is already effective; retain its exact line.
        if key!='nthreads' or changed: updated=_override(updated,key,value)
        overrides.append(dict(key=key,value=value,reason=reason,changed=changed))
    info=dict(threads=effective_threads,memoryBudgetBytes=effective_memory,totalPhysicalMemoryBytes=physical,logicalCpuCount=cpus,
              threadSource=thread_source,memorySource=memory_source,settingsPath=str(settings_path) if settings_path else None,
              settingsPresent=present,settingsRevision=hashlib.sha256(raw).hexdigest(),temporaryOverrides=overrides,
              retainedOtherSettings=True,memoryIsBudget=True,configured=executable is not None)
    binary_before=native_binary_identity(executable)
    info['nativeStaticImageBytes']=native_static_image_bytes(executable)
    binary_after=native_binary_identity(executable)
    if binary_before!=binary_after:
        raise ResourceError('Multiwfn executable changed while resolving its memory estimate; refresh the resource configuration.')
    info['nativeMemoryEstimateSource']='pe-private-writable-sections' if info['nativeStaticImageBytes'] else 'dynamic-scratch-only'
    info['nativeBinaryIdentity']=binary_after
    return info,updated

def write_job_settings(directory,executable=None,threads=None,memory_budget_bytes=None,expected_revision=None):
    info,raw=resolve_resources(executable,threads,memory_budget_bytes)
    if expected_revision is not None and expected_revision!=info['settingsRevision']: raise ResourceError('Multiwfn settings changed after resource planning; refresh the resource configuration.')
    target=(Path(directory)/'settings.ini').resolve()
    if info['settingsPath'] and target==Path(info['settingsPath']).resolve(): raise ResourceError('Job settings must not overwrite the selected program configuration.')
    target.write_bytes(raw)
    return info
