"""One bounded pipe for the original worker's publish and settle calls.

The host owns admission. The resident Node process invokes the same release
entry point and closes its role-specific SQL client after each request.
"""
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

from closed_worker_report_host import (
    IDLE_SECONDS, MAX_REQUEST, MAX_RESPONSE, REQUEST_SECONDS,
    check, current_container, receive, send,
)

MAX_CALLS = 32
DEPLOY_LOCK = Path("/tmp/airfoils-pro-deploy.lock")
DEPLOYED = Path("/opt/airfoils-pro/app")
OWNER_SOURCE = Path("scripts/deploy/archive-closed-worker-reports.py")
PEER = Path("apps/sweeper/src/closed-worker-report-peer.mjs")
OPERATIONS = {"publish", "settle"}

# Keep both open file descriptions in a host process that waits for the
# actual docker exec to exit. If the SSH supervisor dies while a call is
# ambiguous, EOF ends the Node loop *after* its active request finishes.
KEEPER = """import subprocess,sys
fds=tuple(map(int,sys.argv[1:3]))
raise SystemExit(subprocess.run(sys.argv[3:],pass_fds=fds).returncode)
"""

NODE = r"""
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
const [peerHash, scope, owner] = process.argv.slice(1);
const path = './closed-worker-report-peer.mjs';
assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), peerHash);
const {invokeClosedReport} = await import(path);
const emit = (reply) => new Promise((resolve,reject) => {
  const text = JSON.stringify(reply);
  if (Buffer.byteLength(text) >= 2 * 1024 ** 2) return reject(new Error('Oversized writer response'));
  process.stdout.write(text+'\n', error => error ? reject(error) : resolve());
});
await emit({ready:'writer',bootMs:performance.now()});
let counter=0;
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  assert.ok(Buffer.byteLength(line) < 1024 ** 2);
  const {n,request} = JSON.parse(line);
  assert.ok(n===++counter && n<=32 && ['publish','settle'].includes(request.op));
  assert.equal(request.scope.sha256, scope);
  assert.equal(request.key.executionId, owner);
  const start=performance.now(), cpu=process.cpuUsage();
  let value;
  try {
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), peerHash);
    value=await invokeClosedReport(request);
  } catch (error) {
    const busy=/^Worker report archive upload failed [(](429|502|503|504)[)]$/.exec(error.message);
    if (request.op==='publish' && busy) value={retryableBrokerStatus:Number(busy[1])};
    else {
      const state=String(error.cause?.code ?? error.code ?? '');
      await emit({n,error:/^[A-Z0-9_]{1,32}$/.test(state)?state:'WRITER_REFUSED'});
      break;
    }
  }
  const used=process.cpuUsage(cpu);
  await emit({n,value,workMs:performance.now()-start,cpuMs:(used.user+used.system)/1000,
              peakRssKiB:process.resourceUsage().maxRSS});
}
"""


def file_id(stat):
    return stat.st_dev, stat.st_ino


