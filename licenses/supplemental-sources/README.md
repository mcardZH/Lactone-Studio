# Exact supplemental corresponding sources for Ester Studio 2.0.3

The [same 2.0.3 release](https://github.com/Ahey1/Ester-Studio/releases/tag/v2.0.3)
provides the complete source ZIP alongside the portable ZIP. In that source
ZIP, this directory contains `INDEX.json` and `archives/`. The index records
exact archive identities and original upstream acquisition URLs. The portable
ZIP retains this notice and index; obtain the archives from the companion
source ZIP. No written source offer is used in place of this direct provision.

## Cairo and InChI in Indigo

The actual render WASM is Indigo 1.46.0 at commit
`b36d38f5293470721fe02ee570d9f0e6488a5b8d`. The supplied full Indigo archive
contains its complete source tree and build scripts. `third_party/cairo/`
is the actual vendored Cairo 1.17.4 tree; `third_party/inchi/` is the actual
vendored InChI 1.06 tree, including `INCHI_BASE`, `INCHI_API`, its original
licence and CMake build controls. Source prefixes inside the archive are
recorded in `INDEX.json`. This is the vendor tree used by Indigo, not a
substitute archive of a similarly numbered standalone upstream version.

Cairo is distributed under the MPL 1.1 option expressly provided by its
original dual-licence notice. The complete covered source is available under
that licence in this release's source ZIP. Its original LGPL/MPL headers and
both licence texts remain unchanged; the recipient's original licence options
are preserved. Ester Studio made no changes to this vendored Cairo tree.
Upstream adaptations and build configuration are retained as supplied by
Indigo. Original Code and contributor ownership remain identified by the
original source headers, including the University of Southern California and
other named copyright holders. The application licence does not restrict
rights in this covered source. Any application-specific terms are offered
only by Ester Studio's author, not by the Cairo Initial Developer or its
contributors. See the complete MPL 1.1 text at
`../2d-components/upstream/cairo-license-options/MPL-1.1.txt`.

This product includes the International Chemical Identifier (InChI) library,
software version 1.06, copyright IUPAC and InChI Trust, under the supplied
IUPAC/InChI-Trust InChI Licence No. 1.0. Its complete corresponding source,
including the actual vendor build scripts, is offered for equivalent access
at the same release as the executable (sections 4 and 6(a)/(d)). The original
licence is at `../2d-components/upstream/indigo-1.46.0/third_party/inchi/LICENCE`.
Ester Studio made no changes to this vendored InChI tree. No later InChI
licence is substituted for the supplied 1.06 licence.

The supplied Emscripten 5.0.7 and emsdk 5.0.7 sources correspond to the
toolchain version specified by that Indigo commit's successful upstream
WASM build workflow. Emscripten's own original licence and the included
compiler-rt, libc++, libc++abi, libunwind, musl and other notices are retained
under `notices/`. This identifies the actual source commit and declared
toolchain; it does not assert independent bit-for-bit compiler reproduction.
Ketcher and Indigo were developed by EPAM Systems and contributors. Indigo's
rendering dependency is based in part on the work of the FreeType Team.

## Eclipse Temurin / OpenJDK

The bundled Windows x64 JRE is Eclipse Temurin 17.0.20.1+1. The companion
source ZIP supplies the official
`OpenJDK17U-jdk-sources_17.0.20.1_1.tar.gz` from that exact Temurin release,
whose vendor checksum is recorded in `INDEX.json`, and the exact
`temurin-build` source at commit
`e6ba7dec3d07654074559310376a3ae89da5f4ac`. The JRE vendor metadata and its
own `release` file identify OpenJDK commit
`79597447bd94ff9f8216e2e3a573d5261ee49f2e` and that same build commit.
The vendor's complete GPLv2, Classpath exception, assembly exception and
embedded third-party legal subtree remain under `../ocr/molvec/` and in the
actual JRE. These are not replaced by the application licence. Source is
directly supplied with equivalent access at the same release; no new
three-year written offer is made. This provision is distinct from rebuilding
or numerically validating Ester Studio's native chemistry engine.
