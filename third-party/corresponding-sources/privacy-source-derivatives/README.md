# Exact GCC privacy source derivatives

Modification notice: prepared for SY-Studio by Zixuan Zhang on 2026-10-29.
The exact change is the single test-fixture omission described below; neither
archive is represented as an unmodified official GCC distribution.

The supplied GCC13.2.0 and GCC16.2.0 archives are explicitly modified source
distributions. Each omits exactly
`gcc-VERSION/libgo/go/debug/elf/testdata/hello-world-core.gz`, an upstream Go
ELF-core test snapshot containing captured environment credential material.
No credential value is included here and no credential validity was tested.

`DERIVATIVES.json` records the official original acquisition URL/identity,
supplied derived archive identity, excluded compressed/decoded member identity,
and the independent remaining-member comparison. All remaining member contents,
names, permissions, owner fields, timestamps and link targets are preserved.
Compiler/runtime algorithms, build targets, per-file notices and licenses are
unchanged. The omitted file is data for a Go debug/elf parser test, outside the
GNU13 C/Fortran helper and runtime targets selected by `GNU-RUNTIME-REBUILD.md`;
it is not input to those targets. It is not supplied as a functioning Go
testsuite fixture in this derivative.

The output is deterministically serialized PAX tar with gzip mtime zero.
Long names may gain equivalent PAX path headers (including a directory trailing
slash); original archive compression/header bytes are not promised identical.
The archive has a single top-level `gcc-VERSION/` directory just like its input.

`SOURCE-TREE-OVERLAY.json` binds the unchanged historical GNU13 materialized
source inventory and the exact one-row omission. That historical inventory
describes an earlier operation on original source and still lists the fixture;
it is not falsely rewritten as the current derivative. The GNU13 rebuild
control verifies and applies the small overlay before checking current build
inputs. Every remaining historical row retains its original identity.

To reproduce a derivative, independently obtain the exact original named in
`DERIVATIVES.json` and use Python3.11+ standard library with a new output path:

```powershell
& $Python -s -B ./sanitize-gcc-source.py --version 13.2.0 --input $OriginalArchive --output $NewDerivedArchive --receipt $NewProof
```

The control checks original identity, the exact excluded member, independently
reads all output members and compares the complete ordered logical member
identity. It does not download, install, build or run scientific software.
Outputs are never overwritten; retain an unsuccessful partial output as
failure evidence. The official credential-bearing original is an acquisition
input to this optional local transformation, not a payload in this public
source distribution. Never add it alongside the supplied derivative.

Only `sanitize-gcc-source.py` has the narrow additional MIT control grant in
`SANITIZER-LICENSE.txt`. Upstream GCC notices and source terms continue to apply.
These material identities do not assert public-distribution legal approval or
numerical validation of a new binary.
