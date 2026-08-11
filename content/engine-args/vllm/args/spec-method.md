---
schema: 1
engine: vllm
primaryName: "--spec-method"
title: "--spec-method"
summary: Сокращение для ключа `method` в `--speculative-config`. Задает алгоритм спекулятивного декодирования; передача одного этого флага уже включает спекуляцию.
group: VllmConfig
related:
  - --speculative-config
  - --spec-model
  - --spec-tokens
  - --max-num-batched-tokens
  - --gpu-memory-utilization
---

# --spec-method

## Кратко

`--spec-method` — не самостоятельная подсистема, а сокращенная запись одного ключа JSON-объекта `--speculative-config`. `EngineArgs.create_speculative_config()` кладет значение в `speculative_config["method"]`; если `--speculative-config` вообще не задавался, он создается пустым, то есть **спекулятивное декодирование включается самим фактом передачи этого флага**.

Вся механика, стоимость по памяти и компромисс «acceptance rate против latency» описаны в `--speculative-config`. Здесь — только выбор метода и его последствия.

## Оригинальная справка

```text
The name of the speculative method to use. If users provide and set the
`model` param, the speculative method type will be detected automatically
if possible, if `model` param is not provided, the method name must be
provided.

If using `ngram` method, the related configuration `prompt_lookup_max` and
`prompt_lookup_min` should be considered.
```

## Паспорт аргумента

- Флаги: `--spec-method`
- Группа argparse: `VllmConfig`
- Тип значения: строка из фиксированного списка `choices`
- Допустимые значения: `choices` в extract перечисляет их полностью — это `get_args(SpeculativeMethod)` из `vllm/config/speculative.py`. Практически рабочих семейств пять: `ngram`/`ngram_gpu`, `suffix`, `draft_model`, `eagle`/`eagle3`, `mtp`; плюс `medusa`, `mlp_speculator`, `dflash`, `dspark`, `extract_hidden_states`, `custom_class`. Все имена вида `*_mtp` (`deepseek_mtp`, `qwen3_next_mtp`, `glm4_moe_mtp`, …) приняты только ради обратной совместимости
- Значение по умолчанию: `None` — метод выводится автоматически
- Эффективное значение: `SpeculativeConfig.__post_init__` почти всегда переписывает заданное значение. Любое `*_mtp` (кроме самого `mtp`) заменяется на `mtp` с предупреждением; `None` превращается в `custom_class` (если `model` похож на `module.Class`), `ngram` (если `model` равен `ngram`/`[ngram]`) или `draft_model`; при `method: "draft_model"` реальный метод может быть уточнен по имени и `model_type` чекпоинта драфтера
- Где объявлен: `vllm/config/speculative.py:SpeculativeConfig.method`
- Этап применения: `create_engine_config` → `SpeculativeConfig.__post_init__` → выбор класса proposer в `vllm/v1/spec_decode/`

## Что меняет в движке

Значение определяет, какой proposer инстанцируется на каждый шаг декодирования, и нужны ли драфтеру собственные веса:

- `ngram`, `ngram_gpu` — поиск повторов в уже сгенерированном тексте; веса не грузятся, `draft_model_config` указывает на целевую модель. Обязателен `num_speculative_tokens`; `prompt_lookup_min`/`prompt_lookup_max` по умолчанию оба равны `5`, если не задан ни один, и копируют друг друга, если задан один.
- `suffix` — дерево суффиксов по истории запросов; тоже без весов, настраивается ключами `suffix_decoding_*` в `--speculative-config`.
- `draft_model` — отдельная маленькая модель. Требует совпадения размера словаря с целевой, иначе старт падает.
- `eagle`, `eagle3`, `dflash`, `dspark` — легкие головы поверх скрытых состояний целевой модели; конфиг драфтера подменяется на `EAGLEConfig`. `dflash` и `dspark` принудительно включают `parallel_drafting`, `dspark` дополнительно требует Model Runner V2.
- `mtp` — родная multi-token-prediction голова из чекпоинта самой модели: при отсутствии `model` он подставляется из целевой модели, туда же наследуется квантизация.
- `medusa`, `mlp_speculator` — исторические методы с отдельным чекпоинтом.
- `custom_class` — внешний proposer по пути `module.Class` в `model`; помечен предупреждением `Using a custom class-based proposer backend. This is an experimental feature and the proposer interface is subject to breaking changes in future vLLM releases.`
- `extract_hidden_states` — не ускорение, а механизм выдачи промежуточных скрытых состояний.

