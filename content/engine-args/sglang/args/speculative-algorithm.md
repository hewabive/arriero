---
schema: 1
engine: sglang
primaryName: "--speculative-algorithm"
title: "--speculative-algorithm"
summary: Включает спекулятивное декодирование и выбирает алгоритм (EAGLE, EAGLE3, NEXTN, STANDALONE, NGRAM, DFLASH, DSPARK и зарегистрированные плагины). Один этот флаг переписывает `--max-running-requests`, гасит `--enable-mixed-chunk`, уменьшает KV-пул и определяет, какие из остальных `--speculative-*` вообще что-то значат.
group: spec
related:
  - --speculative-draft-model-path
  - --speculative-num-steps
  - --speculative-eagle-topk
  - --speculative-num-draft-tokens
  - --speculative-token-map
  - --speculative-attention-mode
  - --speculative-draft-attention-backend
  - --speculative-adaptive
  - --speculative-dflash-block-size
  - --speculative-dspark-block-size
  - --speculative-ngram-max-bfs-breadth
  - --enable-multi-layer-eagle
  - --max-running-requests
  - --enable-mixed-chunk
  - --mem-fraction-static
  - --page-size
  - --pp-size
  - --lora-paths
---

# --speculative-algorithm

## Кратко

Это единственный выключатель спекулятивного декодирования: пока он не задан, все остальные `--speculative-*` лежат в `ServerArgs` мёртвым грузом. Механика одна на все алгоритмы: дешёвый **draft** предлагает несколько следующих токенов, целевая модель проверяет их **одним** forward'ом (`target_verify`), принятый префикс коммитится, отвергнутый хвост выбрасывается вместе с потраченным на него временем. Выигрыш есть, только если средняя длина принятого куска окупает и работу draft'а, и расширенный verify-батч; при плохом accept rate или при большом running batch спекуляция стабильно медленнее обычного декодирования. Значение выбирается один раз на старте и потом не меняется.

## Оригинальная справка

```text
Speculative algorithm. Builtins: EAGLE, EAGLE3, NEXTN, STANDALONE, NGRAM, DFLASH, DSPARK. Or any name registered via `SpeculativeAlgorithm.register`.
```

## Паспорт аргумента

- Флаги: `--speculative-algorithm`
- Группа: `spec`
- Тип значения: строка (`Optional[str]`)
- Допустимые значения: `choices: null` — argparse не ограничивает список. Реальный набор собирается в runtime: члены enum `SpeculativeAlgorithm` (`DFLASH`, `DSPARK`, `EAGLE`, `EAGLE3`, `FROZEN_KV_MTP`, `STANDALONE`, `NGRAM`) плюс зарезервированный алиас `NEXTN` плюс всё, что плагины добавили через `SpeculativeAlgorithm.register`. Посмотреть на своей сборке: `python -c "from sglang.srt.speculative.spec_info import SpeculativeAlgorithm as S; print([a.name for a in S])"` и `python -c "from sglang.srt.speculative import spec_registry; print(list(spec_registry._REGISTRY))"`
- Значение по умолчанию: `null` — спекуляция выключена
- Эффективное значение: строка приводится к верхнему регистру (`eagle3` = `EAGLE3`); `NEXTN` всегда превращается в `EAGLE`; `NEXTN`/`EAGLE` с draft-архитектурой `Gemma4AssistantForCausalLM` / `Gemma4UnifiedAssistantForCausalLM` повышаются до `FROZEN_KV_MTP` (в логе `promoting --speculative-algorithm ... to FROZEN_KV_MTP`)
- Где объявлен: `ServerArgs.speculative_algorithm`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `handle_speculative_decoding` (`arg_groups/speculative_hook.py`) → per-algorithm хук `_handle_*` → выделение KV-пула (draft делит бюджет с target) → запуск draft-воркера и захват его CUDA graph → forward

## Что меняет в движке

### Разрешение имени и диспетчеризация

`handle_speculative_decoding` вызывается из `__post_init__` после разбора CLI и до `_handle_load_format`. Порядок такой:

