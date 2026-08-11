---
schema: 1
engine: sglang
primaryName: "--kt-threadpool-count"
title: "--kt-threadpool-count"
summary: Число CPU-пулов KTransformers — по одному на NUMA-узел; оно же делит промежуточную размерность экспертов между узлами, поэтому должно совпадать с топологией хоста и с раскладкой конвертированных весов.
group: exec.moe
related:
  - --kt-cpuinfer
  - --kt-method
  - --kt-weight-path
  - --numa-node
---

# --kt-threadpool-count

## Кратко

`--kt-threadpool-count` задает, на сколько подпулов kt-kernel разобьет свои рабочие потоки. Подпул `i` привязывается к NUMA-узлу `i`, получает свою долю `--kt-cpuinfer` потоков и **свой срез весов экспертов**: `TP_MOE_Common` делит `intermediate_size` на число подпулов. Это не просто «сколько тредпулов», а параметр раскладки данных: он должен совпадать с реальным числом NUMA-узлов и с тем, под сколько узлов сконвертированы CPU-веса. Объявленный default — `2`, и на односокетной машине он неверен.

## Оригинальная справка

```text
[ktransformers parameter] One-to-one with the number of NUMA nodes (one thread pool per NUMA).
```

## Паспорт аргумента

- Флаги: `--kt-threadpool-count`
- Группа: `exec.moe`
- Тип значения: целое
- Допустимые значения: не ограничены на уровне argparse; практический диапазон — число онлайн NUMA-узлов (`lscpu | grep "NUMA node(s)"`), в документации kt-kernel — 1-2 для односокетных и 2-4 для двухсокетных хостов
- Значение по умолчанию: `2` — фиксированная константа, а не автоопределение топологии
- Эффективное значение: не переопределяется; `ServerArgs.__post_init__` это поле не читает
- Где объявлен: `ServerArgs.kt_threadpool_count`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, реализация во внешнем пакете `kt_kernel`
- Этап применения: создание синглтона `CPUInfer` и конструктор TP-объекта каждого MoE-слоя

## Что меняет в движке

Значение идет в `KTConfig.threadpool_count` → `KTMoEWrapper(threadpool_count=…)` и используется дважды.

**1. Раскладка потоков.** В `_get_cpu_infer` (`ktransformers/kt-kernel/python/experts_base.py`) строится `WorkerPoolConfig`: `subpool_count = threadpool_count`, `subpool_numa_map = list(range(threadpool_count))` (апстрим-SGLang не передает явный список узлов), `subpool_thread_count` — деление `--kt-cpuinfer` с остатком в пользу первых пулов. `WorkerPool::init` для каждого подпула вызывает `set_to_numa(node)` (`numa_bind` по CPU и памяти) и создает `InNumaPool`, чьи потоки прикрепляются к отдельным ядрам этого узла.

**2. Раскладка весов.** `TP_MOE_Common` (`ktransformers/kt-kernel/operators/moe-tp.hpp`) читает `tp_count = config.pool->config.subpool_count` и строит по одному TP-объекту на подпул:

- обычные backend'ы: `tp_config.intermediate_size = intermediate_size / tp_count`, при неделимости — `std::runtime_error("For TP, intermediate_size must be a multiple of NUMA node count")`;
- `LLAMAFILE`: разбиение по блокам `QK_K = 256`; требуется делимость `intermediate_size` на 256 и хотя бы один блок на пул, иначе `intermediate_size too small: cannot distribute blocks to all TP instances`. Тот же расчет продублирован на Python-стороне в `LlamafileMoEWrapper.__init__` с сообщением, перечисляющим допустимые значения `threadpool_count`.

Результаты подпулов сводятся в `merge_results`. Для AMX-методов срез весов берется по индексу подпула из шардированного каталога: `config_.gate_projs[tp_part_idx][logical_expert_id]` (`ktransformers/kt-kernel/operators/amx/moe.hpp`). Для native-методов (`RAWINT4`, `FP8`, `BF16`, `MXFP4`, `MXFP8`, `GPTQ_INT4`) NUMA-размерность указателей равна `1` — все подпулы читают один буфер со своим смещением.

## Значения и формат

- `1` — один пул, без разбиения. Единственно верное значение на односокетном хосте с одним NUMA-узлом.
- Значение больше числа онлайн-узлов: `set_memory_to_numa` печатает в stderr `NUMA node <n> not found.`, привязка не выполняется, а разбиение весов все равно происходит — конфигурация работает, но смысла в ней нет.
- Значение должно быть согласовано с весами:
  - AMX-каталог конвертируется скриптом `convert_cpu_weights.py --threadpool-count N`, и в ключах `blk.<layer>.ffn_*_exps.<expert>.numa.<id>.weight` появляется ровно `N` шардов. При запуске с бо́льшим `--kt-threadpool-count` индекс подпула выйдет за границы массива шардов;
  - native-методам конвертация не нужна, ограничение только на делимость `intermediate_size`;
  - `LLAMAFILE` дополнительно требует кратности 256.
