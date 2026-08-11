---
schema: 1
engine: sglang
primaryName: "--lora-paths"
title: "--lora-paths"
summary: Список LoRA-адаптеров, загружаемых на старте. Задает и имена, по которым их выбирают запросы, и — если `--max-lora-rank`/`--lora-target-modules` не указаны — форму GPU-пула адаптеров.
group: lora
related:
  - --enable-lora
  - --max-lora-rank
  - --lora-target-modules
  - --max-loaded-loras
  - --max-loras-per-batch
  - --lora-strict-loading
  - --lora-backend
  - --served-model-name
---

# --lora-paths

## Кратко

`--lora-paths` перечисляет адаптеры, которые сервер загрузит при старте. Само наличие аргумента включает `--enable-lora`. Каждый элемент задается одним из трех способов: голый путь, `имя=путь` или JSON-объект (единственный способ пометить адаптер `pinned`). Имя, а не путь, — это то, что клиент указывает в поле `lora_path` запроса или в `model` через синтаксис `база:адаптер`. Если ранг и целевые модули явно не заданы, они выводятся из загруженных здесь адаптеров, и это же становится потолком для всего, что будет догружено динамически.

## Оригинальная справка

```text
The list of LoRA adapters to load. Each adapter must be specified in one of the following formats: <PATH> | <NAME>=<PATH> | JSON with schema {"lora_name":str,"lora_path":str,"pinned":bool}
```

## Паспорт аргумента

- Флаги: `--lora-paths`
- Группа: `lora`
- Тип значения: список строк; `action=LoRAPathAction` с `type=str, nargs="*"`
- Допустимые значения: `<PATH>` | `<NAME>=<PATH>` | JSON-объект `{"lora_name":str,"lora_path":str,"pinned":bool}`
- Значение по умолчанию: `null`; `check_lora_server_args` превращает его в пустой список
- Эффективное значение: строки разбираются в объекты `LoRARef` (`lora_id`, `lora_name`, `lora_path`, `pinned`) на этапе `check_lora_server_args`
- Где объявлен: `ServerArgs.lora_paths`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI (`LoRAPathAction`) → `check_lora_server_args` → `LoRAManager.init_lora_adapters` после загрузки весов модели

## Что меняет в движке

### Разбор

`LoRAPathAction` (`sglang/python/sglang/srt/arg_groups/argparse_actions.py`) обрабатывает каждый элемент: обрезает пробелы, и если строка начинается с `{` и заканчивается `}` — разбирает её как JSON и требует наличия ключей `lora_name` и `lora_path`. Всё остальное остается строкой.

`check_lora_server_args` доводит разбор до `LoRARef`:

- строка с `=` — сплит по **первому** знаку: `name`, `path`, `pinned=False`;
- строка без `=` — **имя равно пути целиком**. То есть `--lora-paths /models/lora/sql` создаст адаптер с именем `/models/lora/sql`, и именно эту строку придется указывать в запросах;
- словарь — `lora_name`, `lora_path`, `pinned` (по умолчанию `False`);
- `lora_id` — детерминированный: `LoRARef.deterministic_id(name, path)`, то есть перезапуск сервера с той же парой даст тот же id.

### Загрузка и валидация каждого адаптера

`LoRAManager._load_lora_adapter` строит `LoRAConfig` из `adapter_config.json`. Путь может быть локальным каталогом либо идентификатором репозитория HF — в последнем случае вызывается `snapshot_download(path, allow_patterns=["*.json"])`, то есть **сервер полезет в сеть прямо на старте**. Затем `validate_new_adapter` отвергает:

- адаптеры, добавляющие токены в словарь (`lora_added_tokens_size > 0`) — `LoRA serving currently doesn't support adapters that add tokens to the vocabulary`;
- DoRA-адаптеры (`use_dora`);
- повторное имя (`... because it is already loaded`); повторный путь под другим именем разрешен, но с предупреждением;
- адаптеры, не помещающиеся в пул: ранг больше `--max-lora-rank` либо целевые модули не входят в `--lora-target-modules`;
- закрепление сверх лимита: `pinned` разрешен, пока `num_pinned_loras < max_loras_per_batch - 1`.

Любой отказ на старте превращается в `RuntimeError: Failed to load LoRA adapter <name>: <причина>` и валит сервер — в отличие от динамической загрузки, где ошибка возвращается в HTTP-ответе.

Дополнительная проверка в `check_lora_server_args`: если задан `--max-loaded-loras`, то `len(lora_paths) <= max_loaded_loras`.

### Как адаптер выбирается запросом

- Поле `lora_path` в запросе на самом деле содержит **имя** адаптера: `_resolve_lora_path` в tokenizer-менеджере ищет его в `lora_ref_cache`, ключ которого — `lora_name`. Неизвестное значение дает `Got LoRA adapter that has never been loaded: <name>`.
- OpenAI-совместимый путь поддерживает синтаксис `model = "база:адаптер"` (`_parse_model_parameter`, сплит по первому двоеточию); он имеет приоритет над явным `lora_path`. Именно из-за этого синтаксиса `--served-model-name` не может содержать двоеточие — это отдельный ассерт при старте.
- Каждый загруженный адаптер появляется отдельной карточкой в `GET /v1/models` с `id = lora_name`, `root = lora_path` и `parent` = имя базовой модели.

### `pinned`

