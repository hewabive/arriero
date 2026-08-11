---
schema: 1
engine: sglang
primaryName: "--cuda-graph-backend-decode"
title: "--cuda-graph-backend-decode"
summary: Выбирает механизм захвата графа для фазы decode. По умолчанию `full` — один цельный CUDA graph на каждый размер батча; `disabled` полностью отключает decode-граф, а `tc_piecewise` сегодня не реализован и молча откатывается в `full`.
group: exec.graph
related:
  - --cuda-graph-config
  - --cuda-graph-backend-prefill
  - --disable-decode-cuda-graph
  - --cuda-graph-max-bs-decode
  - --cuda-graph-bs-decode
  - --debug-cuda-graph
  - --disable-cuda-graph
  - --mem-fraction-static
  - --disaggregation-mode
  - --device
  - --enable-memory-saver
---

# --cuda-graph-backend-decode

## Кратко

Decode-граф — главный источник ускорения шага декодирования: без него каждый токен стоит полного прохода по python-коду модели. `--cuda-graph-backend-decode` выбирает, как этот граф записывается. Практически значимы два значения: `full` (по умолчанию, один `torch.cuda.CUDAGraph` на форму) и `disabled` (граф не записывается вообще). `breakable` — сегментированный захват, нужный в основном для отладки и для конфигураций, где цельный захват падает; `tc_piecewise` для decode еще не реализован.

## Оригинальная справка

```text
Backend for the decode phase. Folds into cuda_graph_config[decode].backend.
```

## Паспорт аргумента

- Флаги: `--cuda-graph-backend-decode`
- Группа: `exec.graph`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `full`, `breakable`, `tc_piecewise`, `disabled`
- Значение по умолчанию: `null` — сам флаг не задан; поле `cuda_graph_config.decode.backend` в этом случае получает `full` из `default_cuda_graph_config()`
- Эффективное значение: складывается в `cuda_graph_config[decode].backend` в `_parse_cuda_graph_config`. Дальше может быть переписано: `--disaggregation-mode prefill` → `disabled`; `--device xpu` → `disabled` (если backend не задан) либо `disabled` с предупреждением для всего, кроме `full`; `--enable-mis` → `disabled`; HRM-Text и EmbeddingGemma → `disabled`. При `tc_piecewise` в `resolve_decode_backend` печатается warning и подставляется `full`
- Где объявлен: `ServerArgs.cuda_graph_backend_decode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config`) → `capture_decode_graph` и `resolve_decode_backend` при инициализации model runner

## Что меняет в движке

Значение попадает в `cuda_graph_config.decode.backend`, а `runner_backend/utils.py:resolve_decode_backend` превращает его в объект backend'а для `DecodeCudaGraphRunner`:

- **`full`** → `FullCudaGraphBackend`. На каждую форму из `cuda_graph_config[decode].bs` пишется один `torch.cuda.CUDAGraph`, охватывающий весь forward. Перед записью выполняются два прогрева, чтобы одноразовая инициализация ядер не попала в граф. Это путь по умолчанию и самый быстрый на реплее.
- **`breakable`** → `BreakableCudaGraphBackend`. Граф пишется как последовательность сегментов, разделенных eager-точками: между сегментами можно выполнять операции, непригодные для записи (коллективы с таймаутами, DeepEP a2a). На NVIDIA требует пакет `cuda-python`, иначе `ImportError: Breakable CUDA graph on NVIDIA requires the 'cuda-python' package`. Несовместим с memory saver: `NotImplementedError: Breakable CUDA graph is not compatible with memory saver mode`. Это единственный backend, с которым работает `--debug-cuda-graph`.
- **`tc_piecewise`** → **не реализован для decode**. `resolve_decode_backend` один раз печатает `cuda_graph_config decode='tc_piecewise' is not yet implemented; falling back to 'full'.` и создает `FullCudaGraphBackend`. Значение принимается argparse и проходит валидацию, но ничего не меняет.
- **`disabled`** → `capture_decode_graph` возвращает пустой результат, decode-runner не создается, декод идет через `EagerRunner`.

Платформенные исключения: на `--device npu` всегда используется `NPUCudaGraphBackend`, на `--device xpu` — `FullXPUGraphBackend`, причем любой backend, кроме `full` и `disabled`, отвергается (`ValueError: XPU only supports cuda_graph_config decode backend 'full'`).

## Значения и формат

- Значение вне списка отвергает argparse (`invalid choice`).
- Не задавать флаг — значит получить `full`. Отдельного значения «auto» нет.
- Флаг перекрывает `--disable-decode-cuda-graph` и legacy `--disable-cuda-graph`: они применяются раньше в `_parse_cuda_graph_config`. То есть `--disable-decode-cuda-graph --cuda-graph-backend-decode full` даст включенный граф.
- Любое явное значение фиксирует пару `(decode, "backend")` в `_cuda_graph_config_locked`. Это отключает две автоматики: назначение роли при `--disaggregation-mode prefill` и XPU-дефолт. Правила `--enable-mis`, HRM-Text и EmbeddingGemma замок **не** уважают и гасят граф в любом случае.

