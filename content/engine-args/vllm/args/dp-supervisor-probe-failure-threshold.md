---
schema: 1
engine: vllm
primaryName: "--dp-supervisor-probe-failure-threshold"
title: "--dp-supervisor-probe-failure-threshold"
summary: Сколько попыток подряд делает health-проба супервизора при ошибке соединения, прежде чем считать дочерний ранг упавшим. До достижения готовности порог принудительно равен 1.
group: Frontend
related:
  - --data-parallel-multi-port-external-lb
  - --data-parallel-supervisor-port
  - --dp-supervisor-probe-interval-s
  - --dp-supervisor-probe-timeout-s
  - --shutdown-timeout
---

# --dp-supervisor-probe-failure-threshold

## Кратко

Порог — это число попыток внутри одной пробы, а не число неудачных оборотов цикла. Он расходуется только на ошибки соединения и таймауты: полученный HTTP-статус, отличный от 200 (например, 503 при мертвом движке), признается окончательным сразу.

И он применяется только после того, как группа однажды стала готовой. До готовности порог жестко равен 1.

## Оригинальная справка

```text
Number of consecutive connection-error retries before a child health
probe is declared failed in multi-port external LB mode.
```

## Паспорт аргумента

- Флаги: `--dp-supervisor-probe-failure-threshold`
- Группа argparse: `Frontend`
- Тип значения: int
- Допустимые значения: не ограничены; минимума в коде нет
- Значение по умолчанию: `3`
- Эффективное значение: `threshold = <значение> if self._is_ready else 1` — до первой готовности всегда одна попытка за оборот
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.dp_supervisor_probe_failure_threshold`
- Этап применения: каждый оборот цикла проб супервизора

## Что меняет в движке

`_probe_endpoint` (`vllm/entrypoints/openai/dp_supervisor.py`) — это цикл `for iteration in range(conn_err_failure_threshold)`:

- при любом полученном HTTP-ответе функция немедленно возвращает `status == 200` и цикл прерывается;
- при `aiohttp.ClientError` или `asyncio.TimeoutError` пишется debug-строка `Probe attempt i/N failed on port P` и, если попытки остались, выполняется пауза `--dp-supervisor-probe-interval-s`;
- исчерпав все попытки, функция возвращает `False`.

Значение `False` хотя бы по одному ребенку после достижения готовности означает остановку всей группы: `_is_ready` снимается, взводится событие остановки, супервизор рассылает детям сигнал завершения и добивает `kill_process_tree` через `--shutdown-timeout` плюс 5 секунд.

Асимметрия «до готовности порог 1» сделана намеренно: стартующий ранг еще не принимает соединения, и тратить на него повторы бессмысленно — его опросят в следующем обороте цикла.

Общий механизм проб описан в документе `--dp-supervisor-probe-interval-s`.

## Значения и формат

- Целое число попыток: `--dp-supervisor-probe-failure-threshold 5`.
- `1` означает «без повторов»: первая же ошибка соединения после достижения готовности останавливает группу.
- `0` или отрицательное значение кодом не запрещено, но `range(<=0)` даст пустой цикл, и проба вернет `False` не выполнив ни одного запроса — группа остановится на первом же обороте. Не задавайте так.
- Худшее время признания ранга упавшим примерно равно `threshold × timeout + (threshold − 1) × interval`.
- Вне режима `--data-parallel-multi-port-external-lb` значение не читается.

## Когда использовать

- Увеличивайте, если сеть до дочерних рангов не идеальна (не loopback) и единичные ошибки соединения — норма. Каждая дополнительная попытка удлиняет время обнаружения настоящего отказа.
- Уменьшайте до 1-2, когда внешний балансировщик должен как можно быстрее вывести узел из ротации, а перезапуск группы дешев.
- Не рассчитывайте, что порог сгладит нестабильный движок: 503 от живого HTTP-сервера с мертвым движком повторами не гасится вовсе.

## Влияние на производительность и память

Прямого влияния на инференс нет. Влияет на доступность: заниженный порог превращает случайную сетевую ошибку в остановку всех локальных рангов, завышенный — удлиняет период, в течение которого балансировщик считает узел исправным.

## Взаимодействие с другими аргументами

- `--dp-supervisor-probe-interval-s`: пауза между попытками внутри пробы и период цикла.
- `--dp-supervisor-probe-timeout-s`: сколько ждет одна попытка.
- `--data-parallel-supervisor-port`: где публикуется итоговое состояние.
- `--shutdown-timeout`: вместе с константной пятисекундной надбавкой определяет, сколько супервизор ждет корректного завершения детей перед принудительным убийством.
- `--data-parallel-multi-port-external-lb`: включатель режима.

## Типовые проблемы и диагностика

- **Симптом:** группа останавливается от единичного сетевого сбоя. **Причина:** низкий порог. **Проверка:** `DPSupervisor probe found N unhealthy DP Servers.` и предшествующие debug-строки `Probe attempt`. **Лечение:** увеличить порог.
- **Симптом:** порог увеличили, а падение ранга всё равно определяется мгновенно. **Причина:** ребенок ответил 503 — повторы к такому случаю не применяются. **Лечение:** ожидаемое поведение; разбирать причину `EngineDeadError` на ранге.
- **Симптом:** при старте порог не работает. **Причина:** до готовности он принудительно равен 1. **Лечение:** ожидаемое поведение; стартующий ранг опрашивается в следующем обороте.
- **Симптом:** после остановки в логе `DP server <name> did not exit within <T>s; force killing.` **Причина:** ребенок не завершился за `--shutdown-timeout` плюс 5 секунд. **Лечение:** увеличить `--shutdown-timeout`.
- **Подтверждение принятого значения:** debug-строки `Probe attempt i/N failed on port P` — знаменатель `N` и есть действующий порог.

## Примеры

```bash
vllm serve /models/Qwen3-4B --data-parallel-multi-port-external-lb --data-parallel-size 2 --data-parallel-size-local 2 --dp-supervisor-probe-failure-threshold 5
```

```bash
vllm serve /models/Qwen3-4B --data-parallel-multi-port-external-lb --data-parallel-size 2 --data-parallel-size-local 2 --dp-supervisor-probe-failure-threshold 1 --dp-supervisor-probe-interval-s 2
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/dp_supervisor.py`
