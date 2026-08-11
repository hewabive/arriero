---
schema: 1
engine: sglang
primaryName: "--dcp-size"
title: "--dcp-size"
summary: Размер группы context parallelism на фазе decode: токены одной последовательности раскладываются по рангам подгруппы, что снимает потолок длины на один ранг. Отключает захват CUDA graph на prefill.
group: parallel
related:
  - --dcp-comm-backend
  - --dcp-replicate-q-proj
  - --tp-size
  - --page-size
  - --attn-cp-size
  - --enable-prefill-cp
  - --mem-fraction-static
  - --context-length
  - --speculative-algorithm
---

# --dcp-size

## Кратко

DCP (decode context parallelism) — это второй, независимый механизм разрезания последовательности. Если `--enable-prefill-cp` ускоряет prefill, то `--dcp-size` меняет раскладку KV **на фазе decode**: внутри каждой TP-группы образуется подгруппа из `dcp_size` рангов, между которыми делятся токены последовательности, а головы KV, наоборот, реплицируются. За счет этого группа адресует в `dcp_size` раз больше токенов при том же объеме памяти на ранг, а каждый шаг decode заканчивается редукцией частичных выходов внимания по LSE — способ редукции выбирает `--dcp-comm-backend`.

## Оригинальная справка

```text
The decode context parallelism size.
```

## Паспорт аргумента

- Флаги: `--dcp-size`, `--decode-context-parallel-size`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `choices` нет; проверка `dcp_size >= 1` в `_handle_dcp_validation`. Практически должен делить `tp_size` — группы нарезаются срезами по `dcp_size` внутри каждой TP-группы
- Значение по умолчанию: `1`
- Эффективное значение: совпадает с заданным. Runtime-величина `attn_dcp_size` равна `dcp_size` только когда DCP-группа действительно создана (`dcp_size > 1`), иначе `1`. Для DeepSeek-V4/Kimi-K3 включение DCP тянет за собой автоматический выбор backend'ов внимания и `--dcp-comm-backend` (см. `arg_groups/overrides.py`)
- Где объявлен: `ServerArgs.dcp_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `_handle_dcp_validation` → `_handle_cuda_graph_config` (отключение prefill-графа) → `initialize_model_parallel` (создание группы `dcp`) → расчет KV-пула → forward на decode

## Что меняет в движке

### Группы

`initialize_model_parallel` (`sglang/python/sglang/srt/distributed/parallel_state.py`) создает группу `dcp` только при `dcp_size > 1`, нарезая каждую TP-группу на последовательные срезы длиной `dcp_size`. На ранге 0 TP-группы печатается

```text
DCP enabled, dcp_size=<n>, tp_size=<m>
```

### KV-пул

Две правки в расчете памяти:

- число KV-голов на ранг считается как `get_num_kv_heads(attn_tp_size, attn_dcp_size)`, то есть делитель равен `attn_tp_size // dcp_size`. Комментарий в `configs/model_config.py` формулирует это прямо: «DCP ranks replicate KV, so heads shard across `tp // dcp` groups» — головы реплицируются по DCP-рангам, а не делятся;
- аллокатор становится страничным с «широкими» страницами: `PagedTokenToKVPoolAllocator(max_total_num_tokens * attn_dcp_size, page_size=page_size * attn_dcp_size, …)` (`mem_cache/kv_cache_configurator.py`). Логическое пространство токенов в `dcp_size` раз больше физического, потому что каждая широкая страница раскладывается по `dcp_size` рангам.

Итог: память на ранг остается прежней, но одна последовательность может занимать в `dcp_size` раз больше токенов, чем помещалось бы на одном ранге. Побочный эффект — при `page_size > 1` обычный `TokenToKVPoolAllocator` не используется вовсе, даже при `--page-size 1`.

Для draft-воркера спекулятивного декодирования сделано исключение: его пулы реплицированы, а не шардированы, поэтому `loc_space_scale` масштабирует его размеры, чтобы он мог адресовать то же виртуальное пространство (`kv_cache_configurator.py`).

### Decode-путь

На MLA-моделях после расчета внимания частичные выходы и LSE сводятся по DCP-группе (`models/deepseek_common/attention_forward_methods/forward_mla.py`): либо `cp_lse_ag_out_rs_mla` (all-gather + reduce-scatter), либо `dcp_a2a_lse_reduce` (all-to-all) — выбор за `--dcp-comm-backend`.

### CUDA graph

