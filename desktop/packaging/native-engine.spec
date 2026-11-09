"""Current native freeze; all sources are admitted by stable content locks."""
import os
import sys
from pathlib import Path

root = Path(SPECPATH).parents[1]
sys.path.insert(0, str(root / 'scripts/native'))
import common
import build as builder
import runtime_pruning
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_delvewheel_libs_directory, copy_metadata

config = common.configuration()
common.activate(config)
profile = config['profile']
runtime_recipe_path = root / runtime_pruning.RECIPE
runtime_recipe = runtime_pruning.validate_recipe(common.read(runtime_recipe_path))
run = common.safe(root / '.cache/builds', Path(os.environ['SCIYUE_NATIVE_RUN']))
context = builder.inputs(config, Path(os.environ['SCIYUE_NATIVE_CONTRACT']), Path(os.environ['SCIYUE_NATIVE_REVIEW']), os.environ['SCIYUE_NATIVE_REVIEW_SHA256'])
datas = collect_data_files('rdkit', excludes=['**/test*', '**/Test*', '**/UnitTest*'])
datas += collect_data_files('ase', excludes=['test/**', 'gui/**'])
datas += collect_data_files('spglib')
datas += [(str(root / 'src/data/conformer-solvation.json'), '.')]
for package in profile['metadataPackages']:
    datas += copy_metadata(package)
binaries = sum((collect_dynamic_libs(package) for package in ('rdkit', 'numpy', 'scipy', 'spglib', 'tblite')), [])
for package in ('numpy', 'scipy'):
    datas, binaries = collect_delvewheel_libs_directory(package, datas=datas, binaries=binaries)
library_binaries, library_selection = runtime_pruning.select_library_dlls(config, runtime_recipe)
binaries += library_binaries
a = Analysis([str(root / profile['entry'])], pathex=[str(root / 'desktop/chemistry')], binaries=binaries, datas=datas,
             hiddenimports=list(dict.fromkeys([Path(name).stem for name in profile['nativeSources']] + profile['hiddenImports'] + ['analysis_result_wire'])), excludes=profile['excludes'], noarchive=False)
a.binaries, binary_deduplication = builder.deduplicate_binaries(config, list(a.binaries), run, context['contract'])
namespaces = {}
for target, source, kind in a.pure:
    if source in (None, '-'):
        node = a.graph.find_node(target)
        namespaces[target] = {'nodeType': type(node).__name__, 'paths': list(node.packagepath or [])}
rows = builder.analysis_rows(config, list(a.scripts) + list(a.pure) + list(a.binaries) + list(a.datas), namespaces, run, context['contract'])
original_pure = a.pure
a.pure, a.datas, rows, frozen_adaptations = builder.freeze_rdkit_paths(config, list(a.pure), list(a.datas), rows, run)
# Keep unchanged Analysis code objects; compile only the declared transformed source.
from PyInstaller.config import CONF
code_cache = CONF['code_cache'].get(id(original_pure))
if code_cache is not None:
    transformed_cache = dict(code_cache)
    transformed_cache.pop('rdkit.RDPaths', None)
    CONF['code_cache'][id(a.pure)] = transformed_cache

a.binaries, rows, runtime_pruning_evidence = runtime_pruning.prune_analysis(
    list(a.binaries), rows, runtime_recipe, library_selection, common.identity(runtime_recipe_path))
common.write_new(run / 'analysis-closure.json', {'schema': 'sciyue-native-analysis-closure-v1', 'buildContract': context['buildContract'],
                 'sourceFiles': context['contract']['sourceFiles'], 'globalFallback': False, 'files': rows,
                 'binaryDeduplication': binary_deduplication, 'runtimePruning': runtime_pruning_evidence,
                 'frozenDependencyAdaptations': frozen_adaptations})
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='engine', debug=False, bootloader_ignore_signals=False,
          strip=False, upx=False, console=True, disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='engine')
