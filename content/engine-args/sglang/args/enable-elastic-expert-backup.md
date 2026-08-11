---
schema: 1
engine: sglang
primaryName: "--enable-elastic-expert-backup"
title: "--enable-elastic-expert-backup"
summary: Поднимает отдельный процесс, который держит копию весов экспертов в хостовой RAM и отдает их по RDMA, чтобы восстановление раскладки после падения ранга не читало веса с диска. Работает только вместе с `--elastic-ep-backend` и несовместим с рантайм-расширением EP.
group: exec.moe
related:
  - --elastic-ep-backend
  - --mooncake-ib-device
  - --disaggregation-ib-device
  - --max-ep-size
  - --enable-eplb
  - --nnodes
  - --ep-num-redundant-experts
---

# --enable-elastic-expert-backup

## Кратко

Когда elastic EP восстанавливает выпавший ранг или EPLB переставляет экспертов, часть весов может не найтись ни на одном живом ранге. Штатный путь в этом случае — дочитать их с диска, что на крупной MoE-модели занимает минуты. Флаг включает альтернативу: на каждом узле стартует процесс-хранитель, который заранее вычитывает свою долю весов экспертов в один непрерывный CPU-буфер, регистрирует его в Mooncake transfer engine и отдает по RDMA. Восстановление тогда идет из чужой RAM, а не с диска.

## Оригинальная справка

```text
Enable elastic expert backup feature.
```

## Паспорт аргумента

- Флаги: `--enable-elastic-expert-backup`
- Группа: `exec.moe`
- Тип значения: булев флаг (`store_true`); парного `--no-*` нет
- Допустимые значения: наличие или отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но игнорируется без `--elastic-ep-backend`: и запуск процесса-хранителя, и создание клиента гейтятся условием «флаг И задан бэкенд elastic EP»
- Где объявлен: `ServerArgs.enable_elastic_expert_backup`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, часть молодой подсистемы elastic EP
- Этап применения: `__post_init__` (проверка несовместимости с расширением) → запуск процессов движка (`run_expert_backup_manager`) → инициализация model runner (`maybe_init_expert_backup_client`) → перебалансировка/восстановление

## Что меняет в движке

**Процесс-хранитель.** `Engine` после запуска планировщиков стартует отдельный `multiprocessing.Process` с `ExpertBackupManager` (`sglang/python/sglang/srt/elastic_ep/expert_backup_manager.py`). Он инициализирует собственный Mooncake transfer engine (адрес IB-устройства берется как `--disaggregation-ib-device`, иначе `--mooncake-ib-device`), проходит итератором по весам модели, отбирает эксперты своей доли (`n_routed_experts // nnodes` подряд, по `--node-rank`), копирует их в один буфер `torch.uint8` на CPU, регистрирует его в transfer engine и публикует карту указателей по ZMQ. Порты — от `SGLANG_BACKUP_PORT_BASE`, по два на узел. Дальше процесс просто живет до сигнала.

**Клиент.** Каждый воркер model runner создает `ExpertBackupClient`: подписывается на публикации всех узлов, регистрирует собственные параметры модели в transfer engine и, получив карты указателей, выставляет `use_backup = True`. Если регистрация памяти не удалась, в лог уходит `Register fails. Stop using expert weight backup!`, и клиент молча деградирует к обычному пути.

**Использование.** В `update_expert_location_with_recovery` (`sglang/python/sglang/srt/eplb/eplb_manager.py`) после переноса весов между рангами остается список логических экспертов, которых не нашлось у соседей. Если клиент бэкапа активен, недостающие веса тянутся из DRAM-копии; иначе вызывается обычная загрузка с диска.

**Транспорт.** Комбинация флага и заданного `--elastic-ep-backend` сама по себе включает инициализацию Mooncake transfer engine в основных процессах, даже если бэкендом elastic EP выбран `nixl`.

## Значения и формат

- Флаг без значения. Отсутствие — недостающие веса читаются с диска.
- Флаг без `--elastic-ep-backend` не делает ничего: ни процесс-хранитель, ни клиент не создаются. Предупреждения об этом нет.
- Флаг требует установленного `mooncake-transfer-engine` — отказ будет на импорте внутри процесса-хранителя, а не при разборе аргументов.

## Когда использовать

