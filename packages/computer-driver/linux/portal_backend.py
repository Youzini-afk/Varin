"""Production Gio portal transport and retained GStreamer PipeWire capture."""
import os
import struct
import threading
import uuid
from datetime import datetime, timezone

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

Gst = None
from portal_session import SessionError

BUS = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
SCREEN = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"


class PortalBackend:
    def __init__(self, capture_factory=None):
        global Gst
        if capture_factory is None:
            gi.require_version("Gst", "1.0")
            from gi.repository import Gst as gst
            Gst = gst
            Gst.init(None)
            for name in ("pipewiresrc", "videoconvert", "pngenc", "appsink"):
                if Gst.ElementFactory.find(name) is None:
                    raise SessionError("unsupported", "The desktop needs GStreamer PipeWire, video conversion and PNG plugins")
        self.capture_factory = capture_factory or PipeWireCapture
        self.loop = GLib.MainLoop()
        self.thread = threading.Thread(target=self.loop.run, daemon=True)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.thread.start()
        self.subscriptions = {}


    def call(self, interface, method, signature, args, path=PATH):
        return self.bus.call_sync(BUS, path, interface, method, GLib.Variant(signature, args),
                                  None, Gio.DBusCallFlags.NONE, -1, None).unpack()

    def capabilities(self):
        remote = self.call("org.freedesktop.DBus.Properties", "GetAll", "(s)", (REMOTE,))[0]
        screen = self.call("org.freedesktop.DBus.Properties", "GetAll", "(s)", (SCREEN,))[0]
        xml = self.call("org.freedesktop.DBus.Introspectable", "Introspect", "()", ())[0]
        info = Gio.DBusNodeInfo.new_for_xml(xml).lookup_interface(REMOTE)
        methods = {method.name for method in info.methods} if info else set()
        return {"devices": int(remote.get("AvailableDeviceTypes", 0)),
                "sources": int(screen.get("AvailableSourceTypes", 0)),
                "cursor_modes": int(screen.get("AvailableCursorModes", 0)),
                "dbus_input": {"NotifyPointerMotionAbsolute", "NotifyPointerButton", "NotifyPointerAxis", "NotifyKeyboardKeysym"}.issubset(methods)}

    def request(self, interface, method, signature, args, options, check):
        token = "varin_" + uuid.uuid4().hex
        sender = self.bus.get_unique_name().lstrip(":").replace(".", "_")
        expected = "/org/freedesktop/portal/desktop/request/" + sender + "/" + token
        complete = threading.Event()
        result = []
        def response(_bus, _sender, _path, _interface, _signal, parameters, _data):
            result.append(parameters.unpack())
            complete.set()
        # Subscribe before the call: a compositor may reply before its method
        # return arrives. handle_token fixes the request path without a race.
        subscription = self.bus.signal_subscribe(BUS, REQUEST, "Response", expected, None,
            Gio.DBusSignalFlags.NONE, response, None)
        request_path = expected
        try:
            options = dict(options, handle_token=GLib.Variant("s", token))
            request_path = self.call(interface, method, signature, tuple(args) + (options,))[0]
            if request_path != expected:
                raise SessionError("driver-error", "The portal returned an unexpected request identity")
            while not complete.wait(0.025):
                check()
            check()
            code, values = result[0]
            if code == 1:
                raise SessionError("input-rejected", "The desktop sharing request was declined")
            if code != 0:
                raise SessionError("driver-error", "The desktop portal could not prepare the requested session")
            return values
        except BaseException:
            try:
                self.call(REQUEST, "Close", "()", (), path=request_path)
            except Exception:
                pass
            raise
        finally:
            self.bus.signal_unsubscribe(subscription)

    def create_session(self, check):
        result = self.request(REMOTE, "CreateSession", "(a{sv})", (),
            {"session_handle_token": GLib.Variant("s", "varin_" + uuid.uuid4().hex)}, check)
        session = result.get("session_handle")
        if not isinstance(session, str) or not session.startswith("/org/freedesktop/portal/desktop/session/"):
            raise SessionError("driver-error", "The portal returned no desktop session identity")
        return session

    def watch_closed(self, session, callback):
        def closed(*_args):
            callback()
        self.subscriptions[session] = self.bus.signal_subscribe(BUS, SESSION, "Closed", session,
            None, Gio.DBusSignalFlags.NONE, closed, None)

    def select_devices(self, session, devices, check):
        self.request(REMOTE, "SelectDevices", "(oa{sv})", (session,),
            {"types": GLib.Variant("u", devices)}, check)

    def select_sources(self, session, sources, check):
        if not sources:
            raise SessionError("unsupported", "The portal exposes no monitor or window source")
        modes = self.capabilities()["cursor_modes"]
        options = {"types": GLib.Variant("u", sources), "multiple": GLib.Variant("b", False)}
        if modes & 2:
            options["cursor_mode"] = GLib.Variant("u", 2)
        self.request(SCREEN, "SelectSources", "(oa{sv})", (session,), options, check)

    def start(self, session, check):
        return self.request(REMOTE, "Start", "(osa{sv})", (session, ""), {}, check)

    def capture(self, session, node, properties, invalidated):
        reply, fds = self.bus.call_with_unix_fd_list_sync(BUS, PATH, SCREEN, "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (session, {})), GLib.VariantType.new("(h)"),
            Gio.DBusCallFlags.NONE, -1, None, None)
        fd = fds.get(reply.unpack()[0])
        try:
            return self.capture_factory(fd, node, properties, invalidated)
        except BaseException:
            os.close(fd)
            raise

    def notify(self, session, method, *args):
        signatures = {"PointerMotionAbsolute": "(oa{sv}udd)", "PointerButton": "(oa{sv}iu)",
                      "PointerAxis": "(oa{sv}dd)", "KeyboardKeysym": "(oa{sv}iu)"}
        self.call(REMOTE, "Notify" + method, signatures[method], (session, {}, *args))

    def close_session(self, session):
        subscription = self.subscriptions.pop(session, None)
        if subscription:
            self.bus.signal_unsubscribe(subscription)
        try:
            self.call(SESSION, "Close", "()", (), path=session)
        except GLib.Error as error:
            # Only an already-absent session establishes that there is nothing
            # left to revoke. A transport failure is not successful cleanup.
            if "UnknownObject" not in str(error):
                raise SessionError("connection-lost", "The portal did not confirm session closure", "unknown") from error

    def dispose(self):
        self.loop.quit()
        self.thread.join()


