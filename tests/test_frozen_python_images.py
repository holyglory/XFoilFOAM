"""Static contracts for reproducible Python installs in production images."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
ACTIVE_DOCKERFILES = (
    ROOT / "docker" / "Dockerfile.api",
    ROOT / "docker" / "Dockerfile.worker",
    ROOT / "docker" / "Dockerfile.worker-foundation14",
)
WORKER_DOCKERFILES = ACTIVE_DOCKERFILES[1:]
EXPECTED_STORAGE_VERSIONS = {
    "google-cloud-storage": "3.13.0",
    "google-crc32c": "1.8.0",
    "zstandard": "0.25.0",
}


def _package_blocks(lockfile: Path) -> dict[str, str]:
    lines = lockfile.read_text().splitlines()
    starts = [
        index
        for index, line in enumerate(lines)
        if line and not line[0].isspace() and not line.startswith("#")
    ]
    blocks: dict[str, str] = {}
    for offset, start in enumerate(starts):
        end = starts[offset + 1] if offset + 1 < len(starts) else len(lines)
        block = "\n".join(lines[start:end])
        name = re.split(r"==|\s", lines[start], maxsplit=1)[0]
        blocks[name] = block
    return blocks


def test_active_images_install_only_from_hash_pinned_locks():
    copy_command = (
        "COPY docker/build-requirements.lock docker/requirements.lock /tmp/"
    )
    build_install = (
        "python3 -m pip install --no-cache-dir --require-hashes "
        "-r /tmp/build-requirements.lock"
    )
    runtime_install = (
        "python3 -m pip install --no-cache-dir --require-hashes "
        "-r /tmp/requirements.lock"
    )
    project_install = (
        "python3 -m pip install --no-cache-dir --no-deps "
        "--no-build-isolation ."
    )
    for dockerfile in ACTIVE_DOCKERFILES:
        contents = dockerfile.read_text()
        ordered = [
            contents.index(copy_command),
            contents.index(build_install),
            contents.index(runtime_install),
            contents.index(project_install),
            contents.index("python3 -m pip check"),
            contents.index("from importlib.metadata import version"),
            contents.index(
                "rm -f /tmp/build-requirements.lock /tmp/requirements.lock"
            ),
        ]

        assert ordered == sorted(ordered), dockerfile
        for name, expected in EXPECTED_STORAGE_VERSIONS.items():
            assert f"'{name}': '{expected}'" in contents, dockerfile
        assert "pip install --no-cache-dir ." not in contents
        assert "pip3 install --no-cache-dir ." not in contents


def test_dependency_locks_pin_and_hash_every_distribution():
    for lockfile in (
        ROOT / "docker" / "build-requirements.lock",
        ROOT / "docker" / "requirements.lock",
    ):
        blocks = _package_blocks(lockfile)
        assert blocks, lockfile
        for name, block in blocks.items():
            first_line = block.splitlines()[0]
            assert "==" in first_line, (lockfile, name)
            assert "--hash=sha256:" in block, (lockfile, name)

    build_blocks = _package_blocks(ROOT / "docker" / "build-requirements.lock")
    assert set(build_blocks) == {"setuptools", "wheel"}
    assert build_blocks["setuptools"].startswith("setuptools==80.9.0")
    assert build_blocks["wheel"].startswith("wheel==0.45.1")

    runtime_blocks = _package_blocks(ROOT / "docker" / "requirements.lock")
    for name, expected in EXPECTED_STORAGE_VERSIONS.items():
        assert runtime_blocks[name].startswith(f"{name}=={expected}")


def test_solver_images_isolate_locked_packages_from_os_python():
    for dockerfile in WORKER_DOCKERFILES:
        contents = dockerfile.read_text()
        venv_env = "VIRTUAL_ENV=/opt/airfoilfoam-venv"
        venv_path = "PATH=/opt/airfoilfoam-venv/bin:${PATH}"
        create_venv = 'RUN python3 -m venv "${VIRTUAL_ENV}"'
        locked_install = (
            "python3 -m pip install --no-cache-dir --require-hashes "
            "-r /tmp/build-requirements.lock"
        )

        assert venv_env in contents, dockerfile
        assert venv_path in contents, dockerfile
        assert contents.index(create_venv) < contents.index(locked_install), dockerfile


def test_emergency_rollback_image_keeps_its_historical_lock_path():
    rollback = (
        ROOT / "docker" / "Dockerfile.worker-opencfd2406-rollback"
    ).read_text()

    assert "COPY rollback-requirements.lock /tmp/rollback-requirements.lock" in rollback
    assert "docker/requirements.lock" not in rollback
    assert "docker/build-requirements.lock" not in rollback
