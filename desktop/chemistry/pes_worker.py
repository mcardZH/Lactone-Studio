"""One owned PES run over an NDJSON request, event and stop pipe."""
from __future__ import annotations

import importlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import threading
import time
import traceback

from native_stdin import control_blocks


SCHEMA = 'es-pes/v1'
OPERATIONS = {
    'scan': ('pes_scan_ts', {'slsqp', 'sella-scan'}),
    'ts': ('pes_scan_ts', {'prfo', 'rfo', 'qn', 'dimer', 'climb'}),
    'hessian': ('pes_scan_ts', {'numeric'}),
    'path': ('pes_paths', {'ci-neb', 'de-gsm', 'fsm'}),
}
STATUSES = {'completed', 'partial', 'not-converged', 'stopped', 'failed'}


def solver_module(request):
    """Choose the declared implementation without reinterpreting legacy requests."""
    operation = OPERATIONS.get(request.get('operation'))
    if operation is None or request.get('algorithm') not in operation[1]:
        raise ValueError('PES algorithm is unavailable in this worker')
    profile = request.get('parameters', {}).get('executionProfile')
    if profile not in (None, 'pes-v222'):
        raise ValueError('Unsupported PES execution profile')
    if request.get('algorithm') == 'sella-scan' and profile != 'pes-v222':
        raise ValueError('Sella scan requires its PES execution profile')
    return operation[0]


def nonfinite(_):
    raise ValueError('Nonfinite JSON is not supported')


def load_line(raw):
    return json.loads(raw.decode('utf-8'), parse_constant=nonfinite)


def read_request(fd):
    incoming = bytearray()
    while True:
        block = os.read(fd, 65536)
        if not block:
            raise ValueError('PES start packet was truncated')
        line, separator, remaining = block.partition(b'\n')
        incoming.extend(line)
        if separator:
            return load_line(incoming), remaining


def validate_input(payload):
    if not isinstance(payload, dict) or set(payload) != {'request', 'runtime', 'workspace'}:
        raise ValueError('Invalid PES worker envelope')
    request = payload['request']
    if not isinstance(request, dict) or request.get('schema') != SCHEMA:
        raise ValueError('Invalid PES request schema')
    identity = request.get('runIdentity')
    if (not isinstance(identity, dict) or set(identity) != {'groupId', 'taskId', 'runId'}
            or not all(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value)
                       for value in identity.values())):
        raise ValueError('Invalid PES run identity')
    if not isinstance(request.get('sourceDocumentId'), str) or not request['sourceDocumentId']:
        raise ValueError('Missing PES source document identity')
    module = solver_module(request)
    workspace = Path(payload['workspace'])
    if not workspace.is_absolute() or not workspace.is_dir() or workspace.is_symlink():
        raise ValueError('Missing owned PES workspace')
    if getattr(workspace.lstat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
        raise ValueError('PES workspace is a reparse point')
    return request, payload['runtime'], workspace, module


def route_native_output(workspace):
    """Keep the protocol descriptor private from Python and native libraries."""
    sys.stdout.flush()
    sys.stderr.flush()
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'wb')
    try:
        with (workspace / 'stderr.log').open('xb') as log:
            os.dup2(log.fileno(), sys.stdout.fileno())
            os.dup2(log.fileno(), sys.stderr.fileno())
            if os.name == 'nt':
                import ctypes
                from ctypes import wintypes
                import msvcrt
                set_handle = ctypes.WinDLL('kernel32', use_last_error=True).SetStdHandle
                set_handle.argtypes = [wintypes.DWORD, wintypes.HANDLE]
                set_handle.restype = wintypes.BOOL
                for native, stream in ((-11, sys.stdout), (-12, sys.stderr)):
                    if not set_handle(native, msvcrt.get_osfhandle(stream.fileno())):
                        raise ctypes.WinError(ctypes.get_last_error())
    except BaseException:
        protocol.close()
        raise
    return protocol


def json_value(value):
    if type(value).__module__.split('.')[0] == 'numpy' and hasattr(value, 'tolist'):
        return value.tolist()
    raise TypeError(f'PES worker cannot serialize {type(value).__name__}')


