---
schema: 1
engine: sglang
primaryName: "--cuda-graph-config"
title: "--cuda-graph-config"
summary: Единый JSON-конфиг захвата CUDA graph по фазам decode и prefill; перекрывает все точечные флаги `--cuda-graph-*` и legacy-флаги. Единственный способ задать ключи `full_prefill_max_req` и `full_prefill_prefix_chunk_tokens`, у которых нет отдельного CLI-флага.
group: exec.graph
related:
  - --cuda-graph-backend-decode
  - --cuda-graph-backend-prefill
  - --cuda-graph-max-bs-decode
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-bs-decode
  - --cuda-graph-bs-prefill
  - --cuda-graph-tc-compiler
  - --disable-decode-cuda-graph
  - --disable-prefill-cuda-graph
  - --disable-cuda-graph
  - --mem-fraction-static
  - --chunked-prefill-size
  - --max-running-requests
---

# --cuda-graph-config

## Кратко

Вся конфигурация захвата графов в SGLang живет в одном объекте `CudaGraphConfig` с двумя секциями — `decode` и `prefill`. Точечные флаги (`--cuda-graph-backend-decode`, `--cuda-graph-max-bs-prefill`, …) — это удобные обертки, которые складываются в тот же объект. `--cuda-graph-config` дает прямой доступ к нему и выигрывает у всех оберток. Трогают его в трех случаях: нужен ключ без отдельного флага (`full_prefill_max_req`, `full_prefill_prefix_chunk_tokens`), нужно задать всю конфигурацию одной строкой (например в arriero — одним аргументом инстанса), или нужно **зафиксировать** значение так, чтобы автологика движка его не переписала.

## Оригинальная справка

```text
Per-phase CUDA graph settings as JSON, e.g. '{"decode":{"backend":"full","max_bs":256},"prefill":{"backend":"tc_piecewise","tc_compiler":"eager"}}'. Allowed backends per phase: full, breakable, tc_piecewise, disabled (full is decode-only). JSON wins over the per-phase --cuda-graph-* convenience flags and over legacy flags.
```

Текст справки в части «full is decode-only» отстал от кода: `ALLOWED_BACKENDS_PER_PHASE[prefill]` в `sglang/python/sglang/srt/model_executor/cuda_graph_config.py` включает `full`, а `_handle_cuda_graph_config` при `prefill.backend == full` печатает предупреждение «cuda_graph_config[prefill].backend='full' is experimental. Use breakable or tc_piecewise for production workloads.» То есть `full` для prefill принимается, но объявлен экспериментальным.

## Паспорт аргумента

- Флаги: `--cuda-graph-config`
- Группа: `exec.graph`
- Тип значения: строка с JSON-объектом (одно значение, не список); разбирается `parse_cuda_graph_config_arg` как `argparse` type
- Допустимые значения: JSON-объект с ключами верхнего уровня `decode` и/или `prefill`; внутри каждого — только разрешенные ключи (см. ниже)
- Значение по умолчанию: `null` — берется `default_cuda_graph_config()`: `decode.backend = full`, `prefill.backend = breakable` на CUDA и `tc_piecewise` на прочих платформах, `max_bs = null`, `bs = null`, `tc_compiler = "eager"`
- Эффективное значение: поле всегда переписывается в `_parse_cuda_graph_config`; после разбора там лежит уже собранный объект `CudaGraphConfig`, а не исходная строка. Дальше значения досчитываются в `_handle_gpu_memory_settings` (`max_bs`/`bs`) и могут быть переписаны совместимостными правилами
- Где объявлен: `ServerArgs.cuda_graph_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config` → `_handle_gpu_memory_settings`) → создание runner'ов и захват графов в `model_executor/model_runner_components/cuda_graph_setup.py`

## Что меняет в движке

### Схема объекта

`decode` принимает ключи `backend`, `max_bs`, `bs`, `tc_compiler`.
`prefill` принимает `backend`, `max_bs`, `bs`, `tc_compiler`, `full_prefill_max_req`, `full_prefill_prefix_chunk_tokens`.