1. если задан `--speculative-draft-model-path`, а `--speculative-draft-model-revision` пуст — ревизия становится `"main"`;
2. имя приводится к upper case;
3. `_resolve_speculative_algorithm_alias` **читает конфиг draft-модели** (`get_config`, то есть скачивание с HF, если путь — repo id), чтобы поймать Gemma4-архитектуру; `EAGLE3` + Gemma4-draft — ошибка;
4. `SpeculativeAlgorithm.from_string` даёт объект алгоритма; неизвестное имя — `ValueError: Unknown speculative algorithm name: <x>`;
5. проверяется `--speculative-draft-window-size` (положительность, предупреждение для всех алгоритмов кроме `EAGLE3` и `DFLASH`);
6. если включён `--speculative-adaptive`, он либо отключается с причиной, либо инициализирует лестницу шагов;
7. `algo.handle_server_args(server_args)` — один из `_handle_dflash` / `_handle_dspark` / `_handle_frozen_kv_mtp` / `_handle_eagle_family` / `_handle_ngram`.

Плагин, зарегистрированный через `SpeculativeAlgorithm.register`, получает только собственный `validate_server_args`; базовый `CustomSpecAlgo.handle_server_args` — пустой, то есть ни `--max-running-requests`, ни `--enable-mixed-chunk` он не трогает (а проверка `check_server_args` требует, чтобы mixed chunk был выключен).

### Что нужно каждому алгоритму

- **EAGLE** (и `NEXTN`, который в него схлопывается). Draft-модель обычно обязательна, но для архитектур `DeepseekV3/V32/V4ForCausalLM`, `Glm4MoeForCausalLM`, `Glm4MoeLiteForCausalLM`, `GlmMoeDsaForCausalLM`, `BailingMoe*`, `MistralLarge3ForCausalLM`, `PixtralForConditionalGeneration`, `HYV3ForCausalLM` путь draft'а **сам подставляется равным `--model-path`** (MTP-головы лежат в том же чекпоинте), а лишний `--speculative-draft-model-path` вызывает предупреждение `DeepSeek MTP does not require setting speculative_draft_model_path`. Если ни один из `--speculative-num-steps` не задан, тройка (steps, topk, num_draft_tokens) подбирается по архитектуре: `LlamaForCausalLM`, `Grok1*` → `(5, 4, 8)`; `STANDALONE` → `(3, 1, 4)`; DeepSeek/GptOss/Glm4Moe/BailingMoe/MiMoV2/Mistral/Pixtral → `(3, 1, 4)`; всё остальное → `(3, 1, 4)`. Задавать эти три флага нужно либо все три, либо ни одного: при заданном `--speculative-num-steps` авто-подбор не работает и остальные два остаются `None`.
- **EAGLE3.** Нужен EAGLE-3-чекпоинт в `--speculative-draft-model-path`. `--speculative-token-map` (FR-Spec) для него игнорируется. Только у Llama-EAGLE3-драфтера учитывается `--speculative-draft-window-size`.
- **STANDALONE.** Отдельная маленькая LLM как draft. Несовместим с `--enable-dp-attention` (явный `ValueError`).
- **NGRAM.** Модель не нужна вообще: кандидаты берутся из n-граммного кеша по уже сгенерированному тексту. Только `--device cuda` или `cpu`. `--speculative-eagle-topk` принудительно становится равным `--speculative-ngram-max-bfs-breadth`, `--speculative-num-draft-tokens` по умолчанию 12, `--speculative-num-steps` = `num_draft_tokens // topk`. `--enable-mixed-chunk` гасится безусловно. `--enable-dp-attention` запрещён; `topk > 1` вместе с `--page-size > 1` работает только на backend'е `flashinfer`.
- **DFLASH.** Нужен DFlash-чекпоинт (`--speculative-draft-model-path` обязателен). Только CUDA и NPU, `--pp-size 1`, без `--enable-dp-attention`. `speculative_num_steps` и `speculative_eagle_topk` принудительно равны 1 (с предупреждением, если заданы иначе), размер блока берётся из `--speculative-dflash-block-size`, иначе из конфига draft'а, иначе 16. Backend внимания draft'а доводится до поддерживаемого списка (`flashinfer`, `fa3`, `fa4`, `triton`, `trtllm_mha`, `ascend`).
- **DSPARK.** Только CUDA, `--pp-size 1`. Draft обязателен, **кроме** случая, когда сам целевой чекпоинт несёт draft-голову (ключи `dspark_block_size`, `dspark_markov_rank`, `dspark_noise_token_id`, `dspark_target_layer_ids` в hf-конфиге) — тогда путь и ревизия draft'а берутся у target'а. steps/topk принудительно 1, `speculative_num_draft_tokens = gamma + 1`. С `--enable-dp-attention` и `--dp-size > 1` требует `--enable-dp-lm-head` и `--moe-a2a-backend none`.
- **FROZEN_KV_MTP.** Напрямую не выбирается — это результат повышения `NEXTN`/`EAGLE` на Gemma4-ассистент-драфте.

