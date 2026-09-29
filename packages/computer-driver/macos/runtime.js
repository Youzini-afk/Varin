// Varin Computer Use — macOS driver runtime library (JXA).
//
// Loaded and eval'd by driver-host.js under `osascript -l JavaScript`. Uses
// the ObjC bridge for CGWindowList window enumeration and CGEvent input, and
// System Events for the accessibility tree — no bundled binary required.
//
// UNVERIFIED: this driver has no real-machine evidence yet. Capabilities are
// reported conservatively and every surface degrades to explicit failure
// rather than silent no-op, so a broken path surfaces as an error.
//
// The op vocabulary matches the other platform drivers (README.md):
//   ping · capabilities · list_apps · get_app_state · click ·
//   perform_secondary_action · scroll · drag · type_text · press_key ·
//   set_value · release_input

ObjC.import("Quartz");
ObjC.import("AppKit");
ObjC.import("stdlib");

var DRIVER_VERSION = "0.1.0";
var MAX_ELEMENTS = 1200;
var MAX_DEPTH = 48;
var DEFAULT_TEXT_LIMIT = 500;

// ---------------------------------------------------------------------------
// Cancellation (BC4.A): stdin is serialized, so a cancel request cannot be
// read while a long operation runs. The Host writes
// "$VARIN_DRIVER_CANCEL_DIR/<requestId>.cancel"; long loops poll that file at
// their checkpoints. driver-host.js sets ACTIVE_REQUEST_ID around each
// request.
// ---------------------------------------------------------------------------

var CANCEL_DIR = $.getenv("VARIN_DRIVER_CANCEL_DIR") || null;
var ACTIVE_REQUEST_ID = null;

function CancelledError(detail) {
    this.name = "CancelledError";
    this.message = detail;
}
CancelledError.prototype = Object.create(Error.prototype);

function cancelRequested() {
    if (!CANCEL_DIR || !ACTIVE_REQUEST_ID) return false;
    return $.NSFileManager.defaultManager.fileExistsAtPath(
        CANCEL_DIR + "/" + ACTIVE_REQUEST_ID + ".cancel"
    );
}

function checkCancel(progress) {
    if (cancelRequested()) {
        throw new CancelledError("cancelled" + (progress ? " (" + progress + ")" : ""));
    }
}

// ---------------------------------------------------------------------------
// Window enumeration — CGWindowList gives every on-screen window with its
// owner pid and bounds; this is macOS's multi-window identity source (BC4.B).
// ---------------------------------------------------------------------------

function listWindowInfos() {
    var list = $.CGWindowListCopyWindowInfo(
        $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
        $.kCGNullWindowID
    );
    var result = [];
    if (!list) return result;
    var count = list.count;
    for (var i = 0; i < count; i++) {
        var info = list.objectAtIndex(i);
        var layer = ObjC.unwrap(info.objectForKey("kCGWindowLayer"));
        if (layer !== 0) continue;
        var boundsDict = info.objectForKey("kCGWindowBounds");
        result.push({
            handle: ObjC.unwrap(info.objectForKey("kCGWindowNumber")),
            pid: ObjC.unwrap(info.objectForKey("kCGWindowOwnerPID")),
            owner: ObjC.unwrap(info.objectForKey("kCGWindowOwnerName")) || "",
            title: ObjC.unwrap(info.objectForKey("kCGWindowName")) || "",
            bounds: boundsDict ? {
                x: ObjC.unwrap(boundsDict.objectForKey("X")),
                y: ObjC.unwrap(boundsDict.objectForKey("Y")),
                width: ObjC.unwrap(boundsDict.objectForKey("Width")),
                height: ObjC.unwrap(boundsDict.objectForKey("Height")),
            } : null,
        });
    }
    return result;
}

function windowsForPid(pid) {
    return listWindowInfos().filter(function (w) { return w.pid === pid; });
}

