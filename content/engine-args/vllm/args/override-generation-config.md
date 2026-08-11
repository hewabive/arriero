---
schema: 1
engine: vllm
primaryName: "--override-generation-config"
title: "--override-generation-config"
summary: Точечная правка серверных дефолтов сэмплинга поверх `generation_config.json` модели. Реально применяются только шесть параметров; остальные ключи молча остаются без эффекта.
group: ModelConfig
related:
  - --generation-config
  - --max-model-len
  - --model
  - --revision
---

# --override-generation-config

## Кратко

`--override-generation-config` задает или перекрывает значения generation config, из которого движок берет **дефолты сэмплинга** для запросов, не указавших параметр явно. В связке с `--generation-config auto` правки накладываются на конфиг модели, с `--generation-config vllm` — становятся единственным источником дефолтов.

Важное ограничение: из всего словаря в дефолты сэмплинга попадают только `repetition_penalty`, `temperature`, `top_k`, `top_p`, `min_p` и `max_new_tokens`.

## Оригинальная справка

```text
Overrides or sets generation config. e.g. `{"temperature": 0.5}`. If
used with `--generation-config auto`, the override parameters will be
merged with the default config from the model. If used with
`--generation-config vllm`, only the override parameters are used.
```

## Паспорт аргумента

- Флаги: `--override-generation-config`
- Группа argparse: `ModelConfig`
- Тип значения: JSON-объект; принимается строкой JSON и точечными под-флагами
- Допустимые значения: любые ключи; фильтрация происходит позже, при построении дефолтов сэмплинга
- Значение по умолчанию: `field(default_factory=dict)`, то есть пустой словарь
- Эффективное значение: не переопределяется движком, но результат зависит от `--generation-config`: при `vllm` база пустая, при `auto` — diff-словарь `generation_config.json` модели, при пути — конфиг из указанного каталога
- Где объявлен: `vllm/config/model.py:ModelConfig.override_generation_config`
- Этап применения: HTTP-слой, построение дефолтных `SamplingParams` (`ModelConfig.get_diff_sampling_param`)

## Что меняет в движке

`get_diff_sampling_param()` работает так:

1. База: пустой словарь при `--generation-config vllm`, иначе — `try_get_generation_config().to_diff_dict()`, то есть только отличающиеся от дефолтов transformers значения из `generation_config.json` модели (или из каталога, указанного в `--generation-config`).
2. `config.update(self.override_generation_config)` — ваши значения перекрывают базу поключево.
3. Из получившегося словаря отбираются **ровно шесть** ключей: `repetition_penalty`, `temperature`, `top_k`, `top_p`, `min_p`, `max_new_tokens`. Ключи со значением `None` отбрасываются.
4. `max_new_tokens` переименовывается в `max_tokens` — это серверный лимит числа выходных токенов для всех запросов, не задавших свой `max_tokens`.
5. Если итоговый набор непуст и источник не `vllm`, один раз печатается предупреждение: `Default vLLM sampling parameters have been overridden by the model's 'generation_config.json': '{...}'. If this is not intended, please relaunch vLLM instance with '--generation-config vllm'.`

Все остальные ключи (например `do_sample`, `num_beams`, `bos_token_id`) в словаре остаются, но на дефолты сэмплинга не влияют — это ровно тот случай, когда «правка не сработала», а ошибки нет.

## Значения и формат

Одной строкой JSON:

```bash
--override-generation-config '{"temperature":0.7,"top_p":0.8,"max_new_tokens":2048}'
```

Точечными под-флагами:

```bash
--override-generation-config.temperature 0.7
```

Особенности:

- Значения парсятся как JSON, поэтому числа пишутся без кавычек, а `null` — это именно `None` (ключ будет отброшен при отборе).
- `max_new_tokens` — единственный ключ с переименованием; в терминах OpenAI API это `max_tokens`.
- Пустой объект эквивалентен отсутствию аргумента.
- Аргумент задает **дефолты**, а не жесткие лимиты: явное значение в теле запроса выигрывает. Исключение по смыслу — `max_new_tokens`, который справка по `--generation-config` называет серверным лимитом на число выходных токенов.

## Когда использовать

- Модель приносит агрессивные дефолты в `generation_config.json` (низкая температура, `top_k`), а вам нужны другие — и при этом не хочется полностью отказываться от конфига модели.
- Нужно ограничить длину ответа по умолчанию на весь сервер: `max_new_tokens`.
- Для полного контроля предпочтительнее пара `--generation-config vllm` плюс явные значения здесь: тогда конфиг модели не участвует вовсе и предупреждение не печатается. Именно этот прием рекомендует `docs/VLLM_OPERATIONS.md` для стабильных серверных дефолтов.
- Не пытайтесь через этот аргумент задать параметры вне списка из шести — они не применятся.

## Влияние на производительность и память

На память не влияет. На производительность влияет косвенно: серверный `max_tokens` (из `max_new_tokens`) ограничивает длину генерации, а значит и время удержания KV-блоков одним запросом — это заметно на нагруженном инстансе. Параметры сэмплинга (`top_k`, `min_p`) меняют стоимость шага сэмплирования незначительно.

## Взаимодействие с другими аргументами

- `--generation-config`: определяет базу, поверх которой накладываются правки; значение `vllm` делает эти правки единственным источником.
- `--max-model-len`: общий лимит на промпт плюс вывод; `max_new_tokens` ограничивает только вывод и не может его превысить по смыслу.
- `--model`, `--revision`: откуда читается `generation_config.json`; смена ревизии может изменить базу и поведение сервера.

## Типовые проблемы и диагностика

- **Симптом:** ключ задан, а поведение не изменилось. **Причина:** ключ не входит в шесть отбираемых. **Проверка:** список `available_params` в `get_diff_sampling_param`. **Лечение:** задавать параметр в запросе или через поддерживаемое имя.
- **Симптом:** в логе `Default vLLM sampling parameters have been overridden by the model's 'generation_config.json': …`. **Причина:** дефолты приехали из репозитория модели (возможно, вместе с вашими правками). **Лечение:** `--generation-config vllm`, если конфиг модели не нужен.
- **Симптом:** ответы обрезаются на одинаковой длине без `max_tokens` в запросе. **Причина:** серверный `max_new_tokens`. **Лечение:** убрать ключ или поднять значение.
- **Симптом:** после обновления модели изменились ответы при неизменных аргументах. **Причина:** новый `generation_config.json`. **Лечение:** зафиксировать `--revision` либо перейти на `--generation-config vllm`.
- **Симптом:** точечные под-флаги задают не то. **Проверка:** `FlexibleArgumentParser` пишет `Found duplicate keys …` при конфликте путей; значения из `--config file.yaml` подставляются раньше явных флагов и потому проигрывают им.

## Примеры

```bash
vllm serve /models/Qwen3-4B --generation-config vllm --override-generation-config '{"temperature":0.7,"top_p":0.8}'
```

```bash
vllm serve /models/Qwen3-4B --override-generation-config.max_new_tokens 2048
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/vllm/entrypoints/openai/chat_completion/protocol.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
