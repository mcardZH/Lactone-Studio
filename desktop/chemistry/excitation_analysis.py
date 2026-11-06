"""Owned, explicit native NTO and hole/electron analysis.

The original wavefunction and output snapshots remain immutable. NTO eigenvalues
never enter the ordinary MO-energy model. Restore/export read completed artifacts.
"""
from __future__ import annotations
import base64
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import numpy as np
from orbitals import OrbitalError, MultiwfnSession, inspect_wavefunction, _windows_owned_job
from multiwfn_resources import resolve_resources
from multiwfn_progress import NativeProgressScanner
from orca_excitation import (parse_orca_output, excitation_mode, validate_orca_wavefunction,
    companion_snapshot, verify_companion, budget_companions, prepare_rpa, write_selected_adapter, rounding as rounding_orca)

NUMBER=r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][+-]?\d+)?'
CONTEXT_KEYS=('sourceId','sourceRevision','jobIndex','sourceFrameIndex','generation','documentId','documentRevision','activationEpoch')
GAUSSIAN_STATE=re.compile(r'Excited State\s+(\d+):\s+(.+?)\s+('+NUMBER+r')\s+eV',re.I)
ORCA_STATE=re.compile(r'^\s*STATE\s+(\d+):.*?('+NUMBER+r')\s+eV',re.I)
COEFF=re.compile(r'^\s*(\d+)([ABab]?)\s*(->|<-)\s*(\d+)([ABab]?)\s+('+NUMBER+r')\s*$')

def _sha(raw): return hashlib.sha256(raw).hexdigest()
def _num(token): return float(token.replace('D','E').replace('d','e'))
def _finite(token):
    try:
        value=_num(token)
        return value if math.isfinite(value) else None
    except (ValueError,AttributeError): return None
def _integer(value,label,minimum=0):
    if isinstance(value,bool) or not isinstance(value,int) or value<minimum: raise OrbitalError('excitation-identity',label+' must be an integer.')
    return value
def _rounding(token):
    token=token.lower().replace('d','e');parts=token.split('e');mant=parts[0]
    return .5*10**((int(parts[1]) if len(parts)>1 else 0)-(len(mant.split('.')[1]) if '.' in mant else 0))
def _snapshot(path,revision=None):
    source=Path(path).resolve()
    if not source.is_file(): raise OrbitalError('excitation-source','Excitation snapshot is absent.')
    raw=source.read_bytes();actual=_sha(raw)
    if revision is not None and revision!=actual: raise OrbitalError('source-changed','Excitation snapshot revision changed.')
    return source,raw,actual

def parse_excitation_source(text,engine,job_index=None):
    """Index raw printed blocks; never reconstruct from a UI transition table."""
    if engine=='orca':return parse_orca_output(text)
    lines=text.splitlines();blocks=[];batch=0;last_index=None;job=0;seen_gaussian=False;job_ends={}
    for i,line in enumerate(lines):
        if engine=='gaussian':
            if re.search(r'Link1:.*Proceeding to internal job step|^\s*--Link1--',line):job_ends[job]=i;job+=1
            if 'Entering Gaussian System' in line:
                if seen_gaussian:job_ends[job]=i;job+=1
                seen_gaussian=True
            m=GAUSSIAN_STATE.search(line)
        else: m=ORCA_STATE.search(line)
        if not m: continue
        index=int(m[1]);label=m[2].strip() if engine=='gaussian' else 'ORCA printed state';token=m[3] if engine=='gaussian' else m[2]
        if last_index is not None and index<=last_index: batch+=1
        last_index=index;rows=[];j=i+1
        if engine=='gaussian':
            while j<len(lines):
                c=COEFF.match(lines[j])
                if c:
                    a,sa,direction,b,sb,amplitude=c.groups();rows.append(dict(fromIndex=int(a),toIndex=int(b),spin=('alpha' if sa.upper()=='A' else 'beta' if sa.upper()=='B' else 'restricted'),direction=direction,amplitude=_num(amplitude),sourceLine=j+1));j+=1
                elif not rows and ('This state for optimization' in lines[j] or not lines[j].strip()): j+=1
                else: break
        else:
            while j<len(lines) and ('->' in lines[j] or not lines[j].strip()): j+=1
        raw='\n'.join(lines[i:j]);x=sum(r['amplitude']**2 for r in rows if r['direction']=='->');y=sum(r['amplitude']**2 for r in rows if r['direction']=='<-')
        state=dict(index=index,label=label,energyEv=_num(token),energyToken=token,sourceLine=i+1,jobIndex=job,batch=batch,coefficients=rows,coefficientCount=len(rows),blockRevision=_sha(raw.encode('utf-8')),excitationSquared=x,deexcitationSquared=y,netSquared=x-y,terminated=j<len(lines))
        explicit_spin=re.match(r'(Singlet|Doublet|Triplet|Quartet|Quintet|Sextet|Septet|Octet)\b',label,re.I)
        if explicit_spin:state['multiplicity']={'singlet':1,'doublet':2,'triplet':3,'quartet':4,'quintet':5,'sextet':6,'septet':7,'octet':8}[explicit_spin[1].lower()]
        blocks.append(state)
    if not blocks: raise OrbitalError('excitation-source','No complete printed excited-state header was found.')
    job_ends[job]=len(lines)
    for block in blocks:block['jobEndSourceLine']=job_ends[block['jobIndex']]
    selected_job=job if job_index is None else job_index
    candidates=[block for block in blocks if block['jobIndex']==selected_job]
    final_batch=candidates[-1]['batch'] if candidates else None
    # A later Gaussian Link1 job may have no TD data at all; the native final-stage
    # loader must not be allowed to attach the previous job's root to it.
    return blocks,[b for b in candidates if b['batch']==final_batch]

def gaussian_analysis_output(raw,final):
    """Exact original prefix ending at the selected job boundary. The native
    whole-file final-batch loader must see the same job selected by the UI.
    Source line numbers, state blocks and the original snapshot remain intact.
    """
    if not final:raise OrbitalError('excitation-stage','The current Gaussian job has no analyzable printed TD states.')
    ends={block.get('jobEndSourceLine') for block in final};lines=raw.splitlines(keepends=True)
    if len(ends)!=1 or any(type(end) is not int or not 1<=end<=len(lines) for end in ends):raise OrbitalError('excitation-stage','The selected Gaussian job has no reliable original source range.')
    end=next(iter(ends))
    return raw if end==len(lines) else b''.join(lines[:end])

def select_state(blocks,final,expected,context):
    for key in ('index','sourceLine'): _integer(expected.get(key),key,1)
    _integer(expected.get('frameIndex'),'frameIndex')
    if expected['frameIndex']!=context.get('sourceFrameIndex'): raise OrbitalError('excitation-frame','Selected excitation and paired wavefunction belong to different source frames.')
    candidates=[b for b in blocks if b['sourceLine']==expected['sourceLine'] and b['index']==expected['index']]
    if len(candidates)!=1: raise OrbitalError('excitation-state','Original state source line and index do not identify one printed block.')
    block=candidates[0]
    if expected.get('multiplicity') is not None and expected['multiplicity']!=block.get('multiplicity') or block.get('engine')=='orca' and expected.get('multiplicity')!=block.get('multiplicity'):raise OrbitalError('excitation-spin','Selected state multiplicity disagrees with its original printed source.')
    if block not in final: raise OrbitalError('excitation-final-stage','Native whole-output analysis is available only for the final printed TD batch; this earlier state was not run.')
    if context.get('jobIndex') is not None and block['jobIndex']!=context['jobIndex']: raise OrbitalError('excitation-job','Printed excitation belongs to a different output job.')
    energy=expected.get('energyEv')
    if isinstance(energy,bool) or not isinstance(energy,(int,float)) or not math.isfinite(energy) or abs(energy-block['energyEv'])>_rounding(block['energyToken'])+1e-10: raise OrbitalError('excitation-state','Selected excitation energy disagrees with its original printed state.')
    if expected.get('label') and expected['label'].strip()!=block['label'] and block['label']!='ORCA printed state': raise OrbitalError('excitation-state','Selected state label disagrees with its original printed state.')
    return block

