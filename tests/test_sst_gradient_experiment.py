import pytest

from scripts.materials.rae2822_local_time import limit_sst_gradients


def test_sst_gradient_limiter_preserves_other_discretization_and_references(tmp_path):
    path = tmp_path / "system/fvSchemes"
    path.parent.mkdir()
    original = "gradSchemes { default Gauss linear; limited cellLimited Gauss linear 1; grad(U) $limited; }\ndivSchemes { div(phi,k) Gauss upwind; div(phi,omega) Gauss upwind; div(phid,p) Gauss vanLeer; }"
    path.write_text(original)
    receipt = limit_sst_gradients(tmp_path)
    expected = original.replace("grad(U) $limited; }", "grad(U) $limited; \n    grad(k)         $limited;\n    grad(omega)     $limited;\n}")
    assert path.read_text() == expected
    assert receipt["fields"] == ["k", "omega"]
    assert receipt["before_sha256"] != receipt["after_sha256"]
    assert receipt["acceptance_threshold_changed"] is False
    with pytest.raises(ValueError, match="original"):
        limit_sst_gradients(tmp_path)


@pytest.mark.parametrize("text", [
    "gradSchemes { default Gauss linear; }",
    "gradSchemes { limited cellLimited Gauss linear 0.5; grad(U) $limited; }",
    "gradSchemes { limited cellLimited Gauss linear 1; grad(U) $limited; grad(k) Gauss linear; }",
    "gradSchemes { limited cellLimited Gauss linear 1; grad(U) $limited; } gradSchemes { }",
])
def test_ambiguous_or_changed_gradient_recipe_is_rejected_without_write(tmp_path, text):
    path = tmp_path / "system/fvSchemes"
    path.parent.mkdir()
    path.write_text(text)
    with pytest.raises(ValueError):
        limit_sst_gradients(tmp_path)
    assert path.read_text() == text
