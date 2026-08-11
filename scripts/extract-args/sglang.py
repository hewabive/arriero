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
    module_path,
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


def imported_modules(tree):
    modules = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
        elif isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
    return [module for module in modules if module.startswith("sglang")]


def index_referenced_modules(repo, tree):
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
    return aliases, constants, docs


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
        "namespace": None,
        "typeParser": None,
    }
    for meta in parts[1:]:
        text = string_value(meta, resolve_doc)
        if text is not None:
            metadata["help"] = text
            continue
        if not isinstance(meta, ast.Call) or not isinstance(meta.func, ast.Name):
            continue
        if meta.func.id == "NS" and meta.args:
            metadata["namespace"] = string_value(meta.args[0])
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


def dataclass_options(server_args, context, diagnostics):
    aliases = context["aliases"]
    constants = context["constants"]
    resolve_doc = context["resolveDoc"]
    options = []
    for node in server_args.body:
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
                "group": metadata["namespace"],
                "help": metadata["help"],
                "choices": choices,
                "type": value_type,
                "optional": is_optional(parts[0]),
                "default": default_field(node.value, resolve_doc),
                "action": metadata["action"],
                "hidden": metadata["hidden"],
                "origin": f"ServerArgs.{field}",
            }
        )
    return options


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
                "origin": "ServerArgs.add_cli_args",
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

    aliases, constants, docs = index_referenced_modules(repo, tree)
    context = {
        "aliases": aliases,
        "constants": constants,
        "resolveDoc": docstring_resolver(docs),
    }
    diagnostics = {
        "fieldsWithoutCliMetadata": [],
        "fieldsMarkedNoCli": [],
        "unresolvedChoices": [],
        "unresolvedHelp": [],
        "duplicateFlags": [],
        "optionsWithoutType": [],
    }

    options = dataclass_options(server_args, context, diagnostics)
    declared = {option["flags"][0] for option in options}
    for option in explicit_options(server_args, context, diagnostics):
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
        "sourceFiles": [SERVER_ARGS_RELATIVE_PATH],
        "options": sort_options(options),
    }, diagnostics


if __name__ == "__main__":
    run_extractor("Extract SGLang argument declarations", extract)
