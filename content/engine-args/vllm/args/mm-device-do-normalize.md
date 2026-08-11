---
schema: 1
engine: vllm
primaryName: "--mm-device-do-normalize"
title: "--mm-device-do-normalize"
summary: Переносит нормализацию и масштабирование пикселей из CPU-препроцессинга на устройство, прямо перед ViT. Поддерживается единицами архитектур, поэтому «не задан» значит «решит модель», а не «выключено».
group: MultiModalConfig
related:
  - --mm-processor-kwargs
  - --mm-processor-device
  - --mm-encoder-attn-backend
  - --limit-mm-per-prompt
  - --api-server-count
---

# --mm-device-do-normalize

## Кратко

HF-процессор обычно делает `do_rescale` (деление на 255) и `do_normalize` (вычитание среднего, деление на std) на CPU, в API-процессе, над полноразмерным тензором `float32`. Флаг говорит: не делай этого на CPU — модель выполнит ту же арифметику на устройстве непосредственно перед ViT.

Тонкость, из-за которой флаг легко неправильно прочитать: **декларативный дефолт поля равен `True`, а дефолт CLI-аргумента переопределён на `None`**. Не задав флаг, вы получаете `None` — «пусть решит модель», и решение берётся из её флага `supports_mm_device_do_normalize`, который в этом commit'е выставлен лишь у нескольких архитектур.

Аргумент новый: в исходники checkout'а он попал за несколько дней до снятия snapshot'а. Проверяйте наличие через `vllm serve --help` в своём окружении.

## Оригинальная справка

```text
Move the do_normalize computation in the mm preprocessing to before the ViT, 
and let the device do it, so that CPU computation can be saved.
```

## Паспорт аргумента

- Флаги: `--mm-device-do-normalize`, `--no-mm-device-do-normalize`
- Группа argparse: `MultiModalConfig`
- Тип значения: bool с допустимым `None` (`argparse.BooleanOptionalAction`, `optional: true`)
- Допустимые значения: `True` / `False` / не задан (`None`)
- Значение по умолчанию: поле датакласса объявлено как `mm_device_do_normalize: bool | None = True`, но при регистрации аргумента `add_cli_args` явно перекрывает `default` на `None` — именно `None` и лежит в extract
- Эффективное значение: `ModelConfig._resolve_mm_device_do_normalize()` превращает `None` в `self._model_info.supports_mm_device_do_normalize`; `True` на неподдерживающей модели принудительно опускается в `False` с предупреждением; при `VLLM_USE_RUST_FRONTEND` всегда `False`
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_device_do_normalize`
- Этап применения: сборка `ModelConfig` (разрешение) → каждый вызов HF-процессора (подмена kwargs) → forward ViT

## Что меняет в движке

**Подмена kwargs.** `MultiModalConfig.merge_mm_processor_kwargs()`:

```python
kwargs = self.mm_processor_kwargs or {}
if self.mm_device_do_normalize:
    kwargs["do_normalize"] = False
    kwargs["do_rescale"] = False
