"""Execute OpenFOAM commands, either inside a fresh Docker container or locally.

Inside the worker image (which is built FROM the OpenFOAM image) use ``LocalRunner``.
On a host that only has the OpenFOAM *image* (e.g. CI / tests) use ``DockerRunner``.
"""
from __future__ import annotations

import os
import signal
import shlex
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from ..config import Settings, get_settings


@dataclass
class RunResult:
    command: str
    returncode: int
    stdout: str
    #: True when the command was killed by the wall-clock timeout (returncode is
    #: forced to 124). Callers distinguish "solver crashed" from "solver ran out
    #: of budget" — a timed-out transient may still have gradable partial output.
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    def check(self) -> "RunResult":
        if not self.ok:
            tail = "\n".join(self.stdout.splitlines()[-40:])
            raise OpenFOAMError(f"Command failed ({self.returncode}): {self.command}\n{tail}")
        return self


class OpenFOAMError(RuntimeError):
    pass


_ACTIVE_PROCESS_GROUPS: set[int] = set()
_ACTIVE_PROCESS_GROUPS_LOCK = threading.Lock()
_SIGNAL_HANDLERS_INSTALLED = False


def _terminate_process_group(pgid: int, sig: int = signal.SIGTERM) -> None:
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        return


def _kill_active_process_groups() -> None:
    with _ACTIVE_PROCESS_GROUPS_LOCK:
        pgids = list(_ACTIVE_PROCESS_GROUPS)
    for pgid in pgids:
        _terminate_process_group(pgid, signal.SIGTERM)
    for pgid in pgids:
        try:
            os.waitpid(-pgid, os.WNOHANG)
        except ChildProcessError:
            pass
        except OSError:
            pass


def install_subprocess_signal_handlers() -> None:
    """Ensure Celery task termination also stops child OpenFOAM processes.

    Celery revokes the task process, but OpenFOAM solvers are separate children
    and can otherwise keep burning CPU after the job disappears from the queue.
    """
    global _SIGNAL_HANDLERS_INSTALLED
    if _SIGNAL_HANDLERS_INSTALLED:
        return
    if threading.current_thread() is not threading.main_thread():
        return

    def handle(signum, _frame):
        _kill_active_process_groups()
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)
    _SIGNAL_HANDLERS_INSTALLED = True


RunMonitor = Callable[[], None]


