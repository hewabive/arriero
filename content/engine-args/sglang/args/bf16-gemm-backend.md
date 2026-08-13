---
schema: 1
engine: sglang
primaryName: "--bf16-gemm-backend"
title: "--bf16-gemm-backend"
summary: Выбирает ядро для неквантованных BF16-линейных слоев. Значимо только на SM10x: там `auto` включает JIT CuTe DSL TGV GEMM, который сам решает по форме матрицы, брать ли себя или cuBLAS. На всех остальных картах и при детерминированном инференсе это всегда cuBLAS.
group: exec.kernel
related:
  - --dtype
  - --quantization
  - --fp8-gemm-backend
  - --fp4-gemm-backend
  - --moe-runner-backend
  - --enable-deterministic-inference
---

# --bf16-gemm-backend

## Кратко

Аргумент касается только **неквантованных** BF16-линейных слоев (`UnquantizedLinearMethod`). Если модель квантована, ее слои идут через свои quant-методы, и этот флаг на них не влияет. На SM10x (Blackwell) `auto` разворачивается в `cutedsl` — JIT-ядро CuTe DSL TGV, оптимизированное под малые M (декод); на остальных картах и при `torch` линейный слой считает `torch.nn.functional.linear`, то есть cuBLAS.

Отдельная развилка — детерминированный инференс. CuTe DSL-путь выбирает ядро по форме матрицы, то есть результат зависит от размера батча, а это ровно то, что режим batch-invariant запрещает. Поэтому при `--enable-deterministic-inference` даже на SM10x `auto` дает `torch`, а явный `cutedsl` — ошибку старта.

## Оригинальная справка

```text
Choose the backend for unquantized BF16 GEMM operations. Options: 'auto' (default; selects 'cutedsl' on SM10x GPUs, except deterministic inference selects 'torch'; otherwise uses cuBLAS via torch.nn.functional.linear), 'cutedsl' (SGLang JIT CuTe DSL TGV BF16 GEMM on SM10x; dispatches between the CuTe DSL kernel and cuBLAS), 'torch' (always uses cuBLAS via torch.nn.functional.linear).
```

## Паспорт аргумента

