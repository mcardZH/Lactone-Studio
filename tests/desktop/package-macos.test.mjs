import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  assembleMacAppBundle,
  buildChemistryEngineLauncherScript,
  removeTreeForce,
} from '../../scripts/release/package-macos.mjs';

const require = createRequire(import.meta.url);
const { chemistryRuntime } = require('../../desktop/runtime.cjs');
const { xtbRuntime } = require('../../desktop/xtb-runtime.cjs');
const { DARWIN_V1_LIBRARIES } = require('../../desktop/xtb-runtime-contract.cjs');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ester-pkg-mac-test-'));
  try {
    return await fn(dir);
  } finally {
    removeTreeForce(dir);
  }
}

function writeText(root, relPath, content, mode) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  if (mode !== undefined) {
    fs.chmodSync(fullPath, mode);
  }
  return fullPath;
}

test('assembleMacAppBundle builds a valid macOS .app bundle compatible with chemistryRuntime and xtbRuntime in packaged mode', async () => {
  await withTempDir(async (root) => {
    const repoRoot = path.join(root, 'repo');
    const electronAppPath = path.join(repoRoot, 'node_modules/electron/dist/Electron.app');
    const pythonToolchainRoot = path.join(
      repoRoot,
      '.local/toolchains/darwin-arm64/conda-py312-arm64/python',
    );
    const pythonDepsRoot = path.join(
      repoRoot,
      '.local/dependencies/darwin-arm64/conda-chem-arm64/python',
    );
    const xtbSourceRoot = path.join(
      repoRoot,
      '.local/dependencies/darwin-arm64/conda-chem-arm64/xtb',
    );

    // 1. Minimal Electron.app template
    writeText(
      electronAppPath,
      'Contents/Info.plist',
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Electron</string>
  <key>CFBundleDisplayName</key>
  <string>Electron</string>
  <key>CFBundleIdentifier</key>
  <string>com.github.Electron</string>
  <key>CFBundleShortVersionString</key>
  <string>44.7.0</string>
  <key>CFBundleVersion</key>
  <string>44.7.0</string>
</dict>
</plist>`,
    );
    writeText(electronAppPath, 'Contents/MacOS/Electron', '#!/bin/sh\n', 0o755);

    // 2. Repo inputs (dist, desktop, package.json, LICENSE.txt, ssh2 dependency)
    writeText(
      repoRoot,
      'package.json',
      JSON.stringify({ name: 'sciyue-input-studio', version: '2.0.2' }),
    );
    writeText(repoRoot, 'LICENSE.txt', 'Ester Studio License\n');
    writeText(repoRoot, 'dist/index.html', '<!doctype html><html></html>\n');
    writeText(repoRoot, 'desktop/main.cjs', '// main\n');
    writeText(repoRoot, 'desktop/chemistry/engine.py', 'print("ok")\n');
    writeText(
      repoRoot,
      'node_modules/ssh2/package.json',
      JSON.stringify({ name: 'ssh2', version: '1.17.0', dependencies: { asn1: '0.2.6' } }),
    );
    writeText(repoRoot, 'node_modules/ssh2/index.js', 'module.exports = {};\n');
    writeText(
      repoRoot,
      'node_modules/asn1/package.json',
      JSON.stringify({ name: 'asn1', version: '0.2.6' }),
    );
    writeText(repoRoot, 'node_modules/asn1/index.js', 'module.exports = {};\n');

    // 3. Python toolchain & read-only dependencies (simulating 0o444/0o555 staged files)
    writeText(pythonToolchainRoot, 'bin/python3', '#!/bin/sh\n', 0o755);
    writeText(
      pythonDepsRoot,
      'lib/python3.12/site-packages/dummy.py',
      '# read-only dep\n',
      0o444,
    );

    // 4. xTB v1 runtime files for darwin-arm64
    writeText(
      xtbSourceRoot,
      'runtime.json',
      JSON.stringify({
        schema: 'sciyue-xtb-bundled-runtime/v1',
        version: '6.7.1',
        platform: 'darwin-arm64',
        scope: 'local-experimental',
        localUseReady: true,
        publicRedistributionReviewed: false,
        distributionLicenseReady: false,
        entry: 'bin/xtb',
        dataDirectory: 'share/xtb',
        methods: ['gfn0', 'gfn1', 'gfn2', 'gfnff'],
      }),
    );
    writeText(xtbSourceRoot, 'bin/xtb', '#!/bin/sh\n', 0o755);
    for (const param of [
      'share/xtb/param_gfn0-xtb.txt',
      'share/xtb/param_gfn1-xtb.txt',
      'share/xtb/param_gfn2-xtb.txt',
      'share/xtb/.param_gfnff.xtb',
    ]) {
      writeText(xtbSourceRoot, param, 'param\n');
    }
    for (const dylib of DARWIN_V1_LIBRARIES) {
      writeText(xtbSourceRoot, dylib, 'dylib\n');
    }

    const calls = [];
    const outputDir = path.join(root, 'release');
    const result = assembleMacAppBundle({
      repoRoot,
      arch: 'arm64',
      outputDir,
      electronAppPath,
      pythonToolchainRoot,
      pythonDepsRoot,
      xtbSourceRoot,
      productName: 'Ester Studio',
      version: '2.0.2',
      sign: true,
      createDmg: true,
      execFile(cmd, args) {
        calls.push({ cmd, args });
        if (cmd === 'hdiutil') {
          fs.writeFileSync(args[args.length - 1], 'fake-dmg');
        }
      },
    });

    assert.ok(fs.existsSync(result.appBundlePath));
    assert.ok(fs.existsSync(result.chemistryEnginePath));
    assert.ok(fs.existsSync(result.dmgPath));

    const plist = fs.readFileSync(
      path.join(result.appBundlePath, 'Contents', 'Info.plist'),
      'utf8',
    );
    assert.match(plist, /<string>Ester Studio<\/string>/);
    assert.match(plist, /<string>com\.sciyue\.esterstudio<\/string>/);
    assert.match(plist, /<string>2\.0\.2<\/string>/);

    // Verify transitive runtime node_modules were bundled into Resources/app/node_modules
    assert.ok(
      fs.existsSync(path.join(result.appResourcesPath, 'node_modules', 'ssh2', 'index.js')),
    );
    assert.ok(
      fs.existsSync(path.join(result.appResourcesPath, 'node_modules', 'asn1', 'index.js')),
    );

    // Verify launcher script uses -s -B so PYTHONPATH is honored while isolating user site
    const launcher = buildChemistryEngineLauncherScript();
    assert.match(launcher, /exec "\$DIR\/python\/bin\/python3" -s -B "\$DIR\/engine\.py" "\$@"/);

    // Verify chemistryRuntime({ packaged: true }) and xtbRuntime({ packaged: true }) accept the assembled bundle
    const chemRt = chemistryRuntime({
      packaged: true,
      resourcesPath: result.resourcesPath,
      appPath: result.appResourcesPath,
      platform: 'darwin',
      arch: 'arm64',
    });
    assert.equal(chemRt.executable, result.chemistryEnginePath);
    assert.equal(chemRt.bundled, true);

    if (process.platform !== 'win32') {
      const xtbRt = await xtbRuntime({
        packaged: true,
        resourcesPath: result.resourcesPath,
        appPath: result.appResourcesPath,
        platform: 'darwin',
        arch: 'arm64',
      });
      assert.equal(xtbRt.executable, path.join(result.xtbPath, 'bin/xtb'));
      assert.equal(xtbRt.version, '6.7.1');
    }

    assert.equal(calls.length, 2);
    assert.equal(calls[0].cmd, 'codesign');
    assert.equal(calls[1].cmd, 'hdiutil');

    // Missing input validation
    assert.throws(
      () =>
        assembleMacAppBundle({
          repoRoot: path.join(root, 'nonexistent-repo'),
          outputDir,
        }),
      /Missing required packaging input/,
    );
  });
});

test('desktop/main.cjs restricts Windows portable layout resolution to win32 when packaged', () => {
  const mainSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../desktop/main.cjs'),
    'utf8',
  );
  assert.match(
    mainSource,
    /\} else if \(app\.isPackaged && process\.platform === 'win32'\) \{/,
  );
});
