import os
from pathlib import Path


OPENFOAM_EXECUTABLES = {
    "simpleFoam", "pimpleFoam", "rhoSimpleFoam", "rhoPimpleFoam", "rhoCentralFoam",
    "potentialFoam", "snappyHexMesh", "surfaceFeatureExtract", "blockMesh", "checkMesh",
    "decomposePar", "reconstructPar", "renumberMesh", "mapFields", "mapFieldsPar",
    "postProcess", "foamToVTK", "foamRun", "foamJob", "cartesian2DMesh",
}
MPI_OPTIONS = {
    "--allow-run-as-root": 0, "--use-hwthread-cpus": 0, "--report-bindings": 0,
    "--oversubscribe": 0, "--bind-to": 1, "--map-by": 1, "--rank-by": 1,
    "-np": 1, "-n": 1, "--np": 1, "--host": 1, "--hostfile": 1,
    "-host": 1, "-hostfile": 1, "--mca": 2, "-mca": 2, "-x": 1,
}


def openfoam_program(arguments):
    if not arguments:
        return None
    program = os.path.basename(arguments[0])
    if program in OPENFOAM_EXECUTABLES:
        return program
    if program in {"sh", "bash", "dash"}:
        remaining = arguments[1:]
        while remaining and remaining[0] in {"-e", "-u", "-eu", "--"}:
            remaining = remaining[1:]
        return "foamJob" if remaining and os.path.basename(remaining[0]) == "foamJob" else None
    if program not in {"mpirun", "mpiexec", "orterun", "prterun"}:
        return None
    index = 1
    while index < len(arguments):
        argument = arguments[index]
        if argument in {"--help", "--version", "-V"}:
            return None
        if not argument.startswith("-"):
            return openfoam_program(arguments[index:])
        option, separator, _ = argument.partition("=")
        if option not in MPI_OPTIONS:
            return next((os.path.basename(value) for value in arguments[index:] if os.path.basename(value) in OPENFOAM_EXECUTABLES), None)
        index += 1 + max(0, MPI_OPTIONS[option] - bool(separator))
    return None


def running_openfoam_processes(proc_root="/proc"):
    found = []
    for path in Path(proc_root).iterdir():
        if not path.name.isdigit():
            continue
        try:
            raw = (path / "cmdline").read_bytes()
        except (FileNotFoundError, ProcessLookupError):
            continue
        arguments = [value.decode(errors="replace") for value in raw.split(b"\0") if value]
        program = openfoam_program(arguments)
        if program:
            found.append((int(path.name), program))
    return sorted(found)


if __name__ == "__main__":
    for process_id, program in running_openfoam_processes():
        print(f"{process_id} {program}")
