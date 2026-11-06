"""Plan/apply explicit same-ABI LGPL replacements in a fresh complete native copy.

This data/PE tool never compiles, imports or executes native/scientific code.
An actual downstream load test remains separate evidence, never implied by PE ABI.
"""
# This file alone: MIT, Copyright (c) 2026 Zixuan Zhang.
# See replace-native-libraries-LICENSE.txt; this does not license SY-Studio itself.
from pathlib import Path, PurePosixPath
import argparse, hashlib, json, os, re, shutil, struct
from urllib.parse import urlsplit

ALLOWED={'_internal/libtblite-0.dll':'tblite','_internal/libdftd4-4.dll':'dftd4',
         '_internal/libs-dftd3-1.dll':'s-dftd3','_internal/iconv.dll':'libiconv',
         '_internal/libquadmath-0.dll':'libquadmath',
         '_internal/charset.dll':'libiconv',
         '_internal/libmctc-lib-0.dll':'mctc-lib','_internal/libtoml-f-0.dll':'toml-f',
         '_internal/libmulticharge-0.dll':'multicharge',
         '_internal/openblas.dll':'openblas',
         '_internal/tblite/_libtblite.cp312-win_amd64.pyd':'tblite'}
SYSTEM=set('advapi32 bcrypt crypt32 gdi32 kernel32 kernelbase msvcrt ntdll ole32 oleaut32 rpcrt4 user32 version shell32 shlwapi ws2_32 wtsapi32 userenv powrprof setupapi comdlg32 comctl32 normaliz dnsapi iphlpapi winhttp wininet secur32 psapi dbghelp imm32'.split())
SCHEMA='sy-local-native-library-replacement/v1'
OPENBLAS_POLICY='openblas-034-to-033-exact-consumer-abi-a01'
OPENBLAS_BEFORE={'path':'_internal/openblas.dll','bytes':28410880,'sha256':'d0073463ce449d6bb4a3f720b1ebf8a858b49ca2e376271585a7f75f6a1795d8'}
OPENBLAS_AFTER={'path':'_internal/openblas.dll','bytes':28357632,'sha256':'ea5706aaa7e88ea76f350faf4181c5e3393817a1ce1cd800501bf3ee21f205e8'}
OPENBLAS_OMITTED={'blas_level3_thread_enter','blas_level3_thread_leave','clarft_lvl2_','dlarft_lvl2_','openblas_set_xerbla','slarft_lvl2_','zlarft_lvl2_'}
ANCILLARY_POLICY_ID='libiconv-1.18-current-host-ancillary-a02'
# Exact reviewed ancillary CRT/compiler exports, not libiconv/libcharset API.
# In particular sprintf is a public CRT function, not a private library API.
ANCILLARY={
 '_internal/iconv.dll':{'bytes':1098568,'sha256':'dde13ae784d3b916ccde2e676f7caa8dd96f23d7e20764fe1b0a8de6424dbd0d','exports':[{'ordinal':1,'names':['_Avx2WmemEnabledWeakValue'],'forwarder':None,'kind':'data'}]},
 '_internal/charset.dll':{'bytes':24904,'sha256':'a3ae42aded452a43703db8f00638550efb3a1013cf8267c475cea4c668e3ab8d','exports':[{'ordinal':1,'names':['__local_stdio_printf_options'],'forwarder':None,'kind':'code'},{'ordinal':2,'names':['_vsnprintf_l'],'forwarder':None,'kind':'code'},{'ordinal':3,'names':['_vsprintf_l'],'forwarder':None,'kind':'code'},{'ordinal':6,'names':['sprintf'],'forwarder':None,'kind':'code'}]}}

def require(ok,message):
    if not ok:raise ValueError(message)