- `backend` — один из `full`, `breakable`, `tc_piecewise`, `disabled`.
- `max_bs` — целое. Для decode это максимальный размер батча (число запросов), для prefill — максимальное **число токенов** в захваченной форме, несмотря на имя.
- `bs` — список целых: явный перечень захватываемых форм. Для decode — размеры батча, для prefill — количества токенов.
- `tc_compiler` — `eager` или `inductor`, читает только backend `tc_piecewise`, и сегодня только в фазе prefill.
- `full_prefill_max_req` — только для prefill с `backend: "full"`: число слотов запросов, зашитых в каждый захваченный граф. `null` (по умолчанию) → `max(chunked_prefill_size // 512, 1)`, дополнительно ограничивается размером `req_to_token_pool`. Батч с числом запросов больше этого значения уходит в eager.
- `full_prefill_prefix_chunk_tokens` — только для prefill с `backend: "full"`: размер одного фиксированного чанка кешированного префикса. `null` → бюджет `chunked_prefill_size`. FullCG захватывает варианты на 1/2/4/8/16 чанков и выбирает наименьший подходящий.

Неизвестная фаза и неизвестный ключ отвергаются на разборе CLI сообщениями `--cuda-graph-config: unknown phase '<x>', expected one of ('decode', 'prefill')` и `--cuda-graph-config['decode']: unknown key '<x>', expected one of (…)`.

### Порядок приоритетов

`_parse_cuda_graph_config` собирает финальный объект слоями, каждый следующий перекрывает предыдущий:

1. Дефолты `default_cuda_graph_config()`.
2. Legacy `--disable-cuda-graph` → `disabled` в обеих фазах.
3. `--disable-prefill-cuda-graph`, `--disable-decode-cuda-graph`.
4. Точечные флаги: `--cuda-graph-backend-*`, `--cuda-graph-max-bs-*`, `--cuda-graph-bs-*`, `--cuda-graph-tc-compiler`.
5. **JSON из `--cuda-graph-config` — последним.**

### Побочный эффект: «замок» на ключе

Любой ключ, попавший в конфиг не из дефолтов, регистрируется в `self._cuda_graph_config_locked` как пара `(фаза, ключ)`. Замок отключает автологику именно для этого ключа:

- `(prefill, "backend")` — целиком пропускается каскад `_apply_cuda_graph_compatibility` (два десятка правил авто-отключения prefill-графа) и правило `_disable_prefill_cuda_graph_for_deepseek_trtllm_mla`;
- `(decode, "backend")` / `(prefill, "backend")` — пропускается назначение ролей PD-disaggregation (`_apply_cuda_graph_disaggregation_roles`) и XPU-дефолт `_handle_xpu_backends`;
- `(prefill, "max_bs")` / `(prefill, "bs")` — пропускается пересчет под DP attention (деление `chunked_prefill_size` на `dp_size`) и подъем буфера для EmbeddingGemma.

Это генерализация старого контракта `--enforce-piecewise-cuda-graph`: задали backend явно — движок вам доверяет и больше не спасает от несовместимой комбинации. Ставить замок через JSON или через точечный флаг — одно и то же.

## Значения и формат

- Значение передается одной строкой; в shell берите ее в одинарные кавычки, чтобы не потерять двойные: `--cuda-graph-config '{"decode":{"max_bs":32}}'`.
- Невалидный JSON: `--cuda-graph-config must be JSON: <ошибка json>`. Не объект верхнего уровня: `--cuda-graph-config must be a JSON object, got list`.
- Секцию можно задать частично: ключи, которых нет в JSON, берутся из дефолтов и автоподбора.
- `null` внутри JSON для `max_bs`/`bs` эквивалентен «подберет движок», но при этом ключ считается заданным и получает замок. Если вам нужен именно автоподбор — не пишите ключ вовсе.
- Порядок элементов в `bs` не важен: списки сортируются и дедуплицируются перед захватом.

## Когда использовать

- Нужен `full_prefill_max_req` или `full_prefill_prefix_chunk_tokens` — другого пути нет, отдельных CLI-флагов у них не существует.
- Нужно заставить движок оставить prefill-граф включенным в конфигурации, которую каскад совместимости отключает (LoRA под `tc_piecewise`, мультимодальность, DeepSeek-V3 на `trtllm_mla`). Тогда явный `{"prefill":{"backend":"breakable"}}` снимает авто-отключение — вместе с ответственностью за результат.
- В arriero удобно хранить весь профиль графов одним аргументом инстанса: меньше строк в `config/instances/<name>.json` и виднее диф в config-git.
- Не используйте JSON там, где хватает одного точечного флага: `--cuda-graph-max-bs-decode 32` читается лучше, чем эквивалентный JSON, и одинаково фиксирует ключ.
- Не дублируйте один и тот же ключ и во флаге, и в JSON: молча победит JSON, а в логе останется только итоговое значение.

