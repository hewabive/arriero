---
schema: 1
engine: sglang
primaryName: "--enable-prefill-context-parallel"
title: "--enable-prefill-context-parallel"
summary: Устаревший включатель context parallelism на prefill для MLA/MHA-моделей. Заменен на `--enable-prefill-cp`; при использовании подставляет стратегию из `--prefill-cp-mode`, то есть всегда `zigzag`.
group: null
related:
  - --enable-prefill-cp
  - --cp-strategy
  - --prefill-cp-mode
  - --enable-dsa-prefill-context-parallel
  - --enable-nsa-prefill-context-parallel
  - --attn-cp-size
  - --tp-size
  - --dp-size
  - --enable-dp-attention
---

# --enable-prefill-context-parallel

## Кратко

Исторический выключатель context parallelism для MLA- и MHA/GQA-моделей (DeepSeek V3/R1, Kimi K2.5 и родственники). Сегодня канонический флаг один — `--enable-prefill-cp`, а раскладка задается через `--cp-strategy`. Механизм целиком описан в документе про `--enable-prefill-cp`; здесь только то, чем отличается устаревшая форма.

Отличие ровно одно и оно существенное: при использовании этого флага без явного `--cp-strategy` стратегия берется из `--prefill-cp-mode`, единственное допустимое значение которого — `in-seq-split`, что транслируется в `zigzag`. Парный устаревший флаг для DSA-моделей (`--enable-dsa-prefill-context-parallel` / `--enable-nsa-prefill-context-parallel`) по умолчанию дает `interleave`. То есть выбор устаревшего флага молча определяет раскладку.

## Оригинальная справка

```text
[Deprecated] Use --enable-prefill-cp instead.
```

## Паспорт аргумента

- Флаги: `--enable-prefill-context-parallel`
- Группа: `null` — устаревший флаг объявлен литеральным `parser.add_argument` в `add_cli_args`; одноименное поле датакласса помечено `Arg(no_cli=True)` и собственного CLI не имеет
- Тип значения: флаг без значения
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `False` (значение по умолчанию `DeprecatedStoreTrueAction`)
- Эффективное значение: `_handle_legacy_cp_arguments` превращает `True` в `enable_prefill_cp = True` и, если `cp_strategy` не задана, в `cp_strategy = "zigzag"`. Обратно поле переустанавливается тем же обработчиком: при канонически заданном `--enable-prefill-cp` оно становится `True`, если attention backend **не** из пары `dsa`/`dsv4`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `enable_prefill_context_parallel`
- Статус: устаревший (`DeprecatedStoreTrueAction`), замена — `--enable-prefill-cp`
- Этап применения: разбор CLI (предупреждение) → `__post_init__` → `_handle_legacy_cp_arguments` (дважды: до конфигурации CUDA graph и после разбора data parallelism) → `_handle_context_parallelism`

## Что меняет в движке

### Предупреждение и трансляция

```text
'--enable-prefill-context-parallel' is deprecated and will be removed in a future release. Use '--enable-prefill-cp' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

Трансляция выполняется в `_handle_legacy_cp_arguments`:

```python
if self.enable_prefill_context_parallel or self.enable_dsa_prefill_context_parallel:
    self.enable_prefill_cp = True
if self.enable_prefill_context_parallel and self.cp_strategy is None:
    self.cp_strategy = legacy_mode_to_strategy[self.prefill_cp_mode]   # in-seq-split -> zigzag
