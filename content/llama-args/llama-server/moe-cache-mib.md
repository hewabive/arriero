---
schema: 1
primaryName: "--moe-cache-mib"
title: "--moe-cache-mib"
summary: "Выделяет на GPU кеш размером `N` MiB для MoE experts, оставленных в RAM через `--cpu-moe`/`--n-cpu-moe`/`-ot`: при генерации часто используемые experts читаются из VRAM, а не считаются на CPU. `0` (по умолчанию) выключает кеш; при нескольких GPU бюджет делится как слои."
category: "Общие параметры"
valueType: "number"
estimation: "normal"
valueHint: "N"
aliases:
  - "--moe-cache-mib"
allowedValues: []
env:
  - "LLAMA_ARG_MOE_CACHE_MIB"
related:
  - "--cpu-moe"
  - "--n-cpu-moe"
  - "--override-tensor"
  - "--gpu-layers"
  - "--tensor-split"
  - "--split-mode"
  - "--fit"
  - "--parallel"
---

# --moe-cache-mib

## Кратко

`--moe-cache-mib N` включает экспериментальный GPU-кеш для MoE expert weights, которые остались в host memory. Без кеша MoE-слой с experts в RAM на маленьком ubatch (генерация) считается на CPU. С кешем llama.cpp держит в VRAM недавно использованные experts, на каждом шаге догружает с хоста только недостающие и выполняет `mul_mat_id` на GPU.

Кеш имеет смысл только вместе с размещением experts в RAM: `--cpu-moe`, `--n-cpu-moe`, `--override-tensor ...exps=CPU` или авто-подбор `--fit`, который сам выносит experts из VRAM. `N` — общий бюджет VRAM в MiB на все GPU.

## Оригинальная справка llama.cpp

```text
GPU cache size in MiB for the MoE experts kept in the CPU. with multiple GPUs, it is split among them like the layers (--tensor-split) (default: 0, disabled)
```

## Паспорт аргумента

- Основное имя: `--moe-cache-mib`
- Алиасов нет
- Категория в `--help`: `Общие параметры`
- Тип значения в arriero: `number`
- Формат: целое число MiB, `N >= 0`
- Переменная окружения: `LLAMA_ARG_MOE_CACHE_MIB`
- Поле в `common_params`: `moe_cache_size` (байты, `N * 1024 * 1024`)
- Поле в `llama_context_params`: `moe_cache_size`, помечено `[EXPERIMENTAL]` в `include/llama.h`
- Значение по умолчанию: `0` — кеш выключен
- Этап применения: создание target-контекста после загрузки весов

## Что меняет в llama-server

Обработчик в `common/arg.cpp` отвергает отрицательное значение (`invalid value`) и пишет `N` MiB в `params.moe_cache_size`; `common_context_params_to_llama()` передает его в `llama_context_params`. При значении больше нуля конструктор `llama_context` создает `llama_moe_cache` (`src/llama-moe-cache.cpp`).

Кешируются только слои, у которых все expert tensors (`ffn_gate_exps`, `ffn_up_exps`, `ffn_down_exps` или `ffn_gate_up_exps`) лежат в host weight buffer, а сам слой назначен на GPU. Слой, у которого в RAM ушла только часть expert tensors, и слой, целиком оставшийся на CPU из-за `--gpu-layers`, не кешируются. Слои одного GPU с одинаковой раскладкой expert tensors (тип и форма) образуют группу с общим банком слотов и общим LRU.

Бюджет распределяется между GPU, которым назначены кешируемые слои: пропорционально `--tensor-split`, а если split не задан или весь нулевой — пропорционально свободной памяти устройств в момент создания контекста. GPU без кешируемых слоев бюджет не получает. Внутри GPU бюджет делится между группами пропорционально объему их host experts, так что каждая группа кеширует примерно одинаковую долю своих experts. Слот — это один expert во всех expert tensors слоя; группа получает столько слотов, сколько помещается в ее долю, с одним запасным слотом в конце банка (CUDA MMQ может читать за последним expert). Если слотов меньше `n_expert_used`, группа не кешируется.

