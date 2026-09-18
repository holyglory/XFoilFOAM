import hashlib
import json
import signal

import pytest

from airfoilfoam import pipeline
from airfoilfoam.material_domain import check_material_domain, material_domain_failure
from airfoilfoam.material_warning import material_temperature_diagnostics
from airfoilfoam.models import CaseSpec, FailureDisposition
from airfoilfoam.openfoam.runner import MaterialDomainError, RunResult
from airfoilfoam.tasks import _terminal_failure_disposition


WARNING = "attempt to use janafThermo<EquationOfState> out of temperature range 150 -> 2000; T = 104.427174342\n"


@pytest.mark.parametrize("returncode,timed_out", [(0, False), (1, False), (124, True), (-signal.SIGFPE, False)])
@pytest.mark.parametrize("separator", [" ", "\n    ", "\n[2]    "])
def test_native_clamp_is_retained_and_rejected_before_process_or_partial_acceptance(tmp_path, returncode, timed_out, separator):
    stdout = "Time = 0.001\n" + WARNING.replace(
        "<EquationOfState> ", f"<EquationOfState>{separator}"
    ) + "End\n"
    result = RunResult("rhoCentralFoam", returncode, stdout, timed_out)
    pipeline.write_divergence_condemnation(tmp_path, "competing numerical diagnosis")
    with pytest.raises(MaterialDomainError):
        pipeline._checked_solver_result(tmp_path, result)
    failure = pipeline._transient_process_failure(tmp_path, result, march_stop="budget guard")
    assert isinstance(failure, MaterialDomainError)
    diagnostic = json.loads((tmp_path / "material-domain-diagnostic.json").read_text())
    assert diagnostic["warning_count"] == 1
    assert diagnostic["parsed_temperature_warning_count"] == 1
    assert diagnostic["unparsed_temperature_warning_count"] == 0
    assert diagnostic["minimum_attempted_temperature_k"] == pytest.approx(104.427174342)
    assert diagnostic["maximum_attempted_temperature_k"] == pytest.approx(104.427174342)
    assert diagnostic["declared_temperature_ranges_k"] == [[150, 2000]]
    assert diagnostic["solver_log_sha256"] == hashlib.sha256(stdout.encode()).hexdigest()
    assert (tmp_path / diagnostic["solver_log"]).read_text() == stdout
    assert len(list(tmp_path.glob("log.material-domain-*"))) == 1
    assert diagnostic["returncode"] == returncode
    assert diagnostic["timed_out"] is timed_out
    assert _terminal_failure_disposition(failure) == FailureDisposition.material_domain
    outcome = pipeline.CaseOutcome(spec=CaseSpec(chord=1, speed=30, aoa_deg=2), reynolds=2_000_000)
    pipeline._record_outcome_failure(outcome, failure)
    pipeline._record_unexceptional_rans_rejection(outcome)
    assert outcome.failure_disposition == FailureDisposition.material_domain
    assert not pipeline.should_abort_rans_sweep_for_urans(2, outcome)


@pytest.mark.parametrize("stdout", [
    "Time = 1\nEnd\n",
    "Configured material temperature range 150 -> 2000\n",
    "temperature max 149 K\n",
    "FOAM Warning: unrelated turbulence warning\n",
])
def test_nonclamp_output_is_not_misclassified_or_written(tmp_path, stdout):
    result = RunResult("rhoSimpleFoam", 0, stdout)
    assert material_domain_failure(tmp_path, result) is None
    assert pipeline._checked_solver_result(tmp_path, result) is result
    assert pipeline._transient_process_failure(tmp_path, result, march_stop=None) is None
    assert list(tmp_path.iterdir()) == []


def test_distinct_failed_pass_logs_are_not_overwritten(tmp_path):
    for temperature in [104.427174342, 110.0]:
        with pytest.raises(MaterialDomainError):
            check_material_domain(tmp_path, RunResult("rhoCentralFoam", 0, WARNING + str(temperature)))
    assert len(list(tmp_path.glob("log.material-domain-*"))) == 2


def test_temperature_summary_accepts_native_numeric_and_mpi_wrapping_without_claiming_field_extrema():
    marker = "attempt to use janafThermo<EquationOfState> out of temperature range"
    stdout = (f"{marker} 100 -> 2000; T = -2.5e+01\n"
              f"{marker}\n[2] 1e2 ->\n[2] 2e3;\n[2] T = +2.5E3\n"
              f"{marker} 150 -> 2000; T = .99e2\n")
    details = material_temperature_diagnostics(stdout)
    assert details == {"warning_count": 3, "parsed_temperature_warning_count": 3,
                       "unparsed_temperature_warning_count": 0, "minimum_attempted_temperature_k": -25,
                       "maximum_attempted_temperature_k": 2500, "declared_temperature_ranges_k": [[100, 2000], [150, 2000]],
                       "declared_temperature_ranges_truncated": False}


@pytest.mark.parametrize("tail", ["", " 100 -> 2000; T =", " 100 -> 2000; T = NaN",
    " 100 -> 2000; T = -inf", " NaN -> 2000; T = 50", " 2000 -> 100; T = 50",
    " 0 -> 2000; T = 50", " 100 -> 2000; T = 1.2e", " 100 -> 2000; T = 1.#IND"])
def test_unparsed_warning_details_never_clear_rejection_or_invent_temperature(tmp_path, tail):
    stdout = "attempt to use janafThermo<EquationOfState> out of temperature range" + tail + "\n"
    result = RunResult("rhoCentralFoam", 0, stdout)
    assert isinstance(material_domain_failure(tmp_path, result), MaterialDomainError)
    diagnostic = json.loads((tmp_path / "material-domain-diagnostic.json").read_text())
    assert diagnostic["warning_count"] == diagnostic["unparsed_temperature_warning_count"] == 1
    assert diagnostic["parsed_temperature_warning_count"] == 0
    assert diagnostic["minimum_attempted_temperature_k"] is None
    assert diagnostic["maximum_attempted_temperature_k"] is None
    assert diagnostic["declared_temperature_ranges_k"] == []
    assert diagnostic["physical_cfd_validated"] is False
    assert (tmp_path / diagnostic["solver_log"]).read_bytes() == stdout.encode()


def test_summary_keeps_all_counts_and_extrema_when_range_metadata_is_bounded():
    marker = "attempt to use janafThermo<EquationOfState> out of temperature range"
    stdout = "\n".join(f"{marker} {100 + index} -> 2000; T = {-index}" for index in range(20))
    details = material_temperature_diagnostics(stdout)
    assert details["warning_count"] == details["parsed_temperature_warning_count"] == 20
    assert details["minimum_attempted_temperature_k"] == -19
    assert details["maximum_attempted_temperature_k"] == 0
    assert len(details["declared_temperature_ranges_k"]) == 16
    assert details["declared_temperature_ranges_truncated"] is True
    assert material_temperature_diagnostics("Temperature min 50 max 2100\nConfigured material range 100 -> 2000\n")["warning_count"] == 0
