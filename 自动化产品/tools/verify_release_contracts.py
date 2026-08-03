#!/usr/bin/env python3
"""Verify release artifacts without importing or starting the application.

The checks in this file intentionally use only the Python standard library so
they can run against an unpacked release before any dependency installation or
database migration:

* ``esm`` verifies that every reachable local ESM file has one browser URL
  identity. Loading one physical module through two query strings creates two
  independent module instances and is rejected.
* ``canvas`` verifies the vendored infinite-canvas closure against its stored
  path/size/SHA-256 manifest. It does not require the canvas source tree or its
  ``out`` directory.
* ``runtime`` verifies the main backend, migration/backup helpers, deployment
  scripts, video sidecar, video web bridge and dependency declarations against
  a release-owned SHA-256 manifest.
* ``all`` runs every check and prints the Phase 0 release-contract tuple.

This verifier is read-only. It never imports ``server.main`` / ``server.store``
and therefore cannot trigger startup schema changes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import unquote, urlsplit


SCHEMA_VERSION = 1
RUNTIME_MANIFEST_PATH = Path("deploy/release-runtime.manifest.json")
RUNTIME_EXACT_PATHS = {
    "server/config.py",
    "server/main.py",
    "server/store.py",
    "server/requirements.txt",
    "server/minimax_system_voices.json",
    "apps/video-workshop/run.py",
    "apps/video-workshop/requirements.txt",
    "tools/verify_release_contracts.py",
}
RUNTIME_PREFIX_RULES = (
    ("server/migrations", ""),
    ("server/scripts", ".py"),
    ("apps/video-workshop/app", ""),
    ("apps/video-workshop/web", ""),
    ("apps/video-workshop/skills/video-production", ""),
    ("apps/video-workshop/vendor/OpenMontage", ""),
    ("deploy", ".sh"),
)
RUNTIME_IGNORED_DIRECTORY_NAMES = {"__pycache__"}
RUNTIME_IGNORED_FILE_SUFFIXES = {".pyc"}


class ContractError(RuntimeError):
    """A release contract is invalid or cannot be verified safely."""


@dataclass(frozen=True)
class ImportUse:
    importer: str
    line: int
    specifier: str
    identity: str


@dataclass(frozen=True)
class _Token:
    kind: str
    value: str
    line: int


class _ModuleScriptParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.entries: List[Tuple[int, str]] = []
        self.inline_modules: List[int] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if tag.lower() != "script":
            return
        values = {key.lower(): value for key, value in attrs}
        if (values.get("type") or "").lower() != "module":
            return
        if not values.get("src"):
            self.inline_modules.append(self.getpos()[0])
            return
        self.entries.append((self.getpos()[0], values["src"] or ""))


def _sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _strict_json_load(path: Path) -> Tuple[Dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ContractError(f"cannot read manifest {path}: {exc}") from exc

    def no_duplicate_keys(pairs: Iterable[Tuple[str, Any]]) -> Dict[str, Any]:
        value: Dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise ContractError(f"duplicate JSON key in manifest: {key}")
            value[key] = item
        return value

    try:
        parsed = json.loads(raw.decode("utf-8"), object_pairs_hook=no_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError(f"invalid UTF-8 JSON manifest {path}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ContractError("manifest root must be an object")
    return parsed, raw


def _tokenize_javascript(source: str) -> List[_Token]:
    """Return enough JavaScript tokens to locate literal ESM imports.

    This is deliberately a small lexer rather than a regular expression so
    commented-out imports and prompt strings do not enter the module graph.
    Template literal bodies are skipped; the repository release graph uses
    literal string import specifiers.
    """

    def skip_quoted(index: int, line: int, quote: str, label: str) -> Tuple[int, int]:
        start_line = line
        index += 1
        while index < len(source):
            current = source[index]
            if current == "\\":
                if index + 1 >= len(source):
                    break
                if source[index + 1] == "\n":
                    line += 1
                index += 2
                continue
            if current == quote:
                return index + 1, line
            if current == "\n":
                if quote != "`":
                    break
                line += 1
            index += 1
        raise ContractError(f"unterminated JavaScript {label} at line {start_line}")

    def skip_template(index: int, line: int) -> Tuple[int, int]:
        start_line = line
        index += 1
        while index < len(source):
            current = source[index]
            if current == "\\":
                if index + 1 >= len(source):
                    break
                if source[index + 1] == "\n":
                    line += 1
                index += 2
                continue
            if current == "`":
                return index + 1, line
            if current == "\n":
                line += 1
                index += 1
                continue
            if current == "$" and index + 1 < len(source) and source[index + 1] == "{":
                index, line = skip_template_expression(index + 2, line, start_line)
                continue
            index += 1
        raise ContractError(f"unterminated JavaScript template at line {start_line}")

    def skip_template_expression(index: int, line: int, template_line: int) -> Tuple[int, int]:
        depth = 1
        while index < len(source):
            current = source[index]
            if current in {'"', "'"}:
                index, line = skip_quoted(index, line, current, "string")
                continue
            if current == "`":
                index, line = skip_template(index, line)
                continue
            if current == "/" and index + 1 < len(source) and source[index + 1] == "/":
                index += 2
                while index < len(source) and source[index] != "\n":
                    index += 1
                continue
            if current == "/" and index + 1 < len(source) and source[index + 1] == "*":
                index += 2
                while index + 1 < len(source) and source[index : index + 2] != "*/":
                    if source[index] == "\n":
                        line += 1
                    index += 1
                if index + 1 >= len(source):
                    raise ContractError(f"unterminated JavaScript comment at line {template_line}")
                index += 2
                continue
            if source.startswith("import", index):
                before = source[index - 1] if index else ""
                after_index = index + len("import")
                after = source[after_index] if after_index < len(source) else ""
                if not (before.isalnum() or before in "_$") and not (after.isalnum() or after in "_$"):
                    raise ContractError(
                        f"dynamic import inside a template expression is not supported at line {line}"
                    )
            if current == "{":
                depth += 1
            elif current == "}":
                depth -= 1
                if depth == 0:
                    return index + 1, line
            elif current == "\n":
                line += 1
            index += 1
        raise ContractError(f"unterminated JavaScript template expression at line {template_line}")

    tokens: List[_Token] = []
    length = len(source)
    index = 0
    line = 1
    while index < length:
        char = source[index]
        if char in " \t\r":
            index += 1
            continue
        if char == "\n":
            line += 1
            index += 1
            continue
        if char == "/" and index + 1 < length and source[index + 1] == "/":
            index += 2
            while index < length and source[index] != "\n":
                index += 1
            continue
        if char == "/" and index + 1 < length and source[index + 1] == "*":
            start_line = line
            index += 2
            while index + 1 < length and source[index : index + 2] != "*/":
                if source[index] == "\n":
                    line += 1
                index += 1
            if index + 1 >= length:
                raise ContractError(f"unterminated JavaScript comment at line {start_line}")
            index += 2
            continue
        if char == "/":
            previous = tokens[-1] if tokens else None
            regex_prefix = previous is None or (
                previous.kind == "punctuation" and previous.value in "([{,:;=!?&|+-*%^~<>"
            ) or (
                previous.kind == "identifier"
                and previous.value
                in {
                    "await",
                    "case",
                    "delete",
                    "do",
                    "else",
                    "in",
                    "instanceof",
                    "new",
                    "of",
                    "return",
                    "throw",
                    "typeof",
                    "void",
                    "yield",
                }
            )
            if regex_prefix:
                token_line = line
                index += 1
                escaped = False
                in_class = False
                while index < length:
                    current = source[index]
                    if current == "\n":
                        raise ContractError(f"unterminated JavaScript regular expression at line {token_line}")
                    if not escaped:
                        if current == "[":
                            in_class = True
                        elif current == "]":
                            in_class = False
                        elif current == "/" and not in_class:
                            index += 1
                            while index < length and source[index].isalpha():
                                index += 1
                            tokens.append(_Token("regex", "", token_line))
                            break
                    if not escaped and current == "\\":
                        escaped = True
                    else:
                        escaped = False
                    index += 1
                else:
                    raise ContractError(f"unterminated JavaScript regular expression at line {token_line}")
                continue
        if char in {'"', "'"}:
            quote = char
            token_line = line
            index += 1
            value: List[str] = []
            while index < length:
                current = source[index]
                if current == quote:
                    index += 1
                    tokens.append(_Token("string", "".join(value), token_line))
                    break
                if current == "\\":
                    if index + 1 >= length:
                        raise ContractError(f"unterminated JavaScript string at line {token_line}")
                    following = source[index + 1]
                    if following == "\n":
                        line += 1
                    else:
                        value.append(following)
                    index += 2
                    continue
                if current == "\n":
                    raise ContractError(f"unterminated JavaScript string at line {token_line}")
                value.append(current)
                index += 1
            else:
                raise ContractError(f"unterminated JavaScript string at line {token_line}")
            continue
        if char == "`":
            index, line = skip_template(index, line)
            continue
        if char.isalpha() or char in "_$":
            token_line = line
            start = index
            index += 1
            while index < length and (source[index].isalnum() or source[index] in "_$"):
                index += 1
            tokens.append(_Token("identifier", source[start:index], token_line))
            continue
        tokens.append(_Token("punctuation", char, line))
        index += 1
    return tokens


def _literal_imports(source: str) -> List[Tuple[int, str]]:
    tokens = _tokenize_javascript(source)
    found: List[Tuple[int, str]] = []
    for index, token in enumerate(tokens):
        if token.kind != "identifier" or token.value not in {"import", "export"}:
            continue
        cursor = index + 1
        if token.value == "import" and cursor < len(tokens):
            next_token = tokens[cursor]
            if next_token.value == ".":  # import.meta
                continue
            if next_token.kind == "string":  # import "./side-effect.js"
                found.append((next_token.line, next_token.value))
                continue
            if next_token.value == "(":  # import("./dynamic.js")
                if cursor + 1 < len(tokens) and tokens[cursor + 1].kind == "string":
                    specifier = tokens[cursor + 1]
                    found.append((specifier.line, specifier.value))
                else:
                    raise ContractError(f"dynamic import must use a literal string at line {token.line}")
                continue
        while cursor < len(tokens):
            candidate = tokens[cursor]
            if candidate.value == ";":
                break
            if candidate.kind == "identifier" and candidate.value in {"import", "export"}:
                break
            if candidate.kind == "identifier" and candidate.value == "from":
                if cursor + 1 < len(tokens) and tokens[cursor + 1].kind == "string":
                    specifier = tokens[cursor + 1]
                    found.append((specifier.line, specifier.value))
                break
            cursor += 1
    return found


def _is_local_specifier(specifier: str) -> bool:
    return specifier.startswith("./") or specifier.startswith("../") or (
        specifier.startswith("/") and not specifier.startswith("//")
    )


def _resolve_local_module(app_root: Path, importer: Path, specifier: str) -> Tuple[Path, str]:
    parts = urlsplit(specifier)
    if parts.scheme or parts.netloc:
        raise ContractError(f"local specifier unexpectedly contains an origin: {specifier}")
    decoded_path = unquote(parts.path)
    candidate = app_root / decoded_path.lstrip("/") if decoded_path.startswith("/") else importer.parent / decoded_path
    # Resolve ``..`` lexically, then reject every symlink component before any
    # filesystem resolution can erase the alias evidence.
    target = Path(os.path.abspath(candidate))
    try:
        relative = target.relative_to(app_root)
    except ValueError as exc:
        raise ContractError(f"local import escapes the release root: {specifier}") from exc
    cursor = app_root
    for component in relative.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise ContractError(f"local import traverses a symlink: {relative.as_posix()}")
    if not target.is_file():
        raise ContractError(f"local import is missing or not a regular file: {relative.as_posix()}")
    identity = f"/{relative.as_posix()}"
    if parts.query:
        identity += f"?{parts.query}"
    if parts.fragment:
        identity += f"#{parts.fragment}"
    return target, identity


def verify_esm(app_root: Path) -> Dict[str, Any]:
    app_root = app_root.resolve()
    index_path = app_root / "index.html"
    if not index_path.is_file() or index_path.is_symlink():
        raise ContractError(f"missing regular ESM entry document: {index_path}")
    parser = _ModuleScriptParser()
    try:
        index_content = index_path.read_bytes()
        parser.feed(index_content.decode("utf-8"))
    except (OSError, UnicodeDecodeError) as exc:
        raise ContractError(f"cannot parse ESM entry document: {exc}") from exc
    if parser.inline_modules:
        raise ContractError(
            f"inline type=module scripts are not allowed because they cannot have a canonical file identity: "
            f"lines={parser.inline_modules}"
        )
    if not parser.entries:
        raise ContractError("index.html has no external type=module entry")

    identities: Dict[Path, List[ImportUse]] = {}
    queue: List[Path] = []
    entry_identities: List[str] = []
    for line, specifier in parser.entries:
        if not _is_local_specifier(specifier):
            raise ContractError(f"module entry must be same-origin and local: {specifier}")
        target, identity = _resolve_local_module(app_root, index_path, specifier)
        identities.setdefault(target, []).append(ImportUse("index.html", line, specifier, identity))
        queue.append(target)
        entry_identities.append(identity)

    visited: set[Path] = set()
    edges: List[Tuple[str, str, str]] = []
    closure_files: List[Tuple[str, int, str]] = []
    while queue:
        importer = queue.pop()
        if importer in visited:
            continue
        visited.add(importer)
        try:
            source_content = importer.read_bytes()
            source = source_content.decode("utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise ContractError(f"cannot read ESM module {importer}: {exc}") from exc
        importer_name = importer.relative_to(app_root).as_posix()
        closure_files.append((importer_name, len(source_content), _sha256_bytes(source_content)))
        try:
            imports = _literal_imports(source)
        except ContractError as exc:
            raise ContractError(f"cannot inspect ESM module {importer_name}: {exc}") from exc
        for line, specifier in imports:
            if not _is_local_specifier(specifier):
                raise ContractError(
                    f"ESM dependency must be bundled and same-origin: {importer_name}:{line} {specifier}"
                )
            target, identity = _resolve_local_module(app_root, importer, specifier)
            use = ImportUse(importer_name, line, specifier, identity)
            identities.setdefault(target, []).append(use)
            edges.append((importer_name, target.relative_to(app_root).as_posix(), identity))
            if target not in visited:
                queue.append(target)

    conflicts: List[Dict[str, Any]] = []
    for target, uses in sorted(identities.items(), key=lambda item: item[0].as_posix()):
        unique = sorted({use.identity for use in uses})
        if len(unique) <= 1:
            continue
        conflicts.append(
            {
                "module": target.relative_to(app_root).as_posix(),
                "identities": unique,
                "uses": [
                    {
                        "importer": use.importer,
                        "line": use.line,
                        "specifier": use.specifier,
                        "identity": use.identity,
                    }
                    for use in sorted(uses, key=lambda item: (item.importer, item.line, item.specifier))
                ],
            }
        )

    graph_material = json.dumps(sorted(edges), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    closure_material = json.dumps(
        sorted(closure_files), ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return {
        "ok": not conflicts,
        "entryIdentities": sorted(entry_identities),
        "entryDocumentSha256": _sha256_bytes(index_content),
        "reachableModules": len(visited),
        "localImportEdges": len(edges),
        "moduleGraphSha256": _sha256_bytes(graph_material),
        "moduleClosureSha256": _sha256_bytes(closure_material),
        "conflicts": conflicts,
    }


def _manifest_entry_path(raw: Any) -> str:
    if not isinstance(raw, str) or not raw or "\\" in raw:
        raise ContractError(f"invalid manifest path: {raw!r}")
    pure = PurePosixPath(raw)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ContractError(f"unsafe manifest path: {raw!r}")
    if pure.as_posix() != raw:
        raise ContractError(f"non-canonical manifest path: {raw!r}")
    return raw


def _checked_release_path(app_root: Path, relative: Path | str, *, label: str) -> Path:
    """Return a lexical child path after rejecting every symlink component."""

    relative_path = Path(relative)
    if relative_path.is_absolute() or any(part in {"", ".", ".."} for part in relative_path.parts):
        raise ContractError(f"unsafe {label} path: {relative_path}")
    cursor = app_root
    for component in relative_path.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise ContractError(f"{label} traverses a symlink: {relative_path.as_posix()}")
    return cursor


def runtime_release_files(app_root: Path) -> List[str]:
    """Return the exact deployable backend/sidecar closure covered by v137."""

    app_root = app_root.resolve()
    found = set(RUNTIME_EXACT_PATHS)
    for relative in RUNTIME_EXACT_PATHS:
        path = _checked_release_path(app_root, relative, label="runtime file")
        if not path.is_file():
            raise ContractError(f"required runtime file is missing or unsafe: {relative}")
    for prefix, suffix in RUNTIME_PREFIX_RULES:
        root = _checked_release_path(app_root, prefix, label="runtime directory")
        if not root.is_dir():
            raise ContractError(f"required runtime directory is missing or unsafe: {prefix}")
        prefix_found = 0
        for current, directory_names, file_names in os.walk(root, followlinks=False):
            current_path = Path(current)
            for name in directory_names:
                directory = current_path / name
                if directory.is_symlink():
                    raise ContractError(
                        f"runtime closure contains a directory symlink: {directory.relative_to(app_root)}"
                    )
            directory_names[:] = [
                name for name in directory_names
                if name not in RUNTIME_IGNORED_DIRECTORY_NAMES
            ]
            for name in file_names:
                path = current_path / name
                if path.is_symlink():
                    raise ContractError(
                        f"runtime closure contains a non-regular file: {path.relative_to(app_root)}"
                    )
                if path.suffix in RUNTIME_IGNORED_FILE_SUFFIXES:
                    continue
                if suffix and path.suffix != suffix:
                    continue
                relative = path.relative_to(app_root)
                checked_path = _checked_release_path(app_root, relative, label="runtime file")
                if not checked_path.is_file():
                    raise ContractError(
                        f"runtime closure contains a non-regular file: {path.relative_to(app_root)}"
                    )
                found.add(relative.as_posix())
                prefix_found += 1
        if prefix_found == 0:
            raise ContractError(f"runtime closure is empty: {prefix}")
    return sorted(found)


def build_runtime_manifest_data(app_root: Path, release_id: str) -> Dict[str, Any]:
    release_id = str(release_id or "").strip()
    if not release_id or len(release_id) > 160:
        raise ContractError("runtime manifest requires a release id")
    app_root = app_root.resolve()
    files = []
    for relative in runtime_release_files(app_root):
        content = _checked_release_path(
            app_root, relative, label="runtime file"
        ).read_bytes()
        files.append({
            "path": relative,
            "size": len(content),
            "sha256": _sha256_bytes(content),
        })
    return {
        "schemaVersion": SCHEMA_VERSION,
        "releaseId": release_id,
        "fileCount": len(files),
        "totalBytes": sum(item["size"] for item in files),
        "files": files,
    }


def verify_runtime(app_root: Path, expected_release_id: str = "") -> Dict[str, Any]:
    app_root = app_root.resolve()
    manifest_path = _checked_release_path(
        app_root, RUNTIME_MANIFEST_PATH, label="runtime manifest"
    )
    if not manifest_path.is_file():
        raise ContractError(f"runtime manifest is missing or unsafe: {manifest_path}")
    manifest, raw_manifest = _strict_json_load(manifest_path)
    expected_keys = {"schemaVersion", "releaseId", "fileCount", "totalBytes", "files"}
    if set(manifest) != expected_keys:
        raise ContractError("unexpected runtime manifest keys")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError("unsupported runtime manifest schemaVersion")
    release_id = str(manifest.get("releaseId") or "").strip()
    if not release_id or len(release_id) > 160:
        raise ContractError("invalid runtime manifest releaseId")
    expected_release_id = str(expected_release_id or "").strip()
    if expected_release_id and release_id != expected_release_id:
        raise ContractError(
            f"runtime manifest releaseId mismatch: expected={expected_release_id} actual={release_id}"
        )
    raw_files = manifest.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ContractError("runtime manifest files must be a non-empty array")
    described: Dict[str, Tuple[int, str]] = {}
    ordered_paths: List[str] = []
    for entry in raw_files:
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise ContractError(f"invalid runtime manifest file entry: {entry!r}")
        path = _manifest_entry_path(entry["path"])
        if path in described:
            raise ContractError(f"duplicate runtime manifest path: {path}")
        size = entry["size"]
        digest = entry["sha256"]
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ContractError(f"invalid runtime file size: {path}")
        if not isinstance(digest, str) or len(digest) != 64 or any(
            char not in "0123456789abcdef" for char in digest
        ):
            raise ContractError(f"invalid runtime file SHA-256: {path}")
        described[path] = (size, digest)
        ordered_paths.append(path)
    if manifest.get("fileCount") != len(described):
        raise ContractError("runtime manifest fileCount does not match files")
    if manifest.get("totalBytes") != sum(size for size, _ in described.values()):
        raise ContractError("runtime manifest totalBytes does not match files")
    actual_paths = runtime_release_files(app_root)
    if set(actual_paths) != set(ordered_paths):
        missing = sorted(set(ordered_paths) - set(actual_paths))
        extra = sorted(set(actual_paths) - set(ordered_paths))
        raise ContractError(f"runtime closure path mismatch; missing={missing}, extra={extra}")
    for path in ordered_paths:
        content = _checked_release_path(
            app_root, path, label="runtime file"
        ).read_bytes()
        size, digest = described[path]
        if len(content) != size or _sha256_bytes(content) != digest:
            raise ContractError(f"runtime file does not match manifest: {path}")
    return {
        "ok": True,
        "releaseId": release_id,
        "fileCount": len(ordered_paths),
        "totalBytes": sum(size for size, _ in described.values()),
        "manifestSha256": _sha256_bytes(raw_manifest),
    }


def _list_regular_files(root: Path) -> List[str]:
    if not root.is_dir() or root.is_symlink():
        raise ContractError(f"canvas vendor closure is missing or not a regular directory: {root}")
    files: List[str] = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in directory_names:
            candidate = current_path / name
            if candidate.is_symlink():
                raise ContractError(f"canvas closure contains a directory symlink: {candidate.relative_to(root)}")
        for name in file_names:
            candidate = current_path / name
            if candidate.is_symlink() or not candidate.is_file():
                raise ContractError(f"canvas closure contains a non-regular file: {candidate.relative_to(root)}")
            files.append(candidate.relative_to(root).as_posix())
    return sorted(files)


def verify_canvas(app_root: Path) -> Dict[str, Any]:
    app_root = app_root.resolve()
    vendor_root = _checked_release_path(app_root, "vendor", label="canvas directory")
    closure_root = _checked_release_path(
        app_root, "vendor/infinite-canvas", label="canvas directory"
    )
    manifest_path = _checked_release_path(
        app_root,
        "vendor/infinite-canvas.manifest.json",
        label="canvas manifest",
    )
    if not manifest_path.is_file():
        raise ContractError(f"canvas manifest is missing or not a regular file: {manifest_path}")
    manifest, raw_manifest = _strict_json_load(manifest_path)

    expected_manifest_keys = {"schemaVersion", "basePath", "fileCount", "totalBytes", "files"}
    if set(manifest) != expected_manifest_keys:
        raise ContractError(
            f"unexpected canvas manifest keys: {sorted(set(manifest) - expected_manifest_keys)}"
        )
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError(f"unsupported canvas manifest schemaVersion: {manifest.get('schemaVersion')!r}")
    if manifest.get("basePath") != "/XZ-Design":
        raise ContractError(f"unexpected canvas basePath: {manifest.get('basePath')!r}")
    raw_files = manifest.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ContractError("canvas manifest files must be a non-empty array")

    described: Dict[str, Tuple[int, str]] = {}
    ordered_paths: List[str] = []
    for entry in raw_files:
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise ContractError(f"invalid canvas manifest file entry: {entry!r}")
        path = _manifest_entry_path(entry["path"])
        if path in described:
            raise ContractError(f"duplicate canvas manifest path: {path}")
        size = entry["size"]
        digest = entry["sha256"]
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ContractError(f"invalid size for canvas file {path}: {size!r}")
        if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ContractError(f"invalid SHA-256 for canvas file {path}")
        described[path] = (size, digest)
        ordered_paths.append(path)
    if manifest.get("fileCount") != len(described):
        raise ContractError("canvas manifest fileCount does not match files")
    expected_total = sum(size for size, _ in described.values())
    if manifest.get("totalBytes") != expected_total:
        raise ContractError("canvas manifest totalBytes does not match files")

    actual_paths = _list_regular_files(closure_root)
    expected_paths = ordered_paths
    if set(actual_paths) != set(expected_paths):
        missing = sorted(set(expected_paths) - set(actual_paths))
        extra = sorted(set(actual_paths) - set(expected_paths))
        raise ContractError(f"canvas closure path mismatch; missing={missing}, extra={extra}")

    for path in expected_paths:
        file_path = _checked_release_path(
            app_root,
            Path("vendor/infinite-canvas").joinpath(*path.split("/")),
            label="canvas file",
        )
        try:
            content = file_path.read_bytes()
        except OSError as exc:
            raise ContractError(f"cannot read canvas file {path}: {exc}") from exc
        expected_size, expected_digest = described[path]
        if len(content) != expected_size:
            raise ContractError(f"canvas file size mismatch: {path}")
        if _sha256_bytes(content) != expected_digest:
            raise ContractError(f"canvas file SHA-256 mismatch: {path}")

    return {
        "ok": True,
        "basePath": manifest["basePath"],
        "fileCount": len(expected_paths),
        "totalBytes": expected_total,
        "manifestSha256": _sha256_bytes(raw_manifest),
    }


def verify_all(app_root: Path, expected_release_id: str = "") -> Dict[str, Any]:
    esm = verify_esm(app_root)
    canvas = verify_canvas(app_root)
    runtime = verify_runtime(app_root, expected_release_id)
    tuple_material = json.dumps(
        {
            "entryDocumentSha256": esm["entryDocumentSha256"],
            "esmModuleGraphSha256": esm["moduleGraphSha256"],
            "esmModuleClosureSha256": esm["moduleClosureSha256"],
            "canvasManifestSha256": canvas["manifestSha256"],
            "runtimeManifestSha256": runtime["manifestSha256"],
            "releaseId": runtime["releaseId"],
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "ok": bool(esm["ok"] and canvas["ok"] and runtime["ok"]),
        "phase0TupleSha256": _sha256_bytes(tuple_material),
        "esm": esm,
        "canvas": canvas,
        "runtime": runtime,
    }


def _print_text(command: str, result: Dict[str, Any]) -> None:
    if command == "esm":
        print(
            f"ESM graph: {result['reachableModules']} modules, {result['localImportEdges']} local edges, "
            f"graph sha256={result['moduleGraphSha256']}, closure sha256={result['moduleClosureSha256']}"
        )
        for conflict in result["conflicts"]:
            print(f"ERROR one physical module has multiple URL identities: {conflict['module']}", file=sys.stderr)
            for identity in conflict["identities"]:
                print(f"  {identity}", file=sys.stderr)
        return
    if command == "canvas":
        print(
            f"canvas closure: {result['fileCount']} files, {result['totalBytes']} bytes, "
            f"manifest sha256={result['manifestSha256']}"
        )
        return
    if command == "runtime":
        print(
            f"runtime closure: release={result['releaseId']}, {result['fileCount']} files, "
            f"{result['totalBytes']} bytes, manifest sha256={result['manifestSha256']}"
        )
        return
    print(f"Phase 0 release tuple sha256={result['phase0TupleSha256']}")
    _print_text("esm", result["esm"])
    _print_text("canvas", result["canvas"])
    _print_text("runtime", result["runtime"])


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("esm", "canvas", "runtime", "all"), nargs="?", default="all")
    parser.add_argument(
        "--app-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="unpacked application release root (defaults to the parent of tools/)",
    )
    parser.add_argument("--json", action="store_true", help="print the machine-readable result")
    parser.add_argument(
        "--expected-release-id",
        default="",
        help="require the runtime manifest to identify this exact release",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "esm":
            result = verify_esm(args.app_root)
        elif args.command == "canvas":
            result = verify_canvas(args.app_root)
        elif args.command == "runtime":
            result = verify_runtime(args.app_root, args.expected_release_id)
        else:
            result = verify_all(args.app_root, args.expected_release_id)
    except ContractError as exc:
        if args.json:
            print(json.dumps({"schemaVersion": SCHEMA_VERSION, "ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"release contract verification failed: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    else:
        _print_text(args.command, result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
