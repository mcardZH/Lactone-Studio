import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  assembleMacAppBundle,
  buildChemistryBootstrapScript,
  buildChemistryEngineLauncherScript,
  parseCliArgs,
  removeTreeForce,
  resolveDefaultMacRuntimeSources,
} from '../../scripts/release/package-macos.mjs';
import { ensureDarwinRuntimeReady } from '../../scripts/native/stage-darwin-runtime.mjs';

const require = createRequire(import.meta.url);
const { chemistryRuntime } = require('../../desktop/runtime.cjs');
const { xtbRuntime } = require('../../desktop/xtb-runtime.cjs');
const { DARWIN_V1_LIBRARIES } = require('../../desktop/xtb-runtime-contract.cjs');
const { createOcrRuntime } = require('../../desktop/ocr-runtime.cjs');
const { assertExportDestination } = require('../../desktop/portable-export.cjs');
const { prepareVersionProfile } = require('../../desktop/version-profile.cjs');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ester-pkg-mac-test-'));
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

function writeMockElectronTemplate(electronAppPath) {
  writeText(
    electronAppPath,
    'Contents/Info.plist',
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Electron</string>
  <key>CFBundleName</key>
  <string>Electron</string>
  <key>CFBundleDisplayName</key>
  <string>Electron</string>
  <key>CFBundleIdentifier</key>
  <string>com.github.Electron</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>44.7.0</string>
  <key>CFBundleVersion</key>
  <string>44.7.0</string>
</dict>
</plist>`,
  );
  writeText(electronAppPath, 'Contents/MacOS/Electron', '#!/bin/sh\n', 0o755);
  writeText(electronAppPath, 'Contents/Resources/default_app.asar', 'default-asar');
  const fwDir = path.join(electronAppPath, 'Contents/Frameworks/Electron Framework.framework');
  writeText(fwDir, 'Versions/A/Electron Framework', '#!/bin/sh\n', 0o755);
  writeText(
    fwDir,
    'Versions/A/Resources/Info.plist',
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Electron Framework</string>
  <key>CFBundleIdentifier</key>
  <string>com.github.Electron.framework</string>
  <key>CFBundleName</key>
  <string>Electron Framework</string>
  <key>CFBundlePackageType</key>
  <string>FMWK</string>
  <key>CFBundleVersion</key>
  <string>44.7.0</string>
</dict>
</plist>`,
  );
  if (process.platform !== 'win32') {
    fs.symlinkSync('A', path.join(fwDir, 'Versions/Current'));
    fs.symlinkSync('Versions/Current/Electron Framework', path.join(fwDir, 'Electron Framework'));
    fs.symlinkSync('Versions/Current/Resources', path.join(fwDir, 'Resources'));
  } else {
    writeText(fwDir, 'Electron Framework', '#!/bin/sh\n', 0o755);
  }
  for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
    const helperName = `Electron Helper${suffix}`;
    writeText(
      electronAppPath,
      `Contents/Frameworks/${helperName}.app/Contents/Info.plist`,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${helperName}</string>
  <key>CFBundleIdentifier</key>
  <string>com.github.Electron.helper</string>
  <key>CFBundleName</key>
  <string>${helperName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
</dict>
</plist>`,
    );
    writeText(
      electronAppPath,
      `Contents/Frameworks/${helperName}.app/Contents/MacOS/${helperName}`,
      '#!/bin/sh\n',
      0o755,
    );
  }
}

test('assembleMacAppBundle rebrands Electron executable and Helpers, stages DMG root directory, and runs isolated chemistry/engine with PYTHONPLATLIBDIR/PYTHONVERBOSE hostility', async () => {
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

    // 1. Minimal Electron.app template with default_app.asar, Electron Framework, and Helper apps
    writeMockElectronTemplate(electronAppPath);

    // 2. Repo inputs (dist, desktop, package.json, LICENSE.txt, ssh2 dependency)
    writeText(
      repoRoot,
      'package.json',
      JSON.stringify({ name: 'sciyue-input-studio', version: '2.0.2' }),
    );
    writeText(repoRoot, 'LICENSE.txt', 'Ester Studio License\n');
    writeText(repoRoot, 'dist/index.html', '<!doctype html><html></html>\n');
    writeText(repoRoot, 'desktop/main.cjs', '// main\n');
    writeText(
      repoRoot,
      'desktop/chemistry/engine.py',
      `import json, sys
from rdkit import RDConfig
from rdkit.Chem.SaltRemover import SaltRemover
remover = SaltRemover()
print(json.dumps({"rdDataDir": RDConfig.RDDataDir, "saltsCount": len(remover.salts), "args": sys.argv[1:]}))
`,
    );
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
    writeText(pythonToolchainRoot, 'lib/python3.12/os.py', '# stdlib os\n', 0o444);
    for (const pkg of ['numpy', 'rdkit', 'scipy', 'ase', 'spglib', 'tblite']) {
      writeText(pythonDepsRoot, `lib/python3.12/site-packages/${pkg}/__init__.py`, '', 0o444);
    }
    writeText(
      pythonDepsRoot,
      'lib/python3.12/site-packages/rdkit/share/RDKit/Data/Salts.txt',
      '// simulated salts\n',
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
    let observedDmgStageEntries = [];
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
          const srcFolderIdx = args.indexOf('-srcfolder');
          const srcFolder = args[srcFolderIdx + 1];
          observedDmgStageEntries = fs.readdirSync(srcFolder).sort();
          fs.writeFileSync(args[args.length - 1], 'fake-dmg');
        }
      },
    });

    assert.ok(fs.existsSync(result.appBundlePath));
    assert.ok(fs.existsSync(result.executablePath));
    assert.equal(path.basename(result.executablePath), 'Ester Studio');
    assert.equal(
      fs.existsSync(path.join(result.appBundlePath, 'Contents', 'MacOS', 'Electron')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(result.resourcesPath, 'default_app.asar')),
      false,
    );

    const plist = fs.readFileSync(
      path.join(result.appBundlePath, 'Contents', 'Info.plist'),
      'utf8',
    );
    assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>Ester Studio<\/string>/);
    assert.match(plist, /<string>com\.sciyue\.esterstudio<\/string>/);
    assert.match(plist, /<string>2\.0\.2<\/string>/);

    // Verify all 4 Helper apps and executables are rebranded
    for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
      const helperName = `Ester Studio Helper${suffix}`;
      const helperBin = path.join(
        result.appBundlePath,
        'Contents',
        'Frameworks',
        `${helperName}.app`,
        'Contents',
        'MacOS',
        helperName,
      );
      assert.ok(fs.existsSync(helperBin), `Expected rebranded helper executable ${helperBin}`);
    }

    // Verify DMG staging folder contains Ester Studio.app at root (not Contents/)
    assert.ok(observedDmgStageEntries.includes('Ester Studio.app'));

    // Verify transitive runtime node_modules were bundled into Resources/app/node_modules
    assert.ok(
      fs.existsSync(path.join(result.appResourcesPath, 'node_modules', 'ssh2', 'index.js')),
    );
    assert.ok(
      fs.existsSync(path.join(result.appResourcesPath, 'node_modules', 'asn1', 'index.js')),
    );

    // Verify launcher and bootstrap scripts use -I -S -B and RDBASE
    const launcher = buildChemistryEngineLauncherScript();
    const bootstrap = buildChemistryBootstrapScript();
    assert.match(launcher, /exec "\$DIR\/python\/bin\/python3" -I -S -B "\$DIR\/bootstrap\.py" "\$@"/);
    assert.match(bootstrap, /rdkit_share = os\.path\.join\(site_packages, 'rdkit', 'share', 'RDKit'\)/);

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

    // Live execution of packaged chemistry/engine against staged darwin-arm64 runtime
    // with hostile PYTHONPLATLIBDIR=lib64 and PYTHONVERBOSE=1
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      ensureDarwinRuntimeReady({ appPath: process.cwd(), platformId: 'darwin-arm64' });
      const realTc = path.resolve(
        process.cwd(),
        '.local/toolchains/darwin-arm64/conda-py312-arm64/python',
      );
      const realDeps = path.resolve(
        process.cwd(),
        '.local/dependencies/darwin-arm64/conda-chem-arm64/python',
      );
      const chemDir = path.join(result.resourcesPath, 'chemistry');
      removeTreeForce(path.join(chemDir, 'python'));
      removeTreeForce(path.join(chemDir, 'deps'));
      fs.symlinkSync(realTc, path.join(chemDir, 'python'));
      fs.symlinkSync(realDeps, path.join(chemDir, 'deps'));

      const engineOut = execFileSync(result.chemistryEnginePath, ['--capabilities'], {
        cwd: chemDir,
        env: {
          ...process.env,
          PYTHONPLATLIBDIR: 'lib64',
          PYTHONVERBOSE: '1',
          PYTHONHOME: '/nonexistent-python-home',
          PYTHONPATH: '/nonexistent-python-path',
        },
        encoding: 'utf8',
        timeout: 30000,
      });
      const parsed = JSON.parse(engineOut.trim());
      assert.ok(fs.existsSync(path.join(parsed.rdDataDir, 'Salts.txt')));
      assert.ok(parsed.saltsCount > 0);
      assert.deepEqual(parsed.args, ['--capabilities']);
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

test('resolveDefaultMacRuntimeSources and assembleMacAppBundle support darwin-x64 with stageDarwinRuntime default layout and lock overrides', async () => {
  await withTempDir(async (root) => {
    const repoRoot = path.join(root, 'repo-x64');
    const outputDir = path.join(root, 'release-x64');
    const electronAppPath = path.join(repoRoot, 'node_modules/electron/dist/Electron.app');
    writeMockElectronTemplate(electronAppPath);
    writeText(repoRoot, 'package.json', JSON.stringify({ name: 'sciyue', version: '2.0.2' }, null, 2));
    writeText(repoRoot, 'LICENSE.txt', 'MIT');
    writeText(repoRoot, 'dist/index.html', '<html></html>');
    writeText(repoRoot, 'desktop/main.cjs', '// main');
    writeText(repoRoot, 'desktop/chemistry/engine.py', 'print("{}")\n');
    writeText(
      repoRoot,
      'node_modules/ssh2/package.json',
      JSON.stringify({ name: 'ssh2', version: '1.17.0' }),
    );
    writeText(repoRoot, 'node_modules/ssh2/index.js', 'module.exports = {};\n');

    // Simulate stageDarwinRuntime default directory naming on darwin-x64 (conda-py312-arm64 / conda-chem-arm64)
    const tcPrefix = '.local/toolchains/darwin-x64/conda-py312-arm64/python';
    const depPrefix = '.local/dependencies/darwin-x64/conda-chem-arm64/python';
    const xtbPrefix = '.local/dependencies/darwin-x64/conda-chem-arm64/xtb';
    writeText(repoRoot, `${tcPrefix}/bin/python3`, '#!/bin/sh\necho "{}"\n', 0o755);
    writeText(repoRoot, `${tcPrefix}/lib/python3.12/os.py`, '# stdlib os\n');
    for (const pkg of ['numpy', 'rdkit', 'scipy', 'ase', 'spglib', 'tblite']) {
      writeText(repoRoot, `${depPrefix}/lib/python3.12/site-packages/${pkg}/__init__.py`, '');
    }
    writeText(
      repoRoot,
      `${xtbPrefix}/runtime.json`,
      JSON.stringify({
        schema: 'sciyue-xtb-bundled-runtime/v1',
        version: '6.7.1',
        platform: 'darwin-x64',
        scope: 'local-experimental',
        localUseReady: true,
        publicRedistributionReviewed: false,
        distributionLicenseReady: false,
        entry: 'bin/xtb',
        dataDirectory: 'share/xtb',
        methods: ['gfn0', 'gfn1', 'gfn2', 'gfnff'],
      }),
    );
    writeText(repoRoot, `${xtbPrefix}/bin/xtb`, '#!/bin/sh\necho "xtb version 6.7.1"\n', 0o755);
    for (const dylib of DARWIN_V1_LIBRARIES) {
      writeText(repoRoot, `${xtbPrefix}/${dylib}`, 'fake-dylib');
    }
    for (const param of [
      'share/xtb/param_gfn0-xtb.txt',
      'share/xtb/param_gfn1-xtb.txt',
      'share/xtb/param_gfn2-xtb.txt',
      'share/xtb/.param_gfnff.xtb',
    ]) {
      writeText(repoRoot, `${xtbPrefix}/${param}`, 'param');
    }

    const sources = resolveDefaultMacRuntimeSources(repoRoot, 'x64');
    assert.equal(sources.pythonToolchainRoot, path.join(repoRoot, tcPrefix));
    assert.equal(sources.pythonDepsRoot, path.join(repoRoot, depPrefix));
    assert.equal(sources.xtbSourceRoot, path.join(repoRoot, xtbPrefix));

    const result = assembleMacAppBundle({
      repoRoot,
      arch: 'x64',
      outputDir,
      sign: false,
      createDmg: false,
    });
    assert.equal(fs.existsSync(result.executablePath), true);
    assert.equal(fs.existsSync(result.chemistryEnginePath), true);

    // Binary plist template (bplist00) + real codesign --verify --deep --strict on macOS
    if (process.platform === 'darwin') {
      execFileSync('/usr/bin/plutil', [
        '-convert',
        'binary1',
        path.join(electronAppPath, 'Contents/Info.plist'),
      ]);
      for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
        execFileSync('/usr/bin/plutil', [
          '-convert',
          'binary1',
          path.join(
            electronAppPath,
            `Contents/Frameworks/Electron Helper${suffix}.app/Contents/Info.plist`,
          ),
        ]);
      }
      const binPlistOutDir = path.join(root, 'release-bplist');
      const binPlistResult = assembleMacAppBundle({
        repoRoot,
        arch: 'x64',
        outputDir: binPlistOutDir,
        sign: true,
        createDmg: false,
      });
      execFileSync('/usr/bin/plutil', [
        '-lint',
        '-s',
        path.join(binPlistResult.appBundlePath, 'Contents/Info.plist'),
      ]);
      const outPlist = fs.readFileSync(
        path.join(binPlistResult.appBundlePath, 'Contents/Info.plist'),
        'utf8',
      );
      assert.match(outPlist, /<key>CFBundleExecutable<\/key>\s*<string>Ester Studio<\/string>/);
      assert.match(outPlist, /<string>com\.sciyue\.esterstudio<\/string>/);
      execFileSync('codesign', ['--verify', '--deep', '--strict', binPlistResult.appBundlePath]);
    }

    // Incomplete Electron.app template (missing Helper app or Electron Framework.framework) must fail
    const missingHelperDir = path.join(
      electronAppPath,
      'Contents/Frameworks/Electron Helper (GPU).app',
    );
    const savedHelperDir = path.join(root, 'saved-gpu-helper.app');
    fs.renameSync(missingHelperDir, savedHelperDir);
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /Missing required packaging input \(Electron Helper \(GPU\)\.app\)/,
    );
    fs.renameSync(savedHelperDir, missingHelperDir);

    const fwPath = path.join(
      electronAppPath,
      'Contents/Frameworks/Electron Framework.framework',
    );
    const savedFwPath = path.join(root, 'saved-electron-fw.framework');
    fs.renameSync(fwPath, savedFwPath);
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /Missing required packaging input \(Electron Framework\.framework\)/,
    );
    fs.renameSync(savedFwPath, fwPath);

    // Corrupt Info.plist in Electron.app template must fail before assembly
    const origPlist = fs.readFileSync(path.join(electronAppPath, 'Contents/Info.plist'));
    writeText(electronAppPath, 'Contents/Info.plist', 'not-a-valid-plist<<<');
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /Invalid( or corrupt| XML) Electron Info\.plist/,
    );
    fs.writeFileSync(path.join(electronAppPath, 'Contents/Info.plist'), origPlist);

    // Single-component override should not fail when that component's lock file is corrupt/missing
    writeText(repoRoot, 'desktop/packaging/native-toolchain.darwin-x64.lock.json', '{corrupt-tc');
    const singleOverrideResult = assembleMacAppBundle({
      repoRoot,
      arch: 'x64',
      outputDir,
      pythonToolchainRoot: path.join(repoRoot, tcPrefix),
    });
    assert.equal(fs.existsSync(singleOverrideResult.executablePath), true);
    fs.rmSync(path.join(repoRoot, 'desktop/packaging/native-toolchain.darwin-x64.lock.json'));

    // Missing required scientific package (e.g. numpy or scipy) must fail
    fs.rmSync(path.join(repoRoot, depPrefix, 'lib/python3.12/site-packages/numpy'), {
      recursive: true,
      force: true,
    });
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /Missing required packaging input \(Python scientific package numpy\)/,
    );
    writeText(repoRoot, `${depPrefix}/lib/python3.12/site-packages/numpy/__init__.py`, '');

    // Symlink in Python toolchain (e.g. bin/python3 pointing outside) must fail
    const realPyBin = path.join(repoRoot, `${tcPrefix}/bin/python3`);
    const extTarget = writeText(root, 'external-python3', '#!/bin/sh\necho "{}"\n', 0o755);
    fs.rmSync(realPyBin);
    fs.symlinkSync(extTarget, realPyBin);
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /must not be a symlink/,
    );
    fs.rmSync(realPyBin);
    writeText(repoRoot, `${tcPrefix}/bin/python3`, '#!/bin/sh\necho "{}"\n', 0o755);

    // Rejects unsupported xtb v2 schema without provenance anchor or localUseReady: false
    writeText(
      repoRoot,
      `${xtbPrefix}/runtime.json`,
      JSON.stringify({
        schema: 'sciyue-xtb-bundled-runtime/v1',
        version: '6.7.1',
        platform: 'darwin-x64',
        scope: 'local-experimental',
        localUseReady: false,
        publicRedistributionReviewed: false,
        distributionLicenseReady: false,
        entry: 'bin/xtb',
        dataDirectory: 'share/xtb',
        methods: ['gfn0', 'gfn1', 'gfn2', 'gfnff'],
      }),
    );
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /XTB_RUNTIME_INCOMPLETE/,
    );
    writeText(
      repoRoot,
      `${xtbPrefix}/runtime.json`,
      JSON.stringify({
        schema: 'sciyue-xtb-bundled-runtime/v1',
        version: '6.7.1',
        platform: 'darwin-x64',
        scope: 'local-experimental',
        localUseReady: true,
        publicRedistributionReviewed: false,
        distributionLicenseReady: false,
        entry: 'bin/xtb',
        dataDirectory: 'share/xtb',
        methods: ['gfn0', 'gfn1', 'gfn2', 'gfnff'],
      }),
    );

    // Locked runtime member size/sha256 mismatch (e.g. truncated parameter file) must fail
    writeText(
      repoRoot,
      'desktop/packaging/xtb-runtime.darwin-x64.lock.json',
      JSON.stringify({
        schema: 'sciyue-xtb-lock-v1',
        platform: 'darwin-x64',
        root: '.local/dependencies/darwin-x64/conda-chem-arm64',
        contentDirectories: ['xtb'],
        files: [
          {
            path: 'xtb/share/xtb/param_gfn2-xtb.txt',
            bytes: 35849,
            sha256: '0'.repeat(64),
          },
        ],
      }),
    );
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /Locked runtime member size mismatch/,
    );
    fs.rmSync(path.join(repoRoot, 'desktop/packaging/xtb-runtime.darwin-x64.lock.json'));

    // Undeclared file (e.g. sitecustomize.py) in locked runtime directory must fail
    const pyBinContent = '#!/bin/sh\necho "{}"\n';
    const osPyContent = '# stdlib os\n';
    const { createHash } = await import('node:crypto');
    const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
    const invJson = JSON.stringify({
      schema: 'sciyue-native-inventory-v1',
      files: [
        { path: 'python/bin/python3', bytes: Buffer.byteLength(pyBinContent), sha256: sha256(pyBinContent) },
        { path: 'python/lib/python3.12/os.py', bytes: Buffer.byteLength(osPyContent), sha256: sha256(osPyContent) },
      ],
    });
    writeText(repoRoot, '.local/toolchains/darwin-x64/conda-py312-arm64/inventory.json', invJson);
    writeText(
      repoRoot,
      'desktop/packaging/native-toolchain.darwin-x64.lock.json',
      JSON.stringify({
        schema: 'sciyue-native-toolchain-lock-v1',
        platform: 'darwin-x64',
        root: '.local/toolchains/darwin-x64/conda-py312-arm64',
        contentDirectories: ['python'],
        inventory: {
          path: '.local/toolchains/darwin-x64/conda-py312-arm64/inventory.json',
          bytes: Buffer.byteLength(invJson),
          sha256: sha256(invJson),
        },
      }),
    );
    writeText(repoRoot, `${tcPrefix}/lib/python3.12/sitecustomize.py`, 'print("HIJACK")');
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /Undeclared file in locked runtime toolchain lock \(python\/lib\/python3\.12\/sitecustomize\.py\)/,
    );
    fs.rmSync(path.join(repoRoot, `${tcPrefix}/lib/python3.12/sitecustomize.py`));
    fs.rmSync(path.join(repoRoot, 'desktop/packaging/native-toolchain.darwin-x64.lock.json'));

    // Optional OCR component in runtime/ocr is mapped so createOcrRuntime discovers it as ready
    const jarContent = 'fake-molvec-jar';
    writeText(repoRoot, 'runtime/ocr/molvec-0.9.8-jar-with-dependencies.jar', jarContent);
    writeText(repoRoot, 'runtime/ocr/runtime/jdk-17.0.20.1+1-jre/bin/java', '#!/bin/sh\n', 0o755);
    writeText(
      repoRoot,
      'runtime/ocr/component.json',
      JSON.stringify({
        schema: 1,
        engine: 'molvec',
        version: '0.9.8',
        platform: 'darwin',
        architecture: 'x64',
        executable: 'runtime/jdk-17.0.20.1+1-jre/bin/java',
        jar: 'molvec-0.9.8-jar-with-dependencies.jar',
      }),
    );
    const ocrBundle = assembleMacAppBundle({
      repoRoot,
      arch: 'x64',
      outputDir,
      sign: false,
      createDmg: false,
    });
    const ocrRt = createOcrRuntime({
      distributionRoot: ocrBundle.appResourcesPath,
      platform: 'darwin',
      architecture: 'x64',
    });
    const ocrCaps = await ocrRt.capabilities();
    const molvecStatus = ocrCaps.engines.find((entry) => entry.engine === 'molvec');
    assert.equal(molvecStatus?.status, 'ready');

    //Missing ssh2 runtime dependency must fail
    fs.rmSync(path.join(repoRoot, 'node_modules/ssh2'), { recursive: true, force: true });
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /Missing required packaging input \(ssh2 runtime dependency\)/,
    );
    writeText(
      repoRoot,
      'node_modules/ssh2/package.json',
      JSON.stringify({ name: 'ssh2', version: '1.17.0' }),
    );
    writeText(repoRoot, 'node_modules/ssh2/index.js', 'module.exports = {};\n');

    // Mach-O extension (.so) architecture mismatch inside pythonDepsRoot must throw
    const arm64MachO = Buffer.alloc(32);
    arm64MachO.writeUInt32BE(0xcffaedfe, 0); // MH_MAGIC_64 (LE)
    arm64MachO.writeInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
    const rdBaseSo = path.join(repoRoot, depPrefix, 'lib/python3.12/site-packages/rdkit/rdBase.so');
    fs.writeFileSync(rdBaseSo, arm64MachO);
    assert.throws(
      () => assembleMacAppBundle({ repoRoot, arch: 'x64', outputDir }),
      /Binary architecture mismatch in Python scientific dependencies.*rdBase\.so.*expected darwin-x64, found \[arm64\]/,
    );
    fs.rmSync(rdBaseSo);

    // Empty directories via explicit overrides must fail before deleting existing output
    const emptyDir = path.join(root, 'empty-dir');
    fs.mkdirSync(emptyDir, { recursive: true });
    assert.throws(
      () =>
        assembleMacAppBundle({
          repoRoot,
          arch: 'x64',
          outputDir,
          pythonToolchainRoot: emptyDir,
          pythonDepsRoot: emptyDir,
          xtbSourceRoot: emptyDir,
        }),
      /Missing required packaging input/,
    );
    assert.equal(fs.existsSync(result.executablePath), true);

    // Lock file pointing to missing directory must NOT silently fall back to conda-py312-arm64
    writeText(
      repoRoot,
      'desktop/packaging/native-toolchain.darwin-x64.lock.json',
      JSON.stringify({
        schema: 'sciyue-native-toolchain-lock-v1',
        platform: 'darwin-x64',
        root: '.local/toolchains/darwin-x64/missing-toolchain',
      }),
    );
    assert.throws(
      () =>
        assembleMacAppBundle({
          repoRoot,
          arch: 'x64',
          outputDir,
        }),
      /Missing required packaging input \(Python toolchain directory\)/,
    );

    // Corrupt lock JSON must throw immediately
    writeText(repoRoot, 'desktop/packaging/native-toolchain.darwin-x64.lock.json', '{corrupt-json');
    assert.throws(
      () => resolveDefaultMacRuntimeSources(repoRoot, 'x64'),
      /Invalid JSON in toolchain lock/,
    );
    fs.rmSync(path.join(repoRoot, 'desktop/packaging/native-toolchain.darwin-x64.lock.json'));

    // Mach-O binary architecture mismatch (arm64 binary when packaging for x64) must throw
    fs.writeFileSync(path.join(electronAppPath, 'Contents/MacOS/Electron'), arm64MachO);
    fs.chmodSync(path.join(electronAppPath, 'Contents/MacOS/Electron'), 0o755);
    assert.throws(
      () =>
        assembleMacAppBundle({
          repoRoot,
          arch: 'x64',
          outputDir,
        }),
      /Binary architecture mismatch for Electron executable.*expected darwin-x64, found \[arm64\]/,
    );

    const parsedCli = parseCliArgs([
      '--skip-build',
      '--skip-dmg',
      '--arch=x64',
      '--python-toolchain-root',
      '/tmp/custom-tc',
    ]);
    assert.equal(parsedCli.skipBuild, true);
    assert.equal(parsedCli.skipDmg, true);
    assert.equal(parsedCli.options.arch, 'x64');
    assert.equal(parsedCli.options.pythonToolchainRoot, path.resolve('/tmp/custom-tc'));
  });
});

test('desktop/main.cjs and desktop/preload.cjs use standard prepareVersionProfile on macOS without Windows portableProfile', async () => {
  const mainSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../desktop/main.cjs'),
    'utf8',
  );
  assert.match(
    mainSource,
    /\} else if \(app\.isPackaged && process\.platform === 'win32'\) \{/,
  );

  const preloadSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../desktop/preload.cjs'),
    'utf8',
  );
  assert.match(
    preloadSource,
    /\(\(process\.platform === 'win32' \|\| process\.env\?\.SCIYUE_TEST_ISOLATED_IO === '1'\) \? \{ portableTools:/,
  );

  await withTempDir(async (root) => {
    const appDataDir = path.join(root, 'Library', 'Application Support');
    fs.mkdirSync(appDataDir, { recursive: true });
    const profileDir = prepareVersionProfile(fs, appDataDir, '2.0.2');
    assert.equal(profileDir, path.join(appDataDir, 'SciYue', 'profiles', 'v2.0.2'));
    assert.equal(fs.existsSync(profileDir), true);

    // Verify assertExportDestination allows POSIX filenames like con.json on darwin while rejecting on win32
    const conPath = path.join(root, 'Documents', 'con.json');
    assert.equal(
      assertExportDestination(conPath, {
        root: path.join(root, 'app'),
        managedRoots: [profileDir],
        applicationRoots: [path.join(root, 'app', 'desktop'), path.join(root, 'app', 'dist')],
        platform: 'darwin',
      }),
      conPath,
    );
    assert.throws(
      () =>
        assertExportDestination(conPath, {
          root: path.join(root, 'app'),
          managedRoots: [profileDir],
          applicationRoots: [path.join(root, 'app', 'desktop')],
          platform: 'win32',
        }),
      /设备名/,
    );
  });

  // Execute preload.cjs in a controlled VM sandbox for darwin vs win32
  const vm = await import('node:vm');
  function runPreloadFor(platform, env = {}) {
    let exposedBridge = null;
    const sandbox = {
      require(modName) {
        assert.equal(modName, 'electron');
        return {
          contextBridge: {
            exposeInMainWorld(name, api) {
              if (name === 'sciyueDesktop') exposedBridge = api;
            },
          },
          ipcRenderer: {
            invoke: async (channel, payload) => ({ channel, payload }),
            on: () => {},
            removeListener: () => {},
          },
          webUtils: { getPathForFile: () => '' },
        };
      },
      process: { platform, env },
      Int8Array,
      Uint8Array,
      Uint8ClampedArray,
      Int16Array,
      Uint16Array,
      Int32Array,
      Uint32Array,
      Float32Array,
      Float64Array,
      BigInt64Array,
      BigUint64Array,
      DataView,
      ArrayBuffer,
      WeakSet,
      Set,
      Object,
      Array,
      Number,
      Error,
      TypeError,
    };
    vm.runInNewContext(preloadSource, sandbox, { filename: 'preload.cjs' });
    return exposedBridge;
  }

  const darwinBridge = runPreloadFor('darwin', {});
  assert.ok(darwinBridge);
  assert.equal('portableTools' in darwinBridge, false);

  const win32Bridge = runPreloadFor('win32', {});
  assert.ok(win32Bridge);
  assert.equal(typeof win32Bridge.portableTools, 'function');

  const isolatedDarwinBridge = runPreloadFor('darwin', { SCIYUE_TEST_ISOLATED_IO: '1' });
  assert.ok(isolatedDarwinBridge);
  assert.equal(typeof isolatedDarwinBridge.portableTools, 'function');
});
