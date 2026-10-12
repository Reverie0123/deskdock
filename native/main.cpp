// One executable, two modes:
//   deskdock-native.exe --helper   -> the engine (JSON lines over stdin/stdout; started by the Node MCP server)
//   deskdock-native.exe            -> the tray icon (what a user double-clicks)
// Built as a GUI-subsystem program so the helper never flashes a console window; the Node side hands it pipes.
#include "helper/helper.cpp"
// system headers the tray needs must be included outside the namespace
#include <shellapi.h>
#include <shlobj.h>
namespace tray {
#include "tray/tray.cpp"
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR cmdLine, int nShow) {
    int argc = 0; LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    bool helper = false;
    for (int i = 1; i < argc; i++) if (wcscmp(argv[i], L"--helper") == 0) helper = true;
    if (argv) LocalFree(argv);
    if (helper) return helperMain();
    return tray::wWinMain(hInst, hPrev, cmdLine, nShow);
}
