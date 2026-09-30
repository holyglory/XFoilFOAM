import json
from pathlib import Path

from scripts.materials.reproduce_blunt_trailing_edge import SOURCE_SHA256, reproduction_request


ROOT = Path(__file__).parents[1]
REQUEST = ROOT / ".codex-artifacts/sg6051-polar-diagnosis-20260930/job-request.json"


def test_full_polar_reference_preserves_the_source_request_and_expands_only_angles():
    original = REQUEST.read_bytes()
    request = reproduction_request(original, "production-fixed", full_polar_reference=True)
    source = json.loads(original)["engineRequest"]
    assert SOURCE_SHA256
    assert request.mesh.mesher == source["mesh"]["mesher"]
    assert request.mesh.target_y_plus == source["mesh"]["target_y_plus"]
    assert request.solver.momentum_scheme == source["solver"]["momentum_scheme"]
    assert request.solver.flow_solver_family == source["solver"]["flow_solver_family"]
    assert request.aoa.expand() == list(range(-5, 21))
