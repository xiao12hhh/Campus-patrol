"""Curated project memory. Retrieval is local and answers remain traceable to code."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE_PATH = ROOT / 'data/project-knowledge.json'


def load_knowledge():
    return json.loads(KNOWLEDGE_PATH.read_text(encoding='utf-8'))


def normalize(text):
    return re.sub(r'\s+', '', text.lower())


def source_digest(path):
    # Git CRLF checkout and a UTF-8 BOM do not change the implementation.
    return hashlib.sha256(path.read_text(encoding='utf-8-sig').encode('utf-8')).hexdigest()


def source_current(source):
    path = (ROOT / source['path']).resolve()
    if not path.is_relative_to(ROOT) or not path.is_file():
        return False
    return source_digest(path) == source['sha256']


def project_answer(question, context_topics=()):
    q = normalize(question)
    data = load_knowledge()
    topics = data['topics']
    followup = bool(context_topics) and bool(re.search('它|这个|那|继续|详细|展开|复杂度|代码在哪|源码在哪|举例', q))
    project_intent = followup or bool(re.search(
        r'项目|本系统|这个系统|技术栈|知识点|怎么实现|如何实现|实现原理|怎么算|怎么计算|如何计算|源码|算法|数据结构|复杂度|avl|平衡二叉树|a\*|astar|vrptw|websocket|three\.js|校园ai|知识库|项目记忆', q))
    if not project_intent:
        return None
    ranked = []
    for topic in topics:
        hits = [len(normalize(k)) for k in topic['keywords'] if normalize(k) in q]
        if hits:
            ranked.append((max(hits), sum(hits), topic))
    ranked.sort(key=lambda item: item[:2], reverse=True)
    selected = [t for _, _, t in ranked if t['id'] != 'overview'][:3]
    if not selected and followup:
        selected = [t for tid in context_topics for t in topics if t['id'] == tid][:3]
    if not selected and ranked:
        selected = [ranked[0][2]]
    if not selected:
        return {'answer': '项目知识库暂未记录这项实现，不能确认项目使用了该技术。可以问“本项目有哪些功能和知识点”，或具体询问 AVL、A*、避障、动画、实时通信、VRPTW、校园 AI。',
                'source': '项目知识库 · 未收录', 'topic_ids': [], 'references': []}
    sections, references, stale = [], [], False
    for topic in selected:
        current = all(source_current(s) for s in topic['sources'])
        stale |= not current
        section = topic['title'] + '\n知识点：' + topic['concepts']
        section += '\n实现过程：\n' + '\n'.join(f'{i+1}. {step}' for i, step in enumerate(topic['steps']))
        if topic['complexity']:
            section += '\n复杂度：' + topic['complexity']
        section += '\n当前边界：' + topic['limits']
        sections.append(section)
        references.extend(dict(path=s['path'], symbol=s['symbol'], current=source_current(s)) for s in topic['sources'])
    answer = '\n\n'.join(sections)
    if stale:
        answer = '注意：部分关联源码已变化，以下是上次核对的项目资料，需重新核验后才能当作当前实现。\n\n' + answer
    return {'answer': answer, 'source': '项目知识库 · ' + ('待核验' if stale else '源码已核对'),
            'topic_ids': [t['id'] for t in selected], 'references': references,
            'knowledge_version': data['version']}
