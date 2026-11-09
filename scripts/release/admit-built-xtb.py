"""Admit one explicit, independently built v2 xTB tree in a source copy.

Plan by default. No xTB, compiler, scientific library, installer or download runs.
Only Node's source-side metadata contract is invoked; admission is not acceptance.
"""
from pathlib import Path,PurePosixPath
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
sys.path.insert(0,str(Path(__file__).resolve().parent))
import materialize as m

NODE_CHECK=r"""
const assert=require('node:assert/strict'),c=require(process.argv[1]),root=process.argv[2];
const manifest=c.fileIdentity(root,'runtime.json'),record=c.validateDescriptor(c.readJson(root,manifest));
assert.equal(record.schema,'sciyue-xtb-bundled-runtime/v2','Only independent v2 runtimes may be admitted');
const inventory=c.readJson(root,record.inventory,8*1024*1024);assert.equal(inventory.schema,'sciyue-xtb-runtime-inventory/v1');
const rows=c.verifyMemberInventory(root,inventory.files);for(const path of c.REQUIRED)assert(rows.some(r=>r.path===path),'Missing required runtime member');
process.stdout.write(JSON.stringify({record,manifest,engineIdentity:c.engineIdentity(record,rows,manifest.sha256)}));
"""

def encode(value):return(json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode('utf-8')

def regular(root,path):
    root=m.ordinary(root);path=m.ordinary(path)
    m.require(path.is_relative_to(root),'Input escaped explicit source root')
    m.require(path.is_file()and path.stat().st_nlink==1,'Ordinary independent file required')
    return path

def identity(root,path):
    path=regular(root,path);before=path.stat();digest=hashlib.sha256()
    with path.open('rb')as stream:
        while block:=stream.read(1024*1024):digest.update(block)
    after=path.stat();m.require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns,before.st_nlink)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns,after.st_nlink),'Input changed while hashing')
    return{'path':path.relative_to(m.ordinary(root)).as_posix(),'bytes':after.st_size,'sha256':digest.hexdigest()}

def load(root,path):
    ref=identity(root,path);data=m.checked(path,ref)
    return json.loads(data),ref

def member(value):
    m.member(value)
    forbidden={'.git','.cache','node_modules','__pycache__','state','profiles','.env','.npmrc','.git-credentials','id_rsa','id_ed25519'}
    m.require(not any(part.casefold()in forbidden for part in value.split('/')),'Private/state member is not a runtime input')
    return value

def inventory(root):
    root=m.ordinary(root);m.require(root.is_dir(),'Runtime directory required');found=[];directories=set();seen=set()
    def walk(directory):
        for path in sorted(directory.iterdir()):
            path=m.ordinary(path);relative=member(path.relative_to(root).as_posix())
            m.require(relative.casefold()not in seen,'Case-colliding runtime member');seen.add(relative.casefold())
            if path.is_dir():directories.add(relative);walk(path)
            else:found.append(identity(root,path))
    walk(root)
    return sorted(found,key=lambda r:r['path']),directories

def exported_reference(root,snapshot,path):
    relative=regular(root,path).relative_to(root).as_posix();rows=[r for r in snapshot['files']if r['path']==relative]
    m.require(len(rows)==1,'Default pins/validator must belong to the exported source snapshot')
    m.checked(path,rows[0]);return rows[0]

def main_commit(pins):
    m.require(pins.get('schema')=='sy-xtb-scientific-pins-v1','Scientific pins schema required')
    rows=[r for r in pins.get('pins',[])if r.get('name')=='xtb'and r.get('role')=='main']
    m.require(len(rows)==1 and re.fullmatch('[a-f0-9]{40}',rows[0].get('commit','')),'Exact main xTB source commit required')
    return rows[0]['commit']

