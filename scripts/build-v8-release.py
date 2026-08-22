#!/usr/bin/env python3
"""Build the byte-limited, semantics-checked Bradbury V8 deployment source."""

from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.metadata
import keyword
import string
from pathlib import Path

import python_minifier


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "contracts" / "LiquidityArenaV8.py"
RELEASE = ROOT / "contracts" / "LiquidityArenaV8.release.py"
MINIFIER_VERSION = "3.2.0"
MAX_RELEASE_BYTES = 45_000
DEPENDS = '# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }'
FACTORY = "0x944fdadd826c2a159c63cb100db174716ccd1317"
ANCHOR_NAMES = {
    "SUPPORTED_ESCROW_CHAIN_IDS",
    "AUDITED_PAYOUT_FACTORY_4221",
}
ERROR_HELPERS = {
    "_expected": "ERROR_EXPECTED",
    "_external": "ERROR_EXTERNAL",
    "_transient": "ERROR_TRANSIENT",
}


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def decorator_text(node: ast.FunctionDef) -> tuple[str, ...]:
    return tuple(ast.unparse(item) for item in node.decorator_list)


def method_signature(node: ast.FunctionDef) -> tuple:
    arguments = []
    for item in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
        arguments.append(
            (
                item.arg,
                ast.unparse(item.annotation) if item.annotation is not None else None,
            )
        )
    return (
        node.name,
        tuple(arguments),
        ast.unparse(node.returns) if node.returns is not None else None,
        decorator_text(node),
    )


def contract_surface(tree: ast.Module) -> tuple:
    contract = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "LiquidityArenaV8"
    )
    storage = tuple(
        (node.target.id, ast.unparse(node.annotation))
        for node in contract.body
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
    )
    constructor = next(
        method_signature(node)
        for node in contract.body
        if isinstance(node, ast.FunctionDef) and node.name == "__init__"
    )
    public = tuple(
        method_signature(node)
        for node in contract.body
        if isinstance(node, ast.FunctionDef)
        and any(value.startswith("gl.public.") for value in decorator_text(node))
    )
    return storage, constructor, public


def generated_names(used: set[str]):
    tails = string.ascii_letters + string.digits
    for first in string.ascii_letters:
        candidate = "_" + first
        if candidate not in used and not keyword.iskeyword(candidate):
            used.add(candidate)
            yield candidate
    for first in string.ascii_letters:
        for second in tails:
            candidate = "_" + first + second
            if candidate not in used and not keyword.iskeyword(candidate):
                used.add(candidate)
                yield candidate


def private_rename_map(tree: ast.Module) -> dict[str, str]:
    candidates: list[str] = []
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and target.id not in ANCHOR_NAMES:
                    candidates.append(target.id)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            if node.name.startswith("_") and node.name != "__init__":
                candidates.append(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                name = alias.asname or alias.name.split(".")[0]
                if name.startswith("_"):
                    candidates.append(name)
    contract = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "LiquidityArenaV8"
    )
    for node in contract.body:
        if (
            isinstance(node, ast.FunctionDef)
            and node.name.startswith("_")
            and node.name != "__init__"
        ):
            candidates.append(node.name)
    used = {
        node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
    } | {
        node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
    }
    names = generated_names(used)
    return {name: next(names) for name in dict.fromkeys(candidates)}


class ReleaseTransform(ast.NodeTransformer):
    def __init__(self, renames: dict[str, str]):
        self.renames = renames
        self.class_depth = 0

    def visit_ClassDef(self, node: ast.ClassDef):
        original = node.name
        self.class_depth += 1
        node = self.generic_visit(node)
        self.class_depth -= 1
        node.name = self.renames.get(original, original)
        return node

    def visit_FunctionDef(self, node: ast.FunctionDef):
        original = node.name
        is_private = original.startswith("_") and original != "__init__"
        if is_private:
            for argument in (
                node.args.posonlyargs + node.args.args + node.args.kwonlyargs
            ):
                argument.annotation = None
            if node.args.vararg is not None:
                node.args.vararg.annotation = None
            if node.args.kwarg is not None:
                node.args.kwarg.annotation = None
            node.returns = None
        if original in ERROR_HELPERS:
            node.args.args = node.args.args[:1]
            category = ERROR_HELPERS[original]
            node.body = ast.parse(
                f'raise gl.vm.UserError(f"{{{category}}} {{code}}")'
            ).body
        node = self.generic_visit(node)
        node.name = self.renames.get(original, original)
        return node

    def visit_Call(self, node: ast.Call):
        original_name = node.func.id if isinstance(node.func, ast.Name) else None
        node = self.generic_visit(node)
        if original_name in ERROR_HELPERS:
            node.args = node.args[:1]
        return node

    def visit_Name(self, node: ast.Name):
        node.id = self.renames.get(node.id, node.id)
        return node

    def visit_Attribute(self, node: ast.Attribute):
        node = self.generic_visit(node)
        if isinstance(node.value, ast.Name) and node.value.id == "self":
            node.attr = self.renames.get(node.attr, node.attr)
        return node

    def visit_alias(self, node: ast.alias):
        bound = node.asname or node.name.split(".")[0]
        if bound in self.renames:
            node.asname = self.renames[bound]
        return node


