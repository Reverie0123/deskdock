// DeskDock helper: the only process that touches Win32.
// Protocol: one JSON request per line on stdin -> one JSON response per line on stdout.
//   request : {"id":1,"op":"list_windows","args":{...}}
//   response: {"id":1,"ok":true,"result":{...}} | {"id":1,"ok":false,"error":"..."}
#include <algorithm>
using std::min; using std::max;
#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>
#include <uiautomation.h>
#include <dwmapi.h>
#include <oleacc.h>
#include <servprov.h>
#include <shlwapi.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <string>
#include <vector>
#include <map>
#include <thread>
#include <future>
#include <chrono>
#include <mutex>
#include <iostream>
#include <stdexcept>
#include "json.hpp"

using json = nlohmann::json;
using namespace std::chrono;

// ---------- encoding helpers ----------
static std::string w2u(const wchar_t* w, int len = -1) {
    if (!w) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, len, nullptr, 0, nullptr, nullptr);
    if (n <= 0) return "";
    std::string s(n, 0);
    WideCharToMultiByte(CP_UTF8, 0, w, len, &s[0], n, nullptr, nullptr);
    if (len == -1 && !s.empty() && s.back() == 0) s.pop_back();
    return s;
}
static std::string b2u(BSTR b) { return b ? w2u(b, SysStringLen(b)) : ""; }
static std::wstring u2w(const std::string& s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}
static std::string base64(const unsigned char* data, size_t len) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out; out.reserve((len + 2) / 3 * 4);
    for (size_t i = 0; i < len; i += 3) {
        unsigned v = data[i] << 16 | (i + 1 < len ? data[i + 1] << 8 : 0) | (i + 2 < len ? data[i + 2] : 0);
        out += tbl[(v >> 18) & 63]; out += tbl[(v >> 12) & 63];
        out += i + 1 < len ? tbl[(v >> 6) & 63] : '=';
        out += i + 2 < len ? tbl[v & 63] : '=';
    }
    return out;
}
static json rectJson(const RECT& r) { return {{"x", r.left}, {"y", r.top}, {"w", r.right - r.left}, {"h", r.bottom - r.top}}; }

// ---------- windows ----------
static std::string processName(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return "";
    wchar_t buf[MAX_PATH * 2]; DWORD n = MAX_PATH * 2;
    std::string s;
    if (QueryFullProcessImageNameW(h, 0, buf, &n)) { s = w2u(PathFindFileNameW(buf)); }
    CloseHandle(h);
    return s;
}
static bool isCloaked(HWND h) {
    DWORD cloaked = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(h, DWMWA_CLOAKED, &cloaked, sizeof(cloaked)))) return cloaked != 0;
    return false;
}
static RECT frameRect(HWND h) {
    RECT r{};
    if (FAILED(DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof(r)))) GetWindowRect(h, &r);
    return r;
}
// UWP / packaged apps are hosted by ApplicationFrameHost.exe: the real app owns the CoreWindow child.
static DWORD realPid(HWND h, DWORD pid) {
    wchar_t cls[128] = L""; GetClassNameW(h, cls, 128);
    if (wcscmp(cls, L"ApplicationFrameWindow") != 0) return pid;
    struct S { DWORD host; DWORD found; } st{ pid, pid };
    EnumChildWindows(h, [](HWND c, LPARAM lp) -> BOOL {
        wchar_t cc[128] = L""; GetClassNameW(c, cc, 128);
        if (wcscmp(cc, L"Windows.UI.Core.CoreWindow") == 0) {
            DWORD cp = 0; GetWindowThreadProcessId(c, &cp);
            if (cp && cp != ((S*)lp)->host) { ((S*)lp)->found = cp; return FALSE; }
        }
        return TRUE;
    }, (LPARAM)&st);
    return st.found;
}
static json windowJson(HWND h) {
    wchar_t title[512] = L"", cls[256] = L"";
    GetWindowTextW(h, title, 512); GetClassNameW(h, cls, 256);
    DWORD pid = 0; GetWindowThreadProcessId(h, &pid);
    pid = realPid(h, pid);
    return {
        {"hwnd", (long long)(intptr_t)h}, {"title", w2u(title)}, {"class", w2u(cls)},
        {"pid", (long long)pid}, {"process", processName(pid)}, {"rect", rectJson(frameRect(h))},
        {"minimized", IsIconic(h) != 0}, {"focused", GetForegroundWindow() == h}
    };
}
static json listWindows(const json&) {
    json out = json::array();
    EnumWindows([](HWND h, LPARAM p) -> BOOL {
        if (!IsWindowVisible(h) || isCloaked(h)) return TRUE;
        wchar_t cls[128] = L""; GetClassNameW(h, cls, 128);
        // Title-less system surfaces the model still needs: taskbar, tray overflow, context menus, popups.
        static const wchar_t* keep[] = { L"Shell_TrayWnd", L"Shell_SecondaryTrayWnd", L"NotifyIconOverflowWindow", L"TopLevelWindowForOverflowXamlIsland", L"#32768", L"Xaml_WindowedPopupClass", L"Windows.UI.Core.CoreWindow" };
        bool whitelisted = false; for (auto k : keep) if (wcscmp(cls, k) == 0) whitelisted = true;
        if (GetWindowTextLengthW(h) == 0 && !whitelisted) return TRUE;
        LONG ex = GetWindowLongW(h, GWL_EXSTYLE);
        if ((ex & WS_EX_TOOLWINDOW) && !whitelisted) return TRUE;
        ((json*)p)->push_back(windowJson(h));
        return TRUE;
    }, (LPARAM)&out);
    return out;
}
static json windowAt(const json& a) {
    POINT pt{ a.at("x").get<int>(), a.at("y").get<int>() };
    HWND h = WindowFromPoint(pt);
    if (!h) throw std::runtime_error("no window at that point");
    HWND top = GetAncestor(h, GA_ROOT);
    return windowJson(top ? top : h);
}
static json foregroundWindow(const json&) {
    HWND h = GetForegroundWindow();
    if (!h) throw std::runtime_error("no foreground window");
    return windowJson(h);
}
static HWND hwndArg(const json& a, const char* key = "hwnd") {
    if (!a.contains(key) || a[key].is_null()) return nullptr;
    HWND h = (HWND)(intptr_t)a[key].get<long long>();
    if (!IsWindow(h)) throw std::runtime_error("window no longer exists");
    return h;
}
static json focusWindow(const json& a) {
    HWND h = hwndArg(a);
    if (!h) throw std::runtime_error("hwnd required");
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    // Windows refuses SetForegroundWindow from background processes unless we attach to the foreground thread.
    DWORD fgThread = GetWindowThreadProcessId(GetForegroundWindow(), nullptr), me = GetCurrentThreadId();
    if (fgThread && fgThread != me) AttachThreadInput(fgThread, me, TRUE);
    BOOL ok = SetForegroundWindow(h);
    BringWindowToTop(h);
    if (fgThread && fgThread != me) AttachThreadInput(fgThread, me, FALSE);
    if (!ok) { // fallback: simulate an Alt press to unlock foreground rights
        INPUT in[2] = {}; in[0].type = in[1].type = INPUT_KEYBOARD; in[0].ki.wVk = in[1].ki.wVk = VK_MENU; in[1].ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(2, in, sizeof(INPUT)); ok = SetForegroundWindow(h);
    }
    Sleep(50);
    return {{"focused", GetForegroundWindow() == h}, {"window", windowJson(h)}};
}

