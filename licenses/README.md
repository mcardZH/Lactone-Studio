# Ester Studio 2.0.2 third-party materials

Ester Studio's own content is covered by the root `LICENSE.txt`. Third-party
components retain their original licences, notices, exceptions and rights. The
application licence does not relicense those components or restrict rights
granted by their original licences.

The release's `SOURCE_INDEX.json` lists the exact files in this `licenses/`
directory. `COMPONENT_SOURCES.json` identifies bundled versions and their
source entries. `SAME_BODY_INDEX.json` records unchanged original notice copies.
These generated indexes do not replace any original legal text.

| Component | Bundled identity | Materials and corresponding source |
|---|---|---|
| Frontend, Electron and Chromium | Electron 44.7.0; Chromium 152.0.7977.130; other versions in the lock/index | `frontend/`, `electron/`, `chromium/` and `SOURCE_INDEX.json`; Electron's MIT licence does not replace Chromium's component notices |
| Native chemistry engine | Runtime originally built for 1.0.3-dev.10; 41 chemistry source files and six builder files | Original runtime notices under `runtime/resources/chemistry/licenses/`; paired source `source-native-identity.json` and `third-party/corresponding-source-index.json` |
| GNU xTB | 6.7.0 | `runtime/resources/xtb/licenses/`; paired source `third-party/corresponding-sources/XTB-GNU-SOURCE-INDEX.json` |
| FFmpeg and native shared libraries | Exact versions in the component/source indexes | Paired source `third-party/corresponding-source-index.json`, including its FFmpeg/GNU/library guides and original licences |
| OpenBLAS | 0.3.33 | `openblas-0.3.33/`; earlier notices are retained separately |
| Ketcher / Indigo | 3.18.0 / 1.46.0 | [2D notices](2d-components/README.md), original notices under `2d-components/`, and [supplemental corresponding sources](supplemental-sources/README.md) |
| Static image decoding | UTIF 3.1.0 / pako 1.0.11 | [Image notices](image-decode/README.md), including original Zlib source notices |
| SSH | ssh2 1.17.0 and its locked dependencies | [SSH notices](task-system/README.md) and `task-system/npm/` |
| MolVec / Eclipse Temurin | 0.9.8 / 17.0.20.1+1 Windows x64 JRE | Runtime under `runtime/ocr-components/molvec/`; [OCR notices](ocr/molvec/README.md), complete vendor `legal/` tree, and the paired exact-source archives described below |

The complete source ZIP and portable ZIP are offered together at the
[Ester Studio 2.0.2 release](https://github.com/Ahey1/Ester-Studio/releases/tag/v2.0.2).
In the source ZIP, `licenses/supplemental-sources/` contains the exact Indigo
vendor source (including Cairo and InChI), Emscripten/emsdk sources and original
notices, the official Temurin/OpenJDK source archive, and the corresponding
Temurin build scripts. Its index gives archive names, checksums and origins.
These source archives are in the companion source ZIP; paths beginning
`third-party/` also refer to that source ZIP, not a hidden portable directory.

Cairo 1.17.4 as vendored by Indigo is distributed using its MPL 1.1 option;
the original dual-licence headers and both original licence texts are preserved.
The source remains available under its original terms. InChI 1.06 retains the
IUPAC/InChI-Trust InChI Licence No. 1.0. Its complete corresponding vendor source
and build scripts are supplied in the same release source ZIP. See the
[source availability notice](supplemental-sources/README.md) for the exact scope.

Multiwfn, Gaussian and ORCA are obtained separately by the user and are not
distributed in these archives. Scientific method citations, data licences and
third-party software licences each retain their own scope. Original copyrights,
notices and required exceptions remain in their original locations as well as
in the applicable material collection.

The source and binary identities and supplied build controls do not claim a
fresh build of the complete native product on a new Windows installation.

The native engine retains its original 1.0.3-dev.10 build identity. Separate
source-side build controls for six Fortran shared libraries are provided at
`scripts/release/fortran-relative-source/README.md` in the companion source ZIP.
Actual library build identities belong to the final runtime provenance; this
source navigation does not claim an engine rebuild or numerical validation.
