---
schema: 1
engine: sglang
primaryName: "--radix-cache-backend"
title: "--radix-cache-backend"
summary: Точка расширения: подставляет вместо встроенного выбора кеша фабрику, зарегистрированную через `register_radix_cache_backend`. Реестр по умолчанию пуст, поэтому почти всегда флаг задавать не нужно.
group: memory
related:
  - --enable-flexkv
  - --enable-lmcache
  - --enable-hierarchical-cache
  - --enable-session-radix-cache
  - --enable-int8-mamba-checkpoint
  - --enable-streaming-session
---

# --radix-cache-backend

## Кратко

`--radix-cache-backend` полностью обходит встроенную цепочку выбора кеша и берет фабрику из реестра по имени. Имена в реестр попадают только из кода: встроенных значений нет, регистрируется лишь `flexkv` — и то в момент импорта своего пакета, то есть при обычном старте реестр пуст. Практически флаг нужен в двух случаях: у вас есть свой backend, зарегистрированный плагином, либо вы явно выбираете `flexkv` в среде, где его модуль уже импортирован. Во всех остальных сценариях правильнее пользоваться `--enable-hierarchical-cache`, `--enable-lmcache` или `--enable-flexkv`.

## Оригинальная справка

```text
Name of a radix-cache backend previously registered via register_radix_cache_backend. Omit this flag to use the built-in default cache selection chain.
```

## Паспорт аргумента

- Флаги: `--radix-cache-backend`
- Группа: `memory`
- Тип значения: строка (`Optional[str]`)
- Допустимые значения: `choices` не заданы — список собирается в runtime реестром `_RADIX_CACHE_REGISTRY` (`sglang/python/sglang/srt/mem_cache/registry.py`). Посмотреть фактический набор на своей сборке можно вызовом `registered_radix_cache_backends()` после импорта нужных пакетов; при неверном имени движок печатает список в тексте ошибки
- Значение по умолчанию: `null` — используется встроенная цепочка выбора
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.radix_cache_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; фактическое поведение целиком зависит от стороннего кода, регистрирующего фабрику
- Этап применения: `create_tree_cache` при построении дерева кеша в scheduler'е

## Что меняет в движке

`create_tree_cache` (`sglang/python/sglang/srt/mem_cache/registry.py`) устроен так:

```python
name = ctx.server_args.radix_cache_backend
if name:
    factory = get_radix_cache_factory(name)
    if factory is None:
        raise ValueError(f"--radix-cache-backend={name!r} is not registered. …")
    cache = factory(ctx)
    source = f"registered({name!r})"
else:
    cache = default_radix_cache_factory(ctx)
    source = "default"
```

То есть при заданном имени **вся** цепочка по умолчанию пропускается: не проверяются ни `--disable-radix-cache` (ChunkCache), ни hybrid-SWA/SSM, ни `--enable-hierarchical-cache`, ни `--enable-lmcache`, ни `--enable-flexkv`. Ответственность за корректность объекта лежит на фабрике.

Регистрация выполняется функцией `register_radix_cache_backend(name, factory)`; она отвергает пустое имя и повторную регистрацию. Внешние пакеты обычно делают это на импорте — SGLang загружает плагины из entry-point группы `sglang.srt.plugins` в `load_plugins()` (`entrypoints/engine.py`), с фильтром по переменной `SGLANG_PLUGINS`.

Единственная регистрация в самом репозитории — `register_radix_cache_backend("flexkv", _flexkv_factory)` в `mem_cache/storage/flexkv/__init__.py`. Но этот пакет импортируется только внутри ветки `--enable-flexkv`, поэтому при старте с одним лишь `--radix-cache-backend flexkv` реестр пуст и вы получите ошибку «is not registered. Registered backends: []».

После создания объекта `create_tree_cache` выполняет две общие проверки: при `--enable-session-radix-cache` кеш обязан поддерживать сессии (иначе `ValueError` с требованием `SGLANG_ENABLE_UNIFIED_RADIX_TREE=1`), а при `--enable-streaming-session` кеш, не поддерживающий стриминг, оборачивается в `StreamingSession`.