static json closeWindow(const json& a) {
    HWND h = hwndArg(a);
    if (!h) throw std::runtime_error("hwnd required");
    json before = windowJson(h);
    PostMessageW(h, WM_CLOSE, 0, 0);
    Sleep(300);
    return {{"window", before}, {"closed", !IsWindow(h)}};
}
// ---------- screenshot ----------
static ULONG_PTR g_gdiToken = 0;
static int encoderClsid(const wchar_t* mime, CLSID* clsid) {
    UINT num = 0, size = 0; Gdiplus::GetImageEncodersSize(&num, &size); if (!size) return -1;
    std::vector<unsigned char> buf(size); auto* info = (Gdiplus::ImageCodecInfo*)buf.data();
    Gdiplus::GetImageEncoders(num, size, info);
    for (UINT i = 0; i < num; i++) if (wcscmp(info[i].MimeType, mime) == 0) { *clsid = info[i].Clsid; return (int)i; }
    return -1;
}
static json screenshot(const json& a) {
    HWND h = hwndArg(a);
    double scale = a.value("scale", 1.0);
    if (scale <= 0 || scale > 1) scale = 1.0;
    RECT r;
    if (h) r = frameRect(h);
    else r = { GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
               GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN),
               GetSystemMetrics(SM_YVIRTUALSCREEN) + GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    int w = r.right - r.left, hgt = r.bottom - r.top;
    if (w <= 0 || hgt <= 0) throw std::runtime_error("window has no visible area (minimized?)");
    HDC screen = GetDC(nullptr); HDC mem = CreateCompatibleDC(screen);
    HBITMAP bmp = CreateCompatibleBitmap(screen, w, hgt); HGDIOBJ old = SelectObject(mem, bmp);
    bool ok = false;
    if (h) {
        // PW_RENDERFULLCONTENT (2) captures DirectComposition / GPU-rendered windows too.
        ok = PrintWindow(h, mem, 2) != 0;
        // PrintWindow draws relative to the window rect, not the DWM frame rect; realign if they differ.
        RECT wr; GetWindowRect(h, &wr);
        if (ok && (wr.left != r.left || wr.top != r.top)) {
            HBITMAP bmp2 = CreateCompatibleBitmap(screen, w, hgt); HDC mem2 = CreateCompatibleDC(screen); HGDIOBJ o2 = SelectObject(mem2, bmp2);
            BitBlt(mem2, 0, 0, w, hgt, mem, r.left - wr.left, r.top - wr.top, SRCCOPY);
            SelectObject(mem2, o2); DeleteDC(mem2); SelectObject(mem, old); DeleteObject(bmp); bmp = bmp2; old = SelectObject(mem, bmp);
        }
    }
    if (!ok) ok = BitBlt(mem, 0, 0, w, hgt, screen, r.left, r.top, SRCCOPY | CAPTUREBLT) != 0;
    SelectObject(mem, old); DeleteDC(mem); ReleaseDC(nullptr, screen);
    if (!ok) { DeleteObject(bmp); throw std::runtime_error("capture failed"); }

    Gdiplus::Bitmap* src = Gdiplus::Bitmap::FromHBITMAP(bmp, nullptr);
    Gdiplus::Bitmap* img = src;
    int ow = w, oh = hgt;
    if (scale < 1.0) {
        ow = max(1, (int)(w * scale)); oh = max(1, (int)(hgt * scale));
        img = new Gdiplus::Bitmap(ow, oh, PixelFormat24bppRGB);
        Gdiplus::Graphics g(img); g.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic); g.DrawImage(src, 0, 0, ow, oh);
    }
    CLSID png; if (encoderClsid(L"image/png", &png) < 0) throw std::runtime_error("png encoder missing");
    IStream* stream = nullptr; CreateStreamOnHGlobal(nullptr, TRUE, &stream);
    img->Save(stream, &png, nullptr);
    HGLOBAL hg = nullptr; GetHGlobalFromStream(stream, &hg);
    STATSTG st{}; stream->Stat(&st, STATFLAG_NONAME); size_t len = (size_t)st.cbSize.QuadPart;
    auto* p = (unsigned char*)GlobalLock(hg);
    std::string b64 = base64(p, len);
    GlobalUnlock(hg); stream->Release();
    if (img != src) delete img;
    delete src; DeleteObject(bmp);
    return {{"png_base64", b64}, {"width", ow}, {"height", oh}, {"origin", {{"x", r.left}, {"y", r.top}}}, {"scale", scale}};
}

