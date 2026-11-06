"""Build the pinned Fortran components from adjacent source/recipes/link inputs."""
from pathlib import Path
import argparse
import datetime
import json
import subprocess
import sys
import time

parser=argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
parser.add_argument('--toolchain-bin', type=Path, required=True)
parser.add_argument('--parallel', type=int, default=4)
args=parser.parse_args()
assert args.parallel > 0
root=args.root.resolve()
bin=args.toolchain_bin.resolve()
parts=[('toml-f-050','toml-f-lib'),('jonquil-static','jonquil-lib'),('mctc-lib','mctc-lib-lib'),('toml-f','toml-f-lib'),
       ('multicharge','multicharge-lib'),('dftd4','dftd4-lib'),('s-dftd3','s-dftd3-lib'),('tblite','tblite-lib')]
for name in ('cmake.exe','ninja.exe','gcc.exe','gfortran.exe'):
    assert (bin/name).is_file(), str(bin/name)
records=root/'records'
records.mkdir(exist_ok=True)
result_path=records/'build-results.json'
assert not result_path.exists(), 'Use a fresh output tree; never overwrite historical build evidence'
results=[]
started=time.monotonic()
for part,target in parts:
    (root/'outputs'/part).mkdir(parents=True,exist_ok=True)
    commands=[
      [str(bin/'cmake.exe'),'-S',str(root/'recipes'/part),'-B',str(root/'build'/part),'-G','Ninja',
       '-DCMAKE_MAKE_PROGRAM='+str(bin/'ninja.exe'),'-DCMAKE_C_COMPILER='+str(bin/'gcc.exe'),
       '-DCMAKE_Fortran_COMPILER='+str(bin/'gfortran.exe'),'-DCMAKE_INSTALL_PREFIX='+str(root/'prefix'/part),
       '-DCMAKE_BUILD_TYPE=Release','-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF','-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF',
       '-DCMAKE_FIND_PACKAGE_NO_PACKAGE_REGISTRY=ON','-DCMAKE_FIND_PACKAGE_NO_SYSTEM_PACKAGE_REGISTRY=ON',
       '-DFETCHCONTENT_FULLY_DISCONNECTED=ON','-DCMAKE_EXPORT_NO_PACKAGE_REGISTRY=ON', '-DES_BUILD_PYTHON='+sys.executable],
      [str(bin/'cmake.exe'),'--build',str(root/'build'/part),'--target',target,'--parallel',str(args.parallel)]]
    for phase,command in zip(('configure','compile'),commands):
        log=records/(part+'-'+phase+'.log')
        row={'part':part,'phase':phase,'argv':command,'cwd':str(root),
             'startedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'log':log.name}
        results.append(row)
        result_path.write_text(json.dumps({'results':results,'scienceExecuted':False},indent=2)+'\n',encoding='utf-8')
        clock=time.monotonic()
        with log.open('xb') as stream:
            row['exitCode']=subprocess.call(command,cwd=root,stdout=stream,stderr=subprocess.STDOUT)
        row['wallSeconds']=time.monotonic()-clock
        result_path.write_text(json.dumps({'results':results,'wallSeconds':time.monotonic()-started,'scienceExecuted':False},indent=2)+'\n',encoding='utf-8')
        print(json.dumps({'part':part,'phase':phase,'exitCode':row['exitCode'],'wallSeconds':row['wallSeconds']}),flush=True)
        if row['exitCode']:
            raise SystemExit(row['exitCode'])
print(json.dumps({'allEightPartsBuilt':True,'wallSeconds':time.monotonic()-started,'scienceExecuted':False}),flush=True)
