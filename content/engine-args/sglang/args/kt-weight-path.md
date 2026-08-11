---
schema: 1
engine: sglang
primaryName: "--kt-weight-path"
title: "--kt-weight-path"
summary: Каталог с CPU-весами экспертов и одновременно единственный переключатель всего гибридного режима KTransformers — без него остальные `--kt-*` не читаются вообще.
group: exec.moe
related:
  - --kt-method
  - --kt-num-gpu-experts
  - --kt-cpuinfer
  - --kt-threadpool-count
  - --model-path
---

# --kt-weight-path

## Кратко

`--kt-weight-path` задает локальный каталог, из которого kt-kernel читает веса экспертов, считаемых на CPU. Это же значение работает как флаг включения: в `create_kt_config_from_server_args` первая проверка — `if server_args.kt_weight_path is None: return None`, и при пустом значении ни один MoE-слой не оборачивается в `KTEPWrapperMethod`, а все прочие `--kt-*` остаются мертвым грузом в `ServerArgs`. Содержимое каталога должно соответствовать выбранному `--kt-method`: у AMX-методов это отдельный конвертированный набор, у native-методов (FP8/BF16/RAWINT4) — тот же каталог, что и у GPU-весов.

## Оригинальная справка

```text
[ktransformers parameter] The path of the quantized expert weights for amx kernel. A local folder.
```

## Паспорт аргумента

