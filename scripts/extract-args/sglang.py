#!/usr/bin/env python3
"""Extract the SGLang launch-server argument declaration from a checkout.

Reads sources only (stdlib ast): no engine import, no venv, no GPU.

Usage:
    python3 scripts/extract-args/sglang.py --repo <sglang-checkout> [--out extract.json]

Contract, invariants and known gaps: docs/ARGUMENT_SOURCE_EXTRACTION.md
"""

import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pyast import (  # noqa: E402
    action_flags,
    annotation_names,
    boolean_action_type,
    choices_of,
    constant_values,
    declared_type,
    default_field,
    flag_of_field,
    is_named_subscript,
    is_optional,
    is_suppress,
    literal_choices,
    merge_module_symbols,
    module_docstrings,
    module_level_statements,
    module_path,
    named_assignments,
    parse_file,
    parser_type,
    run_extractor,
    sort_options,
    string_value,
    subscript_elements,
    unparse,
)

SERVER_ARGS_RELATIVE_PATH = "python/sglang/srt/server_args.py"
PACKAGE_ROOT = "python"
ENTRYPOINT = "python -m sglang.launch_server"
MIN_NAMESPACE_OPTIONS = 100


def imported_modules(tree):
    modules = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
        elif isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
    return [module for module in modules if module.startswith("sglang")]


def module_context(repo, tree):
    aliases = {}
    constants = {}
    docs = dict(module_docstrings(tree))
    merge_module_symbols(tree, aliases, constants)
    for module in imported_modules(tree):
        path = module_path(repo, module, PACKAGE_ROOT)
        if path is None:
            continue
        try:
            imported = parse_file(path)
        except SyntaxError:
            continue
        merge_module_symbols(imported, aliases, constants)
        for name, doc in module_docstrings(imported).items():
            docs.setdefault(name, doc)
    return {
        "aliases": aliases,
        "constants": constants,
        "resolveDoc": docstring_resolver(docs),
    }


def docstring_resolver(docs):
    def resolve(expression):
        if not expression.endswith(".__doc__"):
            return None
        return docs.get(expression[: -len(".__doc__")])

    return resolve


def find_class(tree, name):
    return next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.ClassDef) and node.name == name
        ),
        None,
    )


def annotated_parts(annotation):
    if not is_named_subscript(annotation, {"A", "Annotated"}):
        return None
    parts = subscript_elements(annotation)
    return parts if len(parts) >= 2 else None


def arg_metadata(parts, resolve_doc):
    metadata = {
        "help": None,
        "aliases": [],
        "cliName": None,
        "choices": None,
        "choicesResolved": None,
        "action": None,
        "noCli": False,
        "hidden": False,
        "typeParser": None,
    }
    for meta in parts[1:]:
        text = string_value(meta, resolve_doc)
        if text is not None:
            metadata["help"] = text
            continue
        if not isinstance(meta, ast.Call) or not isinstance(meta.func, ast.Name):
            continue
        if meta.func.id != "Arg":
            continue
        if meta.args:
            metadata["help"] = string_value(meta.args[0], resolve_doc)
        for keyword in meta.keywords:
            value = keyword.value
            if keyword.arg == "help":
                if is_suppress(value):
                    metadata["hidden"] = True
                    metadata["help"] = ""
                else:
                    metadata["help"] = string_value(value, resolve_doc)
            elif keyword.arg == "aliases":
                metadata["aliases"] = constant_values(value) or []
            elif keyword.arg == "cli_name":
                metadata["cliName"] = string_value(value)
            elif keyword.arg == "choices":
                metadata["choices"] = value
            elif keyword.arg == "action":
                metadata["action"] = unparse(value)
            elif keyword.arg == "type_parser":
                metadata["typeParser"] = value
            elif keyword.arg == "no_cli":
                metadata["noCli"] = isinstance(value, ast.Constant) and value.value
    return metadata


def dataclass_options(cls, source, namespace, context, diagnostics):
    aliases = context["aliases"]
    constants = context["constants"]
    resolve_doc = context["resolveDoc"]
    options = []
    for node in cls.body:
        if not isinstance(node, ast.AnnAssign) or not isinstance(node.target, ast.Name):
            continue
        field = node.target.id
        parts = annotated_parts(node.annotation)
        if parts is None:
            diagnostics["fieldsWithoutCliMetadata"].append(field)
            continue

        metadata = arg_metadata(parts, resolve_doc)
        if metadata["noCli"]:
            diagnostics["fieldsMarkedNoCli"].append(field)
            continue
        if metadata["help"] is None:
            diagnostics["fieldsWithoutCliMetadata"].append(field)
            continue

        choices = choices_of(metadata["choices"], aliases, constants) or literal_choices(
            parts[0], aliases
        )
        if choices is None and (
            metadata["choices"] is not None or "Literal" in annotation_names(parts[0])
        ):
            diagnostics["unresolvedChoices"].append(field)

        value_type = (
            parser_type(metadata["typeParser"])
            or declared_type(parts[0], aliases)
            or boolean_action_type(metadata["action"])
        )

        options.append(
            {
                "flags": action_flags(
                    [metadata["cliName"] or flag_of_field(field)]
                    + list(metadata["aliases"]),
                    metadata["action"],
                ),
                "group": namespace,
                "help": metadata["help"],
                "choices": choices,
                "type": value_type,
                "optional": is_optional(parts[0]),
                "default": default_field(node.value, resolve_doc),
                "action": metadata["action"],
                "hidden": metadata["hidden"],
                "origin": f"{source}:{cls.name}.{field}",
            }
        )
    return options


