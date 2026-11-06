# Replace a locally modified shared library in an independent native copy

This route changes a complete native bundle without rebuilding the SY engine or
materializing the whole public toolchain. It is separate from the full
from-scratch build in BUILDING.md. Existing programs, source archives, locks and
receipts are retained. A source copy may be kept in Git.

The data/PE helper `scripts/release/replace-native-libraries.py` is provided under
the narrow MIT license in `replace-native-libraries-LICENSE.txt` alongside it
(Zixuan Zhang). That permission applies only to that helper. Modified LGPL
libraries retain their own licenses; the SY application and assembly tools keep
their applicable licenses. No Main signature or private approval token is needed
to use the local replacement interface.

## Supported components and ABI boundary

| Component | Existing target in complete native bundle | Scope |
| --- | --- | --- |
| tblite 0.7.0 | `_internal/libtblite-0.dll` | Existing CFFI consumer imports its C API; same ABI allows retaining the original pyd. |
| dftd4 4.2.0 | `_internal/libdftd4-4.dll` | Check the actual libtblite consumer's Fortran mangled symbols as well as C API. |
| s-dftd3 1.4.0 | `_internal/libs-dftd3-1.dll` | Check actual Fortran imports from libtblite. |
| libiconv 1.18 | `_internal/iconv.dll` | Its charset dependency remains declared and checked. |
| Explicit native libquadmath | `_internal/libquadmath-0.dll` | Use the native runtime's actual GCC source/version, not the independent xTB GNU toolchain. |

Two companion targets are allowed only as a declared pair:
`_internal/tblite/_libtblite.cp312-win_amd64.pyd` requires a libtblite replacement;
`_internal/charset.dll` requires an iconv replacement. They use component values
`tblite` and `libiconv` respectively. Other dependencies remain byte exact. A new
ABI or an additional dependency needs its own matching host/relink contract; an
arbitrary same-named DLL or system PATH fallback is not accepted by this route.

An explicit tblite/D4/D3 replacement set may also replace the existing support
targets `_internal/libmctc-lib-0.dll`, `_internal/libtoml-f-0.dll` and
`_internal/libmulticharge-0.dll`, using component values `mctc-lib`, `toml-f` and
`multicharge`. Each requires its own full source/build evidence and same ABI.
These are an exact support whitelist, not permission to replace arbitrary DLLs.
Preserve exported DATA versus code kind and every actually consumed ordinal.

### Bounded libiconv ancillary-export profile

The default preserves all old exports. One fixed profile,
`libiconv-1.18-current-host-ancillary-a02`, permits only these missing ancillary
compiler/CRT exports from the following exact parent DLLs:

| Parent target / SHA256 | Permitted absent entry (original ordinal / kind; null forwarder) |
| --- | --- |
| iconv.dll / `dde13ae784d3b916ccde2e676f7caa8dd96f23d7e20764fe1b0a8de6424dbd0d` (1098568 bytes) | `_Avx2WmemEnabledWeakValue` @1 DATA |
| charset.dll / `a3ae42aded452a43703db8f00638550efb3a1013cf8267c475cea4c668e3ab8d` (24904 bytes) | `__local_stdio_printf_options` @1 code; `_vsnprintf_l` @2 code; `_vsprintf_l` @3 code; `sprintf` @6 code |

The original Windows recipe enabled WINDOWS_EXPORT_ALL_SYMBOLS for both targets;
the complete libiconv/libcharset public headers do not declare these five as
their library API. These are ancillary exports of that build. In particular,
sprintf and the snprintf/printf-related routines are CRT APIs, not collectively
"private functions". No precise original CRT object is asserted where absent.

The profile preserves the real public library API's original names, ordinals,
DATA/code kind and forwarders, including `_libiconv_version` as DATA. It does not
permit arbitrary missing symbols, a producer-chosen required list or a regex/
skip switch. A different parent hash or entry shape receives no exception.
Every plan scans the actual host's normal and delay imports; any named or ordinal
consumer of an exempted missing entry rejects the replacement. Static scanning
does not exclude arbitrary dynamic lookup or external consumers.

