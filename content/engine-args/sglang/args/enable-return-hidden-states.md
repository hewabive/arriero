---
schema: 1
engine: sglang
primaryName: "--enable-return-hidden-states"
title: "--enable-return-hidden-states"
summary: Устаревшая по форме, но рабочая половина пары: поднимает потолок сервера до полного возврата скрытых состояний, то есть эквивалентна `--return-hidden-states-mode full`. Меняет тело ответа OpenAI-совместимого API, поэтому важна для всего, что стоит между клиентом и сервером.
group: exec.features
related:
  - --return-hidden-states-mode
  - --enable-return-routed-experts
  - --enable-return-indexer-topk
  - --speculative-algorithm
  - --cuda-graph-backend-prefill
  - --disable-cuda-graph
  - --max-running-requests
---

# --enable-return-hidden-states

## Кратко

Скрытые состояния — это выход последнего слоя перед LM-головой, вектор длины `hidden_size` на токен. Флаг поднимает **потолок сервера**: он не заставляет каждый ответ содержать состояния, он лишь разрешает запросам их просить. Запрос по-прежнему должен передать `return_hidden_states: true` (или `"last"`). Формально флаг не помечен как deprecated, но собственная справка описывает его как эквивалент `--return-hidden-states-mode full`, и в `__post_init__` эти два поля синхронизируются между собой. В новых конфигурациях задавайте режим явно — так видно, что вы разрешили только `last`, а не всё.

## Оригинальная справка

```text
Enable returning full hidden states with responses. Equivalent to `--return-hidden-states-mode full`.
```

## Паспорт аргумента

- Флаги: `--enable-return-hidden-states`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: синхронизируется с `--return-hidden-states-mode` в `_handle_return_hidden_states_mode` (`sglang/python/sglang/srt/server_args.py`). Если режим не задан, а флаг включен, режим становится `"full"`. Если режим задан (любой из `last`/`full`), флаг принудительно становится `True` — то есть в дампе `server_args=` вы увидите `enable_return_hidden_states=True` даже при `--return-hidden-states-mode last`, и это **не** означает полный режим
- Где объявлен: `ServerArgs.enable_return_hidden_states`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; фактически legacy-псевдоним, что зафиксировано и в его справке, и в тексте ошибки валидации запроса
- Этап применения: разбор CLI → `__post_init__` (`_handle_return_hidden_states_mode`) → выбор `capture_hidden_mode` при захвате CUDA graph → валидация каждого запроса в `TokenizerManager` → сборка ответа

## Что меняет в движке

### Потолок и запрос

`get_server_return_hidden_states_mode(server_args)` (`model_executor/forward_batch_info.py`) переводит пару полей в `CaptureHiddenMode`: `last` → `LAST`, `full` (или взведенный legacy-флаг) → `FULL`, иначе `NULL`. `TokenizerManager._validate_one_request` сравнивает режим запроса с серверным потолком и отвергает превышение:

- потолок `LAST`, запрос `return_hidden_states: true` → `ValueError` с текстом «The requested return_hidden_states mode exceeds the server maximum `last`. Please launch with `--return-hidden-states-mode full` …»;
- потолок `NULL`, любой запрос с состояниями → `ValueError` «The server is not configured to return hidden states. Please set `--return-hidden-states-mode last`, `--return-hidden-states-mode full`, or the legacy `--enable-return-hidden-states` flag.»

### Захват CUDA graph

Это главный побочный эффект и его нельзя обойти на лету. `capture_hidden_mode` берется из **серверного** потолка при захвате графов (`model_executor/runner/base_runner.py`, `decode_cuda_graph_runner.py`, `prefill_cuda_graph_runner.py`, `cpu_graph_runner.py`) и запекается в графы для всех размеров батча. То есть потолок `full` увеличивает выходные буферы графов независимо от того, просит ли кто-нибудь состояния в реальности.

Дополнительно: для EAGLE-таргета на `tc_piecewise`-бэкенде prefill-граф **отключается**, если серверный потолок ниже `FULL` (`cuda_graph_setup.py`, комментарий про порчу decode-replay на FP4/TRTLLM-MoE). То есть в спекулятивной конфигурации этот флаг косвенно возвращает prefill-граф.

### Что попадает в ответ

Скрытые состояния копятся в `req.hidden_states` и выгружаются в `output_hidden_states` (`managers/scheduler_components/output_streamer.py`). В OpenAI-совместимом ответе они кладутся в `choices[i].hidden_states` — поле удаляется из сериализации, если оно `None`, поэтому обычные ответы не меняются. При `return_hidden_states: "last"` возвращается собранный список, при `true` — `hidden_states[-1]`, если элементов больше одного, иначе пустой список (`process_hidden_states_for_response` в `entrypoints/openai/utils.py`). В стриминге состояния приходят отдельным финальным чанком с `delta.hidden_states`.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Не заменяет поле запроса: без `return_hidden_states` в теле ответ не изменится.
- Задавать одновременно с `--return-hidden-states-mode` можно, но бессмысленно: режим победит, а флаг всё равно окажется `True`.

