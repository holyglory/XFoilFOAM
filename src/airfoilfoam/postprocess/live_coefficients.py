"""Reuse parsed force rows between polls of one actively growing OpenFOAM segment."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
from typing import Sequence

import numpy as np

from .forces import _data_lines


@dataclass
class _Prefix:
    path: Path
    inode: tuple[int, int]
    size: int
    sha256: bytes
    columns: tuple[int, ...]
    series: tuple[np.ndarray, ...]


class LiveCoefficientReader:
    """One monitor owns one cache. Other layouts go through the general history reader."""

    def __init__(self) -> None:
        self._prefix: _Prefix | None = None

    def read(self, paths: Path | Sequence[Path]) -> tuple[np.ndarray, ...] | None:
        previous, self._prefix = self._prefix, None
        if not isinstance(paths, (list, tuple)) or len(paths) != 1:
            return None
        path = Path(paths[0])
        with path.open("rb") as stream:
            st = os.fstat(stream.fileno())
            # Bound the extra snapshot kept during parsing. Larger segments use normal reads.
            if st.st_size > 128 * 1024**2:
                return None
            raw = stream.read(st.st_size)
        if not raw.endswith(b"\n"):
            return None
        inode = (st.st_dev, st.st_ino)
        digest = hashlib.sha256()
        if previous and previous.path == path and previous.inode == inode and previous.size <= len(raw):
            digest.update(memoryview(raw)[:previous.size])
            if digest.digest() != previous.sha256:
                previous = None
                digest = hashlib.sha256()
        else:
            previous = None
        if previous and previous.size == len(raw):
            self._prefix = previous
            return previous.series

        tail = raw[previous.size:] if previous else raw
        digest.update(tail)
        header, rows = _data_lines(tail.decode().splitlines())
        if not rows or (previous and header):
            return None
        if previous:
            columns = previous.columns
        else:
            # The last labelled header owns the file, just as in the ordinary reader.
            indices = {name: i for i, name in enumerate(header)}
            pitch = "CmPitch" if "CmPitch" in indices else "Cm"
            if not all(name in indices for name in ("Time", "Cl", "Cd", pitch)):
                return None
            columns = tuple(indices[name] for name in ("Time", "Cl", "Cd", pitch))
        try:
            table = np.asarray(rows, dtype=float)
        except ValueError:  # Ragged/torn rows have their existing general-reader semantics.
            return None
        if table.ndim != 2 or table.shape[1] <= max(columns):
            return None
        new = tuple(table[:, i].copy() for i in columns)
        # The general reader sorts, removes non-finite rows and coalesces near-equal times.
        # Only append directly if every one of those operations would be an identity.
        if not all(np.isfinite(a).all() for a in new) or not np.all(np.diff(new[0]) > 1e-12):
            return None
        if previous:
            if new[0][0] - previous.series[0][-1] <= 1e-12:
                return None
            new = tuple(np.concatenate((old, added)) for old, added in zip(previous.series, new))
        for a in new:
            a.setflags(write=False)
        self._prefix = _Prefix(path, inode, len(raw), digest.digest(), columns, new)
        return new
