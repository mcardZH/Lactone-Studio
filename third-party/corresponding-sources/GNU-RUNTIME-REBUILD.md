# GNU xTB runtime: corresponding source and local rebuild

This recipe rebuilds the six separate runtime/support libraries used by the GNU xTB candidate: GCC13.2.0 libgcc/libgfortran/libgomp/libquadmath, MinGW-w64 11.0.1 winpthreads, and dlfcn-win32 1.4.1. It does not upgrade xTB, change scientific parameters, replace OpenBLAS/VC, run a scientific calculation or edit the product lock. The companion `XTB-GNU-REBUILD.md` covers the scientific executable and its separate pinned dependencies.

`GNU-RUNTIME-SOURCE-INDEX.json` pins the seven supplied source inputs by length and SHA256. Six are unchanged official releases/tag archives under `archives/gnu-runtime/`; GCC13.2.0 is the explicitly modified privacy-derived archive under `privacy-source-derivatives/`. Its original official URL, archive identity and upstream SHA512 are retained as provenance, separately from the supplied derived archive identity. The official original GCC archive is not part of the public payload.

The only GCC source omission is `gcc-13.2.0/libgo/go/debug/elf/testdata/hello-world-core.gz`, an upstream Go ELF-core test snapshot containing captured environment credential material. It is not input to the selected C/Fortran helper or runtime targets. Every remaining archive member's contents and logical metadata are independently verified unchanged; compiler/runtime implementation, targets, copyright and notices are preserved. No implementation source patch is supplied. `privacy-source-derivatives/DERIVATIVES.json` binds both original and supplied identities, exact omitted member identities and comparison evidence. Its GCC16.2.0 derivative serves the separately indexed native-library source supplement; this recipe still builds GCC13.2.0 only.

`GNU-RUNTIME-SOURCE-TREE.json` remains the unchanged historical inventory of 128,912 materialized source files from the original operation. It still lists that core fixture and its original completeness metadata describes that historical operation. The current control verifies `privacy-source-derivatives/SOURCE-TREE-OVERLAY.json`, removes only that exact matching inventory row and requires all other original rows unchanged, yielding 128,911 expected files. It does not relabel the historical inventory as a new source snapshot. Equivalent tar/PAX path-header encoding and compression can differ; source-file bytes do not. The privacy exclusion is recorded separately from user source modifications and does not require `--local-modified` for the supplied default.

## Source and bootstrap inputs

| Role | Fixed source |
|---|---|
| Four GCC runtime libraries and required compiler-generation code | GCC13.2.0, pinned privacy-derived release archive; exactly one non-build Go core test fixture omitted |
| Thread runtime and its original notices | MinGW-w64 v11.0.1; build `mingw-w64-libraries/winpthreads` |
| Windows dlopen support | dlfcn-win32 v1.4.1 |
| Compiler prerequisites | GMP6.2.1, MPFR4.1.0, MPC1.2.1, ISL0.24, matching GCC13.2's own prerequisite SHA512 list |

The script requires Windows x64, Python3.11+ standard library, and four separately obtained official bootstrap archives. They are build tools, are **not bundled as source**, and are listed with full URLs/lengths/hashes in `bootstrapToolsNotBundled`:

- WinLibs x86_64 POSIX/SEH GCC13.2.0 / MinGW-w64 UCRT11.0.1 r7 ZIP:225,869,222 bytes, SHA256 `87962f039c303764376b6a031edb7d4afab08abc89805c7055fa9dce5e764c9a`.
- MSYS2 base20260927 XZ archive:42,860,696 bytes, SHA256 `ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322`.
- MSYS POSIX make4.4.1-3:514,683 bytes, SHA256 `af0bdba17f06fe037f0194069adaa31a8fe45f1a11381501896aea1fae37bd5d`.
- MSYS diffutils3.12-1:394,515 bytes, SHA256 `7902c8ce3d4dd69a0f5e98dc9d5c83c17b23314ba486169db57ef6e2835ce3b6`.

Obtain those exact archives independently from the indexed official URLs and place them in a directory you select. The source control never downloads packages, runs an installer, calls pacman, changes the global PATH or accepts an installer agreement. It extracts all helpers into the selected private work directory, keeps their package metadata/notices and verifies the compiler/helper/sysroot file identities before building. MSYS2's own login profile would refresh its keyring, so the build uses `bash --noprofile --norc` and a complete explicit private environment instead.

## Parameterized commands

Run from the exported source checkout. Supply your actual Python executable, bootstrap-archive directory and a **new ASCII work directory** whose components contain only letters, digits, dot, underscore or hyphen. The directory must not exist for `prepare`. These variables are caller-selected paths; they are not developer machine paths.

```powershell
$Python = 'C:/Tools/Python311/python.exe'          # replace with your Python3.11+
$BootstrapDir = 'D:/gnu-bootstrap-archives'        # exact four archives above
$WorkRoot = 'D:/gnu-runtime-work-a01'             # new, dedicated directory
$Sources = (Resolve-Path './third-party/corresponding-sources').Path
$Recipe = Join-Path $Sources 'build-support/gnu-runtime/rebuild-gnu-runtime.py'
$Index = Join-Path $Sources 'GNU-RUNTIME-SOURCE-INDEX.json'

# Hash/plan only. This does not execute native tools or create the work directory.
& $Python -s -B $Recipe plan --index $Index --archive-dir $BootstrapDir --work-root $WorkRoot

# Extract verified supplied sources/tools and the private sysroot; no compilation.
& $Python -s -B $Recipe prepare --index $Index --archive-dir $BootstrapDir --work-root $WorkRoot

# Explicit native build: default4 jobs/8GiB, total build-command deadline5400s.
& $Python -s -B $Recipe build --index $Index --work-root $WorkRoot --jobs 4 --memory-gib 8 --max-seconds 5400
```

