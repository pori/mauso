"""Runs the Node-based tests for app/static/crypto.js (see tests/js/) as
part of the normal `pytest` invocation, so the PBKDF2 migration logic added
there stays covered by the one command the project's gate already runs.

crypto.js is browser-only Web Crypto + IndexedDB code with no Python
involved, and this repo has no JS test framework -- bootstrapping one
(package.json, jest/vitest, fake-indexeddb, etc.) just for this would be
its own large, unscoped change. Node 22+ ships a built-in test runner plus
global WebCrypto/btoa/atob, so tests/js/crypto_migration.test.mjs exercises
the real crypto.js against a small hand-written in-memory IndexedDB stand-in
(tests/js/fake_indexeddb.mjs) with zero new dependencies. If `node` isn't on
PATH (this project doesn't otherwise require it), this test skips rather
than failing the whole suite on hosts that only ever run the Python side.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

JS_TEST_DIR = Path(__file__).resolve().parent / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_crypto_js_migration_suite():
    result = subprocess.run(
        ["node", "--test", str(JS_TEST_DIR / "crypto_migration.test.mjs")],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, f"node --test failed:\n{result.stdout}\n{result.stderr}"
