"""Private file broker for cross-process testing of real Celery control and its prefork master."""
import os
import time
from pathlib import Path

from celery import Celery


def make_app():
    root = Path(os.environ["HZ_PARKING_TEST_DIR"])
    app = Celery("hz_parking_test", broker="filesystem://")
    app.conf.update(
        broker_transport_options={"data_folder_in": str(root / "queue"), "data_folder_out": str(root / "queue"),
                                  "control_folder": str(root / "bindings"), "polling_interval": 0.03},
        task_default_queue="openfoam-opencfd-2606-numerics-2", worker_prefetch_multiplier=1,
        task_ignore_result=True, task_acks_late=True,
    )
    return app


app = make_app()


@app.task(name="airfoilfoam.run_polar")
def hold_reader(job_id, request):
    root = Path(os.environ["HZ_PARKING_TEST_DIR"])
    (root / "reader-started").write_text(str(os.getpid()))
    until = time.monotonic() + 40
    while not (root / "reader-finished").exists() and time.monotonic() < until:
        (root / "solver-progress").write_text(str(time.monotonic_ns()))
        time.sleep(0.025)
