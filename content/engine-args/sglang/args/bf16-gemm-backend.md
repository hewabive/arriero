---
schema: 1
engine: sglang
primaryName: "--bf16-gemm-backend"
title: "--bf16-gemm-backend"
summary: Выбирает ядро для неквантованных BF16-линейных слоев. На SM100/SM103 `auto` включает JIT CuTe DSL TGV GEMM, но в deterministic-режиме принудительно остается на cuBLAS; на прочем железе `auto` также использует cuBLAS.
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

Аргумент касается только **неквантованных** BF16-линейных слоев (`UnquantizedLinearMethod`). Если модель квантована, ее слои идут через свои quant-методы, и этот флаг на них не влияет. На SM100/SM103 `auto` разворачивается в `cutedsl` — JIT-ядро CuTe DSL TGV, оптимизированное под малые M (decode), — кроме deterministic inference, где выбирается `torch`. На остальных картах и при `torch` линейный слой считает `torch.nn.functional.linear`, то есть cuBLAS.

## Оригинальная справка

```text
Choose the backend for unquantized BF16 GEMM operations. Options: 'auto' (default; selects 'cutedsl' on SM10x GPUs, except deterministic inference selects 'torch'; otherwise uses cuBLAS via torch.nn.functional.linear), 'cutedsl' (SGLang JIT CuTe DSL TGV BF16 GEMM on SM10x; dispatches between the allowlisted low-M Split-K kernel, the CuTe DSL kernel, and cuBLAS; set SGLANG_ENABLE_BF16_SPLITK_GEMM=0 to disable Split-K), 'flashinfer_pr4266' (legacy compatibility alias for the optimized CuTe DSL path), 'gemv', 'torch' (always uses cuBLAS via torch.nn.functional.linear).
```

## Паспорт аргумента

- Флаги: `--bf16-gemm-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `auto`, `cutedsl`, `flashinfer_pr4266`, `gemv`, `torch` (choices объявлены непосредственно у поля)
- Значение по умолчанию: `auto`
- Эффективное значение: `initialize_bf16_gemm_config` превращает `auto` при `get_platform().is_sm100` в `cutedsl`, либо в `torch`, если включен `--enable-deterministic-inference`; вне SM100/SM103 `auto` остается `auto` и ведет себя как `torch`
- Где объявлен: `ServerArgs.bf16_gemm_backend` (в extract `origin` — `ServerArgs.bf16_gemm_backend`, `cli_name` задан явно), файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `initialize_bf16_gemm_config` при инициализации планировщика (`scheduler.py`) → каждый вызов `UnquantizedLinearMethod.apply` / `apply_into`

## Что меняет в движке

`initialize_bf16_gemm_config` выбирает `Bf16GemmBackend`. На SM100/SM103 `auto` разрешается в `cutedsl`, кроме deterministic inference, где выбирается `torch`.

- `cutedsl` и совместимый алиас `flashinfer_pr4266` включают оптимизированный CuTe DSL путь; вне SM100/SM103 или при deterministic inference старт завершается ValueError.
- В диспетчере сначала проверяется allowlist форм `(M,N,K)` для low-M Split-K/direct ядра, затем TGV CuTe DSL предикат, иначе вызывается `F.linear`. `SGLANG_ENABLE_BF16_SPLITK_GEMM=0` убирает только Split-K/direct ветку, сохраняя остальной CuTe DSL путь.
- `gemv` требует SM90 (Hopper). Его отдельный GEMV вызывается без bias и только для форм, разрешённых `use_hopper_bf16_gemv`; остальные идут в cuBLAS.
- Неквантованный linear проверяет dtype, устройство и совместимость тензоров. Под `torch.compile` используется custom op `bf16_gemm_dispatch`; также существует вариант записи в предоставленный output buffer.

Флаг касается неквантованных BF16-слоёв, включая оставшиеся неквантованными слои смешанного checkpoint; quant-методы других слоёв выбирают собственные ядра.

## Значения и формат

`auto` сохраняет автоподбор, `torch` принудительно использует cuBLAS. `cutedsl` и `flashinfer_pr4266` — один оптимизированный путь Blackwell; последнее имя оставлено для совместимости и не требует выбирать особую ветку FlashInfer. `gemv` — явный Hopper-вариант. Неизвестное значение отвергает argparse.

## Когда использовать

- `torch`, когда вы подозреваете JIT-ядро CuTe DSL в неверном результате или в регрессии на своих формах и хотите быстро проверить гипотезу.
- `torch`, если старт на Blackwell упирается в JIT-компиляцию CuTe DSL, а модель у вас все равно квантованная (тогда флаг ничего не стоит).
- Не задавайте `cutedsl` вручную: на подходящей карте его и так подставит `auto`, а на неподходящей или в deterministic-режиме вы получите отказ старта.
- Не ждите эффекта на квантованной модели: там работают `--fp8-gemm-backend` и `--fp4-gemm-backend`.

## Влияние на производительность и память

Основной эффект — стоимость BF16 linear на малых M, характерных для decode. Выбор по allowlist не обещает ускорения для произвольного батча; остальные формы уходят в cuBLAS. JIT увеличивает первый запуск; Split-K использует промежуточные вычисления/буферы. Память весов и KV-cache не уменьшается. Сравнивайте latency и peak VRAM на тех же формах.

## Взаимодействие с другими аргументами

- `--dtype`: путь CuTe DSL включается только для bf16; при `float16` условия в `apply` не выполняются никогда.
- `--quantization`: любая квантизация уводит слои из `UnquantizedLinearMethod`, и флаг перестает работать.
- `--fp8-gemm-backend` / `--fp4-gemm-backend`: параллельные аргументы для квантованных линейных слоев, инициализируются в том же месте `scheduler.py`.
- `--moe-runner-backend`: экспертные GEMM живут отдельно и этим флагом не управляются.
- `--enable-deterministic-inference`: `auto` выбирает `torch`, а явный `cutedsl` запрещен, поскольку решение диспетчера зависит от batch shape.

## Типовые проблемы и диагностика

- Ошибка `requires SM100/SM103 (Blackwell)` — `cutedsl` или алиас выбран на неподходящем GPU.
- `gemv requires SM90 (Hopper)` — явный GEMV требует Hopper.
- Ошибка о batch-size-dependent kernel — оптимизированный CuTe DSL несовместим с deterministic inference.
- Для локализации регрессии Split-K задайте `SGLANG_ENABLE_BF16_SPLITK_GEMM=0`; для отключения всего оптимизированного пути используйте `torch`.
- Отсутствие ускорения возможно, если формы ушли в fallback либо слой использует quant-метод.

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
