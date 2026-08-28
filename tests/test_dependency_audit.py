"""scripts/ isn't a package (no __init__.py, and mutmut's source_paths is
only "app" -- this script is a CI-gate wrapper, not app code), so it's
loaded by file path rather than a normal import."""
import importlib.util
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "dependency_audit.py"
spec = importlib.util.spec_from_file_location("dependency_audit", SCRIPT_PATH)
dependency_audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dependency_audit)


def test_runs_pip_audit_against_requirements_txt(monkeypatch):
    captured = {}

    class FakeResult:
        returncode = 0

    def fake_run(cmd, cwd):
        captured["cmd"] = cmd
        captured["cwd"] = cwd
        return FakeResult()

    monkeypatch.setattr(dependency_audit.subprocess, "run", fake_run)

    assert dependency_audit.main() == 0
    assert captured["cmd"] == [sys.executable, "-m", "pip_audit", "-r", "requirements.txt"]
    assert captured["cwd"] == dependency_audit.REPO_ROOT


def test_propagates_pip_audit_failure(monkeypatch):
    class FakeResult:
        returncode = 1

    monkeypatch.setattr(dependency_audit.subprocess, "run", lambda cmd, cwd: FakeResult())

    assert dependency_audit.main() == 1
