"""Read-only Linux observations of open job files, working directories and mappings."""
from __future__ import annotations

import os
from pathlib import Path
import re

_ESC = re.compile(r"\\([0-7]{3})")


def _unescape(path):
    return _ESC.sub(lambda m: chr(int(m[1], 8)), path)


def _mounts(path, dev):
    result = []
    for line in path.read_text().splitlines():
        fields = line.split()
        if fields[2] == dev:
            result.append((_unescape(fields[3]), _unescape(fields[4])))
    return result


def open_jobs(volume, jobs, inodes, proc=Path("/proc")):
    """One bounded batch shares a before/after scan. Unavailable observations fail closed."""
    device = volume.stat().st_dev
    dev = f"{os.major(device)}:{os.minor(device)}"
    absolute = str(volume / "jobs")
    mounts = [(root,where) for root,where in _mounts(proc/"self/mountinfo",dev)
              if absolute==where or absolute.startswith(where.rstrip("/")+"/")]
    if not mounts:
        raise RuntimeError("cannot locate the results filesystem in the host mount namespace")
    root, where = max(mounts, key=lambda m: len(m[1]))
    base = os.path.join(root, os.path.relpath(absolute,where)).rstrip("/")
    namespaces = {}
    held = {}
    def mark(job, cause):
        if job in jobs:
            held.setdefault(job,cause)
    for entry in proc.iterdir():
        if not entry.name.isdecimal() or int(entry.name)==os.getpid():
            continue  # The single-threaded operator's own pinned files and locks.
        try:
            namespace=os.readlink(entry/"ns/mnt")
            if namespace not in namespaces:
                aliases=[]
                for fsroot,mountpoint in _mounts(entry/"mountinfo",dev):
                    if base==fsroot or base.startswith(fsroot.rstrip("/")+"/"):
                        path=os.path.normpath(os.path.join(mountpoint,os.path.relpath(base,fsroot)))
                        aliases.append((path.rstrip("/")+"/",None))
                    elif fsroot.startswith(base+"/"):
                        fixed=fsroot[len(base)+1:].split("/",1)[0]
                        if fixed in jobs:aliases.append((mountpoint.rstrip("/")+"/",fixed))
                namespaces[namespace]=aliases
            aliases=namespaces[namespace]
            def match(path, cause):
                path=path.removesuffix(" (deleted)")
                for prefix,fixed in aliases:
                    if path.startswith(prefix):
                        mark(fixed or path[len(prefix):].split("/",1)[0],cause)
                    elif fixed and path.rstrip("/")==prefix.rstrip("/"):
                        mark(fixed,cause)
            for name in ("cwd","root","exe"):
                try:match(os.readlink(entry/name),"open process "+name)
                except FileNotFoundError:pass
            for fd in (entry/"fd").iterdir():
                try:
                    text=os.readlink(fd);match(text,"open job file descriptor")
                    # Also catches bind aliases, passed descriptors and the detached inode.
                    if text.startswith("/"):
                        st=fd.stat();target=inodes.get((st.st_dev,st.st_ino))
                        if target:mark(target,"open crash-dump descriptor")
                except (FileNotFoundError,ProcessLookupError):continue
            with (entry/"maps").open(errors="surrogateescape")as maps_file:
                for line in maps_file:
                    fields=line.rstrip("\n").split(None,5)
                    if len(fields)<6:continue
                    major,minor=(int(s,16)for s in fields[3].split(":"))
                    if (major,minor)!=(os.major(device),os.minor(device)):continue
                    target=inodes.get((device,int(fields[4])))
                    if target:mark(target,"mapped crash dump")
                    match(_unescape(fields[5]),"mapped job file")
        except (FileNotFoundError,ProcessLookupError):
            continue
        except PermissionError:
            # A living unobservable process must not silently certify release.
            if entry.exists():raise
    return held