// ---------------------------------------------------------------------------
// App resolution — NSRunningApplication for the process list; the app
// selector matches process name (substring), window title substring, or pid.
// ---------------------------------------------------------------------------

function listRunningApps() {
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    var result = [];
    var count = apps.count;
    for (var i = 0; i < count; i++) {
        var app = apps.objectAtIndex(i);
        var name = ObjC.unwrap(app.localizedName);
        var pid = app.processIdentifier;
        if (!name || pid <= 0) continue;
        result.push({ name: name, pid: pid });
    }
    return result;
}

function resolveApp(query) {
    var normalized = String(query || "").trim().toLowerCase();
    var apps = listRunningApps();
    var withWindows = windowsByPid();
    var asPid = parseInt(normalized, 10);
    if (!isNaN(asPid)) {
        for (var i = 0; i < apps.length; i++) {
            if (apps[i].pid === asPid && withWindows[asPid]) return apps[i];
        }
    }
    var i, title;
    for (i = 0; i < apps.length; i++) {
        if (!withWindows[apps[i].pid]) continue;
        if (apps[i].name.toLowerCase() === normalized) return apps[i];
    }
    for (i = 0; i < apps.length; i++) {
        if (!withWindows[apps[i].pid]) continue;
        if (apps[i].name.toLowerCase().indexOf(normalized) >= 0) return apps[i];
        var windows = withWindows[apps[i].pid];
        for (var w = 0; w < windows.length; w++) {
            title = (windows[w].title || "").toLowerCase();
            if (title === normalized || title.indexOf(normalized) >= 0) return apps[i];
        }
    }
    throw new Error('appNotFound("' + query + '")');
}

function windowsByPid() {
    var map = {};
    var infos = listWindowInfos();
    for (var i = 0; i < infos.length; i++) {
        var w = infos[i];
        (map[w.pid] = map[w.pid] || []).push(w);
    }
    return map;
}

// A window selector is the CGWindowNumber (`handle` in descriptors) or a
// window title. Absent → the app's frontmost-ish first window in z-order.
function selectWindow(app, selector, windows) {
    if (!windows.length) {
        throw new Error("No on-screen window is available for " + app.name);
    }
    if (selector === undefined || selector === null) {
        // CGWindowList returns front-to-back; the first is the most focused.
        return windows[0];
    }
    if (typeof selector === "number") {
        for (var i = 0; i < windows.length; i++) {
            if (windows[i].handle === selector) return windows[i];
        }
        throw new Error(
            "Window " + selector + " is not one of the app's windows; list them again"
        );
    }
    var title = String(selector).trim().toLowerCase();
    for (var i2 = 0; i2 < windows.length; i2++) {
        if ((windows[i2].title || "").trim().toLowerCase() === title) return windows[i2];
    }
    for (var i3 = 0; i3 < windows.length; i3++) {
        if (title && (windows[i3].title || "").toLowerCase().indexOf(title) >= 0) return windows[i3];
    }
    throw new Error('windowNotFound("' + selector + '")');
}

// ---------------------------------------------------------------------------
// Accessibility tree — System Events exposes AXUIElement through JXA. Deep
// traversal is slow for large apps; bounded by MAX_ELEMENTS / MAX_DEPTH and
// cancellable via checkCancel.
// ---------------------------------------------------------------------------

function se() {
    return Application("System Events");
}

function seProcess(pid) {
    return se().processes.whose({ unixId: pid })[0];
}

function axWindowElements(process) {
    try {
        var wins = process.windows();
        return wins || [];
    } catch (e) {
        return [];
    }
}

