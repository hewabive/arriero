---
schema: 1
engine: sglang
primaryName: "--flashinfer-mxfp4-moe-precision"
title: "--flashinfer-mxfp4-moe-precision"
summary: Выбирает точность активаций FlashInfer MXFP4 MoE с учётом поколения GPU. На Hopper fp8 включает Humming W4A8, тогда как default и bf16 сохраняют W4A16.
group: exec.moe
related:
  - --moe-runner-backend
  - --quantization
  - --moe-a2a-backend
---

# --flashinfer-mxfp4-moe-precision

## Кратко

Веса остаются MXFP4, а активации и ядро зависят от GPU. На SM90 `fp8` включает Humming W4A8; `default` и `bf16` используют MXFP4 × BF16. На SM120 остаётся MXFP8-путь; на SM100 `fp8` в текущем TRT-LLM forward не обработан и приводит к NotImplementedError.

## Оригинальная справка

```text
Choose the computation precision of flashinfer mxfp4 moe. On SM90, `fp8` selects the Humming-style MXFP4-weight x FP8-activation path introduced by FlashInfer #3738 and requires FlashInfer >= 0.6.18.
```

## Паспорт аргумента

- Флаги: `--flashinfer-mxfp4-moe-precision`
- Группа: `exec.moe`
- Тип значения: перечисление
- Допустимые значения: `default`, `bf16`, `fp8`
- Значение по умолчанию: `default`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.flashinfer_mxfp4_moe_precision`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение метода квантизации MoE-слоя → каждый forward MoE

## Что меняет в движке

`Mxfp4MoEMethod` выбирает kernel по GPU и читает precision при активном `flashinfer_mxfp4`.

- SM90: `fp8` устанавливает `_use_sm90_humming`, создаёт Humming веса/шкалы и использует mixed-input W4A8. Английская справка требует FlashInfer >= 0.6.18; установленный пакет также должен предоставлять используемые mixed-input helpers. `default` и `bf16` сохраняют W4A16.
- SM100: `default` предварительно квантует активации, `bf16` передаёт BF16 для внутренней квантизации; `fp8` не входит в эти две forward-ветки и приводит к NotImplementedError, несмотря на комментарий исходника о переносимости настройки между GPU.
- SM120: используется CUTLASS MXFP8 × MXFP4 путь.

В Kimi K3 слитый route+quant handoff требует `default`; смена precision может убрать эту оптимизацию.

## Значения и формат

`default` — штатный путь данного GPU. `bf16` на SM100 оставляет активации BF16 до входа в kernel, на SM90 сохраняет W4A16. `fp8` — opt-in Humming W4A8 на SM90; на SM120 не включает Hopper-путь, а на SM100 отвергается в TRT-LLM forward: оставляйте `default` или `bf16`. Вне runner `flashinfer_mxfp4` параметр не управляет другими MoE-реализациями.

## Когда использовать

- MXFP4-модель на Blackwell с раннером `flashinfer_mxfp4`, и вы измеряете, какой из двух путей быстрее на вашей форме батча: это ровно та развилка, ради которой аргумент существует.
- Ошибка формы или шкалы в предварительной квантизации: `bf16` убирает этап квантизации на стороне SGLang и позволяет проверить, в нем ли дело.
- Не переключайте на `bf16` на Kimi-K3, не измерив: вы выключите слитую route+quant-оптимизацию.
- Не задавайте аргумент, если раннер не `flashinfer_mxfp4` — он будет проигнорирован.

## Влияние на производительность и память

На Hopper W4A8 меняет точность активаций, их подготовку и временные буферы; веса остаются MXFP4. На SM100 `bf16` переносит квантизацию внутрь kernel. Сравнивайте throughput и качество: численные результаты могут различаться, заранее обещать отсутствие деградации нельзя. KV-cache не меняется.

## Взаимодействие с другими аргументами

- `--moe-runner-backend`: значение читается только при `flashinfer_mxfp4`.
- `--quantization`: применимо к MXFP4-checkpoint'ам (`mxfp4`, `quark_mxfp4`); на NPU `mxfp4` означает другую схему и этот путь не задействует.
- `--moe-a2a-backend`: не влияет на выбор, но определяет, какой dtype приедет в слой; при DeepEP формат dispatch задается отдельно (`--deepep-dispatcher-output-dtype`), и `bf16` здесь требует, чтобы активации к моменту ядра действительно были bf16.

## Типовые проблемы и диагностика

- Ошибка отсутствующего SM90 mixed-input helper — установленный FlashInfer не предоставляет нужный API. Сверьте версию и пакет с текущим checkout.
- Ошибка dtype при `bf16` — активации не BF16; проверьте `--dtype` и dispatcher.
- `NotImplementedError` при `fp8` на SM100 — текущий TRT-LLM forward принимает только `default` и `bf16`; используйте одно из этих значений. На SM120 Humming также не включается, но используется отдельный MXFP8 CUTLASS-путь.
- Изменение latency Kimi K3 может объясняться отключением route+quant handoff при precision, отличном от `default`.

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