def validate_source_receipt(receipt,record,rows,local_modified):
    if receipt.get('schema')=='es-xtb-user-initial-velocity-composition/v1':
        m.require(local_modified,'User H-cap composition requires --local-modified')
        m.require(receipt.get('algorithm')=='xtb-h-only-initial-cap-v1' and receipt.get('buildId')==record['build']['id']
            and record['build']['id'].startswith('es-hcap-user-'),'User composition identity differs')
        raw=receipt.get('rawBuild',{});parent=receipt.get('parentEngineIdentity',{});payload=receipt.get('parentPayload',[])
        m.require(parent.get('sha256')=='b40033dc620944f87e520d54d0a3cf69f7df73a9f82955d34dfa1a3464924a1c'
            and m.digest(canonical({k:v for k,v in parent.items()if k not in ('schema','engine','kind','sha256')}))==parent['sha256']
            and m.digest(canonical(payload))==parent.get('runtimeMemberDigest'),'User composition public parent differs')
        actual=[r for r in rows if r['path'].startswith(('bin/','share/xtb/'))]
        m.require([r for r in actual if r['path']!='bin/xtb.exe']==[r for r in payload if r['path']!='bin/xtb.exe']
            and [r for r in actual if r['path']=='bin/xtb.exe']==[r for r in raw.get('inventoryFiles',[])if r['path']=='bin/xtb.exe'],
            'User composition executable, inherited DLLs or parameters differ')
        m.require(raw.get('schema')=='sy-xtb-gnu-user-source-build-v1' and raw.get('sourceCommit')==record['source']['commit']
            and raw.get('compilerSeedArchiveSha256')==record['build']['toolchainArchiveSha256']
            and raw.get('sourceModified') is True and raw.get('modifiedSourcePaths')==['src/dynamic.f90']
            and raw.get('addedSourcePaths')==[],'User composition scientific source/build differs')
        m.require(all(receipt.get(k)is False and raw.get(k)is False for k in ('officialBinaryIdentity','numericallyValidated','productReady')),
            'User composition cannot claim acceptance')
        for key in ('rawBuildReceipt','preferredSourceTree'):
            m.require(receipt.get(key) in rows,'User composition source proof member missing')
        return
    if receipt.get('schema')=='sy-xtb-normalized-user-build/v1':
        m.require(local_modified,'Normalized user builds require --local-modified')
        m.require(receipt.get('sourceCommit')==record['source']['commit'] and receipt.get('compilerSeedArchiveSha256')==record['build']['toolchainArchiveSha256'],'Normalized source/toolchain differs')
        m.require(receipt.get('buildName')==record['build']['id'] and receipt.get('scientificPinsSha256')==record['source']['scientificPinsManifest']['sha256'],'Normalized build/pins differs')
        m.require(receipt.get('payloadFiles')==[r for r in rows if r['path'].startswith(('bin/','share/xtb/'))],'Normalized complete payload differs')
        m.require(all(receipt.get(k)is False for k in ('officialBinaryIdentity','numericallyValidated','productReady')),'User admission cannot claim acceptance')
        for key in ('rawBuildReceipt','gnuRuntimeReceipt','preferredSourceTree','gnuSourceTree','sourceIndex','gnuSourceIndex'):
            ref=receipt.get(key);m.require(isinstance(ref,dict) and set(ref)=={'path','bytes','sha256'} and ref in rows,'Normalized proof member missing')
        return
    # R2's actual source-build receipt is a different contract from source-only
    # manifests; accepting a matching hash is necessary but not sufficient.
    m.require(receipt.get('schema')=='sy-xtb-r2-source-receipt-v1','Actual R2 source-build receipt required; source-only metadata is not a build receipt')
    m.require(receipt.get('scientificSourceCommit')==record['source']['commit']and receipt.get('seedCompilerArchiveSha256')==record['build']['toolchainArchiveSha256'],'Source receipt commit/toolchain differs')
    m.require(isinstance(receipt.get('scientificProgramBuild'),str)and receipt['scientificProgramBuild'],'Actual scientific program build identity required')
    rebuilds=receipt.get('runtimeRebuilds');m.require(isinstance(rebuilds,list)and rebuilds,'Runtime source rebuild identities required')
    actual={r['path']:r for r in rows if r['path'].startswith('bin/')and r['path']!='bin/xtb.exe'};declared={}
    for item in rebuilds:
        binary=item.get('binary');m.require(isinstance(binary,dict)and set(binary)=={'path','bytes','sha256'},'Exact rebuilt runtime member required');member(binary['path'])
        m.require(binary['path']not in declared and binary['path']in actual and binary==actual[binary['path']],'Rebuilt runtime binary differs from full members')
        m.require(re.fullmatch('[a-f0-9]{64}',item.get('sourceArchiveSha256','')),'Pinned runtime source archive required');declared[binary['path']]=binary
    # R2 rebuilds only selected GNU DLLs; xtb/OpenBLAS/VC may be retained from
    # the separately identified scientific program build. Full-tree membership
    # is independently enforced by --members and the v2 bin/share inventory.
    m.require(re.fullmatch('[a-f0-9]{64}',receipt.get('originalScientificSourceReceiptSha256','')),'Original scientific build receipt identity required')
    if not local_modified:
        m.require(receipt.get('scientificSourceFilesChanged')is False and receipt.get('parameterFilesChanged')is False and receipt.get('runtimeSourcePatches')==[] and all(r.get('intentionalSourcePatchCount')==0 for r in rebuilds),'Source/parameter patches require --local-modified')


def write_new(path,data):
    path=m.ordinary(path);path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb')as stream:stream.write(data)


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode('utf-8')

def rows_map(rows):
    m.require(isinstance(rows,list) and rows,'Complete source/member rows required');result={}
    for row in rows:
        m.require(set(row)=={'path','bytes','sha256'} and type(row['bytes'])is int and row['bytes']>=0 and re.fullmatch('[a-f0-9]{64}',row['sha256']),'Exact source/member row required')
        member(row['path']);m.require(row['path'].casefold()not in result,'Duplicate source/member row');result[row['path'].casefold()]=row
    return result

def referenced(root,ref):
    member(ref['path']);path=regular(root,root/ref['path']);m.require(identity(root,path)==ref,'Referenced source/build file differs');return json.loads(m.checked(path,ref))

def source_diff(expected,actual,receipt):
    old=rows_map(expected);new=rows_map(actual)
    modified=[r['path']for key,r in old.items()if new.get(key)!=r];added=[r['path']for key,r in new.items()if key not in old]
    m.require(sorted(receipt.get('modifiedSourcePaths',[]))==sorted(modified) and sorted(receipt.get('addedSourcePaths',[]))==sorted(added) and receipt.get('sourceModified')==bool(modified or added),'Actual source changes differ from build receipt')

