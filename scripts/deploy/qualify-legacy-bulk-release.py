#!/usr/bin/env python3
"""Qualify the installed ordinary 256 MiB report exporter before its normal service starts."""
import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

CAP = 256 * 1024**2
REPLAY = Path(__file__).with_name("legacy-bulk-cap-replay.mjs")
READER_FILES = (
    "apps/sweeper/src/legacy-report-storage-custody-worker.ts",
    "apps/sweeper/src/legacy-worker-report-product-read.ts",
    "apps/sweeper/src/legacy-report-storage.ts",
    "packages/db/src/legacy-report-storage-codec.ts",
    "packages/db/src/legacy-report-custody.ts",
    "packages/db/src/progressive-report-archive.ts",
)
METADATA = {"completion.json", "delivery.json"}


def check(condition, reason):
    if not condition:
        raise ValueError(reason)


def read(p):
    return json.loads(p.read_bytes())


def sha(p):
    with p.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def hash_json(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def write(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
        tmp = Path(out.name)
        json.dump(value, out, indent=2)
        out.write("\n")
        out.flush()
        os.fsync(out.fileno())
    try:
        if path.exists():
            os.chmod(tmp, path.stat().st_mode & 0o777)
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        tmp.unlink(missing_ok=True)


def command(*argv):
    return subprocess.check_output([str(a) for a in argv], timeout=240)


def verify_install(directory, wanted=None):
    deployment = read(directory / "deployment.json")
    files = deployment["files"]
    check(deployment["entry"] == "legacy-cli.mjs" and "legacy-cli.mjs" in files and METADATA <= files.keys(),
          "Unexpected installed package entry")
    if wanted is not None:
        check(files == wanted, "Installed file manifest differs from sealed package")
    for name, expected in files.items():
        f = directory / name
        check(not Path(name).is_absolute() and ".." not in Path(name).parts and f.resolve() == f and f.is_file()
              and sha(f) == expected, "Installed package file differs: " + name)
    actual = {str(f.relative_to(directory)) for f in directory.rglob("*") if f.is_file() or f.is_symlink()}
    check(actual == set(files) | {"deployment.json"}, "Uncatalogued installed package input")
    return deployment


def policy_scope(args, settings):
    scope = hash_json(read(args.state / "scope.json"))
    checkpoint = read(args.state / "progress/checkpoint.json")
    check(bool(re.fullmatch("[0-9a-f]{64}", scope)) and scope == settings["scopeSha256"] and
          settings["sourceBinding"] == checkpoint["binding"] and settings["capBytes"] == CAP
          and settings["rows"] == 128 and settings["normalPages"] == 16 and
          sha(args.state / "run-migration.py") == settings["canonicalWrapperSha256"], "Ordinary scope, checkpoint, row/byte cap or launcher changed")
    return scope


def package(args):
    prefix = str(args.wave)
    catalog = read(Path(prefix + "-operator-catalog.json"))
    delivery = read(Path(prefix + "-operator-delivery.json"))
    check(catalog["run_complete"] and catalog["run_status"] == "passed" and catalog["requested_tier"] == "release"
          and catalog["test"] == "progressive-report-archive" and catalog["readiness_eligible"] and catalog["proof"] == "complete",
          "Complete governed release check required")
    for key in ("run_id", "check", "source_sha256", "config_sha256", "manifest_sha256", "repository_id", "run_metadata_sha256"):
        check(catalog[key] == delivery[key], "Catalog and qualified delivery differ: " + key)
    check(delivery["qualified"] is True and delivery["kind"] == "local-executable" and
          delivery["check"] == "package-report-migrator" and delivery["target"] == "report-storage-operator"
          and delivery["artifact"] == catalog["artifact"]["name"] == "report-migrator" and
          delivery["artifact_sha256"] == catalog["artifact"]["sha256"] and catalog["next_offset"] is None,
          "Wrong or incomplete report operator qualification")
    entries = {r["path"]: r["sha256"] for r in catalog["entries"]}
    check(len(entries) == len(catalog["entries"]) == catalog["artifact"]["files"]
          and entries.get("delivery.json") == delivery["verification_sha256"] and entries.get("completion.json") == delivery["completion_sha256"],
          "Incomplete or conflicting sealed files")
    installation = args.state / "operator" / args.revision
    manifest = verify_install(installation, entries)
    check(manifest["sourceRevision"] == args.revision and manifest["sourceDigest"] == delivery["source_sha256"]
          and manifest["deliveryReceipt"] == delivery["receipt_id"], "Installed delivery identity differs")
    roles = [read(Path(prefix + "-runtime-" + role + ".json")) for role in args.roles]
    check(len(set(args.roles)) == 2 and roles[0]["manifest"] == roles[1]["manifest"] and
          roles[0]["manifest"]["sourceRevision"] == args.revision and all(r["health"] == "passed" and r["verifiedAt"] for r in roles),
          "Both serving roles must verify the deployed source")
    for f in READER_FILES:
        expected = hashlib.sha256(command("git", "-C", args.checkout, "show", args.revision + ":" + f)).hexdigest()
        check(all(r["files"].get(f) == expected for r in roles), "Serving report reader differs: " + f)
    return delivery, roles[0]["manifest"]["sourceTreeSha256"], manifest


def measure(args, scope, installed):
    fixture = args.representative
    check(fixture is not None and args.accepted_canary is not None, "Supply the retained genuine near-cap page and accepted live canary measurements")
    decision = read(args.accepted_canary)
    check(decision["action"] == "keep256" and decision["allFourReceiptsGenuine"] and decision["headroomAndIngestionPassed"]
          and decision["measuredPositive"] and sha(Path(decision["receiptPath"])) == decision["receiptSha256"],
          "Missing accepted four-page capacity evidence")
    original = read(fixture / "receipt.json")
    check(original["scopeSha256"] == scope and str(original["object"]["generation"]).isdigit(), "Benchmark source is outside the frozen scope")
    name = f"{sha(fixture / 'receipt.json')}.{original['object']['sha256']}.{original['object']['generation']}.receipt.json"
    base = args.state / "progress" / name
    check(sha(base) == sha(fixture / "receipt.json") and any(sha(p) == sha(fixture / "applied.json") for p in base.parent.glob(name + ".*.custody-applied.json")),
          "Retained inputs differ from original production checkpoint receipts")
    head = command("git", "-C", args.checkout, "rev-parse", "HEAD").decode().strip()
    check(head == args.revision and not command("git", "-C", args.checkout, "status", "--porcelain", "--untracked-files=no", "packages", "apps", "pnpm-lock.yaml"),
          "Use the clean candidate checkout for changed-input replay")
    result = json.loads(command("node", "--import", args.checkout / "node_modules/tsx/dist/loader.mjs", REPLAY,
                                "replay", args.checkout, args.revision, fixture, installed, args.state / "scope.json"))
    check(result["scope"] == scope and result["receiptSha256"] == sha(base) and 0 < result["elapsedMs"] <= 120000 and
          0 < result["peakRssKiB"] <= math.floor(decision["heaviestWorkerHWMGiB"] * 1024**2), "Candidate exceeds the admitted memory or proof-age envelope")
    return result


def qualify(args):
    for rev in (args.revision, args.previous):
        check(re.fullmatch("[a-f0-9]{40}", rev), "Expected exact release revisions")
    settings = read(args.policy)
    scope = policy_scope(args, settings)
    previous = settings["qualifiedReleases"][args.previous]
    prev_dir = args.state / "operator" / args.previous
    check(previous["normalSlots"] == 1 and previous["normalCapBytes"] == CAP and
          previous["expectedInstalledManifestSha256"] == sha(prev_dir / "deployment.json"), "Previous ordinary release is unqualified")
    old = verify_install(prev_dir)
    check(old["deliveryReceipt"] == previous["operatorDelivery"] and old["sourceRevision"] == args.previous, "Predecessor receipt differs")
    delivery, tree, current = package(args)
    installed = args.state / "operator" / args.revision
    registration = dict(sourceTree=tree, operatorDelivery=delivery["receipt_id"], expectedInstalledManifestSha256=sha(installed / "deployment.json"),
                        normalSlots=1,normalCapBytes=CAP,bulkRun=delivery["run_id"],singleUnit=previous["singleUnit"])
    check(re.fullmatch(r"[A-Za-z0-9_.@-]+@bulk\.service",previous["singleUnit"]), "Wrong unit for the ordinary budget")
    def inputs(revision, files):
        code = json.loads(command("node", REPLAY, "fingerprint", args.checkout, revision))
        return {"worker":code["sha256"],"runtimeFiles":{k:v for k,v in files.items() if k not in METADATA}}
    earlier_inputs = inputs(args.previous,old["files"])
    current_inputs = inputs(args.revision,current["files"])
    proof = {"scopeSha256":scope,"previous":args.previous,"sourceRevision":args.revision,"budget":registration,
             "fingerprint":hash_json(current_inputs),"samePayloadAndReaders":earlier_inputs == current_inputs}
    already_qualified = settings["qualifiedReleases"].get(args.revision) == registration
    if args.exercise_replay or (not proof["samePayloadAndReaders"] and not already_qualified):
        proof["nearCapReplay"] = measure(args,scope,installed)
    check(args.lock.is_file(), "Original controller configuration lock is missing")
    with args.lock.open("rb") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        latest=read(args.policy)
        check(policy_scope(args,latest) == scope and latest["qualifiedReleases"].get(args.previous) == previous,
              "Predecessor or active source changed during qualification")
        existing=latest["qualifiedReleases"].get(args.revision)
        check(existing in (None,registration), "Conflicting existing qualification for this revision")
        if args.register and existing is None:
            state=command("systemctl","--user","show",previous["singleUnit"],"--property=ActiveState","--value").decode().strip()
            check(state in ("inactive","failed"), "Use the original unit's paused pre-start window")
            check(package(args)[0] == delivery, "Installed package changed during qualification")
            authoritative = json.loads(command("devcoordinator2","--client","codex","call","release.evidence","--params",
                                               json.dumps({"reference":delivery["receipt_id"]})))
            check(authoritative.get("ok") and authoritative.get("data") == delivery,
                  "The authoritative qualified delivery differs from the saved package receipt")
            for role in args.roles:
                check(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}",role), "Invalid serving role")
                marker = json.loads(command("ssh","-T","-oBatchMode=yes","-oForwardAgent=no","-oClearAllForwardings=yes",
                                            "-oStrictHostKeyChecking=yes","-oConnectTimeout=8",role,
                                            "cat /opt/airfoils-pro/app/.deployment-source.json"))
                check(marker == read(Path(str(args.wave) + "-runtime-" + role + ".json"))["manifest"], "Live source changed before registration")
            # Merge the one record while holding the same lock as the scope controller.
            latest["qualifiedReleases"][args.revision]=registration
            write(args.policy,latest)
        proof["registered"]=read(args.policy)["qualifiedReleases"].get(args.revision)==registration
    return proof


if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    for opt in ("state","policy","lock","checkout","wave"):
        p.add_argument("--"+opt,type=Path,required=True)
    p.add_argument("--roles",nargs=2,required=True,metavar=("HUB","WORKER"))
    p.add_argument("--revision",required=True)
    p.add_argument("--previous",required=True)
    p.add_argument("--representative",type=Path)
    p.add_argument("--accepted-canary",type=Path)
    p.add_argument("--exercise-replay",action="store_true",help="Also exercise the retained near-cap case for an already identical runtime")
    p.add_argument("--register",action="store_true",help="Add the qualified entry before the existing service starts")
    try:
        print(json.dumps(qualify(p.parse_args()),indent=2))
    except (KeyError,ValueError,OSError,subprocess.SubprocessError) as exc:
        sys.exit(str(exc))
