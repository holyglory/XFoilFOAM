import sys

import pytest

from airfoilfoam.material_domain import material_domain_failure
from airfoilfoam.openfoam.runner import MaterialDomainError, _run_subprocess


@pytest.mark.parametrize("monitor", [None, lambda: None])
@pytest.mark.parametrize("separator", [" ", "\n    "])
def test_compressible_warning_stops_real_process_before_later_work(tmp_path, monitor, separator):
    warning = f"attempt to use janafThermo<EquationOfState>{separator}out of temperature range 100 -> 2000; T = 55"
    program = f"import time,pathlib; print({warning!r}, flush=True); time.sleep(3); pathlib.Path('continued').write_text('invalid work')"
    result = _run_subprocess(
        [sys.executable, "-c", program], cwd=tmp_path, timeout=8,
        command="isolated material-warning process fixture", monitor=monitor,
        abort_on_material_domain=True,
    )
    assert result.returncode != 0
    assert not result.timed_out
    assert warning in result.stdout
    assert not (tmp_path / "continued").exists()
    assert isinstance(material_domain_failure(tmp_path, result), MaterialDomainError)


@pytest.mark.parametrize("scoped,output", [
    (False, "attempt to use janafThermo<EquationOfState> out of temperature range"),
    (True, "Configured janafThermo<EquationOfState> temperature range 100 -> 2000"),
])
def test_unscoped_or_descriptive_output_does_not_abort(tmp_path, scoped, output):
    program = f"import pathlib; print({output!r}, flush=True); pathlib.Path('continued').write_text('expected work')"
    result = _run_subprocess(
        [sys.executable, "-c", program], cwd=tmp_path, timeout=8,
        command="isolated harmless-output fixture", abort_on_material_domain=scoped,
    )
    assert result.returncode == 0
    assert not result.timed_out
    assert (tmp_path / "continued").read_text() == "expected work"


def test_temperature_abort_remains_distinct_from_wall_timeout(tmp_path):
    result = _run_subprocess(
        [sys.executable, "-c", "import time; print('ordinary run', flush=True); time.sleep(3)"],
        cwd=tmp_path, timeout=0.1, command="isolated timed process fixture",
        abort_on_material_domain=True,
    )
    assert result.timed_out and result.returncode == 124
    assert material_domain_failure(tmp_path, result) is None
