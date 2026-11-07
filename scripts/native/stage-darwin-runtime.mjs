#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  developmentNative,
  developmentXtb,
  currentRuntimeEnvironment,
} = require("../../desktop/current-runtime.cjs");

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

export const ALLOWED_SITE_PACKAGES_DIST_INFO_PREFIXES = Object.freeze([
  "ase",
  "cffi",
  "charset_normalizer",
  "importlib_resources",
  "munkres",
  "numpy",
  "packaging",
  "pycairo",
  "pycparser",
  "python_dateutil",
  "rdkit",
  "rlpycairo",
  "scipy",
  "spglib",
  "tblite",
  "threadpoolctl",
  "typing_extensions",
  "unicodedata2",
  "zipp",
]);

export function isAllowedSitePackagesTopEntry(name) {
  if (ALLOWED_SITE_PACKAGES_TOP_ENTRIES.has(name)) return true;
  const match = /^([A-Za-z0-9_.-]+?)-[0-9][A-Za-z0-9_.-]*\.(?:dist-info|egg-info)$/.exec(name);
  if (!match) return false;
  const normalizedPkg = match[1].toLowerCase().replace(/-/g, "_");
  return ALLOWED_SITE_PACKAGES_DIST_INFO_PREFIXES.includes(normalizedPkg);
}

export const EXPECTED_XTB_VERSION = "6.4.1";

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

