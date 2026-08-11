---
schema: 1
engine: sglang
primaryName: "--enable-prefill-cp"
title: "--enable-prefill-cp"
summary: Главный выключатель context parallelism на фазе prefill: одна длинная последовательность считается несколькими рангами сразу. Требует `--cp-strategy` и сильно перестраивает остальную конфигурацию.
group: parallel
related:
  - --cp-strategy
  - --attn-cp-size
  - --enable-cp-decode-attn-tp
  - --enable-dsa-cache-layer-split
  - --tp-size
  - --dp-size
  - --enable-dp-attention
  - --moe-a2a-backend
  - --moe-dense-tp-size
  - --ep-size
  - --disaggregation-mode
  - --enable-prefill-context-parallel
  - --prefill-only-disable-kv-cache
---

# --enable-prefill-cp

## Кратко

Context parallelism (CP) — это разрезание **одной последовательности** между рангами: каждый ранг считает внимание по своей части токенов, после чего результаты собираются. Он не заменяет тензорный параллелизм и не уменьшает объем KV — он снимает ограничение на длину prefill, которую физически способен обработать один ранг. `--enable-prefill-cp` включает механизм, `--cp-strategy` выбирает раскладку токенов, `--attn-cp-size` задает размер CP-группы. Возможность отмечена в самом коде как экспериментальная (`Context parallel feature is still under experiment. It has only been verified on Hopper platform.`) и для семейства DeepSeek принудительно перестраивает половину конфигурации.

## Оригинальная справка

```text
Enable context parallelism for the prefill phase. Select the layout with --cp-strategy.
```

## Паспорт аргумента

