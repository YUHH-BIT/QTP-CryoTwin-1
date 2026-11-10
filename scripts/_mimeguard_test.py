# -*- coding: utf-8 -*-
"""验证 app.py 的 MIME 兜底：先人为抹掉 .js/.css/.json 的映射（模拟精简
Linux 缺 /etc/mime.types），再 import app，看响应头是否仍为正确类型。"""
import mimetypes, sys, os

for ext in ('.js', '.mjs', '.css', '.json', '.bin'):
    mimetypes.types_map.pop(ext, None)
    mimetypes.common_types.pop(ext, None)

print("[1] 抹掉映射后 guess_type:",
      {e: mimetypes.guess_type('x' + e)[0] for e in ('.js', '.mjs', '.css', '.json')})

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'webgis_backend'))
import app as appmod  # 触发 app.py 顶部的 MIME 强制注册

print("[2] import app 后 guess_type:",
      {e: mimetypes.guess_type('x' + e)[0] for e in ('.js', '.mjs', '.css', '.json')})

import werkzeug
if not hasattr(werkzeug, '__version__'):
    # werkzeug 3.1 移除了 __version__，而 flask 2.3 的 test_client 仍在读它
    werkzeug.__version__ = '3.1.3'

c = appmod.app.test_client()
for p in ('/terrain3d/demo/app.js', '/terrain3d/demo/flood.js',
          '/terrain3d/demo/styles.css', '/terrain3d/demo/data/meta.json',
          '/terrain3d/demo/data/height.bin'):
    r = c.get(p)
    print("[3] %-34s %s  %s" % (p, r.status_code, r.headers.get('Content-Type')))
