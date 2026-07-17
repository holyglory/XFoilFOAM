from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import re
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[1]
REPAIR = ROOT / "scripts" / "deploy" / "repair-pending-node-api.sh"
WORKFLOW = ROOT / ".github" / "workflows" / "deploy-airfoils-pro.yml"
BOUND_REVISION = "63385777be7323777906fde44bdb9fa9b5cc0d6d"
BOUND_TREE = "52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"
BOUND_FILE_COUNT = 2198
BOUND_API_SHA256 = "fa0654f95108b8d5b75ab56e81e13c9bd4706491904f776f95f1648eefc7bdea"
REPAIR_API_SHA256 = "e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4"
BOUND_API_TEST_SHA256 = "b936abf58c27f26bfec6a1c9f74fe4c1828c72d9d7faa3db5d2694e6a55a973d"
REPAIR_API_TEST_SHA256 = "bbc75aa6c6f0d4cca18f051fd1d06d89750c951d625ccd57031fd1a0b3c00e29"


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _git_file(revision: str, path: str) -> bytes:
    return subprocess.check_output(
        ["git", "show", f"{revision}:{path}"],
        cwd=ROOT,
    )


def test_repair_script_has_valid_shell_syntax() -> None:
    subprocess.run(["bash", "-n", str(REPAIR)], check=True, cwd=ROOT)
    python_blocks = re.findall(
        r"<<'PY'\n(.*?)\nPY",
        REPAIR.read_text(),
        flags=re.DOTALL,
    )
    assert len(python_blocks) >= 4
    for index, block in enumerate(python_blocks):
        compile(block, f"{REPAIR.name}:heredoc-{index}", "exec")