## Когда использовать

- `disabled` — когда старт нужно ускорить любой ценой (диагностика, короткие проверки конфигурации), когда захват падает по памяти и уменьшать `--cuda-graph-max-bs-decode` некуда, или когда квантизация несовместима с записью графа (апстрим прямо рекомендует это для `--torchao-config int8dq`).
- `breakable` — когда цельный захват падает или зависает на коллективах, и когда нужен `--debug-cuda-graph` (он требует именно этот backend).
- Не задавайте `tc_piecewise`: это молчаливый `full` с лишним warning'ом в логе.
- Не задавайте `full` «для верности» на PD-роли `prefill`: явное значение снимает автоматическое отключение и заставит prefill-сервер тратить время старта и VRAM на графы, которые он никогда не воспроизведет.

## Влияние на производительность и память

- **Время старта.** `full` платит захватом всех форм из `bs`: на профиле arriero (RTX A5000, Qwen3-30B-A3B с оффлоадом экспертов на CPU, две захваченные формы) захват занял 47.9 с и 0.14 ГиБ (`docs/qualification/ktransformers/0.6.4-2026-07-30.md`). На плотной модели с `max_bs 160` захватывается 24 формы, с `max_bs 512` — 52; время растет примерно линейно.
- **VRAM.** Захваченные графы живут в общем mempool до конца жизни процесса. Априорная оценка в автоподборе `--mem-fraction-static` — `decode.max_bs * 2` МиБ; фактическое значение печатается в строке `Capture target decode CUDA graph end. … mem usage=… GB`. При `disabled` оба слагаемых равны нулю.
- **Latency.** Именно ради нее граф и существует: реплей убирает python-overhead запуска сотен ядер на каждый токен. На маленьких батчах и маленьких моделях разница в разы; на больших батчах доля overhead падает.
- `breakable` дороже `full` и по памяти (несколько объектов CUDAGraph на форму), и на реплее (между сегментами исполняется eager-код).

## Взаимодействие с другими аргументами

- `--cuda-graph-config`: JSON-ключ `decode.backend` перекрывает этот флаг.
- `--disable-decode-cuda-graph`: то же, что `disabled`, но ниже по приоритету.
- `--cuda-graph-max-bs-decode` / `--cuda-graph-bs-decode`: имеют смысл только при backend'е, отличном от `disabled`.
- `--debug-cuda-graph`: требует `breakable`; при `full` захват падает ассертом `Breakable CUDA graph is required for --debug-cuda-graph`.
- `--enable-memory-saver`: несовместим с `breakable`.
- `--mem-fraction-static`: при `disabled` из автоподбора уходит слагаемое `decode.max_bs * 2` МиБ (и +2 ГиБ резерва DeepEP a2a), то есть KV-пул автоматически становится больше.
- `--disaggregation-mode prefill`: гасит decode-граф, если backend не задан явно.
- `--enable-mis`: гасит графы обеих фаз безусловно и пишет `CUDA graph is disabled because --enable-mis is set.`
- `--device xpu` / `--device npu`: свои backend'ы, см. выше.

## Типовые проблемы и диагностика

- **Симптом:** в логе `cuda_graph_config decode='tc_piecewise' is not yet implemented; falling back to 'full'.` **Причина:** задан нереализованный backend. **Решение:** убрать флаг.
- **Симптом:** `ImportError: Breakable CUDA graph on NVIDIA requires the 'cuda-python' package.` **Решение:** установить `cuda-python` в окружение движка либо вернуться на `full`.
- **Симптом:** `NotImplementedError: Breakable CUDA graph is not compatible with memory saver mode`. **Решение:** снять `--enable-memory-saver` или backend `breakable`.
- **Симптом:** `torch.OutOfMemoryError` в строках `Capturing batches (bs=… avail_mem=… GB)`. **Причина:** памяти не хватило на захват. **Решение:** уменьшить `--cuda-graph-max-bs-decode` или `--mem-fraction-static` на 0.02–0.05; крайняя мера — `disabled`.
- **Что смотреть:** `Capture target decode CUDA graph begin. backend=full, num_tokens_per_req=1, bs=[…], avail mem=… GB` и парная строка `end. elapsed=… s, mem usage=… GB, avail mem=… GB.` Отсутствие обеих строк означает `disabled`. В arriero эти строки видны в фильтрованном логе инстанса, и парсер `apps/api/src/process/log-parsers/sglang.ts` показывает их как стадию загрузки `warmup` (90 %).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-decode disabled
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-decode breakable --debug-cuda-graph
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/utils.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/full_cuda_graph_backend.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/breakable_cuda_graph_backend.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- arriero: `docs/qualification/ktransformers/0.6.4-2026-07-30.md`
