---
schema: 1
engine: sglang
primaryName: "--enable-dynamic-chunking"
title: "--enable-dynamic-chunking"
summary: Подбирает размер prefill-куска так, чтобы время forward'а оставалось постоянным по мере роста префикса. Работает только при `--pp-size > 1` и стоит 128 профилировочных прогонов на старте.
group: schedule
related:
  - --chunked-prefill-size
  - --max-prefill-tokens
  - --pp-size
  - --page-size
  - --context-length
  - --disable-overlap-schedule
---

# --enable-dynamic-chunking

## Кратко

При фиксированном `--chunked-prefill-size` время forward'а растет вместе с длиной уже обработанного префикса — внимание квадратично по позиции. В конвейерном параллелизме это ломает балансировку стадий: куски одинаковой длины считаются все дольше. `--enable-dynamic-chunking` заменяет постоянный размер куска предсказанным из квадратичной модели, подогнанной по 128 замерам на старте, так чтобы каждый кусок занимал примерно одинаковое время. Вне `--pp-size > 1` флаг молча ничего не делает.

## Оригинальная справка

```text
Enable dynamic chunk size adjustment for pipeline parallelism. When enabled, chunk sizes are dynamically calculated based on fitted function to maintain consistent execution time across chunks.
```

## Паспорт аргумента

- Флаги: `--enable-dynamic-chunking`
- Группа: `schedule`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует или отсутствует; парного `--no-*` нет
- Значение по умолчанию: `false`
- Эффективное значение: в scheduler'е становится `enable_dynamic_chunking and pp_size > 1`; дополнительно сбрасывается в `false`, если профилирование упало с исключением
- Где объявлен: `ServerArgs.enable_dynamic_chunking`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `Scheduler.init_chunked_prefill` (профилирование при инициализации) → выбор размера куска на каждом проходе с активным `chunked_req`

## Что меняет в движке

При инициализации scheduler'а вызывается `profile_and_init_predictor()`. На PP-ранге 0 он прогоняет до 128 фиктивных extend-батчей с длинами от `chunked_prefill_size * 1.25` вниз с равномерным шагом, измеряя время каждого forward'а с синхронизацией устройства. Пары `(seq_len, latency_ms)` рассылаются по всем рангам (broadcast по attention-TP, attention-CP и PP группам), и каждый ранг подгоняет квадратичную модель `f(l) = a·l² + b·l + c`. Целевая задержка берется как `f(chunked_prefill_size)`.

Дальше, когда есть незавершенный `chunked_req`, планировщик перед сборкой batch'а спрашивает `predict_next_chunk_size(history_len)`: решается уравнение `f(L + x) − f(L) = T` относительно `x` (квадратное `a·x² + (2aL + b)·x − T = 0`). Результат не берется как есть — он сглаживается относительно базового размера:

```python
smoothed = base_chunk_size + smooth_coeff * (calculated - base_chunk_size)
calculated_chunk_size = max(int(smoothed), base_chunk_size // 4)
```

`smooth_coeff` — переменная окружения `SGLANG_DYNAMIC_CHUNKING_SMOOTH_FACTOR` (по умолчанию `0.75`; `0` полностью отключает динамику, `1` следует модели буквально). Дальше размер выравнивается вниз по `max(page_size, 64)`, ограничивается `--max-prefill-tokens` и остатком контекста (с запасом в 100 токенов) и выравнивается еще раз. Полученное число подменяет `chunked_prefill_size` только для этого batch'а; `PrefillAdder` получает его как `rem_chunk_tokens`.

Отдельный эффект — на резервирование памяти: `max_prefill_buffer_tokens()` при включенном флаге и `pp_size > 1` считает потолок prefill-буфера как `max(chunked_prefill_size, max_prefill_tokens, ceil(chunked_prefill_size * 1.25))`, потому что куски могут вырасти.

Если модель подогнать не удалось (`a <= 0`) или дискриминант отрицателен, предсказатель возвращает `None`, и используется обычный `--chunked-prefill-size`.

## Значения и формат

