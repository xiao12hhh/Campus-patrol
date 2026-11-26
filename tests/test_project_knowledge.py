import asyncio
import json
from app.api.assistant import Question, ask
from app.services import project_knowledge as k


def test_avl_astar_explanation_with_real_sources():
    result = k.project_answer('本项目 AVL 和 A* 分别做什么？')
    assert set(result['topic_ids']) == {'avl', 'astar'}
    assert 'heapq' in result['answer'] and 'O(log n)' in result['answer']
    assert all(k.source_current(s) for t in k.load_knowledge()['topics'] for s in t['sources'])
    assert all(r['current'] for r in result['references'])


def test_technical_distance_question_does_not_trigger_route_form():
    result = asyncio.run(ask(Question(message='本项目距离计算怎么实现？')))
    assert '请选择起点' not in result['answer']
    assert '乘 10' in result['answer']
    assert result['source'].startswith('项目知识库')


def test_followup_and_unknown_topic():
    assert k.project_answer('它的复杂度呢？', ['avl'])['topic_ids'] == ['avl']
    assert k.project_answer('代码在哪？', ['motion'])['topic_ids'] == ['motion']
    assert '暂未记录' in k.project_answer('本项目区块链怎么实现？')['answer']
    assert k.project_answer('你好') is None
    assert k.project_answer('从图书馆到体育馆多远') is None


def test_stale_sources_are_explicit(tmp_path, monkeypatch):
    data = k.load_knowledge()
    next(t for t in data['topics'] if t['id'] == 'avl')['sources'][0]['sha256'] = 'stale'
    path = tmp_path / 'knowledge.json'
    path.write_text(json.dumps(data), encoding='utf-8')
    monkeypatch.setattr(k, 'KNOWLEDGE_PATH', path)
    result = k.project_answer('AVL 怎么实现？')
    assert '待核验' in result['source'] and '源码已变化' in result['answer']


def test_project_memory_available_while_model_busy():
    from app.api import assistant as a
    async def run():
        async with a._busy:
            result = await ask(Question(message='本项目有哪些功能和知识点？'))
            assert result['topic_ids'] == ['overview']
    asyncio.run(run())
