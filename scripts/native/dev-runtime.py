#!/usr/bin/env python3
"""Isolated development runtime bootstrap for Ester Studio scientific engine.

Loads packages strictly from the project's locked dependency root (.local/dependencies/...)
and prevents fallback to ambient system/user/conda site-packages.
"""
from __future__ import annotations

import json
import os
import pkgutil
import runpy
import sys
from pathlib import Path

sys.dont_write_bytecode = True

for _env_key in list(os.environ.keys()):
    if _env_key.upper().startswith("_PYTHON_"):
        os.environ.pop(_env_key, None)

PLATFORM_LAYOUTS = {
    "win32-x64": {
        "dependencies_parent": ".local/dependencies/win-x64",
        "toolchains_parent": ".local/toolchains/win-x64",
        "python_entries": ("python/python.exe",),
    },
    "darwin-arm64": {
        "dependencies_parent": ".local/dependencies/darwin-arm64",
        "toolchains_parent": ".local/toolchains/darwin-arm64",
        "python_entries": ("python/bin/python3", "python/bin/python"),
    },
    "darwin-x64": {
        "dependencies_parent": ".local/dependencies/darwin-x64",
        "toolchains_parent": ".local/toolchains/darwin-x64",
        "python_entries": ("python/bin/python3", "python/bin/python"),
    },
}


def _map_macho_cputype(cputype: int) -> str:
    if cputype == 0x0100000C:
        return "arm64"
    if cputype == 0x01000007:
        return "x86_64"
    raise RuntimeError(f"DEV_RUNTIME_PLATFORM_UNSUPPORTED: Unsupported Mach-O cputype {cputype:#x}.")


def _probe_active_darwin_process_arch() -> str | None:
    """Query the in-memory Mach-O header of the active process image via libSystem."""
    try:
        import ctypes

        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        libc._dyld_get_image_header.restype = ctypes.c_void_p
        libc._dyld_get_image_header.argtypes = [ctypes.c_uint32]
        hdr_ptr = libc._dyld_get_image_header(0)
        if not hdr_ptr:
            return None
        words = (ctypes.c_uint32 * 2).from_address(hdr_ptr)
        magic = int(words[0])
        cputype = int(words[1])
        if magic == 0xFEEDFACF:
            return _map_macho_cputype(cputype)
        if magic == 0xCFFAEDFE:
            swapped = int.from_bytes(cputype.to_bytes(4, "little"), "big")
            return _map_macho_cputype(swapped)
    except Exception:
        return None
    return None


def _infer_darwin_arch_without_uname(
    executable_path: str | Path | None = None, *, allow_process_probe: bool = True
) -> str:
    """Read Mach-O cputype of executable without calling os.uname() or sysconfig."""
    target = Path(executable_path) if executable_path is not None else Path(sys.executable)
    try:
        with open(target, "rb") as f:
            header = f.read(512)
    except OSError as exc:
        raise RuntimeError(
            f"DEV_RUNTIME_PLATFORM_UNSUPPORTED: Unable to read executable '{target}'."
        ) from exc

    if len(header) < 8:
        raise RuntimeError(
            f"DEV_RUNTIME_PLATFORM_UNSUPPORTED: Unable to determine Darwin architecture from '{target}'."
        )

    magic_be = int.from_bytes(header[:4], "big")
    magic_le = int.from_bytes(header[:4], "little")

    if magic_le == 0xFEEDFACF:
        return _map_macho_cputype(int.from_bytes(header[4:8], "little"))
    if magic_be == 0xFEEDFACF:
        return _map_macho_cputype(int.from_bytes(header[4:8], "big"))

    if magic_be in (0xCAFEBABE, 0xCAFEBABF) or magic_le in (0xCAFEBABE, 0xCAFEBABF):
        is_be = magic_be in (0xCAFEBABE, 0xCAFEBABF)
        endian = "big" if is_be else "little"
        is_64 = (magic_be if is_be else magic_le) == 0xCAFEBABF
        stride = 24 if is_64 else 20
        nfat = int.from_bytes(header[4:8], endian)
        if nfat <= 0 or nfat > 16 or len(header) < 8 + nfat * stride:
            raise RuntimeError(
                f"DEV_RUNTIME_PLATFORM_UNSUPPORTED: Invalid fat Mach-O header in '{target}'."
            )
        slice_archs: list[str] = []
        for idx in range(nfat):
            offset = 8 + idx * stride
            cputype = int.from_bytes(header[offset : offset + 4], endian)
            arch = _map_macho_cputype(cputype)
            if arch not in slice_archs:
                slice_archs.append(arch)
        if len(slice_archs) == 1:
            return slice_archs[0]
        if allow_process_probe:
            active_arch = _probe_active_darwin_process_arch()
            if active_arch in slice_archs:
                return active_arch
        raise RuntimeError(
            f"DEV_RUNTIME_PLATFORM_UNSUPPORTED: Ambiguous multi-architecture Mach-O binary '{target}'."
        )

    raise RuntimeError(
        f"DEV_RUNTIME_PLATFORM_UNSUPPORTED: Unable to determine Darwin architecture from '{target}'."
    )


