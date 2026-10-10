---
schema: 1
engine: sglang
primaryName: "--hicache-storage-backend-extra-config"
title: "--hicache-storage-backend-extra-config"
summary: Единственный канал настройки L3-хранилища HiCache — JSON-строка или файл с `@`-префиксом. Часть ключей движок вынимает себе (пороги и тайм-ауты prefetch), остальное уходит в backend без разбора.
group: memory
related:
  - --hicache-storage-backend
  - --hicache-storage-prefetch-policy
  - --enable-hierarchical-cache
  - --hicache-mem-layout
  - --tp-size
---

# --hicache-storage-backend-extra-config

## Кратко

`--hicache-storage-backend-extra-config` — словарь настроек для уровня L3. Он выполняет две разные роли одновременно: несколько ключей движок **изымает** из словаря себе (порог prefetch, параметры линейного тайм-аута, режим передачи префиксных ключей), а все, что осталось, отдается конкретному backend'у как есть. Для `--hicache-storage-backend dynamic` этот аргумент обязателен — именно в нем указывается, какой класс грузить. Формат — либо JSON-строка в командной строке, либо путь к файлу с ведущим `@`.

## Оригинальная справка

```text
A dictionary in JSON string format, or a string starting with a leading '@' and a config file in JSON/YAML/TOML format, containing extra configuration for the storage backend.
```

## Паспорт аргумента

