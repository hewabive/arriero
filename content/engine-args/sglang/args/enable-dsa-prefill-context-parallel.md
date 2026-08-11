---
schema: 1
engine: sglang
primaryName: "--enable-dsa-prefill-context-parallel"
title: "--enable-dsa-prefill-context-parallel"
summary: Устаревший включатель context parallelism на prefill для DSA-моделей DeepSeek V3.2. Заменен на `--enable-prefill-cp`; без явной `--cp-strategy` подставляет раскладку из `--dsa-prefill-cp-mode`, то есть `interleave`.
group: null
related:
  - --enable-prefill-cp
  - --cp-strategy
  - --dsa-prefill-cp-mode
  - --nsa-prefill-cp-mode
  - --enable-nsa-prefill-context-parallel
  - --enable-prefill-context-parallel
  - --attn-cp-size
  - --enable-dsa-cache-layer-split
  - --cuda-graph-backend-prefill
---

# --enable-dsa-prefill-context-parallel

## Кратко

Историческая форма включения context parallelism для моделей с DeepSeek Sparse Attention (DSA, она же NSA в старой терминологии). Канонический флаг сегодня — `--enable-prefill-cp`, раскладка задается через `--cp-strategy`. Механизм целиком описан в документе про `--enable-prefill-cp`.

Отличие устаревшей формы от MLA-варианта (`--enable-prefill-context-parallel`) — в стратегии по умолчанию: здесь она берется из `--dsa-prefill-cp-mode` со значением по умолчанию `round-robin-split`, что транслируется в `interleave`. У MLA-варианта по умолчанию получается `zigzag`. То есть выбор устаревшего флага молча определяет раскладку.

## Оригинальная справка

```text
[Deprecated] Use --enable-prefill-cp instead.
```

## Паспорт аргумента

- Флаги: `--enable-dsa-prefill-context-parallel`; ровно тот же `dest` имеет более старый `--enable-nsa-prefill-context-parallel`, то есть это два имени одного поля
- Группа: `null` — устаревший флаг объявлен литеральным `parser.add_argument` в `add_cli_args`; одноименное поле датакласса помечено `Arg(no_cli=True)`
- Тип значения: флаг без значения
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `False` (значение по умолчанию `DeprecatedStoreTrueAction`)
- Эффективное значение: `_handle_legacy_cp_arguments` превращает `True` в `enable_prefill_cp = True` и, если `cp_strategy` не задана, в `cp_strategy = legacy_mode_to_strategy[dsa_prefill_cp_mode]` — по умолчанию `interleave`. Обратно поле выставляется тем же обработчиком при канонической конфигурации, если резолвленный attention backend — `dsa` или `dsv4`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `enable_dsa_prefill_context_parallel`
- Статус: устаревший (`DeprecatedStoreTrueAction`), замена — `--enable-prefill-cp`
- Этап применения: разбор CLI (предупреждение) → `__post_init__` → `_handle_legacy_cp_arguments` → `_handle_cuda_graph_config` (правило каскада) → `_handle_context_parallelism`

## Что меняет в движке

### Предупреждение и трансляция

```text
'--enable-dsa-prefill-context-parallel' is deprecated and will be removed in a future release. Use '--enable-prefill-cp' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Взаимная исключительность с MLA-формой

`_handle_context_parallelism` отвергает одновременную передачу обеих устаревших форм:

```text
ValueError: --enable-prefill-context-parallel and --enable-nsa-prefill-context-parallel are mutually exclusive. Use --enable-nsa-prefill-context-parallel for DeepSeek V3.2 (NSA) models and --enable-prefill-context-parallel for MLA-based models (DeepSeek V3/R1, Kimi K2.5) or MHA/GQA-based models.
```

### Поле живет и после миграции

Это не только входная точка: `enable_dsa_prefill_context_parallel` читается дальше по коду. В частности, это одно из правил каскада авто-отключения prefill-CUDA-graph для backend'а `tc_piecewise` («DSA prefill context parallelism»). Поэтому обработчик проставляет поле и при канонической конфигурации — когда attention backend резолвится в `dsa`/`dsv4`.

## Значения и формат

- Булев флаг без значения.
- Полный синоним `--enable-nsa-prefill-context-parallel` (тот же `dest`); передавать оба бессмысленно, но и безвредно.
- Несовместим с `--enable-prefill-context-parallel`.
- Без `--cp-strategy` дает `interleave`. Стратегию по умолчанию можно поменять устаревшим `--dsa-prefill-cp-mode in-seq-split`, что даст `zigzag`, но правильнее указать каноническую `--cp-strategy`.
- Требует `--attn-cp-size > 1`; для семейства DeepSeek размер группы подставляется автоматически как `tp_size // dp_size`.
- Для стратегии `interleave` модельные override'ы требуют `--dp-size 1`: `AssertionError: interleave DSA CP does not support DP attention.`
- В YAML через `--config` ключ задать нельзя: аргумент с нестандартным argparse-действием отвергается.

