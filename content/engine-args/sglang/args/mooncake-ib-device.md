---
schema: 1
engine: sglang
primaryName: "--mooncake-ib-device"
title: "--mooncake-ib-device"
summary: Задает InfiniBand-устройства, через которые работает Mooncake transfer engine, — общим списком или картой «GPU → устройства». Проверяется по `/sys/class/infiniband` на старте, но только при `--elastic-ep-backend mooncake`; во всех остальных потребителях приоритет у `--disaggregation-ib-device`.
group: exec.moe
related:
  - --elastic-ep-backend
  - --disaggregation-ib-device
  - --enable-elastic-expert-backup
  - --moe-a2a-backend
---

# --mooncake-ib-device

## Кратко

Mooncake transfer engine — общий RDMA-транспорт SGLang, который используется несколькими подсистемами сразу: elastic EP, DRAM-бэкапом весов экспертов, PD-дизагрегацией, hierarchical cache со storage-бэкендом mooncake и передачей мультимодальных признаков. Этот аргумент говорит транспорту, какими сетевыми устройствами пользоваться. Не задан — устройство подбирается автоматически, что на хосте с несколькими HCA нередко дает не тот адаптер.

## Оригинальная справка

```text
The InfiniBand devices for Mooncake Backend transfer, accepts multiple comma-separated devices (e.g., --mooncake-ib-device mlx5_0,mlx5_1). Default is None, which triggers automatic device detection when Mooncake Backend is enabled.
```

## Паспорт аргумента

- Флаги: `--mooncake-ib-device`
- Группа: `exec.moe`
- Тип значения: str — список через запятую, JSON-карта «id GPU → список устройств» или путь к `.json` с такой картой
- Допустимые значения: `choices` нет; имена устройств проверяются по содержимому `/sys/class/infiniband`
- Значение по умолчанию: `null` — автоопределение на стороне Mooncake
- Эффективное значение: при `--elastic-ep-backend mooncake` значение прогоняется через `_validate_ib_devices` в `__post_init__`, нормализуется (пробелы срезаются, дубликаты удаляются с предупреждением, JSON-карта переписывается компактно) и записывается обратно в поле. При других значениях `--elastic-ep-backend` (и без него) нормализация не выполняется — строка уходит в транспорт как есть
- Где объявлен: `ServerArgs.mooncake_ib_device`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (только ветка `mooncake`) → инициализация Mooncake transfer engine в воркерах и в процессе бэкапа экспертов

## Что меняет в движке

Значение попадает в `init_mooncake_transfer_engine(...)` в виде параметра `ib_device`, причем во всех известных точках вызова через выражение `--disaggregation-ib-device` **или** `--mooncake-ib-device`: если задан первый, второй игнорируется. Разбор формата делает `parse_ib_device_config` (`sglang/python/sglang/srt/distributed/device_communicators/mooncake_transfer_engine.py`):

- строка без ведущей `{` и без суффикса `.json` считается общим списком устройств для всех GPU;
- строка, начинающаяся с `{`, разбирается как JSON-карта: ключи — целые номера GPU (допустимы строковые записи чисел), значения — списки устройств через запятую;
- строка, оканчивающаяся на `.json`, читается как файл с такой картой; отсутствие файла дает `RuntimeError: File ... does not exist.`

Валидация в `ServerArgs._validate_ib_devices` (выполняется только при `--elastic-ep-backend mooncake`) дополнительно:

- требует наличия каталога `/sys/class/infiniband` (`RuntimeError: InfiniBand sysfs path not found`) и непустого списка устройств в нем;
- сверяет каждое имя со списком из sysfs и падает `ValueError: Invalid IB devices specified for ...: [...]. Available devices: [...]`;
- при `null` печатает `No IB devices specified for Mooncake backend, falling back to auto discovery.` и оставляет `null`.

Транспорт инициализируется не всегда, а когда включен хотя бы один его потребитель. Для группы `exec.moe` это `--elastic-ep-backend mooncake` и связка `--enable-elastic-expert-backup` с любым заданным `--elastic-ep-backend`. Процесс-хранитель бэкапа экспертов создает свой экземпляр транспорта с тем же аргументом.

