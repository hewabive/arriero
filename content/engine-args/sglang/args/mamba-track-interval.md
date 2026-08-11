---
schema: 1
engine: sglang
primaryName: "--mamba-track-interval"
title: "--mamba-track-interval"
summary: Шаг в токенах, с которым во время декода снимаются чекпоинты рекуррентного состояния для префиксного кеша. Задает гранулярность переиспользования префикса у гибридных моделей и связан делимостью с `--page-size`.
group: exec.mamba
related:
  - --mamba-radix-cache-strategy
  - --mamba-max-states-per-path
  - --page-size
  - --speculative-num-draft-tokens
  - --speculative-algorithm
  - --max-mamba-cache-size
  - --enable-linear-replayssm
  - --disable-radix-cache
  - --chunked-prefill-size
---

# --mamba-track-interval

## Кратко

У обычной модели префиксный кеш может «войти» в любой токен: KV лежит потокенно. У гибридной модели точка входа существует только там, где сохранен снимок рекуррентного состояния, а снимок стоит целый слот дорогого пула. `--mamba-track-interval` задает шаг сетки таких снимков: они делаются на позициях, где `seq_len % interval == 0`. Значение по умолчанию 256. Уменьшение шага делает переиспользование префикса точнее, но повышает и число копий состояния, и число удерживаемых слотов; увеличение — наоборот.

## Оригинальная справка

```text
The interval to track the mamba state during decode.
```

## Паспорт аргумента

- Флаги: `--mamba-track-interval`
- Группа: `exec.mamba`
- Тип значения: int (токены)
- Допустимые значения: argparse ограничений не накладывает; фактические ограничения приходят из проверок стратегии `extra_buffer` (см. ниже)
- Значение по умолчанию: `256`
- Эффективное значение: совпадает с заданным; автоподбора нет
- Где объявлен: `ServerArgs.mamba_track_interval`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: `__post_init__` (валидация в `_validate_mamba_extra_buffer`) → формирование каждого decode-батча (`ScheduleBatch.prepare_for_decode`) → decode-ядро линейного внимания → обработка результата батча

## Что меняет в движке

### Маска снимков в decode-батче

При включенной стратегии `extra_buffer`/`extra_buffer_lazy` каждый decode-батч считает (`sglang/python/sglang/srt/managers/schedule_batch.py`):

```python
track_remainders_cpu   = seq_lens_cpu % mamba_track_interval
track_mask_cpu         = track_remainders_cpu == 0
track_mask_next_cpu    = track_remainders_cpu == mamba_track_interval - 1   # при overlap
```

Строки с истинной маской на этом шаге отдают свое состояние в ping-pong-слот, который затем становится значением узла radix-дерева. Вторая маска нужна overlap-планировщику, чтобы подготовить донорский слот на шаг раньше.

### Форсированный сброс кольца ReplaySSM

Даже в стратегии `no_buffer`, где маски снимков нет, интервал читается GDN-путем ReplaySSM: `_replayssm_track_flush_mask` (`sglang/python/sglang/srt/layers/attention/hybrid_linear_attn_backend.py`) на тех же позициях `seq_lens % interval == 0` заставляет decode-ядро свернуть кольцо в `temporal[slot]`, чтобы состояние в памяти было актуальным именно на границе трека. То есть при `--enable-linear-replayssm` интервал определяет ритм принудительных сбросов в HBM.

### Спекулятивная сверка

`spec_utils.py` и воркеры DSpARK/DFLASH ищут «точку трека» внутри окна верификации: если `seq_lens_pre_verify // interval != seq_lens_post_verify // interval`, значит, границу пересекли, и чекпоинт делается на позиции `seq_lens_post_verify // interval * interval`. Отсюда требование, чтобы окно черновых токенов было не длиннее интервала.

## Значения и формат

