"""Evaluate a paired legacy-custody admission against observed ordinary 256 MiB windows.

Input samples use Linux cgroup-v2 CPU/memory counters in bytes and microseconds.
The controller can call baseline()/assess() with its existing read-only host
observer. No permission, database or scheduling state is changed here.
"""

from datetime import datetime
from statistics import median

MIB = 1024**2


def timestamp(row):
    return datetime.fromisoformat(row["at"].replace("Z", "+00:00")).timestamp()


def cores(a, b, service):
    seconds = timestamp(b) - timestamp(a)
    delta = (
        b["services"][service]["cpuStat"]["usage_usec"]
        - a["services"][service]["cpuStat"]["usage_usec"]
    )
    if seconds <= 0 or delta < 0:
        raise ValueError("Discontinuous cgroup CPU window")
    return delta / (seconds * 1_000_000)


def quantile(values, fraction):
    return sorted(values)[int((len(values) - 1) * fraction)]


def pg_memory(row):
    pg = row["services"]["postgres"]
    current, file, shmem, inactive = (
        pg[k] / MIB for k in ("bytes", "file", "shmem", "inactiveFile")
    )
    if min(current, file, shmem, inactive) < 0:
        raise ValueError("Invalid PostgreSQL memory counter")
    reclaimable = min(inactive, max(0, file - shmem), current)
    return {
        "currentMiB": current,
        "anonMiB": pg["anon"] / MIB,
        "fileMiB": file,
        "inactiveFileMiB": inactive,
        "shmemMiB": shmem,
        "reclaimableFileMiB": reclaimable,
        "workingSetMiB": current - reclaimable,
    }


def baseline(samples):
    if len(samples) < 5:
        raise ValueError("Require a sampled single-worker baseline")
    # Measure CPU over several ticks to avoid making a scheduling slice a policy.
    windows = list(zip(samples, samples[3:]))
    pg = [cores(a, b, "postgres") for a, b in windows]
    engine = [cores(a, b, "worker") for a, b in windows]
    mem = [pg_memory(s)["workingSetMiB"] for s in samples]
    free = [s["hostMemory"]["MemAvailable"] / MIB for s in samples]
    return {
        "samples": len(samples),
        "pgMedianCores": median(pg),
        "pgP95Cores": quantile(pg, 0.95),
        "engineMedianCores": median(engine),
        "engineP10Cores": quantile(engine, 0.1),
        "pgMaxWorkingSetMiB": max(mem),
        "pgWorkingSetSwingMiB": max(mem) - min(mem),
        "hostNormalSwingMiB": max(free) - min(free),
        "pgFullPressure": max(
            s["services"]["postgres"]["memoryPressure"]["full"]["avg10"]
            for s in samples
        ),
        "hostFullPressure": max(
            s["hostMemoryPressure"]["full"]["avg10"] for s in samples
        ),
        "hostIoPressure": max(s["hostIO"]["full"]["avg10"] for s in samples),
    }


def assess(a, b, normal, *, pair_reserve_mib, min_available_mib, signed_progress):
    try:
        pg = pg_memory(b)
        avail = b["hostMemory"]["MemAvailable"] / MIB
        pg_reserve = max(512, normal["pgWorkingSetSwingMiB"])
        extra_growth = max(0, pg["workingSetMiB"] - normal["pgMaxWorkingSetMiB"])
        floor = max(
            min_available_mib,
            pair_reserve_mib + pg_reserve + normal["hostNormalSwingMiB"] + extra_growth,
        )
        pg_cores = cores(a, b, "postgres")
        engine_cores = cores(a, b, "worker")
        reasons = []
        if not signed_progress:
            reasons.append("signed_progress")
        if avail < floor:
            reasons.append("host_memory_margin")
        for service in ("worker", "postgres", "sweeper", "node-api"):
            prev = a["services"][service]
            current = b["services"][service]
            if any(
                current["events"][key] > prev["events"][key]
                for key in ("oom", "oom_kill", "high", "max")
            ):
                reasons.append(service + "_memory_events")
            if current["cpuStat"].get("throttled_usec", 0) > prev["cpuStat"].get(
                "throttled_usec", 0
            ):
                reasons.append(service + "_cpu_throttled")
            reserve = {"postgres": pg_reserve, "sweeper": pair_reserve_mib}.get(
                service, 0
            )
            for key in ("maxBytes", "highBytes"):
                cap = current[key]
                if cap != "max" and (int(cap) - current["bytes"]) / MIB < reserve:
                    reasons.append(service + "_" + key)
        if b["services"]["postgres"]["memoryPressure"]["full"]["avg10"] > max(
            1, normal["pgFullPressure"] + 0.5
        ):
            reasons.append("pg_memory_pressure")
        if b["hostMemoryPressure"]["full"]["avg10"] > max(
            1, normal["hostFullPressure"] + 0.5
        ):
            reasons.append("host_memory_pressure")
        if b["hostIO"]["full"]["avg10"] > max(2, normal["hostIoPressure"] + 1):
            reasons.append("host_io_pressure")
        if pg_cores > normal["pgP95Cores"] + max(
            2, normal["pgP95Cores"] - normal["pgMedianCores"]
        ):
            reasons.append("pg_cpu")
        if engine_cores < 0.85 * normal["engineP10Cores"]:
            reasons.append("solver_cpu_below_normal")
        return {
            "admit": not reasons,
            "reasons": reasons,
            "hostAvailableMiB": avail,
            "hostFreeMiB": b["hostMemory"]["MemFree"] / MIB,
            "requiredHostMiB": floor,
            "pg": pg,
            "pgReserveMiB": pg_reserve,
            "pgCores": pg_cores,
            "engineCores": engine_cores,
        }
    except (ValueError, KeyError, TypeError, ZeroDivisionError):
        return {"admit": False, "reasons": ["capacity_unavailable"]}
