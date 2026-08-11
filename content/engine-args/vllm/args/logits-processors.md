---
schema: 1
engine: vllm
primaryName: "--logits-processors"
title: "--logits-processors"
summary: Подключает пользовательские обработчики логитов по полному имени класса. Импортирует произвольный Python в процессе сервера и несовместим со speculative decoding и pooling-моделями.
group: ModelConfig
related:
  - --speculative-config
  - --runner
  - --convert
  - --logprobs-mode
  - --max-logprobs
---

# --logits-processors

## Кратко

Флаг принимает список полных имён классов вида `module.path:ClassName`. Каждый класс обязан быть наследником `LogitsProcessor`; движок импортирует модуль, достаёт класс и добавляет его в цепочку обработки логитов после трёх встроенных процессоров.

Это точка расширения с исполнением произвольного кода: значение флага — это `importlib.import_module` в процессе сервера. Относитесь к нему как к `--trust-remote-code`, а не как к обычной настройке.

## Оригинальная справка

```text
One or more logits processors' fully-qualified class names or class
definitions
```

## Паспорт аргумента

- Флаги: `--logits-processors`
- Группа argparse: `ModelConfig`
- Тип значения: список строк (`nargs="+"`, значения через пробел). Формулировка «or class definitions» относится к Python-API: поле объявлено как `list[str | type[LogitsProcessor]]`, но через CLI можно передать только строки
- Допустимые значения: `choices: null`, ограничений нет. Синтаксис FQCN: `<module>:<qualname>`, часть после двоеточия может быть точечной (`pkg.mod:Outer.Inner`)
- Значение по умолчанию: `None` — пользовательских процессоров нет
- Эффективное значение: на TPU список игнорируется (`_load_custom_logitsprocs` возвращает пустой список); при pooling-модели и при speculative decoding непустой список приводит к ошибке
- Где объявлен: `vllm/config/model.py:ModelConfig.logits_processors`
- Этап применения: инициализация сэмплера в worker'е (`build_logitsprocs`) → каждый шаг сэмплирования

## Что меняет в движке

**Загрузка** (`vllm/v1/sample/logits_processor/__init__.py`):

- `_load_logitsprocs_plugins()` подтягивает **все** установленные entry-point'ы группы `vllm.logits_processors` — независимо от этого флага. Сбой любого из них фатален: `RuntimeError: Failed to load LogitsProcessor plugin <ep>`;
- `_load_logitsprocs_by_fqcns(...)` разбирает ваш список: `module_path, qualname = logitproc.split(":")`, импорт внутри `guard_cuda_initialization()`, спуск по точечному qualname, проверка `issubclass(obj, LogitsProcessor)`. Ошибки: `RuntimeError: Failed to load {ldx}th LogitsProcessor plugin {logitproc}`, `ValueError: Loaded logit processor must be a type.`, `ValueError: {X} must be a subclass of LogitsProcessor`;
- `_load_custom_logitsprocs` = плагины + ваш список; результат кэшируется через `lru_cache`.

**Сборка цепочки** (`build_logitsprocs`):

- pooling-модель с непустым списком ⇒ `ValueError` (`STR_POOLING_REJECTS_LOGITSPROCS`); без списка просто пропускается с debug-строкой;
- `speculative_config` задан и список непуст ⇒ `ValueError("Custom logits processors are not supported when speculative decoding is enabled.")`; даже без списка при spec-decode остаётся только `MinTokensLogitsProcessor` и печатается предупреждение «min_p and logit_bias parameters won't work with speculative decoding»;
- иначе цепочка = `BUILTIN_LOGITS_PROCESSORS` (`MinTokensLogitsProcessor`, `LogitBiasLogitsProcessor`, `MinPLogitsProcessor`) + ваши классы, в порядке передачи.

**Исполнение.** `Sampler.apply_logits_processors` вызывает часть цепочки до сэмплирования (не argmax-инвариантные процессоры) и часть после применения температуры (argmax-инвариантные, по умолчанию `min_p`). Логиты к этому моменту уже приведены к float32.

**Валидация параметров запроса.** `validate_logits_processors_parameters(...)` вызывает `validate_params(sampling_params)` каждого загруженного процессора; `ValueError` из легаси-реализаций конвертируется в `VLLMValidationError` ради обратной совместимости. Это тот механизм, через который процессор объявляет свои per-request параметры.

**Совместимость с V2 runner.** Непустой `logits_processors` **или** наличие любого установленного плагина группы добавляет «custom logits processors» в `_get_v2_model_runner_unsupported_features` (`vllm/config/vllm.py`).

## Значения и формат