def _run_subprocess(
    args: list[str],
    *,
    cwd: Path,
    timeout: int,
    command: str,
    monitor: RunMonitor | None = None,
    monitor_interval: float = 10.0,
) -> RunResult:
    proc = subprocess.Popen(
        args,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    pgid = os.getpgid(proc.pid)
    with _ACTIVE_PROCESS_GROUPS_LOCK:
        _ACTIVE_PROCESS_GROUPS.add(pgid)
    try:
        if monitor is None:
            try:
                stdout, _ = proc.communicate(timeout=timeout)
                return RunResult(command=command, returncode=proc.returncode, stdout=stdout or "")
            except subprocess.TimeoutExpired:
                _terminate_process_group(pgid, signal.SIGTERM)
                try:
                    stdout, _ = proc.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    _terminate_process_group(pgid, signal.SIGKILL)
                    stdout, _ = proc.communicate()
                msg = f"\nCommand timed out after {timeout}s"
                return RunResult(command=command, returncode=124, stdout=(stdout or "") + msg, timed_out=True)

        chunks: list[str] = []

        def read_stdout() -> None:
            if proc.stdout is None:
                return
            for line in proc.stdout:
                chunks.append(line)

        reader = threading.Thread(target=read_stdout, name="openfoam-stdout-reader", daemon=True)
        reader.start()
        started = time.monotonic()
        next_monitor = started
        timed_out = False
        while proc.poll() is None:
            now = time.monotonic()
            if now - started >= timeout:
                timed_out = True
                break
            if now >= next_monitor:
                try:
                    monitor()
                except Exception as exc:  # noqa: BLE001 - monitoring must not crash solver process
                    chunks.append(f"\n[monitor error] {type(exc).__name__}: {exc}\n")
                next_monitor = now + max(0.5, monitor_interval)
            time.sleep(0.2)
        if timed_out:
            _terminate_process_group(pgid, signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                _terminate_process_group(pgid, signal.SIGKILL)
                proc.wait()
            reader.join(timeout=2)
            msg = f"\nCommand timed out after {timeout}s"
            return RunResult(command=command, returncode=124, stdout="".join(chunks) + msg, timed_out=True)
        reader.join(timeout=2)
        return RunResult(command=command, returncode=proc.returncode or 0, stdout="".join(chunks))
    finally:
        with _ACTIVE_PROCESS_GROUPS_LOCK:
            _ACTIVE_PROCESS_GROUPS.discard(pgid)


class Runner:
    """Base class. Subclasses run a shell command with the OpenFOAM environment loaded."""

    #: True if the solver sees the host filesystem (so a mesh can be shared by an
    #: absolute symlink); False when each command runs in a container that mounts
    #: only the case directory (then a shared mesh must be copied in).
    external_paths_visible: bool = True

    def __init__(self, settings: Settings | None = None):
        self.settings = settings or get_settings()

    def run(
        self,
        case_dir: Path,
        command: str,
        timeout: int = 7200,
        monitor: RunMonitor | None = None,
    ) -> RunResult:  # pragma: no cover
        raise NotImplementedError

    # -- high level helpers ------------------------------------------------- #
    def application(
        self,
        case_dir: Path,
        app: str,
        args: str = "",
        timeout: int = 7200,
        monitor: RunMonitor | None = None,
    ) -> RunResult:
        return self.run(case_dir, f"{app} {args}".strip(), timeout=timeout, monitor=monitor)

    def solver(
        self,
        case_dir: Path,
        app: str,
        n_proc: int,
        timeout: int = 7200,
        restart: bool = False,
        monitor: RunMonitor | None = None,
    ) -> RunResult:
        """Run a solver serially or in parallel (decomposePar + mpirun + reconstructPar).

        ``restart=True`` decomposes the latest time (to continue a run, e.g. a transient
        solve started from a converged steady field) instead of the initial 0/ fields.
        """
        if n_proc <= 1:
            return self.run(case_dir, app, timeout=timeout, monitor=monitor)
        decompose = "decomposePar -latestTime -force" if restart else "decomposePar -force"
        steps = (
            f"{decompose} && "
            f"mpirun --allow-run-as-root -np {n_proc} {app} -parallel && "
            f"reconstructPar -latestTime"
        )
        return self.run(case_dir, steps, timeout=timeout, monitor=monitor)


class LocalRunner(Runner):
    def run(
        self,
        case_dir: Path,
        command: str,
        timeout: int = 7200,
        monitor: RunMonitor | None = None,
    ) -> RunResult:
        bashrc = self.settings.openfoam_bashrc
        full = f"source {shlex.quote(bashrc)} >/dev/null 2>&1; {command}"
        return _run_subprocess(
            ["bash", "-lc", full],
            cwd=str(case_dir),
            timeout=timeout,
            command=command,
            monitor=monitor,
        )


class DockerRunner(Runner):
    # Each command runs in a fresh container that mounts only the case dir, so an
    # external symlink to a shared mesh would be a dangling link inside it.
    external_paths_visible = False

    def run(
        self,
        case_dir: Path,
        command: str,
        timeout: int = 7200,
        monitor: RunMonitor | None = None,
    ) -> RunResult:
        bashrc = self.settings.openfoam_bashrc
        inner = f"source {shlex.quote(bashrc)} >/dev/null 2>&1; cd /case && {command}"
        uid, gid = os.getuid(), os.getgid()
        docker_cmd = [
            self.settings.docker_binary,
            "run",
            "--rm",
            "--user",
            f"{uid}:{gid}",
            "-e",
            "HOME=/tmp",
            "-v",
            f"{Path(case_dir).resolve()}:/case",
            "-w",
            "/case",
            self.settings.openfoam_image,
            "bash",
            "-lc",
            inner,
        ]
        return _run_subprocess(
            docker_cmd,
            cwd=case_dir,
            timeout=timeout,
            command=command,
            monitor=monitor,
        )


def get_runner(settings: Settings | None = None) -> Runner:
    settings = settings or get_settings()
    if settings.openfoam_runner == "local":
        return LocalRunner(settings)
    return DockerRunner(settings)