Receipts list the exact ancillary exceptions and report compatibility only as
`current-host-public-api-and-consumers`; when any export is absent,
`fullParentExportEquivalence` is false. This is not full parent-ABI equivalence,
independent actual loading or general compatibility with other hosts. The
assembler checks that same fixed profile and recorded consumer bindings.

Use the supplied corresponding-source index for the actual native component's
source, patches and Windows recipe. Native and xTB tblite/GCC versions are
different source families. Native mctc-lib's static JSON implementation must be
accounted for using its own recipe's jonquil/toml-f source versions; the tblite
parent recipe's host versions do not prove those static source versions.
Preserve complete preferred source snapshots and all applicable license notices.
The distributed libxml2→iconv edge establishes a binary consumer, not proof that
an active SY workflow uses libxml2.

## Explicit replacement input

Choose an independent exported source root, the complete original native bundle,
its actual successful candidate/local-self-build receipt and that receipt's
origin root. The source's native identity must match the parent source/build
contract. The original receipt must exactly inventory every parent bundle file.
No receipt is rewritten to call a replacement a new engine build.

Prepare an overlay root containing the rebuilt library, its complete preferred
source snapshot, exact recipe/patch files and two evidence JSON files. All paths
below are relative to this overlay root. A file reference is exactly
`{"path": "...", "bytes": N, "sha256": "64 lowercase hexadecimal characters"}`;
measure it from the actual file, for example:

```powershell
function File-Ref([string]$Root, [string]$Relative) {
  $File = Join-Path $Root $Relative
  @{path=$Relative; bytes=(Get-Item -LiteralPath $File).Length;
    sha256=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}
```

The first `sourceEvidence` reference points to JSON with schema
`sy-local-library-source-evidence/v1`, the exact `component`, `upstreamVersion`,
`sourceRoot` (the source snapshot directory), complete `sourceFiles` references,
nonempty `recipeFiles` and optional `patchFiles`. Every file physically below
sourceRoot must appear in sourceFiles; snapshot VCS/build caches separately.

The first `buildEvidence` reference points to an actual completed build record
with schema `sy-local-library-build-evidence/v1`, `component`,
`sourceEvidenceSha256`, actual `commands` (arrays of argument strings),
`toolIdentities` (name, version, actual executable sha256), actual `exitCode: 0`
and `outputs` containing the exact rebuilt file reference. Keep build logs as
additional buildEvidence references. A source inventory alone is not a build
record, and static/plan success is not proof that compilation ran.

Create `replacement.json` with schema `sy-native-library-replacement-input/v1`
and nonempty `replacements`. Each row has:

- `target`: one supported target from the table above;
- `component`: `tblite`, `dftd4`, `s-dftd3`, `libiconv`, `libquadmath`,
  `mctc-lib`, `toml-f` or `multicharge`;
- `file`: exact rebuilt overlay file reference;
- `sourceEvidence`: nonempty reference list, with the source record first;
- `buildEvidence`: nonempty reference list, with the build record first.

The upstream project/feedstock name `simple-dftd3` maps to the replacement
component token `s-dftd3` and target `libs-dftd3-1.dll`. Use `s-dftd3` consistently
in replacement rows and their source/build evidence; retain the upstream name
in source/archive/recipe descriptions. The support component tokens require an
explicit tblite/D4/D3 main-library replacement in the same set as described above.

All source/build evidence is self-describing and file-bound, without requiring a
private signing authority. The producer remains responsible for truthful source
and build records. Paths, links/hardlinks, member changes and actual PE ABI are
independently checked by the replacement tool.

## Plan and create a fresh replacement

Use an explicit Python 3.12+ executable. This step never loads the libraries,
compiles, runs science, installs tools or changes a global environment:

