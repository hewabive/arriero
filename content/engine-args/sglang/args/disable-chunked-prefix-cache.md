---
schema: 1
engine: sglang
primaryName: "--disable-chunked-prefix-cache"
title: "--disable-chunked-prefix-cache"
summary: Отключает поблочное дочитывание закешированного префикса в MHA-пути DeepSeek-моделей. Имеет смысл только на MLA-моделях с подходящим attention backend'ом; на всех остальных конфигурациях выставляется движком автоматически.
group: schedule
related:
  - --attention-backend
  - --prefill-attention-backend
  - --disable-radix-cache
  - --chunked-prefill-size
  - --enable-hierarchical-cache
  - --kv-cache-dtype
---

# --disable-chunked-prefix-cache

## Кратко

Chunked prefix cache — это внутренний механизм DeepSeek-подобных (MLA) моделей: при prefill с длинным закешированным префиксом внимание считается не одним куском, а несколькими проходами по частям KV-кеша с последующим слиянием через log-sum-exp. Флаг его выключает. Название легко спутать с `--chunked-prefill-size`, но это разные вещи: там — нарезка новых токенов, здесь — нарезка чтения **уже закешированного** префикса внутри одного forward'а.

## Оригинальная справка

```text
Disable chunked prefix cache feature for deepseek, which should save overhead for short sequences.
```

## Паспорт аргумента

- Флаги: `--disable-chunked-prefix-cache`
- Группа: `schedule`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует или отсутствует; парного `--no-*` нет
- Значение по умолчанию: `false` — механизм включен
- Эффективное значение: принудительно `true` на этапе загрузки модели, если модель не использует MLA-backend или выбранный attention backend отсутствует в `CHUNKED_PREFIX_CACHE_SUPPORTED_ATTENTION_BACKENDS` (`flashinfer`, `fa3`, `fa4`, `flashmla`, `cutedsl_mla`, `cutlass_mla`, `trtllm_mla`, `tokenspeed_mla`, плюс то, что регистрируют внешние платформы)
- Где объявлен: `ServerArgs.disable_chunked_prefix_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация model runner (`maybe_disable_chunked_prefix_cache`) → выбор пути внимания на каждом prefill-forward'е

## Что меняет в движке

Гейт стоит в `maybe_disable_chunked_prefix_cache` и работает только на целевой модели (draft-воркер пропускается, чтобы его не-MLA конфигурация не переключила общий флаг). Если механизм остался включенным, в лог печатается `Chunked prefix cache is turned on.`

Дальше DeepSeek-слой выбирает один из трех путей MHA по суммарной длине префикса батча:

- `sum_prefix_length` меньше порога `SGLANG_CHUNKED_PREFIX_CACHE_THRESHOLD` (8192) — используется MLA-путь с абсорбцией, префикс поблочно не читается;
- порог ≤ `sum_prefix_length` ≤ `SGLANG_MAX_KV_CHUNK_CAPACITY` (128×1024) — `MHA_ONE_SHOT`: префикс и новая часть читаются одним запросом;
- больше емкости — `MHA_CHUNKED_KV`: префикс делится на `num_prefix_chunks` кусков по `chunk_capacity // batch_size` токенов, для каждого куска считается частичное внимание, результаты сливаются `merge_state`.

С флагом два последних пути отключаются, и при непустом префиксе внимание считается MLA-путем целиком. Backend'ы читают тот же флаг напрямую: `flashinfer_mla_backend` отключает `enable_chunk_kv`, `trtllm_mla_backend` меняет ветвление при наличии префикса, prefill-CUDA-graph-runner перестает готовить индексы чанков.

## Значения и формат

- Флаг без значения; «не задан» означает включенный механизм на подходящей конфигурации.
- Обратного флага нет: если гейт выключил механизм из-за backend'а, вернуть его можно только сменой backend'а.
- Пороги настраиваются не аргументами, а переменными окружения `SGLANG_CHUNKED_PREFIX_CACHE_THRESHOLD` и `SGLANG_MAX_KV_CHUNK_CAPACITY`.

## Когда использовать

- Нагрузка из коротких запросов на DeepSeek-модели: справка прямо говорит, что отключение экономит накладные расходы на коротких последовательностях. Впрочем, порог в 8192 токена префикса уже отсекает большую часть таких случаев автоматически.
- Диагностика расхождений в качестве вывода на MLA-моделях: отключение убирает слияние частичных результатов внимания и позволяет проверить, не в нем ли дело.
- Не трогайте на не-DeepSeek-моделях: флаг там и так выставлен автоматически.
- Не используйте как способ сэкономить память: механизм не выделяет постоянных пулов, а его буферы живут в пределах forward'а.

## Влияние на производительность и память

- VRAM: с включенным механизмом на длинных префиксах выделяются временные буферы под индексы и частичные результаты по каждому чанку — они короткоживущие, но входят в пик активаций prefill'а. Отключение этот пик слегка снижает.
- RAM хоста: не влияет.
- Время старта: не влияет.
- Throughput на длинных префиксах: отключение обычно ухудшает — MLA-путь с абсорбцией на длинном префиксе дороже.
- Throughput на коротких запросах: отключение убирает ветвление и подготовку метаданных чанков, выигрыш небольшой.

## Взаимодействие с другими аргументами

- `--attention-backend` / `--prefill-attention-backend`: механизм требует backend из списка поддерживаемых; иначе он отключается сам, независимо от флага.
- `--chunked-prefill-size`: другой механизм. Оба влияют на prefill, но нарезают разные вещи; их можно и нужно настраивать независимо.
- `--disable-radix-cache` и `--enable-hierarchical-cache`: определяют, будет ли вообще закешированный префикс. Без префикс-кеша `sum_prefix_length` равен нулю, и механизм не активируется.
- `--kv-cache-dtype`: некоторые backend'ы ассертят несовместимость с отключенным chunked prefix cache в собственных путях; проверяется уже в backend'е.

## Типовые проблемы и диагностика

- Строка `Chunked prefix cache is turned on.` в логе старта — механизм активен. Ее отсутствие на DeepSeek-модели означает, что гейт его отключил (проверьте выбранный attention backend).
- `AssertionError: assert not get_schedule().disable_chunked_prefix_cache` в backend-коде (flashattention, xpu, musa) — backend требует включенного механизма для выбранного пути; уберите флаг.
- Флаг задан, а поведение не изменилось — модель не MLA либо backend не из поддерживаемых, механизм и так был выключен.
- Хочется поменять границы путей — это переменные окружения, а не CLI: `SGLANG_CHUNKED_PREFIX_CACHE_THRESHOLD`, `SGLANG_MAX_KV_CHUNK_CAPACITY`.
- Принятое значение флага — в дампе `server_args=`; фактическое (после гейта) в дампе не отражается, ориентируйтесь на строку `Chunked prefix cache is turned on.`

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --attention-backend fa3 --disable-chunked-prefix-cache
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --attention-backend flashinfer --chunked-prefill-size 8192 --disable-chunked-prefix-cache
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/misc_utils.py`
- `sglang/python/sglang/srt/model_executor/forward_batch_deepseek_mha_mixin.py`
- `sglang/python/sglang/srt/models/deepseek_common/attention_forward_methods/forward_mha.py`
- `sglang/python/sglang/srt/layers/attention/flashinfer_mla_backend.py`
- `sglang/python/sglang/srt/layers/attention/trtllm_mla_backend.py`
- `sglang/python/sglang/srt/environ.py`
