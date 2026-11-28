# -*- coding: utf-8 -*-
"""Cross-check frontend API calls against backend Flask routes. ASCII output."""
import ast
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BE = os.path.join(ROOT, 'webgis_backend')
FE = os.path.join(ROOT, 'webgis_frontend')


def collect_routes():
    prefixes = {}
    routes = []
    for dirpath, dirnames, filenames in os.walk(BE):
        if '__pycache__' in dirpath:
            continue
        for fn in filenames:
            if not fn.endswith('.py'):
                continue
            path = os.path.join(dirpath, fn)
            try:
                src = open(path, encoding='utf-8').read()
                tree = ast.parse(src)
            except Exception as exc:
                print('[PARSE-FAIL] %s (%s)' % (fn, exc))
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                    fname = getattr(node.value.func, 'id', None) or getattr(node.value.func, 'attr', None)
                    if fname == 'Blueprint':
                        pref = ''
                        for kw in node.value.keywords:
                            if kw.arg == 'url_prefix' and isinstance(kw.value, ast.Constant):
                                pref = kw.value.value
                        for t in node.targets:
                            if isinstance(t, ast.Name):
                                prefixes[t.id] = pref
            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                for dec in node.decorator_list:
                    if not isinstance(dec, ast.Call):
                        continue
                    fn_attr = getattr(dec.func, 'attr', None)
                    if fn_attr not in ('route', 'get', 'post', 'put', 'delete', 'patch'):
                        continue
                    owner = getattr(dec.func.value, 'id', None)
                    if not dec.args or not isinstance(dec.args[0], ast.Constant):
                        continue
                    raw = dec.args[0].value
                    if owner == 'app':
                        full = raw
                    else:
                        full = prefixes.get(owner, '') + raw
                    routes.append(full)
    return sorted(set(routes))


CALL_RE = re.compile(
    r"""['"`](/(?:api|modules|tif|tiles3d|backend-static|data|cesium|terrain3d)/[^'"`\s?]*)"""
)


def collect_calls():
    found = {}
    for dirpath, dirnames, filenames in os.walk(FE):
        rel = os.path.relpath(dirpath, FE)
        if rel.startswith('terrain3d') and rel != 'terrain3d':
            continue  # 3D demo is a separate app, skip
        for fn in filenames:
            if not (fn.endswith('.js') or fn.endswith('.html')):
                continue
            path = os.path.join(dirpath, fn)
            try:
                src = open(path, encoding='utf-8').read()
            except Exception:
                continue
            for m in CALL_RE.finditer(src):
                v = m.group(1)
                # 去掉末尾的 ${ ... 残片
                v = v.split('${')[0].rstrip('\\')
                if not v:
                    continue
                found.setdefault(v, set()).add(fn)
    return found


def rule_regex(rule):
    body = re.sub(r'<[^>]+>', '\x00', rule)
    return '^' + re.escape(body).replace('\x00', '[^/]+') + '$'


def main():
    routes = collect_routes()
    calls = collect_calls()
    print('backend routes: %d' % len(routes))
    for r in routes:
        print('   %s' % r)
    print('')
    print('frontend call sites: %d unique' % len(calls))

    unmatched = []
    for call, files in sorted(calls.items()):
        probe = call.rstrip('/')
        ok = False
        for r in routes:
            if re.match(rule_regex(r), probe):
                ok = True
                break
            # 前缀宽松匹配：前端路径截断在模板变量处
            r_lit = r.split('<')[0]
            if r_lit and (probe + '/').startswith(r_lit.rstrip('/') + '/') and r.endswith('>'):
                ok = True
                break
        if not ok:
            unmatched.append((call, sorted(files)))

    print('')
    if unmatched:
        print('--- UNMATCHED (%d) ---' % len(unmatched))
        for call, files in unmatched:
            print('  %s   <- %s' % (call, ','.join(files)))
    else:
        print('ALL_FRONTEND_CALLS_MATCHED')


if __name__ == '__main__':
    sys.exit(main())