- Флаги: `--bf16-gemm-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `auto`, `cutedsl`, `torch` (константа `BF16_GEMM_BACKEND_CHOICES`)
- Значение по умолчанию: `auto`
- Эффективное значение: `initialize_bf16_gemm_config` (`sglang/python/sglang/srt/layers/quantization/unquant.py`) превращает `auto` при `is_sm100_supported()` в `cutedsl`, а с `--enable-deterministic-inference` — в `torch`; вне SM10x `auto` остается `auto` и ведет себя как `torch`, потому что `Bf16GemmBackend.is_cutedsl()` ложно и весь диспетчер сводится к `F.linear`
- Где объявлен: `ServerArgs.bf16_gemm_backend` (в extract `origin` — `ServerArgs.bf16_gemm_backend`, `cli_name` задан явно), файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `initialize_bf16_gemm_config` при инициализации планировщика (`scheduler.py`) → каждый вызов `UnquantizedLinearMethod.apply` / `apply_into`

## Что меняет в движке

Значение публикуется как глобальный `Bf16GemmBackend` и читается через `get_bf16_gemm_backend()`.

- **`cutedsl`.** Проверок две, и обе — отказ на старте планировщика, а не тихий fallback. Сначала режим: с `--enable-deterministic-inference` летит `ValueError: --bf16-gemm-backend cutedsl is batch-size dependent and cannot be combined with --enable-deterministic-inference`. Затем железо: на не-SM10x карте — `ValueError: --bf16-gemm-backend cutedsl requires an SM10x GPU`. Только после этого подгружаются `cutedsl_bf16_gemm` и предикат `use_cutedsl_bf16_gemm`.
- Даже при выбранном `cutedsl` ядро применяется не всегда. `UnquantizedLinearMethod.apply` требует одновременно: CUDA-тензор, bf16 у входа, весов и bias, отсутствие `requires_grad` — и положительный ответ `use_cutedsl_bf16_gemm(m, n, k)`. Этот предикат (`sglang/python/sglang/kernels/ops/gemm/cutedsl_bf16_gemm.py`) — таблица решений, снятая профилировщиком на B300 под захватом CUDA graph: он отсекает `k`, не кратное 8 (требование TMA), отвергает `n < 1024`, `k < 2048`, `k > 6144` и дальше разбирает диапазоны `n` с порогами по `m`. Комментарий прямо говорит: спорные и неизмеренные области отдаются cuBLAS.
- Под `torch.compile` вызов уходит в непрозрачный custom-op `bf16_gemm_dispatch`, чтобы Dynamo не перекомпилировал ядро на каждый размер батча — решение по форме принимается в рантайме.
- Есть путь `apply_into` (запись в буфер вызывающей стороны) со своим набором условий и отдельным ядром `cutedsl_bf16_gemm_out`.
- `Kimi K3` (`sglang/python/sglang/srt/models/kimi_k3.py`) отдельно спрашивает `get_bf16_gemm_backend().is_cutedsl()` и меняет свой путь.
- Для ROCm с `SGLANG_USE_AITER=1` неквантованный линейный слой уходит в `tgemm.mm` от AITER раньше, чем проверяется этот флаг: на AMD аргумент фактически не работает.

## Значения и формат

- `auto` — рекомендуемое. На SM10x это `cutedsl`, при детерминированном инференсе — `torch`, на остальном — cuBLAS.
- `cutedsl` вне SM10x или вместе с `--enable-deterministic-inference` — `ValueError` на старте. Никакой деградации до cuBLAS не будет.
- `torch` — принудительный cuBLAS; единственный способ отключить CuTe DSL-путь на Blackwell, не меняя ничего другого.
- Значение вне списка отвергает argparse.

## Когда использовать

- `torch`, когда вы подозреваете JIT-ядро CuTe DSL в неверном результате или в регрессии на своих формах и хотите быстро проверить гипотезу.
- `torch`, если старт на Blackwell упирается в JIT-компиляцию CuTe DSL, а модель у вас все равно квантованная (тогда флаг ничего не стоит).
- Не задавайте `cutedsl` вручную: на подходящей карте его и так подставит `auto`, а на неподходящей вы получите отказ старта.
- Не ждите эффекта на квантованной модели: там работают `--fp8-gemm-backend` и `--fp4-gemm-backend`.

## Влияние на производительность и память

- **Latency декода** на Blackwell — основной эффект: TGV-ядро существует ради малых M (батч в декоде), где cuBLAS недоиспользует карту. Предикат отбора как раз ограничен `m` в десятках-сотнях.
- **Время старта.** `cutedsl` — это JIT: первая компиляция ядра происходит перед первым использованием.
- **VRAM.** Прямого эффекта нет, ядро работает на тех же тензорах.
- **Prefill.** Практически не затрагивается: большие M выпадают из предиката и уходят в cuBLAS.

## Взаимодействие с другими аргументами

- `--dtype`: путь CuTe DSL включается только для bf16; при `float16` условия в `apply` не выполняются никогда.
- `--quantization`: любая квантизация уводит слои из `UnquantizedLinearMethod`, и флаг перестает работать.
- `--fp8-gemm-backend` / `--fp4-gemm-backend`: параллельные аргументы для квантованных линейных слоев, инициализируются в том же месте `scheduler.py`.
- `--moe-runner-backend`: экспертные GEMM живут отдельно и этим флагом не управляются.
- `--enable-deterministic-inference`: снимает CuTe DSL-путь с `auto` на SM10x и делает явный `cutedsl` несовместимым. Учтите, что режим включается и косвенно — через `--rl-on-policy-target`, который выставляет `enable_deterministic_inference` в `_handle_deterministic_inference`.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --bf16-gemm-backend cutedsl requires an SM10x GPU`. **Причина:** значение задано вручную на не-Blackwell карте. **Решение:** `auto` или `torch`.
- **Симптом:** `ValueError: --bf16-gemm-backend cutedsl is batch-size dependent and cannot be combined with --enable-deterministic-inference`. **Причина:** несовместимые режимы; проверка идет раньше проверки железа, так что на не-SM10x карте с детерминизмом вы увидите именно это сообщение. **Решение:** `auto` (даст `torch`) или снять детерминизм.
- **Симптом:** на Blackwell прирост пропал после включения детерминированного инференса. **Причина:** `auto` теперь разворачивается в `torch`, а не в `cutedsl`. **Проверка:** это ожидаемо, вернуть ядро нельзя — оно зависит от размера батча.
- **Симптом:** на Blackwell задан `cutedsl`, а прироста нет. **Причина:** формы ваших слоев не проходят предикат `use_cutedsl_bf16_gemm` (обычно `n` или `k` вне измеренного диапазона), либо модель квантована.
- **Симптом:** на ROCm флаг ничего не меняет. **Причина:** AITER-путь перехватывает неквантованный линейный слой раньше.
- **Проверка:** дамп `server_args=` при старте показывает заданное значение (разрешение `auto → cutedsl` происходит позже и в дампе не отражается).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --dtype bfloat16 --bf16-gemm-backend torch
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --dtype bfloat16 --bf16-gemm-backend auto
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/quantization/unquant.py`
- `sglang/python/sglang/kernels/ops/gemm/cutedsl_bf16_gemm.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/models/kimi_k3.py`
