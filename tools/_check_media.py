"""检查前端样式里是否真的有响应式 @media 断点。"""
import re, pathlib

p = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视\frontend\src\styles.css')
t = p.read_text(encoding='utf-8')
out = []
out.append(f'file lines={t.count(chr(10))+1} chars={len(t)}')
out.append(f'@media count = {t.count("@media")}')
for m in re.finditer(r'@media[^{]*', t):
    out.append('  ' + m.group(0).strip())
out.append(f'min-width occurrences = {t.count("min-width")}')
for m in re.finditer(r'[a-z-]*min-width:[^;}]*', t):
    out.append('  ' + m.group(0).strip())
out.append(f'max-width occurrences = {t.count("max-width")}')
for m in re.finditer(r'[a-z-]*max-width:[^;}]*', t):
    out.append('  ' + m.group(0).strip())
pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视\_media_check.txt').write_text('\n'.join(out), encoding='utf-8')
print('\n'.join(out))
