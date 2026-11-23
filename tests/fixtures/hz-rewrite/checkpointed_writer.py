"""A checkpointed controller with an SSH-like flock child finishing after stop."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

lock, checkpoint = map(Path, sys.argv[1:])
stopping = False


def stop(*_):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
last = int(json.loads(checkpoint.read_text())["cursor"])
# A reader under the actual deployment lock. EOF starts the final, bounded
# remote operation. Stopping the controller leaves this child alive briefly.
remote = subprocess.Popen(
    ["flock", "-s", str(lock), "sh", "-c", "echo locked; cat >/dev/null; sleep 1.2"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    start_new_session=True,
)
assert remote.stdout.readline() == b"locked\n"
tmp = checkpoint.with_suffix(".tmp")
with tmp.open("w") as out:
    json.dump({"source": "same-archive", "cursor": last + 1}, out)
    out.flush()
    os.fsync(out.fileno())
tmp.replace(checkpoint)
print(last + 1, flush=True)
while not stopping:
    time.sleep(0.03)
remote.stdin.close()