def detect_host_platform() -> str:
    plat = sys.platform
    if plat == "win32":
        return "win32-x64"
    if plat == "darwin":
        machine = ""
        if hasattr(os, "uname"):
            try:
                machine = getattr(os.uname(), "machine", "").lower()
            except PermissionError:
                machine = _infer_darwin_arch_without_uname().lower()
        if not machine:
            machine = _infer_darwin_arch_without_uname().lower()
        if machine in ("arm64", "aarch64"):
            return "darwin-arm64"
        if machine in ("x86_64", "amd64"):
            return "darwin-x64"
        raise RuntimeError(f"DEV_RUNTIME_PLATFORM_UNSUPPORTED: Unsupported Darwin machine '{machine}'.")
    return f"{plat}-x64"


def resolve_app_path() -> Path:
    script_app = Path(__file__).resolve().parents[2]
    env_app = os.environ.get("SCIYUE_APP_PATH")
    if env_app:
        candidate = Path(env_app).resolve()
        if candidate != script_app:
            raise RuntimeError(
                f"DEV_RUNTIME_APP_PATH_MISMATCH: SCIYUE_APP_PATH ({candidate}) does not match script root ({script_app})."
            )
    return script_app


def _admitted_path(app_path: Path, relative: str, directory: bool = False) -> Path:
    if (
        not isinstance(relative, str)
        or not relative
        or "\\" in relative
        or "\0" in relative
        or relative.startswith("/")
    ):
        raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Invalid relative path '{relative}'.")
    parts = relative.split("/")
    if any(not p or p in (".", "..") for p in parts):
        raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Invalid path segments in '{relative}'.")

    app_resolved = Path(os.path.abspath(app_path))
    if app_resolved.is_symlink() or getattr(app_resolved, "is_junction", lambda: False)():
        raise RuntimeError("DEV_RUNTIME_LOCK_INVALID: Linked project root is not admitted.")

    cursor = app_resolved
    for part in parts:
        cursor = cursor / part
        if cursor.is_symlink() or getattr(cursor, "is_junction", lambda: False)():
            raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Symlinked runtime input is not admitted: {cursor}")
        if not cursor.exists():
            raise RuntimeError(f"DEV_RUNTIME_ROOT_MISSING: Admitted path does not exist: {cursor}")

    if directory and not cursor.is_dir():
        raise RuntimeError(f"DEV_RUNTIME_ROOT_MISSING: Expected directory at {cursor}")
    if not directory:
        if not cursor.is_file():
            raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Expected ordinary file at {cursor}")
        st = os.lstat(cursor)
        if getattr(st, "st_nlink", 1) != 1:
            raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Hardlinked runtime input is not admitted: {cursor}")
    return cursor.resolve()


