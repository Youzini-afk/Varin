// Native presentation and streamed 7-Zip progress for the x86 Unicode NSIS host.
// Installation, upgrades, UAC, registry entries and shortcuts remain NSIS-owned.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <uxtheme.h>
#include <dwmapi.h>
#include <string>
#include <algorithm>
#include <atomic>
#include <cwchar>

struct Stack { Stack* next; wchar_t text[1]; };
struct Call {
  int size; Stack** stack;
  std::wstring pop() {
    if (!*stack) return {};
    Stack* entry = *stack;
    std::wstring value(entry->text);
    *stack = entry->next;
    GlobalFree(entry);
    return value;
  }
  void push(const std::wstring& value) {
    auto* entry = static_cast<Stack*>(GlobalAlloc(GPTR, sizeof(Stack) + size * sizeof(wchar_t)));
    if (!entry) return;
    lstrcpynW(entry->text, value.c_str(), size);
    entry->next = *stack; *stack = entry;
  }
};
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle() = default;
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
static COLORREF background, foreground, muted, surface, primary, onPrimary;
static HBRUSH backgroundBrush, surfaceBrush;
static HFONT bodyFont, titleFont;
static constexpr int IDBACK = 3;
static std::atomic<bool> awaitingRetry{false};
static std::atomic<int> retryDecision{-1};
static Handle retrySignal;
static int scale = 100;
static int px(int value) { return MulDiv(value, scale, 100); }
static LRESULT CALLBACK buttonProc(HWND window, UINT message, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR) {
  // NSIS reapplies the default-button style after page callbacks; keep its behavior
  // while retaining the installer palette instead of restoring classic white chrome.
  if (message == BM_SETSTYLE) wp = (wp & ~BS_TYPEMASK) | BS_OWNERDRAW;
  if (message == WM_NCDESTROY) RemoveWindowSubclass(window, buttonProc, 1);
  return DefSubclassProc(window, message, wp, lp);
}
static BOOL CALLBACK hideChrome(HWND child, LPARAM parent) {
  if (GetParent(child) != reinterpret_cast<HWND>(parent)) return TRUE;
  const int id = GetDlgCtrlID(child);
  wchar_t type[64]{}; GetClassNameW(child, type, 64);
  if (id != IDOK && id != IDCANCEL && id != 1018 && wcscmp(type, L"#32770"))
    ShowWindow(child, SW_HIDE);
  return TRUE;
}
static COLORREF color(const std::wstring& value) {
  unsigned long rgb = wcstoul(value.c_str(), nullptr, 16);
  return RGB((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
}
static void move(HWND window, int x, int y, int width, int height) {
  if (window) SetWindowPos(window, nullptr, px(x), px(y), px(width), px(height), SWP_NOZORDER | SWP_NOACTIVATE);
}
static LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR) {
  if (awaitingRetry && message == WM_COMMAND && (LOWORD(wp) == IDOK || LOWORD(wp) == IDCANCEL)) {
    retryDecision = LOWORD(wp) == IDOK ? 1 : 0;
    SetEvent(retrySignal.value);
    return 0;
  }
  if (awaitingRetry && message == WM_CLOSE) { retryDecision = 0; SetEvent(retrySignal.value); return 0; }
  if (message == WM_ERASEBKGND) {
    RECT rect; GetClientRect(window, &rect); FillRect(reinterpret_cast<HDC>(wp), &rect, backgroundBrush); return 1;
  }
  if (message == WM_CTLCOLORSTATIC || message == WM_CTLCOLORBTN || message == WM_CTLCOLORDLG ||
      message == WM_CTLCOLOREDIT || message == WM_CTLCOLORLISTBOX) {
    HDC dc = reinterpret_cast<HDC>(wp);
    const bool edit = message == WM_CTLCOLOREDIT || message == WM_CTLCOLORLISTBOX;
    SetTextColor(dc, foreground); SetBkColor(dc, edit ? surface : background);
    return reinterpret_cast<LRESULT>(edit ? surfaceBrush : backgroundBrush);
  }
  if (message == WM_DRAWITEM) {
    auto* item = reinterpret_cast<DRAWITEMSTRUCT*>(lp);
    if (item->CtlType == ODT_BUTTON) {
      const bool main = item->CtlID == IDOK;
      COLORREF fill = main ? primary : surface;
      COLORREF text = main ? onPrimary : foreground;
      if (item->itemState & ODS_DISABLED) { fill = surface; text = muted; }
      HBRUSH brush = CreateSolidBrush(fill);
      auto oldBrush = SelectObject(item->hDC, brush);
      auto oldPen = SelectObject(item->hDC, GetStockObject(NULL_PEN));
      RoundRect(item->hDC, item->rcItem.left, item->rcItem.top, item->rcItem.right, item->rcItem.bottom, px(7), px(7));
      SelectObject(item->hDC, oldPen); SelectObject(item->hDC, oldBrush); DeleteObject(brush);
      wchar_t label[1024]{}; GetWindowTextW(item->hwndItem, label, 1024);
      SetBkMode(item->hDC, TRANSPARENT); SetTextColor(item->hDC, text);
      auto oldFont = SelectObject(item->hDC, bodyFont);
      DrawTextW(item->hDC, label, -1, &item->rcItem, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
      SelectObject(item->hDC, oldFont);
      if (item->itemState & ODS_FOCUS) {
        RECT focus = item->rcItem; InflateRect(&focus, -px(4), -px(4)); DrawFocusRect(item->hDC, &focus);
      }
      return TRUE;
    }
  }
  if (message == WM_NCDESTROY) RemoveWindowSubclass(window, windowProc, 1);
  return DefSubclassProc(window, message, wp, lp);
}
static BOOL CALLBACK styleChild(HWND child, LPARAM) {
  wchar_t type[64]{}; GetClassNameW(child, type, 64);
  SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(bodyFont), TRUE);
  if (wcscmp(type, L"#32770") == 0) SetWindowSubclass(child, windowProc, 1, 0);
  if (wcscmp(type, L"Button") == 0) {
    SetWindowTheme(child, L"", L"");
    LONG_PTR style = GetWindowLongPtrW(child, GWL_STYLE);
    const auto buttonType = style & BS_TYPEMASK;
    if (buttonType == BS_PUSHBUTTON || buttonType == BS_DEFPUSHBUTTON || buttonType == BS_OWNERDRAW) {
      SetWindowLongPtrW(child, GWL_STYLE, (style & ~BS_TYPEMASK) | BS_OWNERDRAW);
      SetWindowSubclass(child, buttonProc, 1, 0);
      InvalidateRect(child, nullptr, TRUE);
    }
  } else if (wcscmp(type, PROGRESS_CLASSW) == 0) {
    SetWindowTheme(child, L"", L"");
    SendMessageW(child, PBM_SETBKCOLOR, 0, surface); SendMessageW(child, PBM_SETBARCOLOR, 0, primary);
  } else if (wcscmp(type, WC_LISTVIEWW) == 0) {
    SetWindowTheme(child, L"", L"");
    ListView_SetBkColor(child, background); ListView_SetTextBkColor(child, background); ListView_SetTextColor(child, muted);
  }
  return TRUE;
}
extern "C" __declspec(dllexport) void __cdecl Theme(HWND parent, int size, wchar_t*, Stack** stack, void*) {
  Call call{size, stack};
  background = color(call.pop()); foreground = color(call.pop()); muted = color(call.pop());
  surface = color(call.pop()); primary = color(call.pop()); onPrimary = color(call.pop());
  if (!backgroundBrush) {
    // Subclasses must remain executable until the installer window is destroyed.
    HMODULE module;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                      reinterpret_cast<LPCWSTR>(&Theme), &module);
    HDC dc = GetDC(parent); const int dpi = GetDeviceCaps(dc, LOGPIXELSY); ReleaseDC(parent, dc);
    scale = MulDiv(dpi, 100, 96);
    bodyFont = CreateFontW(-MulDiv(10, dpi, 72), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    titleFont = CreateFontW(-MulDiv(18, dpi, 72), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    backgroundBrush = CreateSolidBrush(background); surfaceBrush = CreateSolidBrush(surface);
    RECT rect{0, 0, px(620), px(440)};
    AdjustWindowRectEx(&rect, static_cast<DWORD>(GetWindowLongPtrW(parent, GWL_STYLE)), FALSE,
                      static_cast<DWORD>(GetWindowLongPtrW(parent, GWL_EXSTYLE)));
    SetWindowPos(parent, nullptr, 0, 0, rect.right-rect.left, rect.bottom-rect.top, SWP_NOMOVE | SWP_NOZORDER);
    BOOL dark = GetRValue(background) < 128;
    DwmSetWindowAttribute(parent, 20, &dark, sizeof(dark));
  }
  SetWindowSubclass(parent, windowProc, 1, 0);
  EnumChildWindows(parent, styleChild, 0);
  EnumChildWindows(parent, hideChrome, reinterpret_cast<LPARAM>(parent));
  move(GetDlgItem(parent, 1018), 30, 28, 560, 335);
  move(GetDlgItem(parent, IDOK), 446, 389, 144, 34);
  move(GetDlgItem(parent, IDCANCEL), 344, 389, 90, 34);
  InvalidateRect(parent, nullptr, TRUE);
}
extern "C" __declspec(dllexport) void __cdecl Page(HWND parent, int size, wchar_t*, Stack** stack, void*) {
  Call call{size, stack};
  HWND page = reinterpret_cast<HWND>(wcstoull(call.pop().c_str(), nullptr, 0));
  move(page, 30, 28, 560, 335);
  SetWindowSubclass(page, windowProc, 1, 0);
  EnumChildWindows(page, styleChild, 0);
  EnumChildWindows(parent, hideChrome, reinterpret_cast<LPARAM>(parent));
  InvalidateRect(page, nullptr, TRUE);
}
extern "C" __declspec(dllexport) void __cdecl Progress(HWND parent, int size, wchar_t*, Stack** stack, void*) {
  Call call{size, stack};
  HWND page = reinterpret_cast<HWND>(wcstoull(call.pop().c_str(), nullptr, 0));
  const auto title = call.pop(), description = call.pop(), details = call.pop(), mode = call.pop();
  move(page, 30, 28, 560, 335);
  SetWindowSubclass(page, windowProc, 1, 0); EnumChildWindows(page, styleChild, 0);
  EnumChildWindows(parent, hideChrome, reinterpret_cast<LPARAM>(parent));
  HWND heading = CreateWindowW(L"STATIC", title.c_str(), WS_CHILD | WS_VISIBLE, 0, px(10), px(560), px(42), page, reinterpret_cast<HMENU>(9001), nullptr, nullptr);
  SendMessageW(heading, WM_SETFONT, reinterpret_cast<WPARAM>(titleFont), TRUE);
  HWND sub = CreateWindowW(L"STATIC", description.c_str(), WS_CHILD | WS_VISIBLE, 0, px(57), px(560), px(40), page, reinterpret_cast<HMENU>(9002), nullptr, nullptr);
  SendMessageW(sub, WM_SETFONT, reinterpret_cast<WPARAM>(bodyFont), TRUE);
  move(GetDlgItem(page, 1006), 0, 113, 560, 24);
  move(GetDlgItem(page, 1016), 0, 185, 560, 145);
  move(GetDlgItem(page, 1027), 0, 152, 140, 28);
  SetWindowTextW(GetDlgItem(page, 1027), details.c_str());
  move(GetDlgItem(page, 1004), 0, 140, 560, 5);
  if (mode == L"uninstall") {
    HWND progress = GetDlgItem(page, 1004);
    SetWindowLongPtrW(progress, GWL_STYLE, GetWindowLongPtrW(progress, GWL_STYLE) | PBS_MARQUEE);
    SendMessageW(progress, PBM_SETMARQUEE, TRUE, 0);
  }
  ShowWindow(GetDlgItem(parent, IDBACK), SW_HIDE);
}
static std::wstring windowText(HWND window) {
  std::wstring text(GetWindowTextLengthW(window)+1, L'\0');
  int length = GetWindowTextW(window, text.data(), static_cast<int>(text.size()));
  text.resize(length);
  return text;
}
extern "C" __declspec(dllexport) void __cdecl Retry(HWND parent, int size, wchar_t*, Stack** stack, void*) {
  Call call{size, stack};
  HWND page = reinterpret_cast<HWND>(wcstoull(call.pop().c_str(), nullptr, 0));
  const auto title=call.pop(), detail=call.pop(), retry=call.pop(), cancel=call.pop();
  if (!retrySignal.value) retrySignal.value=CreateEventW(nullptr,TRUE,FALSE,nullptr);
  if (!retrySignal.value) { call.push(L"cancel"); return; }
  ResetEvent(retrySignal.value);
  HWND next=GetDlgItem(parent, IDOK), close=GetDlgItem(parent, IDCANCEL), heading=GetDlgItem(page, 9001);
  const auto oldNext=windowText(next), oldClose=windowText(close), oldHeading=windowText(heading);
  BOOL nextEnabled=IsWindowEnabled(next), closeEnabled=IsWindowEnabled(close);
  const int ids[]{1004, 1006, 1016, 1027, 9002};
  BOOL visible[5]{};
  for (int i=0;i<5;++i) { visible[i]=IsWindowVisible(GetDlgItem(page,ids[i])); ShowWindow(GetDlgItem(page,ids[i]),SW_HIDE); }
  HWND message=CreateWindowExW(0,L"EDIT",detail.c_str(),WS_CHILD|WS_VISIBLE|WS_VSCROLL|ES_MULTILINE|ES_READONLY|ES_AUTOVSCROLL,
                              0,px(76),px(560),px(245),page,nullptr,nullptr,nullptr);
  SendMessageW(message,WM_SETFONT,reinterpret_cast<WPARAM>(bodyFont),TRUE);
  SetWindowTextW(heading,title.c_str()); SetWindowTextW(next,retry.c_str()); SetWindowTextW(close,cancel.c_str());
  EnableWindow(next,TRUE); EnableWindow(close,TRUE);
  retryDecision=-1; awaitingRetry=true;
  SetFocus(next);
  while(retryDecision<0) {
    // Install sections run on an NSIS worker thread. Button commands reach the
    // window thread, so wake the worker explicitly instead of waiting for its messages.
    const DWORD result=MsgWaitForMultipleObjects(1,&retrySignal.value,FALSE,INFINITE,QS_ALLINPUT);
    if(result==WAIT_OBJECT_0) break;
    if(result==WAIT_FAILED) { retryDecision=0; break; }
    MSG event;
    while(PeekMessageW(&event,nullptr,0,0,PM_REMOVE)) {
      if(event.message==WM_QUIT) { PostQuitMessage(static_cast<int>(event.wParam)); retryDecision=0; break; }
      if(!IsDialogMessageW(parent,&event)) { TranslateMessage(&event); DispatchMessageW(&event); }
    }
  }
  awaitingRetry=false;
  DestroyWindow(message);
  SetWindowTextW(heading,oldHeading.c_str()); SetWindowTextW(next,oldNext.c_str()); SetWindowTextW(close,oldClose.c_str());
  EnableWindow(next,nextEnabled); EnableWindow(close,closeEnabled);
  for(int i=0;i<5;++i) ShowWindow(GetDlgItem(page,ids[i]),visible[i]?SW_SHOW:SW_HIDE);
  call.push(retryDecision==1?L"retry":L"cancel");
}
static std::wstring systemError(DWORD code) {
  wchar_t* text = nullptr;
  FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                 nullptr, code, 0, reinterpret_cast<LPWSTR>(&text), 0, nullptr);
  std::wstring result = text ? text : L"Windows operation failed";
  if (text) LocalFree(text);
  return result;
}
extern "C" __declspec(dllexport) void __cdecl Extract(HWND parent, int size, wchar_t*, Stack** stack, void*) {
  Call call{size, stack};
  const auto executable = call.pop(), archive = call.pop(), destination = call.pop();
  HWND progress = reinterpret_cast<HWND>(wcstoull(call.pop().c_str(), nullptr, 0));
  HWND status = reinterpret_cast<HWND>(wcstoull(call.pop().c_str(), nullptr, 0));
  const auto label = call.pop();
  Handle reader, writer, input, job, process, thread;
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  DWORD code = 0;
  if (!CreatePipe(&reader.value, &writer.value, &security, 0)) code = GetLastError();
  if (!code && !SetHandleInformation(reader.value, HANDLE_FLAG_INHERIT, 0)) code = GetLastError();
  if (!code) {
    input.value = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
    if (input.value == INVALID_HANDLE_VALUE) code = GetLastError();
  }
  if (!code) {
    job.value = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) code = GetLastError();
  }
  std::wstring command = L"\"" + executable + L"\" x \"" + archive + L"\" \"-o" + destination + L"\" -y -bso0 -bse2 -bsp1 -sccUTF-8";
  if (!code) {
    STARTUPINFOW startup{sizeof(startup)};
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = writer.value; startup.hStdError = writer.value;
    startup.hStdInput = input.value;
    PROCESS_INFORMATION info{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                        CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &startup, &info)) code = GetLastError();
    else {
      process.value = info.hProcess; thread.value = info.hThread;
      if (!AssignProcessToJobObject(job.value, process.value)) { code = GetLastError(); TerminateProcess(process.value, code); }
      else if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) { code = GetLastError(); TerminateProcess(process.value, code); }
    }
  }
  if (writer.value) { CloseHandle(writer.value); writer.value = nullptr; }
  if (code) {
    if (process.value) WaitForSingleObject(process.value, INFINITE);
    call.push(systemError(code)); call.push(std::to_wstring(code)); return;
  }
  std::string line, lastError;
  int previous = -1;
  auto read = [&] {
    DWORD available = 0, count = 0;
    while (PeekNamedPipe(reader.value, nullptr, 0, nullptr, &available, nullptr) && available) {
      char buffer[4096];
      if (!ReadFile(reader.value, buffer, std::min<DWORD>(available, sizeof(buffer)), &count, nullptr)) break;
      for (DWORD i=0; i<count; ++i) {
        char c = buffer[i];
        if (c == '\r' || c == '\n' || c == '\b') {
          if (!line.empty() && line.find('%') == std::string::npos) {
            lastError += line + "\r\n";
            if (lastError.size() > static_cast<size_t>(size)) lastError.erase(0, lastError.size()-size);
          }
          line.clear();
        } else {
          line += c;
          // NSIS result strings have a fixed character capacity; keep the visible diagnostic tail.
          if (line.size() > static_cast<size_t>(size)) line.erase(0, line.size()-size);
          if (c == '%') {
            size_t start = line.size()-1;
            while (start && line[start-1] >= '0' && line[start-1] <= '9') --start;
            if (start < line.size()-1 && line.size()-start <= 4 && line.find_first_not_of(" \t") == start) {
              int percent = std::stoi(line.substr(start, line.size()-start-1));
              if (percent >= 0 && percent <= 100 && percent != previous) {
                previous = percent;
                SendMessageW(progress, PBM_SETRANGE32, 0, 100); SendMessageW(progress, PBM_SETPOS, percent, 0);
                SetWindowTextW(status, (label + L"  " + std::to_wstring(percent) + L"%").c_str());
              }
            }
          }
        }
      }
    }
  };
  while (true) {
    read();
    DWORD wait = MsgWaitForMultipleObjects(1, &process.value, FALSE, 50, QS_ALLINPUT);
    if (wait == WAIT_OBJECT_0) { read(); break; }
    if (wait == WAIT_FAILED) { code = GetLastError(); TerminateJobObject(job.value, code); break; }
    MSG message;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) { TerminateJobObject(job.value, ERROR_CANCELLED); PostQuitMessage(static_cast<int>(message.wParam)); code = ERROR_CANCELLED; break; }
      if (!IsDialogMessageW(parent, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    if (code) break;
  }
  if (!code && !GetExitCodeProcess(process.value, &code)) code = GetLastError();
  if (code) WaitForSingleObject(process.value, INFINITE);
  const int length = MultiByteToWideChar(CP_UTF8, 0, lastError.data(), static_cast<int>(lastError.size()), nullptr, 0);
  std::wstring detail(length, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, lastError.data(), static_cast<int>(lastError.size()), detail.data(), length);
  call.push(detail); call.push(std::to_wstring(code));
}

