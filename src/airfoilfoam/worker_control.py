from __future__ import annotations

import json

from celery.worker.control import control_command

from .config import get_settings
from .execution_stop import _namespace_identity, execution_stop_proof
from .models import EngineIdentity
from .storage import JobStore


def execute_worker_control(action: str, job_id: str, execution_pool: str, expected_engine: dict) -> dict:
    settings = get_settings()
    identity = settings.engine_identity()
    response = {"job_id": job_id, "execution_pool": settings.celery_queue,
                "engine": identity.model_dump(mode="json"), "owner_matched": False}
    requested = EngineIdentity.model_validate(expected_engine)
    if execution_pool != settings.celery_queue or requested.handshake_key != identity.handshake_key:
        return {**response, "error": "Execution control belongs to another engine pool"}
    store = JobStore(settings)
    if not store.exists(job_id):
        return {**response, "error": "Job is unavailable on this worker"}
    owner = store.job_dir(job_id) / ".execution-owner.json"
    if owner.exists() and json.loads(owner.read_text()) != _namespace_identity():
        return {**response, "error": "Job belongs to another process namespace"}
    if action == "inspect":
        receipt = execution_stop_proof(store, job_id)
    elif action == "reap":
        from .tasks import kill_job_processes
        receipt = kill_job_processes.run(job_id)
    else:
        raise ValueError("Unknown worker execution control")
    return {**response, "owner_matched": True, "receipt": receipt}


def register_worker_controls() -> None:
    @control_command(name="airfoilfoam_inspect_execution", visible=False)
    def inspect_execution(_state, job_id, execution_pool, expected_engine, **_kwargs):
        return execute_worker_control("inspect", job_id, execution_pool, expected_engine)

    @control_command(name="airfoilfoam_reap_execution", visible=False)
    def reap_execution(_state, job_id, execution_pool, expected_engine, **_kwargs):
        return execute_worker_control("reap", job_id, execution_pool, expected_engine)


def request_worker_control(action: str, job_id: str, execution_pool: str, expected_engine: EngineIdentity) -> dict:
    from .celery_app import celery_app

    commands = {"inspect": "airfoilfoam_inspect_execution", "reap": "airfoilfoam_reap_execution"}
    if action not in commands:
        raise ValueError("Unknown worker execution control")
    queues = celery_app.control.inspect(timeout=1).active_queues() or {}
    workers = sorted(
        worker for worker, bindings in queues.items()
        if isinstance(bindings, list) and any(isinstance(binding, dict) and binding.get("name") == execution_pool for binding in bindings)
    )
    if not workers:
        raise RuntimeError("No live worker serves the requested execution pool")
    replies = celery_app.control.broadcast(
        commands[action], destination=workers, reply=True, timeout=3, limit=len(workers),
        arguments={"job_id": job_id, "execution_pool": execution_pool, "expected_engine": expected_engine.model_dump(mode="json")},
    )
    receipts = []
    for reply in replies or []:
        if not isinstance(reply, dict):
            continue
        for worker, value in reply.items():
            if worker not in workers or not isinstance(value, dict) or value.get("owner_matched") is not True:
                continue
            if value.get("job_id") != job_id or value.get("execution_pool") != execution_pool:
                continue
            reported_engine = value.get("engine")
            if not isinstance(reported_engine, dict) or not set(expected_engine.model_dump()).issubset(reported_engine):
                continue
            try:
                identity = EngineIdentity.model_validate(reported_engine)
            except ValueError:
                continue
            if identity.handshake_key == expected_engine.handshake_key and isinstance(value.get("receipt"), dict):
                receipts.append(value["receipt"])
    if not receipts:
        raise RuntimeError("No matching worker returned an execution-control receipt")
    def stopped(receipt):
        proof = receipt.get("stop_proof") if action == "reap" else receipt
        return isinstance(proof, dict) and proof.get("job_id") == job_id and proof.get("execution_stopped") is True
    return next((receipt for receipt in receipts if stopped(receipt)), receipts[0])
