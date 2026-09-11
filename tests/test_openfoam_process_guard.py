import pytest

from scripts.deploy.openfoam_process_guard import OPENFOAM_EXECUTABLES, openfoam_program, running_openfoam_processes


@pytest.mark.parametrize("program", sorted(OPENFOAM_EXECUTABLES))
def test_guard_finds_every_supported_native_program(program):
    assert openfoam_program([program, "-case", "/data/case"]) == program
    assert openfoam_program([f"/usr/lib/openfoam/bin/{program}"]) == program


@pytest.mark.parametrize("arguments", [
    ["sh", "-c", 'for path in /data/cases/*/postProcessing; do printf "%s" "$path"; done'],
    ["sh", "-lc", "command -v simpleFoam rhoPimpleFoam foamToVTK"],
    ["pgrep", "-af", "simpleFoam|postProcess"],
    ["python3", "-c", "print('rhoSimpleFoam')"],
    ["cat", "/data/simpleFoam.log"],
    ["mpirun", "--version"],
    ["mpirun", "-np", "2", "echo", "rhoSimpleFoam"],
    [],
])
def test_guard_ignores_names_in_probe_text_or_data_paths(arguments):
    assert openfoam_program(arguments) is None


def test_guard_keeps_real_launcher_and_script_work_blocked():
    assert openfoam_program(["mpirun", "--allow-run-as-root", "--bind-to", "none", "--use-hwthread-cpus", "-np", "4", "rhoPimpleFoam", "-parallel"]) == "rhoPimpleFoam"
    assert openfoam_program(["/usr/bin/mpiexec", "--bind-to=none", "-n", "2", "/opt/bin/rhoCentralFoam"]) == "rhoCentralFoam"
    assert openfoam_program(["bash", "-e", "/opt/openfoam/bin/foamJob", "simpleFoam"]) == "foamJob"


def test_process_scan_uses_nul_separated_arguments_and_handles_finished_processes(tmp_path):
    for process, arguments in [(101, ["rhoSimpleFoam", "-parallel"]), (102, ["sh", "-c", "echo postProcessing"]), (103, [])]:
        path = tmp_path / str(process)
        path.mkdir()
        (path / "cmdline").write_bytes(b"\0".join(value.encode() for value in arguments))
    (tmp_path / "104").mkdir()
    assert running_openfoam_processes(tmp_path) == [(101, "rhoSimpleFoam")]
