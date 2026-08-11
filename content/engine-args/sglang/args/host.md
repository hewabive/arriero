---
schema: 1
engine: sglang
primaryName: "--host"
title: "--host"
summary: Адрес, на котором открывается сокет HTTP-сервера, и одновременно адрес рандеву torch.distributed на одном узле. По умолчанию это петля — менять на 0.0.0.0 означает открыть наружу весь native API, включая управляющие endpoint'ы.
group: serving
related:
  - --port
  - --api-key
  - --admin-api-key
  - --ssl-certfile
  - --fastapi-root-path
  - --enable-http2
  - --grpc-port
  - --dist-init-addr
  - --nccl-port
  - --enable-dp-attention
---

# --host

## Кратко

`--host` задает адрес привязки HTTP-сервера (uvicorn или Granian) и попадает в несколько других мест: адрес нативного gRPC-сервера, bootstrap-сервера PD-disaggregation и — что важнее всего — адрес рандеву `torch.distributed`, если не задан `--dist-init-addr`.

Главное отличие от vLLM: у SGLang **дефолт безопасный** — `127.0.0.1`. Незаданный `--host` означает петлю, а не все интерфейсы. Соответственно, вопрос стоит не «закрыть ли», а «стоит ли открывать»: `--host 0.0.0.0` выставляет наружу не только `/v1/*`, но и весь native API, где по умолчанию нет никакой аутентификации.

## Оригинальная справка

```text
The host of the HTTP server.
```

## Паспорт аргумента

- Флаги: `--host`
- Группа: `serving`
- Тип значения: str (IP-литерал или имя хоста)
- Допустимые значения: `choices` нет; строка должна разрешаться в адрес локального интерфейса, иначе `bind` упадет
- Значение по умолчанию: `127.0.0.1`
- Эффективное значение: совпадает с заданным. Ни один `_handle_*` не переписывает `host`. Производные значения считаются от него: `ServerArgs.url()` подменяет `0.0.0.0` на `127.0.0.1` и `::` на `::1` для внутренних запросов (warmup, health-проверка самого себя), а `_resolve_dist_init_method` берет `self.host or "127.0.0.1"` как адрес TCPStore
- Где объявлен: `ServerArgs.host`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (только производные URL) → запуск процессов и `init_torch_distributed` (адрес рандеву) → HTTP-слой (`uvicorn.run(host=...)` / `Granian(address=...)`)

## Что меняет в движке

На вычисления не влияет: значение целиком уходит в сетевой слой. Маршрутов у него четыре.

1. **HTTP-сокет.** `_setup_and_run_http_server` (`entrypoints/http_server.py`) передает `host=server_args.host` в `uvicorn.run` во всех трех ветках (обычная, `--enable-ssl-refresh`, multi-worker) и в `_run_granian_server(address=host, ...)` при `--enable-http2`. Сокет открывается **после** загрузки весов и старта scheduler'ов: `launch_server` сначала ждет `wait_for_ready()`, поэтому порт молчит все время загрузки модели.
2. **Внутренние запросы движка к самому себе.** `ServerArgs.url()` строит адрес для warmup-запроса (`/model_info`, потом `/generate`), подставляя петлю вместо wildcard-адресов. Схема выбирается по `--ssl-certfile`: `https` если он задан, иначе `http`.
3. **Рандеву `torch.distributed`.** Без `--dist-init-addr` метод инициализации — `tcp://<host>:<nccl_port>` (`distributed/bootstrap.py:_resolve_dist_init_method`). То есть `--host 0.0.0.0` выносит TCPStore на все интерфейсы, а `--host 127.0.0.1` держит его на петле. Порт — `--nccl-port` либо случайный свободный.
4. **Дополнительные слушатели.** Нативный gRPC-сервер (`--grpc-port`), sidecar, bootstrap-сервер PD-disaggregation и encode-сервер тоже биндятся на `server_args.host`.

### Что именно открывает `--host 0.0.0.0`

Auth-middleware подключается **только** если задан `--api-key` или `--admin-api-key` (`http_server.py:_setup_and_run_http_server`). Без них на открытом интерфейсе доступны без всякой проверки, кроме прочего:

- генерация: `/generate`, `/v1/chat/completions`, `/v1/completions`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`, ollama-совместимые `/api/chat` и `/api/generate`;
- **`/server_info`** — отдает `dataclasses.asdict(server_args)` без какой-либо редакции, то есть выдает `api_key`, `admin_api_key` и `ssl_keyfile_password` открытым текстом;
- управление весами: `/update_weights_from_disk`, `/update_weights_from_tensor`, `/update_weights_from_distributed`, `/init_weights_update_group`;
- управление ресурсами: `/release_memory_occupation`, `/resume_memory_occupation`, `/flush_cache`, `/pause_generation`, `/slow_down`, `/freeze_gc`;
- LoRA: `/load_lora_adapter`, `/unload_lora_adapter`;
- профилирование и дампы: `/start_profile`, `/stop_profile`, `/dump_expert_distribution_record`, `/set_internal_state`.

`/health` по умолчанию не просто отвечает 200, а ставит в очередь реальную генерацию одного токена (`SGLANG_ENABLE_HEALTH_ENDPOINT_GENERATION` по умолчанию `True`) и ждет ответа минимум секунду. На открытом порту это дешевый способ нагрузить планировщик.

## Значения и формат

- `127.0.0.1` (по умолчанию) — только петля. Единственный вариант, при котором нужный уровень доступа обеспечен без дополнительных мер.
- `0.0.0.0` — все интерфейсы IPv4. `ServerArgs.url()` знает про это значение и подставляет петлю для внутренних вызовов, так что warmup продолжает работать.
- `::` — все интерфейсы IPv6, внутренние вызовы идут на `::1`.
- Конкретный адрес интерфейса — рабочий вариант для многоузлового запуска; при этом `--dist-init-addr` обычно задают явно, чтобы отвязать рандеву от HTTP-адреса.
- Имя хоста допустимо, отдельной валидации в SGLang нет — разрешение делает `bind`.
- Пустая строка технически принимается argparse; `url()` трактует ее как петлю, а `bind("")` для `AF_INET` — как все интерфейсы. Не используйте: поведение расходится между слоями.
- Несуществующий на машине адрес приводит к `OSError: [Errno 99] Cannot assign requested address` уже после загрузки весов — сокет открывается последним, поэтому вы потеряете все время старта.

## Когда использовать

- Оставляйте дефолт `127.0.0.1` для любого инстанса, который обслуживается через прокси arriero: наружу смотрит менеджер, движку внешний интерфейс не нужен.
- Задавайте конкретный адрес, только если к серверу должен ходить другой узел, и тогда обязательно закрывайте порт файрволом — `--api-key` (см. `api-key.md`) не закрывает `/health` и `/metrics` и не спасает от того, что ключ виден в `/server_info` любому, кто прошел ту же проверку.
- Не выставляйте `0.0.0.0` «чтобы проверить с ноутбука». Одноразовая проверка делается через `ssh -L 30000:127.0.0.1:30000`, а не сменой аргумента запуска.

## Влияние на производительность и память

Нулевое: аргумент не трогает ни VRAM, ни RAM, ни время старта. Единственный эффект — какой сокет создается и на каком адресе поднимается TCPStore.

## Взаимодействие с другими аргументами

- `--port`: пара, задающая точку прослушивания.
- `--dist-init-addr`: при заданном адресе рандеву `--host` перестает влиять на `torch.distributed`; без него адрес берется из `--host`.
- `--nccl-port`: порт того же рандеву; вместе с `--host 0.0.0.0` это второй открытый наружу слушатель.
- `--enable-dp-attention` на одном узле без `--dist-init-addr` дополнительно занимает шесть TCP-портов от `--port + 233` (при переполнении — `--port − 233`), но привязывает их к `127.0.0.1` жестко, независимо от `--host`.
- `--grpc-port`: нативный gRPC поднимается на том же `--host`; `__post_init__` при этом запрещает комбинацию с `--api-key`/`--admin-api-key`, потому что gRPC-слушатель обходит HTTP-middleware.
- `--api-key` / `--admin-api-key`: единственная встроенная аутентификация, и она не покрывает `/health*` и `/metrics*`.
- `--ssl-certfile` / `--ssl-keyfile`: если сервер слушает не петлю, трафик и заголовок `Authorization` должны идти по TLS.
- `--enable-http2`: адрес передается в Granian как `address`, поведение по привязке то же.

## Типовые проблемы и диагностика

- **Симптом:** сервер отвечает с другой машины, хотя «ничего не открывали». **Причина:** `--host 0.0.0.0` в аргументах или в YAML-конфиге `--config` (в примерах апстрим-документации `server_arguments.mdx` в конфиге стоит именно `host: 0.0.0.0`). **Проверка:** `ss -ltnp | grep <port>` и строка `server_args=` в логе старта. **Лечение:** убрать аргумент, дефолт безопасен.
- **Симптом:** `OSError: [Errno 99] Cannot assign requested address` в конце старта. **Причина:** адреса нет ни на одном интерфейсе. **Лечение:** взять адрес из `ip -brief addr`.
- **Симптом:** на хосте видно больше слушателей, чем ожидалось. **Причина:** `--host` тиражируется на TCPStore, gRPC и bootstrap-сервер. **Проверка:** `ss -ltnp | grep sglang`.
- **Симптом (arriero):** preflight пишет `Host <адрес> is not available on this machine` или `Port <N> is already in use on <адрес>`. **Причина:** менеджер перед запуском пробует сам забиндить `host:port` (`apps/api/src/process/preflight.ts`). **Лечение:** исправить адрес или освободить порт.
- **Симптом (arriero):** инстанс запущен, но health не подтверждается. **Как устроено:** менеджер строит адрес инстанса из `--host`/`--port` (`engineDescriptor("ktransformers").http.hostArgKeys`), подменяя `0.0.0.0` и `::` на `127.0.0.1`, и опрашивает `/health` и `/v1/models`. **Лечение:** адрес должен быть виден менеджеру локально; петля подходит всегда.
- **Гигиена:** привязка HTTP к петле не закрывает остальные слушатели автоматически — при `--dist-init-addr` с внешним адресом рандеву остается открытым. Проверяйте `ss -ltnp`, а не только `--host`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 10.0.0.5 --port 30000 --api-key local-only-key --ssl-certfile /etc/ssl/sglang.crt --ssl-keyfile /etc/ssl/sglang.key
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/utils/auth.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `docs/KTRANSFORMERS_OPERATIONS.md`
