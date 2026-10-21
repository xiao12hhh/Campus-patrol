# -*- coding: utf-8 -*-
"""1) 测狗顶部传感舱与机身的实际间隙  2) 检查贴图处理库是否可用  3) 提取树贴图"""
import json, os, subprocess, sys, zipfile

ROOT = r'E:\agent-work\数据结构-笔记\校园巡视'
OUT = os.path.join(ROOT, '_models_raw', 'gap.txt')
L = []


def say(s):
    L.append(s)


# ---------- 1) 贴图处理库 ----------
say('=== 图像处理库 ===')
try:
    import PIL
    from PIL import Image
    say('  Pillow OK  version=' + PIL.__version__)
except Exception as e:
    say('  Pillow 不可用: ' + e)

# ---------- 2) 提取树贴图 ----------
ZIP = r'D:\31054\Documents\95.zip'
DST = os.path.join(ROOT, 'public', 'textures', 'tree')
os.makedirs(DST, exist_ok=True)
say('')
say('=== 提取树贴图 -> ' + DST + ' ===')
if os.path.exists(ZIP):
    with zipfile.ZipFile(ZIP) as z:
        for i in z.infolist():
            name = os.path.basename(i.filename)
            if not name.lower().endswith(('.jpg', '.jpeg', '.png')):
                continue
            with z.open(i) as src, open(os.path.join(DST, name), 'wb') as f:
                f.write(src.read())
    for f in sorted(os.listdir(DST)):
        say('  %9.1f KB  %s' % (os.path.getsize(os.path.join(DST, f)) / 1024, f))
else:
    say('  !! 95.zip 不存在')

try:
    from PIL import Image
    say('')
    say('=== 贴图尺寸 ===')
    for f in sorted(os.listdir(DST)):
        try:
            im = Image.open(os.path.join(DST, f))
            say('  %-52s %s' % (f, im.size))
        except Exception as e:
            say('  %s 读取失败 %s' % (f, e))
except Exception:
    pass

with open(OUT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(L))
