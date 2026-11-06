# xTB GNU scientific executable: exact corresponding source and rebuild

This supplement provides the preferred source for the actual14,613,972-byte GNU `xtb.exe` built from main commit `5071a8869720fb0ecd788af977159869b64a277c`, reported version6.7.0. The separate `GNU-RUNTIME-REBUILD.md` rebuilds its GNU/support DLLs. Runtime DLL sources alone do not replace this scientific-program source.

`XTB-GNU-SOURCE-INDEX.json` pins **12 complete original archives**, their exact commits/tags, URLs, lengths and SHA256; they are supplied under `archives/xtb-gnu/` (22,589,030 bytes). No dependency is left at `head`. All archives were actually available and hashed when this supplement was prepared. The reconstructed clean preferred-source tree contains2,539 files, including source, Meson/CMake/configuration helpers, templates, parameters, upstream tests and original notices needed by the actual source graph. Its947 Fortran/C/header scientific files retain their original archive bytes.947 is a scientific-file metric, not the total source delivered.

The full pin table follows in `XTB-GNU-SOURCE-INDEX.json`; main plus all actual subprojects are included: dftd4, mctc-lib, tblite, cpcmx/cpx, multicharge, toml-f, s-dftd3, numsa, JSON-Fortran, mstore and test-drive. The Go toml-test archive is not required/fetched by the built `xtb.exe` target; it remains an upstream test-only reference, not an omitted runtime dependency. The exact tblite commit is intentional; substituting a nearby release changes its required API and is not this recipe.

## Source layout and the38 build-only overlays

Sources are materialized from their original archives, not copied out of an installed environment or a polluted build directory. No `.git` database, compiled objects, build cache, installed executable/DLL or private execution control is added as source. Original `.gitignore`/`.gitmodules` files and generated upstream preferred-source files remain part of the complete upstream archives; their names do not make them installed binaries.

`XTB-SOURCE-TREE.json` gives each preferred file's path/bytes/SHA after the explicit build-only overlays. `XTB-SOURCE-VERIFICATION.json` is the original byte verification receipt copied without reserialization, so its SHA matches the earlier scientific source receipt. `XTB-ACTUAL-BUILD-EVIDENCE.json` connects that source, the exact build configuration, successful compilation, PE stack and actual executable SHA. The original source/build receipt hashes are retained without publishing private machine paths or old failure logs.

`build-support/xtb-gnu/BUILD-OVERLAYS.json` records all38 target paths, original/final SHA and reasons. The matching final files are supplied under its `overlays/` directory. These overlays are:

1. Exact offline wrap-file wiring shared across the actual Meson dependency graph; archives/directories/hashes are fixed and network fallback is disabled.
2. The unchanged mctc-lib0.3.1 upstream Meson overlay for JSON-Fortran8.2.5, placed at the JSON source root.
3. Export of the CPCM-X generated Fortran module include directory to dependent xTB targets.

The cpcmx source directory is materialized as `subprojects/cpx`; JSON-Fortran is `subprojects/json-fortran-8.2.5`. None of these changes modifies scientific routines, constants, parameters or method definitions. They are not hidden algorithm patches. Six parameter files are pinned individually in the source index and copied unchanged by the default build.

## Required build inputs