class PipeWireCapture:
    def __init__(self, fd, node, properties, invalidated):
        self.fd = fd
        self.condition = threading.Condition()
        self.latest = None
        self.failed = False
        self.invalidated = invalidated
        self.pipeline = Gst.Pipeline.new(None)
        self.bus = None
        source = Gst.ElementFactory.make("pipewiresrc")
        source.set_property("fd", fd)
        source.set_property("do-timestamp", True)
        if source.find_property("on-disconnect"):
            source.set_property("on-disconnect", 2)  # ERROR, never reconnect a replaced source
        serial = properties.get("pipewire-serial")
        if serial is not None:
            if not source.find_property("target-object"):
                raise SessionError("unsupported", "This GStreamer PipeWire plugin cannot bind the portal stream serial")
            source.set_property("target-object", str(serial))
        else:
            source.set_property("path", str(node))
        convert = Gst.ElementFactory.make("videoconvert")
        encoder = Gst.ElementFactory.make("pngenc")
        sink = Gst.ElementFactory.make("appsink")
        sink.set_property("emit-signals", True)
        sink.set_property("max-buffers", 1)
        sink.set_property("drop", True)
        sink.set_property("sync", False)
        for element in (source, convert, encoder, sink):
            self.pipeline.add(element)
        if not source.link(convert) or not convert.link(encoder) or not encoder.link(sink):
            raise SessionError("unsupported", "The PipeWire PNG capture pipeline could not be linked")
        sink.connect("new-sample", self.sample)
        self.bus = self.pipeline.get_bus()
        self.bus.add_signal_watch()
        self.bus.connect("message", self.message)
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            self.pipeline.set_state(Gst.State.NULL)
            self.bus.remove_signal_watch()
            raise SessionError("target-unavailable", "The authorized PipeWire source could not start")

    def sample(self, sink):
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.ERROR
        buffer = sample.get_buffer()
        ok, mapping = buffer.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.ERROR
        try:
            png = bytes(mapping.data)
        finally:
            buffer.unmap(mapping)
        if len(png) < 24 or png[:8] != b"\x89PNG\r\n\x1a\n":
            return Gst.FlowReturn.ERROR
        width, height = struct.unpack(">II", png[16:24])
        with self.condition:
            self.latest = {"png": png, "width": width, "height": height,
                           "capturedAt": datetime.now(timezone.utc).isoformat()}
            self.condition.notify_all()
        return Gst.FlowReturn.OK

    def message(self, _bus, message):
        if message.type in (Gst.MessageType.ERROR, Gst.MessageType.EOS):
            with self.condition:
                self.failed = True
                self.latest = None
                self.condition.notify_all()
            self.invalidated()

    def frame(self, check):
        with self.condition:
            while self.latest is None and not self.failed:
                self.condition.wait(0.025)
                check()
            check()
            if self.failed:
                raise SessionError("session-closed", "The authorized PipeWire stream ended")
            return dict(self.latest)

    def geometry(self):
        with self.condition:
            if self.failed:
                raise SessionError("session-closed", "The authorized PipeWire stream ended")
            return (self.latest["width"], self.latest["height"]) if self.latest else None

    def close(self):
        with self.condition:
            self.failed = True
            self.latest = None
            self.condition.notify_all()
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
        if self.bus:
            self.bus.remove_signal_watch()
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
