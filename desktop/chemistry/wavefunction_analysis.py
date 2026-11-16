"""One bounded, owned numerical analysis. Renderer paths never enter this module.

The Electron host creates the immutable source snapshot and injects trusted
executables. Native tools run in a separate disposable directory with local
settings; cancellation kills this worker and its Windows job kills native children.
"""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from orbitals import OrbitalError, inspect_wavefunction, _number, _windows_owned_job, MultiwfnSession, SYMBOLS
from multiwfn_resources import (resolve_resources, total_physical_memory, _override, require_native_binary_grant, start_multiwfn,
                                gxtb_valence_settings, native_output_has_edf)

NUMBER=r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[EeDd][-+]?\d+)?'

def prepare_hirshfeld_densities(executable,metadata,work,required=True):
    """Copy existing radial densities only; missing data must never invoke Gaussian.

    Required charge states follow Multiwfn manual 3.9.13. Extra supplied states
    for the same elements are retained for iterations beyond the usual range.
    """
    elements={SYMBOLS[a['atomicNumber']] for a in metadata['atoms']}
    group1=set('H Li Na K Rb Cs Fr He Ne Ar Kr Xe Rn Og'.split())
    main=set('B C N O Al Si P S Ga Ge As Se In Sn Sb Te Tl Pb Bi Po Nh Fl Mc Lv'.split())
    names=[]
    for element in sorted(elements):
        states=(-1,0,1) if element in group1 else (-2,-1,0,1,2) if element in main else (-1,0,1,2)
        names.extend(element+('_0' if charge==0 else f'{charge:+d}')+'.rad' for charge in states)
    # Resolve each state independently, preferring a valid reference beside the executable.
    directories=(executable.parent/'atmrad',executable.parent/'examples'/'atmrad')
    payloads={};invalid=set();digest=hashlib.sha256()
    for directory in directories:
        if not directory.is_dir():
            continue
        for file in sorted(directory.iterdir()):
            match=re.fullmatch(r'([A-Z][a-z]?)(?:_0|[+-]\d+)\.rad',file.name)
            if not match or match[1] not in elements or file.name in payloads:
                continue
            try:
                if not file.is_file(): raise ValueError('file type')
                raw=file.read_bytes()
                lines=raw.decode('ascii').splitlines();count=int(lines[0]);previous=-1.
                stripped=file.name==f'{match[1]}+{SYMBOLS.index(match[1])}.rad'
                if (count<2 and not (count==0 and stripped)) or len(lines)!=count+1: raise ValueError('point count')
                for line in lines[1:]:
                    parts=line.split()
                    if len(parts)!=2: raise ValueError('columns')
                    radius,density=map(_number,parts)
                    if not all(map(math.isfinite,(radius,density))) or radius<=previous or density<0: raise ValueError('radial data')
                    previous=radius
            except (ValueError,IndexError,OSError):
                invalid.add(file.name)
                continue
            payloads[file.name]=raw
            invalid.discard(file.name)
    missing=[name for name in names if name not in payloads]
    if missing and required:
        raise OrbitalError('analysis-atomic-density','Hirshfeld-I 缺少有效原子径向密度文件：'+', '.join(missing)+'。')
    if payloads:
        target=work/'atmrad';target.mkdir()
        for name,raw in sorted(payloads.items()):
            digest.update(name.encode('ascii')+b'\0'+raw)
            (target/name).write_bytes(raw)
        parameters=dict(atomicDensity='supplied spherical radial densities',atomicDensityFiles=len(payloads),atomicDensityRevision=digest.hexdigest())
    else:
        parameters=dict(atomicDensity='Multiwfn native reference handling')
    if invalid:
        parameters['unusableAtomicDensityFiles']=', '.join(sorted(invalid))
    return parameters if required else (parameters,missing)

def hirshfeld_missing_reference(output):
    missing_reference=re.compile(r'upstream-disabled|(?:radial|atomic density).*(?:not found|missing)|(?:invoke|running|calling|launching) Gaussian|(?:not found|cannot open|does not exist).*\.rad|\.rad.*(?:not found|cannot open|does not exist)',re.I)
    lines=[line for line in output.splitlines() if missing_reference.search(line)]
    if not lines:
        return None
    detail='、'.join(sorted(set(re.findall(r'\b[A-Z][a-z]?(?:_0|[+-]\d+)\.rad\b','\n'.join(lines)))))
    return 'Hirshfeld-I 本次需要额外原子径向密度参考'+('：'+detail if detail else '')+'。可提供已有 atmrad 数据，或另行确认参考补算。'

def hirshfeld_convergence(output):
    converged=re.search(r'All atomic charges have converged to criterion of\s*('+NUMBER+r')',output)
    cycles=re.findall(r'Cycle\s+(\d+)',output)
    if not converged or not cycles or re.search(r'convergence failed|not converged|failed to converge',output,re.I):
        raise OrbitalError('analysis-convergence','Hirshfeld-I 未确认所有原子电荷收敛；未返回未收敛电荷。')
    return dict(convergenceCriterion=_number(converged[1]),iterations=int(cycles[-1]))

