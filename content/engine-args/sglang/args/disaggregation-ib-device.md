---
schema: 1
engine: sglang
primaryName: "--disaggregation-ib-device"
title: "--disaggregation-ib-device"
summary: Явный выбор InfiniBand/RoCE HCA для mooncake-переноса KV: общий список, JSON-карта «GPU → устройства» или путь к JSON-файлу. Не задан — mooncake ищет устройства сам; проверка идет по `/sys/class/infiniband` и падает, если каталога нет.
group: disagg
related:
  - --disaggregation-mode
  - --disaggregation-transfer-backend
  - --encoder-transfer-backend
  - --base-gpu-id
  - --tp-size
  - --enable-mm-global-cache
---

# --disaggregation-ib-device

## Кратко

Аргумент влияет ровно на один backend — mooncake — и только когда он реально задействован: либо `--disaggregation-transfer-backend mooncake` при `--disaggregation-mode prefill|decode`, либо `--encoder-transfer-backend mooncake`. Значение валидируется **на старте**, до всякой передачи: SGLang читает `/sys/class/infiniband`, сверяет каждое имя со списком существующих устройств и нормализует результат. Отсутствие каталога — жесткая ошибка, а не деградация к TCP.

## Оригинальная справка

```text
The InfiniBand devices for disaggregation transfer. Supports a single device (e.g., --disaggregation-ib-device mlx5_0), a shared comma-separated list (e.g., --disaggregation-ib-device mlx5_0,mlx5_1), a per-GPU JSON mapping (e.g., --disaggregation-ib-device '{"0": "mlx5_0,mlx5_1", "1": "mlx5_2"}'), or a path to a JSON file containing that mapping. Default is None, which triggers automatic device detection when mooncake backend is enabled.
```

## Паспорт аргумента