- Значение — не «параллелизм ради скорости», а деление одной и той же работы. Увеличение числа пулов без увеличения `--kt-cpuinfer` просто дробит те же потоки.

## Когда использовать

- Ставьте ровно `NUMA node(s)` из `lscpu`. Это единственная рекомендация, которую дает и kt-kernel: число узлов не равно числу сокетов, узлы могут делиться внутри одного процессора (NPS/SNC).
- На односокетной UMA-машине явно указывайте `1`: дефолт `2` создаст второй пул для несуществующего узла.
- Не увеличивайте значение, чтобы «получить больше параллелизма»: параллелизм внутри узла задается `--kt-cpuinfer`.
- Не меняйте значение без перегенерации AMX-весов.

## Влияние на производительность и память

- Правильное число пулов дает главный эффект — локальность памяти: каждый узел считает свой срез экспертов из своей же памяти, суммарная пропускная способность памяти складывается по узлам.
- Общий объем весов в RAM от значения практически не зависит: это разбиение, а не копирование. Разбиение при этом определяет, **на каком узле** окажется каждая часть, поэтому перекос в размещении лечится этим аргументом, а не внешним `interleave`.
- Буферы активаций выделяются на каждый подпул отдельно (`local_output_numa`, `shared_mem_buffer_numa`), их размер задается `chunked_prefill_size` и размером батча — рост с числом пулов есть, но он мал относительно весов.
- На VRAM не влияет.
- Неверное значение обычно проявляется не как замедление, а как отказ на старте (исключение при делении) или как молчаливая потеря привязки.

## Взаимодействие с другими аргументами

- `--kt-cpuinfer`: делимое. `--kt-cpuinfer 64 --kt-threadpool-count 2` — по 32 потока на узел.
- `--kt-method`: определяет вид ограничения на делимость (`QK_K` у `LLAMAFILE`) и то, шардированы ли веса физически (AMX) или нарезаются смещением (native).
- `--kt-weight-path`: у AMX должен содержать ровно столько NUMA-шардов, сколько пулов.
- `--numa-node` — это про NUMA-привязку подпроцессов SGLang, а не про пулы kt-kernel; аргументы независимы.
- В arriero: preflight требует положительного значения, а при значении больше `1` — обязательного списка узлов (аргумент `--kt-numa-nodes`, он есть в форке `sglang-kt`, но **отсутствует** в апстрим-декларации, из которой снят этот extract). Количество узлов должно совпадать с числом пулов, значения — быть уникальными и онлайн. Режим `interleave` для KTransformers запрещен, а внешний `bind` обязан совпадать со всеми внутренними узлами (`docs/NUMA_PINNING.md`, `docs/KTRANSFORMERS_SUPPORT.md`).

## Типовые проблемы и диагностика

- `RuntimeError: For TP, intermediate_size must be a multiple of NUMA node count` — промежуточная размерность модели не делится на число пулов. Возьмите делитель (обычно `1` или `2`).
- `intermediate_size must be divisible by QK_K (256) for Llamafile backend` / `intermediate_size too small` — ограничение GGUF-пути; Python-сообщение перечисляет допустимые значения.
- `NUMA node <n> not found.` в stderr — пулов больше, чем узлов.
- Выход за границы массива шардов при AMX — признак рассинхронизации `--kt-threadpool-count` и `--threadpool-count` конвертации. Пересоберите веса.
- Фактическую раскладку показывают строки старта: `WorkerPool[0x…] N subpools, [numa:threads][0:32] [1:32]`, затем `In Numa Worker Pool at NUMA <node>, <threads> threads`, а для каждого слоя — `TP MOE layer <idx>, pool: …` и (для AMX) `Creating AMX_MOE_TP <tp> at numa <node>`. Для `LLAMAFILE` печатается полный блок `[LlamafileMoEWrapper] Layer N TP configuration` с размером и смещением каждого TP.
- Принятое значение аргумента — в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kt-weight-path /models/Qwen3-30B-A3B-Q4_K_M --kt-method LLAMAFILE --kt-cpuinfer 8 --kt-threadpool-count 1 --kt-num-gpu-experts 32
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-R1 --kt-weight-path /models/DeepSeek-R1-INT4 --kt-method AMXINT4 --kt-cpuinfer 60 --kt-threadpool-count 2 --kt-num-gpu-experts 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- `ktransformers/kt-kernel/python/experts_base.py`
- `ktransformers/kt-kernel/python/utils/llamafile.py`
- `ktransformers/kt-kernel/python/utils/amx.py`
- `ktransformers/kt-kernel/cpu_backend/worker_pool.cpp`
- `ktransformers/kt-kernel/cpu_backend/worker_pool.h`
- `ktransformers/kt-kernel/operators/moe-tp.hpp`
- `ktransformers/kt-kernel/operators/amx/moe.hpp`
- `ktransformers/kt-kernel/scripts/convert_cpu_weights.py`
- `ktransformers/kt-kernel/README.md`
- arriero: `docs/NUMA_PINNING.md`, `docs/KTRANSFORMERS_SUPPORT.md`, `docs/KTRANSFORMERS_OPERATIONS.md`
