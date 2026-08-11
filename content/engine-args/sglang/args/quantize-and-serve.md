---
schema: 1
engine: sglang
primaryName: "--quantize-and-serve"
title: "--quantize-and-serve"
summary: Режим «квантовать ModelOpt и сразу отдавать без экспорта». В checkout'е он принудительно отключен: включение всегда завершается `NotImplementedError` при построении `ModelConfig`, поэтому флаг годен только как маркер намерения.
group: model
related:
  - --quantization
  - --modelopt-quant
  - --modelopt-export-path
---

# --quantize-and-serve

## Кратко

Флаг задумывался как способ пропустить шаг экспорта: откалибровать модель через NVIDIA Model Optimizer прямо в процессе старта и сразу начать обслуживать запросы. В коде checkout'а этот режим выключен явным `raise NotImplementedError` — включение флага гарантированно роняет старт, причем еще на этапе построения `ModelConfig`, до загрузки весов. Практический вывод: используйте разделенный сценарий (квантизация с `--modelopt-export-path`, затем отдельный запуск на экспортированном каталоге).

## Оригинальная справка

```text
Quantize the model with ModelOpt and immediately serve it without exporting. This is useful for development and prototyping. For production, it's recommended to use separate quantization and deployment steps.
```

## Паспорт аргумента

- Флаги: `--quantize-and-serve`
- Группа: `model`
- Тип значения: булев переключатель (`store_true`); парной формы `--no-quantize-and-serve` нет
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; но при `true` старт всегда завершается исключением
- Где объявлен: `ServerArgs.quantize_and_serve`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный по форме, фактически отключенный (`quantize_and_serve functionality is currently disabled due to compatibility issues`)
- Этап применения: конструктор `ModelConfig` → `_validate_quantize_and_serve_config`

## Что меняет в движке

Значение проходит два пути:

- в `ModelConfig` через `ModelConfig.from_server_args` — и там в `__init__` немедленно вызывается `_validate_quantize_and_serve_config` (`sglang/python/sglang/srt/configs/model_config.py`);
- в `ModelOptConfig.quantize_and_serve` через `build_load_config` — это поле ни один потребитель `modelopt_config` не читает.

`_validate_quantize_and_serve_config` работает так:

1. если флаг не задан — немедленный выход, никакого эффекта;
2. если задан, но `quantization` не входит в `["modelopt", "modelopt_fp8", "modelopt_fp4", "nvfp4_online", "modelopt_mixed"]` — `ValueError: quantize_and_serve requires ModelOpt quantization (set with --quantization {...})`;
3. иначе — безусловный `NotImplementedError` с текстом «quantize_and_serve functionality is currently disabled due to compatibility issues. Please use the separate quantize-then-deploy workflow instead.»

Дополнительное подтверждение — комментарий в `ModelOptModelLoader.load_model`: «Quantize-and-serve mode has been disabled at the ModelConfig level. All quantization now uses the standard workflow (quantize + export/save)».

`ModelConfig` строится не только основным процессом, но и для драфт-модели и в других вспомогательных путях, поэтому отказ проявится в первом же месте, где создается конфиг модели.

## Значения и формат

Переключатель без значения. Не задан — поведение по умолчанию (никакого влияния). Задан — гарантированный отказ старта: сначала проверка на ModelOpt-метод квантизации, затем безусловное исключение.

## Когда использовать

- Не использовать. В checkout'е нет комбинации аргументов, при которой он приведет к работающему серверу.
- Рабочая замена: `--quantization modelopt_fp8` (или `modelopt_fp4`) вместе с `--modelopt-export-path <dir>` для одноразовой конвертации, затем отдельный запуск сервера на `<dir>`.
- Если вы переносите чужую команду с этим флагом, удалите его: сообщение об ошибке единственное и однозначное.

## Влияние на производительность и память

На производительность и память не влияет: до загрузки весов и выделения KV-пула дело не доходит — исключение поднимается при построении `ModelConfig`.

## Взаимодействие с другими аргументами

- `--quantization`: без значения из ModelOpt-семейства ошибка будет другой (`ValueError` вместо `NotImplementedError`), но старт все равно не состоится.
- `--modelopt-export-path`: реализованная альтернатива этому режиму.
- `--modelopt-quant`: в checkout'е не читается и на проверку не влияет — она смотрит только на `--quantization`.

## Типовые проблемы и диагностика

- `NotImplementedError: quantize_and_serve functionality is currently disabled due to compatibility issues. Please use the separate quantize-then-deploy workflow instead. Step 1: Quantize and export model. Step 2: Deploy the exported model.` — флаг задан вместе с ModelOpt-квантизацией. Снимите флаг.
- `ValueError: quantize_and_serve requires ModelOpt quantization (set with --quantization {modelopt, modelopt_fp4, modelopt_fp8, modelopt_mixed, nvfp4_online})` — флаг задан без подходящего `--quantization`. Снимите флаг.
- Присутствие флага в командной строке видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`), но до этой строки процесс, как правило, уже не доходит.

## Примеры

Рабочий сценарий вместо этого флага — два отдельных запуска:

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --quantization modelopt_fp8 --modelopt-export-path /models/exported/llama31-8b-fp8
```

```bash
python -m sglang.launch_server --model-path /models/exported/llama31-8b-fp8 --quantization modelopt_fp8 --host 127.0.0.1 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/configs/modelopt_config.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/docs/docs/advanced_features/quantization.mdx`
