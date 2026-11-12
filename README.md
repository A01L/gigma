# Gigma

Офлайн-редактор дизайна с открытым исходным кодом для Windows и macOS. Интерфейс в духе Figma,
всё хранится локально, а встроенный MCP-сервер позволяет ИИ-ассистентам (Claude Desktop, Cursor и др.)
рисовать прямо на холсте.

## Быстрый старт

```bash
npm install
npm run dev        # приложение в режиме разработки
npm run web        # только UI в браузере (in-memory, без MCP/SQLite) — для быстрой вёрстки
npm run typecheck
npm run smoke      # e2e-тест MCP: рисует пост через stdio-мост (приложение должно быть запущено)
npm run icons      # пересобрать иконки из build/icon.svg
npm run dist:win   # установщик Windows (.exe)
npm run dist:mac   # .dmg (собирать на macOS)
```

## Подключение ИИ (MCP)

Gigma поднимает MCP-сервер только на `127.0.0.1:7331` (никаких внешних подключений).

- **Claude Desktop**: меню *AI (MCP) → Copy Claude Desktop Config* и вставить в `claude_desktop_config.json`.
  Мост `bin/gigma-mcp.cjs` запускается самим Gigma (`ELECTRON_RUN_AS_NODE`), отдельный Node не нужен.
- **Клиенты с HTTP-транспортом** (Cursor, VS Code, Claude Code, LM Studio): `http://127.0.0.1:7331/mcp`.

Инструменты (41):
- **Задания и заметки:** `list_specs`, `update_spec`, `create_spec` (карточки Spec — задания для ИИ), `list_annotations`,
  `create_annotation`, `resolve_annotation`.
- **Код как дизайн:** `create_code` — блок HTML + CSS, отрисованный на холсте (скрипты отключены, сеть заблокирована).
- **Фигуры тулбара:** `create_shape` — линия, стрелка, многоугольник, звезда, секция, срез.
- **Проекты и вкладки:** `list_projects`, `create_project`, `open_project`, `list_tabs`, `switch_tab`.
- **Страницы:** `list_pages`, `create_page`, `set_current_page`, `update_page` (имя, фон холста), `delete_page`.
- **Создание:** `create_frame`, `create_rectangle`, `create_ellipse`, `create_text`, `create_svg` (SVG → слои), `create_image`.
- **Инспектор целиком:** `update_node` — позиция, размеры, радиус, прозрачность, заливки списком (цвет / картинка + режим),
  обводки с положением, эффекты (тени, размытия), маска, обрезка фрейма, вся типографика.
- **Слои:** `group_nodes`, `ungroup_nodes`, `duplicate_nodes`, `reorder_nodes`, `align_nodes` (в т.ч. распределение), `delete_nodes`.
- **Зрение ИИ:** `get_screenshot` — то, что сейчас видит пользователь; `export_png` — элемент, выделение или вся страница.
- **Чтение:** `get_document`, `get_selection`, `get_node`, `find_nodes`, `export_svg`, `set_selection`, `zoom_to`.

## Совместимость с Figma

| Направление | Как работает |
| --- | --- |
| Gigma → Figma | `Ctrl+C` кладёт в буфер SVG — Figma вставляет его как редактируемые слои |
| Gigma → Gigma | тот же SVG несёт точные данные узлов в `<metadata>` — копирование без потерь |
| Figma → Gigma | обычный `Ctrl+C` в Figma: декодируется нативный формат `fig-kiwi`; также поддерживается «Copy as SVG» и картинки |

Подробности — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Лицензия

MIT
