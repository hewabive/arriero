---
schema: 1
engine: sglang
primaryName: "--crash-dump-folder"
title: "--crash-dump-folder"
summary: Включает буфер последних пяти минут запросов в памяти и сброс его в pickle при падении сервера, а на CUDA — еще и умолчания для device-coredump. В дамп попадают промпты и ответы целиком.
group: observability
related:
  - --watchdog-timeout
  - --soft-watchdog-timeout
  - --export-metrics-to-file
  - --log-requests
  - --debug-tensor-dump-output-folder
  - --enable-request-time-stats-logging
---

# --crash-dump-folder

## Кратко

Аргумент делает две независимые вещи. Первая: tokenizer-процесс начинает **постоянно** держать в памяти скользящее пятиминутное окно завершенных запросов, чтобы при падении записать их вместе с незавершенными в один pickle-файл. Вторая, только на CUDA: `__post_init__` выставляет умолчания переменных окружения для device-coredump, включая генерацию дампа при исключении на GPU. Оба эффекта стоят ресурсов и оба сохраняют содержимое запросов — в файле будут и промпты, и сгенерированные ответы. Не указан — вся механика выключена.

## Оригинальная справка

```text
Folder path to dump requests from the last 5 min before a crash (if any). If not specified, crash dumping is disabled.
```

## Паспорт аргумента

- Флаги: `--crash-dump-folder`
- Группа: `observability`
- Тип значения: str — путь к каталогу
- Допустимые значения: `choices` нет. Существование каталога при разборе не проверяется; каталог для дампа запросов создается в момент записи, каталог для CUDA-coredump — на старте
- Значение по умолчанию: `null` — механизм выключен
- Эффективное значение: совпадает с заданным. Может быть изменено на лету через `ConfigureLoggingReq` (`python -m sglang.srt.managers.configure_logging --url … --crash-dump-folder …`) — тогда новое значение действует до перезапуска, но переменные окружения coredump остаются от старта
- Где объявлен: `ServerArgs.crash_dump_folder`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_crash_dump_env`, переменные окружения) → конструктор `TokenizerManager` → завершение каждого запроса (запись в буфер) → обработчик падения

## Что меняет в движке

### Буфер в памяти

`TokenizerManager` при завершении каждого запроса выполняет:

```python
if self.crash_dump_folder and state.finished and state.obj.log_metrics:
    self.record_request_for_crash_dump(state, out_dict)
