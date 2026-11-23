# Разбор двух проблем расширения Lingo Context

Дата: 2026-11-22. Версия кода на момент разбора: 0.1.0 (`dist/` побайтово совпадал с результатом
`npm run build`). Текущее состояние после исправлений — 0.1.3.

Исходное состояние: `npm run typecheck` — чисто, `npm test` — 107/107, `tools/bundle-e2e.mjs` и
`tools/dom-e2e.mjs` — PASS. То есть обе проблемы **не ловятся существующими тестами**: они
проверяют «эталонную» страницу-книгу, а не поведение на обычных сайтах и не установку в браузер.

---

# Статус исправлений (0.1.3)

Закрыто в коде, с тестами и e2e-проверками:

| Пункт | Что сделано | Проверка |
| --- | --- | --- |
| 1.1 «попап молчит» | `sendToPage()` проверяет ответ; `no_receiver` → сам внедряет `content.js` и повторяет; при отказе показывает причину | `tools/ui-smoke.mjs`: сценарии «нет content script» и «самовнедрение»; тесты `tests/messaging.test.ts` |
| 1.3 вложенные блоки | сегмент = непрерывный run инлайн-узлов; применяется только собственный run (`insertBefore` + удаление своих узлов), вложенные блоки выживают; `revert` побайтовый | 6 тестов в `tests/extract.test.ts`; `tools/dom-e2e.mjs` revert exact |
| 1.4 нет лимита длины | `MAX_SEGMENT_CHARS = 1800` реально работает (`groupRun`/`splitTextNode`); пакеты по `maxChunkChars` провайдера (`chunkByBudget`) | `tests/engine-batching.test.ts`, `tests/extract.test.ts` |
| 1.5 слоты в MT | маскирование `{{n}}` в `⟦n⟧` вокруг запроса + проверка восстановления; при порче сегмент отклоняется | `tests/mt-mask.test.ts` + живая проверка на `translate.googleapis.com` |
| 1.6/1.7 UI | `PageState.notice` отображается в панели и попапе; панель пересоздаётся после перерисовки SPA | `tests/panel.test.ts` |
| доп. | инлайн-код не теряется в MT; повторная инъекция снимает слушатели прежней копии; повторный запуск отменяет предыдущий | `npm test` (142) + `npm run verify` |
| 1.3б иконки/чекбоксы/обложки | `tagNameOf()` нормализует регистр (SVG отдаёт `svg`); `containsOpaque()` рвёт run на обёртках с `input`/`svg`/`embed`; `holdsMedia()` не даёт создать вложенный слот для картинки внутри ссылки (иначе она рисуется дважды) | 4 теста в `tests/extract.test.ts`; замеры: habr.com элементов −110 вместо −342, картинок 36→36, текст 100 % на 6 живых страницах |
| 1.3в форматирование | `strong/em/b/i/u/s/del/ins/mark/small/cite/q/time` стали слотами, жирный текст остаётся жирным | тест «keeps bold text bold through a translation» |
| 1.3г маркеры слотов | `stripMarkers()` чистит строку оригинала («Показать оригинал», билингвальный режим, PDF) и атрибут `data-lingo-original`; раньше читатель видел `{{0}}…{{/0}}` | `tests/apply-markers.test.ts` (5) |

Осталось за рамками кода (см. раздел 2): отключение расширения Яндексом при каждом запуске
лечится только публикацией в Chrome Web Store / Opera Add-ons либо использованием беты Яндекса;
из кода это не исправимо. Пункты 1.2 (shadow DOM), 1.8 (`all_frames: false`) и 1.9
(производительность) осознанно не менялись — это отдельные задачи с собственным риском.

# Проблема 2. Расширение самопроизвольно выключается / исчезает после перезапуска

