#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
revision=$(git rev-parse HEAD)
tag="xfoilfoam-retention-check:sp-$$-$(git rev-parse --short=12 HEAD)"
scratch=$(mktemp -d)
cleanup() {
  docker image rm "$tag" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT
mkdir -m 700 "$scratch/jobs" "$scratch/tmp"
docker build --target sweeper --file "$root/docker/Dockerfile.node" --tag "$tag" "$root" >"$scratch/build.log" 2>&1 || {
  tail -35 "$scratch/build.log" >&2
  exit 1
}
image_id=$(docker image inspect --format '{{.Id}}' "$tag")
options=(--rm --network none --read-only --security-opt no-new-privileges --env TSX_DISABLE_CACHE=1 --env NODE_DISABLE_COMPILE_CACHE=1)
docker run "${options[@]}" --mount "type=bind,src=$scratch/jobs,dst=/data/airfoilfoam/jobs,readonly" \
  --mount "type=bind,src=$scratch/tmp,dst=/tmp" "$tag" /opt/airfoilfoam-retention/bin/python -IB -c \
  'import sys, os, hashlib, pathlib, json; sys.path.insert(0,"/app/src"); import airfoilfoam.automatic_retention as native; import airfoilfoam.closed_progressive_retention as closed; import zstandard, google_crc32c; from importlib.metadata import version; p=pathlib.Path(native.__file__); print(json.dumps({"python":sys.executable,"version":sys.version,"native":str(p),"nativeSha256":hashlib.sha256(p.read_bytes()).hexdigest(),"sharedFilePlannerSha256":hashlib.sha256(pathlib.Path(closed.__file__).read_bytes()).hexdigest(),"zstd":version("zstandard"),"crc32c":version("google-crc32c"),"jobsDev":os.stat("/data/airfoilfoam/jobs").st_dev,"jobsInode":os.stat("/data/airfoilfoam/jobs").st_ino}))'
echo "Qualified sweeper target $image_id from $revision"
# A private source-bound capture may be supplied explicitly for a read-only
# rollout rehearsal. Neither it nor the data it verifies is part of the image.
if [[ -f "$root/.codex-artifacts/ordinary-retention-image/input.json" ]]; then
  input=$(realpath "$root/.codex-artifacts/ordinary-retention-image")
  test -d "$input/jobs"
  docker run -i "${options[@]}" \
    --mount "type=bind,src=$input/jobs,dst=/data/airfoilfoam/jobs,readonly" \
    --mount "type=bind,src=$input/input.json,dst=/proof/input.json,readonly" \
    --mount "type=bind,src=$scratch/tmp,dst=/tmp" "$tag" node --import tsx --input-type=module - <<'JS'
import {readFile,stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {RetentionFiles} from "./apps/sweeper/src/retention-files.ts";
const input=JSON.parse(await readFile("/proof/input.json","utf8"));
const peer=new RetentionFiles("/data/airfoilfoam",AbortSignal.timeout(180000));
const plan=await peer.reclaimClosedProgressiveFiles(input.job,input.manifests);
if (plan.state!=="planned" || plan.plan!==input.plan || plan.bytes!==input.bytes || plan.files!==input.files ||
    !plan.workingPaths?.length || !plan.nativeOwner) throw Error("Read-only mounted source differs from its signed real plan");
for (const s of input.samples) {
  const path="/data/airfoilfoam/jobs/"+input.job+"/"+s.path;
  const st=await stat(path);
  const sha=createHash("sha256").update(await readFile(path)).digest("hex");
  if(st.size!==s.byteSize || sha!==s.sha256) throw Error("Original retained file differs from named capture");
}
console.log(JSON.stringify({realSource:true,state:plan.state,plan:plan.plan,files:plan.files,logicalBytes:plan.bytes,
  allocatedOnMountedCopy:plan.plannedAllocatedBytes,owner:plan.nativeOwner,authenticatedSamples:input.samples.length,removals:0}));
JS
fi
