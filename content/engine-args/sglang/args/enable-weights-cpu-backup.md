---
schema: 1
engine: sglang
primaryName: "--enable-weights-cpu-backup"
title: "--enable-weights-cpu-backup"
summary: Модификатор `--enable-memory-saver`: при освобождении региона весов их содержимое копируется в RAM хоста и возвращается оттуда при пробуждении. Обменивает объем весов в host RAM на то, чтобы после `resume` не перечитывать чекпойнт.
group: exec.features
related:
  - --enable-memory-saver
  - --enable-draft-weights-cpu-backup
  - --weight-cache-mode
  - --speculative-algorithm
  - --tp-size
  - --load-format
---

# --enable-weights-cpu-backup

## Кратко

Сам по себе флаг не делает ничего — он читается ровно в одном месте, при загрузке модели внутрь региона memory saver'а, и превращает «освободить веса» в «скопировать веса в host RAM и освободить». Разница видна только в связке с `--enable-memory-saver`: без CPU-бэкапа после `POST /resume_memory_occupation` на месте весов лежит неинициализированная память и их надо загрузить заново (с диска или пушем от тренера); с бэкапом они восстанавливаются из host-копии. Плата фиксированная и предсказуемая: копия шардов весов данного ранга живет в RAM хоста всё время жизни процесса, а не только на время сна.

## Оригинальная справка

```text
Save model weights (both main model and draft model, if any) to CPU memory during release_weights_occupation and resume_weights_occupation
```

## Паспорт аргумента

- Флаги: `--enable-weights-cpu-backup`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: поле не переписывается, но фактический эффект снимается в `load_model_with_memory_saver`, если `--weight-cache-mode` не `off`: печатается `[ModelRunner] Disabling weights CPU backup in zero-copy IPC mode — IPC-mapped weights cannot be offloaded to CPU.` и локальная переменная `enable_cpu_backup` становится `False`. Кроме того, при выключенном `--enable-memory-saver` адаптер — заглушка, и параметр просто игнорируется без единого сообщения
- Где объявлен: `ServerArgs.enable_weights_cpu_backup`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → загрузка весов (`model_executor/model_runner_components/load_model_utils.py`, `memory_saver_adapter.region(GPU_MEMORY_TYPE_WEIGHTS, enable_cpu_backup=…)`) → каждое `pause`/`resume` тега `weights`

## Что меняет в движке

Вся логика — в одном выражении:

```python
enable_cpu_backup = server_args.enable_weights_cpu_backup or (
    is_draft_worker and server_args.enable_draft_weights_cpu_backup
)
```

и в передаче результата в `region(GPU_MEMORY_TYPE_WEIGHTS, enable_cpu_backup=enable_cpu_backup)`. Обратите внимание: `enable_weights_cpu_backup` проверяется **без** условия на воркер, поэтому он покрывает и основную модель, и draft-модель спекулятивного декодирования — ровно как обещает справка. Отдельный `--enable-draft-weights-cpu-backup` нужен только чтобы включить бэкап **исключительно** для draft-воркера.

Дальше режим региона использует уже сам `torch_memory_saver`: `pause(tag="weights")` при поднятом флаге сохраняет содержимое региона на хост перед освобождением физических страниц, `resume(tag="weights")` восстанавливает его на те же виртуальные адреса. Виртуальные адреса не меняются — именно поэтому захваченные CUDA graph остаются валидными.

Про терминологию в справке: методов `release_weights_occupation` / `resume_weights_occupation` в checkout'е нет. Реальный контракт — `POST /release_memory_occupation` и `POST /resume_memory_occupation` с тегом `weights` (или без тегов, тогда затрагиваются все три региона). Подробности потока — в справке `--enable-memory-saver`.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Требует `--enable-memory-saver`, иначе тихо игнорируется.
- Требует `--weight-cache-mode off` (значение по умолчанию), иначе снимается с предупреждением.
- Размер host-копии не настраивается: это ровно тот объем, который занимают веса **этого ранга** на GPU.

