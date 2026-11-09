# -*- coding: utf-8 -*-
"""吉隆孪生演示页的本地静态服务器（多线程）。

为什么不用 `python -m http.server`：本目录的 data/ 与 lib/ 会被浏览器并发拉取
（1001² DEM、8192×4617 影像、三张 three.js、echarts、Cesium 瓦片……）。
单线程的 socketserver.TCPServer 一次只能服务一个连接，排队被拒时浏览器报
ERR_CONNECTION_REFUSED，表现为「贴图加载失败」「图表区域空白」。
ThreadingHTTPServer 才能稳住。

用法：python tools/serve.py [端口]
默认 http://127.0.0.1:8765/
"""
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # 演示期改样式/脚本后即时生效，不依赖 ?v= 版本号
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    with Server(("127.0.0.1", PORT), handler) as httpd:
        print(f"serving {ROOT} on http://127.0.0.1:{PORT}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
