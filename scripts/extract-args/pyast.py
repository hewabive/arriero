"""Shared AST helpers for the engine argument-declaration extractors.

Contract, invariants and known gaps: docs/ARGUMENT_SOURCE_EXTRACTION.md
"""

import argparse
import ast
import json
import sys
from pathlib import Path

OPTIONAL_WRAPPERS = {"Optional", "Union"}


def parse_file(path):
    return ast.parse(Path(path).read_text(encoding="utf8"), filename=str(path))


def unparse(node):
    try:
        return ast.unparse(node)
    except Exception:
        return None


def subscript_elements(node):
    sliced = node.slice
    return list(sliced.elts) if isinstance(sliced, ast.Tuple) else [sliced]


def is_named_subscript(node, names):
    return (
        isinstance(node, ast.Subscript)
        and isinstance(node.value, ast.Name)
        and node.value.id in names
    )


def string_value(node, doc_resolver=None):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            elif isinstance(value, ast.FormattedValue):
                parts.append(formatted_value(value, doc_resolver))
        return "".join(parts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = string_value(node.left, doc_resolver)
        right = string_value(node.right, doc_resolver)
        if left is not None and right is not None:
            return left + right
    return None


def formatted_value(node, doc_resolver):
    expression = unparse(node.value) or "?"
    if doc_resolver is not None:
        resolved = doc_resolver(expression)
        if resolved is not None:
            return resolved
    return "{" + expression + "}"


def module_docstrings(tree):
    docs = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            doc = ast.get_docstring(node)
            if doc:
                docs[node.name] = doc
    return docs


def module_level_statements(tree):
    for node in tree.body:
        yield node
        if isinstance(node, ast.If):
            yield from node.body
            yield from node.orelse


def named_assignments(tree):
    for node in module_level_statements(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target, value = node.targets[0], node.value
        elif isinstance(node, ast.AnnAssign):
            target, value = node.target, node.value
        else:
            continue
        if isinstance(target, ast.Name) and value is not None:
            yield target.id, value


def literal_aliases(tree):
    return {
        name: value
        for name, value in named_assignments(tree)
        if is_named_subscript(value, {"Literal"})
    }


def constant_values(node):
    if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return None
    values = []
    for element in node.elts:
        if not isinstance(element, ast.Constant):
            return None
        values.append(element.value)
    return values


def constant_sequences(tree):
    sequences = {}
    for name, value in named_assignments(tree):
        values = constant_values(value)
        if values is not None:
            sequences[name] = values
    return sequences


def merge_module_symbols(tree, aliases, constants):
    for name, node in literal_aliases(tree).items():
        aliases.setdefault(name, node)
    for name, values in constant_sequences(tree).items():
        constants.setdefault(name, values)


def module_path(repo, module, package_root=""):
    base = Path(repo).joinpath(package_root, *module.split("."))
    for candidate in (base.with_suffix(".py"), base / "__init__.py"):
        if candidate.exists():
            return candidate
    return None


def choices_of(node, aliases, constants):
    if node is None:
        return None
    values = constant_values(node)
    if values is not None:
        return values
    if isinstance(node, ast.Name) and node.id in constants:
        return constants[node.id]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = choices_of(node.left, aliases, constants)
        right = choices_of(node.right, aliases, constants)
        return merge_choices([left, right]) if left and right else None
    return literal_choices(node, aliases)


def literal_choices(node, aliases, seen=None):
    if node is None:
        return None
    seen = seen or set()

    if is_named_subscript(node, {"Literal"}):
        values = []
        for element in subscript_elements(node):
            if isinstance(element, ast.Constant):
                values.append(element.value)
                continue
            nested = literal_choices(element, aliases, seen)
            if nested is None:
                return None
            values.extend(nested)
        return values

    if isinstance(node, ast.Name):
        if node.id in seen or node.id not in aliases:
            return None
        return literal_choices(aliases[node.id], aliases, seen | {node.id})

    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return None

    if is_named_subscript(node, {"Annotated"}):
        return literal_choices(subscript_elements(node)[0], aliases, seen)

    if is_named_subscript(node, OPTIONAL_WRAPPERS):
        return merge_choices(
            literal_choices(element, aliases, seen)
            for element in subscript_elements(node)
        )

    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return merge_choices(
            [
                literal_choices(node.left, aliases, seen),
                literal_choices(node.right, aliases, seen),
            ]
        )

    return None


def merge_choices(parts):
    merged = []
    for part in parts:
        if not part:
            continue
        for value in part:
            if value not in merged:
                merged.append(value)
    return merged or None


def annotation_names(node):
    names = set()
    for child in ast.walk(node) if node is not None else []:
        if isinstance(child, ast.Name):
            names.add(child.id)
        elif isinstance(child, ast.Constant) and child.value is None:
            names.add("None")
        elif isinstance(child, ast.Attribute):
            names.add(child.attr)
    return names


def default_field(node, doc_resolver=None):
    if node is None:
        return None
    text = string_value(node, doc_resolver)
    if text is not None:
        return {"kind": "literal", "value": text}
    try:
        return {"kind": "literal", "value": ast.literal_eval(node)}
    except Exception:
        return {"kind": "expression", "text": unparse(node)}


def flag_of_field(name):
    return "--" + name.replace("_", "-")


def is_suppress(node):
    return (isinstance(node, ast.Attribute) and node.attr == "SUPPRESS") or (
        isinstance(node, ast.Name) and node.id == "SUPPRESS"
    )


def is_optional(annotation):
    if annotation is None:
        return False
    return bool(annotation_names(annotation) & {"None", "Optional"})


def boolean_optional_flags(flags):
    expanded = []
    for flag in flags:
        expanded.append(flag)
        if flag.startswith("--") and not flag.startswith("--no-"):
            expanded.append("--no-" + flag[2:])
    return expanded


def action_flags(flags, action):
    if action and "BooleanOptionalAction" in action:
        return boolean_optional_flags(flags)
    return flags


def sort_options(options):
    return sorted(options, key=lambda option: (option["flags"][0], option["flags"]))


def write_extract(path, extract):
    payload = json.dumps(extract, ensure_ascii=False, indent=1, sort_keys=False)
    if path in {None, "-"}:
        print(payload)
        return
    Path(path).write_text(payload + "\n", encoding="utf8")


def run_extractor(description, extract):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", default="-")
    arguments = parser.parse_args()

    extracted, diagnostics = extract(arguments.repo)
    write_extract(arguments.out, extracted)
    summary = {
        "options": len(extracted["options"]),
        **{key: len(value) for key, value in diagnostics.items()},
        "details": diagnostics,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=1), file=sys.stderr)