def validate_gaussian_wavefunction(text,block,metadata,wavefunction_text):
    prefix='\n'.join(text.splitlines()[:block['sourceLine']])
    basis=re.findall(r'NBasis=\s*(\d+)',prefix)
    electrons=re.findall(r'(\d+) alpha electrons\s+(\d+) beta electrons',prefix)
    if not basis or int(basis[-1])!=metadata['basisCount']:raise OrbitalError('excitation-basis','Output and wavefunction basis dimensions disagree or are unavailable.')
    actual_alpha=sum(o['occupation'] for o in metadata['orbitals'] if o['spin']=='alpha');actual_beta=sum(o['occupation'] for o in metadata['orbitals'] if o['spin']=='beta')
    if all(o['spin']=='restricted' for o in metadata['orbitals']):
        actual_alpha=sum(min(1,o['occupation']) for o in metadata['orbitals']);actual_beta=sum(max(0,o['occupation']-1) for o in metadata['orbitals'])
    if not electrons or abs(int(electrons[-1][0])-actual_alpha)>1e-5 or abs(int(electrons[-1][1])-actual_beta)>1e-5:raise OrbitalError('excitation-electrons','Output and wavefunction alpha/beta electron populations disagree.')
    # FCHK SCF Energy is distinct from Total Energy (the latter can be E_TD).
    # Compare only these explicitly equivalent ground-reference quantities.
    saved_scf=re.search(r'^SCF Energy\s+R\s+('+NUMBER+r')',wavefunction_text,re.M)
    printed_scf=re.findall(r'SCF Done:.*?=\s*('+NUMBER+r')\s+A\.U\.',prefix,re.I)
    if saved_scf and printed_scf:
        a,b=saved_scf[1],printed_scf[-1]
        if abs(_num(a)-_num(b))>_rounding(a)+_rounding(b)+1e-11:raise OrbitalError('excitation-reference-energy','Explicit SCF reference energies disagree between the excitation output and wavefunction.')
    geometries=re.findall(r'(?:Standard|Input) orientation:\s*\n\s*-+\n[^\n]*\n[^\n]*\n\s*-+\n(.*?)\n\s*-+',prefix,re.S)
    if not geometries:raise OrbitalError('excitation-geometry','No complete source orientation precedes the selected excitation.')
    rows=[line.split() for line in geometries[-1].splitlines() if line.strip()]
    if len(rows)!=len(metadata['atoms']) or any(int(row[1])!=atom['atomicNumber'] for row,atom in zip(rows,metadata['atoms'])):raise OrbitalError('excitation-atoms','Output/wavefunction atom order or atomic numbers disagree.')
    target=np.array([[_num(t) for t in row[3:6]] for row in rows]);moving=np.array([a['positionBohr'] for a in metadata['atoms']])*.529177210903
    out_precision=max(_rounding(t) for row in rows for t in row[3:6]);wf_precision=0.
    match=re.search(r'Current cartesian coordinates\s+R\s+N=\s*(\d+)\s*\n(.*?)(?=\n[^ \d+\-.]|\Z)',wavefunction_text,re.S)
    if match:
        tokens=match[2].split()[:int(match[1])]
        wf_precision=max(_rounding(t) for t in tokens)*.529177210903
    else:wf_precision=1e-8
    a=moving-moving.mean(axis=0);b=target-target.mean(axis=0);u,_,vt=np.linalg.svd(a.T@b);rotation=u@np.diag([1.,1.,np.linalg.det(u@vt)])@vt
    residual=float(np.max(np.linalg.norm(a@rotation-b,axis=1)));tolerance=2*math.sqrt(3)*(out_precision+wf_precision)+1e-11
    if residual>tolerance:raise OrbitalError('excitation-geometry','The selected excitation geometry does not match the immutable wavefunction within printed coordinate precision.')
    return dict(maxResidualAngstrom=residual,coordinateToleranceAngstrom=tolerance)

def parse_native_evidence(output,block,expected_normalization,engine):
    loaded=re.findall(r'Loading configuration coefficients of excited state\s+(\d+)',output)
    if loaded and any(int(index)!=block['index'] for index in loaded):raise OrbitalError('excitation-native-state','Native selected another excitation state.')
    line=re.search(r'State:\s*'+str(block['index'])+r'\s+Exc\. Energy:\s*('+NUMBER+r')\s+eV\s+Multi\.:\s*(\d+)\s+MO pairs:\s*(\d+)',output)
    if line is None and block['index']==1 and 'The only excited state will be studied' in output:line=re.search(r'Excitation Energy:\s*('+NUMBER+r')\s+eV\s+Multiplicity:\s*(\d+)\s+MO pairs:\s*(\d+)',output)
    if not line or abs(_num(line[1])-block['energyEv'])>_rounding(line[1])+_rounding(block['energyToken'])+1e-9: raise OrbitalError('excitation-native-state','Native loaded state energy/identity does not match the requested raw coefficient block.')
    if block.get('multiplicity') is not None and int(line[2])!=block['multiplicity']:raise OrbitalError('excitation-native-state','Native loaded another spin multiplicity.')
    patterns={
      'nativeExcitationSquared':r'Sum of square of excitation coefficients:\s*('+NUMBER+r')',
      'nativeDeexcitationSquared':r'Negative of the sum of square of de-excitation coefficients:\s*('+NUMBER+r')',
      'nativeNetSquared':r'Sum of above two values:\s*('+NUMBER+r')',
      'nativeNormalizationDeviation':r'Deviation to expected normalization value\s*\(('+NUMBER+r')\)\s*is\s*('+NUMBER+r')'}
    evidence={k:block[k] for k in ('sourceLine','blockRevision','coefficientCount','excitationSquared','deexcitationSquared','netSquared')}
    evidence.update(expectedNormalization=expected_normalization,normalizationDeviation=abs(block['netSquared']-expected_normalization))
    for key,pattern in patterns.items():
        m=re.search(pattern,output)
        if key=='nativeNormalizationDeviation' and m and abs(_num(m[1])-expected_normalization)>1e-8:raise OrbitalError('excitation-native-reference','Native coefficient normalization disagrees with the source spin/reference convention.')
        if m: evidence[key]=abs(_num(m[2] if key=='nativeNormalizationDeviation' else m[1])) if key=='nativeDeexcitationSquared' else _num(m[2] if key=='nativeNormalizationDeviation' else m[1])
    if 'nativeExcitationSquared' not in evidence: raise OrbitalError('excitation-native-coefficients','Native did not report the loaded excitation coefficient norm.')
    if 'nativeNetSquared' not in evidence: evidence['nativeNetSquared']=evidence['nativeExcitationSquared']-evidence.get('nativeDeexcitationSquared',0)
    if engine=='gaussian':
        if int(line[3])!=block['coefficientCount']: raise OrbitalError('excitation-native-block','Native coefficient count does not match the selected original block.')
        for native,raw in [('nativeExcitationSquared','excitationSquared'),('nativeDeexcitationSquared','deexcitationSquared'),('nativeNetSquared','netSquared')]:
            if abs(evidence.get(native,0)-block[raw])>1.6e-6: raise OrbitalError('excitation-native-block','Native coefficient norm does not match the selected original block.')
    else:
        evidence.update(coefficientCount=int(line[3]),excitationSquared=evidence['nativeExcitationSquared'],deexcitationSquared=evidence.get('nativeDeexcitationSquared',0),netSquared=evidence['nativeNetSquared'])
        evidence['normalizationDeviation']=abs(evidence['netSquared']-expected_normalization)
    return evidence

