---
schema: 1
engine: vllm
primaryName: "--mm-shm-cache-max-object-size-mb"
title: "--mm-shm-cache-max-object-size-mb"
summary: Потолок размера одного элемента в shared-memory кэше препроцессинга. Элемент крупнее просто не кэшируется (с предупреждением), поэтому на длинном видео дефолтные 128 MiB часто оказываются малы.
group: MultiModalConfig
related:
  - --mm-processor-cache-type
  - --mm-processor-cache-gb
  - --limit-mm-per-prompt
  - --media-io-kwargs
---

# --mm-shm-cache-max-object-size-mb

## Кратко

Значение имеет смысл **только** при `--mm-processor-cache-type shm`; задавать его в других режимах — ошибка конфигурации, а не безобидная избыточность.

Внутри кольцевого буфера разделяемой памяти каждый объект должен уложиться в этот лимит. Не уложился — объект не кэшируется, запрос обрабатывается как обычно, а в лог уходит предупреждение. Кроме прямого потолка, число задаёт и гранулярность освобождения: при нехватке места буфер пытается освободить `2 × max_object_size` байт за раз.

## Оригинальная справка

```text
Size limit (in MiB) for each object stored in the multi-modal processor
shared memory cache. Only effective when `mm_processor_cache_type` is
`"shm"`.
```

## Паспорт аргумента

- Флаги: `--mm-shm-cache-max-object-size-mb`
- Группа argparse: `MultiModalConfig`
- Тип значения: int, мебибайты
- Допустимые значения: `Field(default=128, ge=0)` — целое, не меньше нуля
- Значение по умолчанию: `128` (MiB)
- Эффективное значение: не переопределяется, но применяется только при `mm_processor_cache_type == "shm"`; отличное от дефолта значение при любом другом типе кэша отвергается валидатором конфига
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_shm_cache_max_object_size_mb`
- Этап применения: создание `SingleWriterShmObjectStorage` в API-процессе и в воркерах

## Что меняет в движке

Значение уходит в конструктор `SingleWriterShmObjectStorage` как `max_object_size = mm_shm_cache_max_object_size_mb × MiB` — одинаково для писателя (`ShmObjectStoreSenderCache`) и читателей (`ShmObjectStoreReceiverCache`).

Внутри хранилища оно работает в двух местах:

1. `put()` считает `buffer_size = flag_bytes + data_bytes + md_bytes` и при превышении бросает `ValueError: Serialized object size (N bytes) exceeds max object size (M bytes)`;
2. `free_unused()` пытается освободить `2 × max_object_size` байт — запас на фрагментацию кольцевого буфера.

Исключение из `put()` перехватывается в `ShmObjectStoreSenderCache.get_and_update_item`: элемент возвращается как есть (то есть уйдёт по обычному IPC), а в лог однократно пишется `mm_input <hash> too large to cache; raise --mm-shm-cache-max-object-size-mb. (...)`. Отдельно обрабатывается `MemoryError` — это уже про нехватку **общего** объёма буфера, и подсказка там другая: `consider raising --mm-processor-cache-gb`.

Валидатор `MultiModalConfig._validate_multimodal_config` не пропускает значение, отличное от дефолтного, если тип кэша не `shm`.

## Значения и формат

- Целое число мебибайт. Дробные значения отвергает argparse (тип `int`).
- `0` — формально допустимо (`ge=0`), но означает, что ни один объект не влезет: кэш перестанет что-либо сохранять и будет писать предупреждение. Отключать кэш надо через `--mm-processor-cache-gb 0`.
- Значение имеет смысл соотносить с ёмкостью буфера: лимит одного объекта, сопоставимый с `--mm-processor-cache-gb`, превращает кэш в «один элемент за раз».
- Оценивать порядок величины стоит по размеру препроцессированного тензора, а не исходного файла: 30-секундное видео в 32 кадрах по 512×512 в bf16 — это уже сотни мегабайт `pixel_values`, тогда как исходный mp4 весит единицы мегабайт.

## Когда использовать

- Видео и большие изображения при `--mm-processor-cache-type shm`: если в логе появилось предупреждение про «too large to cache», поднимайте значение, иначе кэш бесполезен именно на тех входах, где он нужнее всего.
- Понижать имеет смысл редко: меньший лимит защищает буфер от того, что один гигантский элемент вытеснит все мелкие. Осмысленно, если трафик смешанный и мелких элементов много.
- Не задавайте при `lru` — старт упадёт с ошибкой валидации.
- Не используйте как ограничение размера входа: это не защита, а лишь порог кэшируемости. Реальные ограничения задаются `--limit-mm-per-prompt` и параметрами загрузки медиа.

## Влияние на производительность и память

- **RAM хоста / разделяемая память.** Прямого выделения нет: общий объём задаёт `--mm-processor-cache-gb`. Этот флаг влияет только на то, какие элементы туда попадут и какими порциями освобождается место.
- **VRAM.** Не влияет.
- **Latency.** Слишком маленький лимит выключает кэш для крупных медиа — каждый повтор снова платит препроцессингом и передачей тензора.
- **Фрагментация.** Значение задаёт шаг освобождения (`2 × max_object_size`); неоправданно большое значение заставляет буфер освобождать крупными кусками и снижает эффективный коэффициент заполнения.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--mm-processor-cache-type`: обязательное условие применимости; при значении, отличном от `shm`, любое неумолчание здесь — ошибка старта.
- `--mm-processor-cache-gb`: общий объём буфера. Если элементы влезают в лимит, но кэш всё равно промахивается, смотреть надо на этот аргумент (`MemoryError` → debug-строка про `--mm-processor-cache-gb`).
- `--limit-mm-per-prompt`: через подсказки размера влияет на профилирование, но не на реальный размер элемента; для оценки лимита ориентируйтесь на реальные медиа.
- `--media-io-kwargs`: число кадров видео и параметры декодирования напрямую определяют размер препроцессированного тензора, то есть попадёт он в лимит или нет.