static void removeTree(const std::wstring& path, DWORD& failure, std::wstring& failedPath) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return;
    if (!failure) { failure = error; failedPath = path; }
    return;
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    WIN32_FIND_DATAW item{};
    HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &item);
    if (search != INVALID_HANDLE_VALUE) {
      do {
        if (wcscmp(item.cFileName, L".") && wcscmp(item.cFileName, L".."))
          removeTree(path + L"\\" + item.cFileName, failure, failedPath);
      } while (FindNextFileW(search, &item));
      DWORD error = GetLastError();
      FindClose(search);
      if (error != ERROR_NO_MORE_FILES && !failure) { failure = error; failedPath = path; }
    } else if (GetLastError() != ERROR_FILE_NOT_FOUND && !failure) {
      failure = GetLastError(); failedPath = path;
    }
  }
  // Junctions and symlinks are removed as links; external targets are never traversed.
  if ((attributes & FILE_ATTRIBUTE_READONLY) && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT))
    SetFileAttributesW(path.c_str(), attributes & ~FILE_ATTRIBUTE_READONLY);
  const BOOL removed = attributes & FILE_ATTRIBUTE_DIRECTORY ? RemoveDirectoryW(path.c_str()) : DeleteFileW(path.c_str());
  if (!removed && !failure) { failure = GetLastError(); failedPath = path; }
}
extern "C" __declspec(dllexport) void __cdecl RemoveData(HWND, int size, wchar_t*, Stack** stack, void*) {
  Call call{size, stack};
  std::wstring path = call.pop();
  if (path.rfind(L"\\\\?\\", 0) != 0) path = path.rfind(L"\\\\", 0) == 0 ? L"\\\\?\\UNC\\" + path.substr(2) : L"\\\\?\\" + path;
  DWORD failure = 0;
  std::wstring failedPath;
  removeTree(path, failure, failedPath);
  call.push(failure ? failedPath + L": " + systemError(failure) : L"");
  call.push(std::to_wstring(failure));
}
