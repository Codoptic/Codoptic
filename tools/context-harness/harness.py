#!/usr/bin/env python3
"""Context harnessing utilities for Codoptic agents."""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


INSTRUCTION_NAMES = ("AGENTS.md", "CLAUDE.md", "INSTRUCTIONS.md", "PROJECT_RULES.md", "README.md")
SKIP_DIRS = {".git", "node_modules", ".next", "dist", "build", ".cache", ".codoptic-cache"}
PACK_EXTS = {".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".md", ".json", ".toml", ".yaml", ".yml"}


def clip(text, max_chars):
    return text if len(text) <= max_chars else text[:max_chars] + f"\n...[truncated {len(text) - max_chars} chars]"


def audit(root):
    base = Path(root)
    instruction_files = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name in INSTRUCTION_NAMES or name.lower() in {"llms.txt", "llms-full.txt"}:
                rel = str((Path(dirpath) / name).relative_to(base)).replace(os.sep, "/")
                instruction_files.append(rel)
    scripts = {}
    package_path = base / "package.json"
    if package_path.exists():
        try:
            scripts = json.loads(package_path.read_text(encoding="utf-8")).get("scripts", {})
        except Exception:
            scripts = {}
    suggestions = []
    if "AGENTS.md" not in instruction_files:
        suggestions.append("Add AGENTS.md with setup, validation, and repository conventions.")
    if not any(name.startswith("docs/") for name in instruction_files):
        suggestions.append("Consider docs/architecture.md or docs/code-space.md for durable agent context.")
    snippets = {}
    for rel in sorted(instruction_files)[:8]:
        try:
            snippets[rel] = clip((base / rel).read_text(encoding="utf-8", errors="replace"), 1200)
        except Exception:
            snippets[rel] = "(unreadable)"
    recommended = [name for name in ("typecheck", "lint", "test", "build") if name in scripts]
    return {
        "mode": "audit",
        "instructionFiles": sorted(instruction_files),
        "instructionSnippets": snippets,
        "packageScripts": sorted(scripts),
        "recommendedValidation": recommended,
        "suggestions": suggestions,
    }


def local_pack(root, max_chars):
    base = Path(root)
    chunks = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.suffix.lower() not in PACK_EXTS and name not in INSTRUCTION_NAMES:
                continue
            try:
                rel = str(path.relative_to(base)).replace(os.sep, "/")
                content = path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            block = f"\n--- FILE {rel} ---\n{clip(content, 3000)}\n"
            if total + len(block) > max_chars:
                return {"filesIncluded": len(chunks), "content": "".join(chunks), "truncated": True}
            chunks.append(block)
            total += len(block)
    return {"filesIncluded": len(chunks), "content": "".join(chunks), "truncated": False}


def pack(root, max_chars):
    repomix = shutil.which("repomix")
    if not repomix:
        fallback = local_pack(root, max_chars)
        return {
            "mode": "pack",
            "status": "fallback",
            "message": "repomix is not installed. Install with: npm install -g repomix",
            "audit": audit(root),
            "localPack": fallback,
        }
    proc = subprocess.run([repomix, root, "--stdout"], text=True, capture_output=True, timeout=120)
    return {
        "mode": "pack",
        "status": "passed" if proc.returncode == 0 else "failed",
        "command": f"{repomix} {root} --stdout",
        "output": clip((proc.stdout or proc.stderr).strip(), max_chars),
    }


def docs(library, query, max_chars):
    ctx7 = shutil.which("ctx7")
    if not ctx7:
        return {
            "mode": "docs",
            "status": "skipped",
            "message": "ctx7 is not installed. Install/use with: npx ctx7 setup, or npm install -g ctx7",
        }
    if not library:
        return {"mode": "docs", "status": "failed", "message": "library is required for docs mode."}
    args = [ctx7, "docs", library, query or "usage examples and API reference"]
    proc = subprocess.run(args, text=True, capture_output=True, timeout=60)
    return {
        "mode": "docs",
        "status": "passed" if proc.returncode == 0 else "failed",
        "command": " ".join(args),
        "output": clip((proc.stdout or proc.stderr).strip(), max_chars),
    }


def main():
    parser = argparse.ArgumentParser(description="Audit or gather agent context.")
    parser.add_argument("--root", default=".")
    parser.add_argument("--mode", choices=["audit", "pack", "docs"], default="audit")
    parser.add_argument("--library", help="Context7 library id for docs mode.")
    parser.add_argument("--query", help="Context7 docs query.")
    parser.add_argument("--max-chars", type=int, default=6000)
    args = parser.parse_args()

    root = str(Path(args.root).resolve())
    if args.mode == "audit":
        result = audit(root)
    elif args.mode == "pack":
        result = pack(root, args.max_chars)
    else:
        result = docs(args.library or "", args.query or "", args.max_chars)
    result["tool"] = "context-harness"
    result["root"] = root
    print(json.dumps(result, indent=2, sort_keys=True))
    return 1 if result.get("status") == "failed" else 0


if __name__ == "__main__":
    sys.exit(main())