// ---------- input ----------
static void sendInputs(std::vector<INPUT>& v) {
    if (v.empty()) return;
    UINT n = SendInput((UINT)v.size(), v.data(), sizeof(INPUT));
    if (n != v.size()) throw std::runtime_error("SendInput was blocked (elevated window in front?)");
}
static INPUT mouseAbs(int x, int y, DWORD flags) {
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    INPUT in{}; in.type = INPUT_MOUSE;
    in.mi.dx = (LONG)(((double)(x - vx) * 65535.0) / (vw - 1) + 0.5);
    in.mi.dy = (LONG)(((double)(y - vy) * 65535.0) / (vh - 1) + 0.5);
    in.mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | flags;
    return in;
}
static void buttonFlags(const std::string& b, DWORD& down, DWORD& up) {
    if (b == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
    else if (b == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
    else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }
}
static json mouseMove(const json& a) {
    std::vector<INPUT> v{ mouseAbs(a.at("x"), a.at("y"), MOUSEEVENTF_MOVE) }; sendInputs(v);
    POINT p; GetCursorPos(&p); return {{"x", p.x}, {"y", p.y}};
}
static json click(const json& a) {
    int x = a.at("x"), y = a.at("y"); int count = a.value("count", 1); DWORD down, up; buttonFlags(a.value("button", "left"), down, up);
    std::vector<INPUT> v{ mouseAbs(x, y, MOUSEEVENTF_MOVE) }; sendInputs(v); Sleep(20);
    for (int i = 0; i < count; i++) {
        std::vector<INPUT> c{ mouseAbs(x, y, down), mouseAbs(x, y, up) }; sendInputs(c);
        if (i + 1 < count) Sleep(60);
    }
    return {{"x", x}, {"y", y}, {"button", a.value("button", "left")}, {"count", count}};
}
static json drag(const json& a) {
    int x1 = a.at("x1"), y1 = a.at("y1"), x2 = a.at("x2"), y2 = a.at("y2"); DWORD down, up; buttonFlags(a.value("button", "left"), down, up);
    std::vector<INPUT> v{ mouseAbs(x1, y1, MOUSEEVENTF_MOVE) }; sendInputs(v); Sleep(30);
    std::vector<INPUT> d{ mouseAbs(x1, y1, down) }; sendInputs(d); Sleep(60);
    const int steps = 12;
    for (int i = 1; i <= steps; i++) { std::vector<INPUT> m{ mouseAbs(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, MOUSEEVENTF_MOVE) }; sendInputs(m); Sleep(15); }
    std::vector<INPUT> u{ mouseAbs(x2, y2, up) }; sendInputs(u);
    return {{"from", {{"x", x1}, {"y", y1}}}, {"to", {{"x", x2}, {"y", y2}}}};
}
static json scroll(const json& a) {
    int x = a.at("x"), y = a.at("y"); int dy = a.value("dy", 0), dx = a.value("dx", 0);
    std::vector<INPUT> v{ mouseAbs(x, y, MOUSEEVENTF_MOVE) }; sendInputs(v); Sleep(20);
    std::vector<INPUT> s;
    if (dy) { INPUT in{}; in.type = INPUT_MOUSE; in.mi.dwFlags = MOUSEEVENTF_WHEEL; in.mi.mouseData = (DWORD)(-dy * WHEEL_DELTA); s.push_back(in); }
    if (dx) { INPUT in{}; in.type = INPUT_MOUSE; in.mi.dwFlags = MOUSEEVENTF_HWHEEL; in.mi.mouseData = (DWORD)(dx * WHEEL_DELTA); s.push_back(in); }
    sendInputs(s);
    return {{"x", x}, {"y", y}, {"dx", dx}, {"dy", dy}};
}
static json typeText(const json& a) {
    std::wstring w = u2w(a.at("text").get<std::string>());
    std::vector<INPUT> v;
    for (wchar_t c : w) {
        if (c == L'\n') { // Enter instead of a unicode LF, which most apps ignore
            INPUT d{}; d.type = INPUT_KEYBOARD; d.ki.wVk = VK_RETURN; v.push_back(d); INPUT u = d; u.ki.dwFlags = KEYEVENTF_KEYUP; v.push_back(u); continue;
        }
        if (c == L'\r') continue;
        INPUT d{}; d.type = INPUT_KEYBOARD; d.ki.wScan = c; d.ki.dwFlags = KEYEVENTF_UNICODE; v.push_back(d);
        INPUT u = d; u.ki.dwFlags |= KEYEVENTF_KEYUP; v.push_back(u);
    }
    // send in chunks so long texts don't overflow the input queue
    for (size_t i = 0; i < v.size(); i += 64) { std::vector<INPUT> chunk(v.begin() + i, v.begin() + min(v.size(), i + 64)); sendInputs(chunk); Sleep(5); }
    return {{"chars", (long long)w.size()}};
}
static WORD vkFromName(std::string k) {
    std::transform(k.begin(), k.end(), k.begin(), ::tolower);
    static const std::map<std::string, WORD> m = {
        {"ctrl", VK_CONTROL}, {"control", VK_CONTROL}, {"alt", VK_MENU}, {"shift", VK_SHIFT}, {"win", VK_LWIN}, {"meta", VK_LWIN}, {"cmd", VK_LWIN},
        {"enter", VK_RETURN}, {"return", VK_RETURN}, {"tab", VK_TAB}, {"esc", VK_ESCAPE}, {"escape", VK_ESCAPE}, {"space", VK_SPACE},
        {"backspace", VK_BACK}, {"delete", VK_DELETE}, {"del", VK_DELETE}, {"insert", VK_INSERT}, {"home", VK_HOME}, {"end", VK_END},
        {"pageup", VK_PRIOR}, {"pagedown", VK_NEXT}, {"up", VK_UP}, {"down", VK_DOWN}, {"left", VK_LEFT}, {"right", VK_RIGHT},
        {"capslock", VK_CAPITAL}, {"printscreen", VK_SNAPSHOT}, {"apps", VK_APPS}, {"menu", VK_APPS},
        {"f1", VK_F1}, {"f2", VK_F2}, {"f3", VK_F3}, {"f4", VK_F4}, {"f5", VK_F5}, {"f6", VK_F6}, {"f7", VK_F7}, {"f8", VK_F8}, {"f9", VK_F9}, {"f10", VK_F10}, {"f11", VK_F11}, {"f12", VK_F12},
        {"plus", VK_OEM_PLUS}, {"minus", VK_OEM_MINUS}, {"comma", VK_OEM_COMMA}, {"period", VK_OEM_PERIOD},
    };
    auto it = m.find(k); if (it != m.end()) return it->second;
    if (k.size() == 1) { SHORT s = VkKeyScanW((wchar_t)k[0]); if (s != -1) return (WORD)(s & 0xff); }
    throw std::runtime_error("unknown key: " + k);
}
static json pressKeys(const json& a) {
    std::string combo = a.at("keys").get<std::string>();
    int repeat = a.value("repeat", 1);
    std::vector<std::string> parts; std::string cur;
    for (char c : combo) { if (c == '+' && !cur.empty()) { parts.push_back(cur); cur.clear(); } else cur += c; }
    if (!cur.empty()) parts.push_back(cur);
    if (parts.empty()) throw std::runtime_error("keys required");
    std::vector<WORD> vks; for (auto& p : parts) vks.push_back(vkFromName(p));
    for (int r = 0; r < repeat; r++) {
        std::vector<INPUT> v;
        for (WORD vk : vks) { INPUT d{}; d.type = INPUT_KEYBOARD; d.ki.wVk = vk; d.ki.wScan = (WORD)MapVirtualKeyW(vk, MAPVK_VK_TO_VSC); v.push_back(d); }
        for (auto it = vks.rbegin(); it != vks.rend(); ++it) { INPUT u{}; u.type = INPUT_KEYBOARD; u.ki.wVk = *it; u.ki.wScan = (WORD)MapVirtualKeyW(*it, MAPVK_VK_TO_VSC); u.ki.dwFlags = KEYEVENTF_KEYUP; v.push_back(u); }
        sendInputs(v); if (r + 1 < repeat) Sleep(40);
    }
    return {{"keys", combo}, {"repeat", repeat}};
}
static json clipboardGet(const json&) {
    if (!OpenClipboard(nullptr)) throw std::runtime_error("clipboard busy");
    std::string text; bool has = false;
    if (HANDLE h = GetClipboardData(CF_UNICODETEXT)) { auto* p = (wchar_t*)GlobalLock(h); if (p) { text = w2u(p); has = true; GlobalUnlock(h); } }
    CloseClipboard();
    return {{"text", text}, {"hasText", has}};
}
static json clipboardSet(const json& a) {
    std::wstring w = u2w(a.at("text").get<std::string>());
    if (!OpenClipboard(nullptr)) throw std::runtime_error("clipboard busy");
    EmptyClipboard();
    HGLOBAL hg = GlobalAlloc(GMEM_MOVEABLE, (w.size() + 1) * sizeof(wchar_t));
    memcpy(GlobalLock(hg), w.c_str(), (w.size() + 1) * sizeof(wchar_t)); GlobalUnlock(hg);
    SetClipboardData(CF_UNICODETEXT, hg); CloseClipboard();
    return {{"chars", (long long)w.size()}};
}
static json cursorPos(const json&) { POINT p; GetCursorPos(&p); return {{"x", p.x}, {"y", p.y}}; }
static json screenInfo(const json&) {
    json mons = json::array();
    EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR m, HDC, LPRECT, LPARAM p) -> BOOL {
        MONITORINFOEXW mi{}; mi.cbSize = sizeof(mi); GetMonitorInfoW(m, &mi);
        UINT dpi = 96;
        { typedef HRESULT(WINAPI* F)(HMONITOR, int, UINT*, UINT*); static F f = (F)GetProcAddress(LoadLibraryW(L"shcore.dll"), "GetDpiForMonitor"); UINT dy; if (f) f(m, 0, &dpi, &dy); }
        ((json*)p)->push_back({{"name", w2u(mi.szDevice)}, {"rect", rectJson(mi.rcMonitor)}, {"work", rectJson(mi.rcWork)}, {"primary", (mi.dwFlags & MONITORINFOF_PRIMARY) != 0}, {"dpi", dpi}, {"scale", dpi / 96.0}});
        return TRUE;
    }, (LPARAM)&mons);
    return {{"virtual", {{"x", GetSystemMetrics(SM_XVIRTUALSCREEN)}, {"y", GetSystemMetrics(SM_YVIRTUALSCREEN)}, {"w", GetSystemMetrics(SM_CXVIRTUALSCREEN)}, {"h", GetSystemMetrics(SM_CYVIRTUALSCREEN)}}}, {"monitors", mons}};
}

