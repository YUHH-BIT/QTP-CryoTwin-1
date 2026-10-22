<#
.SYNOPSIS
    生成「青藏高原冰冻圈灾害数字孪生系统」桌面快捷方式（带品牌图标）。
.DESCRIPTION
    入口链路：桌面 .lnk → run.bat → run.ps1 → .runtime\python\python.exe scripts\start.py
    → Flask 起服务，约 5 秒后自动打开浏览器。

    ⚠ 核心坑位（2026-09-13 初版、2026-10-21 复测确认）：
      项目目录名 QTP-CryoTwin 含非断行连字符 U+2011，GBK 码位里没有这个字符。
      实测：WScript.Shell（wshom.ocx）设置 TargetPath 时会把路径按 ANSI(GBK)
      转换，U+2011 → `?`，而 `?` 是非法文件名字符 → 报「无效的过程调用或参数」
      （VBScript 运行时错误 5）。WorkingDirectory 更阴险：同样被转换，但不报错，
      静默写坏（readback 为空，Save 出一个空目标的坏 .lnk）。
      ⇒ 本机解法：把 **8.3 短路径（F:\QTPCRY~1，纯 ASCII）** 传给 WScript.Shell。
        注意：.vbs 用 UTF-16 编码只保证中文快捷方式名不乱码，治不了 U+2011，
        根因在 wshom 内部转换，不在脚本文件解码。
      若 8.3 短名称被系统禁用（fsutil 8dot3name set 1），本脚本明确报错，
      处置办法见 assets\branding\README.md（目录联接 junction 方案）。

    桌面路径不写死：本机桌面被重定向到 D:\桌面，用 SpecialFolders("Desktop") 取。

    部分代理环境（如 WorkBuddy 工具层）会拦 COM / cscript.exe / cmd.exe，
    本脚本需在真实 PowerShell 终端运行，或经 Python 子进程驱动。

.PARAMETER Name
    快捷方式显示名，默认「青藏高原冰冻圈灾害数字孪生系统」。
.EXAMPLE
    powershell -ExecutionPolicy Bypass -NoProfile -File .\scripts\make_desktop_shortcut.ps1
#>
[CmdletBinding()]
param(
    [string]$Name = '青藏高原冰冻圈灾害数字孪生系统'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $root 'run.bat'))) {
    Write-Error "项目根解析异常：$root 下没有 run.bat"
    exit 1
}
$icon = Join-Path $root 'assets\branding\app-icon.ico'
if (-not (Test-Path -LiteralPath $icon)) {
    Write-Error "缺少品牌图标：$icon（见 assets\branding\README.md）"
    exit 1
}

# ---- 解析 8.3 短路径（U+2011 过不了 wshom 的 ANSI 转换，必须走短路径）----
$sig = @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern uint GetShortPathNameW(string lpszLongPath, System.Text.StringBuilder lpszShortPath, uint cchBuffer);
'@
$api = Add-Type -MemberDefinition $sig -Name 'ShortPathApi' -Namespace 'Win32Utils' -PassThru
$sb = New-Object System.Text.StringBuilder 260
$null = $api::GetShortPathNameW($root, $sb, 260)
$short = $sb.ToString()
if (-not $short -or $short -eq $root -or $short -notmatch '~') {
    Write-Error @"
拿不到 8.3 短路径（返回: $short）。
可能原因：系统禁用了 8.3 名称生成（fsutil 8dot3name set 1）。
处置（二选一）：
  1) 放开本卷 8.3：fsutil 8dot3name set F: 0，然后重跑本脚本；
  2) 建目录联接后改用 ASCII 路径：
       cmd /c mklink /J F:\QTPCryotwin "$root"
     再把本脚本里的 $short 换成 F:\QTPCryotwin。
详见 assets\branding\README.md。
"@
    exit 1
}

# ---- 生成 UTF-16LE + BOM 的 .vbs（保证中文快捷方式名按 Unicode 解码）----
# 所有交给 WScript.Shell 的路径一律用 ASCII 短路径，避免 U+2011 被 ANSI 化。
$vbs = @'
Dim sh, desktop, lnkPath, root
root = "__ROOT__"
Set sh = CreateObject("WScript.Shell")
desktop = sh.SpecialFolders("Desktop")
lnkPath = desktop & "\__NAME__.lnk"
Set lnk = sh.CreateShortcut(lnkPath)
lnk.TargetPath = root & "\run.bat"
lnk.WorkingDirectory = root
lnk.IconLocation = root & "\assets\branding\app-icon.ico,0"
lnk.Description = "__NAME__（QTP-CryoTwin）一键启动：run.bat → 内嵌 Python → Flask"
lnk.WindowStyle = 1
lnk.Save
'@
$vbs = $vbs.Replace('__ROOT__', $short).Replace('__NAME__', $Name)

