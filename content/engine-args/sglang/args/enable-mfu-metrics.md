---
schema: 1
engine: sglang
primaryName: "--enable-mfu-metrics"
title: "--enable-mfu-metrics"
summary: Добавляет три счетчика оценочных FLOPs и байтов на GPU и дописывает в строки `Prefill batch` / `Decode batch` расчетные TFLOPS/s и полосу памяти. Числа аналитические, а не измеренные, и требуют `--enable-metrics`.
group: observability
related:
  - --enable-metrics
  - --decode-log-interval
  - --tp-size
  - --quantization
  - --kt-num-gpu-experts
  - --kt-cpuinfer
  - --speculative-algorithm
---

# --enable-mfu-metrics

## Кратко

Флаг включает аналитическую оценку «сколько работы сделал GPU» — FLOPs, прочитанные и записанные байты — по конфигурации модели, и публикует ее двумя путями: счетчиками `sglang:estimated_flops_per_gpu_total`, `sglang:estimated_read_bytes_per_gpu_total`, `sglang:estimated_write_bytes_per_gpu_total` в Prometheus и суффиксом в строках лога `Prefill batch, …` / `Decode batch, …`. Ничего не измеряется приборами: все числа выводятся из `hidden_size`, числа слоев, голов и `intermediate_size` по формулам плотного трансформера. На MoE-модели и на квантизованных весах — а это ровно профиль KTransformers — оценка систематически расходится с реальностью, и относиться к ней надо как к относительному индикатору, а не как к MFU.

## Оригинальная справка

```text
Enable estimated MFU-related prometheus metrics.
```

## Паспорт аргумента

- Флаги: `--enable-mfu-metrics`
- Группа: `observability`
- Тип значения: bool, `action="store_true"` — значения не принимает
- Допустимые значения: `choices` нет; парной формы `--no-*` не существует
- Значение по умолчанию: `False`
- Эффективное значение: заданное значение читается **внутри** ветки `if self.enable_metrics` в `SchedulerMetricsReporter._init_metrics`, поэтому без `--enable-metrics` эффективное значение всегда `False` независимо от флага
- Где объявлен: `ServerArgs.enable_mfu_metrics`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `SchedulerMetricsReporter` (расчет констант по `model_config`) → каждая итерация prefill/decode

## Что меняет в движке

### Константы, считаемые один раз

`_init_estimated_perf_constants()` (`sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`) собирает из `model_config` набор коэффициентов «на токен»: FLOPs линейных слоев, коэффициент при attention-скалярном произведении, байты записи KV-кеша, байты чтения весов, байты движения активаций QKV и FFN. Входы — `hidden_size`, `num_attention_layers`, `head_dim`, `get_num_attention_heads(tp_size)`, `get_num_kv_heads(tp_size)`, `intermediate_size` (или `ffn_hidden_size`) и `model_config.dtype.itemsize`. Деление на TP выполняется через число голов, поэтому величины уже «на один GPU».

Чего в формуле нет и это важно:

- **никакого члена для MoE** — берется плотный `intermediate_size` из `hf_text_config`, число экспертов и число активных экспертов на токен не учитываются;
- **никакого учета квантизации** — `w_bytes` равен размеру элемента рабочего dtype (`itemsize`), то есть 2 байта для bf16, даже если веса лежат в fp8 или int4;
- **никакого учета оффлоада** — экспертов, посчитанных на CPU через kt-kernel, оценка припишет GPU.

### Что считается на каждой итерации

`_estimate_prefill_perf(batch)` берет `sum(batch.extend_lens)` токенов и добавляет к линейной части квадратичный член `tokens * (tokens + 1) / 2` для causal-attention. `_estimate_decode_perf(batch, decode_tokens)` берет число декодируемых токенов и суммарную длину контекста батча; чтение KV-кеша считается как `total_context * kv_cache_bytes_per_token`.

Результат уходит в `increment_estimated_perf(...)` (три счетчика) и накапливается в локальных `_mfu_log_flops` / `_mfu_log_read_bytes` / `_mfu_log_write_bytes`, которые обнуляются при каждом периодическом логе.

### Что появляется в логе

В строке `Decode batch, …` дописывается:

```text
, est. decode TFLOPS/s (per GPU): 12.34, est. read BW (GB/s per GPU): 456.78, est. write BW (GB/s per GPU): 1.23
```

Накопленные величины делятся на `gap_latency` — время между двумя периодическими логами, то есть на `--decode-log-interval` итераций.

В строке `Prefill batch, …` дописывается `, est. prefill TFLOPS/s (per GPU): …`. Здесь есть оговорка, зафиксированная прямо в коде: FLOPs одного prefill-батча делятся на интервал **между строками лога**, который на асинхронном цикле scheduler'а не совпадает с длительностью самого forward. То есть prefill-число — это темп по окну лога, а не пропускная способность конкретного прогона.

