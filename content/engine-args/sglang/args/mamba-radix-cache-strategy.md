---
schema: 1
engine: sglang
primaryName: "--mamba-radix-cache-strategy"
title: "--mamba-radix-cache-strategy"
summary: Стратегия хранения рекуррентных состояний для префиксного кеша гибридных моделей. `no_buffer` экономит память, но принудительно выключает overlap-планировщик и требует `--page-size 1`; `extra_buffer` сохраняет overlap ценой дополнительных слотов на запрос.
group: exec.mamba
related:
  - --max-mamba-cache-size
  - --mamba-full-memory-ratio
  - --mamba-track-interval
  - --disable-radix-cache
  - --disable-overlap-schedule
  - --page-size
  - --attention-backend
  - --linear-attn-backend
  - --enable-linear-replayssm
  - --disaggregation-mode
  - --speculative-algorithm
  - --speculative-num-draft-tokens
---

# --mamba-radix-cache-strategy

## Кратко

Гибридная модель не может «дописать» рекуррентное состояние так же дешево, как KV: чтобы сохранить состояние в префиксный кеш и одновременно продолжать декодировать, его надо либо скопировать, либо иметь под него второй слот. Отсюда две стратегии. `no_buffer` не дублирует состояния и потому требует `--page-size 1` и работы без overlap-планировщика. `extra_buffer` держит ping-pong-слоты, сохраняет overlap и страничный режим, но увеличивает число слотов на один запрос с 3 до 5. Значение `auto` выбирает между ними по остальным флагам и по тому, поддерживает ли архитектура дополнительный буфер.

## Оригинальная справка

```text
The strategy to use for mamba radix cache.
```

## Паспорт аргумента

- Флаги: `--mamba-radix-cache-strategy`
- Группа: `exec.mamba`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `auto`, `no_buffer`, `extra_buffer`, `extra_buffer_lazy` (список задан прямо в объявлении поля в `arg_groups/fields/exec_.py`)
- Значение по умолчанию: `auto`
- Эффективное значение: разрешается пассом `_mamba_radix_cache_resolution` (`arg_groups/overrides.py`) — см. ниже. Раньше него model overrides ставят `extra_buffer` вместо оставленного `auto`: архитектура Inkling (`model_overrides/inkling.py`) всегда, NemotronH (`model_overrides/nemotron_h.py`) — на SM100 при заданном `--speculative-algorithm`, `--speculative-eagle-topk` 1 или не задан и незаданных attention-флагах (вместе с `trtllm_mha`)
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecMamba.mamba_radix_cache_strategy`; поле помечено `resolvable=True`
- Статус: обычный
- Этап применения: `ServerArgs.resolve_once` → шаг резолва `handle_model_specific_adjustments` → `handle_mamba_radix_cache` (`python/sglang/srt/arg_groups/model_hook.py`: запуск пасса `_mamba_radix_cache_resolution` и валидация) → построение пулов и префиксного кеша

## Что меняет в движке

### Резолюция `auto`

Пасс срабатывает только для гибридных архитектур: список `_MAMBA_RADIX_CACHE_ARCHS` (`KimiLinearForCausalLM`, `KimiK3ForConditionalGeneration`, `Qwen3NextForCausalLM`, `Qwen3_5*`, `Qwen4ExpForConditionalGeneration`, `BailingMoeV2_5ForCausalLM`, `BailingMoeV3*`, `NemotronH*`, `FalconH1ForCausalLM`, `JetNemotronForCausalLM`, `JetVLMForConditionalGeneration`, `Lfm2*`, `InternS2*`, `MiniCPMV4_6ForConditionalGeneration`, `ZayaForCausalLM`, `Glm5NextForConditionalGeneration`) плюс архитектуры, зарегистрированные через `register_linear_attn_model` с `uses_mamba_radix_cache=True`, плюс `GraniteMoeHybridForCausalLM` с mamba-слоями. При `--disable-radix-cache` пасс возвращает пустой результат, и значение вообще не используется.

Для этих архитектур при `auto`:

```python
wants_overlap = not disable_overlap_schedule
wants_paging  = page_size is not None and page_size > 1
if (wants_overlap or wants_paging) and supports_mamba_cache_extra_buffer(view, arch):
    strategy = "extra_buffer"
