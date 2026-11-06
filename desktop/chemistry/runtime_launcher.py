"""Fixed chemistry entry and opt-in, model-free native runtime diagnostics.

Normal argv/stdio behavior uses the existing fixed worker entrypoints. Ordinary
chemistry and callbacks that require engine stay with engine. This entry never
accepts a module, script, file, or arbitrary code from the caller.
"""
from __future__ import annotations

import sys


def parse_openblas_configuration(configuration):
    import re
    return {"use64bitint": "USE64BITINT" in configuration.split(), "dynamicArch": "DYNAMIC_ARCH" in configuration.split(),
            "maxThreads": int(re.search(r"(?:^|\s)MAX_THREADS=(\d+)(?:\s|$)", configuration).group(1)) if re.search(r"(?:^|\s)MAX_THREADS=(\d+)(?:\s|$)", configuration) else None}


def query_loaded_configuration(path, loader=None):
    import ctypes
    if loader is None:
        loader = ctypes.CDLL
    library = loader(path)
    # Query the exact already-loaded library, including its wheel symbol ABI.
    for symbol in ("scipy_openblas_get_config64_", "scipy_openblas_get_config", "openblas_get_config64_", "openblas_get_config"):
        function = getattr(library, symbol, None)
        if function is None:
            continue
        function.argtypes = []
        function.restype = ctypes.c_char_p
        value = function()
        if not value or len(value) > 1024:
            raise RuntimeError("Invalid runtime configuration")
        return parse_openblas_configuration(value.decode("ascii"))
    raise RuntimeError("Actual OpenBLAS configuration symbol unavailable")


def component_info(consumer, pool, root, loader=None):
    import hashlib
    from pathlib import Path
    path = Path(pool["filepath"]).resolve()
    root = Path(root).resolve()
    if not path.is_relative_to(root) or pool["internal_api"] != "openblas" or pool["user_api"] != "blas":
        raise RuntimeError("Unexpected runtime library")
    configuration = query_loaded_configuration(str(path), loader)
    with path.open("rb") as stream:
        before = __import__('os').fstat(stream.fileno())
        digest = hashlib.sha256()
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
        after = __import__('os').fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError("Runtime library identity changed")
    return {"consumer": consumer, "library": "OpenBLAS", "libraryVersion": pool["version"],
            "integerAbi": "ILP64" if configuration["use64bitint"] else "LP64", "integerBits": 64 if configuration["use64bitint"] else 32,
            "abiObserved": True, "threadsObserved": True, "threadCount": pool["num_threads"], "threadingLayer": pool["threading_layer"],
            "configuredThreadLimit": pool["num_threads"], "threadsObservationMeaning": "native configured BLAS thread limit in this diagnostic process",
            "architecture": pool["architecture"], "path": path.relative_to(root).as_posix(), "bytes": before.st_size,
            "sha256": digest.hexdigest(), "configuration": configuration}


