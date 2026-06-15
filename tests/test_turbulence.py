from airfoilfoam.case.turbulence import build_turbulence
from airfoilfoam.models import RoughnessParams, TurbulenceModel


def _build(model):
    return build_turbulence(
        model=model, speed=50.0, nu=1.5e-5, intensity=0.001, viscosity_ratio=10.0,
        roughness=RoughnessParams(), wall="airfoil", inlet="inlet", outlet="outlet",
        empty="frontAndBack",
    )


def test_sst_fields():
    cfg = _build(TurbulenceModel.k_omega_sst)
    names = {f.object_name for f in cfg.fields}
    assert names == {"k", "omega", "nut"}
    assert cfg.ras_model == "kOmegaSST"


def test_transition_model_adds_fields():
    cfg = _build(TurbulenceModel.k_omega_sst_lm)
    names = {f.object_name for f in cfg.fields}
    assert names == {"k", "omega", "nut", "gammaInt", "ReThetat"}
    assert cfg.ras_model == "kOmegaSSTLM"
    assert "div(phi,gammaInt)" in cfg.div_schemes
    assert "div(phi,ReThetat)" in cfg.div_schemes
    assert "gammaInt" in cfg.solver_vars and "ReThetat" in cfg.solver_vars
    # transition fields are dimensionless with an inlet fixedValue
    g = next(f for f in cfg.fields if f.object_name == "gammaInt")
    assert g.boundary["inlet"]["type"] == "fixedValue"
    assert g.boundary["airfoil"]["type"] == "zeroGradient"


def test_spalart_allmaras_fields():
    cfg = _build(TurbulenceModel.spalart_allmaras)
    names = {f.object_name for f in cfg.fields}
    assert names == {"nuTilda", "nut"}
