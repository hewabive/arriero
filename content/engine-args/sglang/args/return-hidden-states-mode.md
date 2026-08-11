---
schema: 1
engine: sglang
primaryName: "--return-hidden-states-mode"
title: "--return-hidden-states-mode"
summary: Задает потолок сервера для возврата скрытых состояний: `last` разрешает только состояние последнего токена, `full` — все. Это одновременно и разрешение для клиента, и решение о том, какие буферы будут запечены в CUDA graph.
group: exec.features
related:
  - --enable-return-hidden-states
  - --enable-return-routed-experts
  - --enable-return-indexer-topk
  - --speculative-algorithm
  - --cuda-graph-backend-prefill
  - --cuda-graph-max-bs
  - --disable-cuda-graph
  - --max-running-requests
---

# --return-hidden-states-mode

## Кратко

Современная форма разрешения на возврат скрытых состояний, пришедшая на смену булеву `--enable-return-hidden-states`. Значение — это **максимум**, который сервер согласен отдать; конкретный запрос все равно должен попросить состояния полем `return_hidden_states`. Разница между `last` и `full` не косметическая: она определяет, какой `CaptureHiddenMode` запекается в CUDA graph при захвате, то есть влияет на VRAM постоянно, а не только на запросах со состояниями. По умолчанию (`null`) потолок равен «нельзя», и любой запрос с состояниями отвергается.

## Оригинальная справка

```text
Set the maximum hidden-state return mode supported by the server. `last` allows requests with return_hidden_states=False or `last`; `full` also allows return_hidden_states=True.
```

## Паспорт аргумента

