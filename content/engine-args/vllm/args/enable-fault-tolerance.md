---
schema: 1
engine: vllm
primaryName: "--enable-fault-tolerance"
title: "--enable-fault-tolerance"
summary: Поднимает контур восстановления после сбоя движка: сторожа в EngineCore и в worker'ах плюс HTTP-эндпоинты `/fault_tolerance/apply` и `/fault_tolerance/status`. Только для DP-развёртываний с внешним балансировщиком и ровно одним API-процессом.
group: ParallelConfig
related:
  - --fault-tolerance-config
  - --data-parallel-external-lb
  - --data-parallel-rank
  - --data-parallel-size
  - --api-server-count
  - --enable-expert-parallel
  - --all2all-backend
---

# --enable-fault-tolerance

## Кратко

По умолчанию отказ движка (EngineCore) — терминальное событие: сервер переходит в состояние ошибки. `--enable-fault-tolerance` включает контур, в котором отказ фиксируется, сообщается наружу и может быть исправлен внешним оркестратором: сбойный DP-движок выводится из строя, оставшиеся переинициализируют DP-группу и продолжают работу.

Флаг рассчитан на конкретную схему развёртывания — DP+EP с **внешним** балансировщиком, где каждый DP-ранг живёт в своём поде и внешняя система решает, куда слать трафик. Отсюда два жёстких требования: `--data-parallel-external-lb` (или явный `--data-parallel-rank`) и ровно один API-процесс.

Управление вынесено в HTTP: `POST /fault_tolerance/apply` (единственная допустимая инструкция — `retry`) и `GET /fault_tolerance/status`. Эти маршруты регистрируются только при включённом флаге.

## Оригинальная справка

```text
Enable fault tolerance for detailed error recovery,
such as scaling down fault DPEngineCore.
```

## Паспорт аргумента

- Флаги: `--enable-fault-tolerance`, `--no-enable-fault-tolerance`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enable-fault-tolerance` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: **принудительно становится `True`**, если задан `--fault-tolerance-config`, с предупреждением `--fault-tolerance-config was passed. Fault tolerance is being automatically enabled.` (`EngineArgs.__post_init__`)
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.enable_fault_tolerance`
- Этап применения: разбор CLI (автовключение из конфига) → `create_engine_config` и `ParallelConfig` (проверки совместимости) → инициализация `EngineCore` и worker'ов (создание сторожей) → сборка FastAPI-приложения (регистрация маршрутов) → рантайм (обработка отказов)

## Что меняет в движке

**Проверки.**

- `EngineArgs.create_engine_config`: `Fault tolerance requires external load balancer mode (--data-parallel-external-lb or --data-parallel-rank). Internal LB mode is not supported.`
- `ParallelConfig._validate_parallel_config`: `Fault tolerance requires a single API server process (--api-server-count=1), but got N. The FT system assumes one AsyncMPClient manages all engines.`

**Сторож движка.** `EngineCoreProc` при включённом флаге создаёт `EngineCoreSentinel` (`vllm/v1/fault_tolerance/engine_core_sentinel.py`). Сторож держит состояние (`HEALTHY`/`UNHEALTHY`), перехватывает исключение через `on_fault`, публикует статус клиенту и ждёт инструкции не дольше `engine_recovery_timeout_sec` из `--fault-tolerance-config`. Если инструкция не пришла — поднимается исходное исключение. Единственная реализованная инструкция — `retry`, она переинициализирует DP-группу (`_reinit_dp_group`).

**Сторож worker'а.** `Worker.__init__` (`vllm/v1/worker/gpu_worker.py`) при включённом флаге создаёт `WorkerSentinel`.

**All2All.** `DeepEPLLAll2AllManager` читает флаг в поле `support_fault_tolerance`: коммуникационный менеджер должен уметь пережить выбывание ранга.

**HTTP.** `vllm/entrypoints/openai/api_server.py` регистрирует роутер только при `args.enable_fault_tolerance`. `POST /fault_tolerance/apply` валидирует инструкцию по белому списку `{"retry"}`, возвращает `202 Accepted` немедленно и запускает восстановление фоновой задачей — потому что восстановление содержит кросс-ранговые коллективы и завершается только после того, как инструкция разослана всем рангам. Прогресс наблюдается через `GET /fault_tolerance/status`.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- `--no-enable-fault-tolerance` — явное подтверждение дефолта; но если вы всё же передали `--fault-tolerance-config`, флаг будет включён автоматически.
- Параметры (сегодня единственный — таймаут ожидания инструкции) задаются в `--fault-tolerance-config`.

