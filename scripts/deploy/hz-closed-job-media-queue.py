"""Run named keep-media jobs and the original raw-file inventory serially on the controller."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import UUID


def require(ok, message):
    if not ok:
        raise ValueError(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def read(path):
    return json.loads(Path(path).read_bytes())


def pinned_bytes(path, sha):
    data = Path(path).read_bytes()
    require(hashlib.sha256(data).hexdigest() == sha, "private inventory or runtime pin changed")
    return data


def publish(path, value):
    """Publish a receipt before starting another filesystem or network effect."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, prefix=".receipt-") as f:
        try:
            f.write(json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\n")
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            os.unlink(f.name)
            raise
    os.replace(f.name, path)
    sync_dir(path.parent)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def exclusive(path, create=False):
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | (os.O_CREAT if create else 0), 0o600)
    with os.fdopen(fd, "rb+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(os.path.samestat(os.fstat(fd), path.stat()), "controller lock was replaced")
        yield


def command(installation):
    root = Path(installation["repository"])
    revision = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
    require(revision == installation["revision"], "frozen operator revision differs")
    return [sys.executable, "-B", str(root / "scripts/deploy/hz-closed-job-maintenance.py")]


def invoke(installation, mode, job, plan=None, proof=None):
    argv = command(installation) + [mode, "--keep-media"]
    if proof is not None:
        argv.extend(["--proof-receipt", str(proof)])
    argv.append(job)
    if plan is not None:
        argv.append(plan)
    result = subprocess.run(argv, cwd=installation["repository"], stdout=subprocess.PIPE, check=False)
    require(result.returncode in (0, 1), "frozen operator could not complete its request")
    receipt = json.loads(result.stdout)
    require(receipt.get("job") == job and (result.returncode == 1) == (receipt["status"] == "refused"),
            "operator result differs from request")
    return receipt


def objects(receipt):
    return {(r["brokeredUploadId"], r["generation"], r["storedSha256"], r["storedByteSize"])
            for r in receipt["readbacks"]}


def validate_runtime(receipt, anchor):
    for key in ("helperRevision", "helperSha256", "dependenciesSha256", "nodePackagesSha256",
                "nativePackages", "jobsInode", "deployLockInode"):
        require(receipt[key] == anchor[key], "runtime fingerprint changed: " + key)


def same_job(first, second):
    for key in ("job", "points", "scientificSha256", "mediaSha256", "keptMediaRows",
                "jobInode", "lockInode"):
        require(first[key] == second[key], "job evidence changed: " + key)
    for key in ("plan", "files", "bytes", "workingPaths", "mediaFiles", "plannedAllocatedBytes"):
        require(first["plan"][key] == second["plan"][key], "native plan changed: " + key)
    require(objects(first) == objects(second), "the pinned object identities differ")


def anchor_read(installation, baseline):
    actual = invoke(installation, "verify", baseline["job"], baseline["plan"]["plan"])
    require(actual["status"] == "verified" and actual["databaseReadOnly"] and actual["plan"]["replayed"],
            "media canary requalification refused")
    validate_runtime(actual, baseline)
    same_job(actual, baseline)
    return actual


def match_roster(row, receipt):
    require(receipt["databaseReadOnly"] and receipt["status"] == "proved" and not receipt["settled"],
            "a read-only media proof is required")
    images = {(m["id"], m["attemptId"], m["resultId"], m["field"], m["path"], m["sha256"], m["byteSize"])
              for m in receipt["keptMediaRows"]}
    roster = {(m["id"], m["attempt"], m["result"], m["field"],
               m["path"].removeprefix("jobs/" + row["id"] + "/"), m["sha"], m["bytes"]) for m in row["media"]}
    require(images == roster and len(images) == len(row["media"]) and
            len(receipt["plan"]["mediaFiles"]) == 2 * len(images), "served media differ from the named roster")
    if not receipt["plan"]["files"]:
        return
    known = {(a["upload"], a["generation"], a["sha"], a["bytes"]) for a in row["objects"]}
    require(known <= objects(receipt) and len(receipt["readbacks"]) == len(objects(receipt)) ==
            len(receipt["points"]) == row["expectedPointCount"], "incomplete or changed signed archive inventory")
    measured = row.get("measured")
    if measured:
        require(all(receipt["plan"][k] == measured[k] for k in ("plan", "files", "bytes", "plannedAllocatedBytes")),
                "current working-file plan differs from measured inventory")


def completed(receipt, before, anchor):
    require(receipt["status"] == "verified" and receipt["databaseReadOnly"] and receipt["plan"]["replayed"],
            "scoped native completion is unverified")
    validate_runtime(receipt, anchor)
    same_job(receipt, before)


def saved_receipt(state, job):
    final = state / "receipts" / (job + ".json")
    if not final.exists():
        return None
    old = read(final)
    require(old["job"] == job and old["outcome"] in ("verified", "deferred", "empty"), "invalid completed receipt")
    pending = state / "pending" / (job + ".json")
    if pending.exists():
        require(read(pending)["startedAt"] == old["startedAt"], "conflicting pending receipt")
        pending.unlink()
        sync_dir(pending.parent)
    return old


def process(row, state, installation, anchor):
    job = row["id"]
    final = state / "receipts" / (job + ".json")
    pending = state / "pending" / (job + ".json")
    old = saved_receipt(state, job)
    if old:
        return old["outcome"]
    current = {"job": job, "startedAt": now()}
    if pending.exists():
        current = read(pending)
    before = current.get("before")
    if before and current.get("applying"):
        # A lost SSH response can leave a complete SQL and native effect. Verify before
        # requesting any write. The original frozen helper can resume an identical intent.
        replay = invoke(installation, "verify", job, before["plan"]["plan"])
        if replay["status"] == "verified":
            completed(replay, before, anchor)
            current.update(outcome="verified", after=replay, recovered=True)
    if "outcome" not in current:
        expected = before["plan"]["plan"] if before else (row.get("measured") or {}).get("plan")
        fresh = invoke(installation, "proof", job, expected)
        if fresh["status"] == "refused":
            require(not current.get("applying"), "unresolved native effect; inspect the pending receipt")
            current.update(outcome="deferred", reason=fresh["reason"], refusal=fresh)
        else:
            validate_runtime(fresh, anchor)
            require(fresh["containers"] == anchor["containers"] and fresh["deployedRevision"] == anchor["deployedRevision"],
                    "runtime changed after the media anchor")
            if before:
                same_job(before, fresh)
            try:
                match_roster(row, fresh)
            except ValueError as error:
                require(not current.get("applying"), "uncertain effect and changed evidence")
                current.update(outcome="deferred", reason=str(error), before=fresh)
            if "outcome" not in current and not fresh["plan"]["files"]:
                current.update(outcome="empty", before=fresh)
            if "outcome" not in current:
                proof_path = state / "proofs" / (job + ".json")
                publish(proof_path, fresh)
                current.update(before=fresh, applying=True)
                publish(pending, current)
                effect = invoke(installation, "reclaim", job, fresh["plan"]["plan"], proof=proof_path)
                require(effect["status"] in ("settled", "already-settled"), "apply refused; inspect the pending receipt")
                completed(effect["after"], fresh, anchor)
                current.update(outcome="verified", effect=effect)
    current["finishedAt"] = now()
    publish(final, current)
    if pending.exists():
        pending.unlink()
        sync_dir(pending.parent)
    return current["outcome"]


def predecessor_complete(previous, entries):
    directory = Path(previous["state"])
    status = read(directory / "status.json")
    if status.get("phase") != "complete":
        return False
    require(status["examined"] == status["nextOffset"] == status["total"] == len(entries)
            and status["verified"] + status["deferred"] == len(entries), "incomplete predecessor totals")
    require(not any((directory / "pending").glob("*.json")), "predecessor has pending effects")
    records = sorted((directory / "receipts").glob("*.json"))
    require(len(records) == len(entries), "missing predecessor receipts")
    for i, (path, expected) in enumerate(zip(records, entries)):
        saved = read(path)
        require(saved["index"] == i and saved["target"]["id"] == expected["id"] and
                saved["target"]["plan"] == expected["plan"] and saved["outcome"] in ("deferred", "verified"),
                "predecessor receipt differs from immutable inventory")
    return True


def run(config, config_sha):
    previous, installation = config["previous"], config["operator"]
    entries = [json.loads(line) for line in pinned_bytes(previous["inventory"], previous["sha256"]).splitlines()]
    rows = [json.loads(line) for line in pinned_bytes(config["inventory"], config["sha256"]).splitlines()]
    old_state = Path(previous["state"])
    pinned_bytes(old_state / "manifest.json", previous["manifestSha256"])
    pinned_bytes(previous["runtimeProof"], previous["runtimeProofSha256"])
    baseline = json.loads(pinned_bytes(config["runtimeProof"], config["runtimeProofSha256"]))
    require(all(str(UUID(r["id"])) == r["id"] for r in rows + entries), "invalid immutable job identity")
    jobs = {r["id"]: r for r in rows}
    require(bool(jobs) and len(jobs) == len(rows) and not set(jobs).intersection(r["id"] for r in entries) and
            baseline["job"] not in jobs, "media inventory overlaps previous work")
    state = Path(config["state"])
    require(state.is_absolute() and state.is_dir() and not state.is_symlink() and state.stat().st_uid == os.getuid()
            and not state.stat().st_mode & 0o077, "controller state must be owner-private")
    lead = config.get("lead")
    require(lead is None or lead in jobs and jobs[lead].get("measured"), "named lead job needs a measured native plan")
    with exclusive(state / "controller.lock", create=True):
        contract = state / "contract.json"
        if contract.exists():
            require(read(contract)["configSha256"] == config_sha, "media continuation identity changed")
        else:
            publish(contract, {"configSha256": config_sha, "total": len(rows), "createdAt": now()})
        def status(phase, **values):
            publish(state / "status.json", {"phase": phase, "at": now(), "total": len(rows), **values})

        slot = state / "named-slot.json"
        pending_lead = state / "pending" / (str(lead) + ".json")
        # A one-time discovery/transport fault in the optional early slot must
        # not hold up the original inventory. An uncertain unlink still needs replay.
        need_early = not slot.exists() or (pending_lead.exists() and read(pending_lead).get("applying"))
        if lead and need_early and saved_receipt(state, lead) is None:
            with exclusive(old_state / "operator.lock"):
                status("named-media-job", job=lead)
                # The named slot is optional. An outstanding removal in the original
                # inventory must finish its native, SQL and cloud replay first.
                unfinished = [read(path) for path in (old_state / "pending").glob("*.json")]
                if not any(item.get("effect") for item in unfinished):
                    publish(slot, {"job": lead, "startedAt": now()})
                    process(jobs[lead], state, installation, anchor_read(installation, baseline))
        if not predecessor_complete(previous, entries):
            status("original-inventory", originalState=str(old_state))
            subprocess.run(command(previous) + ["run-inventory", previous["inventory"], "--sha256", previous["sha256"],
                           "--state", previous["state"], "--runtime-proof", previous["runtimeProof"], "--apply"],
                           cwd=previous["repository"], check=True)
        with exclusive(old_state / "operator.lock"):
            require(predecessor_complete(previous, entries), "original inventory is unfinished")
            anchor = None
            totals = {"verified": 0, "deferred": 0, "empty": 0}
            for index, row in enumerate(rows):
                saved = saved_receipt(state, row["id"])
                if saved:
                    totals[saved["outcome"]] += 1
                    continue
                if anchor is None:
                    anchor = anchor_read(installation, baseline)
                status("media-inventory", index=index, job=row["id"], **totals)
                totals[process(row, state, installation, anchor)] += 1
            status("complete", examined=len(rows), **totals)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--sha256", required=True)
    options = parser.parse_args()
    run(json.loads(pinned_bytes(options.config, options.sha256)), options.sha256)
