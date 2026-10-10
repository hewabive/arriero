---
schema: 1
engine: sglang
primaryName: "--cp-strategy"
title: "--cp-strategy"
summary: Раскладка токенов последовательности по рангам context parallelism: `zigzag` — парные блоки для баланса причинной маски, `interleave` — каждый N-й токен. Обязателен при `--enable-prefill-cp`.
group: parallel
related:
  - --enable-prefill-cp
  - --attn-cp-size
  - --enable-dsa-cache-layer-split
  - --dp-size
  - --attention-backend
  - --language-only
---

# --cp-strategy

## Кратко

`--cp-strategy` отвечает на единственный вопрос: как разрезать последовательность между рангами CP-группы. `zigzag` дает каждому рангу один «ранний» и один «поздний» блок, выравнивая нагрузку под причинную маску внимания; `interleave` раздает токены по кругу, по одному. Выбор не косметический: от него зависят допустимые backend'ы внимания, совместимость с DP-attention, доступность `--enable-dsa-cache-layer-split` и то, какие модельные override'ы применятся. Без `--enable-prefill-cp` аргумент бесполезен, а с ним — обязателен.

## Оригинальная справка

```text
Sharding strategy for prefill CP. 'zigzag' assigns each rank one early and one late sequence block; 'interleave' assigns token indices modulo the CP size.
```

## Паспорт аргумента

