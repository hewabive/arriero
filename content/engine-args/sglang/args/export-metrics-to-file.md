---
schema: 1
engine: sglang
primaryName: "--export-metrics-to-file"
title: "--export-metrics-to-file"
summary: Пишет по одной JSON-строке на каждый завершенный запрос в почасовые файлы на диске. Работает независимо от `--enable-metrics`, требует `--export-metrics-to-file-dir` и по умолчанию сохраняет текст промпта целиком.
group: observability
related:
  - --export-metrics-to-file-dir
  - --enable-metrics
  - --log-requests
  - --log-requests-level
  - --enable-request-time-stats-logging
  - --crash-dump-folder
---

# --export-metrics-to-file

## Кратко

Флаг включает `FileRequestMetricsExporter`: при завершении каждого запроса tokenizer-процесс дописывает в файл `<dir>/sglang-request-metrics-<YYYYMMDD_HH>.log` одну строку JSON с параметрами запроса и его `meta_info`. Ротации, обрезки и удаления нет — каждый час создается новый файл, старые остаются навсегда. Что именно попадает в поле `request_parameters`, определяется не этим флагом, а `--log-requests-level`: при значениях по умолчанию (логирование запросов выключено) исключений нет вообще, и **полный текст промпта уходит на диск**. Это главное, что нужно знать перед включением.

## Оригинальная справка

```text
Export performance metrics for each request to local file (e.g. for forwarding to external systems).
```

## Паспорт аргумента

- Флаги: `--export-metrics-to-file`
- Группа: `observability`
- Тип значения: bool, `action="store_true"` — значения не принимает
- Допустимые значения: `choices` нет; парной формы `--no-*` не существует
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным. `__post_init__` не переписывает его, но валидирует: при `--export-metrics-to-file` без `--export-metrics-to-file-dir` старт падает с `ValueError: --export-metrics-to-file-dir is required when --export-metrics-to-file is enabled`
- Где объявлен: `ServerArgs.export_metrics_to_file`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (проверка) → конструктор `TokenizerManager` (создание экспортера и каталога) → завершение каждого запроса

## Что меняет в движке

### Создание экспортера

`TokenizerManager.__init__` всегда создает `RequestMetricsExporterManager`, но список экспортеров непуст только при этом флаге. `FileRequestMetricsExporter.__init__` сразу делает `os.makedirs(export_dir, exist_ok=True)` — то есть каталог создается при старте сервера, а не при первой записи, и недоступный путь валит старт tokenizer-процесса.

Тот же менеджер пытается импортировать дополнительные экспортеры из приватного форка (`sglang.private.managers.request_metrics_exporter_factory`); в публичной сборке импорт молча не удается и остается только файловый.

### Запись

Вызов идет из потока ответа, при `finished`:

```python
if self.request_metrics_exporter_manager.exporter_enabled():
    asyncio.create_task(self.request_metrics_exporter_manager.write_record(obj, out))
```

Запись асинхронная и не блокирует отдачу ответа клиенту. Внутри `write_record`:

- запросы health-check пропускаются (по префиксу в `rid`);
- имя файла считается от текущего часа (`datetime.now().strftime("%Y%m%d_%H")`), при смене часа старый дескриптор закрывается и открывается новый на дозапись;
- запись сериализуется asyncio-локом, сам `write` + `flush` выполняются в пуле потоков.

### Что именно записывается

```python
request_output_data = {
    "request_parameters": json.dumps(request_params),
    **filtered_out_meta_info,
}
```

`request_params` — это **все** поля датакласса запроса (`GenerateReqInput` / `EmbeddingReqInput`) со значением не `None`, кроме двух групп:

- жестко исключенных `ALWAYS_EXCLUDE_FIELDS` — `image_data`, `video_data`, `audio_data`, `input_embeds` (они просто не сериализуются в JSON);
- набора `obj_skip_names`, который берется из `RequestLogger.metadata`.

И вот ключевая деталь: `RequestLogger._compute_metadata()` возвращает `(None, None, None)`, когда `--log-requests` **не** задан. В конструкторе экспортера это превращается в пустое множество (`obj_skip_names or set()`), то есть **не исключается ничего** — в файл идут `text`, `input_ids`, `sampling_params`, `lora_path`. Исключения появляются только при `--log-requests` вместе с `--log-requests-level 0` или `1`.

Сгенерированный ответ в файл не попадает: берется только `out["meta_info"]` (число токенов промпта и ответа, `cached_tokens`, `finish_reason`, тайминги), а `out["text"]` остается за бортом — если только он не отфильтрован через `out_skip_names`, который на выход и рассчитан.

Наборы `obj_skip_names` / `out_skip_names` снимаются **один раз**, при создании `TokenizerManager`. Изменение уровня логирования на лету через `sglang.srt.managers.configure_logging` на уже созданный экспортер не действует.

## Значения и формат

