import re
import math


MATERIAL_DOMAIN_WARNING = re.compile(
    r"attempt to use janafThermo<EquationOfState>\s+(?:\[\d+\]\s*)?out of temperature range"
)

_NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?(?:nan|inf(?:inity)?)"
_SPACE = r"(?:\s|\[\d+\])*"
_TEMPERATURE_DETAILS = re.compile(
    rf"{_SPACE}(?P<lower>{_NUMBER}){_SPACE}->{_SPACE}(?P<upper>{_NUMBER})"
    rf"{_SPACE};{_SPACE}T{_SPACE}={_SPACE}(?P<attempted>{_NUMBER})(?=\s|$)",
    re.IGNORECASE,
)


def material_temperature_diagnostics(stdout: str) -> dict:
    count = 0
    parsed = 0
    minimum = None
    maximum = None
    ranges = set()
    truncated = False
    for warning in MATERIAL_DOMAIN_WARNING.finditer(stdout):
        count += 1
        details = _TEMPERATURE_DETAILS.match(stdout, warning.end())
        if details is None:
            continue
        lower, upper, attempted = (float(details[name]) for name in ("lower", "upper", "attempted"))
        if not all(math.isfinite(value) for value in (lower, upper, attempted)) or not 0 < lower < upper:
            continue
        parsed += 1
        minimum = attempted if minimum is None else min(minimum, attempted)
        maximum = attempted if maximum is None else max(maximum, attempted)
        interval = (lower, upper)
        if interval in ranges or len(ranges) < 16:
            ranges.add(interval)
        else:
            truncated = True
    return {"warning_count": count, "parsed_temperature_warning_count": parsed,
            "unparsed_temperature_warning_count": count - parsed,
            "minimum_attempted_temperature_k": minimum, "maximum_attempted_temperature_k": maximum,
            "declared_temperature_ranges_k": [list(interval) for interval in sorted(ranges)],
            "declared_temperature_ranges_truncated": truncated}
