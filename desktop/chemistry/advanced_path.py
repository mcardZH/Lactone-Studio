"""Bounded isolated SCAN/dimer/CI-NEB-TS worker; source structures are immutable.

Physical calculator calls only occur inside an explicit run. IDPP preview uses
its geometric objective, never a physical calculator or a physical energy.
"""
from __future__ import annotations
import copy
import itertools
import json
import math
import os
import re
import sys
import threading
import time

import numpy as np
from ase import Atoms, __version__ as ase_version
from ase.calculators.calculator import Calculator, all_changes
from ase.constraints import FixAtoms, FixInternals
from ase.data import atomic_numbers
from ase.mep import NEB, DimerControl, MinModeAtoms, MinModeTranslate, idpp_interpolate
from ase.mep.neb import IDPP
from ase.optimize import FIRE
from scipy.optimize import minimize
from native_stdin import control_blocks

MAX_LINE = 16 * 1024 * 1024
DEFAULTS = dict(threads=2, maxSteps=200, maxEvaluations=5000,
                forceToleranceEVPerAngstrom=.05)
# Algorithmic feasibility tolerances; not a claim of scientific acceptance.
CONSTRAINT_TOLERANCES = dict(B=1e-6, A=1e-4, D=1e-4)


class PathError(ValueError):
    def __init__(self, code, message, diagnostic=None):
        super().__init__(message)
        self.code = code
        self.diagnostic = diagnostic


class Cancelled(PathError):
    pass


def require(condition, message, code='PATH_INVALID'):
    if not condition:
        raise PathError(code, message)


def finite(value, lower=-1e12, upper=1e12):
    return type(value) in (int, float) and math.isfinite(value) and lower <= value <= upper


def integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def identity(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value) is not None


def coordinate_value(positions, kind, indices):
    """Same signed convention as src/core/tasks.ts; public angles are degrees."""
    p = np.asarray(positions, dtype=float)[list(indices)]
    if kind == 'B':
        distance = np.linalg.norm(p[1] - p[0])
        require(distance > 1e-10, 'Coincident distance endpoints')
        return float(distance)
    if kind == 'A':
        a, b = p[0]-p[1], p[2]-p[1]
        denominator = np.linalg.norm(a)*np.linalg.norm(b)
        require(denominator > 1e-12, 'Coincident angle endpoints')
        cosine = float(np.clip(np.dot(a, b)/denominator, -1, 1))
        require(abs(cosine) < 1-1e-12, 'Linear angle has singular derivatives')
        return math.degrees(math.acos(cosine))
    a, axis, c = p[0]-p[1], p[2]-p[1], p[3]-p[2]
    norm=np.linalg.norm(axis); require(norm>1e-10,'Coincident or linear dihedral plane')
    axis=axis/norm; v=a-np.dot(a,axis)*axis; w=c-np.dot(c,axis)*axis
    require(np.linalg.norm(v)*np.linalg.norm(w)>1e-12,'Coincident or linear dihedral plane')
    # Exact ordered projection convention used by core/tasks.ts, xTB security
    # and ASE. Negating a two-normal formula would give the supplementary angle
    # and happens to agree only at +/-90 degrees.
    return math.degrees(math.atan2(float(np.dot(np.cross(axis,v),w)),float(np.dot(v,w))))


def coordinate_delta(value, target, kind):
    delta = value-target
    return (delta+180) % 360-180 if kind == 'D' else delta


def sidpp_tangent(previous, current, following, values, *, weighted=False):
    """Schmerwitz et al. 2310.04531, eqs. 6-9 (unit segments before weighting)."""
    forward=np.asarray(following)-current; backward=np.asarray(current)-previous
    nf,nb=np.linalg.norm(forward),np.linalg.norm(backward)
    require(nf>1e-10 and nb>1e-10,'S-IDPP adjacent images collapsed','PATH_SIDPP_DEGENERATE')
    a,b,c=values
    if not weighted and c>b>a: tangent=forward/nf
    elif not weighted and c<b<a: tangent=backward/nb
    else:
        high,low=max(abs(c-b),abs(a-b)),min(abs(c-b),abs(a-b))
        # Equal objectives leave eq.7 unspecified: its symmetric continuous tie
        # completion is the unit-segment bisector, not a raw-distance tangent.
        if high<=np.finfo(float).eps*max(1.,abs(a),abs(b),abs(c)): tangent=forward/nf+backward/nb
        elif c>a: tangent=forward/nf*high+backward/nb*low
        else: tangent=forward/nf*low+backward/nb*high
    norm=np.linalg.norm(tangent); require(norm>1e-10,'S-IDPP tangent is undefined','PATH_SIDPP_DEGENERATE')
    return tangent/norm


def sequential_idpp(initial,final,count,*,check,project=lambda x:x,max_steps=200,
                    max_force=.01,rms_force=.005,spring=1.,fixed=(),project_force=lambda x,f:f):
    """True sequential IDPP on the geometric A^-2 objective; no E/F provider.

    Implements the paper's original objective, normalized weighted tangent,
    central spring k*d_ideal/gap, frontier-triggered growth and equal-spring
    refinement. Velocity projection is the geometric optimizer, not MD time.
    """
    require(4<=count<=32,'S-IDPP requires at least two growing interior images')
    first,last=np.asarray(initial,float).copy(),np.asarray(final,float).copy()
    distance=np.linalg.norm(last-first); require(distance>1e-10,'Identical S-IDPP endpoints','PATH_SIDPP_DEGENERATE')
    ideal=distance/(count-1); direction=(last-first)/distance
    images=[first,project(first+ideal*direction),project(last-ideal*direction),last]
    labels=[0,1,count-2,count-1]; left=1; right=1; steps=0; trace=[]
    d0=np.linalg.norm(first[:,None]-first[None,:],axis=2); d1=np.linalg.norm(last[:,None]-last[None,:],axis=2)
    calculators={}; symbols=['H']*len(first)
    movable=np.ones(first.shape,dtype=bool); movable[list(fixed)]=False
    require(np.any(movable),'No movable S-IDPP coordinates')
    def forces(springs):
        check(); energies=[0.]; raw=[]
        for index,label in enumerate(labels[1:-1],1):
            pos=images[index]; pair=np.linalg.norm(pos[:,None]-pos[None,:],axis=2)
            require(np.all(pair[np.triu_indices(len(pos),1)]>1e-8),'S-IDPP has coincident atoms','PATH_SIDPP_DEGENERATE')
            if label not in calculators:
                fraction=label/(count-1); calculators[label]=IDPP(d0+fraction*(d1-d0),mic=False)
            atoms=Atoms(symbols,positions=pos,pbc=False); atoms.calc=calculators[label]
            energies.append(float(atoms.get_potential_energy())); raw.append(atoms.get_forces())
        energies.append(0.); arc=sum(np.linalg.norm(b-a) for a,b in zip(images,images[1:])); did=arc/(count-1)
        output=[]; tangents=[]
        for i,force in enumerate(raw,1):
            tangent=sidpp_tangent(images[i-1],images[i],images[i+1],energies[i-1:i+2])
            # Paper section 2.2 explicitly uses eq.7 for insertion even when
            # the effective-force tangent at this image would use eq.6.
            tangents.append(sidpp_tangent(images[i-1],images[i],images[i+1],energies[i-1:i+2],weighted=True))
            force=force-np.vdot(force,tangent)*tangent
            force+=(springs[i]*np.linalg.norm(images[i+1]-images[i])-springs[i-1]*np.linalg.norm(images[i]-images[i-1]))*tangent
            force=np.asarray(project_force(images[i],force),float)
            force[~movable]=0; output.append(force)
        result=np.asarray(output); require(np.isfinite(result).all(),'Nonfinite S-IDPP objective force')
        return result,tangents,springs,did
    def converged(force):
        values=np.asarray(force)[...,movable]
        return float(np.max(np.abs(values)))<=max_force and float(np.sqrt(np.mean(values**2)))<=rms_force
    def relax(equal):
        nonlocal steps
        velocity=np.zeros((len(images)-2,*first.shape))
        # Eqs.10-11 are refreshed when a new image is introduced. Keep that
        # schedule fixed during this relaxation, rather than changing the
        # center spring as the optimizer moves each image.
        springs=np.full(len(images)-1,spring)
        if not equal:
            arc=sum(np.linalg.norm(b-a) for a,b in zip(images,images[1:]));gap=np.linalg.norm(images[left+1]-images[left])
            require(gap>1e-10,'S-IDPP center gap collapsed','PATH_SIDPP_DEGENERATE');springs[left]=spring*arc/(count-1)/gap
        while True:
            force,tangents,springs,did=forces(springs)
            frontier=[left-1,len(images)-right-2]
            ready=[i for i in frontier if converged(force[i])]
            if (converged(force) if equal else bool(ready)):
                chosen=ready[0] if ready else 0
                trace.append(dict(imageCount=len(images),labels=list(labels),leftCount=left,rightCount=right,
                                  geometrySteps=steps,springConstants=springs.tolist(),maxObjectiveForce=float(np.max(np.abs(force))),
                                  phase='equal-spring-refinement' if equal else 'frontier-converged'))
                return chosen,tangents,did
            require(steps<max_steps,'S-IDPP geometric step budget exhausted','PATH_SIDPP_NOT_CONVERGED')
            # Velocity projection (paper section 2.1). Step size is an optimizer
            # setting for the geometric objective, with no physical time unit.
            velocity+=.02*force; dot=float(np.vdot(velocity,force)); f2=float(np.vdot(force,force))
            velocity[:]=force*(dot/f2) if dot>0 and f2>0 else 0
            displacement=.02*velocity; maximum=float(np.linalg.norm(displacement,axis=2).max())
            if maximum>.05: displacement*=.05/maximum
            for i,delta in enumerate(displacement,1):
                candidate=images[i]+delta; candidate[~movable]=first[~movable]; images[i]=np.asarray(project(candidate),float)
            steps+=1
    while len(images)<count:
        chosen,tangents,did=relax(False)
        if chosen==left-1:
            images.insert(left+1,project(images[left]+did*tangents[left-1])); labels.insert(left+1,left+1); left+=1
        else:
            frontier=len(images)-1-right
            images.insert(frontier,project(images[frontier]-did*tangents[frontier-1])); labels.insert(frontier,count-2-right); right+=1
    relax(True)
    require(all(np.linalg.norm(b-a)>1e-10 for a,b in zip(images,images[1:])),'S-IDPP adjacent images collapsed')
    return images,dict(driver='sequential-idpp',reference='https://arxiv.org/html/2310.04531v1',objectiveUnit='angstrom^-2',
                       objectiveGradientUnit='angstrom^-3',baseSpringUnit='angstrom^-2',baseSpring=spring,
                       maxObjectiveForce=max_force,rmsObjectiveForce=rms_force,geometrySteps=steps,
                       tangent='paper-eq6-9-unit-segments-before-weighting',insertionTangent='always-paper-eq7',
                       endpointAlignment='source-endpoints-preserved-as-provided',optimizer=dict(name='velocity-projection',step=.02,maxDisplacementAngstrom=.05),
                       equalObjectiveTie='unit-bisector',trace=trace)


