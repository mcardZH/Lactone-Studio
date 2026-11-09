# Ester Studio modification of xTB

The xTB scientific version remains 6.7.0. This release includes the ES-authored,
2026-11-05 H-only initial-velocity modification under LGPL-3.0-or-later.
All original xTB and dependency licenses remain in place; the application
license does not restrict the rights granted by those licenses.

The exact patch, unchanged original source archive and source/build linkage are
in the companion 2.0.3 source ZIP under
`third-party/corresponding-sources/build-support/xtb-gnu/es-initial-velocity/`.
The source ZIP also provides the four `scripts/native/` source/patch/build
controls. See the source ZIP's BUILDING.md for the actual build route.

Build ID: `5071a886-gnu132-r2-es-hcap-openblas033-v1`.
Source receipt SHA256: `cc4a318390ec628f0fc3daebced29e2a7247a7eba3d9b9b649c9a91a44fe713a`.
The final runtime uses the new executable and unchanged published 2.0.2 DLLs
and parameter files, including OpenBLAS 0.3.33. Original raw-build metadata is
retained separately and does not identify the final distributed math DLL.

The source and portable ZIPs are provided at
https://github.com/Ahey1/Ester-Studio/releases/tag/v2.0.3

This notice states source and license availability. It does not claim a
whole-product clean rebuild or scientific validation beyond the release record.
