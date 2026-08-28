#!/usr/bin/env python3
"""Dependency vulnerability gate: runs pip-audit against requirements.txt.

Local like the mutation gate (scripts/mutation_gate.py) rather than a hosted
SaaS scanning service -- pip-audit only sends package names/versions to the
PyPI/OSV vulnerability feeds to check for known CVEs, never this repo's
source.

Usage:
    python3 scripts/dependency_audit.py
"""
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    result = subprocess.run(
        [sys.executable, "-m", "pip_audit", "-r", "requirements.txt"],
        cwd=REPO_ROOT,
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
