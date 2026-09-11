def configure_unbound_mpi(runner):
    original = runner.run

    def run(case_dir, command, timeout=7200, monitor=None):
        if command.startswith("mpirun "):
            command = command.replace("mpirun ", "mpirun --bind-to none --report-bindings ", 1)
        return original(case_dir, command, timeout=timeout, monitor=monitor)

    runner.run = run
