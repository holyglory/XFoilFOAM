#!/usr/bin/env python3
"""Clear all generations from the dedicated solver bucket, preserving policy."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import urllib.parse
import urllib.request


BUCKET = "airfoils-pro-storage-bucket"
RESET = runpy.run_path(str(Path(__file__).with_name("reset-solver-domain.py")))


def policy_projection(metadata: dict) -> dict:
    return {key: value for key, value in metadata.items()
            if key not in {"updated", "metageneration", "etag"}}


def api(resource: str, parameters: dict | None = None) -> dict:
    token = subprocess.run(
        ["gcloud", "auth", "print-access-token"], check=True, capture_output=True, text=True,
    ).stdout.strip()
    suffix = "?" + urllib.parse.urlencode(parameters) if parameters else ""
    request = urllib.request.Request(
        "https://storage.googleapis.com/storage/v1/b/" + BUCKET + resource + suffix,
        headers={"Authorization": "Bearer " + token},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def inventory(path: Path) -> dict:
    page_token = None
    count = 0
    total_bytes = 0
    checksum = hashlib.sha256()
    with path.open("x") as stream:
        while True:
            parameters = {"versions": "true", "maxResults": "1000",
                          "fields": "items(name,generation,size),nextPageToken"}
            if page_token:
                parameters["pageToken"] = page_token
            page = api("/o", parameters)
            for item in page.get("items", []):
                line = json.dumps(item, sort_keys=True) + "\n"
                stream.write(line)
                checksum.update(line.encode())
                count += 1
                total_bytes += int(item["size"])
            page_token = page.get("nextPageToken")
            if not page_token:
                break
        stream.flush()
        os.fsync(stream.fileno())
    return {"objects": count, "bytes": total_bytes, "sha256": checksum.hexdigest()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", type=Path, required=True)
    arguments = parser.parse_args()
    os.umask(0o077)
    audit = arguments.audit.resolve()
    with RESET["deployment_lock"](Path("/tmp/airfoils-pro-deploy.lock")):
        reset = RESET["Reset"]("app", audit)
        reset.quiesced()
        configuration, solver = reset.inventory()
        reset.verify_preservation(configuration, solver)
        if not (audit / "database-erased.json").exists():
            raise ValueError("Database reset must complete before storage cleanup")
        metadata = api("")
        policy = policy_projection(metadata)
        iam = api("/iam")
        policy_path = audit / "bucket-policy-before.json"
        if policy_path.exists():
            previous = json.loads(policy_path.read_text())
            if previous != {"bucket": policy, "iam": iam}:
                raise ValueError("Bucket configuration changed since reset began")
        else:
            RESET["atomic_json"](policy_path, {"bucket": policy, "iam": iam})
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        manifest = audit / f"bucket-objects-{stamp}.jsonl"
        before = inventory(manifest)
        if before["objects"]:
            with (audit / f"bucket-deletion-{stamp}.log").open("wb") as log:
                subprocess.run(
                    ["gcloud", "storage", "rm", "--all-versions", "--exclude-managed-folders",
                     "gs://" + BUCKET + "/**", "--quiet"],
                    check=True, stdout=log, stderr=log,
                )
        remaining = api("/o", {"versions": "true", "maxResults": "1",
                               "fields": "items(name,generation),nextPageToken"})
        if remaining.get("items") or remaining.get("nextPageToken"):
            raise ValueError("Live or noncurrent objects remain; writers stay stopped")
        if policy_projection(api("")) != policy or api("/iam") != iam:
            raise ValueError("Bucket policy changed during cleanup")
        receipt = {
            "bucket": BUCKET, "verified_at": datetime.now(timezone.utc).isoformat(),
            "before": before, "live_and_noncurrent_objects": 0,
            "bucket_and_iam_unchanged": True,
            "soft_delete_policy": metadata.get("softDeletePolicy"),
            "soft_deleted_objects": "retained until the existing policy expires",
        }
        RESET["atomic_json"](audit / "bucket-cleared.json", receipt)
        print(json.dumps(receipt))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
