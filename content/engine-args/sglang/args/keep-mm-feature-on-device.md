---
schema: 1
engine: sglang
primaryName: "--keep-mm-feature-on-device"
title: "--keep-mm-feature-on-device"
summary: Устаревший флаг, транслируемый в `--mm-feature-transport=cuda_ipc`. Конфликт с явным транспортом отвергается на старте; в новых конфигурациях используйте сам `--mm-feature-transport`.
group: mm
related:
  - --mm-feature-transport
  - --base-gpu-id
  - --tokenizer-worker-num
  - --nnodes
  - --enable-multimodal
---

# --keep-mm-feature-on-device

## Кратко

Исторически `--keep-mm-feature-on-device` означал «не переносить признаки мультимодальных данных на CPU, оставить их на GPU». Проблема была в том, что расход HBM при этом становился функцией трафика. Сейчас за размещение признаков отвечает `--mm-feature-transport` с **ограниченным** пулом на устройстве, а этот флаг оставлен как совместимая обертка: он просто выбирает `cuda_ipc`. В коде помечен как deprecated, справка отсылает к преемнику.

## Оригинальная справка

```text
Deprecated. Use --mm-feature-transport=cuda_ipc for bounded GPU-resident multimodal feature transport.
```

## Паспорт аргумента

- Флаги: `--keep-mm-feature-on-device`
- Группа: `mm`
- Тип значения: bool, `action="store_true"`
- Допустимые значения: значения не принимает — флаг присутствия
- Значение по умолчанию: `false`
- Эффективное значение: `_handle_multimodal_feature_transport` в конце **безусловно** выставляет `keep_mm_feature_on_device = False`, предварительно превратив флаг в `mm_feature_transport = "cuda_ipc"`
- Где объявлен: `ServerArgs.keep_mm_feature_on_device`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: устаревший. Обратите внимание: он объявлен обычным `store_true`, а не через семейство `Deprecated*Action`, поэтому предупреждение печатает не argparse, а `__post_init__`
- Этап применения: `__post_init__`, до запуска tokenizer-воркеров

## Что меняет в движке

Первым же блоком `ServerArgs._handle_multimodal_feature_transport`:

```python
if self.keep_mm_feature_on_device:
    if requested_transport == "cpu":
        raise ValueError(
            "--keep-mm-feature-on-device conflicts with "
            "--mm-feature-transport=cpu. Use only "
            "--mm-feature-transport=cuda_ipc."
        )
    requested_transport = "cuda_ipc"
    logger.warning(
        "--keep-mm-feature-on-device is deprecated; using "
        "--mm-feature-transport=cuda_ipc instead."
    )
```

Дальше выполняется обычный путь `cuda_ipc`: проверка платформы (CUDA обязательна) и единственного узла (`--nnodes 1`), выделение ограниченного пула `SGLANG_MM_FEATURE_CACHE_MB` (1024 МиБ по умолчанию) на `--base-gpu-id`, деленного между tokenizer-воркерами.

В самом конце метода поле сбрасывается:

```python
self.mm_feature_transport = requested_transport
# The bounded IPC pool owns device residency. Do not retain unpooled
# tensors after a pool miss, which would make HBM use request-dependent.
self.keep_mm_feature_on_device = False
```

То есть старая семантика «оставить тензор на устройстве вне пула» больше не существует ни в каком виде: при промахе ограниченного пула признак уходит на CPU. Процессоры читают не это поле, а `use_cuda_ipc = mm_feature_transport == "cuda_ipc"` (`base_processor.py`).

Важно и то, чего флаг **не** делает: он не увеличивает пул и не отключает CPU-фолбэк.

## Значения и формат

- Флаг без значения.
- Совместим только с `--mm-feature-transport cuda_ipc` или с его отсутствием. Явный `--mm-feature-transport cpu` (единственное другое допустимое значение) дает `ValueError` на старте.
- Значение поля после `__post_init__` всегда `False` — в дампе `server_args=` вы увидите именно `False`, даже если флаг передавали. Проверять надо `mm_feature_transport`.

## Когда использовать

- Только для совместимости: старый скрипт запуска или конфигурация, которую пока не переписали.
- В любой новой конфигурации пишите `--mm-feature-transport cuda_ipc` — это то же самое, но явно и без предупреждения.
- Если цель была «не тратить VRAM», флаг сработает ровно наоборот: он включает GPU-пул. Нужен `--mm-feature-transport cpu`.
- Учтите, что на одноузловом CUDA-развертывании `cuda_ipc` и так выбирается автоматически, так что флаг чаще всего просто дублирует поведение по умолчанию.

## Влияние на производительность и память

- Всё влияние совпадает с `--mm-feature-transport cuda_ipc`: резерв `SGLANG_MM_FEATURE_CACHE_MB` (по умолчанию 1 ГиБ) на базовой карте, вычитаемый из бюджета KV-пула, и отсутствие пары копий D2H/H2D на каждый признак.
- Само по себе указание флага не стоит ничего.
- Обещания «признаки всегда остаются на устройстве» он больше не дает: при переполнении пула транспорт падает в CPU, и это сделано намеренно, чтобы расход HBM оставался постоянным.

## Взаимодействие с другими аргументами

- `--mm-feature-transport`: преемник. `cuda_ipc` — единственное совместимое явное значение; `cpu` дает `ValueError`.
- `--nnodes`: путь `cuda_ipc` требует одного узла, иначе `ValueError: --mm-feature-transport=cuda_ipc only supports a single node.`
- `--base-gpu-id`, `--tokenizer-worker-num`: где создается пул и как делится его бюджет.
- `--enable-multimodal`: без мультимодального тракта транспорт не используется.

## Типовые проблемы и диагностика

- `ValueError: --keep-mm-feature-on-device conflicts with --mm-feature-transport=cpu. Use only --mm-feature-transport=cuda_ipc.` — заданы оба, и они противоречат.
- Предупреждение `--keep-mm-feature-on-device is deprecated; using --mm-feature-transport=cuda_ipc instead.` — единственный сигнал, что флаг был принят.
- В дампе `server_args=` поле показывает `False` — это не ошибка, а результат принудительного сброса; смотрите `mm_feature_transport`.
- Ожидали экономии VRAM, получили минус гигабайт — флаг включает GPU-пул, а не выключает его.
- Флаг мог быть удален в вашей сборке: сверьтесь с `python -m sglang.launch_server --help` установленного пакета, а не только с исходниками checkout'а.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --mm-feature-transport cuda_ipc
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --keep-mm-feature-on-device --base-gpu-id 0
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/transport/cuda_ipc.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/supported-models/multimodal_language_models.mdx`