Закрепленный адаптер навсегда занимает один слот GPU-пула и не вытесняется — до явной выгрузки. Это убирает повторные H2D-копии для горячего адаптера ценой уменьшения свободных слотов. Закрепить все слоты движок не даст: лимит `max_loras_per_batch - 1` защищает от голодания базовой модели и незакрепленных адаптеров.

## Значения и формат

- Разделитель — пробел: `--lora-paths a=/p/a b=/p/b`. `nargs="*"` означает, что аргумент можно указать и без значений (получится пустой список).
- Формы можно смешивать в одном списке — это прямо демонстрируется в апстрим-документации.
- В форме `имя=путь` сплит идет по первому `=`, так что путь может содержать `=`, а имя — нет.
- JSON-элемент должен быть **одним** аргументом оболочки и обязан начинаться с `{` и заканчиваться `}`, иначе он будет принят за путь.
- Путь — либо существующий локальный каталог с `adapter_config.json`, либо repo id на HuggingFace Hub.
- Порядок элементов значения не имеет; при выводе `max_lora_rank` берется максимум по всем адаптерам, при выводе `target_modules` — объединение.

## Когда использовать

- Набор адаптеров известен заранее и меняется редко: загрузка на старте дает предсказуемое время первого запроса и падает громко, если адаптер битый.
- Нужно закрепить горячий адаптер (`pinned`) — это единственный способ сделать это на старте.
- **Не полагайтесь** на вывод формы пула из адаптеров, если планируете догружать другие: апстрим-документация прямо рекомендует в динамическом режиме задавать `--max-lora-rank` и `--lora-target-modules` явно, иначе всё догружаемое обязано быть «не больше» стартового набора.
- **Избегайте** формы «голый путь» на сервере, доступном клиентам: имя адаптера станет путем в файловой системе и утечет в `GET /v1/models`.
- **Не указывайте** repo id, если сервер не должен ходить в сеть на старте — `snapshot_download` вызывается безусловно, когда путь не является каталогом.

## Влияние на производительность и память

- **RAM хоста.** Веса каждого адаптера кешируются на CPU в `LoRAManager.loras` и живут там всё время, пока адаптер зарегистрирован. При `--enable-lora-overlap-loading` они дополнительно закрепляются (pinned), что делает память неосвобождаемой.
- **VRAM.** Сами по себе `--lora-paths` VRAM не занимают: на GPU лежит пул на `--max-loras-per-batch` слотов, размер которого определяется `--max-lora-rank` и `--lora-target-modules`. Но именно из адаптеров эти два значения и выводятся, если не заданы, — так что один адаптер ранга 256 в списке раздувает пул для всех.
- **Время старта.** Плюс чтение конфигов, возможный `snapshot_download`, чтение и раскладка весов каждого адаптера.
- **Latency.** `pinned`-адаптер не требует загрузки в слот перед батчем; незакрепленный при промахе слота копируется H2D синхронно (или асинхронно при overlap-загрузке).

## Взаимодействие с другими аргументами

- `--enable-lora`: подтягивается автоматически при непустом списке.
- `--max-lora-rank`, `--lora-target-modules`: если заданы, адаптеры проверяются на соответствие; если нет — выводятся из адаптеров.
- `--max-loaded-loras`: длина списка не может его превышать.
- `--max-loras-per-batch`: определяет число слотов и потолок для закрепленных адаптеров (`max - 1`).
- `--lora-strict-loading`: превращает несовпадение имен весов адаптера с целевыми модулями из предупреждения в ошибку.
- `--served-model-name`: не должен содержать `:` из-за синтаксиса `база:адаптер`.
- `--lora-backend`, `--max-lora-chunk-size`: как исполняются ядра для загруженных адаптеров.

## Типовые проблемы и диагностика

- `RuntimeError: Failed to load LoRA adapter <name>: LoRA adapter <name> with rank R is incompatible with the current LoRA memory pool configuration...` — ранг больше `--max-lora-rank` либо целевые модули шире `--lora-target-modules`.
- `... doesn't support adapters that add tokens to the vocabulary` / `... doesn't support DoRA adapters` — адаптер неподдерживаемого вида.
- `Failed to load LoRA adapter <name> as a pinned adapter. It is not allowed to pin all slots...` — закреплено `max_loras_per_batch - 1` адаптеров.
- `AssertionError: The number of LoRA paths should not exceed max_loaded_loras.`
- `<path> is already loaded with name: <a>, but another copy is being loaded with name: <b>` — предупреждение о дубликате пути; это разрешено.
- Запрос отвечает `Got LoRA adapter that has never been loaded: <x>` — в поле `lora_path` передали путь, а не имя адаптера.
- `assert "lora_path" in obj and "lora_name" in obj` из `LoRAPathAction` — JSON-элемент без обязательных ключей.
- Что реально загружено, показывают строки `LoRA adapter loading starts: LoRARef(...)` / `... completes: ...` с указанием свободной VRAM до и после, а также `GET /v1/models`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-paths sql=/models/lora/sql code=/models/lora/code --max-loras-per-batch 3
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-paths '{"lora_name":"hot","lora_path":"/models/lora/hot","pinned":true}' cold=/models/lora/cold --max-loras-per-batch 3 --max-lora-rank 64 --lora-target-modules all
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/python/sglang/srt/lora/lora_config.py`
- `sglang/python/sglang/srt/lora/lora_registry.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_base.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
