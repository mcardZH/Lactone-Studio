"""Data-only ASE source overlay derivation for an exported source copy.

Does not activate a lock, import a scientific library, install or build anything.
The consumer must validate the parent/overlay chain before accepting the result.
"""
from pathlib import Path,PurePosixPath
import argparse,hashlib,json,os,re,shutil

def require(value,message):
    if not value:raise ValueError(message)

def digest(data):return hashlib.sha256(data).hexdigest()
def encode(value):return(json.dumps(value,indent=2)+'\n').encode('utf-8')
def regular(root,path):
    root=Path(os.path.abspath(root));path=Path(os.path.abspath(path));require(path.is_relative_to(root),'Path escaped declared root')
    for parent in(path,*path.parents):
        require(not parent.is_symlink()and not getattr(parent,'is_junction',lambda:False)(),'Linked path refused')
        if parent==root:break
    require(path.is_file()and path.stat().st_nlink==1,'Ordinary unlinked input required')
    return path

def member(value):
    require(isinstance(value,str)and value and '\\'not in value and ':'not in value,'Unsafe member')
    p=PurePosixPath(value);require(not p.is_absolute()and all(x not in('','.','..')for x in value.split('/')),'Unsafe member')
    require(all(not part.endswith(('.', ' '))and not re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',part,re.I)and not any(c in part for c in '<>"|?*')and not any(ord(c)<32 for c in part)for part in p.parts),'Unsafe Windows member')
    return value

def identity(root,path):
    p=regular(root,path);data=p.read_bytes();return{'path':p.relative_to(root).as_posix(),'bytes':len(data),'sha256':digest(data)}

def load(root,path,expected=None):
    p=regular(root,path);data=p.read_bytes()
    if expected:require(len(data)==expected['bytes']and digest(data)==expected['sha256'],'Input identity changed')
    return json.loads(data),data

def derive(source_root,overlay,run_id,write=False):
    root=Path(os.path.abspath(source_root));overlay=Path(os.path.abspath(overlay))
    require(not(root/'.git').exists(),'Use an independent exported source copy, not the maintained Git checkout')
    require((root/'source-export-manifest.json').is_file()and(root/'source-native-identity.json').is_file(),'Exported source identity files required')
    require(re.fullmatch('[a-z][a-z0-9-]{0,40}',run_id),'Fresh ASCII local modification ID required')
    lock_path=root/'desktop/packaging/native-runtime.lock.json';base,lock_bytes=load(root,lock_path)
    require(base['schema']=='sciyue-native-runtime-lock-v1'and base['platform']=='win32-x64','Wrong runtime schema')
    base_root=root/member(base['root']);inv_path=root/member(base['inventory']['path'])
    require(base_root.is_relative_to(root/'.local/dependencies/win-x64')and inv_path.is_relative_to(base_root),'Wrong base runtime family')
    inventory,_=load(root,inv_path,base['inventory']);require(all(inventory[k]==base[k]for k in('schema','root','lockId')),'Base inventory ownership differs')
    rows={member(r['path']):dict(r)for r in inventory['files']};require(len(rows)==len(inventory['files']),'Duplicate base runtime member')
    owners=[k for k,p in base['packages'].items()if p['name'].lower()=='ase'];require(len(owners)==1,'Unambiguous ASE package owner required');owner=owners[0]
    require(overlay.is_dir()and not overlay.is_symlink()and not getattr(overlay,'is_junction',lambda:False)(),'Ordinary overlay directory required')
    changes=[];payloads={}
    for path in sorted(overlay.rglob('*')):
        require(not path.is_symlink()and not getattr(path,'is_junction',lambda:False)(),'Overlay links refused')
        if not path.is_file():continue
        relative=member(path.relative_to(overlay).as_posix());require(relative.startswith('ase/')and relative.endswith('.py'),'Only ASE preferred Python source overlays are admitted')
        destination='python/Lib/site-packages/'+relative;old=rows.get(destination)
        require(old is not None and old.get('owner')==owner,'Only existing ASE-owned Python sources may be replaced; no new/deleted members')
        data=regular(overlay,path).read_bytes();after={'bytes':len(data),'sha256':digest(data)}
        if old and all(old[k]==after[k]for k in('bytes','sha256')):continue
        before={k:old[k]for k in('bytes','sha256')}
        changes.append({'path':destination,'before':before,'after':after,'owner':owner});payloads[destination]=data
        rows[destination]={**old,**after}
    require(changes,'Overlay makes no ASE source change')
    dlls=lambda values:sorted([{k:r[k]for k in('path','bytes','sha256')}for r in values if r['path'].startswith('python/Library/bin/')and r['path'].lower().endswith('.dll')],key=lambda r:r['path'])
    require(dlls(rows.values())==dlls(inventory['files']),'A Python overlay must leave every Library/bin DLL unchanged')
    derived_relative='.local/dependencies/win-x64/native-local-ase-'+run_id;derived=root/derived_relative
    require(not derived.exists(),'Fresh derived payload required; no overwrite/resume')
    lock_id='native-local-ase-'+run_id
    local={'component':'ase','upstreamVersion':base['packages'][owner]['version'],'kind':'user-modified-preferred-Python-source','officialAcceptance':False}
    packages=json.loads(json.dumps(base['packages']));packages[owner]['localModification']=local
    derived_inventory={**inventory,'root':derived_relative,'lockId':lock_id,'packages':packages,'files':list(rows.values()),'localModification':local,'publicDistributionApproved':False,'officialAcceptance':False}
    derived_inventory.pop('inventory',None);inv_bytes=encode(derived_inventory)
    new_inventory={'path':derived_relative+'/inventory.json','bytes':len(inv_bytes),'sha256':digest(inv_bytes)}
    parent_ref={'path':derived_relative+'/parent-runtime.lock.json','bytes':len(lock_bytes),'sha256':digest(lock_bytes)}
    derivation={'schema':'sy-ase-source-overlay-derivation/v1','component':'ase','parentRef':parent_ref,'parentLockId':base['lockId'],'parentInventory':base['inventory'],'derivedRoot':derived_relative,'derivedLockId':lock_id,'derivedInventory':new_inventory,'overlay':changes,'unchangedLibraryDlls':dlls(inventory['files']),'officialAcceptance':False,'publicDistributionApproved':False}
    derivation_bytes=encode(derivation);derivation_ref={'path':derived_relative+'/derivation.json','bytes':len(derivation_bytes),'sha256':digest(derivation_bytes)}
    new_lock={**base,'root':derived_relative,'lockId':lock_id,'packages':packages,'inventory':new_inventory,'localModification':local,'derivation':derivation_ref,'publicDistributionApproved':False,'officialAcceptance':False};new_lock.pop('files',None)
    plan={'schema':'sy-ase-source-overlay-plan/v1','activeLockChanged':False,'writesRequested':write,'derivedLockPath':derived_relative+'/derived-runtime.lock.json','parentRef':parent_ref,'parentInventory':base['inventory'],'derivedInventory':new_inventory,'derivation':derivation_ref,'overlay':changes,'basePayloadBytes':sum(row['bytes']for row in inventory['files']),'derivedPayloadBytes':sum(row['bytes']for row in derived_inventory['files']),'unchangedLibraryDllCount':len(derivation['unchangedLibraryDlls']),'consumerValidationRequired':'The native recipe consumer must validate parentRef, parent inventory, exact ASE-only delta and unchanged DLL identities. This script does not remove sourceLockIds checks.','scientificCodeExecuted':False,'buildExecuted':False}
    if write:
        # Recheck before any output. Only exact locked baseline bytes are copied.
        require(regular(root,lock_path).read_bytes()==lock_bytes,'Active baseline changed during planning')
        for row in inventory['files']:
            p=regular(base_root,base_root/row['path']);b=p.read_bytes();require(len(b)==row['bytes']and digest(b)==row['sha256'],'Base member changed: '+row['path'])
        derived.mkdir(parents=True)
        for row in inventory['files']:
            source=regular(base_root,base_root/row['path']);target=derived/row['path'];target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        for name,data in payloads.items():
            target=derived/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
        for name,data in [('parent-runtime.lock.json',lock_bytes),('inventory.json',inv_bytes),('derivation.json',derivation_bytes),('derived-runtime.lock.json',encode(new_lock))]:
            with(derived/name).open('xb')as stream:stream.write(data)
        for row in derived_inventory['files']:
            b=regular(derived,derived/row['path']).read_bytes();require(len(b)==row['bytes']and digest(b)==row['sha256'],'Derived byte mismatch')
    return plan

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source-root',type=Path,required=True);p.add_argument('--overlay',type=Path,required=True);p.add_argument('--id',required=True);p.add_argument('--write',action='store_true');a=p.parse_args()
    print(json.dumps(derive(a.source_root,a.overlay,a.id,a.write),indent=2))
if __name__=='__main__':main()
