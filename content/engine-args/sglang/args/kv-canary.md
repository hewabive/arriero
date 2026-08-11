---
schema: 1
engine: sglang
primaryName: "--kv-canary"
title: "--kv-canary"
summary: Диагностический механизм целостности KV-кеша: к пулу пристегиваются контрольные буферы, и каждый forward проверяет, что в слотах лежат ожидаемые токены. Режим `log` сообщает о расхождениях, `raise` роняет сервер на первом же.
group: observability
related:
  - --kv-canary-sweep-interval
  - --kv-canary-real-data
  - --cuda-graph-backend-prefill
  - --mem-fraction-static
  - --page-size
  - --speculative-num-steps
  - --disaggregation-mode
---

# --kv-canary

## Кратко

Не эксплуатационная ручка, а инструмент поиска редких дефектов в работе с KV-кешем (ошибки аллокатора, неверное отображение слотов, повреждение при вытеснении, дефекты спекулятивного декодирования). `install_canary` (`sglang/python/sglang/srt/kv_canary/api.py`) пристегивает к пулу KV дополнительные буферы, в которые при записи кладется «канарейка» — идентификатор токена, позиция и цепочка хешей, — и оборачивает `model.forward` парой пре/пост-операций, проверяющих эти значения.

Механизм узкий по охвату: поддерживаются только зарегистрированные классы пулов. Для незарегистрированного пула старт падает с `NotImplementedError: kv-canary: no attacher registered for pool class …`.

## Оригинальная справка

```text
KV cache canary mode. 'none' disables the canary (default). 'log' prints them while the server keeps running (production-safe). 'raise' fails the server on the first detected mismatch (CI lane).
```

## Паспорт аргумента

- Флаги: `--kv-canary`
- Группа: `observability`
- Тип значения: str
- Допустимые значения: `none`, `log`, `raise` (жесткий `choices`); дополнительно `CanaryConfig.from_env` приводит значение к нижнему регистру и повторно проверяет по тому же списку
- Значение по умолчанию: `none`
- Эффективное значение: совпадает с заданным. Косвенно влияет на другие настройки: при `log`/`raise` включается проверка `assert not check_cuda_graph_backend(Phase.PREFILL, Backend.TC_PIECEWISE)`, то есть piecewise-CUDA-graph на prefill становится несовместим
- Где объявлен: `ServerArgs.kv_canary`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный аргумент, но узкоспециальный диагностический механизм, а не повседневная настройка
- Этап применения: `__post_init__` (проверка связки с `--kv-canary-sweep-interval`) → инициализация `ModelRunner`, сразу после выделения KV-пула и **до** захвата CUDA graph

## Что меняет в движке

### Установка

