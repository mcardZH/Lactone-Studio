# Native corresponding-source supplement

The six unchanged archives in `archives/` supplement the existing tblite 0.7.0 library/Python, DFT-D4 4.2.0, simple-dftd3 1.4.0 and libiconv 1.18 archives. `sources.json` binds source URLs, byte counts and SHA-256 identities. Recipes and patches in `recipes/<original-package>/info/recipe/` are copied byte-for-byte from the original binary packages; their host/build pins identify the historical builds. These source materials do not assert that a locally compiled DLL is byte-identical to the historical DLL.

## Historical build inputs

Use each component's own `meta.yaml`, parent recipe, build script and patches. Keep the Windows libiconv CMakeLists/config.h/configure.cmake patches together. The tblite `find-lib.patch` defines its BLAS discovery. The original simple-dftd3 wrap patch references `mstore` test data at `head`; that mutable historical test-data revision is not represented as a fixed runtime DLL dependency. No test-suite replay is claimed by this supplement.

The native scientific libraries were built with GNU Fortran 14.3; the separately distributed GNU runtime libraries are 16.2. The full GCC 16.2 archive and the original GCC runtime recipe/Windows patches are supplied for libgcc, libgfortran, libgomp and libquadmath source correspondence. The source of libquadmath is governed by its own `COPYING.LIB` and file notices; the GCC Runtime Library Exception label must not replace those terms. The soft-fp headers retain LGPL 2.1-or-later with their explicit additional linking permission.

## Coherent local modified-library build

Use a private source/build/prefix tree, an explicit compatible compiler, CMake or Meson/Ninja as required by the selected original recipe, and no system package registry or implicit network fallback. With a different GNU compiler major version, rebuild every required Fortran module from source; do not feed existing GNU 14 `.mod` files to GNU 13.

Build support in this order: static toml-f 0.5.0, static jonquil 0.3.0 against that toml-f, shared mctc-lib 0.5.2 with those exact JSON dependencies, shared toml-f 0.5.2, shared multicharge 0.5.0, shared DFT-D4 4.2.0, shared simple-dftd3 1.4.0, then shared tblite 0.7.0. Preserve the original DLL basenames, public/data exports and ordinals used by consumers. Keep the original LP64 `libblas.dll`/`liblapack.dll` to `openblas.dll` forwarding route; do not substitute NumPy ILP64 or SciPy's separately bundled BLAS.

For standalone libquadmath, configure the `libquadmath` subdirectory of GCC 16.2 with explicit C compiler/binutils, the target Windows triplet, `--disable-multilib --enable-shared --disable-static`, and build only `libquadmath.la`. Preserve the archive's include/config/libgcc soft-fp support and its generated configure inputs. This does not require bootstrapping the GCC compiler.

For libiconv, apply the three original Windows CMake patches and build iconv.dll plus charset.dll as a pair. A MinGW rebuild need not reproduce unrelated MSVC CRT implementation artifacts, but any replacement contract exemption must be explicit and reviewed. Never supply fabricated CRT implementations.

Any local marker, DEF file, additional patch, build command/tool identity and output hash must accompany that modified build. Before activation, verify PE ABI/import closure and a bounded actual-load/numerical comparison in an isolated complete native bundle. Original CPython 3.12/CFFI tblite glue can remain only when its required C ABI is retained. These materials alone do not constitute successful modified-library loading or numerical equivalence.

Original license texts are retained under `licenses/` and original package notices under `recipes/`. jonquil and both toml-f versions retain their Apache-2.0 OR MIT texts, including the versions embedded statically in mctc-lib. This directory contains no local job receipts or developer runtime state.

Source archive paths in sources.json are relative to the public source-code root. GCC 16.2 is supplied as the declared privacy derivative under ../privacy-source-derivatives/, not the original credential-bearing test archive. The omitted Go core fixture is not used by libquadmath or the native runtime build.