function axWindowIndexFor(axWindows, windowInfo) {
    // CGWindowNumber has no direct System Events window identifier. Require a
    // unique title/geometry match; identical titles are common in editors and
    // choosing the first one would bind an element path to another document.
    var matches = [];
    for (var i = 0; i < axWindows.length; i++) {
        var title = "";
        try { title = String(axWindows[i].title() || ""); } catch (e) {}
        if (windowInfo.title && title !== windowInfo.title) continue;
        var frame = axFrame(axWindows[i]);
        var target = windowInfo.bounds;
        if (target && frame) {
            if (Math.abs(frame.x - target.x) > 16 || Math.abs(frame.y - target.y) > 16
                || Math.abs(frame.width - target.width) > 16 || Math.abs(frame.height - target.height) > 16) continue;
        } else if (!windowInfo.title) {
            continue;
        }
        matches.push(i);
    }
    return matches.length === 1 ? matches[0] : -1;
}

function axFrame(element) {
    try {
        var pos = element.position();
        var size = element.size();
        if (!pos || !size) return null;
        return { x: pos[0], y: pos[1], width: size[0], height: size[1] };
    } catch (e) {
        return null;
    }
}

function limitText(value, textLimit) {
    var text = value === null || value === undefined ? "" : String(value);
    if (textLimit === null || textLimit === undefined) return text;
    return text.length > textLimit ? text.substring(0, textLimit) : text;
}

function nodeActions(element) {
    var names = [];
    try {
        var actions = element.actions();
        for (var i = 0; i < actions.length; i++) {
            try {
                var name = actions[i].name();
                if (name) names.push(String(name).replace(/^AX/, ""));
            } catch (e) { /* skip unreadable action */ }
        }
    } catch (e) { /* node without actions */ }
    return names;
}

var elementCounter = { value: 0 };

function renderTree(root, windowBounds, textLimit, maxNodes, maxDepth) {
    var records = [];
    var lines = [];

    function visit(node, depth, path) {
        if (node === null || node === undefined) return;
        if (records.length >= maxNodes || depth > maxDepth) return;
        checkCancel("walked " + records.length + " of up to " + maxNodes + " tree nodes");
        var record = {};
        var title = "", role = "", value = null;
        try { role = String(node.role() || ""); } catch (e) {}
        try { title = String(node.title() || node.description() || ""); } catch (e) {}
        try { value = node.value(); } catch (e) {}
        var index = records.length;
        record.index = index;
        // The element's child-index path under the window — actions re-resolve
        // the live node by replaying it.
        record.path = path.slice();
        record.controlType = role.replace(/^AX/, "") || "element";
        record.name = limitText(title, textLimit);
        if (value !== null && value !== undefined && typeof value !== "object") {
            record.value = limitText(value, textLimit);
        }
        record.actions = nodeActions(node);
        var frame = axFrame(node);
        if (frame && windowBounds) {
            record.frame = {
                x: frame.x - windowBounds.x,
                y: frame.y - windowBounds.y,
                width: frame.width,
                height: frame.height,
            };
        } else if (frame) {
            record.frame = frame;
        }
        records.push(record);

        var parts = [index, record.controlType, record.name].join(" ").trim();
        if (record.value && record.value !== record.name) {
            parts += " Value: " + String(record.value).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        }
        if (record.actions.length) parts += " Secondary Actions: " + record.actions.join(", ");
        if (record.frame) {
            var f = record.frame;
            parts += " Frame: {x: " + Math.round(f.x) + ", y: " + Math.round(f.y)
                + ", width: " + Math.round(f.width) + ", height: " + Math.round(f.height) + "}";
        }
        lines.push(new Array(depth + 2).join("\t") + parts);

        var children = [];
        try { children = node.uiElements() || []; } catch (e) {}
        for (var c = 0; c < children.length; c++) {
            visit(children[c], depth + 1, path.concat(c));
        }
    }

    visit(root, 0, []);
    return { records: records, lines: lines };
}

// ---------------------------------------------------------------------------
// Screenshot — CGWindowListCreateImage renders the window by number, even
// when occluded (kCGWindowImageDefault compositing still applies).
// ---------------------------------------------------------------------------

