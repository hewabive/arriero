---
schema: 1
engine: vllm
primaryName: "--speculative-config"
title: "--speculative-config"
summary: JSON-объект, включающий спекулятивное декодирование и полностью описывающий его: метод, драфтер, число спекулятивных токенов и настройки приема. Единственная полная форма настройки; `--spec-method`/`--spec-model`/`--spec-tokens` — сокращения для трех его ключей.
group: VllmConfig
related:
  - --spec-method
  - --spec-model
  - --spec-tokens
  - --max-num-batched-tokens
  - --max-num-scheduled-tokens
  - --max-num-seqs
  - --gpu-memory-utilization
  - --enforce-eager
  - --max-cudagraph-capture-size
  - --data-parallel-size
  - --diffusion-config
---

# --speculative-config

## Кратко

`--speculative-config` принимает JSON-объект, который целиком парсится в датакласс `SpeculativeConfig` (`vllm/config/speculative.py`). Непустое значение включает спекулятивное декодирование: движок на каждом шаге просит драфтер предложить `num_speculative_tokens` токенов вперед, прогоняет их через целевую модель одним forward-ом и принимает столько, сколько прошло проверку.

Выигрыш не бесплатный. Каждый шаг стоит на `num_speculative_tokens` дороже по вычислениям и по слотам планировщика независимо от того, сколько токенов приняли. При низкой доле принятия (acceptance rate) latency **ухудшается**, а под конкурентной нагрузкой лишние токены отбирают бюджет у реальных запросов. Это ручка для режима «одна-две сессии, GPU недозагружен», а не для максимального throughput.

## Оригинальная справка

```text
Speculative decoding configuration.
```

## Паспорт аргумента

- Флаги: `--speculative-config`, `-sc`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `-sc.<ключ> <значение>`)
- Допустимые значения: ключи полей `SpeculativeConfig`; список в разделе «Значения и формат»
- Значение по умолчанию: `None` — спекулятивное декодирование выключено
- Эффективное значение: JSON **не валидируется на этапе разбора CLI**. `add_cli_args` подменяет тип на `optional_type(json.loads)`, чтобы отложить pydantic-валидацию; объект собирается позже в `EngineArgs.create_speculative_config()`, куда дополнительно вкладываются `target_model_config` и `target_parallel_config`. Дальше `SpeculativeConfig.__post_init__` доопределяет `method`, `model`, `num_speculative_tokens`, `prompt_lookup_min/max` и может переписать `method` (см. ниже)
- Где объявлен: `vllm/config/vllm.py:VllmConfig.speculative_config`
- Этап применения: разбор CLI → `create_engine_config` → загрузка драфтера вместе с моделью → планировщик (резерв слотов) → каждый forward

## Что меняет в движке

1. **Сборка конфигурации.** `create_speculative_config()` сначала вливает в словарь значения `--spec-method`/`--spec-model`/`--spec-tokens` (см. «Взаимодействие»), затем нормализует ключи (`-` → `_`) и конструирует `SpeculativeConfig`.
2. **Определение метода.** Если `method` не задан, `__post_init__` выводит его: путь вида `module.Class` → `custom_class`; `model` равен `ngram`/`[ngram]` → `ngram`; иначе → `draft_model`. Затем метод уточняется по чекпоинту драфтера: подстроки `eagle-`, `eagle3`, `dflash`, `dspark` в имени, `model_type` равный `medusa`/`mlp_speculator`, любой из MTP-типов. Все устаревшие MTP-имена (`deepseek_mtp`, `qwen3_next_mtp`, …) заменяются на `mtp` с предупреждением `method 'X' is deprecated and replaced with mtp.`.
3. **Драфтер как отдельная модель.** Для `draft_model`, `eagle`, `eagle3`, `medusa`, `mlp_speculator`, `mtp`, `dflash`, `dspark` строится собственный `ModelConfig` (`draft_model_config`) и грузятся отдельные веса — на ту же карту, из того же бюджета `--gpu-memory-utilization`. Для `ngram`, `ngram_gpu`, `suffix`, `custom_class` драфтер весов не имеет: `draft_model_config` просто ссылается на целевую модель.
4. **Резерв KV-слотов.** `VllmConfig.num_lookahead_tokens` добавляет к каждому запросу запас блоков под позиции, которые пишет драфтер: `num_speculative_tokens` для eagle/draft-model-методов, `num_speculative_tokens + 1` для `dflash`, `0` для ngram/suffix.
5. **Бюджет планировщика.** `max_num_new_slots_for_drafting` вычитается из бюджета шага, а `_set_max_num_scheduled_tokens()` проверяет, что при этом остаются слоты хотя бы под один токен.
6. **CUDA graphs.** `decode_query_len = 1 + num_speculative_tokens` входит в расчет `max_cudagraph_capture_size`, то есть спекуляция меняет сетку захватываемых графов.
7. **Ограничения совместимости.** При динамическом варианте (`num_speculative_tokens_per_batch_size`) движок принудительно переводит `cudagraph_mode` в `PIECEWISE` (если не включен `VLLM_USE_V2_MODEL_RUNNER=1`) и отключает динамику при `--data-parallel-size > 1`, оставляя статическое `num_speculative_tokens`. Метод `dspark` принудительно включает Model Runner V2.

