---
schema: 1
engine: sglang
primaryName: "--enable-encoder-swa-bounded-replay"
title: "--enable-encoder-swa-bounded-replay"
summary: Экспериментальный режим кеша DeepSeek-V4.1, только CUDA. Radix cache хранит лишь Main KV и ключи индексера, SWA-окно живет в собственном per-request пуле и при попадании в префикс восстанавливается прогоном до 128 токенов. Убирает paged SWA-пул ценой replay и длинного списка несовместимостей.
group: exec.features
related:
  - --enable-decoder-swa-bounded-replay
  - --max-running-requests
  - --chunked-prefill-size
  - --cuda-graph-backend-prefill
  - --disable-prefill-cuda-graph
  - --enable-dp-attention
  - --attn-cp-size
  - --disaggregation-mode
  - --enable-mixed-chunk
  - --enable-lora
  - --enable-session-radix-cache
  - --enable-unified-memory
  - --enable-unified-cache-external-linker
  - --swa-full-tokens-ratio
  - --swa-prefix-tails
  - --speculative-algorithm
---

# --enable-encoder-swa-bounded-replay

## Кратко

В обычном режиме DeepSeek-V4 держит paged SWA-пул. KV скользящего окна каждого слоя хранится по токенам и попадает в radix cache вместе с основным KV, а под пул резервируется заметная часть памяти (`--swa-full-tokens-ratio`, `--swa-prefix-tails`). При этом попадание в префикс пригодно, только если сохранился SWA-хвост этого префикса.

Encoder replay устроен иначе. В кеш префиксов идут только Main KV и ключи индексера. SWA-окно принадлежит запросу (`RequestWindow`, кольцо размером в окно на каждый слот запроса). Когда запрос попадает в кешированный префикс — новый запрос или возобновление вытесненного, — окно пересобирается прогоном последних ≤128 токенов префикса. Справка прямо называет режим экспериментальным и только для CUDA; аргумент появился в upstream PR #38798. В закрепленной паре `sglang-kt` его может не быть.

## Оригинальная справка

```text
DeepSeek-V4.1 encoder SWA bounded replay: cache Main KV and Indexer keys only, rebuild request-owned SWA windows on prefix hits. Experimental; CUDA only.
```

## Паспорт аргумента

- Флаги: `--enable-encoder-swa-bounded-replay`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: пайплайн не переписывает, но для `DeepseekV4ForCausalLM` `validate_deepseek_v41_features` (`arg_groups/deepseek_v4_hook.py`) проверяет:
  - модель не V4.1 (`model_type` не `deepseek_v41`) → `ValueError: --enable-encoder-swa-bounded-replay requires DeepSeek-V4.1`;
  - не CUDA, активный prefill CUDA graph, DP attention, context parallelism, external cache linker, unified memory, PD disaggregation, mixed prefill/decode, LoRA, radix sessions → `ValueError: --enable-encoder-swa-bounded-replay does not support <feature> yet`;
  - `--max-running-requests` не задан или `<= 0`, либо `--chunked-prefill-size` пуст или меньше 128 → `ValueError: encoder SWA replay requires explicit --max-running-requests and --chunked-prefill-size >= 128`;
  - плюс общие ограничения V4.1: из спекулятивных алгоритмов только DSpark, без HiSparse, two-batch overlap, pipeline parallelism и `--dsv4-attn-backend trtllm`
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecFeatures.enable_encoder_swa_bounded_replay`
- Статус: экспериментальный; контракт может поменяться без предупреждения
- Этап применения: разбор CLI → проверка V4.1 в `handle_model_specific_adjustments` → расчет пулов (`model_executor/pool_configurator.py`) и построение `DeepSeekV4TokenToKVPool` с `RequestWindow` → прогрев (текстовый путь) → прием запроса (tokenizer manager) → планирование (учет replay-токенов) → forward (replay перед обычным extend)

О сообщении про «explicit»: в пайплайне checkout'а `apply_deepseek_v4_defaults` раньше этой проверки подставляет `max_running_requests=256`, а `--chunked-prefill-size` к этому моменту уже подобран по объему GPU-памяти. Поэтому на практике ошибка срабатывает при `--max-running-requests 0` или `--chunked-prefill-size` `-1`/меньше 128. Задавать оба значения явно все равно разумно: по `--max-running-requests` размечаются слоты окна (см. ниже).

## Что меняет в движке

### Память

`pool_configurator.py` при включенном флаге:

- резервирует `request_window_bytes` — кольцо на `(max_running_requests_per_worker + 1)` слотов емкостью `sliding_window + MTP-draft`, выровненной до страницы, на все слои, плюс рабочий буфер не меньше `--chunked-prefill-size`;
- без DSpark-draft ставит `swa_ratio = 0` и `swa_cap_tokens = 0`: paged SWA-пул не создается, и вся остальная KV-память идет под Main KV.

С DSpark-draft paged SWA-аллокатор сохраняется: draft делит с целью отображение full→SWA. В `DeepSeekV4TokenToKVPool` вместо `swa_kv_pool` строится `RequestWindow` (`mem_cache/dsv41_request_window.py`).

### Прием и планирование

- Tokenizer manager отвергает запросы с `image_data`, `video_data`, `audio_data`, `input_embeds`, `positional_embed_overrides` (`encoder SWA replay currently supports token-only text requests`) и prompt logprobs, кроме `logprob_start_len` равного `-1` или длине промпта (`encoder SWA replay cannot return cached prompt logprobs`).
- Прогрев сервера идет по текстовому пути даже для мультимодальной модели (`http_server.py`).
- В `schedule_policy.py` для каждого принятого запроса с префиксом, который новый или возобновленный после retraction, из бюджета токенов и чанка вычитается `min(prefix_len, 128)` replay-токенов. Они видны в строке prefill-лога как `#replay-token: N`.

