---
schema: 1
engine: sglang
primaryName: "--flashinfer-mxfp4-moe-precision"
title: "--flashinfer-mxfp4-moe-precision"
summary: Выбирает, в каком виде активации попадают в FlashInfer-ядро MXFP4-MoE: квантованными заранее (`default`) или в bf16, чтобы ядро квантовало их само (`bf16`). Читается только методом квантизации MXFP4 с MoE-раннером `flashinfer_mxfp4`.
group: exec.moe
related:
  - --moe-runner-backend
  - --quantization
  - --moe-a2a-backend
---

# --flashinfer-mxfp4-moe-precision

## Кратко

Веса в MXFP4-моделях всегда остаются четырехбитными; аргумент решает судьбу активаций. При `default` SGLang квантует их сам (в MXFP8 или per-token-group FP8, в зависимости от ядра) и передает в FlashInfer уже готовый тензор со шкалами. При `bf16` активации уходят в ядро как есть, и TRT-LLM выполняет квантизацию внутри, конвейеризуя ее с GEMM. Второй вариант в комментарии кода описан как потенциально более быстрый; проверять это надо замером на своей карте.

## Оригинальная справка

```text
Choose the computation precision of flashinfer mxfp4 moe
```

## Паспорт аргумента

- Флаги: `--flashinfer-mxfp4-moe-precision`
- Группа: `exec.moe`
- Тип значения: перечисление
- Допустимые значения: `default`, `bf16`
- Значение по умолчанию: `default`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.flashinfer_mxfp4_moe_precision`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение метода квантизации MoE-слоя → каждый forward MoE

## Что меняет в движке

Значение копируется в поле `Mxfp4MoEMethod.flashinfer_mxfp4_moe_precision` (`sglang/python/sglang/srt/layers/quantization/mxfp4.py`) и в `mxfp4_flashinfer_trtllm_moe.py`, и читается на горячем пути только при активном FlashInfer-пути (`--moe-runner-backend flashinfer_mxfp4`). Тот, в свою очередь, сам выбирает точку входа по поколению карты: SM100 (Blackwell) → `trtllm_fp4_block_scale_moe`, SM120 → `cutlass_fused_moe` с MXFP8-активациями, SM90 (Hopper) → `cutlass_fused_moe` с групповым масштабированием W4 (доступно только в достаточно свежем FlashInfer, иначе `RuntimeError` на старте).

- `bf16`: проверяется `assert x.dtype == torch.bfloat16`, при необходимости активации дополняются нулями до `hidden_size`, шкала не передается. Квантизацию делает ядро.
- `default`: активации квантуются заранее — `flashinfer_mxfp8_quantize` в TRT-LLM-пути и `per_token_group_quant` в основном; шкала передается отдельным тензором.
- Любое другое значение в TRT-LLM-пути дает `NotImplementedError: Unsupported mxfp4 moe precision: <значение>`; argparse до этого не допустит, но ошибка существует для программных вызовов.

Побочный эффект, о котором легко забыть: в Kimi-K3 (`sglang/python/sglang/srt/models/kimi_k3.py`) слитый путь «маршрутизация + упаковка topk + квантизация» (`route_quant_handoff`) включается только при `default`. С `bf16` эта оптимизация выключается, и слой идет по неслитой цепочке.

## Значения и формат

- `default` — квантизация на стороне SGLang. Единственный вариант, при котором работает слитая route+quant-оптимизация K3.
- `bf16` — активации в bf16 до ядра. Требует, чтобы активации действительно были bf16: иначе ассерт.
- На путях, где раннер не `flashinfer_mxfp4` (Triton-kernels, Marlin, DeepGEMM), значение не читается вовсе.

## Когда использовать

- MXFP4-модель на Blackwell с раннером `flashinfer_mxfp4`, и вы измеряете, какой из двух путей быстрее на вашей форме батча: это ровно та развилка, ради которой аргумент существует.
- Ошибка формы или шкалы в предварительной квантизации: `bf16` убирает этап квантизации на стороне SGLang и позволяет проверить, в нем ли дело.
- Не переключайте на `bf16` на Kimi-K3, не измерив: вы выключите слитую route+quant-оптимизацию.
- Не задавайте аргумент, если раннер не `flashinfer_mxfp4` — он будет проигнорирован.

## Влияние на производительность и память

- **Latency.** `bf16` убирает отдельный запуск ядра квантизации, но передает в GEMM вдвое больше байт активаций; `default` наоборот. Выигрыш зависит от того, во что упирается слой — в пропускную способность памяти или в запуски ядер.
- **VRAM.** Разница только в размере промежуточных тензоров активаций одного слоя; веса в обоих случаях MXFP4.
- **Точность.** Обе ветки квантуют активации, отличается только момент; заметных расхождений в качестве от переключения ожидать не стоит, но численный результат не побитово совпадет.
- На KV-кеш и коммуникацию аргумент не влияет.

## Взаимодействие с другими аргументами

- `--moe-runner-backend`: значение читается только при `flashinfer_mxfp4`.
- `--quantization`: применимо к MXFP4-checkpoint'ам (`mxfp4`, `quark_mxfp4`); на NPU `mxfp4` означает другую схему и этот путь не задействует.
- `--moe-a2a-backend`: не влияет на выбор, но определяет, какой dtype приедет в слой; при DeepEP формат dispatch задается отдельно (`--deepep-dispatcher-output-dtype`), и `bf16` здесь требует, чтобы активации к моменту ядра действительно были bf16.

## Типовые проблемы и диагностика

- `AssertionError` на `x.dtype == torch.bfloat16` — выбран `bf16`, а активации приходят в другом типе; проверьте `--dtype` и формат dispatch.
- `NotImplementedError: Unsupported mxfp4 moe precision: ...` — значение вне перечисления (возможно при программном запуске в обход CLI).
- `RuntimeError` про отсутствие SM90-ядра MXFP4 в FlashInfer на Hopper — нужен более свежий FlashInfer; к самому аргументу это отношения не имеет.
- Ожидали ускорения, но его нет — вероятно, раннер не `flashinfer_mxfp4`; сверьтесь с дампом `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path openai/gpt-oss-120b --tp-size 4 --moe-runner-backend flashinfer_mxfp4 --flashinfer-mxfp4-moe-precision bf16
```

```bash
python -m sglang.launch_server --model-path openai/gpt-oss-120b --tp-size 4 --moe-runner-backend flashinfer_mxfp4 --flashinfer-mxfp4-moe-precision default
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/quantization/mxfp4.py`
- `sglang/python/sglang/srt/layers/quantization/mxfp4_flashinfer_trtllm_moe.py`
- `sglang/python/sglang/srt/models/kimi_k3.py`
- `sglang/python/sglang/srt/layers/quantization/__init__.py`