## Значения и формат

Обе формы записи эквивалентны и обрабатываются `FlexibleArgumentParser` (`vllm/utils/argparse_utils.py`):

- одной строкой: `--speculative-config '{"method":"ngram","num_speculative_tokens":4}'`;
- точечными под-флагами: `-sc.method ngram -sc.num_speculative_tokens 4`. Парсер собирает все под-флаги **с одинаковым написанием ключа** в один словарь и подставляет его как JSON. Смешивать написания нельзя: `-sc.method ngram` и `--speculative-config.num-speculative-tokens 4` дадут два разных argparse-аргумента, и победит последний. По той же причине не следует одновременно передавать полную JSON-строку и точечные под-флаги — точечные добавляются в конец командной строки и перетирают строку целиком, а не сливаются с ней.
- список пишется либо валидным JSON (`-sc.synthetic_acceptance_rates '[0.9,0.7]'`), либо через суффикс `+`: `-sc.synthetic_acceptance_rates+ 0.9,0.7`.

Ключи, которые действительно настраивают (полный перечень — поля `SpeculativeConfig`):

| Ключ | Значение по умолчанию | Смысл |
| --- | --- | --- |
| `method` | `None` (выводится) | метод спекуляции; те же значения, что у `--spec-method` |
| `model` | `None` | драфтер: HF-id, локальный путь, eagle-голова или `module.Class` |
| `num_speculative_tokens` | `None` (обязателен, если не выводится из `n_predict` драфтера) | сколько токенов предлагать за шаг, строго `> 0` |
| `draft_tensor_parallel_size` | `None` | TP драфтера; допустимы только `1` и TP целевой модели |
| `quantization` | `None` | квантизация весов драфтера (только для model-based методов) |
| `max_model_len` | `None` | отдельный лимит контекста драфтера |
| `attention_backend`, `moe_backend`, `kv_cache_dtype` | `None` | переопределения для драфтера; `None` — наследовать от целевой модели |
| `prompt_lookup_min` / `prompt_lookup_max` | `5` / `5`, если не задан ни один | окно поиска n-грамм, только для `ngram`/`ngram_gpu` |
| `suffix_decoding_max_tree_depth` | `24` | глубина дерева суффиксов |
| `suffix_decoding_max_cached_requests` | `10000` | размер глобального дерева суффиксов; `0` отключает его, оставляя только промпт-деревья |
| `suffix_decoding_max_spec_factor` | `1.0` | множитель длины спекуляции от длины совпавшего префикса |
| `suffix_decoding_min_token_prob` | `0.1` | минимальная оценка вероятности токена для спекуляции |
| `rejection_sample_method` | `"standard"` | `standard`, `synthetic` (искусственная доля принятия для замеров) или `block` |
| `draft_sample_method` | `"greedy"` | `greedy` или `probabilistic`; второй требует дополнительной VRAM под полные логиты драфтера |
| `parallel_drafting` | `false` | генерировать все спекулятивные токены параллельно; `dflash` и `dspark` включают принудительно |
| `use_heterogeneous_vocab` | `false` | разрешить драфтер с другим словарем, только с `method: "draft_model"` и `draft_sample_method: "greedy"` |
| `disable_padded_drafter_batch` | `false` | отключить паддинг спекулятивных батчей (только EAGLE) |
| `enforce_eager` | `None` | отключить CUDA graphs у драфтера отдельно от целевой модели |
| `num_speculative_tokens_per_batch_size` | `None` | динамическая спекуляция: список `(начало, конец, num_speculative_tokens)` |
| `dspark_draft_topk` | `None` | только для `dspark` |