def scan_axes(scan):
    if 'coordinate' in scan:
        return [dict(coordinate=scan['coordinate'],start=scan['start'],stop=scan['stop'],pointCount=scan['pointCount'])],'synchronous'
    return scan['coordinates'],scan.get('combination','synchronous')


def scan_points(scan):
    axes,combination=scan_axes(scan)
    counts=[scan['pointCount']]*len(axes) if combination=='synchronous' else [a['pointCount'] for a in axes]
    ranges=[np.linspace(a['start'],a['stop'],n) for a,n in zip(axes,counts)]
    indices=([j]*len(axes) for j in range(counts[0])) if combination=='synchronous' else itertools.product(*(range(n) for n in counts))
    for index in indices:
        yield [dict(**a['coordinate'],value=float(values[j])) for a,values,j in zip(axes,ranges,index)],list(index)


def bpp_initial_path(payload,first,last,count):
    """Derived initial geometry, not native NEB or an accepted TS.

    Native BPP aligns structures and its final endpoint may be approximate.
    Preserve raw frames/comments, proper-fit (no reflection), pin exact source
    endpoints, then resample the resulting Cartesian arc by stable atom order.
    """
    require(isinstance(payload,dict) and set(payload)=={'frames','comments','evidence'},'Trusted BPP payload required')
    raw=np.asarray(payload['frames'],float)
    require(raw.ndim==3 and raw.shape[1:]==first.shape and 3<=len(raw)<=200 and np.isfinite(raw).all() and np.max(np.abs(raw))<=1e6,'Invalid BPP geometry')
    require(isinstance(payload['comments'],list) and len(payload['comments'])==len(raw) and all(isinstance(s,str) and len(s)<=8192 for s in payload['comments']),'Invalid BPP raw comments')
    evidence=payload['evidence']; require(isinstance(evidence,dict) and evidence.get('driver')=='xtb-rmsd-bpp' and evidence.get('physicalEvaluationCount') is None and evidence.get('maximumBiasTrials')==24,'Invalid BPP evidence')
    center=raw[0].mean(axis=0); target=first.mean(axis=0)
    u,_,vt=np.linalg.svd((raw[0]-center).T@(first-target)); correction=np.eye(3);correction[-1,-1]=np.linalg.det(u@vt)
    rotation=u@correction@vt; aligned=(raw-center)@rotation+target
    points=[first.copy()]
    for xyz in aligned:
        if np.linalg.norm(xyz-points[-1])>1e-10: points.append(xyz)
    if np.linalg.norm(last-points[-1])>1e-10: points.append(last.copy())
    else: points[-1]=last.copy()
    arc=np.concatenate(([0.],np.cumsum([np.linalg.norm(b-a) for a,b in zip(points,points[1:])])))
    require(arc[-1]>1e-10,'Collapsed BPP path')
    positions=np.array(points);result=[]
    for distance in np.linspace(0,arc[-1],count):
        i=min(int(np.searchsorted(arc,distance,side='right'))-1,len(points)-2); i=max(i,0)
        fraction=(distance-arc[i])/(arc[i+1]-arc[i]);result.append((1-fraction)*positions[i]+fraction*positions[i+1])
    result[0]=first.copy();result[-1]=last.copy()
    return result,dict(**evidence,derivation='proper-fit-source-reactant-pin-exact-endpoints-cartesian-arclength-resample',
                       rawFrames=payload['frames'],rawComments=payload['comments'],physicalEnergiesReused=False,
                       sourceReactantFitRMSDAngstrom=float(np.sqrt(np.mean(np.sum((aligned[0]-first)**2,axis=1)))))


