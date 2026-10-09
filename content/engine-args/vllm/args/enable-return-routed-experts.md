---
schema: 1
engine: vllm
primaryName: "--enable-return-routed-experts"
title: "--enable-return-routed-experts"
summary: Возвращает в ответе, каких экспертов MoE роутер выбрал для каждого токена на каждом слое. Совместимый флаг-переключатель поверх `--aux-output-config`; требует Model Runner V2, MoE-модели и prefix caching, держит в хостовой RAM хранилище, рассчитанное на весь пул KV-cache, и несовместим с PP, context parallel и PD-коннекторами.
group: ModelConfig
related:
  - --aux-output-config
  - --enable-prefix-caching
  - --pipeline-parallel-size
  - --decode-context-parallel-size
  - --prefill-context-parallel-size
  - --kv-transfer-config
  - --speculative-config
  - --max-num-batched-tokens
  - --gpu-memory-utilization
---

# --enable-return-routed-experts

## Кратко

При включении vLLM вешает захват на роутеры MoE-слоёв, собирает `topk_ids` каждого токена на каждом слое, копирует их на хост и складывает в хранилище, адресованное хешами блоков prefix cache. Готовая маршрутизация возвращается клиенту полем `routed_experts` в нестриминговом ответе. Это инструмент для RL-пайплайнов и анализа роутера, а не эксплуатационная ручка.

Механизм переписан как часть подсистемы auxiliary outputs: каноническое место настройки теперь `--aux-output-config`, а этот флаг — «публичный аргумент совместимости» (комментарий в `EngineArgs`), который лишь выставляет `aux_output_config.enable_return_routed_experts = True`. Вместе с переписыванием поменялись и условия: нужен Model Runner V2 и включённый prefix caching, а из KV-коннекторов запрещены только PD-коннекторы.

## Оригинальная справка

```text
Capture and return routed-experts auxiliary outputs.
```

## Паспорт аргумента

