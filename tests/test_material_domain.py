import hashlib
import json
import signal

import pytest

from airfoilfoam import pipeline
from airfoilfoam.material_domain import check_material_domain, material_domain_failure
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
