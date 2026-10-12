; DeskDock installer (Inno Setup 6). Per-user, no admin rights, bundles a portable Node.
; Build with scripts/make-installer.ps1, which stages the files into build/stage first.
#define AppName "DeskDock"
#define AppVersion "0.1.0"
#define AppPublisher "Reverie0123"
#define AppURL "https://github.com/Reverie0123/deskdock"
#define Stage "..\build\stage"

[Setup]
AppId={{7F1C3C2E-9C0B-4B7D-A0B9-DE5C0D0C6E11}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={localappdata}\Programs\DeskDock
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist-installer
OutputBaseFilename=DeskDock-Setup-{#AppVersion}
SetupIconFile=..\resources\deskdock.ico
UninstallDisplayIcon={app}\resources\deskdock-native.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "zh"; MessagesFile: "..\build\lang\ChineseSimplified.isl"

[CustomMessages]
en.ClientsPage=AI apps to connect
en.ClientsPageDesc=DeskDock will be added to the MCP settings of the apps you pick.
en.ClientsPageSub=Apps found on this computer are pre-selected. Others can be added later with: deskdock setup
en.OtherClients=Cherry Studio or another MCP client: copy the configuration shown at the end of setup
en.TaskStartup=Start the DeskDock tray icon when I sign in
en.RunTray=Start the DeskDock tray icon now
en.OpenPanel=Open the control panel (permissions, logs, macros)
en.NotFound=(not found on this computer)
zh.ClientsPage=要接入的 AI 软件
zh.ClientsPageDesc=DeskDock 会写进你勾选的软件的 MCP 配置里。
zh.ClientsPageSub=电脑上已装的软件已经帮你勾上。其它的以后可以用 deskdock setup 再加。
zh.OtherClients=Cherry Studio 或其它 MCP 客户端：安装结束时会显示一段配置，复制过去即可
zh.TaskStartup=登录 Windows 时自动启动 DeskDock 托盘图标
zh.RunTray=现在启动 DeskDock 托盘图标
zh.OpenPanel=打开控制面板（权限、日志、宏）
zh.NotFound=（这台电脑上没找到）

[Tasks]
Name: "startup"; Description: "{cm:TaskStartup}"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\DeskDock"; Filename: "{app}\resources\deskdock-native.exe"; IconFilename: "{app}\resources\deskdock.ico"
Name: "{autoprograms}\DeskDock Control Panel"; Filename: "{app}\deskdock.cmd"; Parameters: "panel"; IconFilename: "{app}\resources\deskdock.ico"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "DeskDock"; ValueData: """{app}\resources\deskdock-native.exe"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
; /NOSETUP=1 on the command line skips touching any AI client configuration (used by automated tests)
Filename: "{app}\deskdock.cmd"; Parameters: "setup --clients {code:SelectedClients}"; StatusMsg: "Connecting AI apps..."; Flags: runhidden waituntilterminated; Check: not NoSetup
Filename: "{app}\resources\deskdock-native.exe"; Description: "{cm:RunTray}"; Flags: postinstall nowait skipifsilent
Filename: "{app}\deskdock.cmd"; Parameters: "panel"; Description: "{cm:OpenPanel}"; Flags: postinstall nowait skipifsilent unchecked runhidden

[UninstallDelete]
Type: files; Name: "{app}\.nosetup"
Type: filesandordirs; Name: "{app}\node_modules"

[UninstallRun]
Filename: "{app}\deskdock.cmd"; Parameters: "setup --remove"; Flags: runhidden waituntilterminated; RunOnceId: "removeclients"; Check: not NoSetupMarker
Filename: "taskkill"; Parameters: "/IM deskdock-native.exe /F"; Flags: runhidden; RunOnceId: "killtray"

[Code]
var
  ClientsPage: TInputOptionWizardPage;
  ClientIds: array[0..5] of String;

function Found(Path: String): Boolean;
begin
  Result := DirExists(Path) or FileExists(Path);
end;

function NoSetup: Boolean;
begin
  Result := ExpandConstant('{param:NOSETUP|0}') = '1';
end;

// remember the choice for the uninstaller (which has no access to the install command line)
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and NoSetup then
    SaveStringToFile(ExpandConstant('{app}\.nosetup'), '1', False);
end;

function NoSetupMarker: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\.nosetup'));
end;

procedure InitializeWizard;
var
  i: Integer;
  AppData, Local, UserHome: String;
  Present: array[0..5] of Boolean;
  Labels: array[0..5] of String;
begin
  AppData := ExpandConstant('{userappdata}');
  Local := ExpandConstant('{localappdata}');
  UserHome := ExpandConstant('{%USERPROFILE}');
  ClientIds[0] := 'claude-code';    Labels[0] := 'Claude Code';
  ClientIds[1] := 'claude-desktop'; Labels[1] := 'Claude Desktop';
  ClientIds[2] := 'cursor';         Labels[2] := 'Cursor';
  ClientIds[3] := 'cline';          Labels[3] := 'Cline (VS Code)';
  ClientIds[4] := 'cline-cursor';   Labels[4] := 'Cline (Cursor)';
  ClientIds[5] := 'windsurf';       Labels[5] := 'Windsurf';
  Present[0] := Found(UserHome + '\.claude') or Found(Local + '\AnthropicClaude') or Found(AppData + '\npm\claude.cmd');
  Present[1] := Found(AppData + '\Claude');
  Present[2] := Found(UserHome + '\.cursor') or Found(Local + '\Programs\cursor');
  Present[3] := Found(AppData + '\Code\User\globalStorage\saoudrizwan.claude-dev');
  Present[4] := Found(AppData + '\Cursor\User\globalStorage\saoudrizwan.claude-dev');
  Present[5] := Found(UserHome + '\.codeium\windsurf');
  ClientsPage := CreateInputOptionPage(wpSelectDir, CustomMessage('ClientsPage'), CustomMessage('ClientsPageDesc'), CustomMessage('ClientsPageSub'), False, False);
  for i := 0 to 5 do
  begin
    if Present[i] then
      ClientsPage.Add(Labels[i])
    else
      ClientsPage.Add(Labels[i] + ' ' + CustomMessage('NotFound'));
    ClientsPage.Values[i] := Present[i];
  end;
  ClientsPage.Add(CustomMessage('OtherClients'));
  ClientsPage.Values[6] := False;
  ClientsPage.CheckListBox.ItemEnabled[6] := False;
end;

function SelectedClients(Param: String): String;
var
  i: Integer;
begin
  Result := '';
  for i := 0 to 5 do
    if ClientsPage.Values[i] then
    begin
      if Result <> '' then Result := Result + ',';
      Result := Result + ClientIds[i];
    end;
  if Result = '' then Result := 'none';
end;
