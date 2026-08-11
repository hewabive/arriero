---
schema: 1
engine: sglang
primaryName: "--disaggregation-bootstrap-port"
title: "--disaggregation-bootstrap-port"
summary: TCP-порт реестра рангов PD. На prefill-сервере это порт, который он слушает; на decode-сервере — порт чужого prefill, используемый как значение по умолчанию, когда роутер не прислал `bootstrap_port` в запросе.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --host
  - --port
  - --dist-init-addr
  - --nnodes
  - --node-rank
  - --api-key
---

# --disaggregation-bootstrap-port

## Кратко

Bootstrap-сервер PD — это маленькое aiohttp-приложение, поднимаемое в демон-потоке процесса tokenizer manager **только на prefill-сервере**. Через него decode узнает, на каких IP и портах слушают ZMQ-сокеты KV-менеджеров prefill'а и с какими параметрами (TP/DP/PP-размеры, `page_size`, dtype KV). Аргумент задает порт этого реестра. На decode-стороне тот же флаг означает совсем другое: порт, куда ходить, если роутер не положил `bootstrap_port` в запрос.

## Оригинальная справка

```text
Bootstrap server port on the prefill server. Default is 8998.
```

## Паспорт аргумента

- Флаги: `--disaggregation-bootstrap-port`
- Группа: `disagg`
- Тип значения: int
- Допустимые значения: `choices` нет; практически — свободный TCP-порт, не совпадающий с `--port`
- Значение по умолчанию: `8998`
- Эффективное значение: обычно совпадает с заданным. Два исключения: (1) при `SGLANG_RUST_SERVER` на prefill порт принудительно приравнивается к `--port` (`_alias_bootstrap_port_to_api_port`), потому что rust-сервер отдает реестр на своем же api-листенере; (2) при многоузловом prefill (`--nnodes > 1` и заданном `--dist-init-addr`) порт лидера broadcast'ится на все ранги (`_sync_bootstrap_port_across_nodes`), и локально заданное значение может быть заменено значением ранга 0
- Где объявлен: `ServerArgs.disaggregation_bootstrap_port`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_pd_disaggregation` (только rust-сервер) → `start_disagg_service` в tokenizer manager (prefill: bind) → `CommonKVManager.__init__` в каждом scheduler'е (prefill: регистрация, decode: адрес по умолчанию) → обработка каждого запроса на decode

## Что меняет в движке

### На prefill-сервере

`start_disagg_service` (`managers/disagg_service.py`) создает `<Backend>KVBootstrapServer(host=server_args.host, port=server_args.disaggregation_bootstrap_port)` и запускает его в демон-потоке. Реестр отдает:

```
PUT  /route              регистрация ранга prefill
GET  /route              запрос таблицы рангов (ходит decode)
POST /register_dp_rank   привязка bootstrap_room к DP-рангу
POST /query_dp_ranks
GET  /health
```

Каждый scheduler-ранг prefill'а при инициализации KV-менеджера делает `PUT /route` с полезной нагрузкой, куда входят `rank_ip`, `rank_port` (порт своего ZMQ PULL-сокета, выбираемый динамически), `attn_tp_size/rank`, `attn_cp_size/rank`, `attn_dp_size/rank`, `pp_size/rank`, `page_size`, `kv_cache_dtype`, `load_balance_method` и `prefill_http_port`. Хост, на который ранг стучится, зависит от развертывания: при заданном `--dist-init-addr` берется его хост (то есть узел 0), иначе — `--host` с заменой `0.0.0.0` → `127.0.0.1` и `::` → `::1`.

### На decode-сервере

Bootstrap-сервер не поднимается. Значение используется как **fallback**: в `Scheduler` при приеме запроса, если `recv_req.bootstrap_port is None`, подставляется `disaggregation_bootstrap_port`, после чего адрес реестра собирается как `req.bootstrap_host : req.bootstrap_port`. То есть на decode этот аргумент описывает чужой сервер, а хост всегда приходит из запроса.

### Многоузловой prefill

`_sync_bootstrap_port_across_nodes` broadcast'ит порт world-ранга 0 всем рангам prefill'а, если задан `--dist-init-addr` и `nnodes > 1`. Это нужно для launcher'ов, которые резервируют свободный порт на каждом хосте отдельно: без синхронизации не-лидеры регистрировались бы по `<leader_ip>:<свой порт>` и получали `Connection refused`. В логе видно `Synced disaggregation bootstrap port from leader: local=... -> leader=...`. Побочный эффект: на многоузловом prefill локально заданное значение может не совпасть с эффективным.

## Значения и формат

- Целое число порта. Проверки диапазона нет — argparse примет и `0`, и `70000`, ошибка вылезет при bind.
- Порт **не** проверяется на занятость перед стартом. Занятый порт не валит процесс: `_run_server` ловит исключение, пишет `Server error: ...` и поток умирает, HTTP-фасад продолжает работать.
- Не должен совпадать с `--port`, кроме режима `SGLANG_RUST_SERVER`, где, наоборот, обязан.
- Значение на decode обязано совпадать с портом того prefill, к которому его направит роутер, — либо роутер должен передавать порт явно (в `sglang_router` порт указывается вторым словом после prefill-URL: `--prefill http://prefill1:30001 9001`).

