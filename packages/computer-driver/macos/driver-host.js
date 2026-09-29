// Varin Computer Use — persistent macOS driver host (JXA).
//
// Runs resident inside the user session under `osascript -l JavaScript` and
// speaks a line-delimited JSON protocol on stdin/stdout:
//   in : {"id":"<request>","tool":"<op>", ...params}
//   out: {"id":"<request>","ok":true|false, ...}
//
// Cancellation is out-of-band: while a request executes the Host writes
// "$VARIN_DRIVER_CANCEL_DIR/<requestId>.cancel"; long operations poll it at
// their internal checkpoints and abort with {ok:false, cancelled:true}.
// A fresh process can release only input it has tracked itself. It cannot
// safely distinguish a crashed predecessor's input from human-held input.
//
// Managed by the Varin Host computer service — do not run interactively.

ObjC.import("stdlib");
ObjC.import("Foundation");

// stdin is not exposed to JXA directly; block on NSFileHandle reads and split
// the stream on newlines ourselves.
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;

function writeResponse(requestId, response) {
    var payload = { id: requestId === null || requestId === undefined ? null : requestId };
    for (var key in response) payload[key] = response[key];
    var json = JSON.stringify(payload) + "\n";
    stdout.writeData($(json).dataUsingEncoding($.NSUTF8StringEncoding));
}

// The Host spawns us with cwd set to this directory (same convention as the
// Linux driver), so the runtime library resolves beside the script.
var driverDir = ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
var runtimeSource = $.NSString.stringWithContentsOfFileEncodingError(
    driverDir + "/runtime.js", $.NSUTF8StringEncoding, null
);
if (!runtimeSource) {
    writeResponse(null, { ok: false, error: "runtime.js not found beside driver-host.js" });
    $.exit(1);
}
eval(ObjC.unwrap(runtimeSource));

// Startup cleanup is limited to this process's tracked input.
try { releaseInput(); } catch (e) { /* best effort */ }

var pending = $.NSMutableString.alloc.init;
for (;;) {
    var chunk = stdin.availableData; // blocks until data or EOF
    if (!chunk || chunk.length === 0) break;
    pending.appendString(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(chunk, $.NSUTF8StringEncoding)));
    for (;;) {
        var newline = pending.rangeOfString("\n").location;
        if (newline === $.NSNotFound) break;
        var line = ObjC.unwrap(pending.substringToIndex(newline)).trim();
        pending.deleteCharactersInRange($.NSMakeRange(0, newline + 1));
        if (!line) continue;
        var requestId = null;
        try {
            var operation = JSON.parse(line);
            requestId = operation.id;
            ACTIVE_REQUEST_ID = requestId;
            var response = null;
            try {
                response = performOperation(operation);
            } catch (e) {
                if (e && e.name === "CancelledError") {
                    response = { ok: false, cancelled: true, error: e.message };
                } else {
                    throw e;
                }
            } finally {
                try {
                    if (!response || !response.ok || ["inject_input", "capture_frame", "get_app_state", "list_apps", "capabilities", "ping"].indexOf(operation.tool) < 0) releaseInput();
                }
                catch (releaseError) {
                    response = { ok: false, error: "Input release failed after the operation; its effect is unknown: " + releaseError };
                }
                ACTIVE_REQUEST_ID = null;
            }
            writeResponse(requestId, response);
        } catch (e2) {
            writeResponse(requestId, { ok: false, error: String(e2 && e2.message ? e2.message : e2) });
        }
    }
}
try { releaseInput(); } catch (e) { /* EOF cleanup */ }