def encode(v):return(json.dumps(v,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
def sha(data):return hashlib.sha256(data).hexdigest()
def member(p):
    require(isinstance(p,str)and p and '\\'not in p and ':'not in p,'Unsafe member')
    require(not PurePosixPath(p).is_absolute()and all(x not in('','.','..')and not x.endswith(('.', ' '))and not re.search(r'[<>"|?*\x00-\x1f]',x)for x in p.split('/')),'Unsafe member')
    require(all(not re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',x,re.I)for x in p.split('/')),'Reserved Windows member')
    return p
def ordinary(path):
    path=Path(os.path.abspath(path))
    for item in(path,*path.parents):require(not item.is_symlink()and not getattr(item,'is_junction',lambda:False)(),'Linked path refused')
    return path
def identity(root,path):
    root=ordinary(root);path=ordinary(path);require(path.is_relative_to(root)and path.is_file()and path.stat().st_nlink==1,'Ordinary independent file within root required')
    before=path.stat();h=hashlib.sha256()
    with path.open('rb')as f:
        for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
    after=path.stat();require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'File changed during read')
    return{'path':path.relative_to(root).as_posix(),'bytes':after.st_size,'sha256':h.hexdigest()}
def checked(root,ref):
    require(isinstance(ref,dict)and set(ref)=={'path','bytes','sha256'},'Exact relative file reference required');member(ref['path']);p=ordinary(Path(root)/ref['path']);require(identity(root,p)==ref,'File identity differs: '+ref['path']);return p
def read(root,ref):return json.loads(checked(root,ref).read_bytes())
def inventory(root):
    root=ordinary(root);require(root.is_dir(),'Complete native directory required');rows=[];seen=set()
    for p in sorted(root.rglob('*')):
        p=ordinary(p);rel=member(p.relative_to(root).as_posix());require(rel.casefold()not in seen,'Case-colliding member');seen.add(rel.casefold())
        require(not any(x.casefold()in{'.git','.private','.cache','state','profiles','node_modules'}for x in rel.split('/')),'Private/state input refused')
        if p.is_file():rows.append(identity(root,p))
        else:require(p.is_dir(),'Special member refused')
    return sorted(rows,key=lambda r:r['path'])
def normalized(rows):
    require(isinstance(rows,list)and rows,'Complete files required');result=[];seen=set()
    for r in rows:
        require(set(r)=={'path','bytes','sha256'}and type(r['bytes'])is int and r['bytes']>=0 and re.fullmatch('[a-f0-9]{64}',r['sha256']),'Exact member identity required');member(r['path']);require(r['path'].casefold()not in seen,'Duplicate member');seen.add(r['path'].casefold());result.append(r)
    return sorted(result,key=lambda r:r['path'])

def upstream_openblas_artifact(root,change,evidence=None):
    """Validate an actual conda-forge artifact; never call it a local build."""
    require(change.get('target')=='_internal/openblas.dll' and change.get('component')=='openblas','Upstream artifact is only admitted for the exact OpenBLAS target')
    require(not change.get('sourceEvidence') and not change.get('buildEvidence'),'Upstream artifact cannot claim local source/build evidence')
    refs=change.get('upstreamEvidence');require(isinstance(refs,list) and len(refs)==1,'One upstream artifact evidence record required')
    record=read(root,refs[0]);require(record.get('schema')=='sy-upstream-library-artifact-evidence/v1' and record.get('component')=='openblas' and record.get('kind')=='upstream-prebuilt' and record.get('localBuildExecuted') is False,'Actual upstream prebuilt evidence required')
    package=record.get('package',{});url=urlsplit(package.get('url',''));filename='libopenblas-0.3.33-pthreads_h877e47f_0.conda'
    require(url.scheme=='https' and not(url.username or url.password or url.query or url.fragment) and ((url.netloc=='conda.anaconda.org' and url.path=='/conda-forge/win-64/'+filename) or (url.netloc=='api.anaconda.org' and url.path=='/download/conda-forge/libopenblas/0.3.33/win-64/'+filename)),'Exact approved official conda-forge OpenBLAS artifact required')
    payload=member(record.get('payloadRoot',''));metadata=record.get('metadata',{});binary=record.get('member',{})
    require(set(metadata)=={'index','about','paths'},'Exact extracted metadata slots required')
    require(package['archive']['path'].split('/')[-1]==filename,'Upstream archive filename differs')
    require(binary.get('path')=='Library/bin/openblas.dll' and binary.get('file')==change.get('file') and binary['file']['path']==payload+'/Library/bin/openblas.dll','Upstream installed member differs')
    for key in ('index','about','paths'):require(metadata.get(key,{}).get('path')==payload+'/info/'+key+'.json','Actual extracted package metadata required')
    index=read(root,metadata['index']);about=read(root,metadata['about']);paths=read(root,metadata['paths']);official=read(root,package['officialMetadata'])
    require(index.get('name')=='libopenblas' and index.get('version')=='0.3.33' and index.get('build')=='pthreads_h877e47f_0' and index.get('subdir')=='win-64','Extracted package identity differs')
    require(official.get('basename')=='win-64/'+filename and official.get('sha256')==package['archive']['sha256'] and official.get('size')==package['archive']['bytes'],'Official package record/archive identity differs')
    rows=[row for row in paths.get('paths',[])if row.get('_path')==binary['path']]
    require(len(rows)==1 and rows[0].get('sha256')==binary['file']['sha256'] and rows[0].get('size_in_bytes')==binary['file']['bytes'],'Extracted member differs from actual info/paths.json')
    licenses=record.get('licenseFiles');require(isinstance(licenses,list) and licenses and isinstance(about.get('license'),str) and about['license'].strip(),'Actual upstream license metadata/files required')
    require(all(ref['path'].startswith(payload+'/info/licenses/') for ref in licenses),'License file escaped actual package license tree')
    actual=[{**row,'path':payload+'/info/licenses/'+row['path']}for row in inventory(Path(root)/payload/'info/licenses')]
    require(normalized(licenses)==normalized(actual),'Actual complete upstream license files differ')
    all_refs=[*refs,package['archive'],package['officialMetadata'],*metadata.values(),binary['file'],*licenses]
    for key in ('candidateReceipt','matrixReceipt','compatibilityEvidence'):
        if record.get(key):all_refs.append(record[key])
    for ref in all_refs:
        checked(root,ref)
        if evidence is not None:evidence[ref['path']]=ref
    return record

def openblas_pair(before,after):return before==OPENBLAS_BEFORE and after==OPENBLAS_AFTER

def pe_info(path):
    """Read only x64 PE imports (including delay imports) and named/ordinal exports."""
    data=ordinary(path).read_bytes()
    def unpack(fmt,offset):
        require(0<=offset and offset+struct.calcsize(fmt)<=len(data),'Truncated PE');return struct.unpack_from(fmt,data,offset)
    def string(offset):
        require(0<=offset<len(data),'Invalid PE string');end=data.find(b'\0',offset,min(len(data),offset+65536));require(end>=0,'Unterminated PE string');return data[offset:end].decode('ascii')
    require(data[:2]==b'MZ','PE DOS signature required');base=unpack('<I',60)[0];require(data[base:base+4]==b'PE\0\0','PE signature required')
    machine,count,_,_,_,optional_size,_=unpack('<HHIIIHH',base+4);optional=base+24
    require(machine==0x8664 and unpack('<H',optional)[0]==0x20b,'Same x64 PE32+ ABI required')
    imagebase=unpack('<Q',optional+24)[0];sections=[]
    for i in range(count):
        off=optional+optional_size+40*i;virtual_size,va,size,raw=unpack('<IIII',off+8);sections.append((va,max(virtual_size,size),raw,size,unpack('<I',off+36)[0]))
    def rva(value):
        for va,length,raw,size,flags in sections:
            if va<=value<va+length:require(value-va<size,'PE RVA outside raw section');return raw+value-va
        require(value<unpack('<I',optional+60)[0],'Unmapped PE RVA');return value
    dirs=unpack('<I',optional+108)[0]
    def directory(index):return unpack('<II',optional+112+8*index)if index<dirs else(0,0)
    exports=[];export_rva,export_size=directory(0)
    if export_rva:
        off=rva(export_rva);_,_,_,_,_,ordinal_base,nfunc,nnames,funcs,names,ordinals=unpack('<IIHHIIIIIII',off)
        require(nfunc<=1000000 and nnames<=nfunc,'Invalid export count');byordinal={}
        for i in range(nnames):
            name=string(rva(unpack('<I',rva(names)+4*i)[0]));ordinal=unpack('<H',rva(ordinals)+2*i)[0];require(ordinal<nfunc,'Invalid export ordinal');byordinal.setdefault(ordinal,[]).append(name)
        for i in range(nfunc):
            address=unpack('<I',rva(funcs)+4*i)[0]
            if address:
                forwarder=string(rva(address))if export_rva<=address<export_rva+export_size else None
                kind='forwarder'if forwarder else next(('code'if flags&0x20000000 else'data'for va,length,_,_,flags in sections if va<=address<va+length),None)
                require(kind is not None,'Export address outside PE sections');exports.append({'ordinal':ordinal_base+i,'names':sorted(byordinal.get(i,[])),'forwarder':forwarder,'kind':kind})
    imports=[]
    for index,delay in((1,False),(13,True)):
        address,size=directory(index)
        if not address:continue
        off=rva(address);step=32 if delay else 20
        for i in range(4096):
            fields=unpack('<8I'if delay else'<5I',off+i*step)
            if not any(fields):break
            if delay:
                attr,name,_,_,table,*_=fields;convert=lambda v:v if attr&1 else v-imagebase
                name=convert(name);table=convert(table)
            else:table,_,_,name,iat=fields;table=table or iat
            dll=string(rva(name));symbols=[]
            for j in range(1000000):
                thunk=unpack('<Q',rva(table)+8*j)[0]
                if not thunk:break
                symbols.append({'ordinal':thunk&0xffff}if thunk>>63 else{'name':string(rva(thunk)+2)})
            else:raise ValueError('Unbounded PE thunk table')
            imports.append({'dll':dll,'kind':'delay-import'if delay else'import','symbols':symbols})
        else:raise ValueError('Unbounded PE import table')
    return{'machine':machine,'exports':exports,'imports':imports}

def validate_abi(before,after,available,before_identity=None,after_identity=None):
    require(before['machine']==after['machine']==0x8664,'Machine ABI differs')
    profile=ANCILLARY.get((before_identity or{}).get('path'))
    if profile and any(before_identity.get(k)!=profile[k]for k in('bytes','sha256')):profile=None
    exceptions=[];openblas=openblas_pair(before_identity,after_identity)
    old={r['ordinal']:r for r in before['exports']};new={r['ordinal']:r for r in after['exports']};named={name:r for r in after['exports']for name in r['names']}
    for ordinal,row in old.items():
        if profile and row in profile['exports']and not any(name in named for name in row['names']):exceptions.append(row);continue
        if openblas and row['names'] and set(row['names'])<=OPENBLAS_OMITTED and not any(name in named for name in row['names']):exceptions.append(row);continue
        if row['names']:require(all(name in named and named[name]['forwarder']==row['forwarder']and named[name].get('kind')==row.get('kind')and(not profile or named[name]['ordinal']==ordinal)for name in row['names']),'Required parent export lost/reassigned')
        else:require(ordinal in new and row['forwarder']==new[ordinal]['forwarder']and row.get('kind')==new[ordinal].get('kind'),'Required ordinal-only export lost/reassigned')
    if openblas:require({name for row in exceptions for name in row['names']}==OPENBLAS_OMITTED,'Exact approved seven OpenBLAS omissions required')
    for row in after['imports']:
        name=row['dll'].casefold();stem=name.removesuffix('.dll')
        require(name in available or stem in SYSTEM or stem.startswith(('api-ms-win-','ext-ms-win-')),'Undeclared/non-Windows dependency: '+name)
    for row in after['exports']:
        if row['forwarder']:
            name=row['forwarder'].rsplit('.',1)[0].casefold();require(name+'.dll'in available or name in SYSTEM or name.startswith(('api-ms-win-','ext-ms-win-')),'Undeclared export forwarder dependency')
    return exceptions

def validate_consumer_exports(abi,symbols):
    exceptions=abi.get('ancillaryExportExceptions',[])+abi.get('openblasExportExceptions',[]);omitted_names={n for e in exceptions for n in e['names']};omitted_ordinals={e['ordinal']for e in exceptions}
    require(not any(s.get('name')in omitted_names if'name'in s else s['ordinal']in omitted_ordinals for s in symbols),'Current consumer uses an exempted ancillary export')
    exports=abi['replacement']['exports'];names={n for e in exports for n in e['names']};ordinals={e['ordinal']for e in exports}
    require(all(s.get('name')in names if'name'in s else s['ordinal']in ordinals for s in symbols),'Current consumer required export is absent')
    for symbol in symbols:
        if 'ordinal'in symbol:
            old=next((e for e in abi['parent']['exports']if e['ordinal']==symbol['ordinal']),None);new=next(e for e in exports if e['ordinal']==symbol['ordinal'])
            require(old and set(old['names'])<=set(new['names'])and old['forwarder']==new['forwarder']and old.get('kind')==new.get('kind'),'Current consumer ordinal binding changed')

def plan(source_root,parent_native,parent_receipt,receipt_root,overlay,manifest_path,out,run_id,apply=False):
    root=ordinary(source_root);native=ordinary(parent_native);origin=ordinary(receipt_root);overlay=ordinary(overlay);out=ordinary(out)
    require(re.fullmatch('[a-z][a-z0-9-]{0,40}',run_id),'ASCII local ID required');require(not out.exists(),'Fresh output required')
    for p in(root,native,overlay):require(not out.is_relative_to(p)and not p.is_relative_to(out),'Input/output overlap refused')
    snapshot=json.loads((root/'source-native-identity.json').read_bytes());require(snapshot['schema']=='sy-source-native-identity/v1','Exported native source identity required')
    receipt_path=ordinary(parent_receipt);require(receipt_path.is_relative_to(origin),'Parent receipt must belong to explicit receipt root');parent_ref=identity(origin,receipt_path);parent=read(origin,parent_ref)
    candidate=parent.get('schema')=='sciyue-native-candidate-v1';local=parent.get('schema')=='sy-local-native-self-build/v1'
    require(candidate and parent.get('passed')is True and parent.get('status')=='built-not-scientifically-validated'or local and parent.get('buildSucceeded')is True and parent.get('officialAcceptance')is False and parent.get('scientificAccepted')is False,'Actual successful parent build receipt required')
    parent_files=inventory(native);require(parent_files==normalized(parent['files']),'Parent native receipt membership differs')
    for key in('sourceFiles','builderSources'):
        require(parent[key]==snapshot[key],'Parent/source identity differs')
        for row in snapshot[key]:checked(root,row)
    contract_ref=parent['buildContract']if candidate else parent['sourceContract'];contract=read(origin,contract_ref);require(contract.get('schema')=='sciyue-native-build-contract-v2','Actual parent build contract required')
    for key in('sourceFiles','builderSources'):require(contract[key]==snapshot[key],'Parent contract/source identity differs')
    profile=read(origin,contract['profile']);require(profile.get('backend')=='OpenBLAS'and profile.get('nativeSources')==[r['path']for r in snapshot['sourceFiles']],'Parent profile differs')
    if candidate and 'profile'in parent:require(parent['profile']==contract['profile'],'Parent receipt/profile binding differs')
    manifest_path=ordinary(manifest_path);require(manifest_path.is_relative_to(overlay),'Replacement manifest belongs to overlay root');manifest_ref=identity(overlay,manifest_path);manifest=read(overlay,manifest_ref)
    require(manifest.get('schema')=='sy-native-library-replacement-input/v1','Explicit replacement input required');changes=manifest['replacements'];require(changes,'Nonempty replacement set required')
    baseline={r['path']:r for r in parent_files};declared=set();delta=[];evidence={};pe_cache={}
    def pe(path):
        key=str(path)
        if key not in pe_cache:pe_cache[key]=pe_info(path)
        return pe_cache[key]
    available={Path(r['path']).name.casefold()for r in parent_files if r['path'].casefold().endswith(('.dll','.pyd','.exe'))}
    for change in changes:
        target=member(change['target']);require(target in ALLOWED and target in baseline and target not in declared,'Only unique existing whitelisted LGPL/support targets are replaceable');declared.add(target)
        require(change['component']==ALLOWED[target],'Replacement component/owner differs');replacement=checked(overlay,change['file']);after={**change['file'],'path':target};require(after!=baseline[target],'Replacement must change actual bytes')
        if change.get('upstreamEvidence'):
            upstream_openblas_artifact(overlay,change,evidence)
            evidence_fields={'upstreamEvidence':change['upstreamEvidence']}
        else:
            require(change.get('sourceEvidence')and change.get('buildEvidence'),'Actual source and build evidence required')
            for kind in('sourceEvidence','buildEvidence'):
                for ref in change[kind]:checked(overlay,ref);evidence[ref['path']]=ref
            source_record=read(overlay,change['sourceEvidence'][0]);build_record=read(overlay,change['buildEvidence'][0])
            require(source_record.get('schema')=='sy-local-library-source-evidence/v1'and source_record.get('component')==change['component'],'Explicit preferred-source evidence required')
            require(build_record.get('schema')=='sy-local-library-build-evidence/v1'and build_record.get('component')==change['component']and build_record.get('sourceEvidenceSha256')==change['sourceEvidence'][0]['sha256']and build_record.get('exitCode')==0 and change['file']in build_record.get('outputs',[]),'Actual successful source-bound library build evidence required')
            for key in('sourceFiles','recipeFiles'):
                require(source_record.get(key),'Complete preferred-source/recipe references required')
                for ref in source_record[key]:checked(overlay,ref);evidence[ref['path']]=ref
            source_prefix=member(source_record['sourceRoot']);source_rows=[{**row,'path':source_prefix+'/'+row['path']}for row in inventory(overlay/source_prefix)]
            require(source_rows==normalized(source_record['sourceFiles']),'Complete actual preferred source tree differs')
            require(isinstance(build_record.get('commands'),list)and build_record['commands']and all(isinstance(c,list)and c and all(isinstance(arg,str)for arg in c)for c in build_record['commands']),'Actual build commands required')
            require(build_record.get('toolIdentities')and all(isinstance(t.get('name'),str)and isinstance(t.get('version'),str)and re.fullmatch('[a-f0-9]{64}',t.get('sha256',''))for t in build_record['toolIdentities']),'Explicit actual tool identities required')
            for ref in source_record.get('patchFiles',[]):checked(overlay,ref);evidence[ref['path']]=ref
            evidence_fields={key:change[key]for key in('sourceEvidence','buildEvidence')}
        before_pe=pe(native/target);after_pe=pe(replacement);exceptions=validate_abi(before_pe,after_pe,available,baseline[target],after)
        blas_exceptions=exceptions if openblas_pair(baseline[target],after) else[];ancillary_exceptions=[]if blas_exceptions else exceptions
        if blas_exceptions:
            record=upstream_openblas_artifact(overlay,change,evidence);require(record.get('compatibilityEvidence'),'Actual consumer/source lookup evidence required for OpenBLAS exception');review=read(overlay,record['compatibilityEvidence'])
            require(review.get('schema')=='ester-openblas-consumer-abi-review/v1' and review.get('beforeSha256')==OPENBLAS_BEFORE['sha256'] and review.get('afterSha256')==OPENBLAS_AFTER['sha256'] and set(review.get('missingExports',[]))==OPENBLAS_OMITTED and review.get('peMissingReferences')==[] and review.get('sourceLookupMissingReferences')==[],'OpenBLAS actual-consumer/source evidence differs')
        licenses=[r for r in parent_files if r['path'].startswith('licenses/')];require(licenses,'Parent licenses required')
        delta.append({'target':target,'component':change['component'],'before':baseline[target],'after':after,'file':change['file'],**evidence_fields,'abi':{'parent':before_pe,'replacement':after_pe,'consumers':[],'compatible':True,'compatibilityScope':'current-host-public-api-and-consumers','fullParentExportEquivalence':all(row in after_pe['exports']for row in before_pe['exports']),'ancillaryPolicy':ANCILLARY_POLICY_ID if ancillary_exceptions else None,'ancillaryExportExceptions':ancillary_exceptions,**({'openblasExportPolicy':OPENBLAS_POLICY,'openblasExportExceptions':blas_exceptions}if blas_exceptions else{}),'actualLoadValidated':False}})
    pyd='_internal/tblite/_libtblite.cp312-win_amd64.pyd'
    require(pyd not in declared or '_internal/libtblite-0.dll'in declared,'tblite pyd requires its explicitly paired library replacement')
    require('_internal/charset.dll'not in declared or '_internal/iconv.dll'in declared,'charset requires its explicitly paired iconv replacement')
    support={'_internal/libmctc-lib-0.dll','_internal/libtoml-f-0.dll','_internal/libmulticharge-0.dll'}
    require(not declared&support or declared&{'_internal/libtblite-0.dll','_internal/libdftd4-4.dll','_internal/libs-dftd3-1.dll'},'Fortran support changes require an explicit main-library replacement set')
    # Resolve all original downstream consumers against each changed export set.
    for row in parent_files:
        if not row['path'].casefold().endswith(('.dll','.pyd','.exe','.obf')):continue
        images=[('parent',pe(native/row['path']))]
        if row['path']in declared:images.append(('replacement',pe(checked(overlay,next(c['file']for c in changes if c['target']==row['path'])))))
        for image,consumer in images:
            for imp in consumer['imports']:
                matching=[d for d in delta if Path(d['target']).name.casefold()==imp['dll'].casefold()]
                if not matching:continue
                require(len(matching)==1,'Ambiguous modified import owner');validate_consumer_exports(matching[0]['abi'],imp['symbols'])
                matching[0]['abi']['consumers'].append({'path':row['path'],'image':image,'symbols':imp['symbols']})
            forwarded={}
            for export in consumer['exports']:
                if not export.get('forwarder'):continue
                module,symbol=export['forwarder'].rsplit('.',1);module=module.casefold();module=module if module.endswith('.dll')else module+'.dll'
                matching=[d for d in delta if Path(d['target']).name.casefold()==module]
                if not matching:continue
                require(len(matching)==1,'Ambiguous modified forwarder owner');symbols=forwarded.setdefault(matching[0]['target'],[]);symbols.append({'ordinal':int(symbol[1:])}if symbol.startswith('#')else{'name':symbol})
            for target,symbols in forwarded.items():
                item=next(d for d in delta if d['target']==target);validate_consumer_exports(item['abi'],symbols);item['abi']['consumers'].append({'path':row['path'],'image':image,'kind':'export-forwarder','symbols':symbols})
    result_files=[next(d['after']for d in delta if d['target']==r['path'])if r['path']in declared else r for r in parent_files]
    change_digest=sha(json.dumps([{'target':d['target'],'before':d['before'],'after':d['after']}for d in sorted(delta,key=lambda d:d['target'])],sort_keys=True,separators=(',',':')).encode())
    receipt={'schema':SCHEMA,'id':run_id,'kind':'explicit-user-modified-shared-library','parentReceipt':parent_ref,'parentContract':contract_ref,'inputManifest':manifest_ref,'sourceFiles':snapshot['sourceFiles'],'builderSources':snapshot['builderSources'],'files':result_files,'replacements':delta,'componentIdentitySha256':change_digest,'officialAcceptance':False,'scientificAccepted':False,'publicDistributionApproved':False,'buildExecuted':False,'actualLoadValidated':False,'output':'native'}
    result={'schema':'sy-native-library-replacement-plan/v1','planned':not apply,'receipt':receipt,'output':str(out),'scientificExecution':False}
    if not apply:return result
    out.mkdir(parents=True)
    for row in parent_files:
        source=checked(overlay,next(d['file']for d in delta if d['target']==row['path']))if row['path']in declared else checked(native,row)
        destination=out/'native'/row['path'];destination.parent.mkdir(parents=True,exist_ok=True)
        with source.open('rb')as src,destination.open('xb')as dst:shutil.copyfileobj(src,dst,1024*1024)
    require(inventory(out/'native')==result_files,'Copied native membership differs')
    proofs=out/'proof';proofs.mkdir()
    def copyproof(scope,ref,prefix):
        destination=proofs/prefix/ref['path'];destination.parent.mkdir(parents=True,exist_ok=True)
        with checked(scope,ref).open('rb')as src,destination.open('xb')as dst:shutil.copyfileobj(src,dst,1024*1024)
        actual=identity(out,destination);require((actual['bytes'],actual['sha256'])==(ref['bytes'],ref['sha256']),'Copied proof differs');return actual
    receipt['parentReceipt']=copyproof(origin,parent_ref,'parent');receipt['parentContract']=copyproof(origin,contract_ref,'parent');copyproof(origin,contract['profile'],'parent')
    receipt['parentReceiptRoot']='proof/parent';receipt['inputManifest']=copyproof(overlay,manifest_ref,'replacement')
    for ref in evidence.values():copyproof(overlay,ref,'replacement')
    receipt['evidenceRoot']='proof/replacement'
    # Parent contract and receipt references retain their original relative paths
    # under the dedicated copied proof root; no private absolute path is emitted.
    for ref in(parent_ref,contract_ref):checked(origin,ref)
    for row in parent_files:checked(native,row)
    for ref in evidence.values():checked(overlay,ref)
    checked(overlay,manifest_ref)
    receipt_path=out/'replacement-receipt.json';receipt_path.write_bytes(encode(receipt));result['receiptPath']=str(receipt_path);return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in('source-root','parent-native','parent-receipt','receipt-root','overlay','manifest','out'):p.add_argument('--'+name,required=True,type=Path)
    p.add_argument('--id',required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
    print(json.dumps(plan(a.source_root,a.parent_native,a.parent_receipt,a.receipt_root,a.overlay,a.manifest,a.out,a.id,a.apply),indent=2,ensure_ascii=False))