Each configure/make/CMake/strip command runs inside a Windows Job assigned before the child resumes, with affinity, total-memory, wall-deadline and kill-on-close guards. A failed attempted build is retained; use a fresh prepared work root for another attempt. A `build` invocation never runs xTB or Multiwfn. Inspect the logs and the resulting `runtime-out/runtime-rebuild-receipt.json`; success does not make that output an official product binary or numerically validated replacement.

## Exact build configuration and layout

The R0 support builds use CMake/Ninja Release/shared for dlfcn, and winpthreads configure with x86_64-w64-mingw32 build/host, shared+static, CFLAGS `-O2 -g0`, plus relative `--srcdir`. The parameterized control consistently uses the fixed MSYS POSIX shell/make for winpthreads; the original successful R0 operation used the same target/compiler/source flags with an existing POSIX shell and native make. That host-tool unification is not a claim of bit-identical R0 output.

GCC builds C+Fortran with release checking, 64-bit only, POSIX threads, SEH, shared runtime, libgomp/libquadmath/graphite, no bootstrap, no LTO/plugin/multilib or unused language runtime. All flags are explicit in the supplied script; C/C++ target arithmetic flags are `-O2 -g0`. Upstream Fortran-generated runtime sources use their generated Makefile flags; debug information is removed from final GCC-library copies, rather than changing scientific source.

The unpatched GCC13.2 MinGW target hardcodes `/mingw/include`; a seed sysroot containing only `/include` cannot satisfy that default. The control therefore copies the exact seed include/lib bytes into its own `sysroot/mingw/include` and `sysroot/mingw/lib`. It passes the official top-level make variable `SYSROOT_CFLAGS_FOR_TARGET=--sysroot=<private-sysroot>` to both build and install. No original seed file or GCC source is patched.

The selected targets are exactly:

```text
all-gcc all-target-libgcc all-target-libgfortran all-target-libgomp all-target-libquadmath
install-gcc install-target-libgcc install-target-libgfortran install-target-libgomp install-target-libquadmath
```

The compiler-generation step supplies libgcc's generated headers and `libgcc.mvars`; four unrelated standalone library configure commands are not an equivalent recipe. Original source mtimes are retained to avoid accidental regeneration requirements. Missing compiler manual tools may be reported by upstream install as ignored documentation targets; a missing DLL or failed required target remains a real failure and is not accepted as success.

## Output and user modifications

The complete install trees remain under the work root. The output directory has:

- `bin/`:six runtime/support DLLs, with GCC DLL copies processed only by `strip --strip-debug --preserve-dates` (never strip-all). Original install DLLs and hashes remain available.
- `relink/`:the corresponding produced import/static libraries for a compatible consumer relink.
- `source-tree.json`:actual input source file identities used by this build.
- `runtime-rebuild-receipt.json`:source/index/toolchain identities, actual flags, local source differences and emitted member hashes. It explicitly has no official-binary, numerical-validation or product-ready claim.

To exercise the source modification path, run `prepare`, edit the relevant materialized source under `work-root/source/`, then invoke the same build with `--local-modified`. For example, libquadmath sources are under `source/gcc-13.2.0/libquadmath/`. The recipe records changed/added source identities and emits an independent local candidate. It does not silently relabel modified bytes as the official default.

Supply the rebuilt libraries to the documented local/custom-runtime admission route from `BUILDING.md` / `XTB-GNU-REBUILD.md`, together with the rebuilt scientific executable and unchanged matching parameters. That route must validate the complete actual inventory, create a truthful independent build/source receipt and engine identity, and isolate seeds/caches. Keep the official product lock intact. Replacing a compatible LGPL library or relinking its consumer must remain possible; a fixed official-binary hash is not an excuse to disable all local modified builds.

Before using rebuilt output for science, compare its actual consumer imports/exports, architecture, DLL closure and required scientific values. When stripping, retain executable code/data/export/relocation/unwind sections and critical PE fields; only debug/file-layout metadata may change. The supplied operation evidence passed these checks for the frozen delivered candidate. The complete parameterized public script has been hash/plan/syntax checked; it has not been compiled a second time solely to test this packaging of the recipe. Its output timestamps/build paths can differ, so bit-for-bit identity is not promised. User-modified builds require their own appropriate validation.

## Licenses and correspondence boundary

Keep the supplied source archives and their per-file notices, together with the explicit privacy-derivative identity/omission record, not just a generic GNU license page. GCC libgcc/libgfortran/libgomp notices carry the applicable GPL/Runtime Library Exception terms; libquadmath has its own `COPYING.LIB` and per-file notices and must not be assigned the Runtime Library Exception by analogy. Winpthreads and dlfcn retain their exact original notices. Indexed copies are under `licenses/gnu-runtime/`; the source archives preserve the original notices. The two locally authored build controls have the narrow MIT exception in `build-support/gnu-runtime/BUILD-CONTROLS-LICENSE.txt`; the separate privacy sanitizer has its own narrow MIT exception in `privacy-source-derivatives/SANITIZER-LICENSE.txt`. These grants do not relicense the application or upstream components.

Bootstrap tools are separately obtained build inputs, not product runtime files or rehosted binary components in this source supplement. Using the same seed-tool ZIP identifies the build tool; it does not retrospectively certify the historical WinLibs runtime source patches. The rebuilt target-library source identity is the indexed unpatched GCC13.2 source plus its explicitly recorded configuration. Product/public-distribution approval, actual local replacement/relinking acceptance and any wider scientific certification are separate decisions.