**Короткий ответ: это не баг кода. В коде нет ни одного вызова, который мог бы отключить или
удалить расширение** (`chrome.management`, `uninstallSelf`, `setUninstallURL`,
`permissions.remove` не используются нигде — проверено grep'ом по `src/` и `public/`).
Причина — в способе установки и в политике Яндекс Браузера.

## 2.1. Главная причина: Яндекс Браузер отключает расширения из непроверенных источников

Официальная справка Яндекса описывает симптом дословно: браузер «отключает расширение сразу
после установки и сообщает об этом при перезапуске Браузера. При каждом запуске Браузер
повторяет проверку, отключая расширения из непроверенных источников». При ручном включении:
«расширение будет включено до тех пор, пока вы не закроете Браузер. При каждом перезапуске
Браузера вам придется заново включать его».

- Проверка включена **только в Windows**; на Linux/macOS её нет.
- Расширение, загруженное кнопкой «Загрузить распакованное расширение», попадает в категорию
  «Из других источников» (`browser://extensions` → вкладка «Из других источников»).
- Единственный способ убрать это подтверждение — публикация в Chrome Web Store / Opera Add-ons
  либо бета-версия Яндекс Браузера (в ней проверки нет).

Источник: <https://browser.yandex.ru/help/ru/security/check-extensions.html>,
<https://browser.yandex.ru/help/ru/personalization/extension.html>

## 2.2. Вторая причина: «Режим разработчика» должен оставаться включённым

Яндекс Браузер — форк Chromium (сборки на Chromium 132–138), поэтому к нему применимо поведение
Chrome 133+: распакованное расширение живёт **только пока включён переключатель «Режим
разработчика»**. При его выключении расширение отключается с причиной
`DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION`. Это не документировано Яндексом, но это код движка.

Источник: `extensions/browser/disable_reason.h` в Chromium,
<https://groups.google.com/a/chromium.org/g/chromium-extensions/c/cTdMVtxxooY>

## 2.3. Третья причина: у расширения нет поля `key` → ID меняется вместе с папкой

В `public/manifest.json` **нет поля `key`** (проверено: ключи манифеста —
`manifest_version, name, short_name, description, version, default_locale,
minimum_chrome_version, icons, action, options_ui, background, content_scripts,
permissions, host_permissions, optional_host_permissions, commands`).

Для распакованного расширения без `key` Chrome (и Яндекс как форк) вычисляет ID как
**SHA-256 от абсолютного пути к каталогу**. Следствия:

- распаковали zip в другую папку → **другой ID**;
- перенесли/переименовали папку `dist` → другой ID;
- `chrome.storage.local` (все настройки и API-ключи!), `chrome.storage.session` и IndexedDB-кэш
  привязаны к ID → **выглядит как «расширение удалилось, настройки сбросились»**;
- в `browser://extensions` появляется «новая» запись, а старая — «Ошибка, не удалось загрузить».

Лечится добавлением `"key"` (base64 DER публичного ключа) в манифест — ID фиксируется навсегда.

## 2.4. Четвёртая причина: папка расширения лежит в `%TEMP%` / `Downloads` / внутри zip

Chromium при старте перечитывает манифест распакованного расширения с диска. Если каталога нет
(временная папка вычищена, «Загрузки» почищены, zip не распакован) — расширение не загружается и
пропадает из списка. Исторически установка из `.zip` распаковывалась в `DIR_TEMP`, и это давало
ровно такой симптом.

## 2.5. Что расширение НЕ делает (проверено, чтобы снять ложные версии)

| Версия | Вердикт |
|---|---|
| «Падает service worker и браузер отключает расширение» | **Неверно.** В `disable_reason.h` нет причины «crash». Упавший SW просто перезапускается по событию. |
| «`--load-extension` переживёт перезапуск» | **Неверно.** В коде Chromium: «Skip extensions that were loaded from the command-line because we don't want those to persist across browser restart». В брендовом Chrome флаг вообще игнорируется. |
| «Нужен `update_url`» | **Не нужно.** Для `kUnpacked` автообновление не применяется, поле ни на что не влияет. |
| «Код сам себя выключает» | **Неверно**, см. выше. |

## 2.6. Что делать

1. Положить папку расширения в стабильный путь вне `%TEMP%`/`Downloads`, например
   `C:\Extensions\lingo-context\`, распаковав zip заранее.
2. Добавить в `public/manifest.json` поле `key` (и продублировать в `dist/manifest.json`
   генератором), чтобы ID и `chrome.storage` не сбрасывались.
3. Держать «Режим разработчика» включённым.
4. На Windows в Яндекс Браузере — принять, что при каждом запуске будет запрос на
   подтверждение, либо ставить бета-версию браузера, либо публиковать в стор.
5. (Опционально, для поддерживаемости) Добавить `chrome.management`-независимую диагностику:
   при старте писать в `storage.session` версию установки, а в настройках показывать блок
   «Как установить, чтобы расширение не отключалось».

---

# Проблема 1. Страницы-книги переводятся стабильно, обычные — нет

Книга (`mdbook`, Leptos book) — это **плоская** разметка: `<h1>`, `<p>`, `<li>` и никаких
вложенных блоков с текстом. Обычный сайт — это `<div>`-обёртки с прямым текстом, вложенные
секции, `<br>`-разделители, shadow DOM, содержимое в iframe. Именно на этих конструкциях
ломаются три механизма: извлечение, применение и обратная связь в UI.

## 1.1. Главная причина «нажал — ничего не произошло»: попап молча глотает ошибку

`src/popup/index.ts:260-266`:

```ts
async function startTranslation(): Promise<void> {
  if (!tab?.id) return;
  busy = true;
  render();
  await sendToTab(tab.id, { type: 'TRANSLATE_PAGE' });   // ← результат НЕ проверяется
  startPolling();
}
```

`sendToTab` (`src/shared/messaging.ts:79-88`) не бросает исключение, а возвращает
`{ ok: false, error: {...} }`. Здесь этот результат отбрасывается. Если в табе нет content
script'а, Chrome отвечает **`Could not establish connection. Receiving end does not exist.`**
(проверено: промис `tabs.sendMessage` именно **reject'ится** с этой строкой) — пользователь
не видит **ничего**: кнопка на миг меняется на «Остановить», затем возвращается, страница не
меняется.

**Когда content script'а нет** (все случаи реальны):

- таб был открыт **до** установки/перезагрузки расширения — статические content scripts в уже
  открытые табы не инжектятся (нужен reload страницы);
- Chrome → «Доступ к сайтам» = **«По клику»** или «На конкретных сайтах» — статические скрипты на
  неразрешённых origin'ах не запускаются;
- страница — `chrome://`, PDF-viewer, страница другого расширения, `view-source:`;
- content script был инжекчен, но расширение перезагрузили → старый контекст «протух»,
  `chrome.runtime.sendMessage` в нём падает с **`Extension context invalidated.`**, а попап
  получает тот же «Receiving end does not exist».

Мелкая деталь: `notice` в `PageState` — **мёртвое поле**. Оно выставляется
(`src/content/engine.ts:128` — «На странице нет текста для перевода», `src/content/selection.ts:49`),
но не читается ни в `src/content/panel.ts`, ни в `src/popup/index.ts` (проверено grep'ом:
единственные вхождения — присваивания). То есть «нечего переводить» тоже выглядит как «ничего не
произошло», кроме панели с «Готово: 0 фрагментов».

**Как ловить:** проверять `response.ok` в `startTranslation`, показывать текст ошибки, и при
`Receiving end does not exist` предлагать «Обновите страницу и повторите» (или инжектить
`chrome.scripting.executeScript` по клику — `scripting` уже в `permissions`, но нигде не
используется).

## 1.2. Извлечение: текст в shadow DOM не находится вообще (0 сегментов)

`extractItems` (`src/content/extract.ts:250`) обходит документ через
`document.createTreeWalker(root, NodeFilter.SHOW_TEXT)`. TreeWalker **не заходит в shadow root**.
`all_frames: false` — ещё и iframe'ы пропускаются.

Проверено на макете:

```
plain page        : items = [ 'Frequency to PWM', 'Compute the top divider from the frequency.' ]
shadow DOM open   : items = []
  -> document.body.textContent = ""
shadow DOM closed : items = []
```

Для страницы на веб-компонентах (а это сейчас половина документации и все «книги» на
Starlight/VitePress с web components) это означает «ничего не нашлось» → фаза `done`,
`total: 0`, и **молчание** из-за мёртвого `notice` (см. 1.1).

## 1.3. Извлечение: вложенные блоки дают дубли и «пожирание» содержимого

`extractItems` для каждого текстового узла поднимается до **ближайшего** предка из `BLOCK_TAGS`
(`src/content/extract.ts:79-83`), а туда входят `DIV`, `SECTION`, `ARTICLE`, `UL`, `OL`, `TABLE`,
`HEADER`, `MAIN`, `FORM`, `NAV`… Затем `buildBlockText` сплющивает **всё поддерево** в одну строку.

Итог: если у `div` есть собственный текст, этот `div` становится сегментом, **внутри которого
лежат** сегменты всех вложенных блоков. Замер на макете:

```
segment 0 "Welcome to the documentation site for our product. Getting startedInstall the package
           and run the command.{{0}}Read more{{/0}}"          <-block DIV
segment 1 "Getting started"                                    <-block H2
segment 2 "Install the package and run the command."            <-block P
segment 3 "Getting startedInstall the package and run the command.{{0}}Read more{{/0}}" <-block DIV
```

Дальше `applyBlock` делает `block.replaceChildren(container)` (`src/content/apply.ts:121`) —
**вместе со всеми вложенными элементами**. Вложенные сегменты после этого уже `!isConnected`,
`applyBlock` возвращает `null` и они молча пропускаются.

Замер на живых страницах (реальный HTML, реальный `extractItems` + `applyBlock`, перевод
подставлялся строкой «ПЕРЕВОД …», чтобы любая потеря была видна):

| Сайт | сегментов | вложенных блоков | элементов до → после | `img` | `ul/ol` |
|---|---|---|---|---|---|
| mdbook (implrust) | 31 | **0** | 182 → 206 | 0→0 | 2→2 |
| Leptos book | 42 | **0** | 401 → 440 | 0→0 | 13→13 |
| MDN | 57 | 1 | 1429 → 1441 | 0→0 | 37→37 |
| rust-lang.org | 45 | 10 | 197 → 203 | 9→9 | 3→3 |
| lenta.ru | 238 | 37 | 1471 → **1262** | 112→112 | 3→3 |
| habr.com | 248 | 42 | 2189 → **1496** | 38→38 | 8→8 |
| github.com | 169 | 2 | 2049 → **1581** | 10→**2** | 26→**6** |

Вот почему книги «работают»: у них **ноль** вложенных блоков. А на habr/github теряется
**23–32 %** DOM-узлов, на github — 8 из 10 картинок и 20 из 26 списков.

## 1.4. Извлечение: нет ограничения на длину сегмента

`export const MAX_SEGMENT_CHARS = 1800;` (`src/content/extract.ts:86`) **объявлена и нигде не
используется** (grep: одно вхождение — само объявление). `chunkByBudget` из `src/core/pool.ts`
тоже не вызывается из `engine.ts`, а `maxChunkChars` из каталога провайдеров
(`src/shared/providers.ts:36,162,173,185,197,209`) не читается вообще.

`engine.ts:155` режет только по **количеству** сегментов: `const size = Math.max(1, this.settings.chunkSize)`
(по умолчанию 20). Значит один сегмент может быть сколь угодно длинным. Замер: страница
«один большой `div` с `<br>`» → **1 сегмент длиной 22 755 символов**.

Что происходит дальше — зависит от провайдера:

- **Google free**: замерено вживую — 5 489 симв. → HTTP 200, 13 889 симв. → **HTTP 400**;
  22 755 → пустой ответ и `failedIds=[0]`, текст остаётся оригинальным. Страница «не перевелась».
- **MyMemory**: возвращает в поле `translatedText` **строку об ошибке**
  `QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS`, и она **применяется на страницу**
  как перевод (проверено вживую). Лимит 500 симв. заявлен как `maxChunkChars: 500`, но не
  используется.

## 1.5. Машинный перевод не проверяет слоты `{{n}}…{{/n}}`

LLM-путь валидирует ответ: `checkIntegrity`/`checkSlots`, до 2 попыток починки, при провале
фрагмент остаётся оригинальным (`src/core/providers/llm.ts:126-151`). **MT-путь
(`src/core/providers/mt.ts`) валидации не имеет вообще** — `runMt` считает любой ответ успехом.

Проверено на живом Google:

```
in : "Read the {{0}}getting started guide{{/0}} before you continue with anything else"
out: "Прежде чем продолжить работу, прочтите {{0}}руководство по началу работы{/0}}."
                                                                         ^^^ нет второй {
```

Применение такого ответа (`renderTranslation` не находит закрывающий маркер):

```html
<span class="lingo-translated" ...>Прежде чем продолжить работу, прочтите
  <a href="/docs">руководство по началу работы{/0}}.</a></span>
```

То есть **в текст страницы попадает литерал `{/0}}`**. А если сервис выбрасывает маркеры
целиком — пропадает `<kbd>`/`<code>`/`<img>` внутри абзаца (проверено: `kbd lost: true`).
На книжных страницах слоты редки, поэтому там это незаметно.

## 1.6. Попап проглатывает ошибку остановки и не показывает причину

Дополнительно к 1.1: `stopTranslation`, `toggleOriginal`, `savePdf` тоже не смотрят на
`response.ok` (`src/popup/index.ts:268-285`). Ошибка «нет связи со страницей» нигде не
показывается пользователю.

## 1.7. Панель «отвязывается» при перерисовке SPA

`ensurePanel()` (`src/content/engine.ts:80-91`) кэширует панель и **не проверяет
`host.isConnected`**. Если React/Vue перерисовал корневой контейнер, host выпал из документа, но
`this.panel` остался — все последующие `render()` пишут в отвязанный узел. Пользователь не видит
ни прогресса, ни кнопки «Остановить».

## 1.8. `all_frames: false` — содержимое в iframe не переводится

`public/manifest.json`: `"all_frames": false`. Многие доки-сайты (и часть «книг») держат контент
в `<iframe>`. Такие страницы выглядят как «не перевелось».

## 1.9. Производительность извлечения на тяжёлых страницах

`isVisible()` вызывает `getComputedStyle` на каждом текстовом узле (`src/content/extract.ts:92-96`),
а это принудительный пересчёт стилей. Замер:

| Сайт | время `extractItems` | вызовов `getComputedStyle` |
|---|---|---|
| mdbook | 117 мс | 94 |
| lenta.ru | 790 мс | 853 |
| github | 812 мс | 641 |

На github/lenta это ~0.8 с блокировки главного потока **до** первого запроса — пользователь
успевает решить, что «ничего не произошло».

## 1.10. Мелочи, найденные попутно

- `chrome.action.onClicked` (`src/background/index.ts:243`) **никогда не сработает** при заданном
  `action.default_popup` — мёртвый код.
- `chrome.storage.session` для состояния таба пишется (`saveTabState`), но `loadTabState`
  **не вызывается нигде** — попап не может показать состояние до ответа content script'а.
  Заявленная в ARCHITECTURE.md функция не реализована.
- `REQUEST_HOST_PERMISSION` есть в роутере (`src/background/index.ts:124`), но **никто его не
  отправляет** — мёртвая ветка; при этом `optional_host_permissions: ["https://*/*","http://*/*"]`
  бессмысленны, т.к. `content_scripts.matches` с `http://*/*`+`https://*/*` **уже** даёт
  «доступ ко всем сайтам» и то же самое предупреждение при установке.
- `mapWithProgress`, `segmentsFromScope`, `countApplied`, `hasProseInSlots`, `isShowingOriginal`,
  `MAX_SEGMENT_CHARS` — мёртвые экспорты.
- `src/core/translator.ts:86` сопоставляет ответы **по позиции** в массиве
  (`misses.forEach((seg, i) => byId.set(seg.id, translated.texts[i] ?? seg.text))`), а не по `id`.
  Сейчас все адаптеры сохраняют порядок, поэтому не стреляет, но это единственная защита от
  перепутывания переводов между блоками.
- Двойная перекодировка UTF-8 в комментариях (`src/content/engine.ts:4` — `extract в†’ request`,
  `src/content/engine.ts:168` — `ru в†’ ru`). На работу не влияет, но `scripts/check-encoding.mjs`
  это не ловит — файл-проверка неполон.

---

# Приоритеты исправлений

Состояние на 0.1.3: пункты 1–4, 6, 7 закрыты (см. «Статус исправлений»), 5, 8 и 9 остаются
открытыми намеренно. Таблица ниже сохранена как исходный разбор — по ней видно, откуда
взялся каждый пункт. Адреса в столбце «Файл» — на момент разбора, до правок.

| # | Проблема | Файл | Влияние |
|---|---|---|---|
| 1 | Вложенные блоки уничтожают DOM (`replaceChildren`) | `src/content/extract.ts:242-284`, `src/content/apply.ts:121` | **Критично** — порча страниц на всех обычных сайтах |
| 2 | Попап не проверяет `response.ok` → «нет реакции» | `src/popup/index.ts:260-285` | **Критично** — вся диагностика недоступна пользователю |
| 3 | `MAX_SEGMENT_CHARS` не применяется, лимиты провайдеров не используются | `src/content/extract.ts:86`, `src/core/pool.ts:60` | Высокое — целые страницы «не переводятся» |
| 4 | MT-путь не валидирует слоты → `{/0}}` в тексте, потеря `<kbd>` | `src/core/providers/mt.ts:28-62` | Высокое — видимая порча текста |
| 5 | Shadow DOM / iframe не обходятся | `src/content/extract.ts:250`, `manifest.json` `all_frames` | Высокое — «0 фрагментов» |
| 6 | `notice` не рендерится | `src/content/panel.ts`, `src/popup/index.ts` | Среднее — молчаливые отказы |
| 7 | Панель не переподключается после SPA-перерисовки | `src/content/engine.ts:80` | Среднее |
| 8 | Нет `key` в манифесте → скачет ID | `public/manifest.json` | Среднее — сброс настроек/ключей |
| 9 | Мёртвые экспорты, `action.onClicked`, `REQUEST_HOST_PERMISSION`, `loadTabState` | разные | Низкое — чистота |

---

# Sources

- Яндекс: отключение непроверенных расширений —
  <https://browser.yandex.ru/help/ru/security/check-extensions.html>
- Яндекс: расширения, «Из других источников» —
  <https://browser.yandex.ru/help/ru/personalization/extension.html>
- Chromium `disable_reason.h` (в т.ч. `UNSUPPORTED_DEVELOPER_EXTENSION`) —
  <https://chromium.googlesource.com/chromium/src/+/refs/tags/131.0.6778.85/extensions/browser/disable_reason.h>
- Chrome: декларирование разрешений, `content_scripts.matches` как источник прав —
  <https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
- Chromium `permission_set.cc` (`effective_hosts = explicit ∪ scriptable`) —
  <https://chromium.googlesource.com/chromium/src/+/main/extensions/common/permissions/permission_set.cc>
- Chrome: `activeTab` и `tabs.Tab.url` — <https://developer.chrome.com/docs/extensions/develop/concepts/activeTab>
- Chrome: `action.onClicked` не срабатывает при popup —
  <https://developer.chrome.com/docs/extensions/reference/api/action>
- Chrome: поле `key` и стабильный ID —
  <https://developer.chrome.com/docs/extensions/reference/manifest/key>
- Chrome: перезагрузка расширения требует перезагрузки страницы —
  <https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world>
