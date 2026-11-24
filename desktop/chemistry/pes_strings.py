"""Local Cartesian normal coordinates for freezing-string node relaxation.

The energy and line-search derivative are a pullback through the same chart.
Hard XYZ masks are exact; nonlinear global equalities use an implicit chart,
not a projected force passed off as a full-XYZ energy derivative.
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import minimize

from pes_core import BOHR_ANGSTROM, PesError
from pes_coordinates import CoordinateError


class FSMChartBoundary(CoordinateError):
    pass


def _nullspace(rows, columns):
    rows = np.asarray(rows, dtype=float).reshape(-1, columns)
    if not len(rows):
        return np.eye(columns)
    _, singular, vt = np.linalg.svd(rows, full_matrices=True)
    threshold = max(rows.shape) * np.finfo(float).eps * max(1., singular[0] if len(singular) else 0.)
    return vt[int(np.count_nonzero(singular > threshold)):].T


class FSMNormalChart:
    """Fixed path-normal variables with an exact equality-manifold pullback.

    x = seed + B z + A lambda(z), F(x)=0. A is the initial constraint
    normal space. The derivative is B-A (J A)^+ J B, from that same F.
    B and A have frozen XYZ rows identically zero. No trial-coordinate clip is
    hidden from L-BFGS-B. An actual Cartesian-box boundary ends this short
    local relaxation and preserves its latest valid candidate.
    """
    def __init__(self, seed, tangent, space, box):
        self.seed = np.asarray(seed, dtype=float).copy()
        self.space, self.box = space, float(box)
        allowed = space.tangent(self.seed)
        projected = allowed.T @ np.asarray(tangent, dtype=float).ravel()
        if np.linalg.norm(projected) <= 1e-12:
            raise PesError('FSM tangent vanished in the allowed Cartesian space')
        excluded = [projected / np.linalg.norm(projected)]
        if len(space.free) == self.seed.size and not space.equations:
            rigid = np.tile(np.eye(3), (len(seed), 1))
            if space.geometry is None:
                centered = self.seed - self.seed.mean(axis=0)
                rotations = np.column_stack([np.cross(axis, centered).ravel() for axis in np.eye(3)])
                rigid = np.column_stack((rigid, rotations))
            excluded.extend((allowed.T @ rigid).T)
        self.basis = allowed @ _nullspace(excluded, allowed.shape[1])
        _, jacobian = space.equations_at(self.seed)
        free_jacobian = jacobian[:, space.free]
        if free_jacobian.size:
            _, singular, vt = np.linalg.svd(free_jacobian, full_matrices=False)
            rank = space._rank(free_jacobian, singular)
            self.normal = np.zeros((self.seed.size, rank))
            self.normal[space.free] = vt[:rank].T
        else:
            self.normal = np.zeros((self.seed.size, 0))
        self.scale = np.maximum(np.linalg.norm(jacobian, axis=1), 1.)
        row_sum = np.max(np.sum(np.abs(self.basis), axis=1)) if self.basis.shape[1] else 0.
        self.half_width = self.box / row_sum if row_sum else self.box

    @property
    def dimension(self):
        return self.basis.shape[1]

    def positions_and_jacobian(self, variables):
        z = np.asarray(variables, dtype=float)
        if z.shape != (self.dimension,) or not np.isfinite(z).all():
            raise CoordinateError('Invalid FSM normal-coordinate variables')
        base = self.seed.ravel() + self.basis @ z
        lam = np.zeros(self.normal.shape[1])
        for _ in range(100):
            xyz = (base + self.normal @ lam).reshape(self.seed.shape)
            residual, jacobian = self.space.equations_at(xyz)
            if not len(residual) or np.max(np.abs(residual)) <= 1e-10:
                break
            if not self.normal.shape[1]:
                raise CoordinateError('FSM equality has no local correction direction')
            correction = np.linalg.lstsq((jacobian @ self.normal) / self.scale[:, None],
                                         -residual / self.scale, rcond=None)[0]
            error = np.linalg.norm(residual / self.scale)
            for fraction in (1., .5, .25, .125, .0625, .03125):
                trial = (base + self.normal @ (lam + fraction * correction)).reshape(self.seed.shape)
                updated = self.space.equations_at(trial)[0]
                if np.linalg.norm(updated / self.scale) < error:
                    lam += fraction * correction
                    break
            else:
                raise CoordinateError('FSM local equality chart could not retract this trial')
        else:
            raise CoordinateError('FSM local equality chart did not converge')
        # The mask is structural (zero rows in both bases), never a display fix.
        if not np.array_equal(xyz[self.space.frozen], self.seed[self.space.frozen]):
            raise CoordinateError('FSM local chart changed a frozen XYZ coordinate')
        if np.max(np.abs(xyz - self.seed)) > self.box + 1e-12:
            raise FSMChartBoundary('FSM local Cartesian component boundary reached')
        derivative = self.basis.copy()
        if self.normal.shape[1]:
            derivative -= self.normal @ np.linalg.lstsq(jacobian @ self.normal,
                                                         jacobian @ self.basis, rcond=None)[0]
        return xyz, derivative


def optimize_fsm_node(seed, tangent, ctx, node_steps, line_search, box, *, node_id, observe=None):
    chart = FSMNormalChart(seed, tangent, ctx.constraints, box)
    last = None
    evaluations = 0
    accepted_iterations = 0

    def accepted(_variables):
        nonlocal accepted_iterations
        accepted_iterations += 1

    def objective(variables):
        nonlocal last, evaluations
        ctx.check_cancelled()
        xyz, derivative = chart.positions_and_jacobian(variables)
        raw = ctx.evaluate(xyz, node_id=node_id)
        evaluations += 1
        last = (xyz.copy(), float(raw['energyHartree']))
        if observe is not None:
            observe(*last)
        gradient = derivative.T @ np.asarray(raw['gradientHartreePerBohr']).ravel() / BOHR_ANGSTROM
        return last[1], gradient

    initial = np.zeros(chart.dimension)
    objective(initial)
    boundary = None
    if chart.dimension:
        try:
            fit = minimize(objective, initial, method='L-BFGS-B', jac=True,
                           bounds=[(-chart.half_width, chart.half_width)] * chart.dimension,
                           options={'maxiter': node_steps, 'maxls': line_search}, callback=accepted)
            xyz, _ = chart.positions_and_jacobian(fit.x)
            if last is None or not np.array_equal(last[0], xyz):
                objective(fit.x)
            iterations, status, message = int(fit.nit), int(fit.status), str(fit.message)
        except (FSMChartBoundary, CoordinateError) as error:
            boundary = str(error)
            iterations, status, message = accepted_iterations, 2, boundary
    else:
        iterations, status, message = 0, 0, 'No movable path-normal Cartesian variables'
    if last is None:
        raise PesError('FSM local relaxation returned no valid candidate')
    xyz, energy = last
    return xyz, energy, dict(iterations=iterations, optimizerStatus=status, optimizerMessage=message,
                            localEvaluations=evaluations, normalVariables=chart.dimension,
                            derivative='physical-energy pullback through fixed normal equality chart',
                            localBoundary=boundary,
                            maximumComponentShiftAngstrom=float(np.max(np.abs(xyz - seed))))