Внутренние поля `target_model_config`, `target_parallel_config`, `draft_model_config`, `draft_parallel_config`, `draft_load_config` заполняет движок — руками их не задают. Ключ `tensor_parallel_size` отвергается явной ошибкой с подсказкой использовать `draft_tensor_parallel_size`.

Расхождение с апстрим-документацией: таблица в `vllm/docs/features/speculative_decoding/README.md` перечисляет для `rejection_sample_method` значения `strict`/`probabilistic`/`synthetic` и ключ `synthetic_acceptance_rate`. В коде этого commit'а значения — `standard`/`synthetic`/`block`, а ключи — `synthetic_acceptance_rates` (список) и `synthetic_acceptance_length` (число), причем при `synthetic` обязателен ровно один из них. Ориентируйтесь на `vllm/config/speculative.py`.

## Когда использовать

- **Одиночная интерактивная сессия на недозагруженной карте.** Здесь спекуляция и задумана: decode упирается в память, лишние FLOPs почти бесплатны, ITL падает пропорционально средней длине принятия.
- **`ngram`/`suffix` для повторяющихся ответов** (правки кода, переписывание документа, длинные цитаты промпта). Драфтер весов не грузит, VRAM не отнимает, а на повторяющемся тексте дает заметный выигрыш.
- **`mtp` для моделей с родной MTP-головой** — веса драфтера лежат в том же чекпоинте, отдельная загрузка не нужна.
- **Не включайте под конкурентной нагрузкой без замера.** При высоком QPS батч и так полон, спекулятивные токены конкурируют с реальными за один и тот же `--max-num-batched-tokens`, и итог обычно отрицательный.
- **Не включайте «на всякий случай» в arriero-инстансе, который прокси может вытеснить.** Драфтер увеличивает и резидентную память, и время старта, а значит и стоимость каждого autostart.

## Влияние на производительность и память

- **VRAM.** Модельные методы добавляют веса драфтера и его KV-cache в тот же бюджет `--gpu-memory-utilization`; все это вычитается **до** KV-cache целевой модели, поэтому емкость кэша и `Maximum concurrency` падают. `draft_sample_method: "probabilistic"` дополнительно держит полные логиты драфтера. Методы `ngram`/`suffix` дают только хостовые структуры (дерево суффиксов до `suffix_decoding_max_cached_requests` запросов).
- **Слоты планировщика.** `num_lookahead_tokens` резервирует KV-блоки на каждый активный запрос сверх фактических токенов — при большом `num_speculative_tokens` это заметная доля кэша.
- **Latency.** ITL падает только при высокой доле принятия. Ориентир — средняя длина принятия из лога (см. диагностику): значение около `1.0` означает, что спекуляция ничего не дает и лишь тратит время.
- **Throughput.** Под нагрузкой обычно падает: тот же forward обрабатывает меньше «полезных» токенов.
- **Время старта.** Модельный драфтер — это вторая загрузка весов и вторая компиляция/захват графов.

## Взаимодействие с другими аргументами

