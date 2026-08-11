---
schema: 1
engine: sglang
primaryName: "--detokenizer-worker-num"
title: "--detokenizer-worker-num"
summary: Число процессов детокенизации. Значение больше 1 добавляет N процессов плюс отдельный роутер и имеет смысл только вместе с --tokenizer-worker-num > 1 — иначе роутер падает на первом же запросе.
group: serving
related:
  - --tokenizer-worker-num
  - --skip-tokenizer-init
  - --disable-tokenizer-batch-decode
  - --tokenizer-path
  - --stream-interval
  - --enable-metrics
---

# --detokenizer-worker-num

## Кратко

Детокенизация — обратное преобразование token ids в текст — живет в отдельном процессе `sglang::detokenizer`, который получает выходы планировщика по ZMQ и отдает строки обратно в HTTP-слой. `--detokenizer-worker-num` задает, сколько таких процессов поднять.

Значение больше 1 добавляет не N процессов, а N + 1: каждому воркеру выдается свой `ipc://`-сокет, а исходный сокет забирает себе процесс-роутер `sglang::detokenizer_router`, который распределяет запросы по воркерам.

Ключевое ограничение не отражено ни в справке, ни в проверках: роутер выбирает воркера по полю `http_worker_ipc` запроса, а это поле проставляется **только** в multi-tokenizer-режиме. При `--tokenizer-worker-num 1` оно остается `None`, и роутер падает на assert'е при первом же запросе.

## Оригинальная справка

```text
The worker num of the detokenizer manager.
```

## Паспорт аргумента

- Флаги: `--detokenizer-worker-num`
- Группа: `serving`
- Тип значения: int
- Допустимые значения: `choices` нет; `check_server_args` требует `> 0` (`Detokenizer worker num must >= 1`)
- Значение по умолчанию: `1`
- Эффективное значение: **принудительно `1`** при `--skip-tokenizer-init` (кроме случая `SGLANG_RUST_SERVER`). `_handle_tokenizer_batching` пишет предупреждение `skip_tokenizer_init=True leaves no decode work for detokenizer workers; forcing detokenizer_worker_num=1 (requested N).` и присваивает значение
- Где объявлен: `ServerArgs.detokenizer_worker_num`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_tokenizer_batching`) → запуск дочерних процессов в `_launch_detokenizer_subprocesses` до инициализации tokenizer manager

## Что меняет в движке

`Engine._launch_detokenizer_subprocesses` (`entrypoints/engine.py`) ветвится ровно один раз:

- **`<= 1`** — один процесс, слушающий `port_args.detokenizer_ipc_name`. Исходное поведение, имя процесса `sglang::detokenizer`, watchdog видит его под именем `detokenizer`.
- **`> 1`** — для каждого из N воркеров создается собственный временный `ipc://`-сокет и запускается процесс (`detokenizer_0`, `detokenizer_1`, …). Затем исходный `detokenizer_ipc_name` отдается процессу `run_multi_detokenizer_router_process` (`detokenizer_router`). Все N + 1 процессов попадают под `SubprocessWatchdog`.

`MultiDetokenizerRouter.event_loop` разбирает три случая:

- `FreezeGCReq` — рассылается всем воркерам;
- одиночный `BaseReq` — `assert recv_obj.http_worker_ipc is not None, f"Single req {recv_obj.rid=} missing http_worker_ipc"`, затем выбор воркера как `ipc_name_list[zlib.crc32(key) % num_workers]`;
- батч `BaseBatchReq` — пустой батч рассылается всем, непустой проверяется на `all(x is not None for x in http_worker_ipcs)` и разбивается по элементам, каждый со своим ключом.

Привязка по crc32 не случайна: все выходы одного запроса обязаны попадать к одному детокенизатору, иначе разъедется инкрементальное состояние `decode_status` (в нем хранятся `surr_offset`/`read_offset` и накопленные token ids).

### Почему это требует multi-tokenizer-режима

`http_worker_ipc` заполняется функцией `stamp_http_worker_ipc`, а вызывается она в `TokenizerManager._dispatch_to_scheduler` только под условием `if self.tokenizer_ipc_name is not None`. Это поле, в свою очередь, устанавливается в `init_ipc_channels` исключительно в ветке `tokenizer_worker_num != 1`. При одном tokenizer-воркере штампа нет, и `output_streamer.py` собирает `http_worker_ipcs` из `req.http_worker_ipc`, то есть список из `None`. Оба assert'а роутера на этом срабатывают; исключение перехватывается в `run_multi_detokenizer_router_process`, логируется как `MultiDetokenizerRouter hit an exception` и завершается отправкой `SIGQUIT` родительскому процессу — то есть падением всего сервера.

Косвенное подтверждение замысла: единственный тест апстрима, который вообще задает этот аргумент (`test/registered/tokenizer/test_multi_tokenizer.py`), использует `--tokenizer-worker-num 8 --detokenizer-worker-num 4`.

## Значения и формат

- Целое ≥ 1.
- Практически осмысленны только два варианта: `1` (одиночный процесс) и значение из диапазона, кратно меньшего `--tokenizer-worker-num`, — распределение идет по хешу ipc-имени tokenizer-воркера, поэтому равномерность достигается, когда воркеров-источников заметно больше, чем детокенизаторов.
- Значение больше числа tokenizer-воркеров бессмысленно: ключей для распределения всего `tokenizer_worker_num` штук, часть детокенизаторов останется без нагрузки.

