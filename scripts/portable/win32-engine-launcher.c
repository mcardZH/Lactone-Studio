#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stdlib.h>
#include <stdio.h>

#define MAX_CMD_CHARS 65536
#define MAX_PATH_CHARS 32768

static int append_char(wchar_t *buf, size_t cap, size_t *len, wchar_t ch) {
  if (*len + 1 >= cap) return 0;
  buf[(*len)++] = ch;
  buf[*len] = 0;
  return 1;
}

static int append_str(wchar_t *buf, size_t cap, size_t *len, const wchar_t *str) {
  while (*str) {
    if (!append_char(buf, cap, len, *str++)) return 0;
  }
  return 1;
}

static int append_quoted(wchar_t *buf, size_t cap, size_t *len, const wchar_t *arg) {
  size_t slashes = 0, i;
  if (!append_char(buf, cap, len, L'"')) return 0;
  for (;;) {
    wchar_t c = *arg++;
    if (c == L'\\') {
      slashes++;
      continue;
    }
    for (i = 0; i < slashes * ((c == L'"' || c == 0) ? 2 : 1); i++) {
      if (!append_char(buf, cap, len, L'\\')) return 0;
    }
    slashes = 0;
    if (c == 0) return append_char(buf, cap, len, L'"');
    if (c == L'"' && !append_char(buf, cap, len, L'\\')) return 0;
    if (!append_char(buf, cap, len, c)) return 0;
  }
}

static int is_regular_file(const wchar_t *file_path) {
  DWORD attrs = GetFileAttributesW(file_path);
  if (attrs == INVALID_FILE_ATTRIBUTES) return 0;
  if (attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
  return 1;
}

static void scrub_ambient_python_env(void) {
  static const wchar_t *unset_keys[] = {
    L"PYTHONPATH",
    L"PYTHONHOME",
    L"PYTHONSTARTUP",
    L"PYTHONUSERBASE",
    L"VIRTUAL_ENV",
    L"CONDA_PREFIX",
    L"CONDA_DEFAULT_ENV",
    L"_PYTHON_SYSCONFIGDATA_NAME",
    L"RDBASE",
    NULL
  };
  int i;
  for (i = 0; unset_keys[i] != NULL; i++) {
    SetEnvironmentVariableW(unset_keys[i], NULL);
  }
  SetEnvironmentVariableW(L"PYTHONNOUSERSITE", L"1");
  SetEnvironmentVariableW(L"PYTHONDONTWRITEBYTECODE", L"1");
  SetEnvironmentVariableW(L"PYTHONUTF8", L"1");
}

static int configure_dll_search_path(const wchar_t *root_dir) {
  size_t existing_len = GetEnvironmentVariableW(L"PATH", NULL, 0);
  size_t cap = MAX_PATH_CHARS * 2 + existing_len + 64;
  wchar_t *new_path = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, cap * sizeof(wchar_t));
  size_t len = 0;
  if (!new_path) return 0;

  if (!append_str(new_path, cap, &len, root_dir) ||
      !append_str(new_path, cap, &len, L"\\deps\\Library\\bin;") ||
      !append_str(new_path, cap, &len, root_dir) ||
      !append_str(new_path, cap, &len, L"\\python\\Library\\bin;") ||
      !append_str(new_path, cap, &len, root_dir) ||
      !append_str(new_path, cap, &len, L"\\python\\DLLs;") ||
      !append_str(new_path, cap, &len, root_dir) ||
      !append_str(new_path, cap, &len, L"\\python")) {
    HeapFree(GetProcessHeap(), 0, new_path);
    return 0;
  }

  if (existing_len > 0) {
    if (!append_char(new_path, cap, &len, L';')) {
      HeapFree(GetProcessHeap(), 0, new_path);
      return 0;
    }
    GetEnvironmentVariableW(L"PATH", new_path + len, (DWORD)(cap - len));
  }

  SetEnvironmentVariableW(L"PATH", new_path);
  HeapFree(GetProcessHeap(), 0, new_path);
  return 1;
}

