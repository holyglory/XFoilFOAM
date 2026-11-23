"""Operate on one ordinary Linux core in a pinned, closed native case.

The raw inode moves on its own filesystem. It never becomes an evidence archive.
"""
from __future__ import annotations

from contextlib import ExitStack, contextmanager
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import signal
import stat
import struct
from urllib.parse import unquote, urlsplit
import uuid

from solver_core_host import atomic_json, load_json

CORE = re.compile(r"core(?:\.[1-9][0-9]*)?\Z")
# The native polar and individual case slugs come from jobs.polar_slug and CaseSpec.slug.
NUMBER = r"(?:m?\d+(?:p\d+)?(?:e[+m]?\d+)?)"
CASE = re.compile(rf"c{NUMBER}_u{NUMBER}(?:_a{NUMBER})?\Z")
DIR = os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
FIELDS = ("dev", "ino", "size", "allocated", "nlink", "mtimeNs", "ctimeNs")
RENAME_NOREPLACE = 1


class Held(Exception):
    """The candidate is retained or restored, with a concrete reason."""


def require(value, detail):
    if not value:
        raise Held(detail)


def file_id(st):
    return dict(dev=st.st_dev, ino=st.st_ino, size=st.st_size, allocated=st.st_blocks*512,
                nlink=st.st_nlink, mtimeNs=st.st_mtime_ns, ctimeNs=st.st_ctime_ns)


def same_inode(a, b):
    return b is not None and (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def identity_matches(st, row, *, renamed=False):
    identity = file_id(st)
    return stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and all(
        identity[k] == row[k] for k in FIELDS if not (renamed and k == "ctimeNs"))


def subject(row):
    job = str(uuid.UUID(row["j"]))
    parts = row["r"].split("/")
    require(row["j"] == job and len(parts) == 3 and parts[0] == "cases" and
            CASE.fullmatch(parts[1]) and CORE.fullmatch(parts[2]), "outside native case scratch")
    require(all(type(row.get(k)) is int for k in FIELDS) and row["nlink"] == 1, "invalid inventoried identity")
    return job, parts[1], parts[2]


def elf_core(fd, source_name="core"):
    """Verify the ELF tables and complete Linux notes without reading process memory."""
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "not a single-link regular file")
    ident = os.pread(fd, 16, 0)
    require(len(ident) == 16 and ident[:4] == b"\x7fELF" and ident[4] in (1, 2)
            and ident[5] in (1, 2) and ident[6] == 1, "not ELF")
    order = "<" if ident[5] == 1 else ">"
    wide = ident[4] == 2
    header = struct.Struct(order + ("HHIQQQIHHHHHH" if wide else "HHIIIIIHHHHHH"))
    data = os.pread(fd, header.size, 16)
    require(len(data) == header.size, "short ELF header")
    kind, machine, version, _, phoff, shoff, _, ehsize, phsize, phnum, shsize, shnum, shnames = header.unpack(data)
    ph = struct.Struct(order + ("IIQQQQQQ" if wide else "IIIIIIII"))
    require(kind == 4 and version == 1 and machine != 0 and ehsize == 16 + header.size
            and phsize == ph.size and 0 < phnum < 65535 and phoff >= ehsize
            and phoff + phnum * phsize <= info.st_size, "not a complete ELF ET_CORE header")
    if shoff or shnum or shnames:
        section = struct.Struct(order + ("IIQQQQIIQQ" if wide else "IIIIIIIIII"))
        require(shoff >= ehsize and 0 < shnum < 65535 and shsize == section.size and shnames < shnum
                and shoff + shnum * shsize <= info.st_size, "truncated or unsupported ELF section table")
        sections = os.pread(fd, shnum * shsize, shoff)
        require(len(sections) == shnum * shsize, "short ELF section table")
        for sh in section.iter_unpack(sections):
            require(sh[1] == 8 or not sh[5] or sh[4] + sh[5] <= info.st_size, "truncated ELF section")
    heads = os.pread(fd, phnum * phsize, phoff)
    require(len(heads) == phnum * phsize, "short ELF program table")
    count_load = count_status = partial = 0
    extents = []
    identities, statuses, signals = set(), set(), set()
    native = wide and order == "<" and machine == 62 and ident[7] in (0, 3)
    for seg in ph.iter_unpack(heads):
        offset, length, mem = (seg[2], seg[5], seg[6]) if wide else (seg[1], seg[4], seg[5])
        end = offset + length
        if seg[0] == 1:
            require(length <= mem, "invalid ELF load sizes")
            count_load += 1
            if length:
                extents.append((offset, end))
                partial += int(end > info.st_size)
            continue
        require(not length or end <= info.st_size, "truncated non-memory ELF segment")
        if seg[0] != 4:
            continue
        while offset < end:
            require(offset + 12 <= end, "truncated ELF note header")
            raw = os.pread(fd, 12, offset)
            require(len(raw) == 12, "short ELF note header")
            namesz, descsz, nt = struct.unpack(order + "III", raw)
            name_at = offset + 12
            desc_at = name_at + (namesz + 3) // 4 * 4
            offset = desc_at + (descsz + 3) // 4 * 4
            require(offset <= end, "truncated ELF note descriptor")
            if namesz not in (4, 5, 6) or os.pread(fd, namesz, name_at).rstrip(b"\0") not in (b"CORE", b"LINUX"):
                continue
            if nt == 1 and descsz:
                count_status += 1
            if not native:
                continue
            if nt == 1 and descsz >= 336:
                pid = struct.unpack("<i", os.pread(fd, 4, desc_at + 32))[0]
                sig = struct.unpack("<h", os.pread(fd, 2, desc_at + 12))[0]
                statuses.add((pid, sig))
            elif nt == 3 and descsz >= 136:
                pid = struct.unpack("<i", os.pread(fd, 4, desc_at + 24))[0]
                name = os.pread(fd, 16, desc_at + 40).split(b"\0")[0]
                if pid > 0 and name and all(32 <= b < 127 for b in name):
                    identities.add((pid, name.decode("ascii")))
            elif nt == 0x53494749 and descsz >= 128:
                signals.add(struct.unpack("<i", os.pread(fd, 4, desc_at))[0])
    require(count_load and count_status, "missing native core process note or load segment")
    proof = {"machine": machine, "loadSegments": count_load, "processStatusNotes": count_status,
             "trailingPartialLoadSegments": partial}
    if partial:
        require(native and len(identities) == len(signals) == 1, "ambiguous partial-core identity or signal")
        pid, name = next(iter(identities))
        sig = next(iter(signals))
        fatal = {signal.SIGQUIT, signal.SIGILL, signal.SIGTRAP, signal.SIGABRT, signal.SIGBUS,
                 signal.SIGFPE, signal.SIGSEGV, signal.SIGSYS, signal.SIGXCPU, signal.SIGXFSZ}
        require(sig in fatal and (pid, sig) in statuses and
                (source_name == "core" or source_name == f"core.{pid}"), "partial core lacks matching crash and process identity")
        # A partially written memory tail is recognizable process debris. No
        # missing header, note, section or non-LOAD data is accepted.
        extents.sort()
        require(any(end <= info.st_size for _, end in extents) and
                all(left[1] <= right[0] for left, right in zip(extents, extents[1:])),
                "ambiguous partial ELF memory extents")
        proof.update(processId=pid, processName=name, signal=sig)
    return proof