def runtime_info(development_roots=None, loaded_modules=None):
    import os
    import importlib.metadata as metadata
    from pathlib import Path
    import numpy
    import scipy
    # Both mathematical backends must actually be loaded before observation.
    from numpy.linalg import _umath_linalg
    from scipy.linalg import _fblas, _flapack
    from scipy.optimize import _lbfgsb, _slsqplib
    import threadpoolctl
    frozen = bool(getattr(sys, "frozen", False))
    root = Path(sys.executable).parent if frozen else Path(sys.prefix)
    development = None
    if development_roots is not None:
        if frozen or set(development_roots) != {"toolchain", "scientific"}:
            raise RuntimeError("Invalid development diagnostic roots")
        development = {key: Path(value).resolve() for key, value in development_roots.items()}
        if development["toolchain"] != Path(sys.prefix).resolve() or development["toolchain"] != Path(sys.executable).resolve().parent:
            raise RuntimeError("Development interpreter escaped the fixed toolchain")
        if development["toolchain"] == development["scientific"] or not development["scientific"].is_dir():
            raise RuntimeError("Separate locked scientific root required")
        root = development["scientific"]
    pools = threadpoolctl.threadpool_info()
    components = []
    for consumer, module in (("numpy", numpy), ("scipy", scipy)):
        library_directory = Path(module.__file__).resolve().parent.parent / (consumer + ".libs")
        matched = [row for row in pools if row.get("user_api") == "blas" and Path(row["filepath"]).resolve().parent == library_directory]
        if len(matched) != 1:
            raise RuntimeError("Consumer runtime observation is incomplete")
        components.append(component_info(consumer, matched[0], root))
    versions = {name: metadata.version(name) for name in ("numpy", "scipy", "rdkit", "ase")}
    python_version = '.'.join(map(str, sys.version_info[:3]))
    if any(Path(row["filepath"]).name.lower().startswith("mkl") for row in pools):
        raise RuntimeError("Mixed mathematical backend")
    extra = {}
    if development is not None:
        package_paths = {name: str(Path(module.__file__).resolve()) for name, module in (("numpy", numpy), ("scipy", scipy), ("threadpoolctl", threadpoolctl))}
        if any(not Path(value).is_relative_to(root) for value in package_paths.values()):
            raise RuntimeError("Diagnostic Python module escaped scientific root")
        modules = loaded_modules() if loaded_modules is not None else []
        windows = Path(os.environ.get("SystemRoot", "C:/Windows")).resolve()
        if not modules or any(not any(Path(value).resolve().is_relative_to(allowed) for allowed in (*development.values(), windows)) for value in modules):
            raise RuntimeError("Diagnostic native module escaped fixed roots/Windows")
        extra = {"runtimeRoots": {key: str(value) for key, value in development.items()},
                 "packagePaths": package_paths, "loadedNativeModules": modules,
                 "rootMeaning": "fixed-current-lock-development-roots-not-live-full-inventory-verification"}
    return {"schema": 1, "kind": "sciyue-runtime-info", "scope": "local-runtime-diagnostics", "backend": "OpenBLAS",
            "pythonVersion": python_version, "versions": {"python": python_version, **versions}, "frozen": bool(getattr(sys, "frozen", False)),
            "threadpoolctlVersion": metadata.version("threadpoolctl"), "components": components, "mklObserved": False,
            "diagnosticProcess": {"pid": os.getpid(), "scope": "this-diagnostic-process", "perFrameThreadObservation": False},
            "modelDataIncluded": False, "scienceExecuted": False, **extra}


def science_module(args):
    # Keep engine's existing dispatch precedence, including combined flags.
    # The empirical worker receives engine-owned run/error callbacks there.
    entries=(('--capabilities','engine'),('--crystal-modeling','crystal_modeling'),
             ('--crystal-modeling-worker','crystal_worker'),('--xtb-periodic','xtb_periodic'),
             ('--advanced-path','advanced_path'),('--conformer-sampling','conformer_sampling'),
             ('--electronic-analysis','electronic_analysis_worker'),('--interactions','interaction_worker'),
             ('--surface','surface_worker'),('--empirical-worker','engine'),
             ('--analysis','wavefunction_analysis'),('--orbitals','orbitals_worker'),('--dynamics','dynamics'))
    return next((module for flag,module in entries if flag in args),'engine')


def main(argv=None, science_runner=None, diagnostic_runner=None):
    args = sys.argv[1:] if argv is None else argv
    if args == ["--runtime-info"]:
        import json
        try:
            result = (runtime_info if diagnostic_runner is None else diagnostic_runner)()
            sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
            return 0
        except Exception:
            # Customer diagnostics contain no developer/CI paths or traceback.
            sys.stdout.write(json.dumps({"schema": 1, "kind": "sciyue-runtime-info-error", "error": "runtime-observation-failed",
                                        "modelDataIncluded": False, "scienceExecuted": False}, separators=(",", ":")) + "\n")
            return 1
    if "--runtime-info" in args:
        import json
        sys.stdout.write(json.dumps({"schema": 1, "kind": "sciyue-runtime-info-error", "error": "runtime-info-requires-exact-argv",
                                    "modelDataIncluded": False, "scienceExecuted": False}, separators=(",", ":")) + "\n")
        return 1
    if science_runner is None:
        import runpy
        science_runner = lambda: runpy.run_module(science_module(args), run_name="__main__", alter_sys=False)
    science_runner()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
