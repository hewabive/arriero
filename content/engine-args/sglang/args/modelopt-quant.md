---
schema: 1
engine: sglang
primaryName: "--modelopt-quant"
title: "--modelopt-quant"
summary: Легаси-ручка интеграции с NVIDIA Model Optimizer. В checkout'е значение доезжает до `ModelOptConfig.quant` и там никем не читается — путь ModelOpt включается значениями `modelopt*` у `--quantization`, а рецепт калибровки выводится из них же.
group: model
related:
  - --quantization
  - --modelopt-export-path
  - --quantize-and-serve
  - --load-format
  - --dtype
---

# --modelopt-quant

## Кратко

Аргумент — часть узкой интеграции с библиотекой NVIDIA Model Optimizer (`nvidia-modelopt`), а не повседневная ручка. Он задумывался как «старый» способ указать рецепт калибровочной квантизации, но в коде checkout'а его значение нигде не потребляется: реальный переключатель — `--quantization modelopt`/`modelopt_fp8`/`modelopt_fp4`/`modelopt_mixed`, а рецепт `mtq.*_CFG` выводится из него же. Трогайте этот флаг только если вы осознанно воспроизводите ModelOpt-пайплайн и проверили поведение своей версии пакета.

## Оригинальная справка

```text
The ModelOpt quantization configuration. Supported values: 'fp8', 'int4_awq', 'w4a8_awq', 'nvfp4', 'nvfp4_awq'. This requires the NVIDIA Model Optimizer library to be installed: pip install nvidia-modelopt
```

## Паспорт аргумента

- Флаги: `--modelopt-quant`
- Группа: `model`
- Тип значения: в extract объявлен как `dict` (поле аннотировано `Optional[Union[str, Dict]]`), но argparse получает `type=str` — вывод типа в `arg_utils._infer_type_func` для всего, что не `str`/`int`/`float`, дает `str`. В командной строке это обычная строка
- Допустимые значения: `choices` нет. Справка называет `fp8`, `int4_awq`, `w4a8_awq`, `nvfp4`, `nvfp4_awq` — это ключи словаря `QUANT_CFG_CHOICES` в `sglang/python/sglang/srt/layers/modelopt_utils.py`, причем три из них (`int4_awq`, `w4a8_awq`, `nvfp4_awq`) помечены там как еще не поддержанные
- Значение по умолчанию: `null`
- Эффективное значение: не переопределяется и не читается. `build_load_config` кладет его в `ModelOptConfig.quant`, но ни один потребитель `modelopt_config` в checkout'е поле `quant` не открывает
- Где объявлен: `ServerArgs.modelopt_quant`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный по форме, легаси по смыслу; узкая интеграция, требующая внешнего пакета `nvidia-modelopt`
- Этап применения: формирование `LoadConfig` перед загрузкой весов

## Что меняет в движке

Цепочка значения обрывается. `build_load_config` (`sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`) собирает `ModelOptConfig(quant=server_args.modelopt_quant, checkpoint_restore_path=..., checkpoint_save_path=..., export_path=..., quantize_and_serve=...)` и кладет объект в `LoadConfig.modelopt_config`. Дальше:

- `get_model_loader` смотрит только на `checkpoint_restore_path`, `checkpoint_save_path` и `export_path` (переменная `modelopt_workflow_requested`) и на `model_config.quantization`;
- `ModelOptModelLoader._standard_quantization_workflow` и `DefaultModelLoader._load_modelopt_base_model` спрашивают `model_config.modelopt_quant` — но у класса `ModelConfig` такого атрибута нет вообще, `hasattr` возвращает `False`, и обе ветки уходят в `model_config._get_modelopt_quant_type()`, который выводит рецепт из `--quantization` (`modelopt_fp8`/`modelopt`→`fp8`, `modelopt_fp4`/`nvfp4_online`→`nvfp4`, `modelopt_mixed`→свой разбор).

То есть при отсутствии `--quantization modelopt*` никакой ModelOpt-путь не включится, сколько бы ни было задано `--modelopt-quant`; а при наличии `--quantization modelopt*` рецепт возьмут из него, а не отсюда.

