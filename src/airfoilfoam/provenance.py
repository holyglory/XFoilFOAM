"""Deterministic content fingerprints for the Python solver adapter.

The OCI digest is assigned by the registry after an image is built, so it is
not always available inside the running container.  The worker images instead
write this digest while building, over the exact Python application sources
and packaging metadata copied into the image.  Local/editable runs use the
same canonical algorithm directly against the checkout.
"""
from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path


APPLICATION_SOURCE_SHA256_PATH = Path(
    "/etc/airfoilfoam-application-source-sha256"
)


def application_source_files(project_root: Path) -> list[Path]:
    """Return the canonical, path-sorted adapter source manifest."""
    root = project_root.resolve()
    paths: list[Path] = []
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        paths.append(pyproject)
    source_root = root / "src"
    if source_root.is_dir():
        paths.extend(
            path
            for path in source_root.rglob("*")
            if path.is_file()
            and "__pycache__" not in path.parts
            and path.suffix not in {".pyc", ".pyo"}
        )
    return sorted(paths, key=lambda path: path.relative_to(root).as_posix())


def application_source_sha256(project_root: Path) -> str:
    """Hash canonical relative paths and bytes without host-path dependence."""
    root = project_root.resolve()
    paths = application_source_files(root)
    if not paths:
        raise ValueError(f"no application sources found below {root}")
    digest = hashlib.sha256()
    for path in paths:
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def write_application_source_sha256(
    project_root: Path,
    destination: Path = APPLICATION_SOURCE_SHA256_PATH,
) -> str:
    """Write the canonical source digest used by an immutable worker image."""
    fingerprint = application_source_sha256(project_root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(f"{fingerprint}\n", encoding="ascii")
    return fingerprint


@lru_cache(maxsize=1)
def installed_application_source_sha256() -> str:
    """Read the image fingerprint, or derive one for a source checkout.

    Image builds always create the fixed file.  The fallback keeps local
    workers content-addressed without pretending that a Git label or build id
    is a content digest.
    """
    if APPLICATION_SOURCE_SHA256_PATH.is_file():
        value = APPLICATION_SOURCE_SHA256_PATH.read_text(encoding="ascii").strip()
        if len(value) == 64 and all(char in "0123456789abcdef" for char in value):
            return value
        raise ValueError(
            f"invalid application source fingerprint in {APPLICATION_SOURCE_SHA256_PATH}"
        )

    for candidate in (
        Path.cwd(),
        Path("/app"),
        Path(__file__).resolve().parents[2],
    ):
        if application_source_files(candidate):
            return application_source_sha256(candidate)

    # Last-resort wheel installation: hash the installed adapter package with
    # stable package-relative paths. Docker images never take this branch
    # because they contain the build-generated fixed fingerprint file.
    package_root = Path(__file__).resolve().parent
    paths = sorted(
        (
            path
            for path in package_root.rglob("*")
            if path.is_file()
            and "__pycache__" not in path.parts
            and path.suffix not in {".pyc", ".pyo"}
        ),
        key=lambda path: path.relative_to(package_root).as_posix(),
    )
    if not paths:
        raise ValueError(f"no installed application sources found below {package_root}")
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(package_root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()