```

`record_request_for_crash_dump` кладет в `deque` кортеж `(объект запроса, выходной словарь, время создания, время завершения)` и вычищает всё старше 300 секунд. То есть в памяти постоянно живет полный текст промптов и ответов за последние пять минут работы. Это не «цена в момент падения», а непрерывный расход RAM пропорционально трафику.

### Что пишется при падении

`dump_requests_before_crash()` вызывается из трех мест: `SignalHandler.running_phase_sigquit_handler` (SIGQUIT от упавшего дочернего процесса — например, от сработавшего `--watchdog-timeout`), `print_exception_wrapper` при необработанном исключении в `TokenizerManager` и `sigterm_watchdog` при SIGTERM на нездоровом сервере. Флаг `crash_dump_performed` гарантирует ровно одну запись.

Файл: `<folder>/<hostname>/crash_dump_<YYYY-MM-DD_HH-MM-SS>.pkl`, каталог создается рекурсивно. Содержимое — pickle словаря с ключами `server_args`, `config_updates`, `resolved_config`, `requests` и `launch_command` (полная строка запуска, `" ".join(sys.argv)`). В `requests` идут накопленные завершенные запросы плюс все незавершенные из `rid_to_state` с уже сгенерированной частью ответа.

Если `server_args` не сериализуется pickle'ом (типичный случай при `--trust-remote-code`), запись повторяется без него, и в логе появляется `Failed to pickle dump with server_args: …; retrying without server_args`.

Подтверждение в логе: `Dumping requests before crash. self.crash_dump_folder=…` и затем `Dumped N finished and M unfinished requests before crash to <файл>`.

Воспроизвести дамп можно скриптом из checkout'а — `scripts/playground/replay_request_dump.py`.

### Переменные окружения CUDA coredump

`_handle_crash_dump_env` выставляет, **только если они еще не заданы**:

- `CUDA_ENABLE_COREDUMP_ON_EXCEPTION=1` — дамп при исключении на устройстве;
- `CUDA_ENABLE_USER_TRIGGERED_COREDUMP=1`;
- `CUDA_COREDUMP_SHOW_PROGRESS=1`;
- `CUDA_COREDUMP_GENERATION_FLAGS=skip_nonrelocated_elf_images,skip_global_memory,skip_shared_memory,skip_local_memory,skip_constbank_memory`;
- `CUDA_COREDUMP_FILE=<folder>/%h/core.cuda.%t.%p`;
- `CUDA_COREDUMP_PIPE=/tmp/corepipe.cuda.%h.%p`.

Каждая подстановка логируется строкой `Auto-set <KEY>=<value> (from --crash-dump-folder)`. Каталог для coredump'ов пре-создается (подстановка `%h` разрешается в имя хоста; при других `%`-шаблонах в части пути печатается предупреждение).

Ключевой момент про объем: набор `skip_*` исключает из дампа глобальную, разделяемую, локальную и константную память устройства — именно это удерживает файл от того, чтобы стать сопоставимым с занятой VRAM. Если оператор задаст `CUDA_COREDUMP_GENERATION_FLAGS` сам, умолчание не применится, и дамп с включенной global memory будет порядка объема KV-пула плюс веса.

Сам по себе аргумент **не** запускает py-spy и user-triggered coredump на падении — это делают отдельные переменные окружения `SGLANG_PYSPY_DUMP_BEFORE_CRASH` и `SGLANG_CUDA_COREDUMP_BEFORE_CRASH`, и они работают даже без этого аргумента.

## Значения и формат

- Путь к каталогу; пишите абсолютный, относительный разрешается от рабочего каталога процесса.
- Каталог дампа запросов — `<folder>/<hostname>/`; имя хоста берется из `HOSTNAME` либо из `socket.gethostname()`.
- Пустая строка эквивалентна выключению: проверка везде идет как `if not self.crash_dump_folder` / `if self.crash_dump_folder`.
- Специальных значений (`auto`, `-`) нет.
- Ротации и очистки нет: каждое падение добавляет новый файл с меткой времени, старые остаются.

## Когда использовать

- На стенде, где ловится воспроизводимое падение: дамп дает точную входную нагрузку на момент краха и полную строку запуска, а `replay_request_dump.py` позволяет прогнать ее заново.
- В связке со сторожевым псом: `--watchdog-timeout` убивает дерево процессов через SIGQUIT, и именно этот путь приводит к записи дампа — иначе о содержимом висевших запросов не останется ничего.
- **Не включать на продакшене с пользовательскими данными без осознанного решения:** файл содержит промпты и ответы в открытом виде, а pickle к тому же нельзя безопасно открыть недоверенным.
- Не включать на сервере с высоким RPS «просто чтобы было»: постоянный буфер из пяти минут трафика — это реальная и немаленькая память, см. ниже.
- Не рассчитывать на дамп при `SIGKILL` и при OOM-killer'е: обработчиков там нет, буфер уходит вместе с процессом.

## Влияние на производительность и память

- VRAM: не затрагивает. Но `CUDA_ENABLE_COREDUMP_ON_EXCEPTION=1` меняет поведение драйвера при ошибке на устройстве — вместо немедленного падения будет писаться дамп.
- **RAM хоста — главная цена.** В памяти tokenizer-процесса постоянно лежат все запросы и ответы за 300 секунд. Порядок: `RPS × 300 × (размер промпта + размер ответа)`. При 20 запросах в секунду и суммарных 6 КБ на запрос это около 36 МБ; при длинных контекстах — сотни мегабайт. Освобождение происходит только по времени, независимо от давления на память.
- Latency: добавление в `deque` и очистка головы — операции за константное время, на пути ответа незаметны.
- Диск: файл дампа пишется один раз за жизнь процесса. Его размер — тот же пятиминутный объем плюс незавершенные запросы. CUDA-coredump'ы, если сработают, добавляются отдельно и по одному на процесс.
- Время старта: один `makedirs` для каталога coredump'ов.

## Взаимодействие с другими аргументами

- `--watchdog-timeout` / `--soft-watchdog-timeout`: сторожевой пес scheduler'а шлет родителю SIGQUIT, обработчик которого и вызывает запись дампа. Без `--crash-dump-folder` при срабатывании пса останется только лог.
- `--log-requests`: другой механизм с тем же содержимым, но в лог и постоянно. Обратите внимание: наборы полей, которые `--log-requests-level` исключает из логов и из `--export-metrics-to-file`, к crash-дампу **не применяются** — сюда объект запроса кладется целиком.
- `--export-metrics-to-file`: непрерывный поток на диск против одноразового дампа; каталоги держите раздельно.
- `--debug-tensor-dump-output-folder`: третий писатель на диск, с принципиально другим объемом.
- `--trust-remote-code`: типичная причина отката записи без `server_args`.

## Типовые проблемы и диагностика

- Сервер упал, файла нет — проверьте, дошло ли дело до обработчика: при `SIGKILL`, OOM-killer'е и падении с `os._exit` дамп не пишется. Ищите в логе `Dumping requests before crash.`
- `Dumped 0 finished and 0 unfinished requests before crash` — за последние пять минут не было завершенных запросов и не было активных; файл в этом случае вообще не создается (запись идет только при непустом наборе).
- `SIGTERM/SIGQUIT/Exception triggered, but crash dump already performed, skipping.` — второй сигнал в том же процессе; дамп пишется один раз.
- `Failed to pickle dump with server_args: …; retrying without server_args` — нормальный откат, данные запросов сохранены.
- `Cannot pre-create CUDA coredump directory …: only %h is supported in the directory part` — в `CUDA_COREDUMP_FILE` заданы другие `%`-шаблоны в части пути; coredump может не записаться.
- Память tokenizer-процесса растет и стабилизируется на плато — это буфер пяти минут, а не утечка.
- **В arriero:** падение по сторожевому псу выглядит как неожиданная смерть инстанса, запуск закрывается с `stopReason: "crash"` (`docs/STATUS_LAYERS.md` — слои статусов). Каталог дампа задавайте вне `data/config/`: тот корень может быть под git (`docs/CONFIG_GIT.md`), а pickle с пользовательскими промптами туда попадать не должен. Учтите также, что arriero по умолчанию **не** останавливает управляемые процессы при собственном выходе и переусыновляет их при старте (`docs/STATUS_LAYERS.md`, `process/reconcile.ts`) — обычная остановка инстанса оператором идет через SIGTERM на здоровом сервере и дампа не производит.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --crash-dump-folder /var/tmp/sglang-crash
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --crash-dump-folder /var/tmp/sglang-crash --watchdog-timeout 900 --soft-watchdog-timeout 120
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/io_struct.py`
- `sglang/python/sglang/srt/utils/watchdog.py`
- `sglang/docs/docs/advanced_features/observability.mdx`
- arriero: `docs/STATUS_LAYERS.md`, `docs/CONFIG_GIT.md`
