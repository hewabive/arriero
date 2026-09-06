---
schema: 1
engine: sglang
primaryName: "--load-publish-endpoint"
title: "--load-publish-endpoint"
summary: "Явно включает PUB-сокет нагрузки для внешнего маршрутизатора. Требует активного KV publisher и дополнительных портов на каждый DP rank."
group: observability
related:
  - --kv-events-config
  - --dp-size
  - --load-snapshot-publish-interval
---

# --load-publish-endpoint

## Кратко

Явно включает PUB-сокет нагрузки для внешнего маршрутизатора. Требует активного KV publisher и дополнительных портов на каждый DP rank.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
Opt in to the runtime-load PUB socket that load-aware routers subscribe to. Off by default (unset or 'off'). Use 'auto' to reserve the dp_size ports packed after the --kv-events-config range, or a wildcard-host TCP address (e.g. tcp://*:6000) to place it explicitly; rank r binds port+r and /server_info advertises the base under the kv_events block. Requires --kv-events-config to describe a publisher (routers discover the base through /server_info); startup fails if this is set without one, is not bindable, or overlaps the KV range. Note: 'auto' reserves 2*dp_size ports from the KV base — space co-hosted engines accordingly. The router-facing update cadence follows --load-snapshot-publish-interval (shared to avoid double-collecting the snapshot), so a large value there also staleness-caps this feed.
```

## Паспорт аргумента

- Флаг: `--load-publish-endpoint`
- Группа: `observability`
- Тип: `str`
- Декларативный default: `null`
- Объявление: `ServerArgs.load_publish_endpoint` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI, инициализация и исполнение подсистемы, описанной ниже.

## Что меняет в движке

Публикует runtime-load отдельно от событий KV. Startup validation разбирает KV publisher и проверяет диапазоны; scheduler создаёт PUB-сокеты, а `/server_info` сообщает базовый адрес в блоке `kv_events`. Без активного описываемого publisher запуск с этим флагом отклоняется.

## Значения и формат

Не задан или `off` — выключено. `auto` размещает load-порты после KV-диапазона: нужно суммарно `2 * dp_size` портов от KV base. Явный адрес должен быть TCP bind с wildcard host, например `tcp://*:6000`; rank r использует port+r.

## Когда использовать

Когда внешний load-aware router подписывается на этот протокол. Одного `--kv-events-config` для load-feed недостаточно.

## Влияние на производительность и память

Добавляет сериализацию и сеть, не меняет GPU allocation. Частота общая с `--load-snapshot-publish-interval`: большое значение делает данные маршрутизатора менее свежими.

## Взаимодействие с другими аргументами

Нужен активный `--kv-events-config`; load-диапазон не должен пересекать KV/replay диапазоны. `--dp-size` определяет число портов.

## Типовые проблемы и диагностика

При отказе старта проверьте publisher, wildcard TCP bind и свободные диапазоны. Для discovery смотрите `GET /server_info`; для частоты — snapshot publish interval.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --kv-events-config '{"publisher":"zmq","endpoint":"tcp://*:5557"}' --load-publish-endpoint auto
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/validation_hook.py`
- `sglang/python/sglang/srt/disaggregation/kv_events.py`
- `sglang/python/sglang/srt/managers/scheduler_components/kv_events_publisher.py`
