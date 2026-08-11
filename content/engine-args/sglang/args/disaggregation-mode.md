---
schema: 1
engine: sglang
primaryName: "--disaggregation-mode"
title: "--disaggregation-mode"
summary: Роль процесса в PD-развертывании: `prefill` считает промпт и отдает KV, `decode` принимает KV и генерирует токены. Значение по умолчанию — строка `"null"`, то есть обычный монолитный сервер.
group: disagg
related:
  - --disaggregation-transfer-backend
  - --disaggregation-bootstrap-port
  - --disaggregation-ib-device
  - --disaggregation-decode-polling-interval
  - --disaggregation-decode-enable-radix-cache
  - --disaggregation-decode-enable-offload-kvcache
  - --disaggregation-decode-extra-slots
  - --num-reserved-decode-tokens
  - --optimistic-prefill-attempts
  - --load-balance-method
  - --enable-pdmux
  - --language-only
  - --encoder-only
  - --host
  - --port
  - --dist-init-addr
  - --mem-fraction-static
  - --max-running-requests
  - --enable-dp-attention
---

# --disaggregation-mode

## Кратко

PD disaggregation — это не ручка одного сервера, а форма развертывания: два и более независимых процесса `sglang.launch_server`, каждый со своей копией весов и своим HTTP-портом, плюс роутер перед ними. `--disaggregation-mode` объявляет, какую половину играет **этот** процесс. Значение по умолчанию — не отсутствие значения, а строка `"null"`: argparse принимает `null`, `prefill` и `decode`, и `null` означает обычный монолитный сервер. Все остальные аргументы группы `disagg` без ненулевого значения здесь либо игнорируются, либо отвергаются проверкой.

## Оригинальная справка

```text
Only used for PD disaggregation. "prefill" for prefill-only server, and "decode" for decode-only server. If not specified, it is not PD disaggregated
```

## Паспорт аргумента

- Флаги: `--disaggregation-mode`
- Группа: `disagg`
- Тип значения: str; поле объявлено как `Literal["null", "prefill", "decode"]`, из чего argparse автоматически выводит `choices`
- Допустимые значения: `null`, `prefill`, `decode`. `null` — реальная строка, а не отсутствие значения; `--disaggregation-mode null` эквивалентно тому, что аргумент не задан
- Значение по умолчанию: `"null"`
- Эффективное значение: совпадает с заданным, кроме одного случая — `_handle_dllm_inference` при diffusion-LLM-инференсе печатает `Currently disaggregation is not supported by diffusion LLM inference.` и принудительно ставит `null`
- Где объявлен: `ServerArgs.disaggregation_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_pd_disaggregation` (валидация и нормализация ролей) → `_apply_cuda_graph_disaggregation_roles` → авто-подбор `--mem-fraction-static` → `start_disagg_service` в процессе tokenizer manager (только prefill) → выбор event loop в scheduler (`dispatch_event_loop`) → выделение KV-пула → форвард

## Что меняет в движке

### Топология развертывания

Полное PD-развертывание — это минимум три отдельно запускаемых компонента:

1. **Prefill-сервер** (`--disaggregation-mode prefill`). Обычный HTTP-сервер SGLang плюс **bootstrap-сервер** — aiohttp-приложение, поднятое в отдельном демон-потоке процесса tokenizer manager на `--host`:`--disaggregation-bootstrap-port` (`managers/disagg_service.py:start_disagg_service`). Каждый ранг prefill регистрирует в нем свой `rank_ip`/`rank_port` (ZMQ PULL-сокет KV-менеджера), `attn_tp_size/rank`, `attn_dp_size/rank`, `pp_size/rank`, `page_size`, `kv_cache_dtype` и HTTP-порт (`CommonKVManager.register_to_bootstrap`, PUT `/route`).
2. **Decode-сервер** (`--disaggregation-mode decode`). Bootstrap-сервер не поднимает. Для каждого запроса читает `bootstrap_host:bootstrap_port` **из самого запроса**, ходит на bootstrap-сервер prefill за таблицей рангов, отдает свои KV-индексы и ждет, пока prefill перекачает KV.
3. **Роутер** перед обоими: `python -m sglang_router.launch_router --pd-disaggregation --prefill <url> [bootstrap-port] --decode <url>`. Он и только он раздает запросу `bootstrap_host`, `bootstrap_port` и `bootstrap_room` — либо полями тела (`GenerateReqInput.bootstrap_*`), либо заголовками `x-override-bootstrap-host` / `-port` / `-room` (`entrypoints/request_headers.py`). Он же сшивает поток: prefill возвращает метаданные первого токена, decode — сам поток.

По проводу между prefill и decode идет **KV-кеш запроса** (плюс метаданные первого токена и, для спекуляции/DSA, дополнительные состояния) — трафиком управляет `--disaggregation-transfer-backend`, а сам transfer идет по RDMA/TCP напрямую между рангами, минуя bootstrap-сервер. Bootstrap-сервер переносит только адреса рангов и параметры совместимости.

