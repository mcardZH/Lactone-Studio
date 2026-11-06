"""Bounded observation only; no menu, resource, process or scientific policy."""
from __future__ import annotations
import re


def native_output_chunks(stream):
    read = getattr(stream, 'read1', None)
    if read is None:
        yield from iter(stream.readline, b'')
    else:
        while True:
            chunk = read(4096)
            if not chunk:
                return
            yield chunk


def native_output_lines(stream, observe=None):
    """Observe CR/chunks promptly, but preserve the original readline protocol."""
    pending = b''
    for chunk in native_output_chunks(stream):
        if observe is not None:
            try:
                observe(chunk)
            except Exception:
                pass
        pending += chunk
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            yield line + b'\n'
    if pending:
        yield pending


def report_progress(callback, phase, **values):
    if callback is not None:
        try:
            callback(dict(phase=phase, **values))
        except Exception:
            pass  # An observer never changes the underlying scientific work.


class NativeProgressScanner:
    # Existing native grid output uses this explicitly labelled percentage.
    # Other percentages (thresholds, compositions, fit errors) are not progress.
    pattern = re.compile(r'\bProgress:\s*\[[#=\- ]+\]\s*(\d+(?:\.\d+)?)\s*%')

    def __init__(self, callback, stage_id='native-grid'):
        self.callback = callback
        self.stage_id = stage_id
        self.tail = ''
        self.last = None
        self.sweep = 0

    def feed(self, text):
        if self.callback is None:
            return
        self.tail += text
        parts = re.split(r'[\r\n]', self.tail)
        self.tail = parts.pop()[-8192:]
        for part in [*parts, self.tail]:
            for match in self.pattern.finditer(part):
                value = float(match[1])
                if not 0 <= value <= 100 or value == self.last:
                    continue
                if self.last is not None and value < self.last:
                    self.sweep += 1
                self.last = value
                report_progress(self.callback, 'running', stageId=f'{self.stage_id}:{self.sweep}', measure=dict(kind='percent', value=value))