int main(void) {
  wchar_t *root_dir = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, MAX_PATH_CHARS * sizeof(wchar_t));
  wchar_t *python_exe = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, MAX_PATH_CHARS * sizeof(wchar_t));
  wchar_t *bootstrap_py = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, MAX_PATH_CHARS * sizeof(wchar_t));
  wchar_t *cmd_line = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, MAX_CMD_CHARS * sizeof(wchar_t));
  wchar_t *slash;
  wchar_t **argv = NULL;
  int argc = 0, i;
  size_t len = 0;
  DWORD mod_len, exit_code = 1;
  HANDLE job = NULL;
  STARTUPINFOW si;
  PROCESS_INFORMATION pi;

  if (!root_dir || !python_exe || !bootstrap_py || !cmd_line) return 2;

  mod_len = GetModuleFileNameW(NULL, root_dir, MAX_PATH_CHARS);
  if (!mod_len || mod_len >= MAX_PATH_CHARS || !(slash = wcsrchr(root_dir, L'\\'))) {
    fwprintf(stderr, L"ENGINE_LAUNCHER_ERROR: Unable to resolve launcher directory.\n");
    return 2;
  }
  *slash = 0;

  len = 0;
  if (!append_str(python_exe, MAX_PATH_CHARS, &len, root_dir) ||
      !append_str(python_exe, MAX_PATH_CHARS, &len, L"\\python\\python.exe") ||
      !is_regular_file(python_exe)) {
    fwprintf(stderr, L"BUNDLED_RUNTIME_MISSING: Missing bundled python\\python.exe.\n");
    return 3;
  }

  len = 0;
  if (!append_str(bootstrap_py, MAX_PATH_CHARS, &len, root_dir) ||
      !append_str(bootstrap_py, MAX_PATH_CHARS, &len, L"\\bootstrap.py") ||
      !is_regular_file(bootstrap_py)) {
    fwprintf(stderr, L"BUNDLED_RUNTIME_MISSING: Missing bundled bootstrap.py.\n");
    return 3;
  }

  scrub_ambient_python_env();
  if (!configure_dll_search_path(root_dir)) return 2;

  argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return 2;

  len = 0;
  if (!append_quoted(cmd_line, MAX_CMD_CHARS, &len, python_exe) ||
      !append_str(cmd_line, MAX_CMD_CHARS, &len, L" -I -S -B ") ||
      !append_quoted(cmd_line, MAX_CMD_CHARS, &len, bootstrap_py)) {
    LocalFree(argv);
    return 2;
  }
  for (i = 1; i < argc; i++) {
    if (!append_char(cmd_line, MAX_CMD_CHARS, &len, L' ') ||
        !append_quoted(cmd_line, MAX_CMD_CHARS, &len, argv[i])) {
      LocalFree(argv);
      return 2;
    }
  }
  LocalFree(argv);

  job = CreateJobObjectW(NULL, NULL);
  if (job != NULL) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
    ZeroMemory(&jeli, sizeof(jeli));
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
      CloseHandle(job);
      job = NULL;
    }
  }

  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  ZeroMemory(&pi, sizeof(pi));

  if (!CreateProcessW(
        python_exe,
        cmd_line,
        NULL,
        NULL,
        TRUE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED,
        NULL,
        root_dir,
        &si,
        &pi)) {
    fwprintf(stderr, L"ENGINE_LAUNCHER_ERROR: CreateProcessW failed (%lu).\n", GetLastError());
    if (job != NULL) CloseHandle(job);
    return 4;
  }

  if (job != NULL) {
    AssignProcessToJobObject(job, pi.hProcess);
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);

  if (WaitForSingleObject(pi.hProcess, INFINITE) == WAIT_OBJECT_0) {
    GetExitCodeProcess(pi.hProcess, &exit_code);
  }
  CloseHandle(pi.hProcess);
  if (job != NULL) CloseHandle(job);
  return (int)exit_code;
}
