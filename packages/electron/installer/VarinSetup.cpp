// Native presentation and streamed 7-Zip progress for the x86 Unicode NSIS host.
// Installation, upgrades, UAC, registry entries and shortcuts remain NSIS-owned.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <uxtheme.h>
#include <dwmapi.h>
#include <objidl.h>
#include <gdiplus.h>
#include <string>
#include <algorithm>
#include <atomic>
#include <cwchar>
#include <iterator>
#include "installer-brand.h"

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
static HFONT bodyFont, titleFont, brandFont, smallBrandFont, captionFont;
static HWND installerWindow;
static std::wstring versionLabel;
static constexpr int IDFRAMEMINIMIZE = 9103, IDFRAMECLOSE = 9104;
static constexpr int IDBACK = 3;
static std::atomic<bool> awaitingRetry{false};
static std::atomic<int> retryDecision{-1};
static Handle retrySignal;
static int scale = 100;
static int px(int value) { return MulDiv(value, scale, 100); }
static Gdiplus::Color ink(COLORREF value) { return Gdiplus::Color(255, GetRValue(value), GetGValue(value), GetBValue(value)); }
static COLORREF mix(COLORREF a, COLORREF b, int amount) {
  return RGB((GetRValue(a)*(100-amount)+GetRValue(b)*amount)/100,
             (GetGValue(a)*(100-amount)+GetGValue(b)*amount)/100,
             (GetBValue(a)*(100-amount)+GetBValue(b)*amount)/100);
}
static void rounded(HDC dc, RECT rect, COLORREF fill, int radius) {
  Gdiplus::Graphics graphics(dc); graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  Gdiplus::GraphicsPath path;
  const float x=static_cast<float>(rect.left), y=static_cast<float>(rect.top);
  const float w=static_cast<float>(rect.right-rect.left-1), h=static_cast<float>(rect.bottom-rect.top-1);
  const float d=static_cast<float>(px(radius*2));
  path.AddArc(x,y,d,d,180,90); path.AddArc(x+w-d,y,d,d,270,90);
  path.AddArc(x+w-d,y+h-d,d,d,0,90); path.AddArc(x,y+h-d,d,d,90,90); path.CloseFigure();
  Gdiplus::SolidBrush brush(ink(fill)); graphics.FillPath(&brush,&path);
}
static void brand(HDC dc, int x, int y, int size) {
  Gdiplus::Graphics graphics(dc); graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  graphics.TranslateTransform(static_cast<float>(px(x)),static_cast<float>(px(y)));
  graphics.ScaleTransform(px(size)/128.0f,px(size)/128.0f);
  Gdiplus::SolidBrush first(ink(foreground)), second(ink(mix(foreground,background,32)));
  graphics.FillPolygon(&first,brand0,static_cast<INT>(std::size(brand0)));
  graphics.FillPolygon(&second,brand1,static_cast<INT>(std::size(brand1)));
}
static void label(HDC dc, const wchar_t* text, HFONT font, COLORREF textColor, RECT rect, UINT flags) {
  auto old=SelectObject(dc,font); SetBkMode(dc,TRANSPARENT); SetTextColor(dc,textColor);
  DrawTextW(dc,text,-1,&rect,flags|DT_SINGLELINE|DT_VCENTER); SelectObject(dc,old);
}
static LRESULT CALLBACK buttonProc(HWND window, UINT message, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR) {
  // NSIS reapplies the default-button style after page callbacks; keep its behavior
  // while retaining the installer palette instead of restoring classic white chrome.
  if (message == BM_SETSTYLE) wp = (wp & ~BS_TYPEMASK) | BS_OWNERDRAW;
  if (message == WM_MOUSEMOVE && !GetPropW(window,L"VarinHot")) {
    SetPropW(window,L"VarinHot",reinterpret_cast<HANDLE>(1));
    TRACKMOUSEEVENT track{sizeof(track),TME_LEAVE,window,0}; TrackMouseEvent(&track);
    InvalidateRect(window,nullptr,FALSE);
  }
  if (message == WM_MOUSELEAVE) { RemovePropW(window,L"VarinHot"); InvalidateRect(window,nullptr,FALSE); }
  if (message == WM_SETCURSOR && GetPropW(window,L"VarinLink")) { SetCursor(LoadCursor(nullptr,IDC_HAND)); return TRUE; }
  if (message == WM_NCDESTROY) RemoveWindowSubclass(window, buttonProc, 1);
  return DefSubclassProc(window, message, wp, lp);
}
static LRESULT CALLBACK choiceProc(HWND window, UINT message, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR) {
  if(message==WM_ERASEBKGND) return 1;
  if(message==WM_PAINT) {
    PAINTSTRUCT paint; HDC dc=BeginPaint(window,&paint); RECT rect; GetClientRect(window,&rect); FillRect(dc,&rect,backgroundBrush);
    const bool checked=SendMessageW(window,BM_GETCHECK,0,0)==BST_CHECKED;
    const auto type=GetWindowLongPtrW(window,GWL_STYLE)&BS_TYPEMASK;
    const bool radio=type==BS_AUTORADIOBUTTON || type==BS_RADIOBUTTON;
    const float y=(rect.bottom-px(16))/2.0f;
    Gdiplus::Graphics graphics(dc); graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    Gdiplus::Pen border(ink(checked?primary:muted),static_cast<float>(px(1)));
    Gdiplus::SolidBrush fill(ink(checked?primary:background));
    if(radio) {
      graphics.DrawEllipse(&border,static_cast<float>(px(1)),y,static_cast<float>(px(16)),static_cast<float>(px(16)));
      if(checked) graphics.FillEllipse(&fill,static_cast<float>(px(5)),y+px(4),static_cast<float>(px(8)),static_cast<float>(px(8)));
    } else {
      RECT box{px(1),static_cast<LONG>(y),px(18),static_cast<LONG>(y)+px(17)};
      rounded(dc,box,checked?primary:muted,4);
      if(!checked) { InflateRect(&box,-px(1),-px(1)); rounded(dc,box,background,3); }
      else {
        Gdiplus::Pen tick(ink(onPrimary),px(1)*1.5f);
        Gdiplus::PointF points[]{{static_cast<float>(px(5)),y+px(8)},{static_cast<float>(px(8)),y+px(11)},{static_cast<float>(px(14)),y+px(5)}};
        graphics.DrawLines(&tick,points,3);
      }
    }
    wchar_t text[1024]{}; GetWindowTextW(window,text,1024); rect.left=px(28);
    label(dc,text,bodyFont,IsWindowEnabled(window)?foreground:muted,rect,DT_LEFT);
    if(GetFocus()==window && !(SendMessageW(window,WM_QUERYUISTATE,0,0)&UISF_HIDEFOCUS)) { InflateRect(&rect,-px(2),-px(4)); DrawFocusRect(dc,&rect); }
    EndPaint(window,&paint); return 0;
  }
  if(message==WM_NCDESTROY) RemoveWindowSubclass(window,choiceProc,1);
  const auto result=DefSubclassProc(window,message,wp,lp);
  if(message==BM_SETCHECK || message==BM_SETSTATE || message==WM_SETFOCUS || message==WM_KILLFOCUS || message==WM_ENABLE)
    InvalidateRect(window,nullptr,FALSE);
  return result;
}
static LRESULT CALLBACK editProc(HWND window, UINT message, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR) {
  if(message==WM_NCCALCSIZE) {
    RECT* rect=wp?&reinterpret_cast<NCCALCSIZE_PARAMS*>(lp)->rgrc[0]:reinterpret_cast<RECT*>(lp);
    InflateRect(rect,-px(10),-px(7)); return 0;
  }
  if(message==WM_NCPAINT) {
    HDC dc=GetWindowDC(window); RECT rect; GetWindowRect(window,&rect); OffsetRect(&rect,-rect.left,-rect.top);
    // Leave the EDIT client pixels alone; Windows owns text, selection and IME.
    RECT client; GetClientRect(window,&client); ExcludeClipRect(dc,px(10),px(7),px(10)+client.right,px(7)+client.bottom);
    FillRect(dc,&rect,backgroundBrush); rounded(dc,rect,GetFocus()==window?muted:surface,8);
    InflateRect(&rect,-px(1),-px(1)); rounded(dc,rect,surface,7); ReleaseDC(window,dc); return 0;
  }
  if(message==WM_NCDESTROY) RemoveWindowSubclass(window,editProc,1);
  auto result=DefSubclassProc(window,message,wp,lp);
  if(message==WM_SETFOCUS || message==WM_KILLFOCUS) RedrawWindow(window,nullptr,nullptr,RDW_FRAME|RDW_INVALIDATE);
  return result;
}
static LRESULT CALLBACK progressProc(HWND window, UINT message, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR) {
  if(message==WM_ERASEBKGND) return 1;
  if(message==WM_PAINT) {
    PAINTSTRUCT paint; HDC dc=BeginPaint(window,&paint); RECT rect; GetClientRect(window,&rect);
    FillRect(dc,&rect,backgroundBrush); rounded(dc,rect,surface,2);
    RECT bar=rect;
    if(GetPropW(window,L"VarinMarquee")) {
      const int width=rect.right/4;
      bar.left=static_cast<int>((GetTickCount64()%1800)*(rect.right+width)/1800)-width;
      bar.right=bar.left+width;
    } else {
      PBRANGE range{}; SendMessageW(window,PBM_GETRANGE,FALSE,reinterpret_cast<LPARAM>(&range));
      const auto position=static_cast<int>(SendMessageW(window,PBM_GETPOS,0,0));
      bar.right=range.iHigh>range.iLow?MulDiv(rect.right,std::clamp(position,range.iLow,range.iHigh)-range.iLow,range.iHigh-range.iLow):0;
    }
    if(bar.right>bar.left) rounded(dc,bar,primary,2);
    EndPaint(window,&paint); return 0;
  }
  if(message==PBM_SETMARQUEE) {
    if(wp) { SetPropW(window,L"VarinMarquee",reinterpret_cast<HANDLE>(1)); SetTimer(window,1,40,nullptr); }
    else { RemovePropW(window,L"VarinMarquee"); KillTimer(window,1); }
    InvalidateRect(window,nullptr,FALSE); return 1;
  }
  if(message==WM_TIMER && wp==1) { InvalidateRect(window,nullptr,FALSE); return 0; }
  if(message==WM_NCDESTROY) { KillTimer(window,1); RemoveWindowSubclass(window,progressProc,1); }
  const auto result=DefSubclassProc(window,message,wp,lp);
  if(message==PBM_SETPOS || message==PBM_DELTAPOS || message==PBM_SETRANGE || message==PBM_SETRANGE32 || message==PBM_STEPIT)
    InvalidateRect(window,nullptr,FALSE);
  return result;
}
static BOOL CALLBACK hideChrome(HWND child, LPARAM parent) {
  if (GetParent(child) != reinterpret_cast<HWND>(parent)) return TRUE;
  const int id = GetDlgCtrlID(child);
  wchar_t type[64]{}; GetClassNameW(child, type, 64);
  if (id != IDOK && id != IDCANCEL && id != IDFRAMEMINIMIZE && id != IDFRAMECLOSE && id != 1018 && wcscmp(type, L"#32770"))
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
  // The entire popup is client-owned in both forms of client-size calculation.
  if (window==installerWindow && message==WM_NCCALCSIZE) return 0;
  if (window==installerWindow && message==WM_NCLBUTTONDBLCLK && wp==HTCAPTION) return 0;
  if (window==installerWindow && message==WM_NCHITTEST) {
    POINT point{static_cast<short>(LOWORD(lp)),static_cast<short>(HIWORD(lp))}; ScreenToClient(window,&point);
    return point.y<px(40) ? HTCAPTION : HTCLIENT;
  }
  if (window==installerWindow && message==WM_COMMAND && LOWORD(wp)==IDFRAMEMINIMIZE) { ShowWindow(window,SW_MINIMIZE); return 0; }
  if (window==installerWindow && message==WM_COMMAND && LOWORD(wp)==IDFRAMECLOSE) { PostMessageW(window,WM_CLOSE,0,0); return 0; }
  if (awaitingRetry && message == WM_COMMAND && (LOWORD(wp) == IDOK || LOWORD(wp) == IDCANCEL)) {
    retryDecision = LOWORD(wp) == IDOK ? 1 : 0;
    SetEvent(retrySignal.value);
    return 0;
  }
  if (awaitingRetry && message == WM_CLOSE) { retryDecision = 0; SetEvent(retrySignal.value); return 0; }
  if (message == WM_ERASEBKGND) {
    RECT rect; GetClientRect(window, &rect); FillRect(reinterpret_cast<HDC>(wp), &rect, backgroundBrush); return 1;
  }
  if (message==WM_PAINT) {
    PAINTSTRUCT paint; HDC dc=BeginPaint(window,&paint); RECT rect; GetClientRect(window,&rect); FillRect(dc,&rect,backgroundBrush);
    if (window==installerWindow) {
      RECT footer{px(30),px(554),px(590),px(578)};
      label(dc,versionLabel.c_str(),captionFont,muted,footer,DT_CENTER);
    } else if (GetPropW(window,L"VarinScene")) {
      const bool hero=GetPropW(window,L"VarinScene")==reinterpret_cast<HANDLE>(1);
      brand(dc,hero?280:17,hero?101:20,hero?120:32);
      RECT word=hero?RECT{0,px(176),px(560),px(236)}:RECT{px(44),0,px(240),px(40)};
      label(dc,L"Varin",hero?brandFont:smallBrandFont,foreground,word,hero?DT_CENTER:DT_LEFT);
    }
    EndPaint(window,&paint); return 0;
  }
  if (message == WM_CTLCOLORSTATIC || message == WM_CTLCOLORBTN || message == WM_CTLCOLORDLG ||
      message == WM_CTLCOLOREDIT || message == WM_CTLCOLORLISTBOX) {
    HDC dc = reinterpret_cast<HDC>(wp);
    const bool edit = message == WM_CTLCOLOREDIT || message == WM_CTLCOLORLISTBOX;
    SetTextColor(dc, GetPropW(reinterpret_cast<HWND>(lp),L"VarinMuted") ? muted : foreground); SetBkColor(dc, edit ? surface : background);
    return reinterpret_cast<LRESULT>(edit ? surfaceBrush : backgroundBrush);
  }
  if (message == WM_DRAWITEM) {
    auto* item = reinterpret_cast<DRAWITEMSTRUCT*>(lp);
    if (item->CtlType == ODT_BUTTON) {
      const bool main = item->CtlID == IDOK;
      const bool link = GetPropW(item->hwndItem,L"VarinLink") || item->CtlID==IDCANCEL;
      const bool hot = GetPropW(item->hwndItem,L"VarinHot")!=nullptr;
      const bool chrome = item->CtlID==IDFRAMEMINIMIZE || item->CtlID==IDFRAMECLOSE;
      COLORREF fill = main ? primary : link || chrome ? background : surface;
      COLORREF text = main ? onPrimary : link ? muted : foreground;
      if (hot) { fill=mix(fill,main?background:foreground,main?8:7); text=main?onPrimary:foreground; }
      if (item->itemState & ODS_SELECTED) fill=mix(fill,foreground,12);
      if (item->itemState & ODS_DISABLED) { fill = surface; text = muted; }
      FillRect(item->hDC,&item->rcItem,backgroundBrush);
      rounded(item->hDC,item->rcItem,fill,main?12:7);
      if(chrome) {
        Gdiplus::Graphics graphics(item->hDC); graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
        Gdiplus::Pen pen(ink(text),static_cast<float>(px(1)));
        const float cx=(item->rcItem.right+item->rcItem.left)/2.0f,cy=(item->rcItem.bottom+item->rcItem.top)/2.0f,d=static_cast<float>(px(5));
        if(item->CtlID==IDFRAMECLOSE) { graphics.DrawLine(&pen,cx-d,cy-d,cx+d,cy+d); graphics.DrawLine(&pen,cx-d,cy+d,cx+d,cy-d); }
        else graphics.DrawLine(&pen,cx-d,cy,cx+d,cy);
      } else {
      wchar_t label[1024]{}; GetWindowTextW(item->hwndItem, label, 1024);
      SetBkMode(item->hDC, TRANSPARENT); SetTextColor(item->hDC, text);
      auto oldFont = SelectObject(item->hDC, bodyFont);
      DrawTextW(item->hDC, label, -1, &item->rcItem, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
      SelectObject(item->hDC, oldFont);
      }
      if ((item->itemState & ODS_FOCUS) && !(item->itemState & ODS_NOFOCUSRECT)) {
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
    } else if(buttonType==BS_AUTOCHECKBOX || buttonType==BS_CHECKBOX || buttonType==BS_AUTORADIOBUTTON || buttonType==BS_RADIOBUTTON) {
      SetWindowSubclass(child,choiceProc,1,0);
    }
  } else if(wcscmp(type,L"Edit")==0 && !(GetWindowLongPtrW(child,GWL_STYLE)&ES_MULTILINE)) {
    SetWindowTheme(child,L"",L"");
    SetWindowSubclass(child,editProc,1,0);
    SetWindowLongPtrW(child,GWL_EXSTYLE,GetWindowLongPtrW(child,GWL_EXSTYLE)&~WS_EX_CLIENTEDGE);
    SetWindowPos(child,nullptr,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED);
  } else if (wcscmp(type, PROGRESS_CLASSW) == 0) {
    SetWindowTheme(child, L"", L"");
    SetWindowLongPtrW(child,GWL_STYLE,GetWindowLongPtrW(child,GWL_STYLE)&~WS_BORDER);
    SetWindowLongPtrW(child,GWL_EXSTYLE,GetWindowLongPtrW(child,GWL_EXSTYLE)&~(WS_EX_CLIENTEDGE|WS_EX_STATICEDGE));
    SetWindowSubclass(child,progressProc,1,0);
    SetWindowPos(child,nullptr,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED);
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
  versionLabel=call.pop();
  if (!backgroundBrush) {
    // Subclasses must remain executable until the installer window is destroyed.
    HMODULE module;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                      reinterpret_cast<LPCWSTR>(&Theme), &module);
    HDC dc = GetDC(parent); const int dpi = GetDeviceCaps(dc, LOGPIXELSY); ReleaseDC(parent, dc);
    scale = MulDiv(dpi, 100, 96);
    ULONG_PTR token; Gdiplus::GdiplusStartupInput input; Gdiplus::GdiplusStartup(&token,&input,nullptr);
    bodyFont = CreateFontW(-MulDiv(11, dpi, 72), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    titleFont = CreateFontW(-MulDiv(18, dpi, 72), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    brandFont=CreateFontW(-MulDiv(36,dpi,72),0,0,0,FW_SEMIBOLD,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Segoe UI");
    smallBrandFont=CreateFontW(-MulDiv(18,dpi,72),0,0,0,FW_SEMIBOLD,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Segoe UI");
    captionFont=CreateFontW(-MulDiv(9,dpi,72),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Segoe UI");
    backgroundBrush = CreateSolidBrush(background); surfaceBrush = CreateSolidBrush(surface);
    installerWindow=parent;
    SetWindowSubclass(parent,windowProc,1,0);
    const LONG_PTR style=GetWindowLongPtrW(parent,GWL_STYLE);
    // A fixed-size custom popup has no native sizing frame. Keeping THICKFRAME
    // lets Windows paint it while a folder picker disables its owner, outside
    // the activation/NC-paint paths. Dragging and minimizing don't need it.
    SetWindowLongPtrW(parent,GWL_STYLE,(style & ~(WS_CAPTION|WS_THICKFRAME|WS_MAXIMIZEBOX|DS_MODALFRAME))|WS_POPUP|WS_MINIMIZEBOX|WS_SYSMENU);
    SetWindowLongPtrW(parent,GWL_EXSTYLE,GetWindowLongPtrW(parent,GWL_EXSTYLE)&
                     ~(WS_EX_DLGMODALFRAME|WS_EX_CLIENTEDGE|WS_EX_STATICEDGE|WS_EX_WINDOWEDGE));
    SetWindowPos(parent, nullptr, 0, 0, px(620),px(588), SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED);
    const int corner=2; DwmSetWindowAttribute(parent,33,&corner,sizeof(corner));
    CreateWindowW(L"BUTTON",L"Minimize",WS_CHILD|WS_VISIBLE|BS_OWNERDRAW,px(524),px(8),px(38),px(30),parent,reinterpret_cast<HMENU>(IDFRAMEMINIMIZE),module,nullptr);
    CreateWindowW(L"BUTTON",L"Close",WS_CHILD|WS_VISIBLE|BS_OWNERDRAW,px(568),px(8),px(38),px(30),parent,reinterpret_cast<HMENU>(IDFRAMECLOSE),module,nullptr);
    BOOL dark = GetRValue(background) < 128;
    DwmSetWindowAttribute(parent, 20, &dark, sizeof(dark));
  }
  SetWindowSubclass(parent, windowProc, 1, 0);
  EnumChildWindows(parent, styleChild, 0);
  EnumChildWindows(parent, hideChrome, reinterpret_cast<LPARAM>(parent));
  EnableWindow(GetDlgItem(parent,IDFRAMECLOSE),TRUE);
  move(GetDlgItem(parent, 1018), 30, 50, 560, 396);
  move(GetDlgItem(parent, IDOK), 190, 468, 240, 48);
  move(GetDlgItem(parent, IDCANCEL), 230, 522, 160, 28);
  InvalidateRect(parent, nullptr, TRUE);
}
extern "C" __declspec(dllexport) void __cdecl Page(HWND parent, int size, wchar_t*, Stack** stack, void*) {
  Call call{size, stack};
  HWND page = reinterpret_cast<HWND>(wcstoull(call.pop().c_str(), nullptr, 0));
  const auto scene=call.pop();
  SetPropW(page,L"VarinScene",reinterpret_cast<HANDLE>(scene==L"hero"?1:2));
  move(page, 30, 50, 560, 396);
  SetWindowSubclass(page, windowProc, 1, 0);
  EnumChildWindows(page, styleChild, 0);
  EnumChildWindows(parent, hideChrome, reinterpret_cast<LPARAM>(parent));
  EnableWindow(GetDlgItem(parent,IDFRAMECLOSE),TRUE);
  InvalidateRect(page, nullptr, TRUE);
}
extern "C" __declspec(dllexport) void __cdecl Link(HWND, int size, wchar_t*, Stack** stack, void*) {
  Call call{size,stack}; HWND control=reinterpret_cast<HWND>(wcstoull(call.pop().c_str(),nullptr,0));
  SetPropW(control,L"VarinLink",reinterpret_cast<HANDLE>(1)); InvalidateRect(control,nullptr,TRUE);
}
extern "C" __declspec(dllexport) void __cdecl TextStyle(HWND, int size, wchar_t*, Stack** stack, void*) {
  Call call{size,stack}; HWND control=reinterpret_cast<HWND>(wcstoull(call.pop().c_str(),nullptr,0)); const auto role=call.pop();
  if(role.find(L"muted")!=std::wstring::npos) SetPropW(control,L"VarinMuted",reinterpret_cast<HANDLE>(1));
  else RemovePropW(control,L"VarinMuted");
  const auto style=GetWindowLongPtrW(control,GWL_STYLE);
  SetWindowLongPtrW(control,GWL_STYLE,(style & ~SS_TYPEMASK)|(role.find(L"center")!=std::wstring::npos?SS_CENTER:SS_LEFT));
  SendMessageW(control,WM_SETFONT,reinterpret_cast<WPARAM>(role.find(L"title")!=std::wstring::npos?titleFont:bodyFont),TRUE);
}
extern "C" __declspec(dllexport) void __cdecl Progress(HWND parent, int size, wchar_t*, Stack** stack, void*) {
  Call call{size, stack};
  HWND page = reinterpret_cast<HWND>(wcstoull(call.pop().c_str(), nullptr, 0));
  const auto title = call.pop(), description = call.pop(), details = call.pop(), mode = call.pop();
  move(page, 30, 50, 560, 396);
  SetPropW(page,L"VarinScene",reinterpret_cast<HANDLE>(2));
  SetWindowSubclass(page, windowProc, 1, 0); EnumChildWindows(page, styleChild, 0);
  EnumChildWindows(parent, hideChrome, reinterpret_cast<LPARAM>(parent));
  HWND heading = CreateWindowW(L"STATIC", title.c_str(), WS_CHILD | WS_VISIBLE, 0, px(70), px(560), px(42), page, reinterpret_cast<HMENU>(9001), nullptr, nullptr);
  SendMessageW(heading, WM_SETFONT, reinterpret_cast<WPARAM>(titleFont), TRUE);
  HWND sub = CreateWindowW(L"STATIC", description.c_str(), WS_CHILD | WS_VISIBLE, 0, px(117), px(560), px(40), page, reinterpret_cast<HMENU>(9002), nullptr, nullptr);
  SendMessageW(sub, WM_SETFONT, reinterpret_cast<WPARAM>(bodyFont), TRUE);
  SetPropW(sub,L"VarinMuted",reinterpret_cast<HANDLE>(1));
  move(GetDlgItem(page, 1006), 0, 194, 560, 24);
  move(GetDlgItem(page, 1016), 0, 260, 560, 132);
  move(GetDlgItem(page, 1027), 0, 224, 140, 28);
  SetPropW(GetDlgItem(page,1027),L"VarinLink",reinterpret_cast<HANDLE>(1));
  SetWindowTextW(GetDlgItem(page, 1027), details.c_str());
  move(GetDlgItem(page, 1004), 0, 177, 560, 5);
  if (mode == L"uninstall") {
    HWND progress = GetDlgItem(page, 1004);
    SetWindowLongPtrW(progress, GWL_STYLE, GetWindowLongPtrW(progress, GWL_STYLE) | PBS_MARQUEE);
    SendMessageW(progress, PBM_SETMARQUEE, TRUE, 0);
  }
  ShowWindow(GetDlgItem(parent, IDBACK), SW_HIDE);
  ShowWindow(GetDlgItem(parent,IDOK),SW_HIDE);
  EnableWindow(GetDlgItem(parent,IDFRAMECLOSE),IsWindowEnabled(GetDlgItem(parent,IDCANCEL)));
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
  BOOL nextVisible=IsWindowVisible(next), closeVisible=IsWindowVisible(close);
  const int ids[]{1004, 1006, 1016, 1027, 9002};
  BOOL visible[5]{};
  for (int i=0;i<5;++i) { visible[i]=IsWindowVisible(GetDlgItem(page,ids[i])); ShowWindow(GetDlgItem(page,ids[i]),SW_HIDE); }
  HWND message=CreateWindowExW(0,L"EDIT",detail.c_str(),WS_CHILD|WS_VISIBLE|WS_VSCROLL|ES_MULTILINE|ES_READONLY|ES_AUTOVSCROLL,
                              0,px(124),px(560),px(268),page,nullptr,nullptr,nullptr);
  SendMessageW(message,WM_SETFONT,reinterpret_cast<WPARAM>(bodyFont),TRUE);
  SetWindowTextW(heading,title.c_str()); SetWindowTextW(next,retry.c_str()); SetWindowTextW(close,cancel.c_str());
  EnableWindow(next,TRUE); EnableWindow(close,TRUE);
  ShowWindow(next,SW_SHOW); ShowWindow(close,SW_SHOW); EnableWindow(GetDlgItem(parent,IDFRAMECLOSE),TRUE);
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
  ShowWindow(next,nextVisible?SW_SHOW:SW_HIDE); ShowWindow(close,closeVisible?SW_SHOW:SW_HIDE);
  EnableWindow(GetDlgItem(parent,IDFRAMECLOSE),closeEnabled);
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