def validate_es_initial_receipt(receipt):
    """The ES patch reuses the identified GNU DLL build; it is not a GNU rebuild."""
    m.require(receipt.get('schema')=='es-xtb-initial-velocity-source-build/v1'
        and receipt.get('algorithm')=='xtb-h-only-initial-cap-v1','Exact ES initial velocity receipt required')
    raw=receipt.get('rawBuild',{});patch=receipt.get('sourcePatch',{})
    m.require(raw.get('schema')=='sy-xtb-gnu-user-source-build-v1'
        and raw.get('sourceCommit')=='5071a8869720fb0ecd788af977159869b64a277c'
        and raw.get('buildName')=='5071a886-gnu132-r2-es-hcap-v1','ES scientific source/build differs')
    m.require(raw.get('modifiedSourcePaths')==['src/dynamic.f90']
        and raw.get('addedSourcePaths')==[] and raw.get('sourceModified') is True,'ES source change scope differs')
    m.require(patch.get('algorithm')==receipt['algorithm'] and patch.get('path')=='src/dynamic.f90'
        and patch.get('beforeSha256')=='32b604dfc82eb647b753cd8ff1b650547fcb686e5f1b668a70dfb472aedbfd91'
        and re.fullmatch('[a-f0-9]{64}',patch.get('afterSha256','')),'Exact ES source patch binding required')
    m.require(all(raw.get(k)is False for k in ('officialBinaryIdentity','numericallyValidated','productReady'))
        and receipt.get('numericallyValidated') is False and receipt.get('scienceRunsPerformed')==0,
        'Build receipt cannot claim numerical/product acceptance')
    composition=receipt.get('runtimeComposition',{})
    m.require(composition.get('kind')=='new-executable-with-unchanged-published-runtime'
        and composition.get('sourceBuildName')==raw['buildName']
        and composition.get('buildId')=='5071a886-gnu132-r2-es-hcap-openblas033-v1'
        and composition.get('parentBuildId')=='5071a886-gnu132-r2-openblas033-a01',
        'Explicit published-runtime composition required')
    terminals=receipt.get('buildTerminals',[])
    m.require(len(terminals)==4 and all(t.get('passed') is True and t.get('exitCode')==0
        and t.get('jobTreeEnded') is True and t.get('mainProcessEnded') is True
        and t.get('timedOut') is False and t.get('error') is None and not t.get('cleanupError')
        for t in terminals),'Four successful owned native build commands required')
    return raw

