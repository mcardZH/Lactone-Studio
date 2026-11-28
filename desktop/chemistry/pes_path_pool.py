"""Independent, stable one-thread electronic lanes for a single two-ended path."""
from __future__ import annotations

import json
import os
from pathlib import Path
from queue import Empty, Queue
import signal
import subprocess
import sys
import threading

import numpy as np

from pes_core import PesCancelled, PesError, make_context

_COUNTS = ('physicalEvaluations', 'attemptedPhysicalEvaluations', 'libxtbEvaluations',
           'attemptedLibxtbEvaluations', 'coldStarts', 'warmStarts', 'nativeInvocations',
           'failedElectronicEvaluations', 'createdElectronicNodes', 'releasedElectronicNodes',
           'activeElectronicNodes')


def _lane_evidence(context):
    evidence = context.provenance()
    fields = ('engine', 'providerInterface', 'threads', *_COUNTS)
    return {key: evidence[key] for key in fields if key in evidence}


def path_lane_count(request):
    if (request.get('operation') != 'path' or request.get('algorithm') not in ('ci-neb', 'fsm')
            or request.get('method') not in ('gfn0', 'gfn1', 'gfn2', 'gfnff')):
        return 1
    options = request.get('parameters', {})
    lanes, beads = options.get('xtbBatchParallelism', 1), options.get('beads', 12)
    if type(lanes) is not int or type(beads) is not int:
        return 1  # Domain/native request validation owns bad setting diagnostics.
    return max(1, min(lanes, beads))


