---
schema: 1
engine: vllm
primaryName: "--spec-model"
title: "--spec-model"
summary: Сокращение для ключа `model` в `--speculative-config` — путь или HF-id драфтера, eagle-головы либо модуля собственного proposer'а. Передача этого флага сама по себе включает спекулятивное декодирование.
group: VllmConfig
related:
  - --speculative-config
  - --spec-method
  - --spec-tokens
  - --gpu-memory-utilization
  - --model
  - --download-dir
---

# --spec-model

## Кратко

`--spec-model` кладет значение в `speculative_config["model"]` и, если `--speculative-config` не задавался, создает его пустым — то есть включает спекулятивное декодирование. Значение адресует **вторую модель**: она скачивается, загружается на ту же карту и расходует ту же VRAM, что и целевая.

Механика, стоимость и компромиссы описаны в `--speculative-config`; здесь — что именно принимается в качестве значения и как оно влияет на выбор метода.

## Оригинальная справка

```text
The name of the draft model, eagle head, or additional weights, if
provided.
```

## Паспорт аргумента

- Флаги: `--spec-model`
- Группа argparse: `VllmConfig`
- Тип значения: строка (HF-id, локальный путь, либо `module.Class` для `custom_class`)
- Допустимые значения: не ограничены `choices`; фактическая пригодность проверяется при построении `ModelConfig` драфтера
- Значение по умолчанию: `None`
- Эффективное значение: `SpeculativeConfig.__post_init__` подставляет значение само, если оно не задано, а метод его подразумевает: для `mtp` и `dspark` — путь целевой модели, для `ngram` — литерал `ngram`, для `ngram_gpu` — `ngram_gpu`, для `suffix` — `suffix`, для `extract_hidden_states` — одноименную строку
- Где объявлен: `vllm/config/speculative.py:SpeculativeConfig.model`
- Этап применения: `create_engine_config` → построение `draft_model_config` → загрузка весов драфтера рядом с целевой моделью

## Что меняет в движке

1. **Определяет метод, если он не задан.** Путь вида `module.Class` (есть точка, последний сегмент начинается с заглавной) → `custom_class`; литералы `ngram`/`[ngram]` → `ngram`; иначе — `draft_model`.
2. **Уточняет метод по чекпоинту.** Подстрока `eagle-` в пути → `eagle`, `eagle3` → `eagle3`, `dflash` → `dflash`, `dspark` или архитектуры `Qwen3DSparkModel`/`Gemma4DSparkModel` → `dspark`; `model_type` равный `medusa` → `medusa`, `mlp_speculator` → `mlp_speculator`, любой MTP-тип → `mtp`. Именно поэтому имя каталога драфтера имеет значение: EAGLE-голова, лежащая в каталоге без `eagle` в названии, будет опознана как `draft_model`.
3. **Строит отдельный `ModelConfig`.** Драфтер наследует от целевой модели `tokenizer`, `tokenizer_mode`, `trust_remote_code`, `dtype`, `seed`, `config_format`, `max_logprobs` и ограничение длины; своими остаются `revision`, `code_revision`, `quantization`, `max_model_len` (ключи `--speculative-config`).
4. **Задает `num_speculative_tokens` по умолчанию.** Если в конфиге драфтера есть `n_predict`, он становится значением по умолчанию; заданное вручную значение должно быть кратно `n_predict`.

## Значения и формат

- HF-id (`org/repo`) или локальный путь. Скачивание идет тем же механизмом, что и для целевой модели, и подчиняется `--download-dir` и переменным окружения HF.
- Литералы `ngram`, `ngram_gpu`, `suffix`, `extract_hidden_states` допустимы, но задавать их вручную не нужно — они подставляются по методу.
- Для `--spec-method custom_class` значение должно быть импортируемым путем `my_module.MyProposer`; класс обязан принимать `VllmConfig` и реализовывать `propose`.
- Пустая строка и `None` парсятся как `None` (`optional_type`).
- Никакой проверки существования пути на этапе разбора CLI нет: ошибка возникает позже, при построении `ModelConfig` драфтера.

## Когда использовать

- Для `draft_model`, `eagle`, `eagle3`, `medusa`, `mlp_speculator`, `dflash` — это единственный способ указать драфтер.
- Для `mtp`, `ngram`, `suffix` флаг не нужен: движок подставит значение сам. Явно задавать путь целевой модели для `mtp` можно, но смысла не добавляет.
- Не используйте его как «второй `--model`»: параметры HTTP-слоя, `--served-model-name` и маршрутизация прокси про драфтер ничего не знают.

## Влияние на производительность и память

Драфтер — это дополнительный набор весов и, для model-based методов, дополнительный KV-cache на той же карте. Все это вычитается из бюджета `--gpu-memory-utilization` до KV-cache целевой модели, поэтому емкость кэша и `Maximum concurrency` падают. Старт удлиняется на скачивание, загрузку и компиляцию второй модели. Для `ngram`/`suffix` (где `model` подставляется литералом) расхода VRAM нет.

## Взаимодействие с другими аргументами

- `--speculative-config`: ключ `model` и этот флаг взаимоисключающи (`--spec-model and --speculative-config['model'] are mutually exclusive`).
- `--spec-method`: при заданном `--spec-model` метод часто выводится сам; задавайте метод явно, если имя каталога не содержит опознавательной подстроки.
- `--spec-tokens`: обязателен, если в конфиге драфтера нет `n_predict`.
- `--gpu-memory-utilization`: общий бюджет, из которого вычитаются веса драфтера.
- `--model`: целевая модель; словарь драфтера должен совпадать с ее словарем, если не включен `use_heterogeneous_vocab`.

## Типовые проблемы и диагностика

- **Симптом:** `Target and draft model should have the same vocabulary size. Target model vocab_size=N. Draft model vocab_size=M.` **Лечение:** взять драфтер того же семейства либо `--speculative-config '{"method":"draft_model","model":"...","num_speculative_tokens":3,"use_heterogeneous_vocab":true}'`.
- **Симптом:** `A speculative model was provided, but 'num_speculative_tokens' was not provided`. **Лечение:** добавить `--spec-tokens`.
- **Симптом:** EAGLE-голова работает как обычный драфт-модель и падает на словаре. **Причина:** в пути нет подстроки `eagle`. **Лечение:** добавить `--spec-method eagle3` (или нужный вариант).
- **Симптом:** `method='custom_class' requires 'model' to contain the custom proposer module path (e.g., 'my_module.MyProposer').` **Лечение:** передать импортируемый путь.
- **Симптом:** OOM на этапе загрузки весов после включения спекуляции. **Причина:** веса драфтера не были учтены в бюджете. **Лечение:** понизить `--gpu-memory-utilization` не получится — бюджет надо, наоборот, освободить: уменьшите `--max-model-len`/`--max-num-seqs` либо выберите метод без отдельных весов.
- **Подтверждение принятого значения:** в логе старта видны две загрузки весов и сводка `SpeculativeConfig(method=..., model=...)`.

## Примеры

```bash
vllm serve /models/Qwen3-8B --spec-model /models/Qwen3-0.6B --spec-tokens 3 --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-8B --spec-method eagle3 --spec-model /models/eagle3-head --spec-tokens 2
```

## Источники

- `vllm/vllm/config/speculative.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/docs/features/speculative_decoding/draft_model.md`
- `vllm/docs/features/speculative_decoding/eagle.md`
