import hashlib
import math
import re
import zipfile


ATTRIBUTION = "Produced under the UIUC Low-Speed Airfoil Test program, Summary of Low-Speed Airfoil Data, Volume 1."
MEASUREMENT_SOURCE = "https://m-selig.ae.illinois.edu/pubs/Low-Speed-Airfoil-Data-V1.pdf"
ARCHIVE_SHA256 = "124b990a3d22163cadf6efb8e805860e89275f2f987d96e4fbe7a07bda8e03ab"


def split_source_files(raw):
    separators = list(re.finditer(rb"(?m)^:{14}\r?\n([^\r\n]+)\r?\n:{14}\r?\n", raw))
    if not separators:
        raise ValueError("Source archive member contains no named files")
    result = {}
    for index, separator in enumerate(separators):
        name = separator[1].decode("ascii").strip()
        if name in result or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            raise ValueError("Ambiguous source file name")
        end = separators[index + 1].start() if index + 1 < len(separators) else len(raw)
        result[name] = raw[separator.end():end].strip()
    return result


def load_uiuc_volume1_archive(path):
    with open(path, "rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != ARCHIVE_SHA256:
            raise ValueError("UIUC source archive checksum differs")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        required = {"volume01/COORD01.TXT", "volume01/DRAG01.TXT", "volume01/LIFT01.TXT", "volume01/GPL.TXT", "volume01/MANIFEST.TXT", "volume01/README01.TXT"}
        if len(names) != len(set(names)) or not required <= set(names):
            raise ValueError("UIUC source or required attribution files are missing")
        if any(entry.file_size > 2 * 1024 * 1024 for entry in archive.infolist()):
            raise ValueError("UIUC archive member exceeds source bound")
        return {"coordinates": split_source_files(archive.read("volume01/COORD01.TXT")),
                "drag": split_source_files(archive.read("volume01/DRAG01.TXT")),
                "lift": split_source_files(archive.read("volume01/LIFT01.TXT")),
                "archive_sha256": ARCHIVE_SHA256, "attribution": ATTRIBUTION}


def _branches(rows):
    branches = []
    current = [rows[0]]
    direction = None
    for previous, row in zip(rows, rows[1:]):
        difference = row["alpha"] - previous["alpha"]
        if difference == 0:
            raise ValueError("Repeated angle requires explicit source-run disambiguation")
        changed = "increasing" if difference > 0 else "decreasing"
        if direction is not None and changed != direction:
            branches.append({"direction": direction, "rows": current})
            current = []
        direction = changed
        current.append(row)
    branches.append({"direction": direction or "single", "rows": current})
    return branches


def parse_uiuc_volume1(raw, kind):
    if kind not in {"lift", "drag"}:
        raise ValueError("Specify lift or drag source format")
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("UIUC source exceeds bounded size")
    lines = [line.strip() for line in raw.decode("ascii").splitlines() if line.strip()]
    if len(lines) < 5 or not lines[0].startswith("Airfoil: ") or not lines[1].startswith("Builder:") or not lines[2].startswith("Comment:"):
        raise ValueError("Unknown UIUC Volume1 source header")
    if lines[3] != "Number of Reynolds #'s:":
        raise ValueError("Missing declared source-run count")
    count = int(lines[4])
    if not 1 <= count <= 1000:
        raise ValueError("Invalid source-run count")
    cursor = 5
    runs = []
    for ordinal in range(count):
        if cursor + 5 > len(lines) or lines[cursor] != "Average Reynolds #:" or lines[cursor + 2] != "Number of angles of attack:":
            raise ValueError("Incomplete UIUC source-run header")
        reynolds, samples = int(lines[cursor + 1]), int(lines[cursor + 3])
        if reynolds <= 0 or not 1 <= samples <= 10000:
            raise ValueError("Invalid Reynolds number or angle count")
        header = re.sub(r"\s+", "", lines[cursor + 4])
        expected = "alpha/Cl/Cm" if kind == "lift" else "alpha/Cl/Cd/SpanwiseCd's>>>"
        if header != expected:
            raise ValueError("Source columns do not match lift/drag format")
        cursor += 5
        rows = []
        for sample in range(samples):
            if cursor >= len(lines):
                raise ValueError("Truncated measured source rows")
            values = [float(value) for value in lines[cursor].split()]
            if (kind == "lift" and len(values) != 3) or (kind == "drag" and len(values) < 4) or not all(math.isfinite(value) for value in values):
                raise ValueError("Malformed measured source row")
            if kind == "drag" and any(value <= 0 for value in values[2:]):
                raise ValueError("Measured drag must be positive")
            rows.append({"source_row": sample, "alpha": values[0], "coefficients": [values[1], values[2] if kind == "drag" else None, None],
                         "computed_moment_for_correction": values[2] if kind == "lift" else None,
                         "spanwise_drag": values[3:] if kind == "drag" else None})
            cursor += 1
        if cursor >= len(lines):
            raise ValueError("Missing source reduction provenance")
        footer = re.fullmatch(r"Tabulated from data in file (\S+) & reduced using program (\S+)", lines[cursor])
        if footer is None:
            raise ValueError("Invalid source reduction provenance")
        cursor += 1
        runs.append({"ordinal": ordinal, "reynolds": reynolds, "source_run": footer[1], "reduction_program": footer[2],
                     "branches": _branches(rows), "samples": samples})
    file_generation = None
    if cursor == len(lines) - 1:
        footer = re.fullmatch(r"File (\S+) created on (\d{2}-\d{2}-\d{4}) at (\d{2}:\d{2}:\d{2}) using program FORMAT", lines[cursor])
        extension = ".lft" if kind == "lift" else ".drg"
        if footer and footer[1].lower().endswith(extension):
            file_generation = {"file": footer[1], "date": footer[2], "time": footer[3], "program": "FORMAT"}
            cursor += 1
    if cursor != len(lines):
        raise ValueError("Unexpected trailing source records")
    return {"kind": "uiuc-volume1-experimental-reference", "airfoil": lines[0].split(":", 1)[1].strip(),
            "builder": lines[1].split(":", 1)[1].strip(), "condition": lines[2].split(":", 1)[1].strip(),
            "source_sha256": hashlib.sha256(raw).hexdigest(), "attribution": ATTRIBUTION, "measurement_source": MEASUREMENT_SOURCE,
            "experimental_moment_available": False, "measurement_uncertainty": None, "file_generation": file_generation, "runs": runs}
