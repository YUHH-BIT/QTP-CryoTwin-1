# -*- coding: utf-8 -*-
"""
换机自检 —— 硬盘插到新电脑后先跑这个。

    .\\.runtime\\python\\python.exe scripts\\diagnose.py
    powershell -ExecutionPolicy Bypass -File .\\diagnose.ps1

检查项：盘符 / 内嵌运行时 / 依赖 / 数据完整性 / 写入权限 / .env / 端口
只用标准库，不依赖任何项目代码，因此即便环境坏了它也能跑。
"""
import io
import os
import socket
import subprocess
import sys

# Windows 控制台默认 GBK，重定向时中文会炸，统一按 UTF-8 输出
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, '.runtime', 'python')
PY = os.path.join(RUNTIME, 'python.exe')

OK, WARN, BAD = 'ok', 'warn', 'bad'
MARKS = {OK: '[√]', WARN: '[!]', BAD: '[×]'}
COLORS = {OK: '32', WARN: '33', BAD: '31'}
_counts = {OK: 0, WARN: 0, BAD: 0}

# 运行时必须能导入的包（模块名 -> 展示名）
DEPS = [
    ('flask', 'Flask'), ('torch', 'torch'), ('rasterio', 'rasterio'),
    ('geopandas', 'geopandas'), ('shapely', 'shapely'),
    ('matplotlib', 'matplotlib'), ('pandas', 'pandas'), ('numpy', 'numpy'),
    ('dotenv', 'python-dotenv'), ('netCDF4', 'netCDF4'),
]
# 后两个缺失只影响边缘功能，降级为警告
SOFT_DEPS = {'dotenv', 'netCDF4'}

# 数据检查：相对路径 -> (展示名, 缺失时是否致命)
DATA = [
    ('data/raw/geo', '矢量底图', True),
    # 注意：config.py 里的 DEM_FILE 指向 wholeYarkant.tif，但该文件并不存在
    # （全项目也无人引用 DEM_FILE）。这里按磁盘上真实的文件名检查。
    ('data/raw/dem/TP_China_dem.tif', 'DEM', True),
    ('data/raw/models', 'LSTM 模型', True),
    ('data/raw/thresholds', '淹没阈值', True),
    ('data/processed/db', '索引数据库', True),
    ('data/raw/TibetanPlateau', 'ERA5 驱动栅格', False),
    ('data/raw/GLDAS025_Snowmelt', 'GLDAS 融雪', False),
    ('data/processed/GLDAS_snowmelt_max', '融雪极值', False),
]

# 数据下沉到 data/webgis/ 后，写入检查点同步跟随（uploads=上传、outputs=运行产物）
WRITABLE = ['data/webgis/outputs', 'data/webgis/uploads', 'data/processed']


def _color(text, code):
    if os.environ.get('NO_COLOR') or not sys.stdout.isatty():
        return text
    return '\033[%sm%s\033[0m' % (code, text)


def check(label, detail, state=OK):
    _counts[state] += 1
    line = '  %s %s' % (MARKS[state], label)
    pad = max(1, 34 - len(label) * 2 + len(label))
    print(_color(line + ' ' * pad + str(detail), COLORS[state]))
    return state


def rule():
    print('  ' + '─' * 53)


def run_py(args, timeout=120):
    """用内嵌运行时执行一段代码，失败返回 None。"""
    try:
        r = subprocess.run([PY] + args, capture_output=True, timeout=timeout,
                           env={**os.environ, 'PYTHONNOUSERSITE': '1'})
        return r.stdout.decode('utf-8', 'replace').strip() or None
    except Exception:
        return None


def count_files(path):
    if os.path.isfile(path):
        return 1
    n = 0
    for _, _, fn in os.walk(path):
        n += len(fn)
        if n > 200000:
            break
    return n


