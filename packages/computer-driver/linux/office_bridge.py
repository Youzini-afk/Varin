#!/usr/bin/env python3
"""LibreOffice UNO bridge for the managed Linux desktop (EE §7.2).

Attaches to the real running soffice process — the documents a human has open
(with their unsaved state), not a parallel converter. `uno` ships as
python3-uno in the docs component recipe; without it every op reports an
honest unavailable error.

Ops (perform(operation) dispatch):
  status  -> {running, docs: [...]} — connect probe; never claims a session
  launch  -> start soffice --accept=socket on the desktop's own profile
  docs    -> open components with title, kind, modified flag
  open    -> load a file URL/path into the live instance (visible)
  act     -> kind: read {sheet, range} | write {sheet, range, values}
                 | insert {text} | save
"""
import os
import subprocess
import time

UNO_PORT = 2002
_connect_string = ("uno:socket,host=127.0.0.1,port={};urp;"
                   "StarOffice.ComponentContext").format(UNO_PORT)

_uno = None
_uno_error = None


def _load_uno():
    global _uno, _uno_error
    if _uno is not None or _uno_error is not None:
        return _uno
    try:
        import uno  # noqa: F401
        from com.sun.star.beans import PropertyValue  # noqa: F401
        _uno = uno
    except Exception as exc:
        _uno_error = exc
    return _uno


def _context():
    uno = _load_uno()
    if uno is None:
        raise RuntimeError(f"LibreOffice bridge unavailable: {_uno_error}")
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local)
    return resolver.resolve(_connect_string)


def _desktop(ctx):
    return ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.frame.Desktop", ctx)


def _prop(name, value):
    uno = _load_uno()
    from com.sun.star.beans import PropertyValue
    prop = PropertyValue()
    prop.Name = name
    prop.Value = value
    return prop


def _kind(document):
    if document.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
        return "spreadsheet"
    if document.supportsService("com.sun.star.text.TextDocument"):
        return "text"
    if document.supportsService("com.sun.star.presentation.PresentationDocument"):
        return "presentation"
    return "document"


def _documents(ctx):
    desktop = _desktop(ctx)
    components = desktop.Components.createEnumeration()
    docs = []
    while components.hasMoreElements():
        doc = components.nextElement()
        try:
            docs.append({
                "title": doc.Title,
                "url": doc.getURL() or None,
                "kind": _kind(doc),
                "modified": bool(doc.isModified()),
            })
        except Exception:
            docs.append({"title": "(unreadable component)", "kind": "document"})
    return docs


def _find_document(ctx, title_or_url):
    desktop = _desktop(ctx)
    components = desktop.Components.createEnumeration()
    while components.hasMoreElements():
        doc = components.nextElement()
        try:
            if doc.Title == title_or_url or doc.getURL() == title_or_url:
                return doc
        except Exception:
            continue
    raise RuntimeError(f"no open document matching {title_or_url!r}")


def _file_url(path_or_url):
    uno = _load_uno()
    if path_or_url.startswith(("file://", "http://", "https://")):
        return path_or_url
    path = os.path.abspath(path_or_url)
    return uno.systemPathToFileUrl(path)


def perform(operation):
    try:
        return _perform(operation)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _perform(operation):
    op = operation.get("op") or "status"

    if op == "launch":
        try:
            ctx = _context()
            return {"ok": True, "status": {"running": True}, "alreadyRunning": True}
        except Exception:
            pass
        profile = os.path.expanduser("~/.config/libreoffice/4/user")
        args = ["soffice",
                f"--accept=socket,host=127.0.0.1,port={UNO_PORT};urp;",
                "--norestore", "--nologo"]
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                _context()
                return {"ok": True, "status": {"running": True}}
            except Exception:
                time.sleep(0.5)
        return {"ok": False, "error": "soffice did not expose UNO within 30s"}

    if op == "status":
        try:
            ctx = _context()
            return {"ok": True, "status": {"running": True}, "docs": _documents(ctx)}
        except Exception:
            return {"ok": True, "status": {"running": False}}

    if op == "docs":
        return {"ok": True, "docs": _documents(_context())}

    if op == "open":
        target = operation.get("path") or operation.get("url")
        if not isinstance(target, str) or not target:
            return {"ok": False, "error": "open requires path or url"}
        ctx = _context()
        doc = _desktop(ctx).loadComponentFromURL(
            _file_url(target), "_blank", 0, ())
        if doc is None:
            return {"ok": False, "error": "LibreOffice refused the document"}
        return {"ok": True, "doc": {"title": doc.Title, "url": doc.getURL(),
                                    "kind": _kind(doc), "modified": bool(doc.isModified())}}

    if op == "act":
        act = operation.get("act") or {}
        kind = act.get("kind")
        ctx = _context()
        doc = _find_document(ctx, act.get("doc"))
        if kind == "save":
            if doc.hasLocation():
                doc.store()
            else:
                return {"ok": False, "error": "document has no location — export with a target instead"}
            return {"ok": True, "modified": bool(doc.isModified())}
        if kind == "insert":
            if not doc.supportsService("com.sun.star.text.TextDocument"):
                return {"ok": False, "error": "insert applies to text documents"}
            text = act.get("text")
            if not isinstance(text, str) or not text:
                return {"ok": False, "error": "insert requires text"}
            cursor = doc.Text.createTextCursor()
            cursor.gotoEnd(False)
            doc.Text.insertString(cursor, text, False)
            return {"ok": True, "modified": bool(doc.isModified())}
        if kind in ("read", "write"):
            if not doc.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
                return {"ok": False, "error": f"{kind} applies to spreadsheets"}
            sheets = doc.Sheets
            sheet_name = act.get("sheet")
            sheet = sheets.getByName(sheet_name) if sheet_name else sheets.getByIndex(0)
            range_name = act.get("range")
            if not isinstance(range_name, str) or not range_name:
                return {"ok": False, "error": f"{kind} requires a cell range like A1:B4"}
            cell_range = sheet.getCellRangeByName(range_name)
            if kind == "read":
                values = cell_range.getDataArray()
                return {"ok": True, "sheet": sheet.Name, "range": range_name,
                        "values": [[cell if cell is not None else None for cell in row] for row in values]}
            values = act.get("values")
            if not isinstance(values, list) or not values or not all(isinstance(row, list) for row in values):
                return {"ok": False, "error": "write requires values as a 2-D list matching the range"}
            if len(values) != cell_range.Rows.Count or any(len(row) != cell_range.Columns.Count for row in values):
                return {"ok": False, "error": "values shape must match the range exactly"}
            cell_range.setDataArray(tuple(tuple(row) for row in values))
            return {"ok": True, "modified": bool(doc.isModified())}
        return {"ok": False, "error": f"unknown office act kind: {kind}"}

    return {"ok": False, "error": f"unknown office op: {op}"}
