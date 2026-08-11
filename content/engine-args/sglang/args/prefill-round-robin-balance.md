---
schema: 1
engine: sglang
primaryName: "--prefill-round-robin-balance"
title: "--prefill-round-robin-balance"
summary: Устаревший флаг-заглушка из времен, когда decode-сервер PD-disaggregation не умел сам определять dp-ранг запроса. Сейчас ничего не делает, кроме предупреждения в логе.
group: null
related:
  - --disaggregation-mode
  - --load-balance-method
  - --dp-size
  - --enable-dp-attention
---

# --prefill-round-robin-balance

## Кратко

В PD-disaggregation decode-сервер обязан положить запрос в тот же dp-ранг, куда его положил prefill-сервер. Пока планирование dp-рангов не было доведено до конца, это гарантировали внешним контрактом: prefill-сторона обязана была балансировать запросы по кругу, а decode-сторона — знать об этом. Флаг был декларацией такого контракта на стороне decode, и при `dp_size > 1` его отсутствие приводило к отказу на старте.

После доработки планирования dp-рангов контракт стал не нужен, и флаг превратился в заглушку: соответствующее поле удалено из `ServerArgs`, проверка убрана, осталось только предупреждение.

## Оригинальная справка

```text
Note: --prefill-round-robin-balance is deprecated now.
```

## Паспорт аргумента

- Флаги: `--prefill-round-robin-balance`
- Группа: `null` — объявлен литеральным `parser.add_argument` в `add_cli_args`; поля `prefill_round_robin_balance` в `ServerArgs` больше не существует
- Тип значения: флаг без значения (`nargs=0`)
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `None` — argparse кладет `None` в namespace, но `from_cli_args` собирает только атрибуты, которым соответствуют поля датакласса, поэтому значение отбрасывается
- Эффективное значение: отсутствует. Флаг не влияет ни на одно поле конфигурации
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: устаревший (`DeprecatedAction` — вариант, который **не** сохраняет значение); прямой замены нет
- Этап применения: только разбор CLI

## Что меняет в движке

Ничего. `DeprecatedAction.__call__` печатает единственное сообщение:

```text
The command line argument '--prefill-round-robin-balance' is deprecated and will be removed in future versions.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса. Поля `new_flag` у этого класса действия нет, поэтому подсказки про замену в предупреждении не будет.

Историческая проверка, которую флаг обслуживал, выглядела так (сейчас удалена из `__post_init__`): при `--disaggregation-mode decode` и `dp_size > 1` требовалось, чтобы флаг был задан, а prefill-сервер был запущен с `--load-balance-method auto` или `follow_bootstrap_room`. Сегодня согласование dp-рангов между сторонами обеспечивает сам механизм disaggregation, и от оператора никакого дополнительного объявления не требуется.

## Значения и формат

- Булев флаг без значения. Принимается argparse'ом, но не имеет эффекта.
- Убрать его из команды запуска можно без каких-либо изменений в поведении.
- В YAML через `--config` ключ задать нельзя: `ConfigArgumentMerger` отвергает аргументы с нестандартным argparse-действием.

## Когда использовать

- Не использовать. Просто удалите флаг из старых команд запуска PD-конфигураций.
- Если нужно управлять распределением запросов по dp-рангам, это делает `--load-balance-method` (значения `auto`, `round_robin`, `follow_bootstrap_room`, `total_requests`, `total_tokens`).

## Влияние на производительность и память

Никакого: флаг не читается после разбора командной строки.

## Взаимодействие с другими аргументами

- `--disaggregation-mode`: контекст, в котором флаг когда-то имел смысл (роль `decode`).
- `--load-balance-method`: актуальная ручка выбора стратегии распределения по dp-рангам.
- `--dp-size`: условие, при котором старая проверка срабатывала (`dp_size > 1`).
- `--enable-dp-attention`: часть той же конфигурации data parallelism.

## Типовые проблемы и диагностика

- `The command line argument '--prefill-round-robin-balance' is deprecated and will be removed in future versions.` — удалите флаг.
- Флаг не принимается (`unrecognized arguments`) — установленная версия уже удалила заглушку; сверьтесь с `--help` своей сборки.
- Ожидали от флага изменения распределения запросов — его нет; смотрите `--load-balance-method` и `load_balance_method=` в дампе `server_args=`.

## Примеры

Актуальная форма для PD-decode-сервера — просто без этого флага:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode decode --dp-size 2 --enable-dp-attention
```

Явный выбор стратегии распределения на prefill-стороне:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode prefill --dp-size 2 --load-balance-method round_robin
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