// ---------- UI Automation (always on a worker thread with a timeout) ----------
static const char* controlTypeName(CONTROLTYPEID t) {
    switch (t) {
        case 50000: return "button"; case 50001: return "calendar"; case 50002: return "checkbox"; case 50003: return "combobox"; case 50004: return "edit";
        case 50005: return "hyperlink"; case 50006: return "image"; case 50007: return "listitem"; case 50008: return "list"; case 50009: return "menu";
        case 50010: return "menubar"; case 50011: return "menuitem"; case 50012: return "progressbar"; case 50013: return "radiobutton"; case 50014: return "scrollbar";
        case 50015: return "slider"; case 50016: return "spinner"; case 50017: return "statusbar"; case 50018: return "tab"; case 50019: return "tabitem";
        case 50020: return "text"; case 50021: return "toolbar"; case 50022: return "tooltip"; case 50023: return "tree"; case 50024: return "treeitem";
        case 50025: return "custom"; case 50026: return "group"; case 50027: return "thumb"; case 50028: return "datagrid"; case 50029: return "dataitem";
        case 50030: return "document"; case 50031: return "splitbutton"; case 50032: return "window"; case 50033: return "pane"; case 50034: return "header";
        case 50035: return "headeritem"; case 50036: return "table"; case 50037: return "titlebar"; case 50038: return "separator"; case 50039: return "semanticzoom"; case 50040: return "appbar";
        default: return "unknown";
    }
}
struct RefEntry { std::vector<int> runtimeId; HWND hwnd; RECT rect; };
static std::mutex g_refMutex; static std::map<int, RefEntry> g_refs; static int g_nextRef = 1;