- Флаги: `--cp-strategy`
- Группа: `parallel`
- Тип значения: str (`Optional[str]`)
- Допустимые значения: `zigzag`, `interleave` (`choices` объявлены, argparse отвергнет остальное)
- Значение по умолчанию: `null`
- Эффективное значение: автоподбора «по модели» нет: если `--enable-prefill-cp` задан, а стратегия — нет, запуск отвергается. У DeepSeek-V4 и MiMo V2 модельная проверка срабатывает раньше общей и отвергает пустую стратегию своим текстом (`… got None` / `MiMo V2 prefill CP only supports --cp-strategy zigzag.`). Старые режимы `in-seq-split` и `round-robin-split` более не принимаются как флаги CLI.
- Где объявлен: `python/sglang/srt/arg_groups/fields/parallel.py:Parallel.cp_strategy`
- Статус: обычный; прежние раздельные режимы CP удалены
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline`: шаг `validate_prefill_cp_platform` (до проверки dummy-модели) → модельные override'ы в шаге `handle_model_specific_adjustments` → шаг `handle_context_parallelism` (`arg_groups/parallel_hook.py`: отказ без стратегии, затем `init_cp_strategy`) → forward на extend-шагах

## Что меняет в движке

### zigzag

Реализация — `ZigzagCPStrategy` (`sglang/python/sglang/srt/layers/cp/zigzag.py`). Последовательность режется на `2 * cp_size` блоков, и каждому рангу достаются два: один из начала, один с конца. Для `cp_size = 4`:

```text
cp0: block0, block7
cp1: block1, block6
cp2: block2, block5
cp3: block3, block4
```

Смысл именно в этой паре. При причинной маске ранний блок «видит» мало предшествующих токенов и считается быстро, поздний — много и считается долго; сумма у всех рангов получается примерно одинаковой. После расчета блоки собираются и переставляются обратно в исходный порядок.

`can_apply` требует, чтобы **каждая** последовательность батча имела не меньше `2 * cp_size` токенов; иначе запрос идет обычным путем.

### interleave

Реализация — `InterleaveCPStrategy` (`sglang/python/sglang/srt/layers/cp/interleave.py`): ранг `i` владеет токенами `i, i + cp_size, i + 2 * cp_size, …`. Порядок восстанавливается all-gather'ом.

```text
cp0: token0, token4, token8,  …
cp1: token1, token5, token9,  …
```

`can_apply` мягче: достаточно суммарной длины extend не меньше `cp_size`.

### Что зависит от выбора

- **Модельные override'ы DeepSeek** (`_deepseek_family_overrides`, `arg_groups/model_overrides/deepseek_v2.py`; ветка для CUDA-GPU, на NPU и XPU не применяется): под DSA-моделью `zigzag` дополнительно включает `moe_a2a_backend = deepep` и `ep_size = tp_size` («zigzag DSA CP requires moe_dense_tp_size=1, moe_a2a_backend=deepep, ep_size=tp_size, batch_size=1»), а `interleave` вместо этого требует `dp_size == 1`. Для самой DeepSeek V3.2 (`DeepseekV32ForCausalLM`) `zigzag` после этого все равно отвергается шагом `handle_context_parallelism`, так что ветка `zigzag` касается остальных DSA-архитектур этого override'а (например, `GlmMoeDsaForCausalLM`).
- **Отдельной CP-v2 больше нет**: переменная `SGLANG_ENABLE_CP_V2` числится в `_DEPRECATED_ENVS` (`environ.py`) без замены — стратегийный prefill CP теперь единственная общая реализация.
- **`--enable-dsa-cache-layer-split`** работает исключительно с `interleave`.
- **Модельные ограничения** (шаг `handle_context_parallelism`, `arg_groups/parallel_hook.py`, и `validate_deepseek_v4_cp`): MiMo V2 (`MiMoV2ForCausalLM`, `MiMoV2FlashForCausalLM`) принимает только `zigzag` и только текстовый инференс — мультимодальный чекпоинт требует `--language-only` или `--language-model-only`; DeepSeek V3.2 (`DeepseekV32ForCausalLM`), наоборот, отвергает `zigzag` и требует `interleave`; DeepSeek-V4 (`arg_groups/deepseek_v4_hook.py`) принимает обе стратегии, но `zigzag` — только на NPU (CUDA-backend переиндексирует в порядке `interleave`), вне NPU требует `dp_size == 1` и `tp_size <= 8`, а `moe_a2a_backend` — из `none`/`deepep`/`megamoe`/`mori`.
- **Breakable-CUDA-graph на prefill** возможен только при `zigzag` (плюс `attn_cp_size == tp_size` и backend `trtllm_mha`, см. `supports_prefill_cp_bcg`).
- **Backend внимания**: `CPAttentionBackendKind.from_string` принимает `fa3`, `fa4`, `flashinfer`, `dsa`, `trtllm_mha`; прочие backend'ы под CP не поддерживаются вовсе.

## Значения и формат

- Ровно одна из двух строк: `zigzag` или `interleave`. Иное значение argparse отвергнет со списком допустимых.
- Значения по умолчанию нет; без `--enable-prefill-cp` аргумент ни на что не влияет, с ним — обязателен.
- Старые имена режимов (`in-seq-split`, `round-robin-split`) в этом аргументе не принимаются. Устаревшие флаги, которые их принимали (`--prefill-cp-mode`, `--dsa-prefill-cp-mode`, `--enable-prefill-context-parallel`, `--enable-dsa-prefill-context-parallel` и их `nsa`-алиасы), удалены в v0.5.20 вместе с трансляцией в `cp_strategy`, так что стратегию задает только этот аргумент.

## Когда использовать

- `zigzag` — умолчание здравого смысла для MLA-моделей и всего, где важна равномерность нагрузки при причинной маске, и единственный вариант для MiMo V2. Он же единственный, совместимый с breakable-графом prefill. Исключения: DeepSeek V3.2 его отвергает, DeepSeek-V4 принимает только на NPU.
- `interleave` — для DeepSeek V3.2 и для DeepSeek-V4 вне NPU (там это единственный вариант); когда нужен `--enable-dsa-cache-layer-split` (экономия GPU-памяти под DSA-кеш на PD-prefill-воркере) или когда батч содержит последовательности короче `2 * cp_size` и `zigzag` для них просто не применится.
- Не менять стратегию «на пробу» между перезапусками в одной установке: за ней тянется целый набор автоматических override'ов (`ep_size`, `moe_a2a_backend`, требование `dp_size == 1`), и сравнение получится не о стратегии.
- Не задавать без `--enable-prefill-cp`: аргумент примут, но `init_cp_strategy` вернет `None`.

## Влияние на производительность и память

- Обе стратегии одинаково реплицируют K/V по CP-рангам (all-gather с записью полного K/V в локальный пул), поэтому на размер KV-пула выбор не влияет.
- `zigzag` дает более ровную загрузку рангов на причинном внимании; `interleave` проще, но его баланс зависит от ядра внимания.
- `interleave` применяется к более коротким последовательностям (порог `cp_size` против `2 * cp_size`), то есть покрывает больше запросов.
- Через `interleave` доступен `--enable-dsa-cache-layer-split` — единственный путь, где CP действительно уменьшает per-rank KV-память.
- Через `zigzag` доступен breakable-CUDA-graph на prefill (при выполнении остальных условий), что заметно на времени prefill.

## Взаимодействие с другими аргументами

- `--enable-prefill-cp`: обязательная пара в обе стороны.
- `--attn-cp-size`: определяет число блоков (`2 * cp_size` у `zigzag`) и порог применимости.
- `--dp-size`: `interleave` для DSA требует `dp_size == 1`; DeepSeek-V4 вне NPU требует `dp_size == 1` при любой стратегии.
- `--language-only` / `--language-model-only`: один из них обязателен для prefill CP у мультимодального MiMo V2.
- `--moe-a2a-backend` / `--ep-size`: под DSA-моделью с `zigzag` переписываются автоматически в `deepep` и `tp_size`.
- `--enable-dsa-cache-layer-split`: требует именно `interleave`.
- `--attention-backend`: под CP поддерживаются только `fa3`, `fa4`, `flashinfer`, `dsa`, `trtllm_mha`.
- Для выбора стратегии prefill CP используйте этот аргумент совместно с `--enable-prefill-cp`.

## Типовые проблемы и диагностика

- `argparse: argument --cp-strategy: invalid choice: 'in-seq-split' (choose from 'zigzag', 'interleave')` — использовано старое имя режима.
- `ValueError: --cp-strategy must be set when --enable-prefill-cp is enabled.` — стратегия не задана.
- `AssertionError: interleave DSA CP does not support DP attention.` — при `interleave` нужен `--dp-size 1`.
- `ValueError` при `--enable-dsa-cache-layer-split` без `--enable-prefill-cp --cp-strategy interleave` — для разделения DSA-кеша нужна стратегия `interleave`.
- `ValueError: MiMo V2 prefill CP only supports --cp-strategy zigzag.` — у MiMo V2 задан `interleave` или стратегия не задана.
- `ValueError: MiMo V2 prefill CP only supports text inference; add --language-only.` — мультимодальный MiMo V2 под prefill CP.
- `ValueError: DeepSeek V3.2 prefill CP does not support --cp-strategy zigzag; use interleave.` — обратное ограничение для DeepSeek V3.2.
- `ValueError: DeepSeekV4 zigzag CP requires the NPU backend; the CUDA backend reindexes with interleave order.` — `zigzag` для DeepSeek-V4 вне NPU; `DeepSeekV4 only supports interleave/zigzag CP strategy, got None` — стратегия для DeepSeek-V4 не задана.
- CP «не срабатывает» на коротких запросах — ожидаемо: `can_apply` отсеивает последовательности короче порога стратегии.
- Что смотреть в логе: `cp_strategy=` в дампе `server_args=`, предупреждения `zigzag DSA CP requires moe_dense_tp_size=1, moe_a2a_backend=deepep, ep_size=tp_size, batch_size=1.` и `Enabled DSA context parallel: strategy=…`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tensor-parallel-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy interleave
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/parallel.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/cp/zigzag.py`
- `sglang/python/sglang/srt/layers/cp/interleave.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/layers/cp/bcg.py`
- `sglang/python/sglang/srt/layers/cp/utils.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
- `sglang/python/sglang/srt/arg_groups/parallel_hook.py`
- `sglang/python/sglang/srt/arg_groups/model_overrides/deepseek_v2.py`
- `sglang/python/sglang/srt/arg_groups/model_hook.py`
- `sglang/python/sglang/srt/environ.py`
