---
schema: 1
engine: vllm
primaryName: "--cudagraph-capture-sizes"
title: "--cudagraph-capture-sizes"
summary: Явный список размеров батча, для которых захватываются CUDA-графы, вместо автоматически сгенерированной решётки. Прямая ручка над временем старта и над размером графового пула в VRAM.
group: CompilationConfig
related:
  - --max-cudagraph-capture-size
  - --compilation-config
  - --enforce-eager
  - --max-num-seqs
  - --max-num-batched-tokens
  - --gpu-memory-utilization
  - --optimization-level
  - --performance-mode
  - --enable-lora
  - --speculative-config
  - --attention-backend
---

# --cudagraph-capture-sizes

## Кратко

CUDA-граф захватывается под фиксированное число токенов в батче. vLLM захватывает не все размеры, а решётку и на исполнении добивает батч до ближайшего захваченного размера сверху; батч больше самого крупного захваченного размера идёт мимо графов, в обычном eager/compiled режиме.

`--cudagraph-capture-sizes` заменяет автоматически построенную решётку своим списком. Это единственный способ сказать «захвати только эти пять размеров»: короче список — быстрее старт и меньше графовый пул, но больше padding-оверхед на размерах между узлами решётки.

## Оригинальная справка

```text
Sizes to capture cudagraph.
- None (default): capture sizes are inferred from vllm config.
- list[int]: capture sizes are specified as given.
```

## Паспорт аргумента

- Флаги: `--cudagraph-capture-sizes`
- Группа argparse: `CompilationConfig`
- Тип значения: список целых, argparse получает `type=int, nargs="+"` — значения перечисляются через пробел
- Допустимые значения: любые положительные целые; список дедуплицируется и сортируется, значения больше `max_num_batched_tokens` отбрасываются
- Значение по умолчанию: `None` — «решётку строит движок»
- Эффективное значение: почти всегда переопределяется. `VllmConfig._set_cudagraph_sizes()` фильтрует список по `max_num_batched_tokens`, при последовательном параллелизме округляет его (`update_sizes_for_sequence_parallelism`), при спекулятивном декодировании округляет вверх до кратного `num_speculative_tokens + 1` (`adjust_cudagraph_sizes_for_spec_decode`), а при `--enforce-eager` или `cudagraph_mode=NONE` обнуляет в `[]`. Итоговый список всегда записывается обратно в конфиг
- Где объявлен: `vllm/config/compilation.py:CompilationConfig.cudagraph_capture_sizes`
- Этап применения: сборка `VllmConfig` (`_set_cudagraph_sizes` → `post_init_cudagraph_sizes`) → инициализация cudagraph-диспетчера после выбора backend'а внимания → профилирование памяти графов → захват графов в прогреве worker'а

## Что меняет в движке

Если аргумент не задан, `_set_cudagraph_sizes()` строит решётку сам:

```
max = min(max_num_seqs × (1 + num_speculative_tokens) × 2,
          1024 если data center Blackwell иначе 512)
max = min(max, max_num_batched_tokens)
sizes = [1, 2, 4] + range(8, min(max+1, 256), 8) + range(256, max+1, 16)
```

плюс `max_num_batched_tokens`, если он помещается в `max`. При `--performance-mode interactivity` мелкая часть заменяется на сплошной `range(1, min(max, 32) + 1)` — по графу на каждый размер до 32.

Если аргумент задан, вся эта ветка пропускается: берётся ваш список, из него выбрасывается всё, что больше `max_num_batched_tokens`, результат сортируется. Если после фильтрации список стал короче исходного, в лог уходит `cudagraph_capture_sizes specified in compilation_config [...] is overridden by config [...]`.

Дальше `CudagraphDispatcher.initialize_cudagraph_keys()` разворачивает список в конкретные графы:

- в mixed-режиме (`PIECEWISE` или `FULL`) — по графу на каждый размер из списка;
- при `cudagraph_mode` с отдельной decode-веткой (`FULL_AND_PIECEWISE`, `FULL_DECODE_ONLY`) дополнительно захватываются FULL-графы decode для размеров `≤ max_num_seqs × (1 + num_speculative_tokens)`;
- при включённой LoRA и `cudagraph_specialize_lora=True` каждый размер захватывается дважды (с активными адаптерами и без).

