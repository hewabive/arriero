---
schema: 1
engine: sglang
primaryName: "--weight-cache-mode"
title: "--weight-cache-mode"
summary: Включает загрузку весов из демона, держащего уже квантованные TP-шарды в VRAM, через CUDA IPC. Быстрый рестарт дает только режим `client` поверх отдельно запущенного демона; `daemon` порождает демон вместе с движком и живет ровно столько же.
group: model
related:
  - --weight-cache-socket
  - --weight-cache-timeout
  - --load-format
  - --quantization
  - --speculative-algorithm
  - --enable-weights-cpu-backup
  - --tp-size
  - --pp-size
  - --revision
  - --trust-remote-code
---

# --weight-cache-mode

## Кратко

Weight cache — это отдельный процесс на каждый TP-ранг, который один раз проходит весь путь «диск → TP-шард → квантизация», держит готовый `state_dict` в GPU-памяти и раздает его движкам как CUDA IPC-хендлы. Движок при этом инициализирует модель на meta-устройстве и подставляет чужие указатели — копии весов не создается, лишней VRAM не тратится. Смысл имеет ровно один сценарий: отдельно запущенный долгоживущий демон плюс движок в режиме `client`, тогда рестарт движка не читает веса с диска вовсе. Режим `daemon` порождает демон как дочерний процесс и умирает вместе с ним, поэтому рестарт он не ускоряет, а первый старт делает дольше — об этом честно сказано в самой справке.

## Оригинальная справка

```text
Weight cache mode. 'off': normal disk loading. 'daemon': launch weight cache daemon (holds weights in GPU memory). Engine-spawned daemons are co-terminal with the engine and do NOT persist across restarts, so this alone does not speed up restart (the first start is slower). For fast recovery, run the standalone daemon (python -m sglang.srt.weight_cache.daemon) and connect with 'client'. 'client': connect to existing daemon and load via IPC.
```

## Паспорт аргумента

- Флаги: `--weight-cache-mode`
- Группа: `model`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `off`, `daemon`, `client`
- Значение по умолчанию: `off`
- Эффективное значение: не переопределяется, но **переопределяет** формат загрузки: при значении, отличном от `off`, `maybe_enable_ipc_weight_cache` подменяет `LoadConfig.load_format` на внутренний `ipc_cache`, запомнив исходный формат как `fallback_load_format`
- Где объявлен: `ServerArgs.weight_cache_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_load_format` — запрет со спекуляцией) → запуск демонов в `Engine` (только `daemon`) → формирование `LoadConfig` → загрузка модели через `IpcModelLoader`

## Что меняет в движке

**`off`** — обычная загрузка с диска, никаких дополнительных процессов.

**`daemon`** — `Engine._launch_weight_cache_daemons` (`sglang/python/sglang/srt/entrypoints/engine.py`) до запуска scheduler-процессов порождает по одному процессу `python -m sglang.srt.weight_cache.daemon` на каждый локальный ранг (`pp_rank × tp_rank`), очистив перед этим устаревшие `.sock`/`.ready` файлы. В командную строку демона проброшены `--model-path`, `--gpu-id`, `--tp-size`/`--tp-rank`, `--pp-size`/`--pp-rank`, `--dp-size 1`, `--ep-size`, `--load-format`, `--dtype`, `--dist-init-method`, а также `--quantization`, `--model-loader-extra-config`, `--trust-remote-code` и `--revision`, если они заданы. Затем движок ждет появления `.ready`-файлов не дольше `--weight-cache-timeout`. Демоны — дети движка и завершаются вместе с ним (SIGTERM с последующим SIGKILL), плюс сами убивают себя при смерти родителя.

**`client`** — демонов не запускает, просто подключается к уже существующим сокетам.

В обоих ненулевых режимах загрузка идет через `IpcModelLoader` (`sglang/python/sglang/srt/weight_cache/ipc_loader.py`):

1. проверка допустимости метода квантизации для IPC (см. ниже) — до всякого сетевого обращения;
2. `lstat` сокета: файла нет — «демона нет»; файл есть, но это не сокет или он принадлежит другому пользователю — `RuntimeError` (защита от подложенного файла в `/tmp`);
3. подключение, отправка отпечатка `CacheConfig`: `model_path`, архитектура, `tp/pp/dp/ep`-размеры и ранги, метод квантизации и хеш ее конфига, `dtype`, `revision`, а также compute capability GPU и версия torch;
4. модель создается на meta-устройстве, и каждому параметру/буферу подставляется IPC-тензор демона; `process_weights_after_loading` **не** выполняется повторно — демон уже его прогнал;
5. запускается фоновый watchdog за PID демона: если демон умрет, движок убьет себя SIGKILL, потому что указатели (в том числе захваченные в CUDA graph) станут висячими.

Правила отката различаются по режимам и зафиксированы в докстринге загрузчика: в `daemon` отсутствие демона — всегда `RuntimeError` (диск-загрузка на той же карте дала бы OOM, ведь демон уже держит там веса); в `client` откат на диск допустим **только** если сокета не существует, а «connection refused», несовпадение `CacheConfig` и любая протокольная ошибка — жесткий отказ.

Пока кеш активен, движок запрещает операции, мутирующие веса: `update_weights_from_disk` и подобные, а также освобождение/восстановление памяти весов, отвечают `RuntimeError` с текстом `[weight_cache] ... is not supported while the weight cache is active`.

## Значения и формат

- `off` — по умолчанию.
- `daemon` — демоны порождаются движком. Полезно для отладки самого механизма; ускорения рестарта не дает.
- `client` — единственный режим для быстрого восстановления. Демон запускается заранее и отдельно, например:
  `python -m sglang.srt.weight_cache.daemon --model-path /models/M --tp-size 4 --load-format auto --dtype auto --quantization fp8`.
