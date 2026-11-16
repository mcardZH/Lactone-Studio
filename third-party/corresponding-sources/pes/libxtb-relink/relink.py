"""Standalone re-link recipe for the included LGPL library inputs.

Ester Studio release-support material. This creates a new library only and
never edits a product installation. Supply the explicit matching Zig tool.
"""
import argparse, hashlib, json, os, subprocess
from pathlib import Path

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--zig',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--inputs',type=Path,default=Path(__file__).resolve().parent/'project/inputs')
    a=p.parse_args();root=Path(__file__).resolve().parent
    lock=json.loads((root/'LOCK-REFERENCE.json').read_text(encoding='utf-8'))
    compiler=a.zig.resolve();inputs=a.inputs.resolve();out=a.output.resolve()
    assert not out.exists(),'Output must be a new directory'
    assert inputs!=out and not out.is_relative_to(inputs) and not inputs.is_relative_to(out)
    assert digest(compiler)==lock['relink']['compiler']['sha256'],'Compiler identity differs'
    for r in lock['relink']['inputs']:
        f=inputs/r['path'];assert f.is_file() and f.stat().st_size==r['bytes'] and digest(f)==r['sha256'],r['path']
    out.mkdir(parents=True)
    target=out/'libxtb.dll';inp=lambda s:str(inputs/s)
    args=[str(compiler),'cc','-target','x86_64-windows-gnu','-shared','-o',str(target),inp('link/libxtb.def'),'-Wl,--whole-archive',inp('xtb/lib/libxtb.a'),'-Wl,--no-whole-archive',inp('xtb/lib/libcpx.a'),inp('gnu/lib/libgfortran.dll.a'),inp('gnu/lib/libgomp.dll.a'),inp('gnu/lib/libquadmath.dll.a'),inp('link/libopenblas.a')]
    env={k:os.environ[k] for k in ['SystemRoot','WINDIR'] if k in os.environ}
    env.update(PATH='',TEMP=str(out),TMP=str(out),ZIG_GLOBAL_CACHE_DIR=str(out/'zig-global'),ZIG_LOCAL_CACHE_DIR=str(out/'zig-local'))
    completed=subprocess.run(args,cwd=out,env=env,capture_output=True,timeout=180)
    (out/'stdout.log').write_bytes(completed.stdout);(out/'stderr.log').write_bytes(completed.stderr)
    assert completed.returncode==0,'Re-link failed; inspect output logs'
    result={'schema':'ester-public-libxtb-relink/v1','passed':True,'library':target.name,'bytes':target.stat().st_size,'sha256':digest(target),'inputHashesVerified':len(lock['relink']['inputs']),'scientificEvaluations':0,'productInstallationModified':False}
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result))

if __name__=='__main__':main()