- Флаги: `--kt-weight-path`
- Группа: `exec.moe`
- Тип значения: строка — путь к локальному каталогу (`Optional[str]`)
- Допустимые значения: не ограничены; проверка существования выполняется не SGLang, а загрузчиком kt-kernel
- Значение по умолчанию: `null` (аргумент не задан ⇒ интеграция KTransformers выключена)
- Эффективное значение: не переопределяется; ни один `_handle_*` в `ServerArgs.__post_init__` не читает это поле
- Где объявлен: `ServerArgs.kt_weight_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но целиком относится к внешнему пакету `kt_kernel`; без установленного `kt_kernel` инициализация падает с `ImportError`
- Этап применения: конструктор `FusedMoE` при загрузке модели (по одному `KTConfig` на MoE-слой), затем `process_weights_after_loading`

## Что меняет в движке

Значение попадает в `KTConfig.weight_path` и оттуда в конструктор `kt_kernel.KTMoEWrapper`. Порядок такой:

1. `FusedMoE.__init__` (`sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`) вызывает `create_kt_config_from_server_args(server_args, layer_id)`. Если путь задан, обычный quant-метод слоя оборачивается: `self.quant_method = KTEPWrapperMethod(gpu_method, kt_config)`.
2. `KTEPWrapperMethod.create_weights` создает GPU-веса только для первых `--kt-num-gpu-experts` экспертов и **лишь на `tp_rank == 0`** конструирует `KTMoEWrapper` с этим путем.
3. `process_weights_after_loading` вызывает `wrapper.load_weights(physical_to_logical_map_cpu)`; карта физических→логических экспертов берется из метаданных EPLB (`get_global_expert_location_metadata()`), то есть раскладка CPU-экспертов согласована с `--ep-num-redundant-experts` и `--init-expert-location`.

Дальше путь интерпретирует конкретный backend kt-kernel (`ktransformers/kt-kernel/python/experts.py`, `_create_inference_wrapper`):

- `AMXINT4` / `AMXINT8` → `AMXMoEWrapper`. Если в каталоге есть `*.safetensors`, включается «merged»-режим и `SafeTensorLoader` строит карту тензоров рекурсивным обходом каталога; ключи имеют вид `blk.{layer}.ffn_{gate,up,down}_exps.{expert}.numa.{numa_id}.{weight,scale}`. Если `.safetensors` нет, путь передается в C++ как `moe_config.path`, и слой читает файлы `_layer_<idx>/_numa_<tp>/…kt`.
- `LLAMAFILE` → `LlamafileMoEWrapper`, каталог с GGUF; отсутствие пути дает `FileNotFoundError: GGUF weight path not found`.
- `RAWINT4`, `FP8`, `FP8_PERCHANNEL`, `BF16`, `MXFP4`, `MXFP8`, `GPTQ_INT4` → `NativeMoEWrapper` с профильным загрузчиком safetensors; ключи ищутся по префиксам `model.layers.<idx>`, `language_model.model.layers.<idx>`, `model.language_model.layers.<idx>` — то есть по обычной раскладке HF-чекпойнта.

Ничего в SGLang путь не валидирует: ни `os.path.exists`, ни проверки соответствия методу. Все ошибки приходят из kt-kernel уже во время загрузки весов слоя.

## Значения и формат

- Только локальный каталог. HF repo id, URL и путь до одного файла не поддерживаются: `SafeTensorLoader` обходит каталог `os.walk`, а `AMXMoEWrapper` ищет `glob(os.path.join(weight_path, "*.safetensors"))`. Формально `SafeTensorLoader.__load_tensor_file_map` принимает и файл (берет его каталог), но `AMXMoEWrapper` до этого уже решит режим по `glob` в самом пути.
- Значение не задано ⇒ гибридный режим выключен целиком. Это единственный способ «выключить KTransformers», не убирая остальные `--kt-*`.
- Пустая строка формально пройдет argparse (`kt_weight_path` станет `""`, что не `None`), включит обертку и упадет в загрузчике. Не используйте пустое значение как «выключено».
- Для AMX-каталога число NUMA-шардов в именах ключей (`numa.<id>`) должно совпадать с `--kt-threadpool-count`: индекс подпула используется прямо как индекс шарда (`config_.gate_projs[tp_part_idx]` в `ktransformers/kt-kernel/operators/amx/moe.hpp`).
- Для native-методов путь обычно совпадает с `--model-path`: веса делят CPU и GPU. Это нормальная конфигурация, а не ошибка (см. примеры запуска в туториалах KTransformers).

## Когда использовать

- Всегда, когда нужен гибридный CPU+GPU MoE: модель не помещается в VRAM целиком, а хостовой RAM и CPU-ядер достаточно, чтобы держать «холодных» экспертов.
- Не задавайте путь, если модель целиком помещается на GPU: обертка добавляет копирования hidden states в pinned-буферы и синхронизацию с CPU на каждом MoE-слое, а выигрыша нет.
- Не пытайтесь подсунуть каталог, сконвертированный под другой `--kt-method` или под другое число NUMA-пулов: методы читают разные наборы ключей, и ошибка вылезет на середине загрузки, а не на старте.

## Влияние на производительность и память

- **RAM хоста.** Веса CPU-экспертов резидентны на все время жизни процесса. Порядок величины — размер экспертных весов модели в выбранной квантизации минус то, что осталось на GPU. Для AMX-путей веса не дублируются по NUMA-узлам: `TP_MOE_Common` делит `intermediate_size` на число подпулов, и каждый шард живет в памяти своего узла (`ktransformers/kt-kernel/operators/moe-tp.hpp`).
- **Пик при загрузке.** В merged-режиме `AMXMoEWrapper.load_weights` держит numpy-массивы одного слоя, копирует их в выровненные буферы и затем удаляет — пиковый оверхед порядка одного слоя, не всей модели.
- **Время старта.** Загрузка идет послойно и синхронно (`cpu_infer.submit(...)` + `cpu_infer.sync()`), поэтому холодный старт заметно длиннее чистого GPU-запуска; на первом запуске сюда добавляется чтение весов с диска.
- **VRAM.** Сам путь VRAM не занимает: экономию дают `--kt-num-gpu-experts` (сколько экспертов остается на GPU) и `--mem-fraction-static`.
- В arriero объявляйте положительный host-draw: KT-инстанс не оценивается автоматически, а admission строго требует резервирования (`docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`).

## Взаимодействие с другими аргументами

- `--kt-method`: определяет, какой загрузчик читает каталог. Пара «путь + метод» неразделима.
- `--kt-num-gpu-experts`: без него обертка включится, но `mask_cpu_expert_ids` получит `None` и сравнение упадет; в arriero это ловит preflight (`--kt-num-gpu-experts` или `--kt-gpu-experts-ratio` обязателен).
- `--kt-cpuinfer`, `--kt-threadpool-count`: конфигурация пула, который читает эти веса; для AMX число пулов должно совпадать с раскладкой шардов в каталоге.
- `--model-path`: у native-методов часто тот же каталог; у AMX/LLAMAFILE — обязательно разный.
- `--tp-size`: обертка CPU создается только на `tp_rank == 0`, а `moe_intermediate_size` передается **полным** (`intermediate_size_per_partition * moe_tp_size`). CPU-часть не масштабируется тензорным параллелизмом.

## Типовые проблемы и диагностика

- `ImportError: kt_kernel is not installed. To use KTransformers EP wrapper, please install kt_kernel.` — путь задан, но пакета нет в окружении. Проверьте окружение (`docs/ENVIRONMENTS.md`), а не аргумент.
- `FileNotFoundError: No Safetensor files found in <path>` или `Path not found: <path>` — каталог пуст, не существует или не содержит ожидаемых файлов.
- `ValueError: No experts found for key blk.<N>` (AMX merged) или `No experts found for layer <N> under any prefix` (native) — каталог принадлежит другой модели либо сконвертирован не под тот метод.
- Молчаливое отсутствие эффекта (VRAM как без KT, CPU не загружен) — путь не дошел до процесса. Подтверждается дампом `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`): в нем должно быть непустое `kt_weight_path`.
- В логе рабочего гибридного запуска видны строки kt-kernel: `WorkerPool[…] N subpools, [numa:threads]…`, `TP MOE layer <idx>, pool: …, expert num: …`, для AMX — `Creating AMX_MOE_TP <tp> at numa <node>`.
- В arriero аргумент зарезервирован: попытка положить `--kt-weight-path` в `args` инстанса отклоняется валидацией с `--kt-weight-path is managed by KTransformers engine config`. Значение задается полем `engineConfig.cpuWeights` и подставляется в командную строку при запуске (`apps/api/src/process/launch-snapshot.ts`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kt-weight-path /models/Qwen3-30B-A3B-INT8 --kt-method AMXINT8 --kt-cpuinfer 64 --kt-threadpool-count 2 --kt-num-gpu-experts 32
```

```bash
python -m sglang.launch_server --model-path /models/GLM-5.1-FP8 --kt-weight-path /models/GLM-5.1-FP8 --kt-method FP8 --kt-cpuinfer 96 --kt-threadpool-count 2 --kt-num-gpu-experts 30 --trust-remote-code
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `ktransformers/kt-kernel/python/experts.py`
- `ktransformers/kt-kernel/python/utils/amx.py`
- `ktransformers/kt-kernel/python/utils/llamafile.py`
- `ktransformers/kt-kernel/python/utils/loader.py`
- `ktransformers/kt-kernel/operators/moe-tp.hpp`
- `ktransformers/kt-kernel/operators/amx/moe.hpp`
- `ktransformers/kt-kernel/README.md`
- `ktransformers/doc/en/kt-kernel/GLM-5.1-Tutorial.md`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`
