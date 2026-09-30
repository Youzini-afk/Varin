#!/usr/bin/env python3
"""LibreOffice UNO bridge for the managed Linux desktop (EE §7.2).

Attaches to the real running soffice process — the documents a human has open
(with their unsaved state), not a parallel converter. `uno` ships as
python3-uno in the docs component recipe; without it every op reports an
honest unavailable error.

Ops (perform(operation) dispatch):
  status  -> {running, docs: [...]} — connect probe; never claims a session
  launch  -> start soffice --accept=pipe on the desktop user's own profile
  docs    -> open components with title, kind, modified flag
  open    -> load a file URL/path into the live instance (visible)
  act     -> kind: read {sheet, range} | write {sheet, range, values}
                 | insert {text} | save {path?} | export {path, filter?}
"""
import os
import subprocess
import time

UNO_PIPE = os.environ.get("VARIN_OFFICE_PIPE") or ("varin-office-" + str(os.getuid()) if hasattr(os, "getuid") else "varin-office")
_connect_string = f"uno:pipe,name={UNO_PIPE};urp;StarOffice.ComponentContext"

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
                **({"id": "doc:" + str(doc.RuntimeUID)} if getattr(doc, "RuntimeUID", None) else {}),
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
    matches = []
    documents = []
    while components.hasMoreElements():
        doc = components.nextElement()
        try:
            if not doc.supportsService("com.sun.star.document.OfficeDocument"):
                continue
            documents.append(doc)
            runtime_id = getattr(doc, "RuntimeUID", None)
            if (runtime_id and "doc:" + str(runtime_id) == title_or_url) or doc.Title == title_or_url or doc.getURL() == title_or_url:
                matches.append(doc)
        except Exception:
            continue
    if title_or_url is None:
        current = desktop.getCurrentComponent()
        if current is not None and current.supportsService("com.sun.star.document.OfficeDocument"):
            return current
        if len(documents) == 1:
            return documents[0]
        raise RuntimeError("Select a document id from docs; no active document is identified")
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError("The document selector is ambiguous; use the id returned by docs")
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
        writes = operation.get("op") in ("launch", "open") or (operation.get("op") == "act"
                 and (operation.get("act") or {}).get("kind") != "read")
        return {"ok": False, "error": str(exc), **({"outcome": "unknown"} if writes and not isinstance(exc, ValueError) else {})}


def _perform(operation):
    op = operation.get("op") or "status"

    if op == "launch":
        try:
            ctx = _context()
            return {"ok": True, "status": {"running": True}, "alreadyRunning": True}
        except Exception:
            pass
        args = ["soffice",
                f"--accept=pipe,name={UNO_PIPE};urp;", "--nologo"]
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
        except Exception as exc:
            return {"ok": True, "status": {"running": False, "detail": str(exc)}}

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
                                    **({"id": "doc:" + str(doc.RuntimeUID)} if getattr(doc, "RuntimeUID", None) else {}),
                                    "kind": _kind(doc), "modified": bool(doc.isModified())}}

    if op == "act":
        act = operation.get("act") or {}
        kind = act.get("kind")
        ctx = _context()
        doc = _find_document(ctx, act.get("doc"))
        if kind in ("save", "export"):
            target = act.get("path") or act.get("url")
            if kind == "export":
                if not isinstance(target, str) or not target:
                    return {"ok": False, "error": "export requires a target path or URL"}
                filters = {"text": "writer_pdf_Export", "spreadsheet": "calc_pdf_Export", "presentation": "impress_pdf_Export"}
                filter_name = act.get("filter") or filters.get(_kind(doc))
                if not filter_name:
                    return {"ok": False, "error": "No export filter for this document kind"}
                doc.storeToURL(_file_url(target), (_prop("FilterName", filter_name),))
            elif target:
                doc.storeAsURL(_file_url(target), ())
            elif doc.hasLocation():
                doc.store()
            else:
                return {"ok": False, "error": "document has no location — export with a target instead"}
            return {"ok": True, "modified": bool(doc.isModified()), "target": _file_url(target) if target else doc.getURL()}
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
            if kind == "read" and doc.supportsService("com.sun.star.text.TextDocument"):
                return {"ok": True, "text": doc.Text.String, "modified": bool(doc.isModified())}
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
            if not all(cell is None or isinstance(cell, (str, int, float)) and not isinstance(cell, bool) for row in values for cell in row):
                return {"ok": False, "error": "Values must be numbers, strings, or null for an empty cell"}
            cell_range.setDataArray(tuple(tuple("" if cell is None else float(cell) if isinstance(cell, (int, float)) else cell for cell in row) for row in values))
            return {"ok": True, "modified": bool(doc.isModified())}
        return {"ok": False, "error": f"unknown office act kind: {kind}"}

    return {"ok": False, "error": f"unknown office op: {op}"}
