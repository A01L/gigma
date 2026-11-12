// App settings store (theme, language, favorites...) + translations (RU / EN).
import { useSyncExternalStore } from 'react'
import type { AppSettings } from '@shared/api'
import { backend } from '../backend'

let settings: AppSettings = { theme: 'dark', language: 'system', homeView: 'grid', homeSort: 'edited', favorites: [] }
let version = 0
const subs = new Set<() => void>()

function applyTheme(s: AppSettings) {
  const dark = s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.lang = lang()
}

function update(s: AppSettings) {
  settings = s
  version++
  applyTheme(s)
  subs.forEach((f) => f())
}

export const settingsReady = backend.settings.get().then(update)
backend.settings.onChanged(update)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(settings))

export function getSettings(): AppSettings {
  return settings
}
export function setSettings(patch: Partial<AppSettings>): void {
  update({ ...settings, ...patch }) // optimistic
  void backend.settings.set(patch)
}
export function useSettings(): AppSettings {
  useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => version
  )
  return settings
}

export type Lang = 'ru' | 'en'
export function lang(): Lang {
  if (settings.language !== 'system') return settings.language
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

const RU: Record<string, string> = {
  // home
  'Recent': 'Недавние',
  'Favorites': 'Избранные',
  'Settings': 'Настройки',
  'Starred': 'Избранное',
  'Trash': 'Корзина',
  'Empty trash': 'Очистить корзину',
  'Trash is empty': 'Корзина пуста',
  'Restore': 'Восстановить',
  'Delete forever': 'Удалить навсегда',
  'Deleted': 'Удалён',
  'Delete "{name}" forever?': 'Удалить «{name}» навсегда?',
  'Delete all {n} projects in Trash forever?': 'Удалить навсегда все проекты в корзине ({n})?',
  'Projects in Trash are deleted forever after 30 days.': 'Проекты в корзине удаляются навсегда через 30 дней.',
  'Recently viewed': 'Недавно открытые',
  'New design': 'Новый дизайн',
  'Import .gigma': 'Импорт .gigma',
  'Sort': 'Сортировка',
  'Last edited': 'По изменению',
  'Date created': 'По созданию',
  'Name': 'По имени',
  'Grid': 'Плитка',
  'List': 'Таблица',
  'Edited': 'Изменён',
  'Created': 'Создан',
  'File': 'Файл',
  'open': 'открыт',
  'Add to favorites': 'В избранное',
  'Remove from favorites': 'Убрать из избранного',
  'Move to trash': 'В корзину',
  'Move "{name}" to trash?': 'Переместить «{name}» в корзину?',
  'No projects yet. Create a new design to start. Everything stays on this computer.':
    'Пока нет проектов. Создайте новый дизайн. Всё хранится только на этом компьютере.',
  'No favorites yet. Hover a project and click the star.': 'Избранного пока нет. Наведите на проект и нажмите звёздочку.',
  'Search': 'Поиск',
  'Nothing found': 'Ничего не найдено',
  // greetings
  'Good morning': 'Доброе утро',
  'Good afternoon': 'Добрый день',
  'Good evening': 'Добрый вечер',
  'Good night': 'Доброй ночи',
  'What are we making today?': 'Что сегодня делаем?',
  'Looking for new inspiration?': 'Новое вдохновение?',
  'Ready to create?': 'Готовы творить?',
  'What is the idea today?': 'Какая сегодня идея?',
  'Let’s design something great': 'Сделаем что-то классное',
  // settings
  'Appearance': 'Оформление',
  'Theme': 'Тема',
  'Dark': 'Тёмная',
  'Light': 'Светлая',
  'System': 'Системная',
  'Language': 'Язык',
  'AI (MCP)': 'ИИ (MCP)',
  'Local MCP server is running at': 'Локальный MCP-сервер работает по адресу',
  'Only this computer can connect.': 'Подключиться может только этот компьютер.',
  'MCP server is not running.': 'MCP-сервер не запущен.',
  'Copy Claude Desktop config': 'Скопировать конфиг Claude Desktop',
  'Copied': 'Скопировано',
  'Claude Desktop: Settings → Developer → Edit Config, paste the config and restart Claude.':
    'Claude Desktop: Настройки → Developer → Edit Config, вставьте конфиг и перезапустите Claude.',
  'HTTP clients (Cursor, VS Code, Claude Code, LM Studio): add a server of type “http” with this URL.':
    'Клиенты с HTTP (Cursor, VS Code, Claude Code, LM Studio): добавьте сервер типа «http» с этим адресом.',
  'ChatGPT only connects to MCP servers reachable over HTTPS from the internet; it needs a tunnel you set up yourself.':
    'ChatGPT подключается только к MCP-серверам, доступным по HTTPS из интернета; для него нужен туннель, который настраивается отдельно.',
  'Storage': 'Хранилище',
  'Projects folder': 'Папка проектов',
  'Open folder': 'Открыть папку',
  'About': 'О программе',
  'Version': 'Версия',
  'Gigma is free and open source. Your files never leave this computer.': 'Gigma бесплатна и с открытым кодом. Ваши файлы не покидают этот компьютер.',
  // shell / editor
  'Home': 'Главная',
  'New project (Ctrl+N)': 'Новый проект (Ctrl+N)',
  'Close tab (Ctrl+W)': 'Закрыть вкладку (Ctrl+W)',
  'Menu': 'Меню',
  'Pages': 'Страницы',
  'Layers': 'Слои',
  'Add page': 'Добавить страницу',
  'Import pages from .gigma': 'Импорт страниц из .gigma',
  'Export page as .gigma': 'Экспорт страницы в .gigma',
  'Delete page': 'Удалить страницу',
  'Design': 'Дизайн',
  'Page': 'Страница',
  'Layout': 'Макет',
  'Layer': 'Слой',
  'Fill': 'Заливка',
  'Stroke': 'Обводка',
  'Export': 'Экспорт',
  'Text': 'Текст',
  'Auto layout': 'Авто-лейаут',
  'Add auto layout': 'Добавить авто-лейаут',
  'Remove auto layout': 'Убрать авто-лейаут',
  'Vertical layout': 'Вертикально',
  'Horizontal layout': 'Горизонтально',
  'Gap between items': 'Отступ между элементами',
  'Space between': 'Равномерно',
  'Spread the items across the frame': 'Распределить элементы по всей длине фрейма',
  'Padding': 'Поля',
  'Horizontal padding': 'Поля по горизонтали',
  'Vertical padding': 'Поля по вертикали',
  'Individual padding': 'Поля по сторонам',
  'Left': 'Слева',
  'Right': 'Справа',
  'Fixed': 'Фикс.',
  'Hug': 'Обжать',
  'Fill container': 'Заполн.',
  'Width': 'Ширина',
  'Height': 'Высота',
  'Ignore auto layout': 'Игнорировать авто-лейаут',
  'The layer keeps its own position inside the auto layout frame': 'Слой сохраняет своё положение внутри фрейма с авто-лейаутом',
  'Blend mode': 'Режим наложения',
  'Normal': 'Обычный',
  'Darken': 'Затемнение',
  'Multiply': 'Умножение',
  'Color burn': 'Затемнение основы',
  'Lighten': 'Замена светлым',
  'Screen': 'Экран',
  'Color dodge': 'Осветление основы',
  'Overlay': 'Перекрытие',
  'Soft light': 'Мягкий свет',
  'Hard light': 'Жёсткий свет',
  'Difference': 'Разница',
  'Exclusion': 'Исключение',
  'Hue': 'Цветовой тон',
  'Saturation': 'Насыщенность',
  'Color': 'Цветность',
  'Luminosity': 'Яркость',
  'Union': 'Объединить',
  'Subtract': 'Вычесть',
  'Intersect': 'Пересечение',
  'Exclude': 'Исключить',
  'Flatten': 'Свести в контур',
  'Nothing to flatten': 'Нечего сводить: у выделенного нет площади',
  'Clip content': 'Обрезать содержимое',
  'Mixed': 'Разные',
  'Loading images from Figma…': 'Загружаю изображения из Figma…',
  'Add your Figma token in Settings to load images.': 'Чтобы загрузить изображения, добавьте токен Figma в Настройках.',
  'Open settings': 'Открыть настройки',
  'Figma rejected the token or you have no access to this file.': 'Figma не приняла токен или у вас нет доступа к этому файлу.',
  'Could not load images: {e}': 'Не удалось загрузить изображения: {e}',
  'Images loaded: {n}': 'Загружено изображений: {n}',
  'not found: {n}': 'не найдено: {n}',
  'Figma did not copy {n} images.': 'Figma не скопировала изображения ({n}).',
  'Load from Figma': 'Загрузить из Figma',
  'Image was not copied by Figma.': 'Figma не передала это изображение при копировании.',
  'Image file is missing.': 'Файл изображения отсутствует.',
  'Replace image…': 'Заменить…',
  'Figma': 'Figma',
  'Personal access token': 'Личный токен доступа',
  'Used only to load images of layers pasted from Figma (Figma does not copy image files). Stored only on this computer.':
    'Нужен только чтобы подтянуть изображения у слоёв, вставленных из Figma (Figma не копирует сами файлы картинок). Хранится только на этом компьютере.',
  'How to get a token: Figma → Settings → Security → Personal access tokens → Generate (scope: File content, read-only).':
    'Как получить токен: Figma → Settings → Security → Personal access tokens → Generate new token (права: File content — Read only).',
  'Saved': 'Сохранено',
  'Save': 'Сохранить',
  'Move': 'Перемещение',
  'Hand tool': 'Рука',
  'Scale': 'Масштаб',
  'Section': 'Секция',
  'Slice': 'Срез',
  'Line': 'Линия',
  'Arrow': 'Стрелка',
  'Polygon': 'Многоугольник',
  'Star': 'Звезда',
  'Image…': 'Изображение…',
  'Pen': 'Перо',
  'Pencil': 'Карандаш',
  'Text on path (soon)': 'Текст по контуру (скоро)',
  'Spec': 'Спецификация',
  'Code': 'Код',
  'Annotation': 'Аннотация',
  'Actions': 'Действия',
  'Tools': 'Инструменты',
  'Commands': 'Команды',
  'All': 'Все',
  'Undo': 'Отменить',
  'Redo': 'Повторить',
  'Select all': 'Выделить всё',
  'Duplicate': 'Дублировать',
  'Group selection': 'Сгруппировать',
  'Ungroup': 'Разгруппировать',
  'Delete': 'Удалить',
  'Bring to front': 'На передний план',
  'Send to back': 'На задний план',
  'Zoom to fit': 'Показать всё',
  'Zoom to 100%': 'Масштаб 100%',
  'Toggle left panel': 'Левая панель',
  'Toggle right panel': 'Правая панель',
  'Export selection as PNG': 'Экспорт выделения в PNG',
  'Export selection as SVG': 'Экспорт выделения в SVG',
  'Place image': 'Вставить изображение',
  'Add an annotation': 'Добавьте аннотацию',
  'Resolve': 'Решено',
  'Task': 'Задание',
  'Title': 'Заголовок',
  'Description': 'Описание',
  'Status': 'Статус',
  'To do': 'К выполнению',
  'In progress': 'В работе',
  'Done': 'Готово',
  'Result': 'Результат',
  'Spec cards are tasks for AI: MCP clients find them with list_specs and mark them done.':
    'Спецификации — задания для ИИ: MCP-клиенты находят их через list_specs и отмечают выполненными.',
  'HTML + CSS rendered as design. Scripts never run; only local content is shown.':
    'HTML + CSS отрисовываются как дизайн. Скрипты не выполняются, показывается только локальное содержимое.',
  'Note': 'Заметка',
  'Resolved': 'Решена',
  'Slices export everything inside their area.': 'Срез экспортирует всё, что находится в его области.',
  'Copy': 'Копировать',
  'Cut': 'Вырезать',
  'Paste here': 'Вставить сюда',
  'Copy properties': 'Копировать свойства',
  'Paste properties': 'Вставить свойства',
  'Copy as PNG': 'Копировать как PNG',
  'Copied as PNG': 'Скопировано как PNG',
  'Properties copied': 'Свойства скопированы',
  'Could not read the clipboard': 'Не удалось прочитать буфер обмена',
  'Bring forward': 'Переместить вперёд',
  'Send backward': 'Переместить назад',
  'Frame selection': 'Обернуть во фрейм',
  'Rename': 'Переименовать',
  'Remove mask': 'Убрать маску',
  'Lock': 'Заблокировать',
  'Unlock': 'Разблокировать',
  'Zoom in': 'Приблизить',
  'Zoom out': 'Отдалить',
  'Zoom to selection': 'Показать выделенное',
  'Zoom to 50%': 'Масштаб 50%',
  'Zoom to 200%': 'Масштаб 200%',
  'Solid': 'Сплошной',
  'Linear': 'Линейный',
  'Radial': 'Радиальный',
  'Angle': 'Угол',
  'Add stop': 'Добавить точку',
  'Rotation': 'Поворот',
  'Rotate 90° right': 'Повернуть на 90°',
  'Flip horizontal': 'Отразить по горизонтали',
  'Flip vertical': 'Отразить по вертикали',
  'Dimensions': 'Размеры',
  'Constrain proportions': 'Сохранять пропорции',
  'Opacity': 'Непрозрачность',
  'Corner radius': 'Скругление',
  'Individual corners': 'Отдельные углы',
  'Top left': 'Верхний левый',
  'Top right': 'Верхний правый',
  'Bottom left': 'Нижний левый',
  'Bottom right': 'Нижний правый',
  'Add fill': 'Добавить заливку',
  'Add stroke': 'Добавить обводку',
  'Weight': 'Толщина',
  'Styles': 'Стили',
  'No saved styles yet': 'Сохранённых стилей пока нет',
  'Style name': 'Название стиля',
  'Selection colors': 'Цвета выделения',
  'See all {n} colors': 'Показать все цвета ({n})',
  'Click + to replace mixed content': 'Нажмите +, чтобы заменить разное содержимое',
  'Align horizontal centers': 'По центру по горизонтали',
  'Align vertical centers': 'По центру по вертикали',
  'Align top': 'По верхнему краю',
  'Align bottom': 'По нижнему краю',
  'Vertical trim':'Обрезка по вертикали',
  'Standard': 'Стандартная',
  'Cap height to baseline': 'От высоты прописных до базовой линии',
  'Wrap style': 'Перенос строк',
  'Balanced': 'Ровный',
  'Fill each line, then wrap': 'Заполнять строку целиком, потом переносить',
  'Even line lengths': 'Строки примерно одинаковой длины',
  'Typography': 'Типографика',
  'Type settings': 'Настройки текста',
  'Basics': 'Основное',
  'Details': 'Детали',
  'Close': 'Закрыть',
  'Alignment': 'Выравнивание',
  'Justify': 'По ширине',
  'Decoration': 'Оформление',
  'None': 'Нет',
  'Underline': 'Подчёркнутый',
  'Strikethrough': 'Зачёркнутый',
  'Case': 'Регистр',
  'As typed': 'Как введено',
  'Upper case': 'ВСЕ ПРОПИСНЫЕ',
  'Lower case': 'все строчные',
  'Title case': 'Каждое Слово С Прописной',
  'Italic': 'Курсив',
  'List style': 'Список',
  'Bulleted list': 'Маркированный список',
  'Numbered list': 'Нумерованный список',
  'Paragraph spacing': 'Отступ между абзацами',
  'Truncate text': 'Обрезать текст',
  'Truncate with ellipsis': 'Обрезать с «…»',
  'Vertical align': 'По вертикали',
  'Top': 'По верху',
  'Middle': 'По середине',
  'Bottom': 'По низу',
  'Resizing': 'Размер блока',
  'Line height': 'Межстрочный интервал',
  'Letter spacing': 'Межбуквенный интервал',
  'Auto': 'Авто',
  'Effects': 'Эффекты',
  'Add effect': 'Добавить эффект',
  'Effect settings': 'Настройки эффекта',
  'Drop shadow': 'Тень',
  'Inner shadow': 'Внутренняя тень',
  'Layer blur': 'Размытие слоя',
  'Background blur': 'Размытие фона',
  'Blur': 'Размытие',
  'Spread': 'Разброс',
  'Show': 'Показать',
  'Hide': 'Скрыть',
  'Remove': 'Удалить',
  'Position': 'Положение',
  'Inside': 'Внутри',
  'Center': 'По центру',
  'Outside': 'Снаружи',
  'Use as mask':'Использовать как маску',
  'The shape of this layer clips the layers above it': 'Форма этого слоя обрезает слои над ним',
  'Frame': 'Фрейм',
  'Group': 'Группа',
  'Rectangle': 'Прямоугольник',
  'Ellipse': 'Эллипс',
  'Vector': 'Вектор',
  'Image': 'Изображение',
  'Auto width': 'Автоширина',
  'Auto height': 'Автовысота',
  'Fixed size': 'Фиксированный размер',
  'Align left': 'По левому краю',
  'Align center': 'По центру',
  'Align right': 'По правому краю',
  'Fill mode': 'Заполнить',
  'Fit': 'Вписать',
  'Stretch': 'Растянуть',
  'Ctrl+C copies as SVG — paste straight into Figma.': 'Ctrl+C копирует как SVG — вставляйте прямо в Figma.',
  'Move  V': 'Перемещение  V',
  'Frame  F': 'Фрейм  F',
  'Rectangle  R': 'Прямоугольник  R',
  'Ellipse  O': 'Эллипс  O',
  'Text  T': 'Текст  T',
  'Hand  H': 'Рука  H',
  'Place image  Ctrl+Shift+K': 'Изображение  Ctrl+Shift+K',
  'AI connected via MCP (local)': 'ИИ подключается через MCP (локально)',
  'AI / MCP setup': 'Настройка ИИ / MCP',
  'layers': 'слоёв'
}

export function t(key: string, vars?: Record<string, string>): string {
  let s = lang() === 'ru' ? (RU[key] ?? key) : key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v)
  return s
}

/** Re-render on language change and return the translator. */
export function useT(): typeof t {
  useSettings()
  return t
}

export function greetingFor(date = new Date()): string {
  const h = date.getHours()
  const time = h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 17 ? 'Good afternoon' : h >= 17 && h < 23 ? 'Good evening' : 'Good night'
  const extra = ['What are we making today?', 'Looking for new inspiration?', 'Ready to create?', 'What is the idea today?', 'Let’s design something great']
  // mostly greet by time of day, sometimes ask something playful
  return Math.random() < 0.55 ? time : extra[Math.floor(Math.random() * extra.length)]
}
