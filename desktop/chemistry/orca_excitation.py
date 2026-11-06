"""Content-checked ORCA excitation adapters; no native or upstream execution.

Only restricted references, explicit spin identity and verified amplitude layouts
are admitted. Original JSON/CIS files are immutable; all adapters are job-owned.
"""
from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import numpy as np
from orbitals import OrbitalError
from wavefunction_analysis import SYMBOLS

NUMBER=r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][+-]?\d+)?'
STATE=re.compile(r'^\s*STATE\s+(\d+):\s*E=\s*('+NUMBER+r')\s+au\s+('+NUMBER+r')\s+eV',re.I)
WEIGHT=re.compile(r'^\s*(\d+)([ab])\s*->\s*(\d+)([ab])\s*:\s*('+NUMBER+r')(?:.*?\bc\s*=\s*('+NUMBER+r'))?',re.I)
BOHR_ANGSTROM=.529177210903
MAX_COMPANION_BYTES=512*1024**2

def number(token):return float(str(token).replace('D','E').replace('d','e'))
def rounding(token):
    parts=str(token).lower().replace('d','e').split('e');mant=parts[0]
    return .5*10**((int(parts[1]) if len(parts)>1 else 0)-(len(mant.split('.')[1]) if '.' in mant else 0))
def sha_file(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()
def companion_snapshot(spec,path=None):
    if not spec and not path:return None
    spec=spec or {};source=Path(spec.get('path') or path).resolve();stat=source.stat()
    if not source.is_file():raise OrbitalError('orca-companion','ORCA companion is absent.')
    revision=sha_file(source)
    if spec.get('revision') is not None and revision!=spec['revision']:raise OrbitalError('source-changed','ORCA companion revision changed.')
    return dict(path=source,name=spec.get('name',source.name),revision=revision,bytes=stat.st_size,mtimeNs=stat.st_mtime_ns)
def verify_companion(snapshot):
    if snapshot:
        stat=snapshot['path'].stat()
        if stat.st_size!=snapshot['bytes'] or stat.st_mtime_ns!=snapshot['mtimeNs']:raise OrbitalError('source-changed','Immutable ORCA companion changed after open.')
def budget_companions(json_source,cis_source,metadata,memory_budget,retained_bytes=0):
    raw=sum(source['bytes'] for source in (json_source,cis_source) if source)
    scratch=metadata['sourceBytes']*5+metadata['basisCount']**2*64+64*1024**2
    required=raw*12+scratch+retained_bytes
    if type(memory_budget) is not int or memory_budget<=0:raise OrbitalError('orca-memory','A current positive memory grant is required.')
    return required

def parse_orca_output(text):
    lines=text.splitlines();states=[];batch=0;job=0;section_mult=None;seen=set();last={};section_start=None;version=None
    for i,line in enumerate(lines):
        version_match=re.search(r'Program Version\s+([\d.]+)',line,re.I)
        if version_match:version=version_match[1]
        job_header=re.search(r'\b(?:JOB NUMBER|COMPOUND JOB)\s+(\d+)\b',line,re.I)
        if job_header:
            new_job=int(job_header[1])-1
            if states and new_job!=job:batch+=1;seen.clear();last.clear()
            job=new_job
        header=re.search(r'(?:TD-DFT|TDA|CIS).*EXCITED STATES\s*\((SINGLETS|TRIPLETS)\)',line,re.I)
        if header:
            section_mult=1 if header[1].upper()=='SINGLETS' else 3
            if section_mult in seen:batch+=1;seen.clear();last.clear()
            seen.add(section_mult);section_start=i+1
        match=STATE.match(line)
        if not match:continue
        mult_match=re.search(r'\bMult\s+(\d+)\b',line);mult=int(mult_match[1]) if mult_match else section_mult
        if mult_match and section_mult is not None and mult!=section_mult:raise OrbitalError('orca-spin','Printed ORCA state multiplicity conflicts with its excitation section.')
        index=int(match[1])
        if mult in last and index<=last[mult]:batch+=1;last.clear();seen={mult}
        last[mult]=index;j=i+1;weights=[]
        while j<len(lines):
            weight=WEIGHT.match(lines[j])
            if weight:
                a,sa,b,sb,w,c=weight.groups();weights.append(dict(fromIndex=int(a),toIndex=int(b),fromSpin=sa.lower(),toSpin=sb.lower(),weight=number(w),weightToken=w,amplitude=number(c) if c is not None else None,amplitudeToken=c,sourceLine=j+1));j+=1
            elif not lines[j].strip():
                # A blank line terminates a printed configuration block, unlike
                # a later normal/error termination marker for the whole job.
                if weights:break
                j+=1
            else:break
        raw='\n'.join(lines[i:j]);rows=[]
        for w in weights:
            if w['amplitude'] is not None:
                rows.append(dict(fromIndex=w['fromIndex']+1,toIndex=w['toIndex']+1,spin='restricted',direction='->',amplitude=w['amplitude']/math.sqrt(2),sourceLine=w['sourceLine']))
        x=sum(r['amplitude']**2 for r in rows)
        state=dict(index=index,label='ORCA printed state',energyEv=number(match[3]),energyToken=match[3],energyHartree=number(match[2]),energyHartreeToken=match[2],sourceLine=i+1,jobIndex=job,batch=batch,sectionSourceLine=section_start,coefficients=rows,weights=weights,coefficientCount=len(rows),blockRevision=hashlib.sha256(raw.encode('utf-8')).hexdigest(),excitationSquared=x,deexcitationSquared=0.,netSquared=x,terminated=j<len(lines),engine='orca',sourceVersion=version)
        if mult is not None:state['multiplicity']=mult
        states.append(state)
    if not states:raise OrbitalError('orca-source','ORCA output contains no complete printed excitation header.')
    return states,[state for state in states if state['batch']==states[-1]['batch'] and state['jobIndex']==job]

def excitation_mode(text):
    if re.search(r'\bMode\s+sTD(?:A|DFT)\b',text,re.I):return 'unsupported-simplified'
    values=re.findall(r'Tamm-Dancoff approximation\s*\.\.\.\s*(\S+)',text,re.I)
    if values:
        value=values[-1].lower()
        if value in ('deactivated','false','off'):return 'rpa'
        if value in ('activated','true','on','operative'):return 'tda'
    return 'unknown'

def validate_orca_wavefunction(text,block,metadata,wavefunction_text,reference_json=None,source_blocks=None):
    if metadata.get('format')!='molden':raise OrbitalError('orca-wavefunction','ORCA excitation analysis requires the corresponding Molden orbital source.')
    if not metadata['orbitals'] or any(o['spin']!='restricted' or o['occupation'] not in (0,2) for o in metadata['orbitals']):raise OrbitalError('orca-reference','This ORCA amplitude adapter supports a proven restricted closed-shell reference only.')
    prefix='\n'.join(text.splitlines()[:block['sourceLine']]);basis=re.findall(r'Number of basis functions\s*\.{2,}\s*(\d+)',prefix,re.I)
    if not basis or int(basis[-1])!=metadata['basisCount']:raise OrbitalError('orca-basis','ORCA output and Molden basis dimensions disagree.')
    electron_lines=re.findall(r'^[^\n]*Number of Electrons\s+NEL[^\n]*$',prefix,re.I|re.M)
    expected_electrons=sum(o['occupation'] for o in metadata['orbitals'])
    electron_evidence=None
    if electron_lines:
        printed=re.search(r'Number of Electrons\s+NEL\s*\.{2,}\s*(\d+)\s*$',electron_lines[-1],re.I)
        if not printed:raise OrbitalError('orca-electrons-malformed','The explicit ORCA NEL electron count is malformed; companion data cannot replace it.')
        if int(printed[1])!=expected_electrons:raise OrbitalError('orca-electrons','Explicit ORCA NEL and Molden electron populations disagree; companion data cannot override the conflict.')
        electron_evidence=dict(source='output-nel',electronCount=int(printed[1]))
    orbital_sections=prefix.split('ORBITAL ENERGIES')
    checked_orbitals=0
    if len(orbital_sections)>1:
        table=orbital_sections[-1];header=re.search(r'NO\s+OCC\s+E\(Eh\).*?\n',table)
        if header:
            rows=[]
            for line in table[header.end():].splitlines():
                match=re.match(r'^\s*(\d+)\s+('+NUMBER+r')\s+('+NUMBER+r')\s+('+NUMBER+r')\s*$',line)
                if match:rows.append(match.groups())
                elif rows:break
                elif line.strip():break
            if rows:
                # ORCA normally prints only its first few virtual orbitals.  Verify
                # every printed row, but do not claim evidence for omitted MOs.
                if len(rows)>len(metadata['orbitals']) or [int(row[0]) for row in rows]!=list(range(len(rows))):raise OrbitalError('orca-orbitals','Printed ORCA MO indices do not match the paired Molden channel.')
                for row,orbital in zip(rows,metadata['orbitals']):
                    if abs(number(row[1])-orbital['occupation'])>rounding(row[1])+1e-10 or abs(number(row[2])-orbital['energyHartree'])>rounding(row[2])+1e-10:raise OrbitalError('orca-orbitals','Printed ORCA MO occupations or energies disagree with the paired Molden source.')
                checked_orbitals=len(rows)
    geometries=list(re.finditer(r'CARTESIAN COORDINATES\s*\(ANGSTROEM\)\s*\n\s*-+\s*\n((?:\s*[A-Z][a-z]?\s+'+NUMBER+r'\s+'+NUMBER+r'\s+'+NUMBER+r'\s*\n)+)',prefix))
    if not geometries:raise OrbitalError('orca-geometry','No complete ORCA Cartesian geometry precedes the selected state.')
    rows=[row.split() for row in geometries[-1][1].splitlines() if row.strip()]
    if len(rows)!=len(metadata['atoms']) or any(row[0]!=SYMBOLS[atom['atomicNumber']] for row,atom in zip(rows,metadata['atoms'])):raise OrbitalError('orca-atoms','ORCA/Molden atom identities or order disagree.')
    target=np.array([[number(t) for t in row[1:4]] for row in rows]);moving=np.array([a['positionBohr'] for a in metadata['atoms']])*BOHR_ANGSTROM
    out_precision=max(rounding(t) for row in rows for t in row[1:4]);tol=2*math.sqrt(3)*(out_precision+1e-8)+1e-11
    a=moving-moving.mean(axis=0);b=target-target.mean(axis=0);u,_,vt=np.linalg.svd(a.T@b);rotation=u@np.diag([1.,1.,np.linalg.det(u@vt)])@vt
    residual=float(np.max(np.linalg.norm(a@rotation-b,axis=1)))
    if residual>tol:raise OrbitalError('orca-geometry','ORCA state geometry does not match the paired Molden within printed coordinate precision.')
    if electron_evidence is None:
        if reference_json is None or not source_blocks:
            raise OrbitalError('orca-electrons-missing','ORCA output does not print NEL; a matched JSON reference with exact nuclear charges, charge, spin and state evidence is required.')
        entries,reference=load_json_amplitudes(reference_json,source_blocks,metadata,tol,include_reference=True)
        ordinal=next((i+1 for i,b in enumerate(source_blocks) if b['sourceLine']==block['sourceLine']),None)
        if ordinal not in entries:raise OrbitalError('orca-json-state','JSON does not identify the selected source state; no missing-NEL reference was inferred.')
        # Molden does not itself establish effective core charges. Missing NEL
        # may only use a complete physical all-electron reference, never infer
        # an ECP/valence convention from element names or an orbital window.
        if reference['nuclearCharges']!=reference['atomicNumbers'] or reference['charge']!=int(reference['charge']):
            raise OrbitalError('orca-electrons-reference','Missing NEL requires explicit all-electron nuclear charges and an integer physical charge; no effective-core reference was inferred.')
        source_charges=re.findall(r'Total Charge\s+Charge\s*\.{2,}\s*('+NUMBER+r')',prefix,re.I)
        source_spins=re.findall(r'Multiplicity\s+Mult\s*\.{2,}\s*(\d+)',prefix,re.I)
        input_references=re.findall(r'\*\s+xyz(?:file)?\s+(-?\d+)\s+(\d+)\b',prefix,re.I)
        if (source_charges and number(source_charges[-1])!=reference['charge'] or source_spins and int(source_spins[-1])!=reference['multiplicity']
                or input_references and (int(input_references[-1][0])!=reference['charge'] or int(input_references[-1][1])!=reference['multiplicity'])):
            raise OrbitalError('orca-electrons-reference','Explicit output/input charge or multiplicity conflicts with the matched JSON reference.')
        electron_evidence=dict(source='matched-json-reference',electronCount=reference['electronCount'],charge=reference['charge'],multiplicity=reference['multiplicity'],reference='all-electron',jsonRevision=reference_json['revision'])
    return dict(maxResidualAngstrom=residual,coordinateToleranceAngstrom=tol,printedOrbitalsChecked=checked_orbitals,electronCountEvidence=electron_evidence)

def _array(value,shape,label):
    try:array=np.asarray(value,dtype=np.float64)
    except (ValueError,TypeError):raise OrbitalError('orca-amplitudes',label+' is not a numeric amplitude array.')
    if array.size!=math.prod(shape) or array.ndim not in (1,2) or not np.isfinite(array).all():raise OrbitalError('orca-amplitudes',label+' has wrong dimensions or non-finite amplitudes.')
    if array.ndim==2 and tuple(array.shape)!=tuple(shape):raise OrbitalError('orca-amplitudes',label+' matrix axes disagree with OrbWin.')
    return array.reshape(shape)
def _window(value,metadata):
    if not isinstance(value,list) or len(value)!=4 or any(isinstance(n,bool) or not isinstance(n,int) for n in value):raise OrbitalError('orca-window','Restricted ORCA OrbWin must contain four explicit zero-based integer bounds.')
    ol,ou,vl,vu=value;nmo=len(metadata['orbitals'])
    if not 0<=ol<=ou<vl<=vu<nmo:raise OrbitalError('orca-window','ORCA orbital window is outside the corresponding Molden orbital space.')
    if any(metadata['orbitals'][i]['occupation']!=2 for i in range(ol,ou+1)) or any(metadata['orbitals'][i]['occupation']!=0 for i in range(vl,vu+1)):raise OrbitalError('orca-window','ORCA occupied/virtual window conflicts with Molden occupations.')
    return (ou-ol+1,vu-vl+1)

def _printed_weights(block,plus,minus,window,required=False):
    ol,ou,vl,vu=window;errors=[]
    for row in block['weights']:
        o=row['fromIndex']-ol;v=row['toIndex']-vl
        if row['fromSpin']!='a' or row['toSpin']!='a' or not 0<=o<=ou-ol or not 0<=v<=vu-vl:raise OrbitalError('orca-weight','Printed ORCA transition is outside its restricted orbital window.')
        error=abs(float(plus[o,v]*minus[o,v])-row['weight']);errors.append(error)
        if error>rounding(row['weightToken'])+1e-11:raise OrbitalError('orca-weight','ORCA amplitudes disagree with a printed excitation weight.')
    if required and not errors:raise OrbitalError('orca-weight','CIS recovery requires printed transition weights for independent source correspondence.')
    return len(errors),max(errors,default=0.)

def _validate_json_molecule(molecule,metadata,tolerance):
    atoms=molecule.get('Atoms');units=molecule.get('CoordinateUnits')
    if not isinstance(atoms,list) or len(atoms)!=len(metadata['atoms']):raise OrbitalError('orca-json-geometry','ORCA JSON atom count differs from Molden.')
    if units in ('Angs','Angstrom','Angstroem'):factor=1.
    elif units in ('Bohr','Bohrs','AU','a.u.'):factor=BOHR_ANGSTROM
    else:raise OrbitalError('orca-json-geometry','ORCA JSON coordinate units are not explicit/supported.')
    try:
        if any(type(a['ElementNumber']) is not int or a['ElementNumber']!=b['atomicNumber'] for a,b in zip(atoms,metadata['atoms'])):raise ValueError()
        coords=np.array([a['Coords'] for a in atoms],dtype=np.float64)*factor
    except (KeyError,ValueError,TypeError):raise OrbitalError('orca-json-geometry','ORCA JSON atom identities/order or coordinates are invalid.')
    if coords.shape!=(len(atoms),3) or not np.isfinite(coords).all():raise OrbitalError('orca-json-geometry','ORCA JSON coordinates are incomplete/non-finite.')
    source=np.array([a['positionBohr'] for a in metadata['atoms']])*BOHR_ANGSTROM
    a=source-source.mean(axis=0);b=coords-coords.mean(axis=0);u,_,vt=np.linalg.svd(a.T@b);rotation=u@np.diag([1.,1.,np.linalg.det(u@vt)])@vt
    if np.max(np.linalg.norm(a@rotation-b,axis=1))>tolerance:raise OrbitalError('orca-json-geometry','ORCA JSON geometry does not correspond to the paired Molden source.')
    if molecule.get('HFTyp') not in ('RHF','RKS') or type(molecule.get('Multiplicity')) is not int or molecule['Multiplicity']!=1:raise OrbitalError('orca-json-reference','ORCA JSON does not establish a restricted closed-shell reference.')
    charge=molecule.get('Charge')
    if isinstance(charge,bool) or not isinstance(charge,(int,float)) or not math.isfinite(charge):raise OrbitalError('orca-json-reference','ORCA JSON charge is not a finite physical value.')
    try:
        nuclear=[a['NuclearCharge'] for a in atoms]
        if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<0 for v in nuclear):raise ValueError()
        electrons=sum(nuclear)-charge
    except (KeyError,TypeError,ValueError):raise OrbitalError('orca-json-reference','ORCA JSON does not provide finite nuclear charges needed to check its reference electron count.')
    if electrons!=sum(o['occupation'] for o in metadata['orbitals']):raise OrbitalError('orca-json-reference','ORCA JSON charge/electron count differs from Molden.')
    # CIS-only orca_2json configuration does not include MOs/Basis. Validate the
    # optional table if actually present, without fabricating missing metadata.
    orbitals=molecule.get('MolecularOrbitals')
    if orbitals is not None:
        if orbitals.get('EnergyUnit') not in ('Hartree','Eh','a.u.'):raise OrbitalError('orca-json-orbitals','ORCA JSON MO energy unit is not supported.')
        mos=orbitals.get('MOs')
        if not isinstance(mos,list) or len(mos)!=len(metadata['orbitals']):raise OrbitalError('orca-json-orbitals','ORCA JSON MO dimensions differ from Molden.')
        for a,b in zip(mos,metadata['orbitals']):
            occupation=a.get('Occupancy');energy=a.get('OrbitalEnergy');coeff=a.get('MOCoefficients',[])
            if any(isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) for value in (occupation,energy)) or len(coeff)!=metadata['basisCount'] or not np.isfinite(np.asarray(coeff,dtype=float)).all() or abs(occupation-b['occupation'])>1e-10 or abs(energy-b['energyHartree'])>1e-7:raise OrbitalError('orca-json-orbitals','ORCA JSON orbital dimensions, occupations or energies disagree with Molden.')
    return dict(electronCount=electrons,charge=charge,multiplicity=molecule['Multiplicity'],nuclearCharges=nuclear,atomicNumbers=[a['ElementNumber'] for a in atoms])

