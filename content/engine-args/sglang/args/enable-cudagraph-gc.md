---
schema: 1
engine: sglang
primaryName: "--enable-cudagraph-gc"
title: "--enable-cudagraph-gc"
summary: Разрешает сборщику мусора Python работать во время захвата CUDA graph. По умолчанию GC на время захвата замораживается (`gc.freeze()`), чтобы захват шел быстрее; флаг нужен только при подозрении, что заморозка приводит к нехватке памяти.
group: exec.graph
related:
  - --cuda-graph-backend-decode
  - --cuda-graph-backend-prefill
  - --cuda-graph-max-bs-decode
  - --cuda-graph-bs-decode
  - --disable-decode-cuda-graph
  - --disable-cuda-graph-padding
  - --enable-profile-cuda-graph
---

# --enable-cudagraph-gc

## Кратко

Захват CUDA graph — это сотни последовательных проходов по модели, и каждый из них создает тысячи временных python-объектов. Сборщик мусора, срабатывая посреди захвата, тратит время на обход всех живых объектов процесса (веса модели — это десятки тысяч тензоров). Поэтому SGLang по умолчанию перед захватом делает `gc.collect()`, затем `gc.freeze()` — переносит все уже живые объекты в «постоянное» поколение, которое GC не обходит, — и снимает заморозку после захвата. Флаг отключает эту оптимизацию.

## Оригинальная справка

```text
Enable garbage collection during CUDA graph capture. If disabled (default), GC is frozen during capture to speed up the process.
```

## Паспорт аргумента

- Флаги: `--enable-cudagraph-gc`
- Группа: `exec.graph`
- Тип значения: bool, `action="store_true"` — значение не принимает
- Допустимые значения: флаг либо есть, либо его нет
- Значение по умолчанию: `false` (GC на время захвата заморожен)
- Эффективное значение: не переопределяется нигде в `__post_init__`
- Где объявлен: `ServerArgs.enable_cudagraph_gc`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: захват графов — контекст `freeze_gc(...)` в `DecodeCudaGraphRunner.capture()` и `PrefillCudaGraphRunner.capture()`

## Что меняет в движке

Единственная точка чтения — контекстный менеджер `freeze_gc` в `model_executor/runner/base_cuda_graph_runner.py`:

```python
gc.collect()
should_freeze = not enable_cudagraph_gc
if should_freeze:
    gc.freeze()
try:
    yield
finally:
    if should_freeze:
        gc.unfreeze()
        gc.collect()
```

`gc.collect()` выполняется всегда, независимо от флага. Разница только в `gc.freeze()`/`gc.unfreeze()` вокруг цикла захвата. Заморозка действует ровно на время захвата одной фазы: decode и prefill вызывают контекст независимо.

Флаг не имеет никакого отношения к HTTP-эндпоинту `/freeze_gc` (`entrypoints/http_server.py`), который замораживает GC в процессах tokenizer manager, scheduler и detokenizer уже после прогрева — это отдельный механизм борьбы с джиттером latency.

Если графы отключены в обеих фазах, флаг не читается вообще.

## Значения и формат

- Значения не принимает.
- Обратного флага нет: поведение по умолчанию (заморозка) возвращается снятием флага.
- Флаг не участвует ни в каких проверках совместимости и ничего не переопределяет.

## Когда использовать

- Захват падает с нехваткой **хостовой** памяти или процесс аномально растет по RSS во время захвата: `gc.freeze()` откладывает освобождение циклического мусора до конца захвата, и на очень больших списках форм это может быть заметно.
- Отладка утечек: с включенным GC поведение ближе к обычному режиму работы, и снимки памяти проще интерпретировать.
- Не включайте «на всякий случай»: единственный гарантированный эффект — более долгий захват, а значит более долгий старт.

## Влияние на производительность и память

- **Время старта.** Единственная величина, ради которой флаг существует. Каждый сбор мусора во время захвата обходит все отслеживаемые объекты процесса; при 24–52 захватываемых формах таких срабатываний может быть много. Ускорение от заморозки тем заметнее, чем длиннее список форм и чем больше объектов в процессе.
- **RAM хоста.** С заморозкой пиковое потребление во время захвата выше: циклический мусор не освобождается до `gc.unfreeze()` + `gc.collect()` в конце. Флаг снижает этот пик.
- **VRAM.** Прямого влияния нет: python-объекты — это хостовая память. Косвенно GC может раньше освободить python-обертки над CUDA-тензорами, но захваченные графы держат свою память сами.
- **Latency в работе:** нулевое влияние — флаг действует только на время старта.

## Взаимодействие с другими аргументами

- `--cuda-graph-max-bs-decode` / `--cuda-graph-bs-decode` / `--cuda-graph-bs-prefill`: чем длиннее список форм, тем сильнее эффект флага в обе стороны.
- `--disable-cuda-graph-padding`: сплошной диапазон форм — самый тяжелый для GC случай, и заморозка там особенно полезна.
- `--disable-decode-cuda-graph` / `--disable-prefill-cuda-graph`: при отключенных графах флаг не читается.
- `--enable-profile-cuda-graph`: профилировщик и запись истории аллокаций сами создают много объектов; их совместное использование делает захват заметно дороже.

## Типовые проблемы и диагностика

- **Симптом:** захват идет непривычно долго, в системе видно высокую загрузку одного CPU-ядра между шагами `Capturing batches (bs=…)`. **Причина:** GC включен этим флагом. **Решение:** снять флаг.
- **Симптом:** RSS процесса скачком растет во время захвата и падает сразу после. Это нормальное следствие заморозки по умолчанию; флаг сглаживает пик.
- **Симптом:** ожидали, что флаг уберет джиттер latency в работе. Он этого не делает — для этого есть HTTP-эндпоинт `/freeze_gc`, вызываемый после прогрева.
- **Чем подтвердить:** флаг виден как `enable_cudagraph_gc=True` в дампе `server_args=` при старте; отдельной строки в логе он не печатает. Измеряется по `elapsed=… s` в строках `Capture … CUDA graph end.`

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-cudagraph-gc
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-cudagraph-gc --cuda-graph-max-bs-decode 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