export function verifyTreeMachOArchitectures(rootDir, platformId) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isDirectory()) {
        stack.push(fullPath);
      } else if (
        lstat.isFile() &&
        (readMachOCpuTypes(fullPath).length > 0 ||
          entry.name.endsWith(".dylib") ||
          entry.name.endsWith(".so"))
      ) {
        verifyMachOArchitecture(fullPath, platformId);
      }
    }
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
      } else if (st.isFile()) {
        fs.chmodSync(dir, st.mode | 0o200);
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

function isPrefixBoundaryChar(ch) {
  return (
    ch === undefined ||
    ch === "/" ||
    ch === "\0" ||
    ch === "=" ||
    ch === ":" ||
    ch === ";" ||
    ch === "'" ||
    ch === '"' ||
    ch === "," ||
    ch === ")" ||
    ch === "]" ||
    ch === "}" ||
    ch === ">" ||
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r"
  );
}

export function hasResidualPrefixInString(str, oldPrefix, newPrefix = CANONICAL_LOCKED_PREFIX) {
  if (!oldPrefix || oldPrefix === newPrefix) return false;
  let idx = 0;
  while ((idx = str.indexOf(oldPrefix, idx)) !== -1) {
    if (
      newPrefix &&
      str.startsWith(newPrefix, idx) &&
      isPrefixBoundaryChar(str[idx + newPrefix.length])
    ) {
      idx += newPrefix.length;
      continue;
    }
    const nextCh = str[idx + oldPrefix.length];
    if (isPrefixBoundaryChar(nextCh)) {
      return true;
    }
    idx += oldPrefix.length;
  }
  return false;
}

export function replacePrefixInString(str, oldPrefix, newPrefix = CANONICAL_LOCKED_PREFIX) {
  if (!oldPrefix || oldPrefix === newPrefix) return str;
  let out = "";
  let cursor = 0;
  while (cursor < str.length) {
    const idx = str.indexOf(oldPrefix, cursor);
    if (idx === -1) {
      out += str.slice(cursor);
      break;
    }
    if (
      newPrefix &&
      str.startsWith(newPrefix, idx) &&
      isPrefixBoundaryChar(str[idx + newPrefix.length])
    ) {
      out += str.slice(cursor, idx + newPrefix.length);
      cursor = idx + newPrefix.length;
      continue;
    }
    const nextCh = str[idx + oldPrefix.length];
    if (isPrefixBoundaryChar(nextCh)) {
      out += str.slice(cursor, idx) + newPrefix;
      cursor = idx + oldPrefix.length;
    } else {
      out += str.slice(cursor, idx + oldPrefix.length);
      cursor = idx + oldPrefix.length;
    }
  }
  return out;
}

export function hasResidualPrefixInBuffer(buf, oldPrefix, newPrefix = CANONICAL_LOCKED_PREFIX) {
  if (!oldPrefix || oldPrefix === newPrefix) return false;
  const oldBuf = Buffer.from(oldPrefix, "utf8");
  let pos = 0;
  while ((pos = buf.indexOf(oldBuf, pos)) !== -1) {
    let strStart = pos;
    while (strStart > 0 && buf[strStart - 1] !== 0) strStart -= 1;
    let strEnd = pos;
    while (strEnd < buf.length && buf[strEnd] !== 0) strEnd += 1;
    const origStr = buf.subarray(strStart, strEnd).toString("utf8");
    if (hasResidualPrefixInString(origStr, oldPrefix, newPrefix)) {
      return true;
    }
    pos = Math.max(strEnd, pos + oldBuf.length);
  }
  return false;
}

const DYLIB_AND_RPATH_LC_CMDS = new Set([
  0x0c, // LC_LOAD_DYLIB
  0x0d, // LC_ID_DYLIB
  0x18,
  0x80000018, // LC_LOAD_WEAK_DYLIB
  0x1c,
  0x8000001c, // LC_RPATH
  0x1f,
  0x8000001f, // LC_REEXPORT_DYLIB
  0x20, // LC_LAZY_LOAD_DYLIB
  0x23,
  0x80000023, // LC_LOAD_UPWARD_DYLIB
]);

function parseMachOSliceBounds(buf, sliceOff, sliceEnd, lcSlots, sections, symbolOffsets) {
  if (sliceOff + 32 > sliceEnd || buf.readUInt32LE(sliceOff) !== 0xfeedfacf) {
    return false;
  }
  const ncmds = buf.readUInt32LE(sliceOff + 16);
  const sizeofcmds = buf.readUInt32LE(sliceOff + 20);
  const cmdsEnd = Math.min(sliceEnd, sliceOff + 32 + sizeofcmds);
  const sliceSections = [];
  const symtabs = [];

  let cmdOff = sliceOff + 32;
  for (let i = 0; i < ncmds && cmdOff + 8 <= cmdsEnd; i += 1) {
    const cmd = buf.readUInt32LE(cmdOff);
    const cmdsize = buf.readUInt32LE(cmdOff + 4);
    if (cmdsize < 8 || cmdOff + cmdsize > cmdsEnd) break;

    if (DYLIB_AND_RPATH_LC_CMDS.has(cmd) && cmdsize >= 16) {
      const strOff = buf.readUInt32LE(cmdOff + 8);
      if (strOff >= 12 && strOff < cmdsize) {
        lcSlots.push({ start: cmdOff + strOff, end: cmdOff + cmdsize });
      }
    } else if (cmd === 0x19 && cmdsize >= 72) {
      // LC_SEGMENT_64
      const nsects = buf.readUInt32LE(cmdOff + 64);
      let sectOff = cmdOff + 72;
      for (let s = 0; s < nsects && sectOff + 80 <= cmdOff + cmdsize; s += 1) {
        const sectname = buf
          .subarray(sectOff, sectOff + 16)
          .toString("utf8")
          .replace(/\0.*$/, "");
        const segname = buf
          .subarray(sectOff + 16, sectOff + 32)
          .toString("utf8")
          .replace(/\0.*$/, "");
        const addr = buf.readBigUInt64LE(sectOff + 32);
        const size = Number(buf.readBigUInt64LE(sectOff + 40));
        const fileoff = sliceOff + buf.readUInt32LE(sectOff + 48);
        const flags = buf.readUInt32LE(sectOff + 64);
        const sectRecord = {
          segname,
          sectname,
          addr,
          start: fileoff,
          end: Math.min(sliceEnd, fileoff + size),
          flags,
        };
        sliceSections.push(sectRecord);
        sections.push(sectRecord);
        sectOff += 80;
      }
    } else if (cmd === 0x02 && cmdsize >= 24) {
      // LC_SYMTAB
      const symoff = sliceOff + buf.readUInt32LE(cmdOff + 8);
      const nsyms = buf.readUInt32LE(cmdOff + 12);
      symtabs.push({ symoff, nsyms });
    }
    cmdOff += cmdsize;
  }

  for (const { symoff, nsyms } of symtabs) {
    for (let s = 0; s < nsyms; s += 1) {
      const entryOff = symoff + s * 16;
      if (entryOff + 16 > sliceEnd) break;
      const nType = buf.readUInt8(entryOff + 4);
      const nSect = buf.readUInt8(entryOff + 5);
      const nValue = buf.readBigUInt64LE(entryOff + 8);
      if ((nType & 0x0e) === 0x0e && nSect >= 1 && nSect <= sliceSections.length) {
        const sect = sliceSections[nSect - 1];
        if (nValue >= sect.addr) {
          const rel = Number(nValue - sect.addr);
          if (rel >= 0 && sect.start + rel <= sect.end) {
            symbolOffsets.push(sect.start + rel);
          }
        }
      }
    }
  }
  return true;
}

function parseMachOStructuralBounds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return null;
  const magicLE = buf.readUInt32LE(0);
  const magicBE = buf.readUInt32BE(0);
  const lcSlots = [];
  const sections = [];
  const symbolOffsets = [];

  if (magicLE === 0xfeedfacf) {
    parseMachOSliceBounds(buf, 0, buf.length, lcSlots, sections, symbolOffsets);
    symbolOffsets.sort((a, b) => a - b);
    return { lcSlots, sections, symbolOffsets };
  }
  if (magicBE === 0xcafebabe) {
    const nfat = buf.readUInt32BE(4);
    let anySlice = false;
    for (let i = 0; i < Math.min(nfat, 8); i += 1) {
      const archOff = 8 + i * 20;
      if (archOff + 20 > buf.length) break;
      const sliceOff = buf.readUInt32BE(archOff + 8);
      const sliceSize = buf.readUInt32BE(archOff + 12);
      const sliceEnd = Math.min(buf.length, sliceOff + sliceSize);
      if (parseMachOSliceBounds(buf, sliceOff, sliceEnd, lcSlots, sections, symbolOffsets)) {
        anySlice = true;
      }
    }
    if (anySlice) {
      symbolOffsets.sort((a, b) => a - b);
      return { lcSlots, sections, symbolOffsets };
    }
  }
  return null;
}

