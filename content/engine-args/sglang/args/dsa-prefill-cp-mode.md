---
schema: 1
engine: sglang
primaryName: "--dsa-prefill-cp-mode"
title: "--dsa-prefill-cp-mode"
summary: Устаревшая раскладка токенов context parallelism для DSA-пути. Заменена на `--cp-strategy`: `in-seq-split` соответствует `zigzag`, `round-robin-split` — `interleave`. Значение по умолчанию `round-robin-split` объясняет, почему устаревший DSA-флаг молча дает interleave.
group: null
related:
  - --cp-strategy
  - --enable-prefill-cp
  - --enable-dsa-prefill-context-parallel
  - --enable-nsa-prefill-context-parallel
  - --nsa-prefill-cp-mode
  - --prefill-cp-mode
  - --attn-cp-size
  - --dp-size
  - --enable-dsa-cache-layer-split
---

# --dsa-prefill-cp-mode

## Кратко

Раскладка токенов последовательности по рангам CP-группы для моделей с DeepSeek Sparse Attention. Аргумент устарел: канонический выбор — `--cp-strategy` со значениями `zigzag` и `interleave`.

Практический смысл этого документа — объяснить одно значение по умолчанию. `dsa_prefill_cp_mode` по умолчанию равен `round-robin-split`, а он транслируется в `interleave`. Именно поэтому `--enable-dsa-prefill-context-parallel` без явной стратегии дает `interleave`, тогда как MLA-форма `--enable-prefill-context-parallel` дает `zigzag`. При переносе на канонический интерфейс эту разницу надо воспроизвести руками, иначе поведение изменится.

## Оригинальная справка

```text
[Deprecated] Use --cp-strategy {zigzag,interleave} instead. 'in-seq-split' maps to 'zigzag'; 'round-robin-split' maps to 'interleave'.
```

## Паспорт аргумента

- Флаги: `--dsa-prefill-cp-mode`; ровно тот же `dest` имеет более старый `--nsa-prefill-cp-mode`
- Группа: `null` — устаревший аргумент объявлен литеральным `parser.add_argument` в `add_cli_args`; поле датакласса помечено `Arg(no_cli=True)`
- Тип значения: str
- Допустимые значения: `in-seq-split`, `round-robin-split` (список `DSA_PREFILL_CP_SPLIT_CHOICES`)
- Значение по умолчанию: `ServerArgs.dsa_prefill_cp_mode`, то есть `"round-robin-split"`
- Эффективное значение: используется как источник `cp_strategy`, только когда включен `--enable-dsa-prefill-context-parallel` (или его синоним `--enable-nsa-prefill-context-parallel`) и каноническая `--cp-strategy` не задана. В обратную сторону `_handle_legacy_cp_arguments` переустанавливает поле из канонической стратегии для внутренних потребителей
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `dsa_prefill_cp_mode`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--cp-strategy`
- Этап применения: разбор CLI (предупреждение) → `_handle_legacy_cp_arguments`

## Что меняет в движке

### Предупреждение и трансляция

```text
'--dsa-prefill-cp-mode' is deprecated and will be removed in a future release. Use '--cp-strategy' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

Таблица трансляции в `_handle_legacy_cp_arguments` симметрична:

```python
legacy_mode_to_strategy = {"in-seq-split": "zigzag", "round-robin-split": "interleave"}
strategy_to_legacy_mode = {"zigzag": "in-seq-split", "interleave": "round-robin-split"}
```

Прямое направление читается при устаревшем включателе, обратное — при каноническом, чтобы внутренние потребители, все еще смотрящие на legacy-поля, видели согласованное состояние.

### Чем раскладки отличаются на практике

`zigzag` режет последовательность на непрерывные куски и раздает их «змейкой», уравнивая квадратичную нагрузку внимания между рангами. `interleave` раздает токены по кругу. Для DSA-моделей у `interleave` есть особенности, зафиксированные в модельных override'ах:

