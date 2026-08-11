---
schema: 1
engine: sglang
primaryName: "--chunked-prefill-size"
title: "--chunked-prefill-size"
summary: Потолок числа prefill-токенов в одном forward. Определяет пик активаций, а через него — автоматически подобранный `--mem-fraction-static`; значение `-1` отключает chunked prefill целиком.
group: schedule
related:
  - --mem-fraction-static
  - --max-prefill-tokens
  - --max-total-tokens
  - --page-size
  - --enable-mixed-chunk
  - --enable-dynamic-chunking
  - --enable-dp-attention
  - --dp-size
  - --enable-pdmux
  - --prefill-only-disable-kv-cache
  - --enable-mis
---

# --chunked-prefill-size

## Кратко

`--chunked-prefill-size` режет длинный prompt на куски: запрос, чей непокрытый префикс длиннее значения, обрабатывается за несколько forward'ов, а планировщик между кусками успевает обслужить decode. Значение задает и пик активаций одного forward'а, и — при незаданном `--mem-fraction-static` — размер резерва под этот пик. Значение по умолчанию `null` не означает «отключено»: движок подставит 2048…16384 по объему GPU. `-1` действительно отключает chunked prefill.

## Оригинальная справка

```text
The maximum number of tokens in a chunk for the chunked prefill. Setting this to -1 means disabling chunked prefill.
```

## Паспорт аргумента

- Флаги: `--chunked-prefill-size`
- Группа: `schedule`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: `-1` (отключить) либо положительное число, кратное `--page-size`. Любое значение `<= 0` трактуется планировщиком как «выключено»
- Значение по умолчанию: `null`
- Эффективное значение: подбирается в `_handle_gpu_memory_settings` по емкости GPU — `<20 ГиБ` → 2048, `<35` → 2048, `<60` → 4096, `<90` → 8192, `<160` → 8192, иначе 16384; при неизвестной емкости — 4096. Затем делится на `--dp-size` при `--enable-dp-attention` и принудительно ставится в `-1` при `--enable-mis` и для HRM-Text (`prefix_lm`)
- Где объявлен: `ServerArgs.chunked_prefill_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (подбор и проверки) → `Scheduler.init_chunked_prefill` → каждый вызов `get_new_batch_prefill`

## Что меняет в движке

Значение попадает в `Scheduler.chunked_prefill_size`; там же `<= 0` превращается в `None`, и `None` отдельно ставится для мультимодальных моделей на Transformers-backend'е (с предупреждением в логе). Дальше оно уходит в `PrefillAdder` как `rem_chunk_tokens` — бюджет prefill-токенов на текущий batch:

- если непокрытая часть запроса помещается в остаток бюджета, запрос уходит в batch целиком;
- иначе он усекается до `trunc_len = chunk_tokens_limit // page_size * page_size`, становится `chunked_req` и продолжится в следующих проходах;
- `rem_chunk_tokens` уменьшается на каждый добавленный запрос, поэтому значение — это потолок **суммы** prefill-токенов batch'а, а не на один запрос.

`rem_chunk_tokens is None` (chunked prefill выключен) меняет логику admission: первый запрос в batch принимается всегда, независимо от длины, а последующие ограничиваются только `--max-prefill-tokens`. Один запрос длиной в весь контекст пойдет одним forward'ом — это и есть источник OOM на длинных промптах при `-1`.

Три дополнительных потребителя значения:

- `_handle_gpu_memory_settings`: `activation_tokens = max(chunked_prefill_size, 2048)`, резерв под активации `activation_tokens * 1.5` МиБ; для не-MLA моделей `chunked_prefill_size` становится еще и `cuda_graph_config.prefill.max_bs`;
- backend'ы all-to-all для MoE: `--moe-a2a-backend mori`/`pplx` проверяют, что `chunked_prefill_size` не превышает лимит диспетчера (`SGLANG_MORI_NUM_MAX_DISPATCH_TOKENS_PER_RANK`, `SGLANG_PPLX_NUM_MAX_DISPATCH_TOKENS_PER_RANK`);
- KTransformers: значение уходит в `KTConfig.chunked_prefill_size` → `KTMoEWrapper` → `MOEConfig.max_len` и напрямую задает размер CPU-буферов MoE-оператора (`gate_up_ba_`, `gate_bc_`, `up_bc_`, `down_ba_`, `down_bc_` в `ktransformers/kt-kernel/operators/amx/moe_base.hpp` выделяются на `max_len` строк каждый, на каждый MoE-слой). Для профиля SGLang-KT это не абстрактный «пик активаций», а конкретная линейная статья расхода RAM хоста.

## Значения и формат

