# Каталог скиллов

Репозиторий — маркетплейс плагинов Claude Code. Один плагин = один скилл (иногда несколько близких).

## Структура

```
.claude-plugin/marketplace.json   ← ГЕНЕРИРУЕТСЯ, руками не править
plugins/<имя>/
  .claude-plugin/plugin.json      ← name, version, description, author, keywords
  skills/<имя>/SKILL.md           ← name и description в YAML-шапке
  skills/<имя>/references|scripts|assets|examples/
scripts/catalog.py                ← build / check / new / link
docs/index.html                   ← сайт на GitHub Pages (терминальный стиль); данные берёт из docs/catalog.json
docs/catalog.json                 ← ГЕНЕРИРУЕТСЯ build
```

## Правила

- Новый скилл — только через `python3 scripts/catalog.py new <имя>`; имя — строчная латиница, цифры, дефисы.
- `name` в plugin.json и SKILL.md совпадает с именем папки.
- `description` в SKILL.md пишется для Claude: что делает и в каких ситуациях/фразах включаться. `description` в plugin.json — одна фраза для людей в каталоге.
- SKILL.md держать коротким; длинные справочники — в `references/`, пути в нём — относительно папки скилла.
- При любом изменении плагина поднимай `version` в его plugin.json (иначе у команды не обновится): правка текста — patch, новая возможность — minor.
- После изменений всегда запускай `python3 scripts/catalog.py build` — он проверит ошибки и пересоберёт marketplace.json и таблицу в README.md.
- Тексты скиллов — на русском; команды, код и идентификаторы — как есть.

## Локальная разработка

Скиллы подключены к личному Claude через симлинки `~/.claude/skills/<имя>` → `plugins/<имя>/skills/<имя>` (`python3 scripts/catalog.py link`), поэтому правки видны сразу, без переустановки плагина. Если поставить тот же скилл ещё и плагином — будет дубль, оставь что-то одно.
