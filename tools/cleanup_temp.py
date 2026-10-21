"""把调试临时文件移入回收站（不永久删除）。

用法：
    python tools/cleanup_temp.py                 # 清理默认的临时产物
    python tools/cleanup_temp.py _foo.txt _bar   # 追加指定文件 / 通配符
"""
import fnmatch
import os
import pathlib
import sys

ROOT = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视')

DEFAULT = ['_*.txt', '_*.log', '_*.json', '_*.html', '_*.png', '_*.js']

try:
    from send2trash import send2trash
except ImportError:
    print('send2trash 未安装：pip install send2trash')
    raise SystemExit(1)

patterns = DEFAULT + list(sys.argv[1:])
targets = []
for pat in patterns:
    for t in ROOT.glob(pat):
        if t.is_file() and t not in targets:
            targets.append(t)
# tools 下的一次性诊断脚本（保留通用工具）
KEEP = {'_smoke.py', 'cleanup_temp.py'}
for t in (ROOT / 'tools').glob('_*.py'):
    if t.name not in KEEP and t not in targets:
        targets.append(t)

total = sum(t.stat().st_size for t in targets)
moved, failed = [], []
for t in targets:
    path = str(t)
    try:
        send2trash(path)
    except Exception:
        pass  # send2trash 成功时也会抛异常，以 os.path.exists 复核为准
    (moved if not os.path.exists(path) else failed).append(t.name)

print(f'目标 {len(targets)} 项，约 {total / 1024 / 1024:.2f} MB')
print(f'已移入回收站: {len(moved)}')
print(f'仍存在(真失败): {failed if failed else "无"}')
print('注意：文件仍在回收站，磁盘空间尚未释放。')
