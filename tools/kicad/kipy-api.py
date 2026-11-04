"""Prints the installed kipy's classes and signatures without docstrings or source."""

import importlib
import inspect
import pkgutil
import sys

from google.protobuf.internal.enum_type_wrapper import EnumTypeWrapper

import kipy


def signature(function):
    try:
        return str(inspect.signature(function))
    except (TypeError, ValueError):
        return "(...)"


def print_class(name, cls):
    print(f"class {name}({', '.join(base.__name__ for base in cls.__bases__)})")
    for attribute, value in cls.__dict__.items():
        if attribute.startswith("_") and attribute != "__init__":
            continue
        if isinstance(value, property):
            print(f"  {attribute}" + (" [rw]" if value.fset else ""))
        elif isinstance(value, (staticmethod, classmethod)):
            print(f"  {attribute}{signature(value.__func__)}")
        elif inspect.isfunction(value):
            print(f"  {attribute}{signature(value)}")


if len(sys.argv) < 2:
    modules = [info.name for info in pkgutil.iter_modules(kipy.__path__) if not info.ispkg]
    sys.exit(f"Usage: kipy-api <module> [name ...]\nModules: {' '.join(sorted(modules))}")
module = importlib.import_module(f"kipy.{sys.argv[1]}")
wanted = sys.argv[2:]
for name, cls in inspect.getmembers(module, inspect.isclass):
    if cls.__module__ == module.__name__ and (not wanted or name in wanted):
        print_class(name, cls)
for name, enum in vars(module).items():
    if isinstance(enum, EnumTypeWrapper) and (not wanted or name in wanted):
        print(f"enum {name}: {' '.join(enum.keys())}")
if not wanted:
    for name, function in inspect.getmembers(module, inspect.isfunction):
        if function.__module__ == module.__name__:
            print(f"def {name}{signature(function)}")