## Значения и формат

- Строка — точное имя, под которым фабрика зарегистрирована. Регистр учитывается.
- Пустое/незаданное значение возвращает управление встроенной цепочке; это и есть нормальный режим.
- Проверки имени на этапе argparse нет: несуществующее имя обнаружится только при инициализации scheduler'а, то есть после загрузки весов.

## Когда использовать

- У вас есть собственная реализация префиксного кеша, поставляемая пакетом-плагином: это единственный поддерживаемый способ ее подключить без правки исходников SGLang.
- Вы отлаживаете такой плагин и хотите обойти автовыбор.
- Для FlexKV предпочитайте `--enable-flexkv`: он и импортирует пакет (то есть регистрирует имя), и пробрасывает `--flexkv-config-file` в `FLEXKV_CONFIG_PATH`.
- Не используйте флаг как «переключатель между HiCache и LMCache» — эти реализации в реестре не зарегистрированы.

## Влияние на производительность и память

- Сам аргумент ресурсов не потребляет.
- Все характеристики (расход RAM, VRAM, поведение при вытеснении, стоимость поиска префикса) определяются подставленной фабрикой; предсказать их по этому флагу нельзя.
- Косвенный, но важный эффект: обход цепочки означает, что привычные гарантии (ChunkCache при `--disable-radix-cache`, специальные деревья для hybrid-моделей) не действуют — если фабрика их не воспроизводит, поведение может отличаться радикально.

## Взаимодействие с другими аргументами

- `--enable-flexkv`, `--enable-lmcache`, `--enable-hierarchical-cache`, `--disable-radix-cache`: при заданном backend'е ни один из них не участвует в выборе класса кеша (флаги при этом продолжают влиять на другие подсистемы и на проверки в `__post_init__`).
- `--enable-session-radix-cache`: после создания кеша проверяется наличие поддержки сессий; фабрика обязана вернуть `UnifiedRadixCache` или совместимый объект.
- `--enable-streaming-session`: несовместимый кеш будет обернут в `StreamingSession`.
- `--enable-int8-mamba-checkpoint`: несовместим с любым непустым значением — `_handle_int8_mamba_checkpoint` бросает `ValueError` «--enable-int8-mamba-checkpoint only supports the built-in mamba radix cache; --radix-cache-backend=… is not int8-aware.».
- `--flexkv-config-file`: на этом пути **не** пробрасывается в `FLEXKV_CONFIG_PATH`.

## Типовые проблемы и диагностика

- `ValueError: --radix-cache-backend='flexkv' is not registered. Registered backends: []. External backends must call register_radix_cache_backend(...) at import time.` — модуль, регистрирующий имя, не был импортирован. Для FlexKV используйте `--enable-flexkv` либо импортируйте пакет через плагин.
- `ValueError: --enable-session-radix-cache requires UnifiedRadixCache, but tree_cache is <Class>.` — подставленный backend не умеет сессии.
- `ValueError: register_radix_cache_backend: '<name>' is already registered` — пакет импортирован дважды разными путями.
- Что именно было создано, показывает строка «Tree cache initialized: source=registered('<name>') impl=<Class> …» (`mem_cache/registry.py`) — по полю `source` сразу видно, шел ли выбор через реестр или через цепочку по умолчанию.
- Список загруженных плагинов виден в логе `load_plugins()`; ограничить его можно переменной `SGLANG_PLUGINS`.
- Сторонний backend — исполняемый код в процессе сервера: подключайте только доверенные пакеты, особенно на инстансе, доступном не только с localhost.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --radix-cache-backend flexkv
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --page-size 64 --radix-cache-backend my_kv_backend --radix-eviction-policy lru
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/registry.py`
- `sglang/python/sglang/srt/mem_cache/storage/flexkv/__init__.py`
- `sglang/python/sglang/srt/plugins/__init__.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/test/registered/unit/mem_cache/test_registry.py`
