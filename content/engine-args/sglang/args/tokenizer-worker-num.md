---
schema: 1
engine: sglang
primaryName: "--tokenizer-worker-num"
title: "--tokenizer-worker-num"
summary: Число HTTP/tokenizer-процессов. Значение больше 1 включает multi-tokenizer-режим — это N полноценных процессов со своей копией токенизатора, и в нем полностью отключается аутентификация по ключу.
group: serving
related:
  - --detokenizer-worker-num
  - --tokenizer-path
  - --skip-tokenizer-init
  - --api-key
  - --admin-api-key
  - --grpc-port
  - --enable-ssl-refresh
  - --enable-http2
  - --mm-feature-transport
  - --enable-dynamic-batch-tokenizer
  - --max-ep-size
---

# --tokenizer-worker-num

## Кратко

`--tokenizer-worker-num` задает, сколько процессов обслуживают HTTP-слой и токенизацию. Значение `1` (по умолчанию) — обычный режим: один процесс держит FastAPI-приложение и `TokenizerManager`.

Значение больше 1 переключает движок в **multi-tokenizer-режим**, и это не «настройка числа потоков», а другая архитектура: uvicorn поднимает N рабочих процессов, каждый из которых заново инициализирует собственный `TokenizerWorker` (наследник `TokenizerManager`) из shared memory, а в главном процессе появляется `MultiTokenizerRouter`, который мультиплексирует ZMQ-обмен между воркерами и планировщиком.

Одно последствие критично: **в этом режиме аутентификация по ключу не работает**. Middleware подключается только в ветке `tokenizer_worker_num == 1`, а `--api-key` дополнительно валит каждый воркер на `assert`.

## Оригинальная справка

```text
The worker num of the tokenizer manager.
```

## Паспорт аргумента

- Флаги: `--tokenizer-worker-num`
- Группа: `serving`
- Тип значения: int
- Допустимые значения: `choices` нет; `check_server_args` требует `> 0` (`Tokenizer worker num must >= 1`). Практический потолок — число ядер хоста, свободных от инференса
- Значение по умолчанию: `1`
- Эффективное значение: совпадает с заданным. `--skip-tokenizer-init` его специально **не** сбрасывает — в комментарии кода это объяснено тем, что воркеры продолжают обслуживать HTTP и состояние запросов, даже когда токенизировать нечего
- Где объявлен: `ServerArgs.tokenizer_worker_num`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (проверки совместимости) → выбор ветки запуска в `_setup_and_run_http_server` → запуск N HTTP-процессов и роутера

## Что меняет в движке

### Один воркер (`1`)

`app.is_single_tokenizer_mode = True`, объект приложения получает `server_args` и параметры прогрева напрямую, `TokenizerManager` создается в главном процессе, ZMQ-сокет `scheduler_input_ipc_name` биндится им же. Auth-middleware подключается здесь и только здесь.

### Несколько воркеров (`N > 1`)

1. В главном процессе создается `MultiTokenizerRouter`: три ZMQ-сокета (приём от детокенизатора, отправка планировщику, приём от воркеров), отдельный поток с собственным `asyncio`-циклом и две долгоживущие задачи.
2. `write_data_for_multi_tokenizer` кладет `port_args`, `server_args` и `scheduler_info` в разделяемую память под именем `multi_tokenizer_args_<pid главного процесса>`.
3. `uvicorn.run("sglang.srt.entrypoints.http_server:app", ..., workers=N)` (или `Granian(workers=N)` при `--enable-http2`) поднимает N процессов. Каждый в своем lifespan вызывает `init_multi_tokenizer()`: читает shared memory, **проверяет `assert server_args.api_key is None`**, создает собственный `ipc://`-сокет, поднимает `TokenizerWorker` и свой `TemplateManager`.
4. `TokenizerWorker.__init__` ставит имя процесса `sglang::tokenizer_worker:<pid>`, выполняет `torch.set_num_threads(1)` и регистрируется у роутера сообщением `TokenizerWorkerRegistrationReq` — регистрация нужна, чтобы `pause`/`continue` доходили до всех воркеров.
5. Каждый исходящий объект штампуется `stamp_http_worker_ipc(obj, self.tokenizer_ipc_name)`: именно по этому полю ответы возвращаются тому же воркеру, который принял запрос. В одно-воркерном режиме штамп не ставится вовсе — это важно для `--detokenizer-worker-num`.
6. В `finally` главный процесс делает `multi_tokenizer_args_shm.unlink()` и чистит карту сокетов.

