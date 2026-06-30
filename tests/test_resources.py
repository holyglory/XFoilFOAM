from __future__ import annotations

import json
import os

import pytest

from airfoilfoam.config import Settings
from airfoilfoam.models import ResourceParams, ResourcePolicy
from airfoilfoam.resources import CpuTokenPool, resolve_resources


def _settings(tmp_path, *, worker_cpu_budget=4, case_concurrency=4, solver_processes=1):
    return Settings(
        data_dir=tmp_path,
        worker_cpu_budget=worker_cpu_budget,
        cpu_token_state_path=tmp_path / "tokens.json",
        case_concurrency=case_concurrency,
        solver_processes=solver_processes,
        redis_url="redis://127.0.0.1:1/0",
    )


def test_resource_resolver_clamps_case_concurrency_to_cpu_budget(tmp_path):
    settings = _settings(tmp_path, worker_cpu_budget=4, case_concurrency=8, solver_processes=2)
    resolved = resolve_resources(
        ResourceParams(policy=ResourcePolicy.case_parallel, cpu_budget=4, case_concurrency=8),
        settings,
        aoa_case_count=20,
        queue_depth_override=0,
    )
    assert resolved.solver_processes == 2
    assert resolved.resolved_cpu_budget == 4
    assert resolved.resolved_case_concurrency == 2


def test_auto_high_backlog_favors_airfoil_parallel(tmp_path):
    settings = _settings(tmp_path, worker_cpu_budget=8, case_concurrency=8)
    resolved = resolve_resources(ResourceParams(), settings, aoa_case_count=29, queue_depth_override=12)
    assert resolved.resolved_policy == ResourcePolicy.airfoil_parallel
    assert resolved.resolved_case_concurrency == 1


def test_auto_uses_control_plane_queue_pressure_hint(tmp_path):
    settings = _settings(tmp_path, worker_cpu_budget=8, case_concurrency=8)
    resolved = resolve_resources(ResourceParams(queue_pressure=3), settings, aoa_case_count=29, queue_depth_override=0)
    assert resolved.resolved_policy == ResourcePolicy.airfoil_parallel
    assert resolved.resolved_case_concurrency == 1


def test_auto_uses_local_cpu_token_pressure(tmp_path):
    settings = _settings(tmp_path, worker_cpu_budget=4, case_concurrency=4)
    pool = CpuTokenPool(settings.cpu_token_state_path, budget=4)
    with pool.acquire(2):
        resolved = resolve_resources(ResourceParams(), settings, aoa_case_count=12, queue_depth_override=0)
    assert resolved.queue_depth == 2
    assert resolved.resolved_policy == ResourcePolicy.airfoil_parallel
    assert resolved.resolved_case_concurrency == 1


def test_auto_low_backlog_allows_case_parallelism(tmp_path):
    settings = _settings(tmp_path, worker_cpu_budget=8, case_concurrency=4)
    resolved = resolve_resources(ResourceParams(), settings, aoa_case_count=29, queue_depth_override=0)
    assert resolved.resolved_policy == ResourcePolicy.case_parallel
    assert resolved.resolved_case_concurrency == 4


def test_solver_processes_reduce_case_parallelism(tmp_path):
    settings = _settings(tmp_path, worker_cpu_budget=4, case_concurrency=4, solver_processes=1)
    resolved = resolve_resources(
        ResourceParams(policy=ResourcePolicy.case_parallel, cpu_budget=4, solver_processes=2),
        settings,
        aoa_case_count=10,
        queue_depth_override=0,
    )
    assert resolved.solver_processes == 2
    assert resolved.resolved_case_concurrency == 2


def test_cpu_token_pool_prevents_oversubscription(tmp_path):
    pool = CpuTokenPool(tmp_path / "tokens.json", budget=2)
    with pool.acquire(1):
        with pool.acquire(1):
            with pytest.raises(TimeoutError):
                with pool.acquire(1, timeout=0.01, poll_interval=0.001):
                    pass
    with pool.acquire(2, timeout=0.01):
        pass


def test_cpu_token_pool_reports_wait_and_acquire_callbacks(tmp_path):
    pool = CpuTokenPool(tmp_path / "tokens.json", budget=1)
    waits = []
    acquired = []
    with pool.acquire(1):
        with pytest.raises(TimeoutError):
            with pool.acquire(
                1,
                timeout=0.01,
                poll_interval=0.001,
                wait_notice_interval=0.0,
                on_wait=lambda snap: waits.append((snap.used, snap.available)),
            ):
                pass
    with pool.acquire(1, timeout=0.01, on_acquired=lambda snap: acquired.append((snap.used, snap.available))):
        pass
    assert waits
    assert waits[-1] == (1, 0)
    assert acquired == [(1, 0)]


def test_cpu_token_pool_drops_stale_leases_from_prior_worker_runtime(tmp_path):
    path = tmp_path / "tokens.json"
    path.write_text(
        json.dumps(
            {
                "leases": [
                    {
                        "id": "stale",
                        "owner": "previous-worker-runtime",
                        "pid": os.getpid(),
                        "pid_start": "0",
                        "tokens": 2,
                        "ts": 1,
                    }
                ]
            }
        )
    )
    pool = CpuTokenPool(path, budget=2)
    with pool.acquire(2, timeout=0.01):
        pass
    state = json.loads(path.read_text())
    assert state["leases"] == []
