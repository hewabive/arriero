---
schema: 1
engine: sglang
primaryName: "--quantization"
title: "--quantization"
summary: Задает метод квантизации весов. Для уже квантованного чекпойнта его задавать не надо — движок читает метод из `quantization_config`; флаг нужен только когда вы хотите квантовать веса на загрузке или принудительно выбрать другое ядро под тот же формат.
group: model
related:
  - --dtype
  - --kv-cache-dtype
  - --quantization-param-path
  - --load-format
  - --modelopt-quant
  - --modelopt-export-path
  - --quantize-and-serve
  - --speculative-draft-model-quantization
  - --moe-runner-backend
  - --fp8-gemm-backend
  - --fp4-gemm-backend
  - --weight-cache-mode
  - --model-loader-extra-config
---

# --quantization

## Кратко

`--quantization` выбирает класс `QuantizationConfig`, через который будут построены линейные слои и MoE-эксперты. Значение по умолчанию `null` не означает «без квантизации»: движок сам подставит метод из `quantization_config` в `config.json` чекпойнта. Флаг нужен в двух случаях — когда веса лежат в полной точности и вы хотите квантовать их прямо на загрузке (online), и когда под один и тот же формат чекпойнта надо принудительно выбрать другое ядро (например `w8a8_fp8` вместо `compressed-tensors`). Для готового квантованного чекпойнта апстрим прямо просит флаг **не** задавать.

## Оригинальная справка

```text
The quantization method.
```

## Паспорт аргумента

- Флаги: `--quantization`
- Группа: `model`
- Тип значения: строка (`Optional[str]`)
- Допустимые значения: argparse ограничен списком `QUANTIZATION_CHOICES` (`awq`, `fp8`, `mxfp8`, `gptq`, `marlin`, `gptq_marlin`, `awq_marlin`, `bitsandbytes`, `gguf`, `modelopt`, `modelopt_fp8`, `modelopt_fp4`, `nvfp4_online`, `modelopt_mixed`, `petit_nvfp4`, `w8a8_int8`, `w8a8_fp8`, `moe_wna16`, `w4afp8`, `mxfp4`, `auto-round`, `auto-round-int8`, `compressed-tensors`, `modelslim`, `mxfp_w4a8`, `quark`, `quark_int4fp8_moe`, `quark_mxfp4`, `mlx_q4`, `mlx_q8`, `unquant`, `humming`). Этот список — **не** перечень работающих методов, см. «Значения и формат»
- Значение по умолчанию: `null`
- Эффективное значение: переопределяется регулярно. `unquant` превращается в `None` еще в `ServerArgs.__post_init__`; далее `ModelConfig._verify_quantization` может подставить метод из `quantization_config` чекпойнта, а архитектурные override'ы (`arg_groups/overrides.py`) — навязать метод на sm100. Поле объявлено `resolvable=True`, то есть его разрешено переписывать pipeline'у конфигурации
- Где объявлен: `ServerArgs.quantization`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (`unquant`, наследование в draft, `_gguf_quantization`) → построение `ModelConfig` в каждом воркере (`_verify_quantization`) → выбор загрузчика (`get_model_loader`) → создание квантованных слоев при инициализации модели

## Что меняет в движке

Значение попадает в `ServerArgs.quantization`, оттуда в `ModelConfig.quantization` (`ModelConfig.from_server_args`), и дальше служит ключом в реестре `QUANTIZATION_METHODS` (`sglang/python/sglang/srt/layers/quantization/__init__.py`). Выбранный `QuantizationConfig` создает `quant_method` для каждого линейного слоя и для `FusedMoE`; он же решает, какие параметры (`weight_scale`, `input_scale`, упакованные веса) создаются в модели и что делает `process_weights_after_loading`.

Ключевой шаг — `ModelConfig._verify_quantization` (`sglang/python/sglang/srt/configs/model_config.py`), он выполняется при построении `ModelConfig`, то есть уже после разбора CLI:

