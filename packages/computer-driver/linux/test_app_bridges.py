import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import office_bridge


class Enumeration:
    def __init__(self, documents):
        self.documents = iter(documents)
        self.next = next(self.documents, None)
    def hasMoreElements(self):
        return self.next is not None
    def nextElement(self):
        selected = self.next
        self.next = next(self.documents, None)
        return selected


def document(title, uid):
    return SimpleNamespace(Title=title, RuntimeUID=uid, getURL=lambda: "file:///" + title,
        supportsService=lambda service: service in ("com.sun.star.document.OfficeDocument", "com.sun.star.text.TextDocument"),
        Text=SimpleNamespace(String=f"unsaved text {uid}"), isModified=lambda: True)


class AppBridges(unittest.TestCase):
    def test_duplicate_titles_require_an_identity_and_default_uses_active_doc(self):
        first, second = document("same", "1"), document("same", "2")
        desktop = SimpleNamespace(Components=SimpleNamespace(createEnumeration=lambda: Enumeration([first, second])),
                                  getCurrentComponent=lambda: second)
        with patch.object(office_bridge, "_desktop", lambda _ctx: desktop), patch.object(office_bridge, "_context", lambda: object()):
            selected = office_bridge.perform({"op": "act", "act": {"kind": "read", "doc": "doc:2"}})
            self.assertTrue(selected["ok"])
            self.assertEqual(selected["text"], "unsaved text 2")
            ambiguous = office_bridge.perform({"op": "act", "act": {"kind": "read", "doc": "same"}})
            self.assertFalse(ambiguous["ok"])
            self.assertIn("ambiguous", ambiguous["error"])
            result = office_bridge.perform({"op": "act", "act": {"kind": "read"}})
            self.assertTrue(result["ok"])
            self.assertEqual(result["text"], "unsaved text 2")
            self.assertTrue(result["modified"])

    def test_read_queries_preserve_a_human_gesture_even_when_office_is_unavailable(self):
        held = [False]
        observed = []
        def perform(operation):
            if operation["tool"] == "inject_input":
                held[0] = True
                return {"ok": True}
            observed.append(held[0])
            return {"ok": operation["tool"] != "office"}
        runtime = SimpleNamespace(require_desktop_session=lambda: None,
            Atspi=SimpleNamespace(init=lambda: None), release_input=lambda: held.__setitem__(0, False),
            perform_operation=perform, CancelledError=InterruptedError)
        spec = importlib.util.spec_from_file_location("driver_for_gesture", Path(__file__).with_name("driver-host.py"))
        module = importlib.util.module_from_spec(spec)
        inputs = [{"tool": "inject_input"}, {"tool": "browser", "op": "tabs"},
                  {"tool": "office", "op": "act", "act": {"kind": "read"}}]
        with patch.dict("sys.modules", {"runtime": runtime}), patch("sys.stdin", io.StringIO("\n".join(json.dumps(op) for op in inputs))), patch("sys.stdout", io.StringIO()):
            spec.loader.exec_module(module)
            module.main()
        self.assertEqual(observed, [True, True])
        self.assertFalse(held[0])  # EOF owns cleanup.


if __name__ == "__main__":
    unittest.main()
