---
schema: 1
engine: sglang
primaryName: "--prompt-tokens-buckets"
title: "--prompt-tokens-buckets"
summary: Границы двух Prometheus-гистограмм длины промпта. Значение проверяется при старте всегда, но используется только при --enable-metrics; список по умолчанию рассчитан на диапазон до 1,1 млн токенов и на коротких промптах почти бесполезен.
group: observability
related:
  - --generation-tokens-buckets
  - --enable-metrics
  - --bucket-time-to-first-token
  - --bucket-inter-token-latency
  - --bucket-e2e-request-latency
  - --extra-metric-labels
  - --enable-metrics-for-all-schedulers
---

# --prompt-tokens-buckets

## Кратко

Правило построения границ (`buckets`) для двух гистограмм, создаваемых в `TokenizerMetricsCollector` (`sglang/python/sglang/srt/observability/metrics_collector.py`):

- `sglang:prompt_tokens_histogram` — длина промпта;
- `sglang:uncached_prompt_tokens_histogram` — та часть промпта, которую действительно пришлось считать (не попала в префиксный кеш).

Обе получают один и тот же список границ из этого аргумента. Коллектор создается только при `--enable-metrics`, но синтаксическая проверка значения (`validate_buckets_rule` в `__post_init__`) выполняется всегда — некорректное правило уронит старт даже без метрик.

## Оригинальная справка

```text
The buckets rule of prompt tokens. Supports 3 rule types: 'default' uses predefined buckets; 'tse <middle> <base> <count>' generates two sides exponential distributed buckets (e.g., 'tse 1000 2 8' generates buckets [984.0, 992.0, 996.0, 998.0, 1000.0, 1002.0, 1004.0, 1008.0, 1016.0]).); 'custom <value1> <value2> ...' uses custom bucket values (e.g., 'custom 10 50 100 500').
```

## Паспорт аргумента

- Флаги: `--prompt-tokens-buckets`
- Группа: `observability`
- Тип значения: список строк, `nargs="+"` — первый элемент задает тип правила, остальные являются его параметрами
- Допустимые значения: `choices` нет; первым элементом допустимы только `default`, `tse` и `custom` (проверяется `validate_buckets_rule`)
- Значение по умолчанию: `None`. `generate_buckets` при пустом правиле подставляет `["default"]`
- Эффективное значение: `default` разворачивается в встроенный список из 35 значений от `100` до `1 100 000` (`default_bucket_prompt_tokens` в `metrics_collector.py`); `+Inf` добавляет сам `prometheus_client`
- Где объявлен: `ServerArgs.prompt_tokens_buckets`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (валидация) → создание `TokenizerMetricsCollector` при инициализации `TokenizerManager`, если задан `--enable-metrics`

## Что меняет в движке

`generate_buckets(buckets_rule, default_buckets)` (`sglang/python/sglang/srt/observability/utils.py`) превращает правило в отсортированный список без дубликатов:

- `default` — встроенный список: `100, 300, 500, 700, 1000, 1500, 2000, 3000, …, 40000, 60000, 80000, 100000, 200000, …, 1000000, 1100000`. Он покрывает очень широкий диапазон грубыми ступенями: между 1000 и 2000 всего одна граница, между 40 000 и 100 000 — две.
- `tse <middle> <base> <count>` — «двусторонняя экспонента» вокруг центра: к `middle` прибавляются и вычитаются `base¹, base², …`, всего `ceil(count/2)` шагов в каждую сторону, отрицательные значения обрезаются нулем. `tse 1000 2 8` дает `[984, 992, 996, 998, 1000, 1002, 1004, 1008, 1016]` — плотную сетку около 1000 и ничего за ее пределами.
- `custom <v1> <v2> …` — ровно перечисленные значения; сортировка выполняется автоматически, порядок в командной строке не важен.

Границы фиксируются в момент создания коллектора и на живом сервере не меняются.

## Значения и формат

Проверки в `validate_buckets_rule` (все — `assert`, то есть падение старта с внятным сообщением, содержащим имя аргумента):

- первый элемент — один из `default`, `tse`, `custom`, иначе `Unsupported --prompt-tokens-buckets rule type`;
- `default` — ровно один элемент, лишние параметры отвергаются;
- `tse` — ровно четыре элемента; `middle` и `base` приводятся к `float`, `count` к `int`; требуется `base > 1`, `count > 0`, `middle > 0`;
- `custom` — минимум два элемента; все значения числовые, неотрицательные и **без повторов** (дубликат — ошибка, а не молча схлопнутое значение).

