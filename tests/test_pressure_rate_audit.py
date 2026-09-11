from copy import deepcopy
import json

import numpy as np
import pytest

from scripts.materials.audit_pressure_rates import DIMENSIONS, load_consecutive_states, load_field, recompute_rates


def fixture():
    state = {"rho": np.ones(2), "U": np.array([[1.0, 0, 0], [1.0, 0, 0]]), "h": np.full(2, 2.0),
             "p": np.ones(2), "k": np.ones(2), "omega": np.ones(2), "rDeltaT": np.full(2, 2.0)}
    refs = {"referenceDensity": 1, "referenceSpeed": 1, "referenceLength": 1, "referenceSpecificEnergy": 1,
            "referenceTurbulenceEnergy": 1, "referenceTurbulenceFrequency": 1}
    return state, refs


def test_independent_rates_include_pressure_and_kinetic_energy():
    before, refs = fixture()
    after = deepcopy(before)
    after["U"][1, 0] = 2
    rates = recompute_rates(before, after, refs)
    assert rates["momentum"]["recomputed"] == pytest.approx(2)
    assert rates["total_energy"]["recomputed"] == pytest.approx(3)
    assert rates["density"]["recomputed"] == 0
    after = deepcopy(before)
    after["p"][0] += 0.5
    rates = recompute_rates(before, after, refs)
    assert rates["total_energy"]["recomputed"] == pytest.approx(1)
    assert rates["total_energy"]["cell_index"] == 0


@pytest.mark.parametrize("name", ["rho", "h", "k", "omega"])
def test_independent_audit_detects_each_scalar_channel(name):
    before, refs = fixture()
    after = deepcopy(before)
    after[name][0] += 0.01
    rates = recompute_rates(before, after, refs)
    channel = {"rho": "density", "h": "total_energy"}.get(name, name)
    assert rates[channel]["recomputed"] == pytest.approx(0.02)
    assert rates[channel]["roundoff_envelope"] < 1e-10


def test_uniform_input_is_supported_but_wrong_dimensions_are_not(tmp_path):
    path = tmp_path / "rho"
    path.write_text("FoamFile { format ascii; }\ndimensions [1 -3 0 0 0 0 0];\ninternalField uniform 1.2;")
    np.testing.assert_equal(load_field(path, 3), [1.2, 1.2, 1.2])
    path.write_text(path.read_text().replace("1 -3", "0 0"))
    with pytest.raises(ValueError, match="dimensions"):
        load_field(path, 3)


def test_rates_refuse_nonphysical_time_or_nonfinite_state():
    before, refs = fixture()
    after = deepcopy(before)
    after["rDeltaT"][0] = 0
    with pytest.raises(ValueError, match="positive"):
        recompute_rates(before, after, refs)


    after = deepcopy(before)
    after["U"][0, 0] = np.nan
    with pytest.raises(ValueError, match="Nonfinite"):
        recompute_rates(before, after, refs)


def test_processor_states_are_reassembled_without_inventing_missing_cells(tmp_path):
    for index in range(2):
        processor = tmp_path / f"processor{index}"
        mesh = processor / "constant/polyMesh"
        mesh.mkdir(parents=True)
        (mesh / "cellProcAddressing").write_text(f"FoamFile {{ format ascii; }}\n1({index})")
        for coordinate in (10, 11):
            time = processor / str(coordinate)
            time.mkdir()
            for name, dimensions in DIMENSIONS.items():
                value = f"({coordinate} {index} 0)" if name == "U" else str(coordinate + index)
                (time / name).write_text(f"FoamFile {{ format ascii; }}\ndimensions [{' '.join(map(str, dimensions))}];\ninternalField uniform {value};")
    coordinates, states, storage = load_consecutive_states(tmp_path, 2)
    assert coordinates == [10, 11]
    assert storage == "exact_processor_addressing"
    np.testing.assert_equal(states[1]["rho"], [11, 12])
    with pytest.raises(ValueError, match="every mesh cell"):
        load_consecutive_states(tmp_path, 3)
    (tmp_path / "processor1/constant/polyMesh/cellProcAddressing").write_text("FoamFile { format ascii; }\n1(0)")
    with pytest.raises(ValueError, match="overlaps"):
        load_consecutive_states(tmp_path, 2)


def test_full_audit_serializes_both_agreement_and_real_mismatch(tmp_path, monkeypatch):
    from scripts.materials import audit_pressure_rates as module

    before, refs = fixture()
    report = {"actual_execution": {"physical_time_history": False}, "native_steady_detector": {"energy_field": "h", "references": refs}}
    monkeypatch.setattr(module, "authenticated_retained_source", lambda _: (tmp_path, b"fixture-manifest", {}, {}, report))
    monkeypatch.setattr(module, "load_consecutive_states", lambda *_: ([10, 11], [before, deepcopy(before)], "fixture"))
    mesh = tmp_path / "constant/polyMesh"
    mesh.mkdir(parents=True)
    (mesh / "owner").write_text("FoamFile { format ascii; }\n2(0 1)")
    (mesh / "neighbour").write_text("FoamFile { format ascii; }\n0()")
    (tmp_path / "system").mkdir()
    (tmp_path / "system/controlDict").write_text("FoamFile { format ascii; }\n" + "\n".join(f"{name} {value};" for name, value in refs.items()))
    log = tmp_path / "log.rhoPimpleFoam"
    log.write_text("Time = 11\nXFOILFOAM_LOCAL_STEADY_RESIDUAL 11 0 0 0 0 0\n")
    result = module.audit_case(tmp_path)
    assert result["all_channels_consistent"] is True
    json.dumps(result, allow_nan=False)
    log.write_text("Time = 11\nXFOILFOAM_LOCAL_STEADY_RESIDUAL 11 1 0 0 0 0\n")
    result = module.audit_case(tmp_path)
    assert result["all_channels_consistent"] is False
    json.dumps(result, allow_nan=False)
