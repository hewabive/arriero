---
schema: 1
engine: sglang
primaryName: "--lmcache-config-file"
title: "--lmcache-config-file"
summary: Путь к YAML-конфигурации LMCache. В режиме по умолчанию (MP) обязателен — из него берутся `mp_host`/`mp_port`; SGLang файл не читает и не проверяет, это делает пакет `lmcache`.
group: memory
related:
  - --enable-lmcache
  - --radix-cache-backend
---

# --lmcache-config-file

## Кратко

`--lmcache-config-file` — единственный CLI-канал, через который SGLang передает LMCache его собственную конфигурацию. Файл не разбирается движком: строка целиком уходит в функции пакета `lmcache` (`lmcache_get_config` для MP-режима, `config_file` конструктора коннектора для layerwise-режима). Значение имеет смысл только вместе с `--enable-lmcache`, а в режиме по умолчанию без него сервер вообще не поднимется.

## Оригинальная справка

```text
Path to the LMCache YAML configuration file
```

## Паспорт аргумента

- Флаги: `--lmcache-config-file`
- Группа: `memory`
- Тип значения: строка — путь к файлу (`Optional[str]`)
- Допустимые значения: не ограничены; проверка существования и формата — на стороне пакета `lmcache`
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; читается из опубликованного конфига через `get_memory().lmcache_config_file`, пустая строка эквивалентна отсутствию
- Где объявлен: `ServerArgs.lmcache_config_file`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; смысл содержимого файла определяется внешним пакетом
- Этап применения: конструктор `LMCRadixCache` при построении дерева кеша

## Что меняет в движке

В `LMCRadixCache.__init__` (`sglang/python/sglang/srt/mem_cache/storage/lmcache/lmc_radix_cache.py`) значение читается как `cli_lmc_cfg = get_memory().lmcache_config_file or ""` и дальше используется по-разному в зависимости от режима:

- **MP (multi-process)** — режим по умолчанию на CUDA/ROCm. Пустое значение приводит к `ValueError("MP mode requires --lmcache-config-file (the YAML supplies mp_host / mp_port).")`. Иначе вызывается `lmcache_get_config(cli_lmc_cfg)`, и из полученного объекта берутся `mp_host` и `mp_port` для `LMCacheMPConnector`.
- **IP (in-process, layerwise)** — выбирается автоматически на XPU. Путь передается в `LMCacheLayerwiseConnector(config_file=cli_lmc_cfg, …)`; пустое значение здесь допустимо, и тогда LMCache берет конфигурацию из своих переменных окружения.

SGLang ни разу не открывает файл сам: ни существование пути, ни его формат он не проверяет.

## Значения и формат

- Строка-путь. Файл читается процессом scheduler'а на том же хосте, поэтому путь должен быть локальным и доступным на момент инициализации кеша.
- Формат — YAML в схеме LMCache; SGLang к его содержимому требований не предъявляет, кроме наличия `mp_host`/`mp_port` в MP-режиме.
- Пустая строка эквивалентна незаданному значению (в MP-режиме это ошибка).
- Аргумент без `--enable-lmcache` не читается вообще — `LMCRadixCache` в этом случае не создается.

## Когда использовать

- Всегда, когда задан `--enable-lmcache` на CUDA/ROCm: MP-режим без конфига не стартует.
- Когда нужно зафиксировать конфигурацию LMCache в файле рядом с определением инстанса вместо набора переменных окружения — для arriero это удобнее, поскольку окружение инстанса неизменяемо (`docs/ENVIRONMENTS.md`), а файл конфигурации можно править отдельно.
- Не задавайте путь «на будущее» без `--enable-lmcache`: значение просто не будет прочитано, и это создаст ложное впечатление настроенной интеграции.

## Влияние на производительность и память

- Сам аргумент ничего не выделяет и ни на что не влияет: он только указывает, откуда LMCache возьмет свои настройки.
- Косвенно определяет все: размеры пулов, адреса, режимы передачи задаются именно в этом файле, и он же определяет фактический расход RAM хоста и диска.
- На время старта влияет разве что через инициализацию LMCache по прочитанной конфигурации.

## Взаимодействие с другими аргументами

- `--enable-lmcache`: без него значение не читается.
- `--radix-cache-backend`: если задан явный backend, цепочка по умолчанию обходится и `LMCRadixCache` не создается — файл снова не будет прочитан.
- Аргументы `--hicache-*` к LMCache отношения не имеют: размеры и политики LMCache живут только в этом YAML.

## Типовые проблемы и диагностика

- `ValueError: MP mode requires --lmcache-config-file (the YAML supplies mp_host / mp_port).` — путь не задан в MP-режиме.
- Исключение из `lmcache_get_config` (отсутствие файла, невалидный YAML, отсутствие ожидаемых ключей) — ошибка приходит из пакета LMCache, а не из SGLang; сообщение будет в его терминах.
- Файл задан, но LMCache явно не используется — проверьте строку «Tree cache initialized: source=… impl=…»: если `impl` не `LMCRadixCache`, сработала более ранняя ветка цепочки выбора кеша.
- Принятое значение видно в дампе `server_args=` при старте.
- Файл читается процессом сервера: не храните в нем секреты, которые не должны быть доступны пользователю, от имени которого запущен инстанс.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-lmcache --lmcache-config-file /etc/sglang/lmcache.yaml
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-lmcache --lmcache-config-file /srv/config/lmcache-prod.yaml --enable-metrics
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/storage/lmcache/lmc_radix_cache.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- arriero: `docs/ENVIRONMENTS.md`
