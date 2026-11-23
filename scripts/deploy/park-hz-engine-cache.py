#!/usr/bin/env python3
"""Bounded HZ mesh-cache parking for the PostgreSQL workspace, with exact restoration."""
import argparse
import base64
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
import zipfile

WORKER = "hz-solver2-worker-1"
VOLUME = Path("/var/lib/docker/volumes/hz-solver2_results/_data")
NAMESPACE = Path("engines/openfoam_opencfd_2606_numerics-2/mesh")
SHA = re.compile(r"[0-9a-f]{64}")
CHUNK = 1024 * 1024


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def fsync_dir(p):
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(p, data):
    tmp = p.with_name("." + p.name + "." + uuid.uuid4().hex)
    with tmp.open("x") as out:
        json.dump(data, out, sort_keys=True, separators=(",", ":"))
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, p)
    fsync_dir(p.parent)


def read(p):
    return json.loads(p.read_bytes())


def free(path):
    s = os.statvfs(path)
    return s.f_bavail * s.f_frsize


def regular_dir(path):
    return path.is_absolute() and path.resolve(strict=True) == path and path.is_dir()


def identity(s):
    return [s.st_dev, s.st_ino, s.st_ctime_ns, s.st_mtime_ns, s.st_size, s.st_mode, s.st_uid, s.st_gid]


def meta(path):
    s = path.lstat()
    return {"mode": stat.S_IMODE(s.st_mode), "uid": s.st_uid, "gid": s.st_gid, "mtime": s.st_mtime_ns,
            "attrs": {k: base64.b64encode(os.getxattr(path, k, follow_symlinks=False)).decode()
                      for k in os.listxattr(path, follow_symlinks=False)}}


def set_meta(path, m):
    s = path.lstat()
    if (s.st_uid, s.st_gid) != (m["uid"], m["gid"]):
        os.chown(path, m["uid"], m["gid"], follow_symlinks=False)
    os.chmod(path, m["mode"])
    wanted = m["attrs"]
    for k in os.listxattr(path, follow_symlinks=False):
        if k not in wanted:
            os.removexattr(path, k, follow_symlinks=False)
    for k, v in wanted.items():
        os.setxattr(path, k, base64.b64decode(v), follow_symlinks=False)
    os.utime(path, ns=(s.st_atime_ns, m["mtime"]), follow_symlinks=False)
    require(meta(path) == m, f"Restored metadata differs: {path.name}")


def stream(src, out=None, limit=None, space=None):
    h = hashlib.sha256()
    size = 0
    while block := src.read(CHUNK):
        size += len(block)
        require(limit is None or size <= limit, "Member exceeds bound")
        h.update(block)
        if out is not None:
            if space:
                directory, reserve = space
                require(free(directory) >= reserve + len(block) + 8192, "Filesystem reserve reached during copy")
            out.write(block)
    return h.hexdigest(), size


def walk(entry):
    require(regular_dir(entry), "Mesh entry is not a plain directory")
    dirs, files = {}, {}
    stack = [entry]
    device = entry.stat().st_dev
    while stack:
        d = stack.pop()
        dirs[str(d.relative_to(entry))] = meta(d)
        for f in d.iterdir():
            s = f.lstat()
            require(s.st_dev == device, "Nested filesystem in mesh cache")
            if stat.S_ISDIR(s.st_mode):
                stack.append(f)
            else:
                require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, "Linked or special cache member")
                files[str(f.relative_to(entry))] = (identity(s), s.st_blocks * 512)
    return dirs, files


def fast_identity(entry, item):
    require(identity(entry.stat()) == item["root"], "Source directory changed at cutover")
    seen = set()
    pending = [entry]
    while pending:
        directory = pending.pop()
        rel = str(directory.relative_to(entry))
        require(rel in item["dirs"] and directory.stat().st_mtime_ns == item["dirs"][rel]["mtime"],
                "Changed source directory at cutover")
        with os.scandir(directory) as children:
            for child in children:
                path = Path(child.path)
                state = child.stat(follow_symlinks=False)
                if stat.S_ISDIR(state.st_mode):
                    pending.append(path)
                else:
                    name = str(path.relative_to(entry))
                    require(name in item["files"] and state.st_nlink == 1 and identity(state) == item["files"][name]["id"],
                            "Original payload inode changed at cutover")
                    seen.add(name)
    require(seen == set(item["files"]), "Missing source member at cutover")


