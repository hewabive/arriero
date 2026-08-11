---
schema: 1
engine: sglang
primaryName: "--admin-api-key"
title: "--admin-api-key"
summary: Второй ключ, который отделяет управляющие endpoint'ы от обычных: заданный admin-ключ становится единственным принимаемым на ADMIN_OPTIONAL-маршрутах. Сам по себе он не закрывает генерацию, а /server_info выдает его любому, кто прошел обычную проверку.
group: serving
related:
  - --api-key
  - --host
  - --tokenizer-worker-num
  - --grpc-port
  - --enable-hierarchical-cache
  - --hicache-storage-backend
  - --ssl-certfile
---

# --admin-api-key

## Кратко

`--admin-api-key` задает отдельный Bearer-ключ для управляющих маршрутов. Правило простое и в справке сформулировано верно: когда admin-ключ задан, помеченные endpoint'ы принимают **только** его и **не** принимают `--api-key`.

Два следствия, которые в справке не написаны и которые определяют, как этим аргументом можно пользоваться:

1. **Admin-ключ сам по себе ничего не закрывает.** Если задан только он, все обычные (NORMAL) маршруты остаются полностью открытыми — включая `/generate`, `/v1/chat/completions`, `/v1/models` и `/server_info`. Разграничение возникает только в паре с `--api-key`.
2. **`/server_info` относится к обычному уровню и не редактирует ответ.** Он возвращает `dataclasses.asdict(server_args)` целиком, то есть выдает значение `admin_api_key`. Любой, кто прошел проверку `--api-key` (а при отсутствии `--api-key` — вообще любой), может прочитать admin-ключ одним GET-запросом. Апстрим-документация (`server_arguments.mdx`) относит `/server_info` к admin-only, но в коде декоратора `@auth_level` на нем нет — прав код.

## Оригинальная справка

```text
Set admin API key for sensitive management endpoints (e.g. /clear_hicache_storage_backend). When set, admin endpoints require this key and do NOT accept --api-key.
```

## Паспорт аргумента

- Флаги: `--admin-api-key`
- Группа: `serving`
- Тип значения: str (один ключ)
- Допустимые значения: не ограничены argparse; практически — только ASCII, потому что сверка идет через `secrets.compare_digest` по строкам
- Значение по умолчанию: `None` — отдельного admin-уровня нет, ADMIN_OPTIONAL-маршруты подчиняются `--api-key`
- Эффективное значение: совпадает с заданным. Косвенно: вместе с `--grpc-port` `__post_init__` бросает `ValueError`; при `--tokenizer-worker-num > 1` middleware не подключается вовсе, и ключ молча перестает что-либо охранять
- Где объявлен: `ServerArgs.admin_api_key`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (проверка совместимости с gRPC) → HTTP-слой, `add_api_key_middleware` при сборке приложения

## Что меняет в движке

### Матрица решений

`decide_request_auth` (`sglang/python/sglang/srt/utils/auth.py`) разбирает четыре сочетания ключей. Пути с префиксами `/health` и `/metrics`, а также метод `OPTIONS` пропускаются всегда, до всех проверок.

| `--api-key` | `--admin-api-key` | NORMAL-маршруты | ADMIN_OPTIONAL-маршруты |
| --- | --- | --- | --- |
| нет | нет | открыты | открыты |
| есть | нет | нужен `api_key` | нужен `api_key` |
| нет | **есть** | **открыты** | нужен `admin_api_key` |
| есть | есть | нужен `api_key` | нужен `admin_api_key`, `api_key` отвергается |

Третья строка — главная ловушка. Конфигурация «поставлю только admin-ключ, чтобы закрыть управление» оставляет генерацию, `/v1/models` и `/server_info` полностью анонимными, а `/server_info` при этом отдает admin-ключ.

### Какие маршруты считаются admin

Пометка ставится декоратором `@auth_level(AuthLevel.ADMIN_OPTIONAL)`. В текущем дереве их около сорока: `/flush_cache`, `/set_internal_state`, `/dumper/{method}`, вся группа `/update_weights_from_*` и `/update_weight_version`, `/init_weights_update_group` и `/destroy_weights_update_group`, `/get_weights_by_name`, `/weights_checker`, `/release_memory_occupation`, `/resume_memory_occupation`, `/slow_down`, `/pause_generation`, `/continue_generation`, `/abort_request`, `/load_lora_adapter`, `/unload_lora_adapter`, `/start_profile`, `/stop_profile`, `/freeze_gc`, `/configure_logging`, `/start_expert_distribution_record` и соседи, корпусные `/add_external_corpus`, `/remove_external_corpus`, `/list_external_corpora`, группа `/hicache/storage-backend*` и устаревший `/clear_hicache_storage_backend`, плюс два маршрута elastic-EP.

Заметные исключения, которые остаются на обычном уровне: `/server_info`, `/model_info`, `/v1/loads`, `/set_trace_level` и `/load_lora_adapter_from_tensors` — последний позволяет подгрузить LoRA-адаптер из тензоров, но, в отличие от `/load_lora_adapter`, admin-ключом не защищен.

### Отдельная жесткая проверка у HiCache

Три обработчика — `PUT /hicache/storage-backend`, `DELETE /hicache/storage-backend` и `GET /hicache/storage-backend` — дополнительно начинаются со строки

```python
if not _global_state.tokenizer_manager.server_args.admin_api_key:
    return _admin_api_key_missing_response()
```

