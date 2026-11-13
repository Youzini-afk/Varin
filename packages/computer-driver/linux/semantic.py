"""AT-SPI targets, scoped reads and state actions owned by the resident input helper.

Tokens retain the actual Accessible (whose native identity is its bus + object path),
not a child index or a name. The Host releases tokens when its observations retire.
No events are advertised: the owning Host schedules short reads on the input lane.
"""
import math
import uuid


class SemanticError(Exception):
    def __init__(self, code, message, effect="none"):
        super().__init__(message)
        self.code, self.effect = code, effect

    def response(self):
        return {"ok": False, "error": str(self), "code": self.code,
                "rejected": self.effect == "none", "cancelled": self.code == "cancelled", "complete": False,
                "receipt": {"effect": self.effect, "mechanism": "accessibility",
                            "reason": {"code": {"window_lost": "target-changed", "target_lost": "target-changed",
                                                "window_not_found": "target-unavailable", "unavailable": "target-unavailable"}.get(self.code, self.code), "message": str(self)},
                            "recovery": "observe"}}


ROLES = {
    "push button": "button", "push button menu": "button", "toggle button": "checkbox",
    "check box": "checkbox", "check menu item": "checkbox", "radio button": "radio",
    "radio menu item": "radio", "entry": "textbox", "password text": "textbox",
    "text": "text", "label": "text", "static": "text", "combo box": "combobox",
    "list item": "listitem", "list box": "list", "page tab": "tab", "page tab list": "tablist",
    "tree item": "treeitem", "tree table": "tree", "table cell": "cell",
    "table row": "row", "column header": "columnheader", "row header": "rowheader",
    "menu item": "menuitem", "menu bar": "menubar", "scroll bar": "scrollbar",
    "progress bar": "progressbar", "spin button": "spinbutton", "panel": "group",
    "section": "group", "scroll pane": "group", "filler": "group", "frame": "window",
    "document frame": "document", "document web": "document", "tool bar": "toolbar",
}
STATE_PROPERTIES = {"enabled", "selected", "checked", "expanded", "focused", "visible"}
DEFAULT_PROPERTIES = ["name", "role", "value", "enabled", "selected", "checked", "expanded", "actions"]