## Когда использовать

- Детокенизация упирается в один процесс: очень много одновременных стримов с высокой частотой выдачи токенов, длинные ответы, `--stream-interval 1`. Признак — процесс `sglang::detokenizer` стабильно занимает целое ядро, а планировщик простаивает.
- Только совместно с `--tokenizer-worker-num > 1`.
- Не включайте на инстансе с одним tokenizer-воркером: сервер поднимется, а первый же запрос убьет его.
- Не включайте при `--skip-tokenizer-init`: значение будет принудительно сброшено в 1 с предупреждением.

## Влияние на производительность и память

- **RAM хоста:** каждый детокенизатор — отдельный процесс со своей копией токенизатора (`DetokenizerManager.init_tokenizer` вызывает `get_tokenizer` независимо) и своим словарем инкрементального состояния `decode_status` ограниченной емкости. Плюс еще один процесс под роутер, у которого токенизатора нет — только ZMQ-сокеты и карта воркеров. Измерять: `ps -o pid,rss,args -p $(pgrep -f 'sglang::detokenizer')`.
- **CPU:** параллельная детокенизация N стримов. Выигрыш есть только при реальном насыщении одного процесса.
- **VRAM:** не затрагивается — детокенизация целиком CPU-операция.
- **Latency:** добавляется один лишний ZMQ-хоп (планировщик → роутер → воркер вместо планировщик → воркер). На фоне межпроцессного обмена это малая величина, но при низкой нагрузке чистый проигрыш.
- **Время старта:** N + 1 процессов вместо одного, каждый читает токенизатор.

## Взаимодействие с другими аргументами

- `--tokenizer-worker-num`: фактическое условие работоспособности значений больше 1.
- `--skip-tokenizer-init`: принудительно сбрасывает значение в 1.
- `--disable-tokenizer-batch-decode`: определяет, как каждый детокенизатор декодирует пачку — одним `batch_decode` или построчно. Аргументы независимы, но оба про стоимость детокенизации.
- `--stream-interval`: чем он меньше, тем больше сообщений проходит через детокенизаторы.
- `--enable-metrics`: включает поток мониторинга CPU внутри процесса детокенизатора (`start_cpu_monitor_thread("detokenizer")`) — полезно, чтобы увидеть, действительно ли он насыщен.

## Типовые проблемы и диагностика

- **Симптом:** сервер стартует нормально, но умирает на первом запросе; в логе `MultiDetokenizerRouter hit an exception` с `AssertionError: Single req rid=... missing http_worker_ipc`. **Причина:** `--detokenizer-worker-num > 1` при `--tokenizer-worker-num 1`. **Лечение:** либо поднять число tokenizer-воркеров, либо вернуть `--detokenizer-worker-num 1`.
- **Симптом:** предупреждение `skip_tokenizer_init=True leaves no decode work for detokenizer workers; forcing detokenizer_worker_num=1`. **Причина:** заданное значение перекрыто. **Лечение:** убрать аргумент.
- **Симптом:** часть детокенизаторов простаивает. **Причина:** число ключей распределения равно числу tokenizer-воркеров, и crc32 распределил их неравномерно. **Лечение:** уменьшить число детокенизаторов.
- **Симптом:** текст в стриме «рвется» или дублируется. **Причина, которую стоит исключить первой:** нарушение привязки запроса к одному детокенизатору. В штатном коде это исключено crc32-пиннингом; появление симптома — повод смотреть логи роутера, а не подбирать значение аргумента.
- **Подтверждение конфигурации:** список процессов — должно быть N процессов `sglang::detokenizer` и один `sglang::detokenizer_router`.

## В arriero

Для kind `ktransformers` этот аргумент — прямая опасность. Профиль (`docs/KTRANSFORMERS_OPERATIONS.md`) работает с одним tokenizer-воркером, а значит `--detokenizer-worker-num 2` даст инстанс, который проходит preflight, стартует, отвечает 200 на `/health` — и умирает на первом же проксированном запросе.

Как это будет выглядеть в менеджере: `SIGQUIT` от роутера убивает дерево процессов, супервизор фиксирует неожиданную смерть, инстанс переходит в `error`, а в отфильтрованном логе останется трассировка `MultiDetokenizerRouter hit an exception`. Политика дерева процессов у движка — `all-descendants` (`packages/core/src/engine-descriptor.ts`), поэтому все N + 1 процессов будут учтены и зачищены корректно, но сам отказ произойдет уже под нагрузкой, а не на старте.

Практический вывод: оставляйте значение по умолчанию. Если детокенизация действительно окажется узким местом, сначала поднимайте `--tokenizer-worker-num` — и вместе с ним теряйте аутентификацию по ключу, что для профиля arriero приемлемо только за петлевым интерфейсом.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --detokenizer-worker-num 1
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --tokenizer-worker-num 8 --detokenizer-worker-num 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/managers/multi_tokenizer_mixin.py`
- `sglang/python/sglang/srt/managers/detokenizer_manager.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler_components/output_streamer.py`
- `sglang/test/registered/tokenizer/test_multi_tokenizer.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `packages/core/src/engine-descriptor.ts`
