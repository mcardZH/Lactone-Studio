"""Fixed-cell image choices for the continuous Cartesian PES coordinates."""

from itertools import product

import numpy as np


class FixedCellGeometry:
    """Use a reduced lattice to find actual nearest images in a skew cell."""

    def __init__(self, cell):
        from ase.geometry import minkowski_reduce

        self.vectors = np.asarray(cell['vectors'], dtype=float)
        boundaries = cell['pbc']
        if (self.vectors.shape != (3, 3) or not np.isfinite(self.vectors).all()
                or len(boundaries) != 3 or any(type(value) is not bool for value in boundaries)):
            raise ValueError('Invalid fixed cell or periodic directions')
        self.pbc = np.asarray(boundaries, dtype=bool)
        self.reduced, self.transform = minkowski_reduce(self.vectors, pbc=self.pbc)
        self.inverse = np.linalg.inv(self.reduced)
        offsets = tuple(product(*(range(-1, 2) if active else (0,) for active in self.pbc)))
        self.neighbors = np.array([(0, 0, 0), *(row for row in offsets if any(row))])
        self.translations = self.neighbors @ self.reduced

    @classmethod
    def from_structure(cls, structure):
        cell = structure.get('cell')
        return cls(cell) if cell and any(cell.get('pbc', ())) else None

    def cartesian_offsets(self, images, count):
        shifts = np.asarray(images)
        if (shifts.shape != (count, 3) or shifts.dtype.kind not in 'iu'
                or np.any(shifts[:, ~self.pbc])):
            raise ValueError('Lattice images must be integer triples on periodic axes')
        return shifts @ self.vectors

    def assert_same(self, structure):
        cell = structure.get('cell')
        if (not cell or not np.array_equal(cell.get('pbc'), self.pbc)
                or np.shape(cell.get('vectors')) != (3, 3)
                or not np.allclose(cell['vectors'], self.vectors, atol=1e-8, rtol=0.)):
            raise ValueError('Path snapshots require the same fixed cell and periodic directions')

    def minimum_image(self, displacements):
        """Return vectors and original-cell integer shifts, rather than wrapped positions."""
        displacements = np.asarray(displacements, dtype=float)
        flat = displacements.reshape(-1, 3)
        result = np.empty_like(flat)
        images = np.empty(flat.shape, dtype=np.int64)
        # Avoid a 27-fold temporary when computing pair distances for S-IDPP.
        for begin in range(0, len(flat), 4096):
            end = min(begin + 4096, len(flat))
            vectors = flat[begin:end]
            shifts = -np.floor(vectors @ self.inverse).astype(np.int64) * self.pbc
            base = vectors + (shifts @ self.transform) @ self.vectors
            candidates = base[:, None] + self.translations
            nearest = np.einsum('ijk,ijk->ij', candidates, candidates).argmin(axis=1)
            result[begin:end] = candidates[np.arange(len(vectors)), nearest]
            images[begin:end] = (shifts + self.neighbors[nearest]) @ self.transform
        return result.reshape(displacements.shape), images.reshape(displacements.shape)

    def coordinate_images(self, points):
        """Unwrap along an ordered B/A/D once, from its reference geometry."""
        _, shifts = self.minimum_image(np.diff(points, axis=0))
        return np.vstack((np.zeros((1, 3), dtype=np.int64), shifts.cumsum(axis=0)))

    def pair_distances(self, positions):
        deltas, _ = self.minimum_image(positions[:, None] - positions[None, :])
        return np.linalg.norm(deltas, axis=2)
