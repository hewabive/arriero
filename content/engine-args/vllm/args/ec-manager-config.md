---
schema: 1
engine: vllm
primaryName: "--ec-manager-config"
title: "--ec-manager-config"
summary: Подменяет встроенный менеджер encoder-cache пользовательским Python-классом и передаёт ему произвольную конфигурацию. Нужен разработчикам альтернативных политик кэширования мультимодального encoder output.
group: VllmConfig
related:
  - --ec-transfer-config
  - --limit-mm-per-prompt
  - --mm-processor-cache-gb
  - --max-num-batched-tokens
---

# --ec-manager-config

## Кратко

`--ec-manager-config` выбирает пользовательский класс, который вместо встроенного `EncoderCacheManager` управляет слотами encoder-cache в планировщике V1. Пустой объект сохраняет штатное поведение; это extension point для кода плагина, а не настройка размера cache.

## Оригинальная справка

```text
The configurations for custom encoder cache manager.
```

## Паспорт аргумента

- Флаги: `--ec-manager-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (`EncoderCacheManagerConfig`)
- Допустимые значения: ключи `encoder_cache_manager_cls` и `manager_config`; первый — fully-qualified Python class name или `null`, второй — произвольный JSON-объект
- Значение по умолчанию: `Field(default_factory=EncoderCacheManagerConfig)`, то есть класс не задан и `manager_config={}`
- Эффективное значение: без класса scheduler выбирает `EncoderDecoderCacheManager` для encoder-decoder модели и `EncoderCacheManager` в остальных случаях
- Где объявлен: `vllm/config/vllm.py:VllmConfig.ec_manager_config`
- Этап применения: сборка `VllmConfig` → импорт класса → создание scheduler → обслуживание encoder-cache

## Что меняет в движке

При создании scheduler строка класса разрешается через `resolve_obj_by_qualname()`. Затем vLLM вызывает classmethod `create_manager(cache_size=encoder_cache_size, vllm_config=vllm_config)` и использует возвращённый объект во всех операциях учёта, выделения и освобождения encoder outputs.

Формального ABC для менеджера нет: пользовательский объект должен поддерживать фактически вызываемый интерфейс штатного `EncoderCacheManager` — в частности `reset`, `check_and_update_cache`, `can_allocate`, `allocate`, `free`, `free_encoder_input`, `get_cached_input_ids`, `get_freed_mm_hashes` и `get_manager_metadata`. Произвольные параметры доступны классу как `vllm_config.ec_manager_config.manager_config`.

## Значения и формат

Цельный JSON:

```bash
--ec-manager-config '{"encoder_cache_manager_cls":"mypkg.cache.CustomEncoderCacheManager","manager_config":{"policy":"lru"}}'
```

Эквивалентная точечная форма:

```bash
--ec-manager-config.encoder_cache_manager_cls mypkg.cache.CustomEncoderCacheManager --ec-manager-config.manager_config.policy lru
```

Непустой `manager_config` без `encoder_cache_manager_cls` отвергается с `manager_config requires encoder_cache_manager_cls to be set.`. Ошибки импорта и несовместимый интерфейс проявляются при старте scheduler.

## Когда использовать

- Для экспериментальной политики вытеснения или внешней координации encoder-cache, реализованной установленным Python-пакетом.
- Не задавайте только ради изменения размера cache: его бюджет выводится из мультимодальной конфигурации, а этот аргумент меняет управляющую реализацию.

## Влияние на производительность и память

Пустой объект ничего не меняет. Пользовательская реализация находится на горячем пути scheduler и может изменить hit rate, число повторных encoder-forward и расход cache; медленные методы увеличивают scheduling latency. Ошибка в учёте слотов способна привести к OOM или некорректному переиспользованию encoder output.

## Взаимодействие с другими аргументами

- `--ec-transfer-config`: отвечает за распределённую передачу encoder cache, тогда как этот аргумент — за локальный scheduler-side manager.
- `--limit-mm-per-prompt`: ограничивает возможный спрос на encoder-cache.
- `--mm-processor-cache-gb`: кэширует результаты preprocessing и не является encoder-cache, которым управляет этот класс.
- `--max-num-batched-tokens`: вместе с мультимодальным бюджетом влияет на число encoder inputs, которое scheduler пытается разместить.

## Типовые проблемы и диагностика

- **Симптом:** `ImportError`/`AttributeError` при старте. **Причина:** неверный qualname либо у класса нет `create_manager`. **Лечение:** установить пакет в окружение vLLM и проверить путь импорта.
- **Симптом:** `manager_config requires encoder_cache_manager_cls to be set.` **Причина:** параметры заданы без реализации. **Лечение:** добавить fully-qualified class name или очистить `manager_config`.
- **Симптом:** запросы повторно запускают encoder или зависают при нехватке слотов. **Причина:** пользовательский manager нарушает контракт учёта. **Проверка:** сравнить поведение с пустым `{}` и штатным `EncoderCacheManager`.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --ec-manager-config '{"encoder_cache_manager_cls":"mypkg.cache.CustomEncoderCacheManager","manager_config":{"policy":"lru"}}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --ec-manager-config.encoder_cache_manager_cls mypkg.cache.CustomEncoderCacheManager --ec-manager-config.manager_config.policy lru
```

## Источники

- `vllm/vllm/config/ec_manager_config.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/core/encoder_cache_manager.py`
