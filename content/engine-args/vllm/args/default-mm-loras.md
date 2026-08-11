---
schema: 1
engine: vllm
primaryName: "--default-mm-loras"
title: "--default-mm-loras"
summary: Карта «модальность → путь к адаптеру» для мультимодальных моделей, у которых LoRA обязана быть активной при наличии данной модальности. Адаптеры регистрируются под именами модальностей и подставляются автоматически.
group: LoRAConfig
related:
  - --enable-lora
  - --lora-modules
  - --max-loras
  - --max-lora-rank
  - --limit-mm-per-prompt
  - --enable-tower-connector-lora
---

# --default-mm-loras

## Кратко

Аргумент решает узкую задачу: у моделей вроде Granite Speech или Phi-4-multimodal есть адаптер, который обязан применяться всегда, когда в запросе присутствует аудио (или другая модальность). Вместо того чтобы заставлять клиента выбирать имя модели, движок подставляет `LoRARequest` сам.

Ограничение зафиксировано в самой справке: один адаптер на запрос. Если в запросе несколько модальностей, каждая со своим зарегистрированным адаптером, не применяется ни один.

## Оригинальная справка

```text
Dictionary mapping specific modalities to LoRA model paths; this field
is only applicable to multimodal models and should be leveraged when a
model always expects a LoRA to be active when a given modality is present.
Note that currently, if a request provides multiple additional
modalities, each of which have their own LoRA, we do NOT apply
default_mm_loras because we currently only support one lora adapter
per prompt. When run in offline mode, the lora IDs for n modalities
will be automatically assigned to 1-n with the names of the modalities
in alphabetic order.
```

## Паспорт аргумента

- Флаги: `--default-mm-loras`
- Группа argparse: `LoRAConfig`
- Тип значения: JSON-объект `{"модальность": "путь"}` (`dict[str, str] | None`, парсер `union_dict_and_str`)
- Допустимые значения: ключи — имена модальностей, которые модель объявляет в своих mm-placeholder'ах (`audio`, `image`, `video`, …); значения — путь к адаптеру или Hugging Face id
- Значение по умолчанию: `null` (`None`)
- Эффективное значение: не переопределяется, но проверяется до сборки `LoRAConfig`: непустое значение на немультимодальной модели даёт `ValueError: Default modality-specific LoRA(s) were provided for a non multimodal model`
- Где объявлен: `vllm/config/lora.py:LoRAConfig.default_mm_loras`
- Этап применения: сборка `VllmConfig` → инициализация состояния API-сервера (слияние со списком статических адаптеров) → выбор адаптера при разборе запроса

## Что меняет в движке

**Онлайн-режим (`vllm serve`).** `process_lora_modules()` дописывает к списку из `--lora-modules` по одному `LoRAModulePath(name=<модальность>, path=<путь>)` на каждую запись словаря. Дальше это обычные статические адаптеры: они грузятся в `init_static_loras()` до открытия порта, получают целочисленные id и появляются отдельными карточками в `GET /v1/models` — под именем модальности, а не под именем модели.

Подстановка при запросе идёт в `OpenAIServing._maybe_get_adapters()` → `_get_active_default_mm_loras()`. Логика намеренно грубая: собираются `type` всех элементов контента сообщений, у каждого берётся часть до первого `_` (`audio_url` → `audio`), и адаптер выбирается, если его имя попало в это множество. Если совпал ровно один адаптер — он и подставляется; если ноль или больше одного — не подставляется ничего. Явно указанное клиентом имя модели-адаптера имеет приоритет: проверка `request.model in self.models.lora_requests` идёт первой.

Подстановка работает не на всех эндпоинтах: `supports_default_mm_loras=True` передаётся из chat completions (в том числе батчевого) и из token-in-token-out-сервинга. Для `/v1/completions` она не включена.

**Офлайн-режим (`LLM.generate`).** `_resolve_mm_lora()` работает по фактическим `mm_placeholders` промпта, а id адаптера вычисляется детерминированно: индекс имени модальности в отсортированном по алфавиту списке ключей плюс 1. При пересечении нескольких модальностей печатается предупреждение `Multiple modality specific loras were registered and would be used by a single prompt consuming several modalities; ... will be skipped`.

## Значения и формат

Две эквивалентные формы записи:

- одной строкой JSON: `--default-mm-loras '{"audio": "/models/lora/audio"}'`;
- точечными под-флагами `FlexibleArgumentParser`: `--default-mm-loras.audio /models/lora/audio` (несколько под-флагов сливаются в один словарь).

Особенности:

- парсер `union_dict_and_str` считает значение словарём, только если строка целиком похожа на `{...}`. Всё остальное возвращается как обычная строка и падает уже на валидации pydantic-поля `dict[str, str] | None`, а не на разборе аргумента;
- ключ должен точно совпадать с именем модальности, которое модель кладёт в `mm_placeholders` (офлайн) и с префиксом `type` элемента контента до `_` (онлайн);
- имя модальности становится публичным именем адаптера в `GET /v1/models`; коллизия с именем из `--lora-modules` даст две записи с одинаковым `name`.

## Когда использовать

- Модель поставляется с обязательным модальностным адаптером, и вы не хотите заставлять клиентов указывать имя адаптера в поле `model`.
- Нужен единообразный доступ к смешанному трафику: текстовые запросы идут на базу, запросы с аудио — автоматически через адаптер.
- Не используйте на немультимодальной модели: старт упадёт.
- Не рассчитывайте на автоподстановку в `/v1/completions` и в запросах с несколькими «адаптерными» модальностями сразу — там она не сработает, и запрос уйдёт на базовую модель без предупреждения в онлайн-режиме.

## Влияние на производительность и память

- **VRAM.** Как у любого адаптера: буферы задаются `--max-loras`/`--max-lora-rank`, а не числом записей в словаре. Но каждая запись занимает GPU-слот при активации, поэтому `--max-loras` должен покрывать число одновременно востребованных модальностей.
- **RAM хоста.** Каждый адаптер занимает место в CPU-кэше; учитывайте их в `--max-cpu-loras` вместе с записями `--lora-modules`.
- **Время старта.** Растёт: адаптеры грузятся синхронно, до открытия порта, наравне со статическими.
- **Latency.** Подстановка — это разбор структуры сообщений на каждом chat-запросе (`_get_message_types`), стоимость на уровне обхода списка контента; заметного вклада нет.

## Взаимодействие с другими аргументами

- `--enable-lora`: обязателен, иначе загрузка адаптеров упадёт.
- `--lora-modules`: списки сливаются в `process_lora_modules`, поэтому фактический набор адаптеров шире того, что задан там.
- `--max-loras`, `--max-cpu-loras`: должны учитывать эти адаптеры наравне со статическими.
- `--limit-mm-per-prompt`: определяет, сколько элементов каждой модальности вообще допускается в запросе.
- `--enable-tower-connector-lora`: другой механизм — LoRA на энкодер и коннектор; на автоподстановку по модальности не влияет.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Default modality-specific LoRA(s) were provided for a non multimodal model`. **Причина:** модель не мультимодальная. **Лечение:** убрать аргумент.
- **Симптом:** ошибка валидации pydantic на поле `default_mm_loras`. **Причина:** значение не похоже на JSON-объект (например, записано как `audio=/path`). **Лечение:** одинарные кавычки вокруг JSON либо точечная форма `--default-mm-loras.audio /path`.
- **Симптом:** адаптер не применяется, хотя аудио в запросе есть. **Причина:** имя модальности не совпало с префиксом `type` элемента контента, либо запрос пришёл на `/v1/completions`, либо в запросе есть вторая модальность со своим адаптером. **Проверка:** `GET /v1/models` — адаптер должен быть в списке под именем модальности; в офлайн-режиме предупреждение о нескольких модальностях печатается в лог. **Лечение:** привести имя ключа к имени модальности; при необходимости указывать имя адаптера в поле `model` явно.
- **Симптом:** старт падает на загрузке адаптера. **Причина:** путь не существует; `init_static_loras` превращает любую ошибку загрузки в `ValueError`. **Лечение:** исправить путь.
- **Подтверждение принятого значения:** строки `Loaded new LoRA adapter: name '<модальность>', path '...'` в логе старта.

## Примеры

```bash
vllm serve ibm-granite/granite-speech-3.3-2b --enable-lora --max-lora-rank 64 --default-mm-loras '{"audio": "ibm-granite/granite-speech-3.3-2b"}' --limit-mm-per-prompt '{"audio": 1}'
```

```bash
vllm serve ibm-granite/granite-speech-3.3-2b --enable-lora --max-lora-rank 64 --default-mm-loras.audio ibm-granite/granite-speech-3.3-2b --max-loras 1
```

## Источники

- `vllm/vllm/config/lora.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/vllm/entrypoints/serve/utils/api_utils.py`
- `vllm/vllm/entrypoints/serve/engine/serving.py`
- `vllm/vllm/entrypoints/offline_utils.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/docs/features/lora.md`
