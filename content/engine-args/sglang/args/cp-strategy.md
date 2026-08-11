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
  - --prefill-cp-mode
  - --nsa-prefill-cp-mode
  - --dsa-prefill-cp-mode
---

# --cp-strategy

## Кратко

`--cp-strategy` отвечает на единственный вопрос: как разрезать последовательность между рангами CP-группы. `zigzag` дает каждому рангу один «ранний» и один «поздний» блок, выравнивая нагрузку под причинную маску внимания; `interleave` раздает токены по кругу, по одному. Выбор не косметический: от него зависят допустимые backend'ы внимания, совместимость с DP-attention, доступность `--enable-dsa-cache-layer-split` и то, какие модельные override'ы применятся. Без `--enable-prefill-cp` аргумент бесполезен, а с ним — обязателен.

## Оригинальная справка

```text
Sharding strategy for prefill CP. 'zigzag' is the former in-seq-split mode; 'interleave' is the former round-robin-split mode.
```

## Паспорт аргумента

- Флаги: `--cp-strategy`
- Группа: `parallel`
- Тип значения: str (`Optional[str]`)
- Допустимые значения: `zigzag`, `interleave` (`choices` объявлены, argparse отвергнет остальное)
- Значение по умолчанию: `null`
- Эффективное значение: при использовании устаревших флагов `_handle_legacy_cp_arguments` подставляет значение из старого режима: `in-seq-split` → `zigzag`, `round-robin-split` → `interleave`. Обратно — заданная стратегия проставляет legacy-поля `prefill_cp_mode` / `dsa_prefill_cp_mode` для внутренних потребителей. Автоподбора «по модели» нет: если `--enable-prefill-cp` задан, а стратегия — нет, запуск отвергается
- Где объявлен: `ServerArgs.cp_strategy`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; заменяет устаревшие `--prefill-cp-mode`, `--nsa-prefill-cp-mode`, `--dsa-prefill-cp-mode`
- Этап применения: `__post_init__` (`_handle_legacy_cp_arguments` → модельные override'ы → `_handle_context_parallelism` → `init_cp_strategy`) → forward на extend-шагах

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

- **Модельные override'ы DeepSeek** (`_deepseek_family_overrides`): под DSA-моделью `zigzag` дополнительно включает `moe_a2a_backend = deepep` и `ep_size = tp_size` («zigzag DSA CP requires moe_dense_tp_size=1, moe_a2a_backend=deepep, ep_size=tp_size, batch_size=1»), а `interleave` вместо этого требует `dp_size == 1`.
- **CP-v2 по умолчанию**: для DSA-моделей из `CP_V2_DEFAULT_MODEL_CLASSES` вторая версия реализации включается только при `interleave`; для остальных архитектур из списка — всегда.
- **`--enable-dsa-cache-layer-split`** работает исключительно с `interleave`.
- **MiMo V2 под CP-v2** принимает только `zigzag`, а **DeepSeek-V4** — наоборот, только `interleave` (`validate_deepseek_v4_cp` в `arg_groups/deepseek_v4_hook.py`: `DeepSeekV4 only supports interleave CP strategy, got …`), там же требуются `dp_size == 1`, `tp_size <= 8` и `moe_a2a_backend` из `none`/`deepep`/`megamoe`.
- **Breakable-CUDA-graph на prefill** возможен только при `zigzag` (плюс `attn_cp_size == tp_size` и backend `trtllm_mha`, см. `supports_prefill_cp_bcg`).
- **Backend внимания**: `CPAttentionBackendKind.from_string` принимает `fa3`, `fa4`, `flashinfer`, `dsa`, `trtllm_mha`; прочие backend'ы под CP не поддерживаются вовсе.

## Значения и формат

- Ровно одна из двух строк: `zigzag` или `interleave`. Иное значение argparse отвергнет со списком допустимых.
- Значения по умолчанию нет; без `--enable-prefill-cp` аргумент ни на что не влияет, с ним — обязателен.
- Старые имена режимов (`in-seq-split`, `round-robin-split`) в этом аргументе не принимаются: они остались только у устаревших флагов и транслируются автоматически.

## Когда использовать

- `zigzag` — умолчание здравого смысла для MLA-моделей и всего, где важна равномерность нагрузки при причинной маске. Он же единственный, совместимый с breakable-графом prefill.
- `interleave` — когда нужен `--enable-dsa-cache-layer-split` (экономия GPU-памяти под DSA-кеш на PD-prefill-воркере) или когда батч содержит последовательности короче `2 * cp_size` и `zigzag` для них просто не применится.
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
- `--dp-size`: `interleave` для DSA требует `dp_size == 1`.
- `--moe-a2a-backend` / `--ep-size`: под DSA-моделью с `zigzag` переписываются автоматически в `deepep` и `tp_size`.
- `--enable-dsa-cache-layer-split`: требует именно `interleave`.
- `--attention-backend`: под CP поддерживаются только `fa3`, `fa4`, `flashinfer`, `dsa`, `trtllm_mha`.
- `--prefill-cp-mode` / `--nsa-prefill-cp-mode` / `--dsa-prefill-cp-mode`: устаревшие предшественники; используйте этот аргумент.

## Типовые проблемы и диагностика

- `argparse: argument --cp-strategy: invalid choice: 'in-seq-split' (choose from 'zigzag', 'interleave')` — использовано старое имя режима.
- `ValueError: --cp-strategy must be set when --enable-prefill-cp is enabled.` — стратегия не задана.
- `AssertionError: interleave DSA CP does not support DP attention.` — при `interleave` нужен `--dp-size 1`.
- `ValueError: --enable-dsa-cache-layer-split requires --enable-prefill-cp and --cp-strategy interleave (or legacy --enable-nsa-prefill-context-parallel with --nsa-prefill-cp-mode round-robin-split).`
- `ValueError: MiMo V2 CP-v2 only supports --cp-strategy zigzag.`
- `ValueError: DeepSeekV4 only supports interleave CP strategy, got zigzag` — обратное ограничение для DeepSeek-V4.
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

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/cp/zigzag.py`
- `sglang/python/sglang/srt/layers/cp/interleave.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/layers/cp/bcg.py`
- `sglang/python/sglang/srt/layers/cp/utils.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
