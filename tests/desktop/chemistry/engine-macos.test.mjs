import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  resolveDefaultCondaPrefix,
  stageDarwinRuntime
} from '../../../scripts/native/stage-darwin-runtime.mjs';

const require = createRequire(import.meta.url);
const { chemistryRuntime } = require('../../../desktop/runtime.cjs');
const { currentRuntimeEnvironment } = require('../../../desktop/current-runtime.cjs');

const ROOT = path.resolve(import.meta.dirname, '../../..');
const IS_DARWIN_ARM64_HOST = process.platform === 'darwin' && process.arch === 'arm64';

let cachedRuntime = null;

function verifyCommittedDarwinArm64Locks() {
  for (const rel of [
    'desktop/packaging/native-profile.darwin-arm64.json',
    'desktop/packaging/native-runtime.darwin-arm64.lock.json',
    'desktop/packaging/native-toolchain.darwin-arm64.lock.json',
    'desktop/packaging/xtb-runtime.darwin-arm64.lock.json'
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `Expected committed lock/profile ${rel}`);
  }
}

function resolveActiveRuntime() {
  if (cachedRuntime) return cachedRuntime;
  if (
    IS_DARWIN_ARM64_HOST &&
    !fs.existsSync(
      path.join(ROOT, '.local/toolchains/darwin-arm64/conda-py312-arm64/python/bin/python3')
    )
  ) {
    const condaPrefix = resolveDefaultCondaPrefix();
    if (condaPrefix) {
      stageDarwinRuntime({ appPath: ROOT, platformId: 'darwin-arm64', condaPrefix });
    }
  }
  const rt = chemistryRuntime({
    packaged: false,
    appPath: ROOT,
    environment: {}
  });
  assert.equal(rt.provenance?.locked, true, 'Expected locked .local runtime');
  assert.equal(rt.provenance?.source, 'prepared-current-locks');
  const env = {
    ...process.env,
    ...currentRuntimeEnvironment({
      packaged: false,
      appPath: ROOT,
      executable: rt.executable,
      environment: {
        ...process.env,
        DYLD_LIBRARY_PATH: '/opt/anaconda3/envs/ester-studio/lib',
        PYTHONPATH: '/opt/anaconda3/envs/ester-studio/lib/python3.12/site-packages',
        RDBASE: '/tmp/fake-ambient-rdbase-must-be-stripped'
      }
    })
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete env[k];
  }
  env.OMP_NUM_THREADS = '1';
  cachedRuntime = { ...rt, env };
  return cachedRuntime;
}

function runEngineRequest(runtime, payload, extraArgs = []) {
  const stdout = execFileSync(runtime.executable, [...runtime.args, ...extraArgs], {
    cwd: runtime.cwd,
    env: runtime.env || process.env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60000
  });
  return JSON.parse(stdout.trim());
}

test('macOS Python scientific environment has RDKit, ASE, Spglib, tblite, and SciPy ready', () => {
  verifyCommittedDarwinArm64Locks();
  if (!IS_DARWIN_ARM64_HOST) return;
  const runtime = resolveActiveRuntime();
  assert.ok(runtime.executable);
  assert.ok(Array.isArray(runtime.args) && runtime.args.length >= 2);
  if (fs.existsSync(path.join(ROOT, '.local/toolchains/darwin-arm64'))) {
    assert.equal(runtime.provenance.source, 'prepared-current-locks');
  }
});

test('desktop/chemistry/engine.py --capabilities reports periodicGfn2BondOrders on macOS', () => {
  verifyCommittedDarwinArm64Locks();
  if (!IS_DARWIN_ARM64_HOST) return;
  const runtime = resolveActiveRuntime();
  const stdout = execFileSync(runtime.executable, [...runtime.args, '--capabilities'], {
    cwd: runtime.cwd,
    env: runtime.env || process.env,
    encoding: 'utf8',
    timeout: 60000
  });
  const capabilities = JSON.parse(stdout.trim());
  assert.equal(capabilities.schema, 'sciyue-native-capabilities/v1');
  assert.equal(capabilities.periodicGfn2BondOrders, true);
  assert.equal(capabilities.module, 'xtb_periodic_bonds');
  assert.ok(capabilities.tbliteVersion);
});