template <class F> static json withTimeout(F fn, int timeoutMs) {
    auto task = std::make_shared<std::packaged_task<json()>>([fn]() {
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        json r;
        try { r = fn(); } catch (...) { CoUninitialize(); throw; }
        CoUninitialize(); return r;
    });
    auto fut = task->get_future();
    std::thread([task]() { (*task)(); }).detach();
    if (fut.wait_for(milliseconds(timeoutMs)) != std::future_status::ready)
        throw std::runtime_error("UI Automation timed out after " + std::to_string(timeoutMs) + " ms (the app may not expose its UI tree; use screenshot instead)");
    return fut.get();
}
struct ComPtrUA {
    IUIAutomation* p = nullptr;
    ComPtrUA() { CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUIAutomation), (void**)&p); if (!p) throw std::runtime_error("UIAutomation unavailable"); }
    ~ComPtrUA() { if (p) p->Release(); }
};
static std::vector<int> runtimeIdOf(IUIAutomationElement* el) {
    SAFEARRAY* sa = nullptr; std::vector<int> v;
    if (SUCCEEDED(el->GetRuntimeId(&sa)) && sa) {
        int* d = nullptr; SafeArrayAccessData(sa, (void**)&d); LONG lb, ub; SafeArrayGetLBound(sa, 1, &lb); SafeArrayGetUBound(sa, 1, &ub);
        for (LONG i = lb; i <= ub; i++) v.push_back(d[i - lb]);
        SafeArrayUnaccessData(sa); SafeArrayDestroy(sa);
    }
    return v;
}
static void walk(IUIAutomation* ua, IUIAutomationTreeWalker* walker, IUIAutomationElement* el, int depth, int maxDepth, int& budget, json& out, HWND hwnd, bool interactiveOnly) {
    if (!el || depth > maxDepth || budget <= 0) return;
    BSTR name = nullptr, cls = nullptr, aid = nullptr; CONTROLTYPEID ct = 0; RECT rc{}; BOOL enabled = TRUE, offscreen = FALSE, focusable = FALSE;
    el->get_CurrentName(&name); el->get_CurrentClassName(&cls); el->get_CurrentAutomationId(&aid); el->get_CurrentControlType(&ct); el->get_CurrentBoundingRectangle(&rc);
    el->get_CurrentIsEnabled(&enabled); el->get_CurrentIsOffscreen(&offscreen); el->get_CurrentIsKeyboardFocusable(&focusable);
    std::string type = controlTypeName(ct), nm = b2u(name);
    bool structural = (type == "pane" || type == "group" || type == "custom" || type == "window" || type == "unknown") && nm.empty();
    bool interactive = focusable || type == "button" || type == "edit" || type == "checkbox" || type == "combobox" || type == "hyperlink" || type == "listitem" || type == "menuitem" || type == "radiobutton" || type == "tabitem" || type == "treeitem" || type == "slider" || type == "splitbutton";
    bool include = !structural && (!interactiveOnly || interactive || type == "text" || type == "document");
    if (include) {
        int ref;
        { std::lock_guard<std::mutex> lk(g_refMutex); ref = g_nextRef++; g_refs[ref] = { runtimeIdOf(el), hwnd, rc }; }
        json node = {{"ref", ref}, {"depth", depth}, {"type", type}, {"name", nm}, {"rect", rectJson(rc)}};
        if (!enabled) node["enabled"] = false;
        if (offscreen) node["offscreen"] = true;
        if (focusable) node["focusable"] = true;
        std::string a = b2u(aid); if (!a.empty()) node["automationId"] = a;
        IUIAutomationValuePattern* vp = nullptr; el->GetCurrentPatternAs(UIA_ValuePatternId, __uuidof(IUIAutomationValuePattern), (void**)&vp);
        if (vp) { BSTR v = nullptr; vp->get_CurrentValue(&v); std::string vs = b2u(v); if (!vs.empty()) node["value"] = vs.size() > 2000 ? vs.substr(0, 2000) + "..." : vs; if (v) SysFreeString(v); vp->Release(); }
        IUIAutomationSelectionPattern* sp = nullptr; el->GetCurrentPatternAs(UIA_SelectionPatternId, __uuidof(IUIAutomationSelectionPattern), (void**)&sp);
        if (sp) {
            IUIAutomationElementArray* sel = nullptr; sp->GetCurrentSelection(&sel);
            if (sel) { int n = 0; sel->get_Length(&n); std::string names;
                for (int i = 0; i < n && i < 5; i++) { IUIAutomationElement* se = nullptr; sel->GetElement(i, &se); if (se) { BSTR sn = nullptr; se->get_CurrentName(&sn); if (!names.empty()) names += " | "; names += b2u(sn); if (sn) SysFreeString(sn); se->Release(); } }
                if (n > 0) node["selected"] = names; sel->Release(); }
            sp->Release();
        }
        if (!node.contains("value")) {
            IUIAutomationLegacyIAccessiblePattern* lp = nullptr; el->GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId, __uuidof(IUIAutomationLegacyIAccessiblePattern), (void**)&lp);
            if (lp) { BSTR lv = nullptr; lp->get_CurrentValue(&lv); std::string ls = b2u(lv); if (!ls.empty() && ls != nm) node["value"] = ls.size() > 2000 ? ls.substr(0, 2000) + "..." : ls; if (lv) SysFreeString(lv); lp->Release(); }
        }
        IUIAutomationTogglePattern* tp = nullptr; el->GetCurrentPatternAs(UIA_TogglePatternId, __uuidof(IUIAutomationTogglePattern), (void**)&tp);
        if (tp) { ToggleState ts; tp->get_CurrentToggleState(&ts); node["checked"] = ts == ToggleState_On ? "on" : ts == ToggleState_Off ? "off" : "mixed"; tp->Release(); }
        out.push_back(node); budget--;
    }
    if (name) SysFreeString(name);
    if (cls) SysFreeString(cls);
    if (aid) SysFreeString(aid);
    IUIAutomationElement* child = nullptr; walker->GetFirstChildElement(el, &child);
    while (child && budget > 0) {
        walk(ua, walker, child, include ? depth + 1 : depth, maxDepth, budget, out, hwnd, interactiveOnly);
        IUIAutomationElement* next = nullptr; walker->GetNextSiblingElement(child, &next); child->Release(); child = next;
    }
    if (child) child->Release();
}
// Chromium/Electron: the top-level HWND exposes only the browser chrome (Views). Web content lives under
// child windows of class Chrome_RenderWidgetHostHWND, so those are read separately. Asking the MSAA root for
// IAccessible2 is the signal screen readers send; some builds switch their tree on after seeing it.
static const GUID IID_IAccessible2_ = {0xE89F726E,0xC4F4,0x4c19,{0xBB,0x19,0xB6,0x47,0xD7,0xFA,0x84,0x78}};
static void knockChromium(HWND top) {
    IAccessible* acc = nullptr;
    if (SUCCEEDED(AccessibleObjectFromWindow(top, OBJID_CLIENT, IID_IAccessible, (void**)&acc)) && acc) {
        IServiceProvider* sp = nullptr; acc->QueryInterface(IID_IServiceProvider, (void**)&sp);
        if (sp) { IUnknown* ia2 = nullptr; sp->QueryService(IID_IAccessible2_, IID_IAccessible2_, (void**)&ia2); if (ia2) ia2->Release(); sp->Release(); }
        acc->Release();
    }
    SendMessageTimeoutW(top, WM_GETOBJECT, 0, (LPARAM)1, SMTO_ABORTIFHUNG, 300, nullptr); // honeypot id used by Chromium's screen-reader detection
}
static std::vector<HWND> renderChildren(HWND top) {
    std::vector<HWND> v;
    EnumChildWindows(top, [](HWND c, LPARAM p) -> BOOL {
        wchar_t cls[128] = L""; GetClassNameW(c, cls, 128);
        if (wcsstr(cls, L"Chrome_RenderWidgetHostHWND")) ((std::vector<HWND>*)p)->push_back(c);
        return TRUE;
    }, (LPARAM)&v);
    return v;
}
static bool isChromiumWindow(HWND top) {
    wchar_t cls[128] = L""; GetClassNameW(top, cls, 128);
    return wcsstr(cls, L"Chrome_WidgetWin") != nullptr;
}
static json uiaSnapshot(const json& a) {
    HWND h = hwndArg(a); if (!h) h = GetForegroundWindow();
    int maxDepth = a.value("maxDepth", 12), maxNodes = a.value("maxNodes", 400), timeoutMs = a.value("timeoutMs", 4000);
    bool interactiveOnly = a.value("interactiveOnly", false);
    return withTimeout([=]() {
        ComPtrUA ua;
        bool chromium = isChromiumWindow(h);
        if (chromium) knockChromium(h);
        json nodes = json::array(); int budget = maxNodes;
        { std::lock_guard<std::mutex> lk(g_refMutex); g_refs.clear(); g_nextRef = 1; }
        IUIAutomationTreeWalker* walker = nullptr; ua.p->get_ControlViewWalker(&walker);
        auto readRoot = [&](HWND root_hwnd, int startDepth) {
            IUIAutomationElement* root = nullptr;
            if (FAILED(ua.p->ElementFromHandle(root_hwnd, &root)) || !root) return;
            walk(ua.p, walker, root, startDepth, maxDepth, budget, nodes, root_hwnd, interactiveOnly);
            root->Release();
        };
        readRoot(h, 0);
        int contentNodes = 0;
        if (chromium) {
            size_t before = nodes.size();
            for (HWND rc : renderChildren(h)) { if (budget <= 0) break; readRoot(rc, 1); }
            contentNodes = (int)(nodes.size() - before);
        }
        walker->Release();
        json out = {{"window", windowJson(h)}, {"nodes", nodes}, {"truncated", budget <= 0}};
        if (chromium) { out["chromium"] = true; out["contentNodes"] = contentNodes; }
        return out;
    }, timeoutMs);
}
static IUIAutomationElement* findByRef(IUIAutomation* ua, int ref, RefEntry& entry) {
    { std::lock_guard<std::mutex> lk(g_refMutex); auto it = g_refs.find(ref); if (it == g_refs.end()) throw std::runtime_error("unknown ref (take a new snapshot)"); entry = it->second; }
    if (!IsWindow(entry.hwnd)) throw std::runtime_error("window closed");
    IUIAutomationElement* root = nullptr; ua->ElementFromHandle(entry.hwnd, &root); if (!root) throw std::runtime_error("window not accessible");
    SAFEARRAY* sa = SafeArrayCreateVector(VT_I4, 0, (ULONG)entry.runtimeId.size());
    for (LONG i = 0; i < (LONG)entry.runtimeId.size(); i++) SafeArrayPutElement(sa, &i, &entry.runtimeId[i]);
    VARIANT v; v.vt = VT_I4 | VT_ARRAY; v.parray = sa;
    IUIAutomationCondition* cond = nullptr; ua->CreatePropertyCondition(UIA_RuntimeIdPropertyId, v, &cond);
    IUIAutomationElement* el = nullptr; root->FindFirst(TreeScope_Subtree, cond, &el);
    cond->Release(); SafeArrayDestroy(sa); root->Release();
    if (!el) throw std::runtime_error("element disappeared (take a new snapshot)");
    return el;
}
static json refWindow(const json& a) {
    int ref = a.at("ref"); RefEntry e;
    { std::lock_guard<std::mutex> lk(g_refMutex); auto it = g_refs.find(ref); if (it == g_refs.end()) throw std::runtime_error("unknown ref (take a new snapshot)"); e = it->second; }
    if (!IsWindow(e.hwnd)) throw std::runtime_error("window closed");
    return windowJson(e.hwnd);
}
static CONTROLTYPEID controlTypeFromName(const std::string& n) {
    for (int id = 50000; id <= 50040; id++) if (n == controlTypeName(id)) return id;
    return 0;
}
static json nodeOf(IUIAutomationElement* el, HWND hwnd, int depth) {
    BSTR name = nullptr, aid = nullptr; CONTROLTYPEID ct = 0; RECT rc{}; BOOL enabled = TRUE, offscreen = FALSE, focusable = FALSE;
    el->get_CurrentName(&name); el->get_CurrentAutomationId(&aid); el->get_CurrentControlType(&ct); el->get_CurrentBoundingRectangle(&rc);
    el->get_CurrentIsEnabled(&enabled); el->get_CurrentIsOffscreen(&offscreen); el->get_CurrentIsKeyboardFocusable(&focusable);
    int ref; { std::lock_guard<std::mutex> lk(g_refMutex); ref = g_nextRef++; g_refs[ref] = { runtimeIdOf(el), hwnd, rc }; }
    json node = {{"ref", ref}, {"depth", depth}, {"type", controlTypeName(ct)}, {"name", b2u(name)}, {"rect", rectJson(rc)}};
    if (!enabled) node["enabled"] = false;
    if (offscreen) node["offscreen"] = true;
    if (focusable) node["focusable"] = true;
    std::string a = b2u(aid); if (!a.empty()) node["automationId"] = a;
    IUIAutomationValuePattern* vp = nullptr; el->GetCurrentPatternAs(UIA_ValuePatternId, __uuidof(IUIAutomationValuePattern), (void**)&vp);
    if (vp) { BSTR v = nullptr; vp->get_CurrentValue(&v); std::string vs = b2u(v); if (!vs.empty()) node["value"] = vs.size() > 2000 ? vs.substr(0, 2000) + "..." : vs; if (v) SysFreeString(v); vp->Release(); }
    if (name) SysFreeString(name);
    if (aid) SysFreeString(aid);
    return node;
}
// Find one control in a window by name / type / automationId (used by macros, where refs from an old snapshot are gone).
static json uiaFind(const json& a) {
    HWND h = hwndArg(a); if (!h) h = GetForegroundWindow();
    std::string name = a.value("name", ""), type = a.value("type", ""), aid = a.value("automationId", "");
    bool contains = a.value("nameContains", false);
    int timeoutMs = a.value("timeoutMs", 4000);
    if (name.empty() && type.empty() && aid.empty()) throw std::runtime_error("give name, type or automationId");
    return withTimeout([=]() {
        ComPtrUA ua;
        if (isChromiumWindow(h)) knockChromium(h);
        std::vector<IUIAutomationCondition*> conds;
        if (!type.empty()) { CONTROLTYPEID ct = controlTypeFromName(type); if (!ct) throw std::runtime_error("unknown control type: " + type); VARIANT v; v.vt = VT_I4; v.lVal = ct; IUIAutomationCondition* c = nullptr; ua.p->CreatePropertyCondition(UIA_ControlTypePropertyId, v, &c); conds.push_back(c); }
        if (!aid.empty()) { std::wstring w = u2w(aid); VARIANT v; v.vt = VT_BSTR; v.bstrVal = SysAllocString(w.c_str()); IUIAutomationCondition* c = nullptr; ua.p->CreatePropertyCondition(UIA_AutomationIdPropertyId, v, &c); SysFreeString(v.bstrVal); conds.push_back(c); }
        if (!name.empty() && !contains) { std::wstring w = u2w(name); VARIANT v; v.vt = VT_BSTR; v.bstrVal = SysAllocString(w.c_str()); IUIAutomationCondition* c = nullptr; ua.p->CreatePropertyCondition(UIA_NamePropertyId, v, &c); SysFreeString(v.bstrVal); conds.push_back(c); }
        IUIAutomationCondition* cond = nullptr;
        if (conds.empty()) ua.p->CreateTrueCondition(&cond);
        else if (conds.size() == 1) cond = conds[0];
        else { SAFEARRAY* sa = SafeArrayCreateVector(VT_UNKNOWN, 0, (ULONG)conds.size()); for (LONG i = 0; i < (LONG)conds.size(); i++) SafeArrayPutElement(sa, &i, conds[i]); ua.p->CreateAndConditionFromArray(sa, &cond); SafeArrayDestroy(sa); for (auto c : conds) c->Release(); }
        std::vector<HWND> roots{ h }; for (HWND rc : renderChildren(h)) roots.push_back(rc);
        json best = nullptr, fallback = nullptr; int checked = 0;
        for (HWND root_hwnd : roots) {
            IUIAutomationElement* root = nullptr; if (FAILED(ua.p->ElementFromHandle(root_hwnd, &root)) || !root) continue;
            IUIAutomationElementArray* arr = nullptr; root->FindAll(TreeScope_Subtree, cond, &arr);
            if (arr) {
                int n = 0; arr->get_Length(&n);
                for (int i = 0; i < n && best.is_null(); i++) {
                    IUIAutomationElement* e = nullptr; arr->GetElement(i, &e); if (!e) continue; checked++;
                    BSTR nm = nullptr; e->get_CurrentName(&nm); std::string ns = b2u(nm); if (nm) SysFreeString(nm);
                    bool ok = name.empty() || (contains ? ns.find(name) != std::string::npos : ns == name);
                    if (ok) { json node = nodeOf(e, root_hwnd, 0); if (node.value("offscreen", false)) { if (fallback.is_null()) fallback = node; } else best = node; }
                    e->Release();
                }
                arr->Release();
            }
            root->Release();
            if (!best.is_null()) break;
        }
        cond->Release();
        if (best.is_null()) best = fallback;
        if (best.is_null()) throw std::runtime_error("no control matched (checked " + std::to_string(checked) + " candidates)");
        return json{{"window", windowJson(h)}, {"node", best}};
    }, timeoutMs);
}
static json refNode(const json& a) {
    int ref = a.at("ref"); int timeoutMs = a.value("timeoutMs", 4000);
    return withTimeout([=]() { ComPtrUA ua; RefEntry e; IUIAutomationElement* el = findByRef(ua.p, ref, e); json n = nodeOf(el, e.hwnd, 0); el->Release(); return json{{"window", windowJson(e.hwnd)}, {"node", n}}; }, timeoutMs);
}
static json uiaAction(const json& a, const std::string& action) {
    int ref = a.at("ref"); int timeoutMs = a.value("timeoutMs", 4000);
    std::string text = a.value("text", "");
    bool physical = a.value("physical", false);
    std::string button = a.value("button", "left"); int count = a.value("count", 1);
    return withTimeout([=]() {
        ComPtrUA ua; RefEntry e; IUIAutomationElement* el = findByRef(ua.p, ref, e);
        RECT rc{}; el->get_CurrentBoundingRectangle(&rc); json out = {{"ref", ref}, {"rect", rectJson(rc)}};
        if (action == "focus") { el->SetFocus(); out["action"] = "focus"; }
        else if (action == "setValue") {
            IUIAutomationValuePattern* vp = nullptr; el->GetCurrentPatternAs(UIA_ValuePatternId, __uuidof(IUIAutomationValuePattern), (void**)&vp);
            if (!vp) { el->Release(); throw std::runtime_error("element has no value pattern; click it and use type instead"); }
            std::wstring w = u2w(text); BSTR b = SysAllocStringLen(w.c_str(), (UINT)w.size()); HRESULT hr = vp->SetValue(b); SysFreeString(b); vp->Release();
            if (FAILED(hr)) { el->Release(); throw std::runtime_error("SetValue failed (read-only?)"); }
            out["action"] = "setValue";
        } else { // click: prefer Invoke, else a real mouse click on the clickable point
            IUIAutomationInvokePattern* ip = nullptr; el->GetCurrentPatternAs(UIA_InvokePatternId, __uuidof(IUIAutomationInvokePattern), (void**)&ip);
            if (ip && !physical && button == "left" && count == 1) { ip->Invoke(); ip->Release(); out["action"] = "invoke"; }
            else {
                if (ip) ip->Release();
                POINT pt; BOOL got = FALSE; el->GetClickablePoint(&pt, &got);
                if (!got) { pt.x = (rc.left + rc.right) / 2; pt.y = (rc.top + rc.bottom) / 2; }
                if (rc.right <= rc.left) { el->Release(); throw std::runtime_error("element has no on-screen area"); }
                json c = {{"x", pt.x}, {"y", pt.y}, {"button", button}, {"count", count}};
                click(c); out["action"] = "click"; out["x"] = pt.x; out["y"] = pt.y;
            }
        }
        el->Release(); return out;
    }, timeoutMs);
}