def admit_es_initial_velocity(source_root,runtime,original_runtime,build_root,default_pins,run_id,*,apply=False,activate=False,node='node'):
    """Verify the local ES patch and emit a fresh content-addressed lock, never activate it."""
    m.require(not activate,'ES patch activation remains a separate Main operation')
    m.require(re.fullmatch('[a-z][a-z0-9-]{0,40}',run_id),'Fresh ASCII admission ID required')
    root=m.ordinary(source_root);runtime=m.ordinary(runtime);original=m.ordinary(original_runtime);build=m.ordinary(build_root)
    for path in (runtime,original,build):m.require(path.is_relative_to(root) and path!=root,'ES inputs must belong to the explicit source root')
    receipt,receipt_ref=load(root,runtime/'provenance/es-initial-velocity-build.json')
    raw=validate_es_initial_receipt(receipt)
    raw_actual,_=load(root,build/'output/xtb-build-receipt.json');m.require(raw_actual==raw,'Actual raw build receipt differs')
    members,_=inventory(runtime)
    checked=json.loads(subprocess.run([node,'-e',NODE_CHECK,str(root/'desktop/xtb-runtime-contract.cjs'),str(runtime)],
        check=True,capture_output=True,text=True,encoding='utf-8',timeout=30).stdout)
    record=checked['record'];identity_value=checked['engineIdentity']
    m.require(record['build']['sourceReceiptSha256']==receipt_ref['sha256']
        and record['build']['id']==receipt['runtimeComposition']['buildId'],'ES descriptor/build receipt differs')
    pins,pin_ref=load(root,default_pins);index,index_ref=load(root,root/'third-party/corresponding-sources/XTB-GNU-SOURCE-INDEX.json')
    m.require(main_commit(pins)==raw['sourceCommit'] and record['source']['scientificPinsManifest']['sha256']==pin_ref['sha256']
        and raw['sourceIndexSha256']==index_ref['sha256'] and raw['compilerSeedArchiveSha256']==index['bootstrapToolsNotBundled'][0]['sha256']
        and raw['scientificPins']==[{k:r[k]for k in ('name','commit','sha256')}for r in index['sourceArchives']],
        'ES source index, compiler or scientific pins differ')
    tree=referenced(build/'output',raw['preferredSourceTree'])
    m.require(inventory(build/'source')[0]==tree['files'],'Actual ES preferred source tree differs')
    expected=referenced(root/'third-party/corresponding-sources',index['preferredSourceTree'])
    source_diff(expected['files'],tree['files'],raw)
    m.require(next(r['sha256']for r in tree['files']if r['path']=='src/dynamic.f90')==receipt['sourcePatch']['afterSha256'],
        'ES patch does not bind actual dynamic.f90')
    source_archive=next(r for r in index['sourceArchives']if r['name']=='xtb')
    archive=root/'third-party/corresponding-sources'/source_archive['path']
    m.require(identity(root,archive)['sha256']==source_archive['sha256'],'Pinned xTB archive differs')
    with tarfile.open(archive,'r:gz')as bundle:
        entries=[r for r in bundle if r.isfile()and r.name.endswith('/src/dynamic.f90')]
        m.require(len(entries)==1,'Pinned dynamic source member is ambiguous')
        before=bundle.extractfile(entries[0]).read().decode('utf-8')
    helper=(root/'scripts/native/xtb-initial-velocity.f90').read_text(encoding='utf-8')
    call='      call mdinitu(mol%n,mol%at,velo,mass,edum)'
    m.require(before.count(call)==1 and before.count('end subroutine mdinitu')==1,'Pinned source patch anchors differ')
    expected_source=before.replace(call,call+'\n      call es_initial_velocity_cap(mol%n,mol%at,velo,mass,nfreedom,kB)').replace('end subroutine mdinitu','end subroutine mdinitu\n\n'+helper)
    m.require((build/'source/src/dynamic.f90').read_text(encoding='utf-8')==expected_source,
        'Actual compiled source differs from the explicit H-only patch')
    payload=[r for r in members if r['path'].startswith(('bin/','share/xtb/'))]
    raw_payload=[r for r in inventory(build/'output')[0]if r['path'].startswith(('bin/','share/xtb/'))]
    m.require(raw_payload==raw['inventoryFiles'],'Actual raw ES payload differs from build')
    m.require([r for r in payload if r['path']=='bin/xtb.exe' or r['path'].startswith('share/xtb/')]
        ==[r for r in raw_payload if r['path']=='bin/xtb.exe' or r['path'].startswith('share/xtb/')],
        'ES executable or parameters differ from actual build')
    original_record=json.loads(subprocess.run([node,'-e',NODE_CHECK,str(root/'desktop/xtb-runtime-contract.cjs'),str(original)],
        check=True,capture_output=True,text=True,encoding='utf-8',timeout=30).stdout)
    original_rows=inventory(original)[0]
    composition=receipt['runtimeComposition']
    m.require(original_record['record']['build']['id']==composition['parentBuildId']
        and original_record['engineIdentity']['sha256']=='b40033dc620944f87e520d54d0a3cf69f7df73a9f82955d34dfa1a3464924a1c'
        and original_record['manifest']['sha256']==composition['parentManifestSha256']
        and identity(original,original/composition['parentSourceReceipt']['path'])==composition['parentSourceReceipt'],
        'Published parent runtime provenance differs')
    unchanged=[r for r in payload if r['path']!='bin/xtb.exe']
    original_unchanged=[r for r in original_rows if r['path'].startswith(('bin/','share/xtb/')) and r['path']!='bin/xtb.exe']
    m.require(unchanged==sorted(original_unchanged,key=lambda r:r['path'])
        and unchanged==sorted(receipt['unchangedRuntimeAndParameters'],key=lambda r:r['path']),
        'Reused GNU DLLs or parameter files differ')
    m.require(identity(original,original/'provenance/r2-source-receipt.json')==receipt['originalRuntimeSourceReceipt'],
        'Original GNU runtime source receipt differs')
    m.require(identity(build,build/'build/xtb.exe')['sha256']==next(r['sha256']for r in payload if r['path']=='bin/xtb.exe'),
        'Admitted executable differs from actual compiler output')
    evidence=[]
    for ref in receipt['buildEvidence']:
        m.require(Path(ref['name']).name==ref['name'],'Unsafe build evidence name')
        p=build/'logs'/ref['name'];observed=identity(build/'logs',p)
        m.require(observed=={'path':ref['name'],'bytes':ref['bytes'],'sha256':ref['sha256']},'Native build evidence changed')
        if ref['name'].endswith('.request.json'):evidence.append(json.loads(p.read_text(encoding='utf-8')))
    m.require(len(evidence)==4 and 'ninja.exe' in Path(evidence[-1]['command'][0]).name.lower()
        and evidence[-1]['command'][-1]=='xtb.exe'
        and [Path(item['cwd']) for item in evidence]==[build/'openblas',build/'openblas',build,build]
        and Path(evidence[0]['command'][0]).name.lower()=='gendef.exe'
        and Path(evidence[1]['command'][0]).name.lower()=='dlltool.exe'
        and 'setup' in evidence[2]['command'],'Actual owned build command scope differs')
    active=root/'desktop/packaging/xtb-runtime.lock.json';parent,parent_ref=load(root,active);parent_bytes=m.checked(active,parent_ref)
    lock_id='xtb-es-hcap-'+identity_value['sha256'][:16];relative='.local/dependencies/win-x64/'+lock_id;target=root/relative
    m.require(not target.exists(),'Existing ES admission root protected')
    result=dict(schema='es-xtb-initial-velocity-admission/v1',planned=not apply,activated=False,root=relative,
        lockId=lock_id,engineIdentity=identity_value,files=len(members),parentLock=parent_ref,
        officialAcceptance=False,scientificAccepted=False,buildExecuted=False)
    if not apply:return result
    target.mkdir(parents=True)
    for row in members:
        write_new(target/'xtb'/row['path'],m.checked(runtime/row['path'],row))
    outer={**parent,'lockId':lock_id,'root':relative,'build':record['build'],'source':record['source'],
        'engineIdentity':identity_value,'files':[{**r,'path':'xtb/'+r['path']}for r in members],
        'publicRedistributionReviewed':False,'distributionLicenseReady':False,'publicDistribution':False,
        'localModification':dict(kind='es-h-only-initial-velocity-cap',algorithm=receipt['algorithm'],
            sourceReceipt=receipt_ref,originalEngineIdentity=original_record['engineIdentity'],scientificAccepted=False)}
    outer.pop('inventory',None);outer_bytes=encode(outer);write_new(target/'inventory.json',outer_bytes)
    lock={k:v for k,v in outer.items()if k!='files'};lock['inventory']={'path':relative+'/inventory.json','bytes':len(outer_bytes),'sha256':m.digest(outer_bytes)}
    write_new(target/'lock.json',encode(lock));write_new(target/'previous-xtb-lock.json',parent_bytes)
    m.require(inventory(runtime)[0]==members,'ES runtime changed during copy');m.checked(active,parent_ref)
    result['lock']=identity(root,target/'lock.json');write_new(target/'admission.json',encode(result));return result

