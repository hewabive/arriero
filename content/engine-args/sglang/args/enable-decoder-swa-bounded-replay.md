---
schema: 1
engine: sglang
primaryName: "--enable-decoder-swa-bounded-replay"
title: "--enable-decoder-swa-bounded-replay"
summary: Ускорение prefill DeepSeek-V4.1 — слои после последнего KV-source слоя считаются только по последним 128 токенам каждого запроса. Main и indexer KV остаются точными, но вывод не побитово равен полному prefill. Несовместим с prefill CUDA graph, DP attention, prompt logprobs и возвратом hidden states всех токенов.
group: exec.features
related:
  - --enable-encoder-swa-bounded-replay
  - --cuda-graph-backend-prefill
  - --disable-prefill-cuda-graph
  - --cuda-graph-config
  - --enable-dp-attention
  - --chunked-prefill-size
  - --enable-return-hidden-states
  - --speculative-algorithm
---

# --enable-decoder-swa-bounded-replay

## Кратко

У DeepSeek-V4.1 два вида KV. Сжатые латенты производят только KV-source слои и делят их с последующими слоями. Кроме того, у каждого слоя есть свое скользящее окно (SWA) на 128 позиций, которое нельзя разделить. Upstream cookbook описывает V4.1 Flash как 40 слоев, где поздние слои берут KV у source-слоя 20.

После prefill декодеру нужны полный Main/indexer KV, SWA-окна поздних слоев только на последних 128 позициях и логиты последнего токена. Флаг пропускает вычисление поздних слоев для всех остальных токенов промпта. Повторных прогонов нет («nothing is replayed»): это чистое сокращение работы, в отличие от `--enable-encoder-swa-bounded-replay`. Флаг опциональный, появился в upstream PR #38798; в закрепленной паре `sglang-kt` его может не быть.

## Оригинальная справка

```text
DeepSeek-V4.1 decoder SWA bounded replay: after the last kv_source layer, run the remaining layers over only the last window_size tokens of a prefill. Main and indexer KV stay exact; nothing is replayed. Deterministic for a fixed prompt and chunk size.
```

## Паспорт аргумента