### Forward

`tp_worker.py` перед обычным extend вызывает `run_encoder_swa_replay` (`model_executor/encoder_swa_replay.py`). Для каждого запроса с пометкой сброса окно слота очищается, и, если есть кешированный префикс, отдельным forward прогоняются токены `[max(0, end − 128), end)`, где `end` — длина префикса. Граница префикса должна быть четной, иначе `ValueError: encoder SWA replay requires an even cached-prefix boundary`. Main и indexer KV при replay не пересчитываются: они уже в кеше.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Для моделей не `DeepseekV4ForCausalLM` проверка не вызывается вовсе. При этом код планировщика и воркера обращается к `request_window` пула DeepSeek-V4, так что на других архитектурах ждите падения при прогреве или на первом запросе. Флаг не для них.

## Когда использовать

- DeepSeek-V4.1 на CUDA, текстовая нагрузка с большим переиспользованием префиксов (агентские диалоги, общие системные промпты), где paged SWA-пул съедает память, а попадания в префикс теряются из-за вытесненных SWA-хвостов.
- Только после проверки, что вам не нужны DP attention, PD, LoRA, мультимодальность, prompt logprobs, prefill CUDA graph и mixed chunk: все это режим отвергает.
- Не используйте в эксплуатации без собственного прогона — режим экспериментальный.

## Влияние на производительность и память

- **VRAM.** Paged SWA-пул (без DSpark) исчезает, его место занимает фиксированное кольцо, пропорциональное `(max_running_requests + 1) × окно × число слоев`. Освободившаяся память уходит под Main KV — больше кешируемых токенов. Кольцо занято всегда, даже при простое, поэтому завышенный `--max-running-requests` прямо тратит VRAM.
- **Prefill.** Каждое попадание в префикс у нового или возобновленного запроса стоит до 128 токенов replay. Прогоны идут отдельными forward'ами по одному на запрос, поэтому батч с множеством таких запросов принимается медленнее.
- **Радикс-кеш.** Попадание больше не зависит от сохранности SWA-хвоста. Ради этой зависимости и существует `--swa-prefix-tails`.
- **Время старта.** Без существенных изменений; прогрев идет текстом.

## Взаимодействие с другими аргументами

- `--max-running-requests`: размечает слоты окна; должен быть `> 0`.
- `--chunked-prefill-size`: не меньше 128 и определяет размер рабочего буфера окна.
- `--cuda-graph-backend-prefill`, `--disable-prefill-cuda-graph`: prefill-граф должен быть выключен. Для DeepSeek-V4 он и так выключен каскадом, ошибка будет только при явном включении.
- `--enable-dp-attention`, `--attn-cp-size`, `--disaggregation-mode`, `--enable-mixed-chunk`, `--enable-lora`, `--enable-session-radix-cache`, `--enable-unified-memory`, `--enable-unified-cache-external-linker`: несовместимы.
- `--swa-full-tokens-ratio`, `--swa-prefix-tails`: без DSpark-draft paged SWA-пула нет, и эти настройки его размер не определяют.
- `--speculative-algorithm`: на V4.1 допустим только DSpark; с ним paged SWA-аллокатор для draft сохраняется.
- `--enable-decoder-swa-bounded-replay`: другой механизм (сокращение работы поздних слоев в prefill). Взаимного запрета в коде нет, совместная работа upstream не описана.

## Типовые проблемы и диагностика

- **`--enable-encoder-swa-bounded-replay does not support <feature> yet`.** Уберите названную функцию или флаг.
- **`encoder SWA replay requires explicit --max-running-requests and --chunked-prefill-size >= 128`.** Задайте оба значения явно.
- **Клиент получает `encoder SWA replay currently supports token-only text requests`.** Мультимодальный запрос или `input_embeds`; режим их не поддерживает.
- **`encoder SWA replay cannot return cached prompt logprobs`.** Запрошены prompt logprobs; используйте `logprob_start_len` `-1` или длину промпта.
- **Что включено и сколько стоит replay.** Дамп `server_args=` и поле `#replay-token` в строках prefill-лога.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4.1-Flash --trust-remote-code --tp-size 8 --ep-size 8 --enable-encoder-swa-bounded-replay --max-running-requests 64 --chunked-prefill-size 8192
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4.1-Flash --trust-remote-code --tp-size 8 --ep-size 8 --enable-encoder-swa-bounded-replay --max-running-requests 128 --chunked-prefill-size 4096 --disable-prefill-cuda-graph
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
- `sglang/python/sglang/srt/arg_groups/model_hook.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/mem_cache/deepseek_v4_memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/dsv41_request_window.py`
- `sglang/python/sglang/srt/model_executor/encoder_swa_replay.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- upstream PR #38798 «dsv4.1: remaining model and runtime integration» (коммит `a6cf05817f` в checkout)