def normalize_raw(source_root,raw_output,preferred_source_root,gnu_runtime_output,default_pins,run_id,*,local_modified=False,apply=False,activate=False,node='node'):
    """Validate the public recipe's raw output, then create an independently named v2 tree."""
    m.require(local_modified,'Raw user source builds require explicit --local-modified')
    m.require(not activate or apply,'--activate requires --apply')
    m.require(re.fullmatch('[a-z][a-z0-9-]{0,40}',run_id),'Fresh ASCII admission ID required')
    root=m.ordinary(source_root);raw=m.ordinary(raw_output);gnu=m.ordinary(gnu_runtime_output);source=m.ordinary(preferred_source_root)
    snapshot,_=load(root,root/'source-export-manifest.json');m.require(snapshot.get('schema')=='sy-public-source-snapshot/v1','Exported source copy required')
    regular(root,root/'source-native-identity.json');validator=root/'desktop/xtb-runtime-contract.cjs';exported_reference(root,snapshot,validator)
    base=root/'third-party/corresponding-sources';xi=base/'XTB-GNU-SOURCE-INDEX.json';gi=base/'GNU-RUNTIME-SOURCE-INDEX.json'
    for p in (xi,gi,default_pins):exported_reference(root,snapshot,Path(p))
    x,xref=load(root,xi);g,gref=load(root,gi);pins,pref=load(root,Path(default_pins))
    m.require(x.get('schema')=='sy-xtb-gnu-corresponding-source-index-v1' and g.get('schema')=='sy-gnu-runtime-corresponding-source-index-v1','Exact public source indexes required')
    m.require(main_commit(pins)==x['mainCommit'],'Default main scientific pin differs')
    expected_pins=[{k:r[k]for k in ('name','commit','sha256')}for r in x['sourceArchives']]
    selected=[r for r in pins['pins']if r.get('role')!='excluded-standalone-tests-only']
    m.require({(r['name'],r['commit'],r['archiveSha256'])for r in selected}=={(r['name'],r['commit'],r['sha256'])for r in expected_pins},'All selected scientific source pins must match the indexed recipe')
    for index in (x,g):
        for ref in [index['preferredSourceTree'] if index is x else index['sourceTree'],*index['licenseFiles']]:
            exported_reference(root,snapshot,base/member(ref['path']));m.checked(base/ref['path'],ref)
    build,bref=load(raw,raw/'xtb-build-receipt.json');rt,rtref=load(raw,raw/'gnu-runtime-source-receipt.json')
    m.require(build.get('schema')=='sy-xtb-gnu-user-source-build-v1','Actual public scientific build receipt required')
    m.require(build.get('sourceIndexSha256')==xref['sha256'] and build.get('sourceCommit')==x['mainCommit'] and build.get('scientificPins')==expected_pins,'Scientific index/commit/pins differ')
    m.require(build.get('runtimeSourceReceipt')==rtref,'Copied GNU receipt identity differs')
    m.require(all(build.get(k)is False for k in ('officialBinaryIdentity','numericallyValidated','productReady')),'Raw build must not claim acceptance')
    m.require(build.get('compilerSeedArchiveSha256')==x['bootstrapToolsNotBundled'][0]['sha256'] and build.get('openblasAbi')=='LP64','Compiler/math build contract differs')
    allrows,dirs=inventory(raw);payload=[r for r in allrows if r['path'].startswith(('bin/','share/xtb/'))]
    m.require(payload==build.get('inventoryFiles'),'Full raw executable/parameter membership differs')
    m.require({r['path']for r in allrows}=={r['path']for r in payload}|{'xtb-build-receipt.json','gnu-runtime-source-receipt.json','preferred-source-tree.json'},'Unexpected raw output member')
    m.require(dirs=={p.as_posix()for r in allrows for p in PurePosixPath(r['path']).parents if str(p)!='.'},'Unexpected raw output directory')
    actual_tree=referenced(raw,build['preferredSourceTree']);expected_tree=referenced(base,x['preferredSourceTree'])
    m.require(inventory(source)[0]==actual_tree['files'],'Actual preferred scientific sources differ from build-time source tree')
    source_diff(expected_tree['files'],actual_tree['files'],build)
    actual={r['path']:r for r in payload}
    for key in ('openblas','vcRuntime'):
        row=x[key];m.require(actual.get('bin/'+row['dllName'])=={'path':'bin/'+row['dllName'],'bytes':row['bytes'],'sha256':row['sha256']},'Exact indexed math/VC binary differs')
    parameter_changes=[]
    for row in x['parameters']:
        expected={'path':row['installPath'],'bytes':row['bytes'],'sha256':row['sha256']}
        m.require(expected['path']in actual,'Required parameter absent')
        if actual[expected['path']]!=expected:parameter_changes.append({'default':expected,'actual':actual[expected['path']]})
    m.require(rt.get('schema')=='sy-gnu-runtime-user-rebuild-v1','Actual public GNU user runtime build receipt required')
    m.require(identity(gnu,gnu/'runtime-rebuild-receipt.json')['sha256']==rtref['sha256'],'Explicit GNU build origin differs')
    m.require(rt.get('sourceIndexSha256')==gref['sha256'] and rt.get('originalSourceTreeSha256')==g['sourceTree']['sha256'] and rt.get('compilerSeedArchiveSha256')==build['compilerSeedArchiveSha256'],'GNU source index/compiler differs')
    gt=referenced(gnu,rt['actualSourceTree']);m.require(m.digest(canonical(gt['files']))==rt.get('actualInputSourceTreeDigest')==gt.get('canonicalRowsSha256'),'GNU actual input tree digest differs')
    source_diff(referenced(base,g['sourceTree'])['files'],gt['files'],rt)
    m.require(all(rt.get(k)is False for k in ('officialBinaryIdentity','numericallyValidated','productReady')),'GNU build must not claim acceptance')
    dlls=[]
    for row in rt.get('runtimeFiles',[]):
        binary={k:row[k]for k in ('path','bytes','sha256')};m.require(actual.get(binary['path'])==binary and identity(gnu,gnu/member(binary['path']))==binary,'GNU binary differs from its build receipt');dlls.append(binary['path'])
    expected_dlls={'bin/'+name for name in ('libgcc_s_seh-1.dll','libgfortran-5.dll','libgomp-1.dll','libquadmath-0.dll','libwinpthread-1.dll','libdl.dll')}
    m.require(set(dlls)==expected_dlls and len(dlls)==len(expected_dlls),'Complete six GNU runtime binaries required')
    m.require(set(actual)=={'bin/xtb.exe','bin/openblas.dll','bin/VCRUNTIME140.dll'}|expected_dlls|{r['installPath']for r in x['parameters']},'Unexpected or missing program/runtime/parameter member')
    # Build all metadata in memory. Plan creates no directory or descriptor.
    generated={};copies={r['path']:raw/r['path']for r in payload}
    proof_inputs={'rawBuildReceipt':raw/'xtb-build-receipt.json','gnuRuntimeReceipt':raw/'gnu-runtime-source-receipt.json','preferredSourceTree':raw/'preferred-source-tree.json','gnuSourceTree':gnu/rt['actualSourceTree']['path'],'sourceIndex':xi,'gnuSourceIndex':gi}
    refs={}
    for key,path in proof_inputs.items():
        owner=raw if path.is_relative_to(raw)else gnu if path.is_relative_to(gnu)else root
        ref=identity(owner,path);destination='provenance/'+key+'.json';copies[destination]=path;refs[key]={**ref,'path':destination}
    for index in (x,g):
        for ref in index['licenseFiles']:copies[member(ref['path'])]=base/ref['path']
    composite={'schema':'sy-xtb-normalized-user-build/v1',**refs,'sourceCommit':build['sourceCommit'],'buildName':build['buildName'],'compilerSeedArchiveSha256':build['compilerSeedArchiveSha256'],'scientificPinsSha256':pref['sha256'],'payloadFiles':payload,'parameterChanges':parameter_changes,'sourceModified':build['sourceModified'],'runtimeSourceModified':rt['sourceModified'],'officialBinaryIdentity':False,'numericallyValidated':False,'productReady':False}
    generated['provenance/source-receipt.json']=encode(composite)
    generated['inventory.json']=encode({'schema':'sciyue-xtb-runtime-inventory/v1','files':payload})
    def byte_ref(path,data):return{'path':path,'bytes':len(data),'sha256':m.digest(data)}
    descriptor={'schema':'sciyue-xtb-bundled-runtime/v2','version':x['reportedVersion'],'platform':'win32-x64','entry':'bin/xtb.exe','dataDirectory':'share/xtb','methods':['gfn0','gfn1','gfn2','gfnff'],'scope':'local-experimental','localUseReady':True,'readinessBasis':'structural-local-admission-only; no numerical/product acceptance','source':{'commit':build['sourceCommit'],'scientificPinsManifest':{'sha256':pref['sha256']}},'build':{'id':build['buildName'],'compiler':{'name':'gfortran','version':'13.2.0'},'toolchainArchiveSha256':build['compilerSeedArchiveSha256'],'sourceReceiptSha256':m.digest(generated['provenance/source-receipt.json'])},'modified':{'local':True,'kind':'independent-rebuild','upstreamBinaryIdentity':False},'inventory':byte_ref('inventory.json',generated['inventory.json']),'officialBinaryIdentity':False,'numericallyValidated':False,'productReady':False}
    generated['runtime.json']=encode(descriptor)
    subprocess.run([node,'-e',"require(process.argv[1]).validateDescriptor(JSON.parse(process.argv[2]))",str(validator),json.dumps(descriptor)],check=True,capture_output=True,timeout=30)
    normalized=root/'.local/xtb-normalized'/run_id;target=root/'.local/dependencies/win-x64'/('xtb-local-modified-'+run_id)
    m.require(not normalized.exists()and not target.exists(),'Existing normalization/admission root protected')
    for input_path in (raw,gnu,source):m.require(not normalized.is_relative_to(input_path)and not input_path.is_relative_to(normalized),'Normalization input/output overlap')
    full=[{**identity(path.parent,path),'path':rel}for rel,path in copies.items()]+[byte_ref(rel,data)for rel,data in generated.items()];full.sort(key=lambda r:r['path'])
    rows_map(full)
    result={'schema':'sy-raw-xtb-normalization-plan/v1','planned':not apply,'normalizedRoot':normalized.relative_to(root).as_posix(),'files':len(full),'sourceModified':build['sourceModified'],'runtimeSourceModified':rt['sourceModified'],'parameterChanges':parameter_changes,'officialAcceptance':False,'scientificAccepted':False,'buildExecuted':False}
    if not apply:return result
    normalized.mkdir(parents=True)
    for rel,path in copies.items():
        ref=next(r for r in full if r['path']==rel);write_new(normalized/rel,m.checked(path,ref))
    for rel,data in generated.items():write_new(normalized/rel,data)
    members=normalized.with_name(run_id+'-members.json');write_new(members,encode({'schema':'sy-built-xtb-members/v1','files':full}))
    result['admission']=admit(root,normalized,members,Path(default_pins),normalized/'provenance/source-receipt.json',run_id,local_modified=True,apply=True,activate=activate,node=node)
    result['root']=result['admission']['root'];result['activated']=result['admission']['activated'];return result

