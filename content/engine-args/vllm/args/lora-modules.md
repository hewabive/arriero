---
schema: 1
engine: vllm
primaryName: "--lora-modules"
title: "--lora-modules"
summary: Список LoRA-адаптеров, которые загружаются при старте и становятся отдельными именами моделей в API. Работает только вместе с `--enable-lora`; неудачная загрузка любого адаптера роняет старт.
group: Frontend
related:
  - --enable-lora
  - --max-loras
  - --max-lora-rank
  - --max-cpu-loras
  - --lora-dtype
  - --default-mm-loras
  - --served-model-name
---

# --lora-modules

## Кратко

Аргумент — это только HTTP-слой: он регистрирует пары «публичное имя → путь к адаптеру» в реестре моделей API-сервера. Всё, что касается емкости и стоимости LoRA (сколько адаптеров держать в батче, какой максимальный ранг, сколько памяти под них), задают аргументы группы `LoRAConfig`, начиная с обязательного `--enable-lora`.

Адаптеры загружаются на старте, до открытия порта. Если хотя бы один не загрузился, `init_static_loras` бросает `ValueError`, и сервер не поднимается.

## Оригинальная справка

```text
LoRA modules configurations in either 'name=path' format or JSON format
or JSON list format. Example (old format): `'name=path'` Example (new
format): `{"name": "name", "path": "lora_path",
"base_model_name": "id"}`
```

## Паспорт аргумента