### Что отваливается в multi-режиме

- **Аутентификация.** Ветка `add_api_key_middleware` недостижима. `--api-key` при этом хотя бы падает громко (`AssertionError: API key is not supported in multi-tokenizer mode`), а `--admin-api-key` — молча: сервер стартует, управляющие endpoint'ы остаются открытыми.
- **`--enable-ssl-refresh`.** Предупреждение `--enable-ssl-refresh is not supported with multiple tokenizer workers (--tokenizer-worker-num > 1). SSL refresh will be disabled.` и обычный запуск.
- **Нативный gRPC.** `ValueError: Native gRPC does not yet support --tokenizer-worker-num > 1. Unset --grpc-port or set --tokenizer-worker-num 1.`
- **Elastic EP scale-up.** `assert self.tokenizer_worker_num == 1, "Elastic EP runtime scale-up currently requires --tokenizer-worker-num 1."`

## Значения и формат

- Целое ≥ 1. `0` и отрицательные отвергаются `check_server_args`.
- Значение равно числу HTTP-процессов один в один; никакой поправки на ядра или на `--tp-size` движок не делает.
- Апстрим-примеры для больших развертываний (`docs/docs/advanced_features/pd_disaggregation.mdx`, гайды для Ascend) используют значения 4, 16 и 32 — все они относятся к многокарточным узлам с высокой конкурентной нагрузкой.

## Когда использовать

- Узкое место — CPU HTTP-процесса: сотни одновременных запросов, много коротких промптов, тяжелая мультимодальная предобработка. Признак — процесс `sglang::…` с токенизатором стабильно ест 100% одного ядра, а GPU при этом недогружен.
- Большой узел, где токенизация нескольких DP-реплик упирается в один Python-процесс.
- **Не** включайте на одиночном инстансе с малой конкурентностью: вы получите N копий процесса и потеряете аутентификацию, ничего не выиграв.
- **Не** включайте, если задан `--api-key` или `--admin-api-key`: в первом случае сервер не стартует, во втором — стартует без защиты.

## Влияние на производительность и память

- **RAM хоста — главная статья расходов.** Каждый воркер это полноценный Python-процесс: импорт `torch`, собственный `TokenizerManager`, своя копия токенизатора и, для мультимодальной модели, своя копия процессора (включая image processor). Значение измеряется, а не оценивается:

  ```bash
  ps -o pid,rss,args -p $(pgrep -f 'sglang::tokenizer_worker')
  ```

- **CPU:** `torch.set_num_threads(1)` в каждом воркере не дает им драться за потоки BLAS. Реальный выигрыш — параллельная токенизация и параллельная сериализация HTTP.
- **VRAM:** обычно не затрагивается, **кроме** мультимодального пути. При `--mm-feature-transport cuda_ipc` пул под мультимодальные признаки делится между воркерами поровну в пределах общего бюджета (`get_mm_feature_pool_size_per_worker`), и в лог пишется `reserving up to <N> MiB on base GPU <i> across <N> tokenizer worker(s). This reduces KV cache headroom`. То есть число воркеров влияет на запас VRAM под KV-кеш.
- **Время старта:** N процессов параллельно читают токенизатор; для мультимодальных моделей это заметно, из-за чего в SGLang даже есть отдельная переменная `SGLANG_UVICORN_WORKER_HEALTHCHECK_TIMEOUT` (по умолчанию 10 секунд) с комментарием, что дефолтных 5 секунд не хватает при холодном старте многих воркеров.
- **Throughput:** растет только там, где узким местом был именно HTTP/токенизаторный процесс. На GPU-bound нагрузке эффекта нет.

## Взаимодействие с другими аргументами

