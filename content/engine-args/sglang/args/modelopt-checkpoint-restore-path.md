---
schema: 1
engine: sglang
primaryName: "--modelopt-checkpoint-restore-path"
title: "--modelopt-checkpoint-restore-path"
summary: Восстанавливает ранее сохраненное состояние квантизации NVIDIA Model Optimizer вместо повторной калибровки. Неудачное восстановление не останавливает старт — движок молча уходит на калибровку.
group: model
related:
  - --modelopt-checkpoint-save-path
  - --modelopt-export-path
  - --modelopt-quant
  - --quantization
  - --quantize-and-serve
  - --load-format
---

# --modelopt-checkpoint-restore-path

## Кратко

Аргумент — вторая половина ModelOpt-цикла: раньше состояние квантизации сохранили `--modelopt-checkpoint-save-path`, теперь его подгружают через `mto.restore(model, path)` и пропускают калибровку. Это узкая интеграция с внешним пакетом `nvidia-modelopt`, а не общий механизм квантизации. Главная эксплуатационная особенность — деградация вместо отказа: если восстановление не удалось, движок пишет warning и идет калибровать модель заново, что легко принять за «просто долгий старт».

## Оригинальная справка

```text
Path to restore a previously saved ModelOpt quantized checkpoint. If provided, the quantization process will be skipped and the model will be loaded from this checkpoint.
```

## Паспорт аргумента

- Флаги: `--modelopt-checkpoint-restore-path`
- Группа: `model`
- Тип значения: строка — путь к чекпоинту ModelOpt
- Допустимые значения: не ограничены; файл должен быть создан `mto.save` совместимой версией ModelOpt
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; попадает в `ModelOptConfig.checkpoint_restore_path`
- Где объявлен: `ServerArgs.modelopt_checkpoint_restore_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный по форме, экспериментальный по сути — весь ModelOpt-путь построен на `try/except` с продолжением работы
- Этап применения: загрузка модели в `ModelOptModelLoader.load_model`, до калибровочной квантизации

## Что меняет в движке

`ModelOptModelLoader._setup_modelopt_quantization` (`sglang/python/sglang/srt/model_loader/loader.py`):

```python
if is_quantized(model):
    rank0_log("Model is already quantized, skipping quantization setup.")
    return
if quantized_ckpt_restore_path:
    try:
        mto.restore(model, quantized_ckpt_restore_path)
        rank0_log(f"Restored quantized model from {quantized_ckpt_restore_path}")
        self._maybe_export_modelopt(model, export_path)
        return
    except Exception as e:
        logger.warning(f"Failed to restore from {quantized_ckpt_restore_path}: {e}")
        rank0_log("Proceeding with calibration-based quantization...")
```

Что из этого следует:

1. Успешное восстановление **завершает** функцию: калибровка не запускается, `--modelopt-checkpoint-save-path` не выполняется, а вот `--modelopt-export-path` отрабатывает и по этой ветке.
2. Любая ошибка (несовместимая версия ModelOpt, битый файл, отсутствующий путь) превращается в warning, и старт продолжается по калибровочному пути — с загрузкой датасета `cnn_dailymail` и прогоном 512 примеров.
3. Аргумент сам по себе **не выбирает** ModelOpt-загрузчик. `get_model_loader` берет `ModelOptModelLoader` по значению `model_config.quantization` (`modelopt`, `modelopt_fp8`, `modelopt_fp4`, `modelopt_mixed`). Наличие путей чекпоинта участвует только в одном месте — флаг `modelopt_workflow_requested` отключает «онлайновую» ветку `modelopt_fp4`, которая иначе шла бы через обычный `DefaultModelLoader`.

## Значения и формат

- Путь к файлу состояния ModelOpt (`mto.save`), а не к HF-каталогу и не к safetensors.
- Совместимость версий проверяет сам ModelOpt; SGLang эту ошибку только логирует.
- Пустая строка эквивалентна ложному значению — восстановление не выполнится, но и предупреждения не будет.
- При TP > 1 путь один на все воркеры; восстановление выполняется в каждом.

## Когда использовать

- Развертывание модели, квантованной заранее через ModelOpt, когда повторная калибровка на каждом старте неприемлема.
- Воспроизводимость: одно и то же состояние квантизации на всех инстансах, а не результат новой калибровки на каждом хосте.
- Не используйте как «универсальный способ загрузить квантованную модель»: обычные квантизации (awq, gptq, fp8, compressed-tensors) читаются штатным загрузчиком по `--quantization` без всякого ModelOpt.
- Не рассчитывайте на этот путь как на строгий гейт качества: он деградирует к калибровке, а не падает.

## Влияние на производительность и память

- Главный выигрыш — время старта: восстановление вместо калибровки экономит минуты и снимает необходимость в сети для датасета.
- Пиковая VRAM при восстановлении ниже, чем при калибровке: нет forward-прогона батчами по 36 примеров.
- На инференс после старта не влияет — модель в обоих случаях получается квантованной одинаково.
- Диск: чекпоинт нужно где-то держать, размер сопоставим с квантованной моделью.

## Взаимодействие с другими аргументами

- `--modelopt-checkpoint-save-path`: парная операция; при успешном восстановлении не выполняется.
- `--modelopt-export-path`: выполняется и после восстановления — это единственная операция, доживающая до конца по этой ветке.
- `--quantization` (`modelopt*`): фактический переключатель ModelOpt-загрузчика.
- `--modelopt-quant`: конфигурация квантизации; доезжает до `ModelOptConfig`, но выбор загрузчика на этом commit'е определяет `--quantization`.
- `--quantize-and-serve`: отключен и бросает `NotImplementedError`; апстрим предлагает раздельный цикл «квантовать → развернуть», ради которого и существует пара save/restore.
- `--load-format`: `runai_streamer` и `remote_instance` исключают ModelOpt-ветку.

## Типовые проблемы и диагностика

- Warning `Failed to restore from <path>: …` + `Proceeding with calibration-based quantization...` — восстановление не удалось. Симптом со стороны эксплуатации: старт внезапно занимает минуты и требует сети.
- `ImportError: ModelOpt is not available. Please install modelopt.` — нет пакета в окружении.
- Ничего не происходит, ни одной ModelOpt-строки в логе — загрузчик не выбран; проверьте `--quantization` и наличие строки `Using ModelOptModelLoader due to ModelOpt quantization config.`
- `Model is already quantized, skipping quantization setup.` — чекпоинт уже квантован сам по себе, восстановление не нужно.
- Успех подтверждает `Restored quantized model from <path>`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3-8B --quantization modelopt_fp8 --modelopt-checkpoint-restore-path /models/modelopt/llama3-8b-fp8.ckpt
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3-8B --quantization modelopt_fp8 --modelopt-checkpoint-restore-path /models/modelopt/llama3-8b-fp8.ckpt --modelopt-export-path /models/llama3-8b-fp8-hf
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/modelopt_config.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/layers/modelopt_utils.py`
