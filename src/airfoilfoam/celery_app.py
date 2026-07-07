"""Celery application factory."""
from __future__ import annotations

import math

from celery import Celery

from .config import Settings, get_settings
from .models import URANS_FIDELITY_BUDGET_S

#: Fixed per-case teardown/overhead margin on top of the solver + media budgets:
#: meshing, potentialFoam/steady init, y+, foamToVTK conversion, reconstructPar
#: and evidence archiving (hash + tar of the VTU window) all run outside the
#: solver timeout. Named and documented — never inline a bare number here.
TASK_TIME_LIMIT_MARGIN_S = 900


def task_hard_time_limit_s(settings: Settings, total_cases: int = 1) -> int:
    """Hard celery wall ceiling for one ``run_polar`` task (LAST-RESORT backstop).

    Per-case unit, computed from the SAME config source the runtime budgets
    use (no magic constants):

        2 * max(solver_timeout, max(URANS_FIDELITY_BUDGET_S))
                                    (steady init + base/extended/refined URANS
                                     attempts; each transient attempt is capped
                                     by its fidelity-tier wall budget, which
                                     since the 2026-07-07 measured-rate retune
                                     EXCEEDS solver_timeout — full tier
                                     43200 s vs the 7200 s default — plus the
                                     in-run wall-budget guards)
      + media_budget_seconds()      (post-solve media/frame stage budget)
      + TASK_TIME_LIMIT_MARGIN_S    (meshing / y+ / foamToVTK / evidence)

    Worst-case fit (full tier, default settings): steady init
    (rans_solver_timeout 1200 s) + base+extension transient and one refined
    transient, each stopped by the 80% wall-guard fraction of the 43200 s
    tier budget (~34.6 ks each) + media (3600 s) + margin ≈ 75 ks, under the
    2*43200 + 3600 + 900 = 90 900 s per-case ceiling.

    One celery task runs a WHOLE polar job (possibly many chord x speed x AoA
    cases, marched serially under warm start), so the unit scales linearly
    with the job's case count at dispatch time (see the submit endpoint in
    ``api/main.py``); the app-level default below covers the single-case job.

    Hitting this limit means the engine-side stall detector (tasks.py) and the
    media budget both failed — celery SIGKILLs the pool child, which converts
    the job into the ALREADY-HANDLED death class: the runtime heartbeat goes
    stale, the node's lost-running classifier (apps/sweeper/src/reconcile.ts
    ``classifyLostRunning``) cancels + requeues the points, and any broker
    redelivery is discarded by the terminal-result guard in
    ``tasks.run_polar`` (same class as boot reconcile / redelivery).
    """
    solver_ceiling = max(settings.solver_timeout, max(URANS_FIDELITY_BUDGET_S.values()))
    per_case = 2 * solver_ceiling + settings.media_budget_seconds() + TASK_TIME_LIMIT_MARGIN_S
    return int(math.ceil(per_case * max(1, int(total_cases))))


def make_celery() -> Celery:
    settings = get_settings()
    app = Celery("airfoilfoam", broker=settings.broker_url, backend=settings.result_backend)
    app.conf.update(
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        task_track_started=True,
        worker_prefetch_multiplier=1,
        task_acks_late=True,
        # Default (single-case) hard ceiling; the submit endpoint overrides it
        # per dispatch with the job's real case count.
        task_time_limit=task_hard_time_limit_s(settings),
    )
    app.autodiscover_tasks(["airfoilfoam"])
    return app


celery_app = make_celery()

# Ensure tasks are registered when the worker imports this module.
from . import tasks  # noqa: E402,F401