def full_hash(fd):
    digest = hashlib.sha256()
    offset = 0
    while chunk := os.pread(fd, 2**20, offset):
        digest.update(chunk)
        offset += len(chunk)
    return digest.hexdigest()


def _enter(stack, path, flags, parent=None):
    fd = os.open(path, flags, dir_fd=parent)
    stack.callback(os.close, fd)
    return fd


def _mount_id(fd):
    return next(s.split()[1] for s in Path(f"/proc/self/fdinfo/{fd}").read_text().splitlines() if s.startswith("mnt_id:"))


@contextmanager
def locked_job(volume: Path, job: str):
    require(str(uuid.UUID(job)) == job and volume.is_absolute() and volume.resolve(strict=True)==volume,
            "unexpected results volume or job identity")
    with ExitStack() as stack:
        vol = _enter(stack, volume, DIR)
        jobs = _enter(stack, "jobs", DIR, vol)
        root = _enter(stack, job, DIR, jobs)
        cases = _enter(stack, "cases", DIR, root)
        lock = _enter(stack, ".execute.lock", os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC, root)
        inode = os.fstat(lock)
        require(stat.S_ISREG(inode.st_mode) and inode.st_nlink==1 and
                all(_mount_id(f)==_mount_id(vol) for f in (jobs,root,cases,lock)), "native mount or execution lock differs")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise Held("native execution lock is held") from e
        def pinned():
            return all(same_inode(os.fstat(f), os.stat(name, dir_fd=d, follow_symlinks=False))
                       for d,name,f in [(vol,"jobs",jobs),(jobs,job,root),(root,"cases",cases),(root,".execute.lock",lock)]) and same_inode(os.fstat(vol),volume.stat())
        require(pinned(), "native job changed while taking the execution lock")
        yield root,cases,pinned


