# -*- coding: utf-8 -*-
"""把 Megascans 的单片叶子 atlas 合成「叶丛」贴图 v2。

v1 整张 atlas 旋转叠放的问题：
  - 叶间黑背景占比高，叠 48 次后覆盖率 94.8%，糊成一坨实心;
  - RGBA PNG 2.1 MB 太大。

v2 改为：按 4x2 网格抠出 8 片单叶 → 裁到 alpha 紧包络 →
  随机旋转/缩放/翻转 → 逐片贴到画布，目标覆盖率 ~80%，
  最后 256 色量化 + LZW，PNG 压到几百 KB。
"""
import os, random
from PIL import Image, ImageFilter

SRC = r'E:\agent-work\数据结构-笔记\校园巡视\public\textures\tree'
OUT = os.path.join(SRC, 'leaf_cluster.png')
LOG = r'E:\agent-work\数据结构-笔记\校园巡视\_models_raw\cluster.txt'
CANVAS = 1024
TARGET = 80.0  # 目标覆盖率 %

random.seed(42)
d = Image.open(os.path.join(SRC, 'leaf_diffuse.jpg')).convert('RGB')
o = Image.open(os.path.join(SRC, 'leaf_opacity.jpg')).convert('L')
W, H = d.size
cols, rows = 4, 2
cw, ch = W // cols, H // rows

# 抠出每片叶子：RGBA + 裁到 alpha 紧包络
leaves = []
for r in range(rows):
    for c in range(cols):
        box = (c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)
        leaf = d.crop(box).convert('RGBA')
        alpha = o.crop(box)
        leaf.putalpha(alpha)
        bbox = alpha.point(lambda p: 255 if p > 100 else 0).getbbox()
        if bbox:
            leaves.append(leaf.crop(bbox))
print('单叶数:', len(leaves), '尺寸:', [l.size for l in leaves])

canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))

def coverage(img):
    hist = img.getchannel('A').histogram()
    return 100.0 * sum(hist[129:]) / (CANVAS * CANVAS)

i = 0
while coverage(canvas) < TARGET and i < 400:
    leaf = random.choice(leaves)
    if random.random() < 0.5:
        leaf = leaf.transpose(Image.FLIP_LEFT_RIGHT)
    ang = random.uniform(0, 360)
    leaf = leaf.rotate(ang, resample=Image.BICUBIC, expand=True)
    s = random.uniform(0.35, 1.0)
    nw = max(8, int(leaf.width * s)); nh = max(8, int(leaf.height * s))
    leaf = leaf.resize((nw, nh), Image.LANCZOS)
    x = random.randint(-nw // 3, CANVAS - nw + nw // 3)
    y = random.randint(-nh // 3, CANVAS - nh + nh // 3)
    canvas.alpha_composite(leaf, (x, y))
    i += 1

# alpha 轻微膨胀，缓解 alphaTest 在 mipmap 下的远处闪烁/碎边
a = canvas.getchannel('A').filter(ImageFilter.MaxFilter(3))
canvas.putalpha(a)

# color bleed：膨胀出的 alpha 边缘 + 透明区原本是纯黑，
# mipmap 缩小时 RGB 会被黑污染，alphaTest 后整片树发黑。
# 把整张图的 RGB 渗成叶片平均色（alpha 通道保持不变）。
r, g, b, a = canvas.split()
px = list(zip(r.getdata(), g.getdata(), b.getdata(), a.getdata()))
sr = sg = sb = cnt = 0
for pr, pg, pb, pa in px:
    if pa > 200:
        sr += pr; sg += pg; sb += pb; cnt += 1
avg = (int(sr / cnt), int(sg / cnt), int(sb / cnt)) if cnt else (90, 120, 60)
bg = Image.new('RGBA', canvas.size, avg + (255,))
r = Image.composite(r, bg.getchannel('R'), a)
g = Image.composite(g, bg.getchannel('G'), a)
b = Image.composite(b, bg.getchannel('B'), a)
canvas = Image.merge('RGBA', (r, g, b, a))

# 256 色量化（保留 alpha），压体积
q = canvas.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
q.save(OUT, 'PNG', optimize=True)

cov = coverage(canvas)
size_kb = os.path.getsize(OUT) / 1024
L = [
    'leaf_cluster.png %.1f KB  size=%s  叠放片数=%d  覆盖率(alpha>128)=%.1f%%  bleed=%s' % (size_kb, canvas.size, i, cov, avg),
]
open(LOG, 'w', encoding='utf-8').write('\n'.join(L))
print('\n'.join(L))
