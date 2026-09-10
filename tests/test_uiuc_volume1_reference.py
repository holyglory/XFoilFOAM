import pytest

from scripts.materials.uiuc_volume1_reference import parse_uiuc_volume1, split_source_files


def source(rows="-2 -0.2 -0.03\n0 0 -0.03\n2 0.2 -0.03\n1 0.11 -0.03\n-1 -0.09 -0.03", header="alpha / Cl / Cm", count=5):
    return f"Airfoil: isolated fixture\nBuilder: fixture\nComment: clean\n\nNumber of Reynolds #'s:\n1\nAverage Reynolds #:\n100600\nNumber of angles of attack:\n{count}\n{header}\n{rows}\nTabulated from data in file FIXTURE.DAT & reduced using program FIXTURE\n".encode()


def test_preserves_hysteresis_rows_without_inventing_experimental_moments():
    result = parse_uiuc_volume1(source(), "lift")
    run = result["runs"][0]
    assert run["reynolds"] == 100600
    assert [branch["direction"] for branch in run["branches"]] == ["increasing", "decreasing"]
    rows = [row for branch in run["branches"] for row in branch["rows"]]
    assert [row["source_row"] for row in rows] == list(range(5))
    assert all(row["coefficients"][2] is None for row in rows)
    assert all(row["computed_moment_for_correction"] == -0.03 for row in rows)
    assert result["experimental_moment_available"] is False
    assert result["measurement_uncertainty"] is None


def test_drag_columns_are_not_confused_with_moment_or_standard_error():
    raw = source("0 0.2 0.02 0.021 0.019\n1 0.3 0.03 0.031 0.029", "alpha / Cl / Cd / Spanwise Cd's >>>", 2)
    result = parse_uiuc_volume1(raw, "drag")
    row = result["runs"][0]["branches"][0]["rows"][0]
    assert row["coefficients"] == [0.2, 0.02, None]
    assert row["spanwise_drag"] == [0.021, 0.019]
    assert result["measurement_uncertainty"] is None
    with pytest.raises(ValueError, match="columns"):
        parse_uiuc_volume1(raw, "lift")


@pytest.mark.parametrize("raw", [source(count=6), source(count=4), source(rows="0 0 -0.03\n0 0 -0.03", count=2),
                                 source().replace(b"100600", b"-1"), source().replace(b"FIXTURE.DAT", b""),
                                 source().replace(b"-0.2", b"nan"), source() + b"unexplained row\n"])
def test_rejects_ambiguous_truncated_or_corrupt_source(raw):
    with pytest.raises(ValueError):
        parse_uiuc_volume1(raw, "lift")


def test_archive_named_blocks_preserve_source_bytes_and_reject_duplicates():
    raw = b"Moment data is not measured.\r\n::::::::::::::\r\nTEST.LFT\r\n::::::::::::::\r\nAirfoil: test\r\n::::::::::::::\r\nTEST.DRG\r\n::::::::::::::\r\nAirfoil: drag\r\n"
    assert split_source_files(raw) == {"TEST.LFT": b"Airfoil: test", "TEST.DRG": b"Airfoil: drag"}
    with pytest.raises(ValueError, match="Ambiguous"):
        split_source_files(raw.replace(b"TEST.DRG", b"TEST.LFT"))


def test_preserves_exact_archive_generation_footer_without_accepting_extra_rows():
    footer = b"File fixture.lft created on 12-05-1997 at 15:25:58 using program FORMAT\n"
    parsed = parse_uiuc_volume1(source() + footer, "lift")
    assert parsed["file_generation"] == {"file": "fixture.lft", "date": "12-05-1997", "time": "15:25:58", "program": "FORMAT"}
    for invalid in [footer + b"extra\n", footer.replace(b".lft", b".drg"), footer.replace(b"FORMAT", b"unknown")]:
        with pytest.raises(ValueError, match="Unexpected trailing"):
            parse_uiuc_volume1(source() + invalid, "lift")
