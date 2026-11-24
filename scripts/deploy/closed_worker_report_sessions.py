"""Bounded read sessions used only by the closed-report controller. Writers use the original host flock."""
import contextlib
import hashlib
import json
import shlex
import subprocess
import threading
import time
from pathlib import Path
from closed_worker_report_host import MAX_REQUEST, MAX_RESPONSE, READ_CONTAINER_STOPPED, ROLE_READS, allowed, receive, send


class ReadPeerStopped(RuntimeError):
    """The exact registered read container was inspected and found stopped."""
    def __init__(self, role):
        super().__init__(f"{role} report reader container is stopped")
        self.role = role
        self.keys = []


class ReadTransportLost(RuntimeError):
    """A read-only pipe closed without delivering the response."""


class ReportReadSession:
    def __init__(self, args, role, source):
        host, container = {"hub":(args.hub_host,args.hub_sweeper),"api":(args.hz_host,args.hz_api),
                           "worker":(args.hz_host,args.hz_sweeper)}[role]
        digest=hashlib.sha256(source.encode()).hexdigest()
        guard=Path(__file__).with_name("closed_worker_report_host.py").read_text()
        remote=shlex.join(["python3","-IB","-c",guard,args.runtime_revision,container,role,digest])
        self.child=subprocess.Popen(["ssh","-T","-C","-oBatchMode=yes","-oForwardAgent=no","-oClearAllForwardings=yes",
                                     "-oStrictHostKeyChecking=yes","-oConnectTimeout=10","-oServerAliveInterval=15",
                                     "-oServerAliveCountMax=2",host,remote],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL)
        self.count=0
        self.initialization_started=time.monotonic()
        try:
            try:
                send(self.child.stdin, {"source": source})
                ready = receive(self.child.stdout, 65536, 45)
            except BrokenPipeError:
                ready = None
            if ready is None and self.child.wait(timeout=5) == READ_CONTAINER_STOPPED:
                raise ReadPeerStopped(role)
            if not ready or ready.get("ready")!=role or ready.get("source")!=digest or ready.get("revision")!=args.runtime_revision:
                raise RuntimeError("Persistent reader did not verify its installed owner")
            self.boot_ms=ready["bootMs"]
            self.session_identity=ready["container"]
        except BaseException:
            self.close()
            raise

    def ask(self, role, msg):
        allowed(role,msg)
        self.count+=1
        encoded=json.dumps(msg,separators=(",",":"),ensure_ascii=False).encode()
        if len(encoded)+64>MAX_REQUEST:
            raise ValueError("Report read request exceeds its bound")
        try:
            send(self.child.stdin,{"n":self.count,"request":msg})
            response=receive(self.child.stdout,MAX_RESPONSE,170)
        except (BrokenPipeError,EOFError):
            response=None
        except TimeoutError as error:
            raise ReadTransportLost(f"{role} reader timed out") from error
        if response is None:
            code=self.child.wait(timeout=5)
            if code == READ_CONTAINER_STOPPED:
                raise ReadPeerStopped(role)
            if code in (74,255):
                raise ReadTransportLost(f"{role} reader pipe closed ({code})")
            raise RuntimeError(f"{role} reader refused ({code})")
        if response.get("n")!=self.count or response.get("error"):
            raise RuntimeError(f"{role} read refused: {response.get('error','wrong sequence')}")
        response.pop("n")
        response["bootMs"]=self.boot_ms if self.count==1 else 0
        response["warmSession"]=self.count>1
        return response

    def close(self):
        with contextlib.suppress(BrokenPipeError):
            self.child.stdin.close()
        try:
            self.child.wait(timeout=6)
        except subprocess.TimeoutExpired:
            self.child.terminate()
            self.child.wait(timeout=6)
        finally:
            self.child.stdout.close()


class ReportReadSessions:
    def __init__(self):
        self.sessions={}
        self.locks={key:threading.Lock() for key in ROLE_READS}

    def ask(self,args,role,msg,source):
        allowed(role,msg)
        with self.locks[role]:
            session=self.sessions.get(role)
            if session is None:
                session=self.sessions[role]=ReportReadSession(args,role,source)
            try:
                return session.ask(role,msg)
            except ReadTransportLost:
                # A retry may repeat an authenticated read. All writes use the one-shot owner.
                session.close()
                session=self.sessions[role]=ReportReadSession(args,role,source)
                return session.ask(role,msg)

    def close(self):
        for session in self.sessions.values():
            with contextlib.suppress(OSError,subprocess.SubprocessError):
                session.close()
        self.sessions.clear()
