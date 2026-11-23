import app.b
from app.b import Box, helper


def run():
    box = Box(1)
    first = helper(box.get())
    second = app.b.helper(2)
    return first + second
