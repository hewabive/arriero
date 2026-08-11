---
schema: 1
engine: sglang
primaryName: "--disable-overlap-schedule"
title: "--disable-overlap-schedule"
summary: Выключает совмещение работы CPU-планировщика с forward'ом на GPU и переводит scheduler на синхронный event loop. Требуется рядом конфигураций (`--pp-size > 1`, `--enable-pdmux`, mamba `no_buffer`), в остальных случаях стоит только в отладке.
group: schedule
related:
  - --pp-size
  - --enable-pdmux
  - --enable-prefill-delayer
  - --mamba-radix-cache-strategy
  - --max-mamba-cache-size
  - --speculative-algorithm
  - --disaggregation-mode
  - --num-continuous-decode-steps
---

# --disable-overlap-schedule

## Кратко

Overlap-планировщик — режим по умолчанию: пока GPU считает текущий batch, CPU уже готовит следующий, а результаты предыдущего разбираются на следующей итерации цикла. `--disable-overlap-schedule` возвращает синхронную схему «спланировал → посчитал → разобрал». Прямой цели у флага в продакшене нет: его либо требует другая подсистема (и тогда движок обычно выставляет его сам), либо им пользуются, чтобы убрать асинхронность при отладке нестабильного поведения.

## Оригинальная справка

```text
Disable the overlap scheduler, which overlaps the CPU scheduler with GPU model worker.
```

## Паспорт аргумента

- Флаги: `--disable-overlap-schedule`
- Группа: `schedule`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует или отсутствует; парного `--no-*` нет
- Значение по умолчанию: `false` — overlap включен
- Эффективное значение: принудительно `true` при `--pp-size > 1`, на `--device mps` без MLX, при спекулятивном декодировании на `--device cpu`, при diffusion-LLM (`--dllm-algorithm`), при `SGLANG_EMBEDDINGS_SPARSE_HEAD`, и при стратегии mamba radix cache `no_buffer`; `--enable-pdmux` требует его явно
- Где объявлен: `ServerArgs.disable_overlap_schedule`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (принудительные переключения и проверки) → выбор event loop при запуске scheduler'а

## Что меняет в движке

Флаг инвертируется в `Scheduler.enable_overlap` и в `TpModelWorker.enable_overlap`, а `dispatch_event_loop` по нему выбирает цикл: `event_loop_overlap()` против `event_loop_normal()` (и аналогичные пары для PD-режимов). В overlap-цикле:

- forward запускается на отдельном CUDA-потоке (`forward_stream`), синхронизированном с `schedule_stream`;
- результаты предыдущего batch'а лежат в `result_queue` и разбираются в начале следующей итерации (`if self.enable_overlap and self.last_batch: ...`);
- длины последовательностей и часть входов резолвятся через `future_map`, потому что на момент планирования следующего шага предыдущий еще не завершен;
- `no_copy_to_cpu = not disable_overlap_schedule` в model runner — при overlap результаты не копируются на CPU синхронно.

Кроме планирования флаг меняет несколько размеров буферов:

- пул mamba-состояний: с overlap на запрос резервируется ping-pong буфер (`ratio` 5 вместо 4 или 3 в `_calculate_mamba_ratio`), поэтому выключение overlap увеличивает достижимый `--max-running-requests` на гибридных моделях;
- `SWAChunkCapPoolConfigurator` считает `chunks_in_flight = 1` при выключенном overlap и `2` при включенном;
- аллокатор spec-декодирования держит `2 * alloc_len` при overlap.

`PrefillDelayer` (`--enable-prefill-delayer`) прямо ассертит, что overlap включен.

## Значения и формат

- Флаг без значения; «не задан» означает overlap включен.
- Обратного флага нет: снова включить overlap после того, как его выставила автоматика (например при `--pp-size > 1`), невозможно.
- Задание флага там, где он и так подразумевается, не является ошибкой — предупреждения не будет, значение просто совпадет.

