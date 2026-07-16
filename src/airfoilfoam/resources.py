"""CPU-budget aware scheduling for OpenFOAM jobs.

The scheduler has two layers:
- a per-request resolver decides how many AoA cases this job may run at once;
- a worker-local token pool keeps all Celery processes from oversubscribing CPU.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import threading
import time
from typing import Callable, Iterator, Optional
from uuid import uuid4

from redis import Redis

from .config import Settings
from .models import ResourceParams, ResourcePolicy, SchedulingMetadata

_TOKEN_OWNER = uuid4().hex


class CpuTokenBudgetMismatch(RuntimeError):
    """Active workers disagree about the capacity of their shared token pool."""


@dataclass(frozen=True)
class ResolvedResources:
    requested_policy: ResourcePolicy
    resolved_policy: ResourcePolicy
    worker_cpu_budget: int
    resolved_cpu_budget: int
    resolved_case_concurrency: int
    solver_processes: int
    queue_depth: Optional[int] = None

    def metadata(self, *, mesh_build_count: int, aoa_case_count: int, mesh_reuse_mode: str) -> SchedulingMetadata:
        return SchedulingMetadata(
            requested_policy=self.requested_policy,
            resolved_policy=self.resolved_policy,
            worker_cpu_budget=self.worker_cpu_budget,
            resolved_cpu_budget=self.resolved_cpu_budget,
            resolved_case_concurrency=self.resolved_case_concurrency,
            solver_processes=self.solver_processes,
            mesh_build_count=mesh_build_count,
            aoa_case_count=aoa_case_count,
            mesh_reuse_mode="copy" if mesh_reuse_mode == "copy" else "symlink",
            queue_depth=self.queue_depth,
        )


@dataclass(frozen=True)
class TokenSnapshot:
    budget: int
    used: int
    available: int
    leases: list[dict]


def queue_depth(settings: Settings) -> Optional[int]:
    try:
        client = Redis.from_url(settings.broker_url, socket_connect_timeout=0.2, socket_timeout=0.2)
        return int(client.llen(settings.celery_queue))
    except Exception:
        return None


def cpu_token_pressure(settings: Settings) -> Optional[int]:
    """Best-effort count of live worker-local CPU tokens already leased."""
    try:
        pool = CpuTokenPool(
            settings.cpu_token_state_path,
            settings.resolved_worker_cpu_budget(),
            foreign_lease_ttl=settings.cpu_token_lease_ttl_seconds,
        )
        return pool.snapshot().used
    except Exception:
        return None


def resolve_resources(
    resources: ResourceParams,
    settings: Settings,
    aoa_case_count: int,
    *,
    queue_depth_override: Optional[int] = None,
) -> ResolvedResources:
    worker_budget = max(1, settings.resolved_worker_cpu_budget())
    requested_policy = resources.policy
    if resources.queue_pressure is not None:
        depth = resources.queue_pressure
    elif queue_depth_override is not None:
        depth = queue_depth_override
    else:
        depth = queue_depth(settings)
    local_pressure = cpu_token_pressure(settings)
    if local_pressure is not None:
        depth = max(depth or 0, local_pressure)
    solver_processes = max(1, min(resources.solver_processes or settings.solver_processes, worker_budget))

    if requested_policy == ResourcePolicy.auto:
        resolved_policy = ResourcePolicy.airfoil_parallel if (depth or 0) > 0 else ResourcePolicy.case_parallel
    else:
        resolved_policy = requested_policy

    if resources.cpu_budget is not None:
        cpu_budget = max(solver_processes, min(int(resources.cpu_budget), worker_budget))
    elif resolved_policy == ResourcePolicy.exclusive:
        cpu_budget = worker_budget
    elif resolved_policy == ResourcePolicy.airfoil_parallel:
        cpu_budget = solver_processes
    else:
        cpu_budget = min(worker_budget, max(solver_processes, settings.case_concurrency * solver_processes))

    max_cases_by_budget = max(1, cpu_budget // solver_processes)
    if resources.case_concurrency is not None:
        case_concurrency = int(resources.case_concurrency)
    elif resolved_policy == ResourcePolicy.airfoil_parallel:
        case_concurrency = 1
    else:
        case_concurrency = settings.case_concurrency

    case_concurrency = max(1, min(case_concurrency, max_cases_by_budget, max(1, aoa_case_count)))
    cpu_budget = max(solver_processes, min(cpu_budget, worker_budget))
    return ResolvedResources(
        requested_policy=requested_policy,
        resolved_policy=resolved_policy,
        worker_cpu_budget=worker_budget,
        resolved_cpu_budget=cpu_budget,
        resolved_case_concurrency=case_concurrency,
        solver_processes=solver_processes,
        queue_depth=depth,
    )


class CpuTokenPool:
    def __init__(
        self,
        path: Path,
        budget: int,
        *,
        foreign_lease_ttl: float = 120.0,
        owner: str | None = None,
    ):
        self.path = path
        self.budget = max(1, int(budget))
        self.foreign_lease_ttl = max(0.05, float(foreign_lease_ttl))
        # Capture the runtime owner at construction. Tests may provide a
        # second owner to model another container sharing the same state file.
        self.owner = owner or _TOKEN_OWNER

    @contextmanager
    def acquire(
        self,
        tokens: int,
        *,
        timeout: float | None = None,
        poll_interval: float = 0.1,
        on_wait: Optional[Callable[[TokenSnapshot], None]] = None,
        on_acquired: Optional[Callable[[TokenSnapshot], None]] = None,
        wait_notice_interval: float = 5.0,
    ) -> Iterator[None]:
        lease_id = uuid4().hex
        tokens = max(1, min(int(tokens), self.budget))
        deadline = None if timeout is None else time.monotonic() + timeout
        last_wait_notice = 0.0
        while True:
            if self._try_acquire(lease_id, tokens):
                if on_acquired:
                    on_acquired(self.snapshot())
                break
            now = time.monotonic()
            if on_wait and now - last_wait_notice >= wait_notice_interval:
                on_wait(self.snapshot())
                last_wait_notice = now
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"timed out waiting for {tokens} CPU token(s)")
            time.sleep(poll_interval)
        heartbeat_stop = threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat_loop,
            args=(lease_id, heartbeat_stop),
            name=f"cpu-token-{lease_id[:8]}",
            daemon=True,
        )
        heartbeat.start()
        try:
            yield
        finally:
            heartbeat_stop.set()
            heartbeat.join(timeout=max(0.1, self.foreign_lease_ttl / 3.0))
            self._release(lease_id)

    def snapshot(self) -> TokenSnapshot:
        def read(state):
            used = sum(int(lease.get("tokens", 0)) for lease in state["leases"])
            return TokenSnapshot(
                budget=self.budget,
                used=used,
                available=max(0, self.budget - used),
                leases=list(state["leases"]),
            )

        return self._with_state(read)

    def _with_state(self, fn):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a+", encoding="utf-8") as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            f.seek(0)
            raw = f.read().strip()
            try:
                state = json.loads(raw) if raw else {"leases": []}
            except json.JSONDecodeError:
                state = {"leases": []}
            now = time.time()
            state["leases"] = [
                lease
                for lease in state.get("leases", [])
                if _lease_alive(
                    lease,
                    current_owner=self.owner,
                    now=now,
                    foreign_ttl=self.foreign_lease_ttl,
                )
            ]
            active_budgets = {
                int(lease["budget"])
                for lease in state["leases"]
                if lease.get("budget") is not None
            }
            if any(
                lease.get("owner") != self.owner and lease.get("budget") is None
                for lease in state["leases"]
            ):
                raise CpuTokenBudgetMismatch(
                    "shared CPU-token budget is unknown for a live foreign worker lease"
                )
            if active_budgets and active_budgets != {self.budget}:
                raise CpuTokenBudgetMismatch(
                    "shared CPU-token budget mismatch: active worker budget(s) "
                    f"{sorted(active_budgets)}, this worker budget {self.budget}"
                )
            state["budget"] = self.budget
            result = fn(state)
            f.seek(0)
            f.truncate()
            json.dump(state, f)
            f.flush()
            os.fsync(f.fileno())
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            return result

    def _try_acquire(self, lease_id: str, tokens: int) -> bool:
        def edit(state):
            used = sum(int(lease.get("tokens", 0)) for lease in state["leases"])
            if used + tokens > self.budget:
                return False
            state["leases"].append(
                {
                    "id": lease_id,
                    "owner": self.owner,
                    "pid": os.getpid(),
                    "pid_start": _pid_start_time(os.getpid()),
                    "tokens": tokens,
                    "budget": self.budget,
                    "ts": time.time(),
                    "heartbeat_at": time.time(),
                }
            )
            return True

        return bool(self._with_state(edit))

    def _release(self, lease_id: str) -> None:
        def edit(state):
            state["leases"] = [lease for lease in state["leases"] if lease.get("id") != lease_id]

        self._with_state(edit)

    def _heartbeat_loop(self, lease_id: str, stop: threading.Event) -> None:
        interval = max(0.01, min(5.0, self.foreign_lease_ttl / 3.0))
        while not stop.wait(interval):
            try:
                def edit(state):
                    for lease in state["leases"]:
                        if lease.get("id") == lease_id and lease.get("owner") == self.owner:
                            lease["heartbeat_at"] = time.time()
                            return True
                    return False

                if not self._with_state(edit):
                    return
            except Exception:  # noqa: BLE001 - acquisition owner releases in finally
                # A transient state-file error must not kill the holder thread;
                # retry before the foreign-worker TTL expires.
                continue


def _lease_alive(
    lease: dict,
    *,
    current_owner: str,
    now: float,
    foreign_ttl: float,
) -> bool:
    if lease.get("owner") != current_owner:
        heartbeat_at = lease.get("heartbeat_at", lease.get("ts"))
        try:
            return now - float(heartbeat_at) <= foreign_ttl
        except (TypeError, ValueError):
            return False
    pid = int(lease.get("pid", -1))
    if not _pid_alive(pid):
        return False
    pid_start = lease.get("pid_start")
    return pid_start is None or str(pid_start) == str(_pid_start_time(pid))


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _pid_start_time(pid: int) -> str | None:
    try:
        # Field 22 in /proc/<pid>/stat is the process start time in clock ticks.
        return Path(f"/proc/{pid}/stat").read_text().split()[21]
    except Exception:
        return None
