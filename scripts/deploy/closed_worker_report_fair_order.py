"""Schedule bounded turns from one authenticated source without introducing another cursor."""
from array import array
from bisect import bisect_right
from collections import deque
import json
from uuid import UUID


def fair_order(source, remaining, prefix, hint, digest, validate, *, start_ordinary=False):
    owners = hint["owners"]
    block = hint["blockMembers"]
    if not isinstance(owners, list) or not 1 <= len(owners) <= 25 or type(block) is not int or not 1 <= block <= 32:
        raise ValueError("Invalid finite priority owner count or turn size")
    ranges = {}
    queues = {}
    starts_at = {}
    offsets = {}
    for entry in owners:
        job, spans = entry["executionId"], entry["ranges"]
        if str(UUID(job)) != job or job in queues or not isinstance(spans, list) or not spans:
            raise ValueError("Invalid signed priority owner")
        starts, ends = [], []
        for first, last in spans:
            if (type(first) is not int or type(last) is not int or first < 1 or first > last
                    or last > 2**53-1 or (ends and first <= ends[-1])):
                raise ValueError("Invalid inclusive source ranges")
            starts.append(first)
            ends.append(last)
        ranges[job] = (starts, ends)
        queues[job] = array("Q")
        if "firstSequence" in entry:
            pivot = entry["firstSequence"]
            if type(pivot) is not int or not any(a <= pivot <= b for a, b in spans):
                raise ValueError("First priority sequence must belong to a declared source range")
            starts_at[job] = pivot

    # The source bytes stay in the immutable input. Offsets cost sixteen bytes
    # per unvisited key and may only select a complete, previously unvisited line.
    ordinary = array("Q")
    count = 0
    for start, end in remaining:
        pos = start
        source.seek(pos)
        while pos < end:
            line = source.readline(2049)
            stop = pos + len(line)
            if len(line) > 2048 or not line.endswith(b"\n") or stop > end:
                raise ValueError("Priority plan cut an original source key")
            key = json.loads(line)
            validate(key)
            job, n = key["executionId"], key["sequence"]
            selected = ordinary
            if job in ranges:
                starts, ends = ranges[job]
                i = bisect_right(starts, n) - 1
                if i >= 0 and n <= ends[i]:
                    selected = queues[job]
                    if starts_at.get(job) == n:
                        offsets[job] = len(selected)
            count += 1
            if count > 1024**2:
                return None
            selected.extend((pos, stop))
            pos = stop

    # Append an equal-sized ordinary turn after every selected owner while
    # ordinary keys remain. Adjacent physical key lines need only one interval.
    result = [list(span) for span in prefix]
    def take(offsets, at, number):
        stop = min(len(offsets), at + 2*number)
        for i in range(at, stop, 2):
            a, b = offsets[i], offsets[i+1]
            if result and result[-1][1] == a:
                result[-1][1] = b
            elif len(result) < 16384:
                result.append([a, b])
            else:
                raise OverflowError("Priority source needs too many physical intervals")
        return stop

    ordinary_count = len(ordinary)//2
    positions = deque((keys, offsets.get(job, 0), len(keys)//2) for job, keys in queues.items() if keys)
    at = 0
    try:
        if start_ordinary:
            at = take(ordinary, at, block)
        while positions:
            keys, pos, remaining_keys = positions.popleft()
            wanted = min(block, remaining_keys)
            before_wrap = min(wanted, (len(keys)-pos)//2)
            pos = take(keys, pos, before_wrap)
            if pos == len(keys):
                pos = take(keys, 0, wanted-before_wrap)
            if remaining_keys > wanted:
                positions.append((keys, pos, remaining_keys-wanted))
            at = take(ordinary, at, block)
        take(ordinary, at, ordinary_count)
    except OverflowError:
        return None
    return dict(hint=digest, spans=result, sizes={}, owners=list(ranges), blockMembers=block,
                priorityStarts={j:n for j,n in starts_at.items() if j in offsets},
                startsWithOrdinary=start_ordinary,
                priorityKeys=count-ordinary_count, ordinaryKeys=ordinary_count)
