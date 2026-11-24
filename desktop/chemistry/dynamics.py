"""Owned continuous MD control and frame delivery."""
from __future__ import annotations

from contextlib import ExitStack
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time

from dynamics_errors import Rejected, reject
from native_stdin import control_blocks, route_native_output

SCHEMA = 1
MAX_LINE_BYTES = 16 * 1024 * 1024


class Stopped(Exception):
    pass


def create_session(request, native_context=None, ase_context=None):
    if request.get('operation') != 'md' or request.get('method') is None or request.get('untilStopped') is not True:
        reject('operation', 'A dynamics session requires a continuous MD request.')
    if request.get('integrator') == 'ase':
        from ase_md import ModelingSession
        return ModelingSession(request, ase_context)
    if request.get('integrator', 'xtb') != 'xtb':
        reject('md-integrator', 'The configured MD integrator is unsupported.')
    if not isinstance(native_context, dict):
        reject('md-native-context', 'GFN MD需要桌面提供实际原生运行环境。')
    from dynamics_native_md import Session
    return Session(request, native_context)


def main():
    incoming = queue.Queue(maxsize=64)
    reader_done = threading.Event()

    def enqueue(value):
        while not reader_done.is_set():
            try:
                incoming.put(value, timeout=.05)
                return
            except queue.Full:
                continue

    def reader():
        pending = b""
        try:
            # Poll the owned Windows pipe so the empty pipe cannot hold the
            # CRT descriptor lock while the selected driver initializes.
            for block in control_blocks(sys.stdin.fileno(), reader_done):
                if not block:
                    enqueue(None)
                    return
                pending += block
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    obj = json.loads(line, parse_constant=lambda _: reject("request", "Non-finite JSON is unsupported."))
                    if not isinstance(obj, dict):
                        reject("request", "A session command must be an object.")
                    enqueue(obj)
        except OSError:
            enqueue(Rejected("dynamics-stdin", "无法读取动力学会话控制管道。"))
        except Exception as exc:
            enqueue(exc)

    reader_thread = threading.Thread(target=reader, daemon=True)
    reader_thread.start()
    session = None
    session_id = None
    seq = 0
    last_event_at = time.monotonic()
    original_request = {}
    output_scope = ExitStack()
    native_protocol = None
    def emit(event, snapshot=None, **extra):
        nonlocal seq, last_event_at
        seq += 1
        last_event_at = time.monotonic()
        fallback = dict(stamp=original_request.get("stamp"), operation=original_request.get("operation"), step=0, timeFs=0)
        payload = dict(schema=SCHEMA, sessionId=session_id, event=event, seq=seq,
                       **(snapshot if snapshot is not None else (session.last_validated if session else fallback)), **extra)
        if session is not None:
            payload["targetTemperatureK"] = session.target_temperature
        line = json.dumps(payload, allow_nan=False, separators=(",", ":")) + "\n"
        if native_protocol is None:
            sys.stdout.write(line)
            sys.stdout.flush()
        else:
            native_protocol.write(line.encode('utf-8'))
            native_protocol.flush()
    def command(obj):
        if obj is None:
            raise Stopped()
        if isinstance(obj, Exception):
            raise obj
        if obj.get("schema") != SCHEMA or obj.get("sessionId") != session_id:
            reject("session-identity", "The command schema or session identity does not match.")
        action = obj.get("command")
        if action == "stop":
            session.stopped = True
            raise Stopped()
        reject('md-command', 'MD持续运行直到停止，只接受停止命令。')
    def controls():
        while True:
            if session.max_wall_seconds is not None and session.running_seconds() > session.max_wall_seconds:
                reject("walltime", "The bounded session walltime limit was reached.")
            if time.monotonic()-last_event_at >= 5:
                emit("heartbeat")
            try:
                obj = incoming.get(timeout=0.05) if session.paused else incoming.get_nowait()
                command(obj)
            except queue.Empty:
                if not session.paused:
                    return
    try:
        first = incoming.get()
        if isinstance(first, Exception):
            raise first
        if not first or first.get("schema") != SCHEMA or first.get("command") != "start":
            reject("start", "The first command must start a schema-1 session.")
        session_id = first.get("sessionId")
        if not isinstance(session_id, str) or not session_id or len(session_id) > 256:
            reject("session-identity", "A bounded nonempty session ID is required.")
        original_request = first.get("request", {})
        if not isinstance(original_request, dict):
            original_request = {}
            reject("request", "A session start request must be an object.")
        emit("ready")
        if original_request.get('integrator') == 'ase':
            workspace = Path(first['aseContext']['workspacePath'])
            native_protocol = output_scope.enter_context(route_native_output(workspace, filename='ase-native.log', restore=False))
        session = create_session(original_request, first.get('nativeContext'), first.get('aseContext'))
        emit("started")
        session.run(emit, controls)
        reject('md-unexpected-completion', '连续MD意外完成。')
    except Stopped:
        emit("stopped", reason="cancelled-or-stdin-closed")
        return 0
    except Exception as exc:
        code = getattr(exc, 'code', None)
        diagnostic = getattr(exc, 'details', None)
        emit("error", error=dict(code=code or 'native-failure',
            message=str(exc) if code else 'The dynamics session failed; its last validated frame is retained.',
            **({'diagnostic': diagnostic} if diagnostic else {})))
        return 1
    finally:
        reader_done.set()
        if os.name == "nt":
            reader_thread.join()
        output_scope.close()


if __name__ == "__main__":
    raise SystemExit(main())
