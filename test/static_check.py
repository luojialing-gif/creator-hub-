#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单文件 HTML 的静态自检：外链、标签配平、id 存在性、渲染函数调用链。"""
import re
import sys
import pathlib

DEFAULT = pathlib.Path(__file__).resolve().parent.parent / 'web' / 'creator-hub-web.html'
TARGET = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
src = TARGET.read_text(encoding='utf-8')
js = src[src.find('<script>') + 8: src.rfind('</script>')]
html = src[:src.find('<script>')] + src[src.rfind('</script>'):]

problems = []
notes = []


def check(name, bad, detail=''):
    if bad:
        problems.append('%s：%s' % (name, detail or bad))
    else:
        notes.append('%s：通过' % name)


# 1. 零外链 -------------------------------------------------------------
ext_attr = re.findall(r'(?:src|href|action)\s*=\s*["\']https?://[^"\']+', src)
check('零外链（src/href/action）', ext_attr, '发现 ' + ', '.join(ext_attr[:3]))
script_src = re.findall(r'<script[^>]*\ssrc=', src)
check('无外部脚本', script_src)
cdn = re.findall(r'@import|cdn\.|unpkg|jsdelivr|googleapis|fonts\.', src)
check('无 CDN / 外链字体', cdn, ', '.join(set(cdn)))
fetch_calls = re.findall(r'\bfetch\s*\(', js)
check('无网络请求（fetch/XHR）', fetch_calls, str(len(fetch_calls)))

# 2. 标签配平 -----------------------------------------------------------
tags = ['div', 'section', 'header', 'aside', 'main', 'article', 'button', 'ul', 'li',
        'span', 'p', 'h2', 'h3', 'select', 'option', 'textarea', 'iframe', 'input']
for t in tags:
    opens = len(re.findall(r'<%s(?=[\s>])' % t, src))
    closes = len(re.findall(r'</%s>' % t, src))
    if t == 'input':
        self_close = len(re.findall(r'<input[^>]*/>', src))
        opens -= self_close
    if t == 'iframe':
        opens = len(re.findall(r'<iframe(?=[\s>])', src)) - len(re.findall(r"replace\('<iframe", src))
    if opens != closes:
        problems.append('标签配平 %s：开 %d / 闭 %d' % (t, opens, closes))
if not problems or all('标签配平' not in p for p in problems):
    notes.append('标签配平：通过')

# 3. id 存在性 ----------------------------------------------------------
static_ids = set(re.findall(r'\bid="([A-Za-z0-9_-]+)"', src))
js_ids = set(re.findall(r"\$\('([A-Za-z0-9_-]+)'\)", js))
used_ids = set(re.findall(r"getElementById\('([A-Za-z0-9_-]+)'\)", js))
missing = (js_ids | used_ids) - static_ids
check('JS 引用的 id 均存在', missing, '缺失 ' + ', '.join(sorted(missing)))

# 4. render* 调用链 -----------------------------------------------------
funcs = {}
for m in re.finditer(r'function\s+(render[A-Za-z]*)\s*\([^)]*\)\s*\{', js):
    start = m.end()
    depth = 1
    i = start
    while i < len(js) and depth > 0:
        if js[i] == '{':
            depth += 1
        elif js[i] == '}':
            depth -= 1
        i += 1
    funcs[m.group(1)] = js[start:i]
cycles = []
for name, body in funcs.items():
    for other in funcs:
        if other == name:
            continue
        if re.search(r'\b%s\s*\(' % other, body):
            cycles.append('%s → %s' % (name, other))
check('render* 之间无互调（调用链为 DAG）', cycles, ', '.join(cycles))
notes.append('已识别的 render 函数：%s' % ', '.join(sorted(funcs)))

# 5. 关键约定 -----------------------------------------------------------
check('存在唯一的 refreshAll 聚合入口', js.count('function refreshAll') != 1)
check('未使用任何 CDN 或新窗口 opener 泄漏（window.open 带 noopener）',
      'window.open(url' in js and 'noopener' not in js)
check('未出现删除用户文件的调用', re.findall(r'rm\s+-rf|shutil\.rmtree', js))

# 6. 移动端约定 ---------------------------------------------------------
check('存在 820px 断点（移动端单列）', '@media (max-width:820px)' not in src)
check('移动端输入框字号 ≥16px', 'font-size:16px' not in src)
check('含 safe-area 适配', 'safe-area-inset-bottom' not in src)

print('=' * 62)
print('文件：%s' % TARGET)
print('体积：%d 字节 / %d 行' % (len(src.encode('utf-8')), src.count('\n') + 1))
print('=' * 62)
for n in notes:
    print('  ✓ %s' % n)
if problems:
    print('\n发现问题：')
    for p in problems:
        print('  ✗ %s' % p)
    sys.exit(1)
print('\n全部静态检查通过。')
