# another-skills-catalog

> Oh great, another catalog... of Claude Code skills. Да, ещё один. Зато наш.

Маркетплейс плагинов для Claude Code: каждый скилл здесь — отдельный плагин, ставь только нужные.

## Что есть

<!-- catalog:start -->
| Плагин | Скиллы | Версия | Описание |
|---|---|---|---|
| [`hig`](./plugins/hig) | `/hig` | 1.0.0 | Apple Human Interface Guidelines как правила проектирования мобильных экранов: размеры, типографика, цвета, компоненты, аудит макета (/hig audit). |
| [`tweak`](./plugins/tweak) | `/tweak` | 1.0.0 | Живая панель правок для любого HTML-прототипа: ползунки, цвета, правка элементов кликом и сохранение обратно в файл (/tweak). |
<!-- catalog:end -->

## Как установить

Один раз подключи каталог (в терминальном `claude`):

```
/plugin marketplace add serjnsk/another-skills-catalog
```

Потом ставь нужные плагины:

```
/plugin install hig@another-skills-catalog
/plugin install tweak@another-skills-catalog
```

Обновить каталог и плагины до свежих версий: `/plugin marketplace update another-skills-catalog`.

### Автоматически для проекта

Чтобы Claude сам предлагал каталог и плагины всем, кто открывает репозиторий, добавь в его `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "another-skills-catalog": { "source": { "source": "github", "repo": "serjnsk/another-skills-catalog" } }
  },
  "enabledPlugins": {
    "hig@another-skills-catalog": true
  }
}
```

## Как добавить скилл

```bash
python3 scripts/catalog.py new <имя>     # заготовка plugins/<имя>/
# заполнить plugin.json и SKILL.md (все TODO)
python3 scripts/catalog.py build         # проверка + пересборка marketplace.json и таблицы выше
```

Правила — в [CLAUDE.md](CLAUDE.md).
