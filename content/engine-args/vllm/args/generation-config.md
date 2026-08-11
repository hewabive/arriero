---
schema: 1
engine: vllm
primaryName: "--generation-config"
title: "--generation-config"
summary: Откуда брать дефолтные параметры сэмплирования — из `generation_config.json` модели, из нейтральных дефолтов vLLM или из указанной папки. Именно этот аргумент объясняет «я не задавал temperature, а она не 1.0».
group: ModelConfig
related:
  - --override-generation-config
  - --max-model-len
  - --hf-config-path
  - --revision
---

# --generation-config

## Кратко

По умолчанию (`auto`) vLLM читает `generation_config.json` модели и берёт оттуда `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty` и `max_new_tokens` как **дефолты сервера**. Клиент, не задавший эти поля в запросе, получает значения модели, а не нейтральные значения OpenAI-API.

Это самая частая причина расхождения «одинаковый запрос, разный ответ» между двумя инстансами одной модели. `--generation-config vllm` отключает наследование целиком.

## Оригинальная справка

```text
The folder path to the generation config. Defaults to `"auto"`, the
generation config will be loaded from model path. If set to `"vllm"`, no
generation config is loaded, vLLM defaults will be used. If set to a folder
path, the generation config will be loaded from the specified folder path.
If `max_new_tokens` is specified in generation config, then it sets a
server-wide limit on the number of output tokens for all requests.
```

## Паспорт аргумента

- Флаги: `--generation-config`
- Группа argparse: `ModelConfig`
- Тип значения: str — одно из зарезервированных слов `auto` / `vllm` либо путь к папке
- Допустимые значения: не ограничены; `auto` и `vllm` обрабатываются особо, всё остальное трактуется как путь
- Значение по умолчанию: `auto`
- Эффективное значение: не переопределяется движком, но определяет, применяется ли `max_new_tokens` как жёсткий потолок (см. ниже) — это поведение отличается от текста справки
- Где объявлен: `vllm/config/model.py:ModelConfig.generation_config`
- Этап применения: HTTP-слой — один раз при создании serving-объектов (`get_diff_sampling_param()`), затем на каждый запрос при сборке `SamplingParams`

## Что меняет в движке

**Загрузка.** `ModelConfig.try_get_generation_config()`:

- при `auto` и при `vllm` источником считается `self.hf_config_path or self.model`;
- при пути — сам путь;
- загрузка идёт через `GenerationConfig.from_pretrained(...)`, при `OSError` — через `GenerationConfig.from_model_config(get_config(...))`, при повторной неудаче возвращается `None`;
- результат приводится к `to_diff_dict()`, то есть остаются только отличия от дефолтов `transformers`.

