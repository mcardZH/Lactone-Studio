// Keep the versioned narrow rendering seam reproducible without an install hook.
await import('./prepare-preload.mjs');
const { applyLocked3DmolPatch } = await import('./3dmol-bond-primitives.cjs');
await applyLocked3DmolPatch();
const { prepareDesktopPublicAssets } = await import('./prepare-chemistry.mjs');
await prepareDesktopPublicAssets();
await import('./prepare-workbench-preferences.mjs');
await import('./prepare-structure-provenance.mjs');
await import('./prepare-conformer-batch-runtime.mjs');
await import('./prepare-task-system.mjs');
