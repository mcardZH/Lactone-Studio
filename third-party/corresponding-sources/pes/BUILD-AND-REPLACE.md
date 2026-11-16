Updated 2026-11-14: the declared official dependency versions are now bound to all seven exact upstream tags, the complete official Windows release recipe has been retained, and all 867 static archive objects map to supplied source files. See LIBXTB-SOURCE-AND-RELINK-EVIDENCE.json. The independent public recipe libxtb-relink/relink.py was executed successfully, and its changed-hash DLL was loaded by the real PES Python provider. Use libxtb-relink/PUBLIC-RELINK.md for the proposed public route. The copied historical Node helpers are internal comparison material excluded by PUBLIC-MATERIALS.json. Final desktop admission/integration remains a Main task.

# Source, build, and replacement material

This is prepared material, not a completed clean-build certificate. No supplied script has been executed in this fork.

## xTB 6.8 / FIRE

`SOURCE-MATERIALS.json` pins sixteen original source archives and their source-directory layout. The main xTB commit is 4b8c987066c7e9bd0c2b727ce026fb9a581c273a. `patches/xtb-fire.patch` contains the two changes made for the accepted FIRE build: the remaining-step bound in `src/relaxation_engine.f90` and removal of developer account/host strings from generated build metadata. The original and modified hashes were checked. Complete modified files are included under `modified/xtb-fire/`.

`fire-build-controls/project/` preserves the exact 9005-byte build script, its 8014-byte input declaration, and its Windows command helper. Their original relative paths are preserved. The builder accepts explicit `--sources`, `--work`, `--tools`, and `--math-bin` paths. Point `--sources` to `archives/`; provide the existing pinned toolchain described in the declaration (GCC/gfortran 13.2.0, Meson 1.4.1 and Ninja) and OpenBLAS 0.3.33 LP64. It checks source/tool hashes before unpacking. It creates source/build/output directories in a new user-selected work directory and uses the recorded offline Meson options. It does not install dependencies or run scientific calculations. Its historical per-build resource defaults are build controls, not ES task limits.

Upstream source layout and exact options are also recorded in `FIRE-BUILD-IDENTITY.json`. Preserve the approved compiler-runtime source set from the companion existing `third-party/corresponding-sources/` materials. Only the existing privacy-sanitized GCC derivative and its sanitizer instructions should be reused; do not restore the original archive containing private repository metadata.

## libxtb 6.8 resident library

`libxtb-relink/project/inputs/` holds all eight recorded re-link inputs, including libxtb.a, libcpx.a, xtb.h, GNU import libraries, the export definition and OpenBLAS import library. Each was checked against the accepted lock. The independent `relink.py` and its lock are included. Historical copied Node controls are excluded; the maintained product source exports its required control modules separately. The script requires an explicitly supplied Zig executable whose identity matches the lock (0.17.0); it uses separate input and output directories and does not replace the running library automatically.

Example after locating the compatible toolchain: `node project/scripts/relink-pes-libxtb.mjs --input-root project/inputs --output-root NEW_OUTPUT_DIRECTORY --zig PATH_TO_PINNED_ZIG --lock project/desktop/packaging/pes-libxtb-runtime.lock.json`.

The official static objects were extracted from the xTB 6.8 official Windows archive. LIBXTB-SOURCE-AND-RELINK-EVIDENCE.json binds all seven direct upstream tags and all 867 static objects to the provided sources. This source-material evidence and the saved provider loading result retain their stated scope. The desktop local modification route is scripts/release/derive-pes-library.mjs in the source attachment; BUILDING.md describes the derived locks and reassembly. Actual candidate loading and numerical validation are separately recorded.

## Sella and pyGSM

`archives/sella-2.6.0.tar.gz` is the exact source distribution associated with the runtime lock. The distributed Sella wheel is pure Python (`py3-none-any`); its JAX/JAXlib execution dependencies retain their own original notices. Keep Python 3.12 ABI and dependency requirements from the lock when creating a compatible replacement environment.

`archives/ZimmermanGroup-pyGSM-1b4d5a5557a6.tar.gz` is the pinned upstream source. The twelve compatibility edits in `patches/pygsm-compatibility.patch` were reconstructed from the declared substitutions and matched the baseline packaged files byte for byte. Modified files under `modified/pygsm/` are supplied as an additional reviewable form. Preserve Cody Aldaz's original MIT copyright and permission text, and describe the ES compatibility changes separately.

## g-xTB (external user-supplied program)

The user confirmed on 2026-11-14 that g-xTB is downloaded independently from the official upstream by the customer. The new ES public source/portable artifacts must not contain its executable, exclusive runtime closure or nested binary archive. ES will configure and invoke the selected external CLI. Earlier missing-source findings are historical evidence; acquisition is no longer a release prerequisite for an ES artifact that does not distribute that binary. The historical acquisition draft is internal, not a current task. See the complete Main implementation handoff.
