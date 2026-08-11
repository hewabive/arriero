---
schema: 1
engine: sglang
primaryName: "--dwdp-size"
title: "--dwdp-size"
summary: Включает DWDP: веса MoE-экспертов разложены по рангам, и на prefill они не гоняют токены all-to-all, а подтягивают чужие веса заранее. Обязан равняться `--tp-size` и переписывает половину конфигурации MoE.
group: parallel
related:
  - --tp-size
  - --pp-size
  - --disaggregation-mode
  - --moe-a2a-backend
  - --ep-size
  - --moe-dp-size
  - --moe-dense-tp-size
  - --enable-dp-attention
  - --enable-dp-lm-head
  - --enable-eplb
  - --speculative-algorithm
  - --enable-two-batch-overlap
  - --disable-cuda-graph
---

# --dwdp-size

## Кратко

DWDP (Distributed Weight Data Parallelism) переворачивает обычную схему MoE-параллелизма. Вместо того чтобы гонять токены к рангам-владельцам экспертов (all-to-all), каждый ранг **префетчит чужие веса экспертов** через межранговые CUDA-хендлы (FABRIC или POSIX fd) и считает все локально. Это выгодно на prefill, где токенов много и они «дороже» весов, и вредно на decode, где каждый шаг заново тянул бы все веса. Отсюда и ограничения: `dwdp_size == tp_size`, только `--disaggregation-mode null` или `prefill`, никакого спекулятивного декодирования, никакого PP. Включение переписывает `dp_size`, `ep_size`, `moe_a2a_backend`, `moe_dense_tp_size` и принудительно отключает CUDA graph.

## Оригинальная справка

```text
DWDP (Distributed Weight Data Parallelism) group size. When > 1, MoE prefill uses weight prefetch instead of token all-to-all. Must equal tp_size. Only supported with --disaggregation-mode null or prefill.
```

## Паспорт аргумента

- Флаги: `--dwdp-size`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `1` (выключено) либо ровно `tp_size` (и при этом `>= 2`)
- Значение по умолчанию: `1`
- Эффективное значение: совпадает с заданным, но **сам аргумент переписывает шесть других полей** (`_handle_dwdp`, см. ниже)
- Где объявлен: `ServerArgs.dwdp_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_dwdp`) → `ModelRunner.maybe_init_dwdp` (создание `DwdpManager`, раскладка экспертов, обмен хендлами) → префетч первых слоев при прогреве → forward MoE-слоев

## Что меняет в движке

### Каскад переопределений

`_handle_dwdp` при `dwdp_size > 1` безусловно выставляет:

```python
self.dp_size = self.dwdp_size
self.enable_dp_attention = True
self.enable_dp_attention_local_control_broadcast = True
self.enable_dp_lm_head = True
self.moe_dense_tp_size = 1
self.ep_size = self.dwdp_size
self.moe_ep_size = self.dwdp_size
self.moe_dp_size = 1
self.moe_a2a_backend = "none"
envs.SGLANG_SCHEDULER_SKIP_ALL_GATHER.set(True)
self.disable_cuda_graph = True
```

и печатает итог одной строкой `DWDP enabled: dwdp_size=…, auto-forced dp_size=…, moe_ep_size=…, moe_dense_tp_size=1, moe_a2a_backend=none, dp_attention_local_control_broadcast=True, enable_dp_lm_head=True, SCHEDULER_SKIP_ALL_GATHER=True, disable_cuda_graph=True`. Задавать эти аргументы вручную рядом с `--dwdp-size` бессмысленно — они будут переписаны.

Обратите особое внимание на `disable_cuda_graph = True`: DWDP полностью отключает захват графов, что само по себе заметно на latency.

### Раскладка и префетч

`DwdpManager` (`sglang/python/sglang/srt/layers/moe/dwdp/`) при инициализации model runner'а:

- собирает все `FusedMoE`-слои модели и требует одинакового числа маршрутизируемых экспертов во всех (`DWDP requires a uniform routed expert count across MoE layers, got …`); отсутствие MoE-слоев — `RuntimeError: DWDP is enabled but no FusedMoE layers were found in <Model>`;
- строит `DwdpExpertLayout`: `num_experts_per_worker = num_routed_experts // dwdp_size`, диапазон локальных экспертов и «peer ranges» — какие эксперты у какого соседа;
- через `DWDPTransport` экспортирует CUDA-хендлы своих весовых буферов (FABRIC либо POSIX fd) и импортирует чужие, чтобы читать соседские веса без копирования через хост;
- на прогреве вызывает `prefetch_first_layers()`, чтобы первый forward не начинался с холодного префетча.

### Предупреждение про decode

При `--disaggregation-mode null` (то есть на обычном сервере, который делает и prefill, и decode) движок печатает:

```text
DWDP with --disaggregation-mode null: decode steps re-fetch all remote expert weights every step, which is slow. DWDP is recommended only with --disaggregation-mode prefill.
```