def remove_anchor_assignments(tree: ast.Module) -> ast.Module:
    filtered = []
    found = set()
    for node in tree.body:
        targets = []
        if isinstance(node, ast.Assign):
            targets = [item.id for item in node.targets if isinstance(item, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            targets = [node.target.id]
        matching = ANCHOR_NAMES.intersection(targets)
        if matching:
            found.update(matching)
        else:
            filtered.append(node)
    if found != ANCHOR_NAMES:
        raise ValueError(f"expected exact anchor assignments, found {sorted(found)}")
    tree.body = filtered
    return tree


def assert_unique_consensus_errors(tree: ast.Module) -> None:
    seen: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        if node.func.id not in {"_external", "_transient"}:
            continue
        if len(node.args) != 2:
            raise ValueError(f"{node.func.id} must have code and message before release")
        expression = ast.unparse(node.args[0])
        if expression in seen:
            raise ValueError(f"consensus error code expression is reused: {expression}")
        seen.add(expression)


def build_release(source_text: str) -> bytes:
    lines = source_text.splitlines()
    if not lines or lines[0] != DEPENDS:
        raise ValueError("readable V8 source has the wrong dependency header")
    if importlib.metadata.version("python-minifier") != MINIFIER_VERSION:
        raise ValueError(f"python-minifier must be exactly {MINIFIER_VERSION}")
    original = ast.parse(source_text, filename=str(SOURCE))
    assert_unique_consensus_errors(original)
    expected_surface = contract_surface(original)
    transformed = ast.parse(source_text, filename=str(SOURCE))
    renames = private_rename_map(transformed)
    transformed = remove_anchor_assignments(transformed)
    transformed = ReleaseTransform(renames).visit(transformed)
    ast.fix_missing_locations(transformed)
    compact = python_minifier.minify(
        ast.unparse(transformed),
        filename=str(SOURCE),
        remove_annotations=False,
        remove_literal_statements=True,
        # Literal hoisting rewrites `-> None` into a generated global name,
        # which changes the GenLayer schema even though Python would execute it.
        hoist_literals=False,
        rename_locals=True,
        rename_globals=False,
        remove_asserts=False,
        remove_debug=False,
    )
    prefix = (
        DEPENDS
        + "\nSUPPORTED_ESCROW_CHAIN_IDS = (4_221,)"
        + f'\nAUDITED_PAYOUT_FACTORY_4221 = "{FACTORY}"\n'
    )
    release = (prefix + compact.rstrip() + "\n").encode("utf-8")
    if len(release) > MAX_RELEASE_BYTES:
        raise ValueError(
            f"release is {len(release)} bytes; maximum is {MAX_RELEASE_BYTES}"
        )
    release_tree = ast.parse(release.decode("utf-8"), filename=str(RELEASE))
    if contract_surface(release_tree) != expected_surface:
        raise ValueError("release public ABI, constructor, or storage surface changed")
    if build_release_once_more(source_text, renames) != release:
        raise ValueError("release generation is not deterministic")
    return release


def build_release_once_more(source_text: str, renames: dict[str, str]) -> bytes:
    tree = remove_anchor_assignments(ast.parse(source_text, filename=str(SOURCE)))
    tree = ReleaseTransform(renames).visit(tree)
    ast.fix_missing_locations(tree)
    compact = python_minifier.minify(
        ast.unparse(tree),
        filename=str(SOURCE),
        remove_annotations=False,
        remove_literal_statements=True,
        hoist_literals=False,
        rename_locals=True,
        rename_globals=False,
        remove_asserts=False,
        remove_debug=False,
    )
    return (
        DEPENDS
        + "\nSUPPORTED_ESCROW_CHAIN_IDS = (4_221,)"
        + f'\nAUDITED_PAYOUT_FACTORY_4221 = "{FACTORY}"\n'
        + compact.rstrip()
        + "\n"
    ).encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    if args.check == args.write:
        parser.error("choose exactly one of --check or --write")
    source_bytes = SOURCE.read_bytes()
    source_text = source_bytes.decode("utf-8")
    release = build_release(source_text)
    if args.write:
        RELEASE.write_bytes(release)
    else:
        if not RELEASE.exists() or RELEASE.read_bytes() != release:
            raise SystemExit("LiquidityArenaV8.release.py is stale; run with --write")
    print(
        f"V8 release OK: readable_sha256={sha256(source_bytes)} "
        f"release_sha256={sha256(release)} bytes={len(release)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
