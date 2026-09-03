"""Runs the Node-based tests for app/static/search.js (see tests/js/) as
part of the normal `pytest` invocation, mirroring test_crypto_js.py's
pattern for the other browser-only, DOM-free static module in this repo.

search.js is client-side conversation search with zero DOM/network/
IndexedDB dependencies of its own, so it's exercised directly with Node's
built-in test runner rather than reimplemented in Python. If `node` isn't on
PATH, this test skips rather than failing the whole suite.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

JS_TEST_DIR = Path(__file__).resolve().parent / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_search_js_suite():
    result = subprocess.run(
        ["node", "--test", str(JS_TEST_DIR / "search.test.mjs")],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, f"node --test failed:\n{result.stdout}\n{result.stderr}"