Сам ModelOpt-путь, когда он включен, делает существенно больше, чем выбор ядра: `_load_modelopt_base_model` поднимает модель через `transformers.AutoModelForCausalLM.from_pretrained` с `device_map="auto"`, затем `_setup_modelopt_quantization` строит калибровочный даталоадер на датасете `cnn_dailymail` (batch 36, 512 сэмплов, значения зашиты в код) и вызывает `mtq.quantize`. Без установленного `nvidia-modelopt` это `ImportError`.

## Значения и формат

- Строка ключа рецепта. Отображение ключей в конфиги ModelOpt: `fp8`→`FP8_DEFAULT_CFG`, `int4_awq`→`INT4_AWQ_CFG`, `w4a8_awq`→`W4A8_AWQ_BETA_CFG`, `nvfp4`→`NVFP4_DEFAULT_CFG`, `nvfp4_awq`→`NVFP4_AWQ_LITE_CFG`.
- Аннотация допускает и словарь, но это относится к программному API `ServerArgs`, а не к CLI: из командной строки значение всегда придет строкой.
- Проверок на старте нет: неизвестное значение не отвергается argparse и — поскольку поле не читается — вообще ничем не проявится.

## Когда использовать

- Практически никогда в эксплуатации. Для ModelOpt-модели правильная ручка — `--quantization modelopt_fp8` / `modelopt_fp4` / `modelopt_mixed`; для сохранения результата — `--modelopt-export-path`.
- Если вы переносите чужую команду запуска, где этот флаг есть, — проверьте на своей сборке, читается ли поле (`grep -rn "modelopt_config.quant" python/sglang`), и не полагайтесь на него как на переключатель.
- Не используйте его как способ «включить квантизацию»: без `--quantization modelopt*` загрузчик останется обычным.

## Влияние на производительность и память

Сам аргумент влияния не имеет: значение не читается. Влияние есть у пути, который включается `--quantization modelopt*` — калибровочная квантизация поднимает модель средствами transformers, прогоняет 512 сэмплов и при нехватке VRAM урезает бюджет калибровки, поэтому старт занимает минуты и требует существенно больше памяти, чем обычная загрузка.

## Взаимодействие с другими аргументами

- `--quantization`: настоящий переключатель ModelOpt-пути и источник рецепта.
- `--modelopt-export-path`: вместе с `checkpoint-save-path`/`checkpoint-restore-path` образует признак `modelopt_workflow_requested`, который заставляет использовать `ModelOptModelLoader` даже там, где online-путь обошелся бы `DefaultModelLoader`.
- `--quantize-and-serve`: в checkout'е принудительно отключен, см. его документ.
- `--load-format`: `runai_streamer` и `remote_instance` исключают `ModelOptModelLoader` вовсе.

## Типовые проблемы и диагностика

- Флаг задан, а поведение не изменилось — это норма для checkout'а, а не поломка: поле не читается. Проверяйте по логу, есть ли строка `Using ModelOptModelLoader due to ModelOpt quantization config.`; если ее нет, ModelOpt-путь не включен.
- `ImportError: ModelOpt is not available. Please install modelopt.` — включился ModelOpt-путь, а пакета `nvidia-modelopt` в окружении нет.
- `ValueError: Invalid quantization choice: '<x>'. Available choices: [...]` — рецепт (выведенный из `--quantization`) не нашелся в `QUANT_CFG_CHOICES`.
- `AttributeError: ModelOpt quantization config '<CFG>' not found.` — версия `nvidia-modelopt` не содержит нужного конфига.
- `ModelOpt quantization failed: ...` плюс `Proceeding without quantization...` — калибровка упала, и модель поднимется **неквантованной**. Ошибка не фатальна, отследить можно только по логу.
- Принятое значение видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --quantization modelopt_fp8 --modelopt-quant fp8 --modelopt-export-path /models/exported/llama31-8b-fp8
```

```bash
python -m sglang.launch_server --model-path /models/exported/llama31-8b-fp8 --quantization modelopt_fp8 --host 127.0.0.1 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/modelopt_config.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/layers/modelopt_utils.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
