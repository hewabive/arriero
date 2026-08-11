---
schema: 1
engine: sglang
primaryName: "--speculative-dflash-draft-window-size"
title: "--speculative-dflash-draft-window-size"
summary: Скрытый устаревший алиас `--speculative-draft-window-size`: в `--help` не показывается, справки не имеет, значение кладет в то же поле. Оставлен только ради совместимости со старыми командами запуска DFLASH.
group: null
related:
  - --speculative-draft-window-size
  - --speculative-algorithm
  - --speculative-dflash-block-size
  - --speculative-num-draft-tokens
  - --page-size
---

# --speculative-dflash-draft-window-size

## Кратко

Скользящее окно контекста для draft-модели изначально появилось в алгоритме DFLASH и называлось соответственно. Затем оказалось, что то же поле нужно и Llama-EAGLE3-драфтеру, и аргумент переименовали в `--speculative-draft-window-size`. Старое имя оставили как **скрытый** алиас: `help=argparse.SUPPRESS`, поэтому в `--help` его нет и в extract у него пустая справка.

Собственной семантики у него нет. Всё поведение поля — какие алгоритмы его читают, как оно взаимодействует с `--page-size` и `--speculative-num-draft-tokens`, что происходит при нулевом значении — описано в документе про `--speculative-draft-window-size`.

## Оригинальная справка

Справки нет: аргумент объявлен с `help=argparse.SUPPRESS`, поэтому в extract поле `help` пустое, а `hidden` равно `true`. Это не пропуск в документации, а состояние объявления в исходниках.

## Паспорт аргумента

- Флаги: `--speculative-dflash-draft-window-size`; тот же `dest` у актуального `--speculative-draft-window-size`
- Группа: `null` — скрытый алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне группы `spec`, где живет актуальный флаг
- Тип значения: int — число токенов
- Допустимые значения: строго положительное целое; argparse границ не проверяет, проверка приходит в `handle_speculative_decoding`
- Значение по умолчанию: у алиаса значения по умолчанию нет; `dest` (`speculative_draft_window_size`) инициализируется значением `None` от актуального флага, а `None` означает полное внимание/полный контекст
- Эффективное значение: совпадает с заданным; для DFLASH дополнительно требуется не меньше `--speculative-num-draft-tokens`, а при `--page-size > 1` начало окна выравнивается вниз по границе страницы
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `speculative_draft_window_size`
- Статус: скрытый (`argparse.SUPPRESS` в `help`) и устаревший (`DeprecatedAliasStoreAction`), замена — `--speculative-draft-window-size`
- Этап применения: разбор CLI (предупреждение) → `__post_init__` (`handle_speculative_decoding`) → конструирование draft-модели или draft-воркера → forward

## Что меняет в движке

### Предупреждение и трансляция

```text
'--speculative-dflash-draft-window-size' is deprecated and will be removed in a future release. Use '--speculative-draft-window-size' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса. Это единственный способ узнать, что вы используете скрытый аргумент: в `--help` его нет.

### Скрытость и контракт

Скрытый аргумент — это аргумент, который апстрим не считает частью публичного интерфейса. Он может исчезнуть в любом релизе без записи в changelog и без периода устаревания, потому что формально его никто не объявлял. Не закладывайтесь на него в скриптах запуска и в конфигурации инстансов.

Проверить наличие в своей сборке через `--help` нельзя — там его не будет, даже если он есть. Прямой способ — попытка запуска с заведомо пустой моделью (сервер не поднимется, но разбор аргументов произойдет первым):

```bash
python -m sglang.launch_server --model-path none --speculative-dflash-draft-window-size 512 2>&1 | head -5
```

Если аргумент удален, argparse ответит `unrecognized arguments`; если он на месте, первой строкой будет предупреждение об устаревании.

## Значения и формат

- Одно положительное целое, число токенов.
- Не задавать — значит полное внимание/полный контекст у драфтера.
- Полный синоним `--speculative-draft-window-size`. При передаче обоих побеждает разобранный последним; передавать оба не нужно.
- Читается только двумя драфтерами — Llama-EAGLE3 (`LlamaForCausalLMEagle3`) и DFLASH; остальные, включая MLA-драфтеры EAGLE3, его игнорируют, о чем печатается предупреждение.
- В YAML через `--config` ключ `speculative-draft-window-size` задать нельзя — он отвергается из-за этого скрытого алиаса на общем `dest`.

## Когда использовать

- Не использовать: пишите `--speculative-draft-window-size`.
- Сам параметр (под новым именем) сокращает и KV draft-модели, и время ее внимания; целевая модель не затрагивается.

## Влияние на производительность и память

Собственного влияния нет — это второе имя того же поля. Эффекты окна (меньше KV у draft'а, короче внимание драфтера, возможная потеря точности предсказания на длинном контексте) описаны в документе про `--speculative-draft-window-size`.

## Взаимодействие с другими аргументами

- `--speculative-draft-window-size`: актуальное имя того же поля; вся содержательная документация там.
- `--speculative-algorithm`: определяет, будет ли значение вообще прочитано (`EAGLE3` с Llama-драфтером либо `DFLASH`).
- `--speculative-num-draft-tokens`: для DFLASH окно обязано быть не меньше этого значения.
- `--speculative-dflash-block-size`: соседняя настройка DFLASH, сверяется с окном.
- `--page-size`: при значении больше 1 окно выравнивается по границе страницы, поэтому фактически удерживается до `page_size − 1` лишних токенов слева.

## Типовые проблемы и диагностика

- `'--speculative-dflash-draft-window-size' is deprecated and will be removed in a future release. Use '--speculative-draft-window-size' instead.` — замените имя.
- `unrecognized arguments: --speculative-dflash-draft-window-size` — скрытый алиас уже удален из установленной версии. Это ожидаемый исход для скрытого аргумента; переходите на актуальное имя.
- `--speculative-draft-window-size has no effect with speculative_algorithm=<x> (honored by Llama EAGLE-3 and DFLASH only)` — предупреждение из общей проверки; аргумент прочитан, но алгоритм его не использует.
- Аргумента нет в `--help`, хотя он работает, — так и задумано (`argparse.SUPPRESS`).
- Что смотреть: `speculative_draft_window_size=` в дампе `server_args=`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-70B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/eagle3-llama --speculative-draft-window-size 512
```

Для DFLASH с согласованным числом черновых токенов:

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-70B-Instruct --speculative-algorithm DFLASH --speculative-num-draft-tokens 4 --speculative-draft-window-size 1024
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/`
- arriero: `docs/CASE_PHANTOM_HELP_ARGS.md`
