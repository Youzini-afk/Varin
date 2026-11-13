"""Portable provider-double tests, not a native AT-SPI/desktop acceptance run."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

from semantic import AtspiTargets


STATES = "ACTIVE SHOWING ENABLED SENSITIVE CHECKED CHECKABLE INDETERMINATE EXPANDABLE EXPANDED SELECTABLE SELECTED MULTISELECTABLE FOCUSED DEFUNCT ICONIFIED".split()


class Node:
    def __init__(self, name, role="panel", children=(), states=None, actions=(), interfaces=()):
        self.name, self.role = name, role
        self.children = list(children)
        self.parent = None
        for child in self.children:
            child.parent = self
        self.states = set(states if states is not None else ["ENABLED", "SHOWING"])
        self.actions = list(actions)
        self.interfaces = list(interfaces)
        self.reads = []
        self.calls = []
        self.action_result = True
        self.state_error = False
        self.child_error = False
        self.value = ""
    def get_name(self):
        self.reads.append("name")
        return self.name
    def get_role_name(self):
        self.reads.append("role")
        return self.role
    def get_child_count(self):
        self.reads.append("children")
        if self.child_error:
            raise RuntimeError("provider unavailable")
        return len(self.children)
    def get_child_at_index(self, index):
        self.reads.append("child")
        return self.children[index]
    def get_parent(self):
        self.reads.append("parent")
        return self.parent
    def get_index_in_parent(self):
        return self.parent.children.index(self)
    def get_process_id(self):
        return 47
    def get_state_set(self):
        self.reads.append("state")
        if self.state_error:
            raise RuntimeError("provider unavailable")
        return SimpleNamespace(contains=lambda state: state in self.states)
    def get_interfaces(self):
        return self.interfaces
    def get_accessible_id(self):
        return "id-" + self.name
    def get_component_iface(self):
        return self
    def get_toolkit_name(self):
        return "test"
    def set_cache_mask(self, value):
        self.cache = value
    def get_n_actions(self):
        return len(self.actions)
    def get_action_name(self, index):
        return self.actions[index]
    def get_action_description(self, index):
        return self.actions[index]
    def do_action(self, index):
        self.calls.append(self.actions[index])
        if isinstance(self.action_result, Exception):
            raise self.action_result
        if self.action_result:
            name = self.actions[index]
            if name == "toggle":
                self.states.discard("INDETERMINATE")
                self.states.symmetric_difference_update({"CHECKED"})
            if name in ("expand", "collapse"):
                if name == "expand":
                    self.states.add("EXPANDED")
                else:
                    self.states.discard("EXPANDED")
        return self.action_result
    def get_text_iface(self):
        return self
    def get_editable_text_iface(self):
        return self
    def get_value_iface(self):
        return self if "Value" in self.interfaces else None
    def get_selection_iface(self):
        return self


def load_runtime():
    selection = SimpleNamespace(
        get_n_selected_children=lambda n: sum("SELECTED" in child.states for child in n.children),
        is_child_selected=lambda n, i: "SELECTED" in n.children[i].states,
        clear_selection=lambda n: clear(n),
        select_child=lambda n, i: select(n, i, True),
        deselect_child=lambda n, i: select(n, i, False))
    atspi = SimpleNamespace(StateType=SimpleNamespace(**{name: name for name in STATES}), Cache=SimpleNamespace(NONE=0),
        Component=SimpleNamespace(get_extents=lambda _n, _t: SimpleNamespace(x=1, y=2, width=100, height=80), scroll_to=lambda n, _t: n.calls.append("scroll") or True),
        CoordType=SimpleNamespace(SCREEN=0), ScrollType=SimpleNamespace(ANYWHERE=0), Selection=selection,
        Text=SimpleNamespace(get_character_count=lambda n: len(n.value), get_text=lambda n, a, b: read_text(n, a, b)),
        Value=SimpleNamespace(get_current_value=lambda n: n.value, set_current_value=lambda n, v: set_text(n, v)),
        EditableText=SimpleNamespace(set_text_contents=lambda n, v: set_text(n, v)))
    gi = SimpleNamespace(require_version=lambda *_: None)
    spec = importlib.util.spec_from_file_location("semantic_test_runtime", Path(__file__).with_name("runtime.py"))
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"gi": gi, "gi.repository": SimpleNamespace(Atspi=atspi, Gdk=None)}):
        spec.loader.exec_module(module)
    module.SEMANTIC_TARGETS = AtspiTargets(module)
    return module


def read_text(node, start, end):
    node.reads.append("text")
    return node.value[start:end]


def set_text(node, value):
    node.calls.append("set_value")
    node.value = value
    return True


def clear(node):
    node.calls.append("clear_selection")
    for child in node.children:
        child.states.discard("SELECTED")
    return True


def select(node, index, value):
    node.calls.append("select" if value else "remove")
    if value:
        if "MULTISELECTABLE" not in node.states:
            for child in node.children:
                child.states.discard("SELECTED")
        node.children[index].states.add("SELECTED")
    else:
        node.children[index].states.discard("SELECTED")
    return True


class SemanticTests(unittest.TestCase):
    def setUp(self):
        self.r = load_runtime()
        self.first = Node("Autosave", "check box", states=["ENABLED", "CHECKABLE"], actions=["toggle"])
        self.second = Node("Autosave", "check box", states=["ENABLED", "CHECKABLE"], actions=["toggle"])
        self.left = Node("Left", children=[self.first])
        self.right = Node("Right", children=[self.second])
        self.window = Node("Preferences", "frame", [self.left, self.right])
        self.app = Node("Test", "application", [self.window])
        self.r.resolve_app = lambda _: self.app
        self.r.capture_window_png = lambda _: None
        self.snap = self.r.perform_operation({"tool": "get_app_state", "app": "Test", "screenshot": False})["snapshot"]
        self.records = {node["name"]: node for node in self.snap["elements"]}
        self.first_record = self.snap["elements"][2]
        self.second_record = self.snap["elements"][4]
        self.token = self.snap["nativeTarget"]
        for node in [self.first, self.second, self.left, self.right, self.window, self.app]:
            node.reads.clear()
    def run_op(self, tool, **params):
        return self.r.perform_operation({"tool": tool, "app": "Test", "platform_target": self.token, **params})
    def test_property_read_is_targeted_and_preserves_unknown_and_mixed(self):
        self.first.states.add("INDETERMINATE")
        result = self.run_op("query_elements", element=self.first_record, properties=["checked", "expanded"])
        self.assertEqual(result["properties"], {"checked": "mixed"})
        self.assertEqual(result["unavailableProperties"], ["expanded"])
        self.assertNotIn("children", self.window.reads)
        self.assertEqual(self.second.reads, [])
        self.assertNotIn("text", self.first.reads)
    def test_password_value_is_never_read_or_matched(self):
        self.first.role = "password text"
        self.first.interfaces = ["Text", "EditableText"]
        self.first.value = "secret-password"
        result = self.run_op("query_elements", element=self.first_record, properties=["value", "enabled", "role"])
        self.assertEqual(result["unavailableProperties"], ["value"])
        self.assertEqual(result["properties"], {"enabled": True, "role": "textbox"})
        self.assertNotIn("text", self.first.reads)
        result = self.run_op("get_app_state", within=self.records["Left"], screenshot=False)
        self.assertEqual(result["snapshot"]["elements"][1]["value"], "")
        result = self.run_op("query_elements", within=self.records["Left"], match={"role": "textbox", "value": "secret-password"})
        self.assertFalse(result["complete"])
        self.assertEqual(result["snapshot"]["elements"], [])
        self.assertNotIn("text", self.first.reads)
    def test_short_value_does_not_extract_a_whole_document(self):
        self.first.interfaces = ["Text"]
        self.first.value = "x" * (self.r.DEFAULT_TEXT_LIMIT + 1)
        result = self.run_op("query_elements", element=self.first_record, properties=["value"])
        self.assertEqual(result["unavailableProperties"], ["value"])
        self.assertNotIn("text", self.first.reads)
    def test_subtree_reuses_identity_and_does_not_read_neighbor(self):
        result = self.run_op("get_app_state", within=self.records["Left"], screenshot=False)
        elements = result["snapshot"]["elements"]
        self.assertEqual([e["name"] for e in elements], ["Left", "Autosave"])
        self.assertEqual(elements[1]["targetId"], self.first_record["targetId"])
        self.assertEqual(elements[1]["parentIndex"], 0)
        self.assertEqual(self.second.reads, [])
        result = self.run_op("query_elements", element=self.second_record, properties=["checked"])
        self.assertEqual(result["properties"], {"checked": False})
    def test_query_scoped_match_does_not_choose_first_duplicate(self):
        result = self.run_op("query_elements", match={"role": "checkbox", "name": "Autosave", "checked": False})
        self.assertEqual(len(result["snapshot"]["elements"]), 2)
        self.assertEqual([e["ancestorLabels"] for e in result["snapshot"]["elements"]],
                         [["Preferences", "Left"], ["Preferences", "Right"]])
        self.assertTrue(result["complete"])
        result = self.run_op("query_elements", within=self.records["Left"], match={"role": "checkbox", "name": "Autosave"})
        self.assertEqual([r["targetId"] for r in result["snapshot"]["elements"]], [self.first_record["targetId"]])
    def test_bounds_and_child_reordering_are_not_semantic_identity(self):
        self.window.children.reverse()
        self.first.name = "Renamed"
        result = self.run_op("set_checked", element=self.first_record, checked=True,
                             expected_bounds={"x": 999, "y": 999, "width": 99, "height": 99})
        self.assertEqual(result["receipt"]["effect"], "verified")
        self.assertIn("CHECKED", self.first.states)
        self.assertNotIn("CHECKED", self.second.states)
    def test_replacement_at_identical_path_and_name_is_rejected(self):
        self.left.children[0] = Node("Autosave", "check box", actions=["toggle"])
        self.left.children[0].parent = self.left
        self.first.parent = None
        result = self.run_op("set_checked", element=self.first_record, checked=True)
        self.assertEqual(result["code"], "target_lost")
        self.assertEqual(self.left.children[0].calls, [])
    def test_same_title_reopened_window_is_not_original_window(self):
        replacement = Node("Preferences", "frame", [Node("Autosave", "check box", actions=["toggle"])])
        replacement.parent = self.app
        self.app.children[:] = [replacement]
        result = self.run_op("query_elements", element=self.first_record, properties=["checked"])
        self.assertEqual(result["code"], "window_lost")
    def test_closed_provider_is_not_reported_as_absence(self):
        self.window.state_error = True
        result = self.run_op("query_elements", match={"name": "Missing"})
        self.assertEqual(result["code"], "unavailable")
    def test_native_traversal_budget_is_honest(self):
        result = self.run_op("query_elements", max_tree_nodes=2, match={"name": "Missing"})
        self.assertFalse(result["complete"])
        self.assertIn("node_limit", result["snapshot"]["truncatedReason"])
        self.assertEqual(self.right.reads, [])
        result = self.run_op("get_app_state", max_tree_nodes=2, screenshot=False)
        self.assertTrue(result["snapshot"]["elements"][1]["hasMoreChildren"])
    def test_failed_child_read_cannot_prove_absence(self):
        self.left.child_error = True
        result = self.run_op("query_elements", within=self.records["Left"], match={"name": "Missing"})
        self.assertFalse(result["complete"])
    def test_window_only_has_no_tree_read(self):
        result = self.run_op("query_elements", window_only=True)
        self.assertTrue(result["ok"])
        self.assertEqual(result["snapshot"]["nativeTarget"], self.token)
        self.assertNotIn("children", self.window.reads)
        self.assertEqual(self.left.reads, [])
    def test_truncated_query_cannot_claim_only_match(self):
        result = self.run_op("query_elements", match={"role": "checkbox"}, limit=1)
        self.assertFalse(result["complete"])
        self.assertEqual(result["nextOffset"], 1)
        self.assertEqual(len(result["snapshot"]["elements"]), 1)
    def test_cancellation_during_read_does_not_dispatch_input(self):
        self.r.check_cancel = lambda _message="": (_ for _ in ()).throw(self.r.CancelledError("stop"))
        with self.assertRaises(self.r.CancelledError):
            self.run_op("query_elements", element=self.first_record, properties=["checked"])
        self.assertEqual(self.first.calls, [])
    def test_failed_value_readback_keeps_dispatch_evidence(self):
        self.first.interfaces = ["Text", "EditableText"]
        def mutate(node, value):
            node.value = value
            node.state_error = True
            self.r.Atspi.Text.get_text = lambda *_: (_ for _ in ()).throw(RuntimeError("lost readback"))
            return True
        self.r.Atspi.EditableText.set_text_contents = mutate
        result = self.run_op("set_value", element=self.first_record, value="new")
        self.assertEqual(result["receipt"]["effect"], "dispatched")
        self.assertEqual(self.first.value, "new")
    def test_target_state_repeat_does_not_toggle(self):
        first = self.run_op("set_checked", element=self.first_record, checked=True)
        second = self.run_op("set_checked", element=self.first_record, checked=True)
        self.assertEqual(first["receipt"]["effect"], "verified")
        self.assertEqual(second["receipt"]["effect"], "none")
        self.assertEqual(self.first.calls, ["toggle"])
    def test_auto_click_prefers_native_and_never_retries_after_unknown(self):
        self.r.send_mouse_click = lambda *_: self.fail("must not physically retry")
        self.first.action_result = RuntimeError("lost reply")
        result = self.run_op("click", element=self.first_record, click_method="auto")
        self.assertEqual(result["receipt"]["effect"], "unknown")
        self.assertEqual(self.first.calls, ["toggle"])
    def test_auto_click_without_action_uses_original_physical_path(self):
        self.first.actions = []
        clicks = []
        self.r.focus_window = lambda _: None
        self.r.send_mouse_click = lambda *args: clicks.append(args)
        result = self.run_op("click", element=self.first_record, click_method="auto")
        self.assertTrue(result["ok"])
        self.assertEqual(len(clicks), 1)
    def test_expansion_is_idempotent(self):
        self.left.states.add("EXPANDABLE")
        self.left.actions = ["expand", "collapse"]
        first = self.run_op("set_expanded", element=self.records["Left"], expanded=True)
        second = self.run_op("set_expanded", element=self.records["Left"], expanded=True)
        self.assertEqual(first["receipt"]["observedState"], {"expanded": True})
        self.assertEqual(second["receipt"]["effect"], "none")
        self.assertEqual(self.left.calls, ["expand"])
    def test_value_replacement_and_scroll_are_native(self):
        self.first.interfaces = ["Text", "EditableText"]
        self.first.value = "old"
        result = self.run_op("set_value", element=self.first_record, value="new")
        self.assertEqual(result["receipt"]["effect"], "verified")
        self.assertEqual(self.first.value, "new")
        result = self.run_op("scroll_into_view", element=self.first_record)
        self.assertEqual(result["receipt"]["effect"], "dispatched")
        self.assertEqual(self.first.calls, ["set_value", "scroll"])
    def test_multi_selection_replace_add_and_remove_have_distinct_effects(self):
        self.window.interfaces = ["Selection"]
        self.window.states.add("MULTISELECTABLE")
        self.left.states.update(["SELECTABLE", "SELECTED"])
        self.right.states.update(["SELECTABLE", "SELECTED"])
        result = self.run_op("select", element=self.records["Left"], selection="replace")
        self.assertEqual(result["receipt"]["effect"], "verified")
        self.assertIn("SELECTED", self.left.states)
        self.assertNotIn("SELECTED", self.right.states)
        result = self.run_op("select", element=self.records["Right"], selection="add")
        self.assertEqual(result["receipt"]["effect"], "verified")
        self.assertIn("SELECTED", self.left.states)
        result = self.run_op("select", element=self.records["Left"], selection="remove")
        self.assertEqual(result["receipt"]["observedState"], {"selected": False})
        self.assertIn("SELECTED", self.right.states)
    def test_release_drops_only_requested_element(self):
        self.run_op("release_elements", elements=[self.first_record])
        result = self.run_op("query_elements", element=self.first_record, properties=["name"])
        self.assertEqual(result["code"], "target_lost")
        result = self.run_op("query_elements", element=self.second_record, properties=["name"])
        self.assertTrue(result["ok"])
        self.assertTrue(self.run_op("query_elements", window_only=True)["ok"])
    def test_wayland_semantics_never_requests_portal_authorization(self):
        import wayland_runtime
        with patch.object(wayland_runtime, "owner", side_effect=AssertionError("no portal acquisition")):
            for tool in ["query_elements", "set_checked", "set_expanded", "select", "scroll_into_view"]:
                result = wayland_runtime.perform_operation({"tool": tool})
                self.assertEqual(result["code"], "unsupported")


if __name__ == "__main__":
    unittest.main()