То есть число реальных графов заметно больше длины списка. `GPUModelRunner.profile_cudagraph_memory()` перед выделением KV-cache печатает раскладку — `Profiling CUDA graph memory: PIECEWISE=51 (largest=512), FULL=4 (largest=4)` — и оценку `Estimated CUDA graph memory: X GiB total`, которая вычитается из бюджета `--gpu-memory-utilization`. Сам захват в `capture_model()` идёт от больших размеров к меньшим (мелкие переиспользуют пул крупных), с прогресс-баром `Capturing CUDA graphs (decode, FULL)` / `(mixed prefill-decode, PIECEWISE)` и финальной строкой `Graph capturing finished in N secs, took X GiB` (комментарий в коде оценивает типичное время в 5–20 секунд).

На исполнении диспетчер округляет фактическое число токенов вверх до ближайшего захваченного размера. Разница между фактическим и захваченным размером — это впустую посчитанные позиции, поэтому редкая решётка на больших батчах даёт постоянный накладной расход.

## Значения и формат

- Форма записи: `--cudagraph-capture-sizes 1 2 4 8 16`. `nargs="+"` — значения разделяются пробелами, `None` этот аргумент не принимает (в отличие от `--max-cudagraph-capture-size` тип не обёрнут в `optional_type`), чтобы «вернуть автоподбор», флаг просто не передают.
- Эквивалентные структурные формы через `--compilation-config`: `-cc '{"cudagraph_capture_sizes": [1,2,4,8]}'` или точечный под-флаг `-cc.cudagraph_capture_sizes '[1,2,4,8]'`.
- Пустой список запрещён: `assert len(...) > 0, "cudagraph_capture_sizes should contain at least one element when using cuda graph."` Чтобы выключить графы, используйте `-cc.cudagraph_mode=none` или `--enforce-eager`.
- Значения не обязаны быть степенями двойки или кратными восьми; ограничение только одно — соответствие `--max-cudagraph-capture-size`, если тот задан тоже.
- `post_init_cudagraph_sizes()` проверяет инвариант `cudagraph_capture_sizes[-1] == max_cudagraph_capture_size` ассертом, так что рассогласование после всех правок — это внутренняя ошибка, а не пользовательская.

## Когда использовать

- **Тесная карта.** Профилирование показало гигабайт-плюс в статье CUDA graph memory, а KV-cache не помещается. Список из 4–8 размеров, покрывающих реальный профиль нагрузки, отдаёт большую часть этого гигабайта под KV-cache, сохраняя графы там, где они действительно работают (мелкий decode).
- **Долгий старт при частых рестартах.** Захват — обычно самая заметная часть старта после компиляции. Пять размеров вместо пятидесяти сокращают её примерно во столько же раз.
- **Известный профиль трафика.** Одиночный интерактивный пользователь: `1 2 4 8`. Пакетная обработка с постоянным батчем 32: `8 16 32`.
- **Не трогайте при однородной нагрузке и свободной VRAM.** Автоматическая решётка уже ограничена `max_num_seqs × 2`, и на маленьком `--max-num-seqs` она короткая сама по себе.
- **Не делайте список из одного крупного значения.** Все батчи меньше него будут добиваться до него же — это худший padding-оверхед из возможных.

## Влияние на производительность и память

- **VRAM.** Расход графового пула складывается из «первого захвата» на режим (общие буферы) плюс примерно постоянной добавки на каждый последующий граф; `profile_cudagraph_memory` измеряет обе величины на первых двух графах каждого режима и экстраполирует. FULL и PIECEWISE делят общий пул, поэтому берётся `max` их общих частей плюс сумма поштучных; графы энкодера считаются отдельным слагаемым. Сокращение списка вдвое убирает примерно половину поштучной части.
- **Время старта.** Линейно по числу графов: каждый размер это `cudagraph_num_of_warmups` прогревочных прогонов плюс сам захват. Плюс отдельный прогон профилирования графовой памяти ещё до выделения KV-cache.
- **Latency.** Захваченные размеры дают минимальную latency шага; размеры между узлами решётки платят padding'ом, размеры больше максимума полностью теряют выигрыш графа.
- **Throughput.** Под конкурентной нагрузкой падает, если реальные батчи регулярно попадают в разрыв решётки или превышают максимум.

## Взаимодействие с другими аргументами

