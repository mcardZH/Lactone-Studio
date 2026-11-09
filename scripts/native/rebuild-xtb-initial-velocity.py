"""Reuse the approved local source recipe and compiler; build a fresh H-cap tree.

No package installation or shared build output mutation. The recipe's numerical
flags and source archive pins remain unchanged. Math input must be the original
LP64 OpenBLAS034 or the exact published OpenBLAS033 replacement, explicitly
recorded in the user build receipt; this is not official-product acceptance.
"""
from pathlib import Path
import argparse, hashlib, json, subprocess, sys

ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'third-party/corresponding-sources'

def checked_math_input(runtime):
    dll=runtime/'bin/openblas.dll'
    value=dict(bytes=dll.stat().st_size,sha256=hashlib.sha256(dll.read_bytes()).hexdigest())
    allowed=[dict(bytes=28410880,sha256='d0073463ce449d6bb4a3f720b1ebf8a858b49ca2e376271585a7f75f6a1795d8'),
             dict(bytes=28357632,sha256='ea5706aaa7e88ea76f350faf4181c5e3393817a1ce1cd800501bf3ee21f205e8')]
    if value not in allowed:raise ValueError('Use the pinned original OpenBLAS034 or published OpenBLAS033 runtime')
    return value

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-root',type=Path,required=True)
    parser.add_argument('--tools-root',type=Path,required=True,help='Existing pinned GCC13.2 tree with mingw64/ and meson-1.4.1/')
    parser.add_argument('--runtime-root',type=Path,required=True,help='Existing matched runtime with bin/ and provenance/r2-source-receipt.json')
    parser.add_argument('--jobs',type=int,required=True)
    parser.add_argument('--memory-gib',type=int,required=True)
    parser.add_argument('--max-seconds',type=int,required=True)
    parser.add_argument('--build-name',required=True)
    args=parser.parse_args()
    WORK=args.work_root.resolve();TOOLS=args.tools_root.resolve();RUNTIME=args.runtime_root.resolve()
    if WORK.exists():raise FileExistsError('Fresh build root required')
    math_input=checked_math_input(RUNTIME)
    recipe=BASE/'build-support/xtb-gnu/rebuild-xtb.py'
    text=recipe.read_text(encoding='utf-8')
    old_math="assert identity(mathdir/'openblas.dll')=={k:index['openblas'][k] for k in ['bytes','sha256']},'Primary recipe preserves the exact LP64 OpenBLAS'"
    if text.count(old_math)!=1:raise ValueError('Pinned recipe math assertion changed')
    text=text.replace(old_math,"assert identity(mathdir/'openblas.dll')=="+repr(math_input)+",'Explicit checked LP64 math input changed'")
    text=text.replace("B=W/'tools/winlibs/mingw64/bin';meson=W/'tools/meson'",f"B=Path({str(TOOLS/'mingw64/bin')!r});meson=Path({str(TOOLS/'meson-1.4.1')!r})")
    text=text.replace("for pin in index['sourceArchives']+index['bootstrapToolsNotBundled']:","for pin in index['sourceArchives']:")
    start="  winzip=next(f for name,f in inputs.items() if name.startswith('winlibs-'));"
    lines=text.splitlines()
    lines=[line for line in lines if not line.startswith(start)]
    # Existing compiler and meson are read-only; capture actual executable and
    # module hashes separately, rather than representing them as newly unpacked.
    text='\n'.join(lines)+'\n'
    text=text.replace("tools=[{'path':f.relative_to(W).as_posix(),**identity(f)} for root in [W/'tools'] for f in root.rglob('*') if f.is_file()]", "tools=[]")
    holder=WORK.with_name(WORK.name+'-recipe')
    holder.mkdir(parents=True,exist_ok=False)
    adapted=holder/'rebuild-xtb.py';adapted.write_text(text,encoding='utf-8')
    for name in ('bounded-command.py','meson-entry.py'):
        (holder/name).write_bytes((recipe.parent/name).read_bytes())
    entry=holder/'meson-entry.py'
    entry.write_text('from pathlib import Path\nimport os,sys\n'
        +f'sys.path.insert(0,{str(TOOLS/"meson-1.4.1")!r})\n'
        +f'handles=[os.add_dll_directory({str(RUNTIME/"bin")!r})]\n'
        +'args=sys.argv[1:]\n'
        +'if "--" in args:sys.argv=[str(Path(__file__).resolve())]+args[args.index("--")+1:]\n'
        +'from mesonbuild.mesonmain import main\nraise SystemExit(main())\n',encoding='utf-8')
    bounded=holder/'bounded-command.py'
    code=bounded.read_text(encoding='utf-8')
    code=code.replace("        os.replace(pending,paths['receipt'])", "        for attempt in range(40):\n            try:\n                os.replace(pending,paths['receipt']);break\n            except PermissionError:\n                if attempt==39:raise\n                time.sleep(0.05)")
    bounded.write_text(code,encoding='utf-8')
    refs={}
    for path in [recipe,adapted,TOOLS/'mingw64/bin/gfortran.exe',TOOLS/'mingw64/bin/gcc.exe',TOOLS/'mingw64/bin/ninja.exe',TOOLS/'meson-1.4.1/mesonbuild/mesonmain.py']:
        refs[str(path)]={'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    (holder/'recipe-provenance.json').write_text(json.dumps(refs,indent=2)+'\n')
    (holder/'math-input.json').write_text(json.dumps(math_input,indent=2)+'\n')
    common=[sys.executable,str(adapted),'prepare','--index',str(BASE/'XTB-GNU-SOURCE-INDEX.json'),'--work-root',str(WORK),'--gnu-runtime-bin',str(RUNTIME/'bin'),'--runtime-source-receipt',str(RUNTIME/'provenance/r2-source-receipt.json'),'--math-bin',str(RUNTIME/'bin'),'--jobs',str(args.jobs),'--memory-gib',str(args.memory_gib),'--max-seconds',str(args.max_seconds),'--local-modified','--build-name',args.build_name]
    subprocess.run(common,check=True)
    sys.path.insert(0,str(ROOT/'scripts/native'))
    from importlib import import_module
    proof=import_module('patch-xtb-initial-velocity').apply(WORK/'source')
    (holder/'source-patch.json').write_text(json.dumps(proof,indent=2)+'\n')
    common[2]='build'
    subprocess.run(common,check=True)
    receipt_path=WORK/'output/xtb-build-receipt.json'
    receipt=json.loads(receipt_path.read_text(encoding='utf-8'))
    receipt['actualMathInput']=math_input
    receipt['userBuild']=True
    receipt_path.write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')

if __name__=='__main__':main()