## Когда использовать

- **DP+EP развёртывание за внешним балансировщиком**, где выбывание одного DP-ранга не должно ронять весь сервис, а оркестратор умеет опрашивать статус и отдавать `retry`.
- **Не включайте на одиночном инстансе.** Требования (внешний LB, один API-процесс) в такой схеме не выполняются, а сам механизм рассчитан на масштабирование DP вниз при сбое.
- **Не рассматривайте как «автоперезапуск».** Движок сам себя не чинит: он останавливается, объявляет себя `UNHEALTHY` и ждёт внешней инструкции ограниченное время.
- **Учтите периметр.** `/fault_tolerance/apply` не аутентифицирован самим vLLM. Сервер, доступный не только с localhost, обязан быть за прокси с авторизацией — иначе любой может дёргать восстановление.

## Влияние на производительность и память

- **VRAM.** Не влияет.
- **Throughput/latency в норме.** Влияние отсутствует, пока отказа нет: сторожа пассивны.
- **Во время восстановления.** Обслуживание на сбойном движке прекращается; переинициализация DP-группы — кросс-ранговая коллективная операция, то есть в ней участвуют все ранги.
- **API-процессы.** Требование `--api-server-count=1` ограничивает пропускную способность HTTP-слоя.
- **Время старта.** Практически не меняется.

## Взаимодействие с другими аргументами

- `--fault-tolerance-config`: задаёт `engine_recovery_timeout_sec` и включает этот флаг автоматически.
- `--data-parallel-external-lb` или явный `--data-parallel-rank`: обязательное условие.
- `--api-server-count`: обязан быть 1.
- `--data-parallel-size`: смысл механизма — пережить выбывание одного из нескольких DP-движков.
- `--enable-expert-parallel`, `--all2all-backend deepep_low_latency`: типичное окружение, в котором это применяется; DeepEP LL-менеджер читает флаг напрямую.

## Типовые проблемы и диагностика

- **Симптом:** `Fault tolerance requires external load balancer mode (--data-parallel-external-lb or --data-parallel-rank). Internal LB mode is not supported.` **Лечение:** перейти на внешний DP-балансировщик.
- **Симптом:** `Fault tolerance requires a single API server process (--api-server-count=1), but got 8.` **Лечение:** `--api-server-count 1`.
- **Симптом:** в логе `--fault-tolerance-config was passed. Fault tolerance is being automatically enabled.`, хотя флага вы не ставили. **Причина:** это и есть штатное поведение при передаче конфига.
- **Симптом:** `POST /fault_tolerance/apply` возвращает 400 `Invalid instruction: '...'`. **Причина:** допустима только инструкция `retry`.
- **Симптом:** в логе `[FT] Rejecting retry on engine N: status is HEALTHY`. **Причина:** инструкция послана движку, который не в состоянии отказа.
- **Симптом:** через `engine_recovery_timeout_sec` секунд поднимается исходное исключение. **Причина:** оркестратор не успел прислать инструкцию. **Лечение:** увеличить таймаут в `--fault-tolerance-config` или ускорить реакцию оркестратора.
- **Подтверждение принятого значения:** доступность `GET /fault_tolerance/status` (без флага маршрут не зарегистрирован) и `enable_fault_tolerance=True` в стартовой строке конфига.

## Примеры

```bash
vllm serve /models/DeepSeek-V3 --enable-fault-tolerance --enable-expert-parallel --data-parallel-size 8 --data-parallel-external-lb --api-server-count 1
```

```bash
vllm serve /models/DeepSeek-V3 --enable-fault-tolerance --fault-tolerance-config '{"engine_recovery_timeout_sec":300}' --enable-expert-parallel --data-parallel-size 8 --data-parallel-external-lb --api-server-count 1
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/config/fault_tolerance.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/fault_tolerance/engine_core_sentinel.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/entrypoints/serve/fault_tolerance/api_router.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
