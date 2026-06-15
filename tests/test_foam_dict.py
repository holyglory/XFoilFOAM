from pathlib import Path

from airfoilfoam.openfoam.foam_dict import (
    Raw,
    dimensions,
    render_field,
    vector,
    write_foam_dict,
)


def test_write_foam_dict_roundtrip(tmp_path: Path):
    p = tmp_path / "controlDict"
    write_foam_dict(
        p, "dictionary", "controlDict",
        {"application": "simpleFoam", "endTime": 1000, "nested": {"a": 1, "b": vector(1, 2, 3)}},
    )
    text = p.read_text()
    assert "FoamFile" in text
    assert "object      controlDict;" in text
    assert "application     simpleFoam;" in text
    assert "(1 2 3)" in text
    assert "nested\n{" in text


def test_long_key_has_space_before_value(tmp_path: Path):
    # regression: long dict keys must still be separated from their value by a space
    p = tmp_path / "fvSchemes"
    write_foam_dict(p, "dictionary", "fvSchemes",
                    {"divSchemes": {"div((nuEff*dev2(T(grad(U)))))": "Gauss linear"}})
    text = p.read_text()
    assert "div((nuEff*dev2(T(grad(U))))) Gauss linear;" in text


def test_dimensions_and_vector_format():
    assert str(dimensions(0, 2, -1, 0, 0, 0, 0)) == "[0 2 -1 0 0 0 0]"
    assert str(vector(1.5, 0, -2)) == "(1.5 0 -2)"


def test_render_field_structure():
    text = render_field(
        "volScalarField", "p", dimensions(0, 2, -2, 0, 0, 0, 0), "uniform 0",
        {"inlet": {"type": "zeroGradient"}, "walls": {"type": "fixedValue", "value": Raw("uniform 0")}},
    )
    assert "class       volScalarField;" in text
    assert "internalField   uniform 0;" in text
    assert "boundaryField" in text
    assert "type            zeroGradient;" in text
