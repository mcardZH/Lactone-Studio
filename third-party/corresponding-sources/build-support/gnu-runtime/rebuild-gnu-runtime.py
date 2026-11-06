"""Parameterised corresponding-source build control. No network or installation.

Use plan first; prepare materialises sources/tools only; build compiles on request.
Rebuilt or modified output is an independent local candidate, never an official pin.
"""
from pathlib import Path, PurePosixPath
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tarfile, time, zipfile

def digest(path):
 with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def identity(path):return {'bytes':path.stat().st_size,'sha256':digest(path)}

def effective_source_rows(index,base,tree):
 """Apply the declared one-fixture privacy overlay to historical evidence."""
 overlay_pin=index['sourceTree']['derivativeOverlay'];overlay_path=base/overlay_pin['path']
 assert identity(overlay_path)=={k:overlay_pin[k] for k in ['bytes','sha256']},'Source-tree overlay identity mismatch'
 overlay=json.loads(overlay_path.read_text(encoding='utf-8'))
 assert overlay['originalSourceTree']=={k:index['sourceTree'][k] for k in ['path','bytes','sha256']}
 assert len(overlay['omittedFiles'])==1
 excluded=overlay['omittedFiles'][0]
 assert excluded['path']=='source/gcc-13.2.0/libgo/go/debug/elf/testdata/hello-world-core.gz'
 assert [row for row in tree['files'] if row['path']==excluded['path']]==[excluded], 'Historical exclusion identity mismatch'
 rows=[row for row in tree['files'] if row['path']!=excluded['path']]
 assert len(rows)==overlay['effectiveSourceFiles']==len(tree['files'])-1
 return rows,overlay
def safe_name(name):
 p=PurePosixPath(name)
 if p.is_absolute() or '..' in p.parts or ':' in name or '\\' in name:raise ValueError('Unsafe archive member '+name)
 return p
def extract_source(archive,dest,subtree=None,strip_top=True):
 seen={};skipped=[]
 with tarfile.open(archive,'r:*') as stream:
  for m in stream:
   parts=safe_name(m.name).parts
   if strip_top:parts=parts[1:]
   if subtree:
    prefix=PurePosixPath(subtree).parts
    if tuple(parts[:len(prefix)])!=prefix:continue
    parts=parts[len(prefix):]
   if not parts:continue
   rel='/'.join(parts);key=rel.casefold()
   if key in seen and seen[key]!=rel:
    if '/testsuite/' in '/'+rel or '/tests/' in '/'+rel:skipped.append(rel);continue
    raise ValueError('Case collision '+rel)
   seen[key]=rel;out=dest.joinpath(*parts)
   if not out.resolve().is_relative_to(dest.resolve()):raise ValueError('Member escaped destination')
   if m.isdir():out.mkdir(parents=True,exist_ok=True)
   elif m.isfile():
    out.parent.mkdir(parents=True,exist_ok=True)
    with stream.extractfile(m) as source,out.open('xb') as target:shutil.copyfileobj(source,target)
    os.utime(out,(m.mtime,m.mtime))
   else:raise ValueError('Link/special source member refused '+m.name)
 return skipped