- `--max-cudagraph-capture-size`: задавать оба можно только согласованно — максимум должен равняться последнему элементу списка, иначе `ValueError: customized max_cudagraph_capture_size(=N) should be consistent with the max value of cudagraph_capture_sizes(=M)`.
- `--max-num-batched-tokens`: жёсткий потолок. Всё, что больше, вырезается из списка молча (кроме предупреждения об укорачивании).
- `--max-num-seqs`: через него считается автоматический максимум (`max_num_seqs × decode_query_len × 2`) и потолок для FULL-графов decode. При явном списке на автоматический максимум он уже не влияет, но decode-ветка по-прежнему обрезается по `max_num_seqs`.
- `--enforce-eager`: список принудительно становится `[]`, а `max_cudagraph_capture_size` — `0`; задавать флаги вместе бессмысленно.
- `--compilation-config`: `-cc.cudagraph_mode` решает, будут ли графы вообще и сколько режимов захватывается; `-cc.compile_sizes` умеет принять строку `"cudagraph_capture_sizes"` и скомпилировать ровно те же размеры.
- `--optimization-level`: определяет дефолтный `cudagraph_mode` (`O0` → `NONE`, `O1` → `PIECEWISE`, `O2`/`O3` → `FULL_AND_PIECEWISE`), то есть во сколько наборов графов развернётся ваш список.
- `--performance-mode interactivity`: меняет только автоматическую решётку; явный список её вытесняет и режим перестаёт влиять.
- `--speculative-config`: все размеры округляются вверх до кратного `num_speculative_tokens + 1`; если после округления не осталось ни одного валидного размера — `ValueError: No valid cudagraph sizes after rounding to multiple of N`.
- `--enable-lora`: удваивает число графов при `cudagraph_specialize_lora=True` (значение по умолчанию).
- `--attention-backend`: backend с ограниченной поддержкой графов понижает `cudagraph_mode`, и часть наборов из вашего списка просто не захватывается.
- `--gpu-memory-utilization`: список меняет распределение внутри бюджета, а не сам бюджет; освободившееся уходит в KV-cache.

## Типовые проблемы и диагностика

- **Симптом:** OOM в момент `Capturing CUDA graphs`, до выдачи первого запроса. **Причина:** оценка графовой памяти не покрыла реальный расход (частый случай — LoRA или mamba-модель). **Лечение:** сократить список до нескольких мелких размеров либо понизить `--gpu-memory-utilization`.
- **Симптом:** старт занимает минуты, лог висит на прогресс-баре захвата. **Проверка:** строка `Profiling CUDA graph memory: PIECEWISE=51 (largest=512), FULL=32 (largest=32)` показывает точное число графов. **Лечение:** явный короткий список.
- **Симптом:** задали `--cudagraph-capture-sizes 1 2 4 8` и `--max-cudagraph-capture-size 512`, старт падает на `should be consistent with the max value`. **Лечение:** убрать один из двух флагов; максимум и так выводится из списка.
- **Симптом:** в логе `cudagraph_capture_sizes specified in compilation_config [1, 2, 4, 8192] is overridden by config [1, 2, 4]`. **Причина:** значения больше `--max-num-batched-tokens` вырезаны. **Лечение:** либо поднять `--max-num-batched-tokens`, либо убрать заведомо недостижимые размеры.
- **Симптом:** после сокращения списка выросла latency под нагрузкой. **Причина:** реальные размеры батча попадают в разрывы решётки и добиваются вверх. **Лечение:** добавить узлы вокруг фактического распределения — его видно по `GPU KV cache usage` и числу активных запросов в периодическом логе.
- **Симптом:** `max_num_seqs (N) exceeds available Mamba cache blocks (M) ... CUDA graph capture cannot proceed`. **Причина:** FULL-графы decode для гибридной mamba-модели требуют по блоку состояния на последовательность. **Лечение:** понизить `--max-num-seqs` или поднять `--gpu-memory-utilization`, список размеров тут не поможет.
- **Подтверждение принятого значения:** строки `Profiling CUDA graph memory: ...`, `Estimated CUDA graph memory: X GiB total` и финальная `Graph capturing finished in N secs, took X GiB`. Отсутствие всех трёх означает, что графы отключены.

## Примеры

```bash
vllm serve /models/Qwen3-4B --cudagraph-capture-sizes 1 2 4 8 --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --compilation-config '{"cudagraph_capture_sizes": [1, 2, 4, 8, 16]}' --max-num-seqs 16
```

## Источники

- `vllm/vllm/config/compilation.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/cudagraph_dispatcher.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/docs/design/cuda_graphs.md`
- `vllm/docs/design/torch_compile.md`
- `vllm/docs/configuration/conserving_memory.md`