def test_incident_binding_matches_exact_bound_deployment_source(tmp_path: Path) -> None:
    archive = subprocess.check_output(
        ["git", "archive", "--format=tar", BOUND_REVISION],
        cwd=ROOT,
    )
    bound = tmp_path / "bound"
    bound.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as stream:
        stream.extractall(bound, filter="data")
    completed = subprocess.run(
        [
            "python3",
            str(bound / "scripts/deploy/deployment-source-manifest.py"),
            "--create",
            "--root",
            str(bound),
            "--manifest",
            str(bound / ".deployment-source.json"),
            "--revision",
            BOUND_REVISION,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert completed.stdout.strip() == (
        f"{BOUND_REVISION}\t{BOUND_TREE}\t{BOUND_FILE_COUNT}"
    )

    script = REPAIR.read_text()
    for value in (BOUND_REVISION, BOUND_TREE, str(BOUND_FILE_COUNT)):
        assert value in script


def test_reviewed_api_bytes_match_bound_and_repair_contracts() -> None:
    assert _sha256(_git_file(BOUND_REVISION, "apps/api/src/admin-routes.ts")) == (
        BOUND_API_SHA256
    )
    assert _sha256((ROOT / "apps/api/src/admin-routes.ts").read_bytes()) == (
        REPAIR_API_SHA256
    )
    assert _sha256(
        _git_file(
            BOUND_REVISION,
            "apps/api/test/solver-execution-pool-admission.test.ts",
        )
    ) == BOUND_API_TEST_SHA256
    assert _sha256(
        (
            ROOT
            / "apps/api/test/solver-execution-pool-admission.test.ts"
        ).read_bytes()
    ) == REPAIR_API_TEST_SHA256

    script = REPAIR.read_text()
    for value in (
        BOUND_API_SHA256,
        REPAIR_API_SHA256,
        BOUND_API_TEST_SHA256,
        REPAIR_API_TEST_SHA256,
    ):
        assert value in script


def test_repair_admits_only_the_reviewed_source_scope() -> None:
    script = REPAIR.read_text()
    expected_block = re.search(
        r"expected = \{(?P<body>.*?)\n\}",
        script,
        flags=re.DOTALL,
    )
    assert expected_block is not None
    assert set(re.findall(r'"([^"]+)"', expected_block.group("body"))) == {
        "apps/api/src/admin-routes.ts",
        "apps/api/test/solver-execution-pool-admission.test.ts",
        "scripts/deploy/repair-pending-node-api.sh",
        "tests/test_pending_cutover_node_api_repair.py",
    }
    assert 'spec_from_file_location("bound_deployment_source_manifest", tool)' in script
    assert "if set(changed) != expected:" in script


def test_only_node_api_has_mutating_compose_operations() -> None:
    script = REPAIR.read_text()
    mutation_lines = {
        line.strip()
        for line in script.splitlines()
        if re.match(
            r"^\s*compose_(?:bound|target) "
            r"(?:build|up|down|start|stop|restart|kill|rm)\b",
            line,
        )
    }
    assert mutation_lines == {
        "compose_bound up -d --no-deps --force-recreate node-api",
        "compose_target build node-api",
        "compose_target up -d --no-deps --force-recreate node-api",
    }
    for forbidden in (
        "force-recreate api",
        "force-recreate worker",
        "compose_target build api",
        "compose_target build worker",
        "compose_bound stop sweeper",
    ):
        assert forbidden not in script


def test_repair_guards_exact_pre_attestation_runtime_and_database_state() -> None:
    script = REPAIR.read_text()
    for contract in (
        'state.get("state_kind") != "pending-pristine"',
        'state.get("OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING") != "0"',
        'row.get("campaignStatus") != "paused"',
        'p.get("sourcePoolEnabled") is not False',
        'p.get("sourceImplementationRetired") is not True',
        'p.get("targetPoolEnabled") is not False',
        'p.get("targetAttestationCount") != 0',
        "WHERE solver_execution_pool_id = '$OPENCFD_2606_POOL_ID'",
        'row.get("targetConditionCount") != 0',
        'row.get("targetPointCount") != 0',
        "expected exactly one live OpenCFD worker binding",
        "Engine container/image identity changed during Node API repair.",
    ):
        assert contract in script
    assert re.search(r"\b(?:UPDATE|INSERT|DELETE)\b", script) is None


def test_repair_journals_before_swap_and_rolls_back_build_failures() -> None:
    script = REPAIR.read_text()
    build = script.index("compose_target build node-api")
    arm = script.rindex("ROLLBACK_ARMED=true", 0, build)
    rollback_tag = script.rindex(
        'docker image tag "$old_image_id" "$rollback_image_tag"',
        0,
        build,
    )
    prepared = script.index(
        'persist_receipt prepared "$old_image_id" "$new_image_id"'
    )
    swap = script.index("compose_target up -d --no-deps --force-recreate node-api")
    final_invariants = script.rindex("assert_runtime_invariants")
    applied = script.index(
        'persist_receipt applied "$old_image_id" "$new_image_id" "$node_after"'
    )
    assert rollback_tag < arm < build < prepared < swap < final_invariants < applied
    assert "mapfile -t receipt_fields < <(" not in script
    assert 'docker image tag "$rollback_old_image" "$node_image_ref"' in script
    assert "wait_node_health ||" in script


def test_workflow_requires_explicit_manual_repair_dispatch() -> None:
    workflow = WORKFLOW.read_text()
    assert "pending_cutover_node_api_repair:" in workflow
    assert "default: false" in workflow
    assert (
        "PENDING_CUTOVER_NODE_API_REPAIR: "
        "${{ github.event_name == 'workflow_dispatch' "
        "&& inputs.pending_cutover_node_api_repair || false }}"
    ) in workflow
    assert 'if [[ "$PENDING_CUTOVER_NODE_API_REPAIR" == "true" ]]' in workflow
    assert "EXPECTED_TARGET_SOURCE_REVISION=$REVISION_Q" in workflow
    assert "permissions:\n  contents: read" in workflow


def test_script_refuses_an_unbound_invocation_before_any_runtime_command() -> None:
    env = {**os.environ}
    env.pop("STAGING_DIR", None)
    env.pop("EXPECTED_TARGET_SOURCE_REVISION", None)
    completed = subprocess.run(
        [str(REPAIR)],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode != 0
    assert "STAGING_DIR is required" in completed.stderr
