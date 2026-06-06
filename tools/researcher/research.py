#!/usr/bin/env python3
"""Small web/GitHub research adapter for Codoptic agents.

The tool is intentionally dependency-light: urllib + html.parser are enough for
normal docs pages, while Playwright is optional for JS-heavy pages.
"""
import argparse
import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser


DEFAULT_USER_AGENT = "CodopticResearch/1.0 (+https://github.com/Codoptic/Codoptic)"
MAX_LINKS = 30
MAX_HEADINGS = 40
MAX_SEARCH_RESULTS = 8


class ReadableHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = ""
        self.meta = {}
        self.headings = []
        self.links = []
        self.paragraphs = []
        self._tag_stack = []
        self._buffer = []
        self._capture_tag = None

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        self._tag_stack.append(tag)
        if tag == "meta":
            key = attr.get("name") or attr.get("property")
            value = attr.get("content")
            if key and value and len(self.meta) < 12:
                self.meta[key] = html.unescape(value.strip())
        elif tag == "a" and attr.get("href") and len(self.links) < MAX_LINKS:
            self.links.append({"href": attr["href"], "text": ""})
        elif tag in {"title", "h1", "h2", "h3", "p", "li", "code", "pre"}:
            self._capture_tag = tag
            self._buffer = []

    def handle_endtag(self, tag):
        if self._tag_stack:
            self._tag_stack.pop()
        if tag != self._capture_tag:
            return
        text = normalize_text(" ".join(self._buffer))
        if text:
            if tag == "title" and not self.title:
                self.title = text
            elif tag in {"h1", "h2", "h3"} and len(self.headings) < MAX_HEADINGS:
                self.headings.append({"level": tag, "text": text})
            elif tag in {"p", "li", "code", "pre"} and len(self.paragraphs) < 80:
                self.paragraphs.append(text)
        self._capture_tag = None
        self._buffer = []

    def handle_data(self, data):
        if self._capture_tag and not any(tag in {"script", "style", "noscript"} for tag in self._tag_stack):
            self._buffer.append(data)
        if self.links and self._tag_stack and self._tag_stack[-1] == "a":
            current = self.links[-1]
            current["text"] = normalize_text(f"{current.get('text', '')} {data}")


class SearchHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.results = []
        self._current = None
        self._buffer = []

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        href = attr.get("href", "")
        class_name = attr.get("class", "")
        if tag == "a" and href and ("result__a" in class_name or "uddg=" in href):
            self._current = href
            self._buffer = []

    def handle_endtag(self, tag):
        if tag != "a" or not self._current:
            return
        text = normalize_text(" ".join(self._buffer))
        href = normalize_search_href(self._current)
        if href and text and len(self.results) < MAX_SEARCH_RESULTS:
            self.results.append({"title": text, "url": href})
        self._current = None
        self._buffer = []

    def handle_data(self, data):
        if self._current:
            self._buffer.append(data)


def normalize_text(value):
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def clip(value, max_chars):
    return value if len(value) <= max_chars else value[:max_chars] + f"\n...[truncated {len(value) - max_chars} chars]"