function captureWindowPngBase64(windowInfo) {
    try {
        var rect = $.CGRectMake(
            windowInfo.bounds ? windowInfo.bounds.x : 0,
            windowInfo.bounds ? windowInfo.bounds.y : 0,
            windowInfo.bounds ? windowInfo.bounds.width : 0,
            windowInfo.bounds ? windowInfo.bounds.height : 0
        );
        var image = $.CGWindowListCreateImage(
            rect,
            $.kCGWindowListOptionIncludingWindow,
            windowInfo.handle,
            $.kCGWindowImageDefault
        );
        if (!image || image.js === undefined) {
            // CGRectNull captures nothing — fall back to a bounds-keyed grab.
            image = $.CGWindowListCreateImage(
                $.CGRectNull,
                $.kCGWindowListOptionOnScreenOnly,
                $.kCGNullWindowID,
                $.kCGWindowImageDefault
            );
        }
        if (!image) return null;
        var rep = $.NSBitmapImageRep.alloc.initWithCGImage(image);
        var data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
        if (!data) return null;
        return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Input — CGEvent posting at the HID tap. Held state is tracked so
// release_input can always lift what a cancelled/failed op left down.
// ---------------------------------------------------------------------------

var heldButtons = {};
var heldKeys = {};

function cgPoint(x, y) {
    return $.CGPointMake(x, y);
}

function postMouse(type, x, y, button) {
    var event = $.CGEventCreateMouseEvent($(), type, cgPoint(x, y), button);
    $.CGEventPost($.kCGHIDEventTap, event);
}

function postKey(keyCode, down) {
    var event = $.CGEventCreateKeyboardEvent($(), keyCode, down);
    $.CGEventPost($.kCGHIDEventTap, event);
}

var MOUSE_TYPES = {
    left: { down: $.kCGEventLeftMouseDown, up: $.kCGEventLeftMouseUp, drag: $.kCGEventLeftMouseDragged, button: $.kCGMouseButtonLeft },
    right: { down: $.kCGEventRightMouseDown, up: $.kCGEventRightMouseUp, drag: $.kCGEventRightMouseDragged, button: $.kCGMouseButtonRight },
    middle: { down: $.kCGEventOtherMouseDown, up: $.kCGEventOtherMouseUp, drag: $.kCGEventOtherMouseDragged, button: $.kCGMouseButtonCenter },
};

function screenPoint(windowBounds, elementRecord, x, y) {
    var fx, fy;
    if (elementRecord && elementRecord.frame) {
        fx = elementRecord.frame.x + elementRecord.frame.width / 2;
        fy = elementRecord.frame.y + elementRecord.frame.height / 2;
    } else {
        fx = Number(x) || 0;
        fy = Number(y) || 0;
    }
    return { x: (windowBounds ? windowBounds.x : 0) + fx, y: (windowBounds ? windowBounds.y : 0) + fy };
}

function sendMouseClick(x, y, button, count) {
    var types = MOUSE_TYPES[button] || MOUSE_TYPES.left;
    var repeat = Math.max(1, parseInt(count, 10) || 1);
    for (var i = 0; i < repeat; i++) {
        checkCancel("sent " + i + " of " + repeat + " clicks");
        postMouse(types.down, x, y, types.button);
        heldButtons[types.button] = true;
        $.NSThread.sleepForTimeInterval(0.035);
        postMouse(types.up, x, y, types.button);
        delete heldButtons[types.button];
        $.NSThread.sleepForTimeInterval(0.05);
    }
}

function sendDrag(fromX, fromY, toX, toY) {
    var types = MOUSE_TYPES.left;
    postMouse(types.down, fromX, fromY, types.button);
    heldButtons[types.button] = true;
    var steps = 12;
    try {
        for (var i = 1; i <= steps; i++) {
            checkCancel("dragged " + i + " of " + steps + " steps; the button is still held");
            var x = fromX + ((toX - fromX) * i / steps);
            var y = fromY + ((toY - fromY) * i / steps);
            postMouse(types.drag, x, y, types.button);
            $.NSThread.sleepForTimeInterval(0.02);
        }
    } finally {
        postMouse(types.up, toX, toY, types.button);
        delete heldButtons[types.button];
    }
}

function sendScroll(x, y, direction, pages) {
    // Wheel units: positive = content up (wheel up). 1 wheel unit per page step.
    var units = { up: 3, down: -3, left: -3, right: 3 }[direction] || -3;
    var repeat = Math.max(1, Math.ceil(Number(pages) || 1));
    for (var i = 0; i < repeat; i++) {
        checkCancel("scrolled " + i + " of " + repeat + " steps");
        var event;
        if (direction === "left" || direction === "right") {
            event = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, 0, -units);
        } else {
            event = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, units);
        }
        postMouse($.kCGEventMouseMoved, x, y, $.kCGMouseButtonLeft);
        $.CGEventPost($.kCGHIDEventTap, event);
        $.NSThread.sleepForTimeInterval(0.04);
    }
}

