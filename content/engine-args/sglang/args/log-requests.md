---
schema: 1
engine: sglang
primaryName: "--log-requests"
title: "--log-requests"
summary: Включает запись метаданных, промптов и ответов в лог; подробность задает --log-requests-level, у которого значение по умолчанию 2 уже печатает текст запроса и ответа. Логгеры запросов не подчиняются --log-level.
group: observability
related:
  - --log-requests-level
  - --log-requests-format
  - --log-requests-target
  - --log-level
  - --enable-request-time-stats-logging
  - --crash-dump-folder
  - --enable-metrics
---

# --log-requests

## Кратко

Флаг-выключатель для класса `RequestLogger` (`sglang/python/sglang/srt/utils/request_logger.py`), который создается в tokenizer-процессе и вызывается в трех точках:

1. `log_received_request` — при приеме запроса в `TokenizerManager.generate_request`;
2. `log_openai_received_request` — до адаптации сырого OpenAI-тела, но **только при `--log-requests-level` ≥ 2**;
3. `log_finished_request` — после завершения генерации, вместе с ответом.

Главное, что нужно понимать до включения: значение `--log-requests-level` по умолчанию равно **2**, а на уровне 2 в лог идут и текст промпта, и текст ответа (обрезанные до 2048 символов с каждой стороны). То есть один флаг `--log-requests` без дополнительных параметров — это уже полноценная выгрузка содержимого диалогов на диск.

Второе: логгеры запросов создаются отдельно от корневого, с уровнем INFO и `propagate=False`. `--log-level error` их **не** заглушает.

## Оригинальная справка

```text
Log metadata, inputs, outputs of all requests. The verbosity is decided by --log-requests-level
```

## Паспорт аргумента

- Флаги: `--log-requests`
- Группа: `observability`
- Тип значения: bool, `action="store_true"` — значение не принимает, парной формы `--no-log-requests` нет
- Допустимые значения: флаг присутствует или отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: из CLI не переопределяется; переключается на живом сервере через `POST /configure_logging` (уровень доступа `ADMIN_OPTIONAL`)
- Где объявлен: `ServerArgs.log_requests`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация `TokenizerManager` (`init_request_logging_and_dumping`) → HTTP-слой и прием/завершение каждого запроса

## Что меняет в движке

### Куда пишется

`RequestLogger._setup_targets` вызывает `create_log_targets` (`sglang/python/sglang/srt/utils/log_utils.py`). Без `--log-requests-target` создается один логгер на `sys.stdout` с именем `sglang.srt.utils.request_logger.stdout`, уровнем `INFO`, `propagate=False` и форматтером `[%(asctime)s] %(message)s`. Из-за `propagate=False` и собственного уровня эти строки не проходят через корневой логгер и не зависят от `--log-level`.

### Что именно пишется

Подробный разбор по уровням — в `log-requests-level.md`. Кратко:

- уровни `0` и `1` вырезают из записи поля `text`, `input_ids`, `input_embeds`, `image_data`, `audio_data`, `video_data`, `mm_data_mooncake`, `lora_path` (на уровне `0` — еще и `sampling_params`), а из ответа — `text`, `output_ids`, `embedding`. Содержимого в логе нет;
- уровни `2` и `3` не вырезают ничего: печатаются и промпт, и ответ. Разница только в длине обрезки (2048 символов против 2³⁰, то есть фактически без ограничения).

Дополнительно в запись попадают заголовки из белого списка: по умолчанию только `x-smg-routing-key`, расширяется переменной окружения `SGLANG_LOG_REQUEST_HEADERS`.

### Побочный эффект, который не является логированием

В `log_received_request` есть блок, помеченный в исходниках как `FIXME`: при уровне ≥ 2, если `obj.text is None`, а `obj.input_ids` заданы, вызывается `tokenizer.decode(obj.input_ids, skip_special_tokens=False)`, и результат **записывается обратно в `obj.text`**. То есть включение `--log-requests` для token-in-запросов добавляет полное детокенизирование промпта в горячий путь приема запроса и меняет сам объект запроса, а не только лог.

### Ограничение по длительности

Переменная окружения `SGLANG_LOG_REQUEST_EXCEEDED_MS` (по умолчанию `-1`, выключено) заставляет `log_finished_request` пропускать запросы быстрее указанного порога. Строка `Receive:` при этом все равно печатается — фильтруется только завершение.

## Значения и формат

- Флаг без значения: `--log-requests`.
- Отключить обратно в командной строке нечем — парного `--no-log-requests` не существует (объявление `bool` превращается в `store_true`, а не в `BooleanOptionalAction`).
- На живом сервере выключается запросом:
  ```bash
  curl -sS -X POST http://127.0.0.1:30000/configure_logging -H 'Content-Type: application/json' -d '{"log_requests": false}'
  ```
  Тем же запросом меняются `log_requests_level` и `log_requests_format`. Поле `log_requests_target` в обработчике `TokenizerManager.configure_logging` **не** передается — цель логирования на лету не меняется.

## Когда использовать