def validate_request(raw):
    require(isinstance(raw, dict), 'Bounded request required')
    allowed = {'schema','stamp','runIdentity','operation','structure','method','charge','uhf','frozenAtomIds','constraints',
               *DEFAULTS,'maxWallTimeSeconds','calculator','scan','ts','neb'}
    require(set(raw) <= allowed and raw.get('schema') == 1 and raw.get('operation') in ('scan','ts','ci-neb-ts'), 'Unsupported path request')
    require(raw.get('method') in ('gfn1','gfn2'), 'Only GFN1/GFN2 path calculators are supported')
    stamp, run = raw.get('stamp'), raw.get('runIdentity')
    require(isinstance(stamp,dict) and isinstance(stamp.get('documentId'),str) and bool(stamp['documentId']) and integer(stamp.get('revision'),0,2**53-1)
            and all(isinstance(stamp.get(k),str) and len(stamp[k].encode())<=1024*1024 for k in ('graphFingerprint','coordinatesFingerprint','constraintsFingerprint'))
            and ('activationEpoch' not in stamp or integer(stamp['activationEpoch'],0,2**53-1)), 'Invalid source stamp')
    require(isinstance(run,dict) and set(run)=={'taskId','runId'} and all(identity(v) for v in run.values()), 'Invalid task/run identity')
    request = copy.deepcopy({**DEFAULTS, **raw})
    def check_structure(structure):
        require(isinstance(structure,dict) and isinstance(structure.get('atoms'),list) and len(structure['atoms'])>=1,
                'Complete nonempty atom structure required')
        require(not structure.get('periodicSource') and not any(structure.get('cell',{}).get('pbc',[])) and
                not any(any(b.get('image',[0,0,0])) for b in structure.get('bonds',[])), 'Periodic paths are unsupported')
        atoms=structure['atoms']; ids=[a.get('id') for a in atoms]
        require(all(isinstance(i,str) and i for i in ids) and len(set(ids))==len(ids), 'Unique stable atom IDs required')
        require(all(a.get('element') in atomic_numbers and 1<=atomic_numbers[a['element']]<=86 and all(finite(a.get(k),-1e6,1e6) for k in ('x','y','z')) for a in atoms), 'Invalid path atom')
        return ids
    ids=check_structure(request.get('structure')); atoms=request['structure']['atoms']
    xyz=np.array([[a[k] for k in ('x','y','z')] for a in atoms])
    require(integer(request.get('charge'),-100,100), 'Integer charge required')
    electrons=sum(atomic_numbers[a['element']] for a in atoms)-request['charge']
    require(electrons>0 and integer(request.get('uhf'),0,electrons) and (electrons-request['uhf'])%2==0, 'Charge/UHF parity mismatch')
    require(integer(request['threads'],1,1024) and integer(request['maxSteps'],1,2**53-1) and integer(request['maxEvaluations'],1,2**53-1)
            and ('maxWallTimeSeconds' not in request or finite(request['maxWallTimeSeconds'],.01,1800)) and finite(request['forceToleranceEVPerAngstrom'],1e-6,1), 'Invalid execution budget')
    request.setdefault('frozenAtomIds',[]); request.setdefault('constraints',[])
    frozen=request['frozenAtomIds']
    require(isinstance(frozen,list) and len(set(frozen))==len(frozen) and set(frozen)<set(ids), 'Invalid or fully frozen atoms')
    index={id:i for i,id in enumerate(ids)}
    def check_coordinate(row):
        require(isinstance(row,dict) and row.get('type') in ('B','A','D') and isinstance(row.get('atomIds'),list), 'Invalid internal coordinate')
        refs=row['atomIds']; require(len(refs)=={'B':2,'A':3,'D':4}[row['type']] and len(set(refs))==len(refs) and all(i in index for i in refs), 'Invalid coordinate atom IDs')
        coordinate_value(xyz,row['type'],[index[i] for i in refs])
    require(isinstance(request['constraints'],list) and len(request['constraints'])<=100, 'Invalid constraints')
    seen=set()
    for row in request['constraints']:
        check_coordinate(row); require(row.get('action')=='freeze' and row.get('steps',0) in (0,1) and row.get('increment') is None, 'Only internal freezes are supported')
        key=(row['type'],min(tuple(row['atomIds']),tuple(row['atomIds'][::-1])))
        require(key not in seen,'Duplicate internal constraint'); seen.add(key)
        row.setdefault('value',coordinate_value(xyz,row['type'],[index[i] for i in row['atomIds']]))
        require(finite(row['value'],1e-6 if row['type']=='B' else 1e-4 if row['type']=='A' else -180,1e6 if row['type']=='B' else 179.9999 if row['type']=='A' else 180),'Invalid freeze target')
    calc={**dict(accuracy=1,maxIterations=250,electronicTemperatureK=300),**request.get('calculator',{})}
    require(set(calc)=={'accuracy','maxIterations','electronicTemperatureK'} and finite(calc['accuracy'],.001,10) and integer(calc['maxIterations'],1,2**53-1) and finite(calc['electronicTemperatureK'],0,10000),'Invalid calculator settings'); request['calculator']=calc
    op=request['operation']
    require(all(name=={'scan':'scan','ts':'ts','ci-neb-ts':'neb'}[op] or name not in request for name in ('scan','ts','neb')),'Configuration belongs to another path operation')
    if op=='scan':
        scan=request.get('scan'); require(isinstance(scan,dict),'Invalid scan configuration')
        if 'coordinate' in scan:
            require(set(scan)=={'coordinate','start','stop','pointCount'},'Invalid legacy scan configuration')
        else:
            require(set(scan)<={'coordinates','combination','pointCount'} and isinstance(scan.get('coordinates'),list) and 1<=len(scan['coordinates'])<=3,'A scan needs 1-3 coordinates')
            scan.setdefault('combination','synchronous')
        axes,combination=scan_axes(scan); require(combination in ('synchronous','grid'),'Explicit scan combination required')
        if combination=='synchronous': require(integer(scan.get('pointCount'),2,2**53-1),'Invalid synchronous point count')
        else: require('pointCount' not in scan,'Grid counts belong to each coordinate')
        total=1
        for axis in axes:
            require(set(axis)<={'coordinate','start','stop','pointCount'},'Unknown scan axis field'); check_coordinate(axis['coordinate'])
            kind=axis['coordinate']['type']; lo,hi=(1e-6,1e6) if kind=='B' else (1e-4,179.9999) if kind=='A' else (-100000,100000)
            count=scan['pointCount'] if combination=='synchronous' else axis.get('pointCount')
            require(integer(count,2,2**53-1) and finite(axis.get('start'),lo,hi) and finite(axis.get('stop'),lo,hi) and axis['start']!=axis['stop'],'Invalid directed scan range/count')
            require(combination!='synchronous' or 'pointCount' not in axis or axis['pointCount']==count,'Synchronous axes must share one point count')
            key=(kind,min(tuple(axis['coordinate']['atomIds']),tuple(axis['coordinate']['atomIds'][::-1])))
            require(key not in seen and any(i not in frozen for i in axis['coordinate']['atomIds']),'Duplicate or frozen scanned coordinate');seen.add(key)
            if combination=='grid': total*=count
        require((total if combination=='grid' else scan['pointCount'])<=2**53-1,'Scan grid product exceeds exact integer range')
    elif op=='ts':
        mode=request.get('ts',{}).get('initialMode'); require(isinstance(mode,dict) and mode.get('kind') in ('vector','estimated'),'Explicit TS mode source required')
        if mode['kind']=='estimated': require(set(mode)=={'kind','seed'} and integer(mode['seed'],0,2**32-1),'Deterministic mode seed required')
        else:
            require(set(mode)=={'kind','vectors'} and isinstance(mode['vectors'],list) and len(mode['vectors'])==len(ids),'Complete mode vector required')
            for id,row in zip(ids,mode['vectors']): require(set(row)=={'atomId','x','y','z'} and row['atomId']==id and all(finite(row[k],-1e6,1e6) for k in ('x','y','z')) and (id not in frozen or all(row[k]==0 for k in ('x','y','z'))),'Invalid mode vector identity/freeze')
            require(sum(row[k]**2 for row in mode['vectors'] for k in ('x','y','z'))>1e-20,'Zero mode vector')
    else:
        neb={**dict(imageCount=7,initialPath='idpp',springConstantEVPerAngstrom2=.1,preoptimizeEndpoints=False,warmupForceToleranceEVPerAngstrom=.1,previewOnly=False),**request.get('neb',{})}
        product_ids=check_structure(neb.get('product')); mapping=neb.get('mapping')
        require(len(product_ids)==len(ids) and isinstance(mapping,list) and len(mapping)==len(ids) and all(isinstance(m,dict) and set(m)=={'reactantAtomId','productAtomId'} for m in mapping),'Complete endpoint mapping required')
        require({m['reactantAtomId'] for m in mapping}==set(ids) and {m['productAtomId'] for m in mapping}==set(product_ids),'Endpoint mapping must be bijective')
        products={a['id']:a for a in neb['product']['atoms']}; ordered=[products[next(m['productAtomId'] for m in mapping if m['reactantAtomId']==id)] for id in ids]
        require(all(a['element']==b['element'] for a,b in zip(atoms,ordered)),'Endpoint mapping element mismatch')
        require(all(all(a[k]==b[k] for k in ('x','y','z')) for a,b in zip(atoms,ordered) if a['id'] in frozen),'Frozen endpoint positions differ')
        require(integer(neb['imageCount'],3,2**53-1) and neb['initialPath'] in ('linear','idpp','sidpp','xtb-bpp') and finite(neb['springConstantEVPerAngstrom2'],1e-6,10) and type(neb['preoptimizeEndpoints']) is bool and type(neb['previewOnly']) is bool and not (neb['previewOnly'] and neb['preoptimizeEndpoints']) and finite(neb['warmupForceToleranceEVPerAngstrom'],request['forceToleranceEVPerAngstrom'],1),'Invalid NEB configuration')
        require(neb['initialPath']!='sidpp' or neb['imageCount']>=4,'S-IDPP requires at least four images')
        require(neb['initialPath']!='xtb-bpp' or not neb['previewOnly'] and not neb['preoptimizeEndpoints'] and not frozen and not request['constraints'],'xTB-BPP is an explicit physical path calculation; preview/preoptimization/freezes are unsupported')
        require(neb['initialPath']=='xtb-bpp' or 'bpp' not in neb,'BPP settings belong only to xTB-BPP')
        if neb['initialPath']=='xtb-bpp':
            bpp={**dict(npoint=25,anopt=10,kpush=.003,kpull=-.015,ppull=.05,alp=1.2),**neb.get('bpp',{})}
            require(set(bpp)=={'npoint','anopt','kpush','kpull','ppull','alp'} and integer(bpp['npoint'],3,200) and integer(bpp['anopt'],1,100) and finite(bpp['kpush'],1e-6,1) and finite(bpp['kpull'],-1,-1e-6) and finite(bpp['ppull'],1e-6,1) and finite(bpp['alp'],.05,10),'Invalid BPP controls');neb['bpp']=bpp
        request['neb']=neb
    return request