def read_mwfn(path):
    text=Path(path).read_text(encoding='utf-8');parts=re.split(r'\nIndex=\s*',text)
    if len(parts)<2: raise OrbitalError('nto-file','Native MWFN has no orbital records.')
    header=parts[0];orbs=[]
    basis=re.search(r'^Nbasis=\s*(\d+)',header,re.M)
    if not basis: raise OrbitalError('nto-file','Native MWFN lacks its AO basis count.')
    for part in parts[1:]:
        try:
            meta,coeff=part.split('$Coeff',1)
            val=lambda k: _num(re.search(r'^'+k+r'=\s*(\S+)',meta,re.M)[1])
            values=np.array([_num(t) for t in coeff.split()],dtype=np.float64)
            orb=dict(index=int(meta.splitlines()[0]),type=int(val('Type')),eigenvalue=val('Energy'),occupation=val('Occ'),coefficients=values)
        except (ValueError,TypeError,AttributeError): raise OrbitalError('nto-file','Native MWFN contains a malformed orbital.')
        if len(values)!=int(basis[1]) or not np.isfinite(values).all() or not all(math.isfinite(orb[k]) for k in ('eigenvalue','occupation')): raise OrbitalError('nto-file','Native MWFN orbital arrays are incomplete/non-finite.')
        orbs.append(orb)
    if [o['index'] for o in orbs]!=list(range(1,len(orbs)+1)): raise OrbitalError('nto-file','Native orbital indices are not complete and ordered.')
    return header,orbs

def build_nto_pairs(original_path,nto_path):
    header,mo=read_mwfn(original_path);nto_header,nto=read_mwfn(nto_path)
    # E_tot and all basis metadata are unchanged by the NTO transformation.
    if header!=nto_header or len(mo)!=len(nto): raise OrbitalError('nto-basis','NTO and original native AO definitions disagree.')
    expansion=dict(available=True,relativeResidual=0.,unitarityMaxError=0.,rank=0);transforms={};pairs=[]
    for kind,spin in [(0,'restricted'),(1,'alpha'),(2,'beta')]:
        indices=[i for i,o in enumerate(mo) if o['type']==kind]
        if not indices: continue
        a=np.array([mo[i]['coefficients'] for i in indices]).T;b=np.array([nto[i]['coefficients'] for i in indices]).T
        try:
            u,_,rank,_=np.linalg.lstsq(a,b,rcond=None);res=float(np.linalg.norm(a@u-b)/max(np.linalg.norm(b),1e-300));orth=float(np.max(np.abs(u.T@u-np.eye(len(indices)))))
            expansion['relativeResidual']=max(expansion['relativeResidual'],res);expansion['unitarityMaxError']=max(expansion['unitarityMaxError'],orth);expansion['rank']+=int(rank)
            if rank!=len(indices) or res>1e-6 or orth>1e-5: raise ValueError('rank, reconstruction or unitarity check failed')
            transforms[kind]=(indices,u)
        except (ValueError,np.linalg.LinAlgError) as exc: expansion.update(available=False,reason=str(exc))
        occupied=[i for i in indices if nto[i]['occupation']>.5];virtual=[i for i in indices if nto[i]['occupation']<=.5]
        occupied.sort(key=lambda i:nto[i]['eigenvalue'],reverse=True);virtual.sort(key=lambda i:nto[i]['eigenvalue'],reverse=True)
        for ordinal,(h,e) in enumerate(zip(occupied,virtual),1):
            value=nto[h]['eigenvalue']
            if value< -1e-10 or abs(value-nto[e]['eigenvalue'])>max(1e-8,abs(value)*1e-6): raise OrbitalError('nto-pair','Native occupied and virtual NTO eigenvalues cannot be paired.')
            def orbital(i,side):
                contributions=[]
                if kind in transforms:
                    source_indices,rotation=transforms[kind];column=rotation[:,source_indices.index(i)]
                    contributions=[dict(sourceIndex=k+1,spin=spin,amplitude=float(column[k]),percent=float(100*column[k]**2)) for k in range(len(source_indices))]
                return dict(key=f'{spin}:{ordinal}:{side}',side=side,nativeIndex=nto[i]['index'],sourceIndex=indices.index(i)+1,moContributions=contributions)
            pairs.append(dict(index=ordinal,spin=spin,eigenvalue=value,weightPercent=100*value,hole=orbital(h,'hole'),electron=orbital(e,'electron')))
    if not expansion['available']:
        for pair in pairs:
            for side in ('hole','electron'): pair[side]['moContributions']=[]
    if not pairs: raise OrbitalError('nto-pair','Native result has no occupied/virtual NTO pair.')
    return pairs,expansion

def parse_metrics(output):
    metrics=[]
    def add(key,label,token,unit,line):
        value=_finite(token);row=dict(key=key,label=label,value=value,unit=unit,sourceLine=line,rawValue=token)
        if value is None: row['reason']='Native metric is non-finite or undefined for this state.'
        metrics.append(row)
    token=r'([^\s]+)'
    singles=[('hole-integral','Integral of hole',None),('electron-integral','Integral of electron',None),('transition-integral','Integral of transition density',None),('sm','Sm index (integral of Sm function)','a.u.'),('sr','Sr index (integral of Sr function)','a.u.'),('t','t index','angstrom'),('hdi','Hole delocalization index (HDI)',None),('edi','Electron delocalization index (EDI)',None),('excitation-energy','Excitation energy of this state','eV')]
    vectors=[('hole-centroid','Centroid of hole in X/Y/Z','angstrom'),('electron-centroid','Centroid of electron in X/Y/Z','angstrom'),('transition-dipole','Transition dipole moment in X/Y/Z','a.u.'),('hole-rmsd','RMSD of hole in X/Y/Z','angstrom'),('electron-rmsd','RMSD of electron in X/Y/Z','angstrom')]
    lines=output.splitlines()
    for n,line in enumerate(lines,1):
        for key,label,unit in singles:
            m=re.search(re.escape(label)+r':\s*'+token,line)
            if m: add(key,label,m[1],unit,n)
        for key,label,unit in vectors:
            m=re.search(re.escape(label)+r':\s*'+token+r'\s+'+token+r'\s+'+token,line)
            if m:
                for axis,t in zip('xyz',m.groups()): add(key+'-'+axis,label+' '+axis,t,unit,n)
                norm=re.search(r'Norm:\s*'+token,line)
                if norm: add(key+'-norm',label+' norm',norm[1],unit,n)
        if re.search(r'D_x:',line):
            for key,label in [('d-x','D_x'),('d-y','D_y'),('d-z','D_z'),('d','D index')]:
                m=re.search(re.escape(label)+r':\s*'+token,line)
                if m: add(key,label,m[1],'angstrom',n)
        if re.search(r'H_x:',line):
            for key,label in [('h-x','H_x'),('h-y','H_y'),('h-z','H_z'),('h-ct','H_CT'),('h','H index')]:
                m=re.search(re.escape(label)+r':\s*'+token,line)
                if m:add(key,label,m[1],'angstrom',n)
        if 'Variation of dipole moment with respect to ground state:' in line or 'Difference between RMSD of hole and electron (delta sigma):' in line:
            following=lines[n] if n<len(lines) else '';prefix='delta-dipole' if 'Variation' in line else 'delta-sigma';unit='a.u.' if prefix=='delta-dipole' else 'angstrom'
            for axis in ['X','Y','Z','Norm','Overall']:
                m=re.search(axis+r':\s*'+token,following)
                if m:add(prefix+'-'+axis.lower(),prefix+' '+axis,m[1],unit,n+1)
        if re.match(r'\s*Ghost-hunter index:',line):
            for key,label in [('ghost-hunter','Ghost-hunter index'),('ghost-hunter-first','1st term'),('ghost-hunter-second','2nd term')]:
                m=re.search(re.escape(label)+r':\s*'+token,line)
                if m:add(key,label,m[1],'eV',n)
    if not any(m['key']=='hole-integral' for m in metrics) or not any(m['key']=='electron-integral' for m in metrics): raise OrbitalError('excitation-metrics','Native did not report both hole/electron integrals.')
    return metrics