class AtspiTargets:
    def __init__(self, runtime):
        self.r = runtime
        self.windows = {}
        self.window_ids = {}
        self.elements = {}
        self.element_ids = {}

    def state(self, node):
        # Cache.NONE is process-local. It avoids reading stale state while the
        # synchronous protocol loop is not pumping AT-SPI's GLib event queue.
        # clear_cache() would recursively invalidate a whole native subtree.
        states = node.get_state_set()
        if states is None:
            raise SemanticError("unavailable", "AT-SPI did not expose the target state")
        return states

    def contains(self, states, name):
        value = getattr(self.r.Atspi.StateType, name, None)
        return value is not None and bool(states.contains(value))

    def live(self, node, code="target_lost"):
        try:
            states = self.state(node)
        except SemanticError:
            raise
        except Exception as error:
            raise SemanticError("unavailable", "The AT-SPI provider could not be read") from error
        if self.contains(states, "DEFUNCT"):
            raise SemanticError(code, "The original accessibility target no longer exists")
        return states

    def bind_window(self, app, window, index):
        # libatspi Accessible equality/hash retain native proxy identity. Keep a
        # strong reference, so an unrelated object cannot reuse a freed pointer.
        token = self.window_ids.get(window)
        if token is None:
            token = "atspi-window:" + str(uuid.uuid4())
            app.set_cache_mask(self.r.Atspi.Cache.NONE)
            self.windows[token] = {"app": app, "node": window, "pid": self.r.node_pid(app), "index": index}
            self.window_ids[window] = token
        return token

    def window(self, operation):
        token = operation.get("platform_target")
        record = operation.get("element") or operation.get("within")
        retained = self.elements.get(record.get("targetId")) if record else None
        if retained:
            if token and retained["window"] != token:
                raise SemanticError("target_lost", "The element belongs to a different original window")
            token = retained["window"]
        if token:
            bound = self.windows.get(token)
            if bound is None:
                raise SemanticError("target_lost", "The native observation has expired; observe again")
            app, window = bound["app"], bound["node"]
            self.live(app, "window_lost")
            self.live(window, "window_lost")
            # Only the app's top-level inventory, never the window subtree.
            try:
                current = [(i, app.get_child_at_index(i)) for i in range(app.get_child_count())]
            except Exception as error:
                raise SemanticError("unavailable", "The original window inventory could not be read") from error
            selected = next((i for i, child in current if child == window), None)
            if selected is None and any(child is None for _i, child in current):
                raise SemanticError("unavailable", "The original window inventory is incomplete")
            if selected is None or self.r.node_pid(app) != bound["pid"]:
                raise SemanticError("window_lost", "The original window has closed; observe again")
            return app, selected, window, token
        if record:
            raise SemanticError("target_lost", "The native element reference has expired; observe again")
        try:
            app = self.r.resolve_app(operation.get("app", ""))
            app.set_cache_mask(self.r.Atspi.Cache.NONE)
            index, window = self.r.select_window(app, operation.get("window"))
        except self.r.CancelledError:
            raise
        except Exception as error:
            if str(error).startswith(('appNotFound(', 'windowNotFound(', 'No top-level AT-SPI window')):
                raise SemanticError("window_not_found", "No matching accessibility window is currently exposed") from error
            raise SemanticError("unavailable", "The accessibility window inventory could not be read") from error
        return app, index, window, self.bind_window(app, window, index)

    def retain(self, node, window_token):
        key = (window_token, node)
        token = self.element_ids.get(key)
        if token is None:
            token = "atspi-element:" + str(uuid.uuid4())
            self.element_ids[key] = token
            self.elements[token] = {"node": node, "window": window_token}
        return token

    def release(self, records):
        for record in records:
            target = self.elements.pop(record.get("targetId"), None)
            if target:
                self.element_ids.pop((target["window"], target["node"]), None)

    def element(self, record, window, token):
        if not record:
            return None
        retained = self.elements.get(record.get("targetId"))
        if retained is None or retained["window"] != token:
            raise SemanticError("target_lost", "The native element reference has expired; observe again")
        node = retained["node"]
        self.live(node)
        current, seen = node, set()
        while current is not None and current not in seen:
            self.r.check_cancel("confirming the original element's window")
            if current == window:
                return node
            seen.add(current)
            try:
                current = current.get_parent()
            except Exception as error:
                raise SemanticError("unavailable", "The element's original window could not be confirmed") from error
        raise SemanticError("target_lost", "The element is no longer in its original window")

    def states(self, node, states=None):
        states = states if states is not None else self.state(node)
        has = lambda name: self.contains(states, name)
        role = self.r.node_role(node).lower()
        result = {"enabled": has("ENABLED"), "focused": has("FOCUSED"), "visible": has("SHOWING")}
        if has("SELECTABLE") or has("SELECTED"):
            result["selected"] = has("SELECTED")
        if has("CHECKABLE") or has("CHECKED") or role in {"check box", "check menu item", "radio button", "radio menu item", "toggle button"}:
            result["checked"] = "mixed" if has("INDETERMINATE") else has("CHECKED")
        if has("EXPANDABLE") or has("EXPANDED"):
            result["expanded"] = has("EXPANDED")
        return result

    def properties(self, node, names):
        values, unavailable = {}, []
        states = None
        for name in names:
            self.r.check_cancel("reading target properties")
            try:
                if name in STATE_PROPERTIES:
                    if states is None:
                        states = self.states(node)
                    if name not in states:
                        unavailable.append(name)
                    else:
                        values[name] = states[name]
                elif name == "name":
                    values[name] = node.get_name()
                elif name in ("role", "platformRole"):
                    role = node.get_role_name()
                    values[name] = ROLES.get(role.lower(), role.lower()) if name == "role" else role
                elif name == "actions":
                    values[name] = [node.get_action_name(i) for i in range(node.get_n_actions())]
                elif name == "value":
                    if self.r.protected_value(node):
                        unavailable.append(name)
                        continue
                    interfaces = node.get_interfaces()
                    if "Value" in interfaces:
                        values[name] = str(self.r.Atspi.Value.get_current_value(node.get_value_iface()))
                    elif "Text" in interfaces:
                        text = node.get_text_iface()
                        length = self.r.Atspi.Text.get_character_count(text)
                        # This is the short-value interface, not bulk document
                        # extraction. Never report a truncated value as exact.
                        # Longer text remains available through observation's
                        # explicit native text budget / application protocol.
                        if length > self.r.DEFAULT_TEXT_LIMIT:
                            unavailable.append(name)
                        else:
                            values[name] = self.r.Atspi.Text.get_text(text, 0, length)
                    else:
                        unavailable.append(name)
                else:
                    unavailable.append(name)
            except self.r.CancelledError:
                raise
            except Exception:
                unavailable.append(name)
        return values, unavailable

    def record(self, node, index, path, bounds, token, parent=None, depth=0, text_limit=500):
        record = self.r.record_for(node, index, path, bounds, text_limit)
        role = record["controlType"].lower()
        record.update({"targetId": self.retain(node, token), "role": ROLES.get(role, role),
                       "platformRole": record["controlType"], "depth": depth})
        if parent is not None:
            record["parentIndex"] = parent
        try:
            record.update(self.states(node))
        except Exception:
            pass  # Unknown is absent, never synthesized as false.
        return record

    def walk(self, root, max_nodes, max_depth, visit):
        """Depth-first, bounded native traversal; missing children mean incomplete."""
        visited = 0
        reasons = set()
        seen = set()
        def descend(node, path, depth, parent):
            nonlocal visited
            self.r.check_cancel("walked {} accessibility nodes".format(visited))
            if node is None:
                reasons.add("unavailable")
                return
            if visited >= max_nodes:
                reasons.add("node_limit")
                return
            if node in seen:
                reasons.add("unavailable")
                return
            seen.add(node)
            visited += 1
            try:
                count = node.get_child_count()
                if count < 0:
                    raise ValueError("Unknown child count")
            except Exception:
                count = None
                reasons.add("unavailable")
            record = visit(node, path, depth, parent)
            record_index = record["index"] if record is not None else parent
            if record is not None:
                if count is not None:
                    record["childCount"] = count
                record["hasMoreChildren"] = count is None
            for index in range(count or 0):
                if depth >= max_depth or visited >= max_nodes:
                    reasons.add("depth_limit" if depth >= max_depth else "node_limit")
                    if record is not None:
                        record["hasMoreChildren"] = True
                    break
                try:
                    child = node.get_child_at_index(index)
                except Exception:
                    child = None
                if child is None and record is not None:
                    record["hasMoreChildren"] = True
                descend(child, path + [index], depth + 1, record_index)
        descend(root, [], 0, None)
        return not reasons, ",".join(sorted(reasons)) or None

    def snapshot(self, operation, query=False, resolved=None):
        app, index, window, token = resolved or self.window(operation)
        root = self.element(operation.get("within"), window, token) or window
        bounds = self.r.extents(window)
        records, matched = [], 0
        offset = max(0, int(operation.get("offset") or 0)) if query else 0
        limit = self.r.positive_int(operation.get("limit"), self.r.MAX_ELEMENTS) if query else None
        match = operation.get("match") or {}
        text_limit = self.r.parse_text_limit(operation.get("text_limit"), self.r.DEFAULT_TEXT_LIMIT)
        unknown_match = False
        focus = {}
        labels = {}
        def visit(node, path, depth, parent):
            nonlocal matched, unknown_match
            parent_labels = labels.get(tuple(path[:-1]), []) if path else []
            name = self.r.node_name(node)
            labels[tuple(path)] = parent_labels + ([self.r.limit_text(name, text_limit)] if name else [])
            if query:
                names = [name for name in match if name != "nameMatch"]
                values, missing = self.properties(node, names)
                for name in names:
                    if name in missing:
                        continue
                    expected = match[name]
                    actual = values.get(name)
                    if name == "name" and match.get("nameMatch") == "contains":
                        if expected not in (actual or ""):
                            return None
                    elif actual != expected:
                        return None
                if missing:
                    unknown_match = True
                    return None
                matched += 1
                if matched <= offset or len(records) >= limit:
                    return None
            record = self.record(node, len(records), [index] + path, bounds, token,
                                 parent, depth, text_limit)
            if query and parent_labels:
                record["ancestorLabels"] = parent_labels
            if not query and record.get("focused"):
                focus["focusedSummary"] = (record["platformRole"] + " " + record["name"]).strip()
                if self.r.supports_interface(node, "Text") and not self.r.protected_value(node):
                    try:
                        text = node.get_text_iface()
                        if self.r.Atspi.Text.get_n_selections(text):
                            selection = self.r.Atspi.Text.get_selection(text, 0)
                            end = selection.end_offset if text_limit is None else min(selection.end_offset, selection.start_offset + text_limit)
                            focus["selectedText"] = self.r.Atspi.Text.get_text(text, selection.start_offset, end)
                    except Exception:
                        pass
            records.append(record)
            return record
        complete, reason = self.walk(root, self.r.positive_int(operation.get("max_tree_nodes"), self.r.MAX_ELEMENTS),
                                     self.r.positive_int(operation.get("max_tree_depth"), self.r.MAX_DEPTH), visit)
        if unknown_match:
            complete, reason = False, "unavailable_properties"
        # Query pages are fixed by the Host's published observation; no hidden
        # driver cursor mixes old and new UI. Native limit is an explicit partial read.
        more = query and matched > offset + len(records)
        if more:
            complete, reason = False, "result_limit"
        result = {"app": {"name": self.r.node_name(app), "bundleIdentifier": self.r.node_name(app), "pid": self.r.node_pid(app)},
                  "windowTitle": self.r.node_name(window), "windowHandle": index, "nativeTarget": token,
                  "windowBounds": bounds, "elements": records, "treeLines": self.lines(records),
                  "complete": complete, "scope": "exposed", **focus}
        if reason:
            result["truncatedReason"] = reason
        if operation.get("screenshot"):
            result["screenshotPngBase64"] = self.r.capture_window_png(bounds)
            result["screenshotSource"] = "screen"
        if not query:
            result["windows"] = self.r.window_descriptors(app, index)
        response = {"ok": True, "snapshot": result, "complete": complete}
        if more:
            response["nextOffset"] = offset + len(records)
        return response

    @staticmethod
    def lines(records):
        return ["\t" * (record.get("depth", 0) + 1) + "{} {} {}{}".format(
            record["index"], record["role"], record["name"],
            " Value: " + record["value"].replace("\n", "\\n") if record.get("value") and record["value"] != record["name"] else "")
            for record in records]

    def query(self, operation):
        if operation.get("window_only"):
            app, index, window, token = self.window(operation)
            return {"ok": True, "complete": True, "snapshot": {
                "app": {"name": self.r.node_name(app), "pid": self.r.node_pid(app)},
                "windowTitle": self.r.node_name(window), "windowHandle": index,
                "nativeTarget": token, "elements": [], "treeLines": [], "complete": True}}
        if operation.get("element"):
            _app, _index, window, token = self.window(operation)
            node = self.element(operation["element"], window, token)
            values, missing = self.properties(node, operation.get("properties") or DEFAULT_PROPERTIES)
            return {"ok": True, "properties": values, "unavailableProperties": missing, "complete": not missing}
        return self.snapshot(operation, query=True)

    def action_index(self, node, names, descriptions=False):
        for index in range(node.get_n_actions()):
            if node.get_action_name(index).lower() in names or (descriptions and node.get_action_description(index).lower() in names):
                return index
        return None

    def perform(self, node, operation):
        """One resolved target, no physical retry after any native dispatch."""
        if node is None:
            raise SemanticError("unsupported", "This semantic action requires an observed element")
        tool = operation["tool"]
        before = self.states(node)
        if before.get("enabled") is False:
            raise SemanticError("unsupported", "The target control is disabled")
        requested = {}
        calls = []
        if tool in ("set_checked", "set_expanded"):
            prop = "checked" if tool == "set_checked" else "expanded"
            wanted = operation.get(prop)
            if not isinstance(wanted, bool) or prop not in before:
                raise SemanticError("unsupported", "The control does not expose a readable boolean " + prop + " state")
            requested[prop] = wanted
            if before[prop] == wanted:
                return {"effect": "none", "mechanism": "accessibility", "observedState": requested}
            names = {"toggle", "click", "press", "activate"} if prop == "checked" else ({"expand", "open"} if wanted else {"collapse", "close"})
            if prop == "expanded":
                names |= {"expand or contract", "expand or collapse", "toggle expand", "toggle"}
            index = self.action_index(node, names)
            if index is None:
                raise SemanticError("unsupported", "The control does not expose an action for " + prop)
            calls.append(lambda: node.do_action(index))
        elif tool == "select":
            mode = operation.get("selection", "replace")
            if mode not in ("replace", "add", "remove"):
                raise SemanticError("unsupported", "Unknown selection mode")
            parent = node.get_parent()
            if parent is None or not self.r.supports_interface(parent, "Selection"):
                raise SemanticError("unsupported", "The parent does not expose AT-SPI Selection")
            selection = parent.get_selection_iface()
            index = node.get_index_in_parent()
            if index < 0 or parent.get_child_at_index(index) != node:
                raise SemanticError("target_lost", "The option moved during selection preflight")
            selected = bool(self.r.Atspi.Selection.is_child_selected(selection, index))
            requested["selected"] = mode != "remove"
            count = self.r.Atspi.Selection.get_n_selected_children(selection)
            if selected == requested["selected"] and (mode != "replace" or count == 1):
                return {"effect": "none", "mechanism": "accessibility", "observedState": requested}
            multi = self.contains(self.state(parent), "MULTISELECTABLE")
            if mode == "add" and not multi and count and not selected:
                raise SemanticError("unsupported", "Add selection would replace an existing single selection")
            if mode == "replace" and multi and count:
                calls.append(lambda: self.r.Atspi.Selection.clear_selection(selection))
            calls.append(lambda: self.r.Atspi.Selection.deselect_child(selection, index) if mode == "remove"
                         else self.r.Atspi.Selection.select_child(selection, index))
        elif tool == "scroll_into_view":
            component = node.get_component_iface()
            if component is None or not hasattr(self.r.Atspi.Component, "scroll_to"):
                raise SemanticError("unsupported", "The control does not expose AT-SPI scrolling")
            calls.append(lambda: self.r.Atspi.Component.scroll_to(component, self.r.Atspi.ScrollType.ANYWHERE))
        elif tool == "set_value":
            value = operation.get("value", "")
            if self.r.supports_interface(node, "EditableText"):
                calls.append(lambda: self.r.Atspi.EditableText.set_text_contents(node.get_editable_text_iface(), str(value)))
            elif self.r.supports_interface(node, "Value"):
                try:
                    value = float(value)
                    if not math.isfinite(value):
                        raise ValueError("Non-finite value")
                except (ValueError, TypeError) as error:
                    raise SemanticError("unsupported", "The control requires a numeric value") from error
                calls.append(lambda: self.r.Atspi.Value.set_current_value(node.get_value_iface(), value))
            else:
                raise SemanticError("unsupported", "The control does not expose a settable value")
            requested["value"] = str(value)
            current, missing = self.properties(node, ["value"])
            if not missing and current == requested:
                return {"effect": "none", "mechanism": "accessibility", "observedState": current}
        elif tool == "click":
            index = self.r.preferred_action_index(node)
            if index is None:
                raise SemanticError("unsupported", "The target exposes no primary accessibility action")
            calls.append(lambda: node.do_action(index))
        elif tool == "perform_secondary_action":
            index = self.action_index(node, {str(operation.get("action", "")).lower()}, descriptions=True)
            if index is None:
                raise SemanticError("unsupported", "The requested accessibility action is not exposed")
            calls.append(lambda: node.do_action(index))
        else:
            raise SemanticError("unsupported", "Unknown semantic action")
        dispatched = 0
        for call in calls:
            try:
                self.r.check_cancel("before semantic dispatch")
                accepted = call()
            except self.r.CancelledError:
                if dispatched:
                    raise SemanticError("cancelled", "Cancelled after a semantic action was sent", "partial")
                raise
            except Exception as error:
                raise SemanticError("unavailable", "AT-SPI did not confirm the semantic action; do not repeat it automatically", "partial" if dispatched else "unknown") from error
            if not accepted:
                raise SemanticError("unavailable", "AT-SPI did not confirm the semantic action; do not repeat it automatically", "partial" if dispatched else "unknown")
            dispatched += 1
        receipt = {"effect": "dispatched", "mechanism": "accessibility"}
        if requested:
            try:
                after, missing = self.properties(node, list(requested))
                receipt["observedState"] = after
                if not missing and after == requested:
                    # Replace selection additionally verifies the container, not
                    # merely that this child became selected while others remained.
                    if tool != "select" or operation.get("selection", "replace") != "replace" or self.r.Atspi.Selection.get_n_selected_children(selection) == 1:
                        receipt["effect"] = "verified"
            except self.r.CancelledError as error:
                raise SemanticError("cancelled", "Cancelled after the semantic action was sent", "dispatched") from error
            except Exception:
                pass  # Readback failure cannot erase dispatch or authorize a retry.
        return receipt
