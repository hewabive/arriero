---
schema: 1
engine: vllm
primaryName: "--ray-workers-use-nsight"
title: "--ray-workers-use-nsight"
summary: Просит Ray запускать worker-акторов под Nsight Systems, добавляя профилировщик в runtime env. Работает только с Ray-executor'ом: при любом другом backend'е старт падает с явной ошибкой.
group: ParallelConfig
related:
  - --distributed-executor-backend
  - --data-parallel-backend
  - --tensor-parallel-size
  - --pipeline-parallel-size
---

# --ray-workers-use-nsight

## Кратко

Флаг — тонкая обёртка над механизмом профилирования самого Ray: vLLM добавляет в `runtime_env` акторов раздел `nsight` с фиксированным набором трассируемых подсистем. Собирать и разбирать трассы вы будете средствами Nsight Systems и Ray, не vLLM.

Конфигурация профилировщика жёстко зашита в код и флагами vLLM не настраивается:

```
"nsight": {
    "t": "cuda,cudnn,cublas",
    "o": "'worker_process_%p'",
    "cuda-graph-trace": "node",
}
```

Единственная жёсткая проверка: без Ray профилировать нечего, и конфигурация отвергается на старте.

## Оригинальная справка

```text
Whether to profile Ray workers with nsight, see https://docs.ray.io/en/latest/ray-observability/user-guides/profiling.html#profiling-nsight-profiler.
```

## Паспорт аргумента

- Флаги: `--ray-workers-use-nsight`, `--no-ray-workers-use-nsight`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-ray-workers-use-nsight` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется; вместо этого несовместимая конфигурация отвергается — `ParallelConfig._verify_args` требует `use_ray`. Исключено из `ParallelConfig.compute_hash`. Значение наследуется черновой моделью speculative decoding (`vllm/config/speculative.py` копирует его из целевого `ParallelConfig`)
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.ray_workers_use_nsight`
- Этап применения: сборка `VllmConfig` (проверка `use_ray`) → создание Ray-акторов (формирование `runtime_env`)

## Что меняет в движке

**Проверка.** `ParallelConfig._verify_args`: `if self.ray_workers_use_nsight and not self.use_ray: raise ValueError("Unable to use nsight profiling unless workers run with Ray.")`. Свойство `use_ray` истинно, когда `distributed_executor_backend == "ray"` либо когда в качестве backend'а передан класс executor'а с атрибутом `uses_ray`.

**Ray-executor.** `vllm/v1/executor/ray_executor.py:_configure_ray_workers_use_nsight` дописывает раздел `nsight` в `runtime_env` акторов. В `vllm/v1/executor/ray_executor_v2.py` то же самое делается при сборке `runtime_env` поверх `ray_runtime_env` из конфига.

Формат `o` (`'worker_process_%p'`) означает, что имя файла трассы будет содержать PID процесса, то есть на каждого worker-актора получится свой файл. Раздел `cuda-graph-trace: node` включает трассировку CUDA-графов на уровне узлов графа — существенно для vLLM, где основной путь декодирования как раз графовый.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- `--no-ray-workers-use-nsight` — явное подтверждение дефолта.
- Настроек нет: набор трассируемых подсистем, шаблон имени файла и режим трассировки графов заданы в коде.
- Флаг относится к профилированию **Ray-акторов**. Внутренний профилировщик vLLM (torch/CUDA) — отдельный механизм, настраиваемый через `ProfilerConfig`, а не этим флагом.

## Когда использовать

- **Разбор производительности многокарточного Ray-развёртывания**, когда нужен низкоуровневый разрез по ядрам CUDA, cuDNN и cuBLAS, а не агрегированные метрики.
- **Не используйте в проде.** Nsight добавляет заметные накладные расходы и пишет объёмные трассы; это инструмент разовой диагностики.
- **Не используйте без Ray** — старт не пройдёт.
- **Не рассчитывайте настроить набор трассировки** этим флагом: изменить его можно, только задав собственный `runtime_env` через Ray, минуя vLLM.

## Влияние на производительность и память

- **Latency и throughput.** Падают: профилировщик перехватывает вызовы CUDA-API. Величина зависит от нагрузки, но профилированный запуск нельзя использовать как ориентир по производительности.
- **Диск.** Трассы Nsight объёмны — по файлу на актора, растут со временем работы. Оцените свободное место на узлах Ray до запуска профилирования.
- **VRAM.** Прямого влияния нет.
- **Время старта.** Растёт на время инициализации профилировщика в каждом акторе.

## Взаимодействие с другими аргументами

- `--distributed-executor-backend`: обязан быть `ray` (или класс executor'а с `uses_ray`).
- `--data-parallel-backend`: значение `ray` тоже приводит к Ray-executor'у и удовлетворяет требованию.
- `--tensor-parallel-size`, `--pipeline-parallel-size`: определяют, сколько акторов будет профилироваться и сколько файлов трасс появится.
- `--speculative-config`: `ParallelConfig` черновой модели наследует это значение от целевой.

## Типовые проблемы и диагностика

- **Симптом:** `Unable to use nsight profiling unless workers run with Ray.` **Причина:** backend не Ray. **Лечение:** `--distributed-executor-backend ray` (Ray должен быть установлен: `pip install "ray[cgraph]"`) либо убрать флаг.
- **Симптом:** флаг задан, Ray используется, но трассы не появляются. **Причина:** Nsight Systems не установлен на узлах Ray или недоступны счётчики производительности GPU. В контейнерах для этого нужна capability `CAP_SYS_ADMIN` — апстрим-документация упоминает это применительно к `run_cluster.sh`. **Проверка:** документация Ray по профилированию Nsight, ссылка на неё есть прямо в справке аргумента.
- **Симптом:** узлы кластера заполнили диск. **Причина:** трассы не ротируются. **Лечение:** снимать профиль коротко и выключать флаг.
- **Подтверждение принятого значения:** отсутствие ошибки на старте плюс появление файлов `worker_process_<pid>` в каталоге трасс на узлах Ray.

## Примеры

```bash
vllm serve /models/Llama-3.1-70B --distributed-executor-backend ray --tensor-parallel-size 8 --ray-workers-use-nsight
```

```bash
vllm serve /models/Llama-3.1-70B --distributed-executor-backend ray --tensor-parallel-size 8 --no-ray-workers-use-nsight
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/v1/executor/ray_executor.py`
- `vllm/vllm/v1/executor/ray_executor_v2.py`
- `vllm/vllm/config/speculative.py`
- `vllm/docs/serving/parallelism_scaling.md`