else:
    strategy = "no_buffer"
    disable_overlap_schedule = True    # принудительно
```

`supports_mamba_cache_extra_buffer` истинна только для архитектур из `_MAMBA_EXTRA_BUFFER_ARCHS` (или спецификаций реестра с `support_mamba_cache_extra_buffer`) **и** только при `--linear-attn-backend triton`; на XPU она всегда ложна, так что там `auto` дает `no_buffer`, а явный `extra_buffer` падает на проверке архитектуры. Практическое следствие, которое легко пропустить: смена базового linear-attn backend'а на `cutedsl` или `flashinfer` не просто меняет ядра — она выбивает архитектуру из числа поддерживающих `extra_buffer`, и `auto` уходит в `no_buffer`, попутно выключая overlap-планировщик.

### Что проверяется у каждой стратегии

`no_buffer` (`validate_mamba_no_buffer` в `arg_groups/mamba_hook.py`):

- `--page-size` только `1`;
- overlap-планировщик обязан быть выключен;
- `--attention-backend trtllm_mha` запрещен.

`extra_buffer` (`validate_mamba_extra_buffer` в `arg_groups/mamba_hook.py`):

- архитектура должна поддерживать режим, иначе `extra_buffer is not supported for <arch>; use no_buffer.`;
- платформа CUDA, MUSA, NPU, ROCm или XPU (XPU на деле отсекается предыдущей проверкой);
- при спекуляции `--mamba-track-interval` должен быть не меньше `--speculative-num-draft-tokens`;
- `--mamba-track-interval` должен делиться на `--page-size` нацело;
- если `--chunked-prefill-size` меньше внутреннего `mamba_cache_chunk_size` (функция в `arg_groups/overrides.py`), печатается warning о пропуске чекпоинтов состояния на границе незавершенного chunked prefill.

`extra_buffer_lazy` — тот же `extra_buffer` с отложенным выделением слотов, плюс два запрета: PD-disaggregation (`extra_buffer_lazy unsupported under PD disaggregation; use --mamba-radix-cache-strategy extra_buffer.`) и работа без overlap-планировщика (ассерт `Lazy extra buffer requires overlap schedule (--disable-overlap-schedule is incompatible)` при расчете пула в `_calculate_mamba_ratio`). Спекуляция EAGLE, NGRAM, DSPARK и DFLASH с ним совместима: все они верифицируют через `prepare_mamba_track_for_verify`.

Явный `extra_buffer` или `extra_buffer_lazy` на архитектуре без mamba-состояния (при включенном radix cache) отвергается в `handle_mamba_radix_cache`: `--mamba-radix-cache-strategy <значение> needs mamba state, got <arch>.`

### Сколько слотов на запрос

Стратегия входит в множитель `ratio` в `_calculate_mamba_ratio`: база 3, плюс 2 для `extra_buffer` с overlap-планировщиком, плюс 1 для `extra_buffer_lazy` (только с overlap), плюс 1 для `extra_buffer` без overlap; при `--disable-radix-cache` ratio равен 1. С переменной окружения `SGLANG_OPT_MAMBA_SKIP_DECODE_LOCK=1` база уменьшается до 2, но `no_buffer` получает компенсирующую единицу и остается на 3. Именно на этот множитель делится `--max-mamba-cache-size`, чтобы получить потолок конкурентности.

## Значения и формат

- Одно из четырех значений; всё остальное отвергает argparse.
- `auto` — не «универсальный компромисс», а именно выбор одного из двух режимов; в дампе `server_args=` вы увидите уже разрешенное значение.
- `extra_buffer_lazy` задается только явно: `auto` его никогда не выбирает.
- На не-гибридной модели `auto` и `no_buffer` принимаются и не используются, а `extra_buffer`/`extra_buffer_lazy` при включенном radix cache останавливают старт (`… needs mamba state, got <arch>.`).

## Когда использовать

- Задавать `extra_buffer` явно, когда важен overlap-планировщик и страничный KV (`--page-size` больше 1), а архитектура его поддерживает: так вы не потеряете режим случайно из-за смены соседнего флага.
- Задавать `no_buffer`, когда пул состояний — самое узкое место и вы готовы обменять overlap на 40 % лишних слотов (3 вместо 5 на запрос). Не забудьте про `--page-size 1`.
- Не выбирать `no_buffer` вместе с `--attention-backend trtllm_mha` — комбинация запрещена ассертом.
- Не оставлять `auto`, если вы одновременно меняете `--linear-attn-backend`: результат резолюции при этом меняется неочевидным образом.
- `--enable-linear-replayssm` требует именно `no_buffer` — при `extra_buffer` старт отвергается.

## Влияние на производительность и память

- VRAM: `extra_buffer` не выделяет отдельного пула, но повышает число слотов на запрос с 3 до 5, то есть при фиксированном `--max-mamba-cache-size` конкурентность падает примерно на 40 %.
- RAM хоста: не влияет.
- Время старта: не меняет.
- Throughput: `no_buffer` принудительно выключает overlap-планировщик, а это потеря совмещения подготовки следующего батча с текущим forward — на конкурентной нагрузке эффект больше, чем выигрыш от лишних слотов.
- Кеш префиксов: работает в обеих стратегиях; различается только механика сохранения снимка (копирование против донорства ping-pong-слота).

## Взаимодействие с другими аргументами

- `--disable-overlap-schedule`: вход резолюции `auto`, жесткое следствие `no_buffer` и запрет для `extra_buffer_lazy`.
- `--page-size`: `no_buffer` требует `1`; значение больше `1` толкает `auto` к `extra_buffer`.
- `--linear-attn-backend`: только `triton` разрешает `extra_buffer`.
- `--attention-backend trtllm_mha`: несовместим с `no_buffer`.
- `--max-mamba-cache-size` / `--mamba-full-memory-ratio`: размер пула, который делится на `ratio` этой стратегии.
- `--mamba-track-interval`: при `extra_buffer` обязан делиться на `--page-size` и быть не меньше `--speculative-num-draft-tokens`.
- `--enable-linear-replayssm`: требует `no_buffer`.
- `--disaggregation-mode`: запрещает `extra_buffer_lazy`.
- `--speculative-algorithm`: у NemotronH на SM100 при незаданных attention-флагах превращает `auto` в `extra_buffer`.
- `--disable-radix-cache`: делает аргумент неприменимым.

## Типовые проблемы и диагностика

- `AssertionError: no_buffer only supports page_size=1.` — задан `--page-size` больше 1 при `no_buffer` (в том числе после того, как backend внимания сам поднял размер страницы).
- `AssertionError: no_buffer do not support overlap schedule. Try to set disable_overlap_schedule=True.` — стратегия задана явно, а overlap не выключен.
- `AssertionError: extra_buffer is not supported for <arch>; use no_buffer.` — архитектура вне списка либо базовый linear-attn backend не `triton`.
- `AssertionError: extra_buffer_lazy unsupported under PD disaggregation; use --mamba-radix-cache-strategy extra_buffer.`
- `AssertionError: Lazy extra buffer requires overlap schedule (--disable-overlap-schedule is incompatible)` — `extra_buffer_lazy` вместе с `--disable-overlap-schedule`.
- `ValueError: --mamba-radix-cache-strategy extra_buffer needs mamba state, got <arch>.` — стратегия с буфером задана для модели без mamba-слоев.
- `ValueError: --enable-linear-replayssm requires --mamba-radix-cache-strategy no_buffer (the default) …`
- Overlap-планировщик неожиданно выключен, хотя вы его не выключали — сработала ветка `no_buffer` в резолюции `auto`. Проверьте в дампе `server_args=` поля `mamba_radix_cache_strategy` и `disable_overlap_schedule`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --mamba-radix-cache-strategy extra_buffer
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --mamba-radix-cache-strategy no_buffer --page-size 1 --disable-overlap-schedule
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/model_hook.py`
- `sglang/python/sglang/srt/arg_groups/mamba_hook.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/components/mamba.py`
- `sglang/python/sglang/srt/arg_groups/model_override_base.py`
- `sglang/python/sglang/srt/arg_groups/model_overrides/inkling.py`
- `sglang/python/sglang/srt/arg_groups/model_overrides/nemotron_h.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/configs/linear_attn_model_registry.py`
