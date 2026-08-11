---
schema: 1
engine: sglang
primaryName: "--generation-tokens-buckets"
title: "--generation-tokens-buckets"
summary: Границы гистограммы длины генерации. Формат тот же, что у --prompt-tokens-buckets, но правило `default` подставляет список границ для промптов (до 1,1 млн токенов), поэтому для генерации почти всегда нужен явный `custom`.
group: observability
related:
  - --prompt-tokens-buckets
  - --enable-metrics
  - --bucket-time-to-first-token
  - --bucket-inter-token-latency
  - --bucket-e2e-request-latency
  - --extra-metric-labels
---

# --generation-tokens-buckets

## Кратко

Правило построения границ для одной гистограммы — `sglang:generation_tokens_histogram` («Histogram of generation token length») в `TokenizerMetricsCollector` (`sglang/python/sglang/srt/observability/metrics_collector.py`).

Главное отличие от парного `--prompt-tokens-buckets` не в синтаксисе, а в списке по умолчанию: отдельного набора границ для генерации в коде нет, и вызов выглядит так:

```python
buckets=generate_buckets(
    server_args.generation_tokens_buckets,
    default_bucket_prompt_tokens,
)
```

То есть `default` для генерации — это те же 35 границ от `100` до `1 100 000`, что и для промптов. Для типичной генерации в сотни-тысячи токенов такая сетка означает, что почти всё попадает в первые три-четыре корзины, и гистограмма ничего не показывает.

## Оригинальная справка

```text
The buckets rule for generation tokens histogram. Supports 3 rule types: 'default' uses predefined buckets; 'tse <middle> <base> <count>' generates two sides exponential distributed buckets (e.g., 'tse 1000 2 8' generates buckets [984.0, 992.0, 996.0, 998.0, 1000.0, 1002.0, 1004.0, 1008.0, 1016.0]).); 'custom <value1> <value2> ...' uses custom bucket values (e.g., 'custom 10 50 100 500').
```

## Паспорт аргумента

- Флаги: `--generation-tokens-buckets`
- Группа: `observability`
- Тип значения: список строк, `nargs="+"` — первый элемент задает тип правила
- Допустимые значения: `choices` нет; первым элементом допустимы только `default`, `tse`, `custom` (проверяет `validate_buckets_rule`)
- Значение по умолчанию: `None`; `generate_buckets` подставляет `["default"]`
- Эффективное значение: `default` разворачивается в `default_bucket_prompt_tokens` — список границ **для промптов**, а не для генерации; `+Inf` добавляет `prometheus_client`
- Где объявлен: `ServerArgs.generation_tokens_buckets`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (валидация) → создание `TokenizerMetricsCollector`, если задан `--enable-metrics`

## Что меняет в движке

Механика разбора общая с `--prompt-tokens-buckets` и живет в `generate_buckets` (`sglang/python/sglang/srt/observability/utils.py`):

- `default` → отсортированный уникальный список переданных по умолчанию границ (здесь — промптовых);
- `tse <middle> <base> <count>` → `middle` плюс/минус `base¹…base^ceil(count/2)`, отрицательные значения обрезаются нулем;
- `custom <v1> <v2> …` → перечисленные значения, отсортированные и дедуплицированные.

Гистограмма наблюдается в tokenizer-процессе по завершении запроса, с тем же набором меток, что и остальные метрики токенизатора. Границы фиксируются при создании коллектора и на живом сервере не меняются.

Валидация (`validate_buckets_rule` в `__post_init__`) выполняется независимо от `--enable-metrics`: неправильное правило уронит старт даже на сервере без метрик.

## Значения и формат

- `custom 16 32 64 128 256 512 1024 2048 4096` — типичная сетка под реальную генерацию.
- `tse 512 2 8` — плотная сетка вокруг 512 токенов; за ее пределами разрешения нет.
- `default` — явное указание того же, что и умолчание, со всеми его недостатками.
- Проверки: `tse` — ровно 4 элемента, `base > 1`, `count > 0`, `middle > 0`; `custom` — минимум 2 элемента, числа, неотрицательные, без дубликатов; `default` — ровно 1 элемент.
- `nargs="+"` делает список «жадным»: ставьте аргумент так, чтобы за ним шел следующий флаг, а не значение чего-то другого.

## Когда использовать

- Практически всегда, если вы вообще собираете метрики SGLang: без явного `custom` гистограмма длины генерации показывает распределение, сжатое в первые корзины.
- Ориентируйтесь на фактический `max_new_tokens` вашей нагрузки: сетка должна давать несколько границ до типичного значения и одну-две выше, чтобы было видно упирающиеся в лимит запросы.
- Не нужен, если `--enable-metrics` не задан.

## Влияние на производительность и память

- На VRAM, планировщик и скорость генерации не влияет.
- Каждая граница — отдельный временной ряд на каждый набор меток. Метки: `model_name`, `engine_type`, плюс `priority` при `--enable-priority-scheduling`, плюс `--extra-metric-labels`, плюс разрешенные пользовательские метки. С клиентскими метками (`--tokenizer-metrics-allowed-custom-labels`) произведение растет неограниченно.
- Наблюдение — один `observe()` на завершенный запрос.

## Взаимодействие с другими аргументами

- `--prompt-tokens-buckets`: тот же формат правила; задает границы для двух гистограмм промпта. Если задаете одно, почти всегда стоит задать и второе.
- `--enable-metrics`: без него границы не применяются, но валидируются.
- `--bucket-time-to-first-token`, `--bucket-inter-token-latency`, `--bucket-e2e-request-latency`: соседние гистограммы с другим форматом — простой список чисел без правил.
- `--extra-metric-labels`: множитель числа рядов.

## Типовые проблемы и диагностика

- **Симптом:** гистограмма генерации показывает, что 99 % запросов «меньше 100 токенов», хотя ответы длиннее. **Причина:** правило `default` подставляет промптовые границы, первая из которых 100. **Лечение:** явный `custom`.
- **Симптом:** `AssertionError: --generation-tokens-buckets custom rule requires at least one bucket value`. **Причина:** `custom` без значений.
- **Симптом:** `AssertionError: --generation-tokens-buckets TSE base must be larger than 1`. **Причина:** `base` ≤ 1.
- **Симптом:** правило принято, а границы в `/metrics` прежние. **Причина:** не задан `--enable-metrics`.
- **Проверка принятого значения:** `curl -s http://127.0.0.1:30000/metrics | grep 'sglang:generation_tokens_histogram_bucket'`; дамп `server_args=` при старте содержит `generation_tokens_buckets=`.

## В arriero

Метрики Prometheus самого движка arriero не собирает: состояние инстанса выводится из `/health`, разбора лога и данных процесса, а прикладная статистика — из трасс запросов прокси, где число выданных токенов уже учитывается счетчиком использования (`docs/API_PROXY_FOUNDATION.md`, arriero). Так что этот аргумент нужен только при собственном Prometheus рядом с инстансом.

Если такой Prometheus есть, добавьте `--uvicorn-access-log-exclude-prefixes /metrics`: строки скрейпа иначе засоряют лог инстанса, а фильтр рутинных проб arriero (`apps/api/src/process/log-filter.ts`) рассчитан на формат llama.cpp и записи uvicorn не убирает.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-metrics --generation-tokens-buckets custom 16 32 64 128 256 512 1024 2048 4096
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-metrics --prompt-tokens-buckets custom 512 1024 2048 4096 8192 --generation-tokens-buckets custom 64 128 256 512 1024 2048
```

## Источники

- `sglang/python/sglang/srt/observability/utils.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `apps/api/src/process/log-filter.ts`
