"""The JS tests in tests/js (node --test), run from pytest so one command runs both suites.

They check the page's store (static_store.js) against this store on shared fixtures, and that app.js counts the lines left to decide the same way everywhere. Node 18 or later is needed; the test is skipped when no node is found."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


def node():
    """node on PATH, else the newest one nvm installed."""
    found = shutil.which("node")
    if found:
        return found
    nvm = sorted(Path.home().glob(".nvm/versions/node/v*/bin/node"),
                 key=lambda p: [int(x) for x in p.parent.parent.name[1:].split(".") if x.isdigit()])
    return str(nvm[-1]) if nvm else None


def test_js_suite():
    exe = node()
    if not exe:
        pytest.skip("node is not installed")
    env = dict(os.environ, PYTHON=sys.executable)
    r = subprocess.run([exe, "--test", "tests/js"], cwd=REPO, env=env, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stdout[-6000:] + r.stderr[-3000:]
