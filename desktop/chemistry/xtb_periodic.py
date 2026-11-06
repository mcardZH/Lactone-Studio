"""Fixed-cell xTB outer optimization. Only movable Cartesian entries are variables.

The owned host supplies all executable/workspace paths. Native calls are isolated
energy+gradient evaluations, never native geometry optimization or atom fixing.
"""
from __future__ import annotations
import copy
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
from orbitals import _windows_owned_job
from gfnff_topology import prepare_topology as prepare_gfnff_topology, accept_topology as accept_gfnff_topology, runtime_seed_identity
from task_files import clean_evaluation

BOHR_ANGSTROM = 0.529177210903
ELEMENTS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split()

class PeriodicError(ValueError):
    def __init__(self,message,code='XTB_PERIODIC_REJECTED'):
        super().__init__(message)
        self.code=code

class Cancelled(PeriodicError):
    def __init__(self,message):
        super().__init__(message,'XTB_PERIODIC_CANCELLED')

def phase(name):
    # Opt-in is local to this worker environment, never a persistent setting.
    # Only fixed phase names may reach stderr, not request or path values.
    if os.environ.get('SCIYUE_XTB_PERIODIC_TRACE_PHASES') == '1':
        require(name in ('initial-read','initial-decoded','construct-start','construct-ready',
                         'optimizer-init','optimizer-ready','control-start','control-reading','first-eval'),
                'Unknown periodic diagnostic phase')
        sys.stderr.write(json.dumps(dict(xtbPeriodicPhase=name),separators=(',',':'))+'\n')
        sys.stderr.flush()


def optimizer_callable():
    from scipy.optimize import minimize
    return minimize


def require(condition, message):
    if not condition: raise PeriodicError(message)

def finite_number(value):
    try:result=float(value.replace('D','E').replace('d','e'))
    except ValueError:
        raise PeriodicError('Nonfinite or overflowed native energy/gradient value','XTB_PERIODIC_NONFINITE_RESULT') from None
    if not math.isfinite(result):
        raise PeriodicError('Nonfinite or overflowed native energy/gradient value','XTB_PERIODIC_NONFINITE_RESULT')
    return result

def validate(request):
    require(isinstance(request,dict) and request.get('method') in ('gfnff','gfn0','gfn1','gfn2'),'Unknown periodic method')
    require(request.get('calculation','optimize')=='optimize' and not request.get('constraints'),'Only Cartesian fixed-cell optimization is verified')
    atoms=request['structure']['atoms']; cell=request['structure']['cell']
    require(request['structure'].get('periodicSource',{}).get('completeness')!='partial','Partial translation vectors are not a complete run cell')
    require(isinstance(atoms,list) and 0<len(atoms),'Invalid source atoms')
    ids=[atom.get('id') for atom in atoms]
    require(all(isinstance(i,str) and i for i in ids) and len(set(ids))==len(ids),'Stable unique source atom identities required')
    positions=np.asarray([[a[k] for k in ('x','y','z')] for a in atoms],dtype=float)
    require(positions.shape==(len(atoms),3) and np.isfinite(positions).all() and np.max(np.abs(positions))<=1e6,'Invalid source coordinates')
    require(all(a.get('element') in ELEMENTS for a in atoms),'Unsupported source elements')
    vectors=np.asarray(cell['vectors'],dtype=float)
    require(vectors.shape==(3,3) and np.isfinite(vectors).all() and abs(np.linalg.det(vectors))>=1e-10,'A finite complete nonsingular cell is required')
    pbc=cell.get('pbc'); require(isinstance(pbc,list) and len(pbc)==3 and all(type(v) is bool for v in pbc),'Original source axes must be retained explicitly')
    frozen=request.get('frozenAtomIds',[])
    require(isinstance(frozen,list) and len(set(frozen))==len(frozen) and all(i in ids for i in frozen),'Invalid fixed atom identities')
    movable=np.asarray([i for i,a in enumerate(atoms) if a['id'] not in frozen],dtype=int)
    require(len(movable)>0,'No movable atoms')
    charge=request.get('charge'); uhf=request.get('uhf',0 if request['method']=='gfnff' else None)
    require(type(charge) is int and abs(charge)<=100,'Explicit integer charge required')
    electrons=sum(ELEMENTS.index(a['element'])+1 for a in atoms)-charge
    require(electrons>0,'Invalid electron count')
    require(type(uhf) is int and (uhf==0 if request['method']=='gfnff' else 0<=uhf<=electrons and (electrons-uhf)%2==0),'Invalid requested spin')
    require(type(request.get('maxSccIterations',250)) is int and 1<=request.get('maxSccIterations',250)<=9007199254740991,'Invalid SCC iteration limit')
    thread_limit=max(1,os.cpu_count() or 1)
    require(type(request.get('threads')) is int and 1<=request['threads']<=thread_limit,'Invalid thread limit')
    require(type(request.get('maxSteps')) is int and 1<=request['maxSteps']<=9007199254740991,'Invalid iteration limit')
    require('maxWallTimeSeconds' not in request or type(request['maxWallTimeSeconds']) in (int,float) and math.isfinite(request['maxWallTimeSeconds']) and 0<request['maxWallTimeSeconds'],'Invalid wall limit')
    return positions,vectors,movable

