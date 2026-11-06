# Rebuilding the six Fortran libraries without developer paths

These build controls accompany the exact retained source tree and LP64 BLAS/LAPACK import libraries. They rebuild toml-f 0.5.2, mctc-lib 0.5.2, multicharge 0.5.0, dftd4 4.2.0, s-dftd3 1.4.0 and tblite 0.7.0; static toml-f 0.5.0 and jonquil 0.3.0 supply the original JSON support.

Required layout:

```text
native-fortran/
  build-fortran.py
  controls/
  recipes/
  source.tar.gz           # Metadata-clean archive of the 3550 exact source files
  source/                 # Created by extracting source.tar.gz
  link/libblas.dll.a       # Pinned LP64 import library
  link/liblapack.dll.a     # Pinned LP64 import library
  source-manifest.json
```

Use Windows x64 GNU Fortran/GCC 13.2.0 (UCRT, POSIX threads, SEH), CMake 3.29.2, Ninja, and an existing Python 3.9 or newer interpreter. The compiler and CMake executable hashes used for the retained build are recorded in the accompanying toolchain identity file. No package installation or network download occurs in these controls.

First extract the supplied archive from this directory. It contains only regular files under `source/`, including the upstream license texts and original test sources, with neutral tar/gzip ownership and timestamp metadata:

```text
python -m tarfile -e source.tar.gz .
```

The extracted `source/` tree must match every path, byte count and SHA256 in `source-manifest.json`. Then, from an existing Python interpreter, run:

```text
python build-fortran.py --toolchain-bin <absolute-toolchain-bin-directory> --parallel 4
```

The supplied `link/*.dll.a` files are neutral import stubs regenerated with the same GNU13.2 `dlltool`, original export definitions, machine type and DLL names. Their complete imported DLL names, symbols, ordinal hints and machine types match the original archives. Original archives had local directory text in their linker bookkeeping names. The six validated runtime DLLs were built with those original interface-equivalent archives; the newly supplied neutral archives were not substituted into that historical build or tested through another six-library rebuild.

`link-identities.json` identifies the actual supplied neutral archives. They contain import interfaces and no replacement BLAS/LAPACK numerical implementation. The original runtime BLAS/LAPACK DLLs remain separate dependencies. To recreate these import stubs, run the same tool from the `link/` directory and use relative input/output filenames:

```text
<toolchain-bin>/dlltool.exe --machine i386:x86-64 --dllname libblas.dll --input-def libblas.dll.def --output-lib libblas.dll.a
<toolchain-bin>/dlltool.exe --machine i386:x86-64 --dllname liblapack.dll --input-def liblapack.dll.def --output-lib liblapack.dll.a
```

`recipe-provenance.json` maps each of the eight parts to its upstream source identifier, exact source files, original final recipe hash and portable recipe hash. The portable changes are path derivation and compiler/preprocessor launcher setup; original optional feature flags and final dependency corrections remain in the recipes.

The output tree must be fresh. All original numerical source bytes, Release options, precision, OpenMP and LP64 interfaces, final explicit DLL exports and ordinals, and dependency/link settings are retained. The build-time launcher converts only existing controlled absolute Fortran input filenames into equivalent relative paths from the compiler working directory. Both compilation and CMake's separate Fortran preprocessing use this launcher. Every original/actual compiler argv is recorded under `compiler-argv/`. Python is only a build-time launcher; the generated DLLs do not acquire a Python runtime dependency from it.

The default compiler `-ffile-prefix-map` option does not remove GNU13.2 Fortran runtime diagnostic filenames. These controls preserve diagnostics while avoiding a local machine root in their source filenames. The files are rebuilt from source; no output DLL byte patch is performed.

`records/` contains actual configure/compile commands and exit statuses. Successful compilation alone does not establish numerical equivalence. Before distributing replacements, compare complete PE imports/exports/ordinals/data types, verify that dependencies load from the intended runtime, inspect every DLL for local paths, and validate the affected numerical entry points using fixed existing representative inputs and tolerances. The original build's optional feature choices remain in each recipe; these controls do not enable disabled algorithms or tests.
