"""Owned electronic-analysis RPC; only explicit run commands perform science.

The two scientific services have the same small interface. Control messages
invalidate an epoch and wait for the real executor/native settlement; a cancel
acknowledgement cannot release the host's shared Multiwfn lease early.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from analysis_result_wire import managed_result
import sys
import threading


class ElectronicWorkerError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def bounded_id(value):
    return isinstance(value, str) and 0 < len(value) <= 256


class ElectronicWorker:
    def __init__(self, emit, service_factory=None):
        self.emit = emit
        self.sessions = {}
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='electronic-native')
        self.closed = False
        self.futures = set()
        self.service_factory = service_factory or self._service

    @staticmethod
    def _service(family, workspace, progress, cancelled):
        # Explicit imports keep both families discoverable by the native
        # freezer; their code still loads only when the family is opened.
        if family == 'excitation':
            from excitation_analysis import ExcitationAnalysisService
            constructor = ExcitationAnalysisService
        else:
            from reactivity_analysis import ReactivityAnalysisService
            constructor = ReactivityAnalysisService
        return constructor(workspace, progress_callback=progress, cancel_callback=cancelled)

    def reply(self, request, result=None, error=None, settled=None, retained=None, disposition=None):
        packet = dict(id=request.get('id'), sessionId=request.get('sessionId'), family=request.get('family'), ok=error is None)
        if settled is not None:
            packet['nativeSettled'] = settled
        if retained is not None:
            packet['retainedMemoryBytes'] = retained
        if disposition is not None:
            packet['settlement'] = disposition
        if error is None:
            packet['result'] = result
        else:
            packet['error'] = dict(code=getattr(error, 'code', 'electronic-worker'), message=str(error))
        self.emit(packet)

    @staticmethod
    def retained(session):
        value = session['service'].retained_memory_bytes()
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ElectronicWorkerError('electronic-memory', 'Invalid retained-memory telemetry.')
        return value

    @staticmethod
    def native_starts(session):
        value = getattr(session['service'], 'native_start_count', 0)
        value = value() if callable(value) else value
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ElectronicWorkerError('electronic-native', 'Invalid native-start telemetry.')
        return value

    def handle(self, request):
        try:
            if not isinstance(request, dict) or not bounded_id(request.get('id')) or not bounded_id(request.get('sessionId')) or request.get('family') not in ('excitation', 'reactivity'):
                raise ElectronicWorkerError('electronic-request', 'Expected an owned family/session/request identity.')
            operation, session_id, family = request.get('operation'), request['sessionId'], request['family']
            if operation == 'open':
                with self.lock:
                    if self.closed or session_id in self.sessions:
                        raise ElectronicWorkerError('electronic-session', 'Closed, duplicate or over-limit electronic session.')
                    session = dict(family=family, epoch=0, cancelled=threading.Event(), closed=False, futures=set(), active_request=None, disposition='not-started')

                    def progress(packet):
                        with self.lock:
                            active = session['active_request']
                            if active is None or session['closed'] or session['cancelled'].is_set() or self.sessions.get(session_id) is not session:
                                return
                            reply = dict(event='task-progress', id=active['id'], sessionId=session_id, family=family, progress=packet)
                        self.emit(reply)

                    service = self.service_factory(family, request['workspacePath'], progress, session['cancelled'].is_set)
                    if not all(callable(getattr(service, method, None)) for method in ('handle', 'retained_memory_bytes', 'cancel', 'stop_native', 'apply_resources')):
                        raise ElectronicWorkerError('electronic-service', 'Scientific service lacks required native lifetime methods.')
                    session['service'] = service
                    self.sessions[session_id] = session
                try:
                    result = service.handle(dict(request, command='open'))
                    self.reply(request, result, retained=self.retained(session))
                except Exception:
                    with self.lock:
                        self.sessions.pop(session_id, None)
                    service.handle(dict(command='close'))
                    raise
                return
            with self.lock:
                session = self.sessions.get(session_id)
                if self.closed or session is None or session['family'] != family or session['closed']:
                    raise ElectronicWorkerError('electronic-session', 'Electronic session/family is absent or closed.')
                epoch = session['epoch']
            if operation in ('cancel', 'close'):
                with self.lock:
                    session['epoch'] += 1
                    session['cancelled'].set()
                    session['closed'] = operation == 'close'
                    futures = list(session['futures'])
                cancel = getattr(session['service'], 'cancel', None)
                if cancel is not None:
                    cancel()
                # A service's cancel may only request termination. Acknowledging
                # happens after every in-flight method exits its native finally.
                for future in futures:
                    future.result()
                if operation == 'close':
                    session['service'].handle(dict(command='close'))
                    with self.lock:
                        self.sessions.pop(session_id, None)
                self.reply(request, dict(sessionId=session_id, status='closed' if operation == 'close' else 'cancelled', nativeSettled=True, activeOperationPending=False, settlement=session['disposition']), settled=True, retained=self.retained(session), disposition=session['disposition'])
                return
            if operation not in ('run', 'restore-fields', 'export-cube') or family == 'reactivity' and operation != 'run':
                raise ElectronicWorkerError('electronic-operation', 'Unsupported electronic operation.')
            scientific = operation == 'run'

            def execute():
                result, failure, settled = None, None, None
                starts_before = self.native_starts(session)
                entered = False
                try:
                    with self.lock:
                        if self.closed or self.sessions.get(session_id) is not session or session['epoch'] != epoch or session['closed']:
                            raise ElectronicWorkerError('electronic-cancelled', 'Queued electronic request was cancelled before start.')
                        session['cancelled'].clear()
                        session['active_request'] = request
                        entered = True
                    payload = request.get('request')
                    if not isinstance(payload, dict):
                        raise ElectronicWorkerError('electronic-request', 'Expected explicit typed scientific/read request.')
                    # The current host lease grant replaces the open-time
                    # budget for every operation. Do this once for both service
                    # families before their handle adapters unwrap `request`.
                    session['service'].apply_resources(request.get('resources'))
                    result = session['service'].handle(dict(payload, command=operation, request=payload))
                    with self.lock:
                        if session['epoch'] != epoch or session['closed']:
                            raise ElectronicWorkerError('electronic-cancelled', 'Electronic result belongs to an invalidated request epoch.')
                except Exception as error:
                    failure = error
                finally:
                    if scientific:
                        try:
                            # Both family services guarantee handle exits only
                            # after native termination/wait, including failures.
                            # Explicit stop_native also protects a cached backend.
                            session['service'].stop_native()
                            # A service's explicit unsettled failure is not
                            # erased by a later no-op/partial stop attempt. The
                            # host must close this worker before releasing its
                            # lease, while the service keeps native ownership.
                            settled = not (failure is not None and getattr(failure, 'code', '') == 'native-unsettled')
                        except Exception as error:
                            failure, settled = error, False
                    with self.lock:
                        if session['active_request'] is request:
                            session['active_request'] = None
                        session['disposition'] = 'native-settled' if self.native_starts(session) > starts_before and settled is not False else 'not-started' if entered else 'cancelled-before-start'
                try:
                    retained = self.retained(session)
                except Exception as error:
                    failure, retained = error, None
                self.reply(request, result, failure, settled, retained, session['disposition'] if settled is not False else None)

            # Hold the registry lock across submit+registration so cancel can
            # never miss an accepted request between those two operations.
            with self.lock:
                future = self.executor.submit(execute)
                self.futures.add(future)
                session['futures'].add(future)

            def discard(done):
                with self.lock:
                    self.futures.discard(done)
                    session['futures'].discard(done)
            future.add_done_callback(discard)
        except Exception as error:
            self.reply(request if isinstance(request, dict) else {}, error=error)

    def close(self):
        with self.lock:
            self.closed = True
            sessions = list(self.sessions.values())
            for session in sessions:
                session['epoch'] += 1
                session['closed'] = True
                session['cancelled'].set()
        for session in sessions:
            cancel = getattr(session['service'], 'cancel', None)
            if cancel is not None:
                cancel()
        self.executor.shutdown(wait=True, cancel_futures=False)
        for session in sessions:
            session['service'].handle(dict(command='close'))
        self.sessions.clear()


def main():
    output_lock = threading.Lock()
    roots = {}

    def emit(packet):
        root = roots.get(packet.get('sessionId'))
        if root is not None and packet.get('ok') is True and 'result' in packet:
            try: packet = dict(packet, result=managed_result(packet['result'], root))
            except Exception as error:
                packet = {key:value for key,value in packet.items() if key!='result'}
                packet.update(ok=False,error=dict(code='analysis-result-storage',message=str(error)))
        text = json.dumps(packet, allow_nan=False, separators=(',', ':'))
        with output_lock:
            sys.stdout.write(text + '\n')
            sys.stdout.flush()

    worker = ElectronicWorker(emit)
    try:
        for raw in sys.stdin.buffer:
            try:
                request = json.loads(raw.decode('utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON number.')))
                if request.get('workspacePath') is not None:
                    roots[request.get('sessionId')] = request['workspacePath']
                worker.handle(request)
                if request.get('operation') == 'close':
                    roots.pop(request.get('sessionId'), None)
            except Exception as error:
                emit(dict(id=None, ok=False, error=dict(code='electronic-wire', message=str(error))))
    finally:
        worker.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
