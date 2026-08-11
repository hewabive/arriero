---
schema: 1
engine: sglang
primaryName: "--sampling-defaults"
title: "--sampling-defaults"
summary: Откуда брать sampling-параметры, которые клиент не прислал: `model` (по умолчанию) — из `generation_config.json` модели, `openai` — из фиксированных значений OpenAI. Влияет только на `/v1/chat/completions` и `/v1/responses`.
group: serving
related:
  - --preferred-sampling-params
  - --model-path
  - --revision
  - --json-model-override-args
---

# --sampling-defaults

## Кратко

`--sampling-defaults` отвечает на вопрос «что подставить, если в запросе `temperature` не задана». Значение `model` (дефолт) означает «взять рекомендованные автором модели значения из `generation_config.json`», значение `openai` — «использовать нейтральные OpenAI-совместимые значения».

Два ограничения, которые надо знать до того, как менять флаг: он действует **только** на чат-подобные эндпоинты, и он никак не связан с `--preferred-sampling-params` — это два независимых механизма с разными точками применения.

## Оригинальная справка

```text
Where to get default sampling parameters. 'openai' uses SGLang/OpenAI defaults (temperature=1.0, top_p=1.0, etc.). 'model' uses the model's generation_config.json to get the recommended sampling parameters if available. Default is 'model'.
```

## Паспорт аргумента

- Флаги: `--sampling-defaults`
- Группа: `serving`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `openai`, `model`
- Значение по умолчанию: `model`
- Эффективное значение: `__post_init__` не переопределяет. Значение прокидывается в `ModelConfig(sampling_defaults=...)` в `ModelConfig.from_server_args`; сам конструктор `ModelConfig` имеет собственный дефолт `"openai"`, который виден только при прямом создании `ModelConfig` в обход `ServerArgs`
- Где объявлен: `ServerArgs.sampling_defaults`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение `ModelConfig` при старте → конструктор `OpenAIServingChat` (один раз) → подстановка в `to_sampling_params` на каждом чат-запросе

## Что меняет в движке

### Что читается из модели

`ModelConfig.get_default_sampling_params` (`sglang/python/sglang/srt/configs/model_config.py`):

```python
if self.sampling_defaults != "model":
    return {}
if self.hf_generation_config is None:
    return {}
config = self.hf_generation_config.to_dict()
available_params = ["repetition_penalty", "temperature", "top_k", "top_p", "min_p"]
return {p: config.get(p) for p in available_params if config.get(p) is not None}
```

То есть берутся ровно пять ключей и только те из них, что реально присутствуют в `generation_config.json`. Сам конфиг грузится `get_generation_config` (`sglang/python/sglang/srt/utils/hf_transformers/common.py`) через `GenerationConfig.from_pretrained`; его отсутствие — не ошибка, а DEBUG-строка «No generation config for …», и результат становится пустым словарем. С `openai` функция возвращает `{}`, даже если файл есть.

### Где подставляется

Результат один раз кладется в `OpenAIServingChat.default_sampling_params` и передается в `ChatCompletionRequest.to_sampling_params(model_generation_config=...)` (`sglang/python/sglang/srt/entrypoints/openai/protocol.py`):

```python
def get_param(param_name: str):
    value = getattr(self, param_name)
    if value is None:
        return model_generation_config.get(param_name, self._DEFAULT_SAMPLING_PARAMS[param_name])
    return value
```

Итоговый приоритет для `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`:

1. значение из тела запроса, если оно не `null`;
2. значение из `generation_config.json` — только при `--sampling-defaults model`;
3. встроенный fallback: у `ChatCompletionRequest` — `temperature=1.0`, `top_p=1.0`, `top_k=-1`, `min_p=0.0`, `repetition_penalty=1.0`; у `ResponsesRequest` тот же набор, но `temperature=0.7`.

Работает это благодаря тому, что в `ChatCompletionRequest` поля `temperature`/`top_p` объявлены как `Optional[... ] = None` — «не задано» отличимо от «задано нулем».

### Где НЕ подставляется

