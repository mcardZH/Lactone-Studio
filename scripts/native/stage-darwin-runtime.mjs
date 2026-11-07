#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { developmentNative, developmentXtb } = require("../../desktop/current-runtime.cjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_APP_PATH = path.resolve(__dirname, "../..");

export const CANONICAL_LOCKED_PREFIX = "/opt/ester-studio-locked-runtime";

export const REQUIRED_SCIENTIFIC_MODULES = Object.freeze([
  "rdkit",
  "ase",
  "spglib",
  "tblite",
  "scipy",
]);

export const DEFAULT_PROBE_MODULES = REQUIRED_SCIENTIFIC_MODULES;

export const STDLIB_TOP_EXCLUDES = new Set([
  "__pycache__",
  "config-3.12-darwin",
  "ensurepip",
  "idlelib",
  "lib2to3",
  "pydoc_data",
  "site-packages",
  "test",
  "tkinter",
  "turtledemo",
]);

export const ALLOWED_SITE_PACKAGES_TOP_ENTRIES = new Set([
  "README.txt",
  "_cffi_backend.cpython-312-darwin.so",
  "_distutils_hack",
  "ase",
  "ase-3.29.0.dist-info",
  "cairo",
  "cffi",
  "cffi-2.1.1.dist-info",
  "charset_normalizer",
  "charset_normalizer-3.5.1.dist-info",
  "dateutil",
  "importlib_resources",
  "importlib_resources-7.1.0.dist-info",
  "munkres-1.1.4-py3.9.egg-info",
  "munkres.py",
  "numpy",
  "numpy-2.5.4.dist-info",
  "packaging",
  "packaging-26.3.dist-info",
  "pycairo-1.29.2.dist-info",
  "pycparser",
  "pycparser-3.12.dist-info",
  "pylab.py",
  "python_dateutil-4.0.0.dist-info",
  "rdkit",
  "rdkit-2026.9.1.dist-info",
  "rlPyCairo",
  "rlpycairo-0.4.0.dist-info",
  "scipy",
  "scipy-1.18.1.dist-info",
  "spglib",
  "spglib-2.8.0.dist-info",
  "tblite",
  "tblite-0.8.0.dist-info",
  "threadpoolctl-3.7.0.dist-info",
  "threadpoolctl.py",
  "typing_extensions-4.16.0.dist-info",
  "typing_extensions.py",
  "unicodedata2-18.0.0.dist-info",
  "unicodedata2.cpython-312-darwin.so",
  "zipp",
  "zipp-4.1.2.dist-info",
]);

export const TOOLCHAIN_DYLIB_PREFIXES = Object.freeze([
  "libpython",
  "libintl",
  "libiconv",
  "libffi",
  "liblzma",
  "libz",
  "libbz2",
  "libsqlite3",
  "libcrypto",
  "libssl",
  "libncurses",
  "libreadline",
  "libtinfo",
  "libexpat",
  "libmpdec",
]);

export const XTB_REQUIRED_DYLIBS = Object.freeze([
  "libblas.3.dylib",
  "liblapack.3.dylib",
  "libopenblas.0.dylib",
  "libgfortran.5.dylib",
  "libomp.dylib",
  "libquadmath.0.dylib",
  "libgcc_s.1.1.dylib",
]);

export const XTB_REQUIRED_PARAMS = Object.freeze([
  ".param_gfnff.xtb",
  "param_gfn0-xtb.txt",
  "param_gfn1-xtb.txt",
  "param_gfn2-xtb.txt",
]);

export const CANONICAL_RDPATHS_PY = [
  "import os",
  "# unset so to trigger exceptions and track use: RDBaseDir=os.environ['RDBASE']",
  "RDCodeDir=os.path.dirname(os.path.abspath(__file__))",
  "# not really hard-coded alternative RDCodeDir=os.path.dirname(__file__)",
  "_share = os.path.join(RDCodeDir, 'share', 'RDKit')",
  "RDDataDir=os.path.join(_share,'Data')",
  "RDDocsDir=os.path.join(_share,'Docs')",
  "RDProjDir=os.path.join(_share,'Projects')",
  "RDContribDir=os.path.join(_share,'Contrib')",
  "",
].join("\n");

const machORelocationCache = new Map();

function normalizeRel(p) {
  return p.split(path.sep).join("/");
}