`install_canary` вызывается из `ModelRunner._init_post_memory_pool_components` в строго определенном месте: после создания пула (чтобы было что патчить) и до захвата decode-графа (чтобы прогревочные forward'ы уже видели пропатченные методы пула). При `mode == none` функция возвращает `None` и не делает ничего.

Дальше:

1. `attach_canary_buffers` подбирает «attacher» по классу пула. Зарегистрированы `MHATokenToKVPool`, `MHATokenToKVPoolFP4`, `SWAKVPool`, `DeepSeekV4TokenToKVPool` (`sglang/python/sglang/srt/kv_canary/pool_patcher/api.py`). Всё остальное — отказ на старте.
2. Для каждого буфера выделяется `torch.zeros(num_slots, 32, dtype=uint8)` на устройстве: 32 байта на слот (`CANARY_FIELDS_PER_SLOT = 4` поля по 8 байт — токен, позиция, предыдущий хеш, хеш реального KV). MHA-пул получает четыре таких буфера (голова и хвост для K и для V) — **128 байт на слот KV**; SWA- и DSV4-пулы — два буфера, 64 байта на слот.
3. `model.forward` оборачивается: перед вызовом выполняются пре-операции (запись канареек), после — пост-операции (проверка).

### Обнаружение

Нарушения копятся в кольцевом буфере на устройстве, откачиваются на хост и форматируются `violation_reporter.py` в стабильную однострочную запись:

```text
kv_canary violation: launch_tag=... fail_reason=... slot_idx=... position=... stored_token=... expected_token=... stored_chain_hash=0x... expected_aux=0x...
```

За ней идет многострочная расшифровка с заголовком `KV cache canary violation detected (kernel_kind=…, slot_idx=…, position=…)`, списком причин и сравнением «stored / expected».

- В режиме `log` каждое нарушение печатается через `logger.warning`, сервер продолжает работать.
- В режиме `raise` те же сообщения собираются в одно и бросаются как `RuntimeError` — то есть падает forward, а вместе с ним и процесс планировщика.

Отдельно работает «health checker»: если ожидаемые ядра канарейки не запускались с прошлой проверки, он бросает `RuntimeError: kv-canary: kernel_run_counter did not increase …` — защита от ситуации «канарейка включена, но фактически не исполняется».

### Тонкая настройка (только через переменные окружения)

`CanaryConfig.from_env` читает: `SGLANG_KV_CANARY_RING_CAPACITY` (размер кольца нарушений), `SGLANG_KV_CANARY_ENABLE_WRITE_INPUT_ASSERT`, `SGLANG_KV_CANARY_ENABLE_VERIFY_TOKEN_ASSERT`, `SGLANG_KV_CANARY_STATS_PRINT_EVERY_N_STEPS` (периодическая строка со статистикой). CLI-эквивалентов у них нет.

## Значения и формат

- `none` (по умолчанию) — механизм не устанавливается, накладных расходов нет вовсе.
- `log` — «безопасный для продакшена» по замыслу авторов: нарушения только логируются. Помните, что это все равно означает лишние буферы в VRAM, дополнительные ядра на каждом forward и запрет piecewise-графа на prefill.
- `raise` — режим CI: первое же расхождение убивает сервер. На рабочем сервере это означает потерю всех активных запросов.
- Глубину проверки реального содержимого KV задает отдельный аргумент `--kv-canary-real-data` (`none` / `partial` — первые 16 байт слота / `all` — весь слот).
- `--kv-canary-sweep-interval` без `--kv-canary` в `{log, raise}` — `ValueError: --kv-canary-sweep-interval requires --kv-canary in {log, raise}`.

## Когда использовать

- Воспроизводимая порча вывода при формально нормальной работе сервера: модель отвечает связно, но неверно, и подозрение падает на KV-кеш (свежий attention backend, спекулятивное декодирование, нестандартный размер страницы, экзотическая связка вытеснения и radix cache).
- Приемка нового окружения или сборки: прогон нагрузки под `--kv-canary raise` в отдельном стенде — быстрый способ поймать дефект, который иначе выглядит как «иногда модель глупеет».
- Не включайте на постоянно работающем сервере ради «страховки»: цена в VRAM и forward-времени постоянна, а без внешнего разбора логов нарушение все равно останется незамеченным.
- Не используйте `raise` там, где потеря активных запросов недопустима.

## Влияние на производительность и память

- **VRAM:** 128 байт на слот KV для MHA-пула (64 — для SWA/DSV4). Для пула на 1 000 000 токенов это 128 МиБ. Буферы выделяются **после** расчета размера KV-пула, отдельными тензорами, и в бюджет `--mem-fraction-static` не входят: при работе близко к пределу памяти включение канарейки может дать OOM на захвате CUDA graph.
- **Время forward:** дополнительные ядра записи и проверки на каждом шаге. `--kv-canary-real-data all` увеличивает объем чтения пула на каждой проверке.
- **Захват графов:** piecewise-backend на prefill запрещен ассертом; если он у вас выбран, потребуется `--cuda-graph-backend-prefill disabled` или `breakable`, а это само по себе меняет производительность prefill.
- **Лог:** в режиме `log` при систематическом дефекте нарушений может быть много, по строке на каждое.

## Взаимодействие с другими аргументами

- `--kv-canary-sweep-interval`: включает дополнительный полный обход слотов, удерживаемых радиксным деревом; требует `log` или `raise`.
- `--kv-canary-real-data`: глубина сверки реального содержимого KV, а не только метаданных канарейки.
- `--cuda-graph-backend-prefill`: piecewise-режим несовместим (ассерт в `install_canary`).
- `--mem-fraction-static`: буферы канарейки идут сверх посчитанного бюджета — при включении оставьте запас.
- `--speculative-num-steps`: значение прокидывается в менеджер канарейки; у draft-воркеров учитывается сдвиг слот-токен на единицу (`kv_token_id_vs_position_offset`).
- `--page-size` и `--attention-backend`: определяют класс пула, а значит — поддерживается ли канарейка вообще.

## Типовые проблемы и диагностика

- **Симптом:** `NotImplementedError: kv-canary: no attacher registered for pool class <имя>`. **Причина:** класс KV-пула не зарегистрирован (например, обычный MLA-пул, а не `DeepSeekV4TokenToKVPool`). **Лечение:** канарейка для этой модели/бэкенда недоступна; список поддержанных классов — в `pool_patcher/api.py`.
- **Симптом:** `AssertionError: kv-canary: piecewise cuda graph is not supported …`. **Лечение:** `--cuda-graph-backend-prefill disabled` (или `breakable`).
- **Симптом:** OOM при захвате CUDA graph сразу после включения `--kv-canary log`. **Причина:** дополнительные буферы вне бюджета. **Лечение:** уменьшить `--mem-fraction-static`.
- **Симптом:** `RuntimeError: kv-canary: kernel_run_counter did not increase …`. **Причина:** ядра канарейки не исполняются на ожидаемом пути. **Лечение:** это дефект конфигурации, а не ложное срабатывание; сообщите вместе с полной строкой запуска.
- **Проверка принятого значения:** при старте пишется строка `install_canary: disaggregation_mode=… config=CanaryConfig(mode=…, sweep_interval=…, real_kv_hash_mode=…) …` и строка `attach_canary_buffers: pool=… n_groups=… kinds=…`. Их отсутствие означает, что канарейка не установлена.

## В arriero

- **Совместимость с квалифицированным профилем.** Квалифицированная связка SGLang-KT работает с `Qwen/Qwen3-30B-A3B` (`docs/KTRANSFORMERS_OPERATIONS.md`, arriero), то есть с обычным MHA-пулом — класс зарегистрирован, канарейка установится. Для моделей на MLA (DeepSeek V3) регистрации нет, и старт упадет с `NotImplementedError`. Проверяйте это до того, как добавлять аргумент в определение инстанса.
- **Учет памяти.** Резервирование памяти в arriero задается декларативно в `memory` инстанса и сверяется с бюджетом пула (`docs/RESOURCE_MANAGEMENT.md`, arriero). Буферы канарейки в объявленную заявку не входят и не видны оценщику — при включении уменьшайте `--mem-fraction-static`, а не заявку.
- **Классификация лога.** Строка нарушения (`kv_canary violation: …`) не содержит слов, на которые реагирует разбор лога arriero (`apps/api/src/process/log-parsers/sglang.ts`), поэтому в режиме `log` инстанс останется в состоянии `ready` — нарушения придется искать в логе руками. В режиме `raise` процесс падает с трассировкой, и это менеджер увидит: строка `Traceback` переводит инстанс в `error`/`degraded`, а закрытие процесса записывается со `stopReason` `crash`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --kv-canary log --mem-fraction-static 0.80
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --kv-canary raise --kv-canary-sweep-interval 200 --kv-canary-real-data partial
```

## Источники

- `sglang/python/sglang/srt/kv_canary/api.py`
- `sglang/python/sglang/srt/kv_canary/config.py`
- `sglang/python/sglang/srt/kv_canary/pool_patcher/api.py`
- `sglang/python/sglang/srt/kv_canary/pool_patcher/adapters/mha.py`
- `sglang/python/sglang/srt/kv_canary/pool_patcher/adapters/dsv4.py`
- `sglang/python/sglang/srt/kv_canary/pool_patcher/buffer_alloc.py`
- `sglang/python/sglang/srt/kv_canary/runner/violation_reporter.py`
- `sglang/python/sglang/srt/kv_canary/runner/health_checker.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/server_args.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/RESOURCE_MANAGEMENT.md`, `apps/api/src/process/log-parsers/sglang.ts`
