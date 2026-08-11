---
schema: 1
engine: sglang
primaryName: "--elastic-ep-rejoin"
title: "--elastic-ep-rejoin"
summary: Устаревший булев псевдоним для `--elastic-ep-join-mode recover`. Печатает предупреждение и подставляет режим; при явном конфликтующем `--elastic-ep-join-mode` падает ассертом.
group: exec.moe
related:
  - --elastic-ep-join-mode
  - --elastic-ep-backend
  - --elastic-ep-join-rank-offset
---

# --elastic-ep-rejoin

## Кратко

Флаг остался от версии elastic EP, в которой присоединение бывало только одного вида — возврат упавшего ранга на прежнее место. Когда появился второй сценарий (расширение группы), булев флаг заменили на перечисление `--elastic-ep-join-mode`, а этот оставили как совместимость. Новых конфигураций на нем строить не надо: он умеет ровно одно, и то через подстановку.

## Оригинальная справка

```text
[Deprecated] Alias for --elastic-ep-join-mode recover.
```

## Паспорт аргумента

- Флаги: `--elastic-ep-rejoin`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`); парного `--no-*` нет
- Допустимые значения: наличие или отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: при `true` и незаданном `--elastic-ep-join-mode` подставляет `recover` с предупреждением в логе; при заданном режиме требует, чтобы он уже был `recover`
- Где объявлен: `ServerArgs.elastic_ep_rejoin`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: устаревший. Обратите внимание: устаревание выражено только текстом справки и логикой `_handle_elastic_ep`, а не `action` из семейства `Deprecated*` — в извлеченной декларации `action` остается `null`
- Этап применения: `__post_init__` (`_handle_elastic_ep`), в самом начале обработки elastic EP

## Что меняет в движке

Единственный потребитель — начало `_handle_elastic_ep` в `sglang/python/sglang/srt/server_args.py`:

- если `--elastic-ep-join-mode` не задан, поле `ep_join_mode` становится `recover`, и в лог уходит `--elastic-ep-rejoin is deprecated, use --elastic-ep-join-mode recover instead.`;
- если режим задан, проверяется совпадение: `AssertionError: --elastic-ep-rejoin (deprecated) conflicts with --elastic-ep-join-mode <mode>.`

Дальше сам флаг больше нигде не читается — все поведение определяется уже подставленным `ep_join_mode`, включая требование заданного `--elastic-ep-backend`. Что именно делает режим `recover`, описано в документе `--elastic-ep-join-mode`.

## Значения и формат

- Флаг без значения. Отсутствие — обычное поведение, флаг ни на что не влияет.
- Наличие эквивалентно `--elastic-ep-join-mode recover` и ничему другому: выразить через него расширение группы (`scale`) нельзя.

## Когда использовать

- Только в существующих скриптах запуска, которые еще не переписаны. При правке скрипта заменяйте на `--elastic-ep-join-mode recover`.
- Не используйте в новых конфигурациях: устаревшие аргументы в SGLang удаляются без длинного переходного периода, а поведение флага уже сейчас полностью выражается через актуальное перечисление.

## Влияние на производительность и память

На производительность и память флаг не влияет: он только подставляет значение другого аргумента во время разбора конфигурации.

## Взаимодействие с другими аргументами

- `--elastic-ep-join-mode`: целевой аргумент; при одновременном указании значения должны совпадать.
- `--elastic-ep-backend`: обязателен, потому что подставленный режим требует заданного бэкенда.
- `--elastic-ep-join-rank-offset`: с `recover` его задавать нельзя — он допустим только при `scale`.

## Типовые проблемы и диагностика

- Предупреждение `--elastic-ep-rejoin is deprecated, use --elastic-ep-join-mode recover instead.` — сигнал заменить флаг в скрипте запуска.
- `AssertionError: --elastic-ep-rejoin (deprecated) conflicts with --elastic-ep-join-mode scale.` — в командной строке остались оба флага; уберите устаревший.
- `AssertionError: --elastic-ep-join-mode requires --elastic-ep-backend to be set.` при использовании только этого флага — подстановка сработала, но бэкенд elastic EP не задан.
- Итоговое значение `ep_join_mode` после подстановки видно в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`).

## Примеры

Устаревшая форма, которую вы можете встретить в старых скриптах:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --pp-size 1 --moe-a2a-backend deepep --deepep-mode normal --elastic-ep-backend mooncake --dist-init-addr 10.0.0.1:20000 --nnodes 2 --node-rank 1 --elastic-ep-rejoin
```

Актуальная замена той же строки:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --pp-size 1 --moe-a2a-backend deepep --deepep-mode normal --elastic-ep-backend mooncake --dist-init-addr 10.0.0.1:20000 --nnodes 2 --node-rank 1 --elastic-ep-join-mode recover
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/elastic_ep/elastic_ep.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