- требуется `--dp-size 1`: `AssertionError: interleave DSA CP does not support DP attention.`;
- только с `interleave` работает `--enable-dsa-cache-layer-split` — единственный режим, где CP действительно экономит GPU-память под KV, а не только ускоряет prefill;
- для DSA-моделей со стратегией `zigzag` override'ы дополнительно требуют `moe_a2a_backend = deepep` и `ep_size = tp_size`.

Обе стратегии применяются только к extend-шагам: `zigzag` требует не меньше `2 * cp_size` токенов в каждой последовательности, `interleave` — не меньше `cp_size` суммарно.

## Значения и формат

- Одно из двух: `in-seq-split` или `round-robin-split`. Иное отвергается argparse'ом.
- Значение по умолчанию `round-robin-split` (то есть `interleave`) — редкий случай, когда значение по умолчанию у устаревшего аргумента влияет на итоговую конфигурацию.
- Полный синоним `--nsa-prefill-cp-mode` (тот же `dest`), но у синонима значение по умолчанию подавлено (`argparse.SUPPRESS`), чтобы не перебивать значение, пришедшее из этого аргумента.
- Значение читается, только если включен устаревший DSA-флаг CP. При каноническом `--enable-prefill-cp` оно игнорируется на входе.
- В YAML через `--config` ключ задать нельзя: аргумент с нестандартным argparse-действием отвергается.

## Когда использовать

- Не использовать: пишите `--cp-strategy interleave` (или `zigzag`) вместе с `--enable-prefill-cp`.
- Единственный полезный сценарий — сверка при миграции: если старая команда была `--enable-nsa-prefill-context-parallel` без указания режима, эквивалент — `--enable-prefill-cp --cp-strategy interleave`, а не `zigzag`.

## Влияние на производительность и память

Собственного влияния нет — аргумент только выбирает стратегию. Влияние самих стратегий:

- `zigzag`: равномернее распределяет квадратичную работу внимания, требует более длинных последовательностей для включения.
- `interleave`: включается на более коротких последовательностях, но требует `--dp-size 1`; только он открывает `--enable-dsa-cache-layer-split`, дающий реальную экономию VRAM под KV.

Ни одна из стратегий сама по себе KV-пул не уменьшает: K/V собираются со всех CP-рангов и записываются в локальный пул каждого ранга.

## Взаимодействие с другими аргументами

- `--cp-strategy`: каноническая замена; при явном значении этот аргумент не читается.
- `--enable-dsa-prefill-context-parallel` / `--enable-nsa-prefill-context-parallel`: единственные флаги, при которых значение используется.
- `--enable-prefill-cp`: канонический включатель.
- `--nsa-prefill-cp-mode`: тот же аргумент под старым именем.
- `--prefill-cp-mode`: MLA-аналог с единственным значением `in-seq-split`.
- `--dp-size`: при `interleave` обязан быть 1.
- `--enable-dsa-cache-layer-split`: требует `interleave`.
- `--attn-cp-size`: размер CP-группы; при 1 раскладка не применяется.

## Типовые проблемы и диагностика

- `'--dsa-prefill-cp-mode' is deprecated …` — замените связку на `--enable-prefill-cp --cp-strategy <zigzag|interleave>`.
- `AssertionError: interleave DSA CP does not support DP attention.` — стратегия `interleave` при `--dp-size > 1`.
- После миграции на канонический интерфейс изменилось поведение — почти наверняка забыли, что значение по умолчанию было `round-robin-split`, и получили `zigzag` вместо `interleave`.
- Аргумент задан, а `cp_strategy` в дампе другой — рядом стоит явная `--cp-strategy`, она приоритетнее.
- Что смотреть в логе: предупреждение о deprecated в начале вывода, `Enabled DSA context parallel: strategy=…, dp_size=…, attn_cp_size=…`, поля `cp_strategy=`, `dsa_prefill_cp_mode=` в дампе `server_args=`.

## Примеры

Актуальная форма, сохраняющая прежнее поведение по умолчанию:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy interleave
```

Явный выбор zigzag:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag --attn-cp-size 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/layers/cp/zigzag.py`
- `sglang/python/sglang/srt/layers/cp/interleave.py`