Для кешируемого MoE-слоя graph делает lookup по host-таблице слотов (`slot_map`). Перед этим шагом scheduler вызывает copy callback: он читает с GPU выбранных router-ом experts, планирует слоты по LRU (попадания переносятся в конец очереди, промахи вытесняют самые давно использованные experts любого слоя группы), загружает недостающие experts из RAM в банк — соседние experts в соседние слоты одной копией — и отправляет обновленную таблицу на GPU. Затем `mul_mat_id` читает experts прямо из банка.

Путь через слоты включается только для ubatch не больше 32 токенов и только если distinct experts этого ubatch (`min(n_tokens * n_expert_used, n_expert)`) помещаются в слоты группы. Большие ubatch (prompt processing, крупные speculative verify-batch) идут обычным путем: при batch не меньше `GGML_OP_OFFLOAD_MIN_BATCH` ggml копирует используемые experts на GPU, и expert, который уже есть в кеше, копируется device-to-device из банка вместо загрузки из RAM. Большие batch кеш только читают и не вытесняют experts, нужные генерации.

Кеш есть только у target-контекста: `common_base_params_to_speculative()` обнуляет `moe_cache_size`, поэтому draft-модель и draft-контексты MTP/EAGLE-3/DFlash/DSpark создаются без кеша.

При `moe_cache_size > 0` `llama_context` не включает pipeline parallelism. На практике он и так выключен tensor overrides, без которых experts кешируемого слоя не оказываются в RAM.

## Значения и формат

- `0` — кеш выключен (по умолчанию).
- Положительное целое — общий бюджет VRAM в MiB. Фактический размер может быть меньше: число слотов ограничено числом host experts в кешируемых слоях (`слои × n_expert`) и округляется до целого слота.
- Отрицательное значение — `invalid value` при разборе аргументов.

Суффиксы не поддерживаются, а значение читается через `std::stoi`, который берет только ведущие цифры: `4G` молча превратится в `4` MiB, `1.5` — в `1`. Указывайте целое число MiB, например `4096`.

## Когда использовать

- MoE-модель запущена с experts в RAM (`--cpu-moe`, `--n-cpu-moe`, `-ot exps=CPU`), dense-часть на GPU, и после загрузки остается VRAM, которой мало для статического переноса еще одного слоя experts.
- Генерация упирается в CPU-вычисление experts, а router повторно выбирает одни и те же experts: повторные обращения становятся попаданиями в VRAM.
- Небольшой `--parallel`: в decode-ubatch мало токенов, и distinct experts одного шага помещаются в кеш.

Не включайте для dense-моделей, для MoE-моделей с experts в VRAM и без GPU backend. При медленном PCIe и низком hit rate кеш может не окупиться: каждый промах — загрузка целого expert во всех его tensors.

Сравните на своем workload два способа потратить одну и ту же VRAM: статически вернуть часть experts на GPU (уменьшить `N` в `--n-cpu-moe`) или отдать ее под кеш. Статическое размещение обходится без загрузок и синхронизаций, кеш покрывает горячие experts всех слоев.

## Влияние на производительность и память

VRAM: до `N` MiB суммарно по всем GPU; банки выделяются при создании контекста и не растут. В RAM добавляется только таблица слотов — `int32` на каждый expert каждого кешируемого слоя. В memory breakdown llama.cpp кеш попадает в столбец `context` своего GPU, поэтому `--fit`, который меряет память пробным no-alloc контекстом с теми же context params, этот расход видит.

Выигрыш ожидается на генерации при высоком hit rate. Каждый кешируемый MoE-слой добавляет отдельный split scheduler-а и точку синхронизации: CPU читает выбранных experts с GPU до планирования слотов. Промахи добавляют загрузки по PCIe. При маленьком кеше или низком hit rate генерация может стать медленнее чистого CPU-пути. Prompt processing меняется мало: большие batch идут через обычный offload, а кеш лишь заменяет загрузку уже закешированных experts копией внутри GPU.

Оценка памяти arriero этот кеш пока не учитывает: GPU-пулы занижены примерно на `N` MiB (или на объем host experts, если он меньше). Фактическая раскладка памяти, которую arriero собирает из строк `... buffer size = ...` в логе, кеш тоже не покажет: llama.cpp печатает его отдельной строкой `MoE cache size = ...`.

## Взаимодействие с другими аргументами

