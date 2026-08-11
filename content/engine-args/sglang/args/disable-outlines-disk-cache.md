---
schema: 1
engine: sglang
primaryName: "--disable-outlines-disk-cache"
title: "--disable-outlines-disk-cache"
summary: Выключает дисковый кеш `outlines` для jump-forward-карт грамматики через переменную окружения `SGLANG_DISABLE_OUTLINES_DISK_CACHE`. В checkout'е этот кеш и так не используется — jump-forward-карта у outlines-backend'а всегда `None`, поэтому флаг сейчас фактически ничего не меняет.
group: exec.features
related:
  - --grammar-backend
  - --constrained-json-disable-any-whitespace
  - --constrained-json-whitespace-pattern
  - --max-running-requests
---

# --disable-outlines-disk-cache

## Кратко

`outlines` кеширует построенные из регулярных выражений FSM на диск через `diskcache`, чтобы не пересобирать их при каждом запуске. Кеш — это файловая база, и при высокой конкурентности или на сетевой файловой системе он умеет ломаться, отсюда и флаг. Три вещи, которые надо знать перед использованием. Первая: он относится **только** к backend'у `outlines`, а по умолчанию грамматика идет через `xgrammar`. Вторая: единственная функция, обернутая дисковым кешем, — `init_state_to_jump_forward`, и в этом checkout'е она не вызывается вообще, потому что `OutlinesGrammarBackend._compile_regex` жестко передает `jump_forward_map = None`. Третья: переменная окружения, которой всё управляется, по умолчанию читается как `true` — то есть при импорте модуля вне `launch_server` кеш выключен, а `__post_init__` затем всегда перезаписывает ее значением флага.

## Оригинальная справка

```text
Disable disk cache of outlines to avoid possible crashes related to file system or high concurrency.
```

## Паспорт аргумента

- Флаги: `--disable-outlines-disk-cache`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: само поле не переписывается, но обратите внимание на асимметрию с переменной окружения. `_handle_environment_variables` безусловно выполняет `envs.SGLANG_DISABLE_OUTLINES_DISK_CACHE.set("1" if self.disable_outlines_disk_cache else "0")`, то есть значение, экспортированное оператором в окружение, всегда перезаписывается флагом. При этом модуль `constrained/outlines_jump_forward.py` читает переменную с дефолтом `"true"` — значение по умолчанию флага (`false`) и значение по умолчанию переменной противоположны, и совпадают они только потому, что `__post_init__` всегда пишет переменную явно
- Где объявлен: `ServerArgs.disable_outlines_disk_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (`_handle_environment_variables`) → импорт `constrained/outlines_jump_forward.py` в процессе scheduler'а → декоратор `disk_cache()` на `init_state_to_jump_forward`

## Что меняет в движке

Механика короткая и целиком в `constrained/outlines_jump_forward.py`:

```python
DISABLE_DISK_CACHE = get_bool_env_var("SGLANG_DISABLE_OUTLINES_DISK_CACHE", "true")

def disk_cache(expire=None, typed=False, ignore=()):
    if not DISABLE_DISK_CACHE:
        return cache(expire, typed, ignore)   # outlines.caching.cache
    else:
        return lambda fn: None

