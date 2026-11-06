"""Relativize controlled Fortran input filenames; preserve all compiler options."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

root = Path(sys.argv[1]).resolve()
original = sys.argv[2:]
command = original.copy()
changes = []
for i, value in enumerate(command[1:], 1):
    candidate = Path(value)
    if not candidate.is_absolute() or candidate.suffix.lower() not in ('.f90', '.f', '.f95', '.f03', '.f08'):
        continue
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root) or not resolved.is_file():
        continue
    relative = os.path.relpath(resolved, Path.cwd()).replace('\\', '/')
    command[i] = relative
    changes.append({'index': i, 'before': value, 'after': relative})
log_root = Path(os.environ.get('ES_COMPILER_ARGV_LOG_DIR', root.parent / 'compiler-argv'))
log_root.mkdir(parents=True, exist_ok=True)
(log_root / (str(uuid.uuid4()) + '.json')).write_text(json.dumps({'cwd': str(Path.cwd()), 'original': original,
    'actual': command, 'changes': changes}, indent=2)+'\n', encoding='utf-8')
raise SystemExit(subprocess.call(command))
