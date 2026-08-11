---
schema: 1
engine: sglang
primaryName: "--extra-metric-labels"
title: "--extra-metric-labels"
summary: Добавляет постоянные метки ко всем Prometheus-сериям сервера — обычно чтобы различать инстансы, ноды или окружения в общем дашборде. Значения статические, из командной строки; на кардинальность влияет напрямую.
group: observability
related:
  - --enable-metrics
  - --tokenizer-metrics-custom-labels-header
  - --tokenizer-metrics-allowed-custom-labels
  - --served-model-name
  - --enable-metrics-for-all-schedulers
  - --bucket-time-to-first-token
---

# --extra-metric-labels

## Кратко

Аргумент принимает JSON-объект и подмешивает его пары в базовый набор меток всех трех групп коллекторов: tokenizer, scheduler и radix cache. Метки статические — они задаются один раз при запуске и одинаковы для каждого наблюдения, поэтому кардинальность растет ровно в число заданных комбинаций, то есть в единицу. Типичное применение — пометить инстанс (`{"instance": "kt-dsv3-a"}`), стенд или версию окружения, когда несколько серверов пишут в один Prometheus и меток `model_name` + `engine_type` для различения не хватает. Без `--enable-metrics` аргумент инертен: коллекторы не создаются.

## Оригинальная справка

```text
The custom labels for metrics. e.g. '{"label1": "value1", "label2": "value2"}'
```

## Паспорт аргумента

- Флаги: `--extra-metric-labels`
- Группа: `observability`
- Тип значения: одна строка, разбираемая `json.loads` (`type_parser` в объявлении `Arg`), ожидается объект `Dict[str, str]`
- Допустимые значения: `choices` нет. То, что результат разбора действительно словарь, argparse не проверяет — проверки нет нигде, ошибка вылезет позже, при `labels.update(...)`
- Значение по умолчанию: `null` — дополнительных меток нет
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает
- Где объявлен: `ServerArgs.extra_metric_labels`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI (`json.loads`) → конструкторы коллекторов в tokenizer- и scheduler-процессах → инициализация коллектора radix-кеша

## Что меняет в движке

Значение читается ровно в трех местах, и везде одинаково — как `labels.update(...)` поверх базового набора:

- `TokenizerManager.init_metric_collector_watchdog` — база `{model_name, engine_type}` плюс `priority` при приоритетном планировании и пустые заготовки под `--tokenizer-metrics-allowed-custom-labels`;
- `SchedulerMetricsCollectorContext.init_new` — база `{model_name, engine_type, tp_rank, pp_rank, moe_ep_rank}` плюс `dp_rank`, если DP включен;
- `BasePrefixCache.init_metrics_collector` — база `{cache_type}` (имя класса кеша), читается через `get_observability().extra_metric_labels`.

Поскольку `update` идет последним, ваши ключи **перекрывают** базовые при совпадении имен. Задать `{"model_name": "…"}` технически можно, и это переопределит `--served-model-name` в метриках, но такая подмена делает серии неотличимыми от чужих и ломает готовые дашборды.

Метки становятся частью имени серии в prometheus_client, поэтому изменить их у работающего сервера невозможно, а после перезапуска с другим набором старые серии в Prometheus останутся как отдельные временные ряды.

## Значения и формат

- Один аргумент — одна строка JSON. В shell ее надо взять в одинарные кавычки: `--extra-metric-labels '{"node": "gpu-01"}'`.
- Значения должны быть строками: числа и `null` JSON примет, но prometheus_client приводит значения меток к строке, и `{"replica": 1}` даст метку `replica="1"`. Лучше сразу писать строкой.
- Имена меток должны быть валидными идентификаторами Prometheus (`[a-zA-Z_][a-zA-Z0-9_]*`). Дефис или точка в имени валят регистрацию метрики в момент создания коллектора, то есть при старте.
- Пустой объект `'{}'` допустим и эквивалентен незаданному аргументу.
- Список вместо объекта (`'["a","b"]'`) разберется, но упадет позже: `dict.update` со списком строк вызовет `ValueError` в конструкторе коллектора.
- Специальных значений (`auto`, `none`) нет.

