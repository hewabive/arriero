---
schema: 1
engine: sglang
primaryName: "--enable-profile-cuda-graph"
title: "--enable-profile-cuda-graph"
summary: Оборачивает захват decode-графа в `torch.profiler` и запись истории CUDA-аллокаций, печатает в лог топ-10 ядер по CPU и GPU времени и дампит снимок памяти в `cuda_graph_runner_memory_usage.pickle`. Диагностический флаг: захват становится медленнее и прожорливее.
group: exec.graph
related:
  - --cuda-graph-backend-decode
  - --cuda-graph-max-bs-decode
  - --cuda-graph-bs-decode
  - --disable-decode-cuda-graph
  - --enable-cudagraph-gc
  - --debug-cuda-graph
  - --cuda-graph-config
  - --speculative-algorithm
---

# --enable-profile-cuda-graph

## Кратко

Флаг отвечает на вопрос «куда ушли секунды и мегабайты на захвате графов». Он включает торч-профилировщик вокруг всего цикла захвата decode-фазы, включает `torch.cuda.memory._record_memory_history()` и после захвата пишет в лог две таблицы (топ-10 по CUDA-времени и по CPU-времени) и снимок аллокаций на диск. Это инструмент разбора, а не эксплуатационная настройка: он замедляет старт и увеличивает потребление памяти во время захвата.

## Оригинальная справка

```text
Enable profiling of cuda graph capture.
```

## Паспорт аргумента

- Флаги: `--enable-profile-cuda-graph`
- Группа: `exec.graph`
- Тип значения: bool, `action="store_true"` — значение не принимает
- Допустимые значения: флаг либо есть, либо его нет
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется в `__post_init__`
- Где объявлен: `ServerArgs.enable_profile_cuda_graph`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, диагностический
- Этап применения: захват графов — `DecodeCudaGraphRunner.capture()` и одноименные методы спекулятивных и CPU-runner'ов

## Что меняет в движке

Флаг читают только decode-подобные runner'ы: `runner/decode_cuda_graph_runner.py`, `cpu_graph_runner.py` и четыре спекулятивных runner'а (`eagle_draft_*`, `frozen_kv_mtp_*`, `multi_layer_eagle_draft_extend_*`). **Prefill-runner его не читает** — захват prefill-графа не профилируется.

В `DecodeCudaGraphRunner.capture()`:

1. `_init_profile_context_and_memory_record()` создает профилировщик и вызывает `torch.cuda.memory._record_memory_history()`;
2. весь цикл захвата выполняется внутри контекста профилировщика;
3. `_post_process_after_profile()` пишет `torch.cuda.memory._dump_snapshot("cuda_graph_runner_memory_usage.pickle")` (относительный путь — файл ложится в текущий рабочий каталог процесса), отключает запись истории и печатает в лог блок вида `Sorted by CUDA Time:` / `Sorted by CPU Time:` с таблицами `key_averages(group_by_input_shape=True)` на 10 строк, плюс строку `Memory Usage is saved to cuda_graph_runner_memory_usage.pickle`.

Есть два режима, различаемые переменными окружения (сам флаг обязателен в обоих):

- по умолчанию — один непрерывный профилировщик на весь захват; chrome-trace выгружается, только если задано `SGLANG_ENABLE_CUDA_GRAPH_CAPTURE_TRACE=1`, файл — `<SGLANG_TORCH_PROFILER_DIR>/graph_capture_profile/cuda_graph_capture-<RunnerClass>-TP-<rank>.json.gz` (по умолчанию `SGLANG_TORCH_PROFILER_DIR=/tmp`);
- `SGLANG_GRAPH_BATCH_CAPTURE=1` (и при этом `SGLANG_ENABLE_CUDA_GRAPH_CAPTURE_TRACE` не задан) — профилировщик с расписанием `wait=2, warmup=0, active=1`, шагающий на каждом размере батча; на каждую форму пишется отдельный файл `<dir>/<RunnerClass>_bs_<bs>_rank<rank>.json.gz` и строка `Saved trace for bs=… to …`.

## Значения и формат