- Флаги: `--hicache-storage-backend-extra-config`
- Группа: `memory`
- Тип значения: строка (`Optional[str]`) — JSON-объект либо `@<путь к файлу>`
- Допустимые значения: не ограничены argparse; разбор и валидация происходят уже при инициализации кеша
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; разобранный словарь теряет изъятые движком ключи до того, как попадет в backend
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.hicache_storage_backend_extra_config`
- Статус: обычный
- Этап применения: `HybridCacheController.parse_storage_backend_extra_config` из `UnifiedRadixCache.init_hicache` при инициализации дерева кеша (а также из `StorageAttachment.attach` при рантайм-подключении backend'а через `PUT /hicache/storage-backend`)

## Что меняет в движке

Отдельного `HiRadixCache` больше нет. Разбор выполняет статический `HybridCacheController.parse_storage_backend_extra_config` (`sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_cache_controller.py`); вызывают его `UnifiedRadixCache.init_hicache` на старте и `StorageAttachment.attach` при рантайм-подключении:

1. Если строка начинается с `@`, остаток трактуется как путь к файлу, а формат определяется по расширению: `.json`, `.toml` (через `tomllib`, файл открывается в бинарном режиме), `.yaml`/`.yml` (через `yaml.safe_load`). Прочие расширения — `ValueError: Unsupported config file … (config format: …)`.
2. Иначе строка разбирается как JSON-объект.
3. Из полученного словаря **вынимаются** (`pop`) и проверяются по типу:
   - `prefetch_threshold` (int, по умолчанию 256) — минимальная длина совпадения в L3, при которой вообще запускается prefetch; дальше берется `max(prefetch_threshold, page_size)`;
   - `prefetch_timeout_base` (число, 1 с) — фиксированная часть тайм-аута;
   - `prefetch_timeout_per_ki_token` (число, 0.25 с на 1024 токена) — линейная часть;
   - `hicache_storage_pass_prefix_keys` (bool, `False`) — передавать ли backend'у хеши префиксных узлов при записи.
4. Остаток словаря уходит в `HybridCacheController` (наследник `HiCacheController`) и через `HiCacheStorageConfig.extra_config` — в конструктор backend'а.

Ключ `prefetch_timeout_max`, который до сих пор описывает апстрим-документация (`hicache_design.mdx`, `hicache_storage_runtime_attach_detach.mdx`), код больше не изымает: он остается в остатке, уходит backend'у и на тайм-аут prefetch не влияет — потолка у тайм-аута нет.

Часть остаточных ключей читает не сам backend, а контроллер: `tp_lcm_size` в `_generate_storage_config` включает разбиение по головам для heterogeneous-TP (только для не-MLA моделей и только при `--hicache-mem-layout page_head`), `interface_v1` у `dynamic` включает zero-copy пути чтения/записи, `allocator: "shm"` у `dynamic` переключает аллокатор host-пула на shared memory (только при inline-JSON: `get_allocator_type` в `mem_cache/pool_host/common.py` разбирает строку как JSON, и `@`-файл этот ключ не включает).

Для `--hicache-storage-backend dynamic` обязательны три ключа: `backend_name`, `module_path`, `class_name`; их отсутствие — `ValueError: Missing required field '<field>' …`.

## Значения и формат

- JSON-строка: `'{"prefetch_threshold": 512, "prefetch_timeout_base": 0.5}'`. Кавычки обязательно одинарные снаружи, двойные внутри — иначе shell съест их.
- Файл: `"@/etc/sglang/hicache.toml"`. Расширение определяет парсер; для сложных конфигураций (типично NIXL) апстрим рекомендует именно файл.
- Значение должно разбираться в **объект**. Массив или скаляр приведет к ошибке на первом же `pop`.
- Неверный JSON на старте — необработанный `json.JSONDecodeError` из `json.loads` в трассировке падения scheduler'а, то есть отказ старта; при рантайм-подключении — ответ «Failed to parse storage_backend_extra_config_json '…': …», в логе `Failed to parse storage_backend_extra_config_json: …` с трассировкой, сервер продолжает работать.
- Неверный тип у изъятых ключей — `ValueError: prefetch_threshold must be int, got …` и аналогичные.
- Аргумент имеет смысл только вместе с `--hicache-storage-backend`: без L3 словарь разбирается, но backend, которому его передать, не создается.

## Когда использовать

- Настроить агрессивность prefetch: `prefetch_threshold` вверх, если L3 медленный и не хочется дергать его на коротких совпадениях; параметры тайм-аута — под целевой SLO при `--hicache-storage-prefetch-policy timeout`.
- Передать backend'у его собственные настройки (адреса, пути, параметры репликации) — у большинства интеграций это единственный CLI-канал помимо переменных окружения.
- Подключить свой класс хранилища без правки исходников SGLang — через `dynamic`.
- Настроить heterogeneous-TP переиспользование: `tp_lcm_size` = НОК всех `--tp-size`, которые делят одно хранилище, вместе с `--hicache-mem-layout page_head`.
- Не трогайте, если L3 — `file` и вас устраивают дефолты: все изымаемые ключи имеют разумные значения.

## Влияние на производительность и память

- `prefetch_threshold` напрямую управляет числом обращений к L3: слишком низкий порог создает поток мелких запросов, слишком высокий обесценивает L3 на средних префиксах.
- Тайм-ауты определяют хвост TTFT при промахе L3: бюджет `base + per_ki_token * tokens / 1024`, где `tokens` — длина предзагрузки, кратная странице; верхнего потолка нет.
- `hicache_storage_pass_prefix_keys: true` добавляет вычисление и передачу хешей префиксных узлов при каждой записи — небольшой, но постоянный CPU-оверхед.
- Прямого расхода памяти у самого аргумента нет; косвенно `allocator: "shm"` меняет способ выделения host-пула.

## Взаимодействие с другими аргументами

- `--hicache-storage-backend`: обязательный партнер; для `dynamic` этот аргумент обязателен и должен содержать три ключа загрузки.
- `--hicache-storage-prefetch-policy`: ключи `prefetch_timeout_*` работают только при политике `timeout`; `prefetch_threshold` — при любой.
- `--page-size`: фактический порог prefetch — `max(prefetch_threshold, page_size)`, то есть при крупной странице маленький порог не имеет эффекта.
- `--hicache-mem-layout page_head`: необходим, чтобы `tp_lcm_size` включил head-shard.
- `--tp-size`: `tp_lcm_size` должен делиться на `tp_size` нацело, иначе ассерт «tp_lcm_size must be divisible by tp_size.».
- `--enable-hierarchical-cache`: без него ветка HiCache не строится.

## Типовые проблемы и диагностика

- `json.decoder.JSONDecodeError` при старте или «Failed to parse storage_backend_extra_config_json …» в ответе рантайм-эндпоинта — сломанный JSON или неверные кавычки в shell.
- `ValueError: Unsupported config file … (config format: …)` — у `@`-файла расширение не из списка `.json`/`.toml`/`.yaml`/`.yml`.
- `ValueError: prefetch_threshold must be int, got float` — в JSON написано `512.0` вместо `512`.
- Ассерт «tp_lcm_size must be divisible by tp_size.» — неверный НОК для heterogeneous-TP.
- Backend не видит ваш ключ — проверьте, не входит ли он в список изымаемых движком: `prefetch_threshold`, `prefetch_timeout_base`, `prefetch_timeout_per_ki_token`, `hicache_storage_pass_prefix_keys` до backend'а не доходят. `tp_lcm_size` изымает уже контроллер в `_generate_storage_config`.
- Задали `prefetch_timeout_max`, а длинные предзагрузки все равно ждут дольше — ключ не читается движком (см. выше).
- Текущий словарь можно посмотреть в ответе `GET /hicache/storage-backend`; при рантайм-подключении он передается полем `hicache_storage_backend_extra_config_json`.
- Файл конфигурации попадает в процесс как есть: не кладите в него секреты, которые не должны читаться из-под пользователя сервера.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-storage-backend file --hicache-storage-backend-extra-config '{"prefetch_threshold": 512, "prefetch_timeout_base": 0.5, "prefetch_timeout_per_ki_token": 0.25}'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-storage-backend dynamic --hicache-storage-backend-extra-config '{"backend_name": "my_kv", "module_path": "my_pkg.hicache", "class_name": "MyHiCacheStorage"}'
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/hybrid_cache/hybrid_cache_controller.py`
- `sglang/python/sglang/srt/mem_cache/unified_radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/unified_cache/storage_attachment.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/common.py`
- `sglang/python/sglang/srt/mem_cache/hicache_storage.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/python/sglang/srt/mem_cache/storage/backend_factory.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_best_practices.mdx`
