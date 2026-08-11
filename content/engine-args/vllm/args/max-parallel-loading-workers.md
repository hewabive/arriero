---
schema: 1
engine: vllm
primaryName: "--max-parallel-loading-workers"
title: "--max-parallel-loading-workers"
summary: В этом коммите аргумент не реализован: любое значение отбрасывается с предупреждением `max_parallel_loading_workers is currently not supported and will be ignored`. Задавать его бессмысленно, для контроля RAM при загрузке нужны другие средства.
group: ParallelConfig
related:
  - --tensor-parallel-size
  - --pipeline-parallel-size
  - --load-format
  - --model-loader-extra-config
  - --enable-ep-weight-filter
  - --download-dir
---

# --max-parallel-loading-workers

## Кратко

Аргумент задумывался как ограничитель числа одновременно загружающих веса worker'ов: при большом tensor parallel и большой модели все ранги читают чекпоинт одновременно, и пиковое потребление RAM хоста может закончиться OOM.

В коде этого коммита реализации нет. `ParallelConfig.__post_init__` содержит единственную обработку поля:

```
if self.max_parallel_loading_workers is not None:
    logger.warning(
        "max_parallel_loading_workers is currently "
        "not supported and will be ignored."
    )
```

Дальше поле не читает никто. Значение не влияет ни на загрузку, ни на что-либо ещё; оно даже исключено из `ParallelConfig.compute_hash`.

## Оригинальная справка

```text
Maximum number of parallel loading workers when loading model
sequentially in multiple batches. To avoid RAM OOM when using tensor
parallel and large models.
```

## Паспорт аргумента

- Флаги: `--max-parallel-loading-workers`
- Группа argparse: `ParallelConfig`
- Тип значения: int или `None` (`optional: true`)
- Допустимые значения: `Field(default=None, ge=1)` — либо `None`, либо целое не меньше 1
- Значение по умолчанию: `None`
- Эффективное значение: любое не-`None` значение игнорируется с предупреждением на этапе `ParallelConfig.__post_init__`; фактическое поведение одинаково при любом вводе
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.max_parallel_loading_workers`
- Этап применения: только `ParallelConfig.__post_init__` (предупреждение); до загрузки весов значение не доходит

## Что меняет в движке

Ничего. Единственный код, читающий поле, — предупреждение выше и список `ignored_factors` в `ParallelConfig.compute_hash`, куда оно внесено как деталь запуска, не влияющая на структуру графа вычислений.

Что действительно определяет параллелизм загрузки в этом коммите:

- **`OMP_NUM_THREADS`**, выставляемый `set_multiprocessing_worker_envs(local_world_size)` перед стартом worker'ов как `available_cpu_count() // local_world_size`. Это тот самый бюджет CPU на процесс, который делится между рангами. Значение можно переопределить, задав `OMP_NUM_THREADS` в окружении до запуска (тогда vLLM его не трогает).
- **Загрузчик и его настройки** (`--load-format`, `--model-loader-extra-config`): многопоточная загрузка safetensors, число потоков предвыборки, стратегия чтения.
- **`--enable-ep-weight-filter`** для MoE: сокращает объём читаемых байтов на ранг, а не число одновременных читателей.

## Значения и формат

- Целое ≥ 1 или отсутствие аргумента.
- `None` (не задан) означает «поведение по умолчанию», которое в данном коммите совпадает с поведением при любом заданном значении.
- `0` и отрицательные отвергаются валидацией `ge=1` — единственная проверка, которая с этим полем действительно происходит.

## Когда использовать

- **Не используйте.** В этой версии флаг не делает ничего, кроме предупреждения в логе.
- **Если исходная проблема — OOM хоста при загрузке большой модели с большим TP**, работающие средства другие: ограничить `OMP_NUM_THREADS` в окружении, выбрать загрузчик с меньшим пиковым потреблением через `--load-format`/`--model-loader-extra-config`, для MoE включить `--enable-ep-weight-filter`, либо разнести загрузку по узлам (`--nnodes`).
- **Если аргумент присутствует в вашей конфигурации** — уберите его: он создаёт ложное впечатление, что ограничение действует.
- Проверить, изменилось ли это в вашей сборке, можно прямым запуском: наличие строки `max_parallel_loading_workers is currently not supported and will be ignored` в логе означает, что реализации по-прежнему нет.

## Влияние на производительность и память

- **Никакого.** Значение не доходит до загрузчика. Ни VRAM, ни RAM хоста, ни время старта, ни throughput не меняются.
- Единственный наблюдаемый эффект — одна строка WARNING в логе при старте.

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`, `--pipeline-parallel-size`: определяют реальное число одновременно загружающих процессов (`local_world_size`), а вместе с ним и `OMP_NUM_THREADS` на процесс.
- `--load-format`, `--model-loader-extra-config`: настоящие ручки поведения загрузчика.
- `--enable-ep-weight-filter`: сокращает объём чтения для MoE-моделей при активном экспертном параллелизме.
- `--download-dir`: где лежит чекпоинт; на медленном или сетевом хранилище узкое место обычно там, а не в числе читателей.

## Типовые проблемы и диагностика

- **Симптом:** `max_parallel_loading_workers is currently not supported and will be ignored.` **Причина:** аргумент задан. **Лечение:** убрать его.
- **Симптом:** хост уходит в OOM при загрузке большой модели с большим TP, и аргумент не помогает. **Причина:** он и не может помочь. **Лечение:** снизить `OMP_NUM_THREADS`, сменить загрузчик, включить фильтр экспертных весов для MoE, разнести ранги по узлам.
- **Симптом:** значение отвергнуто ещё парсером. **Причина:** передан `0` или отрицательное число — валидация `ge=1`.
- **Подтверждение принятого значения:** его нет и быть не может — принятого значения у этого аргумента в данном коммите не существует, есть только предупреждение об игнорировании.

## Примеры

```bash
vllm serve /models/Llama-3.1-70B --tensor-parallel-size 4 --max-parallel-loading-workers 2
```

```bash
vllm serve /models/Llama-3.1-70B --tensor-parallel-size 4 --load-format safetensors
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/executor/multiproc_executor.py`
- `vllm/vllm/utils/torch_utils.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
