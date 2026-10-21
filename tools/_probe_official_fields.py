"""看一眼学校官方源每条建筑带哪些字段，评估还能挖什么材质/体块信息。"""
import json, pathlib, collections

p = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视\data\sources\cupb-official-3d.json')
d = json.loads(p.read_text(encoding='utf-8'))
feats = d['features'] if isinstance(d, dict) and 'features' in d else d
print('features', len(feats))
print('顶层 keys:', list(d.keys()) if isinstance(d, dict) else type(d))
f0 = feats[0]
print('\n第一条 props:')
print(json.dumps(f0.get('properties'), ensure_ascii=False, indent=2))
print('geometry type:', f0.get('geometry', {}).get('type'))

keys = collections.Counter()
vals = collections.defaultdict(collections.Counter)
for f in feats:
    pr = f.get('properties') or {}
    for k, v in pr.items():
        keys[k] += 1
        if isinstance(v, (str, int, float)) and len(str(v)) < 24:
            vals[k][str(v)] += 1
print('\n字段出现次数:', dict(keys))
for k, c in vals.items():
    if len(c) <= 14:
        print('\n[%s] 取值分布:' % k, dict(c.most_common(14)))
    else:
        print('\n[%s] 取值种类 %d，示例:' % (k, len(c)), [x for x, _ in c.most_common(6)])
