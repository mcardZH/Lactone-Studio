"""Build local native sources with exact inputs; never official acceptance."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/native'))
import common as c
import build as builder
import runtime_pruning

def adapted_spec_path(run):
    # PyInstaller derives work/<stem> from this basename. The original builder
    # admits its generated base_library.zip only under work/native-engine/.
    return run/'native-engine.spec'

def validate_local_runtime_output(config, closure, files, stderr):
    """Apply the same exact pruning/import/output checks as the native builder."""
    recipe_path=ROOT/runtime_pruning.RECIPE
    recipe=runtime_pruning.validate_recipe(c.read(recipe_path))
    runtime_pruning.validate_pruning(config,recipe,closure['runtimePruning'],c.identity(recipe_path))
    unresolved=[{'dll':dll,'dependentSource':source.replace('\\\\','\\')}for dll,source in re.findall(r"Library not found: could not resolve '([^']+)', dependency of '([^']+)'",stderr)]
    observed=sorted((r['dll'].casefold(),Path(r['dependentSource']).name.casefold())for r in unresolved)
    expected=sorted((r['dll'].casefold(),r['dependent'].casefold())for r in runtime_pruning.expected_unresolved_imports(config['profile'],recipe,closure['runtimePruning']))
    c.require(observed==expected,'Unresolved DLL set differs from explicit profile/recipe')
    for row in unresolved:
        source=Path(row['dependentSource']);c.safe(config['runtimeLockRoot'],source)
        row['dependentSource']=c.identity(source)
    return {'runtimePruning':closure['runtimePruning'],'runtimeOutputCheck':runtime_pruning.validate_output(files,recipe),'unresolvedImportedDlls':unresolved}


def finalize_local_bundle(config, bundle, closure, graph, stderr):
    # Ownership copies required notices/licenses into the bundle. Capture the
    # final membership only after that single side-effecting call completes.
    ownership=builder.ownership(config,bundle,closure,graph)
    files=c.inventory(bundle)
    return {'files':files,'dependencyOwnership':ownership,**validate_local_runtime_output(config,closure,files,stderr)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id',required=True)
    parser.add_argument('--preparation',required=True,type=Path)
    parser.add_argument('--timeout-seconds',type=int,default=2700)
    args=parser.parse_args()
    c.require(re.fullmatch('[a-z][a-z0-9-]{0,50}',args.run_id),'Fresh ASCII run ID required')
    c.require(0<args.timeout_seconds<=2700,'Compilation limit must not exceed 45 minutes')
    config=c.configuration()
    declared=c.read(ROOT/'source-native-identity.json')
    for row in declared['sourceFiles']+declared['builderSources']: c.check(row)
    c.require(declared['sourceFiles']==[c.identity(ROOT/name)for name in config['profile']['nativeSources']],'Native declaration source list differs')
    c.require(declared['builderSources']==[c.identity(ROOT/name)for name in builder.BUILDERS],'Original builder identities differ')
    prep_path=c.safe(ROOT,args.preparation.absolute());prep=c.read(prep_path)
    c.require(prep['passed'] is True and prep['scienceExecuted'] is False,'Fresh actual preparation required')
    for key in ('runtimeLock','toolchainLock','xtbLock'):
        c.require(prep[key]==config[key+'Identity'],'Preparation lock differs')
        c.verify_lock(config[key],config[key+'Root'])
    probe=c.read(c.check(prep['importProbe']))
    python=config['toolchainLockRoot']/config['toolchainLock']['python']
    c.require(Path(probe['executable']).resolve()==python.resolve() and probe['passed'] is True,'Current-root import probe required')
    run=c.safe(ROOT,ROOT/'.cache/builds'/('local-source-'+args.run_id))
    c.require(not run.exists(),'Previous build/failure protected')
    (run/'temp').mkdir(parents=True)
    contract=builder.current_contract(config);contract_path=run/'source-contract.json';c.write_new(contract_path,contract)
    spec=(ROOT/config['profile']['spec']).read_text(encoding='utf-8')
    replacements={"root = Path(SPECPATH).parents[1]":"root = Path(os.environ['SY_SOURCE_ROOT'])",
      "context = builder.inputs(config, Path(os.environ['SCIYUE_NATIVE_CONTRACT']), Path(os.environ['SCIYUE_NATIVE_REVIEW']), os.environ['SCIYUE_NATIVE_REVIEW_SHA256'])":
      "context = {'contract': common.read(Path(os.environ['SCIYUE_NATIVE_CONTRACT'])), 'buildContract': common.identity(Path(os.environ['SCIYUE_NATIVE_CONTRACT']))}"}
    for old,new in replacements.items():
        c.require(spec.count(old)==1,'Adapter anchor changed');spec=spec.replace(old,new)
    spec_path=adapted_spec_path(run);spec_path.write_text(spec,encoding='utf-8')
    env=c.clean_environment(config,run/'temp')
    env.update(SY_SOURCE_ROOT=str(ROOT),SCIYUE_NATIVE_RUN=str(run),SCIYUE_NATIVE_CONTRACT=str(contract_path),PYINSTALLER_CONFIG_DIR=str(run/'pyinstaller-cache'))
    worker=run/'worker.py'
    worker.write_text("import os,sys\nfrom pathlib import Path\nroot=Path(os.environ['SY_SOURCE_ROOT'])\nsys.path.insert(0,str(root/'scripts/native'))\nimport common as c\ncfg=c.configuration();c.activate(cfg);c.initialize_pyinstaller_children(cfg,Path(os.environ['SCIYUE_NATIVE_RUN'])/'isolated-children')\nimport PyInstaller.__main__\nPyInstaller.__main__.run(sys.argv[1:])\n",encoding='utf-8')
    command=[str(python),'-I','-B',str(worker),str(spec_path),'--distpath',str(run/'native'),'--workpath',str(run/'work'),'--log-level','INFO']
    started=datetime.now(timezone.utc).isoformat();timed_out=False
    with(run/'stdout.log').open('x',encoding='utf-8')as out,(run/'stderr.log').open('x',encoding='utf-8')as err:
        process=subprocess.Popen(command,cwd=run,env=env,stdout=out,stderr=err,creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name=='nt' else 0)
        try: process.wait(timeout=args.timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out=True
            if os.name=='nt':subprocess.run([str(Path(os.environ['SystemRoot'])/'System32/taskkill.exe'),'/PID',str(process.pid),'/T','/F'],capture_output=True)
            else:process.kill()
            process.wait()
    c.write_new(run/'execution.json',{'command':command,'pid':process.pid,'startedAt':started,'closedAt':datetime.now(timezone.utc).isoformat(),'returnCode':process.returncode,'timedOut':timed_out,'officialAcceptance':False})
    c.require(not timed_out and process.returncode==0,'Build failed; logs retained')
    c.require(builder.current_contract(config)==contract,'Source/configuration changed during build')
    c.activate(config);bundle=run/'native/engine';closure=c.read(run/'analysis-closure.json')
    c.require(closure['sourceFiles']==contract['sourceFiles'] and closure['buildContract']==c.identity(contract_path),'Analysis contract differs')
    builder.validate_native_source_presence(config['profile'],contract['sourceFiles'],closure['files'])
    adaptations=builder.validate_frozen_dependency_adaptations(config,run,closure['files'],closure['frozenDependencyAdaptations'])
    graph=c.native_graph(bundle)
    stderr=(run/'stderr.log').read_text(encoding='utf-8')
    bundle_metadata=finalize_local_bundle(config,bundle,closure,graph,stderr)
    c.require(not any('openbabel' in p.as_posix().casefold()for p in bundle.rglob('*')),'Excluded Open Babel entered product')
    receipt={'schema':'sy-local-native-self-build/v1','buildSucceeded':True,'officialAcceptance':False,'scientificAccepted':False,'preparation':c.identity(prep_path),'sourceContract':c.identity(contract_path),'sourceFiles':contract['sourceFiles'],'builderSources':contract['builderSources'],'adapter':c.identity(Path(__file__)),'adaptedSpec':c.identity(spec_path),'frozenDependencyAdaptations':adaptations,'output':bundle.relative_to(ROOT).as_posix(),**bundle_metadata}
    c.write_new(run/'local-native-receipt.json',receipt)
    print(json.dumps({'receipt':str(run/'local-native-receipt.json'),'officialAcceptance':False}))

if __name__=='__main__':main()