## Значения и формат

- Одно значение из `choices`, регистр важен. Подчеркивания в имени метода — часть значения, а не разделитель флага.
- `None` (значение по умолчанию) означает «выведи метод сам». Явное `--spec-method None` парсер тоже принимает: `optional_type` превращает строки `None` и пустую строку в `None`.
- Список `choices` статичен и берется из `Literal`-типа в исходниках. Если ваша сборка новее или старше снятого снимка, проверяйте фактический список через `vllm serve --help=spec-method` в нужном окружении.
- Флаг ничего не задает сам по себе: без `num_speculative_tokens` (из `--spec-tokens` или из `n_predict` чекпоинта драфтера) старт упадет.

## Когда использовать

- Когда метод не выводится из `--spec-model`: `ngram`, `suffix`, `mtp` без отдельного чекпоинта, `custom_class`.
- Когда автоопределение по имени чекпоинта ошибается: EAGLE-голова без подстроки `eagle` в пути будет опознана как `draft_model` и упадет на несовпадении словарей — тогда метод задают явно.
- Не задавайте `*_mtp`-варианты: они устарели и все равно схлопываются в `mtp`.
- Не пытайтесь через этот флаг «выбрать метод побыстрее», не измерив долю принятия: см. диагностику в `--speculative-config`.

## Влияние на производительность и память

Сам флаг памяти не занимает, но выбор метода определяет ее расход: `ngram`, `ngram_gpu`, `suffix` и `custom_class` не грузят весов вообще, `mtp` берет их из уже загруженного чекпоинта, а `draft_model`, `eagle*`, `medusa`, `mlp_speculator`, `dflash` добавляют вторую модель в бюджет `--gpu-memory-utilization` и удлиняют старт на вторую загрузку и компиляцию.

## Взаимодействие с другими аргументами

- `--speculative-config`: задать `method` в JSON и одновременно `--spec-method` нельзя — `create_speculative_config` бросает `--spec-method and --speculative-config['method'] are mutually exclusive`.
- `--spec-model`: для большинства методов пара «метод + драфтер»; для `ngram`, `ngram_gpu`, `suffix`, `mtp`, `extract_hidden_states` модель подставляется автоматически.
- `--spec-tokens`: обязателен для всех методов, где число токенов не выводится из конфига драфтера.
- `--max-num-batched-tokens`: метод влияет на число дополнительных слотов в бюджете шага через `num_lookahead_tokens`.
- `--gpu-memory-utilization`: методы с отдельными весами уменьшают остаток под KV-cache.

## Типовые проблемы и диагностика

- **Симптом:** `Unsupported speculative method: 'X'` (argparse-уровень: `invalid choice`). **Причина:** имя метода нет в `choices` установленной версии. **Лечение:** сверить список через `vllm serve --help=spec-method`.
- **Симптом:** предупреждение `method 'deepseek_mtp' is deprecated and replaced with mtp.` **Лечение:** писать `mtp`.
- **Симптом:** `Target and draft model should have the same vocabulary size.` при `--spec-method draft_model`. **Причина:** драфтер из другого семейства. **Лечение:** сменить драфтер либо перейти на `--speculative-config` с `use_heterogeneous_vocab: true`.
- **Симптом:** `method='custom_class' requires 'model' to contain the custom proposer module path`. **Лечение:** передать `--spec-model my_module.MyProposer`.
- **Симптом:** `num_speculative_tokens was provided but without speculative model.` **Причина:** метод требует весов, но `--spec-model` не задан. **Лечение:** добавить драфтер или взять `ngram`/`suffix`.
- **Подтверждение принятого значения:** сводка `SpeculativeConfig(method=..., ...)` в логе старта и периодическая строка `SpecDecoding metrics: ...`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --spec-method ngram --spec-tokens 4
```

```bash
vllm serve /models/Qwen3-8B --spec-method draft_model --spec-model /models/Qwen3-0.6B --spec-tokens 3
```

## Источники

- `vllm/vllm/config/speculative.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/spec_decode/`
- `vllm/docs/features/speculative_decoding/README.md`
