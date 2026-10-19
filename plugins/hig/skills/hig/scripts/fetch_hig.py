#!/usr/bin/env python3
"""Read Apple's Human Interface Guidelines live, as Markdown.

    python3 fetch_hig.py buttons              # one page (slug from the HIG URL)
    python3 fetch_hig.py buttons tab-bars     # several pages
    python3 fetch_hig.py --list               # every page slug
    python3 fetch_hig.py --grep "44x44"       # search all pages, print matching lines

Uses the JSON that powers developer.apple.com/design/human-interface-guidelines.
Image alt texts are kept (colour swatches carry their RGB values there).
Pages are cached for a day in ~/.cache/hig/. Standard library only.
"""
import concurrent.futures as cf
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://developer.apple.com/tutorials/data"
PREFIX = "/design/human-interface-guidelines"
CACHE = Path.home() / ".cache" / "hig"
TTL = 24 * 3600


def fetch(path):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / ((path[len(PREFIX):].strip("/") or "index").replace("/", "_") + ".json")
    if f.exists() and time.time() - f.stat().st_mtime < TTL:
        return json.loads(f.read_text())
    try:
        with urllib.request.urlopen(BASE + path + ".json", timeout=30) as r:
            data = r.read()
    except Exception:
        return None
    f.write_bytes(data)
    return json.loads(data)


def alt(refs, ident):
    a = (refs.get(ident, {}).get("alt") or "").strip()
    return re.sub(r"R-(\d+),G-(\d+),B-(\d+)", r"rgb(\1, \2, \3)", a)


def inline(items, refs):
    out = ""
    for it in items or []:
        t = it.get("type")
        if t == "text":
            out += it["text"]
        elif t in ("strong", "inlineHead"):
            out += "**%s**" % inline(it.get("inlineContent"), refs)
        elif t in ("emphasis", "newTerm"):
            out += "*%s*" % inline(it.get("inlineContent"), refs)
        elif t == "codeVoice":
            out += "`%s`" % it.get("code", "")
        elif t == "reference":
            r = refs.get(it.get("identifier"), {})
            out += r.get("title") or it.get("identifier", "").split("/")[-1]
        elif t == "link":
            out += it.get("title", "")
        elif t == "image":
            out += alt(refs, it.get("identifier"))
        else:
            out += inline(it.get("inlineContent"), refs)
    return out


def blocks(bs, refs):
    out = []
    join = lambda content: " ".join(x.strip() for x in blocks(content, refs) if x.strip())
    for b in bs or []:
        t = b.get("type")
        if t == "heading":
            out.append("\n" + "#" * (b.get("level", 2) + 1) + " " + b.get("text", ""))
        elif t == "paragraph":
            out.append(inline(b.get("inlineContent"), refs))
        elif t in ("unorderedList", "orderedList"):
            for i, item in enumerate(b.get("items", [])):
                out.append(("- " if t == "unorderedList" else "%d. " % (i + 1)) + join(item.get("content")))
        elif t == "aside":
            out.append("> **%s:** %s" % (b.get("name") or b.get("style", "Note"), join(b.get("content"))))
        elif t == "table":
            for ri, row in enumerate(b.get("rows", [])):
                out.append("| " + " | ".join(join(c).replace("|", "/") for c in row) + " |")
                if ri == 0:
                    out.append("|" + "---|" * len(row))
            out.append("")
        elif t == "tabNavigator":
            for tab in b.get("tabs", []):
                out.append("\n**[%s]**" % tab.get("title", ""))
                out += blocks(tab.get("content"), refs)
        elif t == "row":
            for col in b.get("columns", []):
                out += blocks(col.get("content"), refs)
        elif t == "termList":
            for it in b.get("items", []):
                out.append("- **%s** — %s" % (inline(it["term"].get("inlineContent"), refs), join(it["definition"].get("content"))))
        elif t in ("image", "video"):
            a = alt(refs, b.get("identifier"))
            if a:
                out.append("*(image: %s)*" % a)
        elif "content" in b:
            out += blocks(b["content"], refs)
    return out


def to_markdown(path, d):
    refs = d.get("references", {})
    body = []
    for s in d.get("primaryContentSections", []):
        body += blocks(s.get("content"), refs)
    title = d.get("metadata", {}).get("title", path)
    return "# %s\n<https://developer.apple.com%s>\n\n%s\n\n%s\n" % (
        title, path, inline(d.get("abstract"), refs), "\n".join(body))


def children(d):
    for v in d.get("references", {}).values():
        u = v.get("url", "")
        if u.startswith(PREFIX) and "#" not in u:
            yield u


def crawl():
    seen, queue, pages = set(), [PREFIX], {}
    while queue:
        batch = [p for p in dict.fromkeys(queue) if p not in seen]
        queue = []
        seen.update(batch)
        with cf.ThreadPoolExecutor(12) as ex:
            for p, d in zip(batch, ex.map(fetch, batch)):
                if d:
                    pages[p] = d
                    queue += [u for u in children(d) if u not in seen]
    return pages


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    if argv[0] == "--list":
        print("\n".join(sorted(p[len(PREFIX) + 1:] or "index" for p in crawl())))
        return
    if argv[0] == "--grep":
        rx = re.compile(" ".join(argv[1:]), re.I)
        for p, d in sorted(crawl().items()):
            hits = [l for l in to_markdown(p, d).split("\n") if rx.search(l)]
            for l in hits:
                print("%s: %s" % (p[len(PREFIX) + 1:], l.strip()[:400]))
        return
    for slug in argv:
        slug = slug.strip("/").split("human-interface-guidelines/")[-1]
        path = PREFIX + "/" + slug
        d = fetch(path)
        if not d:
            print("# %s — не найдено (проверьте slug через --list)\n" % slug)
            continue
        print(to_markdown(path, d))


if __name__ == "__main__":
    main(sys.argv[1:])
