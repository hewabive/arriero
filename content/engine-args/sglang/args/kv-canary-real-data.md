---
schema: 1
engine: sglang
primaryName: "--kv-canary-real-data"
title: "--kv-canary-real-data"
summary: Расширяет KV-канарейку хешем самих данных KV, а не только идентификатора токена и позиции. Работает только при включенном `--kv-canary`; `partial` читает первые 16 байт слота, `all` — весь слот.
group: null
related:
  - --kv-canary
  - --kv-canary-sweep-interval
  - --page-size
  - --kv-cache-dtype
  - --mem-fraction-static
  - --cuda-graph-backend-prefill
---

# --kv-canary-real-data

## Кратко

Базовая канарейка (`--kv-canary`) проверяет метаданные слота: какой токен и какая позиция должны в нем лежать, плюс цепочку хешей. Она ловит ошибки адресации — не тот слот, не та страница, переиспользование после вытеснения. Но она не заметит, если адресация верна, а испортилось само содержимое K/V. `--kv-canary-real-data` закрывает эту дыру: в четвертое поле канареечного слота дополнительно кладется хеш реальных байтов KV, и проверка сравнивает его при верификации.

Аргумент инертен сам по себе: при `--kv-canary none` (значение по умолчанию) канарейка не устанавливается вовсе, и это значение никем не читается.

## Оригинальная справка

```text
Check the real KV-cache in the canary. 'none' (default) disables the feature. 'partial' checks the first 16 bytes of each real-KV slot. 'all' checks the full real-KV slot.
```

## Паспорт аргумента

- Флаги: `--kv-canary-real-data`
- Группа: `null` — поле `ServerArgs.kv_canary_real_data` объявлено без `Arg(...)`, поэтому флаг заводится литеральным `parser.add_argument` в `add_cli_args` (choices вычисляются из перечисления в момент регистрации)
- Тип значения: str
- Допустимые значения: в extract `choices: null`, но argparse ограничение накладывает — `[m.name.lower() for m in RealKvHashMode]`, то есть `none`, `partial`, `all`. Статически извлечь этот список из исходника нельзя, отсюда `null` в extract; перечисление живет в `sglang/python/sglang/kernels/ops/kv_canary/consts.py`
- Значение по умолчанию: `ServerArgs.kv_canary_real_data`, то есть `"none"`
- Эффективное значение: совпадает с заданным; `CanaryConfig.from_env` приводит строку к верхнему регистру и разрешает в член `RealKvHashMode`. При `--kv-canary none` значение не используется совсем
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный аргумент узкоспециального диагностического механизма, не повседневная настройка
- Этап применения: `install_canary` в `ModelRunner` — после выделения KV-пула и до захвата CUDA graph

## Что меняет в движке

`resolve_real_kv_read_bytes` (`sglang/python/sglang/srt/kv_canary/pool_patcher/buffer_alloc.py`) превращает режим в число байт для чтения:

- `none` → `0`, источники реального KV не регистрируются, поле хеша остается нулевым;
- `partial` → `16` — жесткая константа `_PARTIAL_REAL_KV_READ_BYTES`;
- `all` → `sys.maxsize`, что дальше нормализуется в `num_bytes_per_token`, то есть весь слот целиком.

Полученное число проходит через `_clip_read_bytes_aligned`: fold-ядро выполняет 128-битные загрузки, поэтому длина чтения обязана быть кратна 16 байтам и не превышать размер слота. Отсюда и выбор 16 для `partial` — это минимальная допустимая порция.

Дальше режим одинаково применяется ко всем трем видам запусков канарейки: `HEAD`, `TAIL` и полный sweep (`--kv-canary-sweep-interval`). Расхождение хеша дает флаг `VERIFY_REAL_KV_HASH_MISMATCH` в записи о нарушении — по нему видно, что испорчены именно данные, а не адресация.

Размер канареечных буферов от режима не зависит: слот всегда 32 байта (`CANARY_FIELDS_PER_SLOT = 4` поля по 8 байт), просто при `none` четвертое поле не заполняется.

## Значения и формат