def main():
 a=argparse.ArgumentParser();a.add_argument('mode',choices=['plan','prepare','build']);a.add_argument('--index',type=Path,default=Path(__file__).resolve().parents[2]/'GNU-RUNTIME-SOURCE-INDEX.json');a.add_argument('--archive-dir',type=Path,action='append',default=[]);a.add_argument('--work-root',type=Path,required=True);a.add_argument('--jobs',type=int,default=4);a.add_argument('--memory-gib',type=int,default=8);a.add_argument('--max-seconds',type=int,default=5400);a.add_argument('--local-modified',action='store_true');args=a.parse_args()
 if not 1<=args.jobs<=8 or not 1<=args.memory_gib<=16 or not 1<=args.max_seconds<=5400:raise ValueError('Resource arguments outside bounded builder limits')
 indexpath=args.index.resolve();index=json.loads(indexpath.read_text());base=indexpath.parent;W=args.work_root.resolve();prepared=W/'prepared.json';B=W/'tools/winlibs/mingw64/bin';M=W/'tools/msys/msys64';sources=W/'source';src=sources/'gcc-13.2.0';seed=B.parent/'x86_64-w64-mingw32';R0=W/'install/r0';R2=W/'install/r2';out=W/'runtime-out';runner=Path(__file__).with_name('bounded-command.py')
 if any(not re.fullmatch(r'[A-Za-z0-9_.-]+',part) for part in W.parts[1:]):raise ValueError('Work-root path components must use only ASCII letters, digits, dot, underscore and hyphen')
 treeinfo=index['sourceTree'];treepath=base/treeinfo['path'];assert identity(treepath)=={k:treeinfo[k] for k in ['bytes','sha256']};tree=json.loads(treepath.read_text());expected_rows,source_overlay=effective_source_rows(index,base,tree)
 gcc_pin=next(pin for pin in index['sourceArchives'] if pin.get('component')=='gcc')
 derivative_pin=gcc_pin['sourceDerivation'];derivative_path=base/derivative_pin['path'];assert identity(derivative_path)=={k:derivative_pin[k] for k in ['bytes','sha256']}
 derivative=next(row for row in json.loads(derivative_path.read_text(encoding='utf-8'))['derivatives'] if row['version']=='13.2.0')
 assert derivative['suppliedArchive']=={k:gcc_pin[k] for k in ['path','bytes','sha256']}
 assert source_overlay['derivedArchive']==derivative['suppliedArchive']
 assert derivative['officialInput']==gcc_pin['officialInput']
 assert 'source/'+derivative['excludedMembers'][0]['path']==source_overlay['omittedFiles'][0]['path']
 assert derivative['excludedMembers'][0]['compressedIdentity']=={k:source_overlay['omittedFiles'][0][k] for k in ['bytes','sha256']}
 inputs={}
 if args.mode in ['plan','prepare']:
  for pin in index['sourceArchives']+index['bootstrapToolsNotBundled']:
   candidates=[base/pin['path']] if 'path' in pin else []
   candidates += [directory/pin['name'] for directory in args.archive_dir]
   found=next((p.resolve() for p in candidates if p.is_file()),None)
   if not found:raise FileNotFoundError('Obtain exact archive first: '+pin['name'])
   assert identity(found)=={k:pin[k] for k in ['bytes','sha256']},pin['name'];inputs[pin['name']]=found
 if args.mode=='plan':
  print(json.dumps({'sourceArchiveCount':len(index['sourceArchives']),'bootstrapArchiveCount':len(index['bootstrapToolsNotBundled']),'workRoot':str(W),'target':index['target'],'patches':index['sourcePatches'],'suppliedGccSource':gcc_pin['name'],'privacyOmittedFiles':source_overlay['omittedFiles'],'effectiveSourceFiles':len(expected_rows),'actions':['safe materialize verified privacy-derived GCC and other unchanged sources/private tools','CMake/Ninja dlfcn; configure/make winpthreads','GCC C/Fortran helper plus four target runtimes','standard mingw sysroot layout and SYSROOT_CFLAGS_FOR_TARGET','strip-debug preserve-dates on copies; retain originals and relink libraries','emit truthful local source/member receipt; no product lock or science run'],'nativeCommandsExecuted':False},indent=2));return
 if os.name!='nt':raise RuntimeError('Windows x64 is required for this native MinGW recipe')
 env={k:v for k,v in os.environ.items() if k.upper() in ['SYSTEMROOT','WINDIR','COMSPEC','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE']};win=Path(env.get('SYSTEMROOT','C:/Windows'))
 env.update(PATH=';'.join([str(M/'usr/bin'),str(R0/'bin'),str(B),str(win/'System32'),str(win)]),HOME=(W/'home').as_posix(),USERPROFILE=str(W/'home'),TEMP=str(W/'temp'),TMP=str(W/'temp'),LC_ALL='C',LANG='C',MSYSTEM='MSYS',MSYS2_PATH_TYPE='strict',CHERE_INVOKING='1',SHELL='/usr/bin/sh',CONFIG_SHELL='/usr/bin/sh',CONFIG_SITE='/dev/null',MAKE='/usr/bin/make',OMP_NUM_THREADS=str(args.jobs),OPENBLAS_NUM_THREADS='1')
 deadline=time.monotonic()+args.max_seconds;sequence=0
 def run(command,cwd):
  nonlocal sequence
  sequence+=1;stem=f'{args.mode}-{sequence:02d}';log=W/'logs';remaining=deadline-time.monotonic();assert remaining>0,'Total command deadline exhausted'
  request={'command':list(map(str,command)),'cwd':str(cwd),'env':env,'stdout':str(log/(stem+'.stdout.txt')),'stderr':str(log/(stem+'.stderr.txt')),'receipt':str(log/(stem+'.receipt.json')),'threads':args.jobs,'memoryGiB':args.memory_gib,'timeoutSeconds':remaining};rp=log/(stem+'.request.json');rp.write_text(json.dumps(request,indent=2)+'\n')
  child=subprocess.Popen([sys.executable,'-s','-B',str(runner),str(rp)])
  try:code=child.wait()
  except BaseException:
   child.terminate();child.wait();raise
  if code:raise RuntimeError('Bounded command failed; preserve logs: '+stem)
  return log/(stem+'.stdout.txt')
 def shell(name,body,cwd):
  p=W/'controls'/(name+'.sh');p.write_text('set -eu\n'+body+'\n',encoding='ascii',newline='\n');run([M/'usr/bin/bash.exe','--noprofile','--norc',p],cwd)
 if args.mode=='prepare':
  if W.exists():raise FileExistsError('prepare requires a new work-root')
  for folder in ['tools/winlibs','tools/msys','source','logs','controls','home','temp','build/r0-dlfcn','build/r0-winpthreads','build/r2-gcc','install/r0','install/r2']:(W/folder).mkdir(parents=True,exist_ok=True)
  winzip=next(v for k,v in inputs.items() if k.startswith('winlibs-'))
  with zipfile.ZipFile(winzip) as z:
   for m in z.infolist():
    p=safe_name(m.filename)
    if (m.external_attr>>16)&0o170000==0o120000:raise ValueError('Tool symlink refused')
   z.extractall(W/'tools/winlibs')
  basearc=next(v for k,v in inputs.items() if k.startswith('msys2-base-'));extract_source(basearc,W/'tools/msys',strip_top=False)
  for name in ['make-4.4.1-3-x86_64.pkg.tar.zst','diffutils-3.12-1-x86_64.pkg.tar.zst']:
   archive=inputs[name];listing=run([B/'cmake.exe','-E','tar','tf',archive],W).read_text();verbose=run([B/'cmake.exe','-E','tar','tvf',archive],W).read_text()
   for path in listing.splitlines():safe_name(path)
   for line in verbose.splitlines():assert line.startswith(('-', 'd')),'Special bootstrap member refused'
   run([B/'cmake.exe','-E','tar','xf',archive],M)
  extract_source(inputs[gcc_pin['name']],src)
  extract_source(inputs['mingw-w64-v11.0.1.tar.gz'],sources/'winpthreads-11.0.1','mingw-w64-libraries/winpthreads')
  extract_source(inputs['dlfcn-win32-v1.4.1.tar.gz'],sources/'dlfcn-win32-1.4.1')
  for name in ['gmp-6.2.1.tar.bz2','mpfr-4.1.0.tar.bz2','mpc-1.2.1.tar.gz','isl-0.24.tar.bz2']:extract_source(inputs[name],src/name.split('-')[0])
  sysroot=W/'sysroot/mingw'
  for sub in ['include','lib']:shutil.copytree(seed/sub,sysroot/sub,symlinks=False)
  toolfiles=[{'path':p.relative_to(W).as_posix(),**identity(p)} for folder in [W/'tools',W/'sysroot'] for p in folder.rglob('*') if p.is_file()]
  prepared.write_text(json.dumps({'indexSha256':digest(indexpath),'treeSha256':digest(treepath),'sourceTreePrivacyOverlay':source_overlay,'inputs':{n:{'archive':n,**identity(p)} for n,p in inputs.items()},'toolInputFiles':toolfiles,'runtimeSourcePatches':[]},indent=2)+'\n');print('Prepared sources/tools. No configure/compile/scientific program ran.');return
 assert prepared.is_file() and json.loads(prepared.read_text())['indexSha256']==digest(indexpath),'Prepare using this exact source index first'
 for row in json.loads(prepared.read_text())['toolInputFiles']:assert identity(W/row['path'])=={k:row[k] for k in ['bytes','sha256']},'Pinned compiler/helper/sysroot file changed: '+row['path']
 modified=[];expected={r['path']:r for r in expected_rows}
 for rel,pin in expected.items():
  p=W/rel
  if not p.is_file() or identity(p)!={k:pin[k] for k in ['bytes','sha256']}:modified.append(rel)
 added=[p.relative_to(W).as_posix() for p in sources.rglob('*') if p.is_file() and p.relative_to(W).as_posix() not in expected]
 if (modified or added) and not args.local_modified:raise ValueError('Modified source found; explicitly choose --local-modified')
 actual_source=[{'path':p.relative_to(W).as_posix(),**identity(p)} for p in sources.rglob('*') if p.is_file()];actual_source.sort(key=lambda r:r['path'])
 source_digest=hashlib.sha256(json.dumps(actual_source,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 if any((W/'logs').glob('build-*.request.json')):raise FileExistsError('Build was already attempted in this work-root; preserve it and use a fresh prepared root')
 env.update(CC=(B/'gcc.exe').as_posix(),CXX=(B/'g++.exe').as_posix(),FC=(B/'gfortran.exe').as_posix(),AR=(B/'ar.exe').as_posix(),AS=(B/'as.exe').as_posix(),LD=(B/'ld.exe').as_posix(),RANLIB=(B/'ranlib.exe').as_posix(),CC_FOR_BUILD='gcc',CXX_FOR_BUILD='g++',CFLAGS='-O2 -g0',CXXFLAGS='-O2 -g0',LDFLAGS='-static-libgcc -static-libstdc++',CFLAGS_FOR_TARGET='-O2 -g0',CXXFLAGS_FOR_TARGET='-O2 -g0',FCFLAGS_FOR_TARGET='-O2 -g0',CPPFLAGS_FOR_TARGET='-I'+(R0/'include').as_posix(),LDFLAGS_FOR_TARGET='-L'+(R0/'lib').as_posix())
 run([B/'cmake.exe','-S',sources/'dlfcn-win32-1.4.1','-B',W/'build/r0-dlfcn','-G','Ninja','-DCMAKE_MAKE_PROGRAM='+(B/'ninja.exe').as_posix(),'-DCMAKE_C_COMPILER='+(B/'gcc.exe').as_posix(),'-DCMAKE_BUILD_TYPE=Release','-DBUILD_SHARED_LIBS=ON','-DBUILD_TESTS=OFF','-DCMAKE_INSTALL_PREFIX='+R0.as_posix()],W)
 run([B/'cmake.exe','--build',W/'build/r0-dlfcn','--parallel',str(args.jobs)],W);run([B/'cmake.exe','--install',W/'build/r0-dlfcn'],W)
 shell('winpthreads-configure','CC=gcc CXX=g++ AR=ar RANLIB=ranlib RC=windres CFLAGS="-O2 -g0" /usr/bin/sh ../../source/winpthreads-11.0.1/configure --srcdir=../../source/winpthreads-11.0.1 --build=x86_64-w64-mingw32 --host=x86_64-w64-mingw32 --prefix='+R0.as_posix()+' --enable-shared --enable-static',W/'build/r0-winpthreads')
 shell('winpthreads-build',f'/usr/bin/make -j{args.jobs} SHELL=/usr/bin/sh all install',W/'build/r0-winpthreads')
 flags=['--srcdir=../../source/gcc-13.2.0','--build=x86_64-w64-mingw32','--host=x86_64-w64-mingw32','--target=x86_64-w64-mingw32','--with-build-sysroot='+seed.as_posix(),'--with-native-system-header-dir=/include','--enable-languages=c,fortran','--disable-bootstrap','--disable-multilib','--enable-checking=release','--enable-threads=posix','--disable-sjlj-exceptions','--disable-libunwind-exceptions','--enable-shared','--enable-libgomp','--enable-libquadmath','--enable-graphite','--disable-nls','--disable-win32-registry','--disable-libssp','--disable-libatomic','--disable-libsanitizer','--disable-libvtv','--disable-libcc1','--disable-libstdcxx','--disable-plugin','--disable-lto','--disable-werror','--without-zstd','--prefix='+R2.as_posix(),'--with-pkgversion=SY-GNU13.2-local-runtime-source-rebuild']
 shell('gcc-configure','/usr/bin/sh ../../source/gcc-13.2.0/configure '+' '.join("'"+s+"'" for s in flags),W/'build/r2-gcc')
 override="'SYSROOT_CFLAGS_FOR_TARGET=--sysroot="+(W/'sysroot').as_posix()+"'"
 for name,targets in [('gcc-build','all-gcc all-target-libgcc all-target-libgfortran all-target-libgomp all-target-libquadmath'),('gcc-install','install-gcc install-target-libgcc install-target-libgfortran install-target-libgomp install-target-libquadmath')]:shell(name,f'/usr/bin/make -j{args.jobs} SHELL=/usr/bin/sh {override} {targets}',W/'build/r2-gcc')
 (out/'bin').mkdir(parents=True,exist_ok=False);(out/'relink').mkdir();rows=[]
 for name in ['libdl.dll','libwinpthread-1.dll','libgcc_s_seh-1.dll','libgfortran-5.dll','libgomp-1.dll','libquadmath-0.dll']:
  matches=list((R0 if name in ['libdl.dll','libwinpthread-1.dll'] else R2).rglob(name));assert len(matches)==1,(name,matches);raw=matches[0];dest=out/'bin'/name;shutil.copy2(raw,dest)
  if name not in ['libdl.dll','libwinpthread-1.dll']:run([B/'strip.exe','--strip-debug','--preserve-dates',dest],W)
  rows.append({'path':'bin/'+name,'rawInstall':identity(raw),**identity(dest)})
 relink=[]
 for root in [R0,R2]:
  for p in root.rglob('*.a'):
   if p.name.startswith(('libdl.','libpthread.','libwinpthread.','libgcc','libgfortran.','libgomp.','libquadmath.')):
    dest=out/'relink'/p.name
    if dest.exists():assert digest(dest)==digest(p)
    else:shutil.copy2(p,dest)
    relink.append({'path':'relink/'+p.name,**identity(dest)})
 (out/'source-tree.json').write_text(json.dumps({'files':actual_source,'canonicalRowsSha256':source_digest},separators=(',',':'))+'\n')
 receipt={'schema':'sy-gnu-runtime-user-rebuild-v1','sourceIndexSha256':digest(indexpath),'originalSourceTreeSha256':digest(treepath),'sourceTreePrivacyOverlay':source_overlay,'suppliedGccArchive':{k:gcc_pin[k] for k in ['path','bytes','sha256']},'actualInputSourceTreeDigest':source_digest,'actualSourceTree':{'path':'source-tree.json',**identity(out/'source-tree.json')},'localModified':True,'sourceModified':bool(modified or added),'sourceModificationModeExplicit':args.local_modified,'modifiedSourcePaths':modified,'addedSourcePaths':added,'sourcePatchesSuppliedByRecipe':[],'configuration':flags,'targetMakeOverride':override,'compilerSeedArchiveSha256':index['bootstrapToolsNotBundled'][0]['sha256'],'runtimeFiles':rows,'relinkFiles':relink,'numericallyValidated':False,'officialBinaryIdentity':False,'productReady':False}
 (out/'runtime-rebuild-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(out/'runtime-rebuild-receipt.json')
if __name__=='__main__':main()
