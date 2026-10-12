// DeskDock tray: a notification-area icon with a small menu. No UI framework; talks to the engine through files:
//   %APPDATA%\deskdock\panel.json  -> where the control panel is listening (written by the MCP server / `deskdock panel`)
//   %APPDATA%\deskdock\paused      -> exists while the user paused DeskDock from the tray (the MCP server refuses all tools)
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <string>
#include <cstdio>

#define WM_TRAY (WM_APP + 1)
enum { ID_OPEN = 1, ID_PAUSE, ID_LOGS, ID_EXIT };
static NOTIFYICONDATAW g_nid{};
static bool g_zh = false;
static std::wstring g_dir;        // %APPDATA%\deskdock
static std::wstring g_exeDir;     // folder of this exe (resources/)

static std::wstring appDataDir() {
    wchar_t buf[MAX_PATH]; if (FAILED(SHGetFolderPathW(nullptr, CSIDL_APPDATA, nullptr, 0, buf))) return L".";
    return std::wstring(buf) + L"\\deskdock";
}
static bool fileExists(const std::wstring& p) { DWORD a = GetFileAttributesW(p.c_str()); return a != INVALID_FILE_ATTRIBUTES; }
static std::wstring pausedPath() { return g_dir + L"\\paused"; }
static bool isPaused() { return fileExists(pausedPath()); }
static void setPaused(bool on) {
    if (on) { HANDLE h = CreateFileW(pausedPath().c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr); if (h != INVALID_HANDLE_VALUE) CloseHandle(h); }
    else DeleteFileW(pausedPath().c_str());
}
static std::string readFile(const std::wstring& p) {
    HANDLE h = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return "";
    char buf[4096]; DWORD n = 0; std::string s; while (ReadFile(h, buf, sizeof buf, &n, nullptr) && n) s.append(buf, n); CloseHandle(h); return s;
}
// minimal extraction of "url":"..." and "pid":N from panel.json (no JSON library needed here)
static std::string jsonString(const std::string& j, const char* key) {
    std::string k = std::string("\"") + key + "\":\""; size_t i = j.find(k); if (i == std::string::npos) return ""; i += k.size(); size_t e = j.find('"', i); return e == std::string::npos ? "" : j.substr(i, e - i);
}
static DWORD jsonNumber(const std::string& j, const char* key) {
    std::string k = std::string("\"") + key + "\":"; size_t i = j.find(k); if (i == std::string::npos) return 0; return (DWORD)strtoul(j.c_str() + i + k.size(), nullptr, 10);
}
static bool processAlive(DWORD pid) {
    if (!pid) return false; HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid); if (!h) return false;
    DWORD code = 0; bool alive = GetExitCodeProcess(h, &code) && code == STILL_ACTIVE; CloseHandle(h); return alive;
}
static std::string panelUrl() {
    std::string j = readFile(g_dir + L"\\panel.json");
    if (j.empty()) return "";
    if (!processAlive(jsonNumber(j, "pid"))) return "";
    return jsonString(j, "url");
}
static void startPanel() {
    // resources/deskdock-tray.exe -> ../dist/index.js ; works for a checkout and for node_modules/deskdock
    std::wstring entry = g_exeDir + L"\\..\\dist\\index.js";
    std::wstring cmd = L"node \"" + entry + L"\" panel --no-open";
    STARTUPINFOW si{}; si.cb = sizeof si; si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE; PROCESS_INFORMATION pi{};
    if (CreateProcessW(nullptr, &cmd[0], nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
}
static void openPanel() {
    std::string url = panelUrl();
    if (url.empty()) { startPanel(); for (int i = 0; i < 20 && url.empty(); i++) { Sleep(250); url = panelUrl(); } }
    if (url.empty()) { MessageBoxW(nullptr, g_zh ? L"控制面板没有启动。请确认已安装 Node.js，或手动运行 deskdock panel。" : L"The control panel did not start. Make sure Node.js is installed, or run deskdock panel manually.", L"DeskDock", MB_ICONWARNING); return; }
    std::wstring w(url.begin(), url.end());
    ShellExecuteW(nullptr, L"open", w.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}
static HICON g_icon = nullptr;
static HICON appIcon() {
    if (!g_icon) {
        std::wstring ico = g_exeDir + L"\\deskdock.ico";
        int cx = GetSystemMetrics(SM_CXSMICON), cy = GetSystemMetrics(SM_CYSMICON);
        g_icon = (HICON)LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(1), IMAGE_ICON, cx, cy, 0); // embedded
        if (!g_icon) g_icon = (HICON)LoadImageW(nullptr, ico.c_str(), IMAGE_ICON, cx, cy, LR_LOADFROMFILE);
        if (!g_icon) g_icon = LoadIconW(nullptr, IDI_APPLICATION);
    }
    return g_icon;
}
static void updateTip() {
    std::wstring tip = isPaused() ? (g_zh ? L"DeskDock（已暂停）" : L"DeskDock (paused)") : (g_zh ? L"DeskDock 桌面扩展坞" : L"DeskDock");
    wcsncpy(g_nid.szTip, tip.c_str(), 127); g_nid.uFlags = NIF_TIP | NIF_SHOWTIP | NIF_ICON | NIF_MESSAGE;
    g_nid.hIcon = isPaused() ? LoadIconW(nullptr, IDI_WARNING) : appIcon();
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}
static void showMenu(HWND hwnd) {
    HMENU m = CreatePopupMenu();
    AppendMenuW(m, MF_STRING, ID_OPEN, g_zh ? L"打开控制面板" : L"Open control panel");
    AppendMenuW(m, MF_STRING | (isPaused() ? MF_CHECKED : 0), ID_PAUSE, g_zh ? L"暂停 DeskDock" : L"Pause DeskDock");
    AppendMenuW(m, MF_STRING, ID_LOGS, g_zh ? L"打开日志目录" : L"Open log folder");
    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(m, MF_STRING, ID_EXIT, g_zh ? L"退出" : L"Exit");
    SetMenuDefaultItem(m, ID_OPEN, FALSE);
    POINT pt; GetCursorPos(&pt); SetForegroundWindow(hwnd);
    TrackPopupMenu(m, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, 0, hwnd, nullptr);
    PostMessageW(hwnd, WM_NULL, 0, 0); DestroyMenu(m);
}
static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_TRAY: {
        // NOTIFYICON_VERSION_4: the event is in the low word of lParam, the icon id in the high word
        UINT ev = LOWORD(lp);
        if (ev == WM_RBUTTONUP || ev == WM_CONTEXTMENU) showMenu(hwnd);
        else if (ev == WM_LBUTTONDBLCLK || ev == NIN_KEYSELECT) openPanel();
        return 0;
    }
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_OPEN: openPanel(); break;
        case ID_PAUSE: setPaused(!isPaused()); updateTip(); break;
        case ID_LOGS: { std::wstring logs = g_dir + L"\\logs"; CreateDirectoryW(g_dir.c_str(), nullptr); CreateDirectoryW(logs.c_str(), nullptr); ShellExecuteW(nullptr, L"open", logs.c_str(), nullptr, nullptr, SW_SHOWNORMAL); break; }
        case ID_EXIT: DestroyWindow(hwnd); break;
        }
        return 0;
    case WM_TIMER: { static bool last = false; bool now = isPaused(); if (now != last) { last = now; updateTip(); } return 0; }
    case WM_DESTROY: KillTimer(hwnd, 1); Shell_NotifyIconW(NIM_DELETE, &g_nid); PostQuitMessage(0); return 0;
    }
    if (msg == RegisterWindowMessageW(L"TaskbarCreated")) { Shell_NotifyIconW(NIM_ADD, &g_nid); updateTip(); return 0; } // explorer restarted
    return DefWindowProcW(hwnd, msg, wp, lp);
}
int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int) {
    HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\DeskDockTray"); if (GetLastError() == ERROR_ALREADY_EXISTS) return 0;
    g_zh = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE;
    g_dir = appDataDir(); CreateDirectoryW(g_dir.c_str(), nullptr);
    wchar_t exe[MAX_PATH]; GetModuleFileNameW(nullptr, exe, MAX_PATH); g_exeDir = exe; g_exeDir = g_exeDir.substr(0, g_exeDir.find_last_of(L"\\/"));
    WNDCLASSW wc{}; wc.lpfnWndProc = wndProc; wc.hInstance = hInst; wc.lpszClassName = L"DeskDockTray"; RegisterClassW(&wc);
    HWND hwnd = CreateWindowW(wc.lpszClassName, L"DeskDock", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, hInst, nullptr);
    g_nid.cbSize = sizeof g_nid; g_nid.hWnd = hwnd; g_nid.uID = 1; g_nid.uCallbackMessage = WM_TRAY; g_nid.uVersion = NOTIFYICON_VERSION_4;
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP; g_nid.hIcon = appIcon();
    wcsncpy(g_nid.szTip, g_zh ? L"DeskDock 桌面扩展坞" : L"DeskDock", 127); // the tip doubles as the accessible name of the icon
    Shell_NotifyIconW(NIM_ADD, &g_nid); Shell_NotifyIconW(NIM_SETVERSION, &g_nid); updateTip();
    SetTimer(hwnd, 1, 2000, nullptr); // the paused marker can be changed by the panel or scripts; keep the icon in sync
    MSG m; while (GetMessageW(&m, nullptr, 0, 0) > 0) { TranslateMessage(&m); DispatchMessageW(&m); }
    ReleaseMutex(mutex); CloseHandle(mutex);
    return 0;
}