- Флаги: `--enable-prefill-cp`
- Группа: `parallel`
- Тип значения: bool (`store_true`)
- Допустимые значения: флаг без значения
- Значение по умолчанию: `False`
- Эффективное значение: становится `True` также при использовании устаревших `--enable-prefill-context-parallel` / `--enable-nsa-prefill-context-parallel` (`_handle_legacy_cp_arguments`). Обратная трансляция тоже есть: заданный `--enable-prefill-cp` вместе с `--cp-strategy` проставляет соответствующие legacy-поля и режим (`in-seq-split`/`round-robin-split`) для внутренних потребителей
- Где объявлен: `ServerArgs.enable_prefill_cp`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг, но экспериментальная функция — предупреждение печатается при включении
- Этап применения: `__post_init__` (`_handle_legacy_cp_arguments` → модельные override'ы в `arg_groups/overrides.py` → `_handle_context_parallelism` → `init_cp_strategy`) → выбор attention backend → forward на фазе extend

## Что меняет в движке

### Обязательная пара с `--cp-strategy`

`_handle_context_parallelism` отвергает запуск без раскладки:

```text
ValueError: --cp-strategy must be set when --enable-prefill-cp is enabled.
```

Затем `init_cp_strategy` (`sglang/python/sglang/srt/layers/cp/base.py`) создает объект стратегии — но только если `attn_cp_size > 1`. При `--enable-prefill-cp` с группой размера 1 стратегия остается `None`, и механизм фактически выключен.

### Модельные override'ы (DeepSeek и родственники)

Для семейства DeepSeek `_deepseek_family_overrides` (`sglang/python/sglang/srt/arg_groups/overrides.py`) при включенном флаге **сам** переписывает конфигурацию:

- `enable_dp_attention = True`, `moe_dense_tp_size = 1`;
- `attn_cp_size = tp_size // dp_size` — то есть размер CP-группы задается автоматически, даже если `--attn-cp-size` не указан;
- для DSA-моделей со стратегией `zigzag` дополнительно `moe_a2a_backend = deepep`, `ep_size = tp_size`; для `interleave` требуется `dp_size == 1`;
- `assert tp_size <= 8` — «Context parallel only supports single machine (tp_size <= 8). Cross-machine CP has precision issues.»;
- prefill-CUDA-graph выключается (`cuda_graph_config.prefill.backend = DISABLED`).

Для MLA-моделей DeepSeek V3/R1 действует зеркальный блок с тем же набором ограничений (`moe_dense_tp_size == 1`, `moe_a2a_backend == deepep`, `ep_size == tp_size`, `batch_size == 1`).

Отдельно, для архитектур из `CP_V2_DEFAULT_MODEL_CLASSES` (`DeepseekV3ForCausalLM`, `DeepseekV32ForCausalLM`, `GlmMoeDsaForCausalLM`, `GptOssForCausalLM`, `Qwen3MoeForCausalLM`, `MiMoV2*`) включается вторая версия реализации через переменную `SGLANG_ENABLE_CP_V2`, если оператор не задал ее сам. Для MiMo V2 под CP-v2 допустима только стратегия `zigzag`, а мультимодальная модель требует `--language-only`.

### Что происходит на forward

Стратегия применяется только к extend-шагам и только когда последовательность достаточно длинная (`can_apply`): у `zigzag` требуется не меньше `2 * cp_size` токенов в каждой последовательности, у `interleave` — не меньше `cp_size` суммарно. Короткие запросы идут обычным путем без CP.

Ключевой факт про память: после расчета внимания K/V **собираются со всех CP-рангов и целиком записываются в локальный пул каждого ранга** (`cp_allgather_and_save_kv_cache` в `sglang/python/sglang/srt/layers/utils/cp_utils.py`). Prefill-CP экономит не память, а время: он распараллеливает квадратичную по длине работу внимания. Единственное исключение — `--enable-dsa-cache-layer-split`, который действительно раскладывает слои DSA-кеша по CP-рангам.

## Значения и формат

- Булев флаг без значения; «выключено» = не указывать.
- Работает только совместно с `--cp-strategy`; без нее — отказ на старте.
- Практически требует `--attn-cp-size > 1`: иначе стратегия не создается. Для DeepSeek размер подставляется автоматически.
- Устаревшие эквиваленты (`--enable-prefill-context-parallel`, `--enable-nsa-prefill-context-parallel`) печатают предупреждение и транслируются в этот флаг; в новых конфигурациях их использовать не нужно.
- Не поддерживается на decode-воркере PD-disaggregation: `assert self.disaggregation_mode != "decode"` с текстом «CP is only supported for prefill when PD disaggregation, please remove --enable-prefill-cp.»

## Когда использовать

- Prefill очень длинных контекстов (сотни тысяч токенов), когда одна карта не успевает или не помещает промежуточные буферы внимания. Это основной и по сути единственный сценарий.
- MLA/DSA-модели DeepSeek на одном узле с 4–8 картами: под них написаны автоматические override'ы, и там путь наиболее проверен (апстрим отмечает верификацию на Hopper).
- Не включать ради throughput на обычных длинах: CP добавляет коллектив на каждый слой и отключает prefill-CUDA-graph, а короткие запросы через CP вообще не идут.
- Не сочетать с многоузловым запуском: `tp_size <= 8` в override'ах DeepSeek — прямой запрет, мотивированный точностью.
- Не рассматривать как способ уменьшить KV-пул — см. про all-gather выше.

## Влияние на производительность и память

- VRAM: сам по себе не уменьшает KV-пул, поскольку каждый ранг хранит полный K/V последовательности. Уменьшаются пиковые буферы внимания на фазе prefill: квадратичная часть делится на `attn_cp_size`.
- Время prefill: главный выигрыш. TTFT на очень длинном промпте падает примерно пропорционально размеру CP-группы, за вычетом стоимости all-gather.
- Decode: без `--enable-cp-decode-attn-tp` decode-часть остается с реплицированными attention-весами, то есть считает лишнее.
- CUDA graph: prefill-граф выключается принудительно; при `attn_cp_size > 1` также отключается breakable-граф, если конфигурация не проходит `supports_prefill_cp_bcg` (нужны `attn_cp_size == tp_size`, `zigzag` и backend `trtllm_mha`).
- Коммуникация: на каждый слой добавляется all-gather K/V и сбор выходов внимания.

## Взаимодействие с другими аргументами

- `--cp-strategy`: обязательная пара, задает раскладку (`zigzag` / `interleave`).
- `--attn-cp-size`: размер группы; для DeepSeek выставляется автоматически как `tp_size // dp_size`.
- `--enable-dp-attention` / `--moe-dense-tp-size` / `--moe-a2a-backend` / `--ep-size`: для DeepSeek переписываются автоматически (`True`, `1`, `deepep`, `tp_size`).
- `--enable-cp-decode-attn-tp`: дополняет prefill-CP на фазе decode, срезая реплицированные линейные слои внимания.
- `--enable-dsa-cache-layer-split`: единственный способ получить от CP экономию GPU-памяти под KV; требует `--cp-strategy interleave` и PD-prefill-воркер.
- `--disaggregation-mode`: `decode` несовместим.
- `--prefill-only-disable-kv-cache`: несовместим — путь prefill-CP пишет K/V в пул через `set_kv_buffer`, а no-op-пул это отвергает.
- `--tp-size`: для DeepSeek ограничен восемью при включенном CP.

## Типовые проблемы и диагностика

- `ValueError: --cp-strategy must be set when --enable-prefill-cp is enabled.` — забыт обязательный парный аргумент.
- Флаг задан, а поведение не изменилось — почти всегда `attn_cp_size == 1`: стратегия не создается. Проверьте `attn_cp_size=` в дампе `server_args=` и предупреждение `Enabled DSA context parallel: strategy=…, dp_size=…, attn_cp_size=…` / `Enable Context Parallel opt for MLA, …`.
- `AssertionError: Context parallel only supports single machine (tp_size <= 8). Cross-machine CP has precision issues.` — CP на многоузловой конфигурации DeepSeek.
- `AssertionError: interleave DSA CP does not support DP attention.` — при `--cp-strategy interleave` требуется `--dp-size 1`.
- `ValueError: MiMo V2 CP-v2 only supports --cp-strategy zigzag.` / `MiMo V2 CP-v2 only supports text inference; add --language-only.`
- KV-пул не вырос после включения CP — так и должно быть: K/V реплицируются по CP-рангам.
- Что смотреть в логе: `Context parallel feature is still under experiment. It has only been verified on Hopper platform.`, префикс ` ATTN_CP<rank>` в строках лога (появляется при `attn_cp_size > 1`), `enable_prefill_cp=` и `cp_strategy=` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag --context-length 262144
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tensor-parallel-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy interleave --attn-cp-size 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/layers/cp/zigzag.py`
- `sglang/python/sglang/srt/layers/cp/interleave.py`
- `sglang/python/sglang/srt/layers/cp/utils.py`
- `sglang/python/sglang/srt/layers/cp/bcg.py`
- `sglang/python/sglang/srt/layers/utils/cp_utils.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