def inventory(entry, key=None):
    key = entry.name if key is None else key
    dirs, files = walk(entry)
    manifest = entry / "manifest.json"
    require("manifest.json" in files and files["manifest.json"][0][4] <= 4 * CHUNK, "Invalid mesh manifest")
    raw = manifest.read_bytes()
    v = json.loads(raw)
    require(v["schemaVersion"] == 1 and v["kind"] == "mesh" and SHA.fullmatch(key)
            and v["key"] == key and v["engineNamespace"] == "openfoam:opencfd:2606:numerics-2",
            "Unexpected mesh identity")
    hashes = {"manifest.json": hashlib.sha256(raw).hexdigest()}
    payload = 0
    for item in v["files"]:
        name = item["path"]
        require(name in files and name not in hashes and name.startswith(("polyMesh/", "meshEvidence/"))
                and SHA.fullmatch(item["sha256"]) and files[name][0][4] == item["byteSize"], "Invalid mesh member")
        hashes[name] = item["sha256"]
        payload += item["byteSize"]
    require(set(hashes) == set(files) and payload == v["byteSize"] and payload > 0, "Undeclared or missing mesh bytes")
    return {"key": key, "root": identity(entry.stat()), "dirs": dirs,
            "files": {n: {"id": s, "meta": meta(entry / n), "sha": hashes[n]} for n, (s, _) in files.items()},
            "allocated": sum(sz for _, sz in files.values()) + sum((entry / n).stat().st_blocks * 512 for n in dirs),
            "payload": payload, "lru": files["manifest.json"][0][3]}


def bound(guard):
    w = guard["workspace"]
    require(guard["role"] == "remote-solver" and guard["target"] == "public.progressive_worker_reports"
            and guard["worker"]["disk"]["source"] == "/dev/md4" and not guard.get("touched"), "Wrong rewrite guard")
    fields = ["replacementBytes", "indexScratchBytes", "additionalWalBytes", "externalGrowthBytes", "stopFreeBytes"]
    require(all(type(w[k]) is int and w[k] >= 0 for k in fields) and w["stopFreeBytes"] > 0
            and sum(w[k] for k in fields) == w["requiredBytes"], "Invalid rewrite budget")
    return w["requiredBytes"]


def select_entries(root, dest, guard, margin, reserve, max_bytes, max_entries, min_age, protected=(), attestation=None, copy_all=False):
    require(regular_dir(root) and regular_dir(dest) and root.stat().st_dev != dest.stat().st_dev,
            "Parking and data must be on distinct filesystems")
    require(margin >= 0 and reserve > 0 and max_bytes > 0 and max_entries > 0 and min_age >= 0, "Invalid bounds")
    mesh = root / NAMESPACE
    require(regular_dir(mesh) and mesh.stat().st_dev == root.stat().st_dev, "Unexpected cache layout")
    required = bound(guard) + margin
    start_free = free(root)
    target = max(0, required - start_free)
    entries, total, stored = [], 0, 0
    allowed = None
    if attestation is not None:
        require(not attestation["issues"] and attestation["device"] == root.stat().st_dev and
                attestation["sourceCompletedBytes"] == attestation["allSourceMemberBytesRead"], "Incomplete source attestation")
        allowed = {}
        for a in attestation["entries"]:
            rel = Path(a["entry"])
            require(rel.parent == NAMESPACE and SHA.fullmatch(rel.name) and rel.name not in allowed, "Invalid attested mesh identity")
            allowed[rel.name] = a
    require(not copy_all or allowed is not None, "A full safety copy requires attested originals")
    if target or copy_all:
        cutoff = time.time_ns() - int(min_age * 86400 * 1e9)
        candidates = []
        for e in mesh.iterdir():
            if not SHA.fullmatch(e.name) or e.name in protected or (allowed is not None and e.name not in allowed):
                continue
            require(not e.is_symlink(), "Unexpected linked mesh entry")
            stamp = (e / "manifest.json").stat(follow_symlinks=False).st_mtime_ns
            if stamp <= cutoff:
                candidates.append((stamp, e))
        for stamp, e in sorted(candidates):
            item = inventory(e)
            require(stamp == item["lru"], "LRU changed during selection")
            if allowed is not None:
                a = allowed[e.name]
                require(item["files"]["manifest.json"]["sha"] == a["manifestSha256"] and stamp == a["mtimeNs"]
                        and item["root"][:2] == [a["device"], a["inode"]] and item["allocated"] == a["allocated"]
                        and item["payload"] == a["payload"], "Source differs from independently verified mesh")
            if len(entries) >= max_entries or total + item["allocated"] > max_bytes:
                break
            entries.append(item)
            total += item["allocated"]
            # ZIP_STORED, individual plain members. Include names, central directory, catalog and allocation rounding.
            stored += sum(f["id"][4] + 2 * len(n.encode()) + 256 for n, f in item["files"].items()) + 8192
            if not copy_all and total >= target:
                break
    if copy_all:
        require(len(entries) == len(allowed), "Attested safety page changed, is protected, or exceeds the supplied bounds")
    require(copy_all or total >= target, f"Cold mesh selection falls short by {target-total} bytes")
    if entries:
        stored += len(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()) + 65536
    require(not entries or free(dest) >= stored + reserve, "Insufficient independent parking space")
    return {"version": 1, "run": uuid.uuid4().hex, "root": str(root), "rootId": identity(root.stat())[:2],
            "destDevice": dest.stat().st_dev, "required": required, "margin": margin, "reserve": reserve,
            "initialFree": start_free, "expectedReturn": total, "parkingCeiling": stored, "entries": entries}


