# Build Ester Studio (ES) and replace runtimes from the exported source

Ester Studio is the current name of SY-Studio/SciYue. The current naming contract
sets `.es` for new project saves with legacy `.sy` read compatibility; runtime
completion requires the release's actual validation. Historical source paths,
receipt schemas and internal compatibility identifiers retain their existing names.

Use Windows x64, Node.js 24 or newer (built-in zstd support), and an explicitly
selected Python >=3.12 as bootstrap tools. Run commands in the independent
exported source root. A source copy may be kept in Git. The tools do not install
globally, change PATH, execute a downloaded installer, or run scientific jobs.
Self-built output need not be bit identical to the maintained binary; it remains
unvalidated until separately tested.

## 1. Frontend and locked Electron bootstrap

```text
npm ci
npm run prepare:desktop
npm run build
```

Use the exact package-lock.json with development dependencies. prepare:desktop
explicitly acquires the locked Electron runtime when absent; build prepares the
source-controlled runtime assets and runs TypeScript/Vite. Exporting source does
not execute any of these commands.

## 2. Materialize the unchanged native and toolchain inputs

Inspect third-party/build-inputs/acquisition.json and its README. The exact
archive URLs, sizes/SHA256, member mappings, original native-runtime inventory
and toolchain inventory remain their fixed parent contracts. Do not substitute
an arbitrary pip/Conda environment or an installed compiler.

The GNU rebuild route explicitly skips the historical Intel xTB payload:

```text
python scripts/release/materialize.py plan --skip-xtb --cache=C:/owned/exact-archives
python scripts/release/materialize.py fetch --skip-xtb --cache=C:/owned/exact-archives
python scripts/release/materialize.py materialize --skip-xtb --cache=C:/owned/exact-archives
```

An offline cache with the exact declared archives is equally valid. Skipping
xTB removes only that payload and archives used exclusively by it; shared
archives and every selected native/toolchain member retain their original byte
identities. Existing or partial payload roots are protected, so use a fresh
source copy rather than merging them.

If an acquisition manifest still contains the historical xTB payload, omitting
both selection flags fails. --legacy-xtb explicitly selects that historical
contract for reproducing an old build; it is not a fallback for the new GNU
route. The original historical declarations/archives are not rewritten by this
selection. No old 15-member count, Intel support DLL list or old PE-header patch
is applied to a new GNU output.

## 3. Build the GNU xTB runtime from its actual corresponding sources

The two exact source-side entries are:

- [GNU-RUNTIME-REBUILD.md](third-party/corresponding-sources/GNU-RUNTIME-REBUILD.md): GNU runtime/support libraries and R0 support.
- [XTB-GNU-REBUILD.md](third-party/corresponding-sources/XTB-GNU-REBUILD.md): scientific source/pins, xTB executable, parameters and complete runtime integration.

Both files must actually exist and their exact path/bytes/SHA256 must be covered
by third-party/corresponding-source-index.json. The index must likewise cover
the referenced source archives and recipe files; a matching filename alone is
not sufficient. If any required indexed material is missing, stop. materialize
does not select another xTB binary or make build closure true by metadata.

The runtime guide's parameterized entry uses these exact public paths. Choose
your own bootstrap archive directory and a fresh ASCII source/build path:

```powershell
$SourceRoot = (Resolve-Path '.').Path
$Python = Read-Host 'Absolute bootstrap Python 3.12+ executable'
$BootstrapDir = Read-Host 'Directory of exact bootstrap archives named in the GNU guide'
$Sources = Join-Path $SourceRoot 'third-party/corresponding-sources'
$GNURecipe = Join-Path $Sources 'build-support/gnu-runtime/rebuild-gnu-runtime.py'
$GNUIndex = Join-Path $Sources 'GNU-RUNTIME-SOURCE-INDEX.json'
$GNUWork = Join-Path $SourceRoot 'build/gnu-runtime-a01'
& $Python -s -B $GNURecipe plan --index $GNUIndex --archive-dir $BootstrapDir --work-root $GNUWork
& $Python -s -B $GNURecipe prepare --index $GNUIndex --archive-dir $BootstrapDir --work-root $GNUWork
& $Python -s -B $GNURecipe build --index $GNUIndex --work-root $GNUWork --jobs 4 --memory-gib 8 --max-seconds 5400
```