Формат вызова: `--prompt-tokens-buckets custom 512 1024 2048 4096`. Из-за `nargs="+"` список «съедает» все последующие токены до следующего флага — ставьте аргумент не перед позиционным значением другого аргумента.

## Когда использовать

- Реальные промпты укладываются в 512–8192 токенов, а по умолчанию первая граница — 100 и следующая 300: гистограмма получается почти бесполезной. `custom` с сеткой под свой профиль нагрузки исправляет это за одну строку.
- Нужен точный процентиль вокруг известного размера (например, фиксированный системный промпт ~1000 токенов) — `tse` дает плотную сетку вокруг него, но обратите внимание: за пределами `middle ± base^ceil(count/2)` разрешения нет вообще, все остальное попадет в первую и последнюю корзины.
- Не трогайте, если `--enable-metrics` не задан — гистограмм всё равно не будет.
- Не увлекайтесь длиной списка: каждая граница — это отдельный временной ряд на каждый набор меток.

## Влияние на производительность и память

- На VRAM, на скорость генерации и на планировщик не влияет.
- RAM и объем экспорта: число рядов в `/metrics` равно (число границ + 2) × (число комбинаций меток) × 2 гистограммы. Метки берутся из `model_name`, `engine_type`, плюс `priority` при `--enable-priority-scheduling`, плюс разрешенные пользовательские метки (`--tokenizer-metrics-allowed-custom-labels`), плюс `--extra-metric-labels`. С пользовательскими метками, значения которых приходят от клиента, произведение может расти неограниченно — см. `tokenizer-metrics-custom-labels-header.md`.
- Наблюдение значения — один `observe()` на завершенный запрос; стоимость незначима.

## Взаимодействие с другими аргументами

- `--enable-metrics`: единственное условие, при котором границы вообще применяются.
- `--generation-tokens-buckets`: тот же формат правила для гистограммы длины генерации.
- `--bucket-time-to-first-token`, `--bucket-inter-token-latency`, `--bucket-e2e-request-latency`: соседние гистограммы, но у них другой формат — простой список чисел, без правил `default`/`tse`/`custom`.
- `--extra-metric-labels`, `--tokenizer-metrics-allowed-custom-labels`: умножают число рядов на каждую границу.
- `--enable-metrics-for-all-schedulers`: относится к метрикам планировщика, на эти две гистограммы не влияет (они собираются в tokenizer-процессе).

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: Unsupported --prompt-tokens-buckets rule type: '512'` при старте. **Причина:** забыт первый элемент-правило. **Лечение:** `custom 512 …`.
- **Симптом:** `AssertionError: --prompt-tokens-buckets TSE rule requires exactly 4 parameters`. **Причина:** у `tse` пропущен или добавлен параметр.
- **Симптом:** `AssertionError: … custom rule bucket values should not contain duplicates`. **Причина:** повтор значения в списке.
- **Симптом:** правило задано, а в `/metrics` границы прежние. **Причина:** `--enable-metrics` не задан, либо смотрите не тот процесс.
- **Проверка принятого значения:** `curl -s http://127.0.0.1:30000/metrics | grep 'sglang:prompt_tokens_histogram_bucket'` покажет фактические границы; дамп `server_args=` при старте содержит `prompt_tokens_buckets=`.

## В arriero

Метрики движка в arriero не собираются и в интерфейсе не показываются: карточка инстанса строится по `/health`, разбору лога и данным процесса, а прикладная статистика — по трассам запросов прокси (`docs/API_PROXY_FOUNDATION.md`, arriero). Поэтому `--prompt-tokens-buckets` имеет смысл только если вы отдельно подключили к инстансу свой Prometheus.

Если подключили — не забудьте про access-лог: опрос `/metrics` добавит по строке на каждый скрейп, а фильтр рутинных проб arriero (`apps/api/src/process/log-filter.ts`) строки uvicorn не убирает. Лечится `--uvicorn-access-log-exclude-prefixes /metrics`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-metrics --prompt-tokens-buckets custom 256 512 1024 2048 4096 8192 16384 32768
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-metrics --prompt-tokens-buckets tse 4096 2 10
```

## Источники

- `sglang/python/sglang/srt/observability/utils.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `apps/api/src/process/log-filter.ts`