- Ровно одно из `none`, `partial`, `all`; регистр не важен — `CanaryConfig.from_env` вызывает `.strip().upper()`.
- `none` — выключено (значение по умолчанию), это же значение действует, если `--kv-canary` не включен.
- `partial` — компромисс: 16 байт на слот на каждую проверку. В комментарии к `CanaryConfig` этот режим прямо назван достаточно дешевым для продакшна.
- `all` — читается весь слот KV на каждую проверку; стоимость растет пропорционально `num_bytes_per_token`, то есть числу KV-голов, размерности головы и размеру элемента.
- Аргумент без `--kv-canary log` или `--kv-canary raise` не делает ничего и не выдает предупреждения.

## Когда использовать

- Есть подозрение на повреждение содержимого KV (странные ответы при формально исправном кеше, подозрение на дефект ядра внимания или квантизации KV), а базовая канарейка нарушений не показывает. Тогда `partial`, при необходимости `all`.
- Проверка нового attention backend или нового `--kv-cache-dtype` на тестовом стенде: `--kv-canary raise --kv-canary-real-data all` дает жесткий отказ на первом же расхождении.
- Не включать на рабочем сервере «для профилактики»: это диагностика, а не защита. Обнаруженное расхождение все равно означает остановку и разбор.
- Не ожидать от `all` большей чувствительности к ошибкам адресации: их ловит базовая часть канарейки, а не хеш данных.

## Влияние на производительность и память

- VRAM: дополнительной памяти не требует — поле хеша уже есть в 32-байтном канареечном слоте. Стоимость памяти определяется самим `--kv-canary` (128 байт на слот KV для MHA-пула, 64 для SWA/DSV4).
- Пропускная способность памяти на forward: `partial` добавляет чтение 16 байт на проверяемый слот, `all` — чтение всего слота. На длинных контекстах и при включенном sweep это уже заметная нагрузка, потому что читается вся защищенная область, а не только новые токены.
- Время старта: не меняет.
- Latency: растет вместе с объемом чтения; конкретную величину надо мерить на своей модели — в исходниках чисел нет.

## Взаимодействие с другими аргументами

- `--kv-canary`: обязательный переключатель. При `none` этот аргумент не читается.
- `--kv-canary-sweep-interval`: определяет, как часто режим применяется ко всему пулу, а не только к головным/хвостовым слотам. Связка `all` + маленький интервал sweep — самая дорогая комбинация.
- `--kv-cache-dtype`: определяет `num_bytes_per_token`, а значит и стоимость режима `all`. Величина обязана быть кратна 16 байтам, иначе `_clip_read_bytes_aligned` отвергнет конфигурацию.
- `--page-size`: для страничных пулов источник регистрируется как packed-источник со своим `page_size`; на выбор режима не влияет.
- `--cuda-graph-backend-prefill`: канарейка целиком несовместима с `tc_piecewise` (утверждение в `install_canary`), что косвенно ограничивает и этот аргумент.

## Типовые проблемы и диагностика

- Аргумент задан, а поведение не изменилось — почти наверняка не включен `--kv-canary`. Проверьте `kv_canary=` в дампе `server_args=`.
- `ValueError: kv-canary: num_bytes_per_token must be a positive multiple of 16, got …` — размер слота KV не кратен 16 байт при выбранном dtype; режим реальных данных для такой конфигурации неприменим.
- `ValueError: kv-canary: read_bytes must be a multiple of 16 …` / `read_bytes must be <= num_bytes_per_token …` — внутренняя проверка длины чтения; возникает при нестандартной раскладке пула.
- `KeyError` при разборе значения — режим написан не так, как называется член перечисления; допустимы только `none`, `partial`, `all`.
- Нарушения появились только после включения режима — сравнение хешей данных нашло то, чего не видела базовая канарейка; в записи нарушения будет `VERIFY_REAL_KV_HASH_MISMATCH`.
- Что смотреть в логе: `kv_canary=` и `kv_canary_real_data=` в дампе `server_args=`, строки нарушений от `violation_reporter.py`, периодическую статистику канарейки.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kv-canary log --kv-canary-real-data partial
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kv-canary raise --kv-canary-real-data all --kv-canary-sweep-interval 50 --cuda-graph-backend-prefill disabled
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/kv_canary/config.py`
- `sglang/python/sglang/srt/kv_canary/api.py`
- `sglang/python/sglang/srt/kv_canary/pool_patcher/buffer_alloc.py`
- `sglang/python/sglang/kernels/ops/kv_canary/consts.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