## Когда использовать

- Извлечение эмбеддингов «попутно» с генерацией, обучение пробингов, RL-пайплайны, которым нужны состояния последнего слоя.
- Спекулятивная конфигурация EAGLE на `tc_piecewise`, где вы хотите сохранить prefill-граф.
- Не включайте на общем инференс-инстансе: вы платите памятью графов постоянно, а пользуетесь состояниями изредка. Лучше `--return-hidden-states-mode last`, если вам достаточно последнего токена.
- Не включайте, не подумав о том, кто читает ответы: тело ответа вырастает на мегабайты, и всё, что стоит между клиентом и сервером, будет это хранить и пересылать.

## Влияние на производительность и память

- **VRAM.** Буферы CUDA graph под скрытые состояния для всех захваченных размеров батча: примерно `max_bs × hidden_size × itemsize` на граф в режиме `LAST` и больше в `FULL`. Захват графов дорожает, доступной под KV-пул памяти становится меньше.
- **RAM хоста и трафик.** `FULL` копит вектор на каждый выданный токен. Ответ на 1000 токенов у модели с `hidden_size` 8192 — это 8·10⁶ чисел; в JSON это десятки мегабайт на один запрос.
- **Latency.** Копирование состояний device→host на каждый шаг плюс сериализация в конце. На коротких ответах заметно, на длинных — очень.
- **Throughput.** Падает из-за увеличенных буферов и копирований; при большом `--max-running-requests` эффект складывается.
- **Если никто не просит состояния.** Остается только цена буферов графов — она платится всегда.

## Взаимодействие с другими аргументами

- `--return-hidden-states-mode`: то же поведение с гранулярностью; предпочтительная форма.
- `--enable-return-routed-experts` / `--enable-return-indexer-topk`: соседние флаги, тоже расширяющие тело ответа, но независимые.
- `--speculative-algorithm`: на EAGLE-таргете потолок `full` сохраняет prefill CUDA graph на `tc_piecewise`; кроме того, в режиме `last` сбор состояний ограничивается последним принятым токеном с учетом «перелета» верификации.
- `--cuda-graph-backend-prefill`, `--disable-cuda-graph`: определяют, где именно запекается `capture_hidden_mode`.
- `--max-running-requests`: множитель для буферов и трафика.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: The server is not configured to return hidden states.` **Причина:** ни флаг, ни режим не заданы. **Решение:** задать `--return-hidden-states-mode last` или `full`.
- **Симптом:** `… exceeds the server maximum \`last\`.` **Причина:** запрос просит `true` при потолке `last`. **Решение:** `--return-hidden-states-mode full` или `return_hidden_states: "last"` в запросе.
- **Симптом:** в дампе `server_args=` видно `enable_return_hidden_states=True`, хотя вы задавали только `--return-hidden-states-mode last`. **Причина:** штатная синхронизация полей; смотрите на `return_hidden_states_mode`, а не на флаг.
- **Симптом:** после включения флага упал `max_total_num_tokens`. **Причина:** буферы графов под скрытые состояния. **Проверка:** строка `KV Cache is allocated` до и после.
- **Симптом:** клиент падает на разборе ответа. **Причина:** неожиданное поле `hidden_states` в `choices[i]`.
- **В arriero:** прокси отдает тело ответа как есть — `forwardApiProxyRequest` возвращает поток апстрима, меняя только заголовки. Поэтому `hidden_states` дойдут до клиента без изменений на фасаде `/v1/*`. Три места, где это важно: (1) на Anthropic-фасаде тело перестраивается sans-IO-мостом (`packages/anthropic-openai-bridge/src/response.ts` собирает блоки из `message.content`, `reasoning_content` и `tool_calls`), поэтому `hidden_states` там теряются; (2) нода `cache` кладет полное тело ответа в SQLite (`proxy_response_cache`) — многомегабайтные ответы туда попадут целиком (`docs/API_PROXY_RESPONSE_CACHE.md`); (3) `capture-request` пишет артефакты в `data/proxy-requests/` с той же 30-дневной ретенцией.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-return-hidden-states
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B --speculative-algorithm EAGLE --speculative-draft-model-path /models/eagle-head --enable-return-hidden-states
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/forward_batch_info.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/managers/scheduler_components/output_streamer.py`
- `sglang/python/sglang/srt/entrypoints/openai/utils.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- arriero: `apps/api/src/proxy/forwarder.ts`, `packages/anthropic-openai-bridge/src/response.ts`, `docs/API_PROXY_RESPONSE_CACHE.md`
