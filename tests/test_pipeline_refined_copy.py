"""Regression: _copy_initialized_transient_case with start_time == 0.0.

Production failure (2026-07-05, sd8020 alpha=0, validation campaign): the
retained start time of a no-shedding URANS pass is 0.0, whose time directory
is the "0" dir the helper had already copied — the second copytree raised
FileExistsError and failed the point.
"""
from pathlib import Path

from airfoilfoam.pipeline import _copy_initialized_transient_case


def _make_case(root: Path) -> Path:
    src = root / "transient"
    for name in ("0", "constant", "system"):
        (src / name).mkdir(parents=True)
        (src / name / "marker").write_text(name)
    (src / "0.4").mkdir()
    (src / "0.4" / "U").write_text("fields")
    return src


def test_start_time_zero_does_not_collide(tmp_path):
    src = _make_case(tmp_path)
    dst = tmp_path / "transient_refined"
    _copy_initialized_transient_case(src, dst, start_time=0.0)
    assert (dst / "0" / "marker").read_text() == "0"
    assert (dst / "constant" / "marker").exists()


def test_nonzero_start_time_still_copied(tmp_path):
    src = _make_case(tmp_path)
    dst = tmp_path / "transient_refined"
    _copy_initialized_transient_case(src, dst, start_time=0.4)
    assert (dst / "0.4" / "U").exists()
    assert (dst / "0" / "marker").exists()


def test_existing_destination_is_replaced(tmp_path):
    src = _make_case(tmp_path)
    dst = tmp_path / "transient_refined"
    dst.mkdir()
    (dst / "stale").write_text("old attempt")
    _copy_initialized_transient_case(src, dst, start_time=0.0)
    assert not (dst / "stale").exists()
