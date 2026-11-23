"""A small hand-written Python fixture for the native parser tests.

It is deliberately not a vendored package: a real corpus (click 7.1.2) is
measured by test/python-parse-corpus.ts and recorded in
test/python-parse-corpus-click-7.1.2.txt, not copied into this repository.
"""

from __future__ import annotations

from collections import OrderedDict

from .utils import helper as alias

VALUE = 1


@decorator(arg)
class Base:
    def method(self, x: int) -> int:
        return alias(x) + VALUE


class Child(Base):
    def method(self, x: int) -> int:
        return super().method(x)


def first[T](items: list[T]) -> T:
    match items:
        case [head, *_]:
            return head
        case _:
            raise ValueError("empty")


def formatted(d: dict[str, str]) -> str:
    return f"{d["k"]}"


def collect() -> OrderedDict[str, int]:
    return OrderedDict()
