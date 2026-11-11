# -*- coding: utf-8 -*-
"""不靠猜：直接问 Windows 外壳「你现在给这个快捷方式画什么图标」。
SHGetFileInfo 会命中外壳图标缓存，能把用户实际看到的那枚图标渲染出来。

用法：pwsh -File shell_icon_probe.ps1
产物：%TEMP%\shell_icon.png（左：桌面快捷方式，右：app-icon.ico 原始文件）
"""
$ErrorActionPreference = 'Stop'
$out = Join-Path $env:TEMP 'shell_icon.png'
$log = Join-Path $env:TEMP 'shell_icon.txt'

Add-Type -AssemblyName System.Drawing

$code = @'
using System;
using System.Runtime.InteropServices;
public class ShellIcon {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHFILEINFO {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes,
        ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr hIcon);
    public const uint SHGFI_ICON = 0x100;
    public const uint SHGFI_LARGEICON = 0x0;
    public const uint SHGFI_SMALLICON = 0x1;
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing

function Get-IconBytes([string]$path, [bool]$small) {
    $sfi = New-Object ShellIcon+SHFILEINFO
    $flags = [ShellIcon]::SHGFI_ICON
    if ($small) { $flags = $flags -bor [ShellIcon]::SHGFI_SMALLICON } else { $flags = $flags -bor [ShellIcon]::SHGFI_LARGEICON }
    $r = [ShellIcon]::SHGetFileInfo($path, 0, [ref]$sfi, [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($sfi), $flags)
    if ($sfi.hIcon -eq [IntPtr]::Zero) { return $null }
    $ico = [System.Drawing.Icon]::FromHandle($sfi.hIcon)
    $bmp = $ico.ToBitmap()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose(); $bmp.Dispose()
    [void][ShellIcon]::DestroyIcon($sfi.hIcon)
    return $bytes
}

$lnk = 'D:\桌面\青藏高原冰冻圈灾害数字孪生系统.lnk'
$ico = 'F:\QTP‑CryoTwin\assets\branding\app-icon.ico'

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("lnk exists = " + (Test-Path -LiteralPath $lnk))
$lines.Add("ico exists = " + (Test-Path -LiteralPath $ico))

$imgLnk = Get-IconBytes $lnk $false
$imgIco = Get-IconBytes $ico $false
$lines.Add("lnk 图标字节 = " + $(if ($imgLnk) { $imgLnk.Length } else { 'NULL' }))
$lines.Add("ico 图标字节 = " + $(if ($imgIco) { $imgIco.Length } else { 'NULL' }))

if ($imgLnk -and $imgIco) {
    $md5 = [System.Security.Cryptography.MD5]::Create()
    $h1 = [System.BitConverter]::ToString($md5.ComputeHash($imgLnk))
    $h2 = [System.BitConverter]::ToString($md5.ComputeHash($imgIco))
    $lines.Add("外壳图标 md5 = $h1")
    $lines.Add("文件图标 md5 = $h2")
    $lines.Add("两者相同 = " + ($h1 -eq $h2))
    $a = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(, $imgLnk)))
    $b = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(, $imgIco)))
    $S = 4
    $board = New-Object System.Drawing.Bitmap (2 * ($a.Width * $S) + 60), ($a.Height * $S + 40)
    $g = [System.Drawing.Graphics]::FromImage($board)
    $g.Clear([System.Drawing.Color]::FromArgb(238, 241, 246))
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.DrawImage($a, 20, 20, $a.Width * $S, $a.Height * $S)
    $g.DrawImage($b, ($a.Width * $S) + 40, 20, $b.Width * $S, $b.Height * $S)
    $g.Dispose()
    $board.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $lines.Add("对比图 = $out （左=外壳缓存给快捷方式画的，右=ico 文件本身）")
    $lines.Add("尺寸 = " + $a.Width + "x" + $a.Height)
}

[System.IO.File]::WriteAllLines($log, $lines, (New-Object System.Text.UTF8Encoding($false)))
"written $log"