- Флаги: `--enable-return-routed-experts`, `--no-enable-return-routed-experts`
- Группа argparse: `ModelConfig` (флаг регистрируется в группе модели, но его kwargs берутся из `AuxOutputConfig`)
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`; `--no-enable-return-routed-experts` и отсутствие флага ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: `EngineArgs.__post_init__` при `True` выставляет `aux_output_config.enable_return_routed_experts = True`. При `False` поле не трогается, поэтому `--no-enable-return-routed-experts` **не выключает** захват, включённый через `--aux-output-config`
- Где объявлен: `vllm/config/aux_output.py:AuxOutputConfig.enable_return_routed_experts`
- Этап применения: сборка `VllmConfig` (проверки совместимости, хеш компиляции) → инициализация KV-cache в Model Runner V2 (захват и хранилище) → каждый шаг forward и планировщика → формирование ответа

## Что меняет в движке

**Проверки при сборке конфига** (`VllmConfig._verify_aux_output_compatibility`). Старт падает с `ValueError`, если:

- выбран не Model Runner V2 (кроме TPU и out-of-tree платформ) — `AuxOutput Connector requires Model Runner V2; set VLLM_USE_V2_MODEL_RUNNER=1.`;
- runner не `generate` — `AuxOutput Connector only supports generate runners.`;
- модель не MoE — `AuxOutput Connector only supports MoE models.`;
- prefix caching выключен — `AuxOutput Connector requires prefix caching.`;
- в `--speculative-config` включён `enable_adaptive_verification`;
- `--pipeline-parallel-size > 1` или context parallel (`--decode-context-parallel-size`/`--prefill-context-parallel-size > 1`);
- в `--kv-transfer-config` есть `NixlConnector`, `NixlPullConnector`, `NixlPushConnector`, `MoRIIOConnector` или `MooncakeConnector` — `--enable-return-routed-experts is incompatible with <имя>; PD auxiliary output is not supported.` Коннекторы выгрузки (`OffloadingConnector`, `SimpleCPUOffloadConnector`, `LMCacheConnectorV1`, `LMCacheMPConnector`, `MooncakeStoreConnector`) допускаются.

Model Runner V2 — выбор по умолчанию, но движок откатывается на V1 при `VLLM_USE_V2_MODEL_RUNNER=0`, без Triton, для части архитектур на ROCm и при функциях, которых V2 не поддерживает (предупреждение `Model Runner V2 does not yet support ...; using the V1 model runner instead.`). Любой такой откат с этим флагом превращается в отказ старта.

**Хеш компиляции.** `AuxOutputConfig.compute_hash()` включает этот флаг: граф forward с захватом другой, и первый старт с флагом не попадёт в кэш компиляции, собранный без него.

**Worker.** После выделения KV-cache (не во время профилирования) Model Runner V2 создаёт `AuxOutputWorkerConnector`:

- `RoutedExpertsCapturer` — device-буфер `int32` формы `(max_num_batched_tokens, num_layers, num_experts_per_tok)` и колбэки захвата на роутерах MoE (`bind_routed_experts_capturer`). Монолитные MoE-ядра без поддержки routing replay и нестандартные роутеры отвергаются ошибкой.
- Только на первом TP-ранге — хранилище `BlockObjectStore`: анонимный `mmap` в хостовой RAM размером `aux_output_config.max_bytes`, по умолчанию `num_blocks × block_size × num_layers × num_experts_per_tok × размер элемента`, то есть ёмкость всего пула KV-cache в токенах. Элемент — `uint8`, если экспертов не больше 256, иначе `uint16`. Запись идёт фоновым потоком `vllm-aux-output-writer`.
- `RoutedExpertsBuffer` для незавершённых блоков: порядка `max_concurrent_batches × (max_num_batched_tokens / block_size + max_num_seqs) + max_num_seqs` блоков той же формы.

**Поток данных на шаг.** Снимок маршрутизации шага приводится к `uint8`/`uint16` на GPU и асинхронно копируется на хост. Маршрутизация отвергнутых спекулятивных токенов отбрасывается. Полные блоки публикуются в хранилище под ключами из хешей блоков prefix cache, которые присылает `AuxOutputSchedulerConnector` планировщика. При попадании в prefix cache маршрутизация закэшированной части промпта читается из хранилища, поэтому без prefix caching механизм не работает. Сброс prefix cache переводит хранилище на новое поколение ключей.

**Формат ответа.** Чанки маршрутизации копятся в `OutputProcessor` и прикладываются к `CompletionOutput` только по завершении запроса. В OpenAI-совместимых `/v1/chat/completions` и `/v1/completions` поле `routed_experts` есть только в нестриминговом ответе; token-in-token-out `/inference/v1/generate` отдаёт его и в полном ответе, и в завершающем чанке потока. Формат — base64 от `.npy`, после декодирования — форма `(num_tokens - 1, num_layers, num_experts_per_tok)`, последний сэмплированный токен ещё не прошёл forward. Декодирование: `np.load(io.BytesIO(base64.b64decode(s)))`. `null` означает либо запрос, прерванный до первого forward, либо выключенный захват на сервере.

**Обрезание промпта.** Параметр запроса `routed_experts_prompt_start` (в `SamplingParams` и в теле chat/completions) пропускает первые N токенов промпта — например, уже возвращённую часть многоходового диалога. Это параметр запроса, а не CLI.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- Эквивалентная каноническая запись: `--aux-output-config '{"enable_return_routed_experts": true}'` или `--aux-output-config.enable_return_routed_experts true`. Лимит хранилища `max_bytes` задаётся только там.
- На не-MoE модели старт падает ещё на сборке конфига.

## Когда использовать

- RL-пайплайн, которому нужна маршрутизация для расчёта наград или для routing replay при обучении; рабочий пример в апстриме — `examples/rl/routed_experts_e2e.py`.
- Исследование распределения нагрузки по экспертам на реальном трафике.
- **Не включайте на обычном инференс-инстансе.** Это хостовая RAM размером с KV-cache, D2H-копия на каждом шаге, отдельная компиляция и запрет на PP, context parallel и PD-разнесение.
- Проверьте условия до включения: Model Runner V2, prefix caching, MoE, отсутствие PD-коннектора — каждое нарушение даёт отказ старта, а не деградацию.

## Влияние на производительность и память

- **Хостовая RAM.** Главная статья: по умолчанию `ёмкость KV-cache в токенах × num_layers × top_k` байт (×2 при более чем 256 экспертах) на первом TP-ранге. Arena выделяется как анонимный `mmap`, физическая память занимается по мере заполнения хранилища, но предел растёт вместе с KV-cache — повышение `--gpu-memory-utilization` косвенно поднимает и его. Явный предел — `--aux-output-config.max_bytes`.
- **VRAM.** Device-буфер захвата: `max_num_batched_tokens × num_layers × top_k × 4` байт — единицы мегабайт на worker. Выделяется после профилирования KV-cache.
- **PCIe и CPU.** Асинхронная D2H-копия снимка на каждом шаге и фоновая запись блоков в хранилище; на крупных батчах — единицы мегабайт за шаг.
- **Время старта.** Новый хеш компиляции: первый запуск с флагом компилирует граф заново.

## Взаимодействие с другими аргументами

- `--aux-output-config`: каноническая настройка той же функции и единственное место для `max_bytes`; этот флаг лишь включает захват поверх неё.
- `--enable-prefix-caching`: обязателен, ключи хранилища — хеши блоков prefix cache.
- `--pipeline-parallel-size`: больше 1 запрещено.
- `--decode-context-parallel-size`, `--prefill-context-parallel-size`: больше 1 запрещено.
- `--kv-transfer-config`: PD-коннекторы (NIXL, MoRI-IO, Mooncake) запрещены, коннекторы выгрузки KV-cache допускаются.
- `--speculative-config`: совместим, кроме `enable_adaptive_verification`; маршрутизация отвергнутых черновых токенов отбрасывается.
- `--max-num-batched-tokens`: задаёт размер device-буфера захвата и буфера незавершённых блоков.
- `--gpu-memory-utilization`: через число KV-блоков определяет предел хостового хранилища по умолчанию.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: AuxOutput Connector requires Model Runner V2; set VLLM_USE_V2_MODEL_RUNNER=1.` **Причина:** движок выбрал V1 — проверьте окружение инстанса и предупреждение `Model Runner V2 does not yet support ...` выше в логе. **Лечение:** убрать причину отката или отказаться от флага.
- **Симптом:** `ValueError: AuxOutput Connector requires prefix caching.` **Лечение:** `--enable-prefix-caching`.
- **Симптом:** `ValueError: AuxOutput Connector only supports MoE models.` **Причина:** плотная модель. **Лечение:** снять флаг.
- **Симптом:** `ValueError: --enable-return-routed-experts is incompatible with pipeline parallelism (PP > 1).` или `... with context parallelism (DCP/PCP > 1).` **Лечение:** вернуть PP/CP в 1 или снять флаг.
- **Симптом:** `ValueError: --enable-return-routed-experts is incompatible with NixlConnector; PD auxiliary output is not supported.` **Лечение:** PD-разнесение и захват маршрутизации не совмещаются.
- **Симптом:** `ValueError: Routed-experts capture is not supported with monolithic MoE kernel ...` (или `... with router ...`, `No supported MoE router found for routed-experts capture.`). **Причина:** выбранное MoE-ядро или роутер не умеет отдавать маршрутизацию. **Лечение:** другой `--moe-backend` или отказ от флага.
- **Симптом:** ошибка `auxiliary output object does not exist; the object may have been evicted (used=..., limit=... objects). Increase aux_output_config.max_bytes when a KV cache hit requires it.` **Причина:** заданный вручную `max_bytes` меньше, чем нужно для попаданий в prefix cache. **Лечение:** увеличить `max_bytes` или вернуть значение по умолчанию.
- **Симптом:** в ответе `routed_experts: null`. **Причина:** стриминговый запрос к chat/completions, запрос прерван до первого forward или захват на сервере выключен.
- **Подтверждение принятого значения:** строка `RoutedExpertsCapturer: allocating buffer with max_tokens=..., num_layers=..., num_experts_per_tok=... (hf_config.model_type=...)` после инициализации KV-cache; в стартовой строке конфига `aux_output_config=AuxOutputConfig(enable_return_routed_experts=True, ...)`.

