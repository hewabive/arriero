---
schema: 1
engine: sglang
primaryName: "--kt-method"
title: "--kt-method"
summary: Выбирает CPU-ядро kt-kernel и формат весов экспертов, считаемых на хосте; значение проверяется не argparse, а самим kt-kernel, и должно совпадать и с форматом каталога `--kt-weight-path`, и с набором инструкций CPU.
group: exec.moe
related:
  - --kt-weight-path
  - --kt-num-gpu-experts
  - --kt-threadpool-count
  - --kt-max-deferred-experts-per-token
---

# --kt-method

## Кратко

`--kt-method` — строка, которую SGLang без изменений передает в `kt_kernel.KTMoEWrapper` как `method`. Она определяет три вещи сразу: какой класс-обертку создаст kt-kernel, какой загрузчик прочитает `--kt-weight-path` и какие инструкции CPU потребуются на хосте. Значение по умолчанию `AMXINT4` не подбирается по железу: на CPU без AMX запуск с дефолтом упадет или деградирует, поэтому метод выбирают вместе с весами, а не «оставляют как есть».

## Оригинальная справка

```text
[ktransformers parameter] Quantization formats for CPU execution.
```

## Паспорт аргумента

- Флаги: `--kt-method`
- Группа: `exec.moe`
- Тип значения: строка
- Допустимые значения: `choices` в extract нет — argparse принимает любую строку. Реальный список зашит в kt-kernel: `INFERENCE_METHODS` в `ktransformers/kt-kernel/python/experts.py` (на момент checkout'а — `AMXINT4`, `AMXINT8`, `RAWINT4`, `FP8`, `BF16`, `FP8_PERCHANNEL`, `GPTQ_INT4`, `SYCL_GPTQ_INT4`, `MXFP4`, `MXFP8`, `LLAMAFILE`, `MOE_INT4`, `MOE_INT8`). Свой список смотрите в установленном пакете: `python -c "from kt_kernel.experts import INFERENCE_METHODS; print(sorted(INFERENCE_METHODS))"` либо в `--help` установленной сборки, если она из форка добавляет `choices`.
- Значение по умолчанию: `AMXINT4`
- Эффективное значение: не переопределяется; ни один `_handle_*` в `ServerArgs.__post_init__` не читает это поле
- Где объявлен: `ServerArgs.kt_method`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но полностью реализован во внешнем пакете `kt_kernel`
- Этап применения: конструктор `FusedMoE` (создание `KTMoEWrapper`) и загрузка весов слоя

## Что меняет в движке

SGLang копирует значение в `KTConfig.method` (`sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`) и передает в `KTMoEWrapper`. Дальше решает kt-kernel:

- `KTMoEWrapper.__new__` проверяет метод по `INFERENCE_METHODS` и при промахе бросает `ValueError: Method '<x>' not supported for inference mode. Supported methods: [...]`. Методы семейства `*_SFT` в режиме inference отвергаются явно.
- `_create_inference_wrapper` выбирает класс: `AMXINT4`/`AMXINT8` → `AMXMoEWrapper`; `RAWINT4`, `FP8`, `BF16`, `FP8_PERCHANNEL`, `GPTQ_INT4`, `SYCL_GPTQ_INT4`, `MXFP4`, `MXFP8` → `NativeMoEWrapper`; `LLAMAFILE` → `LlamafileMoEWrapper`; `MOE_INT4`/`MOE_INT8` → `GeneralMoEWrapper`.
- Внутри выбранного класса метод второй раз определяет конкретный C++-оператор: `AMXInt4_MOE` / `AMXInt8_MOE` для AMX, семейство `AVX2*`/`AVXVNNI256*` для native-путей. Часть операторов может отсутствовать в сборке: `ktransformers/kt-kernel/python/utils/amx.py` проверяет их наличие через `getattr(_moe_mod, …)` и переключается на доступный вариант либо бросает `RuntimeError`.
- Метод же определяет формат весов. `NativeMoEWrapper._create_loader` выбирает `FP8SafeTensorLoader`, `BF16SafeTensorLoader`, `GPTQSafeTensorLoader`, `MXFP4SafeTensorLoader`, `MXFP8SafeTensorLoader` или `CompressedSafeTensorLoader` и проверяет dtype масштабов ассертами (`Expected float32 scales for FP8`, `Expected uint8 (ue8m0) scales for MXFP8` и т. п.).

Гибридная схема от метода не зависит: эксперты с id `>= --kt-num-gpu-experts` в любом случае маскируются на GPU и считаются на CPU.

## Значения и формат

- Регистр значим — сравнение идет по строке во frozenset. `amxint4` не пройдет.
- `AMXINT4` / `AMXINT8` требуют весов, сконвертированных `kt-kernel/scripts/convert_cpu_weights.py` (`--quant-method int4|int8`), и AMX на CPU. `AMXINT4` дает наибольшую скорость, но kt-kernel прямо предупреждает о возможной существенной потере качества на отдельных моделях (в README назван Qwen3-30B-A3B); `AMXINT8` — более точный вариант.
- `RAWINT4`, `FP8`, `FP8_PERCHANNEL`, `BF16` читают тот же формат весов, что и GPU: `--kt-weight-path` тогда обычно совпадает с `--model-path`, конвертация не нужна.
- `MOE_INT4` / `MOE_INT8` — путь general-kernel; `MOE_INT8` в KTransformers описан как вариант для AMD с BLIS (`export CPUINFER_ENABLE_BLIS=ON` при сборке).
- `LLAMAFILE` работает с готовыми GGUF-каталогами (`Q4_K_M` и подобные) и не требует AMX, но накладывает жесткое ограничение на разбиение по NUMA: `intermediate_size` должен делиться на `QK_K = 256`, а блоков должно хватить на все пулы.
- `SYCL_GPTQ_INT4` перед инициализацией проверяет доступ к `/dev/dri/renderD*` и падает с понятным сообщением, если пользователь не в группе `render`.

## Когда использовать

- CPU с AMX (Sapphire Rapids и новее, `lscpu | grep -i amx` показывает `amx-bf16 amx-int8 amx-tile`) и есть возможность заранее сконвертировать веса — берите `AMXINT8`, а `AMXINT4` только после проверки качества на своей задаче.
- CPU без AMX — `LLAMAFILE` (GGUF) или native-методы уровня AVX2/AVX-512 в зависимости от того, что поддерживает сборка kt-kernel и формат исходных весов.
- Не меняйте метод «на лету» без перегенерации весов: каталог, собранный под AMXINT8, не читается FP8-загрузчиком, и наоборот.
- Не рассчитывайте на дефолт `AMXINT4`: он не отражает ни ваш CPU, ни формат каталога.

## Влияние на производительность и память

- Разрядность метода прямо задает объем RAM под экспертов: INT4 против INT8 — примерно вдвое меньше, BF16 — заметно больше обоих. Точная величина определяется моделью и раскладкой `--kt-num-gpu-experts`.
- AMX-ядра выигрывают на prefill (высокая арифметическая интенсивность). В самом kt-kernel заявлено, что на низкой интенсивности (decode, короткие prefill) выбор между AMX и AVX-512 делается динамически внутри ядра, без участия CLI (`ktransformers/doc/en/AMX.md`).
- Метод не меняет VRAM: на GPU остаются те же `--kt-num-gpu-experts` экспертов.
- Время старта: AMX merged-режим читает и копирует шардированные веса послойно; native-методы читают тот же чекпойнт, что и GPU, но отдельным загрузчиком — на медленном диске это заметная добавка к холодному старту.

## Взаимодействие с другими аргументами

- `--kt-weight-path`: неразрывная пара. Метод определяет формат каталога, каталог — что реально можно запустить.
- `--kt-threadpool-count`: для AMX число NUMA-шардов в весах должно совпасть с числом пулов; для `LLAMAFILE` действует ограничение `QK_K = 256` на разбиение `intermediate_size`; native-методы шардов по NUMA не имеют (`numa`-размерность указателей равна 1).
- `--kt-num-gpu-experts`, `--kt-max-deferred-experts-per-token`: настраиваются независимо от метода, но их эффект измеряется на конкретном ядре.
- Ускорители и quantization-флаги GPU-части (`--quantization`, `--moe-runner-backend`) метод не затрагивает: обертка вызывает обычный GPU-метод для «горячих» экспертов.

## Типовые проблемы и диагностика

- `ValueError: Method '<x>' not supported for inference mode` — опечатка или метод из другой версии kt-kernel. Сверьтесь с `INFERENCE_METHODS` установленного пакета.
- `NotImplementedError: Unsupported AMX method: <x>` — метод принят фабрикой, но AMX-обертка его не знает (у нее только `AMXINT4`/`AMXINT8`).
- `RuntimeError: … is not compiled in` / `Llamafile backend not available` — метод есть в списке, но соответствующий оператор не собран в вашей сборке `kt_kernel_ext`.
- `SIGILL` при инициализации `CPUInfer` — колесо собрано под инструкции, которых нет на CPU. Это дефект сборки, а не аргумента; в arriero этот случай задокументирован как отдельная ловушка публичных wheel'ов (`docs/KTRANSFORMERS_OPERATIONS.md`).
- Ассерт на dtype масштабов (`Expected bf16 scales for RAWINT4` и аналогичные) — веса не того формата, что ожидает метод.
- Подтверждение принятого значения — дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) и строки создания операторов в логе (`Creating AMX_MOE_TP <tp> at numa <node>` для AMX, блок `[LlamafileMoEWrapper] Layer N TP configuration` для GGUF).
- В arriero метод — зарезервированный ключ: он задается полем `engineConfig.method` (набор ограничен `AMXINT4`, `AMXINT8`, `RAWINT4`, `FP8`, `FP8_PERCHANNEL`, `BF16`, `LLAMAFILE`), а попытка передать `--kt-method` в `args` отклоняется с `--kt-method is managed by KTransformers engine config`. Preflight дополнительно сверяет метод с флагами CPU: AMX-методы требуют `amx_int8`, `FP8`/`FP8_PERCHANNEL` — `avx512f`, `BF16` — `avx512f` и `avx512_bf16`, `RAWINT4` и `LLAMAFILE` — `avx2`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kt-weight-path /models/Qwen3-30B-A3B-INT8 --kt-method AMXINT8 --kt-cpuinfer 64 --kt-threadpool-count 2 --kt-num-gpu-experts 32
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --kt-weight-path /models/Qwen3-30B-A3B-Q4_K_M --kt-method LLAMAFILE --kt-cpuinfer 16 --kt-threadpool-count 1 --kt-num-gpu-experts 32 --kt-max-deferred-experts-per-token 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`
- `ktransformers/kt-kernel/python/experts.py`
- `ktransformers/kt-kernel/python/utils/amx.py`
- `ktransformers/kt-kernel/python/utils/llamafile.py`
- `ktransformers/kt-kernel/scripts/convert_cpu_weights.py`
- `ktransformers/kt-kernel/operators/moe-tp.hpp`
- `ktransformers/kt-kernel/README.md`
- `ktransformers/doc/en/AMX.md`
- `ktransformers/doc/en/kt-kernel/amd_blis.md`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
