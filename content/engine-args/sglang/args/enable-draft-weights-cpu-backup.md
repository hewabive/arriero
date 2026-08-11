---
schema: 1
engine: sglang
primaryName: "--enable-draft-weights-cpu-backup"
title: "--enable-draft-weights-cpu-backup"
summary: Узкая версия `--enable-weights-cpu-backup`: host-копия сохраняется только для весов draft-модели спекулятивного декодирования. Имеет смысл, когда основную модель после пробуждения всё равно перезальют, а маленькую draft-модель — нет.
group: exec.features
related:
  - --enable-weights-cpu-backup
  - --enable-memory-saver
  - --speculative-algorithm
  - --speculative-draft-model-path
  - --weight-cache-mode
  - --tp-size
---

# --enable-draft-weights-cpu-backup

## Кратко

В связке «memory saver + RL-цикл» основную модель после пробуждения обычно перезаливают новыми весами от тренера, поэтому копия старых в RAM бесполезна. Draft-модель спекулятивного декодирования при этом часто не меняется от шага к шагу, а перечитывать ее чекпойнт при каждом пробуждении — лишние секунды. Этот флаг покрывает ровно этот случай: CPU-бэкап включается только для воркера draft-модели. Если draft-модели нет (не задан `--speculative-algorithm`), флаг не делает ничего.

## Оригинальная справка

```text
Save draft model weights to CPU memory during release_weights_occupation and resume_weights_occupation
```

## Паспорт аргумента

- Флаги: `--enable-draft-weights-cpu-backup`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: поле не переписывается, но фактический эффект снимается там же, где и у `--enable-weights-cpu-backup`: при `--weight-cache-mode` не `off` (предупреждение `[ModelRunner] Disabling weights CPU backup in zero-copy IPC mode — IPC-mapped weights cannot be offloaded to CPU.`) и молча при выключенном `--enable-memory-saver`
- Где объявлен: `ServerArgs.enable_draft_weights_cpu_backup`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → загрузка весов draft-воркера (`model_executor/model_runner_components/load_model_utils.py`) → каждое `pause`/`resume` тега `weights` в этом воркере

## Что меняет в движке

Единственная точка чтения:

```python
enable_cpu_backup = server_args.enable_weights_cpu_backup or (
    is_draft_worker and server_args.enable_draft_weights_cpu_backup
)
```

Отсюда весь контракт:

- флаг влияет **только** на воркер, у которого `is_draft_worker` истинно;
- он **избыточен**, если задан `--enable-weights-cpu-backup`: тот покрывает и основную, и draft-модель (левая часть `or` не проверяет тип воркера);
- без draft-воркера выражение всегда ложно, и флаг ни на что не влияет.

Дальше механика та же, что у общего флага: `torch_memory_saver` при `pause(tag="weights")` копирует содержимое региона на хост и возвращает его при `resume` на те же виртуальные адреса, сохраняя валидность захваченных CUDA graph. Тег и HTTP-контракт общие: освобождение и возврат инициируются `POST /release_memory_occupation` и `POST /resume_memory_occupation` (в справке аргумента упомянуты несуществующие в этом checkout'е `release_weights_occupation` / `resume_weights_occupation` — см. `--enable-memory-saver`).

Отдельная деталь: draft-воркер исключен из предвыделения симметричной памяти (`prealloc_symmetric_memory_pool`), но не из регионов memory saver'а — так что его веса действительно попадают под `pause`/`resume` наравне с основными.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Требует `--enable-memory-saver`, иначе тихо игнорируется.
- Требует `--weight-cache-mode off`, иначе снимается с предупреждением.
- Требует включенного спекулятивного декодирования с отдельной draft-моделью; для алгоритмов, работающих без отдельного воркера, эффекта нет.

## Когда использовать

- RL-цикл со спекулятивным декодированием, где основная модель обновляется каждый шаг, а draft — нет. Тогда `--enable-draft-weights-cpu-backup` без `--enable-weights-cpu-backup` — это минимальный расход host RAM при быстром пробуждении draft-части.
- Не включайте вместе с `--enable-weights-cpu-backup`: второй флаг уже покрывает draft-воркер, и комбинация только запутывает конфигурацию.
- Не включайте без спекулятивного декодирования — draft-воркера не будет.
- Не рассчитывайте на этот флаг, если после пробуждения вы всё равно пушите draft-веса: копия окажется лишней.

## Влияние на производительность и память

- **RAM хоста.** Объем весов draft-модели на ранг × число рангов на узле. Draft-модели обычно на порядок меньше основной (EAGLE-головы — сотни МиБ, а не десятки ГиБ), поэтому цена существенно ниже, чем у общего флага.
- **VRAM.** Не меняется.
- **Время `resume`.** Draft-часть восстанавливается копированием host→device вместо чтения чекпойнта.
- **Время `pause`.** Растет на объем копирования весов draft-модели.
- **Установившийся инференс.** Не затрагивается.

## Взаимодействие с другими аргументами

- `--enable-memory-saver`: обязателен.
- `--enable-weights-cpu-backup`: делает этот флаг избыточным.
- `--speculative-algorithm` и `--speculative-draft-model-path`: определяют само существование draft-воркера.
- `--weight-cache-mode`: любое значение, кроме `off`, снимает бэкап.
- `--tp-size`: множитель расхода host RAM на узле.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, host RAM не вырос, время `resume` не изменилось. **Причина:** нет draft-воркера или нет `--enable-memory-saver`. **Проверка:** итоговый дамп `server_args=` — есть ли `speculative_algorithm`.
- **Симптом:** предупреждение `Disabling weights CPU backup in zero-copy IPC mode`. **Причина:** `--weight-cache-mode` не `off`.
- **Симптом:** после `resume` draft-модель дает нулевой accept rate. **Причина:** веса draft освобождались без бэкапа и не были перезалиты. **Решение:** включить этот флаг либо перезаливать draft-веса вместе с основными.
- **Что смотреть:** итоговый дамп `server_args=` при старте и RSS процессов scheduler'а до и после первого `pause`.
- **В arriero:** как и у общего флага, host-копия не видна аналитической оценке памяти; для инстанса со спекуляцией добавьте ее к host-draw вручную (`docs/RESOURCE_MANAGEMENT.md`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-70B --speculative-algorithm EAGLE --speculative-draft-model-path /models/eagle-head --enable-memory-saver --enable-draft-weights-cpu-backup
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-70B --tensor-parallel-size 2 --speculative-algorithm EAGLE --speculative-draft-model-path /models/eagle-head --enable-memory-saver --enable-draft-weights-cpu-backup --weight-cache-mode off
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/utils/torch_memory_saver_adapter.py`
- `sglang/python/sglang/srt/managers/scheduler_components/weight_updater.py`
- `sglang/python/sglang/srt/distributed/device_communicators/pynccl_allocator.py`
- `sglang/docs/docs/advanced_features/sglang_for_rl.mdx`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
