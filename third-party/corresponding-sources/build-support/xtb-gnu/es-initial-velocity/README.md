# Ester Studio xTB H-only initial-velocity modification

This is the 2026-11-05 Ester Studio modification of xTB source commit
5071a8869720fb0ecd788af977159869b64a277c, reported scientific version 6.7.0.
The xTB source and this modification remain under LGPL-3.0-or-later; preserve
the upstream copyright and license files. Ester Studio's application license
does not restrict rights granted in these sources.

The source archive is the unchanged paired-source member
../../../archives/xtb-gnu/xtb-5071a886-source.tar.gz. Apply
xtb-initial-velocity-a04.patch at its extracted root with strip level 1.
The patch was checked against the exact original and reproduces the actual
compiled src/dynamic.f90 bytes. See source-linkage.json for before/after hashes,
the source archive, helper/control files, executable and complete linkage.
The four scripts/native controls are supplied at their original repository
paths, including the same-directory Fortran helper and parameterized rebuild
driver. Use that driver from the exported source root with explicit work,
toolchain, runtime and resource arguments; see the root BUILDING.md.
The exact patch file uses CRLF transport line endings; strip the carriage
returns when applying it to the original LF source. The distributed patch
bytes and their recorded SHA256 are preserved.

The patch limits initial kinetic temperature only when the original native
ekinet result is strictly above 8000 K. It scales H velocities only, preserves
non-H velocities, and retains the upstream native degrees of freedom and
Boltzmann constant. This is a real scientific implementation change, not an
unchanged-program or runtime-library-only update.

The final build ID is 5071a886-gnu132-r2-es-hcap-openblas033-v1. Only the newly
compiled executable is selected from the raw build. Every runtime DLL and
parameter file is identical to the published 2.0.2 OpenBLAS 0.3.33 composition.
The raw-build inventory in the unchanged source receipt describes its original
build-time inputs; runtimeComposition and unchangedRuntimeAndParameters describe
the actual final runtime. Do not use the raw-build OpenBLAS 0.3.34 entry as the
distributed runtime identity.

provenance/es-initial-velocity-build.json is copied without changing bytes;
its SHA256 is the source receipt used by the final runtime. Supporting source
manifests and original GNU/runtime receipts are included in provenance/.
The gnu-runtime-source-receipt.json entry is an exact-byte alias of the original
r2-source-receipt.json for the nested raw-build reference. The original R0/R2
and OpenBLAS metadata remain historical parent evidence, not claims that those
old build operations were repeated for this release.

Private raw commands, logs, test cases and kernel observations are not included.
Their digest references in the unchanged source receipt remain traceability
records; they are not source-file download links. Source provision and a
successful build do not claim whole-product clean-environment rebuilding or
completion of a scientific validation matrix. These materials accompany the
source ZIP of https://github.com/Ahey1/Ester-Studio/releases/tag/v2.0.3.