Из этого следует практическое правило: **обычный запрос на prefill- или decode-сервер напрямую не обслуживается**. `bootstrap_room` авто-назначается только для `--disaggregation-transfer-backend fake`; на decode адрес строится как `NetworkAddress(req.bootstrap_host, req.bootstrap_port)` (`disaggregation/decode.py:_bootstrap_addr`) и без host не соберется. Стартовый warmup обходит это через фиктивный `FAKE_BOOTSTRAP_HOST = "2.2.2.2"` и `bootstrap_room = dp_rank` — путь, зарезервированный за прогревом (`entrypoints/http_server.py:_send_disaggregation_warmup_requests`).

### Что переключается внутри процесса

- **Event loop scheduler'а.** `dispatch_event_loop` (`managers/scheduler.py`) выбирает `event_loop_pp_disagg_prefill` / prefill-петлю или decode-петлю вместо `event_loop_normal`/`event_loop_overlap`.
- **CUDA graph.** `_apply_cuda_graph_disaggregation_roles`: на `prefill` decode-граф выключается (`Backend.DISABLED`), на `decode` — prefill-граф, если backend фазы не зафиксирован явно. Это заметно сокращает и время старта, и VRAM под графы.
- **Кеш префиксов на decode.** По умолчанию decode форсирует chunk cache: `disable_radix_cache = True` с предупреждением `KV cache is forced as chunk cache for decode server`. Вернуть radix можно только `--disaggregation-decode-enable-radix-cache`.
- **Пулы.** На decode `req_to_token_pool` строится как `DecodeReqToTokenPool` с добавочными слотами под запросы в состоянии передачи (`--disaggregation-decode-extra-slots`), а планировщик резервирует `--num-reserved-decode-tokens` на каждый активный запрос.
- **Балансировка.** `--load-balance-method auto` разрешается в `follow_bootstrap_room` для prefill и в `round_robin` для остальных (`_handle_load_balance_method`).
- **Авто-подбор `--mem-fraction-static`.** На decode активационный резерв считается от `max_running_requests * speculative_num_draft_tokens`, а не от `chunked_prefill_size`; VLM-надбавка (`adjust_mem_fraction_for_vlm`) на decode не применяется, потому что энкодер там не работает.
- **Метрики и трассировка.** `engine_type` в метках метрик становится `prefill`/`decode` вместо `unified`; при `--enable-trace` в имена потоков добавляется `Prefill`/`Decode`.

## Значения и формат

- `null` — монолитный сервер. Это значение по умолчанию и единственное, при котором доступны `--enable-pdmux`, `--enable-linear-replayssm`, `--mamba-radix-cache-strategy extra_buffer_lazy` и diffusion-LLM-путь.
- `prefill` — только prefill. Поднимается bootstrap-сервер; `--disaggregation-transfer-backend fake` запрещен (`Prefill server does not support 'fake' as the transfer backend`).
- `decode` — только decode. Bootstrap-сервер не поднимается; `--disaggregation-bootstrap-port` здесь означает порт **чужого** prefill-сервера и используется как значение по умолчанию, если роутер не прислал `bootstrap_port` в запросе.
- Любое другое значение отвергается argparse по `choices`; дополнительная защита от программной подмены — `raise ValueError(f"Invalid disaggregation_mode=...")` в `_handle_load_balance_method`.

## Когда использовать

- Нагрузка, где длинные промпты регулярно прерывают decode и рвут ITL: разделение убирает prefill-interruption и разбалансировку DP-attention, ради которых PD и сделан.
- Разные оптимальные конфигурации фаз: prefill выигрывает от большого `--chunked-prefill-size` и `deepep normal`, decode — от больших CUDA-графов и `deepep low_latency`. В монолите приходится выбирать одну.
- Не включайте ради «просто быстрее» на одной карте: две роли — это две копии весов и два набора KV-пулов, плюс сетевая перекачка KV на каждый запрос. Выигрыш появляется при нескольких GPU/узлах и достаточной сети.
- Не включайте без RDMA или без `mooncake_tcp`/`nixl`-конфигурации, которую вы проверили: `mooncake` по умолчанию ищет InfiniBand/RoCE-устройства.
- **В arriero не используйте.** См. раздел про arriero ниже.

## Влияние на производительность и память