def main():
    print()
    print('  Cryo-floods 换机自检')
    rule()

    # 1. 位置
    check('项目路径', ROOT)
    check('当前盘符', '%s  (代码全部相对解析，任意盘符均可)' % ROOT[:2])

    # 2. 内嵌运行时
    if not os.path.isfile(PY):
        check('内嵌运行时', '.runtime\\python\\python.exe 缺失', BAD)
        print()
        print('  构建命令：  .\\scripts\\setup_runtime.ps1')
    else:
        ver = run_py(['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'])
        pfx = run_py(['-c', 'import sys;print(sys.prefix)'])
        if pfx and os.path.normcase(pfx) == os.path.normcase(RUNTIME):
            check('内嵌运行时', 'Python %s · 自包含' % (ver or '?'))
        else:
            check('内嵌运行时', 'Python %s · sys.prefix 异常: %s' % (ver or '?', pfx), WARN)

    # 3. 依赖
    if os.path.isfile(PY):
        rule()
        probe = (
            'import importlib.util as u, importlib.metadata as md\n'
            'mods = %r\n'
            'for m, name in mods:\n'
            '    if u.find_spec(m) is None:\n'
            '        print("MISS|%%s|未安装" %% m)\n'
            '    else:\n'
            '        try: v = md.version(name)\n'
            '        except Exception: v = "?"\n'
            '        try:\n'
            '            __import__(m); print("OK|%%s|%%s" %% (m, v))\n'
            '        except Exception as e:\n'
            '            print("BAD|%%s|导入失败: %%s" %% (m, str(e)[:40]))\n'
        ) % (DEPS,)
        out = run_py(['-c', probe]) or ''
        for line in out.splitlines():
            parts = line.split('|', 2)
            if len(parts) != 3:
                continue
            st, mod, detail = parts
            if st == 'OK':
                check('  ' + mod, detail)
            elif mod in SOFT_DEPS:
                check('  ' + mod, detail + '（仅影响边缘功能）', WARN)
            else:
                check('  ' + mod, detail, BAD)

    # 4. 数据完整性
    rule()
    for rel, name, fatal in DATA:
        full = os.path.join(ROOT, rel.replace('/', os.sep))
        if os.path.exists(full):
            check('  ' + name, '%d 个文件' % count_files(full))
        else:
            check('  ' + name, '缺失（影响%s）' % ('核心功能' if fatal else '模拟/融雪功能'),
                  BAD if fatal else WARN)

    # 5. 写入权限（移动硬盘跨机最常见的问题）
    rule()
    for rel in WRITABLE:
        d = os.path.join(ROOT, rel.replace('/', os.sep))
        if not os.path.isdir(d):
            try:
                os.makedirs(d, exist_ok=True)
                check('  写入 ' + rel.replace('/', os.sep), '已创建')
                continue
            except Exception as e:
                check('  写入 ' + rel.replace('/', os.sep), '无法创建: %s' % e, BAD)
                continue
        t = os.path.join(d, '._wtest_%d.tmp' % os.getpid())
        try:
            with open(t, 'w') as f:
                f.write('x')
            os.remove(t)
            check('  写入 ' + rel.replace('/', os.sep), '可写')
        except Exception as e:
            check('  写入 ' + rel.replace('/', os.sep), '不可写（移动盘权限问题）: %s' % e, BAD)

    # 6. .env
    rule()
    env_path = os.path.join(ROOT, '.env')
    if os.path.isfile(env_path):
        txt = open(env_path, encoding='utf-8', errors='replace').read()
        n = sum(txt.count(k) for k in ('请填写', '请修改', 'change-me'))
        if n:
            check('  .env', '存在，但仍有 %d 处占位符未填' % n, WARN)
        else:
            check('  .env', '已配置')
    else:
        check('  .env', '缺失（地图编码与冰冻圈灾害大模型不可用）', WARN)

    # 7. 端口
    port = int(os.environ.get('PORT', '5000'))
    s = socket.socket()
    s.settimeout(2)
    try:
        s.bind(('127.0.0.1', port))
        check('  端口', '%d 空闲' % port)
    except OSError:
        check('  端口', '%d 被占用（换端口： .\\run.ps1 -Port 5001）' % port, WARN)
    finally:
        s.close()

    rule()
    total = sum(_counts.values())
    summary = '  通过 %d · 警告 %d · 失败 %d  （共 %d 项）' % (
        _counts[OK], _counts[WARN], _counts[BAD], total)
    if _counts[BAD]:
        print(_color(summary, COLORS[BAD]))
    elif _counts[WARN]:
        print(_color(summary, COLORS[WARN]))
    else:
        print(_color(summary, COLORS[OK]))
    print()
    if not _counts[BAD]:
        print('  可以启动：  .\\run.ps1')
        print()
    return 1 if _counts[BAD] else 0


if __name__ == '__main__':
    sys.exit(main())
