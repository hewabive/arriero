#!/usr/bin/env python3
"""Extract the `vllm serve` argument declaration from a checkout.

Reads sources only (stdlib ast): no engine import, no venv, no GPU.

Usage:
    python3 scripts/extract-args/vllm.py --repo <vllm-checkout> [--out extract.json]

Contract, invariants and known gaps: docs/ARGUMENT_SOURCE_EXTRACTION.md
"""

import ast
import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pyast import (  # noqa: E402
    action_flags,
    annotation_names,
    choices_of,
    default_field,
    flag_of_field,
    is_optional,
    is_suppress,
    literal_choices,
    merge_module_symbols,
    module_path,
    parse_file,
    run_extractor,
    sort_options,
    string_value,
    unparse,
)

ARG_UTILS_RELATIVE_PATH = "vllm/engine/arg_utils.py"
CLI_ARGS_RELATIVE_PATH = "vllm/entrypoints/openai/cli_args.py"
CONFIG_DIRECTORY = "vllm/config"
ENTRYPOINT = "vllm serve"
FRONTEND_CLASS = "FrontendArgs"
FRONTEND_GROUP = "Frontend"


def source_files(repo):
    root = Path(repo)
    files = sorted((root / CONFIG_DIRECTORY).glob("*.py"))
    files.append(root / ARG_UTILS_RELATIVE_PATH)
    files.append(root / CLI_ARGS_RELATIVE_PATH)
    return [path for path in files if path.exists()]


def attribute_docs(class_node):
    docs = {}
    body = list(class_node.body)
    for first, second in zip(body, body[1:]):
        if not isinstance(first, (ast.Assign, ast.AnnAssign)):
            continue
        if not isinstance(second, ast.Expr) or not isinstance(second.value, ast.Constant):
            continue
        if not isinstance(second.value.value, str):
            continue
        targets = first.targets if isinstance(first, ast.Assign) else [first.target]
        for target in targets:
            if isinstance(target, ast.Name):
                docs[target.id] = inspect.cleandoc(second.value.value)
    return docs


def class_fields(class_node):
    fields = {}
    for node in class_node.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            fields[node.target.id] = {
                "annotation": node.annotation,
                "default": node.value,
            }
    return fields


def imported_modules(tree, relative_path):
    package = Path(relative_path).parent.parts
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
            continue
        if not isinstance(node, ast.ImportFrom):
            continue
        if not node.level:
            if node.module:
                modules.add(node.module)
            continue
        prefix = package[: len(package) - (node.level - 1)] if node.level > 1 else package
        modules.add(".".join([*prefix, node.module]) if node.module else ".".join(prefix))
    return {module for module in modules if module.startswith("vllm")}


def imported_literal_aliases(repo, trees, aliases, constants):
    visited = set()
    for relative_path, tree in trees.items():
        for module in imported_modules(tree, relative_path):
            path = module_path(repo, module)
            if path is None or path in visited:
                continue
            visited.add(path)
            try:
                imported = parse_file(path)
            except (SyntaxError, UnicodeDecodeError):
                continue
            merge_module_symbols(imported, aliases, constants)
    return aliases, constants


def index_sources(repo):
    classes = {}
    aliases = {}
    constants = {}
    trees = {}
    for path in source_files(repo):
        tree = parse_file(path)
        relative = str(path.relative_to(Path(repo)))
        trees[relative] = tree
        merge_module_symbols(tree, aliases, constants)
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            classes.setdefault(
                node.name,
                {
                    "path": relative,
                    "bases": [base.id for base in node.bases if isinstance(base, ast.Name)],
                    "fields": class_fields(node),
                    "docs": attribute_docs(node),
                },
            )
    aliases, constants = imported_literal_aliases(repo, trees, aliases, constants)
    return classes, aliases, constants, trees


def resolve_field(classes, class_name, field, seen=None):
    seen = seen or set()
    if class_name in seen:
        return None
    seen.add(class_name)
    entry = classes.get(class_name)
    if entry is None:
        return None
    if field in entry["fields"]:
        return {
            "class": class_name,
            "path": entry["path"],
            "doc": entry["docs"].get(field),
            **entry["fields"][field],
        }
    for base in entry["bases"]:
        resolved = resolve_field(classes, base, field, seen)
        if resolved is not None:
            return resolved
    return None


