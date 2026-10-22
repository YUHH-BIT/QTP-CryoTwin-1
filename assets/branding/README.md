# 品牌图标（桌面快捷方式 / 可复用为 favicon）

- `app-icon.ico` — 当前生效的多尺寸图标（16/24/32/48/64/128/256）
- `app-icon.png` — 512px 主图，可用于文档、汇报封面
- `app-icon-a|b|c.ico` — 三个候选方案：a 低多边形网格雪山（当前默认）、b 雪花等值线、c 风险刻度环
- `make_app_icon.py` — 生成脚本，纯 PIL 绘制，无外部依赖

## 重新生成 / 换方案

```powershell
.\.runtime\python\python.exe assets\branding\make_app_icon.py --outdir assets\branding --default a
```

`--default` 换成 `b` 或 `c` 即可切换；桌面快捷方式需要同步更新图标路径（见下）。

## 桌面快捷方式（系统入口）

一键启动链路：

    桌面 .lnk → run.bat → run.ps1 → .runtime\python\python.exe scripts\start.py
    → Flask 起服务 → 端口就绪后自动打开浏览器

- 生成 / 重建：`powershell -ExecutionPolicy Bypass -NoProfile -File .\scripts\make_desktop_shortcut.ps1`
- 位置：`D:\桌面\青藏高原冰冻圈灾害数字孪生系统.lnk`
  （桌面被重定向到 `D:\桌面`，脚本用 `SpecialFolders("Desktop")` 取真实路径，不写死；
  项目搬家/改名后重跑脚本即可重建）
- 图标：`app-icon.ico`（index 0）。favicon 与此同源——`webgis_backend/app.py` 的
  `/favicon.ico` 直接发这个文件。

### 为什么必须用 8.3 短路径（2026-10-21 实测确认）

项目目录名 `QTP‑CryoTwin` 含非断行连字符 U+2011，GBK 码位里没有这个字符。
WScript.Shell（wshom.ocx）设置路径属性时会把路径按 ANSI(GBK) 转换：

- `TargetPath` 含 U+2011 → 直接报「无效的过程调用或参数」（VBScript 运行时错误 5），建不出来；
- `WorkingDirectory` 含 U+2011 → **不报错但静默写坏**（readback 为空，Save 出一个空目标的 .lnk）。

⇒ 构建脚本把 `F:\QTPCRY~1\run.bat` 这类纯 ASCII 短路径喂给 wshom。wshom/IShellLink 随后
会把短路径展开成长路径，正确写进 .lnk 的 LinkInfo Unicode 字段和 IDList，Explorer 走这两条，
功能正常。已知残留、均无害：

- .lnk 的 LinkInfo **ANSI 兜底字段**是 `F:\QTP?CryoTwin\run.bat`——MS-SHLLINK 规范要求
  Explorer 优先使用 Unicode 字段，不会走 ANSI；
- 用 `WScript.Shell` 回读 `TargetPath` 会显示 `?`（读取时展开+ANSI 化），是显示假象，
  不代表磁盘内容。验证请直接解析 .lnk 二进制（构建脚本内置该检查，报告落
  `%TEMP%\qtp_shortcut_report.txt`）。

若系统禁用了 8.3 名称生成（`fsutil 8dot3name set 1`），脚本会明确报错；处置办法（放开本卷
8.3，或建目录联接 `F:\QTPCryotwin` 后改用 ASCII 路径）见脚本内提示。

> 注：把 .vbs 存成 UTF-16 只能救中文快捷方式名不乱码，救不了 U+2011——根因在 wshom
> 内部转换，不在脚本文件解码（该假设已于 2026-10-21 证伪，勿再走弯路）。