- Флаг без значения; «не задан» — постоянный размер куска.
- Обратного флага нет.
- Задание флага при `--pp-size 1` не является ошибкой и не логируется: `enable_dynamic_chunking` в scheduler'е просто становится `false`, профилирование не запускается.
- Размер куска остается кратным `--page-size`: предсказатель выравнивает результат.

## Когда использовать

- При `--pp-size > 1` и длинных промптах, когда видно, что поздние куски prefill'а считаются заметно дольше ранних и стадии конвейера простаивают.
- Когда важнее равномерность занятости стадий, чем минимальное время старта.
- Вместе с увеличенным стартовым размером куска: апстрим-документация рекомендует брать `--chunked-prefill-size` в 2–3 раза больше оптимального фиксированного (в их примерах 12288 для DeepSeek-V3.1 и 18432 для Qwen3-235B-A22B-FP8) и подбирать `SGLANG_DYNAMIC_CHUNKING_SMOOTH_FACTOR` в диапазоне 0.6–0.85.
- Не включайте без конвейерного параллелизма: флаг будет проигнорирован, а вы будете думать, что он работает.
- Не включайте, если время старта критично: 128 профилировочных forward'ов на PP-ранге 0 добавляются к каждому запуску.
- Не включайте на первом запуске новой конфигурации: сначала убедитесь, что обычный chunked prefill стабилен, потому что профилирование выполняется через тот же путь forward'а и падает вместе с ним.

## Влияние на производительность и память

- Время старта: растет на 128 замеров (реальная величина зависит от модели и `--chunked-prefill-size`); прогресс виден полосой `Profiling prefill latency for dynamic chunking`.
- VRAM: профилировочные батчи занимают KV-слоты, но освобождают их сразу после замера; в резерв под prefill-буфер закладывается коэффициент 1.25 от `chunked_prefill_size`.
- RAM хоста: не влияет.
- Throughput: выигрыш только на конвейере и только на длинных промптах — за счет того, что стадии не ждут самый долгий кусок.
- Latency: TTFT отдельного длинного запроса может как вырасти, так и упасть — куски становятся неравномерными по длине, но равномерными по времени.

## Взаимодействие с другими аргументами

- `--pp-size`: обязателен (`> 1`), иначе флаг не действует.
- `--chunked-prefill-size`: задает целевую задержку (`f(chunked_prefill_size)`) и базу для профилировочного диапазона; остается запасным значением, когда предсказание не удалось.
- `--max-prefill-tokens`: верхняя граница предсказанного куска.
- `--page-size`: предсказанный размер выравнивается по странице.
- `--context-length`: вторая верхняя граница предсказания.
- `--disable-overlap-schedule`: при `--pp-size > 1` overlap отключается принудительно, так что динамическое чанкование всегда работает в синхронном цикле.

## Типовые проблемы и диагностика

- `[PP Dynamic Chunk] Failed to profile prefill latency: … Dynamic chunking will be disabled.` — профилирование упало, движок продолжает работу с постоянным размером куска.
- `Discriminant is negative … No real solution for chunk size.` и `Calculated chunk size is non-positive (…)` — модель не дает решения для текущей длины; в этом проходе используется обычный размер куска.
- Куски к концу длинного промпта становятся неприлично маленькими — уменьшайте `SGLANG_DYNAMIC_CHUNKING_SMOOTH_FACTOR`; нижняя граница жестко зафиксирована на `--chunked-prefill-size // 4`.
- Флаг задан, в логе нет ни строки `Profiling prefill latency for dynamic chunking`, ни `[PP Dynamic Chunk] … Predictor ready (quadratic). Target latency: …ms` — значит `--pp-size` равен 1.
- Долгий старт после включения — ожидаемая цена профилирования.
- Фактические предсказания видны только на уровне `debug` (`[PP Dynamic Chunk] [PPk] Predicted chunk size: N (history_len=L)`); принятое значение флага — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --pp-size 2 --chunked-prefill-size 8192 --enable-dynamic-chunking
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --pp-size 4 --chunked-prefill-size 4096 --max-prefill-tokens 16384 --enable-dynamic-chunking
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/scheduler_pp_mixin.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/docs/docs/advanced_features/pipeline_parallelism.mdx`