def coordinate_input(atoms,positions_bohr,vectors_bohr):
    lines=['$coord']+[' '.join(format(float(v),'.17g') for v in point)+' '+a['element'].lower() for a,point in zip(atoms,positions_bohr)]
    return '\n'.join(lines+['$periodic 3','$lattice bohr']+[' '.join(format(float(v),'.17g') for v in row) for row in vectors_bohr]+['$end',''])

def parse_engrad(text,atoms,positions_bohr,cell_bohr=None,geometry=None):
    require('The current total energy in Eh' in text and 'The current gradient in Eh/bohr' in text and 'current coordinates in Bohr' in text,'Native gradient units missing')
    lines=[line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith('#')]
    count=len(atoms); require(len(lines)==2+3*count+count and re.fullmatch(r'\d+',lines[0]) is not None and int(lines[0])==count,'Incomplete native gradient inventory')
    energy=finite_number(lines[1]); gradient=np.asarray([finite_number(v) for v in lines[2:2+3*count]],dtype=float).reshape(count,3)
    # Only this call's written full XYZ-periodic cell can certify a native wrap.
    # Fail closed outside this float64 adapter's numerical trust envelope; these
    # limits do not change the Hamiltonian or enlarge the writer allowance.
    cell=np.asarray(cell_bohr,dtype=float); positions=np.asarray(positions_bohr,dtype=float)
    require(cell.shape==(3,3) and np.isfinite(cell).all(),'Complete finite written periodic cell required for native gradient')
    require(positions.shape==(count,3) and np.isfinite(positions).all(),'Invalid requested gradient geometry')
    try:
        condition=float(np.linalg.cond(cell))
        inverse=np.linalg.inv(cell.T)
    except np.linalg.LinAlgError: raise PeriodicError('Unreliable periodic gradient cell') from None
    require(math.isfinite(condition) and condition<=1e8,'Unreliable periodic gradient cell')
    allowance=5.1e-8; epsilon=np.finfo(float).eps
    require(np.isfinite(inverse).all() and allowance*float(np.linalg.norm(inverse,ord=np.inf))<=1/16,
            'Periodic gradient cell is unresolved at the writer precision')
    native_positions=[]; native_images=[]
    for i,line in enumerate(lines[2+3*count:]):
        fields=line.split(); require(len(fields)==4 and fields[0].isdigit() and int(fields[0])==ELEMENTS.index(atoms[i]['element'])+1,'Native gradient atom identity/order changed')
        xyz=np.asarray([finite_number(v) for v in fields[1:]])
        delta=xyz-positions[i]
        try: fractional=np.linalg.solve(cell.T,delta)
        except np.linalg.LinAlgError: raise PeriodicError('Unreliable periodic gradient cell') from None
        require(np.isfinite(fractional).all() and np.max(np.abs(fractional))<2**52,
                'Unreliable periodic gradient image')
        # Bound solve roundoff well below half an integer. Cartesian arithmetic
        # uncertainty must separately be <1% of the original writer allowance;
        # only the final Cartesian residual decides geometric equivalence.
        require(32*epsilon*condition*max(1.,float(np.max(np.abs(fractional))))<=1/16,
                'Unreliable periodic gradient image')
        image=np.rint(fractional)
        with np.errstate(over='ignore',invalid='ignore'):
            translated=image@cell
            scale=max(1.,float(np.max(np.abs(xyz))),float(np.max(np.abs(positions[i]))),
                      float(np.max(np.abs(image)@np.abs(cell))))
        require(np.isfinite(translated).all() and math.isfinite(scale) and 32*epsilon*scale<=allowance/100,
                'Unreliable periodic gradient image')
        # ORCA writer prints f12.7 Bohr. Keep its original Cartesian allowance
        # after an integer lattice translation, never rotate/reorder/modify g.
        require(np.max(np.abs(delta-translated))<=allowance,'Native gradient belongs to another geometry')
        native_positions.append(xyz.tolist());native_images.append(image.astype(int).tolist())
    if geometry is not None:geometry.update(nativeCoordinatesBohr=native_positions,nativeImages=native_images)
    return energy,gradient