- Флаги: `--enable-decoder-swa-bounded-replay`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: пайплайн не переписывает, но проверяет. Для `DeepseekV4ForCausalLM` с `model_type` `deepseek_v41` `validate_deepseek_v41_features` (`arg_groups/deepseek_v4_hook.py`) отказывает при активном prefill CUDA graph и при DP attention: `ValueError: --enable-decoder-swa-bounded-replay cannot be combined with the prefill CUDA graph yet; disable one of them.` (или `… with DP attention yet …`). Для других моделей проверки нет
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecFeatures.enable_decoder_swa_bounded_replay`
- Статус: обычный, опциональный, новый
- Этап применения: разбор CLI → проверка V4.1 в `handle_model_specific_adjustments` → конструктор `DeepseekV4Model` (`late_layer_start = max(kv_source_layer_ids) + 1`) → каждый extend-forward без спекуляции

## Что меняет в движке

Флаг читают только `models/deepseek_v4.py` и `layers/attention/deepseek_v4_backend.py`.

**Построение модели.** Конструктор требует непустого `config.kv_source_layer_ids` (ассерт `decoder SWA bounded replay needs kv_source_layer_ids`) и того, что поздние слои не сжимают KV сами (коэффициенты сжатия только `0` или `1`). Если конфиг этого не дает, сервер не стартует.

**Forward.** Путь включается только в extend-батчах без спекуляции (`is_extend_without_speculative`). В `_forward_layers_hc_pre_from_prev`, на входе в первый поздний слой, скрытые состояния, residual, `input_ids`, позиции и hash-ids engram сокращаются до хвоста: последних до 128 (`SWA_WINDOW`) extend-токенов каждого запроса (`late_layer_tail_layout`). Backend переключает метаданные внимания на этот хвост (`enter_late_layer_tail`).

Слои до последнего KV-source видят весь extend, поэтому Main KV и indexer KV пишутся полностью и точно. Поздние слои пишут свои SWA-окна только для хвоста — ровно то, что прочитает decode. Результат зависит от разбиения на чанки, поэтому справка обещает детерминизм лишь «for a fixed prompt and chunk size». Cookbook прямо говорит, что численно это не эквивалентно полному prefill.

**Проверки на запрос.** `_check_late_layer_tail_readers` выполняется внутри forward:

- запрос с `return_hidden_states: true` (полный захват по всем токенам, без DSpark-слоев) → `ValueError: decoder SWA bounded replay cannot capture hidden states of all prompt tokens`;
- `return_logprob` с `logprob_start_len` меньше длины промпта → `ValueError: decoder SWA bounded replay cannot return prompt logprobs; set logprob_start_len to the prompt length`.

Tokenizer manager для этого флага запрос заранее не валидирует. В checkout'е `run_batch` планировщика исключения не перехватывает: они доходят до `run_scheduler_process` (`Scheduler hit an exception`, SIGQUIT родительскому процессу). Значит, по коду один такой запрос может уронить сервер. Не открывайте prompt logprobs и полный возврат hidden states клиентам такого инстанса.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- На моделях не `DeepseekV4ForCausalLM` флаг никто не читает. На DeepSeek-V4 без `kv_source_layer_ids` в конфиге старт падает на ассерте.

## Когда использовать

- DeepSeek-V4.1 под нагрузкой с длинными промптами, где TTFT упирается в prefill. Поздние слои (по cookbook — все после source-слоя 20 из 40) считаются по ≤128 токенам вместо всего промпта. Upstream включает флаг в проверенной конфигурации H200 low-latency (`deepseek-v4_1.jsx`).
- Не включайте, если клиентам нужны prompt logprobs (оценка, perplexity, скоринг) или hidden states всех токенов.
- Не включайте, если нужна побитовая воспроизводимость относительно полного prefill.
- Нужен prefill CUDA graph или DP attention — выбирайте одно из двух.

## Влияние на производительность и память

- **Prefill.** Вычисления поздних слоев на длинном промпте сокращаются до хвоста; для V4.1 Flash это около половины стека слоев, отсюда «materially faster» в cookbook. На коротких промптах (≤128 токенов) разницы нет.
- **VRAM и KV-пул.** Не меняются: пишется тот же KV, а лишних буферов флаг не выделяет.
- **Decode.** Без изменений.
- **Время старта.** Без изменений.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-prefill`, `--disable-prefill-cuda-graph`, `--cuda-graph-config`: для DeepSeek-V4 prefill-граф и так выключен каскадом совместимости (`DeepSeek-V4 (heavy capture-pool memory pressure)`). Отказ на старте возникает только при явном включении prefill-графа.
- `--enable-dp-attention`: несовместим — `input_ids_global` собирается по всей DP-группе, и срез хвоста к нему неприменим.
- `--chunked-prefill-size`: хвост берется на каждом extend-чанке, поэтому результат детерминирован при фиксированном размере чанка.
- `--enable-return-hidden-states`: запрос с полным возвратом hidden states завершится ошибкой в forward (см. выше).
- `--speculative-algorithm`: draft-extend и verify не затрагиваются (`is_extend_without_speculative`); V4.1 допускает только DSpark.
- `--enable-encoder-swa-bounded-replay`: отдельный механизм с другой целью. Взаимного запрета в коде нет, но и совместная работа upstream не описана.

## Типовые проблемы и диагностика

- **Старт падает с `cannot be combined with the prefill CUDA graph yet`.** Уберите явный prefill-backend или задайте `--disable-prefill-cuda-graph`.
- **Старт падает с `cannot be combined with DP attention yet`.** Уберите `--enable-dp-attention` или флаг.
- **Сервер упал с `decoder SWA bounded replay cannot return prompt logprobs` в логе.** Клиент запросил prompt logprobs; ограничьте такие запросы до инстанса.
- **Что включено.** Дамп `server_args=` при старте содержит `enable_decoder_swa_bounded_replay=True`.
- **Эффект.** Сравните TTFT длинных промптов с флагом и без.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4.1-Flash --trust-remote-code --tp-size 8 --ep-size 8 --enable-decoder-swa-bounded-replay
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4.1-Flash --trust-remote-code --tp-size 8 --ep-size 8 --mem-fraction-static 0.8 --enable-decoder-swa-bounded-replay --chunked-prefill-size 8192
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
- `sglang/python/sglang/srt/arg_groups/model_hook.py`
- `sglang/python/sglang/srt/arg_groups/cuda_graph_hook.py`
- `sglang/python/sglang/srt/models/deepseek_v4.py`
- `sglang/python/sglang/srt/layers/attention/deepseek_v4_backend.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/cookbook/autoregressive/DeepSeek/DeepSeek-V4_1.mdx`
- `sglang/docs/src/snippets/configs/deepseek-ai/deepseek-v4_1.jsx`
- upstream PR #38798 «dsv4.1: remaining model and runtime integration» (коммит `a6cf05817f` в checkout)
