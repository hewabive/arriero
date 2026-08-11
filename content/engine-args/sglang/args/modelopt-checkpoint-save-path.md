---
schema: 1
engine: sglang
primaryName: "--modelopt-checkpoint-save-path"
title: "--modelopt-checkpoint-save-path"
summary: Куда `ModelOptModelLoader` сохранит результат калибровочной квантизации NVIDIA Model Optimizer, чтобы следующий запуск её не повторял. Работает только вместе с `--quantization modelopt*` и требует установленного `nvidia-modelopt`.
group: model
related:
  - --modelopt-checkpoint-restore-path
  - --modelopt-export-path
  - --modelopt-quant
  - --quantization
  - --quantize-and-serve
  - --load-format
---

# --modelopt-checkpoint-save-path

## Кратко

Это узкая интеграция с NVIDIA Model Optimizer, а не обычная ручка сервера. Аргумент имеет смысл ровно в одном сценарии: `ModelOptModelLoader` калибрует и квантует модель на старте, и полученное состояние нужно сохранить, чтобы следующий запуск поднялся с `--modelopt-checkpoint-restore-path` вместо повторной калибровки. Сама калибровка — это прогон датасета `cnn_dailymail` (512 примеров, батч 36) внутри процесса запуска; сохранение делает `mto.save(model, path)`.

## Оригинальная справка

```text
Path to save the ModelOpt quantized checkpoint after quantization. This allows reusing the quantized model in future runs.
```

## Паспорт аргумента

- Флаги: `--modelopt-checkpoint-save-path`
- Группа: `model`
- Тип значения: строка — путь к файлу чекпоинта ModelOpt
- Допустимые значения: не ограничены; каталог должен существовать и быть доступен на запись
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется; попадает в `ModelOptConfig.checkpoint_save_path`
- Где объявлен: `ServerArgs.modelopt_checkpoint_save_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный по форме, экспериментальный по сути — весь ModelOpt-путь обвешан `try/except` с деградацией вместо отказа
- Этап применения: загрузка модели в `ModelOptModelLoader.load_model`, после калибровочной квантизации

## Что меняет в движке

Значение проходит `ServerArgs → LoadConfig.modelopt_config (ModelOptConfig) → ModelOptModelLoader._setup_modelopt_quantization(quantized_ckpt_save_path=…)`. Внутри:

```python
mtq.quantize(model, quant_cfg, forward_loop=calibrate_loop)
...
if quantized_ckpt_save_path:
    try:
        mto.save(model, quantized_ckpt_save_path)
        rank0_log(f"Quantized model saved to {quantized_ckpt_save_path}")
    except Exception as e:
        logger.warning(f"Failed to save quantized checkpoint to {quantized_ckpt_save_path}: {e}")
```

Три вещи, которые надо знать до использования:

1. **Сам по себе аргумент ничего не включает.** Загрузчик `ModelOptModelLoader` выбирается в `get_model_loader`, только если `model_config.quantization` — одно из `modelopt_fp8`, `modelopt_fp4`, `modelopt_mixed`, `modelopt` (либо у модели уже есть ModelOpt-конфиг квантизации). Второй возможный триггер — `hasattr(model_config, "modelopt_quant")` — на этом commit'е не срабатывает: `ModelConfig` такого поля не заводит, `--modelopt-quant` доезжает только до `ModelOptConfig`. Без `--quantization modelopt*` путь сохранения молча не выполнится.
2. **Ошибка сохранения не останавливает сервер** — только warning. Проверять надо по логу, а не по факту успешного старта.
3. **Сохранение пропускается**, если модель уже квантована (`is_quantized(model)` → «Model is already quantized, skipping quantization setup.») или если сработал `--modelopt-checkpoint-restore-path`: восстановление завершает функцию до калибровки.

Также ModelOpt-ветка не выбирается при `--load-format runai_streamer` и `remote_instance` — эти форматы владеют своим транспортом весов.

## Значения и формат

- Путь к файлу, который создаст `mto.save`; формат — внутренний формат ModelOpt, не HF. Для HF-экспорта есть `--modelopt-export-path`.
- Каталог назначения не создается автоматически (в отличие от `export_path`, для которого делается `os.makedirs`).
- При TP > 1 сохранение выполняется в каждом воркере с одним и тем же путем — планируйте это либо через отдельные пути, либо через понимание, что rank'и перезапишут друг друга.
- Пустая строка ведет себя как заданное (ложное) значение — не задавайте её.

## Когда использовать

- Один раз, при подготовке квантованной модели: запустить с калибровкой и сохранить состояние.
- В CI/пайплайне подготовки артефактов, где сервер поднимается только чтобы выполнить квантизацию.
- Не используйте на проде в постоянной конфигурации: калибровка на старте — это лишние минуты и загрузка датасета из сети.
- Апстрим прямо рекомендует раздельный процесс «квантовать → развернуть»: `--quantize-and-serve` на этом commit'е вообще отключен и бросает `NotImplementedError: quantize_and_serve functionality is currently disabled due to compatibility issues.`

## Влияние на производительность и память

- Время старта растет на калибровку: 512 примеров `cnn_dailymail` прогоняются через модель, плюс запись чекпоинта. Это минуты, а не секунды.
- Требуется сеть на старте — датасет калибровки скачивается.
- VRAM: во время `mtq.quantize` в памяти живут и исходные, и квантованные веса — пик выше установившегося расхода.
- Диск: чекпоинт ModelOpt сопоставим по размеру с квантованной моделью.
- На инференс после старта аргумент не влияет.

## Взаимодействие с другими аргументами

- `--quantization` (`modelopt`, `modelopt_fp8`, `modelopt_fp4`, `modelopt_mixed`): обязательное условие выбора ModelOpt-загрузчика.
- `--modelopt-checkpoint-restore-path`: обратная операция. Если задан и восстановление удалось, калибровки и сохранения не будет.
- `--modelopt-export-path`: экспорт в HF-формат; выполняется и после успешного восстановления, и после калибровки.
- `--modelopt-quant`: описывает конфигурацию квантизации ModelOpt, но выбор загрузчика на текущем commit'е определяется значением `--quantization`.
- `--quantize-and-serve`: отключен; требует ModelOpt-квантизации и всё равно завершается `NotImplementedError`.
- `--load-format`: `runai_streamer` и `remote_instance` исключают ModelOpt-путь.

## Типовые проблемы и диагностика

- `ImportError: ModelOpt is not available. Please install modelopt.` — нет пакета `nvidia-modelopt` в окружении.
- Warning `Failed to save quantized checkpoint to …` — каталог не существует или недоступен на запись; сервер при этом продолжит работу, и результат калибровки будет потерян.
- Файл не появился и предупреждений нет — ModelOpt-загрузчик не выбирался. Проверьте `--quantization` и строку `Using ModelOptModelLoader due to ModelOpt quantization config.` в логе.
- Warning `ModelOpt quantization failed: …` + «Proceeding without quantization...» — квантизация не удалась, сервер поднялся на неквантованной модели. Это тот случай, когда «запустилось» не значит «сработало».
- Успех подтверждает строка `Quantized model saved to <path>`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3-8B --quantization modelopt_fp8 --modelopt-checkpoint-save-path /models/modelopt/llama3-8b-fp8.ckpt
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3-8B --quantization modelopt_fp8 --modelopt-checkpoint-save-path /models/modelopt/llama3-8b-fp8.ckpt --modelopt-export-path /models/llama3-8b-fp8-hf
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/modelopt_config.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/layers/modelopt_utils.py`
