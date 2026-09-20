from copy import deepcopy
from pathlib import Path
import tomllib


def checks():
    declaration = tomllib.loads((Path(__file__).parents[1] / ".devcoordinator.toml").read_text())
    return {check["name"]: check for check in declaration["test"]["progressive"]["check"]}


def ancestors(graph, name, seen=None):
    seen = set() if seen is None else seen
    for parent in graph[name].get("requires", []):
        if parent not in seen:
            seen.add(parent)
            ancestors(graph, parent, seen)
    return seen


def missing_workspace(graph):
    return {name for name, check in graph.items() if name != "workspace"
            and ("pnpm" in check.get("command", []) or Path(check.get("command", [""])[0]).name == "node")
            and "workspace" not in ancestors(graph, name)}


def test_every_node_check_has_a_real_workspace_success_dependency():
    graph = checks()
    assert not missing_workspace(graph)
    assert graph["workspace"]["command"][-2:] == ["--frozen-lockfile", "--ignore-scripts"]
    assert "workspace" not in ancestors(graph, "dependencies")
    assert "workspace" not in ancestors(graph, "local-steady")


def test_missing_direct_and_inherited_prerequisites_are_detected():
    graph = deepcopy(checks())
    graph["types"].pop("requires", None)
    assert "types" in missing_workspace(graph)
    assert "local-step-client" in missing_workspace(graph)
    graph["allocation-contract"].pop("requires", None)
    assert "allocation-contract" in missing_workspace(graph)


def test_fresh_checkout_preflight_does_not_require_an_uncreated_virtualenv():
    for name, check in checks().items():
        command = check.get("command", [])
        assert not command or not command[0].startswith(".venv/"), name
        if command and "--no-sync" in command:
            assert "dependencies" in ancestors(checks(), name), name
