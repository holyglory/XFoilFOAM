def configure_unbound_mpi(runner):
    original = runner.run

    def run(case_dir, command, timeout=7200, monitor=None):
        if command.startswith("mpirun "):
            if " --bind-to " in command:
                if " --bind-to none " not in command:
                    raise ValueError("Conflicting explicit MPI binding")
                if " --report-bindings " not in command:
                    command = command.replace("mpirun ", "mpirun --report-bindings ", 1)
            else:
                command = command.replace("mpirun ", "mpirun --bind-to none --report-bindings ", 1)
        return original(case_dir, command, timeout=timeout, monitor=monitor)

    runner.run = run
