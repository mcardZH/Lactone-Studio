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