1. Значение приводится к нижнему регистру.
2. Читается `quantization_config` из `config.json` (или конфиг ModelSlim). Если он есть, каждому зарегистрированному методу дают шанс переопределить выбор через `override_quantization_method` — так, например, AWQ-чекпойнт на подходящем GPU сам переключается на `awq_marlin`.
3. Если CLI-значения нет — берется `quant_method` чекпойнта. Именно поэтому `default: null` почти всегда означает «метод возьмут из чекпойнта», а не «квантизации нет».
4. Если CLI-значение задано и **не совпадает** с методом чекпойнта, комбинация должна быть в таблице `compatible_quantization_methods` (`modelopt_fp8`←`modelopt`; `modelopt_fp4`←`modelopt`,`fp8`; `modelopt_mixed`←`modelopt`; `nvfp4_online`←`fp8`; `petit_nvfp4`←`modelopt`; `w8a8_int8`/`w8a8_fp8`/`auto-round-int8`←`compressed-tensors`) либо в `REQUANTIZATION_METHODS` (сейчас там только `quark_mxfp4`). Иначе — `ValueError` на старте.
5. Проверяется, что метод есть в реестре и разрешен на текущей платформе (отдельный список для ROCm), и печатается предупреждение, если метод не входит в `optimized_quantization_methods`.

Есть еще два пути, переписывающих значение помимо чекпойнта:

- `_gguf_quantization` (`sglang/python/sglang/srt/arg_groups/overrides.py`): если `--load-format` равен `auto`/`gguf` и `--model-path` указывает на GGUF-файл, `quantization` принудительно становится `gguf`.
- Архитектурные override'ы для sm100 (Qwen3-MoE, GLM-4 MoE, DeepSeek V3 и другие) подставляют метод чекпойнта и вместе с ним выбирают `--moe-runner-backend`. Для `DeepseekV3ForCausalLM` без `quantization_config` движок читает заголовок safetensors и включает `fp8`, только если в чекпойнте действительно лежат FP8-веса.

Выбор метода влияет и на загрузчик: `modelopt`, `modelopt_fp8`, `modelopt_fp4`, `modelopt_mixed` уводят на `ModelOptModelLoader`, `auto-round-int8` — на `IncModelLoader` (`get_model_loader` в `sglang/python/sglang/srt/model_loader/loader.py`).

Значение также наследуется драфт-моделью: если `--speculative-draft-model-quantization` не задан, он получает значение `--quantization`.

## Значения и формат

**Где настоящий список методов.** Список в `choices` — это список *разрешенных строк argparse*, а не список работающих методов. Реальный реестр — словарь `QUANTIZATION_METHODS` в `sglang/python/sglang/srt/layers/quantization/__init__.py`, и он собирается по платформе:

- `mxfp4` регистрируется только на CPU, CUDA и gfx95 (на NPU под тем же именем регистрируется другой, W4A4-класс);
- `mlx_q4`/`mlx_q8` существуют только на Apple MPS;
- на CPU с AMX реестр сужается до `CPU_QUANTIZATION_METHODS` (`fp8`, `w8a8_int8`, `compressed-tensors`, `awq`, `gptq`, `mxfp4`);
- `marlin` есть в `choices`, но записи в реестре у него нет — argparse значение примет, а старт упадет с `Unknown quantization method: marlin`;
- `unquant` — не метод, а явный отказ: в `__post_init__` он превращается в `None` и ставит флаг `_quantization_explicitly_unset`, который запрещает архитектурным override'ам заново включить квантизацию.

Посмотреть реестр своей сборки:

```bash
python -c "from sglang.srt.layers.quantization import QUANTIZATION_METHODS; print(sorted(QUANTIZATION_METHODS))"
```

**Чекпойнт нужен готовый или квантуем на загрузке.** Апстрим-таблица совместимости — `sglang/docs/docs/advanced_features/quantization.mdx`; в самом коде граница видна по комментариям в `QUANTIZATION_CHOICES`:

- Требуют **предварительно квантованного** чекпойнта (метод только читает уже упакованные веса и масштабы): `awq`, `awq_marlin`, `gptq`, `gptq_marlin`, `moe_wna16`, `gguf`, `bitsandbytes` (nf4-веса), `compressed-tensors`, `auto-round`, `modelslim`, `petit_nvfp4`, `w4afp8`, а также `modelopt_fp8`/`modelopt_fp4`/`modelopt_mixed`, когда чекпойнт уже размечен ModelOpt. Для них флаг обычно избыточен — метод и так придет из `quantization_config`.
- Квантуют **на загрузке** из BF16/FP16 (или requantize из FP8): `fp8`, `mxfp8`, `w8a8_int8`, `w8a8_fp8`, `nvfp4_online`, `quark_mxfp4`, `quark_int4fp8_moe`, `mxfp4` (только MoE), `mlx_q4`/`mlx_q8`. Здесь масштабы считаются из самих весов, калибровочный датасет не используется.
- Отдельный класс — путь ModelOpt с калибровкой (`--modelopt-export-path`): он загружает модель через HuggingFace, прогоняет калибровку и не является «просто выбором ядра».

**Что это стоит.** Online-квантизация не уменьшает объем, который надо прочитать с диска: чекпойнт читается в полной точности целиком, а ужимается уже в памяти. Экономия видна только в VRAM под веса; KV-кеш она не трогает — за него отвечает `--kv-cache-dtype`. По качеству online-методы считают масштабы по весам без калибровки и в общем случае проигрывают offline-методам вроде AWQ/GPTQ; requantization поверх уже квантованного чекпойнта (`quark_mxfp4`) движок сопровождает отдельным предупреждением о возможной потере точности и требованием перепроверить модель бенчмарками.

Специальных значений `0`/`-1`/`auto` у аргумента нет. Отсутствие флага = «взять из чекпойнта».

## Когда использовать

- Веса в BF16/FP16, GPU поддерживает FP8, и нужно вдвое сократить VRAM под веса без внешней конвертации — `--quantization fp8`. Проверяйте качество: это online-путь без калибровки.
- Чекпойнт per-channel INT8/FP8 с per-token динамической активацией, и вы хотите CUTLASS-ядра из `sgl-kernel` вместо vLLM-совместимого пути `compressed-tensors` — `--quantization w8a8_int8` или `w8a8_fp8`. Это ровно тот случай, когда флаг переопределяет `quant_method` чекпойнта легально (по таблице совместимости).
- Чекпойнт уже квантован (AWQ, GPTQ, FP8, ModelOpt) — **не** задавайте флаг. В лучшем случае он ничего не изменит, в худшем даст `ValueError` про несовпадение с `quantization_config`.
- Автоопределение включило метод, который вам не нужен, и вы хотите гарантированный BF16 — `--quantization unquant`. Обычное отсутствие флага здесь не помогает: архитектурные override'ы могут включить метод сами.

## Влияние на производительность и память

- VRAM весов: определяется разрядностью метода (INT4/FP4 против INT8/FP8 против BF16). Освободившееся место автоматически уходит в KV-пул, потому что его размер считается от остатка после весов через `--mem-fraction-static`.
- VRAM KV-кеша метод не меняет.
- Время старта: online-методы добавляют проход `process_weights_after_loading` по всем слоям (упаковка, вычисление масштабов, транспонирования) — на больших MoE это заметные десятки секунд поверх чтения весов. Offline-методы этот проход тоже делают, но он дешевле.
- Пропускная способность: метод определяет, какое GEMM-ядро будет выбрано, а `--fp8-gemm-backend`/`--fp4-gemm-backend` уточняют выбор внутри FP8/FP4. Методы вне списка `optimized_quantization_methods` работают через универсальные пути и могут быть медленнее неквантованной модели — движок предупреждает об этом отдельной строкой в логе.
- RAM хоста: online-квантизация читает полноточный чекпойнт, поэтому page cache и пиковая RSS загрузчика соответствуют исходному, а не итоговому размеру.
- В arriero: метод меняет реальный расход VRAM, но не меняет объявленный memory-draw инстанса — draw описывается вручную в конфигурации (`docs/RESOURCE_MANAGEMENT.md`). После смены метода draw нужно пересматривать, иначе планировщик будет считать по старой цифре.