## Когда использовать

- Когда его требует другая подсистема и вы конфигурируете все явно: `--enable-pdmux` (ассерт `PD-Multiplexing is not compatible with overlap schedule.`), mamba `no_buffer` (`no_buffer do not support overlap schedule`).
- При диагностике: синхронный цикл дает воспроизводимую последовательность forward'ов и понятные стектрейсы, без «результата с прошлой итерации».
- Когда на гибридной mamba-модели упирается `max_running_requests`, и вы готовы разменять overlap на дополнительные слоты состояний.
- Не включайте ради экономии памяти в обычной конфигурации: выигрыш есть только на гибридных архитектурах, а потеря throughput — везде.
- Не используйте вместе с `--enable-prefill-delayer`: конфигурация упадет на ассерте.

## Влияние на производительность и память

- Throughput: падает, тем заметнее, чем короче forward. На мелких batch'ах и небольших моделях планирование на CPU перестает прятаться за GPU и становится видимым в межтоковых интервалах.
- Latency: межтоковая задержка растет на время планирования одного шага.
- VRAM: небольшой выигрыш на гибридных моделях (меньше слотов mamba-состояний на запрос, меньше chunks-in-flight в SWA-кэпе); на обычных моделях изменение незначимо.
- RAM хоста: не меняется.
- Время старта: не меняется.

## Взаимодействие с другими аргументами

- `--pp-size > 1`: overlap отключается принудительно (`Pipeline parallelism is incompatible with overlap schedule.`), плюс есть ассерт на этот случай.
- `--enable-pdmux`: требует флаг явно.
- `--enable-prefill-delayer`: несовместим (`To use PrefillDelayer, disable_overlap_schedule must be False.`).
- `--mamba-radix-cache-strategy no_buffer`: сам выставляет флаг; стратегия `extra_buffer` в «ленивом» варианте, наоборот, требует overlap.
- `--speculative-algorithm`: алгоритм, зарегистрированный с `supports_overlap=False`, при включенном overlap отвергается (`Speculative algorithm X does not support overlap scheduling.`); на `--device cpu` overlap выключается автоматически.
- `--max-running-requests` / `--max-mamba-cache-size`: на гибридных моделях выключение overlap меняет число слотов состояния на запрос.
- `--disaggregation-mode`: у каждого режима своя пара циклов, выбор так же управляется этим флагом.
- `--num-continuous-decode-steps`: другой способ снизить долю планирования в общем времени, без отказа от overlap.

## Типовые проблемы и диагностика

- `AssertionError: Pipeline parallelism is not compatible with overlap schedule, speculative decoding` — при `--pp-size > 1` overlap отключается сам, а спекулятивное декодирование в этой комбинации не поддерживается вовсе.
- `AssertionError: PD-Multiplexing is not compatible with overlap schedule.` — добавьте флаг.
- `AssertionError: To use PrefillDelayer, disable_overlap_schedule must be False.` — уберите флаг либо `--enable-prefill-delayer`.
- `AssertionError: no_buffer do not support overlap schedule.` — стратегия mamba radix cache требует синхронного цикла.
- `AssertionError: Lazy extra buffer requires overlap schedule (--disable-overlap-schedule is incompatible)` — обратный случай.
- Падение throughput после включения флага без изменения других параметров — ожидаемо; сравнивайте `gen throughput (token/s)` в строках `Decode batch, …` до и после.
- Принятое значение — в дампе `server_args=`; предупреждения о принудительном отключении (`Pipeline parallelism is incompatible with overlap schedule.`, `Overlap schedule is disabled because of using diffusion LLM inference`, `Overlap scheduler is disabled when using sparse head for embedding model.`) печатаются на старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --disable-overlap-schedule
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-pdmux --chunked-prefill-size -1 --disable-overlap-schedule
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/managers/prefill_delayer.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/speculative/spec_registry.py`
