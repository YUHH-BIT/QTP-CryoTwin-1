# -*- coding: utf-8 -*-
"""校验桌面快捷方式 .lnk（按 MS-SHLLINK 逐字段解析，不信 wshom/COM 回读）。

背景：项目目录名 QTP‑CryoTwin 含非断行连字符 U+2011。
WScript.Shell 回读 TargetPath 会把它显示成 `?`（ANSI 假象），
make_desktop_shortcut.ps1 里"整文件按 UTF-16 解码后 Contains"的判定也会因
IDList 段奇数字节而错位，误报 FAIL。这个脚本按结构定位 LinkInfo，结论才可靠。

用法：
    .runtime\\python\\python.exe scripts\\verify_shortcut.py "D:\\桌面\\xxx.lnk"
    （不传路径时默认项目同名快捷方式）

退出码：0 全部正确；1 有问题。
"""
import json
import os
import struct
import sys

DEFAULT_LNK = os.path.join(
    os.path.expanduser("~"), "Desktop",
    "青藏高原冰冻圈灾害数字孪生系统.lnk")


def parse(path):
    data = open(path, "rb").read()
    out = {"path": path, "bytes": len(data)}
    flags = struct.unpack("<I", data[20:24])[0]
    out["link_flags"] = hex(flags)
    is_unicode = bool(flags & 0x80)

    p = 76
    if flags & 0x01:                      # HasLinkTargetIDList
        size = struct.unpack("<H", data[p:p + 2])[0]
        p += 2 + size

    def read_cstr(offset, wide):
        b = data[offset:]
        if wide:
            i = 0
            while i + 1 < len(b) and not (b[i] == 0 and b[i + 1] == 0):
                i += 2
            return b[:i].decode("utf-16-le", errors="replace")
        end = b.find(b"\x00")
        return b[:end if end >= 0 else len(b)].decode("latin-1", errors="replace")

    if flags & 0x02:                      # HasLinkInfo
        li = p
        li_size, li_hdr, li_flags = struct.unpack("<III", data[li:li + 12])
        lbp, cps = struct.unpack("<II", data[li + 16:li + 24])
        info = {"size": li_size, "header_size": li_hdr, "flags": hex(li_flags)}
        if lbp:
            info["local_base_path_ansi"] = read_cstr(li + lbp, False)
        if li_hdr >= 0x24:
            lbpu, cpsu = struct.unpack("<II", data[li + 28:li + 36])
            if lbpu:
                info["local_base_path_unicode"] = read_cstr(li + lbpu, True)
            if cpsu:
                info["common_path_suffix_unicode"] = read_cstr(li + cpsu, True)
        out["link_info"] = info
        p = li + li_size

    strings = {}
    for key, bit in (("name", 0x04), ("relative_path", 0x08), ("working_dir", 0x10),
                     ("arguments", 0x20), ("icon_location", 0x40)):
        if flags & bit:
            n = struct.unpack("<H", data[p:p + 2])[0]
            p += 2
            if is_unicode:
                strings[key] = data[p:p + n * 2].decode("utf-16-le", errors="replace")
                p += n * 2
            else:
                strings[key] = data[p:p + n].decode("latin-1", errors="replace")
                p += n
    out["string_data"] = strings
    return out


def main():
    lnk = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LNK
    if not os.path.isfile(lnk):
        print("找不到快捷方式：%s" % lnk)
        return 1

    d = parse(lnk)
    target = d.get("link_info", {}).get("local_base_path_unicode") \
        or d.get("link_info", {}).get("local_base_path_ansi", "")
    icon = d.get("string_data", {}).get("icon_location", "")
    workdir = d.get("string_data", {}).get("working_dir", "")

    checks = {
        "快捷方式存在": True,
        "目标文件真实存在": os.path.isfile(target) if target else False,
        "目标以 run.bat 结尾": target.lower().endswith("run.bat"),
        "图标文件真实存在": bool(icon) and os.path.isfile(icon),
        "图标为 app-icon.ico": os.path.basename(icon).lower() == "app-icon.ico",
        "工作目录存在": bool(workdir) and os.path.isdir(workdir),
    }

    print(json.dumps({"目标(Unicode)": target, "图标": icon, "工作目录": workdir},
                     ensure_ascii=False, indent=1))
    print()
    for k, v in checks.items():
        print("  %-16s %s" % (k, "OK" if v else "FAIL"))
    ok = all(checks.values())
    print("\n结果: %s" % ("OK" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
