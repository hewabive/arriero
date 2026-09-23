---
schema: 1
engine: vllm
primaryName: "--enable-scale-out"
title: "--enable-scale-out"
summary: Регистрирует scale-out HTTP endpoints в обычном vllm serve.
group: Frontend
related: []
---

# --enable-scale-out

## Кратко

Регистрирует scale-out HTTP endpoints в обычном vllm serve.

## Оригинальная справка

```text
If set to True, register the scale-out endpoints (`/render`, `/derender`,
and `/inference/v1/generate`) on `vllm serve`. Has no effect on
`vllm launch render` or `vllm serve --tokens-only`, which always register
their required endpoints regardless of this flag.
```

## Паспорт аргумента

- Флаги: `--enable-scale-out`, `--no-enable-scale-out`
- Группа argparse: `Frontend`
- Тип значения: `bool`
- Значение по умолчанию в декларации: `False`
- Где объявлен: `vllm/entrypoints/launchers/cli_args.py:BaseFrontendArgs.enable_scale_out`

## Что меняет в движке

Добавляются /render, /derender и /inference/v1/generate; в vllm launch render и tokens-only нужные endpoints регистрируются независимо от флага.

## Значения и формат

Парная форма `--no-enable-scale-out` выключает значение; отсутствие флага оставляет значение по умолчанию.

## Когда использовать

Включайте, если внешний клиент использует эти маршруты на обычном serve.

## Влияние на производительность и память

Само включение маршрутов не меняет размер модели или KV-cache; нагрузка на них потребляет обычные ресурсы сервера.

## Взаимодействие с другими аргументами

Применяется вместе с настройками того же компонента; проверяйте итоговый конфиг при запуске.

## Типовые проблемы и диагностика

При HTTP 404 проверьте режим запуска и наличие маршрутов; контролируйте доступ к дополнительным endpoints.

## Примеры

```bash
vllm serve /models/model --enable-scale-out
```

## Источники

- `vllm/vllm/entrypoints/launchers/cli_args.py`
