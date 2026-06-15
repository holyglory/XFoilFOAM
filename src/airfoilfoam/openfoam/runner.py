"""Execute OpenFOAM commands, either inside a fresh Docker container or locally.

Inside the worker image (which is built FROM the OpenFOAM image) use ``LocalRunner``.
On a host that only has the OpenFOAM *image* (e.g. CI / tests) use ``DockerRunner``.
"""
from __future__ import annotations

import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ..config import Settings, get_settings


@dataclass
class RunResult:
    command: str
    returncode: int
    stdout: str

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


class Runner:
    """Base class. Subclasses run a shell command with the OpenFOAM environment loaded."""

    def __init__(self, settings: Settings | None = None):
        self.settings = settings or get_settings()

    def run(self, case_dir: Path, command: str, timeout: int = 7200) -> RunResult:  # pragma: no cover
        raise NotImplementedError

    # -- high level helpers ------------------------------------------------- #
    def application(self, case_dir: Path, app: str, args: str = "", timeout: int = 7200) -> RunResult:
        return self.run(case_dir, f"{app} {args}".strip(), timeout=timeout)

    def solver(
        self, case_dir: Path, app: str, n_proc: int, timeout: int = 7200, restart: bool = False
    ) -> RunResult:
        """Run a solver serially or in parallel (decomposePar + mpirun + reconstructPar).

        ``restart=True`` decomposes the latest time (to continue a run, e.g. a transient
        solve started from a converged steady field) instead of the initial 0/ fields.
        """
        if n_proc <= 1:
            return self.run(case_dir, app, timeout=timeout)
        decompose = "decomposePar -latestTime -force" if restart else "decomposePar -force"
        steps = (
            f"{decompose} && "
            f"mpirun --allow-run-as-root -np {n_proc} {app} -parallel && "
            f"reconstructPar -latestTime"
        )
        return self.run(case_dir, steps, timeout=timeout)


class LocalRunner(Runner):
    def run(self, case_dir: Path, command: str, timeout: int = 7200) -> RunResult:
        bashrc = self.settings.openfoam_bashrc
        full = f"source {shlex.quote(bashrc)} >/dev/null 2>&1; {command}"
        proc = subprocess.run(
            ["bash", "-lc", full],
            cwd=str(case_dir),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return RunResult(command=command, returncode=proc.returncode, stdout=proc.stdout + proc.stderr)


class DockerRunner(Runner):
    def run(self, case_dir: Path, command: str, timeout: int = 7200) -> RunResult:
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
        proc = subprocess.run(docker_cmd, capture_output=True, text=True, timeout=timeout)
        return RunResult(
            command=command,
            returncode=proc.returncode,
            stdout=proc.stdout + proc.stderr,
        )


def get_runner(settings: Settings | None = None) -> Runner:
    settings = settings or get_settings()
    if settings.openfoam_runner == "local":
        return LocalRunner(settings)
    return DockerRunner(settings)
