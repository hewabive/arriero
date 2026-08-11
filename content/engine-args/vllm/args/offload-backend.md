---
schema: 1
engine: vllm
primaryName: "--offload-backend"
title: "--offload-backend"
summary: Выбор реализации выгрузки весов — `uva` (zero-copy чтение из pinned RAM) или `prefetch` (асинхронная подкачка слоев в статические GPU-буферы). При `auto` решает то, какая из групп полей задана.
group: OffloadConfig
related:
  - --cpu-offload-gb
  - --cpu-offload-params
  - --offload-group-size
  - --offload-num-in-group
  - --offload-prefetch-step
  - --offload-params
---

# --offload-backend

## Кратко

`--offload-backend` выбирает между двумя несовместимыми механизмами выгрузки весов модели в хостовую RAM. У каждого своя группа настроек, и настройки чужой группы просто игнорируются.

Сам по себе аргумент ничего не включает: при `auto` (дефолт) выгрузка появляется только если задан `--cpu-offload-gb` или `--offload-group-size`. Явное значение полезно ровно в двух случаях — когда заданы поля обеих групп и нужно снять неоднозначность, и когда нужно, чтобы конфигурация не меняла смысл при редактировании соседних флагов.

## Оригинальная справка

```text
The backend for weight offloading. Options:
- "auto": Selects based on which sub-config has non-default values
  (prefetch if offload_group_size > 0, uva if cpu_offload_gb > 0).
- "uva": UVA (Unified Virtual Addressing) zero-copy offloading.
- "prefetch": Async prefetch with group-based layer offloading.
```

## Паспорт аргумента

- Флаги: `--offload-backend`
- Группа argparse: `OffloadConfig`
- Тип значения: строка из фиксированного перечня (`Literal`)
- Допустимые значения: `auto`, `uva`, `prefetch`
- Значение по умолчанию: `auto`
- Эффективное значение: `auto` разрешается в `create_offloader` — `prefetch`, если `--offload-group-size > 0`; иначе `uva`, если `--cpu-offload-gb > 0`; иначе выгрузки нет (`NoopOffloader`)
- Где объявлен: `vllm/config/offload.py:OffloadConfig.offload_backend`
- Этап применения: `create_engine_config` (валидация `OffloadConfig`) → `GPUModelRunner.__init__` (`create_offloader`) → загрузка модели

## Что меняет в движке

`create_offloader(offload_config)` в `vllm/model_executor/offloader/base.py` — единственное место, где значение читается. Он возвращает один из трех объектов, и этот объект становится глобальным синглтоном процесса (`set_offloader`), который затем вызывается из `make_layers()` при построении модели:

- `NoopOffloader` — слои возвращаются как есть;
- `UVAOffloader(cpu_offload_max_bytes, cpu_offload_params)` — параметры переезжают в pinned RAM, на устройстве остается UVA-view; GPU читает веса по PCIe при каждом обращении;
- `PrefetchOffloader(group_size, num_in_group, prefetch_step, offload_params, mode="cpu")` — параметры хранятся в CPU, на GPU выделяется пул статических буферов, а forward выгруженных слоев обвешивается парой custom ops `wait_prefetch`/`start_prefetch`, которые ведут асинхронное копирование в отдельном CUDA-потоке.

Разница по существу. UVA не делает явных копий вообще — это чтение из хостовой памяти по требованию, стоимость размазана по всему forward и не скрывается ничем. Prefetch делает явные H2D-копии заранее, в фоне, и может спрятать их за вычислениями невыгруженных слоев — но за это платит GPU-памятью под буферы и работает только при регулярной групповой раскладке слоев.

Валидатор `OffloadConfig.validate_offload_config` выдает предупреждения при смешивании групп:

- `uva` + заданный `offload_group_size` → `Prefetch offload fields are set but offload_backend='uva'. Prefetch settings will be ignored.`
- `prefetch` + заданный `cpu_offload_gb` → `UVA offload fields are set but offload_backend='prefetch'. UVA settings will be ignored.`
- `auto` + оба заданы → `Both UVA and prefetch offload fields are set with offload_backend='auto'. Prefetch backend will be selected. Set offload_backend explicitly to suppress this warning.`

Все три идут через `warnings.warn`, а не через логгер движка, поэтому в отфильтрованном логе они выглядят как питоновские `UserWarning`, а не как строки vLLM.

