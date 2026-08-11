---
schema: 1
engine: vllm
primaryName: "--scheduler-reserve-full-isl"
title: "--scheduler-reserve-full-isl"
summary: Впускать новый запрос только если в KV-cache помещается вся его входная последовательность, а не первый кусок prefill. Включено по умолчанию; отключение возвращает старое поведение с перебором запросов и вытеснениями посреди prefill.
group: SchedulerConfig
related:
  - --enable-chunked-prefill
  - --watermark
  - --max-num-seqs
  - --max-model-len
  - --gpu-memory-utilization
  - --enable-prefix-caching
  - --max-num-batched-tokens
  - --scheduling-policy
---

# --scheduler-reserve-full-isl

## Кратко

При chunked prefill запрос впускается в running-очередь по первому куску. Куска на 2048 токенов хватает почти всегда, даже если промпт на 60 000 токенов и KV-cache под него нет. Через несколько шагов блоки кончаются, и планировщик начинает вытеснять — часто тот же самый запрос, чей prefill уже наполовину посчитан.

`--scheduler-reserve-full-isl` (ISL — input sequence length) закрывает эту дыру: перед впуском проверяется, что свободных блоков хватит на **всю** последовательность с учетом префиксных попаданий и sliding window. Не хватает — запрос остается в очереди, и ни один шаг compute не тратится впустую.

## Оригинальная справка

```text
If True, the scheduler checks whether the full input sequence length
fits in the KV cache before admitting a new request, rather than only
checking the first chunk. Prevents over-admission and KV cache thrashing
with chunked prefill.
```

## Паспорт аргумента

- Флаги: `--scheduler-reserve-full-isl`, `--no-scheduler-reserve-full-isl`
- Группа argparse: `SchedulerConfig`
- Тип значения: bool (`action: argparse.BooleanOptionalAction`)
- Допустимые значения: не ограничены сверх пары флагов
- Значение по умолчанию: `true`
- Эффективное значение: не переопределяется — заданное значение доходит до планировщика как есть
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.scheduler_reserve_full_isl`
- Этап применения: планировщик, при впуске запроса из очереди ожидания

## Что меняет в движке

`Scheduler` сохраняет значение в `self.scheduler_reserve_full_isl` и передает его в `kv_cache_manager.allocate_slots(..., full_sequence_must_fit=...)` **только** для запросов из waiting-очереди. Внутри `allocate_slots` (`vllm/v1/core/kv_cache_manager.py`) при истинном флаге выполняется предварительная проверка:

```
full_num_tokens = min(request.num_tokens, max_model_len)
num_blocks_to_allocate = coordinator.get_num_blocks_to_allocate(
    ..., num_tokens=full_num_tokens, apply_admission_cap=True)
if num_blocks_to_allocate + watermark_blocks > block_pool.get_num_free_blocks():
    return None
```

Возврат `None` для waiting-запроса означает «не впускать», и планировщик выходит из обхода очереди (`break`). Уже запущенные запросы (running-очередь) этой проверке не подвергаются — их prefill продолжается по обычным правилам.

Обратите внимание: `full_num_tokens` считается по `request.num_tokens`, то есть по фактической длине запроса, а не по `max_model_len`; экономия от префиксного кэша учитывается через `new_computed_blocks`.

## Значения и формат

- `--scheduler-reserve-full-isl` — проверять полную длину (по умолчанию).
- `--no-scheduler-reserve-full-isl` — проверять только текущий кусок; это поведение движка до появления флага.
- Проверка применяется вместе с watermark: требуемое число блоков считается как `нужно на всю последовательность + watermark_blocks`.

## Когда использовать

- Оставьте включенным. Это защита от самого неприятного класса деградации: KV-cache thrashing, когда система тратит все шаги на пересчет вытесненных prefill.
- `--no-scheduler-reserve-full-isl` осмысленен в двух случаях: воспроизведение поведения старой версии при сравнительных замерах и нагрузка из очень длинных запросов на маленьком KV-cache, где строгая проверка приводит к тому, что запросы вообще не впускаются (лучше, впрочем, поднять `--gpu-memory-utilization` или снизить `--max-model-len`).
- Не рассматривайте флаг как способ увеличить конкурентность: он не добавляет памяти, а лишь меняет момент, когда нехватка обнаруживается.

## Влияние на производительность и память

- **VRAM.** Собственного расхода нет. Меняет только политику впуска.
- **Throughput.** При достаточном KV-cache разницы почти нет. При дефиците включенная проверка выигрывает: без нее шаги уходят на prefill, который потом вытесняется и пересчитывается.
- **TTFT.** Может вырасти: длинный запрос ждет в очереди, пока не освободится память под всю его длину. Взамен исчезает сценарий «начали, вытеснили, начали заново».
- **Справедливость.** Побочный эффект: очень длинный запрос при постоянной нагрузке короткими может ждать заметно дольше. Здесь помогает `--scheduling-policy priority`.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--enable-chunked-prefill`: без chunked prefill проблема, ради которой введен флаг, не возникает — запрос и так впускается только целиком.
- `--watermark`: складывается с этой проверкой, требуя дополнительный запас свободных блоков при впуске.
- `--max-num-seqs`: ограничивает число запросов сверху; строгая проверка часто становится фактическим ограничителем раньше, чем эта квота.
- `--max-model-len`: верхняя граница `full_num_tokens`.
- `--gpu-memory-utilization`: единственный способ действительно увеличить число блоков, а не переставить момент отказа.
- `--enable-prefix-caching`: снижает требование — попавшие в кэш блоки не нужно выделять заново.
- `--scheduling-policy`: определяет, какой именно запрос проверяется первым.

## Типовые проблемы и диагностика

- **Симптом:** длинные запросы стоят в очереди при видимо свободном KV-cache. **Причина:** свободных блоков хватает на кусок, но не на всю последовательность. **Проверка:** `Waiting: N reqs` растет, `GPU KV cache usage` заметно ниже 100 %, `Preemptions` не растет. **Лечение:** поднять `--gpu-memory-utilization`, снизить `--max-model-len` либо (осознанно) отключить флаг.
- **Симптом:** после отключения флага выросли `Preemptions: N` и упал throughput. **Причина:** ровно тот эффект, ради устранения которого флаг введен. **Лечение:** вернуть значение по умолчанию.
- **Симптом:** первый запрос после старта не впускается вовсе. **Причина:** промпт длиннее, чем весь KV-cache. **Проверка:** строка `GPU KV cache size: N tokens, Maximum concurrency for M tokens per request: X.XXx` — если `N` меньше длины промпта, никакая политика впуска не поможет. **Лечение:** увеличить память под KV или сократить контекст.
- **Подтверждение принятого значения:** отдельной строки лога нет. Наблюдаемое различие — соотношение `Waiting` и `Preemptions`: строгий впуск копит очередь, мягкий копит вытеснения.

## Примеры

```bash
vllm serve /models/Qwen3-4B --scheduler-reserve-full-isl --max-model-len 32768 --gpu-memory-utilization 0.9
```

```bash
vllm serve /models/Qwen3-4B --no-scheduler-reserve-full-isl --enable-chunked-prefill --max-num-batched-tokens 4096
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/core/kv_cache_manager.py`
- `vllm/docs/configuration/optimization.md`
