---
schema: 1
engine: sglang
primaryName: "--prefill-cp-mode"
title: "--prefill-cp-mode"
summary: Устаревшая раскладка токенов context parallelism для MLA/MHA-пути. Заменена на `--cp-strategy`; допустимое значение осталось ровно одно — `in-seq-split`, которое и есть значение по умолчанию и транслируется в `zigzag`.
group: null
related:
  - --cp-strategy
  - --enable-prefill-cp
  - --enable-prefill-context-parallel
  - --dsa-prefill-cp-mode
  - --nsa-prefill-cp-mode
  - --attn-cp-size
---

# --prefill-cp-mode

## Кратко

Аргумент задает раскладку токенов последовательности по рангам CP-группы для MLA/MHA-пути. Он устарел вдвойне: во-первых, канонический выбор раскладки теперь `--cp-strategy` со значениями `zigzag` и `interleave`; во-вторых, у самого аргумента остался единственный допустимый вариант — `in-seq-split`, совпадающий со значением по умолчанию.

Практическое следствие: передача `--prefill-cp-mode in-seq-split` не меняет ничего, кроме появления предупреждения в логе. Ничего другого argparse не примет.

## Оригинальная справка

```text
[Deprecated] Use --cp-strategy {zigzag,interleave} instead. 'in-seq-split' maps to 'zigzag'.
```

## Паспорт аргумента

- Флаги: `--prefill-cp-mode`
- Группа: `null` — устаревший аргумент объявлен литеральным `parser.add_argument` в `add_cli_args`; поле датакласса помечено `Arg(no_cli=True)`
- Тип значения: str
- Допустимые значения: `in-seq-split` — единственный элемент списка `PREFILL_CP_SPLIT_CHOICES`. Для сравнения, у DSA-варианта (`--dsa-prefill-cp-mode`) список из двух значений
- Значение по умолчанию: `ServerArgs.prefill_cp_mode`, то есть `"in-seq-split"`
- Эффективное значение: используется только как источник `cp_strategy`, когда включен `--enable-prefill-context-parallel` и каноническая `--cp-strategy` не задана: `in-seq-split` → `zigzag`. В обратную сторону `_handle_legacy_cp_arguments` переустанавливает поле из канонической стратегии (`zigzag` → `in-seq-split`, `interleave` → `round-robin-split`) для внутренних потребителей
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `prefill_cp_mode`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--cp-strategy`
- Этап применения: разбор CLI (предупреждение) → `_handle_legacy_cp_arguments`

## Что меняет в движке

### Предупреждение и трансляция

```text
'--prefill-cp-mode' is deprecated and will be removed in a future release. Use '--cp-strategy' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

Трансляция в `_handle_legacy_cp_arguments`:

```python
legacy_mode_to_strategy = {"in-seq-split": "zigzag", "round-robin-split": "interleave"}
if self.enable_prefill_context_parallel and self.cp_strategy is None:
    self.cp_strategy = legacy_mode_to_strategy[self.prefill_cp_mode]
```

То есть значение читается **только** при включенном устаревшем `--enable-prefill-context-parallel`. С каноническим `--enable-prefill-cp` оно игнорируется на входе и, наоборот, переписывается на выходе.

### Что означают раскладки

`zigzag` (бывший `in-seq-split`) режет последовательность на непрерывные куски и раздает их рангам «змейкой», чтобы уравнять квадратичную нагрузку внимания: у ранга оказывается один кусок из начала и один из конца. `interleave` (бывший `round-robin-split`) раздает токены по кругу. Обе стратегии применяются только к extend-шагам и только когда последовательность достаточно длинная: у `zigzag` требуется не меньше `2 * cp_size` токенов в каждой последовательности, у `interleave` — не меньше `cp_size` суммарно.

## Значения и формат

- Одно строковое значение, и оно же единственное: `in-seq-split`. Любое другое отвергается argparse'ом: `error: argument --prefill-cp-mode: invalid choice: 'round-robin-split' (choose from 'in-seq-split')`.
- Значение по умолчанию совпадает с единственным допустимым, поэтому передача аргумента бессмысленна.
- Чтобы получить `interleave` на устаревшем интерфейсе, нужен DSA-путь (`--enable-dsa-prefill-context-parallel` с `--dsa-prefill-cp-mode round-robin-split`), а не этот аргумент.
- В YAML через `--config` ключ задать нельзя: аргумент с нестандартным argparse-действием отвергается.

## Когда использовать

- Не использовать: пишите `--cp-strategy zigzag` вместе с `--enable-prefill-cp`.
- Единственная причина встретить аргумент — старые скрипты запуска, где он писался явно ради читаемости.

## Влияние на производительность и память

Собственного влияния нет: значение либо совпадает со значением по умолчанию, либо не читается вовсе. Влияние самих раскладок — распределение квадратичной работы внимания по рангам и разные требования к минимальной длине последовательности — относится к `--cp-strategy`.

## Взаимодействие с другими аргументами

- `--cp-strategy`: каноническая замена; при явном значении этот аргумент не читается.
- `--enable-prefill-context-parallel`: единственный флаг, при котором значение вообще используется.
- `--enable-prefill-cp`: канонический включатель; с ним значение игнорируется на входе и переписывается на выходе.
- `--dsa-prefill-cp-mode` / `--nsa-prefill-cp-mode`: DSA-аналоги с двумя допустимыми значениями и значением по умолчанию `round-robin-split`.
- `--attn-cp-size`: размер CP-группы; раскладка имеет смысл только при значении больше 1.

## Типовые проблемы и диагностика

- `'--prefill-cp-mode' is deprecated …` — уберите аргумент и задайте `--cp-strategy zigzag`.
- `error: argument --prefill-cp-mode: invalid choice: 'round-robin-split' (choose from 'in-seq-split')` — попытка получить interleave через MLA-путь; это делается только через DSA-форму или каноническую `--cp-strategy interleave`.
- Аргумент задан, а `cp_strategy` в дампе `server_args=` не `zigzag` — значит рядом стоит явная `--cp-strategy`, и она победила.
- Что смотреть в логе: предупреждение о deprecated в начале вывода, `cp_strategy=`, `prefill_cp_mode=` и `attn_cp_size=` в дампе `server_args=`.

## Примеры

Актуальная форма вместо этого аргумента:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag
```

С явным размером CP-группы:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-R1 --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy zigzag --attn-cp-size 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/layers/cp/zigzag.py`
- `sglang/python/sglang/srt/layers/cp/interleave.py`
