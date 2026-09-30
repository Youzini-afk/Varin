"""Exercise the files actually published to the desktop account."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from desktop_components import publish


class DesktopPublication(unittest.TestCase):
    def test_bridges_import_from_published_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            component = publish(temp, Path(__file__).parent)
            result = subprocess.run([sys.executable, "-I", "-c",
                "import sys,json;sys.path.insert(0,sys.argv[1]);import browser_bridge,office_bridge;"
                "print(json.dumps([browser_bridge.perform({'op':'status'}),office_bridge.perform({'op':'status'})]))",
                str(component)], capture_output=True, text=True, check=True)
            replies = json.loads(result.stdout)
            self.assertTrue(all(reply["ok"] for reply in replies))
            self.assertEqual(component, publish(temp, Path(__file__).parent))


if __name__ == "__main__":
    unittest.main()
