"""Protocol tests on a private D-Bus, not a desktop/portal acceptance test.
Run: dbus-run-session -- /usr/bin/python3 -m unittest discover -s packages/computer-driver/linux -p test_portal_transport.py
"""
import os
import socket
import threading
import unittest
try:
    from portal_backend import PortalBackend, BUS, PATH, REMOTE, SCREEN, SESSION, REQUEST, Gio, GLib
    from portal_session import SessionError
except ImportError:
    PortalBackend = None

XML = '''<node>
<interface name="org.freedesktop.portal.RemoteDesktop">
  <property name="AvailableDeviceTypes" type="u" access="read"/>
  <method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="SelectDevices"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="NotifyPointerMotionAbsolute"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/></method>
  <method name="NotifyPointerButton"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
  <method name="NotifyPointerAxis"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/></method>
  <method name="NotifyKeyboardKeysym"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
</interface>
<interface name="org.freedesktop.portal.ScreenCast">
  <property name="AvailableSourceTypes" type="u" access="read"/>
  <property name="AvailableCursorModes" type="u" access="read"/>
  <method name="SelectSources"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="OpenPipeWireRemote"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="h" direction="out"/></method>
</interface></node>'''
LIFECYCLE = '''<node>
<interface name="org.freedesktop.portal.Request"><method name="Close"/></interface>
<interface name="org.freedesktop.portal.Session"><method name="Close"/></interface>
</node>'''


@unittest.skipUnless(PortalBackend and os.environ.get("VARIN_TEST_PRIVATE_BUS"), "requires Gio and an explicit private test bus")
class PortalTransportTests(unittest.TestCase):
    def setUp(self):
        self.connection = Gio.DBusConnection.new_for_address_sync(os.environ["DBUS_SESSION_BUS_ADDRESS"],
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        self.connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
            GLib.Variant("(su)", (BUS, 0)), None, Gio.DBusCallFlags.NONE, -1, None)
        self.records = []
        self.registrations = []
        self.sockets = []
        self.defer_start = False
        self.session = None
        self.lifecycle = Gio.DBusNodeInfo.new_for_xml(LIFECYCLE)
        for interface in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
            self.registrations.append(self.connection.register_object(PATH, interface, self.method,
                lambda _c, _sender, _path, _iface, _prop: GLib.Variant("u", 3), None))
        self.backend = PortalBackend(capture_factory=lambda fd, node, properties, invalidated: (fd, node, properties))
    def tearDown(self):
        self.backend.dispose()
        for registration in self.registrations:
            self.connection.unregister_object(registration)
        self.connection.close_sync(None)
        for connection in self.sockets:
            connection.close()
    def method(self, _connection, sender, path, interface, method, params, invocation):
        args = params.unpack()
        self.records.append((method, args))
        if method == "Close":
            invocation.return_value(GLib.Variant("()", ()))
            return
        if method.startswith("Notify"):
            invocation.return_value(GLib.Variant("()", ()))
            return
        if method == "OpenPipeWireRemote":
            left, right = socket.socketpair()
            self.sockets.extend((left, right))
            fds = Gio.UnixFDList.new()
            index = fds.append(left.fileno())
            invocation.return_value_with_unix_fd_list(GLib.Variant("(h)", (index,)), fds)
            return
        options = args[-1]
        handle = "/org/freedesktop/portal/desktop/request/" + sender.lstrip(":").replace(".", "_") + "/" + options["handle_token"]
        self.registrations.append(self.connection.register_object(handle, self.lifecycle.lookup_interface(REQUEST), self.method, None, None))
        result = {}
        if method == "CreateSession":
            self.session = "/org/freedesktop/portal/desktop/session/test/" + options["session_handle_token"]
            self.registrations.append(self.connection.register_object(self.session, self.lifecycle.lookup_interface(SESSION), self.method, None, None))
            result["session_handle"] = GLib.Variant("s", self.session)
        elif method == "Start":
            result = {"devices": GLib.Variant("u", 3), "streams": GLib.Variant("a(ua{sv})", [(17, {"size": GLib.Variant("(ii)", (800, 600))})])}
        # Exercise Response arriving before the method return. The backend must
        # already be subscribed to this request's predicted path.
        if not (method == "Start" and self.defer_start):
            self.connection.emit_signal(sender, handle, REQUEST, "Response", GLib.Variant("(ua{sv})", (0, result)))
        invocation.return_value(GLib.Variant("(o)", (handle,)))
    def test_real_gio_request_signal_fd_and_input_round_trip(self):
        caps = self.backend.capabilities()
        self.assertTrue(caps["dbus_input"])
        session = self.backend.create_session(lambda: None)
        closed = threading.Event()
        self.backend.watch_closed(session, closed.set)
        self.backend.select_devices(session, 3, lambda: None)
        self.backend.select_sources(session, 3, lambda: None)
        result = self.backend.start(session, lambda: None)
        self.assertEqual(result["streams"][0][1]["size"], (800, 600))
        fd, node, properties = self.backend.capture(session, 17, {"size": (800, 600)}, lambda: None)
        try:
            self.sockets[-1].sendall(b"pipewire-fd")
            self.assertEqual(os.read(fd, 11), b"pipewire-fd")
        finally:
            os.close(fd)
        self.backend.notify(session, "PointerMotionAbsolute", 17, 12.5, 14.25)
        self.assertEqual(self.records[-1], ("NotifyPointerMotionAbsolute", (session, {}, 17, 12.5, 14.25)))
        self.connection.emit_signal(None, session, SESSION, "Closed", GLib.Variant("(a{sv})", ({},)))
        self.assertTrue(closed.wait(2))
        self.backend.close_session(session)
    def test_cancellation_closes_pending_chooser_request(self):
        self.defer_start = True
        session = self.backend.create_session(lambda: None)
        def cancel():
            raise SessionError("cancelled", "cancelled")
        with self.assertRaisesRegex(SessionError, "cancelled"):
            self.backend.start(session, cancel)
        self.assertEqual(self.records[-1][0], "Close")


