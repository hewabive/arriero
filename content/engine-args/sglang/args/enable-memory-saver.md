---
schema: 1
engine: sglang
primaryName: "--enable-memory-saver"
title: "--enable-memory-saver"
summary: Разрешает временно отдавать VRAM (веса, KV-пул, CUDA graph) без перезапуска процесса через `POST /release_memory_occupation` и возвращать ее через `/resume_memory_occupation`. Нужен внешнему оркестратору RL-обучения; требует установленного пакета `torch-memory-saver`, иначе сервер падает на старте.
group: exec.features
related:
  - --enable-weights-cpu-backup
  - --enable-draft-weights-cpu-backup
  - --weight-cache-mode
  - --cuda-graph-backend-decode
  - --cuda-graph-backend-prefill
  - --enable-breakable-cuda-graph
  - --api-key
  - --admin-api-key
  - --device
---

# --enable-memory-saver

## Кратко

Флаг существует ради одного сценария: rollout-сервер и тренер живут на одних и тех же картах, и между шагами обучения сервер должен «уснуть», освободив VRAM, а потом проснуться без перезагрузки весов с диска и без повторного захвата CUDA graph. Реализуется это через `torch-memory-saver` — аллокатор, который умеет отвязать физические страницы от виртуальных адресов и вернуть их обратно на те же адреса, поэтому захваченный граф остается валидным. Без флага соответствующие HTTP-эндпоинты остаются, но не освобождают ничего и печатают предупреждение. Обычному инференс-инстансу флаг не нужен: цена — это дополнительный слой аллокации на всех крупных буферах и жесткое требование к пакету.

## Оригинальная справка

```text
Allow saving memory using release_memory_occupation and resume_memory_occupation
```

## Паспорт аргумента

- Флаги: `--enable-memory-saver`
- Группа: `exec.features`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: не переписывается ни `__post_init__`, ни реестром `arg_groups/overrides.py`. Но действует несовместимость: `BreakableCudaGraphBackend.__init__` поднимает `NotImplementedError: Breakable CUDA graph is not compatible with memory saver mode`, если флаг включен **и** задан `SGLANG_MEMORY_SAVER_CUDA_GRAPH=1`
- Где объявлен: `ServerArgs.enable_memory_saver`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → запуск scheduler-процессов внутри `memory_saver_adapter.configure_subprocess()` → создание адаптеров в `Scheduler` и `ModelRunner` → выделение весов и KV-пула внутри `region(...)` → захват CUDA graph внутри `cuda_graph(...)` → HTTP `/release_memory_occupation` и `/resume_memory_occupation`

## Что меняет в движке

`TorchMemorySaverAdapter.create(enable=...)` (`utils/torch_memory_saver_adapter.py`) возвращает либо реальный адаптер, либо no-op. Ключевая деталь: при `enable=True` и отсутствующем пакете адаптер **пробрасывает** `ImportError` наружу, предварительно напечатав `enable_memory_saver is enabled, but torch-memory-saver is not installed. Please install it via pip3 install torch-memory-saver.` То есть это не деградация, а отказ на старте.

Адаптер создается в нескольких местах: в `entrypoints/engine.py` — чтобы обернуть запуск дочерних процессов scheduler'а (`configure_subprocess`), в `managers/scheduler.py`, в `model_executor/model_runner.py`, в бэкендах CUDA graph и во всех пулах памяти (`mem_cache/memory_pool.py` и его варианты для DeepSeek-V4, HiSparse, NPU).

Выделения помечаются тегами (`srt/constants.py`):

- `weights` — веса модели (`load_model_with_memory_saver`);
- `kv_cache` — KV-пул и `req_to_token`;
- `cuda_graph` — память захваченных графов.

### Что делают эндпоинты

`POST /release_memory_occupation` с телом `{"tags": ["kv_cache"]}` (либо без тела — тогда все три тега) обрабатывается в `managers/scheduler_components/weight_updater.py`:

- ассерт `release_memory_occupation should be called only when server is idle.` — вызов при активных запросах отвергается;
- для `kv_cache`: остановка disaggregation-очередей, `memory_saver_adapter.pause("kv_cache")`, `flush_cache()`;
- для `weights`: проверка `--weight-cache-mode off` (иначе `RuntimeError`, потому что веса расшарены через CUDA IPC), экспорт «статического состояния» модели (`_export_static_state`), барьер по TP-группе, `pause("weights")`;
- для `cuda_graph`: `pause("cuda_graph")`.

`POST /resume_memory_occupation` выполняет обратное в обратном порядке и восстанавливает статическое состояние.

Важно про содержимое: без CPU-бэкапа `pause` освобождает физические страницы, и после `resume` на тех же адресах лежит **неинициализированная** память. Для KV-пула это нормально (кеш все равно сброшен), для весов — нет: их надо либо восстановить из host-копии (`--enable-weights-cpu-backup`), либо загрузить заново одним из `update_weights_*`. Именно поэтому в RL-цикле после пробуждения тренер сразу пушит новые веса.

### Расхождение с текстом справки

