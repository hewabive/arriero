---
schema: 1
engine: sglang
primaryName: "--modelopt-export-path"
title: "--modelopt-export-path"
summary: Каталог, куда ModelOpt-путь выгрузит квантованную модель в формате HuggingFace после калибровки. Узкая интеграция: это офлайн-операция конвертации, выполняемая внутри запуска сервера, а не ручка инференса.
group: model
related:
  - --quantization
  - --modelopt-quant
  - --quantize-and-serve
  - --model-path
  - --trust-remote-code
---

# --modelopt-export-path

## Кратко

Флаг превращает запуск сервера в задание конвертации: после того как ModelOpt откалибрует и квантует модель, результат будет записан в указанный каталог в формате HuggingFace, пригодном для последующего обычного запуска. Это часть узкой интеграции с `nvidia-modelopt`, а не повседневная настройка. Апстрим рекомендует разделять шаги: сначала квантовать с экспортом, потом отдельно поднимать сервер на экспортированном каталоге.

## Оригинальная справка

```text
Path to export the quantized model in HuggingFace format after ModelOpt quantization. The exported model can then be used directly with SGLang for inference. If not provided, the model will not be exported.
```

## Паспорт аргумента

- Флаги: `--modelopt-export-path`
- Группа: `model`
- Тип значения: путь к каталогу (`Optional[str]`)
- Допустимые значения: не ограничены
- Значение по умолчанию: `null` — экспорт не выполняется
- Эффективное значение: не переопределяется; но само по себе присутствие непустого значения меняет выбор загрузчика (см. ниже)
- Где объявлен: `ServerArgs.modelopt_export_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный по форме, узкая интеграция по сути; требует установленного `nvidia-modelopt`
- Этап применения: загрузка модели — `ModelOptModelLoader._standard_quantization_workflow` → `_setup_modelopt_quantization` → `_maybe_export_modelopt`

## Что меняет в движке

Значение попадает в `ModelOptConfig.export_path` (`build_load_config`) и оттуда в `LoadConfig.modelopt_config`. У него две роли.

**Роль первая — выбор загрузчика.** В `get_model_loader` (`sglang/python/sglang/srt/model_loader/loader.py`) непустой `export_path` (наравне с `modelopt_checkpoint_save_path` и `modelopt_checkpoint_restore_path`) поднимает флаг `modelopt_workflow_requested`. Он отключает «легкий» online-путь для `modelopt_fp4`: без него `modelopt_fp4` над неквантованным чекпойнтом обрабатывается обычным `DefaultModelLoader`, а с ним — полноценным `ModelOptModelLoader` с калибровкой.

**Роль вторая — сама выгрузка.** В `_setup_modelopt_quantization` экспорт вызывается в двух точках: сразу после успешного `mto.restore(...)` из `--modelopt-checkpoint-restore-path` и после калибровочного `mtq.quantize(...)`. `_export_modelopt_checkpoint` создает каталог (`os.makedirs(..., exist_ok=True)`), вызывает `modelopt.torch.export.export_hf_checkpoint(model, export_dir=export_path)` и дополнительно сохраняет туда токенизатор через `AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)`.

Обратите внимание: этот вызов токенизатора жестко передает `trust_remote_code=True` — независимо от `--trust-remote-code`. Для экспортного пути это отдельная поверхность доверия к коду чекпойнта.

После экспорта загрузка продолжается, и сервер поднимается на только что квантованной модели в памяти.

## Значения и формат

- Локальный путь к каталогу. Каталог создается, если его нет; существующее содержимое не очищается — `export_hf_checkpoint` пишет поверх.
- Путь должен быть доступен на запись из процесса воркера. В многоузловой конфигурации каждый ранг выполняет свой `load_model`, поэтому каталог на общей ФС будет переписан несколько раз; апстрим-код никакой ranked-защиты здесь не делает (`rank0_log` ограничивает только вывод в лог, но не сам вызов).
- Пустая строка эквивалентна «не задано» лишь неявно: проверка `if export_path:` считает пустую строку ложной.
- Специальных значений (`auto`, `-1`) нет.

## Когда использовать

- Одноразовая офлайн-конвертация: поднять сервер с `--quantization modelopt_fp8` (или `modelopt_fp4`) и `--modelopt-export-path`, дождаться строки об успешном экспорте, остановить сервер и дальше запускать инференс уже с экспортированного каталога без ModelOpt в цепочке.
- Не оставляйте флаг в постоянной команде запуска инстанса: каждый старт будет заново гонять калибровку и переписывать каталог, а холодный старт вырастет на минуты.
- Не используйте, если `nvidia-modelopt` не установлен — путь просто не включится либо упадет с `ImportError`.

## Влияние на производительность и память

- Время старта: включает полный ModelOpt-цикл — загрузка модели через transformers с `device_map="auto"`, калибровка на 512 сэмплах `cnn_dailymail` батчами по 36 и запись результата на диск. Это минуты, а не секунды.
- VRAM: калибровка идет по HuggingFace-пути, а не по обычному загрузчику SGLang. Если модель не помещается целиком, `infer_auto_device_map` частично уводит ее на CPU и код урезает бюджет GPU-памяти на калибровку (константа `DEFAULT_GPU_MEMORY_FRACTION_FOR_CALIBRATION` в `loader.py`), о чем печатает предупреждение.
- Диск: в каталоге окажется полная копия квантованной модели плюс файлы токенизатора.
- На стационарный throughput/latency после старта не влияет.

## Взаимодействие с другими аргументами

- `--quantization`: ModelOpt-загрузчик выбирается значениями `modelopt`, `modelopt_fp8`, `modelopt_fp4`, `modelopt_mixed`; без них экспорт не произойдет.
- `--modelopt-quant`: в checkout'е не читается, рецепт выводится из `--quantization`.
- `--quantize-and-serve`: заявлен как «квантовать и сразу отдавать без экспорта», но в checkout'е отключен и падает `NotImplementedError` — то есть экспорт остается единственным поддерживаемым исходом ModelOpt-квантизации.
- `--trust-remote-code`: на экспорт токенизатора не влияет, там `trust_remote_code=True` зашит.
- `--load-format`: `runai_streamer` и `remote_instance` полностью исключают `ModelOptModelLoader`.

## Типовые проблемы и диагностика

- `Warning: Failed to export quantized model to <path>: ...` — экспорт не удался, но старт **продолжится**: ошибка проглатывается и логируется. Проверяйте лог, а не только наличие каталога.
- `ImportError: ModelOpt export functionality is not available.` — установлен `nvidia-modelopt` без экспортного API.
- `Warning: Failed to export tokenizer: ...` — модель выгружена, токенизатор нет; экспортированный каталог будет неполным.
- `ModelOpt quantization failed: ...` плюс `Proceeding without quantization...` — упала калибровка; экспорта не будет, а сервер поднимется неквантованным.
- Успех подтверждают строки `Quantized model exported to HuggingFace format at <path>` и `Tokenizer exported to <path>`.
- Строка `Using ModelOptModelLoader due to ModelOpt quantization config.` подтверждает, что ModelOpt-путь вообще включился.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --quantization modelopt_fp8 --modelopt-export-path /models/exported/llama31-8b-fp8 --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/exported/llama31-8b-fp8 --quantization modelopt_fp8 --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/modelopt_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/layers/modelopt_utils.py`
- `sglang/docs/docs/advanced_features/quantization.mdx`