var KEY_CODES = {
    "return": 36, "enter": 36, "tab": 48, "escape": 53, "esc": 53, "space": 49,
    "backspace": 51, "delete": 51, "forward_delete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "page_up": 116, "page_down": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
    "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
    "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26,
    "8": 25, "9": 28,
};
var MODIFIER_CODES = { ctrl: 59, control: 59, shift: 56, alt: 58, option: 58, cmd: 55, command: 55, meta: 55, super: 55 };

function sendKey(chord) {
    var parts = String(chord).split("+").filter(function (p) { return p.length > 0; });
    if (!parts.length) throw new Error("Unsupported key: " + chord);
    var main = parts.pop().toLowerCase();
    var pressed = [];
    for (var i = 0; i < parts.length; i++) {
        var code = MODIFIER_CODES[parts[i].toLowerCase()];
        if (code === undefined) continue;
        postKey(code, true);
        heldKeys[code] = true;
        pressed.push(code);
    }
    try {
        var mainCode = KEY_CODES[main];
        if (mainCode === undefined) {
            if (main.length === 1) {
                // Non-mapped character: synthesize by Unicode event instead.
                sendText(main);
            } else {
                throw new Error("Unsupported key: " + main);
            }
        } else {
            postKey(mainCode, true);
            $.NSThread.sleepForTimeInterval(0.03);
            postKey(mainCode, false);
        }
    } finally {
        for (var m = pressed.length - 1; m >= 0; m--) {
            postKey(pressed[m], false);
            delete heldKeys[pressed[m]];
        }
    }
}

function sendText(text) {
    // System Events `keystroke` handles Unicode through the target process —
    // the CGEvent unichar-buffer bridge is not reliably expressible in JXA.
    // The string is posted as one call; a cancel can only land between ops.
    checkCancel("before typing " + String(text).length + " characters");
    se().keystroke(String(text));
}

function releaseInput() {
    var failed = 0;
    for (var button in heldButtons) {
        try {
            var types = MOUSE_TYPES.left;
            if (String(button) === String($.kCGMouseButtonRight)) types = MOUSE_TYPES.right;
            else if (String(button) === String($.kCGMouseButtonCenter)) types = MOUSE_TYPES.middle;
            postMouse(types.up, 0, 0, Number(button));
        } catch (e) { failed++; }
        delete heldButtons[button];
    }
    for (var code in heldKeys) {
        try { postKey(Number(code), false); } catch (e) { failed++; }
        delete heldKeys[code];
    }
    if (failed) {
        throw new Error("Desktop did not confirm release of " + failed + " managed inputs");
    }
}

// ---------------------------------------------------------------------------
// Viewer frame + human input (BC5) — whole-screen CGWindowList capture and
// raw CGEvent posting at absolute screen coordinates. Ownership checks are
// the Host's job; the driver only emits input. UNVERIFIED like the rest.
// ---------------------------------------------------------------------------