то есть **отказывают вообще всем**, если admin-ключ не задан, с текстом «This endpoint requires admin API key, but this server was started without one (admin-api-key). Restart with --admin-api-key to enable.» и кодом 403. Это единственная группа маршрутов, для которых `--admin-api-key` не «усиление», а обязательное условие работы. В комментарии рядом прямо сказано, что это временная имитация уровня ADMIN_FORCE, который в middleware реализован, но ни на один маршрут пока не навешен.

## Значения и формат

- Один ключ, `nargs` не задан.
- Пустая строка отключает admin-уровень так же, как его отсутствие: `if admin_api_key:` — ложное значение уводит логику в ветку обычного ключа.
- Не-ASCII приводит к `TypeError` в `secrets.compare_digest` при первой же попытке проверки.
- Ключ должен отличаться от `--api-key`. Технически одинаковые значения допустимы, но тогда разделения нет вовсе.

## Когда использовать

- Когда сервер обслуживает несколько потребителей и вы хотите, чтобы «горячие» операции (подмена весов, сброс кеша, профилирование, пауза генерации) требовали отдельного ключа. Только вместе с `--api-key` — иначе см. третью строку матрицы.
- Обязательно, если вы собираетесь управлять HiCache-бэкендом через `PUT`/`DELETE`/`GET /hicache/storage-backend`: без admin-ключа эти маршруты недоступны никому.
- Не нужен, если сервер слушает только петлю и обслуживается через прокси arriero: там управляющие маршруты вообще не должны быть достижимы снаружи, а внутрь ключ не добавляет ничего, что не давал бы `--host 127.0.0.1`.
- Не считайте его границей привилегий, пока `/server_info` открыт: держатель обычного ключа читает admin-ключ из ответа этого маршрута.

## Влияние на производительность и память

Не влияет ни на VRAM, ни на RAM, ни на скорость: разница с одним ключом — одна дополнительная проверка непустой строки на запрос.

## Взаимодействие с другими аргументами

- `--api-key`: единственная осмысленная пара. Без него admin-ключ не закрывает генерацию.
- `--tokenizer-worker-num`: значение больше 1 отключает всю аутентификацию — middleware подключается только в ветке `tokenizer_worker_num == 1`. При этом, в отличие от `--api-key`, для admin-ключа нет ни assert'а, ни предупреждения: сервер спокойно стартует, а ADMIN_OPTIONAL-маршруты остаются открытыми. Проверять это надо самому.
- `--grpc-port`: `ValueError: --grpc-port is incompatible with --api-key/--admin-api-key`.
- `--enable-hierarchical-cache` / `--hicache-storage-backend`: маршруты рантайм-управления HiCache требуют заданного admin-ключа безусловно.
- `--host`, `--ssl-certfile`: сетевая граница и шифрование канала; admin-ключ по HTTP без TLS уходит открытым текстом.

## Типовые проблемы и диагностика

- **Симптом:** `401` на `/flush_cache` или `/update_weights_from_disk`, хотя `--api-key` передан правильно. **Причина:** задан также `--admin-api-key`, и обычный ключ на этих маршрутах отвергается по определению. **Лечение:** слать admin-ключ.
- **Симптом:** `403` с текстом «This endpoint requires admin API key, but this server was started without one». **Причина:** запрос к `/hicache/storage-backend` при незаданном `--admin-api-key`. **Лечение:** перезапустить сервер с ключом.
- **Симптом:** admin-ключ задан, а управляющие маршруты открыты без него. **Причина:** `--tokenizer-worker-num > 1`, middleware не подключено. **Проверка:** `curl -i -X POST http://127.0.0.1:30000/flush_cache` без заголовка — 200 вместо 401 подтверждает диагноз. **Лечение:** вернуть `--tokenizer-worker-num 1`.
- **Симптом:** генерация доступна всем, хотя admin-ключ задан. **Причина:** не задан `--api-key`; NORMAL-маршруты открыты. **Лечение:** задать оба ключа.
- **Утечка:** `curl -s http://127.0.0.1:30000/server_info | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['api_key'], d['admin_api_key'])"` возвращает оба ключа. Плюс те же значения видны в `/proc/<pid>/cmdline` и в строке `server_args=` лога старта.

## В arriero

- Управляющие маршруты SGLang менеджер не использует: kind `ktransformers` объявлен без нативной панели (`nativeApi: "none"`), без `modelLoadUnload` и без `slotSave` (`packages/core/src/engine-descriptor.ts`), а проксирование ходит только в `/v1/*`. Поэтому `--admin-api-key` не мешает работе менеджера — но и не приносит пользы.
- Единственный сценарий, в котором он оправдан, — инстанс, до которого дотягивается кто-то помимо менеджера. В штатном профиле (`docs/KTRANSFORMERS_OPERATIONS.md`) этого нет: сервер слушает петлю, наружу смотрит прокси arriero с собственными источниками запросов.
- Значение ключа попадает в `config/instances/<name>.json` и в `runtime/logs/<instance>.raw.log` (строка `server_args=`). Если каталог конфигурации ведется как git-репозиторий (`docs/CONFIG_GIT.md`), ключ окажется в истории коммитов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --api-key 3f2a9c7e1b4d8065 --admin-api-key 9d41c0b7ae23f158
```

```bash
curl -sS -i -X POST -H "Authorization: Bearer 9d41c0b7ae23f158" http://127.0.0.1:30000/flush_cache
```

## Источники

- `sglang/python/sglang/srt/utils/auth.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/CONFIG_GIT.md`