class BudgetCalculator(Calculator):
    implemented_properties=['energy','forces']
    def __init__(self, session, underlying):
        super().__init__(); self.session=session; self.underlying=underlying
    def calculate(self,atoms=None,properties=None,system_changes=all_changes):
        self.session.check()
        require(self.session.evaluations<self.session.request['maxEvaluations'],'Physical evaluation budget exhausted','PATH_EVALUATION_LIMIT')
        super().calculate(atoms,properties,system_changes)
        self.session.evaluations+=1
        self.underlying.calculate(atoms,['energy','forces'],system_changes)
        energy=float(self.underlying.results['energy']); forces=np.asarray(self.underlying.results['forces'],dtype=float)
        require(finite(energy) and forces.shape==(len(atoms),3) and np.isfinite(forces).all() and np.max(np.abs(forces))<=1e12,'Nonfinite physical energy/forces','PATH_NONFINITE')
        self.results={'energy':energy,'forces':forces.copy()}
        self.session.check()


def tblite_calculator(request):
    from tblite.ase import TBLite
    calc=request['calculator']
    return TBLite(method={'gfn1':'GFN1-xTB','gfn2':'GFN2-xTB'}[request['method']],charge=request['charge'],multiplicity=request['uhf']+1,
                  accuracy=calc['accuracy'],max_iterations=calc['maxIterations'],electronic_temperature=calc['electronicTemperatureK'],verbosity=0)