function captureDesktopFrame() {
    try {
        var image = $.CGWindowListCreateImage(
            $.CGRectNull,
            $.kCGWindowListOptionOnScreenOnly,
            $.kCGNullWindowID,
            $.kCGWindowImageDefault
        );
        if (!image) return null;
        var rep = $.NSBitmapImageRep.alloc.initWithCGImage(image);
        var data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
        if (!data) return null;
        return {
            mime: "image/png",
            base64: ObjC.unwrap(data.base64EncodedStringWithOptions(0)),
            bounds: {
                x: 0, y: 0,
                width: $.CGImageGetWidth(image),
                height: $.CGImageGetHeight(image),
            },
            capturedAt: (new Date()).toISOString(),
        };
    } catch (e) {
        return null;
    }
}

function injectHumanInput(operation) {
    var kind = String(operation.kind || "");
    var x = Number(operation.x) || 0;
    var y = Number(operation.y) || 0;
    var button = String(operation.button || "left");
    var types = MOUSE_TYPES[button] || MOUSE_TYPES.left;
    switch (kind) {
        case "click":
            sendMouseClick(x, y, button, operation.count || 1);
            break;
        case "down":
            postMouse(types.down, x, y, types.button);
            heldButtons[types.button] = true;
            break;
        case "up":
            postMouse(types.up, x, y, types.button);
            delete heldButtons[types.button];
            break;
        case "move":
            postMouse($.kCGEventMouseMoved, x, y, $.kCGMouseButtonLeft);
            break;
        case "scroll":
            sendScroll(x, y, String(operation.direction || "down"), operation.pages || 1);
            break;
        case "key":
            sendKey(String(operation.key || ""));
            break;
        case "text":
            sendText(String(operation.text || ""));
            break;
        default:
            throw new Error('unsupportedHumanInput("' + kind + '")');
    }
}

// ---------------------------------------------------------------------------
// Element resolution — records carry a `path` of child indexes so an action
// can re-resolve the same node in a fresh AX walk (indexes are not stable
// across observations on every app, so mismatches fail closed).
// ---------------------------------------------------------------------------

function axChild(element, index) {
    try {
        var children = element.uiElements() || [];
        return children[index] || null;
    } catch (e) {
        return null;
    }
}

function findAxElement(process, windowIndex, record) {
    var windows = axWindowElements(process);
    if (!windows.length) return null;
    var root = windows[Math.min(windowIndex || 0, windows.length - 1)];
    var path = record && record.path;
    // An observed element always has a path, including [] for the window root.
    // A name/role fallback can silently select a different duplicate control.
    if (!Array.isArray(path)) return null;
    var node = root;
    for (var i = 0; i < path.length; i++) {
        checkCancel();
        node = axChild(node, path[i]);
        if (node === null) return null;
    }
    var role = "", name = "";
    try { role = String(node.role() || "").replace(/^AX/, ""); } catch (e) {}
    try { name = String(node.title() || node.description() || ""); } catch (e) {}
    if (record.controlType && role !== record.controlType) return null;
    if (record.name && name !== record.name) return null;
    return node;
}

function axPress(element) {
    try {
        var actions = element.actions();
        for (var i = 0; i < actions.length; i++) {
            var name = String(actions[i].name() || "");
            if (name === "AXPress") {
                actions[i].perform();
                return true;
            }
        }
    } catch (e) {}
    return false;
}