function sha256Buffer(buf) {
  return {
    bytes: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

export function readMachOCpuTypes(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(64);
    const bytesRead = fs.readSync(fd, header, 0, 64, 0);
    if (bytesRead < 8) return [];
    const magicBE = header.readUInt32BE(0);
    const magicLE = header.readUInt32LE(0);
    if (magicLE === 0xfeedfacf) {
      return [header.readUInt32LE(4)];
    }
    if (magicBE === 0xfeedfacf) {
      return [header.readUInt32BE(4)];
    }
    if (magicBE === 0xcafebabe && bytesRead >= 8) {
      const nfat = header.readUInt32BE(4);
      const types = [];
      for (let i = 0; i < Math.min(nfat, 8); i += 1) {
        const offset = 8 + i * 20;
        if (offset + 4 <= bytesRead) {
          types.push(header.readUInt32BE(offset));
        }
      }
      return types;
    }
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

export function verifyMachOArchitecture(filePath, platformId) {
  if (platformId !== "darwin-arm64" && platformId !== "darwin-x64") {
    throw new Error(`STAGE_PLATFORM_UNSUPPORTED: Unsupported Darwin platformId ${platformId}`);
  }
  const expectedCpuType = platformId === "darwin-arm64" ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64;
  const cpuTypes = readMachOCpuTypes(filePath);
  if (!cpuTypes.includes(expectedCpuType)) {
    throw new Error(
      `STAGE_ARCH_MISMATCH: Binary ${filePath} has Mach-O cpuTypes [${cpuTypes
        .map((x) => `0x${x.toString(16)}`)
        .join(", ")}], which does not match target platform ${platformId}`
    );
  }
}

export function makeDirectoryTreeWritable(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    try {
      const st = fs.lstatSync(dir);
      if (st.isDirectory()) {
        fs.chmodSync(dir, st.mode | 0o200);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const childStat = fs.lstatSync(full);
          if (childStat.isDirectory()) {
            stack.push(full);
          } else if (childStat.isFile()) {
            fs.chmodSync(full, childStat.mode | 0o200);
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

export function lockDirectoryTreeReadOnly(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const dirs = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    dirs.push(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        fs.chmodSync(full, st.mode & ~0o222);
      }
    }
  }
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const st = fs.lstatSync(dirs[i]);
    fs.chmodSync(dirs[i], st.mode & ~0o222);
  }
}

export function verifyTreeReadOnly(rootDir) {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`STAGE_READONLY_FAILED: Directory does not exist: ${rootDir}`);
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const st = fs.lstatSync(current);
    if ((st.mode & 0o222) !== 0) {
      throw new Error(`STAGE_READONLY_FAILED: Path remains writable: ${current}`);
    }
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    }
  }
}

function replaceMachOPrefixSlots(buf, oldPrefixes, newPrefix) {
  let modified = false;
  for (const oldPrefix of oldPrefixes) {
    if (!oldPrefix || oldPrefix === newPrefix) continue;
    const oldBuf = Buffer.from(oldPrefix, "utf8");
    let pos = 0;
    while ((pos = buf.indexOf(oldBuf, pos)) !== -1) {
      let strStart = pos;
      while (strStart > 0 && buf[strStart - 1] !== 0) strStart -= 1;
      let strEnd = pos;
      while (strEnd < buf.length && buf[strEnd] !== 0) strEnd += 1;
      let nulEnd = strEnd;
      while (nulEnd < buf.length && buf[nulEnd] === 0) nulEnd += 1;
      const slotLen = nulEnd - strStart;
      const origStr = buf.subarray(strStart, strEnd).toString("utf8");
      const newStr = origStr.split(oldPrefix).join(newPrefix);
      const newStrBuf = Buffer.from(newStr, "utf8");
      if (newStrBuf.length < slotLen) {
        buf.fill(0, strStart, nulEnd);
        newStrBuf.copy(buf, strStart);
        modified = true;
      }
      pos = nulEnd;
    }
  }
  return modified;
}

export function relocateMachOBinary(filePath, oldPrefixes, newPrefix = CANONICAL_LOCKED_PREFIX) {
  const validPrefixes = [...new Set(oldPrefixes.filter((p) => p && p !== newPrefix))].sort(
    (a, b) => b.length - a.length
  );
  if (validPrefixes.length === 0) return;

  const initialBuf = fs.readFileSync(filePath);
  const hasMatch = validPrefixes.some((p) => initialBuf.indexOf(Buffer.from(p, "utf8")) !== -1);
  if (!hasMatch) return;

  const st = fs.lstatSync(filePath);
  fs.chmodSync(filePath, st.mode | 0o200);

  try {
    execFileSync("codesign", ["--remove-signature", filePath], { stdio: "ignore" });
  } catch {
    // ignore if unsigned
  }

  const unsignedBuf = fs.readFileSync(filePath);
  replaceMachOPrefixSlots(unsignedBuf, validPrefixes, newPrefix);
  const unsignedHash = crypto.createHash("sha256").update(unsignedBuf).digest("hex");

  const cachedSigned = machORelocationCache.get(unsignedHash);
  if (cachedSigned) {
    fs.writeFileSync(filePath, cachedSigned);
    fs.chmodSync(filePath, st.mode);
    return;
  }

  fs.writeFileSync(filePath, unsignedBuf);
  execFileSync("codesign", ["-s", "-", "-f", "-i", "ester-studio-runtime", filePath], {
    stdio: "ignore",
  });
  const signedBuf = fs.readFileSync(filePath);
  if (machORelocationCache.size >= 256) machORelocationCache.clear();
  machORelocationCache.set(unsignedHash, signedBuf);
  fs.chmodSync(filePath, st.mode);
}

export function relocateTreePrefixes(rootDir, oldPrefixes, newPrefix = CANONICAL_LOCKED_PREFIX) {
  if (!fs.existsSync(rootDir)) return;
  const validPrefixes = [...new Set(oldPrefixes.filter((p) => p && p !== newPrefix))].sort(
    (a, b) => b.length - a.length
  );
  if (validPrefixes.length === 0) return;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isDirectory()) {
        walk(fullPath);
      } else if (lstat.isFile()) {
        if (readMachOCpuTypes(fullPath).length > 0) {
          relocateMachOBinary(fullPath, validPrefixes, newPrefix);
        } else {
          const buf = fs.readFileSync(fullPath);
          const hasMatch = validPrefixes.some((p) => buf.indexOf(Buffer.from(p, "utf8")) !== -1);
          if (hasMatch && !buf.includes(0)) {
            let text = buf.toString("utf8");
            for (const p of validPrefixes) {
              text = text.split(p).join(newPrefix);
            }
            fs.chmodSync(fullPath, lstat.mode | 0o200);
            fs.writeFileSync(fullPath, text, "utf8");
            fs.chmodSync(fullPath, lstat.mode);
          }
        }
      }
    }
  };
  walk(rootDir);
}

export function cleanBytecodeAndSymlinks(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  makeDirectoryTreeWritable(rootDir);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        const realTarget = fs.realpathSync(fullPath);
        const targetStat = fs.statSync(realTarget);
        fs.unlinkSync(fullPath);
        if (targetStat.isFile()) {
          fs.copyFileSync(realTarget, fullPath);
          fs.chmodSync(fullPath, targetStat.mode);
        }
        continue;
      }
      if (lstat.isDirectory()) {
        if (entry.name === "__pycache__" || entry.name === "test" || entry.name === "tests") {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          walk(fullPath);
        }
      } else if (
        lstat.isFile() &&
        (entry.name.endsWith(".pyc") ||
          entry.name.endsWith(".pyo") ||
          entry.name.endsWith(".pth") ||
          entry.name.endsWith(".orig") ||
          entry.name.endsWith(".a") ||
          entry.name === "CTestTestfile.cmake")
      ) {
        fs.unlinkSync(fullPath);
      }
    }
  };
  walk(rootDir);
}