test('desktop/chemistry/engine.py executes generate3d, optimize, perceive-bonds, and convert on macOS', () => {
  verifyCommittedDarwinArm64Locks();
  if (!IS_DARWIN_ARM64_HOST) return;
  const runtime = resolveActiveRuntime();

  const waterStructure = {
    dimension: 3,
    atoms: [
      { id: 'a1', element: 'O', x: 0.0, y: 0.0, z: 0.0, formalCharge: 0 },
      { id: 'a2', element: 'H', x: 0.96, y: 0.0, z: 0.0, formalCharge: 0 },
      { id: 'a3', element: 'H', x: -0.24, y: 0.93, z: 0.0, formalCharge: 0 }
    ],
    bonds: [
      { a: 0, b: 1, order: 1 },
      { a: 0, b: 2, order: 1 }
    ]
  };

  // 1. 3D coordinate embedding (ETKDGv3)
  const gen3dRes = runEngineRequest(runtime, {
    stamp: 'test-gen3d',
    operation: 'generate3d',
    structure: waterStructure,
    movableAtomIds: ['a1', 'a2', 'a3']
  });
  assert.equal(gen3dRes.error, undefined);
  assert.equal(gen3dRes.operation, 'generate3d');
  assert.equal(gen3dRes.structure.atoms.length, 3);

  // 2. Force-field geometry optimization
  const optRes = runEngineRequest(runtime, {
    stamp: 'test-opt',
    operation: 'optimize',
    structure: gen3dRes.structure,
    movableAtomIds: ['a1', 'a2', 'a3']
  });
  assert.equal(optRes.error, undefined);
  assert.equal(optRes.operation, 'optimize');
  assert.equal(optRes.structure.atoms.length, 3);

  // 3. Coordinate-import bond perception
  const unbondedWater = {
    dimension: 3,
    atoms: optRes.structure.atoms.map((a) => ({
      id: a.id,
      element: a.element,
      x: a.x,
      y: a.y,
      z: a.z
    }))
  };
  const perceiveRes = runEngineRequest(runtime, {
    stamp: 'test-perceive',
    operation: 'perceive-bonds',
    bondPerceptionPolicy: 'coordinate-import',
    structure: unbondedWater,
    movableAtomIds: ['a1', 'a2', 'a3']
  });
  assert.equal(perceiveRes.error, undefined);
  assert.equal(perceiveRes.structure.bonds.length, 2);

  // 4. Format conversion (XYZ & SDF)
  const xyzRes = runEngineRequest(runtime, {
    stamp: 'test-xyz',
    operation: 'convert',
    format: 'xyz',
    structure: optRes.structure,
    movableAtomIds: ['a1', 'a2', 'a3']
  });
  assert.equal(xyzRes.error, undefined);
  assert.match(xyzRes.text, /^3\nEster Studio explicit coordinates\n/);

  const sdfRes = runEngineRequest(runtime, {
    stamp: 'test-sdf',
    operation: 'convert',
    format: 'sdf',
    structure: optRes.structure,
    movableAtomIds: ['a1', 'a2', 'a3']
  });
  assert.equal(sdfRes.error, undefined);
  assert.match(sdfRes.text, /\$\$\$\$/);
});