### Что переписывается независимо от алгоритма

- **`--max-running-requests` становится 48**, если не задан явно: одинаковая строка `Max running requests is reset to 48 for speculative decoding` есть в `_handle_dflash`, `_handle_dspark`, `_handle_frozen_kv_mtp`, `_handle_eagle_family` и `_handle_ngram`. Это тот же лимит, что описан в `--max-running-requests`, и он сильно ниже обычной авто-оценки (2048…4096).
- **`--enable-mixed-chunk` выключается** («Mixed chunked prefill is disabled because of using … speculative decoding»); `check_server_args` дополнительно ассертит, что mixed chunk выключен.
- На `--device cpu` принудительно включается `--disable-overlap-schedule`.
- **Размер KV-ячейки растёт**: для EAGLE/STANDALONE `cell_size` умножается на `1 + draft_layers / target_layers`, для DFLASH/DSPARK добавляется собственная ячейка draft'а. Тот же бюджет `--mem-fraction-static` делится на большее число байт на токен, то есть `max_total_num_tokens` падает.
- **Резерв KV на шаг декодирования** становится `2 × max(num_steps × topk, num_draft_tokens)` токенов на запрос вместо 2 × 1 (`mem_cache/allocation_sizing.py`).
- Список batch size'ов для захвата CUDA graph при спекуляции другой (меньше padding'а на маленьких батчах), и графов становится больше: draft-decode, draft-extend и verify.
- В `--disaggregation-mode decode` авто-подбор `--mem-fraction-static` считает активации как `max_running_requests × speculative_num_draft_tokens`.

### Жёсткие несовместимости

`--pp-size > 1`; LoRA (`--lora-paths`) со всем, кроме `NGRAM`; `--weight-cache-mode` ≠ `off`; `--enable-hierarchical-cache` при `--dcp-size > 1`; `--dwdp-size > 1`; backend внимания `flex_attention`; `--enable-unified-memory` (разрешён только `DSPARK` и только с линейной цепочкой topk=1).

## Значения и формат

- Регистр не важен: `eagle`, `EAGLE`, `Eagle` эквивалентны.
- `NEXTN` — легальное входное значение, но в `server_args=` вы увидите уже `EAGLE`.
- Значения «выключить» нет: отсутствие флага и есть выключено. Пустая строка `--speculative-algorithm ""` даст `ValueError: Unknown speculative algorithm name:`.
- Опечатка в имени валит старт на `SpeculativeAlgorithm.from_string`, а не молча выключает спекуляцию.
- Заданный `--speculative-draft-model-path` читается на старте **всегда**, даже для `NGRAM`, которому draft не нужен: этого требует проверка на Gemma4-архитектуру. Несуществующий путь уронит запуск и там.

## Когда использовать

- Интерактивная нагрузка с одним-двумя параллельными запросами и хорошим draft'ом: именно там `accept len` 2–4 превращается в реальные 1.5–2.5× по latency.
- Модель с собственными MTP-головами (DeepSeek-V3/V3.2, GLM-4 MoE, Bailing): `--speculative-algorithm EAGLE` без указания draft-пути — самая дешёвая проверка гипотезы, дополнительных весов не грузится.
- Нет ни draft-модели, ни MTP-голов, но в ответах много дословных повторов входа (RAG, правка кода, JSON): `NGRAM` не требует весов вообще.
- Не включать «на всякий случай» на пакетной нагрузке: при большом running batch каждый отвергнутый draft-токен множится на размер батча, и throughput падает. Проверять по `accept len` и `accept rate` в строках `Decode batch`.
- Не включать, когда VRAM уже в обрез: draft добавляет и веса, и слой KV, и отдельные CUDA graph'ы, а KV-пул при этом сжимается.
- В arriero, если у инстанса объявлен memory-draw (`docs/RESOURCE_MANAGEMENT.md`), заявку надо пересчитать после включения спекуляции — потребление меняется по всем трём статьям сразу.

## Влияние на производительность и память

