---
schema: 1
engine: sglang
primaryName: "--cuda-graph-max-bs"
title: "--cuda-graph-max-bs"
summary: Устаревший алиас `--cuda-graph-max-bs-decode` — верхняя граница batch size, для которого захватывается decode-граф. Значение определяет и число захватываемых форм, и резерв VRAM под графы в автоподборе `--mem-fraction-static`.
group: null
related:
  - --cuda-graph-max-bs-decode
  - --cuda-graph-bs-decode
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-backend-decode
  - --cuda-graph-config
  - --mem-fraction-static
  - --max-running-requests
  - --chunked-prefill-size
  - --disable-cuda-graph-padding
---

# --cuda-graph-max-bs

## Кратко

Максимальный batch size, для которого SGLang захватит decode-граф. Батч больше этого значения выполняется eager-путем, батч меньше — дополняется (padding) до ближайшего захваченного размера. Флаг устарел и переименован в `--cuda-graph-max-bs-decode` — просто потому, что появилась вторая фаза со своим потолком (`--cuda-graph-max-bs-prefill`).

Это единственный самый заметный рычаг между «долгий старт и много VRAM под графы» и «быстрый decode на больших батчах».

## Оригинальная справка

```text
Deprecated alias for --cuda-graph-max-bs-decode.
```

## Паспорт аргумента

- Флаги: `--cuda-graph-max-bs`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне пофазной группы `exec.graph`, где живет актуальный флаг
- Тип значения: int
- Допустимые значения: положительное целое; argparse границ не проверяет
- Значение по умолчанию: у самого алиаса значения по умолчанию нет — argparse не подставляет ничего, а `dest` (`cuda_graph_max_bs_decode`) уже инициализирован значением `None` от актуального флага
- Эффективное значение: `None` означает «подберет движок». `_handle_gpu_memory_settings` выбирает потолок по объему карты и `--tp-size`: <20 ГиБ → 8; <35 ГиБ → 24 при `tp_size < 4`, иначе 80; <60 ГиБ → 32 / 160; <90 ГиБ и <160 ГиБ → 256 / 512; выше → 512. Если емкость карты определить не удалось — 160. Кроме того, при явно заданном `--cuda-graph-bs-decode` потолок пересчитывается как `max(bs)`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `cuda_graph_max_bs_decode`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--cuda-graph-max-bs-decode`
- Этап применения: разбор CLI (предупреждение) → `_handle_cuda_graph_config` → `_handle_gpu_memory_settings` (подбор значения и резерв VRAM) → `get_batch_sizes_to_capture` → захват decode-графа

## Что меняет в движке

### Предупреждение и трансляция

```text
'--cuda-graph-max-bs' is deprecated and will be removed in a future release. Use '--cuda-graph-max-bs-decode' instead.
```

Печатается на этапе разбора аргументов, до настройки формата логов, поэтому строка стоит в самом начале вывода без временного префикса. Значение кладется прямо в `cuda_graph_max_bs_decode`, дальше оно неотличимо от заданного актуальным флагом.

### Из потолка получается список форм

`_generate_decode_cuda_graph_batch_sizes(max_bs)` строит список размеров, для которых будет захвачен отдельный граф:

```python
capture_bs = [1, 2, 4, 8, 12] + list(range(16, 257, 8)) + list(range(272, 512, 16)) + list(range(512, max_bs + 1, 32))
capture_bs = [bs for bs in capture_bs if bs <= max_bs]
if max_bs not in capture_bs:
    capture_bs.append(max_bs)
