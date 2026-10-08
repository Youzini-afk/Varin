// Owns injected input independently of the PowerShell/UIA request thread.
// The cancellation channel can release held inputs even while an application
// has stopped answering an accessibility query.
public sealed class VarinInputException : System.InvalidOperationException {
    public VarinInputException(string code, string message) : base(message) { Data["VarinReason"] = code; }
}

public static class VarinInput {
    private static readonly object Gate = new object();
    private static readonly System.Collections.Generic.Dictionary<string, VarinWin32.INPUT> Held = new System.Collections.Generic.Dictionary<string, VarinWin32.INPUT>();
    private static System.IO.FileSystemWatcher watcher;
    private static string cancelDirectory;
    private static string requestId;
    private static volatile bool cancelled, retired;
    private static bool semanticAttempt, verified;
    private static int dispatched;
    private static System.IntPtr window, focus, originalWindow, lastWindow;

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct GUITHREADINFO {
        public int cbSize, flags;
        public System.IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public VarinWin32.RECT rcCaret;
    }
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetGUIThreadInfo(uint id, ref GUITHREADINFO info);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint from, uint to, bool attach);

    public static void Start(string directory) {
        if (string.IsNullOrEmpty(directory) || watcher != null) return;
        cancelDirectory = directory;
        System.IO.Directory.CreateDirectory(directory);
        watcher = new System.IO.FileSystemWatcher(directory);
        watcher.NotifyFilter = System.IO.NotifyFilters.FileName | System.IO.NotifyFilters.LastWrite;
        watcher.Created += OnControl;
        watcher.Changed += OnControl;
        watcher.EnableRaisingEvents = true;
        foreach (string file in System.IO.Directory.GetFiles(directory, "*.release"))
            OnControl(null, new System.IO.FileSystemEventArgs(System.IO.WatcherChangeTypes.Created, directory, System.IO.Path.GetFileName(file)));
    }

    private static void OnControl(object sender, System.IO.FileSystemEventArgs e) {
        bool release = e.Name.EndsWith(".release", System.StringComparison.Ordinal);
        string command = null;
        if (release) {
            try { command = System.IO.File.ReadAllText(e.FullPath).Trim(); } catch { return; }
            if (command != "release" && command != "restore") return;
        }
        lock (Gate) {
            if (!release && (requestId == null || e.Name != requestId + ".cancel")) return;
            cancelled = true;
            if (release) retired = true;
            bool ok = ReleaseHeld();
            if (release) {
                if (command == "restore") RestoreFocus();
                string ack = e.FullPath + ".ack";
                string staged = ack + ".tmp";
                try {
                    System.IO.File.WriteAllText(staged, ok ? "{\"released\":true}" : "{\"released\":false}");
                    if (!System.IO.File.Exists(ack)) System.IO.File.Move(staged, ack);
                    else System.IO.File.Delete(staged);
                } catch { /* The Host retains an unconfirmed release if no receipt arrives. */ }
            }
        }
    }

    public static void Begin(string id) {
        lock (Gate) {
            requestId = id; dispatched = 0; semanticAttempt = false; verified = false;
            window = System.IntPtr.Zero; focus = System.IntPtr.Zero;
            cancelled = retired || (!string.IsNullOrEmpty(cancelDirectory) && System.IO.File.Exists(System.IO.Path.Combine(cancelDirectory, id + ".cancel")));
            AssertActive();
        }
    }
    public static void End() { lock (Gate) { requestId = null; window = System.IntPtr.Zero; focus = System.IntPtr.Zero; } }
    public static void AssertActive() {
        if (cancelled || retired) throw new System.OperationCanceledException("The computer operation was cancelled");
    }
    public static int DispatchedEvents { get { lock (Gate) { return dispatched; } } }
    public static string Effect {
        get { lock (Gate) { return verified ? "verified" : semanticAttempt ? "unknown" : dispatched > 0 ? "partial" : "none"; } }
    }
    public static void AttemptSemantic() { lock (Gate) { AssertActive(); semanticAttempt = true; } }
    public static void Verify() { lock (Gate) { verified = true; } }

    public static void Activate(System.IntPtr target) {
        lock (Gate) {
            AssertActive();
            if (!VarinWin32.IsWindow(target)) throw new VarinInputException("target-unavailable", "The target window no longer exists");
            System.IntPtr previous = VarinWin32.GetForegroundWindow();
            if (previous != target) {
                if (VarinWin32.IsIconic(target)) VarinWin32.ShowWindowAsync(target, 9);
                VarinWin32.SetForegroundWindow(target);
                if (VarinWin32.GetForegroundWindow() != target) {
                    uint pid;
                    uint foregroundThread = VarinWin32.GetWindowThreadProcessId(VarinWin32.GetForegroundWindow(), out pid);
                    uint currentThread = GetCurrentThreadId();
                    // Briefly share the foreground queue only around activation.
                    // No UIA, waits, messages or input run while queues are attached.
                    bool attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
                    try { VarinWin32.SetForegroundWindow(target); }
                    finally { if (attached) AttachThreadInput(currentThread, foregroundThread, false); }
                }
                if (VarinWin32.GetForegroundWindow() != target) throw new VarinInputException("focus-changed", "The target window could not obtain foreground focus");
                if (originalWindow == System.IntPtr.Zero) originalWindow = previous;
            }
            window = target; lastWindow = target;
        }
    }
    public static void BindKeyboardFocus() {
        lock (Gate) {
            AssertTarget();
            uint pid;
            GUITHREADINFO info = new GUITHREADINFO();
            info.cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(GUITHREADINFO));
            if (!GetGUIThreadInfo(VarinWin32.GetWindowThreadProcessId(window, out pid), ref info) || info.hwndFocus == System.IntPtr.Zero)
                throw new VarinInputException("focus-changed", "The target has no keyboard focus");
            focus = info.hwndFocus;
        }
    }
    private static void AssertTarget() {
        AssertActive();
        if (window != System.IntPtr.Zero && VarinWin32.GetForegroundWindow() != window)
            throw new VarinInputException("focus-changed", "The target window lost foreground focus");
        if (focus != System.IntPtr.Zero) {
            uint pid;
            GUITHREADINFO info = new GUITHREADINFO();
            info.cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(GUITHREADINFO));
            if (!GetGUIThreadInfo(VarinWin32.GetWindowThreadProcessId(window, out pid), ref info) || info.hwndFocus != focus)
                throw new VarinInputException("focus-changed", "Keyboard focus moved to another control");
        }
    }

    private static string HeldKey(VarinWin32.INPUT input, out VarinWin32.INPUT up, out bool isUp) {
        up = input; isUp = false;
        if (input.type == VarinWin32.INPUT_KEYBOARD) {
            isUp = (input.union.ki.dwFlags & VarinWin32.KEYEVENTF_KEYUP) != 0;
            up = VarinWin32.KeyInput(input.union.ki.wVk, input.union.ki.wScan, input.union.ki.dwFlags | VarinWin32.KEYEVENTF_KEYUP);
            return "key:" + input.union.ki.wVk + ":" + input.union.ki.wScan;
        }
        uint[] downs = { 2, 8, 32 }, ups = { 4, 16, 64 };
        for (int i = 0; i < downs.Length; i++) if ((input.union.mi.dwFlags & (downs[i] | ups[i])) != 0) {
            isUp = (input.union.mi.dwFlags & ups[i]) != 0;
            up = VarinWin32.MouseInput(0, 0, ups[i], 0);
            return "mouse:" + downs[i];
        }
        return null;
    }
    public static void Send(VarinWin32.INPUT[] inputs) {
        lock (Gate) {
            AssertTarget();
            uint sent = VarinWin32.SendInput((uint)inputs.Length, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(VarinWin32.INPUT)));
            for (int i = 0; i < sent; i++) {
                VarinWin32.INPUT up; bool isUp;
                string key = HeldKey(inputs[i], out up, out isUp);
                if (key != null) { if (isUp) Held.Remove(key); else Held[key] = up; }
            }
            dispatched += (int)sent;
            if (sent != inputs.Length) throw new VarinInputException("input-rejected", "Windows accepted " + sent + " of " + inputs.Length + " input events (error " + System.Runtime.InteropServices.Marshal.GetLastWin32Error() + ")");
        }
    }
    public static void Move(int x, int y) {
        lock (Gate) {
            AssertTarget();
            if (window != System.IntPtr.Zero) {
                VarinWin32.POINT point = new VarinWin32.POINT(); point.X = x; point.Y = y;
                System.IntPtr owner = VarinWin32.WindowFromPoint(point);
                if (owner != window && !VarinWin32.IsChild(window, owner))
                    throw new VarinInputException("target-changed", "The pointer target is covered by another window");
            }
            if (!VarinWin32.SetCursorPos(x, y)) throw new VarinInputException("input-rejected", "Windows did not accept pointer movement");
            dispatched++;
        }
    }
    private static bool ReleaseHeld() {
        foreach (string key in new System.Collections.Generic.List<string>(Held.Keys)) {
            if (VarinWin32.SendInput(1, new VarinWin32.INPUT[] { Held[key] }, System.Runtime.InteropServices.Marshal.SizeOf(typeof(VarinWin32.INPUT))) == 1) Held.Remove(key);
        }
        return Held.Count == 0;
    }
    private static void RestoreFocus() {
        if (originalWindow != System.IntPtr.Zero && VarinWin32.IsWindow(originalWindow) && VarinWin32.GetForegroundWindow() == lastWindow)
            VarinWin32.SetForegroundWindow(originalWindow);
        originalWindow = System.IntPtr.Zero; lastWindow = System.IntPtr.Zero;
    }
    public static void Release(bool restore) {
        lock (Gate) {
            if (!ReleaseHeld()) throw new VarinInputException("input-rejected", "Windows did not confirm release of managed input");
            if (restore) RestoreFocus();
        }
    }
}
