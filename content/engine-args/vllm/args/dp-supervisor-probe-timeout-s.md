---
schema: 1
engine: vllm
primaryName: "--dp-supervisor-probe-timeout-s"
title: "--dp-supervisor-probe-timeout-s"
summary: Полный таймаут одного HTTP-запроса health-пробы супервизора multi-port external LB. Справка описывает его как паузу между повторами, но в коде эту роль играет интервал проб.
group: Frontend
related:
  - --data-parallel-multi-port-external-lb
  - --data-parallel-supervisor-port
  - --dp-supervisor-probe-interval-s
  - --dp-supervisor-probe-failure-threshold
---

# --dp-supervisor-probe-timeout-s

## Кратко

Значение уходит в `aiohttp.ClientTimeout(total=...)` для сессии, которой супервизор опрашивает `/health` дочерних рангов. Это полный бюджет запроса: соединение, отправка, ожидание ответа.

Справка называет его паузой между повторами при ошибке соединения. По коду эту паузу задает `--dp-supervisor-probe-interval-s`; проверяется чтением `_probe_all_children` и `_probe_endpoint` в `vllm/entrypoints/openai/dp_supervisor.py`.

## Оригинальная справка

```text
Seconds to wait between retries when a child health probe fails with a
connection error in multi-port external LB mode.
```

## Паспорт аргумента

- Флаги: `--dp-supervisor-probe-timeout-s`
- Группа argparse: `Frontend`
- Тип значения: float (секунды)
- Допустимые значения: не ограничены; проверок границ в коде нет
- Значение по умолчанию: `5.0`
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.dp_supervisor_probe_timeout_s`
- Этап применения: создание HTTP-сессии проб при запуске цикла наблюдения супервизора

## Что меняет в движке

`_probe_all_children` создает сессию один раз на всё время жизни цикла:

```text
timeout = aiohttp.ClientTimeout(total=self.args.dp_supervisor_probe_timeout_s)
async with aiohttp.ClientSession(timeout=timeout) as session: ...
```

Дальше `_probe_endpoint` выполняет `session.get(...)` и ловит `aiohttp.ClientError` и `asyncio.TimeoutError` в одну ветку. То есть исчерпанный таймаут неотличим от ошибки соединения: обе ситуации считаются «попыткой», расходуют один шаг из `--dp-supervisor-probe-failure-threshold` и приводят к паузе длиной `--dp-supervisor-probe-interval-s`.

Общий механизм проб описан в документе `--dp-supervisor-probe-interval-s`; здесь важно только одно: этот аргумент отвечает за то, сколько супервизор ждет ответа, а не за то, как быстро он повторяет попытку.

Значение сессионное. Изменение возможно только перезапуском супервизора.

## Значения и формат

- Число секунд с плавающей точкой: `--dp-supervisor-probe-timeout-s 2`.
- Слишком малое значение делает пробы ложноотрицательными: перегруженный ранг может не успеть ответить на `/health`, и группа будет остановлена как «нездоровая».
- Ноль или отрицательное значение кодом не запрещены, но `aiohttp` трактует такой total-таймаут как немедленное истечение — все пробы станут неуспешными.
- Вне режима `--data-parallel-multi-port-external-lb` значение не читается.

## Когда использовать

- Уменьшайте на быстрых loopback-пробах, если нужно сократить время реакции: таймаут напрямую входит в худшее время обнаружения отказа.
- Увеличивайте, если ранг под пиковой нагрузкой отвечает на `/health` с задержкой и это уже приводило к ложной остановке группы.
- Не путайте с интервалом: делать таймаут больше интервала можно, но тогда оборот цикла проб растягивается на длительность самой медленной пробы.

## Влияние на производительность и память

Прямого влияния нет: величина определяет только длительность ожидания в супервизорном процессе. Косвенное — через ложные срабатывания: слишком короткий таймаут приводит к остановке всей группы рангов, то есть к полной потере обслуживания.

## Взаимодействие с другими аргументами

- `--dp-supervisor-probe-interval-s`: период цикла и настоящая пауза между повторами.
- `--dp-supervisor-probe-failure-threshold`: сколько таких таймаутов подряд допустимо после достижения готовности.
- `--data-parallel-supervisor-port`: порт, на который выводится результат.
- `--data-parallel-multi-port-external-lb`: включатель режима.

## Типовые проблемы и диагностика

- **Симптом:** группа останавливается под нагрузкой, хотя ранги живы. **Причина:** `/health` не успевает ответить за таймаут. **Проверка:** на уровне debug — строки `Probe attempt i/N failed on port P` с `TimeoutError`. **Лечение:** увеличить таймаут и/или порог повторов.
- **Симптом:** все пробы неуспешны сразу после старта супервизора. **Причина:** нулевой или крайне малый таймаут. **Лечение:** вернуть значение по умолчанию.
- **Симптом:** ранг отвечает 503, а супервизор не повторил попытку. **Причина:** повторы предусмотрены только для ошибок соединения и таймаутов; любой полученный HTTP-статус считается окончательным ответом. **Лечение:** разбирать причину 503 на самом ранге.
- **Подтверждение принятого значения:** отдельной строки лога нет; фактическую длительность неудачной пробы видно по отметкам времени debug-строк `Probe attempt`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --data-parallel-multi-port-external-lb --data-parallel-size 2 --data-parallel-size-local 2 --dp-supervisor-probe-timeout-s 2
```

```bash
vllm serve /models/Qwen3-4B --data-parallel-multi-port-external-lb --data-parallel-size 2 --data-parallel-size-local 2 --dp-supervisor-probe-timeout-s 15 --dp-supervisor-probe-interval-s 5
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/dp_supervisor.py`