- Многоузловая EP-развертка на RDMA, где восстановление после падения ранга должно занимать секунды, а не минуты, и где есть свободная хостовая RAM под копию весов экспертов.
- Вместе с `--enable-eplb`: именно перебалансировка после смены маски живых рангов чаще всего и обнаруживает недостающих экспертов.
- Не включайте, если планируете рантайм-расширение EP: `_handle_elastic_ep` отвергает такую комбинацию ассертом.
- Не включайте на одном узле: доля экспертов узла тогда равна всей модели, а восстанавливать не у кого.
- Не включайте при жестком лимите хостовой памяти — см. ниже.

## Влияние на производительность и память

- **RAM хоста.** Основная цена. Буфер равен суммарному размеру весов экспертов с индексами `[n_routed_experts / nnodes * node_rank, ...)` в dtype модели. Для DeepSeek-V3 на двух узлах это половина всех экспертных весов на узел — десятки-сотни гигабайт. Память выделяется на старте и удерживается все время работы. В arriero это надо учитывать в host-пуле (`docs/RESOURCE_MANAGEMENT.md`), потому что автоматически такой расход не оценивается.
- **Регистрация RDMA.** Буфер и все параметры модели регистрируются в transfer engine; это pinned-память со стороны драйвера.
- **Время старта.** Процесс-хранитель отдельно вычитывает веса модели с диска, параллельно основной загрузке. На медленном хранилище это удваивает нагрузку на ввод-вывод при старте.
- **Установившийся режим.** Накладных расходов нет: буфер только лежит.
- **Восстановление.** Выигрыш измеряется в разнице «RDMA из чужой RAM» против «чтение весов с диска», то есть обычно в порядок.

## Взаимодействие с другими аргументами

- `--elastic-ep-backend`: обязателен, иначе флаг инертен.
- `--max-ep-size` (точнее, активное рантайм-расширение): несовместим — `AssertionError: Elastic EP runtime scale-up does not support --enable-elastic-expert-backup.`
- `--mooncake-ib-device` и `--disaggregation-ib-device`: задают IB-устройства для transfer engine процесса-хранителя; приоритет у `--disaggregation-ib-device`.
- `--nnodes` и `--node-rank`: делят экспертов между хранителями.
- `--enable-eplb`: основной потребитель бэкапа.
- `--ep-num-redundant-experts`: реплики уменьшают вероятность, что эксперт не найдется у соседей.

## Типовые проблемы и диагностика

- `AssertionError: Elastic EP runtime scale-up does not support --enable-elastic-expert-backup.` — уберите флаг либо `--max-ep-size`.
- `RuntimeError: Mooncake memory registration failed.` в процессе-хранителе — не хватило регистрируемой памяти или неверно указано IB-устройство.
- `Register fails. Stop using expert weight backup!` в логе воркера — клиент отключил бэкап, восстановление пойдет с диска. Это предупреждение, а не отказ.
- Хост уходит в своп сразу после старта — буфер копии не поместился; посчитайте размер долей экспертов по числу узлов.
- Старт завис на ожидании клиентов — хранитель блокируется, пока не отчитаются все `--tp-size` клиентов узла; проверьте, что порты от `SGLANG_BACKUP_PORT_BASE` не заняты и доступны между узлами.
- `ValueError: experimental_sgl_marlin EP requires trivial expert placement without redundancy, EPLB, or elastic EP` — флаг несовместим с экспериментальным LoRA-раннером `experimental_sgl_marlin`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --pp-size 1 --nnodes 2 --node-rank 0 --dist-init-addr 10.0.0.1:20000 --moe-a2a-backend deepep --deepep-mode normal --elastic-ep-backend mooncake --mooncake-ib-device mlx5_0,mlx5_1 --enable-elastic-expert-backup --enable-eplb
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --pp-size 1 --nnodes 2 --node-rank 1 --dist-init-addr 10.0.0.1:20000 --moe-a2a-backend deepep --deepep-mode normal --elastic-ep-backend mooncake --mooncake-ib-device mlx5_0,mlx5_1 --enable-elastic-expert-backup --enable-eplb
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/elastic_ep/expert_backup_manager.py`
- `sglang/python/sglang/srt/elastic_ep/expert_backup_client.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/distributed/device_communicators/mooncake_transfer_engine.py`
- `sglang/python/sglang/srt/lora/marlin_lora_temp/policy.py`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