- VRAM: веса draft-модели (для MTP — соответствующие слои того же чекпоинта), увеличенная KV-ячейка, `2 × max(steps × topk, num_draft_tokens)` резерва KV на запрос на шаг, дополнительные CUDA graph'ы draft-decode / draft-extend / verify.
- RAM хоста: заметно только у `NGRAM` — n-граммный кеш (`--speculative-ngram-capacity`, по умолчанию 10 000 000 узлов) и опциональный внешний корпус живут в памяти хоста.
- Время старта: плюс загрузка draft-весов и плюс захват его графов; на больших `--cuda-graph-max-bs-decode` это десятки секунд.
- Throughput: при batch size 1 растёт пропорционально `accept len`; при большом running batch почти всегда падает — verify-батч шире в `num_draft_tokens` раз.
- Latency: падает ровно настолько, насколько принятый префикс длиннее одного токена, минус стоимость draft-шагов.

## Взаимодействие с другими аргументами

- `--max-running-requests`: при незаданном значении подменяется на 48. Если нужна другая конкурентность — задавайте явно, подмена срабатывает только для `None`.
- `--enable-mixed-chunk`: принудительно выключается; обратной силы у флага нет.
- `--speculative-num-steps` / `--speculative-eagle-topk` / `--speculative-num-draft-tokens`: для EAGLE-семейства задаются все три или ни одного; DFLASH и DSPARK насильно ставят steps=topk=1, NGRAM выводит их из ngram-параметров.
- `--speculative-draft-model-path` (+ `--speculative-draft-model-revision`, `--speculative-draft-model-quantization`, `--speculative-draft-load-format`): что именно грузится как draft.
- `--speculative-token-map`: FR-Spec, только EAGLE-2; для EAGLE3 игнорируется.
- `--speculative-attention-mode` и `--speculative-draft-attention-backend`: какими backend'ами считаются verify и draft.
- `--speculative-adaptive`: работает только с `EAGLE`/`EAGLE3` и topk=1, иначе отключается с предупреждением.
- `--enable-multi-layer-eagle`: меняет реализацию EAGLE на многослойную (для MiMoV2 и Step3p5/3p7 включается автоматически).
- `--mem-fraction-static`: тот же бюджет теперь кормит и draft; при OOM после включения спекуляции опускать его надо в первую очередь.
- `--page-size`: `topk > 1` при `page_size > 1` поддержан только backend'ами `flashinfer`, `fa3`, `triton` (для NGRAM — только `flashinfer`).
- `--pp-size`, `--lora-paths`, `--dwdp-size`, `--weight-cache-mode`, `--enable-unified-memory`: перечисленные выше жёсткие конфликты.

## Типовые проблемы и диагностика

- `ValueError: Unknown speculative algorithm name: EAGL3` — опечатка; сверьте список из «Паспорта» на своей сборке.
- `Max running requests is reset to 48 for speculative decoding` — ожидаемое поведение, не ошибка. Если нагрузка рассчитана на другую конкурентность, задайте `--max-running-requests` явно.
- `Mixed chunked prefill is disabled because of using eagle speculative decoding` — тоже норма.
- `torch.OutOfMemoryError` на старте сразу после включения флага — draft-веса и его графы не поместились. Понижайте `--mem-fraction-static` шагами по 0.02–0.05 либо `--cuda-graph-max-bs-decode`.
- Скорость упала, а не выросла: смотрите `Decode batch, #running-req: …, accept len: X.XX, accept rate: Y.YY`. `accept len` около 1.0 означает, что почти все draft-токены отвергаются — draft не подходит модели/нагрузке. Совокупное значение можно снять через `POST /set_internal_state` (в лог печатается `avg_spec_accept_length=`) или из `GET /server_info` (`internal_states[0].avg_spec_accept_length`).
- `Currently ... speculative decoding does not support dp attention` / `only supports pp_size == 1` — конфликт конфигурации, читайте текст ошибки: там названы и алгоритм, и флаг.
- Итоговое значение всегда видно в дампе `server_args=` при старте: там уже подставлены `EAGLE` вместо `NEXTN`, подобранные steps/topk/num_draft_tokens и `max_running_requests=48`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --speculative-algorithm EAGLE --speculative-num-steps 1 --speculative-eagle-topk 1 --speculative-num-draft-tokens 2 --max-running-requests 16
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B --speculative-num-steps 5 --speculative-eagle-topk 4 --speculative-num-draft-tokens 8 --mem-fraction-static 0.8
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --speculative-algorithm NGRAM --speculative-num-draft-tokens 12 --max-running-requests 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/spec_info.py`
- `sglang/python/sglang/srt/speculative/spec_registry.py`
- `sglang/python/sglang/srt/mem_cache/allocation_sizing.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`, `docs/KTRANSFORMERS_OPERATIONS.md`
