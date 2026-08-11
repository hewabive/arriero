---
schema: 1
engine: sglang
primaryName: "--trace-modules"
title: "--trace-modules"
summary: Белый список подсистем, которым разрешено порождать OTLP-спаны при --enable-trace. Значение по умолчанию `request` намеренно отключает спаны передачи KV в mooncake; имена не валидируются, опечатка просто выключает трассировку.
group: observability
related:
  - --enable-trace
  - --otlp-traces-endpoint
  - --disaggregation-mode
  - --disaggregation-transfer-backend
---

# --trace-modules

## Кратко

Строка разбирается в `process_tracing_init` (`sglang/python/sglang/srt/observability/trace.py`) в глобальный список:

```python
global_trace_modules = [module.strip() for module in trace_modules.split(",") if module.strip()]
```

Дальше каждый создаваемый контекст трассировки сверяет свое имя модуля с этим списком и, если имени в списке нет, выключает себя (`tracing_enable = False`, контекст заменяется на `TraceNullContext`). Проверка есть в обоих вариантах контекста — синхронном (`trace.py`) и асинхронном (`trace_async.py`).

Ключевая деталь: фильтр применяется **только к контекстам с непустым именем модуля**. Контексты, созданные без явного `module_name`, трассируются всегда, независимо от значения аргумента.

## Оригинальная справка

```text
Select the components to trace. Available options are 'request' and 'mooncake'. Format: <module1 name>,<module2 name>,...
```

## Паспорт аргумента

- Флаги: `--trace-modules`
- Группа: `observability`
- Тип значения: str — одна строка с именами через запятую, а не список argparse
- Допустимые значения: `choices` нет и валидации нет. Реально существующие имена в дереве — два: `request` (`sglang/python/sglang/srt/observability/req_time_stats.py`) и `mooncake` (`sglang/python/sglang/srt/disaggregation/mooncake/conn.py`). Найти актуальный набор на своей сборке: `grep -rn "module_name=" python/sglang/srt --include=*.py`
- Значение по умолчанию: `request`
- Эффективное значение: совпадает с заданным; действует только при `--enable-trace`
- Где объявлен: `ServerArgs.trace_modules`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `process_tracing_init` в каждом процессе, участвующем в трассировке

## Что меняет в движке

Два места, где имя модуля задается явно:

- `request` — контекст запроса в `req_time_stats.py`, охватывающий стадии обработки от приема до завершения. Это то, ради чего трассировку обычно и включают.
- `mooncake` — контекст передачи KV-кеша на стороне отправителя в PD-disaggregation (`MooncakeKVSender._init_trace_ctx`, роль `Sender`). Он появляется только при disaggregation с backend'ом mooncake.

Значение по умолчанию `request` означает, что спаны mooncake **выключены**: список фильтра непуст, `"mooncake"` в него не входит.

Если бы `trace_modules` был `None`, фильтрация отключалась бы целиком (`global_trace_modules is not None` — обязательное условие в проверке). Из командной строки `None` получить нельзя: у поля есть строковое значение по умолчанию. Практически это означает, что фильтр включен всегда, когда включена трассировка.

## Значения и формат

- Одно имя: `--trace-modules request`.
- Несколько: `--trace-modules request,mooncake`. Разделитель — запятая; пробелы вокруг имен срезаются, но саму строку с пробелами придется закавычить.
- Пустая строка `--trace-modules ""` дает пустой список: все именованные модули отфильтрованы, безымянные контексты по-прежнему трассируются.
- Неизвестное имя принимается молча. `--trace-modules requests` (лишняя `s`) — валидная команда, при которой не будет ни одного спана запроса и ни одного предупреждения в логе.
- Без `--enable-trace` значение не читается вообще.

## Когда использовать

- Оставить `request` — правильный выбор в подавляющем большинстве случаев.
- Добавить `mooncake` имеет смысл только при отладке передачи KV между prefill- и decode-узлами в PD-disaggregation: спаны этой подсистемы порождаются на каждую передачу и на одиночном сервере не появляются вовсе.
- Не пытайтесь через этот аргумент понизить объем трассировки для обычного сервера: подсистем всего две, и отключение `request` оставляет трассировку без содержимого. Регулятор объема — переменная окружения `SGLANG_TRACE_LEVEL` (по умолчанию 3) и эндпоинт `/set_trace_level`.

## Влияние на производительность и память

Сам разбор строки бесплатен. Экономия от исключения модуля пропорциональна числу спанов, которые он бы породил: для `mooncake` это спан на каждую передачу KV, что на PD-нагрузке сравнимо по частоте с числом запросов. Для одиночного сервера без disaggregation значение аргумента на производительность не влияет никак. На VRAM не влияет.

## Взаимодействие с другими аргументами

- `--enable-trace`: без него аргумент инертен.
- `--otlp-traces-endpoint`: адрес, куда уйдут спаны разрешенных модулей.
- `--disaggregation-mode` и `--disaggregation-transfer-backend`: определяют, существует ли модуль `mooncake` в этом запуске вообще.
- Переменная окружения `SGLANG_TRACE_ASYNC` переключает реализацию контекста на асинхронную; фильтр по модулям в ней такой же.

## Типовые проблемы и диагностика

- **Симптом:** трассировка включена, коллектор доступен, спанов нет. **Причина №1:** опечатка в имени модуля — валидации нет. **Причина №2:** `SGLANG_TRACE_LEVEL=0`. **Лечение:** вернуть `--trace-modules request`, проверить уровень через `POST /set_trace_level?level=3`.
- **Симптом:** нет спанов передачи KV в PD-конфигурации. **Причина:** значение по умолчанию `request` их отфильтровывает. **Лечение:** `--trace-modules request,mooncake`.
- **Симптом:** ожидали, что аргумент примет список через пробел. **Причина:** тип поля — `str`, а не список; разделитель только запятая. `--trace-modules request mooncake` приведет к тому, что `mooncake` будет разобрано argparse как отдельный позиционный аргумент и запуск завершится ошибкой.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `trace_modules=`.

## В arriero

Квалифицированный профиль SGLang-KT в arriero — одиночный инстанс без PD-disaggregation (`docs/KTRANSFORMERS_OPERATIONS.md`, arriero), поэтому модуль `mooncake` там не существует, а значение по умолчанию `request` покрывает всё, что вообще может быть протрассировано. Менять аргумент незачем.

Полезнее помнить обратное: сам факт `--enable-trace` с недоступным коллектором добавляет в лог инстанса строки ошибок экспорта opentelemetry, а разбор лога arriero (`apps/api/src/process/log-parsers/sglang.ts`) переводит инстанс в `degraded` по слову `error` в строке. Аргумент `--trace-modules` этому не помогает и не мешает.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --enable-trace --otlp-traces-endpoint 127.0.0.1:4317 --trace-modules request
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --host 127.0.0.1 --port 30000 --enable-trace --otlp-traces-endpoint 127.0.0.1:4317 --trace-modules request,mooncake --disaggregation-mode prefill
```

## Источники

- `sglang/python/sglang/srt/observability/trace.py`
- `sglang/python/sglang/srt/observability/trace_async.py`
- `sglang/python/sglang/srt/observability/req_time_stats.py`
- `sglang/python/sglang/srt/disaggregation/mooncake/conn.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `apps/api/src/process/log-parsers/sglang.ts`