def native_status(output,errors,request,runtime_version):
    combined=output+'\n'+errors
    if re.search(r'FAILED TO CONVERGE|convergence criteria cannot be satisfied|SCF not converged',combined,re.I):
        raise PeriodicError('Native electronic self-consistency did not converge','XTB_PERIODIC_SCF_NOT_CONVERGED')
    require('normal termination of xtb' in errors.lower(),'Native singlepoint did not terminate normally')
    version=re.search(r'\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)',output,re.I)
    require(version is not None and version.group(1)==runtime_version,'Actual xTB version differs from the registered runtime')
    require(not re.search(r'ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR|Single point calculation terminated',combined,re.I),'Native SCF/singlepoint failure')
    require('Periodic properties' in output and not re.search(r'GEOMETRY OPTIMIZATION|Fast Inertial Relaxation Engine|RF solver',output),'Expected a periodic singlepoint, never a native optimizer')
    if request['method']=='gfn1': require(re.search(r'convergence criteria satisfied after\s+\d+\s+iterations',output,re.I),'Native GFN1 SCC convergence missing')
    energies=re.findall(r'\|\s*TOTAL ENERGY\s+([-+\d.eEdD]+)\s+Eh\s*\|',output)
    require(len(energies)==1,'Same-call total energy missing or ambiguous')
    return finite_number(energies[0])

def native_timings(output):
    def seconds(match):return int(match[0])*86400+int(match[1])*3600+int(match[2])*60+float(match[3])
    pattern=r'wall-time:\s*(\d+)\s*d,\s*(\d+)\s*h,\s*(\d+)\s*min,\s*([\d.]+)\s*sec'
    walls=re.findall(pattern,output);result={}
    if walls:result['reportedTotalWallSeconds']=seconds(walls[0])
    electronic=re.findall(pattern,output.rsplit('\n SCF:',1)[-1]) if '\n SCF:' in output else []
    if electronic:result['reportedElectronicWallSeconds']=seconds(electronic[0])
    eg=re.search(r'E\+G \(total\)\s*(\d+)\s*d,\s*(\d+)\s*h,\s*(\d+)\s*min,\s*([\d.]+)\s*sec',output)
    if eg:result['reportedEnergyGradientWallSeconds']=seconds(eg.groups())
    return result

