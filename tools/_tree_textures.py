# -*- coding: utf-8 -*-
"""把 95.zip 里的 2K/4K 贴图压成 Web 可用尺寸，只留用得上的几张。
保留：叶片 Diffuse / Opacity / Normal，树干 Diffuse / Normal / Roughness。
其余（Height/Reflect/Translucency/ior/A_/B_ 变体）删掉，省 20+ MB。
"""
import os
from PIL import Image

SRC = r'E:\agent-work\数据结构-笔记\校园巡视\public\textures\tree'
LOG = r'E:\agent-work\数据结构-笔记\校园巡视\_models_raw\textures.txt'

# 源文件名 -> (输出名, 目标尺寸, 质量, 模式)
JOBS = [
    ('AM258_095_Chestnut_Leaves_Diffuse.jpg', 'leaf_diffuse.jpg', (1024, 1024), 88, 'RGB'),
    ('AM258_095_Chestnut_Leaves_Opacity.jpg', 'leaf_opacity.jpg', (1024, 1024), 92, 'L'),
    ('AM258_095_Chestnut_Leaves_Normal.jpg', 'leaf_normal.jpg', (1024, 1024), 92, 'RGB'),
    ('AM258_095_Chestnut_Trunk_A_Diffuse.jpg', 'trunk_diffuse.jpg', (1024, 2048), 85, 'RGB'),
    ('AM258_095_Chestnut_Trunk_A_Normal.jpg', 'trunk_normal.jpg', (512, 1024), 90, 'RGB'),
    ('AM258_095_Chestnut_Trunk_A_Roughness.jpg', 'trunk_rough.jpg', (512, 1024), 88, 'L'),
]

L = []
for src, dst, size, q, mode in JOBS:
    p = os.path.join(SRC, src)
    if not os.path.exists(p):
        L.append('!! 缺少 ' + src)
        continue
    im = Image.open(p)
    L.append('%-46s %s -> %s' % (src, im.size, size))
    im = im.convert(mode)
    if im.size != size:
        im = im.resize(size, Image.LANCZOS)
    out = os.path.join(SRC, dst)
    im.save(out, 'JPEG', quality=q, optimize=True)
    L.append('    -> %-22s %6.1f KB' % (dst, os.path.getsize(out) / 1024))

# 清理没用到的原图
keep = {j[1] for j in JOBS}
removed = 0
freed = 0
for f in os.listdir(SRC):
    if f in keep:
        continue
    p = os.path.join(SRC, f)
    freed += os.path.getsize(p)
    os.remove(p)
    removed += 1
L.append('')
L.append('清理未使用原图 %d 张，释放 %.1f MB' % (removed, freed / 1048576))
L.append('')
total = 0
for f in sorted(os.listdir(SRC)):
    s = os.path.getsize(os.path.join(SRC, f))
    total += s
    L.append('  %8.1f KB  %s' % (s / 1024, f))
L.append('  合计 %.2f MB' % (total / 1048576))

open(LOG, 'w', encoding='utf-8').write('\n'.join(L))