def fetch_url(url, timeout=20):
    request = urllib.request.Request(url, headers={"User-Agent": DEFAULT_USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        body = response.read(1_000_000).decode(charset, errors="replace")
        return {
            "url": response.geturl(),
            "status": getattr(response, "status", 200),
            "content_type": response.headers.get("content-type", ""),
            "body": body,
        }


def normalize_search_href(href):
    parsed = urllib.parse.urlparse(html.unescape(href))
    query = urllib.parse.parse_qs(parsed.query)
    if "uddg" in query and query["uddg"]:
        return query["uddg"][0]
    if parsed.scheme in {"http", "https"}:
        return href
    return ""


def search_web(query, max_results=MAX_SEARCH_RESULTS):
    encoded = urllib.parse.urlencode({"q": query})
    payload = fetch_url(f"https://duckduckgo.com/html/?{encoded}")
    parser = SearchHTMLParser()
    parser.feed(payload["body"])
    return {"query": query, "results": parser.results[:max_results], "source": "duckduckgo-html"}


async def fetch_with_playwright(url):
    try:
        from playwright.async_api import async_playwright
    except Exception as exc:  # pragma: no cover - depends on optional package
        raise RuntimeError(f"Playwright is not installed. Install with: python3 -m pip install playwright && python3 -m playwright install chromium ({exc})")
    async with async_playwright() as p:  # pragma: no cover - optional browser path
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(user_agent=DEFAULT_USER_AGENT)
        await page.goto(url, wait_until="networkidle", timeout=30_000)
        content = await page.content()
        title = await page.title()
        await browser.close()
        return {"url": url, "status": 200, "content_type": "text/html; playwright", "body": f"<title>{html.escape(title)}</title>{content}"}


def parse_html_page(payload, max_chars):
    parser = ReadableHTMLParser()
    parser.feed(payload["body"])
    base_url = payload["url"]
    links = []
    for link in parser.links:
        href = urllib.parse.urljoin(base_url, link.get("href", ""))
        if href.startswith(("http://", "https://")):
            links.append({"href": href, "text": link.get("text", "")[:120]})
    text = "\n".join(parser.paragraphs)
    return {
        "url": base_url,
        "status": payload["status"],
        "contentType": payload["content_type"],
        "title": parser.title,
        "metadata": parser.meta,
        "headings": parser.headings,
        "links": links[:MAX_LINKS],
        "text": clip(text, max_chars),
    }


def repo_slug(value):
    if not value:
        return ""
    if value.startswith("http"):
        parts = urllib.parse.urlparse(value).path.strip("/").split("/")
        return "/".join(parts[:2])
    return value.strip().strip("/")


def inspect_github_repo(repo):
    slug = repo_slug(repo)
    if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", slug):
        raise ValueError("GitHub repo must be owner/name or a GitHub repository URL.")
    api = f"https://api.github.com/repos/{slug}"
    payload = fetch_url(api)
    data = json.loads(payload["body"])
    readme = None
    try:
        readme_payload = fetch_url(f"https://api.github.com/repos/{slug}/readme")
        readme_data = json.loads(readme_payload["body"])
        readme = {
            "name": readme_data.get("name"),
            "path": readme_data.get("path"),
            "downloadUrl": readme_data.get("download_url"),
            "size": readme_data.get("size"),
        }
    except Exception:
        readme = None
    fields = {
        "repo": slug,
        "description": data.get("description"),
        "stars": data.get("stargazers_count"),
        "forks": data.get("forks_count"),
        "language": data.get("language"),
        "license": (data.get("license") or {}).get("spdx_id"),
        "updatedAt": data.get("updated_at"),
        "defaultBranch": data.get("default_branch"),
        "topics": data.get("topics", []),
        "htmlUrl": data.get("html_url"),
        "readme": readme,
    }
    return fields


def main():
    parser = argparse.ArgumentParser(description="Fetch and summarize current web/GitHub context.")
    parser.add_argument("--query", action="append", default=[], help="Search query to discover likely docs, repos, or examples.")
    parser.add_argument("--url", action="append", default=[], help="URL to fetch and summarize.")
    parser.add_argument("--github-repo", help="GitHub owner/name or repository URL to inspect.")
    parser.add_argument("--browser", action="store_true", help="Use optional Playwright for URLs.")
    parser.add_argument("--max-results", type=int, default=MAX_SEARCH_RESULTS)
    parser.add_argument("--max-chars", type=int, default=5000)
    args = parser.parse_args()

    result = {"tool": "researcher", "queries": [], "pages": [], "github": None, "errors": []}
    for query in args.query:
        try:
            result["queries"].append(search_web(query, max(1, min(MAX_SEARCH_RESULTS, args.max_results))))
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as exc:
            result["errors"].append({"target": query, "error": str(exc)})
    for url in args.url:
        try:
            if args.browser:
                import asyncio
                payload = asyncio.run(fetch_with_playwright(url))
            else:
                payload = fetch_url(url)
            result["pages"].append(parse_html_page(payload, args.max_chars))
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as exc:
            result["errors"].append({"target": url, "error": str(exc)})
    if args.github_repo:
        try:
            result["github"] = inspect_github_repo(args.github_repo)
        except (urllib.error.URLError, json.JSONDecodeError, ValueError) as exc:
            result["errors"].append({"target": args.github_repo, "error": str(exc)})
    print(json.dumps(result, indent=2, sort_keys=True))
    return 1 if result["errors"] and not (result["pages"] or result["github"]) else 0


if __name__ == "__main__":
    sys.exit(main())