- Разбор конкретного инцидента: клиент присылает не то, что думает; парсер инструментов или reasoning ведет себя не так, как ожидается; нужно увидеть фактические `sampling_params`. Для этого достаточно `--log-requests --log-requests-level 1`, содержимое не нужно.
- Учет и биллинг по метаданным — лучше через `--enable-metrics`, а не через разбор лога.
- Не включайте с уровнем по умолчанию на сервере с реальными данными: на уровне 2 диалоги окажутся в файле лога, в его ротациях, в бэкапах и во всем, куда этот файл попадает.
- В arriero есть более аккуратная альтернатива для захвата содержимого — узел конвейера прокси `capture-request`: артефакты кладутся отдельными файлами в `data/proxy-requests/` и подчиняются 30-дневному сроку хранения трасс (`docs/API_PROXY_FOUNDATION.md`, arriero). У лога инстанса срока хранения нет.

## Влияние на производительность и память

- На VRAM и на скорость forward не влияет.
- CPU и I/O: форматирование строки и запись на каждый принятый и на каждый завершенный запрос. На уровне 3 с длинными контекстами одна запись — это сотни килобайт текста; при потоке в десятки запросов в секунду это становится заметной нагрузкой на tokenizer-процесс, который одновременно обслуживает HTTP.
- Отдельная статья расходов — упомянутый выше `tokenizer.decode` полного промпта для token-in-запросов на уровнях ≥ 2.
- Дисковое место: рост файла лога прямо пропорционален суммарному объему промптов и ответов.

## Взаимодействие с другими аргументами

- `--log-requests-level`: единственный регулятор подробности; без него действует значение 2 с содержимым.
- `--log-requests-format`: `text` или `json`; на объем записи не влияет.
- `--log-requests-target`: куда писать — stdout и/или каталоги с почасовой ротацией.
- `--log-level`: на логирование запросов не влияет ни в какую сторону.
- `--enable-request-time-stats-logging`: другой канал — потайминговая статистика по запросу, включается независимо.
- `--crash-dump-folder`: сохраняет запросы за последние 5 минут перед падением; это отдельный механизм со своим буфером.
- `--tokenizer-worker-num` > 1: `RequestLogger` создается в каждом воркере, и каждый пишет в свой поток вывода.

## Типовые проблемы и диагностика

- **Симптом:** включили `--log-requests` «чтобы видеть, кто ходит», а в логе оказались полные диалоги. **Причина:** уровень по умолчанию 2. **Лечение:** `--log-requests-level 0` или `1`.
- **Симптом:** `--log-level error`, а промпты в логе есть. **Причина:** отдельный логгер с `propagate=False`. **Лечение:** выключить `--log-requests`.
- **Симптом:** заметный рост latency приема запроса на token-in-нагрузке. **Причина:** детокенизирование промпта в `log_received_request` при уровне ≥ 2. **Лечение:** уровень 0/1.
- **Симптом:** строки `Finish:` появляются не для всех запросов. **Причина:** задана `SGLANG_LOG_REQUEST_EXCEEDED_MS`. **Лечение:** снять переменную окружения.
- **Проверка принятого значения:** дамп `server_args=` при старте содержит `log_requests=` и `log_requests_level=`; фактические строки в логе начинаются с `Receive: obj=`, `Receive OpenAI: obj=` и `Finish: obj=`.

## В arriero

Это самый опасный аргумент группы для управляемого инстанса, и по двум независимым причинам.

1. **Ложный `degraded`.** Разбор лога (`apps/api/src/process/log-parsers/sglang.ts`) считает ошибкой любую строку, содержащую `error`, `fatal`, `failed`, `exception`, `traceback`, `out of memory` или `oom`, и предупреждением — любую со словом `warn`/`warning`. Наличие хотя бы одной такой строки в последней 1000 строк отфильтрованного лога переводит инстанс в `degraded`, даже когда `/health` отвечает 200 (`apps/api/src/process/health-summary.ts`). На уровне ≥ 2 в лог попадает текст промптов и ответов, а в кодовых и отладочных диалогах эти слова встречаются постоянно. Инстанс будет показан деградировавшим из-за содержимого пользовательских сообщений.
2. **Утечка содержимого в файл без срока хранения.** Строки уходят в `runtime/logs/<instance>-<startedAtMs>.raw.log` и в отфильтрованную копию рядом. Ни ротации по размеру, ни срока хранения у этих файлов нет — в отличие от артефактов запроса прокси, которые чистятся вместе с 30-дневной ретенцией трасс.

Практический вывод: на управляемом инстансе используйте `--log-requests --log-requests-level 1` (метаданные и `sampling_params`, без текста), а содержимое захватывайте узлом `capture-request` в конвейере прокси.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-requests --log-requests-level 1
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --log-requests --log-requests-level 3 --log-requests-format json --log-requests-target /var/log/sglang-requests
```

## Источники

- `sglang/python/sglang/srt/utils/request_logger.py`
- `sglang/python/sglang/srt/utils/log_utils.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_base.py`
- `sglang/python/sglang/srt/managers/configure_logging.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `apps/api/src/process/log-parsers/sglang.ts`, `apps/api/src/process/health-summary.ts`, `docs/API_PROXY_FOUNDATION.md`
