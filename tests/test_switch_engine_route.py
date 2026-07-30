from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from types import ModuleType
from typing import Iterator

import pytest


ROOT = Path(__file__).resolve().parents[1]
SWITCH = ROOT / "scripts" / "deploy" / "switch-engine-route.sh"
SWITCH_PY = ROOT / "scripts" / "deploy" / "switch-engine-route.py"


@contextmanager
def _engine_health(
    payload: dict[str, object], *, status: int = 200, requests: list[str] | None = None
) -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib HTTP hook name
            if requests is not None:
                requests.append(self.path)
            if self.path != "/health":
                self.send_error(404)
                return
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/health"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def _state(tmp_path: Path, engine_url: str) -> tuple[Path, Path, Path]:
    app = tmp_path / "app"
    state = tmp_path / "state"
    app.mkdir()
    state.mkdir()
    env = state / ".env.deploy"
    env.write_text(
        "POSTGRES_PASSWORD=never-store-env-secret\n"
        f"ENGINE_URL={engine_url}\n"
        "AIRFOILFOAM_DEPLOYMENT_ROLE=hub\n"
        "COMPOSE_PROJECT_NAME=app\n",
        encoding="utf-8",
    )
    env.chmod(0o600)
    return app, state, env


def _load_switch_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("engine_route_switch", SWITCH_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _request(
    module: ModuleType,
    app: Path,
    state: Path,
    *,
    primary_url: str = "http://api:8000",
    primary_build: str = "candidate-build-10",
    primary_health_url: str | None = None,
    recovery_url: str = "http://app-api-recovery:8000",
    recovery_build: str = "candidate-build-9",
    recovery_health_url: str | None = None,
    active_route: str = "primary",
) -> object:
    return module.RouteSwitchRequest(
        app_dir=app,
        state_dir=state,
        env_file=state / ".env.deploy",
        lock_file=state / "deploy.lock",
        primary_engine_url=primary_url,
        primary_expected_build_id=primary_build,
        primary_health_url=primary_health_url,
        recovery_engine_url=recovery_url,
        recovery_expected_build_id=recovery_build,
        recovery_health_url=recovery_health_url,
        active_route=active_route,
        health_timeout_seconds=2,
    )


def _allow_candidate_proofs(
    monkeypatch: pytest.MonkeyPatch, module: ModuleType
) -> list[tuple[str, str, str, str]]:
    calls: list[tuple[str, str, str, str]] = []

    def proof(request: object) -> None:
        calls.append(
            (
                request.primary_engine_url,
                request.primary_expected_build_id,
                request.recovery_engine_url,
                request.recovery_expected_build_id,
            )
        )

    monkeypatch.setattr(module, "_validate_candidates", proof)
    return calls


def test_route_switch_proves_two_independently_identified_candidates_then_commits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_switch_module()
    app, state, env = _state(tmp_path, "http://api:8000")
    calls = _allow_candidate_proofs(monkeypatch, module)
    request = _request(module, app, state, active_route="recovery")

    assert module.switch_engine_route(request) == "switched"
    assert f"ENGINE_URL=http://app-api-recovery:8000\n" in env.read_text(
        encoding="utf-8"
    )
    assert json.loads((state / "engine-route.json").read_text(encoding="utf-8")) == {
        "schema_version": 1,
        "engine_url": "http://app-api-recovery:8000",
    }
    assert calls == [
        (
            "http://api:8000",
            "candidate-build-10",
            "http://app-api-recovery:8000",
            "candidate-build-9",
        )
    ] * 2
    assert not (state / ".engine-route-switch.pending.json").exists()


def test_route_switch_refuses_a_failed_consumer_proof_without_touching_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_switch_module()
    app, state, env = _state(tmp_path, "http://api:8000")
    before = env.read_bytes()
    request = _request(module, app, state, active_route="recovery")

    def reject(_request: object) -> None:
        raise module.RouteSwitchError("recovery engine consumer-network health proof failed")

    monkeypatch.setattr(module, "_validate_candidates", reject)
    with pytest.raises(module.RouteSwitchError, match="consumer-network"):
        module.switch_engine_route(request)

    assert env.read_bytes() == before
    assert not (state / "engine-route.json").exists()
    assert not (state / ".engine-route-switch.pending.json").exists()


def test_route_switch_refuses_noncanonical_direct_call_inputs_before_probing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_switch_module()
    app, state, _env = _state(tmp_path, "http://api:8000")
    request = _request(module, app, state, primary_url="http://API:8000/")

    def unexpected_probe(_request: object) -> None:
        raise AssertionError("candidate probe must not run for invalid route state")

    monkeypatch.setattr(module, "_validate_candidates", unexpected_probe)
    with pytest.raises(module.RouteSwitchError, match="canonical origin"):
        module.switch_engine_route(request)


def test_consumer_network_proof_execs_node_api_without_lifecycle_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_switch_module()
    app, state, _env = _state(tmp_path, "http://api:8000")
    request = _request(module, app, state)
    command_seen: list[str] = []

    monkeypatch.setattr(module, "_compose_command", lambda _request: ["docker", "compose"])

    def completed(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        command_seen.extend(command)
        return subprocess.CompletedProcess(command, 0, "consumer engine health proof ok\n", "")

    monkeypatch.setattr(module.subprocess, "run", completed)
    module._probe_health_from_consumer(request, request.primary_candidate)

    assert command_seen[:4] == ["docker", "compose", "exec", "-T"]
    assert "node-api" in command_seen
    assert "up" not in command_seen
    assert "down" not in command_seen
    assert "restart" not in command_seen
    assert "AIRFOILFOAM_ENGINE_ROUTE_PROBE_URL=http://api:8000" in command_seen
    assert "AIRFOILFOAM_ENGINE_ROUTE_PROBE_BUILD_ID=candidate-build-10" in command_seen
    assert command_seen[-2] == "-e"
    assert "fetch(" in command_seen[-1]


def test_consumer_probe_resolves_only_the_active_versioned_release_symlink(
    tmp_path: Path,
) -> None:
    module = _load_switch_module()
    app, state, _env = _state(tmp_path, "http://api:8000")
    app.rmdir()
    releases = tmp_path / "releases"
    releases.mkdir(mode=0o700)
    release = releases / "revision-a"
    release.mkdir(mode=0o700)
    compose = release / "docker-compose.deploy.yml"
    compose.write_text("services: {}\n", encoding="utf-8")
    compose.chmod(0o600)
    app.symlink_to(release, target_is_directory=True)

    assert module._active_app_dir(app, state) == release


def test_consumer_probe_refuses_an_app_symlink_outside_versioned_releases(
    tmp_path: Path,
) -> None:
    module = _load_switch_module()
    app, state, _env = _state(tmp_path, "http://api:8000")
    app.rmdir()
    (tmp_path / "releases").mkdir(mode=0o700)
    outside = tmp_path / "untrusted-release"
    outside.mkdir(mode=0o700)
    app.symlink_to(outside, target_is_directory=True)

    with pytest.raises(module.RouteSwitchError, match="must target the deployment releases"):
        module._active_app_dir(app, state)


def test_candidate_validation_requires_consumer_proofs_and_only_adds_host_proofs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_switch_module()
    app, state, _env = _state(tmp_path, "http://api:8000")
    request = _request(
        module,
        app,
        state,
        primary_health_url="http://127.0.0.1:8000/health",
    )
    consumer: list[tuple[str, str]] = []
    host: list[tuple[str, str]] = []

    monkeypatch.setattr(
        module,
        "_probe_health_from_consumer",
        lambda _request, candidate: consumer.append(
            (candidate.name, candidate.expected_build_id)
        ),
    )
    monkeypatch.setattr(
        module,
        "_probe_health_url",
        lambda health_url, candidate, _timeout: host.append(
            (health_url, candidate.expected_build_id)
        ),
    )
    module._validate_candidates(request)

    assert consumer == [
        ("primary", "candidate-build-10"),
        ("recovery", "candidate-build-9"),
    ]
    assert host == [("http://127.0.0.1:8000/health", "candidate-build-10")]


def test_optional_host_health_proof_checks_its_candidate_build_id() -> None:
    module = _load_switch_module()
    with _engine_health({"status": "ok", "build_id": "candidate-build-10"}) as url:
        candidate = module.EngineCandidate(
            name="primary",
            engine_url="http://api:8000",
            expected_build_id="candidate-build-9",
            health_url=url,
        )
        with pytest.raises(module.RouteSwitchError, match="candidate-build-9"):
            module._probe_health_url(url, candidate, 2)


def test_node_consumer_probe_enforces_the_bounded_exact_build_contract() -> None:
    module = _load_switch_module()
    with _engine_health({"status": "ok", "build_id": "candidate-build-10"}) as url:
        environment = {
            **os.environ,
            "AIRFOILFOAM_ENGINE_ROUTE_PROBE_URL": url.removesuffix("/health"),
            "AIRFOILFOAM_ENGINE_ROUTE_PROBE_BUILD_ID": "candidate-build-10",
            "AIRFOILFOAM_ENGINE_ROUTE_PROBE_TIMEOUT": "2",
            "AIRFOILFOAM_ENGINE_ROUTE_PROBE_MAX_BYTES": "1048576",
        }
        completed = subprocess.run(
            ["node", "-e", module.CONSUMER_HEALTH_PROBE],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )

    assert completed.returncode == 0, completed.stderr
    assert "consumer engine health proof ok" in completed.stdout


def test_interrupted_two_file_commit_blocks_deploys_then_resumes_exact_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_switch_module()
    app, state, _env = _state(tmp_path, "http://api:8000")
    request = _request(module, app, state, active_route="recovery")
    _allow_candidate_proofs(monkeypatch, module)
    original_replace = module._replace_target

    def interrupt_after_env(target: object, state_dir: Path) -> None:
        original_replace(target, state_dir)
        if target.name == "env":
            raise KeyboardInterrupt("simulated process loss after env replacement")

    monkeypatch.setattr(module, "_replace_target", interrupt_after_env)
    with pytest.raises(KeyboardInterrupt):
        module.switch_engine_route(request)

    pending = state / ".engine-route-switch.pending.json"
    assert pending.exists()
    journal = json.loads(pending.read_text(encoding="utf-8"))
    assert journal["primary_expected_build_id"] == "candidate-build-10"
    assert journal["recovery_expected_build_id"] == "candidate-build-9"
    assert "never-store-env-secret" not in pending.read_text(encoding="utf-8")
    assert f"ENGINE_URL=http://app-api-recovery:8000\n" in (
        state / ".env.deploy"
    ).read_text(encoding="utf-8")
    assert not (state / "engine-route.json").exists()

    monkeypatch.setattr(module, "_replace_target", original_replace)
    assert module.switch_engine_route(request) == "resumed"
    assert json.loads((state / "engine-route.json").read_text(encoding="utf-8")) == {
        "schema_version": 1,
        "engine_url": "http://app-api-recovery:8000",
    }
    assert not pending.exists()


def test_pending_route_switch_refuses_a_different_candidate_build_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_switch_module()
    app, state, _env = _state(tmp_path, "http://api:8000")
    first = _request(module, app, state, active_route="recovery")
    _allow_candidate_proofs(monkeypatch, module)
    original_replace = module._replace_target

    def interrupt_after_env(target: object, state_dir: Path) -> None:
        original_replace(target, state_dir)
        if target.name == "env":
            raise KeyboardInterrupt("simulated interruption")

    monkeypatch.setattr(module, "_replace_target", interrupt_after_env)
    with pytest.raises(KeyboardInterrupt):
        module.switch_engine_route(first)
    monkeypatch.setattr(module, "_replace_target", original_replace)

    changed = _request(
        module,
        app,
        state,
        active_route="recovery",
        recovery_build="candidate-build-9b",
    )
    with pytest.raises(module.RouteSwitchError, match="different request"):
        module.switch_engine_route(changed)


def test_cli_parses_distinct_candidate_builds_and_optional_host_health_urls(
    tmp_path: Path,
) -> None:
    module = _load_switch_module()
    app = tmp_path / "app"
    state = tmp_path / "state"
    request = module._parse_args(
        [
            "--app-dir",
            str(app),
            "--state-dir",
            str(state),
            "--primary-engine-url",
            "http://api:8000",
            "--primary-engine-build-id",
            "build-v10",
            "--primary-health-url",
            "http://127.0.0.1:8000/health",
            "--recovery-engine-url",
            "http://app-api-recovery:8000",
            "--recovery-engine-build-id",
            "build-v9",
            "--active-route",
            "primary",
        ]
    )

    assert request.primary_expected_build_id == "build-v10"
    assert request.recovery_expected_build_id == "build-v9"
    assert request.primary_health_url == "http://127.0.0.1:8000/health"
    assert request.recovery_health_url is None


def test_shell_wrapper_exposes_the_safe_candidate_specific_cli() -> None:
    completed = subprocess.run(
        [str(SWITCH), "--help"], text=True, capture_output=True, check=False
    )

    assert completed.returncode == 0
    assert "--primary-engine-build-id" in completed.stdout
    assert "--recovery-engine-build-id" in completed.stdout
    assert "--primary-health-url" in completed.stdout
