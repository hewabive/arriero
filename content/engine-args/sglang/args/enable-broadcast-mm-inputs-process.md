---
schema: 1
engine: sglang
primaryName: "--enable-broadcast-mm-inputs-process"
title: "--enable-broadcast-mm-inputs-process"
summary: Материализует `MultimodalInputs` только на нулевом ранге группы и рассылает готовый объект остальным вместо того, чтобы каждый scheduler-ранг делал ту же CPU-работу. Смысл имеет только при TP > 1.
group: mm
related:
  - --tp-size
  - --enable-dp-attention
  - --mm-feature-transport
  - --enable-multimodal
  - --dp-size
---

# --enable-broadcast-mm-inputs-process

## Кратко

Процесс scheduler'а однопоточный: любая тяжелая CPU-работа в его главном цикле задерживает обработку всех остальных сообщений и, как отмечено в самом коде, при загрузке CPU под 100 % удлиняет запуск CUDA-ядер. Разбор мультимодальных входов (`MultimodalInputs.from_processor_output`) на TP > 1 по умолчанию выполняется **на каждом ранге одинаково**. Флаг переносит его на нулевой ранг группы и рассылает готовый объект через CPU-коллектив.

## Оригинальная справка

```text
Enable broadcast mm-inputs process in scheduler.
```

## Паспорт аргумента

- Флаги: `--enable-broadcast-mm-inputs-process`
- Группа: `mm`
- Тип значения: bool, `action="store_true"`
- Допустимые значения: значения не принимает — флаг присутствия
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.enable_broadcast_mm_inputs_process`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: обработка каждого входящего мультимодального запроса в процессе scheduler'а

## Что меняет в движке

Точка ветвления — `Scheduler._get_multimodal_inputs` (`sglang/python/sglang/srt/managers/scheduler.py`):

```python
if get_mm().enable_broadcast_mm_inputs_process:
    return self._process_and_broadcast_mm_inputs(mm_inputs)
return MultimodalInputs.from_processor_output(mm_inputs)
```

В обычном режиме каждый scheduler-ранг получает сырой словарь от процессора и сам вызывает `from_processor_output`. Эта функция делает не так мало: отбрасывает невалидные элементы, реконструирует CUDA-IPC-прокси в тензоры, вычисляет `pad_value` (а значит и контентный хеш признаков — SHA-256 по байтам), опционально прогоняет признаки через GPU-буфер ускорения хеширования (`SGLANG_MM_BUFFER_SIZE_MB`) и собирает итоговый `MultimodalInputs`. Для больших изображений хеширование заметно.

С флагом работает `_process_and_broadcast_mm_inputs`:

- определяется размер группы `dp_tp_cpu_group` (при недоступности `torch.distributed` пишется предупреждение `Failed to get world size in mm_inputs handling with ..., fallback to 1.` и путь вырождается в локальный);
- ранг `dp_tp_group.rank_in_group == 0` строит `MultimodalInputs` один раз и рассылает его `torch.distributed.broadcast_object_list` по **CPU**-группе (`src = dp_tp_group.first_rank`);
- остальные ранги получают объект вместо того, чтобы строить его;
- при размере группы 1 обе ветки материализуют объект локально, то есть выигрыша нет.

Что именно летит по сети, зависит от `--mm-feature-transport`: при `cuda_ipc` и при CPU-транспорте с `/dev/shm` в объекте лежат хендлы и указатели, и рассылка дешевая. При inline-транспорте (многоузловое развертывание с заданным `--dist-init-addr`) в объекте лежат сами тензоры признаков, и `broadcast_object_list` погонит их целиком через gloo — тогда флаг может оказаться дороже дублирования работы.

## Значения и формат

- Флаг без значения; отключается только его отсутствием.
- Никаких параметров у механизма нет: группа, источник и транспорт выбираются автоматически.

## Когда использовать

- TP ≥ 2 и заметная доля мультимодального трафика с крупными признаками: в профиле scheduler-рангов видно, что CPU главного цикла занят хешированием одних и тех же тензоров N раз.
- Признаки едут по `cuda_ipc` или через `/dev/shm` — тогда рассылка почти бесплатна.
- **Не включайте** при `--tp-size 1`: обе ветки делают одно и то же.
- **Осторожно** на многоузловом развертывании с inline-транспортом признаков: рассылка тяжелых тензоров по gloo может съесть весь выигрыш.
- Флаг не документирован в апстрим-руководствах и никак не подтверждается стартовым логом; относитесь к нему как к оптимизации, которую нужно измерять, а не как к настройке по умолчанию.

## Влияние на производительность и память

- CPU процессов scheduler'а: работа `from_processor_output` выполняется один раз вместо `tp_size` раз. Это разгружает именно тот однопоточный цикл, задержки в котором выливаются в рост latency всех запросов.
- Сеть/межпроцессное взаимодействие: добавляется один `broadcast_object_list` по CPU-группе на каждый мультимодальный запрос. Объем — размер пиклированного `MultimodalInputs`.
- Синхронизация: коллектив блокирующий, поэтому ранги выравниваются на этой точке; при неоднородной нагрузке это добавляет ожидание.
- Память: постоянного расхода нет, только временный буфер пиклированного объекта на каждом ранге.
- На VRAM и на размер KV-пула не влияет.

## Взаимодействие с другими аргументами

- `--tp-size`: единственный источник выигрыша; при 1 флаг инертен.
- `--enable-dp-attention`, `--dp-size`: рассылка идет по `dp_tp_group`/`dp_tp_cpu_group`, то есть внутри DP-подгруппы, а не по всему миру.
- `--mm-feature-transport`: определяет, что именно попадет в пиклированный объект — хендлы или сами тензоры.
- `--enable-multimodal`: без мультимодального тракта ветка не достигается.

## Типовые проблемы и диагностика

- `Failed to get world size in mm_inputs handling with <err>, fallback to 1.` — не удалось определить размер группы; путь свелся к локальной материализации на каждом ранге.
- Зависание на мультимодальном запросе при TP > 1 — коллектив блокирующий, и если один ранг по какой-то причине не дошел до него, встанут все. Смотрите, все ли scheduler-процессы живы.
- Ускорения нет: проверьте `--tp-size` и то, что признаки действительно тяжелые. При мелких картинках стоимость `from_processor_output` пренебрежима.
- Отдельной строки в логе у флага нет; факт применения проверяется только по дампу `server_args=` при старте и по профилю CPU scheduler-рангов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-8B-Instruct --tp-size 4 --enable-broadcast-mm-inputs-process
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-VL-30B-A3B-Instruct --tp-size 4 --enable-broadcast-mm-inputs-process --mm-feature-transport cuda_ipc
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/schedule_batch.py`
- `sglang/python/sglang/srt/managers/mm_utils.py`
- `sglang/python/sglang/srt/managers/scheduler_components/request_receiver.py`