def _strings(value):
    pending=[value]
    while pending:
        node=pending.pop()
        if isinstance(node,str):
            yield node
        elif isinstance(node,dict):
            # Source maps may use paths as keys.
            yield from node.keys()
            pending.extend(node.values())
        elif isinstance(node,list):
            pending.extend(node)


def referenced(values, row, base=PurePosixPath("."), case_hint=None):
    job,case,name=subject(row)
    target=row["r"]
    for value in _strings(values):
        if not isinstance(value,str) or len(value)>16384:
            continue
        try:
            ref=unquote(urlsplit(value).path)
        except ValueError:
            continue
        if ref.split("/")[-1] != name:
            continue
        parts=PurePosixPath(ref).parts
        if "jobs" in parts:
            owner=parts.index("jobs")+1
            if owner<len(parts) and parts[owner]!=job:
                continue
        path=posixpath.normpath(ref)
        if path==target or path.endswith("/"+target) or posixpath.normpath(str(base/ref))==target:
            return True
        if path==name and case_hint in (None, case):
            return True
    return False


def _metadata_names(name):
    return name.endswith((".json",".jsonl")) or name in {".retain-solver-core-dumps",".forensic-hold"}


def manifests(rootfd, casesfd, case_names):
    """Inspect native declarations, including cases/<condition>/<angle>/evidence.

    Directory discovery never follows symlinks or crosses a mount. Raw data
    and field files are never opened. Keep only paths that can name a core.
    """
    documents=[]
    def visit(fd, relative, case):
        with os.scandir(fd) as entries:
            for entry in entries:
                name=entry.name
                if name in {".retain-solver-core-dumps",".forensic-hold"} or "incomplete_evidence_quarantine" in name or "orphan_quarantine" in name:
                    raise Held("explicit diagnostic or forensic hold: "+str(relative/name))
                if _metadata_names(name):
                    st=entry.stat(follow_symlinks=False)
                    require(stat.S_ISREG(st.st_mode), "nonregular source metadata: "+str(relative/name))
                    with os.fdopen(os.open(name,FILE,dir_fd=fd),"rb") as f:
                        require(same_inode(st,os.fstat(f.fileno())), "metadata identity changed")
                        try:
                            values=(json.loads(line)for line in f if line.strip()) if name.endswith(".jsonl") else (json.load(f),)
                            paths=set()
                            for obj in values:
                                for value in _strings(obj):
                                    if ("core" in value or "%" in value) and CORE.fullmatch(unquote(value.split("?",1)[0].split("#",1)[0]).split("/")[-1]):
                                        paths.add(value)
                        except (ValueError,RecursionError) as exc:
                            raise Held("invalid source metadata: "+str(relative/name)) from exc
                        require(file_id(st)==file_id(os.fstat(f.fileno())) and same_inode(st,os.stat(name,dir_fd=fd,follow_symlinks=False)),
                                "source declaration changed during read")
                    if paths:documents.append((relative,case,sorted(paths)))
                elif relative==PurePosixPath(".") and name=="cases":
                    continue
                elif entry.is_symlink():
                    require(name not in {"evidence","mesh-evidence","continuation-metadata"},"symlink in declared evidence namespace")
                elif entry.is_dir(follow_symlinks=False):
                    st=entry.stat(follow_symlinks=False);child=os.open(name,DIR,dir_fd=fd)
                    try:
                        require(same_inode(st,os.fstat(child)) and _mount_id(child)==_mount_id(fd),"metadata directory moved or mounted")
                        visit(child,relative/name,case)
                    finally:os.close(child)
    visit(rootfd,PurePosixPath("."),None)
    for case in case_names:
        fd=os.open(case,DIR,dir_fd=casesfd)
        try:
            require(_mount_id(fd)==_mount_id(casesfd),"unexpected native case mount")
            visit(fd,PurePosixPath("cases",case),case)
        finally:os.close(fd)
    return documents