- `--cpu-moe`, `--n-cpu-moe`, `--override-tensor` создают host-resident experts; без них кешировать нечего. С `--n-cpu-moe N` кешируются только первые `N` слоев — experts остальных и так в VRAM.
- `--gpu-layers`: слой должен быть назначен на GPU. Слои вне GPU offload целиком считаются на CPU и не кешируются.
- `--tensor-split` задает доли бюджета между GPU — тот же массив, что для слоев. Без него доли считаются по свободной памяти на момент старта и могут отличаться между запусками; если split заполнил `--fit`, кеш следует ему.
- `--split-mode`: с `layer` каждый GPU кеширует свои слои; `tensor` несовместим — создание контекста падает с `MoE cache does not support tensor parallelism`.
- `--fit`: авто-fit MoE-модели может сам вынести experts в RAM, и кеш работает на этой раскладке. С пользовательскими tensor overrides fit, как и без кеша, отказывается менять размещение (`tensor_buft_overrides already set by user`).
- `--no-host`: experts, перенесенные на CPU, могут попасть в extra buffer (repack), который не считается host buffer; такие слои не кешируются.
- `--parallel`: в decode-ubatch по токену на каждый активный слот; при многих слотах distinct experts шага могут не поместиться, и шаг пойдет без кеша.
- `--spec-draft-cpu-moe` и `--spec-draft-n-cpu-moe`: на experts draft-модели кеш не распространяется.

## INI-пресеты и router-режим

```ini
[moe-model]
gpu-layers = all
cpu-moe = true
moe-cache-mib = 4096
```

В router mode задавайте `moe-cache-mib` только в preset конкретной MoE-модели. На dense-модели создание контекста падает с `MoE cache requires a MoE model`, без GPU — с `MoE cache requires a GPU backend`, поэтому глобальное значение router-а сломает загрузку таких моделей.

## Типовые проблемы и диагностика

При создании контекста для каждого GPU с кешируемыми слоями печатаются размер кеша и доля experts, которую он вмещает:

```text
<buffer type> MoE cache size = <MiB> MiB for <MiB> MiB of host experts
<n> layers, <type>: <slots> slots (<percent>%)
```

При освобождении контекста (остановка, выгрузка модели) печатается статистика попаданий; `ubatch <= 8` и `ubatch  > 8` относятся только к пути через слоты (до 32 токенов):

```text
llama_moe_cache: ubatch <= 8: hits = ..., misses = ..., hit rate = ...%, uploaded = ... MiB
llama_moe_cache: ubatch  > 8: hits = ..., misses = ..., hit rate = ...%, uploaded = ... MiB
llama_moe_cache: large batches: ... experts copied from the cache, ... MiB
```

- `failed to initialize the context: MoE cache requires a GPU backend` — нет GPU/iGPU backend-а (CPU-only сборка, `--device none`).
- `... MoE cache requires a MoE model` — модель dense.
- `... MoE cache does not support tensor parallelism` — задан `--split-mode tensor`.
- `... MoE cache is too small to hold the experts of one token` — ни одна группа не получила `n_expert_used` слотов; увеличьте `N`.
- Warning `MoE cache budget is too small for <n> layers, they are not cached` — доли конкретной группы (часто GPU с маленькой долей split) не хватает на `n_expert_used` experts.
- Warning `no layer has all of its experts in host memory, MoE cache is disabled` — experts в VRAM, слои не на GPU (`--gpu-layers 0`) или в RAM ушла только часть expert tensors слоя.
- Низкий hit rate и падение скорости: уменьшите `--parallel`, увеличьте кеш или верните часть experts на GPU статически.

## Примеры

```bash
llama-server --model /models/moe.gguf --gpu-layers all --cpu-moe --moe-cache-mib 4096
```

```bash
llama-server --model /models/moe.gguf --device CUDA0,CUDA1 --gpu-layers all --n-cpu-moe 30 --tensor-split 1,1 --moe-cache-mib 8192
```

```bash
LLAMA_ARG_MOE_CACHE_MIB=2048 llama-server --model /models/moe.gguf --gpu-layers all --cpu-moe
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/common/speculative.cpp`
- `llama.cpp/common/fit.cpp`
- `llama.cpp/include/llama.h`
- `llama.cpp/src/llama-moe-cache.h`
- `llama.cpp/src/llama-moe-cache.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/src/llama-graph.cpp`
- `llama.cpp/tools/server/README.md`
- https://github.com/ggml-org/llama.cpp/pull/29887
- https://github.com/ggml-org/llama.cpp/pull/30112