## Взаимодействие с другими аргументами

- `--dtype`: тип, в котором читаются и хранятся неквантованные тензоры и активации. Для AWQ апстрим рекомендует `half`.
- `--kv-cache-dtype` и `--quantization-param-path`: отдельная ось. Квантизация весов не квантует KV-кеш.
- `--load-format`: `gguf`-файл в `--model-path` принудительно ставит `quantization=gguf`; `flash_rl` и `presharded` учитывают метод при формировании кеша шардов.
- `--modelopt-quant`, `--modelopt-export-path`, `--quantize-and-serve`: путь ModelOpt включается именно значениями `modelopt*` этого флага (см. `--modelopt-quant`).
- `--speculative-draft-model-quantization`: наследует значение, если не задан явно.
- `--moe-runner-backend`: FlashInfer-бэкенды MoE проверяют метод ассертами — `flashinfer_cutlass` принимает только `modelopt_fp4`, `modelopt_fp8`, `modelopt_mixed` или bfloat16; `flashinfer_trtllm` — `modelopt_fp4`, `nvfp4_online`, `fp8`, `modelopt_fp8`, `modelopt_mixed`, `compressed-tensors` или bfloat16. Несовпадение — `AssertionError` на старте.
- `--weight-cache-mode`: метод входит в отпечаток `CacheConfig`, и IPC-кеш поддерживает только неквантованные веса и блочный FP8; на любом другом методе он падает с `UnsupportedQuantForIPCError`.
- `--kt-method` (KTransformers): независимая ось. `--quantization` описывает GPU-часть, `--kt-method` — CPU-экспертов.

## Типовые проблемы и диагностика

- `ValueError: Unknown quantization method: <x>. Must be one of [...]` — метод принят argparse, но не зарегистрирован в этой сборке/на этой платформе (классический случай — `marlin`). Список в тексте ошибки и есть настоящий реестр вашей сборки.
- `ValueError: Quantization method specified in the model config (<a>) does not match the quantization method specified in the quantization argument (<b>).` — вы задали флаг поверх уже квантованного чекпойнта, и пара не входит в таблицу совместимости. Снимите флаг.
- `ValueError: <x> quantization is currently not supported in ROCm.` — метод есть, но не в ROCm-списке.
- `logger.warning("<x> quantization is not fully optimized yet. The speed can be slower than non-quantized models.")` — метод рабочий, но идет по неоптимизированному пути.
- `Using CLI-specified quantization (<a>) which is compatible with HF config quant_method (<b>).` — подтверждение, что переопределение принято по таблице совместимости.
- `Requantizing from quant_method='<a>' to the requested online quantization='<b>'` — включена перековка уже квантованных весов; апстрим требует после этого перепроверить качество.
- Дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) показывает значение после `__post_init__` и архитектурных override'ов, но **до** подстановки из `quantization_config` чекпойнта: подстановка живет в `ModelConfig`, а не в `ServerArgs`. Окончательный метод подтверждают строки выбора загрузчика (`Using ModelOptModelLoader due to ModelOpt quantization config.`) и информационные строки из `_verify_quantization`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --quantization fp8 --mem-fraction-static 0.85
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct-FP8-dynamic --quantization w8a8_fp8 --host 127.0.0.1 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --quantization unquant --dtype bfloat16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/layers/quantization/__init__.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/weight_cache/protocol.py`
- `sglang/docs/docs/advanced_features/quantization.mdx`
- `ktransformers/doc/en/kt-kernel/MiniMax-M3-Tutorial.md`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