- `--api-key`: несовместимо, `AssertionError` в каждом воркере.
- `--admin-api-key`: формально совместимо, фактически перестает что-либо защищать — проверять надо самому запросом без заголовка.
- `--detokenizer-worker-num > 1`: работает **только** в паре с multi-tokenizer-режимом (см. `detokenizer-worker-num.md`).
- `--grpc-port`: `ValueError`.
- `--enable-ssl-refresh`: молча отключается.
- `--enable-http2`: меняет реализацию multi-worker сервера с uvicorn на Granian с `workers=N`.
- `--max-ep-size` / elastic-EP scale-up: требует значения 1.
- `--mm-feature-transport`: делит GPU-пул мультимодальных признаков между воркерами.
- `--enable-dynamic-batch-tokenizer`: динамический батчер создается **в каждом** воркере со своей очередью, то есть батчинг идет внутри воркера, а не глобально; с ростом N средний размер батча падает.
- `--skip-tokenizer-init`: не сбрасывает это значение (в отличие от `--detokenizer-worker-num`).

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: API key is not supported in multi-tokenizer mode` при старте. **Лечение:** убрать ключ или вернуть `--tokenizer-worker-num 1`.
- **Симптом:** admin-ключ задан, а управляющие endpoint'ы открыты. **Причина:** multi-tokenizer-режим, middleware не подключено. **Проверка:** `curl -i -X POST http://127.0.0.1:30000/flush_cache` без заголовка.
- **Симптом:** `ValueError: Native gRPC does not yet support --tokenizer-worker-num > 1.` **Лечение:** снять `--grpc-port`.
- **Симптом:** RSS хоста вырос кратно после включения. **Причина:** ожидаемое поведение — N процессов с копиями токенизатора. **Проверка:** `ps` по имени процесса `sglang::tokenizer_worker`.
- **Симптом:** воркеры перезапускаются при старте. **Причина:** супервизор uvicorn не дожидается холодной инициализации. **Лечение:** увеличить `SGLANG_UVICORN_WORKER_HEALTHCHECK_TIMEOUT`.
- **Симптом:** после включения упал размер KV-пула на мультимодальной модели. **Причина:** пул мультимодальных признаков разделен между воркерами и уменьшил запас VRAM. **Подтверждение:** строка про `reserving up to … MiB … across N tokenizer worker(s)` в логе.
- **Подтверждение режима:** имена процессов (`sglang::tokenizer_worker:<pid>`) и наличие сегмента разделяемой памяти `multi_tokenizer_args_<pid>`.

## В arriero

- **Не используйте на инстансах kind `ktransformers`.** Профиль (`docs/KTRANSFORMERS_OPERATIONS.md`) рассчитан на низкую конкурентность (в квалификации — 2 одновременных запроса) и TP 1; узкое место там — CPU-эксперты KTransformers, а не HTTP-слой. Дополнительные процессы будут конкурировать за те же ядра, которыми управляет `--kt-cpuinfer`.
- **Учет памяти не увидит рост.** Каждый воркер добавляет RSS к дереву процессов инстанса. Политика процессов для этого движка — `all-descendants` (`packages/core/src/engine-descriptor.ts`), поэтому измеренная память соберет все воркеры, но **декларированный** host-draw в `config/resources.json` вы должны увеличить сами: строгий контроль допуска KTransformers не переопределяется принудительно (`docs/RESOURCE_MANAGEMENT.md`). Расхождение проявится как дрейф отпечатка в оценке памяти (`docs/MEMORY_ESTIMATION.md`).
- **NUMA.** При `interleave`-режиме инстанса лишние процессы участвуют в той же политике размещения; перекос между узлами переводит инстанс в `degraded` с бейджем `numa skew` (`docs/NUMA_PINNING.md`).
- Ключ не зарезервирован за конфигурацией движка, схема его пропустит.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --tokenizer-worker-num 1
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --tokenizer-worker-num 8 --detokenizer-worker-num 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/managers/multi_tokenizer_mixin.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/multimodal/transport/cuda_ipc.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/test/registered/tokenizer/test_multi_tokenizer.py`
- `sglang/docs/docs/advanced_features/pd_disaggregation.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`, `docs/MEMORY_ESTIMATION.md`, `docs/NUMA_PINNING.md`