// ---------- main loop ----------
static json dispatch(const std::string& op, const json& a) {
    if (op == "ping") return {{"pong", true}, {"pid", (long long)GetCurrentProcessId()}};
    if (op == "list_windows") return listWindows(a);
    if (op == "focus_window") return focusWindow(a);
    if (op == "window_at") return windowAt(a);
    if (op == "close_window") return closeWindow(a);
    if (op == "foreground_window") return foregroundWindow(a);
    if (op == "screenshot") return screenshot(a);
    if (op == "screen_info") return screenInfo(a);
    if (op == "cursor_pos") return cursorPos(a);
    if (op == "mouse_move") return mouseMove(a);
    if (op == "click") return click(a);
    if (op == "drag") return drag(a);
    if (op == "scroll") return scroll(a);
    if (op == "type") return typeText(a);
    if (op == "key") return pressKeys(a);
    if (op == "clipboard_get") return clipboardGet(a);
    if (op == "clipboard_set") return clipboardSet(a);
    if (op == "uia_snapshot") return uiaSnapshot(a);
    if (op == "ref_window") return refWindow(a);
    if (op == "uia_find") return uiaFind(a);
    if (op == "ref_node") return refNode(a);
    if (op == "uia_click") return uiaAction(a, "click");
    if (op == "uia_focus") return uiaAction(a, "focus");
    if (op == "uia_set_value") return uiaAction(a, "setValue");
    throw std::runtime_error("unknown op: " + op);
}
int main() {
    _setmode(_fileno(stdout), _O_BINARY); _setmode(_fileno(stdin), _O_BINARY);
    { typedef BOOL(WINAPI* F)(HANDLE); auto f = (F)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext"); if (f) f((HANDLE)-4 /*PER_MONITOR_AWARE_V2*/); }
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    Gdiplus::GdiplusStartupInput gsi; Gdiplus::GdiplusStartup(&g_gdiToken, &gsi, nullptr);
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        json resp; json id = nullptr;
        try {
            json req = json::parse(line); id = req.value("id", json(nullptr));
            std::string op = req.at("op").get<std::string>(); json args = req.value("args", json::object());
            resp = {{"id", id}, {"ok", true}, {"result", dispatch(op, args)}};
        } catch (const std::exception& e) { resp = {{"id", id}, {"ok", false}, {"error", e.what()}}; }
        std::string s = resp.dump(); s += '\n';
        fwrite(s.data(), 1, s.size(), stdout); fflush(stdout);
    }
    Gdiplus::GdiplusShutdown(g_gdiToken); CoUninitialize();
    return 0;
}