## Когда использовать

- Не использовать. В новых конфигурациях: `--enable-prefill-cp --cp-strategy interleave` (для сохранения прежнего поведения) либо `zigzag`, если раскладка выбирается осознанно.
- При переносе старых команд запуска DeepSeek V3.2 обязательно проставьте `--cp-strategy` явно: иначе после отказа от устаревшего флага раскладка станет обязательной к указанию (`--cp-strategy must be set when --enable-prefill-cp is enabled`), а забытая явная стратегия ранее подставлялась молча.
- Механизм CP помечен в коде как экспериментальный и проверенный только на Hopper.

## Влияние на производительность и память

Собственного влияния нет: флаг транслируется в `--enable-prefill-cp` до всех расчетов. Все эффекты описаны в документе про `--enable-prefill-cp`. Один эффект специфичен для DSA и стоит упомянуть здесь: экономию GPU-памяти от CP дает только `--enable-dsa-cache-layer-split`, который требует стратегию `interleave` и prefill-роль в PD-disaggregation.

## Взаимодействие с другими аргументами

- `--enable-prefill-cp`: канонический флаг, в который транслируется этот.
- `--cp-strategy`: канонический выбор раскладки; при явном значении устаревшие `*-cp-mode` не читаются.
- `--dsa-prefill-cp-mode` / `--nsa-prefill-cp-mode`: источник стратегии по умолчанию (`round-robin-split` → `interleave`).
- `--enable-nsa-prefill-context-parallel`: тот же самый флаг под старым именем.
- `--enable-prefill-context-parallel`: взаимно исключающая MLA-форма.
- `--attn-cp-size`: размер CP-группы; при 1 механизм не включается.
- `--enable-dsa-cache-layer-split`: единственный способ получить от CP экономию VRAM под KV.
- `--cuda-graph-backend-prefill`: при поднятом поле срабатывает правило каскада, отключающее prefill-граф для `tc_piecewise`.

## Типовые проблемы и диагностика

- `'--enable-dsa-prefill-context-parallel' is deprecated …` — замените на `--enable-prefill-cp --cp-strategy interleave`.
- `ValueError: --enable-prefill-context-parallel and --enable-nsa-prefill-context-parallel are mutually exclusive. …` — переданы обе устаревшие формы.
- `AssertionError: interleave DSA CP does not support DP attention.` — при стратегии `interleave` требуется `--dp-size 1`.
- `AssertionError: Context parallel only supports single machine (tp_size <= 8). Cross-machine CP has precision issues.` — CP на многоузловой конфигурации DeepSeek.
- Флаг задан, поведение не изменилось — `attn_cp_size == 1`; проверьте `attn_cp_size=` в дампе `server_args=`.
- Что смотреть в логе: предупреждение о deprecated в начале вывода, `Enabled DSA context parallel: strategy=…, dp_size=…, attn_cp_size=…`, `enable_prefill_cp=` и `cp_strategy=` в дампе `server_args=`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy interleave
```

С явным размером CP-группы и разделением слоев DSA-кеша:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy interleave --attn-cp-size 8 --enable-dsa-cache-layer-split --disaggregation-mode prefill
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/layers/cp/interleave.py`