export function buildInventoryFiles(rootDir, contentDirectories = ["python"]) {
  const files = [];
  for (const contentDir of contentDirectories) {
    const absDir = path.join(rootDir, contentDir);
    if (!fs.existsSync(absDir)) continue;
    const stack = [absDir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        const lstat = fs.lstatSync(fullPath);
        if (lstat.isDirectory()) {
          stack.push(fullPath);
        } else if (lstat.isFile()) {
          const { bytes, sha256 } = sha256File(fullPath);
          files.push({
            path: normalizeRel(path.relative(rootDir, fullPath)),
            bytes,
            sha256,
          });
        }
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function stageFromCondaPrefix(
  condaPrefix,
  toolchainPythonDir,
  runtimePythonDir,
  runtimeXtbDir
) {
  const resolvedPrefix = path.resolve(condaPrefix);
  if (!fs.existsSync(resolvedPrefix)) {
    throw new Error(`STAGE_SOURCE_MISSING: Conda prefix does not exist: ${resolvedPrefix}`);
  }
  const realPrefix = fs.realpathSync(resolvedPrefix);
  const prefixesToRelocate = [resolvedPrefix, realPrefix, "/opt/anaconda3/envs/ester-studio"];
  const copyFlag = fs.constants.COPYFILE_FICLONE || 0;

  makeDirectoryTreeWritable(toolchainPythonDir);
  makeDirectoryTreeWritable(runtimePythonDir);
  makeDirectoryTreeWritable(runtimeXtbDir);
  fs.rmSync(toolchainPythonDir, { recursive: true, force: true });
  fs.rmSync(runtimePythonDir, { recursive: true, force: true });
  fs.rmSync(runtimeXtbDir, { recursive: true, force: true });

  const srcBinPythonPath = path.join(resolvedPrefix, "bin", "python3");
  if (!fs.existsSync(srcBinPythonPath)) {
    throw new Error(`STAGE_PYTHON_MISSING: ${srcBinPythonPath} does not exist`);
  }
  const srcBinPython = fs.realpathSync(srcBinPythonPath);
  const dstBinPython = path.join(toolchainPythonDir, "bin", "python3");
  fs.mkdirSync(path.dirname(dstBinPython), { recursive: true });
  fs.copyFileSync(srcBinPython, dstBinPython, copyFlag);
  fs.chmodSync(dstBinPython, 0o755);

  const srcLibDir = path.join(resolvedPrefix, "lib");
  if (!fs.existsSync(srcLibDir)) {
    throw new Error(`STAGE_LIB_MISSING: ${srcLibDir} does not exist`);
  }
  for (const entry of fs.readdirSync(srcLibDir, { withFileTypes: true })) {
    if (entry.name.endsWith(".dylib")) {
      const realDylib = fs.realpathSync(path.join(srcLibDir, entry.name));
      const dstRtDylib = path.join(runtimePythonDir, "lib", entry.name);
      fs.mkdirSync(path.dirname(dstRtDylib), { recursive: true });
      fs.copyFileSync(realDylib, dstRtDylib, copyFlag);

      if (TOOLCHAIN_DYLIB_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
        const dstTcDylib = path.join(toolchainPythonDir, "lib", entry.name);
        fs.mkdirSync(path.dirname(dstTcDylib), { recursive: true });
        fs.copyFileSync(realDylib, dstTcDylib, copyFlag);
      }
    }
  }

  const srcPyStdlib = path.join(resolvedPrefix, "lib", "python3.12");
  const dstPyStdlib = path.join(toolchainPythonDir, "lib", "python3.12");
  if (!fs.existsSync(srcPyStdlib)) {
    throw new Error(`STAGE_STDLIB_MISSING: ${srcPyStdlib} does not exist`);
  }
  const copyStdlib = (srcDir, dstDir, isTop = false) => {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (isTop && STDLIB_TOP_EXCLUDES.has(entry.name)) continue;
      if (entry.name === "__pycache__" || entry.name === "test" || entry.name === "tests") continue;
      const srcFull = path.join(srcDir, entry.name);
      const dstFull = path.join(dstDir, entry.name);
      const realFull = fs.realpathSync(srcFull);
      const st = fs.statSync(realFull);
      if (st.isDirectory()) {
        copyStdlib(realFull, dstFull, false);
      } else if (
        st.isFile() &&
        !entry.name.endsWith(".pyc") &&
        !entry.name.endsWith(".pyo") &&
        !entry.name.endsWith(".orig") &&
        !entry.name.endsWith(".a") &&
        entry.name !== "CTestTestfile.cmake"
      ) {
        fs.copyFileSync(realFull, dstFull, copyFlag);
        fs.chmodSync(dstFull, st.mode);
      }
    }
  };
  copyStdlib(srcPyStdlib, dstPyStdlib, true);

  const srcSitePackages = path.join(srcPyStdlib, "site-packages");
  const dstSitePackages = path.join(runtimePythonDir, "lib", "python3.12", "site-packages");
  if (!fs.existsSync(srcSitePackages)) {
    throw new Error(`STAGE_SITE_PACKAGES_MISSING: ${srcSitePackages} does not exist`);
  }
  const copySitePackages = (srcDir, dstDir, isTop = false) => {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (isTop && !ALLOWED_SITE_PACKAGES_TOP_ENTRIES.has(entry.name)) continue;
      if (entry.name === "__pycache__" || entry.name === "test" || entry.name === "tests") continue;
      if (entry.name.endsWith(".pth") || entry.name.endsWith(".orig")) continue;
      if (entry.name === "CTestTestfile.cmake") continue;
      const srcFull = path.join(srcDir, entry.name);
      const dstFull = path.join(dstDir, entry.name);
      const realFull = fs.realpathSync(srcFull);
      const st = fs.statSync(realFull);
      if (st.isDirectory()) {
        copySitePackages(realFull, dstFull, false);
      } else if (
        st.isFile() &&
        !entry.name.endsWith(".pyc") &&
        !entry.name.endsWith(".pyo") &&
        !entry.name.endsWith(".a")
      ) {
        fs.copyFileSync(realFull, dstFull, copyFlag);
        fs.chmodSync(dstFull, st.mode);
      }
    }
  };
  copySitePackages(srcSitePackages, dstSitePackages, true);

  // Stage RDKit share/RDKit/Data into site-packages/rdkit/share/RDKit and write relative RDPaths.py
  const dstRdkitDir = path.join(dstSitePackages, "rdkit");
  if (!fs.existsSync(dstRdkitDir)) {
    throw new Error(`STAGE_RDKIT_MISSING: rdkit package not found in ${dstSitePackages}`);
  }
  const candidateRdkitShareDirs = [
    path.join(resolvedPrefix, "share", "RDKit"),
    path.join(dstRdkitDir, "share", "RDKit"),
  ];
  const srcRdkitShare = candidateRdkitShareDirs.find((d) =>
    fs.existsSync(path.join(d, "Data"))
  );
  if (!srcRdkitShare) {
    throw new Error(
      `STAGE_RDKIT_DATA_MISSING: Expected share/RDKit/Data in ${resolvedPrefix}`
    );
  }
  const dstRdkitShare = path.join(dstRdkitDir, "share", "RDKit");
  if (path.resolve(srcRdkitShare) !== path.resolve(dstRdkitShare)) {
    const copyTree = (srcDir, dstDir) => {
      fs.mkdirSync(dstDir, { recursive: true });
      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const s = fs.realpathSync(path.join(srcDir, entry.name));
        const d = path.join(dstDir, entry.name);
        const st = fs.statSync(s);
        if (st.isDirectory()) {
          copyTree(s, d);
        } else if (st.isFile()) {
          fs.copyFileSync(s, d, copyFlag);
          fs.chmodSync(d, st.mode);
        }
      }
    };
    copyTree(path.join(srcRdkitShare, "Data"), path.join(dstRdkitShare, "Data"));
    for (const metaFile of ["README.md", "license.txt"]) {
      const sMeta = path.join(srcRdkitShare, metaFile);
      if (fs.existsSync(sMeta)) {
        fs.copyFileSync(fs.realpathSync(sMeta), path.join(dstRdkitShare, metaFile), copyFlag);
      }
    }
  }
  const rdPathsFile = path.join(dstRdkitDir, "RDPaths.py");
  if (fs.existsSync(rdPathsFile)) {
    fs.chmodSync(rdPathsFile, 0o644);
  }
  fs.writeFileSync(rdPathsFile, CANONICAL_RDPATHS_PY, "utf8");

  // 3. xTB runtime: bin/xtb, lib/*.dylib, share/xtb/param*
  const srcXtbBin = path.join(resolvedPrefix, "bin", "xtb");
  const srcXtbShare = path.join(resolvedPrefix, "share", "xtb");
  if (!fs.existsSync(srcXtbBin) || !fs.existsSync(srcXtbShare)) {
    throw new Error(
      `STAGE_XTB_MISSING: Expected xtb binary and share/xtb parameters in ${resolvedPrefix}`
    );
  }
  const dstXtbBin = path.join(runtimeXtbDir, "bin", "xtb");
  fs.mkdirSync(path.dirname(dstXtbBin), { recursive: true });
  fs.copyFileSync(fs.realpathSync(srcXtbBin), dstXtbBin, copyFlag);
  fs.chmodSync(dstXtbBin, 0o755);

  const dstXtbLib = path.join(runtimeXtbDir, "lib");
  fs.mkdirSync(dstXtbLib, { recursive: true });
  for (const dylibName of XTB_REQUIRED_DYLIBS) {
    const srcDylib = path.join(srcLibDir, dylibName);
    if (!fs.existsSync(srcDylib)) {
      throw new Error(`STAGE_XTB_DYLIB_MISSING: Missing required xTB dylib ${srcDylib}`);
    }
    fs.copyFileSync(fs.realpathSync(srcDylib), path.join(dstXtbLib, dylibName), copyFlag);
  }

  const dstXtbShare = path.join(runtimeXtbDir, "share", "xtb");
  fs.mkdirSync(dstXtbShare, { recursive: true });
  for (const paramName of XTB_REQUIRED_PARAMS) {
    const srcParam = path.join(srcXtbShare, paramName);
    if (!fs.existsSync(srcParam)) {
      throw new Error(`STAGE_XTB_PARAM_MISSING: Missing ${srcParam}`);
    }
    fs.copyFileSync(fs.realpathSync(srcParam), path.join(dstXtbShare, paramName), copyFlag);
  }

  cleanBytecodeAndSymlinks(toolchainPythonDir);
  cleanBytecodeAndSymlinks(runtimePythonDir);
  cleanBytecodeAndSymlinks(runtimeXtbDir);

  relocateTreePrefixes(toolchainPythonDir, prefixesToRelocate, CANONICAL_LOCKED_PREFIX);
  relocateTreePrefixes(runtimePythonDir, prefixesToRelocate, CANONICAL_LOCKED_PREFIX);
  relocateTreePrefixes(runtimeXtbDir, prefixesToRelocate, CANONICAL_LOCKED_PREFIX);
}