def atom_rows(metadata):
    return [dict(atomId=f'a{i+1}',sourceIndex=i+1,element=SYMBOLS[a['atomicNumber']],value=0.) for i,a in enumerate(metadata['atoms'])]

def trusted_source_expectation(value,metadata):
    """Check an internal owned-artifact binding, never a renderer q override.

    Physical and MO-represented electron counts remain distinct evidence. This
    binding neither supplies EDF nor accepts an effective nuclear reference.
    """
    if value is None:return None
    fields={'kind','artifactId','sourceSha256','charge','requestedUhf','atomElements','representedElectronCount','physicalElectronCount','sourceSpinResolution','independentAlphaBeta'}
    gxtb=isinstance(value,dict) and value.get('kind')=='generated-gxtb-sp'
    if gxtb: fields.add('effectiveNuclearCharges')
    if not isinstance(value,dict) or set(value)!=fields or value.get('kind') not in ('generated-gfn2-sp','generated-gxtb-sp') or not isinstance(value.get('artifactId'),str) or not 0<len(value['artifactId'])<=256 or '\x00' in value['artifactId']:
        raise OrbitalError('trusted-source-expectation','Invalid internal generated-source expectation schema.')
    if metadata.get('format')!='molden' or value['sourceSha256']!=metadata['sourceSha256'] or not isinstance(value['sourceSha256'],str) or not re.fullmatch(r'[a-f0-9]{64}',value['sourceSha256']):
        raise OrbitalError('trusted-source-expectation','Generated-source expectation does not match the immutable Molden digest.')
    if value['atomElements']!=[SYMBOLS[a['atomicNumber']] for a in metadata['atoms']]:
        raise OrbitalError('trusted-source-expectation','Generated-source atom order differs from its authenticated artifact.')
    independent=gxtb and any(o['spin']=='beta' for o in metadata['orbitals'])
    resolution=('alpha-beta' if independent else 'restricted') if gxtb else 'spin-summed'
    if value['sourceSpinResolution']!=resolution or value['independentAlphaBeta'] is not independent:
        raise OrbitalError('trusted-source-expectation','Generated Molden spin resolution differs from the authenticated source.')
    charge=value['charge'];uhf=value['requestedUhf']
    if any(isinstance(v,bool) or not isinstance(v,int) or abs(v)>2**53-1 for v in (charge,uhf)) or uhf<0:
        raise OrbitalError('trusted-source-expectation','Generated-source charge/UHF must be bounded integers.')
    physical=sum(a['atomicNumber'] for a in metadata['atoms'])-charge
    represented=sum(o['occupation'] for o in metadata['orbitals'])
    if gxtb:
        effective=[a.get('effectiveNuclearCharge') for a in metadata['atoms']]
        spin=sum(o['occupation']*(1 if o['spin']=='alpha' else -1) for o in metadata['orbitals']) if independent else 0
        if not all(isinstance(z,int) for z in effective) or effective!=value['effectiveNuclearCharges'] or abs(sum(effective)-represented-charge)>1e-6 or abs(spin-uhf)>1e-6:
            raise OrbitalError('trusted-source-expectation','g-xTB effective nuclei, represented electrons or spin differ from the authenticated request.')
    if physical<=0 or uhf>physical or (physical-uhf)%2 or represented<=0 or abs(represented-round(represented))>=1e-6 or represented>physical+1e-6:
        raise OrbitalError('trusted-source-expectation','Generated-source electron counts or requested charge/UHF parity are invalid.')
    for key,actual in [('representedElectronCount',represented),('physicalElectronCount',physical)]:
        supplied=value[key]
        if isinstance(supplied,bool) or not isinstance(supplied,(int,float)) or not math.isfinite(supplied) or abs(supplied-actual)>=1e-6:
            raise OrbitalError('trusted-source-expectation','Generated-source electron evidence changed in transit.')
    if (metadata.get('charge') is not None and metadata['charge']!=charge) or (metadata.get('multiplicity') is not None and metadata['multiplicity']!=uhf+1):
        raise OrbitalError('trusted-source-expectation','Explicit source charge/multiplicity conflicts with the authenticated request.')
    return dict(value,atomElements=list(value['atomElements']))

def verify_trusted_native_electrons(output,trusted):
    if trusted is None:return
    counts=re.search(r'Total/Alpha/Beta electrons:\s*('+NUMBER+r')',output)
    if not counts or abs(_number(counts[1])-trusted['representedElectronCount'])>1e-3:
        raise OrbitalError('analysis-trusted-electrons','Native total electron readback differs from authenticated MO occupations; no spin-channel or core reconstruction was inferred.')
    if trusted['kind']=='generated-gxtb-sp':
        net_charge=re.search(r'Net charge:\s*('+NUMBER+r')',output)
        channels=re.search(r'Total/Alpha/Beta electrons:\s*('+NUMBER+r')\s*('+NUMBER+r')\s*('+NUMBER+r')',output)
        if not net_charge or abs(_number(net_charge[1])-trusted['charge'])>1e-3 or not channels or abs(_number(channels[2])-_number(channels[3])-trusted['requestedUhf'])>1e-3:
            raise OrbitalError('analysis-trusted-electrons','Native g-xTB valence charge or spin differs from the authenticated source.')