```

Практические количества: `max_bs=8` → 4 формы, `24` → 7, `32` → 8, `80` → 14, `160` → 24, `256` → 36, `512` → 52. При включенном спекулятивном декодировании применяется другая, более частая сетка (для `max_bs=256` это 51 форма), потому что там важнее точность на малых батчах.

Далее `get_batch_sizes_to_capture` (`sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`) отфильтровывает формы по выравниванию под attention-TP и обрезает их размером пула запросов `req_to_token_pool.size`. Если верхняя граница списка оказалась выше этого предела, в список отдельно добавляется сам предел, чтобы максимальный реальный батч все же был захвачен.

### Стоимость

Каждая форма — отдельный проход захвата, поэтому и время, и память растут примерно линейно по числу форм. В логе:

```text
Capture target decode CUDA graph begin. backend=full, num_tokens_per_req=1, bs=[1, 2, 4, ...], avail mem=12.41 GB
Capture target decode CUDA graph end. elapsed=18.62 s, mem usage=0.43 GB, avail mem=11.98 GB.
```

Во время захвата на ранге 0 идет прогресс-бар `Capturing batches (bs=… avail_mem=… GB)` — по нему видно, на какой форме процесс остановился, если он падает.

Оценочный резерв, который движок закладывает **до** захвата, считает `reserve_for_graph_mb()`: `max_bs * 2` МиБ на decode-граф, плюс `max_bs * dp_size * 3` МиБ при DP attention (и еще `max_bs * dp_size * 1.5` при `max_bs > 300`). Этот резерв — вход автоподбора `--mem-fraction-static`, поэтому при незаданном `--mem-fraction-static` увеличение потолка автоматически ужимает KV-пул, а при заданном — приводит к OOM на захвате.

## Значения и формат

- Одно положительное целое. Ноль и отрицательные значения argparse примет, но `get_batch_sizes_to_capture` затем упадет на `assert len(capture_bs) > 0 and capture_bs[0] > 0`.
- Значения нет отдельного «авто»: не задавать — и есть авто.
- Потолок ниже реального рабочего батча не является ошибкой: батчи выше него просто идут eager-путем, и в строках `Decode batch, …` появляется `cuda graph: False`.
- `--cuda-graph-bs-decode` (и его устаревший алиас `--cuda-graph-bs`) сильнее: заданный список перезаписывает потолок значением `max(bs)`.
- В YAML-конфиге через `--config` ключ `cuda-graph-max-bs-decode` задать нельзя — он отвергается из-за этого самого устаревшего алиаса, сидящего на том же `dest`. Обходной путь — `cuda-graph-config`.

## Когда использовать

- Не использовать: пишите `--cuda-graph-max-bs-decode`.
- Сам параметр (под новым именем) стоит задавать, когда реальная конкурентность заведомо мала: сервер на 24-ГиБ карте с `--max-running-requests 4` не нуждается в 24 захваченных формах до 24 — потолок 8 сокращает старт и освобождает память.
- И наоборот: если сервер регулярно работает батчами больше автоматического потолка, каждая такая итерация выполняется eager-путем; потолок надо поднимать вместе с `--mem-fraction-static` вниз.
- Не поднимать «про запас» на карте, где память уже расписана: резерв растет линейно, а падение приходит на этапе захвата.

## Влияние на производительность и память

- VRAM: примерно `max_bs * 2` МиБ по оценке движка; фактическая величина — в `mem usage` строки `Capture … end` и в `memory_usage.graph.decode` из `GET /server_info`.
- Время старта: линейно по числу форм; на больших потолках захват занимает десятки секунд. Точное значение — `elapsed` в той же строке и `startup_time.cuda_graph.decode` в `/server_info`.
- Latency decode: батчи в пределах потолка идут по графу, остальные — eager. Разрыв на маленьких батчах кратный.
- Throughput: косвенно, через KV-пул — резерв под графы вычитается из статики при автоподборе `--mem-fraction-static`.

## Взаимодействие с другими аргументами

- `--cuda-graph-max-bs-decode`: актуальное имя того же поля.
- `--cuda-graph-bs-decode`: явный список форм; при его наличии потолок становится `max(bs)`, а этот аргумент теряет смысл.
- `--cuda-graph-max-bs-prefill`: независимый потолок другой фазы, измеряемый в токенах, а не в запросах.
- `--cuda-graph-backend-decode disabled`: обнуляет и захват, и резерв.
- `--mem-fraction-static`: главный партнер. При незаданном значении потолок влияет на размер KV-пула; при заданном — на риск OOM при захвате.
- `--max-running-requests`: определяет реально достижимый батч; держать потолок сильно выше него бессмысленно.
- `--disable-cuda-graph-padding`: меняет сетку форм на сплошную `1..max_bs`, из-за чего число захватов растет на порядок.
- `--speculative-algorithm`: переключает генератор форм на более плотную сетку.

## Типовые проблемы и диагностика

- `'--cuda-graph-max-bs' is deprecated …` в начале лога — замените на `--cuda-graph-max-bs-decode`.
- `torch.OutOfMemoryError` во время `Capturing batches (bs=…)` — резерв меньше реальной стоимости графов. Апстрим-подсказка `CUDA_GRAPH_CAPTURE_FAILED_MSG` предлагает по порядку: уменьшить `--mem-fraction-static` (0.8, 0.7), уменьшить `--cuda-graph-max-bs-decode` (например, до 16), в крайнем случае `--cuda-graph-backend-decode=disabled`.
- `Capture cuda graph failed: …` с последующей подсказкой — то же самое, но обернутое исключением.
- Старт стал заметно дольше после смены карты — сработала другая ветка таблицы подбора потолка (например, 24 → 256 при переезде с 4090 на H100).
- `cuda graph: False` в строках decode-батчей при нормальной нагрузке — реальный батч выше потолка.
- Что смотреть: `cuda_graph_config=` в дампе `server_args=`, строки `Capture target decode CUDA graph begin/end`, `GET /server_info` (`memory_usage.graph`, `startup_time.cuda_graph`).

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-max-bs-decode 16
```

Согласованная пара для тесной карты:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-max-bs-decode 8 --max-running-requests 8 --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner_backend_utils/__init__.py`
