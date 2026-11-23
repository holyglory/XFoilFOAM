"""Substitute only Docker/volume probes; psql and all rewrite SQL are real."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess


def module(path):
    spec = importlib.util.spec_from_file_location("rewrite_server", path)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj


def install(host):
    if os.environ.get("HZ_REPORT_REWRITE_DISPOSABLE") != "1":
        raise RuntimeError("This adapter requires a Coordinator disposable database")
    actual_command = host.command
    saved = Path(os.environ["COMPACTION_STATES"])
    ids = json.loads(os.environ["COMPACTION_IDS"])
    mount = Path(os.environ["REWRITE_TEST_MOUNT"])
    dev = str(mount.stat().st_dev)

    def psql(pg, tag, seconds, write=False):
        options = f"-c application_name={tag} -c statement_timeout={seconds * 1000} -c lock_timeout=3000"
        if not write:
            options += " -c default_transaction_read_only=on"
        return [
            "env",
            "PGOPTIONS=" + options,
            "PGAPPNAME=" + tag,
            "psql",
            "-XwqAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-d",
            os.environ["DATABASE_URL"],
        ]

    def command(argv, **kwargs):
        if argv[:2] == ["docker", "exec"] and "hz_auxiliary_files" in argv:
            # Use the actual run-owned PG container for filesystem block
            # accounting. Only Compose/service lifecycle is substituted.
            run = os.environ["DEVCOORDINATOR_RUN_ID"]
            candidates = subprocess.check_output(
                [
                    "/usr/bin/docker",
                    "ps",
                    "--filter",
                    "label=devcoordinator2.run=" + run,
                    "--format",
                    "{{.ID}}",
                ],
                text=True,
            ).split()
            matches = []
            for cid in candidates:
                ports = json.loads(
                    subprocess.check_output(
                        [
                            "/usr/bin/docker",
                            "inspect",
                            "--format",
                            "{{json .NetworkSettings.Ports}}",
                            cid,
                        ],
                        text=True,
                    )
                )
                if any(
                    v.get("HostPort") == os.environ["PGPORT"]
                    for v in (ports.get("5432/tcp") or [])
                ):
                    matches.append(cid)
            if len(matches) != 1:
                raise ValueError(
                    "Expected one disposable PG fixture with the published test port"
                )
            return actual_command(
                ["/usr/bin/docker", "exec", matches[0], *argv[3:]], **kwargs
            )
        if argv[:2] == ["docker", "exec"] and "pg_controldata" in argv[-1]:
            return "1996"
        if argv[:2] == ["docker", "ps"]:
            return "\n".join(
                name + "|False"
                for name in ids
                if json.loads((saved / name).read_text())["state"] == "running"
            )
        if (
            len(argv) >= 4
            and argv[1] == "-c"
            and "WORKER_VOLUMES" not in argv[2]
            and "os.statvfs(host)" in argv[2]
        ):
            states = {}
            for name, ident in ids.items():
                row = json.loads((saved / name).read_text())
                states[name] = (
                    []
                    if row["state"] == "absent"
                    else [
                        {
                            "id": ident,
                            "state": row["state"],
                            "startedAt": row["started"],
                            "restarts": 0,
                        }
                    ]
                )
            disk = {
                "source": "disposable-test-volume",
                "mount": str(mount),
                "sizeBytes": 45 << 30,
                "freeBytes": 40 << 30,
            }
            if os.environ.get("REWRITE_TEST_FAULT") == "space-before":
                disk["freeBytes"] = 1
            return json.dumps(
                {
                    "devices": {dev: disk},
                    "files": {k: dev for k in json.loads(argv[3])},
                    "services": states,
                }
            )
        if argv[:2] == ["docker", "exec"] and "node" in argv:
            return "1"
        if argv[:2] == ["docker", "top"]:
            return "PID COMMAND\n10 pimpleFoam"
        if argv[:2] == ["docker", "inspect"]:
            return "AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver"
        if argv[:2] == ["docker", "exec"] and "pg_wal" in argv[-1]:
            return "32768"
        return actual_command(argv, **kwargs)

    host.pg_command = psql
    host.command = command


def stage_entry():
    import sys

    host = module(
        Path(os.environ["REWRITE_TEST_SOURCE"]) / "hz-worker-report-rewrite-host.py"
    )
    install(host)
    phase, folder, pg = sys.argv[1:]
    marker = Path(folder)
    (marker / ("entered-" + phase)).touch()
    fault = os.environ.get("REWRITE_TEST_FAULT")
    if phase == "rewrite" and fault == "wal-growth":
        host.wal_bytes = lambda _: 100 << 20
    if phase == "identity-after" and fault in ("changed-body", "changed-science"):
        mutation = (
            "UPDATE force_history SET t='[0.000,0.006]'"
            if fault == "changed-science"
            else """UPDATE progressive_worker_reports SET report=report||'{"dataChanged":true}'
                    WHERE sequence=1"""
        )
        subprocess.run(
            [
                "psql",
                "-Xwq",
                "-v",
                "ON_ERROR_STOP=1",
                os.environ["DATABASE_URL"],
                "-c",
                mutation,
            ],
            check=True,
        )
    host.host_phase(phase, marker, pg)
