import importlib.util
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam.calorics import Nasa7Calorics
from airfoilfoam.thermophysical_constants import OPENCFD2606_UNIVERSAL_GAS_CONSTANT
from airfoilfoam.transport import PolynomialTransport


@pytest.fixture
def native_verifier(monkeypatch):
    path = Path(__file__).parents[1] / "scripts/materials/verify-native-thermophysics.py"
    specification = importlib.util.spec_from_file_location("native_material_verifier", path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    fixture_path = Path(__file__).parent / "fixtures/air-thermophysics-audit.json"
    fixture = json.loads(fixture_path.read_text())
    calorics = Nasa7Calorics.model_validate(fixture["calorics"])
    transport = PolynomialTransport.model_validate(fixture["transport"])
    gas_constant = fixture["gas_constant"]
    samples = []
    for original in fixture["source_samples"]:
        temperature = original["temperature_k"]
        samples.append({"temperature_k": temperature,
            "dynamic_viscosity": transport.dynamic_viscosity(temperature),
            "thermal_conductivity": transport.thermal_conductivity(temperature),
            "heat_capacity": gas_constant * calorics.heat_capacity_ratio(temperature),
            "enthalpy": gas_constant * calorics.enthalpy_ratio(temperature),
            "entropy": gas_constant * calorics.entropy_ratio(temperature),
            "density": fixture["source"]["transport_pressure_pa"] / (gas_constant * temperature)})
    native = {"registered_combinations": 1, "universal_gas_constant": OPENCFD2606_UNIVERSAL_GAS_CONSTANT, "samples": samples}
    monkeypatch.setattr(module.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        stdout=json.dumps(native), stderr="", check_returncode=lambda: None))
    original_read = Path.read_bytes
    monkeypatch.setattr(Path, "read_bytes", lambda path: b"isolated native binary fixture" if str(path) == "/opt/xfoilfoam-thermophysics/lib/libxfoilfoamThermophysics.so" else original_read(path))
    return module, fixture_path, native


def test_native_detector_accepts_equivalent_material_values_without_claiming_flow_validation(tmp_path, native_verifier):
    module, fixture_path, _ = native_verifier
    report = module.verify_native(fixture_path, tmp_path)
    assert report["registered_combinations"] == 1
    assert report["samples"] == 16
    assert report["physical_cfd_validated"] is False
    assert report["installed_catalog_material"] is False
    assert (Path(report["report_directory"]) / "receipt.json").is_file()


@pytest.mark.parametrize("property_name", ["dynamic_viscosity", "thermal_conductivity", "heat_capacity", "enthalpy", "entropy", "density"])
@pytest.mark.parametrize("factor", [1.01, -1, math.nan, math.inf])
def test_native_detector_rejects_each_bad_property(tmp_path, native_verifier, property_name, factor):
    module, fixture_path, native = native_verifier
    native["samples"][3][property_name] *= factor
    with pytest.raises(ValueError, match=property_name):
        module.verify_native(fixture_path, tmp_path)
    assert not list(tmp_path.glob("*/receipt.json"))
    assert list(tmp_path.glob("*/stdout.txt"))


@pytest.mark.parametrize("corruption", ["registration", "constant", "sample_count", "sample_temperature"])
def test_native_detector_rejects_wrong_registration_or_sample_identity(tmp_path, native_verifier, corruption):
    module, fixture_path, native = native_verifier
    if corruption == "registration":
        native["registered_combinations"] = 0
    elif corruption == "constant":
        native["universal_gas_constant"] = 8314.46261815324
    elif corruption == "sample_count":
        native["samples"].pop()
    else:
        native["samples"][0]["temperature_k"] += 1
    with pytest.raises(ValueError):
        module.verify_native(fixture_path, tmp_path)
    assert not list(tmp_path.glob("*/receipt.json"))
