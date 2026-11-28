# -*- coding: utf-8 -*-
"""One-off health check for webgis_frontend pages. ASCII output only."""
import os
import sys
from collections import Counter
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FE = os.path.join(ROOT, 'webgis_frontend')

PAGES = [
    'index.html', 'query.html', 'simulate.html', 'alert.html',
    'decision.html', 'terrain3d.html', 'admin.html', 'login.html',
]

SKIP_PREFIX = ('http://', 'https://', '//', 'data:', 'javascript:', '#', 'mailto:', 'tel:')


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = []
        self.refs = []          # (tag, attr, value, line)
        self.scripts = []
        self.links = []
        self.dup_attr = []
        self.open_tags = []

    def handle_starttag(self, tag, attrs):
        d = {}
        for k, v in attrs:
            if k in d:
                self.dup_attr.append((tag, k, v, self.getpos()[0]))
            d[k] = v
        if 'id' in d:
            self.ids.append((d['id'], self.getpos()[0]))
        for k in ('href', 'src'):
            v = d.get(k)
            if v:
                self.refs.append((tag, k, v, self.getpos()[0]))
        if tag == 'script':
            self.scripts.append(d.get('src') or '<inline>')
        if tag == 'link' and d.get('href'):
            self.links.append(d.get('href'))


def resolve(value):
    """Return local filesystem path for a ref, or None if not a local file ref."""
    v = value.strip()
    if not v or v.lower().startswith(SKIP_PREFIX):
        return None
    v = v.split('#')[0].split('?')[0]
    if not v:
        return None
    if v.startswith('/'):
        # served from webgis_frontend root
        return os.path.join(FE, v.lstrip('/'))
    return os.path.join(FE, v)


def main():
    problems = 0
    for page in PAGES:
        path = os.path.join(FE, page)
        if not os.path.isfile(path):
            print('[MISSING-PAGE] %s' % page)
            problems += 1
            continue
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            html = f.read()
        p = PageParser()
        p.feed(html)
        p.close()

        print('=== %s (%d lines, %d ids)' % (page, html.count('\n') + 1, len(p.ids)))

        # duplicate ids
        for i, n in Counter([x[0] for x in p.ids]).items():
            if n > 1:
                lines = [str(l) for i2, l in p.ids if i2 == i]
                print('  [DUP-ID] %s x%d (lines %s)' % (i, n, ','.join(lines)))
                problems += 1

        # duplicate attributes on one tag
        for tag, k, v, line in p.dup_attr:
            print('  [DUP-ATTR] <%s> %s="%s" line %d' % (tag, k, v, line))
            problems += 1

        # missing local files
        seen = set()
        for tag, attr, v, line in p.refs:
            fp = resolve(v)
            if fp is None:
                continue
            if not os.path.isfile(fp):
                if v in seen:
                    continue
                seen.add(v)
                print('  [MISSING] %s line %d' % (v, line))
                problems += 1

        # duplicate script includes
        for s, n in Counter(p.scripts).items():
            if n > 1 and s != '<inline>':
                print('  [DUP-SCRIPT] %s x%d' % (s, n))
                problems += 1

        # dev leftovers
        for bad in ('TODO', 'FIXME', 'console.error(', 'debugger'):
            if bad in html:
                print('  [LEFT] contains %s' % bad)

    print('')
    print('TOTAL_PROBLEMS=%d' % problems)


if __name__ == '__main__':
    sys.exit(main())