def parse_charge(work, metadata, output, trusted_expectation=None):
    trusted=trusted_source_expectation(trusted_expectation,metadata)
    filename=work/'source.chg'
    if not filename.is_file(): raise OrbitalError('analysis-output','Multiwfn did not export the requested charge table.')
    lines=filename.read_text().splitlines(); rows=atom_rows(metadata)
    if len(lines)!=len(rows): raise OrbitalError('analysis-atoms','Charge result atom count differs from the source.')
    for row,line,atom in zip(rows,lines,metadata['atoms']):
        parts=line.split()
        if len(parts)!=5 or parts[0]!=row['element'] or max(abs(_number(parts[k+1])-atom['positionBohr'][k]*.529177210903) for k in range(3))>2e-5:
            raise OrbitalError('analysis-atoms','Charge result element/coordinates do not match the immutable source.')
        row['value']=_number(parts[4])
    # The unrestricted population atom table explicitly labels alpha, beta,
    # spin, charge. Other methods do not inherit this spin definition.
    # Native alpha/beta/spin columns can be generated from a spin-summed source.
    # They are not independent source evidence and are retained only in raw logs.
    spin_allowed=trusted['independentAlphaBeta'] if trusted else not re.search(r'This file is found to be generated by xtb!',output,re.I)
    spin_block=re.search(r'Atom\s+Alpha pop\.\s+Beta pop\.\s+Spin pop\.\s+(?:Atomic charge|Charge)(.*?)Total net charge',output,re.S) if spin_allowed else None
    if spin_block:
        spins=re.findall(r'^\s*(\d+)\(\s*([A-Za-z]+)\s*\)\s+('+NUMBER+r')\s+('+NUMBER+r')\s+('+NUMBER+r')\s+('+NUMBER+r')\s*$',spin_block[1],re.M)
        if len(spins)!=len(rows): raise OrbitalError('analysis-spin','Incomplete native spin population table.')
        for row,values in zip(rows,spins):
            if int(values[0])!=row['sourceIndex'] or values[1]!=row['element']: raise OrbitalError('analysis-spin','Spin atom mapping differs from the source.')
            row['spinPopulation']=_number(values[4])
        electron_header=re.search(r'Total/Alpha/Beta electrons:\s*('+NUMBER+r')\s*('+NUMBER+r')\s*('+NUMBER+r')',output)
        if not electron_header or abs(_number(electron_header[1])-sum(o['occupation'] for o in metadata['orbitals']))>1e-3: raise OrbitalError('analysis-spin-source','Native electron counts disagree with source orbital occupations.')
        expected_spin=_number(electron_header[2])-_number(electron_header[3])
        if abs(sum(r['spinPopulation'] for r in rows)-expected_spin)>max(.002,len(rows)*1e-5): raise OrbitalError('analysis-spin-sum','Native spin populations do not sum to source alpha-minus-beta occupations.')
    total=sum(r['value'] for r in rows)
    expected=trusted['charge'] if trusted is not None else metadata.get('charge')
    if expected is None and all('effectiveNuclearCharge' in atom for atom in metadata['atoms']):
        expected=sum(atom['effectiveNuclearCharge'] for atom in metadata['atoms'])-sum(orbital['occupation'] for orbital in metadata['orbitals'])
    if expected is None and re.search(r'This file is found to be generated by xtb!',output,re.I):
        from wavefunction_prerequisites import xtb_native_prerequisites
        expected=xtb_native_prerequisites(metadata,output,require_total_density=False)['nativeNetCharge']
    if expected is not None and abs(total-expected)>max(.002,len(rows)*2e-6): raise OrbitalError('analysis-charge-sum','Atomic charges do not sum to the source charge.')
    verify_trusted_native_electrons(output,trusted)
    return dict(unit='e',quantity='net-charge',atoms=rows,sum=total,spinAvailable=bool(spin_block))