def summarize(plan):
    return {k: plan[k] for k in ("run", "required", "margin", "reserve", "initialFree", "expectedReturn", "parkingCeiling")} | {
        "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "selectedKeysAndManifestsSha256": hashlib.sha256("".join(
            q["key"] + " " + q["files"]["manifest.json"]["sha"] + "\n" for q in plan["entries"]
        ).encode()).hexdigest(), "entries": len(plan["entries"]), "activeTasks": plan.get("activeTaskCount"),
        "protectedMeshKeys": plan.get("protectedMeshKeys"), "attestationSha256": plan.get("attestation"),
        "metadataRecheckSeconds": plan.get("metadataRecheckSeconds"), "externalOpenMeshes": plan.get("externalOpenMeshes"),
        "youngestLruNs": max((i["lru"] for i in plan["entries"]), default=None), "dataVolume": plan["rootId"][0], "parkingVolume": plan["destDevice"]}


def exact(entry, expected, hashes=False):
    actual = inventory(entry)
    require(actual == expected, f"Cache identity, LRU, or members changed: {expected['key']}")
    if hashes:
        for n, f in expected["files"].items():
            with (entry / n).open("rb") as src:
                require(stream(src, limit=f["id"][4]) == (f["sha"], f["id"][4]), "Original member checksum changed")


def verified_zip(path, item, restore_to=None, floor=0):
    with zipfile.ZipFile(path, "r") as z:
        require(len(z.infolist()) == len(item["files"]) and set(z.namelist()) == set(item["files"]), "Parked member inventory differs")
        if restore_to is not None:
            restore_to.mkdir()
            for n in sorted(item["dirs"], key=lambda x: len(Path(x).parts)):
                (restore_to / n).mkdir(exist_ok=True)
        for n, f in item["files"].items():
            size = f["id"][4]
            zi = z.getinfo(n)
            require(zi.compress_type == zipfile.ZIP_STORED and zi.file_size == size, "Wrong parking format or length")
            if restore_to is not None:
                require(free(restore_to) >= floor + size + 8192, "Insufficient restoration headroom")
            with z.open(zi) as src, ((restore_to / n).open("xb") if restore_to else contextlib.nullcontext()) as out:
                require(stream(src, out, size, (restore_to, floor) if restore_to else None) == (f["sha"], size), "Independent archive checksum differs")
                if out:
                    out.flush()
                    os.fsync(out.fileno())
            if restore_to:
                set_meta(restore_to / n, f["meta"])
                with (restore_to / n).open("rb") as saved:
                    os.fsync(saved.fileno())
        if restore_to:
            for n in sorted(item["dirs"], key=lambda x: len(Path(x).parts), reverse=True):
                set_meta(restore_to / n, item["dirs"][n])
                fsync_dir(restore_to / n)


