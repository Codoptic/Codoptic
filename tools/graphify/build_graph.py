#!/usr/bin/env python3
"""
Codoptic knowledge-graph builder (Graphify-adapted).

This is a dependency-light port of the Graphify pipeline
(detect -> extract(AST) -> build_graph -> cluster -> analyze -> report -> export)
that runs on the Python standard library alone so it works offline and on any
machine, then reuses Graphify's vis.js rendering for the interactive graph.

Code structure (files, functions, classes, imports) is extracted WITHOUT an LLM:
Python via the stdlib `ast` module, TS/JS via lightweight regex. An OPTIONAL
semantic pass (``--semantic`` with Foundry env vars) annotates top files via the
Azure AI Foundry chat API using urllib; it is best-effort and never required.

Usage:
  python3 build_graph.py --root <repo> --out <dir> [--max-files N] [--semantic]

Outputs under <dir>:
  graph.json        {generatedAt, root, nodes, edges, communities, metrics}
  graph.html        standalone vis.js interactive graph
  GRAPH_REPORT.md   human-readable summary
"""
import argparse
import ast
import json
import os
import re
import sys
import time
from collections import defaultdict, deque

IGNORE_DIRS = {
    ".git", "node_modules", ".next", "dist", "build", "out", "coverage",
    ".codoptic-cache", "__pycache__", ".venv", "venv", "env", ".turbo",
    ".cache", "vendor", ".idea", ".vscode", "graphify-out",
}
CODE_EXTS = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".go": "go",
    ".rs": "rust", ".java": "java", ".rb": "ruby", ".php": "php",
}
DOC_EXTS = {".md": "markdown", ".mdx": "markdown", ".rst": "doc", ".txt": "doc"}
MAX_FILE_BYTES = 400_000

TS_IMPORT_RE = re.compile(r"""(?:import\s[^'"]*from\s*|import\s*|require\(\s*|export\s[^'"]*from\s*)['"]([^'"]+)['"]""")
TS_SYMBOL_RE = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)