def parse_bonds(work,metadata):
    file=work/'bndmat.txt'
    if not file.is_file(): raise OrbitalError('analysis-output','Multiwfn did not export its complete bond order matrix.')
    count=len(metadata['atoms']); values={}; columns=[]
    for line in file.read_text().splitlines():
        parts=line.split()
        if not parts: continue
        if all(p.isdigit() for p in parts):
            columns=list(map(int,parts)); continue
        if columns and parts[0].isdigit() and len(parts)==len(columns)+1:
            row=int(parts[0])
            for column,value in zip(columns,parts[1:]): values[row,column]=_number(value)
    if set(values)!={(i,j) for i in range(1,count+1) for j in range(1,count+1)}: raise OrbitalError('analysis-matrix','Incomplete bond order matrix.')
    bonds=[]
    for i in range(1,count+1):
        for j in range(i+1,count+1):
            if abs(values[i,j]-values[j,i])>1e-5: raise OrbitalError('analysis-matrix','Native bond order matrix is not symmetric.')
            bonds.append(dict(atomId1=f'a{i}',atomId2=f'a{j}',sourceIndex1=i,sourceIndex2=j,value=values[i,j]))
    return dict(unit='dimensionless',bonds=bonds)

def parse_composition(metadata,output,key):
    if not re.search(r'Printing threshold of absolute value:\s*>\s*0\.0+\s*%',output): raise OrbitalError('analysis-threshold','Multiwfn did not confirm a zero composition print threshold.')
    block=re.search(r'Composition of each atom:(.*?)(?:Orbital delocalization|Input the orbital index)',output,re.S)
    if not block: raise OrbitalError('analysis-output','Native atom composition table is absent.')
    rows=atom_rows(metadata); seen=set()
    for match in re.finditer(r'Atom\s+(\d+)\(\s*([A-Za-z]+)\s*\)\s*:\s*('+NUMBER+r')\s*%',block[1]):
        i=int(match[1])-1
        if not 0<=i<len(rows) or match[2]!=rows[i]['element'] or i in seen: raise OrbitalError('analysis-atoms','Orbital composition atom mapping is invalid.')
        seen.add(i); rows[i]['value']=_number(match[3])
    angular_block=re.search(r'Composition of different types of shells \(%\):(.*?)Composition of each atom:',output,re.S)
    if not angular_block: raise OrbitalError('analysis-output','Native angular composition table is absent.')
    angular_values={k:_number(v) for k,v in re.findall(r'([spdfghijk]):\s*('+NUMBER+r')',angular_block[1])}
    angular={k:angular_values.get(k,0.) for k in ('s','p','d','f')}; angular['other']=sum(v for k,v in angular_values.items() if k not in angular)
    total=sum(r['value'] for r in rows)
    if abs(total-100)>max(.01,len(rows)*1e-5): raise OrbitalError('analysis-composition-sum','Full orbital atom compositions do not sum to 100 percent.')
    return dict(unit='percent',orbitalKey=key,atoms=rows,angular=angular,sum=total)

class RespDialogue:
    """Reply to native missing-radius and result prompts in their own states."""
    def __init__(self):
        self.state='fit'; self.partial=''; self.pending=None; self.prompt_started=None; self.radii={}

    def feed(self,text,reply):
        lines=(self.partial+text).split('\n'); self.partial=lines.pop()
        for line in lines:
            if self.state=='fit':
                default=re.search(r'Element:\s*([A-Z][a-z]?)\s+vdW radius \(Angstrom\):\s*('+NUMBER+r')',line)
                if default:
                    self.radii[default[1]]=('native automatic',default[2])
                missing=re.search(r'vdW radius used in fitting for\s+([A-Z][a-z]?)\s+is missing',line)
                if missing:
                    if self.pending: raise OrbitalError('analysis-resp-radius','The previous RESP radius did not receive a native assignment.')
                    self.pending=missing[1]; self.prompt_started=time.monotonic()
                if self.pending and re.search(r'pressing ENTER button directly.*UFF radii scaled by 1/1\.2',line,re.I):
                    self.prompt_started=None
                    reply('\n')
                assigned=re.search(r'Radius of\s+([A-Z][a-z]?)\s+has been set to\s*('+NUMBER+r')\s+Angstrom',line)
                if assigned and self.pending==assigned[1]:
                    if self.prompt_started is not None or _number(assigned[2])<=0:
                        raise OrbitalError('analysis-resp-radius',f'Native RESP did not provide a valid UFF/1.2 radius for {assigned[1]}.')
                    self.radii[assigned[1]]=('native UFF/1.2',assigned[2]); self.pending=None
                if 'If outputting atom coordinates with charges to source.chg' in line:
                    if self.pending: raise OrbitalError('analysis-resp-radius',f'Native RESP did not confirm a radius for {self.pending}.')
                    reply('y\n'); self.state='resp-menu'
            elif self.state=='resp-menu' and 'Calculation of RESP charges' in line:
                reply('0\n'); self.state='charge-menu'
            elif self.state=='charge-menu' and 'Population analysis and atomic charges' in line:
                reply('0\n'); self.state='main-menu'
            elif self.state=='main-menu' and 'Main function menu' in line:
                reply('q\n'); self.state='done'

    def check_prompt(self):
        if self.prompt_started is not None and time.monotonic()-self.prompt_started>10:
            raise OrbitalError('analysis-resp-radius',f'原生 RESP 缺少 {self.pending} 的半径，且未提供可用的 UFF/1.2 替代。')


