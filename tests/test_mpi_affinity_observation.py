import pytest

from scripts.materials.inspect_mpi_affinity import observe_solver_affinity, parse_cpu_list


def test_affinity_ranges_are_exact_and_bounded():
    assert parse_cpu_list("0-3,7,2") == [0, 1, 2, 3, 7]
    for value in ("", "-1", "3-1", "1-2-3", "0-9999999", "nan"):
        with pytest.raises(ValueError):
            parse_cpu_list(value)


def test_probe_groups_real_solver_names_without_exposing_process_or_cgroup_paths(tmp_path):
    for pid, name, cpus, group in [(101, "rhoPimpleFoam", "0", "private/group-a"), (102, "rhoPimpleFoam", "1", "private/group-a"),
                                     (103, "rhoPimpleFoam", "0", "private/group-b"), (104, "unrelated", "0-3", "private/other")]:
        path = tmp_path / str(pid)
        path.mkdir()
        (path / "comm").write_text(name)
        (path / "status").write_text(f"Cpus_allowed_list:\t{cpus}\n")
        (path / "cgroup").write_text(group)
    report = observe_solver_affinity(tmp_path)
    assert sorted(group["processes"] for group in report["groups"]) == [1, 2]
    assert all(group["solver"] == "rhoPimpleFoam" for group in report["groups"])
    assert "private/" not in str(report)
    assert "101" not in str([group["rank_affinities"] for group in report["groups"]])
    assert report["unavailable_process_reads"] == 0