Справки `--enable-weights-cpu-backup` и `--enable-draft-weights-cpu-backup` говорят про «`release_weights_occupation` and `resume_weights_occupation`». Таких методов и эндпоинтов в checkout'е нет — есть только `release_memory_occupation` / `resume_memory_occupation` с тегом `weights`. Формулировка в help устарела; ориентируйтесь на `entrypoints/http_server.py`.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Требует пакет `torch-memory-saver` в том же окружении, что и SGLang.
- На XPU не поддерживается (апстрим-таблица `docs/docs/hardware-platforms/xpu.mdx`).
- Гранулярность освобождения задается не флагом, а телом HTTP-запроса (`tags`).
- `SGLANG_MEMORY_SAVER_CUDA_GRAPH=1` — отдельная переменная, включающая обертку памяти графов; без нее `cuda_graph`-тег на большинстве бэкендов не работает.

## Когда использовать

- RL-обучение с колокацией rollout и тренера на одних GPU — единственный штатный сценарий, описанный апстримом (`sglang/docs/docs/advanced_features/sglang_for_rl.mdx`).
- Оркестратор, которому нужно на время отдать карту другой задаче и вернуться без перезагрузки весов и без повторного захвата графов.
- Не включайте на обычном инференс-инстансе: вы получите зависимость от внешнего пакета, лишний слой аллокации и несовместимость с частью бэкендов CUDA graph, не получив ничего взамен — процесс сам себе память не освобождает, освобождение всегда инициируется извне.
- Не рассматривайте флаг как «экономию памяти»: он не уменьшает потребление, он делает его управляемым снаружи.
- Не оставляйте эндпоинты открытыми: при незаданных `--api-key` и `--admin-api-key` уровень `ADMIN_OPTIONAL` пропускает запрос без ключа, то есть любой, кто дотянулся до порта, может выгрузить веса вашего сервера.

## Влияние на производительность и память

- **VRAM в установившемся режиме.** Не меняется. Меняется возможность отдать ее по запросу.
- **RAM хоста.** Сам по себе не растет; растет при `--enable-weights-cpu-backup` (см. его справку).
- **Latency.** Аллокация через `torch_memory_saver` добавляет накладные расходы на выделениях внутри помеченных регионов; горячий путь forward'а они не затрагивают, потому что там выделяется из обычного кеша torch.
- **Время старта.** Плюс инициализация библиотеки; при `configure_subprocess` — небольшой оверхед на запуск каждого scheduler-процесса.
- **Пауза/возобновление.** Освобождение и возврат KV-пула — это доли секунды; возврат весов без CPU-бэкапа требует последующей загрузки весов, а это уже единицы-десятки секунд.

## Взаимодействие с другими аргументами

- `--enable-weights-cpu-backup` / `--enable-draft-weights-cpu-backup`: без этого флага они бессмысленны — их значение читается ровно в том месте, где веса выделяются в регион memory saver'а.
- `--weight-cache-mode`: любое значение, кроме `off`, делает освобождение и возврат весов невозможным (`RuntimeError` с объяснением про CUDA IPC).
- `--enable-breakable-cuda-graph` / `--cuda-graph-backend-decode breakable` / `--cuda-graph-backend-prefill breakable`: `NotImplementedError` при `SGLANG_MEMORY_SAVER_CUDA_GRAPH=1`.
- `--api-key` / `--admin-api-key`: единственная защита эндпоинтов освобождения памяти.
- `--device`: на XPU не поддерживается.

## Типовые проблемы и диагностика

- **Симптом:** `ImportError` при старте плюс строка `enable_memory_saver is enabled, but torch-memory-saver is not installed.` **Причина:** пакета нет в окружении. **Решение:** установить или убрать флаг.
- **Симптом:** `` `release_memory_occupation` will not save memory because torch_memory_saver is not enabled. `` **Причина:** эндпоинт вызван на сервере без флага. **Решение:** перезапустить с флагом.
- **Симптом:** `AssertionError: release_memory_occupation should be called only when server is idle.` **Причина:** есть незавершенные запросы. **Решение:** дренировать очередь перед вызовом.
- **Симптом:** `RuntimeError: [weight_cache] release_memory_occupation of model weights is not supported while the weight cache is active`. **Причина:** `--weight-cache-mode` не `off`.
- **Симптом:** после `resume` модель выдает мусор. **Причина:** веса освобождались без CPU-бэкапа и не были загружены заново.
- **Что смотреть:** итоговый дамп `server_args=` при старте и ответы самих эндпоинтов.
- **В arriero:** прокси arriero этих эндпоинтов **не использует** — у движка `ktransformers` в дескрипторе `modelLoadUnload: false` и `slotSave: false`, а политика вытеснения по умолчанию `idle-only` означает остановку процесса, а не освобождение памяти внутри него (`docs/RESOURCE_MANAGEMENT.md`, `docs/API_PROXY_FOUNDATION.md`). Освобождение памяти через `/release_memory_occupation` останется вашим ручным действием, и учет памяти arriero об этом не узнает — capacity-ledger считает по объявленному draw инстанса, а не по фактическому потреблению.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --enable-memory-saver --api-key secret
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-32B --enable-memory-saver --enable-weights-cpu-backup --weight-cache-mode off
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/torch_memory_saver_adapter.py`
- `sglang/python/sglang/srt/constants.py`
- `sglang/python/sglang/srt/managers/scheduler_components/weight_updater.py`
- `sglang/python/sglang/srt/entrypoints/engine.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/utils/auth.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/breakable_cuda_graph_backend.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/docs/docs/advanced_features/sglang_for_rl.mdx`
- `sglang/docs/docs/hardware-platforms/xpu.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`, `docs/API_PROXY_FOUNDATION.md`