```powershell
$Python = Read-Host 'Absolute Python 3.12+ executable'
$SourceRoot = Read-Host 'Independent source copy with source-native-identity.json'
$ParentNative = Read-Host 'Complete original native engine directory'
$ParentReceipt = Read-Host 'Actual successful parent native receipt JSON'
$ParentReceiptRoot = Read-Host 'Root resolving parent receipt and build/profile references'
$Overlay = Read-Host 'Prepared library/source/build-evidence overlay directory'
$Output = Read-Host 'Fresh output directory outside source/native/overlay roots'
$Args = @('--source-root', $SourceRoot, '--parent-native', $ParentNative,
  '--parent-receipt', $ParentReceipt, '--receipt-root', $ParentReceiptRoot,
  '--overlay', $Overlay, '--manifest', (Join-Path $Overlay 'replacement.json'),
  '--out', $Output, '--id', 'local-library-01')
& $Python -I -B scripts/release/replace-native-libraries.py @Args
# After reviewing the plan, explicitly create the complete new copy:
& $Python -I -B scripts/release/replace-native-libraries.py @Args --apply
```

Plan writes nothing. Apply creates `native/`, copied relative proof records and
`replacement-receipt.json` with schema `sy-local-native-library-replacement/v1`.
Only the declared target bytes differ; all other native files and licenses stay
exact. Source/evidence drift, unlisted deltas, output overlap, links, missing
exports and undeclared non-system imports fail. Named exports may retain their
ABI despite ordinal reordering; actual ordinal imports retain their original
binding. Existing outputs/partial failures are retained and cannot be resumed.

The original default native recipe and its 155-DLL identity checks are unchanged.
This is an explicit independent modified-library route, not a relaxed default
lock, fake self-build receipt or scientific approval. Any fixed ancillary-export
profile is disclosed above and in the receipt rather than called full ABI equality.

## Actual load and assembly

Before claiming a modified library usable, test its actual downstream consumer
in the new copy. Static PE compatibility alone is insufficient. A bounded source
modification can add an observable local marker while retaining the original
APIs, then verify both the marker and the original consumer's real load under a
sanitized environment. Record full physical module paths/hashes and process exit.
For tblite/D4/D3, verify the original pyd/libtblite host chain; use a separately
approved representative numerical request if numerical compatibility is claimed.
For iconv, a bounded string round-trip through its original API can test loading
without claiming a SY scientific workflow. Test libquadmath only if that component
is actually modified. No compile/load/scientific execution is triggered here.

Use the complete new native directory and its truthful replacement receipt with
the existing explicit assembler:

```powershell
# Supply the other unchanged inputs as documented by BUILDING.md.
node scripts/release/assemble-local.mjs "--dist=$DistPath" `
  "--native=$(Join-Path $Output 'native')" `
  "--native-receipt=$(Join-Path $Output 'replacement-receipt.json')" `
  "--native-receipt-root=$Output" "--xtb=$XtbRoot" `
  "--launcher=$LauncherPath" "--electron=$ElectronCustom" "--out=$PortableOutput"
```

The assembler verifies the copied actual parent build/profile contract and source
identities, complete new membership, declared delta and source/build evidence.
The replacement producer reads the actual PE bytes. The assembler checks their
file bindings and recorded ABI structure; it does not independently reparse PE
imports/exports or perform a DLL load.
Its dependency summary records the replacement component identity and original
build-contract hash. The replacement receipt keeps `buildExecuted`,
`actualLoadValidated`, `scientificAccepted`, `officialAcceptance` and
`publicDistributionApproved` false: the tool did not perform those actions.
Keep separately acquired actual load/numerical evidence alongside the receipt;
do not edit it into a false success. Repeated edits can be derived afresh from
the original parent with the complete intended replacement set. ABI changes
requiring a new host are outside this same-ABI entry and need matching rebuilds.