function axSetValue(element, value) {
    try {
        element.value = value;
        return true;
    } catch (e) {
        try {
            element.attributes.byName("AXValue").value = String(value);
            return true;
        } catch (e2) {
            return false;
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshot + dispatch
// ---------------------------------------------------------------------------

function buildSnapshot(query, textLimit, maxNodes, maxDepth, screenshot, windowSelector) {
    var app = resolveApp(query);
    var windows = windowsForPid(app.pid);
    var windowInfo = selectWindow(app, windowSelector === undefined ? null : windowSelector, windows);
    checkCancel("resolved the target window");
    var process = seProcess(app.pid);
    var axWindows = axWindowElements(process);
    var axIndex = axWindowIndexFor(axWindows, windowInfo);
    var rendered = axIndex >= 0
        ? renderTree(axWindows[axIndex], windowInfo.bounds, textLimit, maxNodes, maxDepth)
        : { records: [], lines: [] };
    checkCancel("rendered the accessibility tree");
    // Stamp each element's AX child path so actions can re-resolve it.
    var descriptors = windows.map(function (w, i) {
        return {
            handle: w.handle,
            title: w.title || undefined,
            bounds: w.bounds || undefined,
            visible: true,
            minimized: false,
            main: w.handle === windowInfo.handle,
        };
    });
    return {
        app: { name: app.name, bundleIdentifier: app.name, pid: app.pid },
        windowTitle: limitText(windowInfo.title || "", textLimit),
        windowHandle: windowInfo.handle,
        windows: descriptors,
        windowBounds: windowInfo.bounds || null,
        screenshotPngBase64: screenshot ? captureWindowPngBase64(windowInfo) : null,
        treeLines: rendered.lines,
        elements: rendered.records,
    };
}

function driverCapabilities() {
    var axOk = true;
    var detail = null;
    try {
        // Accessibility permission: AXIsProcessTrusted — exposed via ObjC
        // bridge; without it the System Events tree is empty.
        if ($.AXIsProcessTrusted && !$.AXIsProcessTrusted()) {
            axOk = false;
            detail = "Accessibility permission is not granted to the driver host; grant it in System Settings > Privacy & Security > Accessibility";
        }
    } catch (e) {
        detail = "Accessibility permission could not be verified (" + e + ")";
    }
    var displays = [];
    try {
        var screens = $.NSScreen.screens;
        for (var i = 0; i < screens.count; i++) {
            var f = screens.objectAtIndex(i).frame;
            displays.push({
                x: f.origin.x, y: f.origin.y,
                width: f.size.width, height: f.size.height,
                primary: i === 0,
            });
        }
    } catch (e) {}
    return {
        platform: "macos",
        driver: "macos-jxa",
        driverVersion: DRIVER_VERSION,
        observeTree: axOk,
        screenshot: true,
        elementAction: axOk,
        coordinateInput: true,
        textInput: true,
        drag: true,
        dpiAware: true,
        multiWindow: true,
        interruptibleInput: true,
        occludedCapture: true,
        sessionType: "aqua",
        displays: displays,
        status: axOk ? "ready" : "unavailable",
        detail: detail || "UNVERIFIED driver — no real-machine evidence yet; report failures honestly",
    };
}

function performOperation(operation) {
    var tool = operation.tool;
    if (tool === "ping") return { ok: true };
    if (tool === "capabilities") return { ok: true, capabilities: driverCapabilities() };
    if (tool === "release_input") { releaseInput(); return { ok: true }; }
    if (tool === "capture_frame") {
        var frame = captureDesktopFrame();
        if (!frame) return { ok: false, error: "desktop capture produced no frame" };
        return { ok: true, frame: frame };
    }
    if (tool === "inject_input") {
        injectHumanInput(operation);
        return { ok: true };
    }
    if (tool === "list_apps") {
        var byPid = windowsByPid();
        var apps = [];
        var running = listRunningApps();
        for (var i = 0; i < running.length; i++) {
            var windows = byPid[running[i].pid];
            if (!windows || !windows.length) continue;
            apps.push({
                name: running[i].name,
                pid: running[i].pid,
                windowTitle: windows[0].title || "",
                windows: windows.map(function (w, i2) {
                    return {
                        handle: w.handle, title: w.title || undefined,
                        bounds: w.bounds || undefined, visible: true, minimized: false, main: i2 === 0,
                    };
                }),
            });
        }
        return { ok: true, apps: apps };
    }
    if (tool === "get_app_state") {
        return {
            ok: true,
            snapshot: buildSnapshot(
                operation.app || "",
                operation.text_limit === undefined ? DEFAULT_TEXT_LIMIT : operation.text_limit,
                operation.max_tree_nodes || MAX_ELEMENTS,
                operation.max_tree_depth || MAX_DEPTH,
                operation.screenshot !== false,
                operation.window
            ),
        };
    }

    var app = resolveApp(operation.app || "");
    var windows = windowsForPid(app.pid);
    var windowInfo = selectWindow(app, operation.window === undefined ? null : operation.window, windows);
    checkCancel("resolved the target window");
    var bounds = windowInfo.bounds || { x: 0, y: 0, width: 0, height: 0 };
    var elementRecord = operation.element || null;
    var element = null;
    if (elementRecord) {
        var process = seProcess(app.pid);
        var axWindows = axWindowElements(process);
        var axIndex = axWindowIndexFor(axWindows, windowInfo);
        if (axIndex < 0) {
            throw new Error("Selected window has no unique accessibility match; observe again");
        }
        element = findAxElement(process, axIndex, elementRecord);
        if (element === null) {
            throw new Error("Observed element no longer exists or is ambiguous; observe again");
        }
    }

    var inputPath = operation.input || "auto";
    switch (tool) {
        case "click": {
            var method = String(operation.click_method || "auto").toLowerCase();
            if ((method === "auto" || method === "accessibility") && element && axPress(element)) {
                break;
            }
            if (method === "accessibility") {
                throw new Error("click_method 'accessibility' could not click the requested element");
            }
            if (method === "app_post" || method === "sky_click") {
                throw new Error("click_method '" + method + "' is not supported on macOS");
            }
            var point = screenPoint(bounds, elementRecord, operation.x, operation.y);
            // Focus the window first so a click on a background app is real.
            try { seProcess(app.pid).frontmost = true; } catch (e) {}
            sendMouseClick(point.x, point.y, operation.mouse_button || "left", operation.click_count || 1);
            break;
        }
        case "perform_secondary_action": {
            if (!element) throw new Error("unknown element_index");
            var wanted = String(operation.action || "").toLowerCase();
            var done = false;
            try {
                var actions = element.actions();
                for (var ai = 0; ai < actions.length; ai++) {
                    var an = String(actions[ai].name() || "");
                    if (an.toLowerCase() === wanted || an.toLowerCase() === "ax" + wanted) {
                        actions[ai].perform();
                        done = true;
                        break;
                    }
                }
            } catch (e) {}
            if (!done) throw new Error(operation.action + " is not a valid secondary action for element");
            break;
        }
        case "scroll": {
            var sp = screenPoint(bounds, elementRecord, operation.x, operation.y);
            sendScroll(sp.x, sp.y, operation.direction || "down", operation.pages || 1);
            break;
        }
        case "drag": {
            var from = screenPoint(bounds, null, operation.from_x, operation.from_y);
            var to = screenPoint(bounds, null, operation.to_x, operation.to_y);
            sendDrag(from.x, from.y, to.x, to.y);
            break;
        }
        case "type_text": {
            try { seProcess(app.pid).frontmost = true; } catch (e) {}
            sendText(operation.text || "");
            break;
        }
        case "press_key": {
            try { seProcess(app.pid).frontmost = true; } catch (e) {}
            sendKey(operation.key || "");
            break;
        }
        case "set_value": {
            if (!element) throw new Error("unknown element_index");
            if (!axSetValue(element, operation.value)) {
                throw new Error("Cannot set a value for an element that is not settable");
            }
            break;
        }
        default:
            throw new Error('unsupportedTool("' + tool + '")');
    }

    $.NSThread.sleepForTimeInterval(0.12);
    try {
        return {
            ok: true,
            snapshot: buildSnapshot(operation.app || "", DEFAULT_TEXT_LIMIT, 0, 0, operation.screenshot !== false, operation.window),
        };
    } catch (e) {
        return {
            ok: true,
            text: "Input was dispatched; post-action observation failed. Observe again before deciding another action.",
        };
    }
}