- Значения не принимает.
- Файл `cuda_graph_runner_memory_usage.pickle` пишется по относительному пути. В arriero процесс инстанса стартует из рабочего каталога менеджера — учитывайте это, если ищете файл.
- Каталог trace-файлов задается только переменной окружения `SGLANG_TORCH_PROFILER_DIR`, CLI-флага для него нет.
- Профилирование prefill-захвата этим флагом не включается.

## Когда использовать

- Захват decode-графов занимает подозрительно много времени, и нужно понять, какие ядра его съедают.
- Захват падает по памяти, и нужен снимок аллокаций (`cuda_graph_runner_memory_usage.pickle` открывается в `https://docs.pytorch.org/memory_viz`).
- Сравнение backend'ов (`full` против `breakable`) или влияния `--cuda-graph-bs-decode` на стоимость захвата.
- Не оставляйте флаг во включенном состоянии постоянно: он удлиняет старт, пишет мегабайтные файлы при каждом запуске и раздувает лог двумя таблицами.

## Влияние на производительность и память

- **Время старта.** Растет: профилировщик с `record_shapes=True`, `with_stack=True`, `with_flops=True`, `profile_memory=True` (в per-bs режиме) добавляет накладные расходы на каждый шаг захвата.
- **RAM хоста.** `_record_memory_history()` копит записи об аллокациях за весь захват; на длинных списках форм это сотни мегабайт.
- **Диск.** Снимок памяти и chrome-trace — от единиц до сотен мегабайт.
- **VRAM.** Прямого влияния нет; профилировщик работает на стороне хоста.
- **Работа сервера после старта:** нулевое влияние, флаг действует только во время захвата.

## Взаимодействие с другими аргументами

- `--disable-decode-cuda-graph` / `--cuda-graph-backend-decode disabled`: захвата нет — флаг ничего не делает.
- `--cuda-graph-max-bs-decode` / `--cuda-graph-bs-decode`: определяют число профилируемых шагов и объем trace-файлов.
- `--enable-cudagraph-gc`: вместе с профилировщиком захват становится еще дороже.
- `--debug-cuda-graph`: другой инструмент — он не измеряет, а переводит исполнение в eager внутри пути захвата/реплея; их можно использовать вместе, но тогда таблицы покажут eager-исполнение, а не реальный граф.
- `--speculative-algorithm`: профилируются и draft-runner'ы, файлы различаются именем класса runner'а в имени trace.
- `--cuda-graph-backend-prefill`: prefill-захват флагом не покрывается.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, а в логе нет таблиц. **Причина:** decode-граф отключен, либо `--device` не поддерживает захват. **Проверка:** наличие строк `Capture target decode CUDA graph begin/end`.
- **Симптом:** нет chrome-trace, хотя таблицы напечатались. **Причина:** trace выгружается только при `SGLANG_ENABLE_CUDA_GRAPH_CAPTURE_TRACE=1` или `SGLANG_GRAPH_BATCH_CAPTURE=1`.
- **Симптом:** захват стал падать по хостовой памяти именно с этим флагом. **Причина:** история аллокаций. **Решение:** снять флаг либо сократить список форм.
- **Симптом:** не находится `cuda_graph_runner_memory_usage.pickle`. **Причина:** относительный путь — файл в рабочем каталоге процесса, не в каталоге модели и не в `SGLANG_TORCH_PROFILER_DIR`.
- **Что смотреть:** блок `Sorted by CUDA Time:` в логе, строку `Memory Usage is saved to cuda_graph_runner_memory_usage.pickle`, при включенных env — `CUDA graph capture trace saved to: …` или `Saved trace for bs=… to …`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-profile-cuda-graph --cuda-graph-max-bs-decode 8
```

```bash
SGLANG_GRAPH_BATCH_CAPTURE=1 SGLANG_TORCH_PROFILER_DIR=/var/tmp/sglang-profile python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --enable-profile-cuda-graph --cuda-graph-bs-decode 1 2 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/full_cuda_graph_backend.py`
- `sglang/python/sglang/srt/utils/profile_utils.py`
- `sglang/python/sglang/srt/environ.py`