## Примеры

```bash
vllm serve /models/Qwen3-30B-A3B --enable-return-routed-experts --enable-prefix-caching --tensor-parallel-size 2
```

```bash
vllm serve /models/Qwen3-30B-A3B --enable-return-routed-experts --enable-prefix-caching --gpu-memory-utilization 0.7 --max-model-len 4096
```

## Источники

- `vllm/vllm/config/aux_output.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/distributed/aux_output_connector/worker.py`
- `vllm/vllm/distributed/aux_output_connector/store.py`
- `vllm/vllm/distributed/aux_output_connector/connector.py`
- `vllm/vllm/distributed/aux_output_connector/routed_experts.py`
- `vllm/vllm/model_executor/layers/fused_moe/routed_experts_capturer.py`
- `vllm/vllm/v1/worker/gpu/model_runner.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/engine/output_processor.py`
- `vllm/vllm/entrypoints/openai/chat_completion/protocol.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/entrypoints/scale_out/token_in_token_out/serving.py`
- `vllm/vllm/sampling_params.py`
- `vllm/tests/config/test_aux_output_config.py`
- `vllm/examples/rl/routed_experts_e2e.py`
- upstream-коммит `0b7f11a1e` «[AuxOutput] Add block-keyed storage for routed-expert outputs (#45635)» в checkout'е
