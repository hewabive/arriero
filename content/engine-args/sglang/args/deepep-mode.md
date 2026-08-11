---
schema: 1
engine: sglang
primaryName: "--deepep-mode"
title: "--deepep-mode"
summary: Режим dispatch/combine для DeepEP-семейства: `normal` для prefill, `low_latency` для decode, `auto` — переключение по типу батча ценой буферов на оба режима. Значение `normal` вместе с DeepEP отключает CUDA graph.
group: exec.moe
related:
  - --moe-a2a-backend
  - --deepep-config
  - --deepep-dispatcher-output-dtype
  - --moe-runner-backend
  - --disable-cuda-graph
  - --enable-two-batch-overlap
---

# --deepep-mode

## Кратко

`--deepep-mode` выбирает, каким путем DeepEP (и совместимые с ним backend'ы) раскидывает токены по рангам: пропускным `normal` или низколатентным `low_latency` с маскированной раскладкой. `auto` создает оба диспетчера и переключает их на каждом forward по признаку «есть ли в батче prefill». Аргумент действует только при `--moe-a2a-backend` из семейства DeepEP; при `flashinfer` он игнорируется, а для `mori` и `pplx` `auto` принудительно превращается в конкретный режим.

## Оригинальная справка

```text
Select the mode when enable DeepEP or MoriEP MoE, could be `normal`, `low_latency` or `auto`. Default is `auto`, which means `low_latency` for decode batch and `normal` for prefill batch.
```

## Паспорт аргумента

- Флаги: `--deepep-mode`
- Группа: `exec.moe`
- Тип значения: перечисление
- Допустимые значения: `auto`, `normal`, `low_latency`
- Значение по умолчанию: `auto`
- Эффективное значение: переопределяется в `_handle_a2a_moe` — `mori` меняет `auto` на `normal`, `pplx` меняет `auto` на `low_latency` (и запрещает `normal`), `flashinfer_cutedsl` поверх DeepEP меняет `auto` на `low_latency` (и запрещает `normal`)
- Где объявлен: `ServerArgs.deepep_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (переопределения и отключение CUDA graph) → `initialize_moe_config` → создание диспетчера слоя и выделение буферов DeepEP → выбор реализации на каждом forward

## Что меняет в движке

Значение публикуется как `DeepEPMode` (`sglang/python/sglang/srt/layers/moe/utils.py`) и используется в трех местах.

**1. Какие диспетчеры вообще создаются.** `MaybeTboDeepEPDispatcher.__init__` создает `_low_latency_dispatcher`, если `enable_low_latency()` (то есть `low_latency` или `auto`), и `_normal_dispatcher`, если `enable_normal()` (`normal` или `auto`). При `auto` живут оба.

**2. Какие буферы выделяются.** `DeepEPBuffer.get_deepep_buffer` считает размеры: для `normal` — NVL- и RDMA-буферы по hidden size и размеру группы (с учетом `--deepep-config`), для `low_latency` — RDMA-буфер по `num_max_dispatch_tokens_per_rank`, hidden size, размеру группы и числу экспертов. При `auto` берется максимум из двух, а `num_qps_per_rank` — максимум из `num_sms` и `num_experts // group_size`. Low-latency дополнительно требует, чтобы число экспертов делилось на размер группы, а `num_max_dispatch_tokens_per_rank` (переменная `SGLANG_DEEPEP_NUM_MAX_DISPATCH_TOKENS_PER_RANK`) не превышал 1024 — это ограничение самого DeepEP.

**3. Что выбирается на каждом проходе.** `_get_impl` вызывает `self.deepep_mode.resolve(get_is_extend_in_batch())`: при `auto` батч с prefill идет в `normal`, чистый decode — в `low_latency`. Фиксированный режим возвращается как есть.

Отдельный и самый заметный побочный эффект: при `--moe-a2a-backend deepep` и `--deepep-mode normal` `_handle_a2a_moe` выключает CUDA graph и для decode, и для prefill (`Cuda graph is disabled because deepep_mode=...`).

## Значения и формат

- `auto` — рекомендованное апстримом значение для смешанного PD-режима: переключение по типу батча, CUDA graph остается включенным.
- `normal` — режим высокой пропускной способности для prefill. В связке с `deepep` отключает CUDA graph, поэтому на смешанной нагрузке это почти всегда проигрыш.
- `low_latency` — маскированная раскладка для decode, совместимая с CUDA graph. Это же единственный режим, который поддерживают `pplx` и путь `flashinfer_cutedsl` поверх DeepEP.
- Значение вне списка отвергает argparse.
- Для `--moe-a2a-backend flashinfer` аргумент бессмыслен: в лог печатается `--deepep-mode is ignored for Flashinfer MoE A2A`.

## Когда использовать

- Смешанная нагрузка на одном инстансе — `auto`.
- PD-disaggregation: prefill-инстанс запускать с `normal`, decode-инстанс — с `low_latency`; именно так это описано в руководстве SGLang для Ascend NPU и логично следует из семантики режимов.
- Фиксированный режим полезен при отладке (исключить переключение как переменную) и при экономии VRAM: один режим резервирует меньше буферов, чем `auto`.
- Не ставьте `normal` на инстанс, обслуживающий decode: потеря CUDA graph съест выигрыш.

## Влияние на производительность и память

- **VRAM.** `auto` — самый дорогой вариант: резервируются буферы под оба пути (максимум размеров) и большее число QP на ранг. Фиксированный режим экономит эту разницу.
- **Latency.** `low_latency` вместе с CUDA graph дает лучший decode; `normal` без CUDA graph заметно поднимает per-step overhead.
- **Throughput.** `normal` эффективнее на длинных prefill-батчах за счет неограниченной маскировкой раскладки.
- **SM.** Число SM под коммуникацию задается `--deepep-config`; при `normal`/`auto` и слишком малом `num_sms` (меньше половины SM устройства) в лог идет предупреждение о неоптимальной конфигурации.
- **Старт.** Буферы выделяются один раз при первом использовании диспетчера; на время загрузки модели режим влияет слабо.

## Взаимодействие с другими аргументами

- `--moe-a2a-backend`: аргумент применим к `deepep`, `mooncake`, `mori`, `nixl`, `pplx`; игнорируется при `flashinfer`; не имеет смысла при `none`.
- `--moe-runner-backend flashinfer_cutedsl`: `normal` запрещен (`ValueError` с объяснением, что у FP4-пути нет обработчика normal-dispatch), `auto` заменяется на `low_latency`.
- `--disable-cuda-graph`: `normal` + `deepep` делает то же самое неявно; если CUDA graph вам не нужен, лучше отключить его явно, чем получать это побочным эффектом.
- `--deepep-config`: тюнинг размеров буферов и числа SM для normal-пути.
- `--deepep-dispatcher-output-dtype`: формат данных на проводе; у части quant-конфигураций различается для normal и low_latency, и диспетчер выбирает его по текущему режиму.
- `--chunked-prefill-size`, `--max-prefill-tokens`: определяют, сколько токенов уезжает за один dispatch; у `mori` и `pplx` для этого есть отдельные проверки лимитов.
- `--enable-two-batch-overlap`: работает поверх того же диспетчера; при TBO предупреждение о числе SM подавляется.

## Типовые проблемы и диагностика

- `flashinfer_cutedsl FP4 MoE only supports DeepEP low_latency dispatch (masked layout)` — снимите `--deepep-mode normal`.
- `moe_a2a_backend='pplx' only supports low-latency mode; set --deepep-mode to 'low_latency' or 'auto'.` — то же для pplx.
- `auto set deepep_mode=...` в логе — режим переопределен backend'ом (`mori` → `normal`, `pplx` → `low_latency`).
- Внезапно пропал CUDA graph, decode стал медленнее — проверьте пару `deepep` + `normal`, предупреждение об этом печатается на старте.
- Ассерт про делимость числа экспертов на размер группы или про `num_max_dispatch_tokens_per_rank <= 1024` — ограничения low-latency пути DeepEP; правится числом рангов или переменной окружения.
- Итоговое значение — в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --moe-a2a-backend deepep --deepep-mode auto --tp-size 8 --ep-size 8
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --moe-a2a-backend deepep --deepep-mode low_latency --tp-size 8 --ep-size 8 --moe-runner-backend deep_gemm
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/layers/moe/token_dispatcher/deepep.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