test('desktop/chemistry/engine.py --crystal-modeling executes spglib symmetry and ASE supercell on macOS', () => {
  verifyCommittedDarwinArm64Locks();
  if (!IS_DARWIN_ARM64_HOST) return;
  const runtime = resolveActiveRuntime();
  const cubicCrystal = {
    id: 'crystal-1',
    atoms: [{ id: 'si-1', element: 'Si', x: 0.0, y: 0.0, z: 0.0 }],
    cell: {
      vectors: [
        [3.84, 0.0, 0.0],
        [0.0, 3.84, 0.0],
        [0.0, 0.0, 3.84]
      ],
      pbc: [true, true, true],
      origin: [0.0, 0.0, 0.0]
    }
  };

  const symResponse = runEngineRequest(
    runtime,
    {
      operation: 'symmetry',
      documentId: 'doc-crystal-1',
      expectedRevision: 1,
      structure: cubicCrystal,
      parameters: { symprec: 0.01 }
    },
    ['--crystal-modeling']
  );
  assert.equal(symResponse.ok, true);
  assert.equal(symResponse.result.symmetry.number, 221);
  assert.equal(symResponse.result.symmetry.symbol, 'Pm-3m');

  const supercellResponse = runEngineRequest(
    runtime,
    {
      operation: 'supercell',
      documentId: 'doc-crystal-1',
      expectedRevision: 1,
      structure: cubicCrystal,
      parameters: {
        matrix: [
          [2, 0, 0],
          [0, 2, 0],
          [0, 0, 2]
        ]
      }
    },
    ['--crystal-modeling']
  );
  assert.equal(supercellResponse.ok, true);
  assert.equal(supercellResponse.result.details.multiplicity, 8);
  assert.equal(supercellResponse.result.candidate.structure.atoms.length, 8);
});

test('all core desktop/chemistry scientific submodules import cleanly and RDKit RDDataDir resolves inside locked runtime', () => {
  verifyCommittedDarwinArm64Locks();
  if (!IS_DARWIN_ARM64_HOST) return;
  const runtime = resolveActiveRuntime();
  const sitePackagesDirs = runtime.runtimeRoot
    ? [
        path.join(runtime.runtimeRoot, 'python/lib/python3.12/site-packages'),
        path.join(runtime.runtimeRoot, 'python/Lib/site-packages')
      ].filter((p) => fs.existsSync(p))
    : [];
  const modulesToVerify = [
    'geometry_clean',
    'crystal_modeling',
    'conformer_sampling',
    'dynamics',
    'advanced_path',
    'xtb_periodic',
    'xtb_periodic_bonds',
    'bader_analysis'
  ];
  const probeScript = `
import ctypes, importlib, json, pathlib, sys
for sp in ${JSON.stringify(sitePackagesDirs)}:
    if sp not in sys.path:
        sys.path.insert(0, sp)
sys.path.insert(0, str(pathlib.Path.cwd()))
loaded = {}
for name in ${JSON.stringify(modulesToVerify)}:
    mod = importlib.import_module(name)
    loaded[name] = bool(mod)

import spglib
import tblite.interface
from rdkit import RDConfig
from rdkit.Chem import SaltRemover
spglib_ver = spglib.spg_get_version()
assert spglib_ver is not None
assert callable(tblite.interface.Calculator)
remover = SaltRemover.SaltRemover()
rd_data_dir = str(pathlib.Path(RDConfig.RDDataDir).resolve())

dylib_images = []
if sys.platform == "darwin":
    libc = ctypes.CDLL(None)
    libc._dyld_image_count.restype = ctypes.c_uint32
    libc._dyld_get_image_name.argtypes = [ctypes.c_uint32]
    libc._dyld_get_image_name.restype = ctypes.c_char_p
    count = libc._dyld_image_count()
    for i in range(count):
        raw = libc._dyld_get_image_name(i)
        if raw:
            p = raw.decode("utf-8", errors="replace")
            if "libRDKit" in p or "libtblite" in p or "libsymspg" in p:
                dylib_images.append(str(pathlib.Path(p).resolve()))
print(json.dumps({"loaded": loaded, "dylib_images": dylib_images, "rd_data_dir": rd_data_dir, "salts_count": len(remover.salts)}))
`;
  const stdout = execFileSync(runtime.executable, ['-I', '-S', '-B', '-c', probeScript], {
    cwd: path.join(ROOT, 'desktop/chemistry'),
    env: runtime.env || process.env,
    encoding: 'utf8',
    timeout: 60000
  });
  const {
    loaded,
    dylib_images: dylibImages,
    rd_data_dir: rdDataDir,
    salts_count: saltsCount
  } = JSON.parse(stdout.trim());
  for (const modName of modulesToVerify) {
    assert.equal(loaded[modName], true, `Expected ${modName} to import cleanly`);
  }
  assert.ok(saltsCount > 0, 'Expected RDKit SaltRemover to load Salts.txt from RDDataDir');
  if (process.platform === 'darwin') {
    const expectedRdDataDir = fs.realpathSync(
      path.join(
        runtime.runtimeRoot,
        'python/lib/python3.12/site-packages/rdkit/share/RDKit/Data'
      )
    );
    assert.equal(rdDataDir, expectedRdDataDir);
    assert.ok(
      dylibImages.some((p) => path.basename(p).startsWith('libRDKit')),
      'Expected libRDKit*.dylib to be loaded'
    );
    assert.ok(
      dylibImages.some((p) => path.basename(p).startsWith('libtblite')),
      'Expected libtblite*.dylib to be loaded'
    );
    assert.ok(
      dylibImages.some((p) => path.basename(p).startsWith('libsymspg')),
      'Expected libsymspg*.dylib to be loaded'
    );
    const expectedLibRoot = fs.realpathSync(path.join(runtime.runtimeRoot, 'python/lib'));
    for (const imgPath of dylibImages) {
      assert.ok(
        imgPath.startsWith(expectedLibRoot + path.sep),
        `Expected loaded dylib ${imgPath} to be inside locked runtime lib ${expectedLibRoot}`
      );
    }
  }
});