@unittest.skipUnless(PortalBackend, "requires Gio introspection")
class GioEncodingTests(unittest.TestCase):
    def setUp(self):
        test = self
        class Bus:
            def __init__(self):
                self.subscriptions = {}
                self.calls = []
                self.defer = False
            def get_unique_name(self):
                return ":1.23"
            def signal_subscribe(self, sender, interface, member, path, arg, flags, callback, data):
                self.subscriptions[path] = callback
                return 1
            def signal_unsubscribe(self, _subscription):
                self.subscriptions.clear()
            def call_sync(self, destination, path, interface, method, parameters, *rest):
                self.calls.append((path, interface, method, parameters.unpack()))
                if interface == "org.freedesktop.DBus.Properties":
                    return GLib.Variant("(a{sv})", ({"AvailableDeviceTypes": GLib.Variant("u", 3),
                        "AvailableSourceTypes": GLib.Variant("u", 3), "AvailableCursorModes": GLib.Variant("u", 3)},))
                if method == "Introspect":
                    return GLib.Variant("(s)", (XML,))
                if method == "Close":
                    return GLib.Variant("()", ())
                info = Gio.DBusNodeInfo.new_for_xml(XML).lookup_interface(interface).lookup_method(method)
                test.assertEqual(parameters.get_type_string(), "(" + "".join(arg.signature for arg in info.in_args) + ")")
                if method.startswith("Notify"):
                    return GLib.Variant("()", ())
                args = parameters.unpack()
                request_path = "/org/freedesktop/portal/desktop/request/1_23/" + args[-1]["handle_token"]
                values = {"session_handle": GLib.Variant("s", "/org/freedesktop/portal/desktop/session/test/session")}
                if method == "Start":
                    values = {"devices": GLib.Variant("u", 3), "streams": GLib.Variant("a(ua{sv})", [(17, {"size": GLib.Variant("(ii)", (800, 600))})])}
                if not self.defer:
                    self.subscriptions[request_path](self, BUS, request_path, REQUEST, "Response", GLib.Variant("(ua{sv})", (0, values)), None)
                return GLib.Variant("(o)", (request_path,))
        self.backend = PortalBackend.__new__(PortalBackend)
        self.backend.bus = Bus()
        self.backend.subscriptions = {}
    def test_actual_gvariant_signatures_and_early_response_correlation(self):
        self.assertTrue(self.backend.capabilities()["dbus_input"])
        session = self.backend.create_session(lambda: None)
        self.backend.select_devices(session, 3, lambda: None)
        self.backend.select_sources(session, 3, lambda: None)
        result = self.backend.start(session, lambda: None)
        self.assertEqual(result["streams"][0][1]["size"], (800, 600))
        for method, args in [("PointerMotionAbsolute", (17, 12.5, 3.5)), ("PointerButton", (0x110, 1)),
                             ("PointerAxis", (0.0, -120.0)), ("KeyboardKeysym", (65, 1))]:
            self.backend.notify(session, method, *args)
        self.assertEqual(self.backend.bus.calls[-1][-1], (session, {}, 65, 1))
        self.assertFalse(self.backend.bus.subscriptions)
    def test_cancel_closes_original_pending_request(self):
        self.backend.bus.defer = True
        def cancel():
            raise SessionError("cancelled", "cancelled")
        with self.assertRaisesRegex(SessionError, "cancelled"):
            self.backend.start("/session", cancel)
        last = self.backend.bus.calls[-1]
        self.assertEqual(last[1:3], (REQUEST, "Close"))
        self.assertTrue(last[0].startswith("/org/freedesktop/portal/desktop/request/1_23/varin_"))
        self.assertFalse(self.backend.bus.subscriptions)


if __name__ == "__main__":
    unittest.main()