def read_density_cube(path):
    lines=Path(path).read_text(encoding='ascii').splitlines()
    if len(lines)<6: raise OrbitalError('excitation-cube','Native Cube header is incomplete.')
    first=lines[2].split();n=int(first[0]);origin=[_num(t) for t in first[1:4]];dims=[];axes=[];axisprecision=[]
    if n<=0 or len(first)!=4: raise OrbitalError('excitation-cube','Expected a scalar, atomic-unit native Cube.')
    for line in lines[3:6]:
        parts=line.split();dims.append(int(parts[0]));axes.append([_num(t) for t in parts[1:4]]);axisprecision.append([_rounding(t) for t in parts[1:4]])
    if any(d<2 for d in dims): raise OrbitalError('excitation-cube','Native Cube dimensions are unsupported.')
    atoms=[];precision=[];charges=[]
    for ordinal,line in enumerate(lines[6:6+n],1):
        row=line.split();atoms.append(dict(sourceIndex=ordinal,atomicNumber=int(row[0]),nuclearCharge=_num(row[1]),position=[_num(t) for t in row[2:5]]));precision.append([_rounding(t) for t in row[2:5]]);charges.append(_rounding(row[1]))
    values=np.fromstring(' '.join(lines[6+n:]).replace('D','E').replace('d','e'),sep=' ',dtype=np.float64)
    if len(values)!=math.prod(dims) or not np.isfinite(values).all() or not np.isfinite(np.array(origin+sum(axes,[]))).all(): raise OrbitalError('excitation-cube','Native Cube values/grid are incomplete or non-finite.')
    return dict(grid=dict(coordinateUnit='bohr',origin=origin,axes=axes,dimensions=dims,ordering='z-fastest'),atoms=atoms,precision=dict(origin=[_rounding(t) for t in first[1:4]],axes=axisprecision,atomCoordinates=precision,nuclearCharges=charges)),values

def _terminate_confirmed(process,job):
    """Release ownership only after wait AND poll confirm the real process exit."""
    if process is not None:
        try:
            if process.poll() is None:process.kill()
            process.wait(timeout=5)
            if process.poll() is None:raise OrbitalError('native-unsettled','Native process remains alive after termination/wait; ownership is retained.')
        except OrbitalError:raise
        except Exception as exc:
            raise OrbitalError('native-unsettled','Native termination could not confirm process exit; process/job ownership is retained.') from exc
    if job:
        kernel,handle=job
        if not kernel.CloseHandle(handle):raise OrbitalError('native-unsettled','Native process exited but its owned job handle could not be released.')

class _ExcitationNtoSession(MultiwfnSession):
    """Reuse scientific grid generation with this service's stricter lifetime gate."""
    def __init__(self,owner,*args,**kwargs):
        self.owner=owner;self._provisional_process=None
        self._start_observer=kwargs.get('native_start_callback')
        kwargs['native_start_callback']=self._record_start
        super().__init__(*args,**kwargs)
    def _record_start(self,process):
        # This is invoked immediately after Popen, before job binding and before
        # the base class publishes its own process attribute.
        self._provisional_process=process
        if self._start_observer is not None:self._start_observer(process)
    def _terminate(self,process,job):
        self.owner._settle_process(process,job)
        if getattr(self,'_provisional_process',None) is process:self._provisional_process=None
    def stop(self):
        # Unlike the legacy helper, do not clear the only process/job references
        # before a bounded wait has actually confirmed termination.
        with self._lifecycle:
            self.stopped.set();process=self.process or getattr(self,'_provisional_process',None);job=self._job
            self._terminate(process,job)
            if self.process is process:self.process=None;self._job=None