- Windows x64 and a functioning Python3.11+ that can import its own standard-library `ctypes` and `zlib`. This recipe does not install Python or modify Conda/system settings.
- Exact WinLibs GCC/gfortran13.2.0, UCRT MinGW-w64 11.0.1 r7 ZIP, including Ninja1.12.0. Exact URL/length/hash are indexed; it is a separately obtained bootstrap tool, not a source archive or a product runtime-source substitute.
- Exact Meson1.4.1 wheel,937,686 bytes, SHA256 `d5acc3abae2dad3c70ddcbd10acac92b78b144d34d43f40f5b8ac31dfd8a826a`. It is privately extracted and run without pip installation. The indexed official wheel URL is fixed.
- The six corresponding GNU/support DLLs built with the separate GNU runtime guide, or the supplied compatible frozen runtime set, **plus its source/build receipt**. The script accepts `sy-gnu-runtime-user-rebuild-v1` or the frozen `sy-xtb-r2-source-receipt-v1`, and checks that the selected six DLL bytes actually match that receipt.
- The delivered, unchanged OpenBLAS0.3.34 LP64 `openblas.dll` and its matching app-local `VCRUNTIME140.dll`. The source index pins both bytes/SHA; OpenBLAS config was actually observed as `OpenBLAS 0.3.34 DYNAMIC_ARCH NO_AFFINITY Haswell MAX_THREADS=128`, without USE64BITINT. These are explicit shared-library inputs, not binaries mislabelled as preferred source. Rebuilding/replacing that math library is outside this fixed primary recipe.

The source controller does not download anything, accept agreements, run installers, modify global PATH or query a system scientific fallback. It keeps the existing OpenBLAS/VC bytes, derives an import `.def` with the pinned WinLibs gendef, and builds its import library with dlltool. The resulting `.dll.a` is a build output, never the supplied preferred source.

## Executable parameterized commands

Run from the exported source checkout. Choose caller-owned actual paths and a new ASCII work directory using letters/digits/dot/underscore/hyphen. The examples are placeholders for your own paths, not developer-machine paths. The GNU guide's `runtime-out/bin` supplies the six GNU DLLs and `runtime-rebuild-receipt.json` binds them. `MathBin` supplies the unchanged OpenBLAS/VC pair from the delivered runtime.

```powershell
$Python = 'C:/Tools/Python311/python.exe'
$BootstrapDir = 'D:/gnu-bootstrap-archives' # exact WinLibs ZIP and Meson wheel
$WorkRoot = 'D:/xtb-source-work-a01'        # must not exist for prepare
$GnuBin = 'D:/gnu-runtime-work-a01/runtime-out/bin'
$GnuReceipt = 'D:/gnu-runtime-work-a01/runtime-out/runtime-rebuild-receipt.json'
$MathBin = 'D:/delivered-xtb-runtime/bin'    # unchanged OpenBLAS and VC
$Sources = (Resolve-Path './third-party/corresponding-sources').Path
$Recipe = Join-Path $Sources 'build-support/xtb-gnu/rebuild-xtb.py'
$Index = Join-Path $Sources 'XTB-GNU-SOURCE-INDEX.json'

& $Python -s -B $Recipe plan --index $Index --archive-dir $BootstrapDir --work-root $WorkRoot --gnu-runtime-bin $GnuBin --runtime-source-receipt $GnuReceipt --math-bin $MathBin
& $Python -s -B $Recipe prepare --index $Index --archive-dir $BootstrapDir --work-root $WorkRoot --gnu-runtime-bin $GnuBin --runtime-source-receipt $GnuReceipt --math-bin $MathBin
& $Python -s -B $Recipe build --index $Index --work-root $WorkRoot --gnu-runtime-bin $GnuBin --runtime-source-receipt $GnuReceipt --math-bin $MathBin --jobs 4 --memory-gib 8 --max-seconds 5400
```

`plan` hashes inputs and prints the intended actions; it executes no native tools and does not create the work root. `prepare` extracts the full source graph, applies only the38 checked build overlays and materializes private compiler/Meson tools. It executes no scientific or compiler program. `build` explicitly compiles only `xtb.exe` and assembles its runtime/parameter output. Each actual build command is bounded by a Windows Job assigned before resume, with affinity, memory, wall deadline and tree lifetime. An attempted build directory is retained; a retry requires a fresh prepared root.

## Successful configuration reproduced by the controller

The actual successful operations used Meson1.4.1, Ninja1.12.0 and GCC/gfortran13.2.0. The fixed options are:

