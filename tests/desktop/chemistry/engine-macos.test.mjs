import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  ensureDarwinRuntimeReady
} from '../../../scripts/native/stage-darwin-runtime.mjs';

const require = createRequire(import.meta.url);
const { chemistryRuntime } = require('../../../desktop/runtime.cjs');
const { currentRuntimeEnvironment } = require('../../../desktop/current-runtime.cjs');
const { xtbRuntime } = require('../../../desktop/xtb-runtime.cjs');

const ROOT = path.resolve(import.meta.dirname, '../../..');
const IS_DARWIN_ARM64_HOST = process.platform === 'darwin' && process.arch === 'arm64';

let cachedRuntime = null;

function verifyCommittedDarwinArm64Locks() {
  const profilePath = path.join(ROOT, 'desktop/packaging/native-profile.darwin-arm64.json');
  const rtLockPath = path.join(ROOT, 'desktop/packaging/native-runtime.darwin-arm64.lock.json');
  const tcLockPath = path.join(ROOT, 'desktop/packaging/native-toolchain.darwin-arm64.lock.json');
  const xtbLockPath = path.join(ROOT, 'desktop/packaging/xtb-runtime.darwin-arm64.lock.json');
  for (const p of [profilePath, rtLockPath, tcLockPath, xtbLockPath]) {
    assert.ok(fs.existsSync(p), `Expected committed lock/profile ${p}`);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const rtLock = JSON.parse(fs.readFileSync(rtLockPath, 'utf8'));
  const tcLock = JSON.parse(fs.readFileSync(tcLockPath, 'utf8'));
  const xtbLock = JSON.parse(fs.readFileSync(xtbLockPath, 'utf8'));
  assert.equal(profile.schema, 'sciyue-native-profile-v1');
  assert.equal(profile.platform, 'darwin-arm64');
  assert.equal(rtLock.schema, 'sciyue-native-runtime-lock-v1');
  assert.equal(tcLock.schema, 'sciyue-native-toolchain-lock-v1');
  assert.equal(xtbLock.schema, 'sciyue-xtb-lock-v1');
  assert.ok(Array.isArray(xtbLock.files) && xtbLock.files.length > 0);
}

function buildIsolatedLockedRuntimeEnv(executable, ambientEnv = process.env) {
  const cleanAmbientEnv = {
    ...ambientEnv,
    DYLD_LIBRARY_PATH: '/opt/anaconda3/envs/ester-studio/lib',
    PYTHONPATH: '/opt/anaconda3/envs/ester-studio/lib/python3.12/site-packages',
    RDBASE: '/tmp/fake-ambient-rdbase-must-be-stripped'
  };
  delete cleanAmbientEnv.SCIYUE_PYTHON;
  const env = {
    ...cleanAmbientEnv,
    ...currentRuntimeEnvironment({
      packaged: false,
      appPath: ROOT,
      executable,
      environment: cleanAmbientEnv
    })
  };
  delete env.SCIYUE_PYTHON;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete env[k];
  }
  env.OMP_NUM_THREADS = '1';
  return env;
}

