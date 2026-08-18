---
schema: 1
engine: sglang
primaryName: "--moe-a2a-backend"
title: "--moe-a2a-backend"
summary: Выбирает библиотеку all-to-all для раскидывания токенов по экспертным рангам. Любое значение, кроме `none`, принудительно приравнивает `--ep-size` к `--tp-size` и тянет за собой набор жестких требований к остальным флагам.
group: exec.moe
related:
  - --moe-runner-backend
  - --deepep-mode
  - --ep-size
  - --enable-dp-attention
  - --deepep-config
  - --enable-waterfill
  - --speculative-moe-a2a-backend
---

# --moe-a2a-backend

## Кратко

`--moe-a2a-backend` определяет, как токены попадают к своим экспертам при экспертном параллелизме: через обычные коллективы (`none`) или через специализированную библиотеку dispatch/combine (DeepEP и производные). Это самый «заражающий» аргумент группы: он переписывает `--ep-size`, требует конкретных раннеров и режимов, а на одной карте вообще не имеет смысла. Значение по умолчанию `none` — единственный вариант, поддерживающий гибрид EP+TP с `ep_size < tp_size`.

## Оригинальная справка

```text
Choose the backend for MoE A2A.
```

## Паспорт аргумента

- Флаги: `--moe-a2a-backend`
- Группа: `exec.moe`
- Тип значения: перечисление
- Допустимые значения: `none`, `deepep`, `mooncake`, `nixl`, `mori`, `ascend_fuseep`, `flashinfer`, `megamoe`, `pplx`, `ascend_tp` (константа `MOE_A2A_BACKEND_CHOICES`). `ascend_tp` принимается argparse, но `_handle_a2a_moe` немедленно заменяет его на `none` — в коде это помечено как обход падения точности
- Значение по умолчанию: `none`
- Эффективное значение: переопределяется `_a2a_backend_overrides` (Waterfill ⇒ `deepep`; переменная `SGLANG_OPT_USE_DEEPGEMM_MEGA_MOE` ⇒ `megamoe`), `_handle_dwdp` (DWDP ⇒ `none`) и правилом NPU (`none` на NPU и `ascend_tp` ⇒ `none`)
- Где объявлен: `ServerArgs.moe_a2a_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_a2a_moe`) → `initialize_moe_config` → создание диспетчера каждого MoE-слоя

## Что меняет в движке

Значение публикуется как `MoeA2ABackend` и читается через `get_moe_a2a_backend()`. Диспетчер слоя выбирается в `create_moe_dispatcher` (`sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`):

- `none`, `megamoe`, `ascend_fuseep` → `StandardDispatcher` (на NPU при `none` — `AscendTPDispatcher`). Токены не переезжают между рангами: каждый ранг считает свою часть и результаты сводятся All-Reduce/All-Gather;
- `deepep`, `mooncake`, `mori`, `nixl`, `pplx` → `MaybeTboDeepEPDispatcher` с режимом из `--deepep-mode`;
- `flashinfer` → `FlashinferDispatcher`.

Параллельно `_handle_a2a_moe` навешивает правила:

- **`--ep-size` перетирается.** `_a2a_ep_size`: для `megamoe`, `deepep`, `mooncake`, `nixl`, `ascend_fuseep`, `flashinfer`, `mori`, `pplx` выставляется `ep_size = tp_size` с информационной строкой в логе. Гибрид `ep_size < tp_size` возможен только при `none`.
- **`flashinfer`**: требует `--enable-dp-attention` и `dp_size == tp_size`; `--deepep-mode` игнорируется (об этом пишется предупреждение); раннер обязан быть `flashinfer_cutlass`, `flashinfer_cutedsl` или `flashinfer_trtllm_routed`; при NVFP4-весах включается `SGLANG_MOE_NVFP4_DISPATCH`.
- **`mori`**: `--deepep-mode auto` превращается в `normal`; при включенном chunked prefill проверяется, что `SGLANG_MORI_NUM_MAX_DISPATCH_TOKENS_PER_RANK` покрывает `--chunked-prefill-size`.
- **`pplx`**: режим `normal` запрещен, `auto` превращается в `low_latency`; требуется `--enable-dp-attention` и `--dp-size >= 2`; раннер — `deep_gemm` (`auto` в него и разрешается); проверяется `SGLANG_PPLX_NUM_MAX_DISPATCH_TOKENS_PER_RANK`.
- **`deepep`**: при `--deepep-mode normal` CUDA graph отключается (и для decode, и для prefill) с предупреждением в логе.
- **`megamoe`**: включается `SGLANG_OPT_FIX_MEGA_MOE_MEMORY`, если она не задана явно.

Значение влияет и на балансировку экспертов: `_handle_eplb_and_dispatch` считает `needs_rank_invariant_dispatch = (moe_a2a_backend == "none")` и в этом случае запрещает `--ep-dispatch-algorithm static` и `lp` — без a2a все ранги считают одни и те же токены и обязаны выбрать одну и ту же реплику эксперта.

## Значения и формат