class Session:
    def __init__(self,request,emit,*,cancelled=None,calculator_factory=tblite_calculator,clock=time.monotonic,initial_path=None,elapsed_before=0):
        require(finite(elapsed_before,0,float('inf')),'Invalid prior native elapsed time')
        self.request=validate_request(request); self.emit=emit; self.clock=clock; self.started=clock()-elapsed_before; self.cancelled=cancelled or threading.Event()
        self.native_initial_path=initial_path; self.bpp_evidence=None
        self.factory=calculator_factory; self.evaluations=0; self.frame_index=0; self.stages=[]; self.last_frame=None
        self.source=copy.deepcopy(self.request['structure']); self.ids=[a['id'] for a in self.source['atoms']]; self.index={id:i for i,id in enumerate(self.ids)}
        self.original=np.array([[a[k] for k in ('x','y','z')] for a in self.source['atoms']],dtype=float)
        self.fixed=[self.index[id] for id in self.request['frozenAtomIds']]
        self.constraints=copy.deepcopy(self.request['constraints'])
    def check(self):
        if self.cancelled.is_set(): raise Cancelled('PATH_CANCELLED','Path run cancelled')
        limit=self.request.get('maxWallTimeSeconds')
        require(limit is None or self.clock()-self.started<=limit,'Path wall-time budget exhausted','PATH_WALL_LIMIT')
    def stage(self,id,phase,**data):
        self.check(); self.emit(dict(kind='stage',stageId=id,phase=phase,**data))
    def rows(self,extra=None):
        return self.constraints+([] if extra is None else [extra])
    def residuals(self,positions,rows):
        result=[]
        for row in rows:
            actual=coordinate_value(positions,row['type'],[self.index[i] for i in row['atomIds']]); residual=coordinate_delta(actual,row['value'],row['type'])
            result.append(dict(id=row.get('id','scan'),type=row['type'],atomIds=row['atomIds'],target=row['value'],actual=actual,residual=residual,unit='angstrom' if row['type']=='B' else 'degree'))
        return result
    def feasible(self,positions,rows):
        return all(abs(r['residual'])<=CONSTRAINT_TOLERANCES[r['type']] for r in self.residuals(positions,rows))
    def frame(self,atoms,stage,iteration,*,rows=None,role='optimizer',projected=None,**extra):
        self.check(); xyz=atoms.get_positions(); require(np.isfinite(xyz).all() and np.max(np.abs(xyz))<=1e6,'Nonfinite frame geometry')
        require(not self.fixed or np.array_equal(xyz[self.fixed],self.original[self.fixed]),'Atomic freeze moved','PATH_FIXED_MOVED')
        rows=self.constraints if rows is None else rows; residuals=self.residuals(xyz,rows)
        require(self.feasible(xyz,rows),'Internal constraint residual exceeded algorithmic tolerance','PATH_CONSTRAINT_RESIDUAL')
        packet=dict(kind='frame',stageId=stage,collectionId=stage,frameIndex=self.frame_index,iteration=iteration,role=role,
                    coordinates=[dict(id=id,element=a['element'],x=float(p[0]),y=float(p[1]),z=float(p[2])) for id,a,p in zip(self.ids,self.source['atoms'],xyz)],
                    constraintResiduals=residuals,units=dict(coordinates='angstrom',energy='eV',forces='eV/angstrom',curvature='eV/angstrom^2'),**extra)
        if role!='initial-path':
            energy=float(atoms.get_potential_energy()); raw=np.asarray(atoms.get_forces(apply_constraint=False)); force=np.asarray(atoms.get_forces()) if projected is None else np.asarray(projected)
            require(finite(energy) and np.isfinite(raw).all() and np.isfinite(force).all(),'Nonfinite frame values')
            packet.update(energyEV=energy,rawForcesEVPerAngstrom=raw.tolist(),projectedForceMaxEVPerAngstrom=float(np.linalg.norm(force,axis=1).max()))
        self.frame_index+=1
        self.emit(packet); self.last_frame=copy.deepcopy(packet); return packet
    def atoms(self,positions,rows=None,physical=True):
        atoms=Atoms([a['element'] for a in self.source['atoms']],positions=np.asarray(positions).copy(),pbc=False)
        constraints=[]; rows=self.constraints if rows is None else rows
        implied=[row for row in rows if all(id in self.request['frozenAtomIds'] for id in row['atomIds'])]
        require(self.feasible(atoms.positions,implied),'An atom-implied internal freeze has a conflicting target','PATH_CONSTRAINT_CONFLICT')
        rows=[row for row in rows if row not in implied]
        if rows:
            require(3*len(atoms)>=6+len(rows) and np.linalg.matrix_rank(atoms.positions-atoms.positions.mean(axis=0))>=2,'Internal constrained TS/NEB requires non-collinear adequate degrees of freedom','PATH_CONSTRAINT_DEGENERATE')
            data={'bonds':[],'angles_deg':[],'dihedrals_deg':[]}
            for row in rows:
                value=row['value']%360 if row['type']=='D' else row['value']
                data[{'B':'bonds','A':'angles_deg','D':'dihedrals_deg'}[row['type']]].append([value,[self.index[id] for id in row['atomIds']]])
            constraints.append(FixInternals(**data,epsilon=1e-9))
        if self.fixed: constraints.append(FixAtoms(indices=self.fixed))
        atoms.set_constraint(constraints)
        if physical: atoms.calc=BudgetCalculator(self,self.factory(self.request))
        return atoms
    def jacobian(self,xyz,rows,variables):
        jac=np.empty((len(rows),len(variables))); step=1e-6
        for j,k in enumerate(variables):
            plus=xyz.copy().ravel(); minus=plus.copy(); plus[k]+=step; minus[k]-=step
            for i,row in enumerate(rows):
                ix=[self.index[id] for id in row['atomIds']]
                jac[i,j]=coordinate_delta(coordinate_value(plus.reshape(-1,3),row['type'],ix),coordinate_value(minus.reshape(-1,3),row['type'],ix),row['type'])/(2*step)
        return jac
    def scan(self):
        scan=self.request['scan']; positions=self.original.copy(); variables=np.array([3*i+j for i in range(len(self.ids)) if i not in self.fixed for j in range(3)])
        local_box=dict(maxAtomDisplacementAngstrom=.10,cartesianHalfWidthAngstrom=.10/math.sqrt(3),recenterPolicy='successful-feasible-boundary-progress-only')
        completed=[]
        for point,(targets,grid_indices) in enumerate(scan_points(scan)):
            self.check(); stage=f'scan-point-{point}'; rows=self.constraints+targets
            point_evaluation_start=self.evaluations
            target_data=[dict(id=r.get('id','scan'),type=r['type'],atomIds=r['atomIds'],target=r['value'],unit='angstrom' if r['type']=='B' else 'degree') for r in targets]
            context=dict(pointIndex=point,targets=target_data,gridIndices=grid_indices)
            if len(targets)==1: context['target']=targets[0]['value']
            self.stage(stage,'started',**context,evaluationsAtPointStart=point_evaluation_start,segmentIndex=0,cumulativeMajorIterations=0,configuration=dict(solver='scipy-slsqp',constraintTolerances=CONSTRAINT_TOLERANCES,localBox=local_box))
            reference=positions.copy(); base=reference.ravel().copy()
            last_projection_x=base[variables].copy()
            def full(x):
                nonlocal last_projection_x
                last_projection_x=np.asarray(x).copy()
                xyz=base.copy(); xyz[variables]=x; return xyz.reshape(-1,3)
            implied=[r for r in rows if all(id in self.request['frozenAtomIds'] for id in r['atomIds'])]
            require(self.feasible(reference,implied),'An atom-implied internal freeze has a conflicting target','PATH_CONSTRAINT_CONFLICT')
            active=[r for r in rows if r not in implied]
            conditions=[dict(type='eq',fun=lambda x,r=r: coordinate_delta(coordinate_value(full(x),r['type'],[self.index[id] for id in r['atomIds']]),r['value'],r['type']),
                             jac=lambda x,r=r:self.jacobian(full(x),[r],variables)[0]) for r in active]
            seed=reference.ravel()[variables]
            def projection_diagnostic(result=None,error=None):
                x=last_projection_x if result is None else result.x;xyz=base.copy();xyz[variables]=x;xyz=xyz.reshape(-1,3)
                residuals=[]
                for row in rows:
                    try:
                        measured=self.residuals(xyz,[row]);require(all(finite(r['actual']) and finite(r['residual']) for r in measured),'Nonfinite projection residual')
                        residuals.extend(measured)
                    except PathError as failure: residuals.append(dict(id=row.get('id','scan'),type=row['type'],atomIds=row['atomIds'],target=row['value'],actual=None,residual=None,unit='angstrom' if row['type']=='B' else 'degree',measurementError=str(failure)))
                return dict(solver='scipy-slsqp',phase='feasibility-projection',pointIndex=point,gridIndices=grid_indices,
                            status=None if result is None else int(result.status),message=str(error) if result is None else str(result.message),
                            optimizerSuccess=False if result is None else bool(result.success),iterations=None if result is None else int(result.nit),
                            initialResiduals=self.residuals(reference,rows),finalResiduals=residuals,constraintTolerances=CONSTRAINT_TOLERANCES)
            try:
                projected=minimize(lambda x: float(np.sum((x-seed)**2)),seed,jac=lambda x:2*(x-seed),constraints=conditions,method='SLSQP',callback=lambda x:self.check(),options=dict(ftol=1e-12,maxiter=self.request['maxSteps']))
            except PathError as failure:
                if isinstance(failure,Cancelled): raise
                raise PathError(failure.code,str(failure),projection_diagnostic(error=failure)) from failure
            # This first solve supplies only a feasible seed, not a scientific
            # optimum. SLSQP may report a line-search status after already
            # meeting every exact geometric target. Preserve that status; the
            # independent physical solve below must still converge normally.
            try: feasible=np.isfinite(projected.x).all() and self.feasible(full(projected.x),rows)
            except PathError: feasible=False
            if not feasible:
                raise PathError('PATH_CONSTRAINT_CONFLICT','Scan target/freeze feasibility projection did not satisfy the requested constraints',projection_diagnostic(projected))
            context['feasibilityProjection']=dict(role='feasibility-only',optimizerSuccess=bool(projected.success),status=int(projected.status),message=str(projected.message))
            jac=self.jacobian(full(projected.x),active,variables);norms=np.linalg.norm(jac,axis=1)
            require(np.all(norms>1e-10),'Scan coordinate derivative vanishes','PATH_CONSTRAINT_DEGENERATE')
            singular=np.linalg.svd(jac/norms[:,None],compute_uv=False)
            require(len(singular)==len(active) and singular[-1]>1e-7*singular[0],'Scan coordinate set is linearly dependent','PATH_CONSTRAINT_DEGENERATE')
            # SLSQP owns exact Cartesian variables; do not attach FixInternals.
            seed_xyz=full(projected.x).copy();atoms=self.atoms(seed_xyz,rows=[]);iteration=0
            completed_callbacks=0;value_calls=0;objective_calls=0;last_callback_xyz=None
            anchor=np.asarray(projected.x).copy();segment_index=0;major_iterations=0;segment_callbacks=0;segments=[];segment_max_displacement=0.
            def diagnostic_coordinates(xyz):
                return [dict(id=id,element=atom['element'],**{key:float(value) if math.isfinite(value) else None for key,value in zip(('x','y','z'),pos)}) for id,atom,pos in zip(self.ids,self.source['atoms'],xyz)]
            def diagnostic_residuals(xyz):
                residuals=[]
                for row in rows:
                    try:
                        measured=self.residuals(xyz,[row]);require(all(math.isfinite(r['actual']) and math.isfinite(r['residual']) for r in measured),'Nonfinite trial coordinate')
                        residuals.extend(measured)
                    except Exception as measurement_error:
                        residuals.append(dict(id=row.get('id','scan'),type=row['type'],atomIds=row['atomIds'],target=row['value'],actual=None,residual=None,
                                              unit='angstrom' if row['type']=='B' else 'degree',measurementError=str(measurement_error)[:1024]))
                return residuals
            def diagnostic_pairs(xyz):
                # Output is bounded: <=120 pairs for <=16 atoms, otherwise
                # <=66 related pairs plus one global minimum. The global-min
                # search uses O(N) scratch, never an O(N^2) output/matrix.
                related={id for row in rows for id in row['atomIds']};small=len(xyz)<=16
                selected=list(range(len(xyz))) if small else [i for i,id in enumerate(self.ids) if id in related][:12]
                pairs=[(i,j) for offset,i in enumerate(selected) for j in selected[offset+1:]];minimum=None
                with np.errstate(over='ignore',invalid='ignore'):
                    for i in range(len(xyz)-1):
                        distances=np.linalg.norm(xyz[i+1:]-xyz[i],axis=1);valid=np.flatnonzero(np.isfinite(distances))
                        if len(valid):
                            offset=int(valid[np.argmin(distances[valid])]);value=float(distances[offset]);j=i+1+offset
                            if minimum is None or value<minimum[0]:minimum=(value,i,j)
                    if minimum is not None and (minimum[1],minimum[2]) not in pairs:pairs.append((minimum[1],minimum[2]))
                    values=[]
                    for i,j in pairs:
                        distance=float(np.linalg.norm(xyz[j]-xyz[i]));values.append(dict(atomIds=[self.ids[i],self.ids[j]],distanceAngstrom=distance if math.isfinite(distance) else None))
                return dict(scope='all-pairs-small-system' if small else 'first12-related-plus-global-minimum',relatedAtomCount=len(related),
                            pairAtomIdsIncluded=[self.ids[i] for i in selected],relatedAtomsTruncated=not small and len(related)>12,pairs=values,
                            minimumFinitePairDistanceAngstrom=None if minimum is None else minimum[0],
                            closestFinitePairAtomIds=None if minimum is None else [self.ids[minimum[1]],self.ids[minimum[2]]])
            def diagnostic_displacement(xyz,origin):
                if origin is None or not np.isfinite(xyz).all() or not np.isfinite(origin).all():return None
                with np.errstate(over='ignore',invalid='ignore'):value=float(np.linalg.norm(xyz-origin,axis=1).max())
                return value if math.isfinite(value) else None
            def trial_diagnostic(xyz,before,site,property_phase,error):
                data=dict(dataRole='unaccepted-evaluation-trial',acceptedResult=False,solver='scipy-slsqp',phase='physical-evaluation',
                          stageId=stage,pointIndex=point,gridIndices=grid_indices,targets=target_data,coordinateUnit='angstrom',
                          coordinates=diagnostic_coordinates(xyz),allCoordinatesFinite=bool(np.isfinite(xyz).all()),coordinatesCapturedBeforeEvaluation=True,
                          requestSite=site,failedPropertyPhase=property_phase,valueFunctionCallOrdinal=value_calls,objectiveCallOrdinal=objective_calls,
                          callbackEnteredCount=iteration,completedCallbackCount=completed_callbacks,evaluationsAtPointStart=point_evaluation_start,
                          localBox=local_box,segmentIndex=segment_index,completedMajorIterations=major_iterations,segmentCallbackCount=segment_callbacks,
                          segmentAnchorCoordinates=diagnostic_coordinates(full(anchor)),completedSolverSegments=copy.deepcopy(segments),
                          evaluationsBeforeCall=before,evaluationsAfterFailure=self.evaluations,pointEvaluationAttempts=self.evaluations-point_evaluation_start,
                          physicalInvocationObserved=self.evaluations>before,physicalEvaluationOrdinal=self.evaluations if self.evaluations>before else None,
                          trialConstraintResiduals=diagnostic_residuals(xyz),constraintTolerances=CONSTRAINT_TOLERANCES,
                          seedProjection=dict(**context['feasibilityProjection'],iterations=int(projected.nit),coordinates=diagnostic_coordinates(seed_xyz),constraintResiduals=diagnostic_residuals(seed_xyz)),
                          lastCompletedCallbackCoordinates=None if last_callback_xyz is None else diagnostic_coordinates(last_callback_xyz),
                          maxAtomDisplacementFromSeedAngstrom=diagnostic_displacement(xyz,seed_xyz),maxAtomDisplacementFromLastCallbackAngstrom=diagnostic_displacement(xyz,last_callback_xyz),
                          pairDistances=diagnostic_pairs(xyz),sourceError=dict(type=type(error).__module__+'.'+type(error).__name__,message=str(error)[:8192]))
                if getattr(error,'diagnostic',None) is not None:data['upstreamDiagnostic']=error.diagnostic
                return data
            def values(x,site='objective-trial'):
                nonlocal value_calls,objective_calls,segment_max_displacement
                self.check(); atoms.set_positions(full(x),apply_constraint=False)
                trial_xyz=atoms.positions.copy();before=self.evaluations;value_calls+=1
                if site=='objective-trial':objective_calls+=1
                property_phase='energy'
                try:
                    # A box is an optimizer control, never an artificial force.
                    # Do not clip only the objective or invent a penalty value.
                    epsilon=64*np.finfo(float).eps*max(1.,float(np.max(np.abs(anchor))))
                    require(np.isfinite(x).all() and np.max(np.abs(x-anchor))<=local_box['cartesianHalfWidthAngstrom']+epsilon,
                            'SLSQP physical trial exceeded its local Cartesian box','PATH_SCAN_TRIAL_BOUND')
                    segment_max_displacement=max(segment_max_displacement,diagnostic_displacement(trial_xyz,full(anchor)))
                    energy=atoms.get_potential_energy();property_phase='forces';force=atoms.get_forces(apply_constraint=False)
                except Exception as error:
                    try:error.diagnostic=trial_diagnostic(trial_xyz,before,site,property_phase,error)
                    except Exception as capture_error:
                        try:error.diagnostic=dict(dataRole='unaccepted-evaluation-trial',acceptedResult=False,stageId=stage,pointIndex=point,evaluationsAfterFailure=self.evaluations,diagnosticCaptureError=str(capture_error)[:1024])
                        except Exception:pass
                    raise # Preserve the original exception; no retry or extra E/F.
                return float(energy),-force.ravel()[variables]
            def tangent_force(x):
                _,gradient=values(x,'projected-force-check'); jac=self.jacobian(full(x),active,variables)
                gradient=gradient-jac.T@np.linalg.lstsq(jac.T,gradient,rcond=None)[0]
                force=np.zeros(atoms.positions.size); force[variables]=-gradient; return force.reshape(-1,3)
            def accepted(x):
                nonlocal iteration,completed_callbacks,last_callback_xyz,segment_callbacks
                self.check(); iteration+=1;segment_callbacks+=1
                if self.feasible(full(x),rows): self.frame(atoms,stage,iteration,rows=rows,projected=tangent_force(x),**context,segmentIndex=segment_index,completedMajorIterations=major_iterations,segmentCallbackCount=segment_callbacks)
                last_callback_xyz=full(x).copy();completed_callbacks+=1
            def solve_failure(message,code):
                data=dict(solver='scipy-slsqp',phase='local-box-solve',**context,localBox=local_box,segmentIndex=segment_index,solverSegments=copy.deepcopy(segments),cumulativeMajorIterations=major_iterations)
                self.stage(stage,'completed',**{key:value for key,value in data.items() if key!='phase'},searchConverged=False,reason=message,evaluationsAtPointStart=point_evaluation_start,evaluations=self.evaluations-point_evaluation_start,cumulativeEvaluations=self.evaluations)
                raise PathError(code,message,data)
            while True:
                self.check()
                if major_iterations>=self.request['maxSteps']:solve_failure('Scan global major-iteration budget exhausted','PATH_SCAN_NOT_CONVERGED')
                half=local_box['cartesianHalfWidthAngstrom'];segment_callbacks=0;segment_max_displacement=0.;segment_start=self.evaluations
                result=minimize(lambda x:values(x),anchor.copy(),jac=True,method='SLSQP',constraints=conditions,bounds=list(zip(anchor-half,anchor+half)),
                                callback=accepted,options=dict(ftol=1e-10,maxiter=self.request['maxSteps']-major_iterations))
                charged=max(1,int(result.nit));major_iterations+=charged
                try:resolved=bool(np.isfinite(result.x).all() and self.feasible(full(result.x),rows))
                except PathError:resolved=False
                progress=float(np.max(np.abs(result.x-anchor))) if np.isfinite(result.x).all() else None
                boundary=bool(progress is not None and np.any(np.abs(result.x-anchor)>=half-1e-8))
                segment=dict(segmentIndex=segment_index,optimizerSuccess=bool(result.success),status=int(result.status),message=str(result.message),
                             iterations=int(result.nit),chargedMajorIterations=charged,cumulativeMajorIterations=major_iterations,
                             feasible=resolved,boundaryReached=boundary,maximumCartesianProgressAngstrom=progress,
                             maxTrialAtomDisplacementAngstrom=segment_max_displacement,evaluations=self.evaluations-segment_start)
                segments.append(segment)
                if major_iterations>self.request['maxSteps']:solve_failure('SLSQP exceeded the remaining major-iteration budget','PATH_SCAN_NOT_CONVERGED')
                if not result.success:solve_failure('Scan local-box SLSQP failed: '+str(result.message),'PATH_SCAN_NOT_CONVERGED')
                if not resolved:solve_failure('Scan local-box result did not satisfy the original constraints','PATH_CONSTRAINT_RESIDUAL')
                atoms.set_positions(full(result.x),apply_constraint=False);force=tangent_force(result.x)
                segment['evaluations']=self.evaluations-segment_start
                segment['projectedForceMaxEVPerAngstrom']=float(np.linalg.norm(force,axis=1).max())
                if segment['projectedForceMaxEVPerAngstrom']<=self.request['forceToleranceEVPerAngstrom']:
                    segment['reason']='physical-force-converged';break
                if not boundary or progress<=1e-10:solve_failure('Scan local-box solve stopped without physical force convergence or boundary progress','PATH_SCAN_NOT_CONVERGED')
                segment['reason']='local-bound-limited';anchor=np.asarray(result.x).copy();segment_index+=1
            converged=True
            packet=self.frame(atoms,stage,major_iterations,rows=rows,projected=force,**context,role='point-result',searchConverged=True,
                              segmentIndex=segment_index,cumulativeMajorIterations=major_iterations)
            summary=dict(stageId=stage,**context,searchConverged=converged,energyEV=packet['energyEV'],reason='converged' if converged else 'optimizer-or-force-limit',
                         evaluationsAtPointStart=point_evaluation_start,evaluations=self.evaluations-point_evaluation_start,cumulativeEvaluations=self.evaluations,
                         localBox=local_box,segmentIndex=segment_index,cumulativeMajorIterations=major_iterations,solverSegments=segments)
            self.stages.append(summary); self.stage(stage,'completed',**{k:v for k,v in summary.items() if k!='stageId'})
            require(converged,'Scan point did not meet force convergence','PATH_SCAN_NOT_CONVERGED')
            completed.append(summary); positions=atoms.positions.copy()
        return dict(resultKind='scan',searchConverged=True,stationaryPointValidation='not-run',points=completed)
    def initial_mode(self,mode):
        if mode['kind']=='vector': vector=np.array([[v[k] for k in ('x','y','z')] for v in mode['vectors']]); source=copy.deepcopy(mode)
        else: vector=np.random.RandomState(mode['seed']).normal(size=self.original.shape); source=dict(kind='estimated',algorithm='seeded-gaussian-direction',seed=mode['seed'])
        vector[self.fixed]=0; require(np.isfinite(vector).all() and np.linalg.norm(vector)>1e-10,'Degenerate initial mode')
        return vector/np.linalg.norm(vector),source
    def dimer(self,atoms,mode,source,stage='ts-dimer'):
        mode=np.asarray(mode).copy(); mode[self.fixed]=0
        if self.constraints:
            variables=np.array([3*i+j for i in range(len(atoms)) if i not in self.fixed for j in range(3)])
            jac=self.jacobian(atoms.positions,self.constraints,variables)
            tangent=mode.ravel()[variables]; tangent=tangent-jac.T@np.linalg.lstsq(jac.T,tangent,rcond=None)[0]
            flat=np.zeros(mode.size); flat[variables]=tangent; mode=flat.reshape(-1,3)
        require(np.isfinite(mode).all() and np.linalg.norm(mode)>1e-10,'The initial TS direction is removed by active freezes','PATH_TS_MODE_DEGENERATE')
        mode/=np.linalg.norm(mode)
        self.stage(stage,'started',initialModeSource=source,configuration=dict(algorithm='ase-dimer',aseVersion=ase_version,dimerSeparationAngstrom=.0001,maximumTranslationAngstrom=.1))
        with DimerControl(logfile=None,eigenmode_logfile=None,order=1,dimer_separation=.0001,trial_trans_step=.001,maximum_translation=.1,mask=[i not in self.fixed for i in range(len(atoms))]) as control:
            dimer=MinModeAtoms(atoms,control,eigenmodes=[mode.copy()],random_seed=0)
            with MinModeTranslate(dimer,logfile=None,trajectory=None) as optimizer:
                def accepted():
                    self.check(); projected=dimer.get_forces(); curvature=float(dimer.get_curvature())
                    require(finite(curvature) and np.isfinite(dimer.get_eigenmode()).all(),'Nonfinite dimer direction/curvature','PATH_DIMER_NONFINITE')
                    self.frame(atoms,stage,optimizer.nsteps,projected=projected,curvatureEVPerAngstrom2=curvature,initialModeSource=source)
                optimizer.attach(accepted,interval=1)
                converged=bool(optimizer.run(fmax=self.request['forceToleranceEVPerAngstrom'],steps=self.request['maxSteps']))
                projected=dimer.get_forces(); curvature=float(dimer.get_curvature())
                require(converged and curvature<0 and np.linalg.norm(projected,axis=1).max()<=self.request['forceToleranceEVPerAngstrom'],'Dimer did not reach a negative-curvature force-converged candidate','PATH_TS_NOT_CONVERGED')
                packet=self.frame(atoms,stage,optimizer.nsteps,projected=projected,curvatureEVPerAngstrom2=curvature,initialModeSource=source,role='candidate')
            result=dict(stageId=stage,searchConverged=True,curvatureEVPerAngstrom2=curvature,energyEV=packet['energyEV'],initialModeSource=source)
            self.stages.append(result); self.stage(stage,'completed',**{k:v for k,v in result.items() if k!='stageId'})
            return dict(resultKind='ts-candidate',searchConverged=True,stationaryPointValidation='not-run',curvatureEVPerAngstrom2=curvature)
    def neb(self):
        settings=self.request['neb']; products={a['id']:a for a in settings['product']['atoms']}; mapping={p['reactantAtomId']:p['productAtomId'] for p in settings['mapping']}
        endpoint=np.array([[products[mapping[id]][k] for k in ('x','y','z')] for id in self.ids])
        require(self.feasible(self.original,self.constraints) and self.feasible(endpoint,self.constraints),'Endpoint internal freezes conflict','PATH_CONSTRAINT_CONFLICT')
        physical=not settings['previewOnly']; first=self.atoms(self.original,physical=physical); last=self.atoms(endpoint,physical=physical)
        if settings['preoptimizeEndpoints']:
            for id,atoms in (('reactant-opt',first),('product-opt',last)):
                self.stage(id,'started',sourceRole='endpoint-copy')
                with FIRE(atoms,logfile=None,trajectory=None,maxstep=.1) as opt:
                    opt.attach(lambda a=atoms,s=id,o=opt:self.frame(a,s,o.nsteps),interval=1)
                    converged=bool(opt.run(fmax=self.request['forceToleranceEVPerAngstrom'],steps=self.request['maxSteps']))
                require(converged,'Endpoint preoptimization did not converge','PATH_ENDPOINT_NOT_CONVERGED'); self.stages.append(dict(stageId=id,searchConverged=True)); self.stage(id,'completed',searchConverged=True)
        images=[first]+[self.atoms(first.positions,physical=False) for _ in range(settings['imageCount']-2)]+[last]
        band=NEB(images,k=settings['springConstantEVPerAngstrom2'],method='improvedtangent',climb=False,parallel=False,remove_rotation_and_translation=False)
        self.stage('initial-path','started',configuration=copy.deepcopy(settings))
        sidpp_evidence=None
        if settings['initialPath']=='xtb-bpp':
            values,self.bpp_evidence=bpp_initial_path(self.native_initial_path,first.positions,last.positions,len(images))
            for atoms,pos in zip(images,values): atoms.set_positions(pos)
        elif settings['initialPath']=='sidpp':
            def project(pos):
                holder=self.atoms(self.original,physical=False); holder.set_positions(pos)
                require(self.feasible(holder.positions,self.constraints),'S-IDPP constraint projection failed','PATH_CONSTRAINT_CONFLICT'); return holder.positions.copy()
            def project_force(pos,force):
                holder=self.atoms(pos,physical=False); force=force.copy()
                for constraint in holder.constraints: constraint.adjust_forces(holder,force)
                return force
            values,sidpp_evidence=sequential_idpp(first.positions,last.positions,len(images),check=self.check,project=project,project_force=project_force,max_steps=self.request['maxSteps'],fixed=self.fixed)
            for atoms,pos in zip(images,values): atoms.set_positions(pos)
        else: band.interpolate(method='linear',mic=False,apply_constraint=True)
        if settings['initialPath']=='idpp':
            # IDPP's pair objective is geometric. A bounded optimizer polls the
            # same cancellation/deadline even though no physical E/G is called.
            session=self
            class CheckedFIRE(FIRE):
                def step(self,*args,**kwargs): session.check(); return super().step(*args,**kwargs)
            idpp_interpolate(band,traj=None,log=None,optimizer=CheckedFIRE,steps=self.request['maxSteps'],fmax=.1,mic=False)
        for i,atoms in enumerate(images): self.frame(atoms,'initial-path',0,role='initial-path',imageIndex=i)
        self.stage('initial-path','completed',initialPathMethod=settings['initialPath'],physicalEvaluations=None if self.bpp_evidence else 0,previewOnly=settings['previewOnly'],**({'sidpp':sidpp_evidence} if sidpp_evidence else {}),**({'nativeInitialPath':self.bpp_evidence} if self.bpp_evidence else {}))
        if settings['previewOnly']: return dict(resultKind='initial-path',searchConverged=False,stationaryPointValidation='not-run')
        for atoms in images[1:-1]: atoms.calc=BudgetCalculator(self,self.factory(self.request))
        for stage,climb,tolerance in (('neb',False,settings['warmupForceToleranceEVPerAngstrom']),('climbing-neb',True,self.request['forceToleranceEVPerAngstrom'])):
            band.climb=climb; self.stage(stage,'started',configuration=dict(climb=climb,forceToleranceEVPerAngstrom=tolerance,method='improvedtangent'))
            with FIRE(band,logfile=None,trajectory=None,maxstep=.1) as opt:
                def accepted():
                    self.check(); forces=band.get_forces().reshape(-1,len(first),3)
                    for i,atoms in enumerate(images): self.frame(atoms,stage,opt.nsteps,imageIndex=i,projected=np.zeros_like(first.positions) if i in (0,len(images)-1) else forces[i-1])
                opt.attach(accepted,interval=1)
                converged=bool(opt.run(fmax=tolerance,steps=self.request['maxSteps']))
            require(converged,'NEB stage did not meet projected-force convergence','PATH_NEB_NOT_CONVERGED')
            result=dict(stageId=stage,searchConverged=True,highestEnergyImageIndex=int(band.imax),climbingImageIndex=int(band.imax) if climb else None)
            self.stages.append(result); self.stage(stage,'completed',**{k:v for k,v in result.items() if k!='stageId'})
        image=int(band.imax); mode=images[image+1].positions-images[image-1].positions; mode[self.fixed]=0
        require(np.linalg.norm(mode)>1e-10,'Degenerate climbing-image tangent','PATH_TS_MODE_DEGENERATE')
        # Separate Atoms/calculator: the band's image is never mutated by TS.
        candidate=self.atoms(images[image].positions)
        return self.dimer(candidate,mode/np.linalg.norm(mode),dict(kind='neb-tangent',stageId='climbing-neb',imageIndex=image),'neb-ts-dimer')
    def run(self):
        self.stage('configuration','started',configuration=copy.deepcopy(self.request),constraintTolerances=CONSTRAINT_TOLERANCES)
        if self.request['operation']=='scan': result=self.scan()
        elif self.request['operation']=='ts':
            mode,source=self.initial_mode(self.request['ts']['initialMode']); result=self.dimer(self.atoms(self.original),mode,source)
        else: result=self.neb()
        preview=result['resultKind']=='initial-path'
        return dict(kind='completed',workerSettled=True,**result,stages=self.stages,lastFrame=self.last_frame,evaluations=self.evaluations,elapsedSeconds=self.clock()-self.started,**({'nativeInitialPath':self.bpp_evidence} if self.bpp_evidence else {}),
                    backend=dict(driver='ASE',aseVersion=ase_version,calculator='none' if preview else 'tblite',method=self.request['method'],physicalCalculatorCreated=not preview))