- Флаги: `--lora-modules`
- Группа argparse: `Frontend`
- Тип значения: список строк (`nargs="+"`, `type=optional_type(str)`, `action=LoRAParserAction`)
- Допустимые значения: не ограничены; каждый элемент — либо `имя=путь`, либо JSON-объект
- Значение по умолчанию: `None` — статических адаптеров нет
- Эффективное значение: `process_lora_modules` (`vllm/entrypoints/serve/utils/api_utils.py`) дописывает к списку адаптеры из `--default-mm-loras` (`LoRAConfig`), поэтому фактический набор может быть шире заданного
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.lora_modules`
- Этап применения: разбор CLI (`LoRAParserAction`) → инициализация состояния API-сервера (`init_static_loras`, реальная загрузка в движок) → маршрутизация по имени модели

## Что меняет в движке

`LoRAParserAction` (`vllm/entrypoints/openai/cli_args.py`) разбирает каждый элемент по одному правилу: если в строке есть `=` **и** нет `,` — это старый формат `имя=путь`; иначе строка парсится как JSON и подается в конструктор `LoRAModulePath(name, path, base_model_name=None, is_3d_lora_weight=False)`. Ошибка JSON и лишние поля превращаются в `parser.error(...)`, то есть в аварийный выход argparse.

Дальше `init_app_state` создает `OpenAIServingModels(lora_modules=...)` и вызывает `init_static_loras()`. Для каждого адаптера выполняется тот же путь, что и у динамического `POST /v1/load_lora_adapter`: выделяется целочисленный `lora_int_id`, собирается `LoRARequest`, и `engine_client.add_lora(...)` реально грузит веса в worker. Успех логируется как `Loaded new LoRA adapter: name '<имя>', path '<путь>'`.

После загрузки адаптер существует как отдельная запись в `GET /v1/models`: `id` — имя адаптера, `root` — путь, `parent` — `base_model_name` или первое имя базовой модели. Запрос с `model: "<имя адаптера>"` маршрутизируется на базовый движок с этим адаптером.

## Значения и формат

Все три формы принимаются одним флагом, значения разделяются пробелами:

- старый формат: `--lora-modules sql=/models/lora/sql chat=/models/lora/chat`;
- JSON-объект: `--lora-modules '{"name": "sql", "path": "/models/lora/sql"}'`;
- JSON с базовой моделью: `--lora-modules '{"name": "sql", "path": "/models/lora/sql", "base_model_name": "qwen3-4b"}'` — `base_model_name` влияет только на поле `parent` в карточке модели и принимается, лишь если совпадает с одним из имен базовой модели.

Особенности разбора, о которые спотыкаются:

- путь, содержащий запятую, ломает старый формат: из-за условия «есть `=` и нет `,`» такая строка уйдет в JSON-ветку и вызовет `Invalid JSON format for --lora-modules`;
- имя или путь с `=` внутри пути ломает `item.split("=")` (разбиение без ограничения на две части) — используйте JSON-форму;
- пустая строка и литерал `None` в списке пропускаются (`optional_type(str)` плюс явная проверка в `LoRAParserAction`);
- четвертое поле `is_3d_lora_weight` (bool) допустимо в JSON-объекте; посторонние ключи дают `Invalid fields for --lora-modules`.

## Когда использовать

- Несколько дообученных вариантов одной базовой модели обслуживаются одним процессом: адаптеры делят веса базы, и это дешевле нескольких инстансов.
- Нужен предсказуемый набор адаптеров на старте, без обращений к административным эндпоинтам.
- Не используйте вместо динамической загрузки, если набор адаптеров меняется часто: для этого есть `POST /v1/load_lora_adapter` (требует `--enable-lora` и `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True`, и по `vllm/docs/usage/security.md` эти эндпоинты нельзя открывать недоверенным клиентам).
- Не указывайте без `--enable-lora`: старт гарантированно упадет.

## Влияние на производительность и память

- **VRAM.** Каждый активный адаптер занимает память под свои матрицы; объем задается `--max-lora-rank` и числом целевых модулей. Резерв делается исходя из `--max-loras` (сколько адаптеров может быть в одном батче), а не из числа записей в `--lora-modules`. Профилирование памяти выполняется уже с учетом LoRA, поэтому включение LoRA уменьшает остаток под KV-cache при том же `--gpu-memory-utilization`.
- **RAM хоста.** `--max-cpu-loras` определяет размер CPU-кэша адаптеров; адаптеры сверх `--max-loras` подкачиваются оттуда.
- **Время старта.** Растет линейно по числу адаптеров: каждый грузится синхронно до открытия порта.
- **Throughput.** Смешанный батч с разными адаптерами дороже однородного; при числе одновременно востребованных адаптеров больше `--max-loras` планировщик начинает их чередовать, и latency растет.

## Взаимодействие с другими аргументами

Аргументы ниже — группа `LoRAConfig`, здесь они упомянуты только по именам; их собственная механика описана в своих документах.

- `--enable-lora`: обязателен. Без него загрузка падает с `RuntimeError: LoRA is not enabled. Use --enable-lora to enable LoRA.`
- `--max-loras`: сколько адаптеров может участвовать в одном батче; это и есть основной параметр емкости.
- `--max-lora-rank`: верхняя граница ранга; адаптер большего ранга не загрузится.
- `--max-cpu-loras`: размер CPU-кэша адаптеров.
- `--lora-dtype`: тип весов адаптера.
- `--default-mm-loras`: сливается с этим списком в `process_lora_modules`, поэтому итоговый набор может отличаться от заданного здесь.
- `--served-model-name`: задает имена базовой модели; имена адаптеров добавляются к ним в тот же реестр, а не заменяют их.

## Типовые проблемы и диагностика

- **Симптом:** старт падает с `RuntimeError: LoRA is not enabled. Use --enable-lora to enable LoRA.` **Причина:** заданы адаптеры без `--enable-lora`. **Лечение:** добавить `--enable-lora`.
- **Симптом:** `argparse` сообщает `Invalid JSON format for --lora-modules: <строка>`. **Причина:** элемент не подошел под старый формат (в нем есть запятая) и не является валидным JSON. **Лечение:** взять JSON-форму и заключить ее в одинарные кавычки.
- **Симптом:** `Invalid fields for --lora-modules: <строка> - ...`. **Причина:** в JSON есть ключ, которого нет в `LoRAModulePath`. **Лечение:** оставить `name`, `path`, `base_model_name`, `is_3d_lora_weight`.
- **Симптом:** старт падает с сообщением про ненайденный адаптер. **Причина:** путь не существует или в нем нет весов адаптера; `init_static_loras` превращает любую ошибку загрузки в `ValueError` и прекращает старт. **Проверка:** путь и содержимое каталога адаптера. **Лечение:** исправить путь.
- **Симптом:** адаптер загрузился, но запрос с его именем отвечает `model_not_found`. **Причина:** имя в запросе не совпадает с `name` адаптера. **Проверка:** `GET /v1/models` — адаптеры перечислены отдельными карточками с `parent`. **Лечение:** использовать имя из карточки.
- **Подтверждение принятого значения:** строки `Loaded new LoRA adapter: name '...', path '...'` в логе старта, по одной на адаптер.
- **Симптом (arriero):** прокси видит только базовую модель. **Причина:** идентификатор модели инстанса выводится из `--served-model-name`/позиционного аргумента и не знает про адаптеры. **Лечение:** завести отдельную запись модели прокси на нужное имя адаптера.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-lora --lora-modules sql=/models/lora/sql --max-loras 2 --max-lora-rank 16
```

```bash
vllm serve /models/Qwen3-4B --enable-lora --lora-modules '{"name": "sql", "path": "/models/lora/sql", "base_model_name": "qwen3-4b"}' --served-model-name qwen3-4b
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/models/serving.py`
- `vllm/vllm/entrypoints/openai/models/protocol.py`
- `vllm/vllm/entrypoints/serve/utils/api_utils.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/v1/worker/lora_model_runner_mixin.py`
- `vllm/docs/features/lora.md`
- `vllm/docs/usage/security.md`