$tmpVbs = Join-Path $env:TEMP 'qtp_cryotwin_shortcut.vbs'
# .NET "Unicode" 编码 = UTF-16LE 带 BOM
[System.IO.File]::WriteAllText($tmpVbs, $vbs, [System.Text.Encoding]::Unicode)

# ---- 删除已存在的旧快捷方式（wshom 的 Save 无法覆写已存在的 .lnk）----
$sh = New-Object -ComObject WScript.Shell
$desktop = $sh.SpecialFolders('Desktop')
$lnkPath = Join-Path $desktop ($Name + '.lnk')
if (Test-Path -LiteralPath $lnkPath) {
    Remove-Item -LiteralPath $lnkPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $lnkPath) {
        Write-Error @"
无法删除已存在的快捷方式：$lnkPath
请手动删除该文件后重试（资源管理器/终端均可）。
"@
        exit 1
    }
}

# ---- 执行 cscript（子进程方式启动，避免继承本会话执行策略）----
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $env:SystemRoot 'System32\cscript.exe'
$psi.Arguments = '//nologo "' + $tmpVbs + '"'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$stdout = $proc.StandardOutput.ReadToEnd()
$stderr = $proc.StandardError.ReadToEnd()
$proc.WaitForExit()
$exitCode = $proc.ExitCode

# ---- 回读验证（直接解析 .lnk 二进制，不信 wshom 的回读属性）----
# 背景：wshom 读 TargetPath 时会把短路径展开成长路径再按 ANSI 转换，
#       U+2011 显示成 `?`（假象，磁盘上的 .lnk 是好的）。
#       且 IShellLink 展开后写入 .lnk 的 ANSI 兜底字段本身就是 `?`，
#       但 Explorer 按规范优先使用 LinkInfo 的 Unicode 字段，不受影响。
$report = New-Object System.Collections.Generic.List[string]
$report.Add('报告时间    : ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$report.Add('项目根      : ' + $root)
$report.Add('8.3 短路径  : ' + $short)
$report.Add('桌面路径    : ' + $desktop)
$report.Add('快捷方式    : ' + $lnkPath)
$report.Add('cscript 退出码: ' + $exitCode)
if ($stdout.Trim()) { $report.Add('cscript stdout: ' + $stdout.Trim()) }
if ($stderr.Trim()) { $report.Add('cscript stderr: ' + $stderr.Trim()) }

$ok = $false
if (-not (Test-Path -LiteralPath $lnkPath)) {
    $report.Add('结果: FAIL —— 快捷方式未生成')
}
else {
    $bytes = [System.IO.File]::ReadAllBytes($lnkPath)
    $u16 = [System.Text.Encoding]::Unicode.GetString($bytes)
    $targetWide = Join-Path $root 'run.bat'                          # 真实长路径（含 U+2011）
    $targetShort = Join-Path $short 'run.bat'                        # ASCII 短路径
    $iconReal = Join-Path $root 'assets\branding\app-icon.ico'

    $hasTarget = $u16.Contains($targetWide) -or $u16.Contains($targetShort)
    $hasIcon = $u16.Contains('app-icon.ico')
    $targetOk = Test-Path -LiteralPath $targetWide
    $iconOk = Test-Path -LiteralPath $iconReal

    $report.Add('目标(长)写入 : ' + $u16.Contains($targetWide))
    $report.Add('目标(短)写入 : ' + $u16.Contains($targetShort))
    $report.Add('图标路径写入 : ' + $hasIcon)
    $report.Add('目标可解析   : ' + $targetOk)
    $report.Add('图标可解析   : ' + $iconOk)
    $report.Add('说明: ANSI 兜底字段含 ? 属预期（Explorer 按规范优先用 Unicode 字段）；' +
                'wshom 回读 TargetPath 显示 ? 是 ANSI 假象，不代表磁盘内容。')

    $ok = ($exitCode -eq 0 -and $hasTarget -and $hasIcon -and $targetOk -and $iconOk)
    $report.Add('结果: ' + $(if ($ok) { 'OK' } else { 'FAIL' }))
}

$reportFile = Join-Path $env:TEMP 'qtp_shortcut_report.txt'
[System.IO.File]::WriteAllLines($reportFile, $report, [System.Text.Encoding]::UTF8)
$report | ForEach-Object { Write-Output $_ }
Write-Output ('REPORT_FILE=' + $reportFile)

# 清理临时 .vbs（成功才删，失败留着排查）
if ($ok) { Remove-Item -LiteralPath $tmpVbs -Force -ErrorAction SilentlyContinue }

if (-not $ok) { exit 1 }
exit 0