Отдельная ловушка: `--offload-backend prefetch` **без** `--offload-group-size` всегда падает на валидации. Условие валидатора срабатывает по самому backend'у, а `offload_num_in_group` (минимум 1 по `ge=1`) неизбежно оказывается больше `offload_group_size` (0), и конфиг отвергается с `offload_num_in_group (1) must be <= offload_group_size (0)`. Симметричный случай мягче: `--offload-backend uva` без `--cpu-offload-gb` стартует нормально, но не выгружает ничего — бюджет нулевой.

## Значения и формат

- `auto` — выбор по заданным полям. Значение `None` перечень не допускает: аргумент не `optional`.
- `uva` — только `--cpu-offload-gb` и `--cpu-offload-params`.
- `prefetch` — только `--offload-group-size`, `--offload-num-in-group`, `--offload-prefetch-step`, `--offload-params`.
- Любое другое значение отвергает argparse на разборе строки, до загрузки модели.

## Когда использовать

- Задавайте явно, если в конфигурации инстанса присутствуют поля обеих групп: при `auto` выигрывает prefetch, и это редко то, чего хотели.
- `uva` — когда выгружается небольшая доля весов и важна простота: нет дополнительного расхода VRAM под буферы, нет требований к регулярности слоев.
- `prefetch` — когда выгружается заметная доля слоев и есть запас VRAM под буферный пул: только этот режим способен скрыть передачу за вычислениями.
- Оставляйте `auto`, если задана ровно одна группа полей — это самый читаемый вариант.

## Влияние на производительность и память

Сам селектор ресурсов не потребляет. Через выбор реализации он определяет:

- **VRAM.** `uva` не занимает на устройстве ничего сверх view. `prefetch` выделяет статический пул размером `prefetch_step × объем параметров одного выгруженного слоя`; пул аллоцируется в конце `load_model`, то есть попадает в измеренное «consumed memory» профилирования и вычитается из бюджета `--gpu-memory-utilization` до KV-cache.
- **Скорость.** У `uva` передача не перекрывается ничем; у `prefetch` — перекрывается вычислением невыгруженных слоев, если параметры группы подобраны корректно.
- **Кэш компиляции.** `OffloadConfig.compute_hash()` входит в `VllmConfig.compute_hash`, и в нем учитываются **все** поля, включая сам backend: смена значения вызывает повторную компиляцию модели при старте.

## Взаимодействие с другими аргументами

- `--cpu-offload-gb`, `--cpu-offload-params`: активны только при `uva` (или `auto` без prefetch-полей).
- `--offload-group-size`, `--offload-num-in-group`, `--offload-prefetch-step`, `--offload-params`: активны только при `prefetch` (или `auto` при `--offload-group-size > 0`).
- Ни один из двух режимов не комбинируется с другим: это `if/elif` в `create_offloader`, а не объединение.

## Типовые проблемы и диагностика

- **Симптом:** `offload_num_in_group (1) must be <= offload_group_size (0)` при старте. **Причина:** задан `--offload-backend prefetch` без `--offload-group-size`. **Лечение:** задать группу либо выбрать `uva`.
- **Симптом:** ничего не выгружается, лог молчит. **Причина:** `--offload-backend uva` при нулевом `--cpu-offload-gb`, либо `auto` без обоих полей. **Проверка:** отсутствие строки `Offloader set to ...` на уровне INFO. **Лечение:** задать бюджет.
- **Симптом:** `UserWarning: Both UVA and prefetch offload fields are set with offload_backend='auto'.` **Причина:** заданы поля обеих групп. **Лечение:** выставить backend явно.
- **Подтверждение принятого значения:** строка `Offloader set to UVAOffloader` или `Offloader set to PrefetchOffloader` (INFO, один раз); для prefetch дополнительно `[PrefetchOffloader] Initialized N modules. Total GPU memory saved: X GB, Static buffer pool: Y GB (group_size=..., num_in_group=..., prefetch_step=..., mode=cpu)`.
- **Симптом:** каждый рестарт заново компилирует модель. **Причина:** поля offload меняются между запусками и входят в ключ кэша. **Лечение:** зафиксировать конфигурацию инстанса.

## Примеры

```bash
vllm serve /models/Qwen3-4B --offload-backend uva --cpu-offload-gb 6
```

```bash
vllm serve /models/Qwen3-4B --offload-backend prefetch --offload-group-size 8 --offload-num-in-group 2 --offload-prefetch-step 2
```

## Источники

- `vllm/vllm/config/offload.py`
- `vllm/vllm/model_executor/offloader/base.py`
- `vllm/vllm/model_executor/offloader/uva.py`
- `vllm/vllm/model_executor/offloader/prefetch.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