def _valid_lock_rel(kind: str, host_platform: str, actual_rel: object) -> bool:
    return actual_rel in (
        f"desktop/packaging/{kind}.lock.json",
        f"desktop/packaging/{kind}.{host_platform}.lock.json",
    )


def _validate_content_root_rel(root_rel: object, expected_parent: str) -> str:
    if not isinstance(root_rel, str) or not root_rel.startswith(expected_parent + "/"):
        raise RuntimeError(
            f"DEV_RUNTIME_LOCK_INVALID: Root '{root_rel}' must be directly under '{expected_parent}/'."
        )
    parts = root_rel.split("/")
    parent_parts = expected_parent.split("/")
    if len(parts) != len(parent_parts) + 1 or any(not p or p in (".", "..") for p in parts):
        raise RuntimeError(
            f"DEV_RUNTIME_LOCK_INVALID: Content-specific runtime root required under '{expected_parent}/', got '{root_rel}'."
        )
    return root_rel


def _admitted_optional_subdir(base_root: Path, rel_posix: str, *, allow_zip_file: bool = False) -> Path | None:
    if (
        not isinstance(rel_posix, str)
        or not rel_posix
        or "\\" in rel_posix
        or "\0" in rel_posix
        or rel_posix.startswith("/")
    ):
        raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Invalid relative path '{rel_posix}'.")
    parts = rel_posix.split("/")
    if any(not p or p in (".", "..") for p in parts):
        raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Invalid path segments in '{rel_posix}'.")

    root_resolved = Path(os.path.abspath(base_root))
    if root_resolved.is_symlink() or getattr(root_resolved, "is_junction", lambda: False)():
        raise RuntimeError("DEV_RUNTIME_LOCK_INVALID: Linked runtime root is not admitted.")

    cursor = root_resolved
    for part in parts:
        cursor = cursor / part
        if cursor.is_symlink() or getattr(cursor, "is_junction", lambda: False)():
            raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Symlinked runtime input is not admitted: {cursor}")
        if not cursor.exists():
            return None

    if cursor.is_dir():
        pass
    elif allow_zip_file and cursor.is_file() and cursor.suffix.lower() == ".zip":
        st = os.lstat(cursor)
        if getattr(st, "st_nlink", 1) != 1:
            raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Hardlinked runtime input is not admitted: {cursor}")
    else:
        raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Expected directory at {cursor}")

    resolved = cursor.resolve()
    if not resolved.is_relative_to(root_resolved.resolve()):
        raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Runtime path escaped root: {resolved}")
    return resolved


def _require_content_dirs(lock_doc: dict, label: str) -> list[str]:
    dirs = lock_doc.get("contentDirectories")
    if not isinstance(dirs, list) or len(dirs) == 0:
        raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Explicit non-empty contentDirectories required in {label} lock.")
    result: list[str] = []
    for d in dirs:
        if not isinstance(d, str) or not d:
            raise RuntimeError(f"DEV_RUNTIME_LOCK_INVALID: Invalid contentDirectories entry in {label} lock.")
        result.append(d)
    return result


def load_active_profile(app_path: Path, host_platform: str) -> dict:
    _admitted_path(app_path, "desktop/packaging", directory=True)
    default_rel = "desktop/packaging/native-profile.json"
    platform_rel = f"desktop/packaging/native-profile.{host_platform}.json"

    platform_candidate = app_path / platform_rel
    chosen_rel = platform_rel if os.path.lexists(platform_candidate) else default_rel
    if not os.path.lexists(app_path / chosen_rel):
        raise RuntimeError(
            f"DEV_RUNTIME_PROFILE_MISSING: No valid native-profile for platform {host_platform}."
        )
    admitted_file = _admitted_path(app_path, chosen_rel, directory=False)
    profile = json.loads(admitted_file.read_text(encoding="utf-8"))
    if (
        isinstance(profile, dict)
        and profile.get("schema") == "sciyue-native-profile-v1"
        and profile.get("platform") == host_platform
    ):
        return profile

    raise RuntimeError(
        f"DEV_RUNTIME_PROFILE_MISSING: No valid native-profile for platform {host_platform}."
    )