def rename_noreplace(parent, name, dst, newname):
    libc=ctypes.CDLL(None,use_errno=True)
    result=libc.renameat2(parent,os.fsencode(name),dst,os.fsencode(newname),RENAME_NOREPLACE)
    if result!=0:
        e=ctypes.get_errno()
        raise OSError(e,os.strerror(e),name)
    os.fsync(parent)
    os.fsync(dst)


def _exists(fd,name):
    try:return os.stat(name,dir_fd=fd,follow_symlinks=False)
    except FileNotFoundError:return None


def core_action(volume, state, subject_row, job_fds, documents, db_paths, action, *,
                holders, science_check, race_hook=None):
    """Quarantine and revalidate the exact inode before any destructive operation."""
    job,case,name=subject(subject_row)
    root,cases,pinned=job_fds
    if action != "restore":
        for base,hint,data in documents:
            require(not referenced(data,subject_row,base,hint), "native manifest or declared file reference")
        for hint,refs in db_paths:
            require(not referenced(refs,subject_row,case_hint=hint), "database artifact, media or incident reference")
        require(not holders(), "job or core has open process references")
    key=hashlib.sha256(json.dumps([job,subject_row["r"],*[subject_row[k]for k in FIELDS]],separators=(",",":")).encode()).hexdigest()
    receipt=state/"files"/(key+".json")
    record=load_json(receipt) if receipt.exists() else {"state":"new","source":subject_row,"key":key}
    original_state=record["state"]
    require(record["source"]==subject_row, "retirement intent has different ownership")
    with ExitStack() as stack:
        cf=_enter(stack,case,DIR,cases)
        require(_mount_id(cf)==_mount_id(cases), "case mount differs")
        def bound():
            return pinned() and same_inode(os.fstat(cf),os.stat(case,dir_fd=cases,follow_symlinks=False))
        require(bound(),"case directory changed")
        # A named-volume sibling is on the same filesystem and outside all
        # container mounts. Only this host's root operator can name its entries.
        staging=volume.parent/".airfoils-solver-core-retirement"
        if action=="inspect":
            if record["state"] in ("new","restored"):
                f=_enter(stack,name,FILE,cf)
                expect=dict(subject_row,ctimeNs=record.get("restoredCtimeNs",subject_row["ctimeNs"]))
                require(identity_matches(os.fstat(f),expect),"inventoried source changed")
                record["elf"]=elf_core(f,name)
                return {"state":"eligible","key":key,"allocated":0}
            return {"state":"already-released" if record["state"]=="released" else "pending-"+record["state"],
                    "key":key,"allocated":0}
        staging.mkdir(mode=0o700,exist_ok=True)
        q=_enter(stack,staging,DIR);qs=os.fstat(q)
        require(qs.st_uid==os.geteuid() and stat.S_IMODE(qs.st_mode)==0o700 and qs.st_dev==os.fstat(cf).st_dev,
                "private quarantine owner, mode or device differs")
        token=key+".core";detached=_exists(q,token)
        if record["state"]=="released":
            require(detached is None, "released quarantine object unexpectedly exists")
            return {"state":"already-released","key":key,"allocated":0}
        if record["state"]=="release-intent" and detached is None:
            require(_exists(cf,name) is None, "unacknowledged release source changed")
            record["state"]="released";atomic_json(receipt,record)
            return {"state":"recovered-release","key":key,"allocated":0}
        if detached is None:
            require(action != "release", "release requires an independently claimed inode")
            require(action != "restore" or record["state"] in ("restored","restore-intent"), "no staged core to restore")
            require(record["state"] in ("new","restored","intent","restore-intent"),"quarantined inode missing")
            f=_enter(stack,name,FILE,cf);st=os.fstat(f)
            expect=dict(subject_row,ctimeNs=record.get("restoredCtimeNs",subject_row["ctimeNs"]))
            require(identity_matches(st,expect,renamed=record["state"]=="restore-intent") and same_inode(st,_exists(cf,name)), "inventoried source changed")
            record["elf"]=elf_core(f,name)
            if record["state"]=="restore-intent":
                record.update(state="restored",restoredCtimeNs=st.st_ctime_ns);atomic_json(receipt,record)
                return {"state":"restored","key":key,"allocated":0}
            if action=="restore" and record["state"]=="restored":
                return {"state":"restored","key":key,"allocated":0}
            if action=="canary":record["sha256"]=full_hash(f)
            require(identity_matches(os.fstat(f),expect) and bound(), "source changed during verification")
            record["state"]="intent";atomic_json(receipt,record)
            if race_hook:race_hook()
            rename_noreplace(cf,name,q,token)
            actual=_exists(q,token)
            if not bound() or not same_inode(st,actual) or not identity_matches(actual,expect,renamed=True):
                # Move back the entry that actually raced the rename. Never
                # overwrite a replacement and never unlink the unexpected inode.
                try:rename_noreplace(q,token,cf,name)
                except FileExistsError:pass
                raise Held("source raced quarantine; all displaced bytes retained")
            record.update(state="quarantined",quarantinedCtimeNs=actual.st_ctime_ns);atomic_json(receipt,record)
        else:
            flags=(os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC) if action=="release" else FILE
            f=_enter(stack,token,flags,q);st=os.fstat(f)
            require(record["state"] in ("intent","quarantined","restore-intent","release-intent") and identity_matches(st,subject_row,renamed=True),
                    "unexpected quarantine identity")
            if "quarantinedCtimeNs" in record:
                require(st.st_ctime_ns==record["quarantinedCtimeNs"], "quarantined inode changed since its recorded move")
            record["elf"]=elf_core(f,name)
        def restore():
            require(bound() and _exists(cf,name) is None,"original path occupied or renamed; quarantine retained")
            require(same_inode(os.fstat(f),_exists(q,token)), "quarantine identity changed before restore")
            record["state"]="restore-intent";atomic_json(receipt,record)
            rename_noreplace(q,token,cf,name)
            live=_exists(cf,name)
            require(same_inode(os.fstat(f),live) and identity_matches(live,subject_row,renamed=True),"restored inode differs")
            record.update(state="restored",restoredCtimeNs=live.st_ctime_ns);atomic_json(receipt,record)
        try:
            require(bound() and _exists(cf,name) is None,"source was replaced after quarantine")
            require(same_inode(os.fstat(f),_exists(q,token)) and identity_matches(os.fstat(f),subject_row,renamed=True),
                    "quarantine inode changed")
            if action != "restore":
                require(not holders(), "process holds the quarantined core or job")
                science_check()
            if detached is not None and original_state in ("intent","restore-intent") and action!="restore":
                restore()
                return {"state":"restored-retry","key":key,"allocated":0}
            if action == "stage":
                require(record["state"] in ("quarantined","release-intent"), "incomplete claim; restore before retry")
                return {"state":"quarantined","key":key,"allocated":0}
            if action in ("canary","restore"):
                if "sha256" in record:require(full_hash(f)==record["sha256"],"quarantined core content changed")
                restore()
                if "sha256" in record:require(full_hash(f)==record["sha256"],"restored core hash differs")
                science_check()
                return {"state":"restored","key":key,"allocated":0,"sha256":record.get("sha256"),"elf":record["elf"]}
            require(action=="release","unexpected core action")
            # The private directory is serialized by the host controller. This
            # name is never unlinked from a solver-writable directory.
            require(record["state"] in ("quarantined","release-intent"), "unconfirmed quarantine cannot authorize release")
            # The private inode must also admit an exclusive kernel lease.
            previous_handler=signal.signal(signal.SIGIO,signal.SIG_IGN)
            try:
                fcntl.fcntl(f,fcntl.F_SETLEASE,fcntl.F_WRLCK)
            except OSError as exc:
                signal.signal(signal.SIGIO,previous_handler)
                raise Held("core has open handles or cannot acquire an exclusive file lease") from exc
            def drop_lease():
                try:fcntl.fcntl(f,fcntl.F_SETLEASE,fcntl.F_UNLCK)
                except OSError as exc:
                    if exc.errno not in (errno.EAGAIN,errno.ENOENT):raise
                finally:signal.signal(signal.SIGIO,previous_handler)
            stack.callback(drop_lease)
            record["state"]="release-intent";atomic_json(receipt,record)
            require(bound() and _exists(cf,name) is None and same_inode(os.fstat(f),_exists(q,token)) and os.fstat(f).st_nlink==1,
                    "quarantine changed before release")
            os.unlink(token,dir_fd=q);os.fsync(q)
            require(os.fstat(f).st_nlink==0,"unlinked inode retains another link")
            record["state"]="released";atomic_json(receipt,record)
            return {"state":"released","key":key,"allocated":st.st_blocks*512,"apparent":st.st_size,"elf":record["elf"]}
        except Exception:
            if _exists(q,token) is not None and _exists(cf,name) is None and bound():restore()
            raise
