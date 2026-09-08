import re


MATERIAL_DOMAIN_WARNING = re.compile(
    r"attempt to use janafThermo<EquationOfState>\s+(?:\[\d+\]\s*)?out of temperature range"
)