## Когда использовать

- Когда в один Prometheus пишут несколько инстансов SGLang: без дополнительной метки серии с одинаковым `model_name` сольются. Практичный минимум — `{"instance_name": "<имя инстанса arriero>"}`.
- Когда нужен разрез по стендам или по версии окружения: `{"env": "prod", "sglang_kt": "0.5.4"}` избавляет от переписывания дашбордов при переезде.
- Не использовать для чего-либо, что меняется от запроса к запросу — это невозможно по конструкции (метки статические), а для пер-запросных меток есть `--tokenizer-metrics-custom-labels-header` вместе с `--tokenizer-metrics-allowed-custom-labels`.
- Не дублировать метки, которые Prometheus и так добавит при скрейпе (`job`, `instance` из `scrape_config`): они появятся сверху и создадут путаницу при совпадении имен.

## Влияние на производительность и память

- VRAM: не затрагивает.
- RAM хоста: набор статический, поэтому число серий не растет — растет длина каждой строки в `/metrics` и размер соответствующих записей в `PROMETHEUS_MULTIPROC_DIR`. Практически незаметно.
- Latency: метки резолвятся при каждом `labels(**self.labels)`; лишние две-три пары не меняют картину.
- Время старта и throughput: не влияет.
- Единственный реальный риск — если задать метку, значение которой вы потом захотите менять между перезапусками: каждое новое значение создаст в Prometheus новый временной ряд, и старые останутся до истечения retention.

## Взаимодействие с другими аргументами

- `--enable-metrics`: обязателен. Без него ни один из трех коллекторов не создается, и аргумент не делает ничего.
- `--tokenizer-metrics-custom-labels-header` / `--tokenizer-metrics-allowed-custom-labels`: соседний, но другой механизм — метки берутся из HTTP-заголовка запроса и потому динамические. Именно они опасны по кардинальности, а `--extra-metric-labels` — нет.
- `--served-model-name`: задает базовую метку `model_name`; при совпадении ключа ваш словарь ее перекроет.
- `--enable-metrics-for-all-schedulers`: добавляет серии по `tp_rank`; ваши метки перемножаются с ними.
- `--bucket-*`: число границ гистограмм умножается на кардинальность меток; со статическими метками множитель остается единицей.

## Типовые проблемы и диагностика

- `argument --extra-metric-labels: invalid loads value: '{node: gpu-01}'` — это не JSON: ключи и значения должны быть в двойных кавычках.
- Старт падает в tokenizer-процессе с ошибкой prometheus_client про недопустимое имя метки — в ключе дефис, точка или двоеточие.
- `ValueError: dictionary update sequence element #0 has length 1` при создании коллектора — передан JSON-массив вместо объекта.
- Метки не появились в `/metrics` — проверьте `extra_metric_labels={...}` и `enable_metrics=True` в дампе `server_args=` при старте; типичная причина — забытый `--enable-metrics`.
- Метки видны у запросных метрик, но не у метрик кеша — коллектор кеша создается позже и только там, где кеш существует; проверьте, что смотрите на серии с меткой `cache_type`.
- **В arriero:** аналогичную роль в собственной телеметрии играют записи трейса: `modelId`, `targetId`, `sourceId`/`sourceName` (`docs/API_PROXY_FOUNDATION.md`) уже различают инстансы и клиентов без всякой конфигурации движка. Метки `--extra-metric-labels` нужны только для внешнего Prometheus.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-metrics --extra-metric-labels '{"instance_name": "kt-dsv3-a", "host": "gpu-01"}'
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --enable-metrics --enable-metrics-for-all-schedulers --extra-metric-labels '{"env": "prod"}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/mem_cache/base_prefix_cache.py`
- `sglang/docs/docs/references/production_metrics.mdx`
- arriero: `docs/API_PROXY_FOUNDATION.md`
