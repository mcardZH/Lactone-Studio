import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DARWIN_ARCHITECTURES,
  DARWIN_EXECUTABLE_PATTERN,
  WIN32_EXECUTABLE_PATTERN,
  isSupportedJavaExecutable,
  resolveJavaHome,
  command,
  parse,
} = require('../../desktop/ocr/molvec.cjs');
const { createOcrRuntime } = require('../../desktop/ocr-runtime.cjs');
const approvedMolvec = require('../../desktop/ocr/molvec-component.json');

async function makeRealTempDir(prefix) {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(raw);
}

async function writeComponent(root, {
  platform,
  architecture,
  executable,
  jar = 'molvec-0.9.8-jar-with-dependencies.jar',
  version = '0.9.8',
  extraFiles = {},
  executableMode = 0o755,
  executableContent = '#!/bin/sh\necho java\n',
  jarContent = 'PK-molvec-jar-content',
}) {
  await fs.mkdir(root, { recursive: true });
  const execFile = path.join(root, ...executable.split('/'));
  await fs.mkdir(path.dirname(execFile), { recursive: true });
  await fs.writeFile(execFile, executableContent, { mode: executableMode });
  if (process.platform !== 'win32') {
    await fs.chmod(execFile, executableMode);
  }
  const jarFile = path.join(root, ...jar.split('/'));
  await fs.mkdir(path.dirname(jarFile), { recursive: true });
  await fs.writeFile(jarFile, jarContent);
  for (const [rel, content] of Object.entries(extraFiles)) {
    const target = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const manifest = {
    schema: 1,
    engine: 'molvec',
    version,
    platform,
    ...(architecture !== undefined ? { architecture } : {}),
    executable,
    jar,
  };
  await fs.writeFile(path.join(root, 'component.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function createDirLinkOrJunction(targetDir, linkPath) {
  try {
    await fs.symlink(targetDir, linkPath, 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'ENOSYS')) {
      await fs.symlink(targetDir, linkPath, 'junction');
      return;
    }
    throw error;
  }
}

test('molvec helpers validate Java launcher paths (including spaces, Chinese JRE directories, and POSIX backslashes), resolve JAVA_HOME, build JVM command, and parse MOL output', () => {
  assert.deepEqual(approvedMolvec, {
    schema: 1,
    engine: 'molvec',
    version: '0.9.8',
    jar: 'molvec-0.9.8-jar-with-dependencies.jar',
  });
  assert.equal('files' in approvedMolvec, false);
  assert.equal('sources' in approvedMolvec, false);
  assert.deepEqual([...DARWIN_ARCHITECTURES], ['arm64', 'x64']);
  assert.equal(DARWIN_EXECUTABLE_PATTERN.test('runtime/jdk-17.0.20.1+1-jre/Contents/Home/bin/java'), true);
  assert.equal(DARWIN_EXECUTABLE_PATTERN.test('runtime/jdk-17.0.20.1+1-jre/bin/java'), true);
  assert.equal(DARWIN_EXECUTABLE_PATTERN.test('runtime/JRE 17/Contents/Home/bin/java'), true);
  assert.equal(DARWIN_EXECUTABLE_PATTERN.test('runtime/运行库-17/bin/java'), true);
  assert.equal(WIN32_EXECUTABLE_PATTERN.test('runtime/jdk-17.0.20.1+1-jre/bin/java.exe'), true);
  assert.equal(WIN32_EXECUTABLE_PATTERN.test('runtime/JRE 17/bin/java.exe'), true);
  assert.equal(WIN32_EXECUTABLE_PATTERN.test('runtime/运行库-17/bin/java.exe'), true);

  // Windows executable validation & JAVA_HOME (including spaces and non-ASCII JRE dir)
  for (const jreDir of ['jdk-17.0.20.1+1-jre', 'JRE 17', '运行库-17']) {
    const relWin = `runtime/${jreDir}/bin/java.exe`;
    const absWin = `C:\\app\\ocr\\molvec\\runtime\\${jreDir}\\bin\\java.exe`;
    assert.equal(isSupportedJavaExecutable(relWin, 'win32'), true);
    assert.equal(isSupportedJavaExecutable(absWin, 'win32'), true);
    assert.equal(isSupportedJavaExecutable(absWin, 'darwin'), false);
    assert.equal(resolveJavaHome(absWin, 'win32'), `C:\\app\\ocr\\molvec\\runtime\\${jreDir}`);
  }

  // macOS flat JRE & Bundle JRE executable validation & JAVA_HOME (including spaces and non-ASCII JRE dir)
  for (const jreDir of ['jdk-17.0.20.1+1-jre', 'JRE 17', '运行库-17']) {
    const relFlat = `runtime/${jreDir}/bin/java`;
    const relBundle = `runtime/${jreDir}/Contents/Home/bin/java`;
    const macFlatExec = `/Applications/Ester Studio.app/Contents/Resources/ocr/molvec/runtime/${jreDir}/bin/java`;
    const macBundleExec = `/Applications/Ester Studio.app/Contents/Resources/ocr/molvec/runtime/${jreDir}/Contents/Home/bin/java`;
    assert.equal(isSupportedJavaExecutable(relFlat, 'darwin'), true);
    assert.equal(isSupportedJavaExecutable(relBundle, 'darwin'), true);
    assert.equal(isSupportedJavaExecutable(macFlatExec, 'darwin'), true);
    assert.equal(isSupportedJavaExecutable(macBundleExec, 'darwin'), true);
    assert.equal(isSupportedJavaExecutable(macBundleExec, 'win32'), false);
    assert.equal(
      resolveJavaHome(macFlatExec, 'darwin'),
      `/Applications/Ester Studio.app/Contents/Resources/ocr/molvec/runtime/${jreDir}`,
    );
    assert.equal(
      resolveJavaHome(macBundleExec, 'darwin'),
      `/Applications/Ester Studio.app/Contents/Resources/ocr/molvec/runtime/${jreDir}/Contents/Home`,
    );
  }

  // Resolved macOS absolute path inside a directory whose name contains a literal backslash
  const macBackslashDirExec = '/private/tmp/ocr\\component/molvec/runtime/jdk-17.0.20.1+1-jre/Contents/Home/bin/java';
  assert.equal(isSupportedJavaExecutable(macBackslashDirExec, 'darwin'), true);
  assert.equal(
    resolveJavaHome(macBackslashDirExec, 'darwin'),
    '/private/tmp/ocr\\component/molvec/runtime/jdk-17.0.20.1+1-jre/Contents/Home',
  );

  // Linux flat JRE executable validation, JAVA_HOME, and path-traversal/backslash/absolute guards
  for (const jreDir of ['openjdk-21', 'JRE 21', '运行库-21']) {
    const relLinux = `runtime/${jreDir}/bin/java`;
    const absLinux = `/opt/lactone-studio/runtime/ocr-components/molvec/runtime/${jreDir}/bin/java`;
    assert.equal(isSupportedJavaExecutable(relLinux, 'linux'), true);
    assert.equal(isSupportedJavaExecutable(absLinux, 'linux'), true);
    assert.equal(isSupportedJavaExecutable(absLinux, 'linux', { allowAbsolute: false }), false);
    assert.equal(
      resolveJavaHome(absLinux, 'linux'),
      `/opt/lactone-studio/runtime/ocr-components/molvec/runtime/${jreDir}`,
    );
  }
  assert.equal(isSupportedJavaExecutable('runtime\\openjdk-21\\bin\\java', 'linux'), false);
  assert.equal(isSupportedJavaExecutable('runtime/../openjdk-21/bin/java', 'linux'), false);
  assert.equal(isSupportedJavaExecutable('/usr/bin/../bin/java', 'linux'), false);

  // Relative manifest executable must reject backslashes, traversal, absolute paths (when allowAbsolute=false), or non-java names
  assert.equal(isSupportedJavaExecutable('runtime\\jdk-17.0.20.1+1-jre\\bin\\java', 'darwin'), false);
  assert.equal(isSupportedJavaExecutable('runtime\\jdk-17.0.20.1+1-jre\\bin\\java.exe', 'win32'), false);
  assert.equal(isSupportedJavaExecutable('runtime/../jdk-17/bin/java', 'darwin'), false);
  assert.equal(isSupportedJavaExecutable('/usr/bin/../bin/java', 'darwin'), false);
  assert.equal(isSupportedJavaExecutable('/usr/bin/java', 'darwin', { allowAbsolute: false }), false);
  assert.equal(isSupportedJavaExecutable('/opt/runtime/jdk-17/bin/java', 'darwin', { allowAbsolute: false }), false);
  assert.equal(isSupportedJavaExecutable('C:\\app\\runtime\\jdk-17\\bin\\java.exe', 'win32', { allowAbsolute: false }), false);
  assert.equal(isSupportedJavaExecutable('/usr/bin/python3', 'darwin'), false);
  assert.equal(isSupportedJavaExecutable('', 'darwin'), false);

  // Command generation for macOS Bundle JRE
  const macBundleExec = '/Applications/Ester Studio.app/Contents/Resources/ocr/molvec/runtime/jdk-17.0.20.1+1-jre/Contents/Home/bin/java';
  const winExec = 'C:\\app\\ocr\\molvec\\runtime\\jdk-17.0.20.1+1-jre\\bin\\java.exe';
  const cmd = command(
    {
      executable: macBundleExec,
      jar: '/Applications/Ester Studio.app/Contents/Resources/ocr/molvec/molvec-0.9.8-jar-with-dependencies.jar',
      manifest: { platform: 'darwin' },
    },
    '/tmp/job/input.png',
    '/tmp/job/candidate.mol',
    { threads: 4, memoryBudgetBytes: 1024 * 1024 * 1024 },
    '/tmp/job',
  );
  assert.equal(cmd.executable, macBundleExec);
  assert.equal(
    cmd.environment.JAVA_HOME,
    '/Applications/Ester Studio.app/Contents/Resources/ocr/molvec/runtime/jdk-17.0.20.1+1-jre/Contents/Home',
  );
  assert.ok(cmd.args.includes('-Djava.awt.headless=true'));
  assert.ok(cmd.args.includes('-Xmx665m'));

  // Reject insufficient memory or mismatched platform launcher in command()
  assert.throws(
    () =>
      command(
        { executable: macBundleExec, jar: '/tmp/molvec.jar', manifest: { platform: 'darwin' } },
        '/tmp/in.png',
        '/tmp/out.mol',
        { threads: 2, memoryBudgetBytes: 64 * 1024 * 1024 },
        '/tmp/job',
      ),
    /OCR_MEMORY/,
  );
  assert.throws(
    () =>
      command(
        { executable: winExec, jar: '/tmp/molvec.jar', manifest: { platform: 'darwin' } },
        '/tmp/in.png',
        '/tmp/out.mol',
        { threads: 2, memoryBudgetBytes: 1024 * 1024 * 1024 },
        '/tmp/job',
      ),
    /OCR_COMPONENT_EXECUTABLE/,
  );

  // Parse valid and invalid MOL blocks
  const validMol = '\n  MolVec\n\n  0  0  0  0  0  0            999 V2000\nM  END\n';
  assert.deepEqual(parse(validMol), { molblock: validMol });
  assert.throws(() => parse('invalid text without end'), /OCR_OUTPUT/);
  assert.throws(() => parse('M  END\0\n'), /OCR_OUTPUT/);
});

test('createOcrRuntime reports not-installed on missing directory for win32-x64, darwin-arm64, and darwin-x64, and rejects unsupported platforms/architectures', async () => {
  const tmpRoot = await makeRealTempDir('ocr-caps-');
  try {
    for (const [platform, architecture] of [
      ['win32', 'x64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
    ]) {
      const runtime = createOcrRuntime({
        distributionRoot: tmpRoot,
        platform,
        architecture,
      });
      const caps = await runtime.capabilities();
      const molvecStatus = caps.engines.find((entry) => entry.engine === 'molvec');
      assert.equal(molvecStatus?.status, 'not-installed');
    }

    const freebsdRuntime = createOcrRuntime({ distributionRoot: tmpRoot, platform: 'freebsd', architecture: 'x64' });
    await assert.rejects(() => freebsdRuntime.resolve('molvec'), /OCR_UNSUPPORTED: 组件不支持当前系统。/);

    const linuxArmRuntime = createOcrRuntime({ distributionRoot: tmpRoot, platform: 'linux', architecture: 'arm64' });
    await assert.rejects(() => linuxArmRuntime.resolve('molvec'), /OCR_UNSUPPORTED: 组件不支持当前处理器架构。/);

    const winArmRuntime = createOcrRuntime({ distributionRoot: tmpRoot, platform: 'win32', architecture: 'arm64' });
    await assert.rejects(() => winArmRuntime.resolve('molvec'), /OCR_UNSUPPORTED: 组件不支持当前处理器架构。/);

    const macIa32Runtime = createOcrRuntime({ distributionRoot: tmpRoot, platform: 'darwin', architecture: 'ia32' });
    await assert.rejects(() => macIa32Runtime.resolve('molvec'), /OCR_UNSUPPORTED: 组件不支持当前处理器架构。/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('createOcrRuntime resolves win32-x64, darwin-arm64 (Bundle & Flat), and darwin-x64 (Bundle & Flat) without JRE hash pinning, supports spaces/Chinese JRE folders and POSIX backslashes, and updates componentSHA256 when JAR content changes', async () => {
  const tmpRoot = await makeRealTempDir('ocr-resolve-');
  try {
    // 1. win32-x64 with spaces/Chinese JRE folder and arbitrary JRE DLLs on disk
    const winRoot = path.join(tmpRoot, 'win32', 'molvec');
    const winExecRel = 'runtime/JRE 17 运行库/bin/java.exe';
    await writeComponent(winRoot, {
      platform: 'win32',
      architecture: 'x64',
      executable: winExecRel,
      extraFiles: {
        'runtime/JRE 17 运行库/bin/server/jvm.dll': 'arbitrary-dll-bytes',
      },
    });
    const winRuntime = createOcrRuntime({
      defaultRoot: path.join(tmpRoot, 'win32'),
      distributionRoot: path.join(tmpRoot, 'win32'),
      platform: 'win32',
      architecture: 'x64',
    });
    const resolvedWin = await winRuntime.resolve('molvec');
    assert.equal(resolvedWin.executable, path.join(winRoot, ...winExecRel.split('/')));

    // 2. darwin-arm64 Bundle layout & Flat layout (including spaces and Chinese JRE directory names)
    for (const [variant, execRel] of [
      ['arm64-bundle', 'runtime/JRE 17/Contents/Home/bin/java'],
      ['arm64-flat', 'runtime/运行库-17/bin/java'],
    ]) {
      const compRoot = path.join(tmpRoot, variant, 'molvec');
      await writeComponent(compRoot, {
        platform: 'darwin',
        architecture: 'arm64',
        executable: execRel,
        extraFiles: {
          'runtime/JRE 17/lib/server/libjvm.dylib': 'unpinned-dylib-bytes',
        },
      });
      const rt = createOcrRuntime({
        defaultRoot: path.join(tmpRoot, variant),
        distributionRoot: path.join(tmpRoot, variant),
        platform: 'darwin',
        architecture: 'arm64',
      });
      const caps = await rt.capabilities();
      assert.equal(caps.engines.find((e) => e.engine === 'molvec')?.status, 'ready');
      const resolved = await rt.resolve('molvec');
      assert.equal(resolved.executable, path.join(compRoot, ...execRel.split('/')));
    }

    // 3. darwin-x64 Bundle layout & Flat layout, plus verifying componentSHA256 equals jarSHA256, ignores extra manifest fields, and changes when JAR bytes change on disk
    const x64Root = path.join(tmpRoot, 'x64-bundle', 'molvec');
    const x64Manifest = await writeComponent(x64Root, {
      platform: 'darwin',
      architecture: 'x64',
      executable: 'runtime/temurin-17-jre/Contents/Home/bin/java',
      jarContent: 'PK-molvec-jar-v1',
    });
    const x64Runtime = createOcrRuntime({
      defaultRoot: path.join(tmpRoot, 'x64-bundle'),
      distributionRoot: path.join(tmpRoot, 'x64-bundle'),
      platform: 'darwin',
      architecture: 'x64',
    });
    const resolvedV1 = await x64Runtime.resolve('molvec');
    assert.equal(resolvedV1.componentSHA256, resolvedV1.jarSHA256);
    await fs.writeFile(
      path.join(x64Root, 'component.json'),
      JSON.stringify({ ...x64Manifest, runtimeVersion: 'Temurin 17.0.21', note: 'extra-field' }, null, 2),
    );
    const resolvedExtraField = await x64Runtime.resolve('molvec');
    assert.equal(resolvedExtraField.componentSHA256, resolvedV1.componentSHA256);
    await fs.writeFile(path.join(x64Root, 'molvec-0.9.8-jar-with-dependencies.jar'), 'PK-molvec-jar-v2');
    const resolvedV2 = await x64Runtime.resolve('molvec');
    assert.equal(resolvedV2.componentSHA256, resolvedV2.jarSHA256);
    assert.notEqual(resolvedV1.componentSHA256, resolvedV2.componentSHA256);
    assert.notEqual(resolvedV1.jarSHA256, resolvedV2.jarSHA256);

    const x64FlatRoot = path.join(tmpRoot, 'x64-flat', 'molvec');
    await writeComponent(x64FlatRoot, {
      platform: 'darwin',
      architecture: 'x64',
      executable: 'runtime/temurin-17-jre/bin/java',
    });
    const x64FlatRuntime = createOcrRuntime({
      defaultRoot: path.join(tmpRoot, 'x64-flat'),
      distributionRoot: path.join(tmpRoot, 'x64-flat'),
      platform: 'darwin',
      architecture: 'x64',
    });
    assert.equal((await x64FlatRuntime.capabilities()).engines[0].status, 'ready');

    // 4. Regression test on POSIX: component directory name containing literal backslash (\)
    if (process.platform !== 'win32') {
      const backslashRoot = path.join(tmpRoot, 'folder\\with\\backslash', 'molvec');
      const macBundleRel = 'runtime/jdk-17.0.20.1+1-jre/Contents/Home/bin/java';
      await writeComponent(backslashRoot, {
        platform: 'darwin',
        architecture: 'arm64',
        executable: macBundleRel,
      });
      const backslashRuntime = createOcrRuntime({
        distributionRoot: tmpRoot,
        platform: 'darwin',
        architecture: 'arm64',
      });
      const backslashCaps = await backslashRuntime.select(backslashRoot);
      assert.equal(backslashCaps.engines.find((entry) => entry.engine === 'molvec')?.status, 'ready');
      const resolvedBackslash = await backslashRuntime.resolve('molvec');
      const builtCommand = command(
        resolvedBackslash,
        path.join(tmpRoot, 'in.png'),
        path.join(tmpRoot, 'out.mol'),
        { threads: 2, memoryBudgetBytes: 512 * 1024 * 1024 },
        tmpRoot,
      );
      assert.equal(builtCommand.executable, path.join(backslashRoot, ...macBundleRel.split('/')));
      assert.equal(
        builtCommand.environment.JAVA_HOME,
        path.posix.join(backslashRoot, 'runtime/jdk-17.0.20.1+1-jre/Contents/Home'),
      );
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('createOcrRuntime rejects missing/invalid architecture field, invalid launcher paths, missing or empty jar/java files, symlinked files/intermediate dirs/roots, and non-executable java binary', async () => {
  const tmpRoot = await makeRealTempDir('ocr-reject-');
  try {
    const compRoot = path.join(tmpRoot, 'molvec');
    const execRel = 'runtime/jdk-17.0.20.1+1-jre/Contents/Home/bin/java';
    const baseManifest = await writeComponent(compRoot, {
      platform: 'darwin',
      architecture: 'arm64',
      executable: execRel,
    });

    const runtime = createOcrRuntime({
      distributionRoot: tmpRoot,
      platform: 'darwin',
      architecture: 'arm64',
    });
    await runtime.resolve('molvec', compRoot);

    // 1. Architecture mismatch, missing, null, empty, or wrong type in component.json -> OCR_COMPONENT_UNAPPROVED
    const x64Runtime = createOcrRuntime({
      distributionRoot: tmpRoot,
      platform: 'darwin',
      architecture: 'x64',
    });
    await assert.rejects(() => x64Runtime.resolve('molvec', compRoot), /OCR_COMPONENT_UNAPPROVED/);

    for (const badArch of [undefined, null, '', false, 0, 'x64']) {
      const badManifest = { ...baseManifest };
      if (badArch === undefined) delete badManifest.architecture;
      else badManifest.architecture = badArch;
      await fs.writeFile(path.join(compRoot, 'component.json'), JSON.stringify(badManifest, null, 2));
      await assert.rejects(() => runtime.resolve('molvec', compRoot), /OCR_COMPONENT_UNAPPROVED/);
    }
    await fs.writeFile(path.join(compRoot, 'component.json'), JSON.stringify(baseManifest, null, 2));

    // 2. Invalid or absolute launcher path in component.json -> OCR_COMPONENT_EXECUTABLE
    const badExecRoot = path.join(tmpRoot, 'molvec-bad-exec');
    await writeComponent(badExecRoot, {
      platform: 'darwin',
      architecture: 'arm64',
      executable: 'runtime/jdk-17/bin/python3',
    });
    await assert.rejects(() => runtime.resolve('molvec', badExecRoot), /OCR_COMPONENT_EXECUTABLE/);

    for (const absExec of ['/usr/bin/java', '/opt/runtime/jdk-17/bin/java']) {
      await fs.writeFile(
        path.join(compRoot, 'component.json'),
        JSON.stringify({ ...baseManifest, executable: absExec }, null, 2),
      );
      await assert.rejects(() => runtime.resolve('molvec', compRoot), /OCR_COMPONENT_EXECUTABLE/);
    }
    await fs.writeFile(path.join(compRoot, 'component.json'), JSON.stringify(baseManifest, null, 2));

    // 3. Non-executable java binary on non-Windows -> OCR_COMPONENT_EXECUTABLE; execute-only (0o111) resolves cleanly
    const execPath = path.join(compRoot, ...execRel.split('/'));
    if (process.platform !== 'win32') {
      await fs.chmod(execPath, 0o644);
      await assert.rejects(() => runtime.resolve('molvec', compRoot), /OCR_COMPONENT_EXECUTABLE/);
      await fs.chmod(execPath, 0o111);
      const execOnlyResolved = await runtime.resolve('molvec', compRoot);
      assert.equal(execOnlyResolved.executable, execPath);
      await fs.chmod(execPath, 0o755);
    }

    // 4. Empty java executable (0 bytes) -> OCR_COMPONENT_FILE; missing java executable -> ENOENT
    await fs.writeFile(execPath, '', { mode: 0o755 });
    await assert.rejects(() => runtime.resolve('molvec', compRoot), /OCR_COMPONENT_FILE/);
    await fs.rm(execPath);
    await assert.rejects(() => runtime.resolve('molvec', compRoot), /ENOENT/);
    await fs.writeFile(execPath, '#!/bin/sh\necho java\n', { mode: 0o755 });
    if (process.platform !== 'win32') await fs.chmod(execPath, 0o755);

    // 5. Empty JAR file (0 bytes) -> OCR_COMPONENT_FILE; missing JAR file -> ENOENT
    const jarPath = path.join(compRoot, 'molvec-0.9.8-jar-with-dependencies.jar');
    await fs.writeFile(jarPath, '');
    await assert.rejects(() => runtime.resolve('molvec', compRoot), /OCR_COMPONENT_FILE/);
    await fs.rm(jarPath);
    await assert.rejects(() => runtime.resolve('molvec', compRoot), /ENOENT/);
    await fs.writeFile(jarPath, 'PK-molvec-jar-content');

    // 6. Symlinked JAR file or symlinked intermediate directory -> OCR_COMPONENT_FILE / OCR_COMPONENT_PATH
    if (process.platform !== 'win32') {
      const externalJar = path.join(tmpRoot, 'external.jar');
      await fs.writeFile(externalJar, 'PK-external-jar');
      await fs.rm(jarPath);
      await fs.symlink(externalJar, jarPath);
      await assert.rejects(() => runtime.resolve('molvec', compRoot), /OCR_COMPONENT_FILE/);
      await fs.rm(jarPath);
      await fs.writeFile(jarPath, 'PK-molvec-jar-content');

      const linkedMidRoot = path.join(tmpRoot, 'molvec-mid-link');
      await fs.mkdir(linkedMidRoot, { recursive: true });
      await fs.writeFile(path.join(linkedMidRoot, 'component.json'), JSON.stringify(baseManifest, null, 2));
      await fs.writeFile(path.join(linkedMidRoot, 'molvec-0.9.8-jar-with-dependencies.jar'), 'PK-jar');
      await createDirLinkOrJunction(path.join(compRoot, 'runtime'), path.join(linkedMidRoot, 'runtime'));
      await assert.rejects(() => runtime.resolve('molvec', linkedMidRoot), /OCR_COMPONENT_PATH/);
    }

    // 7. Symlinked component root -> OCR_COMPONENT_PATH
    const linkRoot = path.join(tmpRoot, 'molvec-link');
    await createDirLinkOrJunction(compRoot, linkRoot);
    await assert.rejects(() => runtime.resolve('molvec', linkRoot), /OCR_COMPONENT_PATH/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