## Значения и формат

- Флаг без значения; `--enable-mfu-metrics true` argparse не примет.
- Специальных значений нет, отключить после старта нельзя.
- Единицы в логе: TFLOPS/s и GB/s (десятичные, деление на `1e12` и `1e9`), на **один** GPU.
- Единицы в Prometheus: сырые FLOPs и байты как монотонные счетчики — в дашборде их надо брать через `rate()`.
- Само значение MFU (доля от пикового FLOPS железа) движок не считает: он не знает пикового числа для вашей карты. Делить на паспортный пик придется в дашборде.

## Когда использовать

- Когда нужен относительный индикатор: «после изменения `--chunked-prefill-size` расчетная полоса чтения выросла в полтора раза». Формула не меняется между запусками, поэтому сравнение конфигураций с одной и той же моделью корректно, даже если абсолютные числа смещены.
- Когда надо отличить compute-bound decode от memory-bound: соотношение `est. read BW` к паспортной полосе HBM карты — самая быстрая проверка.
- Не использовать как MFU на MoE-модели: плотный `intermediate_size` даст завышенные FLOPs на каждый токен, потому что реально считается только доля экспертов.
- Не использовать для приемки KTransformers-профиля: часть экспертов считает CPU (`--kt-cpuinfer`, `--kt-num-gpu-experts`), а оценка целиком приписана GPU. Для этого профиля надежнее меряется `gen throughput (token/s)` в той же строке лога — она основана на реальном числе токенов и реальном времени.
- Не включать при спекулятивном декодировании ради точных цифр: в decode-оценку идет `batch_size + num_correct_drafts`, отвергнутые draft-токены в FLOPs не входят, хотя железо на них поработало.

## Влияние на производительность и память

- VRAM: не затрагивает.
- RAM хоста: три дополнительных счетчика в Prometheus — доли килобайта.
- Latency и throughput: на каждой decode-итерации выполняется около десятка операций с float и один инкремент трех счетчиков. Плюс на каждой prefill-итерации — `sum(batch.extend_lens)`. Это ниже уровня шума на фоне forward.
- Время старта: `_init_estimated_perf_constants()` — несколько десятков арифметических операций один раз.

## Взаимодействие с другими аргументами

- `--enable-metrics`: жесткая зависимость. `self.enable_mfu_metrics` присваивается только внутри `if self.enable_metrics:`, так что в одиночку флаг не делает ничего — ни метрик, ни суффикса в логе.
- `--decode-log-interval`: определяет и окно усреднения для чисел в логе, и частоту их появления. При очень маленьком интервале числа станут шумными, при большом — сгладятся.
- `--tp-size`: входит в расчет через `get_num_attention_heads(tp_size)` / `get_num_kv_heads(tp_size)`, поэтому величины даны «на один GPU» и при росте TP уменьшаются.
- `--quantization`: не учитывается. Оценка чтения весов будет завышена во столько раз, во сколько квантизованные веса меньше bf16.
- `--kt-num-gpu-experts` / `--kt-cpuinfer`: разделение экспертов между GPU и CPU оценке неизвестно.
- `--speculative-algorithm`: draft-модель в константы не входит; в decode-оценку попадают только принятые токены.

## Типовые проблемы и диагностика

- Флаг задан, но в логе нет суффикса `est. decode TFLOPS/s` — не задан `--enable-metrics`. Проверьте `enable_metrics=True, enable_mfu_metrics=True` в дампе `server_args=` при старте.
- Числа появляются, но выглядят абсурдно большими на MoE-модели — это ожидаемо, см. выше про плотный `intermediate_size`.
- `est. prefill TFLOPS/s` скачет на порядки от строки к строке — знаменатель здесь интервал между логами, а не время forward; на редких prefill-батчах интервал большой, и значение падает. Для устойчивой картины смотрите decode-строку.
- Суффикс исчез, хотя нагрузка есть — он печатается только при `gap_latency > 0`; на первой строке после старта или после паузы это может быть не так.
- В `/metrics` счетчики есть, но не растут — метрики пишет только ранг `attn_tp_rank == 0`, если не задан `--enable-metrics-for-all-schedulers`.
- **В arriero:** ни расчетные метрики, ни суффиксы лога менеджером не разбираются — парсер лога SGLang (`apps/api/src/process/log-parsers/sglang.ts`) извлекает готовность, путь модели, `max_total_num_tokens` и предупреждения, но не строки производительности. Суффиксы попадут в фильтрованный лог инстанса как есть.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-metrics --enable-mfu-metrics
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-metrics --enable-mfu-metrics --decode-log-interval 100
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/observability/metrics_collector.py`
- `sglang/docs/docs/references/production_metrics.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