## Когда использовать

- RL-цикл, в котором после пробуждения нужны **те же** веса, что были до сна. Классический пример — сервер засыпает, пока другая задача занимает карту, и просыпается с прежним чекпойнтом.
- Хост с быстрым и объемным RAM, где перечитывание чекпойнта с диска (особенно сетевого) на каждом пробуждении обходится дороже, чем постоянно занятые гигабайты.
- Не включайте, если ваш оркестратор всё равно пушит новые веса после каждого пробуждения (типичный RL-цикл с обновлением политики): копия в RAM будет создана и никогда не пригодится.
- Не включайте без `--enable-memory-saver` — флаг будет висеть в конфигурации, не делая ничего.
- Не забывайте умножать: на восьмикарточном узле в host RAM окажется **восемь** шардов, то есть суммарно полный размер модели, а не одна восьмая.

## Влияние на производительность и память

- **RAM хоста.** Основная цена: объем весов на ранг × число рангов на узле. Для 70B в bf16 при `--tp-size 8` это порядка 140 ГиБ суммарно по узлу. Планируйте это как постоянный резерв, а не как всплеск.
- **VRAM.** Не меняется в рабочем режиме; смысл флага в том, что во время сна VRAM освобождается так же, как и без него.
- **Время `resume`.** Уменьшается радикально относительно перезагрузки чекпойнта: копирование host→device по PCIe вместо чтения с диска и распаковки формата.
- **Время `pause`.** Растет: добавляется копирование device→host всего региона весов.
- **Установившийся инференс.** Не затрагивается — флаг не влияет ни на один forward.

## Взаимодействие с другими аргументами

- `--enable-memory-saver`: обязателен, иначе флаг инертен.
- `--enable-draft-weights-cpu-backup`: избыточен при включенном этом флаге — `enable_weights_cpu_backup` уже покрывает draft-воркер.
- `--weight-cache-mode`: любое значение, кроме `off`, снимает бэкап (веса расшарены через CUDA IPC и не могут быть выгружены).
- `--speculative-algorithm`: определяет, есть ли вообще draft-воркер, чью память тоже покроет этот флаг.
- `--tp-size`: множитель для суммарного расхода host RAM на узле.
- `--load-format`: определяет, насколько дорогой была бы альтернатива — повторное чтение чекпойнта.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, но после `resume` веса всё равно мусорные. **Причина №1:** нет `--enable-memory-saver`. **Причина №2:** активен weight cache. **Проверка:** предупреждение `Disabling weights CPU backup in zero-copy IPC mode` в логе старта; итоговый дамп `server_args=`.
- **Симптом:** процесс убит OOM-killer'ом хоста вскоре после старта. **Причина:** host-копия весов не влезла в RAM. **Решение:** убрать флаг либо уменьшить `--tp-size` на узел / нарастить RAM.
- **Симптом:** `pause` стал заметно дольше. **Причина:** ожидаемая — копирование весов на хост.
- **Что смотреть:** итоговый дамп `server_args=` при старте, предупреждение про zero-copy IPC, и потребление RSS процессов scheduler'а.
- **В arriero:** постоянно занятая host-копия не учитывается аналитической оценкой памяти и не отражается в capacity-ledger автоматически. Если вы включаете флаг, увеличивайте host-draw инстанса на суммарный размер шардов узла — иначе ledger разрешит запустить рядом еще один инстанс и хост уйдет в swap; деградацию по свопу arriero заметит только постфактум, через порог 64 МиБ в health summary (`docs/RESOURCE_MANAGEMENT.md`).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --enable-memory-saver --enable-weights-cpu-backup
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --tensor-parallel-size 2 --enable-memory-saver --enable-weights-cpu-backup --weight-cache-mode off
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/utils/torch_memory_saver_adapter.py`
- `sglang/python/sglang/srt/managers/scheduler_components/weight_updater.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/advanced_features/sglang_for_rl.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