def admit(file, operation, timeout=15):
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(file, operation | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            left = deadline - time.monotonic()
            if left <= 0:
                return False
            time.sleep(min(0.1, left))


def keep_writer(command, deploy, owner):
    fds = (deploy.fileno(), owner.fileno())
    return subprocess.Popen(
        [sys.executable, "-IB", "-c", KEEPER, *map(str, fds), *command],
        pass_fds=fds, start_new_session=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )


def host_writer(revision, container, scope, execution, program_sha, runtime_sha):
    check(re.fullmatch(r"[0-9a-f]{40}", revision) and re.fullmatch(r"[0-9a-f]{64}", scope)
          and re.fullmatch(r"[0-9a-f]{64}", program_sha) and re.fullmatch(r"[0-9a-f]{64}", runtime_sha)
          and re.fullmatch(r"[0-9a-f-]{36}", execution), "Invalid native writer binding")
    owner_path = DEPLOYED / OWNER_SOURCE
    readonly = os.O_RDONLY | os.O_NOFOLLOW
    with os.fdopen(os.open(DEPLOY_LOCK, readonly), "rb") as deploy, os.fdopen(os.open(owner_path, readonly), "rb") as owner:
        if not admit(owner, fcntl.LOCK_EX) or not admit(deploy, fcntl.LOCK_SH):
            send(sys.stdout.buffer, {"busy": True})
            return
        def verify_files():
            check(file_id(os.fstat(owner.fileno())) == file_id(owner_path.stat()) and
                  file_id(os.fstat(deploy.fileno())) == file_id(DEPLOY_LOCK.stat()), "Native writer lease file changed")
        verify_files()
        lease = current_container(revision, container)
        check(hashlib.sha256((DEPLOYED / PEER).read_bytes()).hexdigest() == program_sha, "Native peer changed")
        cmd = ["docker","exec","-i","-w","/app/apps/sweeper/src",lease[0],"node","--import","tsx",
               "--input-type=module","-e",NODE,program_sha,scope,execution]
        proc = keep_writer(cmd, deploy, owner)
        try:
            ready = receive(proc.stdout, 65536, 35)
            check(ready and ready.get("ready") == "writer", "Native writer did not authenticate its source")
            current_container(revision, container, lease)
            fcntl.flock(deploy, fcntl.LOCK_UN)
            send(sys.stdout.buffer, dict(ready, revision=revision, source=program_sha, container=lease))
            for counter in range(1, MAX_CALLS + 1):
                msg = receive(sys.stdin.buffer, MAX_REQUEST, IDLE_SECONDS)
                if msg is None:
                    break
                request = msg["request"]
                check(msg["n"] == counter and request["op"] in OPERATIONS and
                      request["scope"]["sha256"] == scope and request["key"]["executionId"] == execution,
                      "Foreign or unordered native writer request")
                runtime = json.dumps(request["runtime"], sort_keys=True, separators=(",", ":")).encode()
                check(hashlib.sha256(runtime).hexdigest() == runtime_sha, "Installed role file roster changed")
                if not admit(deploy, fcntl.LOCK_SH):
                    send(sys.stdout.buffer, {"n":counter,"busy":True})
                    break
                verify_files()
                current_container(revision, container, lease)
                send(proc.stdin, msg)
                result = receive(proc.stdout, MAX_RESPONSE, REQUEST_SECONDS)
                if result is None:
                    current_container(revision, container, lease)
                    raise EOFError("The in-flight native writer exited before acknowledging its request")
                check(result.get("n") == counter, "Mismatched native writer acknowledgement")
                current_container(revision, container, lease)
                fcntl.flock(deploy, fcntl.LOCK_UN)
                send(sys.stdout.buffer, result)
                if result.get("error"):
                    break
        finally:
            # Never explicitly unlock or terminate the native child on an
            # ambiguous reply. Its inherited leases outlive a disconnected SSH client.
            proc.communicate()


class WriterTransportInterrupted(RuntimeError):
    def __init__(self, message):
        super().__init__("Native write transport interrupted; reconcile the saved page")
        self.operation = message["op"]
        rows = message.get("items") or [message]
        self.keys = [row["key"] for row in rows]
        self.pins = [row.get("pin") for row in rows]
        self.sources = [row["source"] for row in rows]
        self.share_results = message.get("shareResults", False)


class NativeWriteSession:
    def __init__(self):
        self.child = None
        self.binding = None
        self.counter = 0
        self.last_reply = 0.0
        self.boot_ms = 0.0
        self.lease = None

    def close(self):
        child, self.child = self.child, None
        self.binding = None
        if child is not None:
            with contextlib.suppress(BrokenPipeError):
                child.stdin.close()
            try:
                child.wait(timeout=6)
            except subprocess.TimeoutExpired:
                # Only close the local SSH transport. The remote guardian remains
                # responsible for the original locks until the real writer exits.
                child.terminate()
                child.wait(timeout=6)
            child.stdout.close()

    def open(self, args, binding):
        revision, container, scope, execution, sha, runtime_sha = binding
        # Only the controller's pipe driver is delivered here. The common
        # protocol and the scientific peer must match the deployed source.
        common = Path(__file__).with_name("closed_worker_report_host.py")
        common_sha = hashlib.sha256(common.read_bytes()).hexdigest()
        host_source = Path(__file__).read_text()
        bootstrap = ("import hashlib,sys,types; from pathlib import Path; "
                     "p=Path('/opt/airfoils-pro/app/scripts/deploy/closed_worker_report_host.py'); "
                     "s=p.read_bytes(); "
                     "sys.exit(75) if hashlib.sha256(s).hexdigest()!=sys.argv[1] else None; "
                     "m=types.ModuleType('closed_worker_report_host'); "
                     "exec(compile(s,str(p),'exec'),m.__dict__);sys.modules[m.__name__]=m\n")
        remote = shlex.join(["python3", "-IB", "-c",
                             bootstrap + host_source + "\ntry: host_writer(*sys.argv[2:])"
                             "\nexcept (TimeoutError,EOFError,BrokenPipeError,ConnectionResetError): sys.exit(74)"
                             "\nexcept (ValueError,OSError,subprocess.SubprocessError): sys.exit(65)",
                             common_sha, revision, container, scope, execution, sha, runtime_sha])
        self.child = subprocess.Popen(["ssh","-T","-C","-oBatchMode=yes","-oForwardAgent=no","-oClearAllForwardings=yes",
                                       "-oStrictHostKeyChecking=yes","-oConnectTimeout=10","-oServerAliveInterval=15",
                                       "-oServerAliveCountMax=2",args.hz_host,remote],
                                      stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        ready = receive(self.child.stdout, 65536, 52)
        if ready and ready.get("busy"):
            return False
        if ready is None:
            code = self.child.wait(timeout=5)
            if code in (74, 255):
                return False
            raise RuntimeError(f"Native writer source lease refused ({code})")
        check(ready and ready.get("ready") == "writer" and ready.get("revision") == revision and
              ready.get("source") == sha and ready.get("container"), "Writer did not confirm its installed source")
        self.binding, self.counter, self.boot_ms, self.lease = binding, 0, ready["bootMs"], ready["container"]
        return True

    def ask(self, args, message, source):
        check(args.apply and message["op"] in OPERATIONS, "Mutation requires the original native writer")
        runtime = json.dumps(message["runtime"], sort_keys=True, separators=(",", ":")).encode()
        binding = (args.runtime_revision, args.hz_sweeper, args.frozen_sha256, message["key"]["executionId"],
                   hashlib.sha256(source.encode()).hexdigest(), hashlib.sha256(runtime).hexdigest())
        check(message["scope"]["sha256"] == args.frozen_sha256, "Writer scope differs")
        payload = json.dumps(message,separators=(",",":"),ensure_ascii=False).encode()
        if len(payload) + 64 > MAX_REQUEST:
            self.close()
            return None
        if self.binding != binding or self.counter >= MAX_CALLS or time.monotonic() - self.last_reply > IDLE_SECONDS - 10:
            self.close()
        try:
            if self.child is None and not self.open(args, binding):
                raise WriterTransportInterrupted(message)
            self.counter += 1
            send(self.child.stdin, {"n":self.counter,"request":message})
            result = receive(self.child.stdout, MAX_RESPONSE, REQUEST_SECONDS + 20)
            if result is None:
                code = self.child.wait(timeout=5)
                if code in (0, 74, 255):
                    raise WriterTransportInterrupted(message)
                raise RuntimeError(f"Native writer refused ({code})")
            check(result.pop("n") == self.counter, "Mismatched native write response")
            if result.get("busy"):
                raise WriterTransportInterrupted(message)
            if result.get("error"):
                raise RuntimeError(f"Native writer {message['op']} refused: {result['error']}")
            result.update(bootMs=self.boot_ms if self.counter==1 else 0, warmWriter=self.counter>1,
                          writerContainer=self.lease)
            self.last_reply = time.monotonic()
            return result
        except (BrokenPipeError, ConnectionResetError, TimeoutError, EOFError, subprocess.TimeoutExpired) as error:
            self.close()
            raise WriterTransportInterrupted(message) from error
        except BaseException:
            self.close()
            raise