def inherited_fields(classes, class_name, seen=None):
    seen = seen or set()
    if class_name in seen:
        return []
    seen.add(class_name)
    entry = classes.get(class_name)
    if entry is None:
        return []
    names = []
    for base in entry["bases"]:
        names.extend(inherited_fields(classes, base, seen))
    names.extend(entry["fields"])
    return list(dict.fromkeys(names))


def is_dataclass_typed(annotation, classes):
    return bool(annotation_names(annotation) & set(classes)) if annotation else False


def wants_boolean_optional(annotation, classes):
    if annotation is None:
        return False
    names = annotation_names(annotation)
    if is_dataclass_typed(annotation, classes):
        return False
    if names & {"bool"} and names & {"str"} and names & {"None"}:
        return False
    return "bool" in names


def collect_bindings(function_node, diagnostics):
    groups = {}
    kwargs_sources = {}
    field_aliases = {}
    for node in ast.walk(function_node):
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Subscript):
            adjusted_key = string_value(target.slice)
            if adjusted_key in {"help", "choices", "metavar"}:
                diagnostics["runtimeAdjustedKwargs"].append(unparse(target))
            continue
        if not isinstance(target, ast.Name):
            continue
        if isinstance(node.value, ast.Subscript) and isinstance(node.value.value, ast.Name):
            source = kwargs_sources.get(node.value.value.id)
            field = string_value(node.value.slice)
            if source and field:
                field_aliases[target.id] = (source, field)
            continue
        if not isinstance(node.value, ast.Call):
            continue
        call = node.value
        if isinstance(call.func, ast.Attribute) and call.func.attr == "add_argument_group":
            title = next(
                (
                    string_value(keyword.value)
                    for keyword in call.keywords
                    if keyword.arg == "title"
                ),
                None,
            )
            groups[target.id] = title
        elif isinstance(call.func, ast.Name) and call.func.id == "get_kwargs":
            if call.args and isinstance(call.args[0], ast.Name):
                kwargs_sources[target.id] = call.args[0].id
    return groups, kwargs_sources, field_aliases


def resolve_kwargs(keywords_node, kwargs_sources, field_aliases):
    reference = {"class": None, "field": None}
    explicit = {}

    def visit_unpacked(value):
        if isinstance(value, ast.Name) and value.id in field_aliases:
            reference["class"], reference["field"] = field_aliases[value.id]
            return
        if isinstance(value, ast.Subscript) and isinstance(value.value, ast.Name):
            source = kwargs_sources.get(value.value.id)
            field = string_value(value.slice)
            if source and field:
                reference["class"] = source
                reference["field"] = field
            return
        if isinstance(value, ast.Dict):
            for key, item in zip(value.keys, value.values):
                if key is None:
                    visit_unpacked(item)
                    continue
                name = string_value(key)
                if name:
                    explicit[name] = item

    for keyword in keywords_node:
        if keyword.arg is None:
            visit_unpacked(keyword.value)
        else:
            explicit[keyword.arg] = keyword.value

    return reference["class"], reference["field"], explicit


def build_option(input):
    flags = input["flags"]
    explicit = input["explicit"]
    field = input["field"]
    classes = input["classes"]
    aliases = input["aliases"]

    annotation = field["annotation"] if field else None
    hidden = is_suppress(explicit.get("help"))
    help_text = None
    if hidden:
        help_text = ""
    elif "help" in explicit:
        help_text = string_value(explicit["help"])
    if help_text is None and field:
        help_text = field.get("doc")

    choices = None
    if "choices" in explicit:
        choices = choices_of(explicit["choices"], aliases, input["constants"])
    if choices is None and annotation is not None:
        choices = literal_choices(annotation, aliases)

    default = None
    if "default" in explicit:
        default = default_field(explicit["default"])
    elif field:
        default = default_field(field["default"])

    action = unparse(explicit["action"]) if "action" in explicit else None
    if action is None and wants_boolean_optional(annotation, classes):
        action = "argparse.BooleanOptionalAction"
    flags = action_flags(flags, action)

    return {
        "flags": flags,
        "group": input["group"],
        "help": help_text or "",
        "choices": choices,
        "optional": is_optional(annotation),
        "default": default,
        "action": action,
        "hidden": hidden,
        "origin": input["origin"],
    }