These are explicit user commands, not commands executed during source export.
The runtime recipe's runtime-out/bin and sy-gnu-runtime-user-rebuild-v1 receipt
are not a product v2 runtime by themselves. Continue with XTB-GNU-REBUILD.md to
build/relink the scientific executable, preserve its parameters and integrate
the complete runtime and actual product source receipt. The public recipe is
not called verified merely because its files have been supplied.

## 4. Normalize, admit and explicitly activate the raw user build

The scientific recipe emits output/xtb-build-receipt.json with schema
sy-xtb-gnu-user-source-build-v1, bin/, share/xtb/, preferred-source-tree.json and
the actual GNU receipt. This is raw source-build output, not a product v2 tree.
Use the explicit bridge below; do not rename its schema or invent an R2 receipt.

```powershell
$XtbWork = Join-Path $SourceRoot 'build/xtb-gnu-a01'
$DefaultPins = Join-Path $SourceRoot 'third-party/build-inputs/gnu-xtb/default-scientific-pins.json'
$RawOutput = Join-Path $XtbWork 'output'
$PreferredSource = Join-Path $XtbWork 'source'
$GNURuntimeOutput = Join-Path $GNUWork 'runtime-out'
$AdmissionArgs = @('--source-root', $SourceRoot, '--raw-output', $RawOutput, '--preferred-source-root', $PreferredSource, '--gnu-runtime-output', $GNURuntimeOutput, '--default-pins', $DefaultPins, '--id', 'gnu-local-01', '--local-modified')
& $Python scripts/release/admit-built-xtb.py @AdmissionArgs
# Review the plan before explicitly writing and activating a new source-copy lock.
$Admitted = & $Python scripts/release/admit-built-xtb.py @AdmissionArgs --apply --activate | ConvertFrom-Json
$XtbRoot = Join-Path $SourceRoot (Join-Path $Admitted.root 'xtb')
```

This bridge checks the source-export snapshot's exact XTB/GNU indexes and
licenses, all selected scientific pins, actual preferred scientific sources
against their build-time tree, GNU input tree/digest and explicit build origin,
every bin/share member, six actual GNU DLLs, fixed LP64 BLAS/VC bytes and all
parameter files. Source/parameter changes are recorded explicitly. The guides
and indexes must exist and match their exported identities. No xTB, compiler,
installer or scientific program runs during admission.

Plan writes nothing. --apply creates a fresh .local/xtb-normalized/ID with indexed
licenses/proofs, a sy-xtb-normalized-user-build/v1 composite source receipt,
inventory.json, runtime.json and an external full member manifest. It then uses
the actual desktop/xtb-runtime-contract.cjs to create a fresh
.local/dependencies/win-x64/xtb-local-modified-ID lock/inventory, retaining the
previous declaration. --activate requires --apply and atomically switches only
this source-copy xTB lock. Native/toolchain locks and source inputs are unchanged.
Existing IDs or partial outputs are protected.

All user builds use explicit --local-modified and independent engine identities.
localUseReady means structural local admission only. officialBinaryIdentity,
numericallyValidated, productReady and public approval remain false. A receipt
does not establish numerical acceptance.

The earlier direct-v2 API remains with --runtime, --members and --source-receipt
for a completed v2 tree and its actual R2 source-build receipt. Its strict full
membership and source/pins checks remain. It is not needed for the public raw
recipe route. No fixed Intel DLL list/15-member count applies to GNU output.
Generated binaries stay in local output roots, not corresponding-source trees.

## 5. Fresh preparation and native engine build

Read the exact Python executable from desktop/packaging/native-toolchain.lock.json
and invoke it with -I -B, rather than a global Python/Conda executable:

```powershell
$Toolchain = Get-Content -LiteralPath './desktop/packaging/native-toolchain.lock.json' -Encoding UTF8 -Raw | ConvertFrom-Json
$NativePython = Join-Path $SourceRoot (Join-Path $Toolchain.root $Toolchain.python)
$Prepared = & $NativePython -I -B scripts/native/prepare.py prepare --run-id fresh-01 | ConvertFrom-Json
$LocalBuild = & $NativePython -I -B scripts/release/build-native-local.py --run-id fresh-01 --preparation $Prepared.preparation.path | ConvertFrom-Json
$NativeReceiptPath = $LocalBuild.receipt
$NativeReceipt = Get-Content -LiteralPath $NativeReceiptPath -Encoding UTF8 -Raw | ConvertFrom-Json
$NativeRoot = Join-Path $SourceRoot $NativeReceipt.output
```