def load_json_amplitudes(snapshot,blocks,metadata,geometry_tolerance,include_reference=False):
    verify_companion(snapshot)
    try:
        with snapshot['path'].open(encoding='utf-8-sig') as stream:
            data=json.load(stream,parse_constant=lambda token:(_ for _ in ()).throw(ValueError(token)))
        molecule=data['Molecule'];entries=molecule['TD-DFT']
    except (ValueError,KeyError,TypeError):raise OrbitalError('orca-json','ORCA JSON lacks a valid Molecule/TD-DFT amplitude dataset.')
    reference=_validate_json_molecule(molecule,metadata,geometry_tolerance)
    if not isinstance(entries,list) or not entries:raise OrbitalError('orca-json','ORCA JSON contains no amplitude roots.')
    result={}
    for entry in entries:
        root=entry.get('IRoot')
        if isinstance(root,bool) or not isinstance(root,int) or not 1<=root<=len(blocks) or root in result:raise OrbitalError('orca-json-state','ORCA JSON IRoot does not uniquely identify a printed root ordinal.')
        block=blocks[root-1];energy=entry.get('Energy')
        if isinstance(energy,bool) or not isinstance(energy,(int,float)) or not math.isfinite(energy) or abs(energy-block['energyHartree'])>rounding(block['energyHartreeToken'])+1e-12:raise OrbitalError('orca-json-state','ORCA JSON root energy disagrees with the printed source state.')
        window=entry.get('OrbWin');shape=_window(window,metadata)
        plus=_array(entry.get('X+Y'),shape,'X+Y');minus=_array(entry.get('X-Y'),shape,'X-Y')
        result[root]=dict(root=root,window=window,plus=plus,minus=minus,energy=energy,version=data.get('ORCA Header',{}).get('Version'))
    verify_companion(snapshot)
    return (result,reference) if include_reference else result

