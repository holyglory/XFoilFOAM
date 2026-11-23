"""Finite priority turns over one authenticated inventory and one durable byte cursor."""
import hashlib
import json
import os
from bisect import bisect_right
from itertools import accumulate


MAX_PAGE_BYTES = 32 * 1024**2
MAX_TURN_KEYS = 128


def check(value, reason):
    if not value:
        raise ValueError(reason)


def order_hash(order):
    return hashlib.sha256(json.dumps(order, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def trim(spans, lo, hi):
    """Return physical slices for [lo, hi) in the current logical order."""
    result = []
    pos = 0
    for a, b in spans:
        end = pos + b - a
        l, r = max(lo, pos), min(hi, end)
        if l < r:
            result.append([a + l - pos, a + r - pos])
        pos = end
    return result


def coalesce(spans):
    result = []
    for a, b in spans:
        if result and result[-1][1] == a:
            result[-1][1] = b
        else:
            result.append([a, b])
    return result


class OrderedInventory:
    def __init__(self, source, spans, sizes):
        self.source = source
        self.spans = spans
        self.ends = list(accumulate(b-a for a, b in spans))
        self.sizes = {int(k): n for k, n in sizes.items()}
        self.pos = 0

    def tell(self):
        return self.pos

    def seek(self, pos):
        check(0 <= pos <= self.ends[-1], "Invalid signed inventory cursor")
        self.pos = pos

    def fileno(self):
        return self.source.fileno()

    def readline(self, limit):
        i = bisect_right(self.ends, self.pos)
        if i == len(self.ends):
            return b""
        a, b = self.spans[i]
        physical = b - (self.ends[i] - self.pos)
        self.source.seek(physical)
        data = self.source.readline(min(limit, b-physical))
        self.pos += len(data)
        return data

    def page_limit(self, limit):
        # Hints only reduce work. The peer still authenticates and enforces its
        # exact reconstructed-byte cap on every actual member.
        pos = self.tell()
        used = 0
        try:
            for count in range(limit):
                size = self.sizes.get(self.tell())
                if size is None:
                    return count if count else limit
                if used + size > MAX_PAGE_BYTES:
                    return max(1, count)
                used += size
                self.readline(2049)
            return limit
        finally:
            self.seek(pos)


def ordered_inventory(args, source, progress, bind, path, durable, validate):
    size = os.fstat(source.fileno()).st_size
    order = progress.get("sourceOrder")
    expected = dict(bind, sourceOrderSha256=order_hash(order)) if order else bind
    check(progress["binding"] == expected, "Controller scope or source order changed")
    spans = order["spans"] if order else [[0, size]]
    hint_file = getattr(args, "priority_turn", None)
    requested = getattr(args, "priority_turn_sha256", None)
    pending = progress.get("pending") or progress.get("group")
    if hint_file and args.apply and not pending and (not order or order["hint"] != requested):
        with hint_file.open("rb") as hint_source:
            data = hint_source.read(128*1024 + 1)
        digest = hashlib.sha256(data).hexdigest()
        check(len(data) <= 128*1024 and digest == requested, "Priority hint digest differs")
        hint = json.loads(data)
        # Subordinate discovery and held-key recovery own different signed rosters.
        if hint["inventory"] == bind["inventory"]:
            start, keys = hint["offset"], hint["keys"]
            check(hint["version"] == 1 and type(start) is int and 0 <= start < size
                  and 0 < len(keys) <= MAX_TURN_KEYS, "Invalid finite priority turn")
            if start:
                source.seek(start-1)
                check(source.read(1) == b"\n", "Priority range must start at a complete signed key")
            source.seek(start)
            offsets = []
            last = None
            for entry in keys:
                line = source.readline(2049)
                check(len(line) <= 2048 and line.endswith(b"\n"), "Incomplete priority source")
                key = json.loads(line)
                check(key == entry["key"], "Priority source is different from the signed inventory")
                validate(key)
                check(last is None or (last["executionId"] == key["executionId"] and last["sequence"] < key["sequence"]),
                      "Priority turn needs ordered keys of one execution")
                n = entry.get("byteSize")
                check(n is None or type(n) is int and 0 < n <= MAX_PAGE_BYTES, "Invalid source byte hint")
                offsets.append((source.tell()-len(line)-start, n))
                last = key
            stop = source.tell()
            pos = progress["after"]
            origin = 0
            for a, b in spans:
                if a <= start and stop <= b:
                    origin += start-a
                    break
                origin += b-a
            else:
                origin = -1
            # Only an untouched future block may move. The original prefix,
            # including any saved far-side receipt awaiting acknowledgement,
            # always completes in its previously admitted order.
            next_receipt = path.parent / "receipts" / f"{progress['completed']:08d}"
            occupied = any(next_receipt.with_suffix(ext).exists() for ext in (".json", ".page.json"))
            if origin >= pos and not occupied and origin + stop-start <= size:
                through = origin + stop-start
                moved = coalesce(trim(spans, 0, pos) + [[start, stop]]
                                 + trim(spans, pos, origin) + trim(spans, through, size))
                # Limit persistent scheduling metadata independently of the source size.
                if len(moved) <= 192:
                    order = dict(hint=digest, spans=moved,
                                 sizes={str(pos+rel): n for rel, n in offsets if n is not None})
                    progress["sourceOrder"] = order
                    progress["binding"] = dict(bind, sourceOrderSha256=order_hash(order))
                    durable(path, progress)
                    spans = moved
    if not order:
        return source
    # Physical intervals must partition the original file once, even after a restart.
    at = 0
    for first, end in sorted(spans):
        check(first == at and first < end <= size, "Invalid source inventory partition")
        at = end
    check(at == size, "Incomplete source inventory partition")
    return OrderedInventory(source, spans, order["sizes"])
