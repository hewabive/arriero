---
schema: 1
engine: vllm
primaryName: "--dp-supervisor-probe-interval-s"
title: "--dp-supervisor-probe-interval-s"
summary: Период цикла проверок супервизора multi-port external LB. Он же служит паузой между повторами пробы после ошибки соединения — вторая роль в справке не описана.
group: Frontend
related:
  - --data-parallel-multi-port-external-lb
  - --data-parallel-supervisor-port
  - --dp-supervisor-probe-timeout-s
  - --dp-supervisor-probe-failure-threshold
  - --data-parallel-size-local
---

# --dp-supervisor-probe-interval-s

## Кратко

Это основной ритм супервизора. С этим периодом он и опрашивает `/health` каждого дочернего ранга, и проверяет, живы ли их процессы.

Второе применение того же значения в справке не упомянуто: оно передается в пробу как `conn_err_retry_delay`, то есть как пауза между повторами при ошибке соединения. Увеличение интервала пропорционально удлиняет и полное время обнаружения отказа.

## Оригинальная справка

```text
Seconds between aggregated health probes in multi-port external LB mode.
```

## Паспорт аргумента

- Флаги: `--dp-supervisor-probe-interval-s`
- Группа argparse: `Frontend`
- Тип значения: float (секунды)
- Допустимые значения: не ограничены; нижней и верхней границы в коде нет
- Значение по умолчанию: `5.0`
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:FrontendArgs.dp_supervisor_probe_interval_s`
- Этап применения: работа супервизора после запуска дочерних процессов

## Что меняет в движке

Механизм проверок целиком живет в `DPSupervisor` (`vllm/entrypoints/openai/dp_supervisor.py`) и состоит из двух параллельных задач.

**`_probe_all_children`** — цикл, в каждом обороте которого выполняется `_probe_endpoint` для всех дочерних портов сразу (`asyncio.gather`). Проба одного ребенка:

- делает `GET http://<host>:<порт>/health` и **немедленно** возвращает результат сравнения `status == 200` при любом HTTP-ответе. То есть 503 (например, `EngineDeadError`) считается отказом сразу, без повторов;
- повторяет попытку только при ошибке соединения или таймауте — не более `--dp-supervisor-probe-failure-threshold` раз, засыпая между попытками ровно на `--dp-supervisor-probe-interval-s`;
- до достижения готовности порог принудительно равен 1: стартующий ранг просто будет опрошен в следующем обороте цикла.

Когда здоровы все дети, супервизор помечается готовым и поднимает свой HTTP-сервер. Если после этого хоть один ребенок оказался нездоров, супервизор пишет `DPSupervisor probe found N unhealthy DP Servers.`, снимает готовность и инициирует остановку всей группы.

**`_monitor_children`** — второй цикл с тем же периодом: он проверяет, не завершился ли дочерний процесс, и не упала ли задача проб. Ожидание в обоих циклах реализовано как `asyncio.wait_for(shutdown_event.wait(), timeout=<интервал>)`, поэтому сигнал остановки не ждет конца паузы.

## Значения и формат

- Число секунд с плавающей точкой: `--dp-supervisor-probe-interval-s 2.5`.
- Нулевое или отрицательное значение кодом не запрещено: `asyncio.sleep(0)` и `wait_for(..., timeout<=0)` превратят цикл в busy-loop. Не задавайте так.
- Значение по умолчанию `5.0` совпадает с дефолтом `--dp-supervisor-probe-timeout-s`, но это разные величины: одна — пауза, другая — таймаут запроса.
- Вне режима `--data-parallel-multi-port-external-lb` значение не читается.

## Когда использовать

- Уменьшайте, если внешний балансировщик должен узнавать об отказе ранга быстрее, чем за десятки секунд: полное время обнаружения при ошибке соединения равно примерно `interval × (threshold − 1)` плюс таймауты запросов.
- Увеличивайте, если ранги долго стартуют, а лишний трафик проб по loopback нежелателен; на готовность это не влияет — до нее порог повторов и так равен 1.
- Не подбирайте интервал ради «сглаживания» флапов: после достижения готовности одна неудачная проба останавливает всю группу, флапы здесь не гасятся.

## Влияние на производительность и память

Пренебрежимо мало: один HTTP-запрос на ранг за оборот по loopback. На VRAM, KV-cache, throughput и latency инференса не влияет. Слишком малое значение нагружает не движок, а `/health`-обработчики дочерних серверов и лог (при `--uvicorn-log-level debug` — заметно).

## Взаимодействие с другими аргументами

- `--data-parallel-multi-port-external-lb`: без него весь механизм не запускается.
- `--dp-supervisor-probe-failure-threshold`: число попыток; вместе с интервалом задает время обнаружения отказа.
- `--dp-supervisor-probe-timeout-s`: таймаут одного HTTP-запроса пробы.
- `--data-parallel-supervisor-port`: порт, на котором публикуется результат этих проб.
- `--data-parallel-size-local`: сколько детей опрашивается в каждом обороте.

## Типовые проблемы и диагностика

- **Симптом:** балансировщик узнает о падении ранга слишком поздно. **Причина:** велик интервал и/или порог повторов. **Проверка:** отметки времени между `DPSupervisor probe found N unhealthy DP Servers.` и фактическим падением ранга. **Лечение:** уменьшить интервал и порог.
- **Симптом:** в логе на уровне debug поток строк `Probe attempt i/N failed on port P`. **Причина:** ребенок не принимает соединения. **Лечение:** смотреть лог соответствующего ранга — супервизор здесь только наблюдатель.
- **Симптом:** после старта супервизор долго не поднимает свой порт. **Причина:** какой-то ранг еще грузит модель; до готовности каждый оборот делает по одной попытке. **Проверка:** `Waiting for vLLM DP Servers to become ready.` **Лечение:** ожидание, интервал на скорость загрузки модели не влияет.
- **Подтверждение принятого значения:** при `--uvicorn-log-level debug` в логе видно `Waiting for <N> seconds before next probe`.

## Примеры

```bash
vllm serve /models/Qwen3-4B --data-parallel-multi-port-external-lb --data-parallel-size 2 --data-parallel-size-local 2 --dp-supervisor-probe-interval-s 2
```

```bash
vllm serve /models/Qwen3-4B --data-parallel-multi-port-external-lb --data-parallel-size 2 --data-parallel-size-local 2 --dp-supervisor-probe-interval-s 10 --dp-supervisor-probe-failure-threshold 2
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/openai/dp_supervisor.py`
- `vllm/vllm/entrypoints/cli/serve.py`
