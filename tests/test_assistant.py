import asyncio
import math
import pytest
from app.api import assistant as a
from app.services.campus_data import places_by_name


def test_names_preserve_direction_and_longest_match():
    places = places_by_name()
    assert a.mentioned('从图书馆到体育馆', places) == ['图书馆', '体育馆']
    assert a.mentioned('从体育馆到图书馆', places) == ['体育馆', '图书馆']
    assert a.mentioned('中国石油大学体育馆', places) == ['中国石油大学体育馆']
    assert a.mentioned('三教到四教', places) == ['第三教学楼', '第四教学楼']


def test_route_distance_and_segments_are_computed():
    result = a.route('图书馆', '体育馆', {}, 0)
    route = result['route']
    points = route['points']
    assert route['meters'] == round(sum(math.dist(p, q) for p, q in zip(points, points[1:])) * 10)
    assert all(a._grid.segment_clear(*p, *q) for p, q in zip(points, points[1:]))
    # A large obstacle must not produce the old clear route or a made-up distance.
    blocked = a.route('图书馆', '体育馆', {'test': dict(x=points[0][0], z=points[0][1], radius=1000)}, 1)
    assert 'route' not in blocked


def test_missing_origin_and_same_place_never_use_model(monkeypatch):
    def fail(_):
        pytest.fail('Route requests must not call the LLM')
    monkeypatch.setattr(a, 'chat', fail)
    assert '请选择' in asyncio.run(a.ask(a.Question(message='去图书馆怎么走')))['answer']
    assert '0 米' in asyncio.run(a.ask(a.Question(message='路线', start='图书馆', end='图书馆')))['answer']
    assert '请选择' in asyncio.run(a.ask(a.Question(message='路线', start='不存在', end='图书馆')))['answer']


def test_model_failure_and_no_thinking_leak(monkeypatch):
    monkeypatch.setattr(a, 'ollama', lambda *args, **kwargs: {'message': {'content': '<think>private reasoning</think>你好'}})
    assert a.chat(a.Question(message='你好'))['answer'] == '你好'
    def unavailable(*args, **kwargs):
        raise TimeoutError()
    monkeypatch.setattr(a, 'ollama', unavailable)
    assert '路线和距离查询仍可使用' in asyncio.run(a.ask(a.Question(message='你好')))['answer']