export function replaceMachOPrefixSlots(buf, oldPrefixes, newPrefix, filePath = "<buffer>") {
  let modified = false;
  const machOBounds = parseMachOStructuralBounds(buf);

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

      let maxSlotEnd = nulEnd;
      let inLoadCommand = false;
      if (machOBounds) {
        const lc = machOBounds.lcSlots.find((s) => pos >= s.start && strEnd <= s.end);
        if (lc) {
          inLoadCommand = true;
          strStart = Math.max(strStart, lc.start);
          maxSlotEnd = Math.min(nulEnd, lc.end);
        } else {
          const sect = machOBounds.sections.find((s) => pos >= s.start && strEnd <= s.end);
          const isExecutableSection =
            sect && ((sect.flags & 0x80000000) !== 0 || sect.sectname === "__text");
          if (!sect || isExecutableSection) {
            throw new Error(
              `STAGE_RELOCATION_FAILED: Refusing to relocate prefix '${oldPrefix}' outside Mach-O load commands or data/const sections in ${filePath} (offset ${pos})`
            );
          }
          strStart = Math.max(strStart, sect.start);
          maxSlotEnd = Math.min(nulEnd, sect.end);
          for (const symOff of machOBounds.symbolOffsets) {
            if (symOff > strStart && symOff <= pos) {
              strStart = symOff;
            } else if (symOff >= strEnd && symOff < maxSlotEnd) {
              maxSlotEnd = symOff;
              break;
            }
          }
        }
      }

      const origStr = buf.subarray(strStart, strEnd).toString("utf8");
      if (!hasResidualPrefixInString(origStr, oldPrefix, newPrefix)) {
        pos = Math.max(strEnd, pos + oldBuf.length);
        continue;
      }
      const newStr = replacePrefixInString(origStr, oldPrefix, newPrefix);
      const newStrBuf = Buffer.from(newStr, "utf8");
      const origLen = strEnd - strStart;
      const isExpanding = newStrBuf.length > origLen;

      const boundedSlotLen = maxSlotEnd - strStart;
      const boundedNulCount = maxSlotEnd - strEnd;
      if (isExpanding && !inLoadCommand && (boundedSlotLen < 256 || boundedNulCount < 64)) {
        throw new Error(
          `STAGE_RELOCATION_FAILED: Refusing to expand prefix '${oldPrefix}' to '${newPrefix}' in non-placeholder slot (${boundedSlotLen} bytes, ${boundedNulCount} trailing NULs) in ${filePath}`
        );
      }
      if (newStrBuf.length >= boundedSlotLen) {
        throw new Error(
          `STAGE_RELOCATION_FAILED: Mach-O string slot (${boundedSlotLen} bytes) in ${filePath} is too short to relocate prefix '${oldPrefix}' to '${newPrefix}' (${newStrBuf.length + 1} bytes required)`
        );
      }

      const clearEnd = Math.min(maxSlotEnd, Math.max(strEnd, strStart + newStrBuf.length + 1));
      buf.fill(0, strStart, clearEnd);
      newStrBuf.copy(buf, strStart);
      modified = true;
      pos = maxSlotEnd;
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
  const hasMatch = validPrefixes.some((p) => hasResidualPrefixInBuffer(initialBuf, p, newPrefix));
  if (!hasMatch) return;

  const st = fs.lstatSync(filePath);
  fs.chmodSync(filePath, st.mode | 0o200);

  try {
    execFileSync("codesign", ["--remove-signature", filePath], { stdio: "ignore" });
  } catch {
    // ignore if unsigned
  }

  const unsignedBuf = fs.readFileSync(filePath);
  replaceMachOPrefixSlots(unsignedBuf, validPrefixes, newPrefix, filePath);
  for (const p of validPrefixes) {
    if (hasResidualPrefixInBuffer(unsignedBuf, p, newPrefix)) {
      throw new Error(
        `STAGE_RELOCATION_FAILED: Residual prefix '${p}' remained in Mach-O binary ${filePath}`
      );
    }
  }
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
          const hasMatch = validPrefixes.some((p) => hasResidualPrefixInBuffer(buf, p, newPrefix));
          if (hasMatch && !buf.includes(0)) {
            let text = buf.toString("utf8");
            for (const p of validPrefixes) {
              text = replacePrefixInString(text, p, newPrefix);
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

function compareCodepointStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildInventoryFiles(rootDir, contentDirectories = ["python"]) {
  const files = [];
  for (const contentDir of contentDirectories) {
    const absDir = path.join(rootDir, contentDir);
    if (!fs.existsSync(absDir)) continue;
    const stack = [absDir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs
        .readdirSync(current, { withFileTypes: true })
        .sort((a, b) => compareCodepointStrings(a.name, b.name));
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
  files.sort((a, b) => compareCodepointStrings(a.path, b.path));
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
      if (isTop && !isAllowedSitePackagesTopEntry(entry.name)) continue;
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

export function verifyStagedXtbRuntime(
  xtbDir,
  pythonBinPath,
  platformId,
  expectedVersion = EXPECTED_XTB_VERSION
) {
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

  let parsedVersion = expectedVersion || EXPECTED_XTB_VERSION;
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
    const verMatch = /xtb\s+version\s+([0-9]+\.[0-9]+\.[0-9]+)/i.exec(String(out));
    if (!verMatch) {
      throw new Error(`STAGE_XTB_PROBE_FAILED: Unexpected xtb --version output: ${out}`);
    }
    parsedVersion = verMatch[1];
    if (expectedVersion && parsedVersion !== expectedVersion) {
      throw new Error(
        `STAGE_XTB_VERSION_MISMATCH: Expected xtb version ${expectedVersion}, got ${parsedVersion}`
      );
    }
  }
  return parsedVersion;
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
    "import importlib, json, os, pathlib, re, sys",
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
    "versions = {}",
    `for mod_name in ${JSON.stringify(probeModules)}:`,
    "    mod = importlib.import_module(mod_name)",
    "    mod_file = pathlib.Path(getattr(mod, '__file__', '')).resolve()",
    "    if not mod_file.is_relative_to(dep_site):",
    "        raise RuntimeError(f'Module {mod_name} loaded from outside locked site-packages: {mod_file}')",
    "    dist_Candidates = sorted(dep_site.glob(f'{mod_name}-*.dist-info'))",
    "    if not dist_Candidates:",
    "        raise RuntimeError(f'Missing {mod_name}-*.dist-info metadata in locked site-packages: {dep_site}')",
    "    meta_file = dist_Candidates[0] / 'METADATA'",
    "    if not meta_file.is_file():",
    "        raise RuntimeError(f'Missing METADATA file in {dist_Candidates[0]}')",
    "    meta_text = meta_file.read_text(encoding='utf-8', errors='replace')",
    "    ver_match = re.search(r'^Version:\\s*(\\S+)', meta_text, re.M)",
    "    if not ver_match:",
    "        raise RuntimeError(f'Missing Version header in {meta_file}')",
    "    ver = ver_match.group(1)",
    "    if (tc_root / 'python/lib/python3.12/importlib/metadata/__init__.py').is_file():",
    "        import importlib.metadata",
    "        dist = importlib.metadata.distribution(mod_name)",
    "        dist_path = pathlib.Path(dist._path).resolve()",
    "        if not dist_path.is_relative_to(dep_site) or dist.version != ver:",
    "            raise RuntimeError(f'Distribution metadata mismatch for {mod_name}: {dist_path} ({dist.version} vs {ver})')",
    "    loaded[mod_name] = str(mod_file)",
    "    versions[mod_name] = ver",
    "from rdkit import RDConfig",
    "import tblite.interface, tblite.library, rdkit.Chem.AllChem, scipy.linalg, scipy.optimize, scipy.spatial, ase.build",
    "if not callable(getattr(tblite.interface, 'Calculator', None)) or not callable(getattr(tblite.library, 'get_version', None)):",
    "    raise RuntimeError('tblite Calculator or get_version is not callable')",
    "rd_data = pathlib.Path(RDConfig.RDDataDir).resolve()",
    "expected_rd_data = (dep_site / 'rdkit' / 'share' / 'RDKit' / 'Data').resolve()",
    "if rd_data != expected_rd_data or not (rd_data / 'Salts.txt').is_file():",
    "    raise RuntimeError(f'RDKit RDDataDir escaped locked runtime: {rd_data} (expected {expected_rd_data})')",
    "if sys.platform == 'darwin' and (tc_root / 'python/lib/python3.12/ctypes/__init__.py').is_file():",
    "    import ctypes",
    "    libc = ctypes.CDLL(None)",
    "    libc._dyld_image_count.restype = ctypes.c_uint32",
    "    libc._dyld_get_image_name.argtypes = [ctypes.c_uint32]",
    "    libc._dyld_get_image_name.restype = ctypes.c_char_p",
    `    dep_root = pathlib.Path(${JSON.stringify(depAbsRoot)}).resolve()`,
    "    for i in range(libc._dyld_image_count()):",
    "        raw = libc._dyld_get_image_name(i)",
    "        if raw:",
    "            p = raw.decode('utf-8', errors='replace')",
    "            base = os.path.basename(p)",
    "            if base.startswith(('libpython', 'libRDKit', 'libtblite', 'libsymspg')):",
    "                rp = pathlib.Path(p).resolve()",
    "                if not rp.is_relative_to(tc_root) and not rp.is_relative_to(dep_root):",
    "                    raise RuntimeError(f'Native library {base} escaped locked runtime: {rp}')",
    "print(json.dumps({'schema': 'sciyue-import-probe-v1', 'passed': True, 'platform': " +
      JSON.stringify(platformId) +
      ", 'modules': sorted(list(loaded.keys())), 'versions': versions}))",
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

export function acquireStagingLock(appPath) {
  const localDir = path.join(path.resolve(appPath), ".local");
  fs.mkdirSync(localDir, { recursive: true });
  const lockDir = path.join(localDir, ".staging.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  const recoverLockDir = path.join(localDir, ".staging.recover.lock");
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const ownerPayload = JSON.stringify({ pid: process.pid, token, startedAt: Date.now() });

  const createPreparedLockViaRename = () => {
    const tmpDir = path.join(localDir, `.staging-lock-init-${token}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "owner.json"), ownerPayload, "utf8");
    try {
      // On POSIX/APFS, renaming a non-empty directory over an existing non-empty directory atomically fails with ENOTEMPTY/EEXIST,
      // and when lockDir does not exist, lockDir becomes visible with owner.json already inside it in a single atomic rename!
      fs.renameSync(tmpDir, lockDir);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
  };

  const readExistingOwner = () => {
    try {
      const raw = fs.readFileSync(ownerFile, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  };

  try {
    createPreparedLockViaRename();
  } catch (err) {
    if (err && (err.code === "EEXIST" || err.code === "ENOTEMPTY" || err.code === "EACCES")) {
      const existingOwner = readExistingOwner();
      const existingPid = existingOwner && typeof existingOwner.pid === "number" ? existingOwner.pid : null;
      if (existingPid && isProcessAlive(existingPid)) {
        throw new Error(
          `STAGE_CONCURRENT_BUSY: Another staging operation (pid=${existingPid}) is active in ${lockDir}`
        );
      }
      // If ownerFile could not be parsed (e.g. external manual directory without owner.json), treat recent (<5s) dir as busy
      if (!existingOwner) {
        try {
          const st = fs.lstatSync(lockDir);
          if (Date.now() - st.mtimeMs < 5000) {
            throw new Error(
              `STAGE_CONCURRENT_BUSY: Another staging operation is initializing ${lockDir}`
            );
          }
        } catch (statErr) {
          if (statErr && String(statErr.message).includes("STAGE_CONCURRENT_BUSY")) {
            throw statErr;
          }
        }
      }
      // Serialize stale lock cleanup via recoverLockDir so two processes never race to delete a newly acquired lock
      try {
        fs.mkdirSync(recoverLockDir);
      } catch {
        throw new Error(
          `STAGE_CONCURRENT_BUSY: Concurrent stale-lock recovery in progress for ${lockDir}`
        );
      }
      try {
        const recheckedOwner = readExistingOwner();
        const recheckedPid =
          recheckedOwner && typeof recheckedOwner.pid === "number" ? recheckedOwner.pid : null;
        if (recheckedPid && isProcessAlive(recheckedPid)) {
          throw new Error(
            `STAGE_CONCURRENT_BUSY: Another staging operation (pid=${recheckedPid}) acquired ${lockDir}`
          );
        }
        makeDirectoryTreeWritable(lockDir);
        fs.rmSync(lockDir, { recursive: true, force: true });
        createPreparedLockViaRename();
      } finally {
        fs.rmSync(recoverLockDir, { recursive: true, force: true });
      }
    } else {
      throw err;
    }
  }

  return () => {
    try {
      const currentOwner = readExistingOwner();
      if (currentOwner && currentOwner.token === token) {
        makeDirectoryTreeWritable(lockDir);
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  };
}

function verifyDevRuntimeCapabilities(appRootPath, platformId) {
  const enginePyPath = path.join(appRootPath, "desktop", "chemistry", "engine.py");
  const devRuntimePyPath = path.join(appRootPath, "scripts", "native", "dev-runtime.py");
  if (!fs.existsSync(enginePyPath) || !fs.statSync(enginePyPath).isFile()) {
    throw new Error(
      `STAGE_ENGINE_MISSING: Required chemistry engine ${enginePyPath} does not exist`
    );
  }
  if (!fs.existsSync(devRuntimePyPath) || !fs.statSync(devRuntimePyPath).isFile()) {
    throw new Error(
      `STAGE_DEV_RUNTIME_MISSING: Required bootstrap ${devRuntimePyPath} does not exist`
    );
  }

  const selectedNative = developmentNative(appRootPath, { platformId });
  developmentXtb(appRootPath, { platformId });

  if (process.platform === "darwin" && `darwin-${process.arch}` === platformId) {
    const cleanAmbientEnv = { ...process.env };
    delete cleanAmbientEnv.SCIYUE_PYTHON;
    const rtEnv = {
      ...cleanAmbientEnv,
      ...currentRuntimeEnvironment({
        packaged: false,
        appPath: appRootPath,
        executable: selectedNative.executable,
        platformId,
        environment: cleanAmbientEnv,
      }),
    };
    delete rtEnv.SCIYUE_PYTHON;
    for (const [k, v] of Object.entries(rtEnv)) {
      if (v === undefined) delete rtEnv[k];
    }
    let capStdout;
    try {
      capStdout = execFileSync(
        selectedNative.executable,
        ["-I", "-S", "-B", devRuntimePyPath, "--capabilities"],
        {
          cwd: path.dirname(enginePyPath),
          env: rtEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    } catch (err) {
      const stderr = err.stderr ? String(err.stderr).trim() : err.message;
      throw new Error(`STAGE_DEV_RUNTIME_FAILED: dev-runtime.py verification failed: ${stderr}`);
    }
    let capJson;
    try {
      capJson = JSON.parse(String(capStdout).trim());
    } catch {
      throw new Error(
        `STAGE_DEV_RUNTIME_FAILED: Invalid JSON from dev-runtime.py --capabilities: ${capStdout}`
      );
    }
    if (
      !capJson ||
      capJson.schema !== "sciyue-native-capabilities/v1" ||
      capJson.periodicGfn2BondOrders !== true ||
      typeof capJson.tbliteVersion !== "string" ||
      !capJson.tbliteVersion.trim()
    ) {
      throw new Error(
        `STAGE_DEV_RUNTIME_FAILED: dev-runtime.py --capabilities did not report periodicGfn2BondOrders=true and tbliteVersion: ${JSON.stringify(
          capJson
        )}`
      );
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
  expectedXtbVersion = EXPECTED_XTB_VERSION,
  updateLocks = false,
  verifyCommittedLocks = true,
  lockReadOnly = true,
  renameImpl = fs.renameSync,
  rollbackRenameImpl = fs.renameSync,
} = {}) {
  if (platformId !== "darwin-arm64" && platformId !== "darwin-x64") {
    throw new Error(`STAGE_PLATFORM_UNSUPPORTED: Unsupported platformId: ${platformId}`);
  }

  const resolvedAppPath = path.resolve(appPath);
  const releaseLock = acquireStagingLock(resolvedAppPath);
  let txRoot = null;

  try {
    const enginePyPath = path.join(resolvedAppPath, "desktop", "chemistry", "engine.py");
    const devRuntimePyPath = path.join(resolvedAppPath, "scripts", "native", "dev-runtime.py");
    if (!fs.existsSync(enginePyPath) || !fs.statSync(enginePyPath).isFile()) {
      throw new Error(
        `STAGE_ENGINE_MISSING: Required chemistry engine ${enginePyPath} does not exist`
      );
    }
    if (!fs.existsSync(devRuntimePyPath) || !fs.statSync(devRuntimePyPath).isFile()) {
      throw new Error(
        `STAGE_DEV_RUNTIME_MISSING: Required bootstrap ${devRuntimePyPath} does not exist`
      );
    }

    const tcRelRoot = `.local/toolchains/${platformId}/${toolchainLockId}`;
    const depRelRoot = `.local/dependencies/${platformId}/${runtimeLockId}`;
    const prepRelDir = `.local/preparation/${platformId}`;

    const tcAbsRoot = path.join(resolvedAppPath, tcRelRoot);
    const depAbsRoot = path.join(resolvedAppPath, depRelRoot);
    const prepAbsDir = path.join(resolvedAppPath, prepRelDir);
    const packagingAbsDir = path.join(resolvedAppPath, "desktop", "packaging");

    // Stage in an isolated transaction directory mirroring appPath layout so dev-runtime.py --capabilities runs BEFORE swapping appPath
    txRoot = fs.mkdtempSync(path.join(os.tmpdir(), "es-darwin-stage-tx-"));
    const txTcAbsRoot = path.join(txRoot, tcRelRoot);
    const txDepAbsRoot = path.join(txRoot, depRelRoot);
    const txPrepAbsDir = path.join(txRoot, prepRelDir);
    const txPackagingDir = path.join(txRoot, "desktop", "packaging");

    fs.mkdirSync(path.join(txTcAbsRoot, "python"), { recursive: true });
    fs.mkdirSync(path.join(txDepAbsRoot, "python"), { recursive: true });
    fs.mkdirSync(path.join(txDepAbsRoot, "xtb"), { recursive: true });
    fs.mkdirSync(txPrepAbsDir, { recursive: true });
    fs.mkdirSync(txPackagingDir, { recursive: true });

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
    verifyTreeMachOArchitectures(path.join(txTcAbsRoot, "python"), platformId);
    verifyTreeMachOArchitectures(path.join(txDepAbsRoot, "python"), platformId);
    const verifiedXtbVersion = verifyStagedXtbRuntime(
      path.join(txDepAbsRoot, "xtb"),
      txPythonBinPath,
      platformId,
      expectedXtbVersion
    );
    verifyTreeMachOArchitectures(path.join(txDepAbsRoot, "xtb"), platformId);

    const xtbRuntimeDescriptorPath = path.join(txDepAbsRoot, "xtb", "runtime.json");
    const xtbDescriptorPayload = {
      schema: "sciyue-xtb-bundled-runtime/v1",
      version: verifiedXtbVersion,
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
    const lockAndProfilePaths = [tcLockAbs, depLockAbs, xtbLockAbs, profileAbs];
    const existingLockAndProfileCount = lockAndProfilePaths.filter((p) => fs.existsSync(p)).length;
    const nextProfileMeta = sha256Buffer(Buffer.from(profileText, "utf8"));
    if (verifyCommittedLocks && !updateLocks) {
      if (existingLockAndProfileCount < lockAndProfilePaths.length) {
        throw new Error(
          `STAGE_LOCK_DRIFT: Missing committed lock or profile files in ${packagingAbsDir} (found ${existingLockAndProfileCount}/${lockAndProfilePaths.length}; pass updateLocks: true or --update-locks to initialize or update)`
        );
      }
      const committedTcMeta = sha256File(tcLockAbs);
      const committedDepMeta = sha256File(depLockAbs);
      const committedXtbMeta = sha256File(xtbLockAbs);
      const committedProfileMeta = sha256File(profileAbs);

      if (
        committedTcMeta.sha256 !== tcLockMeta.sha256 ||
        committedDepMeta.sha256 !== depLockMeta.sha256 ||
        committedXtbMeta.sha256 !== xtbLockMeta.sha256 ||
        committedProfileMeta.sha256 !== nextProfileMeta.sha256
      ) {
        throw new Error(
          `STAGE_LOCK_DRIFT: Staged inventory or preparation differs from committed locks/profile in ${packagingAbsDir} (pass updateLocks: true or --update-locks to update)`
        );
      }
    }

    // Complete txRoot layout and run full pre-swap verification (developmentNative, developmentXtb, dev-runtime.py --capabilities) BEFORE touching appPath
    fs.writeFileSync(path.join(txTcAbsRoot, "inventory.json"), tcInvText, "utf8");
    fs.writeFileSync(path.join(txDepAbsRoot, "inventory.json"), depInvText, "utf8");
    fs.writeFileSync(path.join(txPrepAbsDir, "import-probe.json"), probeText, "utf8");
    fs.writeFileSync(path.join(txPrepAbsDir, "native-preparation.json"), prepText, "utf8");
    fs.writeFileSync(path.join(txRoot, tcLockRel), tcLockText, "utf8");
    fs.writeFileSync(path.join(txRoot, depLockRel), depLockText, "utf8");
    fs.writeFileSync(path.join(txRoot, xtbLockRel), xtbLockText, "utf8");
    fs.writeFileSync(path.join(txRoot, profileRel), profileText, "utf8");
    copyDirectoryTree(
      path.join(resolvedAppPath, "desktop", "chemistry"),
      path.join(txRoot, "desktop", "chemistry")
    );
    fs.mkdirSync(path.join(txRoot, "scripts", "native"), { recursive: true });
    fs.copyFileSync(devRuntimePyPath, path.join(txRoot, "scripts", "native", "dev-runtime.py"));
    verifyDevRuntimeCapabilities(txRoot, platformId);

    const shouldWriteLocks = updateLocks || !verifyCommittedLocks;

    // Prepare transactional staging siblings in the same parent directories so 0555 directory renames never cross parent inodes,
    // recording original modes of existing parent directories so they are restored on rollback or completion.
    const modifiedParentModes = new Map();
    const ensureDirSelfWritable = (dirPath) => {
      if (!fs.existsSync(dirPath)) return;
      const st = fs.lstatSync(dirPath);
      if ((st.mode & 0o200) === 0) {
        if (!modifiedParentModes.has(dirPath)) {
          modifiedParentModes.set(dirPath, st.mode & 0o777);
        }
        fs.chmodSync(dirPath, st.mode | 0o200);
      }
    };
    const swapId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    fs.mkdirSync(path.dirname(tcAbsRoot), { recursive: true });
    fs.mkdirSync(path.dirname(depAbsRoot), { recursive: true });
    fs.mkdirSync(path.dirname(prepAbsDir), { recursive: true });
    ensureDirSelfWritable(path.dirname(tcAbsRoot));
    ensureDirSelfWritable(path.dirname(depAbsRoot));
    ensureDirSelfWritable(path.dirname(prepAbsDir));

    const nextTcRoot = path.join(path.dirname(tcAbsRoot), `.stage-next-${swapId}-tc`);
    const nextDepRoot = path.join(path.dirname(depAbsRoot), `.stage-next-${swapId}-dep`);
    const nextPrepDir = path.join(path.dirname(prepAbsDir), `.stage-next-${swapId}-prep`);

    const swapPlan = [
      {
        targetPath: tcAbsRoot,
        nextPath: nextTcRoot,
        backupPath: path.join(path.dirname(tcAbsRoot), `.stage-bak-${swapId}-tc`),
      },
      {
        targetPath: depAbsRoot,
        nextPath: nextDepRoot,
        backupPath: path.join(path.dirname(depAbsRoot), `.stage-bak-${swapId}-dep`),
      },
      {
        targetPath: prepAbsDir,
        nextPath: nextPrepDir,
        backupPath: path.join(path.dirname(prepAbsDir), `.stage-bak-${swapId}-prep`),
      },
    ];

    let preserveBackups = false;
    try {
      fs.mkdirSync(nextTcRoot, { recursive: true });
      fs.mkdirSync(nextDepRoot, { recursive: true });
      fs.mkdirSync(nextPrepDir, { recursive: true });

      copyDirectoryTree(path.join(txTcAbsRoot, "python"), path.join(nextTcRoot, "python"));
      copyDirectoryTree(path.join(txDepAbsRoot, "python"), path.join(nextDepRoot, "python"));
      copyDirectoryTree(path.join(txDepAbsRoot, "xtb"), path.join(nextDepRoot, "xtb"));

      fs.writeFileSync(path.join(nextTcRoot, "inventory.json"), tcInvText, "utf8");
      fs.writeFileSync(path.join(nextDepRoot, "inventory.json"), depInvText, "utf8");
      fs.writeFileSync(path.join(nextPrepDir, "import-probe.json"), probeText, "utf8");
      fs.writeFileSync(path.join(nextPrepDir, "native-preparation.json"), prepText, "utf8");

      if (lockReadOnly) {
        lockDirectoryTreeReadOnly(nextTcRoot);
        lockDirectoryTreeReadOnly(nextDepRoot);
        lockDirectoryTreeReadOnly(nextPrepDir);
        verifyTreeReadOnly(nextTcRoot);
        verifyTreeReadOnly(nextDepRoot);
        verifyTreeReadOnly(nextPrepDir);
      }

      if (shouldWriteLocks) {
        fs.mkdirSync(packagingAbsDir, { recursive: true });
        ensureDirSelfWritable(packagingAbsDir);
        const lockEntries = [
          { targetPath: tcLockAbs, text: tcLockText, tag: "tc-lock" },
          { targetPath: depLockAbs, text: depLockText, tag: "dep-lock" },
          { targetPath: xtbLockAbs, text: xtbLockText, tag: "xtb-lock" },
          { targetPath: profileAbs, text: profileText, tag: "profile" },
        ];
        for (const le of lockEntries) {
          const nextFile = path.join(packagingAbsDir, `.stage-next-${swapId}-${le.tag}`);
          const bakFile = path.join(packagingAbsDir, `.stage-bak-${swapId}-${le.tag}`);
          fs.writeFileSync(nextFile, le.text, "utf8");
          swapPlan.push({
            targetPath: le.targetPath,
            nextPath: nextFile,
            backupPath: bakFile,
          });
        }
      }

      const appliedSwaps = [];
      try {
        for (const item of swapPlan) {
          const parentDir = path.dirname(item.targetPath);
          fs.mkdirSync(parentDir, { recursive: true });
          ensureDirSelfWritable(parentDir);
          const existed = fs.existsSync(item.targetPath);
          const swapRecord = { ...item, existed, backedUp: false, installed: false };
          appliedSwaps.push(swapRecord);
          if (existed) {
            renameImpl(item.targetPath, item.backupPath);
            swapRecord.backedUp = true;
          }
          renameImpl(item.nextPath, item.targetPath);
          swapRecord.installed = true;
        }

        // Warm up final committed Mach-O inodes and verify committed checkout admission
        runImportProbe({
          pythonExecutable: path.join(tcAbsRoot, "python", "bin", "python3"),
          tcAbsRoot,
          depAbsRoot,
          platformId,
          probeModules: REQUIRED_SCIENTIFIC_MODULES,
        });
        verifyDevRuntimeCapabilities(resolvedAppPath, platformId);
      } catch (commitErr) {
        const rollbackErrors = [];
        for (let i = appliedSwaps.length - 1; i >= 0; i -= 1) {
          const item = appliedSwaps[i];
          try {
            const parentDir = path.dirname(item.targetPath);
            if (fs.existsSync(parentDir)) {
              ensureDirSelfWritable(parentDir);
            }
            if (item.installed || item.backedUp) {
              if (fs.existsSync(item.targetPath)) {
                makeDirectoryTreeWritable(item.targetPath);
                fs.rmSync(item.targetPath, { recursive: true, force: true });
              }
              if (item.existed && item.backedUp && fs.existsSync(item.backupPath)) {
                rollbackRenameImpl(item.backupPath, item.targetPath);
              }
            }
          } catch (rbErr) {
            preserveBackups = true;
            rollbackErrors.push(`${item.targetPath} (backup at ${item.backupPath}): ${rbErr.message}`);
          }
        }
        if (preserveBackups) {
          throw new Error(
            `${commitErr.message} (STAGE_ROLLBACK_INCOMPLETE: Backups preserved: ${rollbackErrors.join(
              "; "
            )})`
          );
        }
        throw commitErr;
      }
    } finally {
      if (!preserveBackups) {
        for (const item of swapPlan) {
          for (const tempPath of [item.nextPath, item.backupPath]) {
            if (fs.existsSync(tempPath)) {
              makeDirectoryTreeWritable(tempPath);
              fs.rmSync(tempPath, { recursive: true, force: true });
            }
          }
        }
      }
      for (const [dirPath, origMode] of modifiedParentModes.entries()) {
        try {
          if (fs.existsSync(dirPath)) {
            fs.chmodSync(dirPath, origMode);
          }
        } catch {
          // ignore
        }
      }
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
    if (txRoot) {
      try {
        makeDirectoryTreeWritable(txRoot);
        fs.rmSync(txRoot, { recursive: true, force: true });
      } catch {
        // ignore cleanup error so lock is always released
      }
    }
    releaseLock();
  }
}

export function ensureDarwinRuntimeReady({
  appPath = DEFAULT_APP_PATH,
  platformId = `darwin-${process.arch}`,
  condaPrefix = null,
  waitTimeoutMs = 180000,
} = {}) {
  const resolvedAppPath = path.resolve(appPath);
  const lockDir = path.join(resolvedAppPath, ".local", ".staging.lock");
  const isReady = () => {
    if (fs.existsSync(lockDir)) return false;
    try {
      developmentNative(resolvedAppPath, { platformId });
      developmentXtb(resolvedAppPath, { platformId });
      return true;
    } catch {
      return false;
    }
  };
  if (isReady()) return;

  const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  const deadline = Date.now() + waitTimeoutMs;
  while (true) {
    if (isReady()) return;
    try {
      const resolvedPrefix = condaPrefix || resolveDefaultCondaPrefix();
      if (!resolvedPrefix) {
        throw new Error(
          `STAGE_SOURCE_MISSING: Cannot stage ${resolvedAppPath} because no Conda environment was found`
        );
      }
      stageDarwinRuntime({
        appPath: resolvedAppPath,
        platformId,
        condaPrefix: resolvedPrefix,
      });
      return;
    } catch (err) {
      if (err && String(err.message).includes("STAGE_CONCURRENT_BUSY") && Date.now() < deadline) {
        sleepSync(200);
        continue;
      }
      throw err;
    }
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