@disk_cache()
def init_state_to_jump_forward(regex_string): ...
```

Обратите внимание на форму отключения: при выключенном кеше декоратор превращает функцию в `None`, а не оставляет ее без кеша. То есть `OutlinesJumpForwardMap.__init__` при попытке вызвать `init_state_to_jump_forward(regex_string)` получил бы `TypeError: 'NoneType' object is not callable`. В checkout'е этого не происходит только потому, что `OutlinesJumpForwardMap` не создается: `OutlinesGrammarBackend._compile_regex` (`constrained/outlines_backend.py`) собирает `RegexGuide` и передает в `OutlinesGrammar` `jump_forward_map = None`. Соответственно `try_jump_forward` сразу выходит по `if not self.jump_forward_map`.

Практический вывод: сегодня флаг влияет только на значение переменной окружения и на то, будет ли `outlines.caching.cache` вообще подключен к этой функции. Наблюдаемого различия в поведении сервера на этом commit'е у него нет. Если вы отлаживаете зависания или падения при структурированном выводе, ищите причину в активном backend'е грамматики (`xgrammar` по умолчанию), а не здесь.

Сама переменная `SGLANG_DISABLE_OUTLINES_DISK_CACHE` объявлена в `srt/environ.py` как `EnvBool(False)`; читается она ровно в одном месте — в файле выше.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Каталог кеша флагом не задается: его расположение определяет сам `outlines` (обычно через свою переменную окружения для директории кеша).
- Задавать флаг при `--grammar-backend xgrammar`, `llguidance` или `none` бессмысленно: код `outlines` в этих режимах не участвует в компиляции грамматик.

## Когда использовать

- Явно выбран `--grammar-backend outlines`, и вы диагностируете проблемы с файловой системой (`diskcache` на NFS, права, конкурентный доступ нескольких процессов к одному каталогу кеша). Даже тогда сначала проверьте, что jump-forward-путь у вас вообще активен — в этом checkout'е он отключен на уровне backend'а.
- Полностью read-only контейнер, где любая попытка писать в кеш нежелательна.
- Не используйте флаг как средство «ускорить» или «починить» структурированный вывод в конфигурации по умолчанию: `xgrammar` о нем не знает.
- Не ожидайте, что флаг уменьшит потребление памяти или ускорит старт: компиляция FSM у outlines-backend'а происходит в момент первого запроса с этой схемой, независимо от флага.

## Влияние на производительность и память

- **Диск.** При выключенном кеше не создаются и не читаются файлы `diskcache`. Это единственный наблюдаемый эффект в принципе.
- **VRAM.** Не влияет.
- **RAM хоста.** Не влияет заметно.
- **Время старта.** Не влияет: кеш читается лениво, при компиляции конкретной схемы.
- **Latency первого запроса со схемой.** В теории (при активном jump-forward-пути) без кеша первая компиляция FSM для каждой новой регулярки была бы дороже. В текущем checkout'е разницы нет, потому что кешируемая функция не вызывается.

## Взаимодействие с другими аргументами

- `--grammar-backend`: определяет, участвует ли `outlines` вообще. По умолчанию поле пустое и `_handle_grammar_backend` подставляет `xgrammar`.
- `--constrained-json-disable-any-whitespace`, `--constrained-json-whitespace-pattern`: настройки построения регулярки из JSON-схемы; у outlines-backend'а `whitespace_pattern` передается в `build_regex_from_object`, то есть влияет на то, какие регулярки попадут в кеш.
- `--max-running-requests`: исторический контекст флага — «high concurrency» из его справки; конкурентный доступ к `diskcache` из нескольких процессов scheduler'а был источником падений.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, ничего не изменилось. **Причина:** активен `xgrammar` либо jump-forward-путь у outlines-backend'а отключен в коде. **Проверка:** значение `grammar_backend` в итоговом дампе `server_args=`.
- **Симптом:** ошибки записи в каталог кеша при структурированном выводе с `--grammar-backend outlines`. **Причина:** права или файловая система. **Решение:** флаг либо перенос каталога кеша `outlines`.
- **Симптом:** `TypeError: 'NoneType' object is not callable` в `OutlinesJumpForwardMap`. **Причина:** сочетание выключенного кеша с восстановленным jump-forward-путем (актуально при правках кода или другой версии пакета). **Решение:** не выключать кеш в такой сборке.
- **Что смотреть:** итоговый дамп `server_args=` — поля `disable_outlines_disk_cache` и `grammar_backend`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --grammar-backend outlines --disable-outlines-disk-cache
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --grammar-backend outlines --disable-outlines-disk-cache --constrained-json-disable-any-whitespace
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/python/sglang/srt/constrained/outlines_jump_forward.py`
- `sglang/python/sglang/srt/constrained/outlines_backend.py`
- `sglang/python/sglang/srt/constrained/base_grammar_backend.py`
- `sglang/docs/docs/advanced_features/structured_outputs.mdx`