- Целое число токенов. Практически всегда степень двойки — из-за требования делимости на `--page-size`.
- При стратегии `extra_buffer` и включенной спекуляции проверяется `mamba_track_interval >= speculative_num_draft_tokens`; иначе окно верификации может целиком перескочить границу трека.
- При стратегии `extra_buffer` и заданном `--page-size` проверяется `mamba_track_interval % page_size == 0`.
- Слишком маленькое значение (единицы токенов) означает снимок почти на каждом шаге: копирование состояния на каждый decode-шаг съест выигрыш от кеша.
- При `--disable-radix-cache` снимки не нужны, и значение читается только путем ReplaySSM.

## Когда использовать

- Уменьшать (например, до 64 или 128), когда нагрузка — многотуровые диалоги с приростом контекста на десятки токенов за ход: с шагом 256 такой прирост не попадает в сетку, и весь ход декодируется заново от предыдущего снимка.
- Увеличивать (512, 1024), когда пул состояний мал и `--mamba-max-states-per-path` уже включен: реже снимки — меньше удерживаемых слотов.
- Согласовывать со спекуляцией: при `--speculative-num-draft-tokens 8` любое значение ниже 8 отвергается на старте в режиме `extra_buffer`.
- Не трогать на однократных независимых запросах: там префиксного переиспользования нет вовсе и любой интервал одинаково бесполезен.

## Влияние на производительность и память

- VRAM: не выделяет буферов, но управляет тем, как быстро кеш занимает слоты пула состояний. Один снимок = один слот (37.7 MiB на Qwen3-Next при `bfloat16`).
- RAM хоста: не влияет; при `--enable-hierarchical-cache` снимки могут уходить в host-пул, и частота снимков определяет объем этого трафика.
- Время старта: не влияет.
- Latency decode: на шагах-границах выполняется дополнительное копирование состояния (или свертка кольца ReplaySSM). При интервале 256 это один шаг из 256 — доли процента; при интервале 8 — уже заметно.
- TTFT: чем плотнее сетка, тем ближе точка входа в кеш к концу общего префикса и тем короче пересчет.

## Взаимодействие с другими аргументами

- `--mamba-radix-cache-strategy`: маска снимков строится только в `extra_buffer`/`extra_buffer_lazy`; там же живут обе проверки корректности значения.
- `--page-size`: интервал обязан делиться на размер страницы нацело.
- `--speculative-num-draft-tokens`: интервал должен быть не меньше числа черновых токенов.
- `--mamba-max-states-per-path`: интервал задает, как часто появляются снимки, а этот аргумент — сколько их переживает вставку в дерево.
- `--enable-linear-replayssm`: интервал задает принудительный сброс кольца в HBM для GDN-моделей.
- `--chunked-prefill-size`: при `extra_buffer` слишком маленький chunk относительно внутреннего `mamba_cache_chunk_size` приводит к warning'у о пропуске чекпоинтов на границе незавершенного chunked prefill.
- `--max-mamba-cache-size`: общий объем пула, который эти снимки делят с живыми запросами.

## Типовые проблемы и диагностика

- `AssertionError` в `_validate_mamba_extra_buffer` на строке `view.mamba_track_interval >= view.speculative_num_draft_tokens` — интервал меньше окна спекуляции.
- `AssertionError` на `view.mamba_track_interval % view.page_size == 0` — интервал не делится на размер страницы. Помните, что `--page-size` мог быть изменен backend'ом внимания.
- `Mamba radix extra-buffer is enabled with chunked_prefill_size=… smaller than mamba_cache_chunk_size=…` — предупреждение о том, что часть чекпоинтов будет пропущена на стыке chunked prefill.
- Низкий hit rate префиксного кеша на гибридной модели при заведомо общих префиксах — сетка снимков слишком редкая, попадание есть, но точка входа далеко позади.
- Что смотреть в логе: `mamba_track_interval=` в дампе `server_args=`, статистику пулов (`mamba_evictable_size`) и предупреждение об ограничении конкурентности пулом состояний.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --mamba-track-interval 128
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --mamba-radix-cache-strategy extra_buffer --page-size 64 --mamba-track-interval 512
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/layers/attention/hybrid_linear_attn_backend.py`
- `sglang/python/sglang/srt/speculative/spec_utils.py`
- `sglang/python/sglang/srt/managers/scheduler_components/batch_result_processor.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