- Флаги: `--return-hidden-states-mode`
- Группа: `exec.features`
- Тип значения: строка с фиксированным списком (`Optional[str]`)
- Допустимые значения: `last`, `full`
- Значение по умолчанию: `null` — возврат скрытых состояний запрещен
- Эффективное значение: `_handle_return_hidden_states_mode` (`sglang/python/sglang/srt/server_args.py`) связывает поле с legacy-флагом в обе стороны. Если значение не задано, но задан `--enable-return-hidden-states`, режим становится `"full"`. Если значение задано, `enable_return_hidden_states` принудительно становится `True` — включая случай `last`. Значение вне `None`/`last`/`full` (возможно только при программном создании `ServerArgs`) поднимает `ValueError: return_hidden_states_mode must be one of: None, 'last', or 'full'.`
- Где объявлен: `ServerArgs.return_hidden_states_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (`_handle_return_hidden_states_mode`) → выбор `capture_hidden_mode` при захвате CUDA graph → валидация каждого запроса → сборка ответа

## Что меняет в движке

### Три уровня режима

`CaptureHiddenMode` (`model_executor/forward_batch_info.py`) — упорядоченный `IntEnum`: `NULL = 0`, `LAST = 1`, `FULL = 2`. Сравнение режимов — это сравнение чисел, поэтому «потолок» реализуется буквально:

- `get_server_return_hidden_states_mode(server_args)`: `last` → `LAST`, `full` (или взведенный legacy-флаг) → `FULL`, иначе `NULL`;
- `get_request_return_hidden_states_mode(...)`: поле запроса `true` → `FULL`, `"last"` → `LAST`, `false` → `NULL`; для списка берется максимум;
- `TokenizerManager._validate_one_request` отвергает запрос, если его режим больше серверного, с разными текстами для потолка `LAST` и для `NULL`.

Внутри батча режим тоже берется максимумом по запросам (`get_batch_return_hidden_states_mode`), и при слиянии батчей поднимается до большего из двух. То есть один запрос с `full` в батче заставляет захватывать полные состояния для всего батча на этом шаге.

### Что запекается в графы

`capture_hidden_mode` для decode- и prefill-раннеров и для CPU-раннера берется из **серверного** потолка, а не из текущего батча — иначе граф пришлось бы перезахватывать. Отсюда правило: `full` увеличивает выходные буферы всех захваченных графов, даже если запросов со состояниями нет вовсе.

Отдельный частный случай: для EAGLE-таргета на бэкенде `tc_piecewise` prefill-граф **отключается**, если серверный потолок меньше `FULL` (`cuda_graph_setup.py`; в комментарии — ссылка на порчу decode-replay при FP4/TRTLLM-MoE). Бэкенд `breakable` этого не требует, он захватывает `FULL` для EAGLE-таргета сам.

### Что видит клиент

- `last`: `output_hidden_states` содержит одно состояние на запрос — последний элемент `req.hidden_states`;
- `full`: содержит список состояний, обрезанный по `finished_len` (чтобы «перелет» шагов верификации спекуляции не попал в ответ).

Дальше `process_hidden_states_for_response` (`entrypoints/openai/utils.py`) формирует поле `choices[i].hidden_states`. Поле выпиливается из сериализации при `None`, поэтому обычные ответы не меняются ни на байт. В стриминге состояния приходят отдельным финальным чанком с `delta.hidden_states`.

## Значения и формат

- Только `last` или `full`; всё остальное отвергает argparse (`invalid choice`).
- Не задавать — это «запрещено», а не «авто». Синонима `none`/`off` нет.
- Значение — потолок, а не режим по умолчанию для запросов: без `return_hidden_states` в теле ответ не изменится.
- Задавать вместе с `--enable-return-hidden-states` не нужно: режим победит, а флаг всё равно станет `True`.

## Когда использовать

- `last` — почти всегда правильный выбор, если вам нужен эмбеддинг ответа: один вектор на запрос, минимальный трафик, минимальные буферы графов.
- `full` — только если вам действительно нужны состояния каждого выданного токена (пробинги, анализ траектории, обучение по промежуточным представлениям), либо ради prefill-графа EAGLE-таргета на `tc_piecewise`.
- Не ставьте `full` «на всякий случай»: это постоянная плата VRAM и потенциально десятки мегабайт JSON на запрос.
- Не оставляйте режим включенным на общем инференс-инстансе после эксперимента.

## Влияние на производительность и память

- **VRAM.** Буферы скрытых состояний в каждом захваченном графе; порядок — `cuda_graph_max_bs × hidden_size × itemsize` для `LAST` и кратно больше для `FULL` (там буфер рассчитан на токены батча, а не на запросы). Прямое следствие — меньше `max_total_num_tokens`.
- **Трафик и RAM.** `full` на длинном ответе — это `num_tokens × hidden_size` чисел в JSON. Для `hidden_size` 8192 и 1000 токенов речь о десятках мегабайт на один ответ.
- **Latency.** Копирование device→host на каждом шаге плюс сериализация; в `last` — только последний вектор.
- **Throughput.** Падает на батчах со состояниями; при `full` еще и потому, что весь батч поднимается до максимального режима.
- **Захват графов.** Дольше и дороже по памяти в обоих режимах, но в `full` заметнее.

## Взаимодействие с другими аргументами

- `--enable-return-hidden-states`: legacy-эквивалент `full`; поля синхронизируются в обе стороны.
- `--speculative-algorithm`: в `full` состояния обрезаются по `finished_len`; на EAGLE-таргете `tc_piecewise` потолок ниже `FULL` отключает prefill-граф.
- `--cuda-graph-backend-prefill`: определяет, попадет ли prefill-граф под это правило.
- `--cuda-graph-max-bs`, `--max-running-requests`: множители размера буферов и объема ответов.
- `--disable-cuda-graph`: снимает плату по буферам графов, но платой становится сам eager-режим.
- `--enable-return-routed-experts` / `--enable-return-indexer-topk`: независимые расширения тела ответа.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: The requested return_hidden_states mode exceeds the server maximum \`last\`.` **Причина:** запрос с `return_hidden_states: true` при потолке `last`. **Решение:** `full` на сервере либо `"last"` в запросе.
- **Симптом:** `ValueError: The server is not configured to return hidden states.` **Причина:** режим не задан. **Решение:** задать `last` или `full`.
- **Симптом:** после смены `last` на `full` упал `max_total_num_tokens`. **Причина:** выросли буферы графов. **Проверка:** строки `KV Cache is allocated` и о захвате графов до и после.
- **Симптом:** в дампе `server_args=` `enable_return_hidden_states=True` при `return_hidden_states_mode='last'`. **Причина:** штатная синхронизация; ориентируйтесь на само поле режима.
- **Симптом:** для EAGLE пропал prefill-граф с сообщением про FP4/MoE decode-replay. **Причина:** потолок ниже `FULL` на `tc_piecewise`. **Решение:** `full` либо бэкенд `breakable`.
- **В arriero:** прокси возвращает тело апстрима потоком без изменений, так что `hidden_states` доходят до клиента на фасаде `/v1/*`; на Anthropic-фасаде мост собирает ответ из фиксированного набора полей и состояния теряются. Отдельно учитывайте ноду `cache`: она хранит полное тело в SQLite, а `capture-request` — в `data/proxy-requests/` (`docs/API_PROXY_RESPONSE_CACHE.md`, `docs/API_PROXY_PIPELINES.md`). Режим `full` в связке с кешированием — это гигабайты в `data/`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --return-hidden-states-mode last
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --return-hidden-states-mode full --cuda-graph-max-bs 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/forward_batch_info.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler_components/output_streamer.py`
- `sglang/python/sglang/srt/entrypoints/openai/utils.py`
- arriero: `apps/api/src/proxy/forwarder.ts`, `docs/API_PROXY_RESPONSE_CACHE.md`, `docs/API_PROXY_PIPELINES.md`