function resolveActiveRuntime() {
  if (cachedRuntime) return cachedRuntime;
  if (IS_DARWIN_ARM64_HOST) {
    ensureDarwinRuntimeReady({ appPath: ROOT, platformId: 'darwin-arm64' });
  }
  const rt = chemistryRuntime({
    packaged: false,
    appPath: ROOT,
    environment: {}
  });
  assert.equal(rt.provenance?.locked, true, 'Expected locked .local runtime');
  assert.equal(rt.provenance?.source, 'prepared-current-locks');
  const env = buildIsolatedLockedRuntimeEnv(rt.executable, process.env);
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

test('darwin-arm64 committed packaging lock and profile contracts are present and structurally valid', () => {
  verifyCommittedDarwinArm64Locks();
  if (process.env.SCIYUE_REQUIRE_DARWIN_ARM64 === '1') {
    assert.equal(
      IS_DARWIN_ARM64_HOST,
      true,
      'SCIYUE_REQUIRE_DARWIN_ARM64=1 requires darwin-arm64 host to execute live engine tests'
    );
  }
});

test.describe(
  'darwin-arm64 live scientific engine execution',
  { skip: !IS_DARWIN_ARM64_HOST ? 'Requires darwin-arm64 host' : false },
  () => {
    let executedScenarios = 0;

    test.after(() => {
      if (IS_DARWIN_ARM64_HOST) {
        assert.equal(
          executedScenarios,
          7,
          'Expected all 7 live darwin-arm64 scientific engine scenarios to execute'
        );
      }
    });

    test('macOS Python scientific environment has RDKit, ASE, Spglib, tblite, and SciPy ready', () => {
      const runtime = resolveActiveRuntime();
      assert.ok(runtime.executable);
      assert.ok(Array.isArray(runtime.args) && runtime.args.length >= 2);
      if (fs.existsSync(path.join(ROOT, '.local/toolchains/darwin-arm64'))) {
        assert.equal(runtime.provenance.source, 'prepared-current-locks');
      }
      const pollutedEnv = buildIsolatedLockedRuntimeEnv(runtime.executable, {
        ...process.env,
        SCIYUE_PYTHON: '/opt/anaconda3/envs/ester-studio/bin/python3',
        DYLD_LIBRARY_PATH: '/opt/anaconda3/envs/ester-studio/lib'
      });
      assert.equal(pollutedEnv.SCIYUE_PYTHON, undefined);
      assert.equal(pollutedEnv.DYLD_LIBRARY_PATH, undefined);
      executedScenarios += 1;
    });

    test('desktop/chemistry/engine.py --capabilities reports periodicGfn2BondOrders on macOS', () => {
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
      executedScenarios += 1;
    });

    test('desktop/chemistry/engine.py executes generate3d, optimize, perceive-bonds, and convert on macOS', () => {
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
      executedScenarios += 1;
    });

    test('desktop/chemistry/engine.py --crystal-modeling executes spglib symmetry and ASE supercell on macOS', () => {
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
      executedScenarios += 1;
    });

    test('all core desktop/chemistry scientific submodules import cleanly and RDKit RDDataDir resolves inside locked runtime', () => {
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
        'conformer_solvation',
        'conformer_native_md',
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
      executedScenarios += 1;
    });

    test('xtb_periodic_bonds.PeriodicBondEvaluator computes periodic GFN2-xTB Mayer-Wiberg bond orders on macOS', () => {
      const runtime = resolveActiveRuntime();
      const sitePackagesDirs = runtime.runtimeRoot
        ? [
            path.join(runtime.runtimeRoot, 'python/lib/python3.12/site-packages'),
            path.join(runtime.runtimeRoot, 'python/Lib/site-packages')
          ].filter((p) => fs.existsSync(p))
        : [];
      const tmpWorkspace = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), 'es-xtb-pbc-bonds-')
      );
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
        executedScenarios += 1;
      } finally {
        fs.rmSync(tmpWorkspace, { recursive: true, force: true });
      }
    });

    test('conformer_native_md.NativeMDSession admits darwin xtbRuntime and executes GFN2 MD with ALPB water solvation on macOS', async () => {
      const runtime = resolveActiveRuntime();
      const xtb = await xtbRuntime({ packaged: false, appPath: ROOT });
      const sitePackagesDirs = runtime.runtimeRoot
        ? [
            path.join(runtime.runtimeRoot, 'python/lib/python3.12/site-packages'),
            path.join(runtime.runtimeRoot, 'python/Lib/site-packages')
          ].filter((p) => fs.existsSync(p))
        : [];
      const tmpWorkspace = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), 'es-native-md-alpb-')
      );
      try {
        const mdScript = `
import copy, hashlib, importlib.util, json, pathlib, shutil, sys, tempfile, threading
for sp in ${JSON.stringify(sitePackagesDirs)}:
    if sp not in sys.path:
        sys.path.insert(0, sp)
sys.path.insert(0, str(pathlib.Path.cwd()))
import conformer_native_md
from conformer_native_md import NativeMDError, NativeMDSession, admitted_md_engine_identity
import conformer_solvation
from conformer_solvation import native_alpb_supported
assert native_alpb_supported("gfn2", "md", "water") is True
rt = json.loads(${JSON.stringify(JSON.stringify(xtb))})
admitted = admitted_md_engine_identity(rt)
assert admitted["version"] == rt["version"]

# Verify Darwin codesign-modified runtimeMemberDigest admission with recomputed canonical sha256
signed_rt = copy.deepcopy(rt)
signed_rt["engineIdentity"]["runtimeMemberDigest"] = "a" * 64
payload = {k: v for k, v in signed_rt["engineIdentity"].items() if k not in ("schema", "engine", "kind", "sha256")}
signed_rt["engineIdentity"]["sha256"] = hashlib.sha256(
    json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
).hexdigest()
admitted_signed = admitted_md_engine_identity(signed_rt)
assert admitted_signed["runtimeMemberDigest"] == "a" * 64

def expect_rejected(bad_rt):
    try:
        admitted_md_engine_identity(bad_rt)
    except NativeMDError:
        return
    raise AssertionError("Expected NativeMDError for invalid engineIdentity")

# Reject stale sha256 when runtimeMemberDigest changes
stale_sha_rt = copy.deepcopy(rt)
stale_sha_rt["engineIdentity"]["runtimeMemberDigest"] = "b" * 64
expect_rejected(stale_sha_rt)

# Reject forged sha256
forged_sha_rt = copy.deepcopy(signed_rt)
forged_sha_rt["engineIdentity"]["sha256"] = "c" * 64
expect_rejected(forged_sha_rt)

# Reject unanchored buildId even with valid canonical sha256
unanchored_build_rt = copy.deepcopy(rt)
unanchored_build_rt["engineIdentity"]["buildId"] = "forged-build-id"
payload_b = {k: v for k, v in unanchored_build_rt["engineIdentity"].items() if k not in ("schema", "engine", "kind", "sha256")}
unanchored_build_rt["engineIdentity"]["sha256"] = hashlib.sha256(
    json.dumps(payload_b, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
).hexdigest()
expect_rejected(unanchored_build_rt)

# Reject extra keys in engineIdentity
extra_key_rt = copy.deepcopy(signed_rt)
extra_key_rt["engineIdentity"]["extraKey"] = "unexpected"
expect_rejected(extra_key_rt)

# Reject codesign-modified runtimeMemberDigest on non-darwin platforms, while admitting platform-anchored linux/win32 v1 bundles
orig_platform = conformer_native_md.sys.platform
try:
    conformer_native_md.sys.platform = "win32"
    expect_rejected(signed_rt)

    win_conda_rt = copy.deepcopy(rt)
    win_conda_rt["version"] = "6.7.1"
    win_conda_rt["engineIdentity"]["version"] = "6.7.1"
    win_conda_rt["engineIdentity"]["buildId"] = "legacy-manifest-4eb25c769e6b157e4c61f2244f370f3033e68f98d3c575e93955f9ca4aab9434"
    win_conda_rt["engineIdentity"]["runtimeMemberDigest"] = "d" * 64
    win_payload = {k: v for k, v in win_conda_rt["engineIdentity"].items() if k not in ("schema", "engine", "kind", "sha256")}
    win_conda_rt["engineIdentity"]["sha256"] = hashlib.sha256(
        json.dumps(win_payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    ).hexdigest()
    assert admitted_md_engine_identity(win_conda_rt)["version"] == "6.7.1"

    conformer_native_md.sys.platform = "linux"
    expect_rejected(win_conda_rt)
    linux_conda_rt = copy.deepcopy(win_conda_rt)
    linux_conda_rt["engineIdentity"]["buildId"] = "legacy-manifest-4a22fa7162c1b47691623d1fe658b44adcce0334343bac59f28eb296f78a6fd7"
    lin_payload = {k: v for k, v in linux_conda_rt["engineIdentity"].items() if k not in ("schema", "engine", "kind", "sha256")}
    linux_conda_rt["engineIdentity"]["sha256"] = hashlib.sha256(
        json.dumps(lin_payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    ).hexdigest()
    assert admitted_md_engine_identity(linux_conda_rt)["version"] == "6.7.1"
finally:
    conformer_native_md.sys.platform = orig_platform

# Verify conformer_solvation._resolve_capability_path() in packaged .app directory layouts
src_solv_py = pathlib.Path.cwd() / "conformer_solvation.py"
src_solv_json = pathlib.Path(${JSON.stringify(path.join(ROOT, 'src/data/conformer-solvation.json'))})
with tempfile.TemporaryDirectory() as pkg_tmp:
    resources_dir = pathlib.Path(pkg_tmp) / "Ester Studio.app/Contents/Resources"
    chem_dir = resources_dir / "chemistry"
    app_data_dir = resources_dir / "app/src/data"
    chem_dir.mkdir(parents=True, exist_ok=True)
    app_data_dir.mkdir(parents=True, exist_ok=True)
    pkg_py = chem_dir / "conformer_solvation.py"
    shutil.copy2(src_solv_py, pkg_py)

    # Layout 1: Contents/Resources/app/src/data/conformer-solvation.json
    app_json = app_data_dir / "conformer-solvation.json"
    shutil.copy2(src_solv_json, app_json)
    spec1 = importlib.util.spec_from_file_location("pkg_conformer_solvation_1", pkg_py)
    mod1 = importlib.util.module_from_spec(spec1)
    spec1.loader.exec_module(mod1)
    assert mod1._resolve_capability_path() == app_json.resolve()

    # Layout 2: Contents/Resources/chemistry/conformer-solvation.json takes precedence over app/src/data
    chem_json = chem_dir / "conformer-solvation.json"
    shutil.copy2(src_solv_json, chem_json)
    spec2 = importlib.util.spec_from_file_location("pkg_conformer_solvation_2", pkg_py)
    mod2 = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(mod2)
    assert mod2._resolve_capability_path() == chem_json.resolve()

request = {
    "operation": "md",
    "method": "gfn2",
    "charge": 0,
    "uhf": 0,
    "threads": 1,
    "dtFs": 1.0,
    "reportEvery": 2,
    "maxSteps": 10,
    "maxEvaluations": 20,
    "maxFrames": 10,
    "shakeHydrogenBonds": True,
    "seed": 42,
    "calculator": {"accuracy": 2.0, "maxIterations": 250, "electronicTemperatureK": 300.0},
    "molecularMD": {"temperatureK": 298.15, "durationFs": 4.0, "sampleEveryFs": 2.0},
    "solvation": {"model": "alpb", "solvent": "water"},
    "structure": {
        "atoms": [
            {"id": "a1", "element": "O", "x": 0.0, "y": 0.0, "z": 0.0},
            {"id": "a2", "element": "H", "x": 0.96, "y": 0.0, "z": 0.0},
            {"id": "a3", "element": "H", "x": -0.24, "y": 0.93, "z": 0.0}
        ],
        "bonds": [{"id": "b1", "a": 0, "b": 1, "order": 1}, {"id": "b2", "a": 0, "b": 2, "order": 1}]
    }
}
events = []
ctx = {
    "runtime": rt,
    "workspacePath": ${JSON.stringify(tmpWorkspace)},
    "emit": events.append,
    "check": lambda: None,
    "cancelled": threading.Event()
}
res = NativeMDSession(request, ctx).run()
print(json.dumps({"kind": res["kind"], "frameCount": res["frameCount"], "nativeSolvation": res.get("nativeSolvation")}))
`;
        const stdout = execFileSync(runtime.executable, ['-I', '-S', '-B', '-c', mdScript], {
          cwd: path.join(ROOT, 'desktop/chemistry'),
          env: runtime.env || process.env,
          encoding: 'utf8',
          timeout: 60000
        });
        const res = JSON.parse(stdout.trim());
        assert.equal(res.kind, 'completed');
        assert.equal(res.frameCount, 2);
        assert.equal(res.nativeSolvation?.model, 'alpb');
        assert.equal(res.nativeSolvation?.solvent, 'water');
        assert.equal(res.nativeSolvation?.dielectricConstant, 80.2);
        executedScenarios += 1;
      } finally {
        fs.rmSync(tmpWorkspace, { recursive: true, force: true });
      }
    });
  }
);
