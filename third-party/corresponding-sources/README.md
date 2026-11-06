# Corresponding source materials

The adjacent `../corresponding-source-index.json` records every provided member,
its original upstream location, exact size and SHA-256, and its build relation.
`archives/` preserves the indexed acquired source archives byte for byte.
`privacy-source-derivatives/` supplies explicitly modified GCC source archives:
each omits one non-build upstream process-memory test fixture containing
credential environment material. Original/derived identities and the exact
exclusion are recorded; all other logical members and content are preserved.
`recipes/` preserves the relevant original binary-package recipes, patches and
licenses. `build-support/` contains original Electron and Chromium FFmpeg build
materials needed to describe the selected source/configuration boundary.

The adjacent index records the current component-source and replacement scope;
the full product rebuild from exported source is a separate, deferred task.
Native shared-library sources and recursive JSON dependencies are under
`native-shared/`; `LOCAL-LIBRARY-REPLACEMENT.md` describes independent same-ABI
replacement and its exact host constraints. The material index grants no
public-release approval. Original third-party licenses apply to their respective
source, patches and tools; the project root license does not replace them.

Read archives and recipes before choosing a local build. Exporting these
materials does not execute archive code, install a toolchain, build a library,
or replace a runtime component.
