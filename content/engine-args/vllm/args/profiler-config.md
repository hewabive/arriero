---
schema: 1
engine: vllm
primaryName: "--profiler-config"
title: "--profiler-config"
summary: JSON-объект `ProfilerConfig` — включает torch- или CUDA-профилировщик и настраивает его расписание и содержимое трасс. Побочный эффект: открывает незащищенные HTTP-эндпоинты `/start_profile` и `/stop_profile`.
group: VllmConfig
related:
  - --api-key
  - --host
  - --collect-detailed-traces
  - --otlp-traces-endpoint
  - --disable-log-stats
  - --enable-per-request-metrics
---

# --profiler-config

## Кратко

`--profiler-config` заполняет `ProfilerConfig` (`vllm/config/profiler.py`). Поле `profiler` — единственный переключатель: пока оно `None`, ничего не происходит и эндпоинты профилирования не регистрируются. При `torch` или `cuda` в API-сервер добавляется роутер с `POST /start_profile` и `POST /stop_profile`, а в лог печатается предупреждение `Profiler with mode 'X' is enabled in the API server. This should ONLY be used for local development!`.

Это инструмент разработки, а не эксплуатационная телеметрия. Для постоянных измерений есть `/metrics`, `--collect-detailed-traces` и `--otlp-traces-endpoint`.

## Оригинальная справка

```text
Profiling configuration.
```

## Паспорт аргумента

- Флаги: `--profiler-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `--profiler-config.<поле> <значение>`)
- Допустимые значения: поля `ProfilerConfig`; `profiler` ограничен `torch` и `cuda`
- Значение по умолчанию: `Field(default_factory=ProfilerConfig)` — объект со значениями по умолчанию, а не `None`; при этом `profiler` внутри него равен `None`
- Эффективное значение: `_validate_profiler_config` (pydantic, на разборе CLI) приводит `torch_profiler_dir` к абсолютному пути через `os.path.abspath(os.path.expanduser(...))`, если это не URI со схемой (`gs://`, `s3://`, `hdfs://` и подобные — они остаются как есть)
- Где объявлен: `vllm/config/vllm.py:VllmConfig.profiler_config`
- Этап применения: разбор CLI → регистрация роутера профилирования в API-сервере → инициализация воркера → запуск/остановка по HTTP-вызову

## Что меняет в движке

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `profiler` | `None` | `torch` — PyTorch-профилировщик (CPU + GPU, трассы в файлы); `cuda` — обертка вокруг CUDA-профилировщика (для внешнего Nsight); `None` — выключено |
| `torch_profiler_dir` | `""` | каталог для трасс; обязателен при `profiler: "torch"` и запрещен при любом другом значении |
| `torch_profiler_with_stack` | `true` | записывать стеки вызовов |
| `torch_profiler_with_flops` | `false` | считать FLOPS |
| `torch_profiler_use_gzip` | `true` | сжимать трассы |
| `torch_profiler_dump_cuda_time_total` | `true` | выгружать суммарное CUDA-время |
| `torch_profiler_record_shapes` | `false` | записывать формы тензоров |
| `torch_profiler_with_memory` | `false` | профилировать память |
| `capture_torch_profiler` | `false` | профилировать саму фазу захвата CUDA graphs на rank 0; трассы попадают в подкаталог `capture_traces`. Требует `profiler: "torch"` |
| `detailed_trace_annotation` | `false` | подробные аннотации событий с roofline-метриками вместо простых счетчиков запросов и токенов |
| `ignore_frontend` | `false` | не профилировать фронтенд `AsyncLLM`; нужен вместе с `delay_iterations`/`max_iterations`, иначе фронтенд захватит весь диапазон |
| `delay_iterations` | `0` | пропустить N итераций движка после `/start_profile` перед началом записи |
| `max_iterations` | `0` (без ограничения) | максимум итераций для профилирования |
| `warmup_iterations` | `0` | итерации прогрева в расписании PyTorch: профилировщик работает, но данные выбрасываются. Положительное значение включает расписание |
| `active_iterations` | `5` | сколько итераций расписания реально записываются |
| `wait_iterations` | `0` | итерации полного простоя профилировщика перед прогревом |

`compute_hash()` возвращает хеш пустого списка факторов: конфиг не влияет на граф вычислений и не инвалидирует кэш компиляции.

## Значения и формат