class ExcitationAnalysisService:
    def __init__(self,work_dir,progress_callback=None,cancel_callback=None):
        self.root=Path(work_dir).resolve();self.root.mkdir(parents=True,exist_ok=True)
        self.progress_callback=progress_callback;self.cancel_callback=cancel_callback
        self.closed=False;self.cancelled=threading.Event();self.epoch=0;self.process=None;self.native_session=None;self._job=None;self.opened=False;self.native_start_count=0
        self.results={};self.fields={};self.field_owners={};self.ntos={};self._lock=threading.RLock()

    def _progress(self,phase,**extra):
        if self.progress_callback:
            try:self.progress_callback(dict(phase=phase,**extra))
            except Exception:pass
    def _check_cancel(self):
        if self.closed or self.cancelled.is_set() or self.cancel_callback and self.cancel_callback(): self.cancel();raise OrbitalError('aborted','Excitation analysis stopped; completed results are retained.')
    def retained_memory_bytes(self):
        results=sum(len(json.dumps(r,separators=(',',':'))) for r in self.results.values())
        # Companions stay path-only; the parsed JSON and amplitude scratch are
        # transient run-local values and never retained across context switches.
        source_bytes=len(getattr(self,'wavefunction_raw',b''))+len(getattr(self,'output_raw',b''))
        analysis=getattr(self,'analysis_output_raw',None)
        if analysis is not None and analysis is not self.output_raw:source_bytes+=len(analysis)
        return results+source_bytes
    def _native_started(self,process=None):
        with self._lock:
            if process is not None:self.process=process;self._job=None
            self.native_start_count+=1
    def _settle_process(self,process,job):
        with self._lock:
            if process is not None:
                if self.process is not None and self.process is not process:raise OrbitalError('native-unsettled','Another native process still owns this excitation service.')
                self.process=process;self._job=job
            _terminate_confirmed(process,job)
            if self.process is process:self.process=None;self._job=None
    def stop_native(self):
        session=self.native_session
        if session:
            session.stop()
        with self._lock:process=self.process;job=self._job
        if process is not None or job:self._settle_process(process,job)
    def cancel(self): self.cancelled.set();self.stop_native()
    def close(self):
        self.closed=True;self.cancel();self.results.clear();self.fields.clear();self.field_owners.clear();self.ntos.clear()
        self.analysis_output_raw=b'';self.output_raw=b'';self.wavefunction_raw=b'';self.output_text='';self.blocks=[];self.final=[]
    def apply_resources(self,resources):
        if self.process is not None or self.native_session is not None: raise OrbitalError('excitation-busy','Cannot change resources during an active native calculation.')
        resources=resources or {}
        self.resources,self.settings=resolve_resources(self.executable,resources.get('threads'),resources.get('memoryBudgetBytes'))
        if resources.get('settingsRevision') is not None and resources['settingsRevision']!=self.resources['settingsRevision']:raise OrbitalError('resource-changed','Multiwfn settings revision changed.')
        return self.resources

    def _open(self,request):
        if self.opened: raise OrbitalError('excitation-open','Excitation source is already open; open a new owned service for a different source.')
        source=request['source'];output=request['output'];self.context=copy.deepcopy(source['context']);self.session_id=request['sessionId']
        if not self.context.get('sourceId') or not self.context.get('sourceRevision'):raise OrbitalError('excitation-context','An immutable scientific source context is required.')
        _integer(self.context.get('generation'),'generation')
        if self.context.get('jobIndex') is not None:_integer(self.context['jobIndex'],'jobIndex')
        _integer(self.context.get('sourceFrameIndex'),'sourceFrameIndex')
        self.source,self.wavefunction_raw,self.source_revision=_snapshot(source.get('sourcePath') or request.get('ownedSourcePath'),source.get('sourceRevision'))
        self.output,self.output_raw,self.output_revision=_snapshot(output.get('path') or request.get('outputPath'),output.get('revision'))
        self.metadata=inspect_wavefunction(self.source);self.executable=Path(request['executable']).resolve()
        if not self.executable.is_file(): raise OrbitalError('backend-missing','Select an existing Multiwfn executable.')
        self.output_text=self.output_raw.decode('utf-8',errors='replace');self.engine='gaussian' if 'Gaussian' in self.output_text and GAUSSIAN_STATE.search(self.output_text) else 'orca' if 'O   R   C   A' in self.output_text or 'ORCA' in self.output_text else 'unknown'
        if self.engine=='unknown': raise OrbitalError('excitation-engine','Excitation source must identify Gaussian or ORCA by contents.')
        self.blocks,self.final=parse_excitation_source(self.output_text,self.engine,self.context.get('jobIndex'))
        self.json_path=None;self.json_revision=None;self.json_source=None;self.cis_source=None;self.notices=[];self.reasons=[]
        self.apply_resources(request.get('resources') or {})
        self.json_source=companion_snapshot(request.get('orcaJson'),request.get('jsonPath'))
        self.cis_source=companion_snapshot(request.get('orcaCis'),request.get('cisPath'))
        if self.json_source:self.json_path=self.json_source['path'];self.json_revision=self.json_source['revision']
        if self.engine=='orca':
            self.orca_mode=excitation_mode(self.output_text)
            if self.orca_mode=='rpa' and not self.json_source and not self.cis_source:self.reasons.append('Full ORCA TDDFT requires same-job X/Y amplitudes from JSON or original CIS; combined printed weights are insufficient.')
            if self.orca_mode in ('unsupported-simplified','unknown'):self.reasons.append('ORCA TDA/full-RPA identity or this approximation is not supported by a verified amplitude route.')
            if self.orca_mode=='tda' and not any(b['weights'] and len(b['weights'])==len(b['coefficients']) for b in self.final):self.reasons.append('ORCA TDA output lacks signed c= configuration amplitudes; printed weights alone do not establish their phases.')
            if not self.final or any(b.get('multiplicity') not in (1,3) for b in self.final):self.reasons.append('ORCA source lacks explicit supported singlet/triplet identity.')
            if self.metadata['format']!='molden' or any(o['spin']!='restricted' or o['occupation'] not in (0,2) for o in self.metadata['orbitals']):self.reasons.append('ORCA derivation requires a corresponding restricted closed-shell Molden orbital source.')
        else:
            if not self.final:self.reasons.append('The current Gaussian stage has no analyzable printed TD states; no state was borrowed from another job.')
            elif not any(block['coefficients'] for block in self.final):self.reasons.append('The current Gaussian TD batch contains no printed configuration amplitudes.')
            if not re.search(r'IOp\s*\(\s*9\s*/\s*40\s*=\s*[3456789]',self.output_text,re.I):self.notices.append('Gaussian output may use the default coefficient print threshold; actual normalization is retained without automatic correction.')
            if self.final and not any(row['direction']=='<-' for block in self.final for row in block['coefficients']):self.notices.append('The selected Gaussian batch prints no de-excitation coefficients; a zero printed sum does not prove the physical Y amplitudes are zero.')
        self.analysis_output_raw=gaussian_analysis_output(self.output_raw,self.final) if self.engine=='gaussian' and self.final else self.output_raw
        spins={o['spin'] for o in self.metadata['orbitals']};self.expected=.5 if spins=={'restricted'} and all(o['occupation'] in (0,2) for o in self.metadata['orbitals']) else 1.
        self.opened=True
        states=[dict(index=b['index'],sourceLine=b['sourceLine'],frameIndex=self.context['sourceFrameIndex'],energyEv=b['energyEv'],label=b['label'],**(dict(multiplicity=b['multiplicity']) if 'multiplicity' in b else {})) for b in self.final if self.context.get('jobIndex') in (None,b['jobIndex'])]
        return dict(sessionId=self.session_id,context=self.context,states=states,capabilities=dict(nto=bool(states) and not self.reasons,holeElectron=bool(states) and not self.reasons,reasons=self.reasons),notices=self.notices,resources=self.resources)

    def _stamp(self,stamp):
        epoch=stamp.get('activationEpoch')
        if epoch is not None and (isinstance(epoch,bool) or not isinstance(epoch,int) or not 0<=epoch<=2**53-1):raise OrbitalError('excitation-context','Activation epoch must be a nonnegative safe integer when present.')
        if not stamp.get('requestId') or not stamp.get('analysisId') or any(stamp.get(k)!=self.context.get(k) for k in CONTEXT_KEYS if k!='activationEpoch'): raise OrbitalError('excitation-context','Excitation request belongs to a different immutable source/context.')
    def _work(self,prefix):
        self._check_cancel();work=Path(tempfile.mkdtemp(prefix=prefix,dir=self.root))
        _snapshot(self.source,self.source_revision)
        verify_companion(self.json_source);verify_companion(self.cis_source)
        suffix='.fchk' if self.metadata['format']=='fchk' else '.molden';shutil.copyfile(self.source,work/('source'+suffix));(work/'source.out').write_bytes(getattr(self,'analysis_output_raw',self.output_raw))
        (work/'settings.ini').write_bytes(self.settings)
        return work,'source'+suffix
    def _native(self,work,source,answers):
        self._check_cancel();log=work/'native-output.txt';threads=self.resources['threads'];env=dict(os.environ,Multiwfnpath=str(self.executable.parent),OMP_NUM_THREADS=str(threads),OPENBLAS_NUM_THREADS=str(threads),MKL_NUM_THREADS=str(threads),OMP_STACKSIZE='200M')
        scanner=NativeProgressScanner(self.progress_callback);offset=0
        self._progress('running',stageId='excitation-native')
        with log.open('wb') as output:
            process=subprocess.Popen([str(self.executable),source],cwd=work,env=env,stdin=subprocess.PIPE,stdout=output,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));self._native_started(process);job=None
            try:
                job=_windows_owned_job(process,self.resources['memoryBudgetBytes'])
                with self._lock:self._job=job
                process.stdin.write(('\n'.join(answers)+'\n').encode('ascii'));process.stdin.close()
                while process.poll() is None:
                    self._check_cancel()
                    with log.open('rb') as stream:stream.seek(offset);chunk=stream.read(65536)
                    offset+=len(chunk);scanner.feed(chunk.decode('utf-8',errors='replace'));time.sleep(.05)
                self._check_cancel();text=log.read_text(encoding='utf-8',errors='replace').replace('\r','')
                if process.returncode!=0:raise OrbitalError('excitation-native','Native excitation analysis failed: '+text[-1400:])
                if text.count('************ Main function menu')<2:raise OrbitalError('excitation-menu','Native excitation route did not settle back to the main menu.')
                version=re.search(r'Version\s+([^\n]+)',text);actual=re.search(r'Number of parallel threads:\s*(\d+)',text)
                if not version or not actual or int(actual[1])!=threads:raise OrbitalError('excitation-backend','Native version or actual thread count could not be verified.')
                self.backend=dict(name='Multiwfn',version=version[1].strip(),threads=threads)
                return text
            finally:
                with self._lock:
                    owned=self.process is process
                if owned:self._settle_process(process,job)
    def _provenance(self,work,output,parameters):
        if self.engine=='gaussian':parameters={**parameters,'analysisOutputJobIndex':self.context.get('jobIndex'),'analysisOutputEndSourceLine':self.final[0]['jobEndSourceLine'],'analysisOutputRevision':_sha(self.analysis_output_raw)}
        files=[]
        for path in sorted(work.iterdir()):
            if path.is_file() and path.name not in ('source.fchk','source.molden','source.out','source.json','settings.ini'):
                raw=path.read_bytes();role='native-excitation-adapter' if path.name=='excitation.txt' else 'full-orca-amplitudes' if path.name=='orca-full-amplitudes.npz' else 'native-output' if path.suffix=='.txt' else 'native-artifact';files.append(dict(role=role,name=path.name,revision=_sha(raw),bytes=len(raw)))
        cross=re.search(r'coefficient\s*<\s*('+NUMBER+r')',output)
        if cross:parameters['crossTermCoefficientThreshold']=_num(cross[1])
        notices=list(self.notices)
        deviation=re.search(r'Deviation to expected normalization value\s*\(('+NUMBER+r')\)\s*is\s*('+NUMBER+r')',output)
        if deviation:
            parameters.update(coefficientExpectedNormalization=_num(deviation[1]),coefficientNormalizationDeviation=_num(deviation[2]),coefficientNormalizationWarningTolerance=.001)
            if _num(deviation[2])>.001:notices.append('Loaded configuration coefficients deviate from their expected normalization; raw coefficients/weights/density integrals have not been renormalized.')
        integrals=re.findall(r'Integral of (?:hole|electron):\s*('+NUMBER+r')',output)
        if any(abs(_num(value)-1)>.01 for value in integrals):notices.append('Native hole/electron integrals depart from 1 by more than 0.01; coefficients, grid spacing and spatial extent limit quantitative interpretation.')
        return dict(backend=self.backend,wavefunctionRevision=self.source_revision,outputRevision=self.output_revision,**(dict(orcaJsonRevision=self.json_revision) if self.json_revision else {}),parameters=parameters,rawArtifacts=files,notices=notices)
    def _quality(self,quality):
        quality=quality or dict(mode='high');mode=quality.get('mode')
        if mode in ('low','medium','high'):return [str({'low':1,'medium':2,'high':3}[mode])]
        if mode=='spacing':
            spacing=quality.get('spacingBohr')
            if isinstance(spacing,(int,float)) and not isinstance(spacing,bool) and math.isfinite(spacing) and spacing>0:return ['4',','.join([str(spacing)]*3)]
        if mode=='dimensions':
            dims=quality.get('dimensions')
            if isinstance(dims,list) and len(dims)==3 and all(isinstance(n,int) and not isinstance(n,bool) and n>=2 for n in dims):return ['4',','.join(map(str,dims))]
        raise OrbitalError('excitation-grid','Select a valid low/medium/high grid or positive explicit spacing.')
    def _grid_budget(self,quality):
        quality=quality or dict(mode='high');self._quality(quality)
        positions=np.array([a['positionBohr'] for a in self.metadata['atoms']]);span=positions.max(axis=0)-positions.min(axis=0)+12
        mode=quality['mode']
        if mode=='dimensions':points=math.prod(quality['dimensions'])
        else:
            spacing=quality['spacingBohr'] if mode=='spacing' else (float(np.prod(span))/{'low':125000,'medium':512000,'high':1728000}[mode])**(1/3)
            if not np.isfinite(span/spacing).all():raise OrbitalError('excitation-grid','Requested spacing exceeds the supported grid size.')
            points=math.prod(int(math.ceil(n/spacing))+1 for n in span)
        estimate=points*256+self.metadata['sourceBytes']*5+self.metadata['basisCount']**2*96+self.retained_memory_bytes()+128*1024**2
        return points
    def _field(self,path,request,role,pair=None):
        metadata,values=read_density_cube(path)
        if role!='nto' and np.any(values<0):raise OrbitalError('excitation-density','Native total density contains negative nodes; the density field was not silently clipped.')
        key=request['stamp']['requestId']+':'+role+(':'+pair['spin']+':'+str(pair['index'])+':'+request['side'] if pair else '')
        field=dict(id=key,context={k:request['stamp'][k] for k in CONTEXT_KEYS if k in request['stamp']},state=copy.deepcopy(request['state']),**metadata,validDomain=dict(kind='full-grid',evidence='Native full-system grid, all Cube nodes calculated.'),valuesBase64=base64.b64encode(values.astype('<f8',copy=False).tobytes()).decode('ascii'),valueEncoding='float64-le')
        if role=='nto':field.update(pairIndex=pair['index'],spin=pair['spin'],side=request['side'],eigenvalue=pair['eigenvalue'],valueUnit='bohr^-3/2')
        else:field.update(excitationRole=role,function='electron-density',functionLabel='Total hole density' if role=='hole-density' else 'Total excited electron density',valueUnit='bohr^-3',definitionEvidence=dict(kind='native-output',description='Multiwfn total (local + cross term) excitation '+role),source=dict(id=key,name=path.name,revision=_sha(path.read_bytes()),kind='generated-cube',producer='multiwfn'))
        return field
    def _run(self,request):
        self._stamp(request['stamp']);self._check_cancel()
        if self.reasons:raise OrbitalError('excitation-prerequisite',' '.join(self.reasons))
        block=select_state(self.blocks,self.final,request['state'],self.context)
        if self.engine=='orca' and self.json_source:
            budget_companions(self.json_source,self.cis_source,self.metadata,self.resources['memoryBudgetBytes'],self.retained_memory_bytes())
        geometry=validate_gaussian_wavefunction(self.output_text,block,self.metadata,self.wavefunction_raw.decode('utf-8',errors='replace')) if self.engine=='gaussian' else validate_orca_wavefunction(self.output_text,block,self.metadata,self.wavefunction_raw.decode('utf-8',errors='replace'),self.json_source,self.final)
        if self.engine=='gaussian' and not block['coefficients']:raise OrbitalError('excitation-coefficients','Selected printed state contains no usable raw configuration coefficients.')
        if self.engine=='gaussian' and not block['terminated']:raise OrbitalError('excitation-truncated-block','The selected coefficient block reaches end-of-file without a complete boundary; no derived result was fabricated.')
        operation=request['operation']
        if operation=='nto-field':return self._nto_field(request)
        if operation not in ('nto','hole-electron'):raise OrbitalError('excitation-operation','Unsupported excitation operation.')
        work,source=self._work(operation+'-')
        native_block=block;native_engine='gaussian';selection=['source.out',str(block['index'])];orca_proof=None
        if self.engine=='orca':
            if self.orca_mode=='rpa':
                budget_companions(self.json_source,self.cis_source,self.metadata,self.resources['memoryBudgetBytes'],self.retained_memory_bytes())
                x,y,orca_proof=prepare_rpa(self.json_source,self.cis_source,self.final,block,self.metadata,geometry['coordinateToleranceAngstrom'])
                options=re.findall(rb'(?mi)^\s*ORCAloadcoeff\s*=\s*([^/\r\n]+)',self.settings)
                if len(options)!=1:raise OrbitalError('orca-threshold','The actual job settings do not uniquely specify ORCAloadcoeff.')
                try:threshold=_num(options[0].decode('ascii').strip())
                except ValueError:raise OrbitalError('orca-threshold','The actual ORCAloadcoeff setting is not numeric.')
                adapter,native_block=write_selected_adapter(work,block,x,y,orca_proof,threshold);selection=[adapter.name]
            else:
                if not block['weights'] or len(block['coefficients'])!=len(block['weights']):raise OrbitalError('orca-tda-coefficients','ORCA TDA output lacks signed c= amplitudes; combined printed weights were not converted into guessed phases.')
                if not block['terminated']:raise OrbitalError('excitation-truncated-block','Selected ORCA TDA coefficient block has no complete boundary.')
                for row in block['weights']:
                    if row['fromSpin']!='a' or row['toSpin']!='a' or not 0<=row['fromIndex']<len(self.metadata['orbitals']) or not 0<=row['toIndex']<len(self.metadata['orbitals']) or self.metadata['orbitals'][row['fromIndex']]['occupation']!=2 or self.metadata['orbitals'][row['toIndex']]['occupation']!=0:raise OrbitalError('orca-tda-coefficients','Printed TDA MO indices/spin do not correspond to the paired Molden occupied/virtual orbitals.')
                    c=row['amplitude'];tol=rounding_orca(row['weightToken'])+2*abs(c)*rounding_orca(row['amplitudeToken'])+rounding_orca(row['amplitudeToken'])**2+1e-11
                    if abs(c*c-row['weight'])>tol:raise OrbitalError('orca-tda-coefficients','Printed TDA signed amplitude and weight disagree.')
                has_triplet_prompt=bool(re.search(r'Generation of triplets\s*\.{2,}\s*on\b',self.output_text,re.I))
                if block['multiplicity']==3 and not has_triplet_prompt:raise OrbitalError('orca-native-menu','Triplet selection lacks the verified native ORCA multiplicity prompt.')
                selection=['source.out']+([str(block['multiplicity'])] if has_triplet_prompt else [])+([str(block['index'])] if sum(b.get('multiplicity')==block['multiplicity'] for b in self.final)>1 else [])
                orca_proof=dict(route='out-tda',sourceStateIndex=block['index'],multiplicity=block['multiplicity'],sourceLine=block['sourceLine'],rpaNorm=2*block['netSquared'],xSquared=2*block['excitationSquared'],ySquared=0.,convention='orca-norm-1; closed-shell-amplitudes/sqrt(2); source-MO+1',printedWeightsChecked=len(block['weights']),maximumPrintedWeightDifference=max(abs(w['amplitude']**2-w['weight']) for w in block['weights']))
        def evidence_for(output):
            evidence=parse_native_evidence(output,native_block,self.expected,native_engine)
            if orca_proof and self.orca_mode=='rpa':
                evidence.update(blockRevision=block['blockRevision'],coefficientCount=orca_proof['fullCoefficientCount'],nativeCoefficientCount=orca_proof['effectiveCoefficientCount'],excitationSquared=orca_proof['xSquared']/2,deexcitationSquared=orca_proof['ySquared']/2,netSquared=orca_proof['rpaNorm']/2,normalizationDeviation=abs(orca_proof['rpaNorm']/2-self.expected))
            return evidence
        if operation=='nto':
            answers=['18','6']+selection+['3','nto.mwfn','6']+selection+['2','nto.fchk','0','100','2','32','original.mwfn','0','0','q']
            # After NTO export Multiwfn returns to main18, not to its output-format menu.
            output=self._native(work,source,answers)
            evidence=evidence_for(output)
            pairs,expansion=build_nto_pairs(work/'original.mwfn',work/'nto.mwfn')
            result=dict(stamp=request['stamp'],operation=operation,state=request['state'],pairs=pairs,eigenvalueSum=sum(p['eigenvalue'] for p in pairs),coefficients=evidence,expansion=expansion,provenance=self._provenance(work,output,dict(nativeMenu='18/6; NTO MWFN+FCHK; original MWFN',weightConvention='100*raw eigenvalue; no normalization',moExpansion='C_MO U=C_NTO; 100*abs(U)^2')))
        else:
            self._grid_budget(request.get('quality'));quality=self._quality(request.get('quality'));include=request.get('includeCoulomb',False)
            if not isinstance(include,bool):raise OrbitalError('excitation-coulomb','includeCoulomb must be explicit boolean.')
            answers=['18','1']+selection+['1']+quality+['10','1','11','1']+(['18'] if include else [])+['0','0','0','q']
            output=self._native(work,source,answers);evidence=evidence_for(output);metrics=parse_metrics(output)
            hole=self._field(work/'hole.cub',request,'hole-density');electron=self._field(work/'electron.cub',request,'electron-density')
            if hole['grid']!=electron['grid'] or hole['atoms']!=electron['atoms']:raise OrbitalError('excitation-grid','Total hole/electron native Cubes do not share exactly the same grid/atoms.')
            coulomb=dict(requested=include,valueHartree=None,valueEV=None,definition='hole-electron-coulomb-model')
            if include:
                for n,line in enumerate(output.splitlines(),1):
                    m=re.search(r'Coulomb attractive energy:\s*('+NUMBER+r')\s+a.u.\s*\(\s*('+NUMBER+r')\s+eV',line)
                    if m:coulomb.update(valueHartree=_num(m[1]),valueEV=_num(m[2]),sourceLine=n)
                if coulomb['valueHartree'] is None:raise OrbitalError('excitation-coulomb','Requested Coulomb calculation produced no finite native value.')
            result=dict(stamp=request['stamp'],operation=operation,state=request['state'],coefficients=evidence,metrics=metrics,hole=hole,electron=electron,coulomb=coulomb,provenance=self._provenance(work,output,dict(nativeMenu='18/1; total hole/electron Cube',qualityMode=(request.get('quality') or dict(mode='high'))['mode'],gridDimensions=hole['grid']['dimensions'],gridOriginBohr=hole['grid']['origin'],gridAxesBohr=sum(hole['grid']['axes'],[]),includeCoulomb=include)))
        if orca_proof:
            result['provenance']['orcaAmplitudes']=orca_proof
            if self.orca_mode=='rpa':result['provenance']['parameters'].update(nativeAdapterStateIndex=1,ORCAloadcoeff=orca_proof['nativeCoefficientThreshold'],fullCoefficientCount=orca_proof['fullCoefficientCount'],nativeCoefficientCount=orca_proof['effectiveCoefficientCount'],fullRPANorm=orca_proof['rpaNorm'],effectiveRPANorm=orca_proof['effectiveXSquared']-orca_proof['effectiveYSquared'])
            if orca_proof['route']=='cis-verified-json-recovery':result['provenance']['notices'].append('Known exact ORCA JSON export inconsistency was verified against the original same-job CIS; an owned amplitude adapter was restored without modifying or normalizing the original sources.')
        if self.engine=='orca':
            reference=geometry['electronCountEvidence']
            result['provenance']['parameters'].update(electronCountSource=reference['source'],referenceElectronCount=reference['electronCount'])
            if 'jsonRevision' in reference:result['provenance']['parameters']['referenceJsonRevision']=reference['jsonRevision']
        self._check_cancel()
        if operation=='nto':self.ntos[request['stamp']['requestId']]=(work,result)
        else:
            for role,name in [('hole','hole.cub'),('electron','electron.cub')]:
                field=result[role];self.fields[field['id']]=(work/name,field);self.field_owners[field['id']]=request['stamp']['analysisId']
        self.results[request['stamp']['requestId']]=copy.deepcopy(result);return result

    def _nto_field(self,request):
        generation=request.get('generationId');saved=self.ntos.get(generation)
        if not saved:raise OrbitalError('nto-pending','Generate this state NTO explicitly before requesting an NTO field.')
        work,result=saved
        if result['state']!=request['state'] or result['stamp']['analysisId']!=request['stamp']['analysisId']:raise OrbitalError('nto-context','NTO field request does not belong to its original analysis/state.')
        pair=next((p for p in result['pairs'] if p['index']==request.get('pairIndex') and p['spin']==request.get('spin','restricted')),None)
        side=request.get('side')
        if not pair or side not in ('hole','electron'):raise OrbitalError('nto-pair','Select a completed NTO pair/spin/side.')
        self._grid_budget(request.get('quality'));metadata=inspect_wavefunction(work/'nto.fchk');quality=request.get('quality') or dict(mode='high');mode=quality['mode'];positions=np.array([a['positionBohr'] for a in metadata['atoms']]);lower=positions.min(axis=0)-6;upper=positions.max(axis=0)+6;volume=float(np.prod(upper-lower))
        if mode in ('low','medium','high'):spacing=(volume/{'low':125000,'medium':512000,'high':1728000}[mode])**(1/3);dims=np.ceil((upper-lower)/spacing).astype(int)+1
        elif mode=='spacing':self._quality(quality);spacing=quality['spacingBohr'];dims=np.ceil((upper-lower)/spacing).astype(int)+1
        elif mode=='dimensions':self._quality(quality);dims=np.array(quality['dimensions']);spacing=None
        else:raise OrbitalError('nto-grid','Unsupported NTO field quality.')
        steps=np.full(3,spacing) if spacing else (upper-lower)/(dims-1);grid=dict(originBohr=lower.tolist(),axesBohr=np.diag(steps).tolist(),dimensions=dims.tolist())
        self._check_cancel();session=_ExcitationNtoSession(self,self.executable,work/'nto.fchk',grid,self.resources['threads'],self.resources['memoryBudgetBytes'],self.root,mode='selected',expected_settings_revision=self.resources['settingsRevision'],progress_callback=self.progress_callback,native_start_callback=self._native_started);self.native_session=session
        try:
            target=next(o for o in session.metadata['orbitals'] if o['multiwfnIndex']==pair[side]['nativeIndex'])
            generated=list(session.generate([target['id']],selected_only=True));self._check_cancel()
            if len(generated)!=1:raise OrbitalError('nto-field','NTO field did not complete.')
            destination=work/('field-'+request['stamp']['requestId'].encode('utf-8').hex()+'.cub');cube=session.export_cube(target['id']).splitlines();cube[0]=f"Ester Studio NTO pair {pair['index']} {side}; eigenvalue={pair['eigenvalue']:.12g}; psi [bohr^-3/2]";destination.write_text('\n'.join(cube)+'\n',encoding='ascii')
            field=self._field(destination,request,'nto',pair);provenance=copy.deepcopy(result['provenance']);provenance['parameters'].update(fieldKind='signed-nto-wavefunction',gridDimensions=grid['dimensions'],gridOriginBohr=grid['originBohr'],gridAxesBohr=sum(grid['axesBohr'],[]))
            provenance['parameters'].update(ntoTransformationBackendVersion=provenance['backend']['version'],ntoTransformationThreads=provenance['backend']['threads'],fieldNativeMenu='5/4 signed NTO amplitude')
            provenance['backend']=dict(name='Multiwfn',version=session.backend['version'],threads=session.backend['threads'])
            artifact=destination.read_bytes();provenance['rawArtifacts'].append(dict(role='nto-signed-cube',name=destination.name,revision=_sha(artifact),bytes=len(artifact)))
            self._check_cancel();response=dict(stamp=request['stamp'],operation='nto-field',state=request['state'],field=field,provenance=provenance)
        finally:session.close();self.native_session=None
        self._check_cancel()
        self.fields[field['id']]=(destination,field);self.field_owners[field['id']]=request['stamp']['analysisId'];self.results[request['stamp']['requestId']]=copy.deepcopy(response);return response

    def handle(self,payload):
        command=payload.get('command');request=payload.get('request',payload)
        if command=='open':return self._open(request)
        if command=='close':self.close();return dict(closed=True)
        if command in ('cancel','stop'):self.cancel();return dict(cancelled=True)
        if self.closed or not self.opened:raise OrbitalError('excitation-session','Excitation service is not open.')
        if command=='resources':return self.apply_resources(request.get('resources',request))
        if command=='run':
            if self.process is not None or self.native_session is not None:raise OrbitalError('native-unsettled','The previous native process/session has not been confirmed settled; no new process was started.')
            self.cancelled.clear();return self._run(request)
        if command in ('restore','restore-fields'):
            self._stamp(request['stamp']);result=self.results.get(request.get('generationId'))
            if result is None:raise OrbitalError('excitation-pending','No completed result exists for this generation; restore never recalculates.')
            if result['stamp']['analysisId']!=request['stamp']['analysisId']:raise OrbitalError('excitation-context','Cached result belongs to a different analysis.')
            response=copy.deepcopy(result);response['stamp']=request['stamp']
            for key in ('field','hole','electron'):
                if key in response:response[key]['context']={k:request['stamp'][k] for k in CONTEXT_KEYS if k in request['stamp']}
            return response
        if command in ('export','export-cube'):
            self._stamp(request['stamp']);saved=self.fields.get(request.get('fieldId'))
            if saved is None:raise OrbitalError('excitation-pending','Requested field has not completed; export never recalculates.')
            if self.field_owners.get(request['fieldId'])!=request['stamp']['analysisId']:raise OrbitalError('excitation-context','Field export belongs to a different analysis instance.')
            path,field=saved;return dict(stamp=request['stamp'],fieldId=field['id'],name=path.name,text=path.read_text(encoding='ascii'))
        raise OrbitalError('excitation-command','Unsupported excitation service command.')
