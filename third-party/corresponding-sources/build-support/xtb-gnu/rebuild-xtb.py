"""Build the complete pinned xTB preferred source, not just its GNU DLLs.

No network, installer, product lock edits or scientific execution. User source
modifications are recorded and create an independent local output identity.
"""
from pathlib import Path,PurePosixPath
import argparse,hashlib,json,os,re,shutil,struct,subprocess,sys,tarfile,time,zipfile

def identity(p):
 with p.open('rb') as f:h=hashlib.file_digest(f,'sha256').hexdigest()
 return {'bytes':p.stat().st_size,'sha256':h}
def safe(name):
 p=PurePosixPath(name)
 if p.is_absolute() or '..' in p.parts or ':' in name or '\\' in name:raise ValueError('Unsafe member '+name)
 return p
def unpack_zip(archive,dest):
 with zipfile.ZipFile(archive) as z:
  for m in z.infolist():
   safe(m.filename)
   if (m.external_attr>>16)&0o170000==0o120000:raise ValueError('Tool symlink refused')
  z.extractall(dest)
def unpack_source(archive,dest):
 with tarfile.open(archive,'r:gz') as tf:
  for m in tf:
   parts=safe(m.name).parts[1:]
   if not parts:continue
   target=dest.joinpath(*parts)
   if not target.resolve().is_relative_to(dest.resolve()):raise ValueError('Source escaped destination')
   if m.isdir():target.mkdir(parents=True,exist_ok=True)
   elif m.isfile():
    target.parent.mkdir(parents=True,exist_ok=True)
    with tf.extractfile(m) as source,target.open('xb') as out:shutil.copyfileobj(source,out)
   else:raise ValueError('Source link/special member refused')