def read_cis_records(snapshot,blocks,metadata):
    """Read only the verified restricted 36B + (40B + dim*8) record layout."""
    verify_companion(snapshot);path=snapshot['path']
    with path.open('rb') as stream:
        raw=stream.read(36)
        if len(raw)!=36:raise OrbitalError('orca-cis','ORCA CIS header is truncated.')
        count,*window=struct.unpack('<9i',raw)
        if count!=2*len(blocks) or window[4:]!=[-1,-1,-1,-1]:raise OrbitalError('orca-cis','CIS root count or spin-channel layout is not the supported restricted full-RPA layout.')
        shape=_window(window[:4],metadata);dimension=math.prod(shape);stride=40+8*dimension
        if 36+count*stride!=snapshot['bytes']:raise OrbitalError('orca-cis','CIS dimensions do not exactly consume the source file; layout is unsupported or truncated.')
        headers=[]
        for i in range(count):
            stream.seek(36+i*stride);header=stream.read(40);ints=struct.unpack('<6i',header[:24]);energy=struct.unpack('<d',header[24:32])[0]
            if ints[0]!=dimension or not math.isfinite(energy):raise OrbitalError('orca-cis','CIS record dimensions/energy are invalid.')
            headers.append(dict(ints=ints,energy=energy))
        def close_energy(value,block):return abs(value-block['energyHartree'])<=rounding(block['energyHartreeToken'])+1e-12
        pair_energy=all(close_energy(h['energy'],blocks[i//2]) for i,h in enumerate(headers))
        prefix_energy=all(close_energy(h['energy'],blocks[i if i<len(blocks) else i//2]) for i,h in enumerate(headers))
        if not pair_energy and (not prefix_energy or any(b.get('sourceVersion')!='6.1.0' for b in blocks)):raise OrbitalError('orca-cis-energy','CIS header energies match neither paired nor the verified ORCA 6.1.0 prefix-energy-table layout.')
        records={}
        for ordinal,block in enumerate(blocks):
            pair=headers[2*ordinal:2*ordinal+2];mult=block.get('multiplicity')
            if mult not in (1,3) or any(h['ints'][2]!=mult for h in pair):raise OrbitalError('orca-cis-spin','CIS spin metadata conflicts with the printed ORCA state.')
            root_correct=all(h['ints'][4]==block['index']-1 for h in pair)
            stale_triplet=block.get('sourceVersion')=='6.1.0' and mult==3 and all(h['ints'][4]==max(b['index'] for b in blocks if b.get('multiplicity')==3)-1 for h in pair)
            if not root_correct and not stale_triplet:raise OrbitalError('orca-cis-state','CIS root metadata does not match a verified source layout.')
            arrays=[]
            for index in (2*ordinal,2*ordinal+1):
                stream.seek(36+index*stride+40);values=np.fromfile(stream,dtype='<f8',count=dimension)
                if len(values)!=dimension or not np.isfinite(values).all():raise OrbitalError('orca-cis','CIS amplitude record is incomplete/non-finite.')
                arrays.append(values.reshape(shape))
            plus,minus=arrays;norm=float(np.sum(plus*minus))
            if abs(norm-1)>1e-8:raise OrbitalError('orca-cis-norm','CIS full-RPA amplitude norm differs from 1; no normalization was applied.')
            checked,error=_printed_weights(block,plus,minus,window[:4],required=True)
            records[ordinal+1]=dict(root=ordinal+1,window=window[:4],plus=plus,minus=minus,rpaNorm=norm,rootMetadataVerified=root_correct,printedWeightsChecked=checked,maximumPrintedWeightDifference=error,layout='paired-energy' if pair_energy else 'prefix-state-energy-table')
    verify_companion(snapshot)
    return records

def _verified_json_against_cis(entry,native):
    if entry['window']!=native['window']:raise OrbitalError('orca-json-cis','JSON and CIS orbital windows disagree.')
    a,b=native['plus'],native['minus'];ja,jb=entry['plus'],entry['minus'];actions=[]
    if np.array_equal(ja,a):actions.append('X+Y exact native CIS')
    elif np.array_equal(ja,np.where(abs(a)<1e-12,0.,a)):actions.append('X+Y exact known <1e-12 zero-mask; full native CIS retained')
    else:raise OrbitalError('orca-json-conflict','JSON X+Y conflicts with native CIS outside the verified exact export signatures.')
    if np.array_equal(jb,b):actions.append('X-Y exact native CIS')
    elif np.array_equal(jb,a):actions.append('X-Y exact duplicated X+Y; full native CIS X-Y restored')
    elif np.array_equal(jb,np.where(abs(b)<1e-12,0.,a)):actions.append('X-Y exact duplicated X+Y with native-X-Y zero-mask; full native CIS X-Y restored')
    else:raise OrbitalError('orca-json-conflict','JSON X-Y conflicts with native CIS outside the verified exact export signatures.')
    changed=not(np.array_equal(ja,a) and np.array_equal(jb,b))
    if changed and entry.get('version')!='6.1.0':raise OrbitalError('orca-json-conflict','This exact recovery signature has not been verified for the reported ORCA exporter version.')
    return '; '.join(actions),changed

def prepare_rpa(json_source,cis_source,blocks,selected,metadata,geometry_tolerance):
    entries=load_json_amplitudes(json_source,blocks,metadata,geometry_tolerance) if json_source else {}
    native=read_cis_records(cis_source,blocks,metadata) if cis_source else {}
    ordinal=next(i+1 for i,b in enumerate(blocks) if b['sourceLine']==selected['sourceLine'])
    if json_source and ordinal not in entries:raise OrbitalError('orca-json-state','ORCA JSON has no amplitudes for the selected printed state.')
    recovered=False;actions={}
    if json_source and cis_source:
        # Recovery is only permitted when every JSON root has exact original-CIS
        # correspondence and every original CIS root passed independent checks.
        for root,entry in entries.items():
            actions[root],changed=_verified_json_against_cis(entry,native[root]);recovered=recovered or changed
        if recovered and len(entries)!=len(blocks):raise OrbitalError('orca-json-conflict','Known JSON recovery requires complete all-root JSON/CIS correspondence.')
    if cis_source:
        chosen=native[ordinal]
        if not chosen['rootMetadataVerified'] and not json_source:raise OrbitalError('orca-cis-state','This CIS root has stale exported root metadata; matching JSON is required to establish its exact source identity.')
        plus,minus=chosen['plus'],chosen['minus'];window=chosen['window'];route='cis-verified-json-recovery' if recovered else 'json-rpa' if json_source else 'cis-rpa'
    elif json_source:
        chosen=entries[ordinal];plus,minus=chosen['plus'],chosen['minus'];window=chosen['window'];route='json-rpa'
    else:raise OrbitalError('orca-amplitudes-missing','Full ORCA TDDFT requires real X/Y amplitudes from same-job JSON or CIS; printed combined weights are insufficient.')
    norm=float(np.sum(plus*minus))
    if abs(norm-1)>1e-8:raise OrbitalError('orca-json-norm','ORCA JSON full-RPA norm is inconsistent; matching original CIS is needed, and no Y amplitudes were guessed.')
    checked,error=_printed_weights(selected,plus,minus,window,required=bool(cis_source))
    x=(plus+minus)/2;y=(plus-minus)/2
    proof=dict(route=route,sourceStateIndex=selected['index'],multiplicity=selected['multiplicity'],sourceLine=selected['sourceLine'],orbitalWindow=window,jsonRoot=ordinal,rpaNorm=norm,xSquared=float(np.sum(x*x)),ySquared=float(np.sum(y*y)),convention='orca-norm-1; closed-shell-amplitudes/sqrt(2); source-MO+1',printedWeightsChecked=checked,maximumPrintedWeightDifference=error)
    if json_source:proof['jsonRevision']=json_source['revision']
    if cis_source:proof['cisRevision']=cis_source['revision']
    if ordinal in actions:proof['jsonAction']=actions[ordinal]
    return x,y,proof

def write_selected_adapter(work,selected,x,y,proof,threshold):
    """Keep complete amplitudes and apply only the actual native loader threshold."""
    if not math.isfinite(threshold) or threshold<0:raise OrbitalError('orca-threshold','Actual native ORCAloadcoeff must be a finite nonnegative number.')
    work=Path(work);window=proof['orbitalWindow'];np.savez(work/'orca-full-amplitudes.npz',x=x,y=y,orbitalWindow=np.array(window,dtype=np.int64))
    rows=[];lines=[f"Excited State 1 {selected['multiplicity']} {selected['energyEv']:.17g}"]
    for direction,array in [('->',x),('<-',y)]:
        for i,j in np.argwhere(abs(array)>threshold):
            coefficient=float(array[i,j])/math.sqrt(2);left=int(i)+window[0]+1;right=int(j)+window[2]+1
            lines.append(f'{left} {direction} {right} {coefficient:.17g}')
            rows.append(dict(fromIndex=left,toIndex=right,spin='restricted',direction=direction,amplitude=coefficient,sourceLine=selected['sourceLine']))
    if not rows:raise OrbitalError('orca-threshold','The actual native ORCA coefficient threshold retains no amplitudes for this state.')
    path=work/'excitation.txt';path.write_text('\n'.join(lines)+'\n\n',encoding='ascii');revision=sha_file(path)
    effective_x=float(np.sum(x[abs(x)>threshold]**2));effective_y=float(np.sum(y[abs(y)>threshold]**2))
    proof.update(adapterRevision=revision,nativeAdapterStateIndex=1,nativeCoefficientThreshold=threshold,fullCoefficientCount=int(np.count_nonzero(x)+np.count_nonzero(y)),effectiveCoefficientCount=len(rows),effectiveXSquared=effective_x,effectiveYSquared=effective_y)
    block=dict(selected,index=1,coefficients=rows,coefficientCount=len(rows),blockRevision=revision,excitationSquared=effective_x/2,deexcitationSquared=effective_y/2,netSquared=(effective_x-effective_y)/2)
    return path,block
