#!/usr/bin/env python3
"""Каталог скиллов: проверка, сборка marketplace.json и README, заготовка нового скилла.

Использование (из корня репозитория):
  python3 scripts/catalog.py build          # проверить всё и пересобрать .claude-plugin/marketplace.json + таблицу в README.md
  python3 scripts/catalog.py check          # только проверить (код выхода 1, если есть ошибки или каталог устарел)
  python3 scripts/catalog.py new <имя>      # создать заготовку plugins/<имя>/ с plugin.json и SKILL.md
  python3 scripts/catalog.py link           # симлинки всех скиллов в ~/.claude/skills (для локальной разработки)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"
README = ROOT / "README.md"
TABLE_START = "<!-- catalog:start -->"
TABLE_END = "<!-- catalog:end -->"
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

MARKETPLACE_HEADER = {
    "name": "another-skills-catalog",
    "owner": {"name": "Directline"},
    "description": "Oh great, another catalog... of Claude Code skills.",
}


def frontmatter(path):
    """Простые однострочные поля YAML-шапки SKILL.md."""
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return None
    fields = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep and not line.startswith((" ", "\t")):
            fields[k.strip()] = v.strip().strip("\"'")
    return fields


def scan():
    errors, entries = [], []
    for pdir in sorted(p for p in PLUGINS.iterdir() if p.is_dir()):
        where = f"plugins/{pdir.name}"
        manifest = pdir / ".claude-plugin" / "plugin.json"
        if not manifest.exists():
            errors.append(f"{where}: нет .claude-plugin/plugin.json")
            continue
        try:
            meta = json.loads(manifest.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            errors.append(f"{where}/.claude-plugin/plugin.json: битый JSON ({e})")
            continue
        for key in ("name", "version", "description"):
            if not meta.get(key):
                errors.append(f"{where}/.claude-plugin/plugin.json: не заполнено поле {key}")
        if "TODO" in meta.get("description", ""):
            errors.append(f"{where}/.claude-plugin/plugin.json: остался TODO в description")
        if meta.get("name") != pdir.name:
            errors.append(f"{where}: name в plugin.json ({meta.get('name')}) должен совпадать с именем папки")
        if not NAME_RE.match(pdir.name):
            errors.append(f"{where}: имя плагина — только строчные латинские буквы, цифры и дефисы")

        skills = sorted(s for s in (pdir / "skills").glob("*") if s.is_dir()) if (pdir / "skills").exists() else []
        if not skills:
            errors.append(f"{where}: нет ни одного скилла в skills/")
        for sdir in skills:
            swhere = f"{where}/skills/{sdir.name}"
            fm = frontmatter(sdir / "SKILL.md") if (sdir / "SKILL.md").exists() else None
            if fm is None:
                errors.append(f"{swhere}: нет SKILL.md или YAML-шапки ---")
                continue
            if fm.get("name") != sdir.name:
                errors.append(f"{swhere}/SKILL.md: name ({fm.get('name')}) должен совпадать с именем папки")
            if not fm.get("description"):
                errors.append(f"{swhere}/SKILL.md: пустой description — по нему Claude решает, когда включать скилл")
            if "TODO" in (sdir / "SKILL.md").read_text(encoding="utf-8"):
                errors.append(f"{swhere}/SKILL.md: остались TODO из заготовки")

        entry = {
            "name": meta.get("name", pdir.name),
            "source": f"./plugins/{pdir.name}",
            "description": meta.get("description", ""),
            "version": meta.get("version", ""),
        }
        if meta.get("keywords"):
            entry["keywords"] = meta["keywords"]
        entry["_skills"] = [s.name for s in skills]
        entries.append(entry)
    return errors, entries


def render_marketplace(entries):
    data = dict(MARKETPLACE_HEADER)
    data["plugins"] = [{k: v for k, v in e.items() if not k.startswith("_")} for e in entries]
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def render_readme(entries):
    rows = ["| Плагин | Скиллы | Версия | Описание |", "|---|---|---|---|"]
    for e in entries:
        skills = ", ".join(f"`/{s}`" for s in e["_skills"])
        rows.append(f"| [`{e['name']}`]({e['source']}) | {skills} | {e['version']} | {e['description']} |")
    text = README.read_text(encoding="utf-8")
    block = f"{TABLE_START}\n" + "\n".join(rows) + f"\n{TABLE_END}"
    return re.sub(re.escape(TABLE_START) + ".*?" + re.escape(TABLE_END), lambda _: block, text, flags=re.S)


def cmd_build(write):
    errors, entries = scan()
    for e in errors:
        print(f"✗ {e}")
    if errors:
        print(f"\nОшибок: {len(errors)}. Каталог не собран.")
        return 1
    outputs = {MARKETPLACE: render_marketplace(entries), README: render_readme(entries)}
    stale = [p for p, c in outputs.items() if not p.exists() or p.read_text(encoding="utf-8") != c]
    if write:
        for p in stale:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(outputs[p], encoding="utf-8")
            print(f"обновлён {p.relative_to(ROOT)}")
        print(f"✓ Плагинов в каталоге: {len(entries)}")
        return 0
    if stale:
        for p in stale:
            print(f"✗ {p.relative_to(ROOT)} устарел — запусти: python3 scripts/catalog.py build")
        return 1
    print(f"✓ Всё в порядке, плагинов: {len(entries)}")
    return 0


def cmd_new(name):
    if not NAME_RE.match(name):
        print("Имя — только строчные латинские буквы, цифры и дефисы, например: brand-voice")
        return 1
    pdir = PLUGINS / name
    if pdir.exists():
        print(f"plugins/{name} уже существует")
        return 1
    (pdir / ".claude-plugin").mkdir(parents=True)
    (pdir / "skills" / name).mkdir(parents=True)
    (pdir / ".claude-plugin" / "plugin.json").write_text(json.dumps({
        "name": name,
        "version": "0.1.0",
        "description": "TODO: одна фраза для каталога — что даёт плагин",
        "author": MARKETPLACE_HEADER["owner"],
        "keywords": [],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (pdir / "skills" / name / "SKILL.md").write_text(
        f"---\nname: {name}\n"
        "description: TODO: что делает скилл и КОГДА его включать — фразы и ситуации, по которым Claude его узнает.\n"
        "---\n\n"
        f"# /{name}\n\nTODO: инструкции. Длинные справочники выноси в references/, скрипты — в scripts/, "
        "шаблоны и файлы — в assets/.\n",
        encoding="utf-8",
    )
    print(f"Создано plugins/{name}/. Заполни TODO, затем: python3 scripts/catalog.py build")
    return 0


def cmd_link():
    target = Path.home() / ".claude" / "skills"
    target.mkdir(parents=True, exist_ok=True)
    for sdir in sorted(PLUGINS.glob("*/skills/*")):
        if not sdir.is_dir():
            continue
        link = target / sdir.name
        if link.is_symlink():
            link.unlink()
        elif link.exists():
            print(f"пропущен {link}: там уже лежит не симлинк")
            continue
        link.symlink_to(sdir)
        print(f"{link} → {sdir}")
    return 0


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "build":
        return cmd_build(write=True)
    if cmd == "check":
        return cmd_build(write=False)
    if cmd == "new" and len(rest) == 1:
        return cmd_new(rest[0])
    if cmd == "link":
        return cmd_link()
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