def detect(root, max_files):
    """Stage 1 — detect: enumerate candidate source/doc files."""
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and not d.startswith(".")]
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext not in CODE_EXTS and ext not in DOC_EXTS:
                continue
            abspath = os.path.join(dirpath, name)
            try:
                if os.path.getsize(abspath) > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            rel = os.path.relpath(abspath, root).replace(os.sep, "/")
            files.append(rel)
            if len(files) >= max_files:
                return sorted(files)
    return sorted(files)


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def extract_python(rel, content):
    """AST extraction for Python (stdlib, LLM-free)."""
    symbols, imports = [], []
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return symbols, imports
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            symbols.append(node.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            # Preserve relative-import level: `from .util import x` -> ".util",
            # `from ..pkg import y` -> "..pkg". Without the leading dots the spec would be
            # indistinguishable from an absolute/external import and never resolve internally.
            if node.level:
                imports.append("." * node.level + (node.module or ""))
            elif node.module:
                imports.append(node.module)
    return symbols, imports


def extract_ts(rel, content):
    """Regex extraction for TS/JS."""
    symbols = TS_SYMBOL_RE.findall(content)
    imports = TS_IMPORT_RE.findall(content)
    return symbols, imports


def _match_candidate(target, file_set, exts, index_names):
    candidates = [target] if target in file_set else []
    for ext in exts:
        candidates.append(target + ext)
        for index in index_names:
            candidates.append(f"{target}/{index}{ext}")
    for candidate in candidates:
        if candidate in file_set:
            return candidate
    return None


def resolve_python_import(rel, spec, file_set):
    """Resolve a Python dotted relative import (e.g. `.util`, `..pkg.mod`) to a repo file."""
    level = len(spec) - len(spec.lstrip("."))
    module = spec[level:]
    base = os.path.dirname(rel)
    # level 1 == current package directory; each extra dot climbs one directory up.
    for _ in range(level - 1):
        base = os.path.dirname(base)
    target = base
    for part in (module.split(".") if module else []):
        target = os.path.join(target, part)
    target = os.path.normpath(target).replace(os.sep, "/")
    return _match_candidate(target, file_set, (".py",), ("__init__",))


def resolve_import(rel, spec, file_set):
    """Resolve a relative import spec to a repo file path; None for externals."""
    if not spec.startswith("."):
        return None
    if rel.endswith(".py"):
        return resolve_python_import(rel, spec, file_set)
    # TS/JS path-relative specifier ("./lib", "../util/index").
    base = os.path.dirname(rel)
    target = os.path.normpath(os.path.join(base, spec)).replace(os.sep, "/")
    return _match_candidate(target, file_set, (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"), ("index",))


def build(root, files):
    """Stages 2-3 — extract + build_graph."""
    file_set = set(files)
    nodes, edges = [], []
    for rel in files:
        ext = os.path.splitext(rel)[1].lower()
        language = CODE_EXTS.get(ext) or DOC_EXTS.get(ext, "other")
        content = read_text(os.path.join(root, rel))
        loc = content.count("\n") + 1 if content else 0
        kind = "doc" if ext in DOC_EXTS else "file"
        symbols, imports = ([], [])
        if language == "python":
            symbols, imports = extract_python(rel, content)
        elif language in ("typescript", "javascript"):
            symbols, imports = extract_ts(rel, content)
        nodes.append({
            "id": rel,
            "type": kind,
            "path": rel,
            "language": language,
            "loc": loc,
            "symbols": symbols[:40],
        })
        seen = set()
        for spec in imports:
            target = resolve_import(rel, spec, file_set)
            if target and target != rel and target not in seen:
                seen.add(target)
                edges.append({"from": rel, "to": target, "type": "imports"})
    return nodes, edges


def cluster(nodes, edges):
    """Stage 4 — cluster via connected components over the (undirected) import graph."""
    adjacency = defaultdict(set)
    ids = {node["id"] for node in nodes}
    for edge in edges:
        if edge["from"] in ids and edge["to"] in ids:
            adjacency[edge["from"]].add(edge["to"])
            adjacency[edge["to"]].add(edge["from"])
    community = {}
    current = 0
    for node in nodes:
        nid = node["id"]
        if nid in community:
            continue
        queue = deque([nid])
        community[nid] = current
        while queue:
            cur = queue.popleft()
            for neighbor in adjacency[cur]:
                if neighbor not in community:
                    community[neighbor] = current
                    queue.append(neighbor)
        current += 1
    for node in nodes:
        node["community"] = community.get(node["id"], 0)
    return community, current


def analyze(nodes, edges):
    """Stage 5 — degree centrality + god-node detection."""
    incoming = defaultdict(int)
    outgoing = defaultdict(int)
    for edge in edges:
        outgoing[edge["from"]] += 1
        incoming[edge["to"]] += 1
    for node in nodes:
        nid = node["id"]
        node["incoming"] = incoming[nid]
        node["outgoing"] = outgoing[nid]
        node["degree"] = incoming[nid] + outgoing[nid]
    ranked = sorted(nodes, key=lambda n: (-n["degree"], n["id"]))
    god_count = max(1, min(15, len(nodes) // 12)) if nodes else 0
    god_nodes = [n["id"] for n in ranked[:god_count] if n["degree"] > 0]
    for node in nodes:
        node["isGod"] = node["id"] in god_nodes
    return god_nodes


def report(root, nodes, edges, god_nodes, communities_count):
    lines = [
        "# Knowledge Graph Report",
        "",
        f"- Root: `{root}`",
        f"- Files (nodes): {len(nodes)}",
        f"- Import edges: {len(edges)}",
        f"- Communities: {communities_count}",
        "",
        "## Central modules (god nodes)",
    ]
    if god_nodes:
        by_id = {n["id"]: n for n in nodes}
        for nid in god_nodes:
            node = by_id[nid]
            lines.append(f"- `{nid}` — degree {node['degree']} ({node['incoming']} in / {node['outgoing']} out)")
    else:
        lines.append("- (none — no internal import edges detected)")
    lines.append("")
    return "\n".join(lines)


def render_html(graph):
    """Stage 7 — export: standalone vis.js interactive graph (Graphify-style)."""
    palette = [
        "#5b8ff9", "#61ddaa", "#65789b", "#f6bd16", "#7262fd", "#78d3f8",
        "#9661bc", "#f6903d", "#008685", "#f08bb4",
    ]
    vis_nodes = []
    for node in graph["nodes"]:
        color = palette[node["community"] % len(palette)]
        size = 10 + min(40, node["degree"] * 4)
        vis_nodes.append({
            "id": node["id"],
            "label": node["path"].split("/")[-1],
            "title": f"{node['path']} — degree {node['degree']} (community {node['community']})",
            "value": size,
            "color": {"background": color, "border": "#1f2937" if not node["isGod"] else "#ef4444"},
            "borderWidth": 4 if node["isGod"] else 1,
        })
    vis_edges = [{"from": e["from"], "to": e["to"], "arrows": "to"} for e in graph["edges"]]
    data = json.dumps({"nodes": vis_nodes, "edges": vis_edges})
    metrics = graph["metrics"]
    return """<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Codoptic Knowledge Graph</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
  html,body{margin:0;height:100%;background:#0f1115;color:#e6edf3;font-family:ui-sans-serif,system-ui,sans-serif}
  #bar{padding:8px 12px;font-size:12px;border-bottom:1px solid #222;background:#11151c}
  #graph{width:100%;height:calc(100% - 38px)}
  b{color:#9ecbff}
</style></head>
<body>
  <div id="bar">Knowledge Graph — <b>__FILES__</b> files · <b>__EDGES__</b> imports · <b>__COMMUNITIES__</b> communities · red border = central module</div>
  <div id="graph"></div>
  <script>
    var graph = __DATA__;
    var container = document.getElementById('graph');
    var data = { nodes: new vis.DataSet(graph.nodes), edges: new vis.DataSet(graph.edges) };
    var options = {
      nodes: { shape: 'dot', scaling: { min: 8, max: 50 }, font: { color: '#c9d1d9', size: 12 } },
      edges: { color: { color: '#3a4250', highlight: '#9ecbff' }, smooth: { type: 'continuous' }, width: 0.6 },
      physics: { stabilization: { iterations: 180 }, barnesHut: { gravitationalConstant: -8000, springLength: 120 } },
      interaction: { hover: true, tooltipDelay: 120 }
    };
    new vis.Network(container, data, options);
  </script>
</body></html>""" \
        .replace("__DATA__", data) \
        .replace("__FILES__", str(metrics["fileCount"])) \
        .replace("__EDGES__", str(metrics["edgeCount"])) \
        .replace("__COMMUNITIES__", str(metrics["communityCount"]))


def maybe_semantic(root, nodes, god_nodes):
    """Optional Foundry semantic pass (best-effort, offline-safe)."""
    import urllib.request

    api_key = os.environ.get("FOUNDRY_API_KEY")
    endpoint = os.environ.get("FOUNDRY_ENDPOINT")
    model = os.environ.get("FOUNDRY_MODEL", "gpt-5.4")
    if not api_key or not endpoint:
        return
    by_id = {n["id"]: n for n in nodes}
    url = endpoint.rstrip("/")
    if "/chat/completions" not in url:
        url = f"{url}/openai/deployments/{model}/chat/completions?api-version=2024-08-01-preview"
    for nid in god_nodes[:6]:
        node = by_id.get(nid)
        if not node:
            continue
        snippet = read_text(os.path.join(root, nid))[:2500]
        body = json.dumps({
            "messages": [
                {"role": "system", "content": "Summarize this source file's responsibility in one sentence (<=22 words). No prose."},
                {"role": "user", "content": f"File: {nid}\n\n{snippet}"},
            ],
            "max_tokens": 60,
            "temperature": 0,
        }).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "api-key": api_key})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
                summary = payload["choices"][0]["message"]["content"].strip()
                if summary:
                    node["summary"] = summary[:240]
        except Exception:
            continue  # semantic enrichment is best-effort


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-files", type=int, default=4000)
    parser.add_argument("--semantic", action="store_true")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print(json.dumps({"ok": False, "error": f"root not found: {root}"}))
        return 1

    files = detect(root, args.max_files)
    nodes, edges = build(root, files)
    _, communities_count = cluster(nodes, edges)
    god_nodes = analyze(nodes, edges)
    if args.semantic:
        maybe_semantic(root, nodes, god_nodes)

    graph = {
        "generatedAt": int(time.time() * 1000),
        "root": root,
        "nodes": nodes,
        "edges": edges,
        "godNodes": god_nodes,
        "metrics": {
            "fileCount": len(nodes),
            "edgeCount": len(edges),
            "communityCount": communities_count,
            "godNodeCount": len(god_nodes),
        },
    }

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "graph.json"), "w", encoding="utf-8") as handle:
        json.dump(graph, handle)
    with open(os.path.join(args.out, "graph.html"), "w", encoding="utf-8") as handle:
        handle.write(render_html(graph))
    with open(os.path.join(args.out, "GRAPH_REPORT.md"), "w", encoding="utf-8") as handle:
        handle.write(report(root, nodes, edges, god_nodes, communities_count))

    print(json.dumps({
        "ok": True,
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "godNodes": god_nodes,
        "communityCount": communities_count,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
