"""Command-line interface: run polars locally, or launch the API / worker."""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path

from .config import get_settings
from .models import PolarRequest
from .storage import JobStore


def _run(args: argparse.Namespace) -> int:
    from .jobs import execute_job

    request = PolarRequest.model_validate_json(Path(args.request).read_text())
    settings = get_settings()
    store = JobStore(settings)
    job_id = args.job_id or uuid.uuid4().hex
    store.create(job_id, request)
    print(f"Running job {job_id} ({len(request.cases())} cases) ...", file=sys.stderr)
    result = execute_job(job_id, request, store=store, settings=settings)
    print(json.dumps(json.loads(result.model_dump_json()), indent=2))
    print(f"\nResults in {store.job_dir(job_id)}", file=sys.stderr)
    return 0 if result.state.value == "completed" else 1


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("airfoilfoam.api.main:app", host=args.host, port=args.port)
    return 0


def _worker(args: argparse.Namespace) -> int:
    from .celery_app import celery_app

    celery_app.worker_main(["worker", "--loglevel=info", f"--concurrency={args.concurrency}"])
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="airfoilfoam", description="Airfoil polar CFD via OpenFOAM")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="Run a polar request JSON synchronously (no broker)")
    p_run.add_argument("request", help="Path to a PolarRequest JSON file")
    p_run.add_argument("--job-id", default=None)
    p_run.set_defaults(func=_run)

    p_serve = sub.add_parser("serve", help="Run the HTTP API")
    p_serve.add_argument("--host", default="0.0.0.0")
    p_serve.add_argument("--port", type=int, default=8000)
    p_serve.set_defaults(func=_serve)

    p_worker = sub.add_parser("worker", help="Run a Celery worker")
    p_worker.add_argument("--concurrency", type=int, default=4)
    p_worker.set_defaults(func=_worker)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
