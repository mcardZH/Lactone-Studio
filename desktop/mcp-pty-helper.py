#!/usr/bin/env python3
"""Lightweight pure-stdlib PTY supervisor for Electron AgentTerminal (macOS/Linux)."""

import base64
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def set_winsize(fd: int, rows: int, cols: int) -> None:
    cols = max(1, min(32767, int(cols)))
    rows = max(1, min(32767, int(rows)))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def signal_child_group(pid: int, sig: int, master_fd=None) -> None:
    targets = set()
    if master_fd is not None:
        try:
            fg_pgid = os.tcgetpgrp(master_fd)
            if fg_pgid > 0:
                targets.add(fg_pgid)
        except Exception:
            pass
    try:
        pgid = os.getpgid(pid)
        if pgid > 0:
            targets.add(pgid)
    except ProcessLookupError:
        pass
    except Exception:
        pass

    if not targets:
        try:
            os.kill(pid, sig)
        except Exception:
            pass
        return

    for pgid in targets:
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
        except Exception:
            pass


def decode_wait_status(status: int):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status), None
    if os.WIFSIGNALED(status):
        return None, os.WTERMSIG(status)
    return 0, None


def main() -> int:
    if len(sys.argv) < 4:
        emit("F:invalid-pty-helper-arguments")
        return 1

    try:
        cols = int(sys.argv[1])
        rows = int(sys.argv[2])
    except ValueError:
        emit("F:invalid-terminal-dimensions")
        return 1

    cmd = sys.argv[3:]
    master_fd, slave_fd = pty.openpty()
    try:
        set_winsize(slave_fd, rows, cols)
    except Exception:
        pass

    pid = os.fork()
    if pid == 0:
        os.close(master_fd)
        try:
            os.setsid()
            try:
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            except Exception:
                pass
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                os.close(slave_fd)
            os.execvp(cmd[0], cmd)
        except Exception as exc:
            sys.stderr.write(f"Failed to launch shell {cmd[0]!r}: {exc}\n")
            sys.stderr.flush()
            os._exit(127)

    os.close(slave_fd)
    emit(f"P:{pid}")

    stdin_fd = sys.stdin.fileno()
    os.set_blocking(master_fd, False)
    os.set_blocking(stdin_fd, False)

    stdin_buf = bytearray()
    pending_write = bytearray()
    stdin_open = True
    master_open = True
    stopping = False
    stop_deadline = None
    exit_code = None
    exit_signal = None

    def reap_child() -> bool:
        nonlocal exit_code, exit_signal
        if exit_code is not None or exit_signal is not None:
            return True
        try:
            waited_pid, status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                exit_code, exit_signal = decode_wait_status(status)
                return True
        except ChildProcessError:
            exit_code = 0
            return True
        return False

    try:
        while master_open:
            reap_child()
            read_fds = [master_fd] + ([stdin_fd] if stdin_open else [])
            write_fds = [master_fd] if (pending_write and master_open) else []
            timeout = 0.05 if stopping or (exit_code is not None or exit_signal is not None) else 0.5
            try:
                rlist, wlist, _ = select.select(read_fds, write_fds, [], timeout)
            except InterruptedError:
                continue

            if stdin_fd in rlist:
                try:
                    chunk = os.read(stdin_fd, 65536)
                except OSError as exc:
                    if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                        chunk = None
                    else:
                        chunk = b""
                if chunk is not None and not chunk:
                    stdin_open = False
                elif chunk:
                    stdin_buf.extend(chunk)
                    while b"\n" in stdin_buf:
                        nl = stdin_buf.index(b"\n")
                        raw_line = bytes(stdin_buf[:nl]).rstrip(b"\r")
                        del stdin_buf[: nl + 1]
                        if not raw_line:
                            continue
                        if raw_line.startswith(b"I:"):
                            try:
                                pending_write.extend(base64.b64decode(raw_line[2:]))
                            except Exception:
                                pass
                        elif raw_line.startswith(b"R:"):
                            try:
                                parts = raw_line[2:].decode("ascii").split(",", 1)
                                new_cols = int(parts[0])
                                new_rows = int(parts[1])
                                set_winsize(master_fd, new_rows, new_cols)
                                signal_child_group(pid, signal.SIGWINCH, master_fd)
                            except Exception:
                                pass
                        elif raw_line == b"Q":
                            if not stopping:
                                stopping = True
                                signal_child_group(pid, signal.SIGTERM, master_fd)
                if not stdin_open and not stopping:
                    stopping = True
                    signal_child_group(pid, signal.SIGTERM, master_fd)

            if master_fd in wlist and pending_write:
                try:
                    written = os.write(master_fd, pending_write)
                    del pending_write[:written]
                except OSError as exc:
                    if exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                        pending_write.clear()

            if master_fd in rlist:
                try:
                    out = os.read(master_fd, 65536)
                except OSError as exc:
                    if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                        out = None
                    else:
                        out = b""
                if out is not None:
                    if not out:
                        master_open = False
                    else:
                        emit("D:" + base64.b64encode(out).decode("ascii"))

            if reap_child() and not master_open:
                break

            if stopping:
                if stop_deadline is None:
                    stop_deadline = time.monotonic() + 1.5
                elif time.monotonic() >= stop_deadline:
                    signal_child_group(pid, signal.SIGKILL, master_fd)
                    break

        if exit_code is None and exit_signal is None:
            try:
                _, status = os.waitpid(pid, 0)
                exit_code, exit_signal = decode_wait_status(status)
            except ChildProcessError:
                exit_code = 0
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    code_str = "" if exit_code is None else str(exit_code)
    sig_str = "" if exit_signal is None else str(exit_signal)
    emit(f"E:{code_str},{sig_str}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
