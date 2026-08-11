---
schema: 1
engine: vllm
primaryName: "--uvicorn-log-level"
title: "--uvicorn-log-level"
summary: Уровень логирования HTTP-сервера uvicorn. Не влияет на логи самого движка, но при уровне выше info скрывает строку готовности, по которой определяется прогресс запуска.
group: Frontend
related:
  - --disable-uvicorn-access-log
  - --disable-access-log-for-endpoints
  - --log-config-file
---

# --uvicorn-log-level

## Кратко

Значение уходит в `uvicorn.Config(log_level=...)` и относится только к логгерам uvicorn (`uvicorn`, `uvicorn.error`, `uvicorn.access`). Логи vLLM управляются отдельно, переменной окружения `VLLM_LOGGING_LEVEL`.

Практическая ловушка: строки `Started server process [pid]` и `Application startup complete.` печатает именно uvicorn на уровне INFO. Подняв уровень до `warning`, вы теряете основной признак «сервер поднялся» — в том числе тот, по которому arriero строит прогресс запуска инстанса.

## Оригинальная справка

```text
Log level for uvicorn.
```

## Паспорт аргумента

- Флаги: `--uvicorn-log-level`
- Группа argparse: `Frontend`
- Тип значения: строка из фиксированного перечня (`Literal`)
- Допустимые значения: `critical`, `error`, `warning`, `info`, `debug`, `trace`
- Значение по умолчанию: `info`
- Эффективное значение: не переопределяется, но перекрывается конфигурацией из `--log-config-file`, которая задает уровни логгеров сама; при `--disable-access-log-for-endpoints` то же значение подставляется в сгенерированную конфигурацию (`create_uvicorn_log_config(..., log_level=args.uvicorn_log_level)`)
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.uvicorn_log_level`
- Этап применения: HTTP-слой, `serve_http()` → `uvicorn.Config`

## Что меняет в движке

Уровень трех логгеров uvicorn. На объем логов vLLM (загрузка весов, профилирование памяти, статистика планировщика) не влияет вообще — их уровень задается `VLLM_LOGGING_LEVEL`.

Что теряется при повышении уровня выше `info`:

- `Started server process [<pid>]`, `Waiting for application startup.`, `Application startup complete.` — сигналы готовности HTTP-слоя;
- строки access-лога (они пишутся на INFO);
- сообщения о завершении работы.

Что появляется на `debug`/`trace`: подробности жизненного цикла соединений. Уровень `trace` — собственный уровень uvicorn ниже DEBUG, полезен только при отладке транспорта.

## Значения и формат

- Одно из шести значений, регистр важен (все в нижнем).
- `info` — рабочее значение по умолчанию.
- `warning` и выше — «тихий» режим ценой потери признака готовности.
- `debug`, `trace` — только для отладки; на нагруженном сервере объем логов растет заметно.

## Когда использовать

- `warning` — если лог инстанса нужен исключительно для ошибок, а факт запуска отслеживается по HTTP-проверке.
- `debug` — при разборе проблем с соединениями, keep-alive, обрывами SSE.
- **Не поднимайте выше `info` на управляемых инстансах arriero.** Прогресс запуска в панели инстанса строится из строк лога: признак готовности — `Application startup complete.` или `Started server process [...]`. Без них прогресс остается в состоянии «стартует», хотя статус здоровья, который считается по HTTP-опросу `/health`, придет в норму.
- Для борьбы с шумом от опроса вместо повышения уровня используйте `--disable-access-log-for-endpoints`.

## Влияние на производительность и память

Заметно только на `debug`/`trace`, где растет объем записи в лог-файл. На VRAM и генерацию не влияет.

## Взаимодействие с другими аргументами

- `--disable-uvicorn-access-log`: отключает access-лог независимо от уровня.
- `--disable-access-log-for-endpoints`: сгенерированная конфигурация фильтра наследует это значение как уровень всех логгеров uvicorn.
- `--log-config-file`: имеет приоритет — если файл загружен, уровни берутся из него.

## Типовые проблемы и диагностика

- **Симптом:** в логе нет `Application startup complete.`, хотя сервер отвечает. **Причина:** уровень выше `info`. **Лечение:** вернуть `info`.
- **Симптом (arriero):** индикатор запуска инстанса не доходит до готовности. **Причина:** та же — строка готовности не печатается. **Лечение:** `--uvicorn-log-level info`.
- **Симптом:** уровень задан, но объем логов не изменился. **Причина:** основной объем дают логи vLLM, а не uvicorn. **Лечение:** `VLLM_LOGGING_LEVEL`.
- **Симптом:** значение игнорируется. **Причина:** загружена конфигурация из `--log-config-file` или `VLLM_LOGGING_CONFIG_PATH`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --uvicorn-log-level info
```

```bash
vllm serve /models/Qwen3-4B --host 127.0.0.1 --uvicorn-log-level debug --disable-access-log-for-endpoints "/health"
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/entrypoints/serve/utils/server_utils.py`
- `vllm/vllm/logging_utils/access_log_filter.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