## Типовые проблемы и диагностика

- **Симптом:** `'mm_shm_cache_max_object_size_mb' should only be set when 'mm_processor_cache_type' is 'shm'.` **Причина:** значение задано при `lru`. **Лечение:** убрать флаг или переключить тип кэша.
- **Симптом:** в логе `mm_input <hash> too large to cache; raise --mm-shm-cache-max-object-size-mb.` **Причина:** сериализованный элемент больше лимита. **Лечение:** поднять значение (для видео — до нескольких сотен MiB) либо уменьшить число кадров через `--media-io-kwargs`.
- **Симптом:** `MM cache hit rate` держится около нуля именно на видео, при этом на картинках нормальный. **Причина:** видео-элементы не проходят по лимиту. **Проверка:** те же предупреждения в логе; метрики `vllm:mm_cache_queries` / `vllm:mm_cache_hits` в `/metrics`.
- **Симптом:** debug-строка `mm_input <hash> not cached; shm cache full, consider raising --mm-processor-cache-gb.` **Причина:** это уже не лимит объекта, а общий объём. **Лечение:** увеличить `--mm-processor-cache-gb`.
- **Подтверждение принятого значения:** значение видно в стартовой строке конфига как `mm_shm_cache_max_object_size_mb=...`; поведение подтверждается наличием/отсутствием предупреждений выше.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-processor-cache-type shm --mm-processor-cache-gb 16 --mm-shm-cache-max-object-size-mb 512
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --tensor-parallel-size 2 --mm-processor-cache-type shm --mm-shm-cache-max-object-size-mb 256 --media-io-kwargs '{"video": {"num_frames": 16}}'
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/multimodal/cache.py`
- `vllm/vllm/distributed/device_communicators/shm_object_storage.py`
- `vllm/docs/configuration/optimization.md`
