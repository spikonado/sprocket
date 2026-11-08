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


def print_module(module, wanted, printed):
    for name, cls in inspect.getmembers(module, inspect.isclass):
        if cls.__module__ == module.__name__ and (not wanted or name in wanted):
            print_class(name, cls)
            printed[name] = cls
    for name, enum in vars(module).items():
        if isinstance(enum, EnumTypeWrapper) and (not wanted or name in wanted):
            # Modules re-export the same protobuf enums.
            if printed.get(name) is not enum:
                print(f"enum {name}: {' '.join(enum.keys())}")
                printed[name] = enum
    if not wanted:
        for name, function in inspect.getmembers(module, inspect.isfunction):
            if function.__module__ == module.__name__:
                print(f"def {name}{signature(function)}")


modules = sorted(info.name for info in pkgutil.iter_modules(kipy.__path__) if not info.ispkg)
args = sys.argv[1:]
if not args or args[0] in ("-h", "--help"):
    print("Usage: kipy-api <module> [name ...]")
    print("       kipy-api <name> ...   searches every module")
    print(f"Modules: {' '.join(modules)}")
elif args[0] in modules:
    print_module(importlib.import_module(f"kipy.{args[0]}"), args[1:], {})
else:
    printed = {}
    for name in modules:
        print_module(importlib.import_module(f"kipy.{name}"), args, printed)
    if missing := [name for name in args if name not in printed]:
        sys.exit(f"Not in kipy: {' '.join(missing)}. Run kipy-api <module> to list a module.")
