from __future__ import annotations

from pathlib import Path
import runpy
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
DEPLOY_TESTS = runpy.run_path(str(ROOT / "tests" / "test_deploy_sweeper_state.py"))
_deploy_harness = DEPLOY_TESTS["_deploy_harness"]
_replace_env_values = DEPLOY_TESTS["_replace_env_values"]
_set_pending_attestation = DEPLOY_TESTS["_set_pending_attestation"]


@pytest.mark.parametrize("script", ["vps-redeploy.sh", "rebuild-engine.sh"])
def test_deploy_entry_rejects_mode_drift_before_compose_mutation(
    tmp_path: Path, script: str
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")
    Path(env["ENV_FILE"]).chmod(0o640)
    command = [str(ROOT / "scripts" / "deploy" / script)]
    if script == "rebuild-engine.sh":
        command.append("test-build")

    completed = subprocess.run(
        command, env=env, text=True, capture_output=True, check=False
    )

    assert completed.returncode == 2
    assert "exact mode 0600" in completed.stderr
    call_log = Path(env["CALL_LOG"])
    assert not call_log.exists() or call_log.read_text().splitlines() == []


def test_rebuild_rejects_compatibility_env_symlink_without_splitting_state(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")
    compatibility = Path(env["ENV_FILE"])
    state = Path(env["AIRFOILS_PRO_STATE_DIR"])
    state.mkdir()
    authoritative = state / ".env.deploy"
    original = compatibility.read_text()
    compatibility.replace(authoritative)
    compatibility.symlink_to(authoritative)

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 2
    assert "non-symlink regular file" in completed.stderr
    assert compatibility.is_symlink()
    assert compatibility.resolve() == authoritative
    assert authoritative.read_text() == original
    call_log = Path(env["CALL_LOG"])
    assert not call_log.exists() or call_log.read_text().splitlines() == []


def test_env_preflight_enforces_deploying_owner_in_source() -> None:
    source = (ROOT / "scripts" / "deploy" / "deployment-env-preflight.py").read_text()
    assert "metadata.st_uid != os.geteuid()" in source


@pytest.mark.parametrize(
    "token",
    [
        "",
        "too-short",
        '"quoted-control-plane-token-at-least-32-bytes"',
        "control-plane-token-with whitespace-at-least-32-bytes",
    ],
)
def test_remote_only_deploy_rejects_unsafe_control_plane_token_before_compose(
    tmp_path: Path,
    token: str,
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")
    _replace_env_values(
        Path(env["ENV_FILE"]),
        {"AIRFOILFOAM_CONTROL_PLANE_TOKEN": token},
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 2
    assert "remote-only GCS evidence requires" in completed.stderr
    call_log = Path(env["CALL_LOG"])
    assert not call_log.exists() or call_log.read_text().splitlines() == []


def test_remote_only_deploy_rejects_duplicate_control_plane_token_before_compose(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")
    env_file = Path(env["ENV_FILE"])
    with env_file.open("a", encoding="utf-8") as stream:
        stream.write(
            "AIRFOILFOAM_CONTROL_PLANE_TOKEN="
            "second-control-plane-token-at-least-32-bytes\n"
        )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 2
    assert "duplicates AIRFOILFOAM_CONTROL_PLANE_TOKEN" in completed.stderr
    call_log = Path(env["CALL_LOG"])
    assert not call_log.exists() or call_log.read_text().splitlines() == []


def test_certification_refuses_pending_recovery_bound_to_other_source(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    env_file = Path(env["ENV_FILE"])
    _set_pending_attestation(env_file, sweeper_was_running="0")
    _replace_env_values(
        env_file,
        {"OPENCFD2606_CUTOVER_SOURCE_REVISION": "b" * 40},
    )

    completed = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "different deployment source" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert calls == ["compose version"]


def test_control_plane_deploy_refuses_pending_cutover_before_build(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    env_file = Path(env["ENV_FILE"])
    _set_pending_attestation(env_file, sweeper_was_running="0")

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "cutover recovery is pending" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build " in call or " up " in call or " stop " in call for call in calls)