def run_native(arguments,answers,work,timeout=None,env=None,memory_budget_bytes=None,progress=None,resources=None,dialogue=None):
    from multiwfn_progress import NativeProgressScanner, report_progress
    log=work/'native-output.txt'
    scanner=NativeProgressScanner(progress);offset=0
    def reply(text):
        process.stdin.write(text.encode('ascii')); process.stdin.flush()
    def observe():
        nonlocal offset
        if progress is None and dialogue is None: return False
        try:
            with log.open('rb') as stream:
                stream.seek(offset); chunk=stream.read(65536)
            offset+=len(chunk)
            text=chunk.decode('utf-8',errors='replace').replace('\r','')
            scanner.feed(text)
            if dialogue is not None: dialogue.feed(text,reply)
            return bool(chunk)
        except OSError:
            return False
    with log.open('wb') as output:
        interactive_env=dict(env or os.environ,GFORTRAN_UNBUFFERED_ALL='1',FOR_DISABLE_BUFFERING='TRUE') if dialogue is not None else env
        process=start_multiwfn(arguments,resources=resources,cwd=work,env=interactive_env,stdin=subprocess.PIPE,stdout=output,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        job=_windows_owned_job(process,total_physical_memory() if memory_budget_bytes is None else memory_budget_bytes)
        try:
            reply(answers)
            if dialogue is None: process.stdin.close()
            deadline=None if timeout is None else time.monotonic()+timeout
            while process.poll() is None:
                if deadline is not None and time.monotonic()>deadline: raise OrbitalError('analysis-timeout','Native analysis exceeded its bounded deadline.')
                observe()
                if dialogue is not None: dialogue.check_prompt()
                time.sleep(.05)
            text=log.read_text(encoding='utf-8',errors='replace').replace('\r','')
            while (progress is not None or dialogue is not None) and offset<log.stat().st_size:
                if not observe(): break
            if process.returncode!=0: raise OrbitalError('analysis-native','Native analysis failed: '+text[-1800:])
            if dialogue is not None and dialogue.state!='done': raise OrbitalError('analysis-menu','Native RESP did not complete its result and menu sequence.')
            return text
        finally:
            if process.stdin and not process.stdin.closed:
                try: process.stdin.close()
                except OSError: pass
            MultiwfnSession._terminate(process,job)

def capture_analysis_evidence(work,request):
    """Bounded exact UTF-8 snapshots for an explicitly enabled internal harness."""
    evidence=dict(schema='sciyue-wavefunction-analysis-evidence/v1',sessionId=request['sessionId'],sourceRevision=request['sourceRevision'],kind=request['request']['kind'],method=request['request']['method'],nativeOutput='',files={})
    for name,limit in [('native-output.txt',2*1024**2),('source.chg',1024**2),('bndmat.txt',1024**2)]:
        file=work/name
        if file.is_symlink():raise OrbitalError('analysis-evidence','Owned evidence file became a symbolic link.')
        if not file.exists():continue
        if not file.is_file() or file.stat().st_size>limit:raise OrbitalError('analysis-evidence-limit','Requested raw evidence exceeds its per-file limit; no truncated original was returned.')
        raw=file.read_bytes()
        if len(raw)>limit:raise OrbitalError('analysis-evidence-limit','Requested raw evidence grew beyond its per-file limit.')
        try:text=raw.decode('utf-8')
        except UnicodeDecodeError as exc:raise OrbitalError('analysis-evidence-encoding','Raw evidence is not lossless UTF-8; no replaced original was returned.') from exc
        if name=='native-output.txt':evidence['nativeOutput']=text
        else:evidence['files'][name]=text
    if len(json.dumps(evidence,ensure_ascii=False,separators=(',',':')).encode('utf-8'))>4*1024**2:raise OrbitalError('analysis-evidence-limit','Requested raw evidence exceeds 4 MiB; no truncated original was returned.')
    return evidence

def analyze(request,progress=None,evidence_callback=None):
    from multiwfn_progress import report_progress
    report_progress(progress,'reading',stageId='analysis-source')
    params=request['request']; kind=params['kind']; method=params['method']
    if (request.get('captureEvidence') is not None and not isinstance(request['captureEvidence'],bool)) or (request.get('captureEvidence') is True and evidence_callback is None):raise OrbitalError('analysis-evidence','Evidence capture requires an internal callback.')
    if request.get('densityCube') or 'baderExecutable' in request: raise OrbitalError('analysis-not-available','Independent density Cube execution is not part of this version scope.')
    source=Path(request['sourcePath']).resolve()
    metadata=inspect_wavefunction(source)
    if metadata['sourceSha256']!=request['sourceRevision']: raise OrbitalError('source-changed','Wavefunction analysis source revision changed.')
    trusted_expectation=trusted_source_expectation(request.get('trustedSourceExpectation'),metadata)
    if any(k in params for k in ('expectedCharge','trustedSourceExpectation','trustedExpectedCharge')):raise OrbitalError('analysis-request','Renderer analysis parameters cannot set trusted charge expectations.')
    bader_plan=None; bader_reference=None
    if kind=='charges' and method=='bader':
        from bader_analysis import source_reference, grid_plan, assert_budget
        bader_reference=source_reference(source.read_text(encoding='utf-8-sig'),metadata)
    elif 'bader' in params: raise OrbitalError('analysis-method','Bader parameters require a Bader charge request.')
    executable=Path(request['executable']).resolve()
    requested=request.get('resources') or {}
    resources,settings=resolve_resources(executable,requested.get('threads'),requested.get('memoryBudgetBytes'))
    settings, gxtb_density = gxtb_valence_settings(settings, metadata)
    if bader_reference is not None:
        bader_plan=grid_plan(metadata['atoms'],metadata['basisCount'],metadata['sourceBytes'],params.get('bader'),resources['threads'])
        supplied=request.get('baderGridPlan')
        if supplied is not None:
            scalar_mismatch=any(supplied.get(k)!=bader_plan[k] for k in ('dimensions','estimatedMemoryBytes','threads','threadStackBytes'))
            vector_mismatch=any(not isinstance(supplied.get(k),list) or len(supplied[k])!=3 or any(isinstance(n,bool) or not isinstance(n,(int,float)) or not math.isfinite(n) or abs(n-v)>1e-10 for n,v in zip(supplied[k],bader_plan[k])) for k in ('originBohr','spacingBohr'))
            if scalar_mismatch or vector_mismatch: raise OrbitalError('bader-grid-plan','Host and worker Bader grid/resource plans disagree.')
    require_native_binary_grant(resources, requested)
    if requested.get('settingsRevision') is not None and requested['settingsRevision']!=resources['settingsRevision']: raise OrbitalError('resource-changed','Multiwfn settings changed after resource planning; refresh the configuration.')
    memory_budget=request.get('nativeMemoryBudgetBytes',resources['memoryBudgetBytes'])
    if isinstance(memory_budget,bool) or not isinstance(memory_budget,int) or not 0<memory_budget<=resources['memoryBudgetBytes']: raise OrbitalError('analysis-memory','Invalid available native memory budget.')
    if bader_plan is not None: assert_budget(bader_plan,memory_budget)
    root=Path(request['workspacePath']).resolve(); work=Path(tempfile.mkdtemp(prefix='numerical-',dir=root))
    try:
        shutil.copyfile(source,work/('source.molden' if metadata['format']=='molden' else 'source.fchk'))
        if bader_plan is not None:
            # An inherited ibasinlocmin=1 would integrate density minima rather
            # than nuclear maxima. Scope the scientific override to this job.
            settings=_override(settings,'ibasinlocmin',0)
        (work/'settings.ini').write_bytes(settings)
        density_parameters={}; dialogue=None
        if kind=='charges':
            menus={'mulliken':['7','5','1','y','0','0','q'],'lowdin':['7','6','','y','0','q'],'adch':['7','11','1','y','0','q'],'hirshfeld':['7','1','1','y','0','q'],'hirshfeld-i':['7','15','1','y','0','q'],'cm5':['7','16','1','y','0','q'],'resp':['7','18','1'],'scpa':['7','7','y','0','q']}
            if method!='bader' and method not in menus: raise OrbitalError('analysis-method','Unsupported atomic charge method.')
            answers=menus.get(method,[])
            if method=='resp': dialogue=RespDialogue()
            if method=='hirshfeld-i':
                density_parameters,_=prepare_hirshfeld_densities(executable,metadata,work,required=False)
                # Even if a future native version requests an unexpected state,
                # the job must not launch the user's configured upstream engine.
                disabled_gaussian='"'+str(work/'upstream-disabled.exe')+'"'
                (work/'settings.ini').write_bytes(_override(settings,'gaupath',disabled_gaussian))
                density_parameters['upstreamCalculation']='disabled in job-local settings'
        elif kind=='bond-orders':
            option={'mayer':'1','wiberg-lowdin':'3','mulliken':'4','laplacian':'8','fuzzy':'7'}.get(method)
            if not option: raise OrbitalError('analysis-method','Unsupported continuous bond order method.')
            answers=['9',option,'y','0','q']
        elif kind=='composition':
            orbital=next((o for o in metadata['orbitals'] if o['id']==params['orbitalKey']),None)
            if not orbital or method not in ('mulliken','scpa'): raise OrbitalError('analysis-orbital','Select an existing source orbital and an explicit supported composition method.')
            answers=['8','1' if method=='mulliken' else '3',str(orbital['multiwfnIndex']),'0','-10','q']
        else: raise OrbitalError('analysis-kind','Unsupported wavefunction numerical analysis.')
        threads_text=str(resources['threads'])
        env=dict(os.environ,Multiwfnpath=str(executable.parent),OMP_NUM_THREADS=threads_text,OPENBLAS_NUM_THREADS=threads_text,MKL_NUM_THREADS=threads_text,OMP_STACKSIZE='200M')
        report_progress(progress,'running',stageId='analysis-native')
        bader_usage={}
        if bader_plan is not None:
            from bader_analysis import run_bader_native
            output=run_bader_native(executable,work,bader_plan,len(metadata['atoms']),memory_budget,env,progress,telemetry=bader_usage.update,**({'resources':resources} if 'nativeBinaryIdentity' in resources else {}))
        else:
            try:
                output=run_native([str(executable),'source.molden' if metadata['format']=='molden' else 'source.fchk'],'\n'.join(answers)+'\n',work,env=env,memory_budget_bytes=memory_budget,**({'resources':resources} if 'nativeBinaryIdentity' in resources else {}),**(dict(progress=progress) if progress is not None else {}),**({'dialogue':dialogue} if dialogue is not None else {}))
            except OrbitalError:
                if kind=='charges' and method=='hirshfeld-i' and (work/'native-output.txt').is_file():
                    log=(work/'native-output.txt').read_text(encoding='utf-8',errors='replace')
                    issue=hirshfeld_missing_reference(log)
                    if issue: raise OrbitalError('analysis-atomic-density',issue)
                raise
        report_progress(progress,'parse',stageId='analysis-result')
        if kind=='charges' and method=='hirshfeld-i' and 'All atomic charges have converged' not in output:
            issue=hirshfeld_missing_reference(output)
            if issue: raise OrbitalError('analysis-atomic-density',issue)
        version=re.search(r'Version\s+([^\n]+)',output); threads=re.search(r'Number of parallel threads:\s*(\d+)',output)
        if not version or not threads or int(threads[1])!=resources['threads']: raise OrbitalError('analysis-backend','Native version/actual thread count could not be verified.')
        if output.count('************ Main function menu')<2: raise OrbitalError('analysis-menu','Native analysis did not return to its main menu.')
        verify_trusted_native_electrons(output,trusted_expectation)
        from wavefunction_prerequisites import xtb_native_prerequisites
        total_density = kind=='bond-orders' and method in ('laplacian','fuzzy')
        if gxtb_density:
            if native_output_has_edf(output):
                raise OrbitalError('analysis-gxtb-density', 'Multiwfn added EDF to this g-xTB source despite the job-local isupplyEDF=0 setting.')
            native_source = gxtb_density
        else:
            native_source=xtb_native_prerequisites(metadata,output,trusted_expectation,require_total_density=total_density)
        if native_source and not gxtb_density and kind=='bond-orders' and method!='laplacian' and any(min(abs(o['occupation']),abs(o['occupation']-2))>1e-7 for o in metadata['orbitals']):
            raise OrbitalError('analysis-xtb-spin', 'This spin-summed xTB source lacks the independent spin matrices required by this bond-order route; Laplacian total-density analysis remains available.')
        if bader_plan is not None:
            from bader_analysis import parse_bader
            result=parse_bader(output,metadata,bader_reference,bader_plan)
        else: result=parse_charge(work,metadata,output,trusted_expectation) if kind=='charges' else parse_bonds(work,metadata) if kind=='bond-orders' else parse_composition(metadata,output,params['orbitalKey'])
        parameters=dict(nativeMenu=' → '.join(a if a else '(Enter)' for a in (answers if dialogue is not None else answers[:-1])),printThresholdPercent=0,memoryBudgetBytes=memory_budget,**density_parameters)
        if native_source: parameters.update(native_source)
        if trusted_expectation is not None:parameters.update(chargeExpectationSource='owned-'+trusted_expectation['kind'],chargeExpectationArtifactId=trusted_expectation['artifactId'],chargeExpectationSourceSha256=trusted_expectation['sourceSha256'],expectedCharge=trusted_expectation['charge'],requestedUhf=trusted_expectation['requestedUhf'],sourceSpinResolution=trusted_expectation['sourceSpinResolution'],independentAlphaBeta=trusted_expectation['independentAlphaBeta'],representedElectronCount=trusted_expectation['representedElectronCount'],physicalElectronCount=trusted_expectation['physicalElectronCount'])
        if bader_plan is not None: parameters.update(nativeMenu='17 → 1 → 1 → 7 (explicit grid) → 7 → 2 → 1',integration='mixed-exact',basinExtrema='maxima (job-local ibasinlocmin=0)',spacingBohr=bader_plan['spacingBohr'],dimensions=bader_plan['dimensions'],paddingBohr=bader_plan['paddingBohr'],scientificAcceptance='pending-native-calibration')
        for source_key,target_key in [('peakCommitBytes','nativePeakCommitBytes'),('peakWorkingSetBytes','nativePeakWorkingSetBytes'),('hardBudgetBytes','nativeHardMemoryBudgetBytes'),('closed','nativeProcessClosed'),('returncode','nativeExitCode'),('windowsJobAttached','nativeJobAttached')]:
            if source_key in bader_usage:parameters[target_key]=bader_usage[source_key]
        grid=re.search(r'Radial (?:points|grids):\s*(\d+)\s+Angular (?:points|grids):\s*(\d+)',output)
        if grid: parameters.update(radialPoints=int(grid[1]),angularPoints=int(grid[2]))
        if kind=='charges' and method=='hirshfeld-i': parameters.update(hirshfeld_convergence(output))
        if kind=='charges' and method=='resp':
            if 'Successfully converged!' not in output or 'convergence failed' in output.lower(): raise OrbitalError('analysis-convergence','RESP fitting did not confirm native convergence.')
            points=re.search(r'Number of MK fitting points used:\s*(\d+)',output)
            fit=re.search(r'RMSE:\s*('+NUMBER+r')\s+RRMSE:\s*('+NUMBER+r')',output)
            if not points or not fit: raise OrbitalError('analysis-convergence','RESP fitting point/error evidence is incomplete.')
            parameters.update(protocol='standard two-stage RESP',fittingPoints='MK',fittingPointCount=int(points[1]),rmse=_number(fit[1]),rrmse=_number(fit[2]),secondStage='skipped: no fitted atoms' if 'Stage 2 of standard RESP fitting is skipped' in output else 'performed')
            parameters['fittingRadiiAngstromReadback']='; '.join(f'{element}: {radius} ({source})' for element,(source,radius) in dialogue.radii.items())
        if kind=='charges' and method in ('adch','hirshfeld','cm5'): parameters['atomicDensity']='built-in spherical free atoms'
        warnings=[line.strip() for line in output.splitlines() if re.search(r'^\s*(?:Warning:|NOTE:.*(?:EDF|inner-core))',line,re.I)]
        if bader_plan is not None:
            nna=sum(b['role']=='non-nuclear' for b in result['bader']['basins'])
            if nna: warnings.append(f'检测到 {nna} 个非核电子盆；原子电荷和不包含这些盆的电子数，不能当作分子总净电荷。')
            remainder=[result['bader'][k] for k in ('unassigned','boundary')]
            if any(r['gridCount'] for r in remainder): warnings.append('存在未归属或到达盒边界的网格（对应电子数 '+format(sum(r['electronPopulation'] for r in remainder),'.10g')+' e）；这些电子未分配给原子。')
        has_spin=any(o['spin']!='restricted' for o in metadata['orbitals']) or (metadata.get('multiplicity') or 1)>1
        if kind=='charges' and not result['spinAvailable'] and has_spin: warnings.append('This method/source did not provide an independent spin population table.')
        geometry_identity=hashlib.sha256(json.dumps(metadata['atoms'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        resources['nativeMemoryBudgetBytes']=memory_budget
        result.update(sessionId=request['sessionId'],sourceRevision=metadata['sourceSha256'],geometryIdentity=geometry_identity,coordinateUnit='bohr',parameters=parameters,kind=kind,method=method,backend=dict(name='Multiwfn',version=version[1].strip(),threads=resources['threads']),resources=resources,warnings=warnings)
        return result
    finally:
        evidence_error=None
        if request.get('captureEvidence') is True:
            try:evidence_callback(capture_analysis_evidence(work,request))
            except Exception as exc:evidence_error=exc
        # The work directory was created by this call, contains only owned tool
        # outputs, and is never followed through links during exact-file cleanup.
        # In the opt-in evidence harness the host owns final exact-file cleanup
        # after its async evidence callback settles. Normal product jobs retain
        # the original immediate worker cleanup behavior.
        if request.get('captureEvidence') is not True:
            for item in work.iterdir():
                if item.is_file() and not item.is_symlink(): item.unlink()
                elif item.name=='atmrad' and item.is_dir() and not item.is_symlink():
                    for density in item.iterdir():
                        if density.is_file() and not density.is_symlink(): density.unlink()
                    item.rmdir()
            try: work.rmdir()
            except OSError: pass
        if evidence_error is not None:raise evidence_error

def main():
    try:
        raw=sys.stdin.buffer.readline()
        def progress(packet):
            sys.stderr.write('SCIYUE_MULTIWFN_PROGRESS\t'+json.dumps(packet,allow_nan=False,separators=(',',':'))+'\n');sys.stderr.flush()
        request=json.loads(raw.decode('utf-8'));evidence=[]
        result=analyze(request,progress,evidence.append if request.get('captureEvidence') is True else None)
        from analysis_result_wire import managed_result
        result=managed_result(result, request['workspacePath'])
        print(json.dumps(dict(ok=True,result=result,**(dict(evidence=evidence[0]) if evidence else {})),allow_nan=False,separators=(',',':'))); return 0
    except Exception as exc:
        print(json.dumps(dict(ok=False,error=dict(code=getattr(exc,'code','analysis-failure'),message=str(exc)),**(dict(evidence=evidence[0]) if 'evidence' in locals() and evidence else {})),allow_nan=False,separators=(',',':'))); return 1

if __name__=='__main__': raise SystemExit(main())
