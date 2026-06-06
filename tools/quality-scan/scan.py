#!/usr/bin/env python3
"""Quality/security scanning adapter for Codoptic agents."""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


INSTALL_HINTS = {
    "semgrep": "Install Semgrep with: python3 -m pip install semgrep",
    "sg": "Install ast-grep with: npm install -g @ast-grep/cli",
    "jscpd": "Install jscpd/cpd with: npm install -g jscpd cpd",
    "gitleaks": "Install Gitleaks from https://github.com/gitleaks/gitleaks/releases or brew install gitleaks",
}
SKIP_DIRS = {".git", "node_modules", ".next", "dist", "build", ".cache", ".codoptic-cache", ".agent"}
CODE_EXTS = {".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php"}
SECRET_RE = re.compile(r"(?i)(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*['\"]?([A-Za-z0-9_\-./+=]{16,})")


def clip(text, max_chars):
    return text if len(text) <= max_chars else text[:max_chars] + f"\n...[truncated {len(text) - max_chars} chars]"


def redact(text):
    return SECRET_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", text or "")


def iter_code_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            path = Path(dirpath) / name
            if path.suffix.lower() in CODE_EXTS or name in {"Dockerfile", "Makefile"}:
                yield path


def run(name, args, root, max_chars, timeout=120):
    binary = shutil.which(name)
    if not binary:
        return {"scanner": name, "status": "skipped", "output": INSTALL_HINTS.get(name, f"Install {name} and retry.")}
    proc = subprocess.run([binary, *args], cwd=root, text=True, capture_output=True, timeout=timeout)
    output = redact((proc.stdout or proc.stderr or "").strip())
    return {
        "scanner": name,
        "status": "passed" if proc.returncode == 0 else "failed",
        "command": " ".join([binary, *args]),
        "exitCode": proc.returncode,
        "output": clip(output, max_chars),
    }


def semgrep(root, max_chars):
    result = run("semgrep", ["scan", "--config", "auto", "--json", "."], root, max_chars)
    if result["status"] != "skipped":
        return result
    findings = []
    patterns = [
        ("dangerous-eval", re.compile(r"\beval\s*\(")),
        ("unsafe-innerhtml", re.compile(r"\binnerHTML\s*=")),
        ("broad-ignore", re.compile(r"eslint-disable|ts-ignore")),
    ]
    for path in iter_code_files(root):
        try:
            for index, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                for rule, rx in patterns:
                    if rx.search(line):
                        findings.append({"rule": rule, "path": str(path.relative_to(root)), "line": index, "text": line.strip()[:160]})
        except Exception:
            continue
    return {"scanner": "semgrep-fallback", "status": "passed", "output": clip(json.dumps({"findings": findings[:80]}, indent=2), max_chars)}


def ast_grep(root, pattern, lang, max_chars):
    if not pattern:
        return {"scanner": "sg", "status": "skipped", "output": "ast-grep requires --pattern for structural search."}
    args = ["--pattern", pattern]
    if lang:
        args.extend(["--lang", lang])
    args.append(".")
    return run("sg", args, root, max_chars)


def duplication(root, max_chars):
    binary = "cpd" if shutil.which("cpd") else "jscpd"
    args = [".", "--reporters", "ai", "--min-lines", "5", "--min-tokens", "50"]
    result = run(binary, args, root, max_chars)
    if result["status"] != "skipped":
        return result
    seen = {}
    duplicates = []
    for path in iter_code_files(root):
        try:
            lines = [line.strip() for line in path.read_text(encoding="utf-8", errors="replace").splitlines()]
        except Exception:
            continue
        for index in range(0, max(0, len(lines) - 5)):
            block = "\n".join(line for line in lines[index:index + 6] if line and not line.startswith("//"))
            if len(block) < 120:
                continue
            current = f"{path.relative_to(root)}:{index + 1}"
            if block in seen:
                duplicates.append({"first": seen[block], "second": current})
            else:
                seen[block] = current
            if len(duplicates) >= 40:
                break
    return {"scanner": "duplication-fallback", "status": "passed", "output": clip(json.dumps({"duplicates": duplicates}, indent=2), max_chars)}


def secrets(root, max_chars):
    result = run("gitleaks", ["dir", ".", "--redact", "--no-banner"], root, max_chars)
    if result["status"] != "skipped":
        return result
    findings = []
    for path in iter_code_files(root):
        try:
            for index, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if SECRET_RE.search(line):
                    findings.append({"path": str(path.relative_to(root)), "line": index, "text": redact(line.strip())[:160]})
        except Exception:
            continue
    status = "failed" if findings else "passed"
    return {"scanner": "gitleaks-fallback", "status": status, "output": clip(json.dumps({"findings": findings[:80]}, indent=2), max_chars)}


def main():
    parser = argparse.ArgumentParser(description="Run optional quality scanners.")
    parser.add_argument("--root", default=".")
    parser.add_argument("--mode", choices=["all", "semgrep", "ast-grep", "duplication", "secrets"], default="all")
    parser.add_argument("--pattern", help="Structural pattern for ast-grep.")
    parser.add_argument("--lang", help="Language for ast-grep.")
    parser.add_argument("--max-chars", type=int, default=6000)
    args = parser.parse_args()

    root = str(Path(args.root).resolve())
    results = []
    if args.mode in {"all", "semgrep"}:
        results.append(semgrep(root, args.max_chars))
    if args.mode == "ast-grep" or (args.mode == "all" and args.pattern):
        results.append(ast_grep(root, args.pattern or "", args.lang or "", args.max_chars))
    if args.mode in {"all", "duplication"}:
        results.append(duplication(root, args.max_chars))
    if args.mode in {"all", "secrets"}:
        results.append(secrets(root, args.max_chars))
    status = "passed" if results and all(item["status"] in {"passed", "skipped"} for item in results) else "failed"
    print(json.dumps({"tool": "quality-scan", "root": root, "status": status, "results": results}, indent=2, sort_keys=True))
    return 1 if any(item["status"] == "failed" for item in results) else 0


if __name__ == "__main__":
    sys.exit(main())
