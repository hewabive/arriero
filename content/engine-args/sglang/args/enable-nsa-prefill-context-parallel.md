---
schema: 1
engine: sglang
primaryName: "--enable-nsa-prefill-context-parallel"
title: "--enable-nsa-prefill-context-parallel"
summary: Самое старое имя включателя context parallelism для DSA-моделей DeepSeek V3.2: NSA переименована в DSA, а сам флаг заменен на `--enable-prefill-cp`. Полный синоним `--enable-dsa-prefill-context-parallel` — тот же `dest`, то же поведение.
group: null
related:
  - --enable-prefill-cp
  - --cp-strategy
  - --enable-dsa-prefill-context-parallel
  - --enable-prefill-context-parallel
  - --dsa-prefill-cp-mode
  - --nsa-prefill-cp-mode
  - --attn-cp-size
  - --dsa-prefill-backend
---

# --enable-nsa-prefill-context-parallel

## Кратко

Флаг пережил два переименования подряд. Сначала подсистема разреженного внимания DeepSeek сменила имя с NSA на DSA — так появился `--enable-dsa-prefill-context-parallel` с тем же `dest`. Затем весь механизм context parallelism получил единый канонический интерфейс `--enable-prefill-cp` + `--cp-strategy`, и обе формы стали устаревшими.

Никакой собственной семантики у этого имени нет: `parser.add_argument("--enable-nsa-prefill-context-parallel", dest="enable_dsa_prefill_context_parallel", …)` — это буквально второе имя того же поля. Всё поведение описано в документе про `--enable-dsa-prefill-context-parallel`, а сам механизм — в документе про `--enable-prefill-cp`.

## Оригинальная справка

```text
[Deprecated] Use --enable-prefill-cp instead.
```

## Паспорт аргумента

- Флаги: `--enable-nsa-prefill-context-parallel`; тот же `dest` у `--enable-dsa-prefill-context-parallel`
- Группа: `null` — устаревший флаг объявлен литеральным `parser.add_argument` в `add_cli_args`; поле датакласса помечено `Arg(no_cli=True)`
- Тип значения: флаг без значения
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `False` (значение по умолчанию `DeprecatedStoreTrueAction`)
- Эффективное значение: `enable_prefill_cp = True`, а при незаданной `--cp-strategy` — `cp_strategy = legacy_mode_to_strategy[dsa_prefill_cp_mode]`, то есть `interleave` при значении по умолчанию `round-robin-split`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `enable_dsa_prefill_context_parallel`
- Статус: устаревший (`DeprecatedStoreTrueAction`), замена — `--enable-prefill-cp`
- Этап применения: разбор CLI (предупреждение) → `_handle_legacy_cp_arguments` → `_handle_context_parallelism`

## Что меняет в движке

### Предупреждение

```text
'--enable-nsa-prefill-context-parallel' is deprecated and will be removed in a future release. Use '--enable-prefill-cp' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Почему имя NSA все еще встречается в тексте ошибок

Сообщение о взаимной исключительности упоминает именно это имя, хотя оно самое старое:

```text
ValueError: --enable-prefill-context-parallel and --enable-nsa-prefill-context-parallel are mutually exclusive. Use --enable-nsa-prefill-context-parallel for DeepSeek V3.2 (NSA) models and --enable-prefill-context-parallel for MLA-based models (DeepSeek V3/R1, Kimi K2.5) or MHA/GQA-based models.
```

Это единственная причина, по которой имя вообще стоит помнить: увидев такую ошибку, не ищите в своей командной строке буквально `--enable-nsa-…` — ошибка возникнет и при `--enable-dsa-prefill-context-parallel`, потому что проверяется общее поле.

Похожая пара имен есть и у backend'ов внимания: `--nsa-prefill-backend` / `--nsa-decode-backend` устарели в пользу `--dsa-prefill-backend` / `--dsa-decode-backend`.

## Значения и формат

- Булев флаг без значения.
- Полный синоним `--enable-dsa-prefill-context-parallel`.
- Несовместим с `--enable-prefill-context-parallel`.
- Без `--cp-strategy` дает `interleave`.
- Требует `--attn-cp-size > 1`; для DeepSeek размер группы подставляется автоматически.
- В YAML через `--config` ключ задать нельзя: аргумент с нестандартным argparse-действием отвергается.

## Когда использовать

- Не использовать: это самая старая из трех форм. Каноническая запись — `--enable-prefill-cp --cp-strategy interleave`.
- Единственный сценарий встречи — очень старые скрипты запуска DeepSeek V3.2 времен, когда подсистема называлась NSA.

## Влияние на производительность и память

Собственного влияния нет: флаг является вторым именем поля и транслируется в `--enable-prefill-cp` до всех расчетов. Эффекты CP — время prefill, коллективы на слой, принудительно выключенный prefill-CUDA-graph, отсутствие экономии KV без `--enable-dsa-cache-layer-split` — описаны в документе про `--enable-prefill-cp`.

## Взаимодействие с другими аргументами

- `--enable-dsa-prefill-context-parallel`: тот же флаг под актуальным (но тоже устаревшим) именем.
- `--enable-prefill-cp` + `--cp-strategy`: каноническая замена.
- `--enable-prefill-context-parallel`: взаимно исключающая MLA-форма.
- `--dsa-prefill-cp-mode` / `--nsa-prefill-cp-mode`: устаревшие источники раскладки по умолчанию.
- `--attn-cp-size`: размер CP-группы.
- `--dsa-prefill-backend`: актуальное имя backend'а разреженного внимания, чьи старые формы (`--nsa-prefill-backend`) устарели тем же переименованием.

## Типовые проблемы и диагностика

- `'--enable-nsa-prefill-context-parallel' is deprecated …` — замените на `--enable-prefill-cp --cp-strategy interleave`.
- `ValueError: … are mutually exclusive …` — переданы обе устаревшие формы; текст ошибки называет NSA-имя даже если вы использовали DSA-имя.
- Флаг задан, поведение не изменилось — `attn_cp_size == 1`. Проверьте `attn_cp_size=` и `cp_strategy=` в дампе `server_args=`.
- Флаг не принимается вовсе (`unrecognized arguments`) — установленная версия пакета уже удалила устаревшее имя; сверьтесь с `--help` своей сборки.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy interleave
```

Та же конфигурация с явным размером CP-группы:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --tp-size 8 --dp-size 1 --enable-prefill-cp --cp-strategy interleave --attn-cp-size 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/layers/cp/base.py`
- `sglang/python/sglang/srt/layers/cp/interleave.py`