def main():
    payload=None; session=None; seq=0; output_bytes=0; cancelled=threading.Event(); control_error=[]
    control_done=threading.Event(); control_thread=None
    def emit(packet):
        nonlocal seq,output_bytes
        request=payload['request']; value=dict(schema=1,sessionId=payload['sessionId'],stamp=request['stamp'],runIdentity=request['runIdentity'],operation=request['operation'],method=request['method'],seq=seq,**packet)
        json.dump(value,sys.stdout,ensure_ascii=True,allow_nan=False,separators=(',',':'))
        seq+=1;sys.stdout.write('\n');sys.stdout.flush()
    try:
        incoming=b''; descriptor=sys.stdin.fileno()
        while b'\n' not in incoming:
            chunk=os.read(descriptor,65536); require(bool(chunk),'Truncated path request'); incoming+=chunk
        line,pending=incoming.split(b'\n',1)
        payload=json.loads(line.decode('utf-8'),parse_constant=lambda _:(_ for _ in ()).throw(PathError('PATH_INVALID','Nonfinite JSON')))
        require(isinstance(payload,dict) and {'schema','sessionId','request'}<=set(payload)<={'schema','sessionId','request','initialPath','elapsedBeforeSeconds'} and payload['schema']==1 and identity(payload['sessionId']),'Invalid worker envelope')
        payload['request']=validate_request(payload['request'])
        require(('initialPath' in payload)==(payload['request'].get('neb',{}).get('initialPath')=='xtb-bpp'),'Trusted initial path belongs only to BPP')
        def consume(data):
            require(len(data)<=65536,'Control input exceeded limit')
            while b'\n' in data:
                raw,data=data.split(b'\n',1); control=json.loads(raw)
                require(isinstance(control,dict) and set(control)=={'schema','sessionId','runIdentity','command'} and control['schema']==1 and control['sessionId']==payload['sessionId'] and control['runIdentity']==payload['request']['runIdentity'] and control['command']=='stop','Invalid path control identity')
                cancelled.set()
            return data
        pending=consume(pending)
        if cancelled.is_set(): raise Cancelled('PATH_CANCELLED','Cancelled before calculator initialization')
        def reader():
            nonlocal pending
            try:
                for block in control_blocks(descriptor,control_done):
                    if not block: cancelled.set(); return
                    pending=consume(pending+block)
                    if cancelled.is_set():return
            except Exception as error: control_error.append(error); cancelled.set()
        control_thread=threading.Thread(target=reader,daemon=True);control_thread.start()
        session=Session(payload['request'],emit,cancelled=cancelled,initial_path=payload.get('initialPath'),elapsed_before=payload.get('elapsedBeforeSeconds',0))
        emit(session.run()); return 0
    except Exception as error:
        if control_error: error=control_error[0]
        if isinstance(payload,dict) and isinstance(payload.get('request'),dict) and all(k in payload['request'] for k in ('stamp','runIdentity','operation','method')):
            packet=dict(kind='stopped' if isinstance(error,Cancelled) else 'error',workerSettled=True,lastFrame=getattr(session,'last_frame',None),stages=getattr(session,'stages',[]),
                        evaluations=getattr(session,'evaluations',0),elapsedSeconds=0. if session is None else session.clock()-session.started)
            if isinstance(error,Cancelled): packet['reason']='cancelled'
            else:
                packet['error']=dict(code=getattr(error,'code','PATH_NATIVE_FAILED'),message=str(error)[:8192])
                if getattr(error,'diagnostic',None) is not None: packet['error']['diagnostic']=error.diagnostic
            try: emit(packet)
            except Exception: sys.stderr.write('Advanced path worker could not emit a bounded terminal packet\n')
        else: sys.stderr.write('Advanced path request rejected before source identity was established\n')
        return 0 if isinstance(error,Cancelled) else 1
    finally:
        control_done.set()
        if control_thread is not None:control_thread.join(timeout=.2)


if __name__=='__main__': raise SystemExit(main())