def admit(source_root,runtime,members,default_pins,source_receipt,run_id,*,pins=None,local_modified=False,apply=False,activate=False,node='node'):
    root=m.ordinary(source_root);runtime=m.ordinary(runtime)
    m.require(root.is_dir()and runtime.is_relative_to(root)and runtime!=root,'Runtime must belong to the explicit source copy')
    m.require(not activate or apply,'--activate requires --apply')
    m.require(re.fullmatch('[a-z][a-z0-9-]{0,40}',run_id),'Fresh ASCII admission ID required')
    snapshot,snapshot_ref=load(root,root/'source-export-manifest.json');m.require(snapshot.get('schema')=='sy-public-source-snapshot/v1','Exported source copy required')
    regular(root,root/'source-native-identity.json')
    validator=root/'desktop/xtb-runtime-contract.cjs';validator_ref=exported_reference(root,snapshot,validator)
    default_pins=m.ordinary(default_pins);default_value,default_ref=load(root,default_pins);exported_reference(root,snapshot,default_pins);default_commit=main_commit(default_value)
    pins=m.ordinary(pins or default_pins);pin_value,pin_ref=load(root,pins);actual_commit=main_commit(pin_value)
    if not local_modified:m.require(pin_ref['sha256']==default_ref['sha256']and actual_commit==default_commit,'Changed scientific pins require --local-modified')
    members=m.ordinary(members);m.require(not members.is_relative_to(runtime),'Full member manifest must be outside the runtime to avoid self-reference')
    declared,member_ref=load(root,members);m.require(declared.get('schema')=='sy-built-xtb-members/v1','Independent full runtime member manifest required')
    rows=declared.get('files');m.require(isinstance(rows,list)and rows,'Full runtime membership required')
    for row in rows:
        m.require(set(row)=={'path','bytes','sha256'}and type(row['bytes'])is int and row['bytes']>=0 and re.fullmatch('[a-f0-9]{64}',row['sha256']),'Exact runtime member identity required');member(row['path'])
    m.require(len(rows)==len({r['path'].casefold()for r in rows}),'Duplicate runtime member')
    expected=sorted(rows,key=lambda r:r['path']);actual,directories=inventory(runtime)
    m.require(actual==expected,'Missing, extra or changed full runtime member')
    expected_dirs={parent.as_posix()for row in rows for parent in PurePosixPath(row['path']).parents if str(parent)!='.'}
    m.require(directories==expected_dirs,'Extra or missing runtime directory')
    source_receipt=m.ordinary(source_receipt);receipt,receipt_ref=load(root,source_receipt);m.require(isinstance(receipt,dict)and isinstance(receipt.get('schema'),str),'Actual source receipt JSON required')
    result=subprocess.run([node,'-e',NODE_CHECK,str(validator),str(runtime)],capture_output=True,text=True,encoding='utf-8',timeout=30,check=True)
    checked=json.loads(result.stdout);record=checked['record']
    m.require(record['source']['scientificPinsManifest']['sha256']==pin_ref['sha256']and record['source']['commit']==actual_commit,'Runtime source/pins do not match the actual build inputs')
    m.require(record['build']['sourceReceiptSha256']==receipt_ref['sha256'],'Actual source receipt identity differs from runtime descriptor')
    validate_source_receipt(receipt,record,actual,local_modified)
    if receipt.get('schema')=='es-xtb-user-initial-velocity-composition/v1':
        raw=referenced(runtime,receipt['rawBuildReceipt']);tree=referenced(runtime,receipt['preferredSourceTree'])
        m.require(raw==receipt['rawBuild'] and raw['preferredSourceTree']['sha256']==receipt['preferredSourceTree']['sha256'],
            'User composition copied proof differs')
        index_path=root/'third-party/corresponding-sources/XTB-GNU-SOURCE-INDEX.json'
        exported_reference(root,snapshot,index_path);index,index_ref=load(root,index_path)
        m.require(raw['sourceIndexSha256']==index_ref['sha256'],'User composition source index differs from exported source')
        expected=referenced(root/'third-party/corresponding-sources',index['preferredSourceTree'])
        source_diff(expected['files'],tree['files'],raw)
        m.require(next((r['sha256']for r in tree['files']if r['path']=='src/dynamic.f90'),None)
            =='1b23863afc82582386e4a3a4c1711e09439e79417a65b133219810214c65ca4f',
            'User composition H-only patch differs from this source release')
    if receipt.get('schema')=='sy-xtb-normalized-user-build/v1':
        raw=referenced(runtime,receipt['rawBuildReceipt']);gnu=referenced(runtime,receipt['gnuRuntimeReceipt'])
        m.require(raw.get('schema')=='sy-xtb-gnu-user-source-build-v1' and gnu.get('schema')=='sy-gnu-runtime-user-rebuild-v1','Normalized proofs must be actual user build receipts')
        m.require(raw.get('inventoryFiles')==receipt['payloadFiles'] and raw.get('buildName')==record['build']['id'] and raw.get('sourceCommit')==record['source']['commit'],'Normalized raw build/payload binding differs')
        m.require(raw['runtimeSourceReceipt']['sha256']==receipt['gnuRuntimeReceipt']['sha256'] and raw['preferredSourceTree']['sha256']==receipt['preferredSourceTree']['sha256'] and gnu['actualSourceTree']['sha256']==receipt['gnuSourceTree']['sha256'],'Normalized source proof binding differs')
        for key,name in [('sourceIndex','XTB-GNU-SOURCE-INDEX.json'),('gnuSourceIndex','GNU-RUNTIME-SOURCE-INDEX.json')]:
            frozen=exported_reference(root,snapshot,root/'third-party/corresponding-sources'/name)
            m.require(receipt[key]['sha256']==frozen['sha256'],'Normalized source index differs from exported snapshot')
        m.require(raw['sourceIndexSha256']==receipt['sourceIndex']['sha256'] and gnu['sourceIndexSha256']==receipt['gnuSourceIndex']['sha256'],'Normalized build/index binding differs')
        source_index=referenced(runtime,receipt['sourceIndex'])
        m.require(raw['scientificPins']==[{k:r[k]for k in ('name','commit','sha256')}for r in source_index['sourceArchives']] and raw['compilerSeedArchiveSha256']==record['build']['toolchainArchiveSha256'],'Normalized scientific pins/compiler binding differs')
        for index in (referenced(runtime,receipt['sourceIndex']),referenced(runtime,receipt['gnuSourceIndex'])):
            for ref in index['licenseFiles']:m.require(identity(runtime,runtime/member(ref['path']))=={k:ref[k]for k in ('path','bytes','sha256')},'Normalized indexed license differs')
    m.require(identity(runtime,runtime/'runtime.json')==checked['manifest'],'Descriptor changed during validation')
    active=root/'desktop/packaging/xtb-runtime.lock.json';parent,parent_ref=load(root,active);parent_bytes=m.checked(active,parent_ref)
    m.require(parent.get('schema')=='sciyue-xtb-lock-v1','Existing active xTB declaration required')
    mode='modified'if local_modified else'pinned';lock_id='xtb-local-'+mode+'-'+run_id;relative='.local/dependencies/win-x64/'+lock_id;target=m.ordinary(root/relative)
    m.require(not target.exists(),'Existing admission/partial root protected; use a fresh ID')
    m.require(not target.is_relative_to(runtime)and not runtime.is_relative_to(target),'Admission output/input overlap refused')
    local={'kind':'explicit-user-modified-build'if local_modified else'independent-pinned-source-rebuild','defaultBinaryIdentity':False,'localModified':bool(local_modified),'officialAcceptance':False,'scientificAccepted':False,'defaultPins':default_ref,'actualPins':pin_ref,'sourceReceipt':receipt_ref,'parentLock':parent_ref}
    base={'schema':'sciyue-xtb-lock-v1','platform':'win32-x64','lockId':lock_id,'root':relative,'contentDirectories':['xtb'],'version':record['version'],'entry':'xtb/bin/xtb.exe','dataDirectory':'xtb/share/xtb','methods':record['methods'],'source':record['source'],'build':record['build'],'scope':'local-experimental','localUseReady':record['localUseReady'],'publicRedistributionReviewed':False,'distributionLicenseReady':False,'publicDistribution':False,'localModification':local,'engineIdentity':checked['engineIdentity']}
    payload=[{**r,'path':'xtb/'+r['path']}for r in actual];outer={**base,'files':payload};outer_bytes=encode(outer)
    lock={**base,'inventory':{'path':relative+'/inventory.json','bytes':len(outer_bytes),'sha256':m.digest(outer_bytes)}};lock_bytes=encode(lock)
    outcome={'schema':'sy-local-built-xtb-admission/v1','planned':not apply,'activated':False,'root':relative,'lockId':lock_id,'files':len(payload),'runtimeManifest':checked['manifest'],'engineIdentity':checked['engineIdentity'],'sourceSnapshot':snapshot_ref,'validator':validator_ref,'members':member_ref,'localModified':bool(local_modified),'officialAcceptance':False,'scientificAccepted':False,'buildExecuted':False,'scientificExecution':False}
    if not apply:return outcome
    target.mkdir(parents=True)
    for row in actual:
        source=regular(runtime,runtime/row['path']);destination=m.ordinary(target/'xtb'/row['path']);destination.parent.mkdir(parents=True,exist_ok=True)
        with source.open('rb')as src,destination.open('xb')as dst:shutil.copyfileobj(src,dst,1024*1024)
        m.require(identity(target,destination)=={**row,'path':'xtb/'+row['path']},'Copied member identity differs')
    write_new(target/'inventory.json',outer_bytes);write_new(target/'lock.json',lock_bytes);write_new(target/'previous-xtb-lock.json',parent_bytes)
    for path,ref in [(validator,validator_ref),(default_pins,default_ref),(pins,pin_ref),(members,member_ref),(source_receipt,receipt_ref),(active,parent_ref)]:m.checked(path,ref)
    m.require(inventory(runtime)[0]==actual,'Built runtime changed while copying')
    if activate:
        temporary=active.with_name('xtb-runtime.lock.next-'+run_id+'.json');write_new(temporary,lock_bytes);m.checked(active,parent_ref);os.replace(temporary,active);outcome['activated']=True
    outcome['planned']=False;outcome['lock']={'path':relative+'/lock.json','bytes':len(lock_bytes),'sha256':m.digest(lock_bytes)}
    write_new(target/'admission.json',encode(outcome));return outcome

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in('source-root','default-pins'):parser.add_argument('--'+name,required=True,type=Path)
    route=parser.add_mutually_exclusive_group(required=True);route.add_argument('--runtime',type=Path);route.add_argument('--raw-output',type=Path)
    for name in('members','source-receipt','preferred-source-root','gnu-runtime-output'):parser.add_argument('--'+name,type=Path)
    parser.add_argument('--pins',type=Path);parser.add_argument('--id',required=True);parser.add_argument('--local-modified',action='store_true');parser.add_argument('--apply',action='store_true');parser.add_argument('--activate',action='store_true');parser.add_argument('--node',default='node')
    parser.add_argument('--es-initial-velocity',action='store_true')
    parser.add_argument('--original-runtime',type=Path);parser.add_argument('--build-root',type=Path)
    a=parser.parse_args()
    if a.es_initial_velocity:
        if not(a.runtime and a.original_runtime and a.build_root and a.local_modified) or a.activate:
            parser.error('ES initial velocity admission requires runtime, original-runtime, build-root and local-modified; activation is separate')
        result=admit_es_initial_velocity(a.source_root,a.runtime,a.original_runtime,a.build_root,a.default_pins,a.id,apply=a.apply,node=a.node)
    elif a.raw_output:
        if not(a.preferred_source_root and a.gnu_runtime_output)or a.members or a.source_receipt or a.pins:parser.error('raw output requires --preferred-source-root/--gnu-runtime-output; direct-v2 members/receipt/pins options do not apply')
        result=normalize_raw(a.source_root,a.raw_output,a.preferred_source_root,a.gnu_runtime_output,a.default_pins,a.id,local_modified=a.local_modified,apply=a.apply,activate=a.activate,node=a.node)
    else:
        if not(a.members and a.source_receipt)or a.preferred_source_root or a.gnu_runtime_output:parser.error('direct v2 requires --members/--source-receipt and no raw-only paths')
        result=admit(a.source_root,a.runtime,a.members,a.default_pins,a.source_receipt,a.id,pins=a.pins,local_modified=a.local_modified,apply=a.apply,activate=a.activate,node=a.node)
    print(json.dumps(result,indent=2))
