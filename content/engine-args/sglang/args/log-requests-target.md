---
schema: 1
engine: sglang
primaryName: "--log-requests-target"
title: "--log-requests-target"
summary: Куда писать логи запросов: stdout и/или каталоги. Файловая цель означает почасовую ротацию без удаления старых файлов, а каталог создается при старте даже когда --log-requests выключен.
group: observability
related:
  - --log-requests
  - --log-requests-level
  - --log-requests-format
  - --crash-dump-folder
  - --tokenizer-worker-num
---

# --log-requests-target

## Кратко

Список целей, который `RequestLogger._setup_targets` передает в `create_log_targets` (`sglang/python/sglang/srt/utils/log_utils.py`). Каждой цели соответствует свой `logging.Logger` с собственным обработчиком; запись отправляется во все цели по очереди.

Два поведения, которые стоит знать заранее:

1. Цели создаются в конструкторе `RequestLogger` **безусловно** — даже если `--log-requests` не задан. Каталог будет создан (`os.makedirs`), файл открыт, и если прав на запись нет, сервер не стартует.
2. Файловая цель использует `TimedRotatingFileHandler(when="H", backupCount=0)`. Это почасовая ротация, при которой старые файлы **никогда не удаляются**: `backupCount=0` отключает очистку. Ротация без ретенции — ваша задача.

## Оригинальная справка

```text
Target(s) for request logging: 'stdout' and/or directory path(s) for file output. Can specify multiple targets, e.g., '--log-requests-target stdout /my/path'. 
```

## Паспорт аргумента

- Флаги: `--log-requests-target`
- Группа: `observability`
- Тип значения: список строк, `nargs="+"` (выводится из аннотации `Optional[List[str]]` в `arg_groups/arg_utils.py`) — минимум одно значение
- Допустимые значения: `choices` нет. Строка `stdout` (сравнение без учета регистра) означает поток вывода процесса, любая другая строка трактуется как **путь к каталогу**, а не к файлу
- Значение по умолчанию: `None` — одна цель, stdout
- Эффективное значение: совпадает с заданным. На живом сервере **не меняется**: `RequestLogger.configure` параметр принимает, но `TokenizerManager.configure_logging` его не передает
- Где объявлен: `ServerArgs.log_requests_target`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация `TokenizerManager` (`init_request_logging_and_dumping`), до приема первого запроса

## Что меняет в движке

`create_log_targets`:

- пустой список или `None` → одна цель `_create_log_target_stdout`: логгер `sglang.srt.utils.request_logger.stdout`, `StreamHandler(sys.stdout)`;
- `stdout` в списке → та же цель;
- любое другое значение → `_create_log_target_file(directory, …)`:
  - `os.makedirs(directory, exist_ok=True)`;
  - имя файла — `f"{hostname}_{rank}.log"`, где `hostname` — `socket.gethostname()`, а `rank` — `torch.distributed.get_rank()` при инициализированном `torch.distributed`, иначе `0`. В tokenizer-процессе `torch.distributed` не инициализирован, поэтому файл практически всегда `<hostname>_0.log`;
  - обработчик — `TimedRotatingFileHandler(filename, when="H", backupCount=0, encoding="utf-8")`.

Все цели получают одинаковый форматтер `[%(asctime)s] %(message)s`, уровень `INFO` и `propagate=False`. Последнее означает, что записи запросов не проходят через корневой логгер и не зависят от `--log-level`.

Логгер кешируется по имени, и обработчик добавляется только если у логгера их еще нет (`if not logger.handlers`). Поэтому повторный `configure()` не удваивает вывод, но и не позволяет заменить обработчик.

## Значения и формат

- Одна цель: `--log-requests-target /var/log/sglang-requests`.
- Несколько: `--log-requests-target stdout /var/log/sglang-requests` — запись уйдет и в поток вывода, и в файл.
- Значение — **каталог**. Указать конкретное имя файла нельзя; имя выводится из хоста и ранга.
- Относительный путь разрешается относительно рабочего каталога процесса.
- Аргумент без значений (`--log-requests-target` в конце строки) argparse отвергает: `nargs="+"` требует минимум одно.
- Ротация: раз в час текущий файл переименовывается в `<hostname>_0.log.YYYY-MM-DD_HH`, и открывается новый. Число сохраняемых файлов не ограничено.

## Когда использовать