- Флаги: `--disaggregation-ib-device`
- Группа: `disagg`
- Тип значения: str (`Optional[str]`) в трех формах: список через запятую, JSON-объект, путь к `.json`-файлу
- Допустимые значения: `choices` нет; фактический список ограничен содержимым `/sys/class/infiniband` на конкретном хосте — посмотреть его можно `ls /sys/class/infiniband`
- Значение по умолчанию: `null` (не задан) — mooncake ищет устройства сам
- Эффективное значение: переписывается `_validate_ib_devices` в **нормализованную** строку — дубликаты убираются, пробелы срезаются, JSON пересобирается компактно (`json.dumps(..., separators=(",", ":"))`). При `--disaggregation-transfer-backend mooncake_tcp` значение принудительно сбрасывается в `None` еще раньше, в `handle_pd_disaggregation`
- Где объявлен: `ServerArgs.disaggregation_ib_device`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_pd_disaggregation` (сброс при `mooncake_tcp`) → `_handle_encoder_disaggregation` → `_validate_ib_devices` (чтение sysfs, нормализация) → `MooncakeTransferEngine.__init__` на каждом ранге, где устройство выбирается по `gpu_id`

## Что меняет в движке

Строка разбирается `parse_ib_device_config` (`distributed/device_communicators/mooncake_transfer_engine.py`) по трем веткам:

1. значение не начинается с `{` и не заканчивается на `.json` → трактуется как общий список устройств для всех GPU;
2. заканчивается на `.json` → файл читается с диска; отсутствие файла — `RuntimeError: File ... does not exist.`;
3. начинается с `{` → парсится как JSON-объект `{"<gpu_id>": "<devices>"}`.

Дальше `_validate_ib_devices` в `ServerArgs`:

- проверяет наличие каталога `/sys/class/infiniband`, иначе `RuntimeError: InfiniBand sysfs path not found: /sys/class/infiniband. Please ensure InfiniBand drivers are installed.`;
- проверяет, что каталог не пуст, иначе `RuntimeError: No IB devices found in /sys/class/infiniband`;
- для каждой группы устройств убирает дубликаты (с предупреждением `Duplicate IB devices specified for ...`) и сверяет имена с содержимым sysfs, иначе `ValueError: Invalid IB devices specified for ...: [...]. Available devices: [...]`.

Если значение не задано, вместо всего этого печатается `No IB devices specified for Mooncake backend, falling back to auto discovery.` и выбор HCA остается за mooncake.

Во время работы каждый ранг выбирает свою группу устройств по `gpu_id` через `get_ib_devices_for_gpu` — отсюда смысл per-GPU-карты: на многокарточном узле привязка HCA к GPU по PCIe-топологии заметно влияет на пропускную способность.

## Значения и формат

- Одно устройство: `mlx5_0`. Общий список: `mlx5_0,mlx5_1` (разделитель — запятая, пробелы вокруг допускаются и срезаются).
- Per-GPU карта: `'{"0": "mlx5_0,mlx5_1", "1": "mlx5_2"}'`. Ключи — целые числа (или их строковые представления), значения — строки; иное дает `ValueError: Invalid format: keys must be integers ... and values must be strings`.
- Путь к файлу распознается **только по суффиксу `.json`**. Файл содержит тот же объект.
- Ключи карты — это `gpu_id` в нумерации процесса, то есть после `CUDA_VISIBLE_DEVICES` и с учетом `--base-gpu-id`.
- Пустая строка после `strip()` — `ValueError: No valid IB devices specified`.
- Имена — это имена устройств из `/sys/class/infiniband` (`mlx5_0`, `mlx5_roce0`, …), а не имена сетевых интерфейсов (`ib0`, `eth0`).

## Когда использовать

- Многокарточный узел с несколькими HCA: задавайте per-GPU-карту в соответствии с PCIe-топологией (`nvidia-smi topo -m`), иначе автоподбор может увести трафик через дальний коммутатор.
- Хост, где часть HCA занята под другую сеть (хранилище, управление): явный список не даст mooncake ее захватить.
- Одна карта и один HCA: можно не задавать — автоподбор справится.
- Не задавайте при `--disaggregation-transfer-backend mooncake_tcp`: значение все равно обнулится, а вы получите ложное ощущение, что RDMA настроена.
- Не задавайте при `nixl`/`mori`/`ascend`/`fake` — там аргумент просто не читается.

## Влияние на производительность и память

- На VRAM и RAM не влияет: выбирается только устройство переноса.
- На пропускную способность KV-transfer'а влияет сильно и напрямую: неверная привязка GPU↔HCA дает переход через хостовый PCIe-корень и кратную потерю на длинных промптах.
- На время старта влияет пренебрежимо: чтение sysfs и нормализация строки.

## Взаимодействие с другими аргументами

- `--disaggregation-transfer-backend mooncake`: единственная комбинация, при которой значение проверяется в PD-режиме.
- `--disaggregation-transfer-backend mooncake_tcp`: значение сбрасывается в `None`, RDMA не используется.
- `--encoder-transfer-backend mooncake`: второй путь, при котором валидация включается, — уже вне PD, для переноса выходов энкодера.
- `--disaggregation-mode`: без `prefill`/`decode` (и без mooncake-энкодера) значение игнорируется.
- `--base-gpu-id`: сдвигает нумерацию GPU, по которой раскладывается per-GPU-карта.
- `--tp-size`: количество рангов на узле определяет, сколько записей карты реально понадобится.

## Типовые проблемы и диагностика

- `RuntimeError: InfiniBand sysfs path not found: /sys/class/infiniband. Please ensure InfiniBand drivers are installed.` — на хосте нет RDMA-стека. Либо ставьте драйверы, либо переходите на `mooncake_tcp`.
- `RuntimeError: No IB devices found in /sys/class/infiniband` — каталог есть, устройств нет (например в контейнере не проброшены `/dev/infiniband/*`).
- `ValueError: Invalid IB devices specified for all GPUs: ['mlx5_9']. Available devices: ['mlx5_0', 'mlx5_1']` — опечатка или устройство недоступно этому контейнеру.
- `RuntimeError: File /path/devices.json does not exist.` — путь распознан как файл (по суффиксу `.json`), но его нет.
- `ValueError: Invalid JSON mapping: {...}` — синтаксис JSON; в shell не забудьте одинарные кавычки вокруг всего объекта.
- Предупреждение `No IB devices specified for Mooncake backend, falling back to auto discovery.` — нормальное поведение при незаданном значении; если после него transfer идет медленно, задайте устройства явно.
- Принятое (уже нормализованное) значение видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode prefill --disaggregation-transfer-backend mooncake --disaggregation-ib-device mlx5_0,mlx5_1 --port 30000 --tp-size 8
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode decode --disaggregation-transfer-backend mooncake --disaggregation-ib-device '{"0": "mlx5_0", "1": "mlx5_1"}' --port 30001 --tp-size 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/pd_disaggregation_hook.py`
- `sglang/python/sglang/srt/distributed/device_communicators/mooncake_transfer_engine.py`
- `sglang/python/sglang/srt/disaggregation/mooncake/conn.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
