---
schema: 1
engine: sglang
primaryName: "--model-impl"
title: "--model-impl"
summary: Какую реализацию модели брать — нативную SGLang, обертку над Transformers или MindSpore. `auto` откатывается на Transformers сам; значение `sglang` не запрещает этот откат, а `choices` у аргумента нет, поэтому опечатка проходит молча.
group: model
related:
  - --model-path
  - --trust-remote-code
  - --enable-multimodal
  - --model-config-parser
  - --load-format
  - --attention-backend
---

# --model-impl

## Кратко

`--model-impl` выбирает, чей код исполняет модель: нативная реализация из реестра SGLang, обертка над `transformers`, либо MindSpore. Нативная быстрее и поддерживает все фичи; Transformers-путь — способ поднять архитектуру, которой в SGLang еще нет, ценой производительности и части возможностей. Дефолт `auto` делает это сам и печатает предупреждение. Практический смысл ручного значения — `transformers`: он снимает часть проверок совместимости, которые в `auto` приводят к отказу.

## Оригинальная справка

```text
Which implementation of the model to use.

* "auto" will try to use the SGLang implementation if it exists and fall back to the Transformers implementation if no SGLang implementation is available.
* "sglang" will use the SGLang model implementation.
* "transformers" will use the Transformers model * "mindspore" will use the MindSpore model implementation.
```

## Паспорт аргумента

- Флаги: `--model-impl`
- Группа: `model`
- Тип значения: строка
- Допустимые значения: `choices` в объявлении **нет**, argparse принимает любую строку. Осмысленны только значения enum `ModelImpl`: `auto`, `sglang`, `transformers`, `mindspore` (`sglang/python/sglang/srt/configs/model_config.py`)
- Значение по умолчанию: `auto`
- Эффективное значение: не переписывается; фактическая реализация определяется в `get_model_architecture` и записывается в `model_config._resolved_model_impl`
- Где объявлен: `ServerArgs.model_impl`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение `ModelConfig` → разрешение класса модели перед загрузкой весов; дополнительно читается при выборе мультимодального процессора

## Что меняет в движке

Решение принимается в `get_model_architecture` (`sglang/python/sglang/srt/model_loader/utils.py`):

```python
is_native_supported = any(arch in ModelRegistry.get_supported_archs() for arch in architectures)
if model_config.model_impl == ModelImpl.MINDSPORE:
    architectures = ["MindSporeForCausalLM"]
elif not is_native_supported or model_config.model_impl == ModelImpl.TRANSFORMERS:
    architectures = resolve_transformers_arch(model_config, architectures)
```

Отсюда три вещи, которые не следуют из справки:

1. **`sglang` не является гарантией.** Если архитектуры нет в реестре SGLang, условие `not is_native_supported` истинно, и движок всё равно уходит в Transformers-путь — так же, как при `auto`. Значение `sglang` не приводит к отказу «нет нативной реализации».
2. **`auto` строже, чем `transformers`.** В `resolve_transformers_arch` при `auto` несовместимая реализация Transformers (`is_backend_compatible()` вернул False) даёт `ValueError: … has no SGlang implementation and the Transformers implementation is not compatible with SGLang.`, а при явном `transformers` — только предупреждение «Proceeding anyway because --model-impl=transformers was explicitly requested. The model may not work correctly.» То же с отсутствующим классом модели: явный `transformers` пропускает compat-gate.
3. **Опечатка не ловится.** `choices` нет, а сравнения идут с членами `str`-enum. Строка `transformer` (без `s`) не совпадёт ни с `TRANSFORMERS`, ни с `AUTO`, поэтому compat-проверки ветки `auto` будут пропущены, а поведение окажется ближе к «ни то, ни другое». Проверять значение стоит по дампу `server_args=`.

Дополнительно `model_impl` читается в двух местах: `ModelConfig` использует его при определении мультимодальности (эвристика по `vision_config`/`audio_config` применяется только при явном `transformers`, а список `mm_disabled_models` не отключает мультимодальность для Transformers-пути), и `managers/multimodal_processor.py` выбирает процессор Transformers-бэкенда.

## Значения и формат

- `auto` — попытаться нативно, иначе Transformers с полным набором проверок.
- `sglang` — то же самое по факту; отличается только тем, что compat-ветка `ModelImpl.AUTO` не выполняется.
- `transformers` — принудительно Transformers-реализация даже при наличии нативной; проверки совместимости деградируют до предупреждений.
- `mindspore` — архитектура жестко подменяется на `MindSporeForCausalLM`; применимо только в сборке с MindSpore.
- Регистр значим: сравнение идет по строкам enum в нижнем регистре.

## Когда использовать

- Оставьте `auto`.
- Поставьте `transformers`, когда нужна свежая архитектура, которой нет в реестре SGLang, и вы готовы к тому, что часть фич (специфичные attention backend'ы, некоторые оптимизации MoE) не заработает.
- Поставьте `transformers`, если `auto` падает на compat-gate, а вы понимаете риск и хотите увидеть, заведется ли модель.
- Не ставьте `sglang` в надежде «запретить откат» — этого эффекта у значения нет.

## Влияние на производительность и память

- Transformers-реализация обычно медленнее нативной: она не использует часть fused-kernel'ов SGLang и написана под другой контракт батчинга. Численной оценки в коде нет, сам движок формулирует это как «Some features may not be supported and performance may not be optimal».
- На объем весов и размер KV-пула выбор реализации не влияет — это то же самое число слоев и голов.
- Косвенно влияет на VRAM через набор доступных backend'ов и оптимизаций.
- Время старта может вырасти: Transformers-путь при кастомном коде подгружает модули из репозитория модели (`auto_map`), что требует `--trust-remote-code`.

## Взаимодействие с другими аргументами

- `--model-path`: архитектура берется из его `config.json`; она и решает, есть ли нативная реализация.
- `--trust-remote-code`: обязателен, когда Transformers-путь резолвит класс через `auto_map` в репозитории модели.
- `--enable-multimodal`: для части архитектур мультимодальность отключается по умолчанию, но **не** при `--model-impl transformers`.
- `--attention-backend`: не все backend'ы применимы к Transformers-реализации; несовместимость проявится позже, при инициализации backend'а.
- `--model-config-parser`: другой слой — он выбирает, как читать конфиг, а не как исполнять модель.

## Типовые проблемы и диагностика

- `ValueError: <Arch> has no SGlang implementation and the Transformers implementation is not compatible with SGLang.` — при `auto`; осознанный обход — явный `--model-impl transformers`.
- `ValueError: Cannot find model module. '<Arch>' is not a registered model in the Transformers library … and 'AutoModel' is not present in the model config's 'auto_map'.` — архитектуры нет ни там, ни там; `--model-impl` не поможет.
- Предупреждение «%s has no SGLang implementation, falling back to Transformers implementation» — тихий откат сработал; если вы этого не ждали, значит модель не поддерживается нативно.
- Модель поднялась, но заметно медленнее ожидаемого — проверьте это же предупреждение в логе старта.
- Значение аргумента как его принял движок — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/NewArch-7B --model-impl transformers --trust-remote-code
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --model-impl auto --served-model-name qwen3-30b
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/model_loader/utils.py`
- `sglang/python/sglang/srt/managers/multimodal_processor.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
