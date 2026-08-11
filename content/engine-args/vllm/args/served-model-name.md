---
schema: 1
engine: vllm
primaryName: "--served-model-name"
title: "--served-model-name"
summary: Публичные имена модели в HTTP API и в метках Prometheus. Без него именем становится строка `--model` целиком — для локального пути это весь путь.
group: ModelConfig
related:
  - --model
  - --revision
  - --lora-modules
  - --max-model-len
---

# --served-model-name

## Кратко

`--served-model-name` отвязывает публичное имя модели от того, откуда взяты веса. Аргумент принимает несколько имен: сервер отвечает на любое из них, а метки метрик берут первое.

Для управляемого сервера это способ сделать имя стабильным: путь к весам меняется при переезде каталога, публичное имя — нет.

## Оригинальная справка

```text
The model name(s) used in the API. If multiple names are provided, the
server will respond to any of the provided names. The model name in the
model field of a response will be the first name in this list. If not
specified, the model name will be the same as the `--model` argument. Noted
that this name(s) will also be used in `model_name` tag content of
prometheus metrics, if multiple names provided, metrics tag will take the
first one.
```

## Паспорт аргумента

- Флаги: `--served-model-name`
- Группа argparse: `ModelConfig`
- Тип значения: список строк (`nargs="+"` — несколько значений через пробел после одного флага)
- Допустимые значения: не ограничены
- Значение по умолчанию: `None` — имя равно строке `--model`
- Эффективное значение: `ModelConfig.served_model_name` заполняется функцией `get_served_model_name` **первой строкой** списка (или строкой `--model`, если список пуст). Это делается до `maybe_model_redirect`, поэтому карта редиректов `VLLM_MODEL_REDIRECT_PATH` на публичное имя не влияет. При этом HTTP-слой строит `BaseModelPath` для **каждого** имени из списка (`api_server.py`), то есть отвечают все
- Где объявлен: `vllm/config/model.py:ModelConfig.served_model_name`
- Этап применения: сборка `ModelConfig` → инициализация состояния API-сервера (`init_app_state`) → `GET /v1/models`, разрешение поля `model` в запросах, метки метрик

## Что меняет в движке

Значение живет в двух местах с разной семантикой:

1. **`ModelConfig.served_model_name`** — скаляр, первое имя. Используется как метка `model_name` в метриках Prometheus и в метриках парсеров tool-call (`init_parser_metrics`).
2. **`args.served_model_name`** — исходный список. `init_app_state` создает `BaseModelPath(name=<имя>, model_path=args.model)` для каждого элемента, и `OpenAIModelRegistry` регистрирует их все. Поэтому `GET /v1/models` перечисляет все имена, и запрос с любым из них маршрутизируется к одной и той же модели.

LoRA-модули (`--lora-modules`) добавляют собственные имена в тот же реестр — они не заменяют базовые, а дополняют их.

## Значения и формат

- Одно имя: `--served-model-name qwen3-4b`.
- Несколько: `--served-model-name qwen3-4b qwen3 default` — сервер примет любое, метрики будут помечены `qwen3-4b`.
- Не задано: имя равно строке `--model` как она передана. Для `/models/Qwen3-4B` публичным именем станет `/models/Qwen3-4B`.
- Ограничений на символы движок не накладывает, но имя попадает в URL-независимое поле `model` JSON-запроса и в метки метрик — пробелы и кавычки лучше не использовать.

## Когда использовать

- Всегда, когда модель задана локальным путем: иначе публичное имя — это путь файловой системы, который утекает в `/v1/models` и в метрики.
- Когда нужно сохранить совместимость с клиентами при смене весов: новое место, старое имя.
- Когда несколько клиентов исторически используют разные имена одной модели — перечислите их все.
- Не используйте как способ «разделить» одну модель на несколько логических: инстанс один, конфигурация одна, разные имена ведут в один и тот же движок.

## Влияние на производительность и память

На производительность и память не влияет: значение участвует только в маршрутизации по имени и в разметке метрик.

## Взаимодействие с другими аргументами

- `--model`: источник имени по умолчанию; публичное имя фиксируется до применения карты редиректов моделей.
- `--revision`: на имя не влияет — при смене ревизии имя остается прежним, что и требуется для стабильного контракта.
- `--lora-modules`: добавляют дополнительные имена в тот же реестр моделей.
- `--max-model-len`: попадает в поле `max_model_len` карточки модели в `GET /v1/models`, то есть публичное имя и заявленный лимит видны клиенту вместе.

## Типовые проблемы и диагностика

- **Симптом:** клиент получает 404/`model_not_found` на имя, которое «точно правильное». **Причина:** имя не входит в список `--served-model-name`, а дефолт равен полной строке `--model`. **Проверка:** `GET /v1/models`. **Лечение:** добавить имя в список.
- **Симптом:** в Prometheus метка `model_name` содержит путь к каталогу. **Причина:** аргумент не задан. **Лечение:** задать явное имя.
- **Симптом:** имен несколько, а в метриках видно только одно. **Причина:** метка берет первое имя списка — это документированное поведение. **Действий не требуется.**
- **Симптом (arriero):** публичное имя модели прокси не совпадает с ожидаемым. **Причина:** arriero выводит идентификатор модели инстанса как первое значение `--served-model-name`, а при его отсутствии — как первый позиционный аргумент (`packages/core/src/instance-model.ts`). **Лечение:** задать `--served-model-name` на инстансе.

## Примеры

```bash
vllm serve /models/Qwen3-4B --served-model-name qwen3-4b --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --served-model-name qwen3-4b qwen3 default --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/engine/arg_utils.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
