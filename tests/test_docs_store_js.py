"""Runs the Node-based tests for the documents-store addition to
app/static/crypto.js (see tests/js/), mirroring test_notes_store_js.py's
pattern for the other browser-only, DOM-free pieces of that module. Skips
if `node` isn't on PATH.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

JS_TEST_DIR = Path(__file__).resolve().parent / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_docs_store_js_suite():
    result = subprocess.run(
        ["node", "--test", str(JS_TEST_DIR / "docs_store.test.mjs")],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, f"node --test failed:\n{result.stdout}\n{result.stderr}"
