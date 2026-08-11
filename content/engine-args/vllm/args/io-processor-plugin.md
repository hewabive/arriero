---
schema: 1
engine: vllm
primaryName: "--io-processor-plugin"
title: "--io-processor-plugin"
summary: Имя плагина, который берёт на себя пре- и постобработку запроса для pooling-моделей. Работает только через `/pooling`, требует установленного entry-point'а и никак не валидирует данные плагина.
group: ModelConfig
related:
  - --runner
  - --convert
  - --pooler-config
  - --model-class-overrides
---

# --io-processor-plugin

## Кратко

IO Processor plugin — расширение, которое подменяет вход и выход движка для pooling-моделей: клиент шлёт произвольный объект (например, геопривязанный растр), плагин превращает его в один или несколько промптов, а результат пулинга — обратно в произвольный объект.

Это узкий механизм: он работает только для pooling-runner'а и только через эндпоинт `/pooling`. Генеративные модели его не используют.

## Оригинальная справка

```text
IOProcessor plugin name to load at model startup
```

## Паспорт аргумента

- Флаги: `--io-processor-plugin`
- Группа argparse: `ModelConfig`
- Тип значения: str (имя entry-point'а, не путь и не FQCN)
- Допустимые значения: `choices: null` — список **реестровый**: это имена entry-point'ов в группе `vllm.io_processor_plugins`, установленных в конкретном окружении. Посмотреть на своей сборке: `python -c "from importlib.metadata import entry_points; print([e.name for e in entry_points(group='vllm.io_processor_plugins')])"`
- Значение по умолчанию: `None`
- Эффективное значение: при `None` используется поле `io_processor_plugin` из `config.json` модели, если оно там есть; CLI-значение имеет приоритет над конфигом
- Где объявлен: `vllm/config/model.py:ModelConfig.io_processor_plugin`
- Этап применения: старт сервера — сборка фабрик pooling-эндпоинтов; далее на каждый запрос `/pooling`

## Что меняет в движке

**Разрешение имени.** `vllm/plugins/io_processors/__init__.py`:

- `has_io_processor(vllm_config, plugin_from_init)` — если CLI-значение задано, берётся оно; иначе `hf_config.to_dict().get("io_processor_plugin")`. Возвращает `True`, если хоть один источник дал имя;
- `get_io_processor(...)` — загружает **все** entry-point'ы группы `vllm.io_processor_plugins`, вызывает каждый (он обязан вернуть FQCN класса процессора), собирает карту `имя → FQCN`, находит запрошенное имя и инстанцирует класс через `resolve_obj_by_qualname`.

Ошибки на этом шаге фатальны для старта:

- `ValueError: No IOProcessor plugins installed but one is required (<name>).`
- `ValueError: The model requires the '<name>' IO Processor plugin but it is not installed. Available plugins: [...]` — в тексте перечислены реально доступные имена, это лучший источник правды для вашей сборки.

Отдельный entry-point, упавший при загрузке, не валит старт: пишется `warning "Failed to load plugin %s."` и он просто выпадает из карты.

**Подключение.** `vllm/entrypoints/pooling/factories.py` при `has_io_processor(...)` регистрирует обработчик задачи `plugin` (`PluginWithIOProcessorPlugins`); без плагина на месте той же задачи стоит `PluginWithoutIOProcessorPlugins`.

**Контракт плагина** (`vllm.plugins.io_processors.interface.IOProcessor`): `parse_data` валидирует пользовательский объект, `merge_sampling_params` / `merge_pooling_params` дополняют параметры, `pre_process*` превращают вход в `PromptType`, `post_process*` собирают ответ из `PoolingRequestOutput`. Апстрим-документация формулирует границу ответственности прямо: «vLLM does not perform any validation of input/output data, and it is up to the plugin to ensure the correct data is being fed to the model and returned to the user».

## Значения и формат

- Одна строка — **имя entry-point'а**, как оно объявлено в `setup.py`/`pyproject.toml` плагина, а не путь к модулю и не имя класса.
- Не задан ⇒ `None` ⇒ смотрится поле `io_processor_plugin` в `config.json` модели.
- Приоритет строго: CLI > конфиг модели.
- Значение проверяется только на этапе разрешения; опечатка даёт отказ старта с перечнем доступных имён.

## Когда использовать

- Модель, для которой автор опубликовал плагин ввода-вывода (в апстрим-примерах — `terratorch_segmentation` для PrithviGeospatialMAE), и вы хотите ходить в неё «нативным» форматом, а не собирать промпты вручную.
- Переопределить плагин, прописанный в `config.json` модели, своим.
- **Не используйте** на генеративном инстансе: путь плагина заведён только в pooling-фабрике, и никакого эффекта не будет.
- Помните, что плагин — это чужой код, исполняемый в процессе сервера. По классу риска он ближе к `--logits-processors` и `--trust-remote-code`, чем к обычной настройке.

## Влияние на производительность и память

Сам аргумент ничего не выделяет. Всё, что делает плагин, идёт за его счёт: `pre_process` может развернуть один пользовательский объект в десятки промптов (тогда одна внешняя «единица работы» превращается в батч запросов к движку), `post_process` собирает выход на хосте. Оценивать нагрузку нужно по поведению конкретного плагина, а не по этому флагу. На VRAM, KV-cache и время компиляции влияния нет; на время старта — стоимость импорта всех entry-point'ов группы.

## Взаимодействие с другими аргументами

- `--runner`: механизм заведён только для `pooling`. На `generate` плагин не подключается.
- `--convert`: если pooling-режим получается конверсией генеративной модели, плагин работает поверх результата конверсии.
- `--pooler-config`: настраивает пулер; плагин работает снаружи него — на входе и на выходе.
- `--model-class-overrides`: соседний механизм подмены, но на уровне класса модели, а не ввода-вывода.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: No IOProcessor plugins installed but one is required (terratorch_segmentation).` **Причина:** имя запрошено (флагом или конфигом модели), но в окружении нет ни одного плагина группы. **Лечение:** установить пакет плагина в то же uv-окружение, откуда запускается `vllm`.
- **Симптом:** `ValueError: The model requires the 'X' IO Processor plugin but it is not installed. Available plugins: ['y', 'z'].` **Причина:** опечатка в имени или не тот пакет. **Лечение:** взять имя из списка в сообщении.
- **Симптом:** плагин не запросили, а старт всё равно требует его. **Причина:** имя прописано в `config.json` модели. **Лечение:** либо установить плагин, либо переопределить поле через `--hf-overrides`.
- **Симптом:** в логе `WARNING ... Failed to load plugin <name>.` с трейсбеком, но старт продолжился. **Причина:** сбойный entry-point исключён из карты. **Следствие:** если это был нужный плагин, дальше будет ошибка «not installed».
- **Симптом:** запрос к `/pooling` возвращает не то, что ожидалось. **Причина:** vLLM не валидирует данные плагина. **Диагностика:** сторона плагина, а не движка.
- **Подтверждение принятого значения:** debug-строки `IOProcessor plugin to be loaded <name>` и `No IOProcessor plugins requested by the model` в логе старта.

## Примеры

```bash
vllm serve ibm-nasa-geospatial/Prithvi-EO-2.0-300M-TL-Sen1Floods11 --runner pooling --io-processor-plugin terratorch_segmentation --trust-remote-code
```

```bash
vllm serve /models/pooling-model --io-processor-plugin my_custom_processor --max-model-len 4096
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/plugins/io_processors/__init__.py`
- `vllm/vllm/entrypoints/pooling/factories.py`
- `vllm/docs/design/io_processor_plugins.md`
- `vllm/docs/design/plugin_system.md`
- `vllm/examples/pooling/plugin/prithvi_geospatial_mae_io_processor.py`
