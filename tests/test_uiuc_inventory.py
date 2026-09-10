from scripts.materials.inventory_uiuc_references import profile_family


def test_test_model_labels_share_one_holdout_family():
    assert profile_family(" E387 (A) ") == profile_family("E387 (B)") == "e387"
    assert profile_family("S1223") != profile_family("S1223VG1")
    assert profile_family("SD7037 (A)") != profile_family("SD7032 (D)")
