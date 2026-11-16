# Exact public build inputs

The native-runtime and native-toolchain declarations preserve their exact
acquisition parent identities. Use the archive URLs, sizes, SHA256 and per-member
mappings, or an offline cache with those exact bytes. Do not substitute a local
pip/Conda environment. Python >=3.12 and Node >=24 are bootstrap tools. Nested
CAB data is read with Windows expand; installers are not executed.

## Default GNU xTB source route

The exported desktop/packaging/xtb-runtime.lock.json is deliberately a
source-build-required blueprint. It has no files/inventory and cannot satisfy
native preparation. It does not claim that a binary exists or is accepted.

1. Run scripts/release/materialize.py plan, fetch and materialize with
   --skip-xtb and an explicit --cache. Only the fixed native/toolchain inputs are
   selected. Existing or partial output roots are protected.
2. Follow third-party/corresponding-sources/GNU-RUNTIME-REBUILD.md and
   XTB-GNU-REBUILD.md. Their indexed archives, preferred source trees, controls
   and licenses are the actual public build materials. Build the GNU runtime
   and then scientific xTB with the exact LP64 math/VC inputs and parameters.
3. Run scripts/release/admit-built-xtb.py --raw-output with explicit
   --preferred-source-root, --gnu-runtime-output, --source-root, --default-pins,
   --id and --local-modified. Default is a read-only plan. --apply creates fresh
   normalized v2 and local lock/inventory roots; only additional --activate
   atomically switches this source copy's xTB lock.
4. Continue with preparation, six-builder native build, custom GNU FFmpeg and
   portable assembly as documented in root BUILDING.md.

Default scientific pins are gnu-xtb/default-scientific-pins.json. Admission checks
every selected source pin, actual preferred source tree, raw build receipt, full
bin/share membership, six GNU DLLs and their actual build receipt, fixed math
binaries and complete parameters. It copies indexed GNU/xTB licenses and creates
a new composite source receipt and v2 identity. Source/parameter changes are
explicit local changes. Admission is not numerical/product/public acceptance.
No executable is represented as corresponding source.

## Historical acquisition remains separate

acquisition.json, transformations.json and the old xTB inventory retain the
historical Intel-based xTB payload and its original PE stack-header operation.
They are historical reconstruction data, not the default xTB declaration.
Omitting both --skip-xtb and --legacy-xtb when that payload is present fails.
--legacy-xtb explicitly selects historical acquisition; it does not activate the
old binary or satisfy the GNU source-build-required declaration. There is no
silent fallback. Shared archives needed by native/toolchain remain selected
with their exact byte identities. Original local locks and receipts are retained.

Wheel RECORDs, explicit isolated-Python text, RDKit path adjustment, psutil 7.2.2
ownership correction, liblzma 5.8.2 and omission of unused path-bound wrappers
remain defined by the acquisition/transformations contracts. Open Babel remains
only a historical strict-preparation input; product output checks it absent.
These contracts establish byte/source identities, not redistribution approval.
Keep the supplied license/source indexes. Public approval remains false here.

## Ester Studio 2.0.8 internal xTB runtime set

The current local set has four routes. Official Windows xTB 6.8.0 serves
ordinary GFN calls. Non-FIRE GFN0 uses the same release and parameters with
the already measured 64 MiB PE stack reserve change. Nonperiodic g-xTB uses
its own release 2.0.1, with host xTB 6.7.1 (30c6303) and its own DLL directory.
Periodic optimization uses the bounded-cycle rebuild of xTB 6.8.0; periodic
MD stays on its ordinary GFN route. The independent complete-matrix tblite
API for periodic bond analysis is separate from these command-line runtimes.

- `declarations/xtb-v208-inputs.json` pins the upstream archives, exact
  FIRE source commits and archives, toolchain inputs and LP64 OpenBLAS.
  Git-archive entries are produced from the listed commit with
  `git archive --format=tar.gz --prefix=<component>/ <commit>`. Use the
  exact matching archives; the builder does not acquire inputs.
- `declarations/xtb-v208-assembly.json` pins the release DLLs and the
  linked rebuild DLLs and licenses. The official g-xTB tag's license is
  retained as `literals/xtb-v208-gxtb-LICENSE.txt`.
- `scripts/native/build-xtb-v208-fire.py` uses the existing WinLibs GCC
  13.2/Meson 1.4.1 toolchain and OpenBLAS 0.3.33 LP64. It changes the FIRE
  microcycle request to the smaller of the planned block and the remaining
  cycles, and replaces two local build identity strings. It does not change
  the optimizer, its thresholds, or the shipped parameter files.
  `declarations/xtb-v208-fire-build.json` is the actual build receipt.
- `scripts/native/assemble-xtb-v208.py` verifies those inputs and the
  official archives, validates the existing stack-only derivative and the
  complete DLL import closure, and stages a fresh local runtime. The root
  inventory for the selected bytes is `inventories/xtb-v208-win64.json`.
  The active development lock and portable dependency summary anchor
  the manifest and all four runtime identities. Assembly and lock checks
  do not execute a scientific program.

This section describes the internal 2.0.8 build. The preceding public
source-export blueprint and redistribution review are separate.
