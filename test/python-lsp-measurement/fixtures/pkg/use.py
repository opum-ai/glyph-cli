from . import base
from .base import Animal, Dog as Doggo, helper as h
from .base import Cat


def run_all(pets: list[Animal]):
    out = []
    for p in pets:
        out.append(p.speak())
        out.append(p.describe())
    return out


def make():
    d = Doggo("rex", [])
    c = Cat("tom")
    a = Animal.create("generic")
    e = base.Animal("aliased")
    k = Animal.kingdom()
    lab = d.label
    n = h(3) + base.helper(4)
    r = run_all([d, c, a, e])
    d.fetch("ball")
    c.speak()
    return d, c, a, e, k, lab, n, r


def through_callback():
    fn = base.helper
    calls = [fn(1), list(map(base.helper, [1, 2]))]
    cb = d_speak = Cat("x").speak
    return calls, cb(), d_speak()


def comprehension():
    return [h(i) for i in range(3)], {i: base.helper(i) for i in range(2)}


async def amain():
    return await _aw()


async def _aw():
    return h(1)