- Целое число токенов; суффиксы SI/IEC здесь **не** поддерживаются (в отличие от `--max-prefill-tokens` и `--max-total-tokens`).
- Должно делиться на `--page-size`: `assert chunked_prefill_size % page_size == 0` при `chunked_prefill_size > 0` и `--disaggregation-mode` не `decode`. При `--page-size 64` допустимы 2048/4096/8192, но не 5000.
- `-1` (и любое `<= 0`) отключает chunked prefill. Это требование для `--prefill-only-disable-kv-cache` и для `--enable-pdmux`; `--enable-mis` выставляет `-1` сам, с предупреждением.
- При `--enable-dp-attention` значение делится на `--dp-size` (в лог пишется `DP attention is enabled. chunked prefill size is adjusted from X to Y`) — задавайте суммарное значение, а не значение на rank.
- Смысла в значениях меньше `--page-size` нет: `trunc_len` округляется вниз до страницы и обнуляется.

## Когда использовать

- Уменьшать до 4096/2048, когда OOM приходит на prefill длинных промптов: пик активаций падает пропорционально.
- Увеличивать до 16384 и выше на больших картах, когда рабочая нагрузка — длинные промпты и важен TTFT: меньше кусков, меньше накладных расходов на переоткрытие batch'а.
- Ставить `-1` только там, где это требование другой подсистемы (`--prefill-only-disable-kv-cache`, `--enable-pdmux`) или где промпты заведомо короткие и хочется убрать накладные расходы на нарезку.
- В профиле SGLang-KT держать значение умеренным (2048–8192): каждый MoE-слой держит host-буферы на `max_len` токенов, и рост значения умножается на число слоев.
- Не пытаться поднять `chunked_prefill_size` при уже заданном `--mem-fraction-static`: связь «больше chunk → больше резерв» работает только в автоподборе, вручную придется одновременно снижать `--mem-fraction-static`.

## Влияние на производительность и память

- VRAM: активации prefill растут примерно линейно (эвристика движка — 1.5 МиБ на токен); при не-MLA моделях от того же значения зависит и размер prefill CUDA graph.
- RAM хоста: в обычном режиме не влияет; в KT-профиле задает буферы CPU-MoE на каждый слой.
- Время старта: не влияет напрямую; при `--enable-dynamic-chunking` от него зависит диапазон профилировочных прогонов.
- TTFT: меньший chunk → больше forward'ов на один длинный промпт → выше TTFT для этого запроса, но ниже задержка для уже идущих decode.
- Throughput: слишком маленький chunk (например, 512) заметно снижает утилизацию GPU на prefill-нагрузке; слишком большой — «замораживает» decode на время куска.

## Взаимодействие с другими аргументами

- `--mem-fraction-static`: вход автоподбора. Пара «chunk ↑, fraction ↓» и «chunk ↓, fraction ↑» — типовой обмен между активациями и KV-пулом.
- `--max-prefill-tokens`: второй, независимый бюджет того же batch'а. Реальный потолок prefill-batch'а — минимум из двух; по умолчанию `max_prefill_tokens` = 16384 больше, чем chunk на большинстве карт, поэтому связывает именно chunk.
- `--page-size`: делимость проверяется ассертом, и усечение куска выравнивается по странице.
- `--enable-mixed-chunk`: разрешает подмешивать decode-токены в тот же batch; число running-запросов вычитается из `rem_chunk_tokens` до admission.
- `--enable-dynamic-chunking`: при `--pp-size > 1` заменяет постоянный размер куска предсказанным, используя текущее значение как цель по времени forward'а.
- `--enable-dp-attention` / `--dp-size`: делят значение на число DP-групп.
- `--max-total-tokens`: ограничивает сверху `cuda_graph_config.prefill.max_bs`, который иначе равен `chunked_prefill_size`.
- `--enable-pdmux`, `--prefill-only-disable-kv-cache`: требуют ровно `-1`.
- `--enable-mis`: сам переводит в `-1` и пишет `Chunked prefill is disabled because --enable-mis is set.`

## Типовые проблемы и диагностика

- `AssertionError: chunked_prefill_size must be divisible by page_size` — выберите значение, кратное `--page-size`.
- `AssertionError: PD-Multiplexing is not compatible with chunked prefill.` — при `--enable-pdmux` требуется `-1`.
- OOM на prefill при формально нормальном `token usage` — пик активаций. Уменьшайте значение вдвое до устранения.
- Резко выросший TTFT после снижения значения — ожидаемая цена; смотрите строки `Prefill batch, …` в логе: число кусков на запрос равно `ceil(len(prompt)/chunk)`.
- Предупреждение `Chunked prefill is disabled for multimodal models with the Transformers backend` — значение принято, но обнулено планировщиком.
- Итоговое эффективное значение печатается дважды: в дампе `server_args=` и в сводке `max_total_num_tokens=…, chunked_prefill_size=…, max_prefill_tokens=…` при готовности scheduler'а. Именно вторая строка показывает значение после деления на `--dp-size`.
- В KT-профиле подозрение на переполнение host-буферов проверяется сопоставлением `chunked_prefill_size` с измеренной RAM дерева процессов (панель деталей инстанса arriero) — рост значения должен давать пропорциональный рост.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --chunked-prefill-size 4096 --page-size 64
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --chunked-prefill-size 2048 --mem-fraction-static 0.88 --max-prefill-tokens 8192
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- `ktransformers/kt-kernel/python/utils/amx.py`
- `ktransformers/kt-kernel/operators/amx/moe_base.hpp`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
