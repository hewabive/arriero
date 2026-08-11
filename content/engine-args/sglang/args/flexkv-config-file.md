---
schema: 1
engine: sglang
primaryName: "--flexkv-config-file"
title: "--flexkv-config-file"
summary: Путь к YAML/JSON-конфигурации FlexKV. SGLang файл не читает: он только выставляет переменную `FLEXKV_CONFIG_PATH`, и делает это исключительно на пути `--enable-flexkv`.
group: memory
related:
  - --enable-flexkv
  - --radix-cache-backend
---

# --flexkv-config-file

## Кратко

`--flexkv-config-file` — удобная обертка над переменной окружения `FLEXKV_CONFIG_PATH`. Содержимое файла разбирает сам пакет FlexKV (`FlexKVConfig.from_env()`), SGLang его не открывает и не валидирует. Важная асимметрия: переменную выставляет только ветка `--enable-flexkv` в цепочке выбора кеша; при явном `--radix-cache-backend flexkv` этот аргумент остается прочитанным, но неиспользованным, и конфигурацию придется задавать переменной окружения вручную.

## Оригинальная справка

```text
Path to the FlexKV YAML / JSON configuration file. Equivalent to setting the FLEXKV_CONFIG_PATH environment variable.
```

## Паспорт аргумента

- Флаги: `--flexkv-config-file`
- Группа: `memory`
- Тип значения: строка — путь к файлу (`Optional[str]`)
- Допустимые значения: не ограничены; существование и формат проверяет пакет FlexKV
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется. Проброс в `FLEXKV_CONFIG_PATH` происходит только если переменная еще не выставлена (`if server_args.flexkv_config_file and not os.environ.get("FLEXKV_CONFIG_PATH")`) — то есть уже заданная переменная окружения имеет приоритет над аргументом
- Где объявлен: `ServerArgs.flexkv_config_file`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; смысл содержимого определяется внешним пакетом
- Этап применения: ветка `enable_flexkv` в `default_radix_cache_factory`, непосредственно перед созданием кеша

## Что меняет в движке

Единственное место чтения — `default_radix_cache_factory` (`sglang/python/sglang/srt/mem_cache/registry.py`):

```python
if server_args.flexkv_config_file and not os.environ.get("FLEXKV_CONFIG_PATH"):
    os.environ["FLEXKV_CONFIG_PATH"] = server_args.flexkv_config_file
return _flexkv_factory(ctx)
```

Дальше `FlexKVConnector.__init__` (`mem_cache/storage/flexkv/flexkv_connector.py`) вызывает `FlexKVConfig.from_env()`, который и читает файл по этой переменной. Из полученной конфигурации FlexKV берет `model_config`, `cache_config`, `server_recv_port`, `gpu_register_port` и остальное.

Ветка `_flexkv_factory`, вызываемая через реестр (`--radix-cache-backend flexkv`), переменную не выставляет — проброс живет только в ветке автовыбора.

## Значения и формат

- Строка-путь к YAML или JSON. Файл читается процессом scheduler'а, поэтому путь должен быть локальным и существовать к моменту инициализации кеша.
- Минимальный рабочий пример из документации интеграции — одна строка `cpu_cache_gb: 16`, что включает CPU-пул на 16 ГиБ. Остальные ключи (SSD, remote, распределенные настройки) описаны в примерах конфигурации FlexKV.
- Пустое значение или незаданный аргумент означают «конфигурировать FlexKV через переменные окружения».
- Уже выставленный `FLEXKV_CONFIG_PATH` побеждает: аргумент его не перетирает.

## Когда использовать

- Всегда вместе с `--enable-flexkv`, если конфигурацию FlexKV удобнее держать файлом, а не набором переменных окружения. Для arriero это предпочтительный вариант: окружение инстанса неизменяемо (`docs/ENVIRONMENTS.md`), а файл можно править и версионировать отдельно.
- Не используйте с `--radix-cache-backend flexkv`, рассчитывая на автоматический проброс: в этой ветке аргумент не читается. Либо переключитесь на `--enable-flexkv`, либо выставьте `FLEXKV_CONFIG_PATH` в окружении процесса.
- Не задавайте путь без включения FlexKV: значение просто не будет прочитано.

## Влияние на производительность и память

- Сам аргумент ресурсов не потребляет.
- Косвенно определяет все: размер CPU-пула FlexKV, использование SSD и удаленных уровней, режимы передачи. Именно из этого файла берется фактический расход RAM хоста, который в arriero нужно заложить в host memory draw инстанса (`docs/RESOURCE_MANAGEMENT.md`).
- На время старта влияет через инициализацию `KVManager` по прочитанной конфигурации.

## Взаимодействие с другими аргументами

- `--enable-flexkv`: единственный путь, на котором аргумент что-то делает.
- `--radix-cache-backend flexkv`: даст тот же класс кеша, но конфиг из этого аргумента до FlexKV не дойдет.
- Аргументы `--hicache-*` к FlexKV отношения не имеют.

## Типовые проблемы и диагностика

- FlexKV стартует с пустой/дефолтной конфигурацией, хотя путь задан — почти всегда это либо `--radix-cache-backend flexkv` вместо `--enable-flexkv`, либо уже выставленная в окружении переменная `FLEXKV_CONFIG_PATH` с другим значением.
- Ошибки разбора конфигурации приходят из FlexKV (`FlexKVConfig.from_env()`), а не из SGLang: сообщение будет в терминах пакета.
- Принятое значение аргумента видно в дампе `server_args=` при старте; фактически использованный путь — в переменной окружения процесса (`/proc/<pid>/environ`).
- Ветку кеша подтверждает строка «Tree cache initialized: source=… impl=FlexKVRadixCache».
- Файл читается процессом сервера: не храните в нем секреты, недопустимые для пользователя, от имени которого запущен инстанс.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --enable-flexkv --flexkv-config-file /etc/sglang/flexkv.yaml
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --page-size 64 --enable-flexkv --flexkv-config-file /srv/config/flexkv-ssd.json --mem-fraction-static 0.45
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/storage/flexkv/flexkv_connector.py`
- `sglang/python/sglang/srt/mem_cache/storage/flexkv/README.md`
- arriero: `docs/ENVIRONMENTS.md`, `docs/RESOURCE_MANAGEMENT.md`