def configure_isolated_paths(app_path: Path) -> tuple[Path, Path]:
    host_platform = detect_host_platform()
    if host_platform not in PLATFORM_LAYOUTS:
        raise RuntimeError(f"DEV_RUNTIME_PLATFORM_UNSUPPORTED: Unsupported platform '{host_platform}'.")
    layout = PLATFORM_LAYOUTS[host_platform]

    profile = load_active_profile(app_path, host_platform)
    runtime_lock_rel = profile.get("runtimeLock")
    toolchain_lock_rel = profile.get("toolchainLock")
    if not _valid_lock_rel("native-runtime", host_platform, runtime_lock_rel) or not _valid_lock_rel(
        "native-toolchain", host_platform, toolchain_lock_rel
    ):
        raise RuntimeError("DEV_RUNTIME_LOCK_INVALID: Invalid lock file paths in profile.")

    runtime_lock_path = _admitted_path(app_path, str(runtime_lock_rel), directory=False)
    toolchain_lock_path = _admitted_path(app_path, str(toolchain_lock_rel), directory=False)

    runtime_lock = json.loads(runtime_lock_path.read_text(encoding="utf-8"))
    toolchain_lock = json.loads(toolchain_lock_path.read_text(encoding="utf-8"))
    if (
        runtime_lock.get("schema") != "sciyue-native-runtime-lock-v1"
        or runtime_lock.get("platform") != host_platform
        or toolchain_lock.get("schema") != "sciyue-native-toolchain-lock-v1"
        or toolchain_lock.get("platform") != host_platform
    ):
        raise RuntimeError("DEV_RUNTIME_LOCK_INVALID: Lock schema or platform mismatch.")

    dep_root_rel = _validate_content_root_rel(runtime_lock.get("root"), layout["dependencies_parent"])
    tc_root_rel = _validate_content_root_rel(toolchain_lock.get("root"), layout["toolchains_parent"])

    dep_root = _admitted_path(app_path, dep_root_rel, directory=True)
    tc_root = _admitted_path(app_path, tc_root_rel, directory=True)

    locked_python_rel = toolchain_lock.get("python")
    if not isinstance(locked_python_rel, str) or locked_python_rel not in layout["python_entries"]:
        raise RuntimeError(
            f"DEV_RUNTIME_LOCK_INVALID: Invalid python entry '{locked_python_rel}' for platform {host_platform}."
        )

    expected_python = _admitted_path(app_path, f"{tc_root_rel}/{locked_python_rel}", directory=False)
    exe_resolved = Path(sys.executable).resolve()
    prefix_resolved = Path(sys.prefix).resolve()
    base_prefix_resolved = Path(sys.base_prefix).resolve()

    if (
        exe_resolved != expected_python
        or not exe_resolved.is_relative_to(tc_root)
        or not prefix_resolved.is_relative_to(tc_root)
        or not base_prefix_resolved.is_relative_to(tc_root)
    ):
        raise RuntimeError(
            "DEV_RUNTIME_PREFIX_ESCAPED: Interpreter executable or prefix is outside locked toolchain "
            f"(executable={exe_resolved}, expected={expected_python}, prefix={prefix_resolved}, "
            f"base_prefix={base_prefix_resolved}, tc_root={tc_root})."
        )

    tc_content_dirs = _require_content_dirs(toolchain_lock, "toolchain")
    allowed_tc_roots: list[Path] = []
    for d in tc_content_dirs:
        admitted_tc_dir = _admitted_path(tc_root, d, directory=True)
        if not admitted_tc_dir.is_relative_to(tc_root):
            raise RuntimeError("DEV_RUNTIME_LOCK_INVALID: Toolchain contentDirectory escaped toolchain root.")
        allowed_tc_roots.append(admitted_tc_dir)

    cleaned_sys_path: list[str] = []
    for entry in sys.path:
        if not entry:
            continue
        try:
            resolved = Path(entry).resolve()
        except Exception:
            continue
        if not resolved.is_relative_to(tc_root):
            continue
        if not any(resolved.is_relative_to(allowed_tc) for allowed_tc in allowed_tc_roots):
            continue
        rel_to_tc = resolved.relative_to(tc_root)
        lower_rel_parts = [p.lower() for p in rel_to_tc.parts]
        if "site-packages" in lower_rel_parts or "dist-packages" in lower_rel_parts:
            continue
        if rel_to_tc.parts:
            try:
                verified_tc_entry = _admitted_optional_subdir(
                    tc_root, rel_to_tc.as_posix(), allow_zip_file=True
                )
            except RuntimeError:
                continue
            if verified_tc_entry is None:
                continue
            cleaned_sys_path.append(str(verified_tc_entry))

    sys.path[:] = cleaned_sys_path

    dep_content_dirs = _require_content_dirs(runtime_lock, "runtime")
    allowed_dep_roots: list[Path] = []
    for d in dep_content_dirs:
        admitted_dep_dir = _admitted_path(dep_root, d, directory=True)
        if not admitted_dep_dir.is_relative_to(dep_root):
            raise RuntimeError("DEV_RUNTIME_LOCK_INVALID: Runtime contentDirectory escaped dependency root.")
        allowed_dep_roots.append(admitted_dep_dir)

    py_ver = f"python{sys.version_info.major}.{sys.version_info.minor}"
    candidate_site_rels = [
        f"python/lib/{py_ver}/site-packages",
        "python/Lib/site-packages",
    ]

    added_dirs: list[str] = []
    for rel_candidate in candidate_site_rels:
        resolved_candidate = _admitted_optional_subdir(dep_root, rel_candidate)
        if resolved_candidate is not None:
            if any(resolved_candidate.is_relative_to(allowed_dep) for allowed_dep in allowed_dep_roots):
                added_dirs.append(str(resolved_candidate))

    chemistry_dir = _admitted_path(app_path, "desktop/chemistry", directory=True)
    reordered = [str(chemistry_dir)]
    for d in added_dirs:
        if d not in reordered:
            reordered.append(d)
    for existing in sys.path:
        if existing not in reordered:
            reordered.append(existing)
    sys.path[:] = reordered

    if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
        dll_handles = []
        for base_dir, rel_dll, allowed_roots in (
            (dep_root, "python/Library/bin", allowed_dep_roots),
            (tc_root, "python", allowed_tc_roots),
            (tc_root, "python/DLLs", allowed_tc_roots),
        ):
            resolved_dll = _admitted_optional_subdir(base_dir, rel_dll)
            if resolved_dll is not None and any(
                resolved_dll.is_relative_to(allowed) for allowed in allowed_roots
            ):
                dll_handles.append(os.add_dll_directory(str(resolved_dll)))
        sys._sciyue_dll_handles = dll_handles  # type: ignore[attr-defined]

    for env_key in list(os.environ.keys()):
        if env_key.upper() == "RDBASE":
            os.environ.pop(env_key, None)

    os.environ["SCIYUE_LOCKED_DEPENDENCY_ROOT"] = str(dep_root)
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    return chemistry_dir, dep_root


def main() -> None:
    app_path = resolve_app_path()
    chemistry_dir, _ = configure_isolated_paths(app_path)
    engine_py = _admitted_path(app_path, "desktop/chemistry/engine.py", directory=False)
    sys.argv = [str(engine_py), *sys.argv[1:]]
    runpy.run_path(str(engine_py), run_name="__main__")


if __name__ == "__main__":
    main()