class Events:
    def __init__(self, protocol, request):
        self.protocol = protocol
        self.request = request
        self.seq = 0
        self.frames = {}
        self.path_records = {}
        self.scan_points = {}
        self.timed_stage = None
        self.completed = None
        self.stage_started = None

    def emit(self, event, **fields):
        packet = dict(schema=SCHEMA, runIdentity=self.request['runIdentity'], seq=self.seq, event=event, **fields)
        data = json.dumps(packet, ensure_ascii=True, allow_nan=False, separators=(',', ':'), default=json_value)
        self.protocol.write(data.encode('ascii') + b'\n')
        self.protocol.flush()
        self.seq += 1

    def observe(self, kind, payload):
        if kind == 'progress':
            stage = payload.get('stage', payload.get('phase'))
            fields = {key: payload[key] for key in ('completed', 'total', 'elapsedSeconds') if payload.get(key) is not None}
            if 'completed' not in fields and payload.get('acceptedSteps') is not None:
                fields['completed'] = payload['acceptedSteps']
            if fields.get('total') == 0:
                del fields['total']
            if stage in ('scan', 'hessian', 'initial-hessian', 'recalculate-hessian', 'final-frequency') and 'total' in fields and 'completed' in fields:
                key = (stage, fields['total'])
                completed = fields['completed']
                if self.timed_stage != key or completed < self.completed:
                    self.stage_started = time.monotonic() if completed == 0 else None
                elif completed == self.completed:
                    return
                self.timed_stage, self.completed = key, completed
                if self.stage_started is not None:
                    fields.setdefault('elapsedSeconds', time.monotonic() - self.stage_started)
            else:
                self.timed_stage = None
            self.emit('progress', stage=stage, **fields)
        elif kind == 'frame':
            if payload['id'] in self.frames:
                raise ValueError('PES algorithm repeated a live frame identity')
            self.emit('frame', frame=payload)
            self.frames[payload['id']] = payload
        elif kind == 'path-record':
            record = payload['record']
            if record['id'] in self.path_records:
                raise ValueError('PES algorithm repeated a path round identity')
            self.emit('path-record', **payload)
            self.path_records[record['id']] = record
        elif kind == 'scan-point':
            if payload['pointIndex'] in self.scan_points:
                raise ValueError('PES algorithm repeated a scan point identity')
            self.emit('scan-point', point=payload)
            self.scan_points[payload['pointIndex']] = payload
        else:
            raise ValueError(f'Unknown PES progress kind {kind}')

    def terminal(self, result, error=None):
        status = result['status']
        if status not in STATUSES:
            raise ValueError('Unknown PES result status')
        source_error = result.get('error')
        if error is None and (status == 'failed' or source_error is not None):
            error = {'message': 'PES 计算失败。'}
            if source_error is not None:
                error['detail'] = detail(source_error)
        if error is not None and status in ('completed', 'stopped'):
            raise ValueError(f'Unexpected PES failure attached to a {status} result: {detail(error)}')
        # A search may run successfully to its configured boundary while
        # yielding a partial or nonconverged scientific result.
        terminal = 'failed' if error is not None else 'stopped' if status == 'stopped' else 'completed'
        packet = {'status': terminal, 'result': result}
        if error is not None:
            packet['error'] = error
        self.emit('terminal', **packet)
        return 1 if terminal == 'failed' else 0


class StopReader:
    def __init__(self, fd, pending, run_identity):
        self.fd, self.pending, self.run_identity = fd, pending, run_identity
        self.done = threading.Event()
        self.stop = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self.read, name='pes-stop-reader', daemon=True)

    def consume(self, data):
        expected = dict(schema=SCHEMA, runIdentity=self.run_identity, command='stop')
        while b'\n' in data:
            command, data = data.split(b'\n', 1)
            if load_line(command) != expected:
                raise ValueError('Invalid PES stop identity or command')
            self.stop.set()
        # This bound is on control messages only. Scientific requests and
        # results may contain arbitrarily many valid individual records.
        if len(data) > 65536:
            raise ValueError('PES stop control packet is oversized')
        return data

    def read(self):
        try:
            for block in control_blocks(self.fd, self.done):
                if not block:
                    self.stop.set()
                    return
                self.pending = self.consume(self.pending + block)
                if self.stop.is_set():
                    return
        except Exception as error:
            self.error = error
            self.stop.set()

    def __enter__(self):
        self.pending = self.consume(self.pending)
        if not self.stop.is_set():
            self.thread.start()
        return self

    def __exit__(self, *_):
        self.done.set()
        if self.thread.ident is not None:
            self.thread.join(timeout=.2)


def detail(error):
    if isinstance(error, dict):
        return json.dumps(error, ensure_ascii=False, default=json_value)
    return str(error)