- `--spec-method`, `--spec-model`, `--spec-tokens`: сокращения для ключей `method`, `model`, `num_speculative_tokens`. Задать ключ и сокращение одновременно нельзя — `create_speculative_config` бросает `--spec-method and --speculative-config['method'] are mutually exclusive`. При этом сам факт передачи любого из сокращений создает пустой `speculative_config`, то есть включает спекуляцию.
- `--max-num-batched-tokens` и `--max-num-scheduled-tokens`: draft-слоты расходуют тот же бюджет шага; при малом бюджете старт падает на `VllmConfig does not have enough slots to schedule a token and support the speculative decoding settings.`
- `--max-num-seqs`: вместе с `1 + num_speculative_tokens` задает сетку CUDA graphs.
- `--gpu-memory-utilization`: общий бюджет, из которого вычитаются веса и KV драфтера.
- `--enforce-eager`: отключает графы у обеих моделей; ключ `enforce_eager` внутри JSON отключает их только у драфтера.
- `--max-cudagraph-capture-size`: явный потолок, если автоподбор с учетом `decode_query_len` дает неудобную сетку.
- `--data-parallel-size`: при значении больше 1 динамическая спекуляция принудительно отключается.
- `--diffusion-config`: dLLM-модели переиспользуют тот же тракт спекулятивных токенов; одновременно с `--speculative-config` его задавать не нужно.

## Типовые проблемы и диагностика

- **Симптом:** `num_speculative_tokens was provided but without speculative model.` **Причина:** задан `num_speculative_tokens` без `model` для метода, который требует весов. **Лечение:** добавить `model` или выбрать `ngram`/`suffix`.
- **Симптом:** `A speculative model was provided, but 'num_speculative_tokens' was not provided`. **Причина:** в конфиге драфтера нет `n_predict`. **Лечение:** задать `num_speculative_tokens` явно.
- **Симптом:** `Target and draft model should have the same vocabulary size.` **Лечение:** взять драфтер того же семейства либо `use_heterogeneous_vocab: true` при `method: "draft_model"`.
- **Симптом:** `'tensor_parallel_size' is not a valid argument in the speculative_config.` **Лечение:** переименовать ключ в `draft_tensor_parallel_size`.
- **Симптом:** `num_speculative_tokens:N must be divisible by n_predict=M`. **Причина:** MTP-модуль переиспользуется кратное число раз. **Лечение:** взять `num_speculative_tokens`, кратное `n_predict`.
- **Симптом:** ITL не улучшился или вырос. **Проверка:** периодическая строка `SpecDecoding metrics: Mean acceptance length: X.XX, Accepted throughput: ... , Per-position acceptance rate: ..., Avg Draft acceptance rate: NN.N%`. **Лечение:** при длине принятия около 1 уменьшить `num_speculative_tokens` или выключить спекуляцию; per-position вектор показывает, на какой позиции драфтер начинает промахиваться.
- **Подтверждение принятого значения:** строка конфигурации движка со сводкой `SpeculativeConfig(method=..., model=..., num_speculative_tokens=...)` в логе старта. Метрики Prometheus: `vllm:spec_decode_num_accepted_tokens_total`, `vllm:spec_decode_num_draft_tokens_total`, `vllm:spec_decode_num_drafts`.
- **Симптом:** предупреждение `Dynamic speculative decoding changes the target verification length at runtime. Overriding cudagraph_mode from ... to PIECEWISE for reliability.` **Причина:** задан `num_speculative_tokens_per_batch_size` при полных CUDA graphs. **Лечение:** принять понижение или включить `VLLM_USE_V2_MODEL_RUNNER=1`.
- **Симптом (arriero):** после включения спекуляции инстанс перестал проходить admission по памяти. **Причина:** веса драфтера входят в реальный расход, но не в аналитическую оценку по GGUF-подобным данным. **Лечение:** перезамерить оценку памяти инстанса и поднять declared draw — см. `docs/MEMORY_ESTIMATION.md` (документ arriero).

## Примеры

```bash
vllm serve /models/Qwen3-4B --speculative-config '{"method":"ngram","num_speculative_tokens":4,"prompt_lookup_min":2,"prompt_lookup_max":5}' --max-num-batched-tokens 4096
```

```bash
vllm serve /models/Qwen3-8B -sc.method draft_model -sc.model /models/Qwen3-0.6B -sc.num_speculative_tokens 3 --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/speculative.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
- `vllm/vllm/v1/spec_decode/metrics.py`
- `vllm/docs/features/speculative_decoding/README.md`
- `docs/MEMORY_ESTIMATION.md` (arriero)
- `docs/VLLM_OPERATIONS.md` (arriero)