- Одно или несколько значений через пробел: `--logits-processors mypkg.procs:BanTokens mypkg.procs:Clamp`.
- Разделитель модуля и класса — двоеточие, не точка. `mypkg.procs.BanTokens` не разберётся: `split(":")` вернёт один элемент и распаковка упадёт.
- Модуль должен быть импортируем из окружения сервера (тот же uv-env, из которого запускается `vllm`). Путь к файлу не принимается.
- Порядок значим: процессоры добавляются в цепочку в порядке передачи, после встроенных.
- Не задан ⇒ `None`. Обратите внимание: даже при `None` установленные entry-point-плагины всё равно загружаются.

## Когда использовать

- Доменное ограничение генерации, которое не выражается штатными средствами (грамматики — это `--structured-outputs-config`, а не этот флаг).
- Собственный семплинг-эксперимент, требующий доступа к тензору логитов.
- **Не используйте**, если задача решается `logit_bias`, `min_p`, `stop`, структурированным выводом или узлами пайплайна arriero (`docs/API_PROXY_PIPELINES.md`) — те дешевле и не тянут за собой несовместимости.
- **Не используйте вместе со speculative decoding** — старт упадёт.
- Учитывайте, что код процессора выполняется в горячем цикле декодирования: медленная реализация на Python бьёт по latency каждого шага для всего батча, а не только для «своих» запросов.

## Влияние на производительность и память

- **Latency и throughput.** Каждый процессор — дополнительная операция над тензором `(batch, vocab)` на каждом шаге. Для 150k словаря и батча 32 это ~19 M элементов float32 за проход; всё, что не векторизовано, обходится дорого.
- **VRAM.** Собственно цепочка ничего не выделяет, но процессор может завести свои буферы; они выделяются вне профилирования памяти и не учитываются в бюджете `--gpu-memory-utilization`.
- **Время старта.** Импорт модулей и entry-point'ов; на тяжёлых зависимостях заметно.
- **Совместимость.** Потеря V2 model runner'а — это не производительность в текущем шаге, но ограничение на будущие оптимизации.

## Взаимодействие с другими аргументами

- `--speculative-config`: взаимно исключающие. Непустой список ⇒ отказ старта.
- `--runner pooling` / `--convert embed|classify`: pooling-модели пользовательские процессоры не поддерживают, старт падает.
- `--logprobs-mode`: `processed_*` режимы возвращают логиты/логвероятности **после** всех процессоров, включая ваши; `raw_*` — до них. Это единственный способ увидеть в API эффект своего процессора.
- `--max-logprobs`: сколько значений вернётся клиенту.
- `--structured-outputs-config`: штатная альтернатива для ограничений формата, не требующая внешнего кода.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: not enough values to unpack (expected 2, got 1)` при старте. **Причина:** в FQCN точка вместо двоеточия. **Лечение:** `module.path:ClassName`.
- **Симптом:** `RuntimeError: Failed to load 0th LogitsProcessor plugin mypkg.procs:BanTokens`. **Причина:** модуль не импортируется в окружении сервера. **Проверка:** `python -c "import mypkg.procs"` тем же интерпретатором, откуда запускается `vllm`.
- **Симптом:** `ValueError: BanTokens must be a subclass of LogitsProcessor`. **Причина:** класс не наследует базовый интерфейс.
- **Симптом:** `ValueError: Custom logits processors are not supported when speculative decoding is enabled.` **Лечение:** отказаться от одного из двух.
- **Симптом:** `RuntimeError: Failed to load LogitsProcessor plugin <entry point>` при пустом флаге. **Причина:** сломанный установленный плагин группы `vllm.logits_processors`, не ваш список. **Лечение:** удалить пакет плагина.
- **Симптом:** просадка throughput после подключения процессора. **Проверка:** сравнить `vllm bench` до и после; профилировать сам процессор.
- **Подтверждение принятого значения:** debug-строки `%s additional custom logits processors specified, checking whether they need to be loaded.` и `- Loading logits processor <fqcn>` в логе старта.

## Примеры

```bash
vllm serve /models/Qwen3-4B --logits-processors mypkg.procs:BanTokensProcessor --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --logits-processors mypkg.procs:BanTokensProcessor mypkg.procs:ClampProcessor --logprobs-mode processed_logprobs
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/v1/sample/logits_processor/__init__.py`
- `vllm/vllm/v1/sample/sampler.py`
- `vllm/vllm/config/vllm.py`
- `vllm/docs/features/custom_logitsprocs.md`
- `vllm/docs/features/custom_arguments.md`
- `docs/API_PROXY_PIPELINES.md` (arriero)