def _json_value(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(f'Unexpected PES lane value {type(value).__name__}')


def _send(stream, value):
    stream.write((json.dumps(value, separators=(',', ':'), allow_nan=False, default=_json_value) + '\n').encode('utf-8'))
    stream.flush()


def _call(action, ctx, row):
    node_id = row['nodeId']
    partial = None
    try:
        if action == 'evaluate':
            return {'value': ctx.evaluate(row['xyz'], node_id=node_id)}
        if action == 'release':
            ctx.release_node(node_id)
            return {'value': None}
        from pes_strings import optimize_fsm_node

        def observe(xyz, energy):
            nonlocal partial
            partial = (xyz, energy)

        xyz, energy, details = optimize_fsm_node(np.asarray(row['xyz']), np.asarray(row['tangent']), ctx,
            row['nodeSteps'], row['lineSearch'], row['box'], node_id=node_id, observe=observe)
        return {'value': (xyz, energy, details)}
    except Exception as error:
        return {'localException': error, 'partial': partial,
                'error': {'code': getattr(error, 'code', 'PES_PATH_FAILED'), 'message': str(error),
                          'diagnostics': getattr(error, 'diagnostics', None)}}
    finally:
        if action == 'fsm':
            ctx.release_node(node_id)


def _execute(action, ctx, work):
    rows = []
    for item in work:
        observed = _call(action, ctx, item)
        rows.append({'nodeId': item['nodeId'], **observed})
    return rows


def run_path_lane():
    """Child owns exactly one task context. The parent owns command admission."""
    from native_stdin import route_native_output
    from threadpoolctl import threadpool_limits

    workspace = Path.cwd()
    with route_native_output(workspace, filename='lane-native.log', restore=False) as protocol:
        init = json.loads(sys.stdin.buffer.readline())
        if init.get('action') != 'start' or init['request']['threads'] != 1:
            raise ValueError('Invalid PES path lane startup')
        # Do not spawn evaluators or read scientific input before the parent has
        # attached the Windows lifetime guard and sent this private command.
        ctx = make_context(init['request'], init['runtime'], workspace)
        try:
            with threadpool_limits(limits=1):
                _send(protocol, {'action': 'start', 'pid': os.getpid()})
                for line in sys.stdin.buffer:
                    packet = json.loads(line)
                    action = packet['action']
                    if action == 'finish':
                        ctx.close()
                        _send(protocol, {'action': action, 'evidence': _lane_evidence(ctx)})
                        return
                    if action not in ('evaluate', 'release', 'fsm'):
                        raise ValueError('Unknown PES path lane command')
                    rows = _execute(action, ctx, packet['nodes'])
                    for row in rows:
                        row.pop('localException', None)
                    _send(protocol, {'action': action, 'rows': rows,
                                     'evaluations': ctx.evaluations, 'attempts': ctx.evaluation_attempts})
        finally:
            ctx.close()


def _child_command():
    executable = Path(sys.executable).resolve()
    bootstrap = executable.parent.parent / 'bootstrap.py'
    if not bootstrap.is_file():
        raise PesError('PES path lanes require the bundled worker bootstrap', 'PES_PATH_LANE')
    return [str(executable), '-I', '-B', str(bootstrap), '--pes-path-lane']


class _PathLane:
    def __init__(self, command, directory, request, runtime):
        from orbitals import _windows_owned_job

        directory.mkdir()
        env = dict(os.environ, OMP_NUM_THREADS='1', OMP_MAX_ACTIVE_LEVELS='1', OMP_DYNAMIC='FALSE',
                   MKL_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', BLIS_NUM_THREADS='1')
        self.directory, self.evaluations, self.attempts = directory, 0, 0
        self.messages, self.pending = Queue(), None
        self.job = self.reader = None
        with (directory / 'lane-stderr.log').open('xb') as stderr:
            self.child = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                start_new_session=os.name != 'nt')
        try:
            self.job = _windows_owned_job(self.child)
            self.reader = threading.Thread(target=self._read, name=f'pes-path-lane-{self.child.pid}', daemon=True)
            self.reader.start()
            self.send('start', request=request, runtime=runtime)
        except BaseException:
            self.close()
            raise

    def _read(self):
        try:
            for line in self.child.stdout:
                self.messages.put(json.loads(line))
        except (OSError, ValueError) as error:
            self.messages.put(error)
        finally:
            self.messages.put(None)

    def send(self, action, **fields):
        if self.pending is not None:
            raise PesError('PES path lane did not settle its previous request', 'PES_PATH_LANE')
        self.pending = action
        _send(self.child.stdin, {'action': action, **fields})

    def receive(self, ctx):
        while True:
            ctx.check_cancelled()
            try:
                reply = self.messages.get(timeout=.05)
                break
            except Empty:
                continue
        expected, self.pending = self.pending, None
        if not isinstance(reply, dict) or reply.get('action') != expected:
            raise PesError(f'PES path lane {self.child.pid} closed or returned an invalid response',
                           'PES_PATH_LANE', {'directory': str(self.directory), 'detail': str(reply)})
        self.evaluations = reply.get('evaluations', self.evaluations)
        self.attempts = reply.get('attempts', self.attempts)
        return reply

    def close(self, *, graceful=False):
        if graceful and self.child.poll() is None:
            try:
                self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        if self.job is not None:
            kernel, handle = self.job
            kernel.CloseHandle(handle)
            self.job = None
        if self.child.poll() is None:
            if os.name == 'nt':
                self.child.kill()
            else:
                try:
                    os.killpg(self.child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.child.stdin.close()
        self.child.wait()
        if self.reader is not None:
            self.reader.join()
        self.child.stdout.close()


class PathPool:
    supports_evaluation_batch = True

    def __init__(self, request, ctx, lanes):
        self.request, self.base, self.count = request, ctx, lanes
        self.remote, self.lane_by_node = {}, {}
        self.closed, self.healthy = False, True
        self.statistics = None

    def __getattr__(self, name):
        return getattr(self.base, name)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def pin_node(self, node_id, bead_index):
        self.lane_by_node[node_id] = bead_index % self.count

    def _lane(self, lane):
        if lane not in self.remote:
            self.base.check_cancelled()
            process = _PathLane(_child_command(), self.workspace / f'path-lane-{lane + 1:03d}',
                                {**self.request, 'threads': 1}, self.runtime)
            self.remote[lane] = process
        return self.remote[lane]

    def _dispatch(self, action, nodes):
        self.base.check_cancelled()
        work, observed = {}, {}
        for row in nodes:
            lane = self.lane_by_node[row['nodeId']]
            work.setdefault(lane, []).append(row)
        running = {}
        for lane in work:
            if lane != 0:
                try:
                    running[lane] = self._lane(lane)
                except PesCancelled:
                    raise
                except Exception as error:
                    self.healthy = False
                    for row in work[lane]:
                        observed[row['nodeId']] = {'localException': error}
        sent = {}
        for lane, process in running.items():
            try:
                if process.pending == 'start' and process.receive(self.base)['pid'] != process.child.pid:
                    raise PesError('PES path lane process identity changed', 'PES_PATH_LANE')
                process.send(action, nodes=work[lane])
                sent[lane] = process
            except PesCancelled:
                raise
            except Exception as error:
                self.healthy = False
                for row in work[lane]:
                    observed[row['nodeId']] = {'localException': error}
        if 0 in work:
            observed.update((row['nodeId'], row) for row in _execute(action, self.base, work[0]))
        for lane, process in sent.items():
            try:
                rows = process.receive(self.base)['rows']
                if [row['nodeId'] for row in rows] != [row['nodeId'] for row in work[lane]]:
                    raise PesError('PES path lane returned a different set of scientific nodes', 'PES_PATH_LANE')
                observed.update((row['nodeId'], row) for row in rows)
            except PesCancelled:
                raise
            except Exception as error:
                self.healthy = False
                for row in work[lane]:
                    observed[row['nodeId']] = {'localException': error}
        return [observed[row['nodeId']] for row in nodes]

    @staticmethod
    def _error(outcome):
        if 'localException' in outcome:
            return outcome['localException']
        if 'error' in outcome:
            error = outcome['error']
            if error['code'] == 'PES_STOPPED':
                return PesCancelled()
            return PesError(error['message'], error['code'], error.get('diagnostics'))
        return None

    def evaluate_many(self, nodes):
        outcomes = self._dispatch('evaluate', [{'nodeId': node_id, 'xyz': xyz} for node_id, xyz in nodes])
        return [self._error(outcome) or outcome['value'] for outcome in outcomes]

    def optimize_fsm_nodes(self, jobs):
        try:
            outcomes = self._dispatch('fsm', jobs)
            return [(self._error(row) or row['value'], row.get('partial')) for row in outcomes]
        finally:
            for job in jobs:
                self.lane_by_node.pop(job['nodeId'], None)

    def release_nodes(self, node_ids):
        remote_nodes = []
        for node_id in node_ids:
            lane = self.lane_by_node.get(node_id)
            if lane == 0:
                self.base.release_node(node_id)
            elif lane is not None:
                remote_nodes.append({'nodeId': node_id})
        if remote_nodes and self.healthy and not self.base.cancelled():
            for outcome in self._dispatch('release', remote_nodes):
                if self._error(outcome) is not None:
                    self.healthy = False  # Closing the lane still releases the provider.
        for node_id in node_ids:
            self.lane_by_node.pop(node_id, None)

    def close(self):
        if self.closed:
            return
        self.closed = True
        evidence = {}
        errors, finished = [], set()
        try:
            evidence['0'] = dict(pid=os.getpid(), **_lane_evidence(self.base))
            for lane, remote in self.remote.items():
                row = evidence[str(lane)] = {'pid': remote.child.pid, 'physicalEvaluations': remote.evaluations,
                                             'attemptedPhysicalEvaluations': remote.attempts}
                if remote.pending is None and remote.child.poll() is None and not self.base.cancelled():
                    try:
                        remote.send('finish')
                        row.update(remote.receive(self.base)['evidence'])
                        finished.add(lane)
                    except (PesCancelled, OSError, PesError) as error:
                        if not self.base.cancelled():
                            row['cleanupError'] = str(error)
                            errors.append(str(error))
        finally:
            unsettled = []
            for lane, remote in self.remote.items():
                row = evidence.setdefault(str(lane), {'pid': remote.child.pid})
                try:
                    remote.close(graceful=lane in finished)
                except (OSError, RuntimeError) as error:
                    row['cleanupError'] = str(error)
                    errors.append(str(error))
                row['exitCode'] = remote.child.poll()
                if row['exitCode'] is None:
                    unsettled.append(remote.child.pid)
            self.statistics = dict(lanes=self.count, threadsPerLane=1, actualLanes=len(evidence),
                distribution='zero-based bead index modulo granted lane count', workers=evidence, transportHealthy=self.healthy,
                evaluationCountsComplete=len(finished) == len(self.remote),
                **({'cleanupErrors': errors} if errors else {}))
            if unsettled:
                raise PesError(f'PES path lanes did not close: {unsettled}', 'PES_RESOURCE_CLEANUP')

    def result_evidence(self):
        workers = tuple(self.statistics['workers'].values())
        summed = {}
        for key in _COUNTS:
            values = [row[key] for row in workers if type(row.get(key)) is int]
            if values:
                summed[key] = sum(values)
        return {'pathParallelism': self.statistics, **summed}


if __name__ == '__main__':
    run_path_lane()
