# Ester Studio (ES) source snapshot

Ester Studio (ES), formerly SY-Studio/SciYue, uses `.es` project indexes for
opening and saving projects. This snapshot contains the product and build
source. Its `source-export-manifest.json`
binds the actual source commit and exact exported files, including explicitly
documented build-only transformations. It contains no development history,
private scientific test corpus, developer state or internal acceptance receipts.

Read [BUILDING.md](BUILDING.md) for the complete local build route. Project terms
are in the root `LICENSE.txt`; exact third-party notices, source and build
materials are indexed in `licenses/`. The acquisition contract is build material,
not permission to redistribute a third-party component. A successful local build
does not establish scientific validation, a tested Windows support matrix or
approval for publication. Gaussian, ORCA, Multiwfn and g-xTB are external
user-selected programs. Download g-xTB from its official
[release page](https://github.com/grimme-lab/g-xtb/releases), retain the DLLs
from the same archive, and select its `bin/xtb.exe` in Settings. Only actions
that require an unconfigured external program are unavailable. Existing results
remain readable without that program. The source and portable attachments do
not distribute the g-xTB executable or its exclusive runtime.

Current PES source/build/re-link materials are indexed by
`third-party/pes-corresponding-source-index.json`. The root application license
does not replace third-party library rights or the modification/debugging
exceptions described in `licenses/THIRD_PARTY_RUNTIME_TERMS.md`.