## Когда использовать

- Несколько prefill-серверов на одном хосте: разведите порты (`8998`, `8999`, …) и укажите каждому свой; decode получит нужный из запроса.
- Порт 8998 занят другим сервисом — простая перестановка.
- Одиночный prefill и роутер, который передает порт явно, — значение по умолчанию менять не нужно.
- Не задавайте на decode «на всякий случай» отличное от prefill значение: если роутер порт не пришлет, decode пойдет не туда и запрос повиснет до `SGLANG_DISAGGREGATION_WAITING_TIMEOUT`.

## Влияние на производительность и память

На память и throughput не влияет: через bootstrap-сервер идут только регистрации рангов и разовые запросы таблицы на запрос, KV по нему не передается. Косвенно влияет на TTFT: недоступный реестр превращается в ожидание до таймаута bootstrap'а, а не в быстрый отказ.

## Взаимодействие с другими аргументами

- `--disaggregation-mode`: слушающая сторона — только `prefill`; на `decode` значение работает как адрес по умолчанию; при `null` не используется.
- `--host`: bootstrap-сервер биндится именно на него, а не на `0.0.0.0` по умолчанию.
- `--port`: должен отличаться (кроме rust-сервера, где приравнивается).
- `--dist-init-addr` / `--nnodes` / `--node-rank`: при многоузловом prefill определяют, куда ранги регистрируются и включают broadcast порта лидера.
- `--disaggregation-transfer-backend`: определяет класс bootstrap-сервера, но у всех backend'ов это подклассы одного `CommonKVBootstrapServer` с одинаковым HTTP-контрактом.
- `--api-key`: **не** защищает bootstrap-сервер — это отдельный listener без аутентификации.

## Типовые проблемы и диагностика

- Подтверждение старта: `CommonKVBootstrapServer started successfully on <host>:<port>` в логе prefill. Отсутствие строки при наличии `Server error: [Errno 98] address already in use` — порт занят.
- `Prefill register attempt 1/5 failed: Connection refused` и затем `Prefill instance failed to register to bootstrap server after 5 retries` — реестр не поднялся или ранг стучится не туда (типично для многоузлового prefill с расходящимися портами).
- Decode долго висит и отваливается по таймауту: он ходит на `bootstrap_host:bootstrap_port` из запроса. Проверьте, что роутер отдает правильный порт, и что `--disaggregation-bootstrap-port` на decode совпадает с prefill'ом как минимум для fallback-пути.
- `ValueError: SGLANG_RUST_SERVER serves the PD KV bootstrap registry on the api port itself; --disaggregation-bootstrap-port ... conflicts with --port ...` — в rust-режиме флаг надо просто убрать.
- **Безопасность.** `GET /route` отдает всю таблицу рангов, `PUT /route` позволяет зарегистрировать произвольный ранг. Аутентификации нет. Порт должен быть закрыт от всего, кроме decode-серверов и роутера.
- Принятое значение — в дампе `server_args=` при старте; для многоузлового prefill сверяйте его со строкой `Synced disaggregation bootstrap port from leader: ...`.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode prefill --port 30000 --disaggregation-bootstrap-port 8996
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --disaggregation-mode decode --port 30001 --base-gpu-id 1 --disaggregation-bootstrap-port 8996
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/managers/disagg_service.py`
- `sglang/python/sglang/srt/disaggregation/common/conn.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
- `sglang/docs/docs/advanced_features/sgl_model_gateway.mdx`