def prepare(run, plan):
    root = Path(plan["root"])
    require(run.parent.stat().st_dev == plan["destDevice"] and root.stat().st_dev != plan["destDevice"], "Parking mount changed")
    if not run.exists():
        run.mkdir(mode=0o700)
        fsync_dir(run.parent)
    require(regular_dir(run) and run.stat().st_uid == os.geteuid() and stat.S_IMODE(run.stat().st_mode) == 0o700,
            "Run directory is not private and owned")
    if (run / "plan.json").exists():
        require(read(run / "plan.json") == plan, "Different parking plan already exists")
    else:
        require(not any(run.iterdir()), "Run directory is occupied")
        require(free(run) >= plan["reserve"] + plan["parkingCeiling"], "Parking space changed before preparation")
        write_json(run / "plan.json", plan)
    previous = read(run / "prepared.json") if (run / "prepared.json").exists() else None
    if previous:
        require(previous["planSha256"] == hashlib.sha256((run / "plan.json").read_bytes()).hexdigest() and
                set(previous["zips"]) == {q["key"] for q in plan["entries"]}, "Sealed safety receipt differs")
    seals = {}
    before_available = free(run)
    reused = 0
    for number, item in enumerate(plan["entries"], 1):
        key = item["key"]
        final = run / (key + ".zip")
        if final.exists() or final.is_symlink():
            st = final.lstat()
            require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_dev == plan["destDevice"],
                    "Parking ZIP is not an independent regular file")
            verified_zip(final, item)
            reused += 1
            with final.open("rb") as src:
                seals[key] = list(stream(src))
            if previous:
                require(seals[key] == previous["zips"][key], "Sealed parking ZIP bytes changed")
            continue
        require(not previous, "Sealed parking ZIP is missing")
        src = root / NAMESPACE / key
        exact(src, item)
        temp = run / (key + ".part")
        if temp.exists() or temp.is_symlink():
            st = temp.lstat()
            require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid(), "Unexpected incomplete ZIP")
            temp.unlink()
        with temp.open("xb") as dest:
            with zipfile.ZipFile(dest, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
                for n, f in item["files"].items():
                    size = f["id"][4]
                    require(free(run) >= plan["reserve"] + size + 8192, "Parking reserve reached")
                    with (src / n).open("rb") as original, z.open(n, "w", force_zip64=True) as out:
                        require(stream(original, out, size, (run, plan["reserve"])) == (f["sha"], size), "Source checksum differs")
            dest.flush()
            os.fsync(dest.fileno())
        exact(src, item)
        verified_zip(temp, item)
        with temp.open("rb") as src:
            seals[key] = list(stream(src))
        os.replace(temp, final)
        fsync_dir(run)
        if number % 128 == 0:
            print(json.dumps({"verifiedSafetyZips": number, "pageEntries": len(plan["entries"]),
                              "parkingAvailable": free(run)}), file=sys.stderr, flush=True)
    for item in plan["entries"]:
        fast_identity(root / NAMESPACE / item["key"], item)
    require(free(run) >= plan["reserve"], "Parking filesystem reserve reached")
    if previous:
        return {"verifiedEntries": len(seals), "reusedSealedCopy": True, "retiredBytes": 0}
    write_json(run / "prepared.json", {"planSha256": hashlib.sha256((run / "plan.json").read_bytes()).hexdigest(),
                                      "count": len(plan["entries"]), "zips": seals, "reusedVerifiedZips": reused,
                                      "verifiedPayloadBytes": sum(q["payload"] for q in plan["entries"]),
                                      "verifiedPayloadMembers": sum(len(q["files"])-1 for q in plan["entries"]),
                                      "zipBytes": sum(v[1] for v in seals.values()),
                                      "zipAllocatedBytes": sum((run / (key+".zip")).stat().st_blocks*512 for key in seals),
                                      "dataDevice":root.stat().st_dev, "parkingDevice":run.stat().st_dev,
                                      "parkingAvailableBeforeCopy":before_available, "parkingAvailableAfterCopy":free(run),
                                      "allOriginalIdentitiesRechecked": True, "retiredBytes": 0})
    return {"verifiedEntries": len(seals), "reusedSealedCopy": False, "retiredBytes": 0}


def load_prepared(run):
    require(regular_dir(run) and run.stat().st_uid == os.geteuid() and stat.S_IMODE(run.stat().st_mode) == 0o700,
            "Private run path changed")
    seal = read(run / "prepared.json")
    raw = (run / "plan.json").read_bytes()
    require(hashlib.sha256(raw).hexdigest() == seal["planSha256"], "Prepared selection changed")
    plan = json.loads(raw)
    require(len(plan["entries"]) == seal["count"] and all(SHA.fullmatch(q["key"]) for q in plan["entries"]) and
            {q["key"] for q in plan["entries"]} == set(seal["zips"]), "Invalid sealed archive keys")
    root = Path(plan["root"])
    require(regular_dir(root) and identity(root.stat())[:2] == plan["rootId"] and
            run.stat().st_dev == plan["destDevice"] != root.stat().st_dev, "Bound storage mount changed")
    return plan


def hold_for(root, plan):
    require(re.fullmatch("[0-9a-f]{32}", plan["run"]), "Invalid parking identifier")
    hold = root.parent / (".hz-cache-parking-" + plan["run"])
    hold.mkdir(mode=0o700, exist_ok=True)
    require(regular_dir(hold) and hold.stat().st_dev == root.stat().st_dev and hold.stat().st_uid == os.geteuid()
            and stat.S_IMODE(hold.stat().st_mode) == 0o700, "Invalid private hold")
    return hold


def noreplace(source, dest):
    fn = ctypes.CDLL(None, use_errno=True).renameat2
    if fn(-100, os.fsencode(source), -100, os.fsencode(dest), 1) != 0:
        e = ctypes.get_errno()
        raise OSError(e, os.strerror(e), str(dest))


def same_restored(entry, item, preserve_newer_lru=False):
    actual = inventory(entry, item["key"])
    require(actual["key"] == item["key"] and actual["dirs"] == item["dirs"] and
            set(actual["files"]) == set(item["files"]), "Regenerated entry or directory metadata differs")
    for n, f in actual["files"].items():
        source = item["files"][n]
        expected_meta = dict(source["meta"])
        if preserve_newer_lru and n == "manifest.json":
            expected_meta["mtime"] = max(expected_meta["mtime"], f["meta"]["mtime"])
        require(f["meta"] == expected_meta and f["sha"] == source["sha"], "Regenerated member differs")
        with (entry / n).open("rb") as src:
            require(stream(src, limit=source["id"][4]) == (source["sha"], source["id"][4]), "Restored payload differs")


def park(run, fence, latest=None, get_protected=None):
    plan = load_prepared(run)
    target = plan["required"] if latest is None else bound(latest) + plan["margin"]
    if latest is not None:
        require(latest["identity"][:5] == plan["dbIdentity"], "Rewrite relation identity changed")
    root = Path(plan["root"])
    mesh = root / NAMESPACE
    journal = run / "retiring.json"
    if journal.exists():
        keys = read(journal)["keys"]
    else:
        required = max(0, target - free(root))
        keys, blocks = [], 0
        protected = get_protected() if required and get_protected else set()
        for item in plan["entries"]:
            if blocks >= required:
                break
            if item["key"] in protected:
                continue
            keys.append(item["key"])
            blocks += item["allocated"]
        require(blocks >= required, "Fresh data-volume gap exceeds prepared page")
    selected = set(keys)
    items = [item for item in plan["entries"] if item["key"] in selected]
    require(len(set(keys)) == len(keys) == len(items), "Invalid parking journal")
    if (run / "restored.json").exists():
        raise ValueError("This parking run is already restored")
    if (run / "parked.json").exists():
        saved = read(run / "parked.json")
        if latest is not None:
            return {**saved, "requiredBytes": target, "currentAvailableBytes": free(root), "meetsRequiredBytes": free(root) >= target}
        return saved
    hold = hold_for(root, plan) if items else None
    seal = read(run / "prepared.json")["zips"]
    switched = run / "switched.json"
    for item in items:
        with (run / (item["key"] + ".zip")).open("rb") as src:
            require(list(stream(src)) == seal[item["key"]], "Verified parking ZIP changed")
        src = mesh / item["key"]
        if not switched.exists() and (not journal.exists() or src.exists()):
            exact(src, item)
    before = free(root)
    if items and not switched.exists():
        with fence({r["key"] for r in items}) as guard:
            for item in items:
                guard()
                entry = mesh / item["key"]
                if entry.exists():
                    fast_identity(entry, item)
            if not journal.exists():
                write_json(journal, {"keys": keys, "before": before})
            for item in items:
                key = item["key"]
                src, dst = mesh / key, hold / key
                guard()
                if src.exists():
                    # Pin the directory and original manifest under the live-reader/evictor fence.
                    require(identity(src.stat()) == item["root"] and identity((src / "manifest.json").stat()) ==
                            item["files"]["manifest.json"]["id"], "Selected mesh was touched or replaced")
                    noreplace(src, dst)
                require(dst.exists() and identity(dst.stat())[:2] == item["root"][:2], "Original hold is missing")
            fsync_dir(mesh)
            fsync_dir(hold)
            guard()
            write_json(switched, {"keys": keys})
    if items:
        require(read(switched)["keys"] == keys, "Retirement receipt differs")
        # Only the exact retired, now-private inode is unlinked. No cache path is removed here.
        for item in items:
            dst = hold / item["key"]
            if dst.exists():
                require(identity(dst.stat())[:2] == item["root"][:2], "Wrong retired entry")
                shutil.rmtree(dst)
        fsync_dir(hold)
    else:
        write_json(journal, {"keys": [], "before": before})
    result = {"parkedEntries": len(keys), "sourceAllocatedBytes": sum(q["allocated"] for q in items),
              "beforeAvailableBytes": read(journal)["before"], "afterAvailableBytes": free(root),
              "requiredBytes": target}
    result["netDataVolumeAvailableChange"] = result["afterAvailableBytes"] - result["beforeAvailableBytes"]
    result["meetsRequiredBytes"] = result["afterAvailableBytes"] >= target
    write_json(run / "parked.json", result)
    return result


def restore(run, floor, fence):
    plan = load_prepared(run)
    root = Path(plan["root"])
    mesh = root / NAMESPACE
    if (run / "restored.json").exists():
        return read(run / "restored.json")
    if not (run / "retiring.json").exists():
        return {"restoredEntries": 0}
    keys = set(read(run / "retiring.json")["keys"])
    items = [r for r in plan["entries"] if r["key"] in keys]
    require(len(items) == len(keys) and floor > 0, "Invalid restoration bounds")
    hold = hold_for(root, plan)
    missing, conflicts = [], []
    for item in items:
        key = item["key"]
        dest = mesh / key
        if dest.exists() or dest.is_symlink():
            try:
                same_restored(dest, item, preserve_newer_lru=True)
            except (ValueError, OSError, KeyError) as ex:
                conflicts.append({"key": key, "originalManifestSha256": item["files"]["manifest.json"]["sha"],
                                  "reason": str(ex)})
            continue
        stage = hold / ("restore-" + key)
        original = hold / key
        if original.exists():
            same_restored(original, item)
            stage = original
        else:
            if stage.exists():
                shutil.rmtree(stage)  # private incomplete reconstruction; verified ZIP remains
            require(free(root) >= floor + item["allocated"], "Restoration would cross data-volume reserve")
            verified_zip(run / (key + ".zip"), item, stage, floor)
            # Reopen the disk files. Their names are about to become visible to ordinary cache readers.
            same_restored(stage, item)
        missing.append((stage, dest))
    if missing:
        with fence({dest.name for _, dest in missing}) as guard:
            for stage, dest in missing:
                guard()
                noreplace(stage, dest)
            fsync_dir(mesh)
            fsync_dir(hold)
            guard()
    result = {"restoredEntries": len(items) - len(conflicts), "conflicts": conflicts, "availableBytes": free(root)}
    write_json(run / ("restore-conflicts.json" if conflicts else "restored.json"), result)
    return result


def docker(*args, stdin=None, timeout=25):
    result = subprocess.run(["docker", *args], input=stdin, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("Docker operation failed: " + result.stderr[-500:])
    return result.stdout


def engine():
    fmt = '{{json .State}}\n{{json .Mounts}}\n{{.Id}}\n{{.Config.Hostname}}'
    lines = docker("inspect", "--format", fmt, WORKER).splitlines()
    state, mounts = json.loads(lines[0]), json.loads(lines[1])
    consumers = docker("ps", "--filter", "volume=hz-solver2_results", "--format", "{{.Names}}").splitlines()
    known = {"hz-solver2-" + name + "-1" for name in ("worker", "api", "sweeper", "node-api", "media-repair")}
    require(WORKER in consumers and set(consumers) <= known, "Unclassified consumer of the results volume")
    require(state["Running"] and not state["Paused"] and any(
        m["Source"] == str(VOLUME) and m["Destination"] == "/data/airfoilfoam" for m in mounts), "HZ worker role or engine mount changed")
    return {"container": lines[2], "hostname": lines[3], "init": state["Pid"], "started": state["StartedAt"]}


def scope_source():
    if "STREAMED_SCOPE" in globals():
        return STREAMED_SCOPE
    return Path(__file__).with_name("hz_cache_reader_scope.py").read_text()


def worker_call(owner, action, prior=None):
    args = ["exec", "-i", owner["container"], "python", "-B", "-", action]
    if prior:
        args.append(json.dumps(prior))
    raw = docker(*args, stdin=scope_source(), timeout=40)
    return json.loads(raw)


def pidfd(pid):
    if hasattr(os, "pidfd_open"):
        return os.pidfd_open(pid)
    fd = ctypes.CDLL(None, use_errno=True).pidfd_open(pid, 0)
    if fd < 0:
        e = ctypes.get_errno()
        raise OSError(e, os.strerror(e))
    return fd


def signal_fd(fd, sig):
    if hasattr(signal, "pidfd_send_signal"):
        return signal.pidfd_send_signal(fd, sig)
    if ctypes.CDLL(None, use_errno=True).pidfd_send_signal(fd, int(sig), None, 0) != 0:
        e = ctypes.get_errno()
        raise OSError(e, os.strerror(e))


def proc(pid):
    raw = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return raw[0], int(raw[19])


def open_cache_readers(keys, processes=None):
    found = set()
    paths = (processes if processes is not None else (p for p in Path("/proc").iterdir() if p.name.isdigit()))
    marker = "/" + str(NAMESPACE) + "/"

    def check(value):
        _, sep, tail = value.partition(marker)
        if sep and tail.split("/", 1)[0] in keys:
            found.add(tail.split("/", 1)[0])

    for p in paths:
        try:
            # Also catch a standalone solver CLI which could hold a cached path between opens.
            args = (p / "cmdline").read_bytes().split(b"\0")
            if any(a == b"airfoilfoam.cli" or a.rsplit(b"/", 1)[-1] == b"airfoilfoam" for a in args[:4]):
                raise ValueError("Standalone solver CLI can bypass worker admission")
            check(os.readlink(p / "cwd"))
            for fd in (p / "fd").iterdir():
                try:
                    check(os.readlink(fd))
                except FileNotFoundError:
                    continue
            with (p / "maps").open(errors="replace") as maps:
                for line in maps:
                    if marker in line:
                        check(line.strip())
        except (FileNotFoundError, ProcessLookupError):
            continue
    return found


def master(owner, inner_pid):
    candidates = Path(f"/proc/{owner['init']}/task/{owner['init']}/children").read_text().split()
    for text in candidates:
        pid = int(text)
        try:
            status = Path(f"/proc/{pid}/status").read_text()
            ids = re.search(r"^NSpid:\s*(.+)$", status, re.M)
            if ids and int(ids[1].split()[-1]) == inner_pid and Path(f"/proc/{pid}/comm").read_text().strip() == "celery":
                return pid
        except FileNotFoundError:
            continue
    raise RuntimeError("Cannot bind the Celery master in its actual PID namespace")


def locked(path):
    @contextlib.contextmanager
    def acquire():
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)
    return acquire()


def recover_readers(run):
    state_file = run / "reader-state.json"
    if not state_file.exists():
        return
    state = read(state_file)
    owner, pid = state["owner"], state["pid"]
    require(engine() == owner, "Original HZ engine changed; reader recovery requires inspection")
    require(proc(pid)[1] == state["start"], "Original Celery process changed")
    prior = state["prior"]
    require(all(re.fullmatch("[a-f0-9]{32}", prior[k]) for k in ("parkingRun", "fenceId")), "Unbound reader epoch")
    epoch = VOLUME / (".hz-cache-parking-" + prior["parkingRun"]) / ("reader-" + prior["fenceId"])
    require(regular_dir(epoch) and epoch.stat().st_uid == os.geteuid(), "Reader epoch is missing")
    write_json(epoch / "revoked.json", {"fence": prior["fenceId"]})
    fd = pidfd(pid)
    try:
        require(master(owner, state["prior"]["masterPid"]) == pid and proc(pid)[1] == state["start"], "Original reader process was replaced")
        if state["mayStop"] and proc(pid)[0] == "T":
            signal_fd(fd, signal.SIGCONT)
    finally:
        os.close(fd)
    worker_call(owner, "restore", state["prior"])
    state_file.unlink()
    fsync_dir(run)


@contextlib.contextmanager
def live_fence(run, keys):
    require(not (run / "reader-state.json").exists(), "Recover the previous reader admission first")
    with locked(VOLUME / "cache/.evict.lock"):
        owner = engine()
        scope = worker_call(owner, "inspect")
        require(not keys.intersection(scope["meshKeys"]), "Active solver can read a selected mesh")
        prior = {k: scope[k] for k in ("node", "queue", "bindings", "masterPid")}
        pid = master(owner, prior["masterPid"])
        state, start = proc(pid)
        require(state not in ("T", "t", "Z"), "Celery master is already stopped")
        plan = load_prepared(run)
        prior.update(parkingRun=plan["run"], fenceId=uuid.uuid4().hex)
        hold = hold_for(VOLUME / "cache", plan)
        epoch = hold / ("reader-" + prior["fenceId"])
        epoch.mkdir(mode=0o700)
        fsync_dir(hold)
        record = {"owner": owner, "prior": prior, "pid": pid, "start": start, "mayStop": False}
        write_json(run / "reader-state.json", record)
        rd, wr = os.pipe()
        parent = pidfd(os.getpid())
        watcher = os.fork()
        if watcher == 0:
            os.setsid()
            os.close(wr)
            try:
                ready = select.select([rd], [], [], 90)[0]
                if ready and os.read(rd, 1) == b"K":
                    os._exit(0)
                if not ready:
                    # No second actor may release the fence while the original can still rename an entry.
                    signal_fd(parent, signal.SIGKILL)
                    select.select([parent], [], [])
                recover_readers(run)
                os._exit(0)
            except BaseException:
                os._exit(1)
        os.close(rd)
        os.close(parent)
        fd = pidfd(pid)
        try:
            fenced = worker_call(owner, "fence", prior)
            require(engine() == owner and not keys.intersection(fenced["meshKeys"]),
                    "Newly admitted solver can read a selected mesh")
            require(not open_cache_readers(keys), "An external process has a selected cache entry open")
            require(master(owner, prior["masterPid"]) == pid and proc(pid)[1] == start and proc(pid)[0] not in ("T", "t", "Z"),
                    "Celery master changed before cutover")
            record["mayStop"] = True
            write_json(run / "reader-state.json", record)
            signal_fd(fd, signal.SIGSTOP)  # the consumer master alone; no pool child or CFD process
            deadline = time.monotonic() + 12
            while proc(pid)[0] != "T":
                require(time.monotonic() < deadline, "Could not fence worker admission")
                time.sleep(0.005)

            def check():
                require(time.monotonic() < deadline and proc(pid) == ("T", start), "Short admission fence expired")

            check()
            yield check
        finally:
            try:
                recover_readers(run)
                os.write(wr, b"K")
            finally:
                os.close(wr)
                os.close(fd)
                _, status = os.waitpid(watcher, 0)
                require(os.waitstatus_to_exitcode(status) == 0, "Reader admission recovery is incomplete")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["plan", "prepare", "park", "restore", "recover-readers"], nargs="?", default="plan")
    parser.add_argument("--all-attested", action="store_true", help="prepare the entire bounded attested safety page; park still selects only the current gap")
    parser.add_argument("--ssh", action="store_true", help="stream the checked source to HZ with the existing SSH identity")
    parser.add_argument("--attestation", type=Path, help="qualified per-entry HZ source-attestation JSON")
    parser.add_argument("--guard", type=Path, help="JSON output from the qualified HZ rewrite dry run")
    parser.add_argument("--run-dir", required=True, type=Path, help="private run under an existing independent filesystem")
    parser.add_argument("--margin-bytes", type=int, default=0, help="additional data-volume margin beyond the rewrite budget")
    parser.add_argument("--parking-reserve-bytes", type=int, help="space to preserve on the independent filesystem")
    parser.add_argument("--max-bytes", type=int, help="upper bound on extents selected in this page")
    parser.add_argument("--max-entries", type=int, default=4096)
    parser.add_argument("--min-age-days", type=float, default=14)
    parser.add_argument("--restore-reserve-bytes", type=int, help="space to preserve on md4 while restoring")
    args = parser.parse_args()
    if args.ssh:
        forwarded = [a for a in sys.argv[1:] if a != "--ssh"]
        setup = "import sys\nsys.argv=" + repr(["park-hz-engine-cache.py", *forwarded]) + "\n"
        setup += "STREAMED_SCOPE=" + repr(scope_source()) + "\n"
        if args.guard:
            setup += "STREAMED_GUARD=" + repr(read(args.guard)) + "\n"
        if args.attestation:
            setup += "STREAMED_ATTESTATION_BYTES=" + repr(args.attestation.read_bytes()) + "\n"
        source = Path(__file__).read_text()
        command = ["ssh", "-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=8",
                   "hz-solver2", "ionice", "-c3", "nice", "-n", "10", "python3", "-B", "-"]
        sys.exit(subprocess.run(command, input=setup + source, text=True).returncode)
    os.umask(0o077)
    root, run = VOLUME / "cache", args.run_dir
    require(run.is_absolute() and regular_dir(run.parent) and not run.is_symlink(), "Invalid parking run parent")
    require(run.parent.stat().st_dev == Path("/var/tmp").stat().st_dev != root.stat().st_dev, "Expected independent HZ root and results mounts")
    if args.action in ("plan", "prepare"):
        require(args.guard and args.attestation and args.max_bytes and args.parking_reserve_bytes, "Supply the rewrite guard, attested source and bounded page/reserve")
        guard = STREAMED_GUARD if "STREAMED_GUARD" in globals() else read(args.guard)
        require(guard["worker"]["disk"]["mount"] == "/var/lib/docker" and root.stat().st_dev == Path("/var/lib/docker").stat().st_dev,
                "Rewrite and actual cache volumes differ")
        raw_attestation = STREAMED_ATTESTATION_BYTES if "STREAMED_ATTESTATION_BYTES" in globals() else args.attestation.read_bytes()
        attestation = json.loads(raw_attestation)
        attested_sha = hashlib.sha256(raw_attestation).hexdigest()
        if args.action == "prepare" and (run / "plan.json").exists():
            plan = read(run / "plan.json")
            require(plan["dbIdentity"] == guard["identity"][:5] and plan["attestation"] == attested_sha,
                    "Different saved source or relation")
            require(len(plan["entries"]) <= args.max_entries and plan["expectedReturn"] <= args.max_bytes
                    and plan["margin"] == args.margin_bytes, "Resumed page exceeds the supplied bounds")
        else:
            owner = engine()
            scope = {"meshKeys": [], "tasks": None} if args.action == "prepare" and args.all_attested else worker_call(owner, "inspect")
            plan = select_entries(root, run.parent, guard, args.margin_bytes, args.parking_reserve_bytes, args.max_bytes,
                                  args.max_entries, args.min_age_days, set(scope["meshKeys"]), attestation, args.all_attested)
            plan["attestation"] = attested_sha
            plan["dbIdentity"] = guard["identity"][:5]
            plan["activeTaskCount"] = scope["tasks"]
            plan["protectedMeshKeys"] = len(scope["meshKeys"])
            started = time.monotonic()
            for item in plan["entries"]:
                fast_identity(root / NAMESPACE / item["key"], item)
            plan["metadataRecheckSeconds"] = time.monotonic() - started
            if args.action == "plan":
                clock_pid = master(owner, scope["masterPid"])
                fd = pidfd(clock_pid)
                os.close(fd)
                plan["externalOpenMeshes"] = sorted(open_cache_readers({q["key"] for q in plan["entries"]})) if plan["entries"] else []
        copy_result = {}
        if args.action == "prepare":
            with locked(run.parent / ("." + run.name + ".copy.lock")):
                copy_result = prepare(run, plan)
        print(json.dumps({**summarize(plan), **copy_result}))
    else:
        require(regular_dir(run) and run.stat().st_uid == os.geteuid() and stat.S_IMODE(run.stat().st_mode) == 0o700,
                "Invalid private parking directory")
        with locked(Path("/tmp/airfoils-pro-deploy.lock")), locked(run.parent / ("." + run.name + ".copy.lock")), locked(run / "operator.lock"):
            if args.action == "recover-readers":
                recover_readers(run)
                return
            plan = load_prepared(run)
            require(plan["root"] == str(root), "This run belongs to another cache")
            fence = lambda keys: live_fence(run, keys)
            if args.action == "park":
                require(args.guard, "Supply the latest matching HZ rewrite guard")
                latest = STREAMED_GUARD if "STREAMED_GUARD" in globals() else read(args.guard)
                result = park(run, fence, latest, lambda: set(worker_call(engine(), "inspect")["meshKeys"]))
            else:
                require(args.restore_reserve_bytes and args.restore_reserve_bytes > 0, "Supply the restoration floor")
                result = restore(run, args.restore_reserve_bytes, fence)
            print(json.dumps(result))
            if result.get("meetsRequiredBytes") is False or result.get("conflicts"):
                sys.exit(2)


if __name__ == "__main__":
    main()