class PeriodicEvaluator:
    def __init__(self,request,runtime,workspace,cancel=None):
        self.request=copy.deepcopy(request); self.initial,self.vectors,self.movable=validate(request)
        self.initial_bohr=self.initial/BOHR_ANGSTROM; self.vectors_bohr=self.vectors/BOHR_ANGSTROM
        self.runtime=runtime; self.workspace=Path(workspace).resolve()
        require(self.workspace.is_dir() and not self.workspace.is_symlink(),'Owned workspace must already exist')
        for key in ('executable','directory','dataDirectory'):
            require(Path(runtime[key]).is_absolute(),'Runtime paths must be host-resolved')
        require(Path(runtime['executable']).name.lower() in ('xtb.exe','xtb'),'Only the trusted xTB runtime is accepted')
        self.cancel=cancel or threading.Event(); self.started=time.monotonic(); self.history=[]; self.current=None
        self.last=None; self.evaluations=0; self.observer=lambda _event:None
        self.gfnff_seed=None; self.gfnff_seed_sha256=None; self.gfnff_seed_images=None; self.gfnff_seed_identity=None
        self.electronic_seed=None;self.electronic_seed_sha256=None;self.electronic_seed_identity=None
        self.optimization=None;self.accepted=None;self.attempts=[]
        self.timings=dict(nativeProcessSeconds=0.,evaluationSeconds=0.,optimizerSeconds=0.,optimizerOverheadSeconds=0.)
        phase('construct-ready'); phase('optimizer-init')
        self.minimize=optimizer_callable()
        self.timings['workerInitializationSeconds']=time.monotonic()-self.started
        phase('optimizer-ready')

    def current_check(self):
        if self.cancel.is_set(): raise Cancelled('Periodic optimization cancelled')
        if self.request.get('maxWallTimeSeconds') is not None and time.monotonic()-self.started>=self.request['maxWallTimeSeconds']:
            raise PeriodicError('Periodic optimization wall budget exceeded','XTB_PERIODIC_WALL_LIMIT')

    def positions(self,variable):
        self.current_check(); variable=np.asarray(variable,dtype=float)
        require(variable.size==3*len(self.movable) and np.isfinite(variable).all(),'Invalid movable coordinates')
        full=self.initial_bohr.copy(); full[self.movable]=variable.reshape(-1,3)
        return full

    def coordinates(self,variable):
        # Fixed coordinates are never optimizer variables, not corrected after optimization.
        full=self.positions(variable); movable=set(self.movable.tolist())
        return [dict(id=a['id'],element=a['element'],**{axis:float(full[i,j]*BOHR_ANGSTROM) if i in movable else a[axis] for j,axis in enumerate(('x','y','z'))}) for i,a in enumerate(self.request['structure']['atoms'])]

    def evidence(self):
        import scipy
        result=dict(sourceCell=copy.deepcopy(self.request['structure']['cell']),sourcePbc=list(self.request['structure']['cell']['pbc']),effectivePbc=[True,True,True],fixedCell=True,optimizer='scipy-lbfgsb',optimizerVersion=scipy.__version__,backend='tblite' if self.request['method']=='gfn2' else 'native',gradientUnit='hartree/bohr')
        if self.request['method']=='gfnff': result['forceFieldTopologySha256']=self.gfnff_seed_sha256
        return result

    def prepare_topology(self,directory):
        if self.request['method']!='gfnff': return False
        current=runtime_seed_identity(self.runtime,self.request,require)
        if self.gfnff_seed is not None:require(self.gfnff_seed_identity==current,'Owned GFN-FF seed belongs to another engine/build/parameter set')
        return prepare_gfnff_topology(directory,self.gfnff_seed,self.gfnff_seed_sha256,require)

    def accept_topology(self,directory,output,seeded):
        if self.request['method']!='gfnff': return
        current=runtime_seed_identity(self.runtime,self.request,require)
        if seeded:require(self.gfnff_seed_identity==current,'Owned GFN-FF seed belongs to another engine/build/parameter set')
        self.gfnff_seed,self.gfnff_seed_sha256=accept_gfnff_topology(directory,output,seeded,self.gfnff_seed,self.gfnff_seed_sha256,require)
        self.gfnff_seed_identity=current

    def electronic_identity(self):
        return runtime_seed_identity(self.runtime,self.request,require)

    def prepare_electronic(self,directory):
        if self.request['method'] not in ('gfn1','gfn2'):return False
        if self.electronic_seed is not None:
            if self.electronic_seed_identity!=self.electronic_identity() or hashlib.sha256(self.electronic_seed).hexdigest()!=self.electronic_seed_sha256:
                self.electronic_seed=None;self.electronic_seed_sha256=None;self.electronic_seed_identity=None
            else:
                with (directory/'xtbrestart').open('xb') as handle:handle.write(self.electronic_seed)
                return True
        return False

    def accept_electronic(self,directory,output,seeded,record):
        if self.request['method'] not in ('gfn1','gfn2'):return
        # Native restart only seeds SCC. This call still needs its own normal
        # termination, electronic convergence and matching E/G artifacts.
        record['electronicRestartReadConfirmed']=bool(seeded and ('q/qsh data taken from xtbrestart' in output if self.request['method']=='gfn1' else 'Wavefunction read from restart file' in output))
        member=directory/'xtbrestart'
        if not member.exists():
            self.electronic_seed=None;self.electronic_seed_sha256=None;self.electronic_seed_identity=None
            record['electronicRestartAvailable']=False;return
        require(member.is_file() and not member.is_symlink() and member.stat().st_nlink==1,'Native electronic restart is not an owned regular file')
        raw=member.read_bytes();require(len(raw)>0,'Native electronic restart is empty')
        self.electronic_seed=raw;self.electronic_seed_sha256=hashlib.sha256(raw).hexdigest();self.electronic_seed_identity=self.electronic_identity()
        record.update(electronicRestartAvailable=True,electronicRestartOutputSha256=self.electronic_seed_sha256,electronicRestartIdentity=self.electronic_seed_identity)

    def force_field_coordinates(self,full):
        images=np.zeros_like(full,dtype=int);translation=np.zeros(3)
        if self.request['method']=='gfnff' and self.gfnff_seed_images is not None:
            # The initial native topology is indexed in its original wrapped
            # atom representatives. Keep those fixed lifts, then translate ALL
            # backend atoms together into an interior chart. A common shift
            # changes neither the periodic Hamiltonian nor Cartesian forces;
            # model/frozen coordinates stay in the source chart throughout.
            images=np.asarray(self.gfnff_seed_images,dtype=int)
            lifted=full+images@self.vectors_bohr
            try:fractional=np.linalg.solve(self.vectors_bohr.T,lifted.T).T
            except np.linalg.LinAlgError:raise PeriodicError('Unreliable fixed-topology backend cell','XTB_PERIODIC_FORCE_FIELD_IMAGE_CHANGED') from None
            low=fractional.min(axis=0);high=fractional.max(axis=0)
            if not np.isfinite(fractional).all() or np.any(high-low>=1-2e-8):
                raise PeriodicError('The current fixed-topology atom representatives no longer fit one periodic backend chart; no topology or atom image was changed','XTB_PERIODIC_FORCE_FIELD_IMAGE_CHANGED')
            translation=((1-low-high)/2)@self.vectors_bohr
            full=lifted+translation
        return full,dict(backendAtomImages=images.tolist(),backendTranslationBohr=translation.tolist(),backendCoordinatesBohr=full.tolist())

    def evaluate(self,variable):
        started=time.monotonic();before=len(self.history)
        try:return self._evaluate(variable)
        finally:
            if len(self.history)>before:
                record=self.history[-1];record['evaluationSeconds']=time.monotonic()-started
                self.timings['evaluationSeconds']+=record['evaluationSeconds']
                (Path(record['directory'])/'process.json').write_text(json.dumps(record,indent=2,allow_nan=False)+'\n',encoding='utf-8')
                if record['closed']:
                    clean_evaluation(Path(record['directory']))
                    # Raw coordinates/gradients belong only to the latest
                    # accepted state; earlier evaluations retain small receipts.
                    for old in self.history[-2:-1]:
                        for field in tuple(old):
                            if field not in ('closed','code','pid','inputSha256','engradSha256','processSeconds','evaluationSeconds'):
                                old.pop(field,None)

    def _evaluate(self,variable):
        self.current_check(); full=self.positions(variable)
        if self.last is not None and np.array_equal(np.asarray(variable),self.last[0]): return self.last[1],self.last[2].copy()
        if self.evaluations==0: phase('first-eval')
        backend_full,transform=self.force_field_coordinates(full)
        directory=self.workspace/f'eval-{self.evaluations:06d}'; directory.mkdir(); self.evaluations+=1
        seeded=self.prepare_topology(directory)
        electronic_seeded=self.prepare_electronic(directory)
        text=coordinate_input(self.request['structure']['atoms'],backend_full,self.vectors_bohr); source=directory/'input.coord'; source.write_text(text,encoding='ascii',newline='\n')
        argv=[self.runtime['executable'],'input.coord']+(['--gfnff'] if self.request['method']=='gfnff' else ['--gfn',self.request['method'][-1]])+(['--tblite'] if self.request['method']=='gfn2' else [])+['--grad']+(['--iterations',str(self.request.get('maxSccIterations',250))] if self.request['method'] in ('gfn1','gfn2') else [])+['--chrg',str(self.request['charge'])]+([] if self.request['method']=='gfnff' else ['--uhf',str(self.request['uhf'])])+([] if seeded or self.request['method'] in ('gfn1','gfn2') else ['--norestart'])+['--parallel',str(self.request['threads'])]
        env={k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','SYSTEMDRIVE')}
        env.update(PATH=self.runtime['directory'],XTBPATH=self.runtime['dataDirectory'],HOME=str(directory),USERPROFILE=str(directory),TEMP=str(directory),TMP=str(directory),LANG='C',LC_ALL='C',OMP_NUM_THREADS=str(self.request['threads']),OMP_MAX_ACTIVE_LEVELS='1',OMP_DYNAMIC='FALSE',MKL_NUM_THREADS=str(self.request['threads']),OPENBLAS_NUM_THREADS=str(self.request['threads']))
        record=dict(directory=str(directory),argv=argv,inputSha256=hashlib.sha256(text.encode('ascii')).hexdigest(),pid=None,closed=False,code=None,signal=None)
        if self.request['method'] in ('gfn1','gfn2'):record.update(electronicRestartInputSha256=self.electronic_seed_sha256 if electronic_seeded else None,electronicRestartRequested=electronic_seeded)
        self.history.append(record); process=None; job=None; stdout=b''; stderr=b''
        process_started=time.monotonic()
        try:
            process=self.current=subprocess.Popen(argv,cwd=directory,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            record['pid']=process.pid; job=_windows_owned_job(process)
            self.observer(dict(kind='native-started',pid=process.pid))
            while True:
                try:
                    stdout,stderr=process.communicate(timeout=.1); break
                except subprocess.TimeoutExpired:
                    if self.cancel.is_set() or self.request.get('maxWallTimeSeconds') is not None and time.monotonic()>=self.started+self.request['maxWallTimeSeconds']:
                        process.kill(); stdout,stderr=process.communicate(timeout=5)
                        if self.cancel.is_set(): raise Cancelled('Periodic optimization cancelled')
                        raise PeriodicError('Native energy/gradient exceeded its explicit deadline','XTB_PERIODIC_WALL_LIMIT')
            record.update(code=process.returncode,closed=True)
        finally:
            if process is not None:
                if process.poll() is None: process.kill(); stdout,stderr=process.communicate(timeout=5)
                record.update(code=process.returncode,closed=process.poll() is not None)
                if process.stdout: process.stdout.close()
                if process.stderr: process.stderr.close()
            if job: job[0].CloseHandle(job[1])
            self.current=None
            record['processSeconds']=time.monotonic()-process_started
            self.timings['nativeProcessSeconds']+=record['processSeconds']
            if process is not None: self.observer(dict(kind='native-closed',pid=process.pid,code=process.returncode))
            (directory/'stdout.txt').write_bytes(stdout); (directory/'stderr.txt').write_bytes(stderr)
            (directory/'process.json').write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
        self.current_check()
        output=stdout.decode('utf-8',errors='replace'); errors=stderr.decode('utf-8',errors='replace')
        if (directory/'NOT_CONVERGED').exists() or (directory/'.sccnotconverged').exists() or re.search(r'FAILED TO CONVERGE|convergence criteria cannot be satisfied|SCF not converged',output+'\n'+errors,re.I):
            raise PeriodicError('Native electronic self-consistency did not converge','XTB_PERIODIC_SCF_NOT_CONVERGED')
        require(record['code']==0 and record['closed'],'Native singlepoint process failed')
        summary_energy=native_status(output,errors,self.request,self.runtime['version'])
        require(source.read_text(encoding='ascii')==text,'Singlepoint cell/coordinate input changed')
        files=list(directory.glob('*.engrad')); require(len(files)==1,'Exactly one native energy/gradient artifact required')
        geometry={}
        energy,gradient=parse_engrad(files[0].read_text(encoding='ascii'),self.request['structure']['atoms'],backend_full,self.vectors_bohr,geometry)
        require(abs(energy-summary_energy)<=1e-9,'Gradient artifact energy differs from this singlepoint')
        self.accept_topology(directory,output,seeded)
        self.accept_electronic(directory,output,electronic_seeded,record)
        selected=gradient[self.movable].reshape(-1)
        record.update(energyHartree=energy,gradientUnit='hartree/bohr',energyUnit='hartree',gradientShape=list(gradient.shape),gradient=gradient.tolist(),coordinatesBohr=full.tolist(),cellBohr=self.vectors_bohr.tolist(),engradPath=str(files[0]),engradSha256=hashlib.sha256(files[0].read_bytes()).hexdigest(),**geometry,**transform)
        record['nativeReportedTimings']=native_timings(output)
        if 'reportedTotalWallSeconds' in record['nativeReportedTimings']:
            record['outsideNativeReportedSeconds']=max(0.,record['processSeconds']-record['nativeReportedTimings']['reportedTotalWallSeconds'])
        if self.request['method']=='gfnff': record.update(forceFieldTopologySha256=self.gfnff_seed_sha256,topologyReadFromOwnedSeed=seeded)
        if self.request['method']=='gfnff':
            source_images=(np.asarray(geometry['nativeImages'],dtype=int)+np.asarray(transform['backendAtomImages'],dtype=int)).tolist()
            record['sourceNativeImages']=source_images
        if self.request['method']=='gfnff':
            if self.gfnff_seed_images is None:self.gfnff_seed_images=copy.deepcopy(source_images)
            if self.gfnff_seed_images!=source_images:
                raise PeriodicError('GFN-FF native wrapping changed atom images relative to the fixed initial topology; the rejected energy/gradient is retained in diagnostics','XTB_PERIODIC_FORCE_FIELD_IMAGE_CHANGED')
        self.last=(np.asarray(variable,dtype=float).copy(),energy,selected.copy())
        return energy,selected

    def save_optimization(self,reason,message,status=None):
        self.optimization=dict(schema='sciyue-periodic-optimization-v1',reason=reason,message=message,status=status,
                               attempts=copy.deepcopy(self.attempts),accepted=copy.deepcopy(self.accepted),
                               evaluations=self.evaluations,elapsedSeconds=time.monotonic()-self.started,
                               timings=dict(self.timings),gradientThresholdHartreePerBohr=1e-4,
                               maxSteps=self.request['maxSteps'],maxWallTimeSeconds=self.request.get('maxWallTimeSeconds'),
                               method=self.request['method'],charge=self.request['charge'],
                               **({'uhf':self.request['uhf']} if 'uhf' in self.request else {}),
                               sourceCell=copy.deepcopy(self.request['structure']['cell']),effectivePbc=[True,True,True])
        (self.workspace/'optimization.json').write_text(json.dumps(self.optimization,indent=2,allow_nan=False)+'\n',encoding='utf-8')

    def bounded_chart(self,variable):
        require(self.request['method']=='gfnff' and self.gfnff_seed_images is not None,'A fixed initial force-field topology is required for chart recovery')
        full=self.positions(variable);images=np.asarray(self.gfnff_seed_images,dtype=int)
        fractional=np.linalg.solve(self.vectors_bohr.T,(full+images@self.vectors_bohr).T).T
        shift=(1-fractional.min(axis=0)-fractional.max(axis=0))/2
        lengths=np.linalg.norm(self.vectors_bohr,axis=1)
        basis=self.vectors_bohr/lengths[:,None]
        # Variables are distances along unit lattice axes, not new physical
        # coordinates or artificial energies. g_u = basis @ g_cart; the
        # inverse-norm conversion keeps the full Cartesian force requirement.
        threshold=1e-4/max(1.,float(np.linalg.norm(np.linalg.inv(basis),ord=np.inf)))
        origin=(-shift-images[self.movable])@self.vectors_bohr
        initial=((fractional[self.movable]+shift)*lengths).reshape(-1)
        lower=np.tile(2e-8*lengths,len(self.movable));upper=np.tile((1-2e-8)*lengths,len(self.movable))
        if not np.all(initial>lower) or not np.all(initial<upper):
            raise PeriodicError('No interior fixed-topology chart remains for a bounded recovery','XTB_PERIODIC_FORCE_FIELD_IMAGE_CHANGED')
        return dict(initial=initial,lower=lower,upper=upper,basis=basis,origin=origin,gtol=threshold)

    def optimize(self,emit):
        self.current_check()
        initial=self.initial_bohr[self.movable].reshape(-1);step=0;accepted=initial.copy()
        total_evaluations=sys.maxsize  # SciPy's native counter representation; maxSteps is the user stop condition.
        self.attempts=[];self.accepted=None
        def accept(variable,frame_step):
            self.current_check();energy,gradient=self.evaluate(variable)
            self.accepted=dict(step=frame_step,coordinates=self.coordinates(variable),energyHartree=energy,
                               movableAtomIds=[self.request['structure']['atoms'][i]['id'] for i in self.movable],
                               movableGradientHartreePerBohr=np.asarray(gradient).reshape(-1,3).tolist(),
                               gradientMaxHartreePerBohr=float(np.max(np.abs(gradient))))
            emit(dict(kind='frame',step=frame_step,stepKind='outer-optimizer-iteration',coordinates=self.accepted['coordinates'],energyHartree=energy,periodic=self.evidence()))
        def callback(variable):
            nonlocal step,accepted
            require(step<self.request['maxSteps'],'Optimizer accepted more steps than the shared budget')
            candidate=np.asarray(variable).copy();accept(candidate,step+1)
            step+=1;accepted=candidate
        try:
            accept(initial,0)
            chart=None
            for attempt in range(2):
                remaining_steps=self.request['maxSteps']-step
                remaining_evaluations=total_evaluations-self.evaluations
                if remaining_steps<=0:raise PeriodicError('Periodic optimizer exhausted its total step budget','XTB_PERIODIC_STEP_LIMIT')
                if remaining_evaluations<=0:raise PeriodicError('Periodic optimizer exhausted its total evaluation budget','XTB_PERIODIC_EVALUATION_LIMIT')
                before=time.monotonic();before_evaluation_seconds=self.timings['evaluationSeconds'];attempt_step=step;attempt_evaluations=self.evaluations
                def physical(variable):return (np.asarray(variable).reshape(-1,3)@chart['basis']+chart['origin']).reshape(-1) if chart else variable
                def objective(variable):
                    energy,gradient=self.evaluate(physical(variable))
                    return energy,(np.asarray(gradient).reshape(-1,3)@chart['basis'].T).reshape(-1) if chart else gradient
                options=dict(maxiter=remaining_steps,maxfun=remaining_evaluations,maxls=20,gtol=chart['gtol'] if chart else 1e-4,ftol=1e-12 if attempt==0 else 0.)
                arguments=dict(jac=True,method='L-BFGS-B',callback=lambda variable:callback(physical(variable)),options=options)
                if chart:arguments['bounds']=list(zip(chart['lower'],chart['upper']))
                try:
                    try:result=self.minimize(objective,chart['initial'] if chart else accepted,**arguments)
                    except PeriodicError as error:
                        if attempt==0 and error.code=='XTB_PERIODIC_FORCE_FIELD_IMAGE_CHANGED' and self.accepted is not None and step<self.request['maxSteps']:
                            # Reject the invalid request without inventing E/G.
                            # One reset now uses explicit chart bounds. A
                            # projected-gradient stop at an active bound cannot
                            # pass the independent full Cartesian force gate.
                            chart=self.bounded_chart(accepted)
                            self.attempts.append(dict(attempt=attempt,reason='image-chart-trial',status=None,message=str(error),success=False,
                                                     iterations=step-attempt_step,functionEvaluations=self.evaluations-attempt_evaluations,
                                                     energyHartree=self.accepted['energyHartree'],gradientMaxHartreePerBohr=self.accepted['gradientMaxHartreePerBohr']))
                            self.save_optimization('recovering',str(error))
                            continue
                        raise
                finally:
                    elapsed=time.monotonic()-before
                    self.timings['optimizerSeconds']+=elapsed
                    self.timings['optimizerOverheadSeconds']+=max(0.,elapsed-(self.timings['evaluationSeconds']-before_evaluation_seconds))
                self.current_check();final_variable=physical(result.x);energy,gradient=self.evaluate(final_variable)
                gradient_max=float(np.max(np.abs(gradient)));message=str(getattr(result,'message',''))[:2048]
                status=getattr(result,'status',None);status=int(status) if status is not None else None
                iterations=int(result.nit)
                require(iterations>=0 and iterations<=remaining_steps,'Optimizer iteration counter exceeds the shared budget')
                # Real SciPy calls callback once per accepted iterate. Some
                # pure protocol fixtures omit callbacks for zero-step returns.
                require(step-attempt_step==iterations,'Optimizer accepted-step counter changed')
                active_bounds=int(np.count_nonzero((np.abs(result.x-chart['lower'])<=1e-7)|(np.abs(result.x-chart['upper'])<=1e-7))) if chart else 0
                reason='converged' if bool(result.success and gradient_max<=1e-4) else 'chart-boundary' if active_bounds and gradient_max>1e-4 else 'step-limit' if iterations>=remaining_steps else 'line-search' if 'ABNORMAL' in message.upper() or 'LINE SEARCH' in message.upper() else 'evaluation-limit' if 'EVALUATION' in message.upper() else 'final-gradient' if result.success else 'optimizer-failure'
                self.attempts.append(dict(attempt=attempt,reason=reason,status=status,message=message,
                                          success=bool(result.success),iterations=iterations,
                                          functionEvaluations=int(getattr(result,'nfev',0)),
                                          energyHartree=energy,gradientMaxHartreePerBohr=gradient_max,
                                          coordinateChart='bounded-lattice-axes' if chart else 'cartesian',
                                          optimizerInternalGtol=options['gtol'],activeChartBounds=active_bounds))
                if reason=='converged':
                    self.save_optimization(reason,message,status)
                    return dict(kind='completed',coordinates=self.coordinates(final_variable),step=step,stepKind='outer-optimizer-iteration',periodic=self.evidence(),energyHartree=energy,iterations=step,gradientMaxHartreePerBohr=gradient_max,nativeClosed=all(r['closed'] for r in self.history),evaluations=self.evaluations,optimization=self.optimization)
                if attempt==0 and reason in ('final-gradient','line-search') and step<self.request['maxSteps'] and self.evaluations<total_evaluations:
                    # One reset of the same optimizer/method from the last
                    # accepted iterate; no new budget, topology or Hamiltonian.
                    self.save_optimization('recovering',message,status)
                    continue
                code={'step-limit':'XTB_PERIODIC_STEP_LIMIT','line-search':'XTB_PERIODIC_LINE_SEARCH','evaluation-limit':'XTB_PERIODIC_EVALUATION_LIMIT','final-gradient':'XTB_PERIODIC_FINAL_GRADIENT','chart-boundary':'XTB_PERIODIC_FORCE_FIELD_IMAGE_CHANGED'}.get(reason,'XTB_PERIODIC_OPTIMIZER_FAILED')
                self.save_optimization(reason,message,status)
                raise PeriodicError(f'Periodic optimization stopped: {reason}; {message}; movable gradient {gradient_max:.9g} Eh/bohr exceeds 0.0001',code)
        except Exception as error:
            self.save_optimization(getattr(error,'code','XTB_PERIODIC_REJECTED'),str(error),self.attempts[-1]['status'] if self.attempts else None)
            raise

def main():
    output_lock=threading.Lock(); cancelled=threading.Event(); evaluator=None; payload={}
    def emit(packet):
        value=dict(packet,sessionId=payload['sessionId'],stamp=payload['request']['stamp'])
        with output_lock:
            sys.stdout.write(json.dumps(value,separators=(',',':'),allow_nan=False)+'\n'); sys.stdout.flush()
    try:
        phase('initial-read')
        descriptor=sys.stdin.fileno(); initial=b''
        while b'\n' not in initial:
            chunk=os.read(descriptor,65536); require(bool(chunk),'Periodic request was truncated')
            initial+=chunk
        line,pending_control=initial.split(b'\n',1)
        payload=json.loads(line.decode('utf-8')); require(isinstance(payload,dict) and isinstance(payload.get('sessionId'),str),'Invalid worker identity')
        phase('initial-decoded')
        def consume_control(pending):
            if len(pending)>65536: cancelled.set();return b''
            while b'\n' in pending:
                raw,pending=pending.split(b'\n',1)
                try:
                    if json.loads(raw).get('command')=='stop': cancelled.set()
                except (ValueError,AttributeError): cancelled.set()
            return pending
        # Coalesced Stop is already owned input: honor it before initialization
        # or any possible first point, without depending on thread scheduling.
        pending_control=consume_control(pending_control)
        if cancelled.is_set(): raise Cancelled('Periodic optimization cancelled')
        phase('construct-start')
        if payload['request'].get('calculation') == 'singlepoint':
            from xtb_periodic_bonds import PeriodicBondEvaluator
            evaluator=PeriodicBondEvaluator(payload['request'],payload['runtime'],payload['workspacePath'],cancelled)
        else:
            evaluator=PeriodicEvaluator(payload['request'],payload['runtime'],payload['workspacePath'],cancelled)
        evaluator.observer=emit
        def control():
            # A daemon must never hold Python's buffered stdin lock during
            # interpreter shutdown. Raw pipe reads also keep stop independent.
            pending=pending_control
            try:
                while True:
                    pending=consume_control(pending)
                    if cancelled.is_set(): return
                    phase('control-reading')
                    chunk=os.read(descriptor,65536)
                    if not chunk: cancelled.set();return
                    pending+=chunk
            except OSError: cancelled.set()
        phase('control-start')
        threading.Thread(target=control,daemon=True).start()
        evaluator.current_check()
        emit(evaluator.optimize(emit)); return 0
    except Exception as error:
        if payload:
            emit(dict(kind='stopped' if isinstance(error,Cancelled) else 'error',message=str(error),code=getattr(error,'code','XTB_PERIODIC_REJECTED'),optimization=getattr(evaluator,'optimization',None),nativeClosed=evaluator is None or evaluator.current is None and all(r['closed'] for r in evaluator.history)))
        else:
            sys.stderr.write(str(error)+'\n')
        return 0 if isinstance(error,Cancelled) else 1

if __name__=='__main__': raise SystemExit(main())
