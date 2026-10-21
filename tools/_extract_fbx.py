# -*- coding: utf-8 -*-
import os, subprocess

ROOT = r'E:\agent-work\数据结构-笔记\校园巡视\_models_raw'
TAR = r'C:\windows\System32\tar.EXE'
LOG = os.path.join(ROOT, 'list4.txt')
lines = []

# 只解 fbx + obj.mtl（obj.obj 530MB 太大，先看 mtl 判断有没有贴图）
jobs = [
    ('03_fbx.rar', 'fbx', None),
    ('02_obj.rar', 'obj', '*.mtl'),
]

for rar, sub, pattern in jobs:
    dst = os.path.join(ROOT, sub)
    os.makedirs(dst, exist_ok=True)
    src = os.path.join(ROOT, 'dog', rar)
    args = [TAR, '-xf', src, '-C', dst]
    if pattern:
        args.append(pattern)
    try:
        p = subprocess.run(args, capture_output=True, timeout=900)
        lines.append('%s -> %s rc=%d' % (rar, dst, p.returncode))
        lines.append((p.stderr or b'').decode('utf-8', 'replace')[:800])
    except Exception as e:
        lines.append('%s ERROR %r' % (rar, e))

# 列出产出
for sub in ('fbx', 'obj'):
    d = os.path.join(ROOT, sub)
    if not os.path.isdir(d):
        continue
    lines.append('')
    lines.append('--- %s ---' % sub)
    for root, dirs, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            lines.append('  %12.2f MB  %s' % (os.path.getsize(p) / 1048576, os.path.relpath(p, d)))

# obj.mtl 内容
mtl = os.path.join(ROOT, 'obj', 'obj.mtl')
if os.path.exists(mtl):
    lines.append('')
    lines.append('--- obj.mtl ---')
    lines.append(open(mtl, 'r', encoding='utf-8', errors='replace').read()[:2000])

with open(LOG, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))
