"""Small stdlib client for the debug-only Tauri WebDriver automation plugin."""
import base64
import json
from http.client import RemoteDisconnected
import time
import urllib.request


class Driver:
    def __init__(self, port):
        self.base_url = f"http://127.0.0.1:{port}"

    def post(self, endpoint, payload):
        request = urllib.request.Request(
            f"{self.base_url}/{endpoint}", json.dumps(payload).encode(),
            {"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except RemoteDisconnected as error:
            raise RuntimeError("Debug driver disconnected. Restart Citadel Dev and use its new port; avoid HMR changes during checks.") from error

    def execute(self, script):
        result = self.post("script/execute", {"script": script})
        if "value" not in result:
            raise RuntimeError(result)
        return result["value"]

    def wait(self, script, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.execute(script)
            if result:
                return result
            time.sleep(0.1)
        raise AssertionError(f"Timed out: {script}")

    def capture(self, path):
        path.write_bytes(base64.b64decode(self.post("screenshot", {})["data"]))