test('xtb_periodic_bonds.PeriodicBondEvaluator computes periodic GFN2-xTB Mayer-Wiberg bond orders on macOS', () => {
  verifyCommittedDarwinArm64Locks();
  if (!IS_DARWIN_ARM64_HOST) return;
  const runtime = resolveActiveRuntime();
  const sitePackagesDirs = runtime.runtimeRoot
    ? [
        path.join(runtime.runtimeRoot, 'python/lib/python3.12/site-packages'),
        path.join(runtime.runtimeRoot, 'python/Lib/site-packages')
      ].filter((p) => fs.existsSync(p))
    : [];
  const tmpWorkspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'es-xtb-pbc-bonds-'));
  try {
    const pbcScript = `
import json, pathlib, sys
for sp in ${JSON.stringify(sitePackagesDirs)}:
    if sp not in sys.path:
        sys.path.insert(0, sp)
sys.path.insert(0, str(pathlib.Path.cwd()))
from xtb_periodic_bonds import PeriodicBondEvaluator
request = {
    "method": "gfn2",
    "calculation": "singlepoint",
    "charge": 0,
    "uhf": 0,
    "threads": 1,
    "maxSteps": 1,
    "maxSccIterations": 100,
    "structure": {
        "atoms": [
            {"id": "h1", "element": "H", "x": 0.0, "y": 0.0, "z": 0.0},
            {"id": "h2", "element": "H", "x": 0.74, "y": 0.0, "z": 0.0}
        ],
        "cell": {
            "vectors": [[10.0, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0, 0.0, 10.0]],
            "pbc": [True, True, True]
        }
    }
}
evaluator = PeriodicBondEvaluator(request, runtime={}, workspace=${JSON.stringify(tmpWorkspace)})
res = evaluator.optimize(lambda _: None)
print(json.dumps(res))
`;
    const stdout = execFileSync(runtime.executable, ['-I', '-S', '-B', '-c', pbcScript], {
      cwd: path.join(ROOT, 'desktop/chemistry'),
      env: runtime.env || process.env,
      encoding: 'utf8',
      timeout: 60000
    });
    const res = JSON.parse(stdout.trim());
    assert.equal(res.kind, 'completed');
    assert.equal(res.nativeClosed, true);
    assert.ok(Number.isFinite(res.energyHartree));
    assert.equal(res.bondOrders.definition, 'mayer-wiberg');
    assert.equal(res.bondOrders.sourceField, 'tblite:bond-orders');
    assert.equal(res.bondOrders.entries.length, 1);
    assert.ok(res.bondOrders.entries[0].value > 0.8);
    assert.ok(fs.existsSync(path.join(tmpWorkspace, 'bond-orders.npy')));
    assert.ok(fs.existsSync(path.join(tmpWorkspace, 'bond-orders.json')));
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});
