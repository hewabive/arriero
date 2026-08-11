---
schema: 1
engine: sglang
primaryName: "--nsa-prefill-cp-mode"
title: "--nsa-prefill-cp-mode"
summary: Самое старое имя раскладки context parallelism для DSA-пути — второй флаг того же поля, что и `--dsa-prefill-cp-mode`. Заменен на `--cp-strategy`; собственного значения по умолчанию не имеет (`argparse.SUPPRESS`), чтобы не перебивать значение соседа.
group: null
related:
  - --cp-strategy
  - --dsa-prefill-cp-mode
  - --enable-prefill-cp
  - --enable-nsa-prefill-context-parallel
  - --enable-dsa-prefill-context-parallel
  - --prefill-cp-mode
  - --attn-cp-size
---

# --nsa-prefill-cp-mode

## Кратко

Имя из эпохи, когда разреженное внимание DeepSeek называлось NSA. Это второй флаг того же поля `dsa_prefill_cp_mode` — вся семантика описана в документе про `--dsa-prefill-cp-mode`, а канонический интерфейс сегодня — `--cp-strategy` вместе с `--enable-prefill-cp`.

Единственное техническое отличие от `--dsa-prefill-cp-mode`: у этого флага значение по умолчанию объявлено как `argparse.SUPPRESS`. Это не «нет значения по умолчанию», а «не класть ничего в namespace, если флаг не передан» — так значение по умолчанию `round-robin-split`, объявленное у соседнего флага, не перезаписывается.

## Оригинальная справка

```text
[Deprecated] Use --cp-strategy instead.
```

## Паспорт аргумента

- Флаги: `--nsa-prefill-cp-mode`; тот же `dest` у `--dsa-prefill-cp-mode`
- Группа: `null` — устаревший аргумент объявлен литеральным `parser.add_argument` в `add_cli_args`; поле датакласса помечено `Arg(no_cli=True)`
- Тип значения: str
- Допустимые значения: `in-seq-split`, `round-robin-split` (тот же список `DSA_PREFILL_CP_SPLIT_CHOICES`)
- Значение по умолчанию: в extract это выражение `argparse.SUPPRESS` — при отсутствии флага argparse ничего не пишет в namespace, и действует значение по умолчанию соседнего `--dsa-prefill-cp-mode`, то есть `"round-robin-split"`
- Эффективное значение: `in-seq-split` → `zigzag`, `round-robin-split` → `interleave`; читается только при включенном устаревшем DSA-флаге CP и незаданной канонической `--cp-strategy`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `dsa_prefill_cp_mode`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--cp-strategy`
- Этап применения: разбор CLI (предупреждение) → `_handle_legacy_cp_arguments`

## Что меняет в движке

### Предупреждение

```text
'--nsa-prefill-cp-mode' is deprecated and will be removed in a future release. Use '--cp-strategy' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Зачем нужен SUPPRESS

Оба флага (`--dsa-prefill-cp-mode` и этот) пишут в один `dest`. Argparse проставляет значения по умолчанию по одному разу на `dest`: побеждает то, что объявлено у зарегистрированного первым флага. Здесь первым идет `--dsa-prefill-cp-mode` со значением по умолчанию `round-robin-split`, а у второго значение по умолчанию подавлено, чтобы конструкция не зависела от порядка регистрации. Такой же прием применен к `--nsa-prefill-backend` / `--nsa-decode-backend`, которые тоже разделяют `dest` с актуальными `--dsa-*`-флагами.

Практический вывод: `--nsa-prefill-cp-mode` не влияет ни на что, пока не передан явно, и полностью эквивалентен `--dsa-prefill-cp-mode`, когда передан.

## Значения и формат

- Одно из двух: `in-seq-split` или `round-robin-split`.
- Не передавать — значит действует `round-robin-split` от соседнего флага, то есть раскладка `interleave`.
- Полный синоним `--dsa-prefill-cp-mode`. При передаче обоих побеждает разобранный последним — то есть здесь порядок в командной строке значим; передавать оба не нужно.
- Значение читается, только если включен устаревший DSA-флаг CP.
- В YAML через `--config` ключ задать нельзя: аргумент с нестандартным argparse-действием отвергается.

## Когда использовать

- Не использовать: пишите `--cp-strategy` вместе с `--enable-prefill-cp`.
- Единственный сценарий встречи — очень старые команды запуска DeepSeek V3.2 времен, когда подсистема называлась NSA.

## Влияние на производительность и память

Собственного влияния нет: аргумент выбирает раскладку и является вторым именем того же поля. Различия между `zigzag` и `interleave` — распределение квадратичной работы внимания, требования к минимальной длине последовательности, обязательный `--dp-size 1` у `interleave` и доступность `--enable-dsa-cache-layer-split` — описаны в документе про `--dsa-prefill-cp-mode`.

## Взаимодействие с другими аргументами

- `--dsa-prefill-cp-mode`: тот же аргумент под актуальным (но тоже устаревшим) именем и источник фактического значения по умолчанию.
- `--cp-strategy`: каноническая замена.
- `--enable-nsa-prefill-context-parallel` / `--enable-dsa-prefill-context-parallel`: единственные флаги, при которых значение читается.
- `--enable-prefill-cp`: канонический включатель; с ним значение игнорируется на входе.
- `--prefill-cp-mode`: MLA-аналог с единственным значением `in-seq-split`.
- `--attn-cp-size`: размер CP-группы; при 1 раскладка не применяется.

## Типовые проблемы и диагностика

- `'--nsa-prefill-cp-mode' is deprecated …` — замените связку на `--enable-prefill-cp --cp-strategy <zigzag|interleave>`.
- Значение задано, а раскладка другая — рядом стоит либо `--dsa-prefill-cp-mode` позже в строке, либо каноническая `--cp-strategy`, которая приоритетнее обоих.
- Флаг не принимается вовсе (`unrecognized arguments`) — установленная версия уже удалила устаревшее имя; сверьтесь с `--help` своей сборки.
- Что смотреть в логе: предупреждение о deprecated в начале вывода, `cp_strategy=` и `dsa_prefill_cp_mode=` в дампе `server_args=`.

## Примеры

Актуальная форма вместо этого аргумента:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy interleave
```

Вариант с zigzag и явным размером группы:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag --attn-cp-size 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/layers/cp/interleave.py`
