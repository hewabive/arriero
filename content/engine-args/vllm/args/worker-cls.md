---
schema: 1
engine: vllm
primaryName: "--worker-cls"
title: "--worker-cls"
summary: Полное имя класса worker'а. Значение `auto` заменяется платформенным хуком на конкретный класс (`gpu_worker.Worker` для CUDA/ROCm, `xpu_worker.XPUWorker`, `cpu_worker.CPUWorker`); менять имеет смысл только при собственной реализации worker'а.
group: ParallelConfig
related:
  - --worker-extension-cls
  - --distributed-executor-backend
  - --tensor-parallel-size
  - --pipeline-parallel-size
---

# --worker-cls

## Кратко

Worker — это процесс, который держит устройство, загружает шард весов и исполняет forward. `--worker-cls` определяет, какой именно класс им будет.

Значение по умолчанию `auto` — не «класс по имени auto», а маркер: платформенный хук `check_and_update_config` заменяет его на конкретный путь, соответствующий устройству. Поэтому в подавляющем большинстве случаев флаг трогать не нужно.

Флаг существует ради расширяемости: сторонние платформы и исследовательские сборки подставляют сюда свою реализацию. Значение обязано быть **строкой** с полным квалифицированным именем — передать класс объектом в CLI нельзя.

## Оригинальная справка

```text
The full name of the worker class to use. If "auto", the worker class
will be determined based on the platform.
```

## Паспорт аргумента

- Флаги: `--worker-cls`
- Группа argparse: `ParallelConfig`
- Тип значения: str (полное квалифицированное имя класса)
- Допустимые значения: `choices` нет — имя разрешается динамически через `resolve_obj_by_qualname`, поэтому статического списка не существует. Реально применимые значения определяются установленными платформами и вашими собственными модулями
- Значение по умолчанию: `"auto"`
- Эффективное значение: **всегда переопределяется** при `auto` платформенным хуком: `vllm.v1.worker.gpu_worker.Worker` на CUDA (`vllm/platforms/cuda.py`) и на ROCm (`vllm/platforms/rocm.py`), `vllm.v1.worker.xpu_worker.XPUWorker` на XPU, `vllm.v1.worker.cpu_worker.CPUWorker` на CPU. Исключено из `ParallelConfig.compute_hash`
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.worker_cls`
- Этап применения: платформенный хук при сборке `VllmConfig` (замена `auto`) → инициализация каждого worker-процесса (`WorkerWrapperBase`, импорт и создание объекта)

## Что меняет в движке

**Замена `auto`.** Каждая платформа в `check_and_update_config` проверяет `if parallel_config.worker_cls == "auto"` и подставляет свой класс. Явно заданное значение платформа не трогает — в `vllm/platforms/xpu.py` это отдельно оговорено комментарием.

**Разрешение имени.** `WorkerWrapperBase.init_worker` (`vllm/v1/worker/worker_base.py`):

```
if isinstance(parallel_config.worker_cls, str):
    worker_class = resolve_obj_by_qualname(parallel_config.worker_cls)
else:
    raise ValueError("passing worker_cls is no longer supported. "
                     "Please pass keep the class in a separate module "
                     "and pass the qualified name of the class as a string.")
```

Импорт происходит **внутри** worker-процесса, после `load_general_plugins()`. Отсюда практическое требование: модуль должен быть импортируемым в окружении worker'а, а не только в процессе, где разбиралась командная строка. При `spawn` это не одно и то же.

**Отличие от Python-API.** В `vllm/entrypoints/llm.py` значение `worker_cls`, переданное типом, сериализуется через `cloudpickle`. Через CLI такой путь недоступен: `vllm serve` передаёт строку.

## Значения и формат

- Строка вида `пакет.модуль.Класс`.
- `auto` (дефолт) — «выбери по платформе».
- Проверок формата нет: неверное имя проявится как ошибка импорта при инициализации worker'а, то есть уже после старта процессов.
- Класс должен быть наследником `WorkerBase` и реализовывать её контракт; типовой ориентир — `vllm.v1.worker.gpu_worker.Worker`.
- Отдельное поле `sd_worker_cls` (класс worker'а для speculative decoding, тоже со значением `auto`) в CLI не выведено — его через флаги не задать.

## Когда использовать

- **Своя платформа или свой backend исполнения.** Штатный способ подменить исполнителя, не форкая vLLM.
- **Исследовательские сборки**, где нужен worker с дополнительной инструментацией на уровне всего жизненного цикла (инициализация устройства, профилирование памяти, загрузка модели).
- **Не используйте, чтобы добавить пару методов.** Для этого есть `--worker-extension-cls`: он подмешивает класс в базы штатного worker'а, не заменяя его.
- **Не оставляйте `auto` в командной строке явно** — это ровно то же, что не указывать флаг.
- **Учитывайте периметр.** Значение — это имя, которое движок импортирует и исполняет. Оно должно приходить из доверенного источника конфигурации, наравне с путями к весам.

## Влияние на производительность и память

- **Само по себе.** Никакого: `auto` и явно указанный платформенный класс дают идентичное поведение.
- **С чужой реализацией.** Все характеристики (VRAM, время старта, throughput, latency) определяются этой реализацией, а не флагом. Штатные гарантии vLLM на неё не распространяются.
- **Время старта.** Незначительно: один динамический импорт на worker-процесс.

## Взаимодействие с другими аргументами

- `--worker-extension-cls`: подмешивается в базы выбранного здесь класса; при конфликте атрибутов инициализация падает утверждением.
- `--distributed-executor-backend`: определяет, сколько и каких процессов будет создано, но класс worker'а берётся отсюда в любом случае.
- `--tensor-parallel-size`, `--pipeline-parallel-size`, `--prefill-context-parallel-size`: задают число worker-процессов, каждый из которых инстанцирует этот класс.

## Типовые проблемы и диагностика

- **Симптом:** `passing worker_cls is no longer supported. Please pass keep the class in a separate module and pass the qualified name of the class as a string.` **Причина:** передан объект класса, а не строка (актуально для Python-API, не для CLI).
- **Симптом:** `ModuleNotFoundError` или `AttributeError` при инициализации worker'а. **Причина:** модуль не импортируется в окружении worker-процесса или имя класса указано неверно. **Проверка:** тот же импорт вручную из окружения, откуда запускается сервер.
- **Симптом:** сервер стартует на CUDA, а вы ожидали свой класс. **Причина:** значение осталось `auto`, платформенный хук подставил `vllm.v1.worker.gpu_worker.Worker`.
- **Симптом:** worker падает на методе, которого нет. **Причина:** класс не реализует контракт `WorkerBase`.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `worker_cls=...` уже после платформенной замены; при заданном `--worker-extension-cls` дополнительно печатается `Injected <ext> into <worker_class> for extended collective_rpc calls [...]`, где виден фактический класс worker'а.

## Примеры

```bash
vllm serve /models/Qwen3-4B --worker-cls vllm.v1.worker.gpu_worker.Worker --tensor-parallel-size 2
```

```bash
vllm serve /models/Qwen3-4B --worker-cls my_package.workers.InstrumentedWorker --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/worker/worker_base.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/platforms/rocm.py`
- `vllm/vllm/platforms/xpu.py`
- `vllm/vllm/platforms/cpu.py`
- `vllm/vllm/entrypoints/llm.py`