## Влияние на производительность и память

Само по себе значение ничего не стоит — платят настройки, которые вы им задаете:

- `backend: "disabled"` в decode убирает из VRAM все захваченные графы (эвристический резерв `decode.max_bs * 2` МиБ в `reserve_for_graph_mb()` обнуляется) и убирает секунды/минуты захвата со старта, но добавляет python-overhead на каждый шаг декода.
- `max_bs`/`bs` линейно определяют число захватов: время старта и потребление VRAM растут с длиной списка.
- `full_prefill_max_req` больше нужного увеличивает объем одного графа; меньше нужного — отправляет крупные батчи в eager.

Все три величины участвуют в автоподборе `--mem-fraction-static`, поэтому изменение конфига при **незаданном** `--mem-fraction-static` автоматически меняет размер KV-пула, а при заданном — нет, и тогда рост графов идет в OOM.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-decode` / `--cuda-graph-backend-prefill` / `--cuda-graph-max-bs-decode` / `--cuda-graph-max-bs-prefill` / `--cuda-graph-bs-decode` / `--cuda-graph-bs-prefill` / `--cuda-graph-tc-compiler`: те же поля, ниже по приоритету.
- `--disable-decode-cuda-graph` / `--disable-prefill-cuda-graph` / legacy `--disable-cuda-graph`: то же, что `backend: "disabled"` в соответствующей фазе.
- `--mem-fraction-static`: `reserve_for_graph_mb()` читает `decode.max_bs`, `decode.backend`, `prefill.backend` и длину `prefill.bs`.
- `--chunked-prefill-size`: дефолт `prefill.max_bs` для не-MLA моделей и делитель для `full_prefill_max_req`.
- `--max-running-requests`: через размер `req_to_token_pool` обрезает список decode-форм сверху.
- `--disaggregation-mode`: роль `prefill` гасит decode-граф, роль `decode` гасит prefill-граф — но только для незафиксированных ключей.
- `--enable-torch-compile`: отдельный механизм, не backend графа; он лишь отключает `tc_piecewise` в prefill.

## Типовые проблемы и диагностика

- **Симптом:** `argparse` ругается `--cuda-graph-config must be JSON`. **Причина:** shell съел кавычки. **Решение:** обернуть значение в одинарные кавычки целиком.
- **Симптом:** `--cuda-graph-config['prefill']: unknown key 'max_tokens'`. **Причина:** для prefill число токенов задается ключом `max_bs`/`bs`, отдельного `max_tokens` нет.
- **Симптом:** `ValueError: --cuda-graph-config[prefill].backend='xxx' not allowed; allowed: ('full', 'breakable', 'tc_piecewise', 'disabled')` из `_validate_cuda_graph_config`.
- **Симптом:** задали `{"prefill":{"backend":"breakable"}}`, сервер стартует, но замедлился prefill. **Причина:** явный backend снял авто-отключение, которое раньше спасало модель от неподдерживаемого пути. **Проверка:** в логе нет ни одного `Breakable CUDA graph is incompatible with …` — каскад был пропущен.
- **Что смотреть всегда:** итоговый дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) содержит развернутый `cuda_graph_config=CudaGraphConfig(decode=PhaseConfig(...), prefill=PhaseConfig(...))` — это единственный надежный способ увидеть, что реально получилось после всех слоев и автоподбора. Дальше идут строки `Capture target prefill CUDA graph begin. backend=…, num_tokens=[…]` и `Capture target decode CUDA graph begin. backend=…, bs=[…]`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-config '{"decode":{"max_bs":32},"prefill":{"backend":"disabled"}}'
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-config '{"prefill":{"backend":"full","full_prefill_max_req":8,"max_bs":4096}}' --chunked-prefill-size 4096
```

## Источники

- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/utils.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