export function verifyStagedXtbRuntime(xtbDir, pythonBinPath, platformId) {
  const xtbBinPath = path.join(xtbDir, "bin", "xtb");
  if (!fs.existsSync(xtbBinPath)) {
    throw new Error(`STAGE_XTB_MISSING: ${xtbBinPath} does not exist`);
  }
  verifyMachOArchitecture(xtbBinPath, platformId);

  if (pythonBinPath && fs.existsSync(pythonBinPath)) {
    const pyHash = sha256File(pythonBinPath).sha256;
    const xtbHash = sha256File(xtbBinPath).sha256;
    if (pyHash === xtbHash) {
      throw new Error(
        "STAGE_XTB_INVALID: xtb binary is identical to python3 executable (fake xtb binary rejected)"
      );
    }
  }

  for (const dylibName of XTB_REQUIRED_DYLIBS) {
    const dylibPath = path.join(xtbDir, "lib", dylibName);
    if (!fs.existsSync(dylibPath)) {
      throw new Error(`STAGE_XTB_DYLIB_MISSING: ${dylibPath} does not exist`);
    }
    verifyMachOArchitecture(dylibPath, platformId);
  }

  for (const paramName of XTB_REQUIRED_PARAMS) {
    const paramPath = path.join(xtbDir, "share", "xtb", paramName);
    if (!fs.existsSync(paramPath) || fs.statSync(paramPath).size < 1024) {
      throw new Error(
        `STAGE_XTB_PARAM_INVALID: Parameter file ${paramPath} is missing or truncated`
      );
    }
  }

  if (process.platform === "darwin" && `darwin-${process.arch}` === platformId) {
    let out;
    try {
      out = execFileSync(xtbBinPath, ["--version"], {
        env: {
          PATH: "/usr/bin:/bin",
          XTBPATH: path.join(xtbDir, "share", "xtb"),
          OMP_NUM_THREADS: "1",
          DYLD_FALLBACK_LIBRARY_PATH: [path.join(xtbDir, "lib"), "/usr/lib"].join(path.delimiter),
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const stderr = err.stderr ? String(err.stderr).trim() : err.message;
      throw new Error(`STAGE_XTB_PROBE_FAILED: xtb --version failed: ${stderr}`);
    }
    if (!String(out).toLowerCase().includes("xtb")) {
      throw new Error(`STAGE_XTB_PROBE_FAILED: Unexpected xtb --version output: ${out}`);
    }
  }
}

export function runImportProbe({
  pythonExecutable,
  tcAbsRoot,
  depAbsRoot,
  platformId,
  probeModules = REQUIRED_SCIENTIFIC_MODULES,
}) {
  if (!Array.isArray(probeModules) || probeModules.length === 0) {
    throw new Error("STAGE_IMPORT_PROBE_INVALID: probeModules must be a non-empty array");
  }
  for (const reqMod of REQUIRED_SCIENTIFIC_MODULES) {
    if (!probeModules.includes(reqMod)) {
      throw new Error(
        `STAGE_IMPORT_PROBE_INVALID: probeModules is missing required scientific module '${reqMod}'`
      );
    }
  }

  const sitePackagesDir = path.join(depAbsRoot, "python", "lib", "python3.12", "site-packages");
  const probeScript = [
    "import importlib, json, os, pathlib, sys",
    "for k in list(os.environ.keys()):",
    "    if k.upper() == 'RDBASE':",
    "        os.environ.pop(k, None)",
    `tc_root = pathlib.Path(${JSON.stringify(tcAbsRoot)}).resolve()`,
    `dep_site = pathlib.Path(${JSON.stringify(sitePackagesDir)}).resolve()`,
    "exe = pathlib.Path(sys.executable).resolve()",
    "prefix = pathlib.Path(sys.prefix).resolve()",
    "if not exe.is_relative_to(tc_root) or not prefix.is_relative_to(tc_root):",
    "    raise RuntimeError(f'Probe interpreter escaped toolchain root: {exe} / {prefix}')",
    "sys.path[:] = [str(dep_site)] + [str(pathlib.Path(p).resolve()) for p in sys.path if p and pathlib.Path(p).resolve().is_relative_to(tc_root)]",
    "loaded = {}",
    `for mod_name in ${JSON.stringify(probeModules)}:`,
    "    mod = importlib.import_module(mod_name)",
    "    mod_file = pathlib.Path(getattr(mod, '__file__', '')).resolve()",
    "    if not mod_file.is_relative_to(dep_site):",
    "        raise RuntimeError(f'Module {mod_name} loaded from outside locked site-packages: {mod_file}')",
    "    loaded[mod_name] = str(mod_file)",
    "from rdkit import RDConfig",
    "try:",
    "    import tblite.interface, rdkit.Chem.AllChem, scipy.linalg, scipy.optimize, scipy.spatial, ase.build",
    "except Exception:",
    "    pass",
    "rd_data = pathlib.Path(RDConfig.RDDataDir).resolve()",
    "expected_rd_data = (dep_site / 'rdkit' / 'share' / 'RDKit' / 'Data').resolve()",
    "if rd_data != expected_rd_data or not (rd_data / 'Salts.txt').is_file():",
    "    raise RuntimeError(f'RDKit RDDataDir escaped locked runtime: {rd_data} (expected {expected_rd_data})')",
    "print(json.dumps({'schema': 'sciyue-import-probe-v1', 'passed': True, 'platform': " +
      JSON.stringify(platformId) +
      ", 'modules': sorted(list(loaded.keys()))}))",
  ].join("\n");

  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    OMP_NUM_THREADS: "1",
    RDBASE: "/invalid/ambient/rdbase/must/be/ignored",
    DYLD_FALLBACK_LIBRARY_PATH: [
      path.join(depAbsRoot, "python", "lib"),
      path.join(tcAbsRoot, "python", "lib"),
      "/usr/lib",
    ].join(path.delimiter),
  };

  let stdout;
  try {
    stdout = execFileSync(pythonExecutable, ["-I", "-S", "-B", "-c", probeScript], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(`STAGE_IMPORT_PROBE_FAILED: ${stderr}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`STAGE_IMPORT_PROBE_FAILED: Invalid JSON output from probe: ${stdout}`);
  }
  if (!parsed || parsed.passed !== true) {
    throw new Error("STAGE_IMPORT_PROBE_FAILED: Probe did not report passed=true");
  }
  return parsed;
}

function copyDirectoryTree(srcDir, dstDir) {
  const copyFlag = fs.constants.COPYFILE_FICLONE || 0;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcFull = path.join(srcDir, entry.name);
    const dstFull = path.join(dstDir, entry.name);
    const st = fs.lstatSync(srcFull);
    if (st.isDirectory()) {
      copyDirectoryTree(srcFull, dstFull);
    } else if (st.isFile()) {
      fs.copyFileSync(srcFull, dstFull, copyFlag);
      fs.chmodSync(dstFull, st.mode | 0o200);
    }
  }
}

export function stageDarwinRuntime({
  appPath = DEFAULT_APP_PATH,
  platformId = `darwin-${process.arch}`,
  condaPrefix = null,
  toolchainLockId = "conda-py312-arm64",
  runtimeLockId = "conda-chem-arm64",
  xtbLockId = `${platformId}-xtb-v1`,
  updateLocks = false,
  verifyCommittedLocks = true,
  lockReadOnly = true,
} = {}) {
  if (platformId !== "darwin-arm64" && platformId !== "darwin-x64") {
    throw new Error(`STAGE_PLATFORM_UNSUPPORTED: Unsupported platformId: ${platformId}`);
  }

  const resolvedAppPath = path.resolve(appPath);
  const tcRelRoot = `.local/toolchains/${platformId}/${toolchainLockId}`;
  const depRelRoot = `.local/dependencies/${platformId}/${runtimeLockId}`;
  const prepRelDir = `.local/preparation/${platformId}`;

  const tcAbsRoot = path.join(resolvedAppPath, tcRelRoot);
  const depAbsRoot = path.join(resolvedAppPath, depRelRoot);
  const prepAbsDir = path.join(resolvedAppPath, prepRelDir);
  const packagingAbsDir = path.join(resolvedAppPath, "desktop", "packaging");

  // Stage in an isolated transaction directory so existing .local state is never corrupted on error
  const txRoot = fs.mkdtempSync(path.join(os.tmpdir(), "es-darwin-stage-tx-"));
  const txTcAbsRoot = path.join(txRoot, "tc");
  const txDepAbsRoot = path.join(txRoot, "dep");
  const txPrepAbsDir = path.join(txRoot, "prep");

  try {
    fs.mkdirSync(path.join(txTcAbsRoot, "python"), { recursive: true });
    fs.mkdirSync(path.join(txDepAbsRoot, "python"), { recursive: true });
    fs.mkdirSync(path.join(txDepAbsRoot, "xtb"), { recursive: true });
    fs.mkdirSync(txPrepAbsDir, { recursive: true });

    if (condaPrefix) {
      stageFromCondaPrefix(
        condaPrefix,
        path.join(txTcAbsRoot, "python"),
        path.join(txDepAbsRoot, "python"),
        path.join(txDepAbsRoot, "xtb")
      );
    } else {
      if (
        !fs.existsSync(path.join(tcAbsRoot, "python")) ||
        !fs.existsSync(path.join(depAbsRoot, "python")) ||
        !fs.existsSync(path.join(depAbsRoot, "xtb"))
      ) {
        throw new Error(
          `STAGE_SOURCE_MISSING: No condaPrefix provided and existing .local directories are incomplete in ${resolvedAppPath}`
        );
      }
      copyDirectoryTree(path.join(tcAbsRoot, "python"), path.join(txTcAbsRoot, "python"));
      copyDirectoryTree(path.join(depAbsRoot, "python"), path.join(txDepAbsRoot, "python"));
      copyDirectoryTree(path.join(depAbsRoot, "xtb"), path.join(txDepAbsRoot, "xtb"));
      cleanBytecodeAndSymlinks(path.join(txTcAbsRoot, "python"));
      cleanBytecodeAndSymlinks(path.join(txDepAbsRoot, "python"));
      cleanBytecodeAndSymlinks(path.join(txDepAbsRoot, "xtb"));
      relocateTreePrefixes(
        path.join(txTcAbsRoot, "python"),
        ["/opt/anaconda3/envs/ester-studio"],
        CANONICAL_LOCKED_PREFIX
      );
      relocateTreePrefixes(
        path.join(txDepAbsRoot, "python"),
        ["/opt/anaconda3/envs/ester-studio"],
        CANONICAL_LOCKED_PREFIX
      );
      relocateTreePrefixes(
        path.join(txDepAbsRoot, "xtb"),
        ["/opt/anaconda3/envs/ester-studio"],
        CANONICAL_LOCKED_PREFIX
      );
    }

    const txPythonBinPath = path.join(txTcAbsRoot, "python", "bin", "python3");
    if (!fs.existsSync(txPythonBinPath)) {
      throw new Error(`STAGE_PYTHON_MISSING: ${txPythonBinPath} does not exist`);
    }

    verifyMachOArchitecture(txPythonBinPath, platformId);
    verifyStagedXtbRuntime(path.join(txDepAbsRoot, "xtb"), txPythonBinPath, platformId);

    const xtbRuntimeDescriptorPath = path.join(txDepAbsRoot, "xtb", "runtime.json");
    const xtbDescriptorPayload = {
      schema: "sciyue-xtb-bundled-runtime/v1",
      version: "6.4.1",
      platform: platformId,
      scope: "local-experimental",
      localUseReady: true,
      publicRedistributionReviewed: false,
      distributionLicenseReady: false,
      entry: "bin/xtb",
      dataDirectory: "share/xtb",
      methods: ["gfn0", "gfn1", "gfn2", "gfnff"],
    };
    fs.writeFileSync(
      xtbRuntimeDescriptorPath,
      `${JSON.stringify(xtbDescriptorPayload, null, 2)}\n`,
      "utf8"
    );

    const tcFiles = buildInventoryFiles(txTcAbsRoot, ["python"]);
    const depFiles = buildInventoryFiles(txDepAbsRoot, ["python"]);
    const xtbFiles = buildInventoryFiles(txDepAbsRoot, ["xtb"]);

    if (tcFiles.length === 0 || depFiles.length === 0 || xtbFiles.length === 0) {
      throw new Error(
        `STAGE_RUNTIME_EMPTY: Staged runtime has empty inventory (tc=${tcFiles.length}, dep=${depFiles.length}, xtb=${xtbFiles.length})`
      );
    }

    const probeResult = runImportProbe({
      pythonExecutable: txPythonBinPath,
      tcAbsRoot: txTcAbsRoot,
      depAbsRoot: txDepAbsRoot,
      platformId,
      probeModules: REQUIRED_SCIENTIFIC_MODULES,
    });

    const tcInvRel = `${tcRelRoot}/inventory.json`;
    const tcInvPayload = {
      schema: "sciyue-native-toolchain-lock-v1",
      lockId: toolchainLockId,
      root: tcRelRoot,
      files: tcFiles,
    };
    const tcInvText = `${JSON.stringify(tcInvPayload, null, 2)}\n`;
    const tcInvMeta = sha256Buffer(Buffer.from(tcInvText, "utf8"));

    const depInvRel = `${depRelRoot}/inventory.json`;
    const depInvPayload = {
      schema: "sciyue-native-runtime-lock-v1",
      lockId: runtimeLockId,
      root: depRelRoot,
      files: depFiles,
    };
    const depInvText = `${JSON.stringify(depInvPayload, null, 2)}\n`;
    const depInvMeta = sha256Buffer(Buffer.from(depInvText, "utf8"));

    const tcLockRel = `desktop/packaging/native-toolchain.${platformId}.lock.json`;
    const tcLockAbs = path.join(resolvedAppPath, tcLockRel);
    const tcLockPayload = {
      schema: "sciyue-native-toolchain-lock-v1",
      platform: platformId,
      lockId: toolchainLockId,
      root: tcRelRoot,
      contentDirectories: ["python"],
      python: "python/bin/python3",
      inventory: {
        bytes: tcInvMeta.bytes,
        path: tcInvRel,
        sha256: tcInvMeta.sha256,
      },
    };
    const tcLockText = `${JSON.stringify(tcLockPayload, null, 2)}\n`;
    const tcLockMeta = sha256Buffer(Buffer.from(tcLockText, "utf8"));

    const depLockRel = `desktop/packaging/native-runtime.${platformId}.lock.json`;
    const depLockAbs = path.join(resolvedAppPath, depLockRel);
    const depLockPayload = {
      schema: "sciyue-native-runtime-lock-v1",
      platform: platformId,
      lockId: runtimeLockId,
      root: depRelRoot,
      contentDirectories: ["python"],
      inventory: {
        bytes: depInvMeta.bytes,
        path: depInvRel,
        sha256: depInvMeta.sha256,
      },
    };
    const depLockText = `${JSON.stringify(depLockPayload, null, 2)}\n`;
    const depLockMeta = sha256Buffer(Buffer.from(depLockText, "utf8"));

    const xtbLockRel = `desktop/packaging/xtb-runtime.${platformId}.lock.json`;
    const xtbLockAbs = path.join(resolvedAppPath, xtbLockRel);
    const xtbLockPayload = {
      schema: "sciyue-xtb-lock-v1",
      platform: platformId,
      lockId: xtbLockId,
      root: depRelRoot,
      contentDirectories: ["xtb"],
      localUseReady: true,
      entry: "xtb/bin/xtb",
      dataDirectory: "xtb/share/xtb",
      files: xtbFiles,
    };
    const xtbLockText = `${JSON.stringify(xtbLockPayload, null, 2)}\n`;
    const xtbLockMeta = sha256Buffer(Buffer.from(xtbLockText, "utf8"));

    const probePayload = {
      schema: "sciyue-import-probe-v1",
      passed: true,
      scienceExecuted: false,
      platform: platformId,
      runtimeLock: {
        bytes: depLockMeta.bytes,
        path: depLockRel,
        sha256: depLockMeta.sha256,
      },
      toolchainLock: {
        bytes: tcLockMeta.bytes,
        path: tcLockRel,
        sha256: tcLockMeta.sha256,
      },
      xtbLock: {
        bytes: xtbLockMeta.bytes,
        path: xtbLockRel,
        sha256: xtbLockMeta.sha256,
      },
      modules: probeResult.modules,
    };
    const probeRel = `${prepRelDir}/import-probe.json`;
    const probeText = `${JSON.stringify(probePayload, null, 2)}\n`;
    const probeMeta = sha256Buffer(Buffer.from(probeText, "utf8"));

    const prepRel = `${prepRelDir}/native-preparation.json`;
    const prepPayload = {
      schema: "sciyue-native-preparation-v1",
      passed: true,
      scienceExecuted: false,
      runtimeLock: {
        bytes: depLockMeta.bytes,
        path: depLockRel,
        sha256: depLockMeta.sha256,
      },
      toolchainLock: {
        bytes: tcLockMeta.bytes,
        path: tcLockRel,
        sha256: tcLockMeta.sha256,
      },
      xtbLock: {
        bytes: xtbLockMeta.bytes,
        path: xtbLockRel,
        sha256: xtbLockMeta.sha256,
      },
      importProbe: {
        bytes: probeMeta.bytes,
        path: probeRel,
        sha256: probeMeta.sha256,
      },
    };
    const prepText = `${JSON.stringify(prepPayload, null, 2)}\n`;
    const prepMeta = sha256Buffer(Buffer.from(prepText, "utf8"));

    const profileRel = `desktop/packaging/native-profile.${platformId}.json`;
    const profileAbs = path.join(resolvedAppPath, profileRel);
    const profilePayload = {
      schema: "sciyue-native-profile-v1",
      platform: platformId,
      runtimeLock: depLockRel,
      toolchainLock: tcLockRel,
      xtbLock: xtbLockRel,
      preparation: {
        bytes: prepMeta.bytes,
        path: prepRel,
        sha256: prepMeta.sha256,
      },
    };
    const profileText = `${JSON.stringify(profilePayload, null, 2)}\n`;

    // Verify against existing committed locks & profile BEFORE touching appPath
    const hasExistingLocks =
      fs.existsSync(tcLockAbs) && fs.existsSync(depLockAbs) && fs.existsSync(xtbLockAbs);
    if (hasExistingLocks && !updateLocks && verifyCommittedLocks) {
      const committedTcMeta = sha256File(tcLockAbs);
      const committedDepMeta = sha256File(depLockAbs);
      const committedXtbMeta = sha256File(xtbLockAbs);
      const profileDrift =
        fs.existsSync(profileAbs) &&
        sha256File(profileAbs).sha256 !== sha256Buffer(Buffer.from(profileText, "utf8")).sha256;

      if (
        committedTcMeta.sha256 !== tcLockMeta.sha256 ||
        committedDepMeta.sha256 !== depLockMeta.sha256 ||
        committedXtbMeta.sha256 !== xtbLockMeta.sha256 ||
        profileDrift
      ) {
        throw new Error(
          `STAGE_LOCK_DRIFT: Staged inventory or preparation differs from committed locks/profile in ${packagingAbsDir} (pass updateLocks: true or --update-locks to update)`
        );
      }
    }

    // All validations passed! Commit staged trees and metadata into appPath
    makeDirectoryTreeWritable(tcAbsRoot);
    makeDirectoryTreeWritable(depAbsRoot);
    fs.rmSync(path.join(tcAbsRoot, "python"), { recursive: true, force: true });
    fs.rmSync(path.join(depAbsRoot, "python"), { recursive: true, force: true });
    fs.rmSync(path.join(depAbsRoot, "xtb"), { recursive: true, force: true });

    fs.mkdirSync(tcAbsRoot, { recursive: true });
    fs.mkdirSync(depAbsRoot, { recursive: true });
    fs.mkdirSync(prepAbsDir, { recursive: true });
    fs.mkdirSync(packagingAbsDir, { recursive: true });

    copyDirectoryTree(path.join(txTcAbsRoot, "python"), path.join(tcAbsRoot, "python"));
    copyDirectoryTree(path.join(txDepAbsRoot, "python"), path.join(depAbsRoot, "python"));
    copyDirectoryTree(path.join(txDepAbsRoot, "xtb"), path.join(depAbsRoot, "xtb"));

    fs.writeFileSync(path.join(resolvedAppPath, tcInvRel), tcInvText, "utf8");
    fs.writeFileSync(path.join(resolvedAppPath, depInvRel), depInvText, "utf8");
    fs.writeFileSync(path.join(resolvedAppPath, probeRel), probeText, "utf8");
    fs.writeFileSync(path.join(resolvedAppPath, prepRel), prepText, "utf8");

    if (!hasExistingLocks || updateLocks || !verifyCommittedLocks) {
      fs.writeFileSync(tcLockAbs, tcLockText, "utf8");
      fs.writeFileSync(depLockAbs, depLockText, "utf8");
      fs.writeFileSync(xtbLockAbs, xtbLockText, "utf8");
    }
    if (!fs.existsSync(profileAbs) || updateLocks || !verifyCommittedLocks) {
      fs.writeFileSync(profileAbs, profileText, "utf8");
    }

    if (lockReadOnly) {
      lockDirectoryTreeReadOnly(path.join(tcAbsRoot, "python"));
      lockDirectoryTreeReadOnly(path.join(depAbsRoot, "python"));
      lockDirectoryTreeReadOnly(path.join(depAbsRoot, "xtb"));
      verifyTreeReadOnly(path.join(tcAbsRoot, "python"));
      verifyTreeReadOnly(path.join(depAbsRoot, "python"));
      verifyTreeReadOnly(path.join(depAbsRoot, "xtb"));
    }

    // Warm up final committed Mach-O inodes so macOS kernel caches ad-hoc signatures immediately
    runImportProbe({
      pythonExecutable: path.join(tcAbsRoot, "python", "bin", "python3"),
      tcAbsRoot,
      depAbsRoot,
      platformId,
      probeModules: REQUIRED_SCIENTIFIC_MODULES,
    });

    // End-to-end admission verification when engine.py is present in appPath
    if (fs.existsSync(path.join(resolvedAppPath, "desktop", "chemistry", "engine.py"))) {
      developmentNative(resolvedAppPath, { platformId });
      developmentXtb(resolvedAppPath, { platformId });
    }

    return {
      appPath: resolvedAppPath,
      platformId,
      profilePath: profileAbs,
      toolchainRoot: tcAbsRoot,
      dependencyRoot: depAbsRoot,
      toolchainFileCount: tcFiles.length,
      dependencyFileCount: depFiles.length,
      xtbFileCount: xtbFiles.length,
    };
  } finally {
    fs.rmSync(txRoot, { recursive: true, force: true });
  }
}

export function resolveDefaultCondaPrefix(env = process.env) {
  if (env.SCIYUE_CONDA_ENV && fs.existsSync(env.SCIYUE_CONDA_ENV)) {
    return path.resolve(env.SCIYUE_CONDA_ENV);
  }
  const dedicatedEnv = "/opt/anaconda3/envs/ester-studio";
  if (fs.existsSync(dedicatedEnv)) {
    return dedicatedEnv;
  }
  return null;
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--app-path" && argv[i + 1]) {
      opts.appPath = argv[++i];
    } else if (arg === "--conda-prefix" && argv[i + 1]) {
      opts.condaPrefix = argv[++i];
    } else if (arg === "--platform" && argv[i + 1]) {
      opts.platformId = argv[++i];
    } else if (arg === "--update-locks") {
      opts.updateLocks = true;
    } else if (arg === "--no-readonly") {
      opts.lockReadOnly = false;
    }
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  if (!cliOpts.condaPrefix) {
    const resolved = resolveDefaultCondaPrefix(process.env);
    if (resolved) {
      cliOpts.condaPrefix = resolved;
    }
  }
  const result = stageDarwinRuntime(cliOpts);
  console.log(
    `Staged ${result.platformId} runtime in ${result.appPath} (${result.toolchainFileCount} toolchain files, ${result.dependencyFileCount} dependency files, ${result.xtbFileCount} xtb files)`
  );
}
