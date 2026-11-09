"""Compose a USER-BUILT H-cap runtime from raw build and an exact public parent.

This does not install, activate, execute xTB, rebuild GNU libraries, or confer
official/numerical acceptance. By default it validates and prints a plan;
--apply writes a fresh output directory with an independent identity.
"""
import argparse,hashlib,importlib.util,json,re,shutil,subprocess,sys,tarfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('es_xtb_admission',ROOT/'scripts/release/admit-built-xtb.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)

def validate_inputs(root,build,parent,node):
    base=root/'third-party/corresponding-sources'
    index,index_ref=a.load(root,base/'XTB-GNU-SOURCE-INDEX.json')
    raw,raw_ref=a.load(build/'output',build/'output/xtb-build-receipt.json')
    a.m.require(raw.get('schema')=='sy-xtb-gnu-user-source-build-v1'
        and raw.get('sourceIndexSha256')==index_ref['sha256'] and raw.get('sourceCommit')==index['mainCommit'],
        'Raw build/source index differs')
    a.m.require(raw.get('sourceModified') is True and raw.get('modifiedSourcePaths')==['src/dynamic.f90']
        and raw.get('addedSourcePaths')==[] and all(raw.get(k)is False for k in
        ('officialBinaryIdentity','numericallyValidated','productReady')),'Expected unaccepted H-only source build')
    a.m.require(raw.get('scientificPins')==[{k:r[k]for k in ('name','commit','sha256')}for r in index['sourceArchives']]
        and raw.get('compilerSeedArchiveSha256')==index['bootstrapToolsNotBundled'][0]['sha256'],
        'Scientific pins/compiler archive differs')
    tree=a.referenced(build/'output',raw['preferredSourceTree'])
    a.m.require(a.inventory(build/'source')[0]==tree['files'],'Build-time preferred source tree differs')
    a.source_diff(a.referenced(base,index['preferredSourceTree'])['files'],tree['files'],raw)
    pin=next(r for r in index['sourceArchives']if r['name']=='xtb');archive=base/pin['path']
    a.m.require(a.identity(base,archive)['sha256']==pin['sha256'],'Pinned xTB archive differs')
    with tarfile.open(archive,'r:gz')as bundle:
        names=[m for m in bundle if m.isfile()and m.name.endswith('/src/dynamic.f90')]
        a.m.require(len(names)==1,'Ambiguous original dynamic source')
        original=bundle.extractfile(names[0]).read().decode('utf-8')
    helper=(root/'scripts/native/xtb-initial-velocity.f90').read_text(encoding='utf-8')
    call='      call mdinitu(mol%n,mol%at,velo,mass,edum)'
    expected=original.replace(call,call+'\n      call es_initial_velocity_cap(mol%n,mol%at,velo,mass,nfreedom,kB)').replace(
        'end subroutine mdinitu','end subroutine mdinitu\n\n'+helper)
    a.m.require((build/'source/src/dynamic.f90').read_text(encoding='utf-8')==expected,'Actual source differs from current explicit H-only patch')
    payload=[r for r in a.inventory(build/'output')[0]if r['path'].startswith(('bin/','share/xtb/'))]
    a.m.require(payload==raw['inventoryFiles'],'Raw output membership differs from build receipt')
    a.m.require(a.identity(build,build/'build/xtb.exe')['sha256']==next(r['sha256']for r in payload if r['path']=='bin/xtb.exe'),
        'Raw executable differs from actual build output')
    check=json.loads(subprocess.run([node,'-e',a.NODE_CHECK,str(root/'desktop/xtb-runtime-contract.cjs'),str(parent)],
        capture_output=True,text=True,encoding='utf-8',check=True,timeout=30).stdout)
    a.m.require(check['engineIdentity']['sha256']=='b40033dc620944f87e520d54d0a3cf69f7df73a9f82955d34dfa1a3464924a1c',
        'Use the exact published 2.0.2 OpenBLAS033 parent runtime')
    parent_rows=a.inventory(parent)[0]
    a.m.require([r for r in payload if r['path'].startswith('share/xtb/')]==
        [r for r in parent_rows if r['path'].startswith('share/xtb/')],'Raw and public-parent parameters differ')
    evidence=sorted((build/'logs').glob('*.receipt.json'))
    a.m.require(len(evidence)==4,'Four owned build command receipts required')
    for p in evidence:
        value=json.loads(p.read_text(encoding='utf-8'))
        a.m.require(value.get('passed') is True and value.get('exitCode')==0 and value.get('jobTreeEnded') is True
            and value.get('mainProcessEnded') is True and value.get('timedOut') is False,
            'Native build command did not finish successfully')
    return raw,tree,payload,check,parent_rows

def compose(root,build,parent,out,*,apply=False,node='node'):
    root=a.m.ordinary(root);build=a.m.ordinary(build);parent=a.m.ordinary(parent);out=a.m.ordinary(out)
    a.m.require(not out.exists(),'Fresh output required; existing runtimes are protected')
    for source in (build,parent):
        a.m.require(not out.is_relative_to(source) and not source.is_relative_to(out),'Composition input/output overlap')
    raw,tree,payload,check,parent_rows=validate_inputs(root,build,parent,node)
    exe=next(r for r in payload if r['path']=='bin/xtb.exe')
    build_id='es-hcap-user-'+exe['sha256'][:16]
    receipt=dict(schema='es-xtb-user-initial-velocity-composition/v1',algorithm='xtb-h-only-initial-cap-v1',
        buildId=build_id,rawBuild=raw,parentRuntime=check['record'],parentEngineIdentity=check['engineIdentity'],
        parentPayload=[r for r in parent_rows if r['path'].startswith(('bin/','share/xtb/'))],
        rawBuildReceipt={**a.identity(build/'output',build/'output/xtb-build-receipt.json'),'path':'provenance/user-raw-xtb-build.json'},
        preferredSourceTree={**raw['preferredSourceTree'],'path':'provenance/user-preferred-source-tree.json'},
        actualDynamicSourceSha256=next(r['sha256']for r in tree['files']if r['path']=='src/dynamic.f90'),
        unchangedRuntimeAndParameters=[r for r in parent_rows if r['path'].startswith(('bin/','share/xtb/'))and r['path']!='bin/xtb.exe'],
        officialBinaryIdentity=False,numericallyValidated=False,productReady=False,buildExecutedByThisTool=False)
    encoded=a.encode(receipt);copies={r['path']:parent/r['path']for r in parent_rows
        if r['path']not in ('runtime.json','inventory.json','bin/xtb.exe')}
    copies['bin/xtb.exe']=build/'output/bin/xtb.exe'
    copies['provenance/user-raw-xtb-build.json']=build/'output/xtb-build-receipt.json'
    copies['provenance/user-preferred-source-tree.json']=build/'output/preferred-source-tree.json'
    rows=[{'path':name,'bytes':p.stat().st_size,'sha256':a.identity(p.parent,p)['sha256']}for name,p in copies.items()
        if name.startswith(('bin/','share/xtb/'))];rows.sort(key=lambda r:r['path'])
    inventory=a.encode(dict(schema='sciyue-xtb-runtime-inventory/v1',files=rows))
    descriptor=dict(check['record']);descriptor['build']={**descriptor['build'],'id':build_id,'sourceReceiptSha256':a.m.digest(encoded)}
    descriptor['inventory']=dict(path='inventory.json',bytes=len(inventory),sha256=a.m.digest(inventory))
    descriptor['userBuild']=True;descriptor['officialBinaryIdentity']=False;descriptor['numericallyValidated']=False
    descriptor['productReady']=False;descriptor['readinessBasis']='structural user composition; numerical/product validation pending'
    descriptor['initialVelocityCorrection']=dict(algorithm='xtb-h-only-initial-cap-v1',ceilingTemperatureK=8000,
        scope='automatic-initial-velocities-only',elements=['H'])
    subprocess.run([node,'-e','require(process.argv[1]).validateDescriptor(JSON.parse(process.argv[2]))',
        str(root/'desktop/xtb-runtime-contract.cjs'),json.dumps(descriptor)],check=True,capture_output=True,timeout=30)
    member_path=out.with_name(out.name+'-members.json')
    a.m.require(not member_path.exists(),'Existing user runtime member manifest is protected')
    result=dict(planned=not apply,output=str(out),members=str(member_path),
        sourceReceipt=str(out/'provenance/user-initial-velocity-composition.json'),
        buildId=build_id,files=len(copies)+3,officialAcceptance=False,
        scientificAccepted=False,activationPerformed=False)
    if not apply:return result
    out.mkdir(parents=True)
    for name,p in copies.items():a.write_new(out/name,p.read_bytes())
    a.write_new(out/'provenance/user-initial-velocity-composition.json',encoded)
    a.write_new(out/'inventory.json',inventory);a.write_new(out/'runtime.json',a.encode(descriptor))
    identity=json.loads(subprocess.run([node,'-e',a.NODE_CHECK,str(root/'desktop/xtb-runtime-contract.cjs'),str(out)],
        check=True,capture_output=True,text=True,encoding='utf-8',timeout=30).stdout)['engineIdentity']
    a.write_new(member_path,a.encode(dict(schema='sy-built-xtb-members/v1',files=a.inventory(out)[0])))
    result['engineIdentity']=identity;return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source-root',type=Path,default=ROOT)
    p.add_argument('--build-root',type=Path,required=True);p.add_argument('--parent-runtime',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--apply',action='store_true');p.add_argument('--node',default='node')
    x=p.parse_args();print(json.dumps(compose(x.source_root,x.build_root,x.parent_runtime,x.output,apply=x.apply,node=x.node),indent=2))