- **VRAM.** Суммарно растет: веса модели живут в обеих ролях. На каждой роли, наоборот, освобождается память за счет выключенного графа противоположной фазы и (на decode) отсутствия prefill-буферов.
- **Хост.** Каждый сервер — самостоятельное дерево процессов (tokenizer manager, scheduler'ы по числу рангов, detokenizer). Умножайте RAM и число потоков на количество ролей.
- **Latency.** TTFT растет на время bootstrap-рукопожатия и перекачки KV; ITL, наоборот, стабилизируется, потому что decode больше не прерывается prefill-батчами.
- **Throughput.** Основной выигрыш — на смешанной нагрузке с длинными промптами и высокой конкурентностью; на коротких запросах накладные расходы перекачки съедают выигрыш.
- **Время старта.** Сокращается на стороне каждой роли (меньше графов), но общее время развертывания растет: узлы стартуют независимо и должны сойтись через bootstrap.

## Взаимодействие с другими аргументами

- `--disaggregation-transfer-backend`: чем и по какому транспорту переносится KV. На prefill `fake` запрещен.
- `--disaggregation-bootstrap-port`: на prefill — порт своего bootstrap-сервера, на decode — порт чужого; значения обязаны совпадать (или роутер должен передавать порт явно).
- `--disaggregation-ib-device`: проверяется и нормализуется только при `mooncake` **и** режиме `prefill`/`decode`.
- `--host` / `--port`: bootstrap-сервер садится на `--host` и отдельный порт; `--port` остается HTTP-фасадом роли.
- `--enable-pdmux`: взаимоисключающи, `PD-Multiplexing is not compatible with disaggregation mode`. Это другой способ совмещать фазы — на одной карте через green context.
- `--enable-prefill-cp`: допустим при `null`/`prefill`, на `decode` падает с явной подсказкой убрать флаг.
- `--enable-dsa-cache-layer-split`: разрешен **только** на `prefill`.
- `--dwdp-size`: требует `null` или `prefill`; при `null` печатает предупреждение, что это медленно.
- `--enable-unified-memory`: при любом ненулевом режиме требует `mooncake` и `--pp-size 1`.
- `--enable-linear-replayssm`: при ненулевом режиме отвергается.
- `--mamba-radix-cache-strategy extra_buffer_lazy`: требует `null`.
- `--load-balance-method`: `auto` разрешается по режиму.
- `--language-only` + `--disaggregation-mode prefill` — это EPD-развертывание (энкодер отдельно). `--encoder-only` с ненулевым режимом запрещен.
- Prefill-режим отключает `TC_PIECEWISE`-захват prefill-графа (`PD disaggregation` в списке несовместимостей `_disable_tc_piecewise_cudagraph_if_incompatible`).

## Типовые проблемы и диагностика

- Старт `prefill` прошел, но decode не видит рангов: ищите `CommonKVBootstrapServer started successfully on <host>:<port>` в логе prefill. Если вместо этого `Server error: ...` — порт занят, поток bootstrap умер, а HTTP-фасад продолжает отвечать 200 на `/health`. Отдельно проверьте `Prefill instance failed to register to bootstrap server after 5 retries`.
- Запрос на decode падает или висит: в нем нет `bootstrap_host`/`bootstrap_room`. Такие поля ставит роутер; прямой `curl` на decode-сервер не работает by design.
- `Currently disaggregation is not supported by diffusion LLM inference.` — режим сброшен в `null` из-за diffusion-LLM-пути; disaggregation в этом запуске не работает независимо от того, что вы задали.
- Старт висит на PD-warmup: см. `Start of pd disaggregation warmup ...` и следом либо `End of disaggregation warmup`, либо `Disaggregation warmup failed (mode=..., status codes: ...)`. Во втором случае `server_status` становится `UnHealthy`, и `/health_generate` это покажет.
- Таймауты передачи: `SGLANG_DISAGGREGATION_BOOTSTRAP_TIMEOUT` (300 c, prefill ждет KV-индексы от decode) и `SGLANG_DISAGGREGATION_WAITING_TIMEOUT` (300 c, decode ждет KV). Это переменные окружения, а не CLI.
- Принятое значение — в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).
- **Безопасность.** Bootstrap-сервер не аутентифицируется вообще: любой, кто дотянулся до `--disaggregation-bootstrap-port`, читает таблицу рангов через `GET /route` и может подменить регистрацию через `PUT /route`. Он обязан жить в доверенном сегменте; `--api-key` на него не распространяется.
- **В arriero.** Менеджер супервизирует **один** процесс на инстанс (`process/supervisor.ts` делает один `spawn` с собственной pgid), здоровье инстанса — HTTP `/health` этого одного процесса, а proxy-таргет указывает на один endpoint. Ни второй роли, ни роутера `sglang_router` в модели инстанса нет, и квалифицированный профиль KTransformers (`docs/KTRANSFORMERS_OPERATIONS.md`) описывает ровно один монолитный `sglang.launch_server`. Поэтому PD-развертывание сегодня лежит вне того, чем управляет arriero: инстанс с `--disaggregation-mode prefill` или `decode` поднимется и даже отдаст `/health` 200, но не будет обслуживать запросы через прокси. Оставляйте значение по умолчанию.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode prefill --port 30000 --disaggregation-ib-device mlx5_0
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --port 30001 --base-gpu-id 1 --disaggregation-ib-device mlx5_0 --max-running-requests 128
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/managers/disagg_service.py`
- `sglang/python/sglang/srt/disaggregation/utils.py`
- `sglang/python/sglang/srt/disaggregation/common/conn.py`
- `sglang/python/sglang/srt/disaggregation/prefill.py`
- `sglang/python/sglang/srt/disaggregation/decode.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/request_headers.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
- `sglang/docs/docs/advanced_features/sgl_model_gateway.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`
