---
schema: 1
engine: sglang
primaryName: "--preferred-sampling-params"
title: "--preferred-sampling-params"
summary: JSON с sampling-параметрами, который публикуется в `/model_info` и подмешивается в запросы как самый слабый слой. Для ключей, которые OpenAI-фасад заполняет всегда (`temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`), он не срабатывает никогда.
group: serving
related:
  - --sampling-defaults
  - --skip-tokenizer-init
  - --stream-interval
  - --served-model-name
---

# --preferred-sampling-params

## Кратко

По справке это «настройки, которые вернутся в `/get_model_info`» — то есть в первую очередь способ **объявить** клиентам рекомендованные параметры. Но значение используется и как реальный слой дефолтов: `TokenizerManager` сливает его с параметрами запроса.

Практический эффект этого второго применения гораздо уже, чем кажется. Слияние выглядит как `{**preferred, **obj.sampling_params}`, а OpenAI-фасад к этому моменту уже положил в `obj.sampling_params` полный набор ключей. Поэтому `--preferred-sampling-params` реально влияет только на те параметры, которые фасад **не** заполняет, и на нативный `/generate`.

## Оригинальная справка

```text
json-formatted sampling settings that will be returned in /get_model_info
```

## Паспорт аргумента

- Флаги: `--preferred-sampling-params`
- Группа: `serving`
- Тип значения: JSON-объект (в extract `type: json`), разбирается `json.loads` на этапе argparse; поле объявлено как `Optional[str]`, но после разбора хранит словарь
- Допустимые значения: `choices` нет; ключи — поля датакласса `SamplingParams` (`sglang/python/sglang/srt/sampling/sampling_params.py`)
- Значение по умолчанию: `null` — слой отсутствует
- Эффективное значение: `_handle_other_validations` повторно применяет `json.loads`, если значение осталось строкой, и при `--skip-tokenizer-init` дополнительно прогоняет его через `SamplingParams(**value).normalize(None)` — это отсеивает параметры, требующие токенизатор
- Где объявлен: `ServerArgs.preferred_sampling_params`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → валидация в `__post_init__` → `TokenizerManager` (на каждом запросе) и HTTP-эндпоинт `/model_info`

## Что меняет в движке

### Публикация

`GET /model_info` (и его устаревший алиас `GET /get_model_info`, который печатает предупреждение) отдает поле `preferred_sampling_params` как есть — прямо из `server_args`. Никакой обработки, это чисто информационный канал для клиента.

### Подмешивание в запрос

`TokenizerManager._create_tokenized_object` (`sglang/python/sglang/srt/managers/tokenizer_manager.py`):

```python
if self.preferred_sampling_params:
    sampling_kwargs = {**self.preferred_sampling_params, **obj.sampling_params}
else:
    sampling_kwargs = obj.sampling_params
sampling_params = self.sampling_params_class(**sampling_kwargs)
```

Правое слагаемое побеждает — то есть **любой ключ, присутствующий в `obj.sampling_params`, перекрывает `preferred`**, даже если его значение равно дефолту. Отсюда важная деталь: `ChatCompletionRequest.to_sampling_params` формирует словарь, в котором `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `presence_penalty`, `frequency_penalty`, `n`, `stop`, `skip_special_tokens`, `spaces_between_special_tokens` и еще десяток ключей присутствуют **всегда**. `OpenAIServingCompletions._build_sampling_params` — аналогично. Значит, для чата и `/v1/completions` перечисленные параметры из `preferred` не берутся ни при каких условиях.

Что остается:

- **Нативный `/generate`** — клиент передает произвольное подмножество `sampling_params`, всё непереданное берется из `preferred`. Это основной рабочий сценарий.
- **Ключи, которых OpenAI-фасад не формирует.** Самый практичный пример — `stream_interval`: он есть в `SamplingParams`, но ни `ChatCompletionRequest`, ни `CompletionRequest` его не содержат, поэтому `--preferred-sampling-params '{"stream_interval": 8}'` реально задает поштучный интервал стриминга для OpenAI-запросов.

### Валидация

Валидация значения выполняется только при `--skip-tokenizer-init`: тогда `SamplingParams(**preferred).normalize(None)` упадет, если в наборе есть параметры, зависящие от токенизатора (например строковые `stop`). Без этого флага набор попадет в `SamplingParams` уже на первом запросе — неизвестный ключ даст `TypeError` там, а не на старте.

## Значения и формат

- Одна JSON-строка: `--preferred-sampling-params '{"temperature": 0.6, "top_p": 0.95}'`.
- Верхний уровень должен быть объектом; список или число дадут `TypeError` при конструировании `SamplingParams` (при `--skip-tokenizer-init` — сразу на старте).
- Невалидный JSON отвергает argparse на этапе разбора.
- Ключи — имена полей `SamplingParams`, а не имена OpenAI-полей: `max_new_tokens`, а не `max_tokens`; `stop_token_ids`, а не `stop_sequences`.
- `{}` эквивалентно «не задан»: проверка `if self.preferred_sampling_params:` для пустого словаря falsy.

## Когда использовать

- Инстанс обслуживается нативным `/generate` (собственный клиент, бенчмарк, SGLang-frontend) и вы хотите один раз задать рекомендованные параметры на сервере.
- Нужно объявить клиентам рекомендованные значения через `/model_info`, не навязывая их.
- Нужно поднять `stream_interval` для OpenAI-клиентов, не меняя серверный дефолт для всех путей — это единственный способ сделать это «мягко», потому что сам `--stream-interval` глобальный.
- **Не используйте** как способ навязать `temperature` OpenAI-клиентам: для чата это не работает по построению (см. выше). Для чата дефолты задаются через `--sampling-defaults` и `generation_config.json`.

## Влияние на производительность и память

На память не влияет. На скорость влияет ровно настолько, насколько влияют сами подставленные параметры (`top_k`, `stream_interval` и т. п.). Само слияние — один `dict`-литерал на запрос.

## Взаимодействие с другими аргументами

- `--sampling-defaults`: работает выше по стеку, на уровне OpenAI-протокола, и для пяти базовых sampling-ключей всегда выигрывает у `preferred`. Механизмы независимы и не заменяют друг друга.
- `--stream-interval`: глобальный серверный дефолт; `preferred` может задать per-server значение, которое клиент всё равно перебьет полем `stream_interval` в нативном запросе.
- `--skip-tokenizer-init`: включает раннюю валидацию значения на старте.
- `--served-model-name`: соседнее поле в ответе `/model_info`; на подстановку не влияет.

## Типовые проблемы и диагностика

- Ошибка argparse о значении `loads` — строка не парсится как JSON (чаще всего съедены кавычки оболочкой).
- `TypeError: __init__() got an unexpected keyword argument '<x>'` на первом же запросе — ключ, которого нет в `SamplingParams`. При `--skip-tokenizer-init` та же ошибка приходит на старте.
- **Значение задано, а `temperature` в ответах прежняя** — ожидаемое поведение для `/v1/chat/completions` и `/v1/completions`. Проверьте на нативном `/generate` с пустым `sampling_params`, чтобы убедиться, что сам слой работает.
- Подтверждение публикации: `curl -s http://127.0.0.1:30000/model_info | python -m json.tool` — поле `preferred_sampling_params`.
- Принятое значение видно и в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --preferred-sampling-params '{"temperature": 0.6, "top_p": 0.95, "top_k": 20}' --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --preferred-sampling-params '{"stream_interval": 8}' --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/sampling/sampling_params.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/entrypoints/openai/protocol.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