- Обе формы: `--profiler-config '{"profiler":"torch","torch_profiler_dir":"/tmp/vllm-traces"}'` и `--profiler-config.profiler torch --profiler-config.torch_profiler_dir /tmp/vllm-traces`. Точечные под-флаги должны использовать одно написание флага и не смешиваться с полной JSON-строкой.
- Значение валидируется на разборе CLI, включая взаимные проверки: путь без `profiler: "torch"` и `profiler: "torch"` без пути отвергаются сразу.
- `torch_profiler_dir` приводится к абсолютному пути, кроме URI со схемой длиннее одного символа — это сделано, чтобы `C://` на Windows не спутать со схемой.
- Числовые поля расписания ограничены снизу: `delay_iterations`, `max_iterations`, `warmup_iterations`, `wait_iterations` — `>= 0`, `active_iterations` — `>= 1`.
- `0` в `max_iterations` означает «без ограничения», в `delay_iterations` — «начинать сразу», в `warmup_iterations` — «расписание выключено, писать все итерации».

## Когда использовать

- **Разовое расследование производительности на локальной машине.** Включили, сняли трассу через `/start_profile` + нагрузка + `/stop_profile`, выключили.
- **`delay_iterations` + `max_iterations` + `ignore_frontend: true`**, когда интересен установившийся режим, а не первые итерации. Без `ignore_frontend` профилирование фронтенда захватит весь диапазон и трасса раздуется.
- **`capture_torch_profiler`**, если подозрение на аномальное время или память в фазе `Capturing CUDA graphs`.
- **Не оставляйте включенным на сервере, доступном не только с localhost.** Роутер `/start_profile` и `/stop_profile` регистрируется в общем FastAPI-приложении; в arriero управляемый инстанс обычно закрыт прокси, но при прямом доступе любой, кто дотянется до порта движка, может запустить профилирование и заполнить диск трассами. Апстрим отмечает это предупреждением при старте.
- **Не включайте `torch_profiler_with_memory` и `record_shapes` без нужды** — оба резко увеличивают размер трассы и накладные расходы.

## Влияние на производительность и память

- **Пока `profiler` равен `None`** — влияния нет вообще: ни фаз при старте, ни накладных расходов на шаг.
- **При включенном профилировщике** каждый шаг движка платит за сбор событий; со `with_stack` и `record_shapes` замедление становится заметным и искажает измеряемую картину.
- **Диск.** Трассы torch-профилировщика растут быстро; `torch_profiler_use_gzip` включен по умолчанию именно поэтому. Каталог не ротируется движком.
- **RAM хоста.** Профилировщик буферизует события до выгрузки; при длинных сессиях без `max_iterations` это заметный расход.
- **VRAM.** Прямого расхода нет.

## Взаимодействие с другими аргументами

- `--api-key`, `--host`: определяют, кто дотянется до `/start_profile`. Если профилировщик включен, эти настройки становятся вопросом безопасности, а не удобства.
- `--collect-detailed-traces`, `--otlp-traces-endpoint`: постоянная трассировка запросов; независимый механизм, не требующий этого конфига.
- `--enable-per-request-metrics`, `--disable-log-stats`: обычная телеметрия; для эксплуатационных наблюдений предпочтительнее профилировщика.
- Конфиг не взаимодействует с памятью, планировщиком и компиляцией — он ортогонален всей остальной конфигурации.

## Типовые проблемы и диагностика

- **Симптом:** `torch_profiler_dir must be set when profiler is 'torch'`. **Лечение:** добавить каталог.
- **Симптом:** `torch_profiler_dir is only applicable when profiler is set to 'torch'`. **Причина:** путь задан при `profiler: "cuda"` или без профилировщика. **Лечение:** убрать одно из двух.
- **Симптом:** `capture_torch_profiler is only applicable when profiler is set to 'torch'`. **Лечение:** то же.
- **Симптом:** `Unknown profiler type: X` при инициализации воркера. **Причина:** значение вне `torch`/`cuda`. **Лечение:** исправить значение.
- **Симптом:** предупреждение `Using 'torch' profiler with delay_iterations or max_iterations while ignore_frontend is False may result in high overhead.` **Лечение:** добавить `ignore_frontend: true`.
- **Симптом:** `POST /start_profile` возвращает 404. **Причина:** `profiler` не задан, роутер не зарегистрирован. **Лечение:** включить профилировщик и перезапустить сервер.
- **Подтверждение принятого значения:** предупреждение `Profiler with mode 'X' is enabled in the API server. This should ONLY be used for local development!` при старте и строки `Starting profiler...` / `Profiler started.` при вызове эндпоинта.

## Примеры

```bash
vllm serve /models/Qwen3-4B --profiler-config '{"profiler":"torch","torch_profiler_dir":"/tmp/vllm-traces","ignore_frontend":true,"max_iterations":50}'
```

```bash
vllm serve /models/Qwen3-4B --profiler-config.profiler torch --profiler-config.torch_profiler_dir /tmp/vllm-traces --profiler-config.capture_torch_profiler true
```

## Источники

- `vllm/vllm/config/profiler.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/entrypoints/serve/profile/api_router.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/docs/contributing/profiling.md`
