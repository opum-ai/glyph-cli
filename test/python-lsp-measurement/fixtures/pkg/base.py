import functools


def helper(x):
    return x + 1


def traced(fn):
    @functools.wraps(fn)
    def inner(*args, **kwargs):
        return fn(*args, **kwargs)

    return inner


class Animal:
    species = "generic"

    def __init__(self, name):
        self.name = name

    def speak(self):
        return "..."

    def describe(self):
        return self.speak() + self.name

    @classmethod
    def create(cls, name):
        return cls(name)

    @staticmethod
    def kingdom():
        return "animalia"

    @property
    def label(self):
        return self.name.upper()


class Dog(Animal):
    def __init__(self, name, tricks):
        super().__init__(name)
        self.tricks = tricks

    def speak(self):
        return "woof" + super().speak()

    @traced
    def fetch(self, item):
        return helper(len(item))


class Cat(Animal):
    def speak(self):
        return "meow"
