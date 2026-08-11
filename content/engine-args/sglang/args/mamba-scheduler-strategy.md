---
schema: 1
engine: sglang
primaryName: "--mamba-scheduler-strategy"
title: "--mamba-scheduler-strategy"
summary: Устаревший алиас `--mamba-radix-cache-strategy` — стратегия хранения состояний mamba для гибридных моделей. Опасная деталь алиаса: у него не объявлены `choices`, поэтому опечатка проходит argparse и тихо трактуется как `no_buffer`.
group: null
related:
  - --mamba-radix-cache-strategy
  - --max-mamba-cache-size
  - --mamba-full-memory-ratio
  - --disable-radix-cache
  - --disable-overlap-schedule
  - --page-size
  - --attention-backend
  - --enable-linear-replayssm
  - --disaggregation-mode
---

# --mamba-scheduler-strategy

## Кратко

Гибридные модели (mamba/linear attention вперемешку с обычным вниманием) хранят не KV, а рекуррентное состояние, и стратегия его хранения определяет, можно ли переиспользовать префиксы в radix-кеше и можно ли работать с overlap-планировщиком. Аргумент устарел и переименован в `--mamba-radix-cache-strategy` — новое имя точнее: настройка относится не к планировщику, а к кешу.

У переименования есть неприятный побочный эффект: актуальный флаг объявлен с `choices`, а устаревший алиас — без. Argparse поэтому примет у алиаса любую строку, и неверное значение проявится позже как невнятное `AssertionError` вместо честного `invalid choice`.

## Оригинальная справка

```text
Deprecated alias for --mamba-radix-cache-strategy.
```

## Паспорт аргумента

- Флаги: `--mamba-scheduler-strategy`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне группы `exec.mamba`, где живет актуальный флаг
- Тип значения: str
- Допустимые значения: **у алиаса не ограничены** — в его `add_argument` нет `choices` (это видно и в extract: `choices: null`). У актуального `--mamba-radix-cache-strategy` список есть: `auto`, `no_buffer`, `extra_buffer`, `extra_buffer_lazy`
- Значение по умолчанию: `ServerArgs.mamba_radix_cache_strategy`, то есть `"auto"`
- Эффективное значение: `auto` резолвится в пассе `_mamba_radix_cache_resolution` (`arg_groups/overrides.py`) — при выключенном radix-кеше пасс ничего не делает; иначе, если нужен overlap-планировщик или `--page-size > 1` и архитектура поддерживает дополнительный буфер, выбирается `extra_buffer`, а иначе `no_buffer` вместе с принудительным `disable_overlap_schedule = True`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `mamba_radix_cache_strategy`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--mamba-radix-cache-strategy`
- Этап применения: разбор CLI (предупреждение) → `__post_init__` → `_handle_mamba_radix_cache` (резолюция `auto` и валидация) → построение кеша

## Что меняет в движке

### Предупреждение и трансляция

```text
'--mamba-scheduler-strategy' is deprecated and will be removed in a future release. Use '--mamba-radix-cache-strategy' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Что означают стратегии

- `no_buffer` — состояния не дублируются. Самый экономный режим, но он требует `--page-size 1`, принудительно выключает overlap-планировщик и несовместим с attention backend `trtllm_mha`. Проверки в `_validate_mamba_no_buffer`.
- `extra_buffer` — под состояния выделяется дополнительный буфер, что позволяет держать overlap-планировщик и страничный режим. Требует поддержки со стороны архитектуры (`supports_mamba_cache_extra_buffer`) и CUDA/MUSA/NPU/ROCm.
- `extra_buffer_lazy` — вариант с отложенными слотами; дополнительно запрещен под PD-disaggregation и с алгоритмом спекуляции DFLASH.
- `auto` — выбор между первыми двумя по описанной выше логике.

### Ловушка с отсутствующими choices

Поскольку у алиаса `choices` не объявлены, значение вроде `extra-buffer` (через дефис) или `nobuffer` пройдет разбор. Дальше `_mamba_radix_cache_resolution` подменяет значение только при точном `auto`, а предикат `mamba_extra_buffer_of` проверяет вхождение в `("extra_buffer", "extra_buffer_lazy")`. Неизвестная строка не попадает ни туда, ни туда — конфигурация уходит в ветку валидации `no_buffer` и падает на первом же не выполненном условии:

```text
AssertionError: no_buffer only supports page_size=1.
```

или

```text
AssertionError: no_buffer do not support overlap schedule. Try to set disable_overlap_schedule=True.
```

Сообщение при этом ничего не говорит о том, что виновата опечатка в значении. Через актуальный флаг такой сценарий невозможен — argparse отвергнет значение сразу.

## Значения и формат

- Одна строка. Через алиас — любая; через актуальный флаг — только из списка `auto`, `no_buffer`, `extra_buffer`, `extra_buffer_lazy`.
- Значение по умолчанию `auto` покрывает подавляющее большинство случаев.
- Настройка имеет смысл только для архитектур из списка гибридных моделей и только при включенном radix-кеше: при `--disable-radix-cache` пасс резолюции возвращает пустой результат и значение не используется.
- В YAML через `--config` ключ `mamba-radix-cache-strategy` задать нельзя — он отвергается из-за этого устаревшего алиаса на общем `dest`.

## Когда использовать

- Не использовать: пишите `--mamba-radix-cache-strategy`.
- Сам параметр (под новым именем) трогают в двух случаях: нужна экономия памяти под состояния любой ценой (`no_buffer`, с готовностью отдать overlap-планировщик), либо архитектура поддерживает `extra_buffer_lazy` и хочется отложенных слотов.
- `--enable-linear-replayssm` прямо требует `no_buffer`; при `extra_buffer` он отвергается на старте.
- Не задавать значение вручную «на всякий случай»: `auto` учитывает и `--page-size`, и `--disable-overlap-schedule`, и поддержку со стороны архитектуры.

## Влияние на производительность и память

- VRAM: `extra_buffer` требует дополнительной памяти под состояния сверх основного пула; `no_buffer` — нет. Размер задается `--max-mamba-cache-size` и `--mamba-full-memory-ratio`.
- Throughput: `no_buffer` выключает overlap-планировщик, а это заметная потеря на конкурентной нагрузке — планировщик перестает совмещать подготовку следующего батча с текущим forward.
- Кеш префиксов: обе стратегии работают с radix-кешем, но `no_buffer` ограничивает `--page-size` единицей.
- Время старта: не меняет.

## Взаимодействие с другими аргументами

- `--mamba-radix-cache-strategy`: актуальное имя того же поля и единственное место, где значение проверяется по списку.
- `--page-size`: `no_buffer` требует 1; при значении больше 1 `auto` выберет `extra_buffer`.
- `--disable-overlap-schedule`: `no_buffer` включает его принудительно; `auto` учитывает его при выборе.
- `--disable-radix-cache`: при включении настройка не используется.
- `--attention-backend trtllm_mha`: несовместим с `no_buffer`.
- `--max-mamba-cache-size` / `--mamba-full-memory-ratio`: размер памяти под состояния.
- `--enable-linear-replayssm`: требует `no_buffer`.
- `--disaggregation-mode`: `extra_buffer_lazy` под PD не поддерживается.

## Типовые проблемы и диагностика

- `'--mamba-scheduler-strategy' is deprecated …` — замените на `--mamba-radix-cache-strategy`.
- `AssertionError: no_buffer only supports page_size=1.` или `no_buffer do not support overlap schedule …` при, казалось бы, заданном `extra_buffer` — проверьте написание значения: через устаревший алиас опечатка не отвергается.
- `AssertionError: extra_buffer is not supported for <архитектура>; use no_buffer.` — архитектура не поддерживает дополнительный буфер.
- `ValueError: --enable-linear-replayssm requires --mamba-radix-cache-strategy no_buffer …` — конфликт с ReplaySSM.
- `AssertionError: extra_buffer_lazy unsupported under PD disaggregation; use --mamba-radix-cache-strategy extra_buffer.`
- Что смотреть: `mamba_radix_cache_strategy=` в дампе `server_args=` — там уже резолвленное значение, а не `auto`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-radix-cache-strategy extra_buffer
```

Экономный режим с обязательными спутниками:

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-radix-cache-strategy no_buffer --page-size 1 --disable-overlap-schedule
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/mem_cache/mamba_radix_cache.py`
