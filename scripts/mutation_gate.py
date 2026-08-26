#!/usr/bin/env python3
"""Mutation-testing gate for a task's diff (see the nightly-agent-lifecycle
design: "a task's new/changed test must survive mutation on the lines it
touched, not just pass").

Runs pytest, then mutmut (scoped to lines the test suite actually covers --
see pyproject.toml's mutate_only_covered_lines), then fails only if a mutant
survived inside a file *this diff touched*. Pre-existing gaps in code the
task didn't touch don't block it -- that's a separate, larger backlog, not
this task's problem.

Usage:
    python3 scripts/mutation_gate.py [--base-ref REF] [--full]

--base-ref: what to diff against for "this task's changes" (default: main).
--full: ignore the diff filter and fail on ANY surviving mutant across the
whole app/ tree -- for a periodic audit, not for gating one task.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MUTANT_RE = re.compile(r"^\s*(?P<name>(?P<module>[\w.]+)\.x_\w+__mutmut_\d+):\s*(?P<status>\S+)")


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    print(f"$ {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=REPO_ROOT)


def changed_app_files(base_ref: str) -> set[str]:
    """Union of: committed diff vs base_ref, uncommitted changes, and staged
    changes -- so this is useful both in CI (comparing a branch to main) and
    locally (before anything's even committed)."""
    files: set[str] = set()
    for cmd in (
        ["git", "diff", "--name-only", f"{base_ref}...HEAD", "--", "app/*.py"],
        ["git", "diff", "--name-only", "--", "app/*.py"],
        ["git", "diff", "--cached", "--name-only", "--", "app/*.py"],
    ):
        result = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)
        if result.returncode == 0:
            files.update(f for f in result.stdout.splitlines() if f)
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-ref", default="main")
    parser.add_argument("--full", action="store_true", help="check the whole app/ tree, not just this diff")
    args = parser.parse_args()

    if run([sys.executable, "-m", "pytest", "-q"]).returncode != 0:
        print("\nGate FAILED: pytest did not pass.")
        return 1

    run([sys.executable, "-m", "mutmut", "run"])

    results = subprocess.run(
        [sys.executable, "-m", "mutmut", "results"], cwd=REPO_ROOT, capture_output=True, text=True,
    )
    print(results.stdout)

    survivors = []
    for line in results.stdout.splitlines():
        m = MUTANT_RE.match(line)
        if m and m.group("status") == "survived":
            module_path = m.group("module").replace(".", "/") + ".py"
            survivors.append((m.group("name"), module_path))

    if not args.full:
        changed = changed_app_files(args.base_ref)
        survivors = [(name, path) for name, path in survivors if path in changed]

    if survivors:
        print(f"Gate FAILED: {len(survivors)} mutant(s) survived in files this diff touched:")
        for name, path in survivors:
            print(f"  {name}  ({path})")
        print("Run `mutmut show <name>` to see the diff, then strengthen the test that should have caught it.")
        return 1

    print("Gate passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