- Значение вне списка отвергает argparse.

**Жесткое ограничение по квантизации.** IPC-путь верифицирован только для неквантованных весов и блочного FP8 (`IPC_QUANT_ALLOWLIST` в `sglang/python/sglang/srt/weight_cache/protocol.py`: пустая строка и `fp8` с заданным `weight_block_size`). Любой другой метод — `UnsupportedQuantForIPCError` до подключения к демону, потому что `process_weights_after_loading` других методов переупаковывает веса или проставляет Python-side метаданные, которые meta-инициализированный клиент воспроизвести не может.

## Когда использовать

- Модель большая, а перезапуски частые (обновление конфигурации, отладка пайплайна), и вы готовы держать отдельный процесс с полной копией весов в VRAM: `client` + заранее поднятый демон.
- Несколько движков на одной карте должны разделить одни и те же веса — IPC дает именно это, без дублирования VRAM.
- Не включайте `daemon` ради ускорения рестарта: он его не ускоряет.
- Не включайте на квантованной модели вне allowlist — старт упадет.
- Не включайте, если вам нужны горячее обновление весов, спекулятивное декодирование или CPU-бэкап весов.

## Влияние на производительность и память

- VRAM: в zero-copy режиме дополнительная копия не создается — движок отображает память демона. Но сам демон удерживает полный набор весов на карте постоянно, и эта память недоступна KV-пулу, пока демон жив. Планируйте `--mem-fraction-static` с учетом того, что веса «принадлежат» демону.
- Время старта: `client` при живом демоне сводит загрузку весов к передаче IPC-хендлов (в логе `Fetched <n> IPC handles from daemon in <t>s`). `daemon` наоборот удлиняет первый старт: сначала грузится демон, потом подключается движок.
- CPU-бэкап весов принудительно отключается: `enable_weights_cpu_backup` при активном кеше сбрасывается с предупреждением, потому что IPC-память нельзя выгрузить на хост.
- RAM хоста: демон читает чекпойнт своими средствами, page cache расходуется как при обычной загрузке.

## Взаимодействие с другими аргументами

- `--weight-cache-socket`: путь к сокету на стороне клиента. Учтите: у самого демона CLI-опции для смены пути **нет**, он всегда биндит `/tmp/sglang_weight_cache_rank{global_rank}.sock`.
- `--weight-cache-timeout`: ожидание готовности демонов; действует только в режиме `daemon`.
- `--speculative-algorithm`: запрещенная комбинация. `_handle_load_format` поднимает `ValueError`: демон не экспортирует веса драфт-модели.
- `--load-format`: исходное значение сохраняется как `fallback_load_format` и используется при откате на диск в режиме `client`. Значение `ipc_cache` задать вручную нельзя — `ValueError`.
- `--quantization`: метод входит в отпечаток и в allowlist IPC.
- `--revision`, `--trust-remote-code`, `--model-loader-extra-config`, `--dtype`: пробрасываются в порожденные демоны и (первые два) участвуют в отпечатке.
- `--tp-size`/`--pp-size`: глобальный ранг демона считается как `tp_size × pp_rank + tp_rank`; смена топологии означает другие сокеты и несовместимый отпечаток.
- `--enable-weights-cpu-backup`: принудительно выключается.

## Типовые проблемы и диагностика

- `ValueError: --weight-cache-mode is not supported together with speculative decoding (--speculative-algorithm) ...` — снимите одно из двух.
- `RuntimeError: [IpcModelLoader] Weight cache daemon not available at <socket>. In daemon mode, fallback to disk loading is disabled ...` — в режиме `daemon` демон не поднялся или отпечаток не совпал.
- `RuntimeError: [IpcModelLoader] Refusing to connect: <path> is not a socket owned by this user.` — по пути лежит не сокет либо чужой сокет. На общем хосте `/tmp` — общий каталог, и эта проверка здесь единственный барьер.
- `RuntimeError: [IpcModelLoader] Daemon socket exists at <path> but refused the connection. The daemon may have crashed after creating the socket.` — демон умер после bind.
- `UnsupportedQuantForIPCError: [weight_cache:client] quantization method '<x>' is not verified for CUDA IPC zero-copy weight sharing ...` — метод вне allowlist.
- `TimeoutError: Weight cache daemon for pp_rank=<i> tp_rank=<j> did not become ready within <t>s` или `RuntimeError: Weight cache daemon (pid=<p>) exited prematurely with code <c>` — режим `daemon`, см. `--weight-cache-timeout`.
- `[IpcModelLoader] Weight cache not available or config mismatch, falling back to disk load` — режим `client`, сокета нет; движок поднимется медленным путем.
- `RuntimeError: [weight_cache] update_weights_from_disk is not supported while the weight cache is active (--weight-cache-mode <mode>) ...` — попытка мутировать веса при активном кеше.
- Успех подтверждают `[IpcModelLoader] Fetched <n> IPC handles from daemon in <t>s`, `[IpcModelLoader] Loaded model via IPC (mode=<mode>), total=<t>s` и `[IpcModelLoader] Started daemon-liveness watchdog for pid=<p>`.

## Примеры

```bash
python -m sglang.srt.weight_cache.daemon --model-path /models/Qwen3-30B-A3B --tp-size 1 --load-format auto --dtype auto
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --weight-cache-mode client --mem-fraction-static 0.6 --host 127.0.0.1 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/weight_cache/daemon.py`
- `sglang/python/sglang/srt/weight_cache/ipc_loader.py`
- `sglang/python/sglang/srt/weight_cache/protocol.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/weight_updater.py`
- `sglang/python/sglang/srt/managers/scheduler_components/weight_updater.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