## Значения и формат

- `mlx5_0,mlx5_1` — общий список для всех GPU процесса. Пробелы вокруг запятых допустимы, дубликаты вычищаются с предупреждением.
- `{"0":"mlx5_0","1":"mlx5_1"}` — привязка устройства к номеру GPU. Нужна на хостах, где HCA распределены по PCIe-корням и важна NUMA/PCIe-близость.
- `/etc/sglang/ib.json` — тот же JSON, вынесенный в файл.
- Не задан — автоопределение внутри Mooncake. На одном HCA это нормально; на нескольких — источник трудноуловимой асимметрии пропускной способности.
- Имена берутся ровно из `ls /sys/class/infiniband` (`mlx5_0`, `mlx5_bond_0` и подобные), а не из имен сетевых интерфейсов вроде `ib0`.

## Когда использовать

- На узле несколько HCA, и вы хотите гарантировать, что каждая GPU ходит через ближайшую: JSON-карта.
- Часть адаптеров отдана под другой трафик (например, хранилище): общий список только с нужными устройствами.
- Одновременно включена PD-дизагрегация: задавайте `--disaggregation-ib-device` — он перекроет этот аргумент во всех точках инициализации транспорта, и держать два разных значения бессмысленно.
- Не задавайте аргумент, если Mooncake transfer engine у вас вообще не поднимается: он будет молча проигнорирован.

## Влияние на производительность и память

- Выбор HCA определяет реальную пропускную способность RDMA-переноса при восстановлении рангов elastic EP и при подтягивании весов из DRAM-бэкапа. Ошибка в привязке дает не отказ, а деградацию.
- На VRAM аргумент не влияет. На хостовую память — только косвенно, через регистрацию буферов в transfer engine.
- Валидация на старте стоит одного чтения каталога sysfs.

## Взаимодействие с другими аргументами

- `--disaggregation-ib-device`: имеет приоритет во всех местах, где транспорт инициализируется; проходит ту же нормализацию, но в своей ветке `__post_init__`.
- `--elastic-ep-backend`: только значение `mooncake` включает валидацию этого аргумента.
- `--enable-elastic-expert-backup`: второй потребитель транспорта в группе `exec.moe`; процесс-хранитель читает тот же аргумент.
- `--moe-a2a-backend mooncake`: отдельная настройка (a2a-диспетчер MoE), не путайте ее с `--elastic-ep-backend mooncake`; аргумент относится к транспорту, а не к a2a.

## Типовые проблемы и диагностика

- `RuntimeError: InfiniBand sysfs path not found: /sys/class/infiniband. Please ensure InfiniBand drivers are installed.` — на хосте нет IB-стека; уберите аргумент или установите драйверы.
- `ValueError: Invalid IB devices specified for all GPUs: ['ib0']. Available devices: ['mlx5_0', 'mlx5_1']` — указаны имена сетевых интерфейсов вместо имен устройств из sysfs.
- `ValueError: Invalid format: expected a mapping from GPU id to IB device string` — JSON-карта не является объектом.
- `RuntimeError: File /path/ib.json does not exist.` — путь виден не на всех узлах.
- `No IB devices specified for Mooncake backend, falling back to auto discovery.` — аргумент не задан, транспорт выберет устройство сам.
- Предупреждение `Duplicate IB devices specified for ...` — дубликаты в списке; движок их вычистил.
- Итоговое нормализованное значение видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --pp-size 1 --moe-a2a-backend deepep --deepep-mode normal --elastic-ep-backend mooncake --mooncake-ib-device mlx5_0,mlx5_1
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --pp-size 1 --moe-a2a-backend deepep --deepep-mode normal --elastic-ep-backend mooncake --mooncake-ib-device '{"0":"mlx5_0","1":"mlx5_1","2":"mlx5_2","3":"mlx5_3"}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/device_communicators/mooncake_transfer_engine.py`
- `sglang/python/sglang/srt/elastic_ep/expert_backup_manager.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