Это ключ к пониманию, зачем аргумент вообще существует: он рассчитан на выделенный prefill-воркер дезагрегированной установки.

## Значения и формат

- Целое. `1` — выключено.
- `>= 2` и строго `== tp_size`: `AssertionError: dwdp_size (N) must equal tp_size (M)`. Промежуточных конфигураций нет.
- Число маршрутизируемых экспертов должно делиться на `dwdp_size` — иначе раскладка не построится.
- Работает только на моделях с `FusedMoE`-слоями; плотная модель даст `RuntimeError` на инициализации.

## Когда использовать

- Выделенный prefill-воркер PD-дезагрегации на большой MoE-модели, где all-to-all токенов стал узким местом. Это сценарий, под который функция написана, и единственный, который апстрим рекомендует.
- Эксперимент на обычном сервере (`--disaggregation-mode null`) — только с пониманием, что decode будет тянуть все удаленные веса на каждом шаге; предупреждение об этом печатается явно.
- Не включать вместе с EPLB: динамическая миграция экспертов противоречит статической раскладке DWDP.
- Не включать со спекулятивным декодированием, TBO или PP — все три запрещены ассертами.
- Не ожидать, что можно оставить CUDA graph: он выключается принудительно.

## Влияние на производительность и память

- Prefill: цель оптимизации. Вместо перемещения токенов между рангами перемещаются веса, причем заранее и по межранговым CUDA-хендлам.
- Decode: сильно проигрывает, если воркер вообще делает decode (см. предупреждение) — на каждом шаге веса тянутся заново.
- VRAM: добавляются буферы префетча и импортированные представления чужих весов. Размер определяется `num_prefetch_experts` и размером экспертных весов слоя; это заметная величина на больших MoE.
- Latency: растет из-за принудительного `disable_cuda_graph`.
- Коммуникация: all-to-all токенов исчезает (`moe_a2a_backend = none`), появляется трафик весов; дополнительно `SGLANG_SCHEDULER_SKIP_ALL_GATHER` снимает all-gather в планировщике.
- Время старта: добавляется обмен CUDA-хендлами по группе и префетч первых слоев на прогреве.

## Взаимодействие с другими аргументами

- `--tp-size`: обязано совпадать.
- `--disaggregation-mode`: допустимы только `null` и `prefill`; `decode` отвергается.
- `--moe-a2a-backend` / `--ep-size` / `--moe-dp-size` / `--moe-dense-tp-size` / `--dp-size` / `--enable-dp-attention` / `--enable-dp-lm-head`: переписываются автоматически.
- `--enable-eplb`: несовместим (`EPLB dynamic migration conflicts with static DWDP partitioning`).
- `--speculative-algorithm`: несовместим (`DWDP does not support speculative decoding (MTP/draft workers)`).
- `--pp-size`: обязан быть `1`.
- `--enable-two-batch-overlap`: несовместим (`DWDP's prefetch event protocol does not support two-batch overlap`).
- `--disable-cuda-graph`: включается принудительно.

## Типовые проблемы и диагностика

- `AssertionError: dwdp_size (2) must equal tp_size (4)` — размеры не совпали.
- `AssertionError: DWDP requires --disaggregation-mode null or prefill`.
- `AssertionError: EPLB dynamic migration conflicts with static DWDP partitioning`.
- `AssertionError: DWDP does not support speculative decoding (MTP/draft workers)` / `DWDP requires pp_size == 1` / `DWDP's prefetch event protocol does not support two-batch overlap`.
- `RuntimeError: DWDP is enabled but no FusedMoE layers were found in <Model>` — модель не MoE.
- `RuntimeError: DWDP requires a uniform routed expert count across MoE layers, got […]` — гетерогенная модель.
- Decode стал заметно медленнее — ожидаемо на `--disaggregation-mode null`; смотрите предупреждение `DWDP with --disaggregation-mode null: decode steps re-fetch all remote expert weights every step, which is slow.`
- Latency выросла даже на prefill — проверьте, что вы учли принудительное `disable_cuda_graph=True` из строки `DWDP enabled: …`.
- Что смотреть в логе: строку `DWDP enabled: dwdp_size=…` (в ней перечислены все переопределения) и `dwdp_size=` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dwdp-size 8 --disaggregation-mode prefill
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-235B-A22B --tensor-parallel-size 4 --dwdp-size 4 --disaggregation-mode prefill --mem-fraction-static 0.8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/dwdp/dwdp_manager.py`
- `sglang/python/sglang/srt/layers/moe/dwdp/layout.py`
- `sglang/python/sglang/srt/layers/moe/dwdp/transport.py`
- `sglang/python/sglang/srt/layers/moe/dwdp/weight_manager.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/python/sglang/srt/managers/scheduler_components/dp_attn.py`