`dcp_size > 1` входит в список несовместимостей для **prefill**-графа (и обычного, и breakable): «Capture builds a dummy extend forward with `attn_dcp_metadata=None`». Decode-граф при этом сохраняется.

## Значения и формат

- Целое ≥ 1; `1` — «DCP выключен», а не «авто».
- `dcp_size < 1` → `ValueError: Decode context parallel size (--dcp-size / --decode-context-parallel-size) must be >= 1, but got dcp_size=…`
- Должен делить `tp_size`: группы формируются срезами `tp_group[start : start + dcp_size]`, и остаток даст неполную группу.
- Для backend'ов `a2a`/`fi_a2a` дополнительно требуется, чтобы число голов внимания делилось на `dcp_size` (`assert H % N == 0` в `layers/dcp/comm.py`).
- Величина не связана с `--attn-cp-size`: это разные группы и разные фазы.

## Когда использовать

- Длинный контекст на decode, когда KV одной последовательности не помещается в бюджет одного ранга. Это основной сценарий: DCP поднимает адресуемую длину пропорционально размеру группы.
- MLA-модели (DeepSeek V3/V4, Kimi) — путь, для которого написана редукция по LSE и модельные override'ы.
- Не включать ради throughput на обычных длинах: добавляется коллектив на каждый слой decode и теряется prefill-CUDA-graph.
- Не путать с `--attn-cp-size`: тот работает на prefill и не уменьшает KV; этот меняет раскладку KV на decode.
- Не рассчитывать на суммарную экономию VRAM: память на ранг не уменьшается, увеличивается адресуемая длина.

## Влияние на производительность и память

- VRAM на ранг: практически не меняется. Растет число KV-голов на ранг, но во столько же раз падает число токенов, которые ранг хранит для одной последовательности.
- Адресуемая длина: растет в `dcp_size` раз — это и есть цель.
- Latency decode: растет на стоимость редукции по DCP-группе на каждом слое. `--dcp-comm-backend a2a` дешевле `ag_rs`, а `--dcp-replicate-q-proj` убирает еще один коллектив.
- Prefill: замедляется из-за отключенного prefill-CUDA-graph.
- Страничность: страница становится `page_size * dcp_size` логических токенов, то есть внутренняя фрагментация пула растет; учитывайте это при выборе `--page-size`.

## Взаимодействие с другими аргументами

- `--dcp-comm-backend`: способ редукции; значения `a2a`/`fi_a2a` требуют `dcp_size > 1`.
- `--dcp-replicate-q-proj`: работает только при `dcp_size > 1` и backend'ах `a2a`/`fi_a2a`.
- `--tp-size`: делимое; DCP-группы нарезаются внутри TP-группы.
- `--page-size`: умножается на `dcp_size` в аллокаторе.
- `--attn-cp-size` / `--enable-prefill-cp`: другой механизм и другая фаза; сочетание допустимо, но конфигурацию нужно проверять отдельно.
- `--mem-fraction-static`: при `dcp_size != 1` отключается ветка `post_capture_kv_sizing_planned`, то есть KV-пул считается обычным путем, до захвата графов.
- `--speculative-algorithm`: draft-воркер получает реплицированные пулы с масштабированным адресным пространством.

## Типовые проблемы и диагностика

- `ValueError: Decode context parallel size (--dcp-size / --decode-context-parallel-size) must be >= 1, but got dcp_size=0.`
- `ValueError: --dcp-comm-backend a2a only affects the decode context-parallel attention reduction and therefore requires --dcp-size / --decode-context-parallel-size > 1, but got dcp_size=1.`
- `AssertionError: num_heads (…) must be divisible by dcp_size (…)` — число голов не делится на размер группы при `a2a`/`fi_a2a`.
- Prefill стал заметно медленнее — ожидаемо: prefill-граф отключен при `dcp_size > 1`.
- `max_total_num_tokens` в логе выглядит «слишком большим» — это логическое пространство, умноженное на `dcp_size`; физическая память на ранг не выросла.
- Что смотреть в логе: `DCP enabled, dcp_size=…, tp_size=…`, `dcp_size=` в дампе `server_args=`, строку `KV Cache is allocated. …` и итоговую сводку `max_total_num_tokens=…`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --decode-context-parallel-size 2 --context-length 131072
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --decode-context-parallel-size 4 --dcp-comm-backend a2a --dcp-replicate-q-proj
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/layers/dcp/comm.py`
- `sglang/python/sglang/srt/models/deepseek_common/attention_forward_methods/forward_mla.py`
- `sglang/python/sglang/srt/runtime_context.py`
