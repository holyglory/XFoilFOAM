"""Run inside the initialized HZ engine container; stdout contains keys, never requests or broker settings."""
import fcntl
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import sys


# These three installed functions own every mesh-cache read, replacement and explicit
# invalidation in HZ run_polar. Other engine builds must qualify their own recovery ladder.
PINS = {
    "execute_job": "52826f7545a7d9b71f01e0723e3a53a70a934bee7557e6ccaecc203865cf41cf",
    "prepare_mesh": "750c5034089193550c7bb5676bdff0580af700152b0b97e1e50f843658aa3bdd",
    "prepare_mesh_with_recovery": "07c6b2c694a001fcb044a747a04955c41c44921ca305f8d7728d59c4c57572a5",
}


def mesh_keys(request):
    from airfoilfoam import jobs, pipeline as p
    from airfoilfoam.cache import EngineCache
    from airfoilfoam.models import PolarRequest

    req = PolarRequest.model_validate_json(request)
    airfoil = jobs.load_airfoil(req.airfoil.name, req.airfoil.coordinates, req.airfoil.points, req.airfoil.format)
    base, _ = jobs.effective_mesh_params_for_airfoil(
        req.mesh, req.solver, airfoil, urans_mesh=req.urans_mesh, urans_precalc_mesh=req.urans_precalc_mesh
    )
    keys = set()
    for chord in req.chord_lengths:
        for speed in req.speeds:
            spec = jobs.CaseSpec(chord=chord, speed=speed, aoa_deg=0.0)
            resolved = jobs.resolve_mesh_params(base, spec, req.fluid)
            keys.add(EngineCache.mesh_key(airfoil, chord, resolved, mesher=jobs.get_mesher(resolved.mesher)))
            if resolved.mesher != p.MESH_RECOVERY_PUBLIC_MESHER:
                continue
            variants = [(name, jobs.get_mesher(name)) for name in p.MESH_RECOVERY_MESHER_CANDIDATES]
            variants.append(("blockmesh-cgrid-finite-edge", p.BlockMeshCGrid(topology=p.FINITE_EDGE_TOPOLOGY)))
            for name, mesher in variants:
                # Deliberately include both height caps even when the live ladder would omit one.
                for height in (resolved.first_cell_height_chords, p.MESH_RECOVERY_MAX_FIRST_CELL_HEIGHT_CHORDS,
                               p.MESH_RECOVERY_FINE_FIRST_CELL_HEIGHT_CHORDS):
                    candidate = resolved.model_copy(update={"mesher": name, "first_cell_height_chords": height})
                    keys.add(EngineCache.mesh_key(airfoil, chord, candidate, mesher=mesher))
    return keys


RESULTS_ROOT = Path("/data/airfoilfoam")


def control(action, expected=None):
    if action == "inspect":
        return _control(action, expected)
    if action not in ("fence", "restore") or not expected:
        raise ValueError("Unbound reader operation")
    run, epoch = expected["parkingRun"], expected["fenceId"]
    if not all(re.fullmatch("[a-f0-9]{32}", k) for k in (run, epoch)):
        raise ValueError("Invalid reader epoch")
    directory = RESULTS_ROOT / (".hz-cache-parking-" + run) / ("reader-" + epoch)
    if directory.resolve(strict=True) != directory or directory.stat().st_uid != os.geteuid():
        raise ValueError("Reader epoch owner changed")
    # docker exec can outlive a killed SSH/operator process. Serialize with its
    # independent recovery, and permanently reject late cancellation for a revoked epoch.
    with (directory / "rpc.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        revoked = (directory / "revoked.json").exists()
        if revoked != (action == "restore"):
            raise ValueError("Reader epoch revoked or recovery not recorded")
        return _control(action, expected)


def _control(action, expected=None):
    import socket
    from airfoilfoam import jobs, pipeline
    from airfoilfoam.celery_app import celery_app as app
    from airfoilfoam.config import get_settings

    settings = get_settings()
    if str(settings.resolved_cache_dir()) != "/data/airfoilfoam/cache" or settings.engine_identity().compatibility_key != "openfoam:opencfd:2606:numerics-2":
        raise RuntimeError("Worker is not using the qualified HZ cache")
    node = "celery@" + socket.gethostname()
    queue = settings.celery_queue
    ctl = app.control
    inst = ctl.inspect(destination=[node], timeout=4)

    def value(method):
        reply = getattr(inst, method)()
        if not isinstance(reply, dict) or set(reply) != {node}:
            raise RuntimeError("Incomplete worker reply for " + method)
        return reply[node]

    q = value("active_queues")
    if q and (len(q) != 1 or q[0]["name"] != queue or q[0]["routing_key"] != queue
              or q[0]["exchange"]["name"] != queue or q[0]["exchange"]["type"] != "direct"):
        raise RuntimeError("Unexpected HZ worker queue binding")
    state = {"node": node, "queue": queue, "bindings": q}
    stats = value("stats")
    if stats["pool"]["implementation"] != "celery.concurrency.prefork:TaskPool":
        raise RuntimeError("Worker is not using its qualified prefork pool")
    state["masterPid"] = int(stats["pid"])
    if expected and (state["node"], state["queue"], state["masterPid"]) != (
            expected["node"], expected["queue"], expected["masterPid"]):
        raise RuntimeError("Worker process identity changed")
    if action == "restore":
        if expected["bindings"]:
            # The registered queue object retains the exact exchange/bindings when deselected.
            ctl.add_consumer(queue, destination=[node], reply=True, timeout=4)
        if value("active_queues") != expected["bindings"]:
            raise RuntimeError("Original task queue binding was not restored")
        return state
    if action == "fence":
        if q and q != expected["bindings"]:
            raise RuntimeError("Worker queue binding changed")
        if q:
            ctl.cancel_consumer(queue, destination=[node], reply=True, timeout=4)
        if value("active_queues"):
            raise RuntimeError("Worker continues to admit tasks")
    for fn in (jobs.execute_job, pipeline.prepare_mesh, pipeline.prepare_mesh_with_recovery):
        if hashlib.sha256(inspect.getsource(fn).encode()).hexdigest() != PINS[fn.__name__]:
            raise RuntimeError("Unqualified mesh reader " + fn.__name__)
    tasks = {}
    # Once deselected, tasks can only move from scheduled -> reserved -> active -> finished.
    # Observe in that order so transitions cannot hide an outstanding SeedHit or mesh read.
    for method in ("scheduled", "reserved", "active"):
        for item in value(method):
            task = item.get("request", item)
            if task.get("name") != "airfoilfoam.run_polar":
                raise RuntimeError("Unclassified worker task in the cache reader window")
            args = task["args"]
            if not isinstance(args, list) or len(args) != 2 or not isinstance(args[1], str):
                raise RuntimeError("Cannot bind active solver request")
            tasks[task["id"]] = args[1]
    keys = set()
    if len(tasks) > 256:
        raise RuntimeError("Reader scope exceeded its bounded task inventory")
    for request in tasks.values():
        keys.update(mesh_keys(request))
    if action == "fence" and value("active_queues"):
        raise RuntimeError("New worker admission during the fence")
    return {**state, "tasks": len(tasks), "meshKeys": sorted(keys)}


if __name__ == "__main__":
    print(json.dumps(control(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else None)))
