# -*- coding: utf-8 -*-
"""Syntax-check inline <script> blocks in the main pages. ASCII output."""
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FE = os.path.join(ROOT, 'webgis_frontend')

PAGES = [
    'index.html', 'query.html', 'simulate.html', 'alert.html',
    'decision.html', 'terrain3d.html', 'admin.html', 'login.html',
]

BLOCK_RE = re.compile(r'<script([^>]*)>(.*?)</script>', re.S | re.I)

# 只要出现这些，说明内联块里有 Jinja 注入或缺依赖，跳过语法检查
SKIP_MARKERS = ('{{', '{%')


def main():
    fails = 0
    total = 0
    for page in PAGES:
        path = os.path.join(FE, page)
        if not os.path.isfile(path):
            continue
        src = open(path, encoding='utf-8').read()
        for m in BLOCK_RE.finditer(src):
            attrs, body = m.group(1), m.group(2)
            if re.search(r'\bsrc\s*=', attrs, re.I):
                continue
            if not body.strip():
                continue
            if any(s in body for s in SKIP_MARKERS):
                continue
            line = src[:m.start()].count('\n') + 1
            kind = 'module' if 'module' in attrs else 'script'
            fd, tmp = tempfile.mkstemp(suffix='.js')
            os.close(fd)
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(body)
            try:
                r = subprocess.run(
                    ['node', '--check', tmp],
                    capture_output=True, text=True, encoding='utf-8', errors='replace')
                total += 1
                if r.returncode != 0:
                    fails += 1
                    first = (r.stderr or '').strip().splitlines()
                    msg = first[1] if len(first) > 1 else (first[0] if first else 'unknown')
                    print('[SYNTAX] %s line %d (%s): %s' % (page, line, kind, msg.strip()))
            finally:
                os.unlink(tmp)
    print('')
    print('inline_blocks_checked=%d fails=%d' % (total, fails))


if __name__ == '__main__':
    sys.exit(main())