- Нужно отделить поток записей запросов от общего лога процесса, чтобы его можно было отдельно ротацией и правами доступа ограничить, — задайте каталог и **не** указывайте `stdout`.
- Нужно и то и другое (лог инстанса для быстрого просмотра, файл для сборщика) — перечислите обе цели.
- Не используйте файловую цель без внешней ретенции: за сутки при `--log-requests-level 3` каталог легко набирает гигабайты и никогда не чистится сам.
- Не рассчитывайте переключить цель на живом сервере — `POST /configure_logging` этого поля не принимает.

## Влияние на производительность и память

- На VRAM и на скорость генерации не влияет.
- Каждая дополнительная цель — это дополнительная синхронная запись на каждый залогированный запрос в потоке tokenizer-процесса. Две цели — двойной I/O.
- Файловая цель на медленном или сетевом томе способна замедлить прием запросов: запись выполняется синхронно в обработчике логгера, без отдельного потока и без очереди.
- Дисковое место: ограничено только объемом раздела.

## Взаимодействие с другими аргументами

- `--log-requests`: без него в цели ничего не пишется, но сами цели все равно создаются при старте (каталог, файл, дескриптор).
- `--log-requests-level`: определяет объем, который уйдет в эти цели.
- `--log-requests-format`: формат одинаков для всех целей.
- `--crash-dump-folder`: другой механизм и другой каталог; путь может совпадать, но файлы разные.
- `--tokenizer-worker-num` > 1: `RequestLogger` создается в каждом HTTP-воркере, `torch.distributed` ни в одном из них не инициализирован, поэтому все воркеры на одном хосте берут одно и то же имя файла `<hostname>_0.log` и открывают собственный `TimedRotatingFileHandler` на него. Записи перемешиваются, а ротация выполняется каждым воркером независимо — при таком режиме используйте `stdout` и разделяйте потоки снаружи.

## Типовые проблемы и диагностика

- **Симптом:** сервер не стартует, `PermissionError` при создании каталога. **Причина:** `os.makedirs` выполняется в конструкторе `RequestLogger`, до приема запросов, независимо от `--log-requests`. **Лечение:** дать права или убрать аргумент.
- **Симптом:** указали путь `/var/log/sglang/requests.log`, а получили каталог с таким именем и файлом `<hostname>_0.log` внутри. **Причина:** значение всегда трактуется как каталог. **Лечение:** передавать каталог.
- **Симптом:** раздел с логами заполнился. **Причина:** `backupCount=0`, ротированные файлы не удаляются. **Лечение:** внешняя ретенция (logrotate по маске `<hostname>_0.log.*`, cron-очистка).
- **Симптом:** записи запросов пропали из лога инстанса. **Причина:** задана только файловая цель, `stdout` в списке нет. **Лечение:** добавить `stdout`.
- **Симптом:** `POST /configure_logging` с `log_requests_target` ничего не изменил. **Причина:** обработчик это поле игнорирует. **Лечение:** перезапуск с новым значением.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `log_requests_target=`.

## В arriero

Управляемый инстанс пишет stdout и stderr напрямую в файловый дескриптор `runtime/logs/<instance>-<startedAtMs>.raw.log` (супервизор ведет tail этого файла и строит отфильтрованный лог рядом). Поэтому цель `stdout` означает «в лог инстанса», со всеми последствиями: разбор лога (`apps/api/src/process/log-parsers/sglang.ts`) увидит текст промптов и ответов и при уровне ≥ 2 переведет инстанс в `degraded` по словам вроде `error` и `failed` в содержимом (`apps/api/src/process/health-summary.ts`).

Отдельный каталог этот эффект снимает: записи запросов уходят мимо лога инстанса, и разбор их не видит. Взамен вы получаете файлы, о которых arriero ничего не знает — они не ротируются вместе с логами инстанса, не удаляются при удалении инстанса (`apps/api/src/process/log-paths.ts` знает только про `runtime/logs`) и не подчиняются 30-дневной ретенции трасс прокси. Если задача — именно сохранить содержимое запросов, штатный инструмент arriero это узел конвейера `capture-request` (`docs/API_PROXY_FOUNDATION.md`, arriero), а не файловая цель движка.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-requests --log-requests-level 1 --log-requests-target /var/log/sglang-requests
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-requests --log-requests-target stdout /var/log/sglang-requests
```

## Источники

- `sglang/python/sglang/srt/utils/log_utils.py`
- `sglang/python/sglang/srt/utils/request_logger.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `apps/api/src/process/log-parsers/sglang.ts`, `apps/api/src/process/health-summary.ts`, `docs/API_PROXY_FOUNDATION.md`
