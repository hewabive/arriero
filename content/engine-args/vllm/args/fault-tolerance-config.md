---
schema: 1
engine: vllm
primaryName: "--fault-tolerance-config"
title: "--fault-tolerance-config"
summary: JSON-объект настроек контура отказоустойчивости; сегодня в нём ровно один ключ — `engine_recovery_timeout_sec` (120). Передача этого аргумента сама включает `--enable-fault-tolerance`.
group: ParallelConfig
related:
  - --enable-fault-tolerance
  - --data-parallel-external-lb
  - --data-parallel-rank
  - --data-parallel-size
  - --api-server-count
---

# --fault-tolerance-config

## Кратко

`--fault-tolerance-config` настраивает контур восстановления после сбоя движка. Сегодня датакласс `FaultToleranceConfig` состоит из единственного поля: `engine_recovery_timeout_sec` — сколько секунд сбойный `EngineCore` ждёт инструкции по обработке ошибки, прежде чем поднять исходное исключение.

Важная особенность, которой нет у соседнего `--eplb-config`: передача этого аргумента **включает механизм сама**. `EngineArgs.__post_init__` при разборе выставляет `enable_fault_tolerance = True` и пишет предупреждение.

Как и всякий JSON-аргумент vLLM, принимается и одной строкой, и точечным под-флагом.

## Оригинальная справка

```text
The configurations for fault tolerance.
```

## Паспорт аргумента

- Флаги: `--fault-tolerance-config`
- Группа argparse: `ParallelConfig`
- Тип значения: JSON-объект (датакласс `FaultToleranceConfig`)
- Допустимые значения: `choices` нет; единственный ключ — `engine_recovery_timeout_sec` (int)
- Значение по умолчанию: `Field(default_factory=FaultToleranceConfig)` — конструируемый объект со значением `engine_recovery_timeout_sec = 120`
- Эффективное значение: сам конфиг не переопределяется, но переопределяет соседа — включает `--enable-fault-tolerance`, а тот тянет за собой требования «внешний DP-балансировщик» и `--api-server-count=1`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.fault_tolerance_config`
- Этап применения: разбор CLI (`EngineArgs.__post_init__` превращает dict в `FaultToleranceConfig` и включает флаг) → инициализация `EngineCoreSentinel` → рантайм (ожидание инструкции при отказе)

## Что меняет в движке

Датакласс (`vllm/config/fault_tolerance.py`) целиком:

```
engine_recovery_timeout_sec: int = 120
```

Значение читает `EngineCoreSentinel.__init__` и хранит в одноимённом поле. Оно используется как таймаут ожидания: после `on_fault` движок объявляет себя `UNHEALTHY`, публикует статус и ждёт инструкции извне. Не дождавшись — поднимает исходное исключение, то есть ведёт себя как без отказоустойчивости, только позже.

Автовключение (`vllm/engine/arg_utils.py`):

```
if isinstance(self.fault_tolerance_config, dict):
    if not self.enable_fault_tolerance:
        logger.warning("--fault-tolerance-config was passed. Fault tolerance is being "
                       "automatically enabled.")
        self.enable_fault_tolerance = True
    self.fault_tolerance_config = FaultToleranceConfig(**self.fault_tolerance_config)
```

Отсюда следует, что задать конфиг «на будущее», не включая механизм, нельзя.

## Значения и формат

Одна строка JSON:

```bash
vllm serve /models/DeepSeek-V3 --data-parallel-size 8 --data-parallel-external-lb --api-server-count 1 --fault-tolerance-config '{"engine_recovery_timeout_sec":300}'
```

Точечный под-флаг (эквивалентно):

```bash
vllm serve /models/DeepSeek-V3 --data-parallel-size 8 --data-parallel-external-lb --api-server-count 1 --fault-tolerance-config.engine_recovery_timeout_sec 300
```

- Дефис и подчёркивание в имени ключа эквивалентны (`FlexibleArgumentParser`).
- Незаданный ключ берёт значение из датакласса (120), а не «отключается».
- Лишний ключ отвергается конструктором датакласса.
- `--config file.yaml` подставляет значения до явных флагов, поэтому явный флаг командной строки выигрывает.

## Когда использовать

- **Оркестратор реагирует медленнее 120 секунд.** Это единственная содержательная причина трогать значение: увеличить окно, за которое внешняя система успеет опросить `GET /fault_tolerance/status` и прислать `retry`.
- **Наоборот, сократить окно**, если сбой должен как можно быстрее превращаться в явную ошибку и перезапуск пода, а не в долгое ожидание.
- **Не используйте как способ включить отказоустойчивость «между делом».** Включение — побочный эффект, а требования (внешний DP-LB, один API-процесс) остаются в силе и проверяются на старте.
- **Не ждите здесь других настроек.** Датакласс из одного поля; всё остальное поведение контура задано кодом.

## Влияние на производительность и память

- **VRAM, throughput, latency в норме.** Не влияет: значение читается только на пути обработки отказа.
- **Во время отказа.** Задаёт, как долго процесс остаётся живым и недоступным для обслуживания, прежде чем упасть. Слишком большое значение затягивает деградацию, слишком малое — не даёт оркестратору шанса.
- **Косвенно.** Через автовключение `--enable-fault-tolerance` конфиг приносит требование `--api-server-count=1`, а это уже влияет на пропускную способность HTTP-слоя.

## Взаимодействие с другими аргументами

- `--enable-fault-tolerance`: включается автоматически при передаче этого конфига; все его ограничения применяются.
- `--data-parallel-external-lb` или явный `--data-parallel-rank`: обязательное условие, которое придёт вместе с автовключением.
- `--api-server-count`: обязан быть 1.
- `--data-parallel-size`: механизм имеет смысл при нескольких DP-движках.

## Типовые проблемы и диагностика

- **Симптом:** `--fault-tolerance-config was passed. Fault tolerance is being automatically enabled.` **Причина:** штатное автовключение. **Что делать:** убедиться, что остальные требования выполнены, иначе следующая же проверка остановит старт.
- **Симптом:** сразу после передачи конфига старт падает на `Fault tolerance requires external load balancer mode ...` или `Fault tolerance requires a single API server process (--api-server-count=1) ...`. **Причина:** автовключение сработало, а схема развёртывания к нему не готова. **Лечение:** либо убрать конфиг, либо привести развёртывание в соответствие.
- **Симптом:** движок падает ровно через 120 секунд после отказа. **Причина:** дефолтный таймаут истёк, инструкция не пришла. **Лечение:** увеличить `engine_recovery_timeout_sec` и проверить, что оркестратор опрашивает `GET /fault_tolerance/status`.
- **Симптом:** `TypeError` при конструировании `FaultToleranceConfig`. **Причина:** лишний ключ в JSON.
- **Подтверждение принятого значения:** предупреждение об автовключении в логе и доступность `GET /fault_tolerance/status`.

## Примеры

```bash
vllm serve /models/DeepSeek-V3 --fault-tolerance-config '{"engine_recovery_timeout_sec":300}' --enable-expert-parallel --data-parallel-size 8 --data-parallel-external-lb --api-server-count 1
```

```bash
vllm serve /models/DeepSeek-V3 --enable-fault-tolerance --fault-tolerance-config.engine_recovery_timeout_sec 60 --data-parallel-size 4 --data-parallel-external-lb --api-server-count 1
```

## Источники

- `vllm/vllm/config/fault_tolerance.py`
- `vllm/vllm/config/parallel.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/fault_tolerance/engine_core_sentinel.py`
- `vllm/vllm/entrypoints/serve/fault_tolerance/api_router.py`
- `vllm/vllm/utils/argparse_utils.py`