Preparation verifies the complete current members, paths and links and runs
fresh current-root import/DLL/compiler probes. Native source identity includes
all six builder inputs, including runtime_pruning.py and the exact output recipe.
The local builder retains source/build-contract, pruning, unresolved-import and
output-member checks. It records the actual sourceContract, not a source-only
hash or old acceptance receipt. Logs remain in its fresh .cache build directory;
the bounded local compilation owns stopping its subprocess tree. A successful
local build is not a scientific or public-release acceptance.

For an ASE preferred-Python-source overlay, use the separately supplied
third-party/corresponding-sources/LOCAL-LIBRARY-REBUILD.md and the explicit
scripts/release/derive-local-lgpl-runtime.py plan/apply interface. Do not disable
parent lock or complete DLL inventory verification to accept an overlay.

For the explicit same-ABI native LGPL shared-library route, use
third-party/corresponding-sources/LOCAL-LIBRARY-REPLACEMENT.md and
scripts/release/replace-native-libraries.py. It creates a fresh complete native
copy from an actual parent build receipt, declared source/build evidence and
strict component delta. It does not require a complete native refreeze and does
not change the official 155-DLL recipe. Its distinct replacement receipt is
accepted by the assembler; actual downstream loading remains a separate test.
The replacement helper alone has the adjacent narrow MIT license.
The guide documents the exact baseline-bound libiconv/charset ancillary-export
profile. Such receipts explicitly limit compatibility to the current host and
do not claim full parent-export equivalence or actual loading.

## 6. Custom GNU FFmpeg and final portable assembly

Use [FFMPEG-GNU-REBUILD.md](third-party/corresponding-sources/FFMPEG-GNU-REBUILD.md).
It must actually exist and be covered by its exact path/bytes/SHA256 in
third-party/corresponding-source-index.json, together with its supplemental
source/build materials. Rebuild
its matching codec profile, then apply the documented replacement to a fresh
complete copy of the locked Electron tree; retain the original Electron tree
and the applicable licenses/notices. Merely keeping the stock FFmpeg DLL is not
the custom rebuild/replacement step. Missing indexed build inputs are a blocker,
not permission to select a different upstream binary.

Build the launcher with the locked compiler and checked-in icon, then explicitly
supply the complete native engine, admitted xTB runtime and custom Electron root:

```powershell
$ElectronCustom = Read-Host 'Complete locked Electron copy after FFMPEG-GNU-REBUILD replacement'
$OutputRoot = Read-Host 'Fresh separate output directory'
$Launcher = node scripts/release/build-launcher-local.mjs --run=fresh-launcher-01 | ConvertFrom-Json
$LauncherPath = Join-Path $SourceRoot $Launcher.data.artifact.path
$DistPath = Join-Path $SourceRoot 'dist'
node scripts/release/assemble-local.mjs "--dist=$DistPath" "--native=$NativeRoot" "--native-receipt=$NativeReceiptPath" "--native-receipt-root=$SourceRoot" "--xtb=$XtbRoot" "--launcher=$LauncherPath" "--out=$OutputRoot" "--electron=$ElectronCustom"
```

GNU v2 requires an actual native candidate or local-self-build receipt. The
assembler checks every native member and source/builder identity against the
exported source, reads the receipt's real buildContract/sourceContract, and
writes native origin plus the actual xTB runtimeManifest anchor into the original
manifested dependencies.json. It does not search for old receipts or substitute
source-only metadata. Legacy receipt-optional assembly remains its unverified
historical API, not the GNU v2 route.

Output must be fresh and outside every input/source root. Keep complete native
and xTB licenses/share/parameter files; root LICENSE.txt and third-party licenses
are retained. No developer profile, Multiwfn path, resource confirmation or old
scientific receipt is injected. The self-assembled directory remains explicitly
unvalidated and publicDistributionApproved=false. Actual source rebuild,
modified-library replacement, scientific tests, unfamiliar Windows/CPU checks
and any publication decision require their own evidence; no upload occurs here.