return kwargs | dict(inference_kwargs)
```

То есть HF-процессору говорят «не нормализуй и не масштабируй», а соответствующая арифметика выполняется уже внутри модели на устройстве. Обратите внимание: per-request `mm_processor_kwargs` применяются **после** и могут вернуть `do_normalize` обратно.

**Разрешение значения.** `_resolve_mm_device_do_normalize` в `ModelConfig`:

- `None` и `VLLM_USE_RUST_FRONTEND` → `False` (debug-лог `Rust frontend does not currently support mm_device_do_normalize, forcing mm_device_do_normalize = False.`);
- `None` иначе → значение флага модели, debug-лог `mm_device_do_normalize is enabled/disabled by default.`;
- `True` при `VLLM_USE_RUST_FRONTEND` → `False` с **warning**;
- `True` на модели без поддержки → `False` с warning `Model does not support mm_device_do_normalize, forcing mm_device_do_normalize = False.`

**Кто поддерживает.** Флаг модели `supports_mm_device_do_normalize` объявлен в `SupportsMultiModal` как `False` и переопределён в `True` лишь у нескольких архитектур — в этом commit'е checkout'а это `qwen2_vl` и `qwen2_5_vl`. Точный список для вашей версии смотрите grep'ом по `supports_mm_device_do_normalize = True` в `vllm/model_executor/models/`.

**Влияние на кэш компиляции.** Значение входит в `MultiModalConfig.compute_hash()` наравне с backend'ом внимания энкодера и TP-режимом, поэтому переключение флага даёт другой ключ кэша графа.

## Значения и формат

- Не задан → `None` → «как решит модель». Это дефолт CLI и практически всегда то, что нужно.
- `--mm-device-do-normalize` → `True`: попытка включить принудительно. На неподдерживающей модели молча (точнее, с warning) откатится в `False`.
- `--no-mm-device-do-normalize` → `False`: принудительно выключить даже там, где модель это умеет. Полезно для сравнения численных результатов.
- Значение `None` содержательно отличается от `False`: `False` — ваше решение, `None` — делегирование модели.

## Когда использовать

- Явный `--no-mm-device-do-normalize`, когда после обновления vLLM изменились численные результаты на Qwen2-VL/Qwen2.5-VL и нужно исключить перенос нормализации из подозреваемых.
- Явный `--mm-device-do-normalize`, если вы добавили поддержку в своей модели (свой `supports_mm_device_do_normalize`) и хотите убедиться, что путь активен.
- В остальных случаях не задавайте: разрешение по модели корректнее, чем ручное угадывание, а неверное `True` всё равно будет опущено.
- Не рассматривайте флаг как ускоритель для любой VL-модели: без поддержки со стороны архитектуры он ничего не делает.

## Влияние на производительность и память

- **CPU хоста.** Основной эффект: из препроцессинга уходят два поэлементных прохода по полноразмерному float-тензору. На больших изображениях и видео это заметная доля времени API-процесса.
- **VRAM.** Небольшой рост: нормализация выполняется на устройстве над тензором активаций перед ViT.
- **RAM хоста.** Слегка снижается — меньше промежуточных копий в препроцессоре.
- **Latency.** TTFT мультимодального запроса падает за счёт более быстрого препроцессинга.
- **Численность.** Арифметика та же, но порядок операций и точность промежуточных значений меняются; побитового совпадения с CPU-путём ожидать не стоит.
- **Время старта.** Не влияет, кроме того, что смена значения инвалидирует кэш компиляции графа.

## Взаимодействие с другими аргументами

- `--mm-processor-kwargs`: флаг реализуется именно подстановкой `do_normalize`/`do_rescale` в эти kwargs; явные per-request значения применяются последними и перебивают подстановку.
- `--mm-processor-device`: соседняя, но независимая оптимизация — она переносит на устройство весь image/video-трансформ, а не только нормализацию, и требует encode-only инстанса.
- `--mm-encoder-attn-backend`: вместе с этим флагом входит в `MultiModalConfig.compute_hash()`, то есть оба участвуют в ключе кэша компиляции.
- `--limit-mm-per-prompt`: чем больше элементов и чем они крупнее, тем ощутимее выигрыш на CPU.
- `--api-server-count`: альтернативный способ разгрузить препроцессинг — распараллелить его по процессам.

## Типовые проблемы и диагностика

- **Симптом:** warning `Model does not support mm_device_do_normalize, forcing mm_device_do_normalize = False.` **Причина:** явный `True` на архитектуре без поддержки. **Лечение:** убрать флаг; ускорения на этой модели не будет.
- **Симптом:** warning про `VLLM_USE_RUST_FRONTEND`. **Причина:** Rust-фронтенд не поддерживает этот путь. **Лечение:** либо выключить Rust-фронтенд, либо смириться с CPU-нормализацией.
- **Симптом:** после обновления изменились ответы на картинках без изменения флагов. **Причина:** модель начала объявлять `supports_mm_device_do_normalize`, и `None` разрешился в `True`. **Лечение:** зафиксировать `--no-mm-device-do-normalize` и сравнить.
- **Симптом:** «двойная нормализация» — заметно искажённые ответы. **Причина:** per-request `mm_processor_kwargs` вернули `do_normalize: true`, а модель нормализует ещё раз на устройстве. **Лечение:** убрать эти ключи из запросов.
- **Подтверждение принятого значения:** debug-строки `mm_device_do_normalize is enabled.` / `... is disabled.` (либо `... by default.` для `None`) — уровень debug, поэтому потребуется поднять verbosity логгера.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --no-mm-device-do-normalize --limit-mm-per-prompt '{"image": 2}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-device-do-normalize --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/model_executor/models/interfaces.py`
- `vllm/vllm/model_executor/models/registry.py`
- `vllm/vllm/model_executor/models/qwen2_5_vl.py`
