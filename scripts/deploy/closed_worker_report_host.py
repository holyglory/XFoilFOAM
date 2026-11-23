"""Pipe-only controller peer. Every request is read-only and bound to the live container and deployment."""
import hashlib
import json
import os
import re
import selectors
import subprocess
import sys
import time
from pathlib import Path

MAX_REQUEST = 1024 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
IDLE_SECONDS = 90
REQUEST_SECONDS = 165
ROLE_READS = {"hub": {"hub", "cloud", "discover-hub"},
              "api": {"read"}, "worker": {"read", "source", "discover-worker"}}


def check(value, message):
    if not value:
        raise ValueError(message)


def receive(stream, limit, timeout):
    """Each sender waits for its matching response before sending another frame."""
    data = bytearray()
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as poll:
        poll.register(stream, selectors.EVENT_READ)
        while len(data) <= limit:
            if not poll.select(max(0.0, deadline-time.monotonic())):
                raise TimeoutError("Report reader pipe timed out")
            chunk = os.read(stream.fileno(), min(65536, limit+1-len(data)))
            if not chunk:
                if not data:
                    return None
                raise EOFError("Incomplete report reader frame")
            data.extend(chunk)
            if b"\n" in chunk:
                check(data.endswith(b"\n") and data.count(b"\n")==1 and len(data)<=limit, "Invalid report reader frame")
                return json.loads(data)
    raise ValueError("Report reader frame exceeds its bound")


def send(stream, value):
    data=json.dumps(value, separators=(",",":"), ensure_ascii=False).encode()+b"\n"
    check(len(data)<=MAX_RESPONSE, "Report reader reply exceeds its bound")
    stream.write(data)
    stream.flush()


def current_container(revision, container):
    marker=json.loads(Path("/opt/airfoils-pro/app/.deployment-source.json").read_bytes())
    if marker["sourceRevision"]!=revision:
        raise SystemExit(75)
    fields=subprocess.check_output(["docker","inspect","-f","{{.Id}} {{.State.StartedAt}} {{.State.Running}}",container],
                                   timeout=8,text=True).split()
    check(len(fields)==3 and re.fullmatch(r"[0-9a-f]{64}",fields[0]) and fields[2]=="true", "Container is unavailable")
    return fields[:2]


def allowed(role, m):
    check(m["op"] in ROLE_READS[role], "Read-only report peer received a write or a foreign role")
    if m["op"]=="read":
        check(m.get("reader")==("api" if role=="api" else "sweeper"),"Wrong native reader")


def host_main(revision, container, role, program_sha):
    check(role in ROLE_READS and re.fullmatch(r"[a-f0-9]{40}",revision) and re.fullmatch(r"[a-f0-9]{64}",program_sha),
          "Missing reader identity")
    lease=current_container(revision,container)
    boot=receive(sys.stdin.buffer,MAX_REQUEST,15)
    source=boot["source"]
    check(hashlib.sha256(source.encode()).hexdigest()==program_sha,"Report reader source changed")
    program=source+"\nawait serveClosedReportReads("+json.dumps(role)+");"
    cmd=["docker","exec","-i","-w","/app/apps/sweeper/src",lease[0],"node","--import","tsx","--input-type=module","-e",program]
    proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        ready=receive(proc.stdout,65536,30)
        check(ready and ready.get("ready")==role,"Reader did not start")
        send(sys.stdout.buffer,{**ready,"source":program_sha,"revision":revision,"container":lease})
        for counter in range(1,129):
            msg=receive(sys.stdin.buffer,MAX_REQUEST,IDLE_SECONDS)
            if msg is None:
                break
            check(msg["n"]==counter,"Out-of-order report request")
            allowed(role,msg["request"])
            if current_container(revision,container)!=lease:
                raise SystemExit(75)
            send(proc.stdin,msg)
            res=receive(proc.stdout,MAX_RESPONSE,REQUEST_SECONDS)
            check(res and res.get("n")==counter,"Mismatched report response")
            if current_container(revision,container)!=lease:
                raise SystemExit(75)
            send(sys.stdout.buffer,res)
            if res.get("error"):
                break
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.terminate()
            proc.wait(timeout=4)


if __name__=="__main__":
    try:
        host_main(*sys.argv[1:])
    except (TimeoutError,EOFError,OSError,subprocess.TimeoutExpired):
        sys.exit(74)
    except (ValueError,subprocess.CalledProcessError):
        sys.exit(65)
