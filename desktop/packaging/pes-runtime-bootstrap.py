"""Start the PES worker using the portable, product-owned Python closure."""

import os
from pathlib import Path
import runpy
import sys


_DLL_HANDLES = []


def activate():
    root = Path(__file__).resolve().parent
    python = root / "python"
    if Path(sys.executable).resolve() != python / "python.exe":
        raise RuntimeError("The PES worker requires its bundled Python executable")
    if sys.version_info[:3] != (3, 12, 13) or not sys.flags.isolated:
        raise RuntimeError("The PES worker requires the locked isolated Python runtime")

    libraries = python / "Library" / "bin"
    for directory in (libraries, python, python / "DLLs"):
        _DLL_HANDLES.append(os.add_dll_directory(str(directory)))
    sys.path[:] = [
        str(root / "chemistry"),
        str(root / "site-packages"),
        str(python / "Lib"),
        str(python / "DLLs"),
        str(python),
    ]
    os.environ["MPLBACKEND"] = "Agg"
    os.environ["JAX_PLATFORMS"] = "cpu"
    return root


if __name__ == "__main__":
    if sys.argv[1:] != ["--pes-worker"]:
        raise SystemExit("Expected the PES worker entrypoint")
    runtime = activate()
    runpy.run_path(str(runtime / "chemistry" / "pes_worker.py"), run_name="__main__")
