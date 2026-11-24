"""Owned PES runs over an NDJSON request, event and stop pipe."""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
import importlib
import json
import hashlib
import struct
import os
from pathlib import Path
from queue import Queue
import re
import stat
import sys
import threading
import time
import traceback

from native_stdin import control_blocks, replace_native_output_descriptors, route_native_output


SCHEMA = 'es-pes/v1'
RESIDENT_SCHEMA = 'es-pes-resident/v1'
ORDINARY_WARM = {'fire2': 'fire2', 'sella-xyz': 'sella', 'sella-ric': 'sella'}
OPERATIONS = {
    'scan': ('pes_scan_ts', {'slsqp', 'sella-scan', 'lbfgs-scan', 'fire2-scan'}),
    'ts': ('pes_scan_ts', {'prfo', 'rfo', 'qn', 'dimer', 'climb'}),
    'hessian': ('pes_scan_ts', {'numeric'}),
    'path': ('pes_paths', {'ci-neb', 'de-gsm', 'fsm'}),
    'opt': ('pes_opt', {'lbfgs', 'precon-exp', 'fire2', 'sella-xyz', 'sella-ric'}),
    'irc': ('pes_irc', {'sella-irc'}),
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


class ResidentProtocol:
    """Keep concurrent preparation and scientific events on whole NDJSON lines."""

    def __init__(self, stream):
        self.stream = stream
        self.lock = threading.Lock()

    def write(self, data):
        with self.lock:
            self.stream.write(data)
            self.stream.flush()

    def flush(self):
        pass  # Each line was flushed while holding the writer lock.


@contextmanager
def resident_protocol():
    sys.stdout.flush()
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb') as stdout:
        try:
            # Optional imports can run concurrently. Their prints use the
            # diagnostic descriptors while the private stream carries events.
            replace_native_output_descriptors(sys.stderr.fileno(), sys.stderr.fileno())
            yield ResidentProtocol(stdout)
        finally:
            sys.stdout.flush()
            replace_native_output_descriptors(stdout.fileno(), sys.stderr.fileno())


def json_value(value):
    if type(value).__module__.split('.')[0] == 'numpy' and hasattr(value, 'tolist'):
        return value.tolist()
    raise TypeError(f'PES worker cannot serialize {type(value).__name__}')


class Events:
    def __init__(self, protocol, request, *, compact_terminal_frames=False, numeric_directory=None):
        self.protocol = protocol
        self.request = request
        self.seq = 0
        self.frames = {}
        self.compact_terminal_frames = compact_terminal_frames
        self.emitted_frame_hashes = {}
        self.numeric_directory = numeric_directory
        self.path_records = {}
        self.scan_points = {}
        self.timed_stage = None
        self.completed = None
        self.stage_started = None
        self.evaluation_started = False

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
            if self.compact_terminal_frames:
                frame = json.dumps(payload, ensure_ascii=True, allow_nan=False,
                                   separators=(',', ':'), default=json_value).encode('ascii')
                header = dict(schema=SCHEMA, runIdentity=self.request['runIdentity'], seq=self.seq, event='frame')
                context = json.dumps(header, ensure_ascii=True, separators=(',', ':')).encode('ascii')
                self.protocol.write(context[:-1] + b',"frame":' + frame + b'}\n')
                self.protocol.flush()
                self.seq += 1
                self.emitted_frame_hashes[payload['id']] = hashlib.sha256(frame).digest()
            else:
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
        elif kind == 'evaluation-started':
            if not self.evaluation_started:
                self.evaluation_started = True
                self.emit('evaluation-started', **payload)
        elif kind == 'optimization-timing':
            self.emit(kind, timing=payload)
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
        # Reuse the exact order in the final solver result, including frames
        # emitted only at termination. A changed previously emitted frame
        # stays explicit so the host can reject it as it did on the old wire.
        if self.compact_terminal_frames and result.get('frames'):
            frames = result.get('frames', ())
            def was_emitted(frame):
                previous = self.emitted_frame_hashes.get(frame['id'])
                if previous is None:
                    return False
                encoded = json.dumps(frame, ensure_ascii=True, allow_nan=False,
                                     separators=(',', ':'), default=json_value).encode('ascii')
                return hashlib.sha256(encoded).digest() == previous
            changed = []
            for frame in frames:
                if frame['id'] not in self.emitted_frame_hashes:
                    self.emit('terminal-frame', frame=frame)
                elif not was_emitted(frame):
                    # A redefined live receipt is checked by the host and can
                    # never be silently reused as the earlier immutable frame.
                    changed.append(frame)
            packet['resultFrameIds'] = [frame['id'] for frame in frames]
            packet['result'] = {**result, 'frames': changed}
        if self.numeric_directory is not None:
            try:
                compact, fields = write_terminal_numeric_fields(packet['result'], self.numeric_directory)
                if fields:
                    packet['result'] = compact
                    packet['resultNumericFiles'] = fields
            except OSError as storage_error:
                # Numerical results still exist in the solver payload if the
                # transport file could not be created.
                packet['result'] = {**packet['result'], 'provenance': {
                    **packet['result']['provenance'], 'terminalNumericStorageWarning': str(storage_error)}}
        if error is not None:
            packet['error'] = error
        self.emit('terminal', **packet)
        return 1 if terminal == 'failed' else 0


def write_terminal_numeric_fields(result, directory):
    """Emit immutable Float64 evidence while leaving geometry and mode metadata inline."""
    hessian = result.get('hessian')
    matrix = hessian.get('matrixHartreePerBohr2') if hessian is not None else None
    modes = result.get('frequencies')
    if matrix is None and not modes:
        return result, {}
    fields = {}

    def write(name, rows, shape):
        digest = hashlib.sha256()
        length = 0
        with (directory / name).open('xb') as stream:
            for row in rows:
                packed = struct.pack(f'<{len(row)}d', *row)
                stream.write(packed)
                digest.update(packed)
                length += len(packed)
            stream.flush()
            os.fsync(stream.fileno())
        return {'name': name, 'shape': shape, 'bytes': length, 'sha256': digest.hexdigest()}

    compact = dict(result)
    if matrix is not None:
        size = len(matrix)
        fields['hessianMatrix'] = write('hessian-matrix.f64', matrix, [size, size])
        compact['hessian'] = {key: value for key, value in hessian.items() if key != 'matrixHartreePerBohr2'}
    if modes:
        atoms = len(modes[0]['displacements'])
        fields['modeDisplacements'] = write(
            'vibration-displacements.f64', (xyz for mode in modes for xyz in mode['displacements']),
            [len(modes), atoms, 3])
        compact['frequencies'] = [{key: value for key, value in mode.items() if key != 'displacements'}
                                  for mode in modes]
    return compact, fields


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
        if isinstance(payload, dict) and payload.get('schema') == RESIDENT_SCHEMA:
            return run_on_large_stack(lambda: resident_main(fd, pending, payload))
        request, runtime, workspace, module = validate_input(payload)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1

    needs_stack = False
    if request.get('method') in ('gfn0', 'gfnff'):
        from pes_core import uses_resident_eg
        needs_stack = uses_resident_eg(request)
    if needs_stack:
        return run_on_large_stack(lambda: run_owned(request, runtime, workspace, module, pending, fd))
    return run_owned(request, runtime, workspace, module, pending, fd)


def run_on_large_stack(work):
    # The Windows non-SCC loaders need the validated 64 MiB native stack.
    values, failures, ready = [], [], threading.Event()

    def execute():
        ready.wait()
        try:
            values.append(work())
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


class ResidentControl:
    def __init__(self, fd, pending):
        self.commands = Queue()
        self.active = None
        self.last_identity = None
        self.done = threading.Event()
        self.lock = threading.Lock()
        self.error = None
        self.thread = threading.Thread(target=self.read, args=(fd, pending), name='pes-resident-control', daemon=True)
        self.thread.start()

    def read(self, fd, pending):
        incoming = bytearray()
        try:
            if not self.consume(incoming, pending):
                return
            for block in control_blocks(fd, self.done):
                if not block:
                    break
                if not self.consume(incoming, block):
                    return
        except Exception as error:
            self.error = error
        finally:
            self.done.set()
            with self.lock:
                if self.active is not None:
                    self.active[1].set()
            self.commands.put(None)

    def consume(self, incoming, block):
        lines = block.split(b'\n')
        for line in lines[:-1]:
            incoming.extend(line)
            packet = load_line(incoming)
            incoming.clear()
            if packet.get('command') == 'stop':
                self.stop(packet)
                continue
            if packet.get('schema') != RESIDENT_SCHEMA:
                raise ValueError('Invalid PES resident control schema')
            command = packet.get('command')
            if command == 'shutdown':
                return False
            if command == 'run':
                payload = packet['payload']
                identity = payload['request']['runIdentity']
                with self.lock:
                    if self.active is not None:
                        raise ValueError('PES worker received overlapping task leases')
                    stop = threading.Event()
                    self.active = (identity, stop)
                self.commands.put((command, payload, stop))
            elif command == 'prepare':
                self.commands.put((command, packet['profile'], None))
            else:
                raise ValueError('Invalid PES resident control command')
        incoming.extend(lines[-1])
        return True

    def stop(self, packet):
        identity = packet.get('runIdentity')
        if packet != dict(schema=SCHEMA, runIdentity=identity, command='stop'):
            raise ValueError('Invalid PES stop message')
        with self.lock:
            if self.active is not None and identity == self.active[0]:
                self.active[1].set()
            elif identity != self.last_identity or identity is None:
                raise ValueError('Invalid PES stop identity')

    def release(self, identity):
        with self.lock:
            if self.active is None or identity != self.active[0]:
                raise ValueError('Invalid PES worker lease release')
            self.active = None
            self.last_identity = identity


def prepare_profile(profile):
    module = solver_module(profile)
    algorithm = profile['algorithm']
    importlib.import_module(module)
    importlib.import_module('ase.data')
    if algorithm.startswith('sella') or algorithm in ('prfo', 'rfo', 'qn'):
        importlib.import_module('sella')
        importlib.import_module('sella.internal')
        importlib.import_module('sella.optimize.restricted_step')
    elif algorithm in ('fire2', 'climb'):
        importlib.import_module('ase.optimize')
    elif algorithm == 'dimer':
        importlib.import_module('ase.mep')
    elif algorithm == 'fsm':
        importlib.import_module('pes_strings')
    elif algorithm == 'ci-neb':
        importlib.import_module('pes_neb')
    elif algorithm == 'de-gsm':
        importlib.import_module('pyGSM.growing_string_methods.de_gsm')
        importlib.import_module('pyGSM.molecule')


def resident_main(fd, pending, envelope):
    with resident_protocol() as protocol:
        return run_resident(fd, pending, envelope, protocol)


def run_resident(fd, pending, envelope, protocol):
    from threadpoolctl import ThreadpoolController

    if set(envelope) != {'schema', 'command', 'library', 'profile'} or envelope['command'] != 'resident':
        raise ValueError('Invalid PES resident bootstrap envelope')
    warm_directory = Path.cwd()
    control = ResidentControl(fd, pending)
    library = envelope['library']
    close_library = lambda: None
    controller = None
    prepared_profiles = set()
    optional = {}
    preparation = None

    def emit(event, **fields):
        line = json.dumps(dict(schema=RESIDENT_SCHEMA, event=event, **fields),
                          ensure_ascii=True, separators=(',', ':')) + '\n'
        protocol.write(line.encode('ascii'))

    def prepare(profile):
        nonlocal controller
        key = (profile['operation'], profile['algorithm'], profile.get('parameters', {}).get('executionProfile'))
        if key in prepared_profiles:
            return
        dependency = ORDINARY_WARM.get(profile['algorithm']) if profile['operation'] == 'opt' else None
        warming = optional.get(dependency)
        if warming is None:
            prepare_profile(profile)
            controller = ThreadpoolController()
        else:
            warming['done'].wait()
            if 'error' in warming:
                raise warming['error']
            controller = warming['controller']
        prepared_profiles.add(key)

    def warm_optimizers():
        for dependency, algorithm in (('fire2', 'fire2'), ('sella', 'sella-xyz')):
            if control.done.is_set():
                return
            state = optional[dependency]
            try:
                prepare_profile({'operation': 'opt', 'algorithm': algorithm})
                state['controller'] = ThreadpoolController()
            except Exception as error:
                state['error'] = error
                traceback.print_exc(file=sys.stderr)
            finally:
                state['done'].set()
            if not control.done.is_set():
                error = state.get('error')
                emit('optimizer-prepared', optimizer=dependency, ready=error is None,
                     **({'detail': str(error)} if error is not None else {}))

    try:
        if library is not None:
            from pes_libxtb import close_resident_api, prepare_resident_api
            close_library = close_resident_api
            prepare_resident_api(library)
        prepare(envelope['profile'])
        emit('ready')
        if library is not None:
            optional.update({name: {'done': threading.Event()} for name in ('fire2', 'sella')})
            preparation = threading.Thread(target=warm_optimizers, name='pes-optimizer-preparation', daemon=True)
            preparation.start()
        while not control.done.is_set():
            message = control.commands.get()
            if message is None:
                break
            command, payload, stop = message
            if command == 'prepare':
                try:
                    prepare(payload)
                    emit('prepared')
                except Exception as error:
                    traceback.print_exc(file=sys.stderr)
                    emit('prepare-failed', detail=str(error))
                continue
            request, runtime, workspace, module = validate_input(payload)
            prepare(request)
            if 'libxtbRoot' in runtime:
                from pes_libxtb import close_resident_api, prepare_resident_api
                close_library = close_resident_api
                prepare_resident_api(runtime)
                if library is None:
                    library = runtime
                    controller = ThreadpoolController()
            os.chdir(workspace)
            try:
                with controller.limit(limits=request['threads']):
                    _, reusable = execute_owned(request, runtime, workspace, module, nullcontext(control),
                                                stop=stop, event_stream=protocol)
            finally:
                os.chdir(warm_directory)
            if control.error is not None:
                raise control.error
            if not reusable:
                return 1
            identity = request['runIdentity']
            control.release(identity)
            emit('released', runIdentity=identity)
        if control.error is not None:
            raise control.error
        return 0
    finally:
        control.done.set()
        if preparation is not None:
            preparation.join()
        close_library()


def run_owned(request, runtime, workspace, module, pending, fd):
    return execute_owned(request, runtime, workspace, module, StopReader(fd, pending, request['runIdentity']))[0]


def execute_owned(request, runtime, workspace, module, stop_reader, *, stop=None, event_stream=None):
    with route_native_output(workspace) as protocol:
        events = Events(event_stream if event_stream is not None else protocol, request,
                        compact_terminal_frames=runtime.get('compactTerminalFrames') is True,
                        numeric_directory=workspace if runtime.get('binaryTerminalFields') is True else None)
        ctx = None
        control = None
        stopped_type = ()
        result = None
        failure = None
        reusable = True
        try:
            with (workspace / 'request.json').open('x', encoding='ascii') as stream:
                json.dump(request, stream, ensure_ascii=True, allow_nan=False)
            with stop_reader as control:
                stop = stop if stop is not None else control.stop
                if stop.is_set():
                    result = fallback(request, events, ctx, 'stopped')
                else:
                    observe_opt = request.get('operation') == 'opt' and request.get('parameters', {}).get('batchFinalOnly') is not True
                    context_started = time.perf_counter() if observe_opt else None
                    from pes_core import PesCancelled, make_context
                    stopped_type = PesCancelled
                    ctx = make_context(request, runtime, workspace, cancelled=stop.is_set, emit=events.observe)
                    if observe_opt:
                        events.observe('optimization-timing', dict(phase='worker-context-ready',
                                       contextMs=(time.perf_counter() - context_started) * 1000))
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
            control_error = getattr(control, 'error', None)
            traceback.print_exception(control_error or error, file=sys.stderr)
            result = fallback(request, events, ctx, 'partial' if events.frames or events.path_records else 'failed')
            failure = dict(message='PES 停止消息无效。' if control_error is not None else 'PES 工作进程执行失败。',
                           detail=str(control_error or error))
            if control_error is None and request.get('parameters', {}).get('batchFinalOnly') is True:
                from pes_coordinates import CoordinateError
                code = 'PES_OPT_COORDINATE' if isinstance(error, CoordinateError) else getattr(error, 'code', None)
                if code:
                    result['error'] = dict(code=code, message=str(error))
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
                    reusable = False
                    traceback.print_exc(file=sys.stderr)
                    if result is not None:
                        result['provenance'] = dict(result['provenance'], resourceCleanupError=str(error),
                                                    scientificStatusBeforeCleanup=result['status'])
                        if request.get('parameters', {}).get('batchFinalOnly') is True:
                            if result.get('error') is not None:
                                result['provenance']['scientificErrorBeforeCleanup'] = result['error']
                            result['error'] = dict(code='PES_RESOURCE_CLEANUP', message=str(error))
                        if result['status'] in ('completed', 'stopped'):
                            result['status'] = 'partial'
                    failure = dict(message='PES 计算资源释放失败。', detail=str(error))
        # Native handles are released before publishing a terminal packet. The
        # host still waits for the owned worker's actual close before returning
        # the shared grant or announcing workerSettled.
        return events.terminal(result, failure), reusable


if __name__ == '__main__':
    raise SystemExit(main())
