#!/usr/bin/env python3
"""Detect and run stack-specific validation commands for a repository."""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_TIMEOUT = 120
SKIP_DIRS = {".git", "node_modules", ".next", "dist", "build", ".cache", ".codoptic-cache", ".agent"}
NODE_SCRIPT_ORDER = ("typecheck", "lint", "test", "test:e2e", "e2e", "test:visual", "build")


def has_files(root, suffix):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        if any(name.endswith(suffix) for name in filenames):
            return True
    return False


def has_dir_or_file(root, names):
    return any((Path(root) / name).exists() for name in names)


def package_scripts(root):
    package_path = Path(root) / "package.json"
    if not package_path.exists():
        return {}
    try:
        return json.loads(package_path.read_text(encoding="utf-8")).get("scripts", {})
    except Exception:
        return {}


def detect_package_manager(root):
    base = Path(root)
    if (base / "pnpm-lock.yaml").exists():
        return "pnpm"
    if (base / "yarn.lock").exists():
        return "yarn"
    if (base / "bun.lockb").exists():
        return "bun"
    return "npm"


def node_command(manager, script):
    if manager == "npm" and script == "test":
        return ["npm", "test"]
    return [manager, "run", script]


def detect_commands(root, scope, changed_paths=None):
    commands = []
    scripts = package_scripts(root)
    manager = detect_package_manager(root)
    changed_paths = changed_paths or []
    for script in NODE_SCRIPT_ORDER:
        if script in scripts and (scope in {"all", "node"}):
            command = node_command(manager, script)
            commands.append({"kind": script, "cmd": command, "reason": f"package.json script '{script}'"})
    if changed_paths and "test" in scripts and scope in {"all", "node"}:
        test_targets = [path for path in changed_paths if path.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"))][:8]
        if test_targets:
            commands.insert(0, {"kind": "test", "cmd": [manager, "run", "test", "--", *test_targets], "reason": "Focused tests for changed test files"})
    if scope in {"all", "python"} and has_files(root, ".py"):
        commands.append({"kind": "syntax", "cmd": ["python3", "-m", "compileall", "."], "reason": "Python files present"})
        if has_dir_or_file(root, ["pytest.ini", "pyproject.toml", "tests", "test"]):
            commands.append({"kind": "test", "cmd": ["python3", "-m", "pytest"], "reason": "Python test surface detected"})
    if scope in {"all", "go"} and (Path(root) / "go.mod").exists():
        commands.append({"kind": "test", "cmd": ["go", "test", "./..."], "reason": "go.mod present"})
    if scope in {"all", "rust"} and (Path(root) / "Cargo.toml").exists():
        commands.append({"kind": "test", "cmd": ["cargo", "test"], "reason": "Cargo.toml present"})
    return commands


def run_command(root, entry, timeout):
    started = time.time()
    try:
        proc = subprocess.run(entry["cmd"], cwd=root, text=True, capture_output=True, timeout=timeout)
        output = "\n".join(part for part in [proc.stdout, proc.stderr] if part).strip()
        return {
            "kind": entry["kind"],
            "command": " ".join(entry["cmd"]),
            "reason": entry["reason"],
            "status": "passed" if proc.returncode == 0 else "failed",
            "exitCode": proc.returncode,
            "durationMs": int((time.time() - started) * 1000),
            "output": redact(output[-6000:] or "(no output)"),
        }
    except FileNotFoundError:
        return {
            "kind": entry["kind"],
            "command": " ".join(entry["cmd"]),
            "reason": entry["reason"],
            "status": "skipped",
            "exitCode": None,
            "durationMs": int((time.time() - started) * 1000),
            "output": f"Command not found: {entry['cmd'][0]}",
        }
    except subprocess.TimeoutExpired as exc:
        output = "\n".join(part for part in [exc.stdout or "", exc.stderr or ""] if part)
        return {
            "kind": entry["kind"],
            "command": " ".join(entry["cmd"]),
            "reason": entry["reason"],
            "status": "failed",
            "exitCode": None,
            "durationMs": int((time.time() - started) * 1000),
            "output": redact((output or "Command timed out.")[-6000:]),
        }


def redact(text):
    return text.replace(os.environ.get("OPENAI_API_KEY", "__never__"), "[REDACTED]") if text else text


def main():
    parser = argparse.ArgumentParser(description="Run detected validation commands.")
    parser.add_argument("--root", default=".")
    parser.add_argument("--scope", choices=["all", "node", "python", "go", "rust"], default="all")
    parser.add_argument("--changed-path", action="append", default=[], help="Changed path used to choose focused tests when possible.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    args = parser.parse_args()

    root = str(Path(args.root).resolve())
    commands = detect_commands(root, args.scope, args.changed_path)
    if args.dry_run:
        print(json.dumps({"tool": "validation-matrix", "root": root, "commands": commands}, indent=2))
        return 0
    results = [run_command(root, entry, args.timeout) for entry in commands]
    status = "passed" if results and all(item["status"] in {"passed", "skipped"} for item in results) else "failed"
    if not results:
        status = "skipped"
    summary = {
        "passed": sum(1 for item in results if item["status"] == "passed"),
        "failed": sum(1 for item in results if item["status"] == "failed"),
        "skipped": sum(1 for item in results if item["status"] == "skipped"),
    }
    print(json.dumps({"tool": "validation-matrix", "root": root, "status": status, "summary": summary, "results": results}, indent=2))
    return 1 if any(item["status"] == "failed" for item in results) else 0


if __name__ == "__main__":
    sys.exit(main())