**Фильтрация.** `get_diff_sampling_param()` при `vllm` начинает с пустого словаря, иначе с загруженного, затем накладывает `--override-generation-config`. Из результата оставляются только шесть ключей: `repetition_penalty`, `temperature`, `top_k`, `top_p`, `min_p`, `max_new_tokens`; последний переименовывается в `max_tokens` («Huggingface definition of max_new_tokens is equivalent to vLLM's max_tokens»). Если что-то осталось и источник не `vllm`, пишется предупреждение:

```
Default vLLM sampling parameters have been overridden by the model's `generation_config.json`: `{...}`. If this is not intended, please relaunch vLLM instance with `--generation-config vllm`.
```

**Применение.** Получившийся словарь становится `self.default_sampling_params` у каждого serving-объекта (`chat_completion/serving.py`, `completion/serving.py`, responses, scale-out) и подставляется в `request.to_sampling_params(max_tokens, self.default_sampling_params)` для полей, которых нет в запросе.

**«Server-wide limit» — только в двух случаях.** Ограничение выхода считает `get_max_tokens()` (`vllm/entrypoints/serve/utils/api_utils.py`):

```
fallback_max_tokens = max_tokens if max_tokens is not None else default_sampling_params.get("max_tokens")
return min(model_max_tokens, fallback_max_tokens, override_max_tokens, platform_max_tokens)  # None отбрасываются
```

а `override_max_tokens` в serving-слое собирается так:

```
self.override_max_tokens = (
    self.default_sampling_params.get("max_tokens")
    if mc.generation_config not in ("auto", "vllm")
    else getattr(mc, "override_generation_config", {}).get("max_new_tokens")
)
```

Отсюда: при дефолтном `auto` значение `max_new_tokens` из `generation_config.json` модели попадает только в `fallback` — то есть работает как **дефолт**, который клиент перебивает своим `max_tokens`. Жёстким потолком оно становится, только если `--generation-config` указывает на папку, либо если `max_new_tokens` задан через `--override-generation-config`. Формулировка справки про «server-wide limit ... for all requests» верна лишь для этих двух случаев.

## Значения и формат

- `auto` — читать `generation_config.json` из модели (или из `--hf-config-path`). Дефолт.
- `vllm` — ничего не читать; действуют нейтральные дефолты vLLM/OpenAI-API. Самый предсказуемый вариант для сервиса за прокси.
- Путь к **папке**, а не к файлу: внутри ожидается `generation_config.json` в формате `transformers`.
- Несуществующая папка не приводит к ошибке старта: `try_get_generation_config` глотает `OSError` и возвращает `{}`. Опечатка в пути даёт молчаливое «дефолтов нет» — проверяйте по наличию/отсутствию предупреждения в логе.
- Ключи вне шести перечисленных (например, `stop_token_ids`, `bos_token_id`) в `default_sampling_params` не попадают через этот путь; часть из них читается отдельно на уровне протокола.

## Когда использовать

- `--generation-config vllm` — когда инстанс обслуживает API и клиенты ожидают стандартных дефолтов OpenAI. Иначе одна и та же модель на двух серверах ведёт себя по-разному, и найти причину без чтения лога тяжело.
- `auto` — когда важно воспроизвести «рекомендованные автором модели» настройки без их дублирования в конфиге инстанса.
- Папка — когда у вас есть свой набор дефолтов на несколько моделей, и вы хотите заодно получить жёсткий потолок по `max_new_tokens`.
- В arriero: значения из `generation_config.json` применяются **внутри** vLLM, то есть до того, как ответ дойдёт до прокси. Узлы пайплайна `output-limit` и `context-limit` (`docs/API_PROXY_PIPELINES.md`) действуют на другом слое и не отменяют этот; если ответы обрезаются раньше ожидаемого, проверьте оба.

## Влияние на производительность и память

На VRAM, KV-cache и планировщик не влияет. Косвенно влияет на нагрузку: унаследованный `max_new_tokens` ограничивает длину генерации и тем самым удержание KV-блоков, а унаследованные `temperature`/`top_k`/`top_p` меняют путь сэмплирования, но не его стоимость. Загрузка конфига — одно чтение файла (или один запрос к Hub) на старте.

## Взаимодействие с другими аргументами

- `--override-generation-config`: накладывается поверх загруженного словаря. При `--generation-config vllm` работает как единственный источник дефолтов; и это единственный способ задать жёсткий потолок `max_new_tokens`, не переходя на путь-папку.
- `--hf-config-path`: при `auto` generation config читается оттуда же, откуда и основной конфиг.
- `--revision`, `--code-revision`: передаются в загрузку конфига.
- `--max-model-len`: даёт вторую границу выхода — `model_max_tokens = max_model_len − длина_входа`; итоговый лимит есть минимум из всех источников.

## Типовые проблемы и диагностика

- **Симптом:** ответы «слишком творческие» или наоборот детерминированные при пустом запросе. **Причина:** унаследованная `temperature` из `generation_config.json`. **Проверка:** предупреждение `Default vLLM sampling parameters have been overridden by the model's generation_config.json: {...}` в логе старта — в нём перечислены именно применённые значения. **Лечение:** `--generation-config vllm`.
- **Симптом:** ответы обрезаются на фиксированной длине, хотя клиент просит больше. **Причина:** `max_new_tokens` как жёсткий потолок, то есть `--generation-config <path>` или `--override-generation-config`. **Лечение:** убрать потолок либо поднять значение.
- **Симптом:** клиент задал `max_tokens`, и потолок не применился. **Причина:** при `--generation-config auto` `max_new_tokens` — только дефолт. **Действие:** если нужен настоящий потолок, используйте `--override-generation-config '{"max_new_tokens": N}'`.
- **Симптом:** указана папка, а дефолты не применились и предупреждения нет. **Причина:** `OSError` при загрузке проглочен, словарь пуст. **Лечение:** проверить, что в папке лежит `generation_config.json`.
- **Подтверждение принятого значения:** наличие или отсутствие предупреждения выше; при `--generation-config vllm` его не будет никогда.

## Примеры

```bash
vllm serve /models/Qwen3-4B --generation-config vllm --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --generation-config /etc/vllm/defaults --override-generation-config '{"temperature": 0.7}'
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/transformers_utils/config.py`
- `vllm/vllm/entrypoints/serve/utils/api_utils.py`
- `vllm/vllm/entrypoints/openai/chat_completion/serving.py`
- `vllm/vllm/entrypoints/openai/completion/serving.py`
- `docs/API_PROXY_PIPELINES.md` (arriero)