def parser_function_options(function_node, context, diagnostics):
    groups, kwargs_sources, field_aliases = collect_bindings(function_node, diagnostics)
    options = []
    for node in ast.walk(function_node):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Attribute) or node.func.attr != "add_argument":
            continue

        flags = [
            value
            for value in (string_value(argument) for argument in node.args)
            if value and value.startswith("-")
        ]
        if not flags:
            positional = [
                value for value in (string_value(argument) for argument in node.args) if value
            ]
            diagnostics["positionalArguments"].extend(positional)
            continue

        class_name, field_name, explicit = resolve_kwargs(
            node.keywords, kwargs_sources, field_aliases
        )
        field = (
            resolve_field(context["classes"], class_name, field_name)
            if class_name and field_name
            else None
        )
        if class_name and field is None:
            diagnostics["unresolvedConfigFields"].append(f"{class_name}.{field_name}")

        group = None
        if isinstance(node.func.value, ast.Name):
            group = groups.get(node.func.value.id)
        origin = (
            f"{field['path']}:{class_name}.{field_name}"
            if field
            else f"{context['path']}:{context['function']}"
        )

        options.append(
            build_option(
                {
                    "flags": flags,
                    "group": group or class_name,
                    "explicit": explicit,
                    "field": field,
                    "classes": context["classes"],
                    "aliases": context["aliases"],
                    "constants": context["constants"],
                    "origin": origin,
                }
            )
        )
    return options


def frontend_options(context, diagnostics):
    classes = context["classes"]
    options = []
    for field_name in inherited_fields(classes, FRONTEND_CLASS):
        field = resolve_field(classes, FRONTEND_CLASS, field_name)
        if field is None:
            diagnostics["unresolvedConfigFields"].append(f"{FRONTEND_CLASS}.{field_name}")
            continue
        options.append(
            build_option(
                {
                    "flags": [flag_of_field(field_name)],
                    "group": FRONTEND_GROUP,
                    "explicit": {},
                    "field": field,
                    "classes": classes,
                    "aliases": context["aliases"],
                    "constants": context["constants"],
                    "origin": f"{field['path']}:{field['class']}.{field_name}",
                }
            )
        )
    return options


def find_function(tree, class_name, function_name):
    for node in ast.walk(tree):
        if class_name is not None:
            if not isinstance(node, ast.ClassDef) or node.name != class_name:
                continue
            for child in node.body:
                if isinstance(child, ast.FunctionDef) and child.name == function_name:
                    return child
        elif isinstance(node, ast.FunctionDef) and node.name == function_name:
            return node
    return None


def extract(repo):
    classes, aliases, constants, trees = index_sources(repo)
    arg_utils = trees.get(ARG_UTILS_RELATIVE_PATH)
    cli_args = trees.get(CLI_ARGS_RELATIVE_PATH)
    if arg_utils is None or cli_args is None:
        raise SystemExit(f"vLLM argument sources not found under {repo}")

    diagnostics = {
        "positionalArguments": [],
        "unresolvedConfigFields": [],
        "runtimeAdjustedKwargs": [],
        "duplicateFlags": [],
        "optionsWithoutHelp": [],
    }
    context = {"classes": classes, "aliases": aliases, "constants": constants}

    targets = [
        (cli_args, None, "make_arg_parser", CLI_ARGS_RELATIVE_PATH),
        (arg_utils, "EngineArgs", "add_cli_args", ARG_UTILS_RELATIVE_PATH),
        (arg_utils, "AsyncEngineArgs", "add_cli_args", ARG_UTILS_RELATIVE_PATH),
    ]

    options = []
    for tree, class_name, function_name, path in targets:
        function_node = find_function(tree, class_name, function_name)
        if function_node is None:
            raise SystemExit(f"{class_name or ''}.{function_name} not found in {path}")
        options.extend(
            parser_function_options(
                function_node,
                {**context, "path": path, "function": function_name},
                diagnostics,
            )
        )
    options.extend(frontend_options(context, diagnostics))

    unique = {}
    for option in options:
        primary = option["flags"][0]
        if primary in unique:
            diagnostics["duplicateFlags"].append(primary)
            continue
        unique[primary] = option
        if not option["help"] and not option["hidden"]:
            diagnostics["optionsWithoutHelp"].append(primary)

    return {
        "schema": 1,
        "engine": "vllm",
        "entrypoint": ENTRYPOINT,
        "sourceFiles": [ARG_UTILS_RELATIVE_PATH, CLI_ARGS_RELATIVE_PATH, CONFIG_DIRECTORY],
        "options": sort_options(list(unique.values())),
    }, diagnostics


if __name__ == "__main__":
    run_extractor("Extract vLLM argument declarations", extract)
