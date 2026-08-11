---
schema: 1
engine: sglang
primaryName: "--argument-name"
title: "--argument-name"
summary: Одно-два практичных предложения о том, что аргумент делает и когда его трогают.
group: null
related:
  - --related-argument
---

# --argument-name

## Кратко

Что аргумент меняет и в какой момент о нем вспоминает человек, эксплуатирующий сервер. Два-четыре предложения, без вступления про важность SGLang.

## Оригинальная справка

```text
Дословный help из extract, без перевода и без правок. У скрытых аргументов help пуст — так и фиксируй.
```

## Паспорт аргумента

- Флаги: `--argument-name` (все элементы `flags` из extract: алиасы, `--no-*` половина пары)
- Группа: `schedule` (поле `group`; если `null` — так и пиши)
- Тип значения: int / float / str / bool / путь / список / JSON
- Допустимые значения: перечень из `choices`; если `choices: null` — «не ограничены» либо «список собирается в runtime из реестра ...»
- Значение по умолчанию: из `default`; для `kind: expression` — раскрытое значение
- Эффективное значение: что и на каком шаге переопределяет дефолт (`ServerArgs.__post_init__`, конкретный `_handle_*`), если это так
- Где объявлен: `ServerArgs.field_name` (поле `origin` из extract, дословно), файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный / скрытый (`argparse.SUPPRESS`) / устаревший (`Deprecated*Action`, чем заменен)
- Этап применения: разбор CLI / `__post_init__` / запуск процессов (tokenizer, scheduler, detokenizer, TP/DP-воркеры) / выделение KV-пула / захват CUDA graph / forward / HTTP-слой

## Что меняет в движке

Какая подсистема затрагивается и в какой момент. Куда попадает значение (поле `ServerArgs`), кто читает его дальше (scheduler, memory pool, model runner, attention backend, endpoint), что происходит, если аргумент не задан. Обязательно — авто-подбор в `__post_init__`, если он есть: по объему GPU-памяти, архитектуре модели, совместимости backend'ов.

## Значения и формат

Форма записи, единицы, границы, поведение специальных значений (`0`, `-1`, `auto`, `null`, пустая строка). Что отвергает argparse и что отвергает проверка уже после разбора. Для аргументов со списками — разделитель и порядок; для путей — что именно проверяется и когда.

## Когда использовать

- Сценарий, в котором авто-подбор не подходит, и признак, по которому это видно.
- Сценарий, в котором аргумент трогать не надо, хотя соблазн есть.

## Влияние на производительность и память

VRAM (веса, KV-пул, CUDA graphs, буферы спекуляции), RAM хоста и CPU-потоки, время старта (захват графов, прогрев, загрузка весов), throughput и latency под конкурентной нагрузкой. Если влияния нет — одна конкретная фраза об этом.

## Взаимодействие с другими аргументами

- `--related-argument`: как связаны, какие комбинации осмысленны и какие взаимно исключены.
- Аргументы, которые делят ту же память или ту же очередь планировщика.

## Типовые проблемы и диагностика

- Симптом (ошибка на старте, OOM при захвате CUDA graph, деградация throughput, предупреждение о deprecated-флаге).
- Причина.
- Чем подтвердить: строка в логе движка (в том числе итоговый дамп `server_args=` при старте), метрика, вывод `--help` установленной версии.
- Как исправить, с конкретными значениями.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/model --argument-name value
```

```bash
python -m sglang.launch_server --model-path /models/model --argument-name value --related-argument other-value
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- для `kt_*`: `sglang/python/sglang/srt/layers/moe/kt_ep_wrapper.py`, `ktransformers/kt-kernel/README.md`, `ktransformers/doc/en/AMX.md`
- проверенные upstream PR/issue