- `/v1/completions`: `OpenAIServingCompletions._build_sampling_params` берет `request.temperature`, `request.top_p` и т. д. напрямую, а в `CompletionRequest` у этих полей ненулевые pydantic-дефолты (`temperature=1.0`, `top_p=1.0`, `top_k=-1`, `repetition_penalty=1.0`). `model_generation_config` туда не передается вовсе.
- Нативный `/generate`: `sampling_params` приходит от клиента и нормализуется в `SamplingParams`, минуя OpenAI-протокол.
- `--preferred-sampling-params`: отдельный механизм в `TokenizerManager`, см. ниже.

Отдельно стоит помнить: `eos_token_id` из `generation_config.json` объединяется с `eos_token_id` из `config.json` в `ModelConfig._get_hf_eos_token_id` **независимо** от `--sampling-defaults`. Переключение на `openai` не отключает EOS-токены модели.

## Значения и формат

- `model` (по умолчанию) — рекомендованные автором модели значения. Для Qwen3, DeepSeek и подобных это как раз то, что нужно: их `generation_config.json` содержит выверенные `temperature`/`top_p`/`top_k`.
- `openai` — только фиксированные `_DEFAULT_SAMPLING_PARAMS`. Полезно, когда нужен строгий паритет с поведением OpenAI API или когда `generation_config.json` в чекпойнте заведомо мусорный.
- Значение вне списка отвергает argparse.
- Значения «отключить» нет: `openai` — это не «без дефолтов», а другой набор дефолтов.

## Когда использовать

- Клиент (агент, SDK) не передает sampling-параметры и рассчитывает на OpenAI-семантику `temperature=1.0` — ставьте `openai`, иначе получите значения из чекпойнта и не поймете, откуда взялась `temperature=0.6`.
- В чекпойнте лежит `generation_config.json` с параметрами под другую задачу (частая история у дообученных и сконвертированных весов) — `openai` убирает этот источник сюрпризов.
- **Не трогайте**, если клиенты всегда шлют явные `temperature`/`top_p`: значение из запроса всегда сильнее, и флаг ничего не изменит.
- **Не используйте** для «навязать всем свою температуру» — это не то, что делает аргумент; ближайший (и всё равно частичный) инструмент — `--preferred-sampling-params`.

## Влияние на производительность и память

На память не влияет. На скорость влияет косвенно и заметно: `top_k=-1` (все токены) против `top_k=20` из `generation_config.json` — это разный объем работы сэмплера, а разная `temperature` меняет длину генерации, а значит занятость KV-пула и время ответа.

## Взаимодействие с другими аргументами

- `--preferred-sampling-params`: применяется **позже и ниже** — в `TokenizerManager._create_tokenized_object`, слиянием `{**preferred, **obj.sampling_params}`. Поскольку OpenAI-фасад к этому моменту уже заполнил все пять ключей (значением из запроса, из `generation_config.json` или fallback'ом), `preferred` для них проигрывает **всегда**. Практический вывод: эти два флага не конкурируют, `--sampling-defaults` выигрывает для чат-запросов по построению.
- `--model-path` / `--revision`: определяют, какой `generation_config.json` будет прочитан.
- `--json-model-override-args`: правит `config.json`, не `generation_config.json`; на этот механизм не влияет.

## Типовые проблемы и диагностика

- **Ответы «горячее»/«холоднее» ожидаемого при пустом запросе.** Проверьте лог старта: при `model` и непустом конфиге печатается один раз `Using default chat sampling params from model generation config: {'temperature': …, 'top_p': …}`. Отсутствие строки означает либо `openai`, либо отсутствие/пустоту `generation_config.json`.
- **`--sampling-defaults model` задан, а значения не применились**: `generation_config.json` в чекпойнте нет (сообщение видно только при `--log-level debug`) или в нем нет ни одного из пяти поддерживаемых ключей.
- **Флаг не действует на `/v1/completions`** — это не баг, а описанное выше устройство: там дефолты pydantic-схемы.
- Принятое значение — в дампе `server_args=` при старте.
- Фактические параметры конкретного запроса удобнее всего смотреть при `--log-requests --log-requests-level 1` и выше — с первого уровня в лог попадают sampling-параметры.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --sampling-defaults model --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --sampling-defaults openai --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/utils/hf_transformers/common.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