def assigned_value(scope, name):
    return dict(named_assignments(scope)).get(name)


def input_namespace_names(tree):
    value = assigned_value(tree, "_INPUT_NAMESPACES")
    if value is None:
        raise SystemExit("_INPUT_NAMESPACES not found in server_args.py")
    if not isinstance(value, ast.List) or not all(
        isinstance(item, ast.Name) for item in value.elts
    ):
        raise SystemExit("_INPUT_NAMESPACES is not a literal list of classes")
    if not value.elts:
        raise SystemExit("_INPUT_NAMESPACES is empty")
    return [item.id for item in value.elts]


def imported_classes(tree):
    return {
        alias.asname or alias.name: (node.module, alias.name)
        for node in module_level_statements(tree)
        if isinstance(node, ast.ImportFrom) and node.module
        for alias in node.names
    }


def namespace_classes(repo, tree, names):
    imports = imported_classes(tree)
    classes = []
    for name in names:
        module, class_name = imports.get(name, (None, name))
        path = module_path(repo, module, PACKAGE_ROOT) if module else None
        cls = find_class(parse_file(path), class_name) if path else None
        if cls is None:
            raise SystemExit(f"SGLang input namespace not found: {name}")
        namespace = string_value(assigned_value(cls, "_NS_PATH"))
        if not namespace:
            raise SystemExit(f"missing _NS_PATH for SGLang namespace: {name}")
        classes.append((path, cls, namespace))
    return classes


def explicit_options(server_args, context, diagnostics):
    aliases = context["aliases"]
    constants = context["constants"]
    resolve_doc = context["resolveDoc"]
    add_cli_args = next(
        (
            node
            for node in server_args.body
            if isinstance(node, ast.FunctionDef) and node.name == "add_cli_args"
        ),
        None,
    )
    if add_cli_args is None:
        raise SystemExit("ServerArgs.add_cli_args not found")

    options = []
    for node in ast.walk(add_cli_args):
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
            continue

        keywords = {
            keyword.arg: keyword.value for keyword in node.keywords if keyword.arg
        }
        hidden = is_suppress(keywords.get("help"))
        help_text = "" if hidden else string_value(keywords.get("help"), resolve_doc)
        if help_text is None and "help" in keywords:
            diagnostics["unresolvedHelp"].append(flags[0])

        choices = choices_of(keywords.get("choices"), aliases, constants)
        if choices is None and "choices" in keywords:
            diagnostics["unresolvedChoices"].append(flags[0])

        action = unparse(keywords["action"]) if "action" in keywords else None
        options.append(
            {
                "flags": action_flags(flags, action),
                "group": None,
                "help": help_text or "",
                "choices": choices,
                "type": parser_type(keywords.get("type")) or boolean_action_type(action),
                "optional": False,
                "default": default_field(keywords.get("default"), resolve_doc),
                "action": action,
                "hidden": hidden,
                "origin": f"{SERVER_ARGS_RELATIVE_PATH}:ServerArgs.add_cli_args",
            }
        )
    return options


def extract(repo):
    server_args_path = Path(repo) / SERVER_ARGS_RELATIVE_PATH
    if not server_args_path.exists():
        raise SystemExit(f"server_args.py not found: {server_args_path}")

    tree = parse_file(server_args_path)
    server_args = find_class(tree, "ServerArgs")
    if server_args is None:
        raise SystemExit(f"ServerArgs class not found in {server_args_path}")

    diagnostics = {
        "fieldsWithoutCliMetadata": [],
        "fieldsMarkedNoCli": [],
        "unresolvedChoices": [],
        "unresolvedHelp": [],
        "duplicateFlags": [],
        "optionsWithoutType": [],
    }

    classes = namespace_classes(repo, tree, input_namespace_names(tree))
    sources = {path: path.relative_to(repo).as_posix() for path, _, _ in classes}
    contexts = {path: module_context(repo, parse_file(path)) for path in sources}
    options = []
    for path, cls, namespace in classes:
        field_options = dataclass_options(
            cls, sources[path], namespace, contexts[path], diagnostics
        )
        if not field_options:
            raise SystemExit(f"no CLI fields found in SGLang namespace: {namespace}")
        options.extend(field_options)
    if len(options) < MIN_NAMESPACE_OPTIONS:
        raise SystemExit(
            f"SGLang input namespaces yielded fewer than {MIN_NAMESPACE_OPTIONS} CLI fields"
        )
    source_files = [SERVER_ARGS_RELATIVE_PATH, *sources.values()]
    declared = {option["flags"][0] for option in options}
    for option in explicit_options(
        server_args, module_context(repo, tree), diagnostics
    ):
        if option["flags"][0] in declared:
            diagnostics["duplicateFlags"].append(option["flags"][0])
            continue
        declared.add(option["flags"][0])
        options.append(option)

    diagnostics["optionsWithoutType"].extend(
        option["flags"][0] for option in options if option["type"] is None
    )

    return {
        "schema": 1,
        "engine": "sglang",
        "entrypoint": ENTRYPOINT,
        "sourceFiles": source_files,
        "options": sort_options(options),
    }, diagnostics


if __name__ == "__main__":
    run_extractor("Extract SGLang argument declarations", extract)