def fallback(request, events, ctx, status):
    records = list(events.path_records.values())
    last_record = records[-1]['id'] if records else None
    warning = None
    if ctx is not None:
        try:
            for recorder in getattr(ctx, 'path_recorders', ()):
                last_record = recorder.finish() or last_record
            if getattr(ctx, 'path_recorders', None):
                records = [record for recorder in ctx.path_recorders for record in recorder.records.values()]
        except OSError as error:
            # Disk failure must not discard an already-published prefix or
            # claim that an uncommitted coordinate batch is available.
            warning = str(error)
            records = list(events.path_records.values())
    provenance = ctx.provenance() if ctx is not None else {
        'sourceDocumentId': request['sourceDocumentId'], 'method': request['method'],
        'algorithm': request['algorithm'], 'coordinateUnit': 'angstrom', 'energyUnit': 'hartree',
    }
    if warning:
        provenance['pathRecordWarning'] = warning
    return dict(frames=list(events.frames.values()), pathRecords=records, lastPathRecordId=last_record,
                scanPoints=list(events.scan_points.values()), status=status,
                provenance=provenance)


def main():
    fd = sys.stdin.fileno()
    try:
        payload, pending = read_request(fd)
        request, runtime, workspace, module = validate_input(payload)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1

    needs_stack = False
    if request.get('method') in ('gfn0', 'gfnff'):
        from pes_core import uses_resident_eg
        needs_stack = uses_resident_eg(request)
    if needs_stack:
        # The Windows native non-SCC loaders need the validated 64 MiB stack.
        # Keep create/evaluate/release on this one task thread; OMP/BLAS grants
        # remain untouched. Restore the process default before other threads.
        values, failures, ready = [], [], threading.Event()
        def execute():
            ready.wait()
            try:
                values.append(run_owned(request, runtime, workspace, module, pending, fd))
            except BaseException as error:
                failures.append(error)
        previous = threading.stack_size()
        try:
            threading.stack_size(64 * 1024 * 1024)
            solver = threading.Thread(target=execute, name='pes-resident-solver')
            solver.start()
        finally:
            threading.stack_size(previous)
        ready.set()
        solver.join()
        if failures:
            raise failures[0]
        return values[0]
    return run_owned(request, runtime, workspace, module, pending, fd)


def run_owned(request, runtime, workspace, module, pending, fd):
    with route_native_output(workspace) as protocol:
        events = Events(protocol, request)
        ctx = None
        stopped_type = ()
        result = None
        failure = None
        try:
            with (workspace / 'request.json').open('x', encoding='ascii') as stream:
                json.dump(request, stream, ensure_ascii=True, allow_nan=False)
            with StopReader(fd, pending, request['runIdentity']) as control:
                if control.stop.is_set():
                    result = fallback(request, events, ctx, 'stopped')
                else:
                    from pes_core import PesCancelled, make_context
                    stopped_type = PesCancelled
                    ctx = make_context(request, runtime, workspace, cancelled=control.stop.is_set, emit=events.observe)
                    result = importlib.import_module(module).run(request, ctx)
            if control.error is not None:
                raise control.error
            result['provenance'] = dict(ctx.provenance() if ctx is not None else {}, **result['provenance'])
            result['provenance']['sourceDocumentId'] = request['sourceDocumentId']
            result['provenance']['algorithm'] = request['algorithm']
        except stopped_type:
            if control.error is None:
                result = fallback(request, events, ctx, 'stopped')
            else:
                traceback.print_exception(control.error, file=sys.stderr)
                result = fallback(request, events, ctx, 'partial' if events.frames or events.path_records else 'failed')
                failure = dict(message='PES 停止消息无效。', detail=str(control.error))
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            result = fallback(request, events, ctx, 'partial' if events.frames or events.path_records else 'failed')
            failure = dict(message='PES 工作进程执行失败。', detail=str(error))
        finally:
            close = getattr(ctx, 'close', None)
            if close is not None:
                try:
                    close()
                    if result is not None:
                        after_close = ctx.provenance()
                        result['provenance']['resourceCleanup'] = dict(contextClosed=True, **{
                            name: after_close[name] for name in ('activeElectronicNodes', 'releasedElectronicNodes')
                            if name in after_close})
                except Exception as error:
                    traceback.print_exc(file=sys.stderr)
                    if result is not None:
                        result['provenance'] = dict(result['provenance'], resourceCleanupError=str(error),
                                                    scientificStatusBeforeCleanup=result['status'])
                        if result['status'] in ('completed', 'stopped'):
                            result['status'] = 'partial'
                    failure = dict(message='PES 计算资源释放失败。', detail=str(error))
        # Native handles are released before publishing a terminal packet. The
        # host still waits for the owned worker's actual close before returning
        # the shared grant or announcing workerSettled.
        return events.terminal(result, failure)


if __name__ == '__main__':
    raise SystemExit(main())
