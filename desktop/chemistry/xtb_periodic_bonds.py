"""GFN2 atom-pair bond orders in the existing full XYZ-periodic run cell.

tblite's Mayer-Wiberg matrix aggregates the periodic electronic structure for
each original atom pair. It has no image index and is never image-resolved.
"""
from __future__ import annotations
import copy
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import threading
import time

import numpy as np
from xtb_periodic import BOHR_ANGSTROM, Cancelled, ELEMENTS, require, validate


def pair_orders(matrix, atoms):
    raw = np.asarray(matrix, dtype=float)
    count = len(atoms)
    require(raw.shape in ((count, count), (count, count, 1), (count, count, 2)) and np.isfinite(raw).all(),
            'Incomplete or nonfinite tblite atom-pair bond-order matrix')
    # tblite 0.7 post_processing/wbo -> wavefunction/mulliken ends in
    # updown_to_magnet: channel 0 is total, channel 1 magnetization, not alpha/
    # beta. Preserve raw channels and select total; do not sum the channels.
    values = raw if raw.ndim == 2 else raw[:, :, 0]
    require(np.allclose(values, values.T, rtol=1e-10, atol=1e-10),
            'Asymmetric tblite atom-pair bond-order matrix')
    # Keep the original upper-triangle values, without rounding, clamping,
    # filtering negative values, assigning images, or manufacturing missing 0s.
    entries = [dict(atomIds=[atoms[i]['id'], atoms[j]['id']], value=float(values[i, j]))
               for i in range(count) for j in range(i + 1, count)]
    result = dict(definition='mayer-wiberg', sourceField='tblite:bond-orders',
                  threshold=0, entries=entries)
    return result


class PeriodicBondEvaluator:
    def __init__(self, request, runtime, workspace, cancel=None):
        require(request.get('method') == 'gfn2' and request.get('calculation') == 'singlepoint',
                'Periodic bond orders require a GFN2 singlepoint')
        # Reuse geometry/electron/resource validation, without claiming or
        # initializing an optimizer; frozen atoms need not be movable for SP.
        normalized = copy.deepcopy(request)
        normalized.update(calculation='optimize', frozenAtomIds=[])
        self.initial, self.vectors, _ = validate(normalized)
        ids = [atom['id'] for atom in request['structure']['atoms']]
        frozen = request.get('frozenAtomIds', [])
        require(isinstance(frozen, list) and len(set(frozen)) == len(frozen) and all(atom_id in ids for atom_id in frozen),
                'Invalid fixed atom identities')
        self.request = copy.deepcopy(request)
        self.workspace = Path(workspace).resolve()
        require(self.workspace.is_dir() and not self.workspace.is_symlink(),
                'Owned workspace must already exist')
        self.cancel = cancel or threading.Event()
        self.started = time.monotonic()
        self.current = None
        self.history = []
        self.observer = lambda _event: None
        self.logs = []
        self.log_bytes = 0
        # Frozen imports and distribution metadata must initialize before the
        # worker's control thread can block in os.read. Keep this lazy to the
        # singlepoint evaluator; constructing a Calculator still happens only
        # on the explicit calculation path below.
        self.current_check()
        from tblite.interface import Calculator
        from tblite.library import get_version
        self.calculator_type = Calculator
        self.version = importlib.metadata.version('tblite')
        self.library_version = '.'.join(map(str, get_version()))
        self.current_check()

    def current_check(self):
        if self.cancel.is_set():
            raise Cancelled('Periodic bond-order calculation cancelled')
        limit = self.request.get('maxWallTimeSeconds')
        require(limit is None or time.monotonic() - self.started < limit,
                'Periodic bond-order wall budget exceeded')

    def optimize(self, _emit):
        # This method name only shares the worker protocol. No coordinates are
        # variables and no optimizer is imported or called on this route.
        self.current_check()
        parameters = dict(method='GFN2-xTB', accuracy=1.0,
                          maxIterations=self.request.get('maxSccIterations', 250),
                          electronicTemperatureHartree=0.0009500)
        atoms = self.request['structure']['atoms']

        def logger(message):
            self.current_check()
            text = str(message)
            self.log_bytes += len(text.encode('utf-8'))
            self.logs.append(text)

        try:
            calc = self.calculator_type('GFN2-xTB',
                              np.asarray([ELEMENTS.index(atom['element']) + 1 for atom in atoms]),
                              self.initial / BOHR_ANGSTROM,
                              charge=self.request['charge'], uhf=self.request['uhf'],
                              lattice=self.vectors / BOHR_ANGSTROM,
                              periodic=np.asarray([True, True, True]), logger=logger)
            calc.set('accuracy', parameters['accuracy'])
            calc.set('max-iter', parameters['maxIterations'])
            calc.set('temperature', parameters['electronicTemperatureHartree'])
            calc.add('bond-orders')
            self.current_check()
            result = calc.singlepoint()
            self.current_check()
            energy = float(result.get('energy'))
            require(math.isfinite(energy), 'Nonfinite tblite singlepoint energy')
            matrix = np.asarray(result.get('bond-orders'), dtype=float)
            # The raw matrix is authoritative, including diagonal/self-image
            # contributions which cannot safely be associated with one image.
            with (self.workspace / 'bond-orders.npy').open('xb') as handle:
                np.save(handle, matrix, allow_pickle=False)
            orders = pair_orders(matrix, atoms)
            periodic = dict(sourceCell=copy.deepcopy(self.request['structure']['cell']),
                            sourcePbc=list(self.request['structure']['cell']['pbc']),
                            effectivePbc=[True, True, True], fixedCell=True,
                            backend='tblite-api', bondOrderScope='atom-pair-periodic-aggregate',
                            imageResolved=False, version=self.version, libraryVersion=self.library_version,
                            parameters=parameters)
            evidence = dict(schema='sciyue-periodic-pair-bond-orders-v1',
                            request=self.request, energyHartree=energy, periodic=periodic,
                            bondOrders=orders, rawMatrixFile='bond-orders.npy',
                            rawMatrixShape=list(matrix.shape),
                            rawMatrixSha256=hashlib.sha256((self.workspace / 'bond-orders.npy').read_bytes()).hexdigest())
            with (self.workspace / 'bond-orders.json').open('x', encoding='utf-8') as handle:
                json.dump(evidence, handle, indent=2, allow_nan=False)
                handle.write('\n')
            self.current_check()
            return dict(kind='completed', nativeClosed=True,
                        coordinates=[{key: atom[key] for key in ('id', 'element', 'x', 'y', 'z')} for atom in atoms],
                        energyHartree=energy, periodic=periodic, bondOrders=orders)
        finally:
            with (self.workspace / 'tblite.log').open('x', encoding='utf-8') as handle:
                handle.write('\n'.join(self.logs) + '\n')
