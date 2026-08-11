---
schema: 1
engine: vllm
primaryName: "--worker-extension-cls"
title: "--worker-extension-cls"
summary: Класс, который динамически подмешивается в базы worker'а, чтобы добавить методы, вызываемые через `collective_rpc`. Дефолт — пустая строка (расширения нет); конфликт имён атрибутов с worker'ом останавливает старт.
group: ParallelConfig
related:
  - --worker-cls
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --distributed-executor-backend
---

# --worker-extension-cls

## Кратко

`collective_rpc` — механизм vLLM для вызова метода **на всех worker'ах сразу** и сбора результатов. `--worker-extension-cls` расширяет набор доступных таких методов: указанный класс динамически добавляется в базы класса worker'а, и все его публичные методы становятся вызываемыми по имени.

Штатное применение — обновление весов на живом сервере, снятие статистики, инструментация: то, что должно исполниться внутри каждого worker-процесса, где есть модель и устройство.

Дефолт — пустая строка, то есть расширения нет. Значение читается один раз при инициализации worker'а.

## Оригинальная справка

```text
The full name of the worker extension class to use. The worker extension
class is dynamically inherited by the worker class. This is used to inject
new attributes and methods to the worker class for use in collective_rpc
calls.
```

## Паспорт аргумента

- Флаги: `--worker-extension-cls`
- Группа argparse: `ParallelConfig`
- Тип значения: str (полное квалифицированное имя класса)
- Допустимые значения: `choices` нет — имя разрешается динамически через `resolve_obj_by_qualname`; статического списка не существует
- Значение по умолчанию: `""` (пустая строка — расширение не подключается)
- Эффективное значение: не переопределяется; исключено из `ParallelConfig.compute_hash`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.worker_extension_cls`
- Этап применения: инициализация каждого worker-процесса (`WorkerWrapperBase.init_worker`) — до создания объекта worker'а

## Что меняет в движке

`WorkerWrapperBase.init_worker` (`vllm/v1/worker/worker_base.py`) при непустом значении:

1. разрешает имя через `resolve_obj_by_qualname`;
2. если класс ещё не в базах worker'а, обходит все его атрибуты, не начинающиеся с `__`, и **утверждает**, что такого атрибута у worker'а нет: `Worker class <...> already has an attribute <attr>, which conflicts with the worker extension class <...>.`;
3. собирает список вызываемых атрибутов и дописывает класс в `worker_class.__bases__`;
4. логирует `Injected %s into %s for extended collective_rpc calls %s` с перечислением добавленных методов.

Это именно подмешивание в базы, а не композиция: методы расширения получают `self` того же worker'а и доступ к его состоянию (модель, устройство, конфиг).

**Как эти методы вызываются.** Программно — `LLM.collective_rpc(method, timeout, args, kwargs)` в `vllm/entrypoints/llm.py`. По HTTP — `POST /collective_rpc`, но этот маршрут регистрируется **только** при `VLLM_SERVER_DEV_MODE` (`vllm/entrypoints/openai/api_server.py` подключает dev-роутеры под этим условием). Из соображений безопасности эндпоинт передаёт только сериализованные строковые `args`/`kwargs`, и десериализация — забота вашего метода.

## Значения и формат

- Строка вида `пакет.модуль.Класс`.
- Пустая строка (дефолт) — расширение отключено; отдельного значения «none» нет.
- Проверок формата нет: неверное имя проявится ошибкой импорта при инициализации worker'а.
- Класс не обязан наследоваться от чего-либо конкретного — он именно подмешивается. Требование одно: его публичные атрибуты не должны совпадать с атрибутами класса worker'а.
- Подмешивается ровно один класс; списка здесь не предусмотрено.

## Когда использовать

- **Обновление весов на живом сервере** и другие операции, которым нужен доступ к модели внутри каждого worker'а.
- **Сбор специфичной телеметрии**, недоступной снаружи процесса.
- **Инструментация в исследовательских сборках**, когда полная замена `--worker-cls` избыточна.
- **Не используйте для смены исполнителя** — для этого есть `--worker-cls`.
- **Не рассчитывайте на HTTP-вызов в обычном режиме.** Без `VLLM_SERVER_DEV_MODE` маршрут `/collective_rpc` не зарегистрирован.
- **Не включайте `VLLM_SERVER_DEV_MODE` на сервере, доступном не только с localhost.** `/collective_rpc` не аутентифицирован самим vLLM и позволяет вызвать по имени метод внутри worker-процесса — это фактически удалённое исполнение кода в контуре движка. Если такой режим нужен, ставьте перед сервером прокси с авторизацией.

## Влияние на производительность и память

- **В покое.** Никакого: подмешивание происходит один раз при инициализации.
- **Во время вызова.** Определяется вашим методом. `collective_rpc` синхронно ждёт все ранги, поэтому долгая операция блокирует обслуживание.
- **VRAM.** Зависит от того, что делает метод: например, обновление весов может временно удвоить память под тензоры.
- **Время старта.** Незначительно: один динамический импорт и обход атрибутов на worker-процесс.

## Взаимодействие с другими аргументами

- `--worker-cls`: расширение подмешивается именно в этот класс; проверка конфликтов идёт против него.
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--prefill-context-parallel-size`: определяют, на скольких процессах будет исполняться каждый `collective_rpc`-вызов.
- `--distributed-executor-backend`: механизм работает одинаково для mp- и Ray-executor'ов; отличается только транспорт вызова.

## Типовые проблемы и диагностика

- **Симптом:** `Worker class <...> already has an attribute <attr>, which conflicts with the worker extension class <...>.` **Причина:** имя метода или поля расширения совпало с существующим у worker'а. **Лечение:** переименовать атрибут в расширении.
- **Симптом:** `ModuleNotFoundError`/`AttributeError` при инициализации worker'а. **Причина:** модуль не импортируется в окружении worker-процесса. **Проверка:** тот же импорт вручную из окружения запуска (при `spawn` окружение ребёнка не наследует всё от родителя автоматически).
- **Симптом:** `POST /collective_rpc` возвращает 404. **Причина:** не включён `VLLM_SERVER_DEV_MODE`.
- **Симптом:** метод вызван, но получил строки вместо объектов. **Причина:** это заявленный контракт эндпоинта: передаются только сериализованные строковые аргументы, десериализация — на стороне метода.
- **Симптом:** вызов зависает. **Причина:** `collective_rpc` ждёт все ранги; метод не завершился на одном из них. **Лечение:** передавать `timeout` в вызове.
- **Подтверждение принятого значения:** строка `Injected <класс> into <класс worker'а> for extended collective_rpc calls ['method_a', 'method_b']` в логе каждого worker-процесса.

## Примеры

```bash
vllm serve /models/Qwen3-4B --worker-extension-cls my_package.workers.WeightUpdateMixin --tensor-parallel-size 2
```

```bash
vllm serve /models/Qwen3-4B --worker-cls vllm.v1.worker.gpu_worker.Worker --worker-extension-cls my_package.workers.TelemetryMixin --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/worker/worker_base.py`
- `vllm/vllm/entrypoints/llm.py`
- `vllm/vllm/entrypoints/serve/dev/rpc/api_router.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