def main():
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['plan','prepare','build']);p.add_argument('--index',type=Path,default=Path(__file__).resolve().parents[2]/'XTB-GNU-SOURCE-INDEX.json');p.add_argument('--archive-dir',type=Path,action='append',default=[]);p.add_argument('--work-root',type=Path,required=True);p.add_argument('--gnu-runtime-bin',type=Path,required=True);p.add_argument('--runtime-source-receipt',type=Path,required=True);p.add_argument('--math-bin',type=Path,required=True);p.add_argument('--jobs',type=int,default=4);p.add_argument('--memory-gib',type=int,default=8);p.add_argument('--max-seconds',type=int,default=5400);p.add_argument('--local-modified',action='store_true');p.add_argument('--build-name',default='5071a886-local-gnu132-source-rebuild');a=p.parse_args()
 if not 1<=a.jobs<=8 or not 1<=a.memory_gib<=16 or not 1<=a.max_seconds<=5400:raise ValueError('Invalid bounded resources')
 W=a.work_root.resolve();base=a.index.resolve().parent;index=json.loads(a.index.read_text());source=W/'source';B=W/'tools/winlibs/mingw64/bin';meson=W/'tools/meson';out=W/'output';mathdir=a.math_bin.resolve();runtime=a.gnu_runtime_bin.resolve();here=Path(__file__).resolve().parent
 if any(not re.fullmatch(r'[A-Za-z0-9_.-]+',part) for part in W.parts[1:]):raise ValueError('Use a new ASCII work-root with letters/digits/dot/underscore/hyphen')
 if not re.fullmatch(r'[A-Za-z0-9_.-]+',a.build_name):raise ValueError('Use an ASCII build name')
 treepin=index['preferredSourceTree'];tp=base/treepin['path'];assert identity(tp)=={k:treepin[k] for k in ['bytes','sha256']};tree=json.loads(tp.read_text());overlaypin=index['buildOverlays'];op=base/overlaypin['path'];assert identity(op)=={k:overlaypin[k] for k in ['bytes','sha256']};overlays=json.loads(op.read_text())['buildOnlyOverlays']
 assert identity(mathdir/'openblas.dll')=={k:index['openblas'][k] for k in ['bytes','sha256']},'Primary recipe preserves the exact LP64 OpenBLAS'
 vc=mathdir/'VCRUNTIME140.dll';assert identity(vc)=={k:index['vcRuntime'][k] for k in ['bytes','sha256']},'Primary recipe preserves the matching app-local VC runtime'
 names=['libgcc_s_seh-1.dll','libgfortran-5.dll','libgomp-1.dll','libquadmath-0.dll','libwinpthread-1.dll','libdl.dll'];assert all((runtime/n).is_file() for n in names),'Build/obtain the matched GNU runtime set first'
 rt=json.loads(a.runtime_source_receipt.read_text());rtrows=rt.get('runtimeFiles') if rt.get('schema')=='sy-gnu-runtime-user-rebuild-v1' else ([x['binary'] for x in rt['runtimeRebuilds']] if rt.get('schema')=='sy-xtb-r2-source-receipt-v1' else None)
 if rtrows is None:raise ValueError('Supply the GNU runtime build/source receipt, not a product lock or a DLL list alone')
 for n in names:
  pin=next((x for x in rtrows if Path(x['path']).name.casefold()==n.casefold()),None);assert pin and identity(runtime/n)=={k:pin[k] for k in ['bytes','sha256']},'Runtime source receipt does not bind selected DLL: '+n
 inputs={}
 if a.mode in ['plan','prepare']:
  for pin in index['sourceArchives']+index['bootstrapToolsNotBundled']:
   name=pin.get('archiveName',pin.get('name'));candidates=([base/pin['path']] if 'path' in pin else [])+[d/name for d in a.archive_dir];f=next((f.resolve() for f in candidates if f.is_file()),None)
   if not f:raise FileNotFoundError('Exact archive missing: '+name)
   assert identity(f)=={k:pin[k] for k in ['bytes','sha256']},name;inputs[name]=f
 if a.mode=='plan':
  print(json.dumps({'mainCommit':index['mainCommit'],'sourceArchives':12,'preferredSourceFiles':len(tree['files']),'scientificSourceFilesUnchanged':947,'buildOnlyOverlays':38,'workRoot':str(W),'meson':'1.4.1','ninja':'1.12.0','compiler':'GCC/gfortran13.2.0 UCRT','stackReserve':67108864,'stackCommit':4096,'nativeCommandsExecuted':False,'actions':['materialize all pinned sources and exact build-only overlays','generate OpenBLAS import library from unchanged LP64 DLL','Meson nodownload static subprojects; explicit shared OpenBLAS','Ninja xtb.exe only','assemble executable, six unchanged params and selected runtime; emit local source/member receipt']},indent=2));return
 if os.name!='nt':raise RuntimeError('Native Windows x64 recipe')
 if a.mode=='prepare':
  if W.exists():raise FileExistsError('prepare requires a fresh work-root')
  for folder in ['source','tools/winlibs','tools/meson','logs','controls','home','temp','openblas','empty-pkgconfig']:(W/folder).mkdir(parents=True,exist_ok=True)
  for pin in index['sourceArchives']:unpack_source(inputs[pin['archiveName']],source/pin['materializePrefix'])
  for ov in overlays:
   target=source/ov['targetPath'];raw=target.read_bytes() if target.exists() else b'';assert hashlib.sha256(raw).hexdigest()==ov['beforeSha256'];origin=base/ov['overlayPath'];assert identity(origin)=={'bytes':ov['bytes'],'sha256':ov['afterSha256']};target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(origin,target)
  for row in tree['files']:assert identity(source/row['path'])=={k:row[k] for k in ['bytes','sha256']}
  winzip=next(f for name,f in inputs.items() if name.startswith('winlibs-'));wheel=next(f for name,f in inputs.items() if name.startswith('meson-'));unpack_zip(winzip,W/'tools/winlibs');unpack_zip(wheel,meson)
  tools=[{'path':f.relative_to(W).as_posix(),**identity(f)} for root in [W/'tools'] for f in root.rglob('*') if f.is_file()]
  (W/'prepared.json').write_text(json.dumps({'sourceIndexSha256':identity(a.index)['sha256'],'toolFiles':tools,'runtimeSourceReceipt':identity(a.runtime_source_receipt),'runtimeFiles':[{'name':n,**identity(runtime/n)} for n in names],'openblas':identity(mathdir/'openblas.dll'),'vc':identity(vc)},indent=2)+'\n');print('Preferred sources and build controls materialized; no source executed.');return
 prepared=json.loads((W/'prepared.json').read_text());assert prepared['sourceIndexSha256']==identity(a.index)['sha256']
 for row in prepared['toolFiles']:assert identity(W/row['path'])=={k:row[k] for k in ['bytes','sha256']},'Pinned compiler/Meson tool changed'
 for row in prepared['runtimeFiles']:assert identity(runtime/row['name'])=={k:row[k] for k in ['bytes','sha256']},'Runtime input changed after prepare'
 assert identity(vc)==prepared['vc'] and identity(mathdir/'openblas.dll')==prepared['openblas'] and identity(a.runtime_source_receipt)==prepared['runtimeSourceReceipt']
 modified=[];expected={r['path']:r for r in tree['files']}
 for rel,row in expected.items():
  f=source/rel
  if not f.is_file() or identity(f)!={k:row[k] for k in ['bytes','sha256']}:modified.append(rel)
 actual=[{'path':f.relative_to(source).as_posix(),**identity(f)} for f in source.rglob('*') if f.is_file()];actual.sort(key=lambda r:r['path']);added=[r['path'] for r in actual if r['path'] not in expected]
 if (modified or added) and not a.local_modified:raise ValueError('Explicit --local-modified is required for edited preferred source')
 if (W/'build').exists() or out.exists():raise FileExistsError('Build already attempted here; preserve it and use a fresh prepared root')
 win=Path(os.environ.get('SYSTEMROOT','C:/Windows'));env={k:v for k,v in os.environ.items() if k.upper() in ['SYSTEMROOT','WINDIR','COMSPEC','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE']};env.update(PATH=';'.join([str(B),str(Path(sys.executable).parent),str(runtime),str(mathdir),str(win/'System32'),str(win)]),HOME=str(W/'home'),USERPROFILE=str(W/'home'),TEMP=str(W/'temp'),TMP=str(W/'temp'),PYTHONDONTWRITEBYTECODE='1',PYTHONUTF8='1',OMP_NUM_THREADS=str(a.jobs),OPENBLAS_NUM_THREADS='1',OMP_DYNAMIC='FALSE',LIBRARY_PATH=str(W/'openblas'),CMAKE_PREFIX_PATH='',PKG_CONFIG_PATH='',PKG_CONFIG_LIBDIR=str(W/'empty-pkgconfig'))
 deadline=time.monotonic()+a.max_seconds;seq=0
 def run(command,cwd):
  nonlocal seq
  seq+=1;stem=f'build-{seq:02d}';remain=deadline-time.monotonic();assert remain>0,'Total build deadline exhausted';req={'command':list(map(str,command)),'cwd':str(cwd),'env':env,'stdout':str(W/'logs'/(stem+'.stdout.txt')),'stderr':str(W/'logs'/(stem+'.stderr.txt')),'receipt':str(W/'logs'/(stem+'.receipt.json')),'threads':a.jobs,'memoryGiB':a.memory_gib,'timeoutSeconds':remain};rp=W/'logs'/(stem+'.request.json');rp.write_text(json.dumps(req,indent=2)+'\n')
  proc=subprocess.Popen([sys.executable,'-s','-B',str(here/'bounded-command.py'),str(rp)])
  try:code=proc.wait()
  except BaseException:proc.terminate();proc.wait();raise
  if code:raise RuntimeError('Required bounded command failed: '+stem)
 abi=W/'openblas';shutil.copy2(mathdir/'openblas.dll',abi/'openblas.dll');run([B/'gendef.exe',abi/'openblas.dll'],abi);run([B/'dlltool.exe','-d',abi/'openblas.def','-D','openblas.dll','-l',abi/'libopenblas.dll.a'],abi)
 native=W/'controls/native.ini';bins={'c':B/'gcc.exe','fortran':B/'gfortran.exe','ar':B/'ar.exe','strip':B/'strip.exe','python':Path(sys.executable),'python3':Path(sys.executable)}
 text='[binaries]\n'+''.join(k+' = '+repr(v.as_posix())+'\n' for k,v in bins.items())+'[built-in options]\nfortran_link_args = '+repr(['-L'+abi.as_posix(),'-Xlinker','--stack','-Xlinker','67108864,4096'])+'\nc_link_args = '+repr(['-L'+abi.as_posix()])+'\n';native.write_text(text)
 entry=[sys.executable,'-s','-B',here/'meson-entry.py','--meson-root',meson,'--dll-dir',runtime,'--dll-dir',mathdir,'--'];fallback='mctc-lib,json-fortran,json-fortran-8.2.5,tblite,multicharge,dftd4,cpx,numsa,s-dftd3,toml-f,test-drive,mstore'
 setup=['setup',W/'build',source,'--native-file',native,'--prefix',W/'install','--buildtype=release','--default-library=static','--wrap-mode=nodownload','--force-fallback-for='+fallback,'-Dtblite=enabled','-Dcpcmx=enabled','-Dopenmp=true','-Dgpu=false','-Dlapack=openblas','-Dmctc-lib:json=enabled','-Dbuild_name='+a.build_name]
 run(entry+setup,W);run([B/'ninja.exe','-C',W/'build','-j',str(a.jobs),'xtb.exe'],W)
 exe=W/'build/xtb.exe';blob=exe.read_bytes();pe=struct.unpack_from('<I',blob,0x3c)[0];assert struct.unpack_from('<H',blob,pe+24)[0]==0x20b;reserve,commit=struct.unpack_from('<QQ',blob,pe+24+72);assert (reserve,commit)==(67108864,4096)
 (out/'bin').mkdir(parents=True);(out/'share/xtb').mkdir(parents=True);shutil.copy2(exe,out/'bin/xtb.exe')
 for n in names:shutil.copy2(runtime/n,out/'bin'/n)
 for n in ['openblas.dll','VCRUNTIME140.dll']:shutil.copy2(mathdir/n,out/'bin'/n)
 for row in index['parameters']:
  f=source/row['sourcePath']
  if not a.local_modified:assert identity(f)=={k:row[k] for k in ['bytes','sha256']}
  shutil.copy2(f,out/row['installPath'])
 files=[{'path':f.relative_to(out).as_posix(),**identity(f)} for root in [out/'bin',out/'share/xtb'] for f in root.rglob('*') if f.is_file()];files.sort(key=lambda r:r['path']);actualpath=out/'preferred-source-tree.json';actualpath.write_text(json.dumps({'files':actual},separators=(',',':'))+'\n')
 shutil.copy2(a.runtime_source_receipt,out/'gnu-runtime-source-receipt.json')
 receipt={'schema':'sy-xtb-gnu-user-source-build-v1','sourceCommit':index['mainCommit'],'sourceIndexSha256':identity(a.index)['sha256'],'preferredSourceTree':{'path':actualpath.name,**identity(actualpath)},'scientificPins':[{k:r[k] for k in ['name','commit','sha256']} for r in index['sourceArchives']],'runtimeSourceReceipt':{'path':'gnu-runtime-source-receipt.json',**identity(out/'gnu-runtime-source-receipt.json')},'localModified':True,'sourceModified':bool(modified or added),'modifiedSourcePaths':modified,'addedSourcePaths':added,'buildName':a.build_name,'compilerSeedArchiveSha256':index['bootstrapToolsNotBundled'][0]['sha256'],'meson':'1.4.1','ninja':'1.12.0','openblasAbi':'LP64','peStackReserve':reserve,'peStackCommit':commit,'inventoryFiles':files,'officialBinaryIdentity':False,'numericallyValidated':False,'productReady':False}
 (out/'xtb-build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(out/'xtb-build-receipt.json')
if __name__=='__main__':main()
