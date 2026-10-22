# -*- coding: utf-8 -*-
"""
一键启动（换机/移动硬盘场景）。

    .\\run.bat                 双击即可
    powershell -ExecutionPolicy Bypass -File .\\run.ps1
    .\\.runtime\\python\\python.exe scripts\\start.py --port 5001

启动前做四项自检，任一项致命失败就明确报错并给出修复命令：
    内嵌运行时 → 核心依赖 → .env → 端口占用
"""
import argparse
import io
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, '.runtime', 'python', 'python.exe')
APP = os.path.join(ROOT, 'webgis_backend', 'app.py')

# 启动必需的核心依赖（少了就跑不起来）
CORE_DEPS = ['flask', 'torch', 'rasterio', 'geopandas', 'shapely', 'matplotlib', 'pandas']


def port_free(port):
    s = socket.socket()
    s.settimeout(2)
    try:
        s.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def open_browser_when_ready(url, port, timeout=300):
    """等服务真正就绪再开浏览器。

    冷启动时 app.py 要 import torch/rasterio 等重依赖，实测约 1 分钟；
    原来固定 5 秒就 webbrowser.open，用户看到的是"无法访问此页面"。
    这里轮询端口，连上后再开；超时也照样开（让用户看到地址自行刷新）。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                break
        except OSError:
            time.sleep(1.0)
    webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--host', default=None)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--debug', action='store_true',
                    help='开启 Flask 调试模式（默认关闭）')
    a = ap.parse_args()

    port = a.port or int(os.environ.get('PORT', '5000'))
    url = 'http://127.0.0.1:%d/' % port

    print()
    print('  Cryo-floods 启动器')
    print('  项目路径: %s' % ROOT)
    print('  盘符    : %s' % ROOT[:2])

    # 1. 内嵌运行时
    if not os.path.isfile(PY):
        print()
        print('  [×] 未找到内嵌运行时 .runtime\\python\\python.exe')
        print('      首次在这台机器运行请先构建：')
        print('        powershell -ExecutionPolicy Bypass -File .\\scripts\\setup_runtime.ps1')
        return 1
    print('  [√] 运行时已就位')

    # 2. 核心依赖
    probe = ('import importlib.util as u\n'
             'miss=[m for m in %r if u.find_spec(m) is None]\n'
             'print(",".join(miss))') % (CORE_DEPS,)
    env = {**os.environ, 'PYTHONNOUSERSITE': '1'}
    miss = subprocess.run([PY, '-c', probe], capture_output=True,
                          env=env, timeout=180).stdout.decode().strip()
    if miss:
        print()
        print('  [×] 缺少依赖: %s' % miss)
        print('      修复： .\\.runtime\\python\\python.exe -m pip install -r requirements.lock.txt')
        return 1
    print('  [√] 依赖已就绪')

    # 3. .env
    env_file = os.path.join(ROOT, '.env')
    if not os.path.isfile(env_file):
        example = os.path.join(ROOT, '.env.example')
        if os.path.isfile(example):
            with open(example, encoding='utf-8') as f:
                body = f.read()
            with open(env_file, 'w', encoding='utf-8') as f:
                f.write(body)
            print('  [!] 已从 .env.example 生成 .env，请填 API Key 后使用地图/智能体')
        else:
            print('  [!] 缺 .env（地图编码与决策智能体不可用）')
    else:
        print('  [√] .env 已配置')

    # 4. 端口
    if not port_free(port):
        print()
        print('  [!] 端口 %d 被占用。换端口： .\\run.bat 后改用 .\\run.ps1 -Port %d' % (port, port + 1))
        print('      或先关闭占用该端口的程序，然后重试。')
        return 1
    print('  [√] 端口 %d 空闲' % port)

    # 环境隔离：不读目标机器用户目录下的 Python 包，避免版本串味
    env['PYTHONNOUSERSITE'] = '1'
    env['PYTHONUNBUFFERED'] = '1'
    env['PORT'] = str(port)
    if a.host:
        env['HOST'] = a.host
    # matplotlib 配置目录放项目内，避免往用户 Profile 写
    mpl = os.path.join(ROOT, '.runtime', 'mplconfig')
    os.makedirs(mpl, exist_ok=True)
    env['MPLCONFIGDIR'] = mpl
    # 默认关掉调试模式：Flask 的 reloader 会启动两遍进程，
    # 期间端口短暂不可连（演示时表现为"打不开页面"），且调试控制台对外暴露不安全。
    # 需要调试时用 --debug。
    env['FLASK_CONFIG'] = 'development' if a.debug else 'production'

    print()
    print('  启动中 → %s' % url)
    print('  停止服务：Ctrl+C')
    print()

    if not a.no_browser:
        threading.Thread(
            target=open_browser_when_ready,
            args=(url, port), daemon=True).start()

    try:
        return subprocess.run([PY, APP], cwd=ROOT, env=env).returncode
    except KeyboardInterrupt:
        print('\n  已停止')
        return 0


if __name__ == '__main__':
    sys.exit(main())