```text
--buildtype=release
--default-library=static
--wrap-mode=nodownload
--force-fallback-for=mctc-lib,json-fortran,json-fortran-8.2.5,tblite,multicharge,dftd4,cpx,numsa,s-dftd3,toml-f,test-drive,mstore
-Dtblite=enabled -Dcpcmx=enabled -Dopenmp=true -Dgpu=false
-Dlapack=openblas -Dmctc-lib:json=enabled
```

The native file names exact C/Fortran/ar/strip/Python tools. Its Fortran link arguments include the private OpenBLAS import-library directory and **`-Xlinker --stack -Xlinker 67108864,4096`**. The output PE must report64MiB stack reserve and4096-byte commit; the controller reads and checks those fields without running the executable. C link arguments use the same OpenBLAS import-library directory. `LIBRARY_PATH` is that private directory; CMake/pkg-config searches are isolated and Meson uses only the fully materialized fallback graph.

The source graph is static within the executable while OpenBLAS and runtime DLLs stay separate. The successful historical build's `ninja -j4 xtb.exe` took62.046851 seconds, exited0 and measured538,578,944 bytes peak Job memory under8GiB. Its executable SHA256 is `8ee086b79963b1214a1bec753712cc46e5e430d510f0fad3c88f20b130b6db3b`,14,613,972 bytes. These are existing actual operation receipts. The parameterized packaging controller has been syntax/hash/zero-execution-plan checked; this supplement preparation did not compile the executable again. A new user build has its own date/author/host/build name and may have different binary bytes. No bit-identical-build promise is made.

## Modified-source rebuild and admission

After `prepare`, edit the preferred sources under `WorkRoot/source/`, then invoke `build` with `--local-modified`. The controller records modified/added files, the complete actual source-file hash tree, exact pins, selected GNU-runtime receipt and emitted file hashes. It does not silently rewrite source to pass a test or substitute another dependency version. Keep changes to methods/parameters scientifically explicit; validation of a user-modified model is the user's separate responsibility.

The output is `WorkRoot/output/`: `bin/xtb.exe`, the six selected GNU/support DLLs, unchanged OpenBLAS/VC, six parameters under `share/xtb/`, actual preferred-source hashes, the GNU runtime source receipt and `xtb-build-receipt.json` (`sy-xtb-gnu-user-source-build-v1`). The receipt declares local independent build, no official-binary identity, no new numerical validation and no product-ready claim. This is **not** a product runtime v2 descriptor.

Use the documented source-checkout admission CLI from `BUILDING.md` with explicit local-modified mode. That path validates the complete actual inventory, creates a truthful composite program/runtime/parameter source identity and separates caches/seeds. Do not overwrite an official library while retaining its old hash, edit the official lock as a workaround, or disable all integrity checks. Full preferred source and build controls allow recompiling the scientific executable and its static subprojects when relinking is required; the GNU guide also supplies produced import/static libraries for the shared-runtime replacement case.

The frozen supplied composition separately passed seven fixed water/TiO₂ representative regressions using its final DLL bytes and actual loaded-module observations. That evidence is for that exact frozen composition, not automatically for a freshly compiled or user-modified binary. No new Multiwfn field/grid, full-element/method/solvent/CPU matrix, GUI or public-release approval is asserted by this source recipe.

## Original licenses and delivery boundary

Twenty-four original notice/license files are additionally indexed under `licenses/xtb-gnu/`, while complete originals and per-file copyrights remain in the twelve source archives. xTB and its dependencies keep their own license terms; the application author's default restrictions do not replace their LGPL/GPL or other rights. Required corresponding build controls must be provided with rights compatible with the applicable component terms; final licensing exceptions are the distributor's explicit responsibility. This guide does not invent a new license or claim that an unadded exception already exists.

The supplement's `sourceAvailable` means actual exact source archives, checked preferred-source tree, necessary build-only overlays and controls are present. It does not mean the new packaging wrapper was compiled again, modified-library admission was fully accepted, or public distribution was authorized. The separate GNU runtime guide, OpenBLAS/VC material boundary and final source index must accompany the actual distributed composition.