```

### Взаимная исключительность с DSA-формой

`_handle_context_parallelism` отвергает одновременную передачу обеих устаревших форм:

```text
ValueError: --enable-prefill-context-parallel and --enable-nsa-prefill-context-parallel are mutually exclusive. Use --enable-nsa-prefill-context-parallel for DeepSeek V3.2 (NSA) models and --enable-prefill-context-parallel for MLA-based models (DeepSeek V3/R1, Kimi K2.5) or MHA/GQA-based models.
```

Текст ошибки заодно объясняет исходное разделение: этот флаг — для MLA/MHA, другой — для DSA-моделей DeepSeek V3.2.

### Поле остается живым и после миграции

Важно понимать, что `enable_prefill_context_parallel` — не просто входная точка. Обработчик работает и в обратную сторону: при канонической конфигурации (`--enable-prefill-cp --cp-strategy …`) он сам проставляет одно из двух legacy-полей в зависимости от резолвленного attention backend'а. Внутренние потребители читают именно их — например, правило каскада авто-отключения prefill-графа «DSA prefill context parallelism» проверяет `enable_dsa_prefill_context_parallel`.

## Значения и формат

- Булев флаг без значения.
- Несовместим с `--enable-nsa-prefill-context-parallel` / `--enable-dsa-prefill-context-parallel` (см. ошибку выше).
- Без `--cp-strategy` дает `zigzag`. С явной `--cp-strategy` устаревший флаг влияет только на выбор legacy-полей, а раскладку определяет канонический аргумент.
- Как и канонический флаг, требует `--attn-cp-size > 1`, иначе объект стратегии не создается и механизм фактически выключен. Для семейства DeepSeek размер группы подставляется автоматически как `tp_size // dp_size`.
- В YAML через `--config` ключ `enable-prefill-context-parallel` задать нельзя: аргумент с нестандартным argparse-действием отвергается.

## Когда использовать

- Не использовать. В новых конфигурациях: `--enable-prefill-cp --cp-strategy zigzag`.
- Единственная причина встретить этот флаг — старые скрипты запуска DeepSeek V3/R1. При переносе замените его на пару канонических аргументов и явно укажите `zigzag`, чтобы поведение не изменилось.
- Сам механизм CP по-прежнему помечен в коде как экспериментальный и проверенный только на Hopper — это относится и к канонической форме.

## Влияние на производительность и память

Собственного влияния у флага нет: он транслируется в `--enable-prefill-cp` до того, как что-либо считается. Все эффекты — время prefill, коллективы на каждый слой, принудительно выключенный prefill-CUDA-graph, отсутствие экономии KV — описаны в документе про `--enable-prefill-cp`.

## Взаимодействие с другими аргументами

- `--enable-prefill-cp`: канонический флаг, в который транслируется этот.
- `--cp-strategy`: канонический выбор раскладки (`zigzag` / `interleave`); при явном значении устаревший `--prefill-cp-mode` не читается.
- `--prefill-cp-mode`: источник стратегии по умолчанию для этого флага; единственное допустимое значение `in-seq-split` дает `zigzag`.
- `--enable-dsa-prefill-context-parallel` / `--enable-nsa-prefill-context-parallel`: взаимно исключающая пара для DSA-моделей; по умолчанию дают `interleave`.
- `--attn-cp-size`: размер CP-группы; при 1 механизм не включается.
- `--tp-size`, `--dp-size`, `--enable-dp-attention`: для DeepSeek переписываются автоматически модельными override'ами.

## Типовые проблемы и диагностика

- `'--enable-prefill-context-parallel' is deprecated …` — замените на `--enable-prefill-cp --cp-strategy zigzag`.
- `ValueError: --enable-prefill-context-parallel and --enable-nsa-prefill-context-parallel are mutually exclusive. …` — переданы обе устаревшие формы.
- `ValueError: --cp-strategy must be set when --enable-prefill-cp is enabled.` — возникает при канонической форме без стратегии; из этого флага стратегия подставляется, поэтому здесь ошибка означает, что вы уже смешали формы.
- Флаг задан, поведение не изменилось — почти всегда `attn_cp_size == 1`. Проверьте `attn_cp_size=` и `cp_strategy=` в дампе `server_args=`.
- Что смотреть в логе: предупреждение о deprecated в начале вывода, `enable_prefill_cp=`, `cp_strategy=`, `attn_cp_size=` в дампе `server_args=`, префикс ` ATTN_CP<rank>` в строках лога при `attn_cp_size > 1`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag
```

С явным размером CP-группы:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-R1 --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag --attn-cp-size 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/layers/cp/utils.py`