- Флаг без значения; `--export-metrics-to-file true` argparse не примет.
- Обязательно вместе с `--export-metrics-to-file-dir`, иначе старт падает еще в `__post_init__`, до загрузки модели.
- Формат файла — JSON Lines: один объект на строку, `flush` после каждой записи, кодировка UTF-8, режим открытия `a`.
- Имя файла: `sglang-request-metrics-YYYYMMDD_HH.log`, час — локальный (`datetime.now()`), не UTC.
- Отключить после старта нельзя.

## Когда использовать

- Когда нужен пер-запросный сырой поток для внешней системы (биллинг, аналитика), а Prometheus дает только агрегаты. Формат JSON Lines удобно забирать любым сборщиком логов.
- Когда надо разобрать конкретный инцидент постфактум: в файле есть `finish_reason` и полный набор параметров сэмплинга, по которым воспроизводится запрос.
- **Не включать** на сервере с пользовательскими данными без сознательного решения о промптах: по умолчанию они пишутся на диск целиком. Если поток нужен только ради метрик, включайте вместе с `--log-requests --log-requests-level 1` — тогда `text` и `input_ids` будут исключены и из файла тоже.
- Не включать без плана ротации: файлы не удаляются никогда, а объем растет пропорционально трафику **и длине промптов**.
- Не использовать как замену трейсам arriero, если движок работает за прокси менеджера: там та же пер-запросная запись уже есть, с ретенцией и фильтрами.

## Влияние на производительность и память

- VRAM: не затрагивает.
- RAM хоста: один открытый дескриптор и буфер строки; накопления в памяти нет.
- Диск: **неограниченный рост**. Оценка — размер промпта в UTF-8 плюс сотня-другая байт метаданных на каждый запрос, один файл на час. При среднем промпте в 4 КБ и 10 запросах в секунду это порядка 140 МБ в час; при длинном контексте — существенно больше. Ни ротации, ни лимита, ни очистки в движке нет.
- Latency: запись вынесена в `asyncio.create_task` и выполняется в пуле потоков, ответ клиенту не задерживается. Но `flush` после каждой записи означает системный вызов на каждый запрос — на медленном или сетевом диске это заметная фоновая нагрузка.
- Throughput: при большом числе одновременных запросов asyncio-лок сериализует записи; при быстром локальном диске это несущественно.

## Взаимодействие с другими аргументами

- `--export-metrics-to-file-dir`: обязателен, проверяется в `__post_init__`.
- `--enable-metrics`: **не требуется**. Это независимые механизмы: Prometheus — агрегаты в памяти, этот флаг — сырые записи на диск. Их можно включать по отдельности.
- `--log-requests` / `--log-requests-level`: определяют, какие поля запроса будут исключены из файла. Единственный способ убрать промпты из экспорта — задать `--log-requests --log-requests-level 0` (без `sampling_params`) или `1`.
- `--enable-request-time-stats-logging`: соседний способ получить тайминги — но в лог scheduler'а, без параметров запроса.
- `--crash-dump-folder`: другой писатель на диск, но одноразовый и в pickle; сюда пишется постоянно и в JSON.
- `--served-model-name`: в записи не участвует — если моделей несколько, различать их придется по каталогам или по полям запроса.

## Типовые проблемы и диагностика

- `ValueError: --export-metrics-to-file-dir is required when --export-metrics-to-file is enabled` при старте — забыт второй аргумент.
- Старт падает на `os.makedirs` с `PermissionError` — каталог недоступен пользователю, под которым запущен сервер.
- Файлы создаются, но пустые — все запросы были health-check'ами (они пропускаются) либо ни один не дошел до `finished`.
- В логе `Failed to write perf metrics to file: …` — ошибка сериализации или записи; сама ошибка глушится и на ответ клиенту не влияет.
- `Failed to open log file …` при смене часа — на диске кончилось место или каталог удалили под работающим сервером.
- Диск заполняется быстрее ожидаемого — проверьте, не пишутся ли промпты: посмотрите поле `request_parameters` в любой строке файла.
- **В arriero:** пер-запросная запись у менеджера уже есть и она богаче по маршрутной части — трейс прокси (`docs/API_PROXY_FOUNDATION.md`) хранит модель, источник, цель, действия планировщика, токены, длительность, код ошибки, и **сам** ограничен ретенцией в 30 дней с автоматической очисткой. Содержимого запроса он не сохраняет по умолчанию: тело пишется только через явный узел пайплайна `capture-request` в `data/proxy-requests/`. Поэтому `--export-metrics-to-file` для инстанса под управлением arriero осмыслен, только если поток нужен вне менеджера (внешняя аналитика) или если нужны поля, которых у прокси нет: `sampling_params` и `cached_tokens` конкретного запроса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --export-metrics-to-file --export-metrics-to-file-dir /var/log/sglang/request-metrics
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --export-metrics-to-file --export-metrics-to-file-dir /var/log/sglang/request-metrics --log-requests --log-requests-level 1
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/observability/request_metrics_exporter.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/utils/request_logger.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`