- `none` — коллективы вместо a2a. Единственный вариант для одной GPU, для гибридного EP+TP и для конфигураций без установленного DeepEP.
- `deepep` — базовый вариант для крупных EP-развертываний; требует установленного пакета DeepEP, иначе диспетчер бросает `ImportError` с ссылкой на репозиторий.
- `mooncake`, `nixl` — расширения для elastic EP (RDMA, отказоустойчивость, динамическое масштабирование).
- `mori` — путь AMD/ROCm, только `normal`-режим.
- `flashinfer` — связка с FlashInfer-раннерами и DP-attention.
- `pplx` — NVSHMEM-ядра Perplexity, только low-latency, только Hopper и FP8/DeepGEMM.
- `ascend_fuseep`, `ascend_tp` — NPU-специфика; `ascend_tp` де-факто отключен.
- `megamoe` — Mega-MoE-путь DeepSeek-моделей на ядрах DeepGEMM без пересылки токенов (`StandardDispatcher`); автоконфигурируется переменной `SGLANG_OPT_USE_DEEPGEMM_MEGA_MOE`.

## Когда использовать

- Одна GPU или `--tp-size 1`: только `none`. Все остальные значения имеют смысл лишь при нескольких экспертных рангах.
- Крупная MoE-модель на 8+ картах с DP-attention: `deepep` — базовая точка отсчета, дальше по железу (`mori` на ROCm, `pplx`/`flashinfer` на подходящих связках раннер+квантизация).
- Нужен гибрид EP и TP (`ep_size < tp_size`): оставляйте `none`, иначе значение будет перетерто.
- Не задавайте a2a-backend «на пробу» вместе с фиксированным `--ep-size`: значение все равно станет равным `--tp-size`, и конфигурация будет не той, что вы написали.

## Влияние на производительность и память

- **VRAM.** DeepEP-семейство выделяет коммуникационные буферы: `get_deepep_buffer` считает `num_nvl_bytes`/`num_rdma_bytes` по hidden size, размеру группы и режиму. Это отдельная от KV-кеша статья расхода, и при `--deepep-mode auto` резервируются буферы **обоих** режимов (максимум из двух), то есть auto дороже по памяти, чем фиксированный режим.
- **SM.** DeepEP занимает часть SM под коммуникацию (`--deepep-config`, поле `num_sms`); при слишком малом числе SM в лог печатается предупреждение о заведомо неоптимальной производительности.
- **CUDA graph.** `deepep` + `--deepep-mode normal` отключает CUDA graph целиком — это заметный удар по latency на decode.
- **Throughput.** Основной выигрыш a2a виден на больших EP-группах: токен уезжает ровно к своему рангу вместо All-Reduce по всей группе.
- На хостовую RAM влияние косвенное (буферы регистрации RDMA), в arriero это не учитывается автоматически.

## Взаимодействие с другими аргументами

- `--ep-size`: перетирается на `tp_size` для всех значений, кроме `none`.
- `--deepep-mode`: применяется к `deepep`, `mooncake`, `mori`, `nixl`, `pplx`; игнорируется при `flashinfer`.
- `--moe-runner-backend`: взаимные ограничения (`flashinfer` ⇒ FlashInfer-раннеры; `pplx` ⇒ `deep_gemm`; `flashinfer_cutedsl` ⇒ a2a только `none`/`deepep`/`flashinfer`).
- `--enable-dp-attention`, `--dp-size`: обязательны для `flashinfer` (равенство с `tp_size`) и `pplx` (минимум 2 группы).
- `--enable-waterfill`: принудительно переводит a2a на `deepep`, если стоит что-то кроме `deepep`/`megamoe`.
- `--ep-dispatch-algorithm`: при `none` допустимы только ранг-инвариантные алгоритмы.
- `--speculative-moe-a2a-backend`: отдельное значение для draft-модели; если не задано, наследует основное.
- `--chunked-prefill-size`: участвует в проверках лимитов диспетчера у `mori` и `pplx`.

## Типовые проблемы и диагностика

- `DeepEP is not installed. Please install DeepEP package …` — значение выбрано, пакет отсутствует.
- `Flashinfer MoE A2A is only supported with dp_size == tp_size and --enable-dp-attention` — не хватает DP-attention.
- `moe_a2a_backend='pplx' requires --enable-dp-attention with at least 2 DP groups` / `only supports low-latency mode` — нарушены ограничения pplx.
- `SGLANG_MORI_NUM_MAX_DISPATCH_TOKENS_PER_RANK (default 4096) must be >= …` — окно диспетчера меньше `--chunked-prefill-size`.
- В логе `deepep MoE is enabled. The expert parallel size is adjusted from N to the tensor parallel size [M].` — подтверждение перетирания `--ep-size`.
- Предупреждение `Cuda graph is disabled because deepep_mode=...` — комбинация `deepep` + `normal`, которую почти никогда не хотят на decode.
- Итоговое значение после всех переопределений — в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --moe-a2a-backend deepep --moe-runner-backend deep_gemm --tp-size 8 --ep-size 8 --deepep-mode auto
```

```bash
python -m sglang.launch_server --model-path /models/qwen3-moe --moe-a2a-backend none --ep-size 2 --tp-size 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
- `sglang/python/sglang/srt/layers/moe/token_dispatcher/deepep.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
