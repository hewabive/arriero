---
schema: 1
engine: sglang
primaryName: "--cuda-graph-max-bs-prefill"
title: "--cuda-graph-max-bs-prefill"
summary: Верхняя граница захватываемой формы prefill-графа. Несмотря на имя, измеряется в **токенах**, а не в запросах: по умолчанию равна `--chunked-prefill-size` (для MLA-моделей — 2048).
group: exec.graph
related:
  - --cuda-graph-bs-prefill
  - --piecewise-cuda-graph-max-tokens
  - --cuda-graph-max-bs-decode
  - --cuda-graph-backend-prefill
  - --disable-prefill-cuda-graph
  - --cuda-graph-config
  - --chunked-prefill-size
  - --max-total-tokens
  - --context-length
  - --mem-fraction-static
  - --enable-dp-attention
---

# --cuda-graph-max-bs-prefill

## Кратко

Prefill-граф захватывается по количеству токенов в объединенном батче, а не по числу запросов. `--cuda-graph-max-bs-prefill` задает максимум этой величины, из него генерируется весь список бакетов, и от длины списка зависит и время старта, и резерв VRAM. Имя ключа (`max_bs`) унаследовано от общей схемы `PhaseConfig`, единица измерения — токены; устаревший псевдоним назывался честнее: `--piecewise-cuda-graph-max-tokens`.

## Оригинальная справка

```text
Maximum batch size captured for the prefill cuda graph.
```

## Паспорт аргумента

- Флаги: `--cuda-graph-max-bs-prefill`
- Группа: `exec.graph`
- Тип значения: int (число токенов)
- Допустимые значения: положительное целое; argparse границ не проверяет
- Значение по умолчанию: `null` — «подберет движок»
- Эффективное значение: в `_handle_gpu_memory_settings` при незаданном флаге ставится `--chunked-prefill-size` для не-MLA моделей и `2048` для MLA; затем ограничивается сверху `--max-total-tokens`, если тот задан, и величиной 4096, если в пути модели встречается `llama-2`. При включенном DP attention пересчитывается на `chunked_prefill_size // dp_size`. Для EmbeddingGemma поднимается до `max(context_len, 16384)`. Если задан `--cuda-graph-bs-prefill`, из него берется весь список, а этот флаг не применяется. При MoE a2a backend `deepep` и `breakable` список выравнивается по 8, и `max_bs` становится последним выровненным элементом
- Где объявлен: `ServerArgs.cuda_graph_max_bs_prefill`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный. Устаревший псевдоним — `--piecewise-cuda-graph-max-tokens`
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config` → `_handle_gpu_memory_settings`) → `capture_prefill_graph` → захват

## Что меняет в движке

### Как из значения получается список форм

`_generate_prefill_cuda_graph_batch_sizes(max_bs)` строит сетку по числу токенов и отсекает все, что больше `max_bs`:

`range(4, 33, 4)` + `range(48, 257, 16)` + `range(288, 513, 32)` + `range(576, 1025, 64)` + `range(1280, 4097, 256)` + `range(4608, max_bs+1, 512)`.

Численно: `max_bs 2048` → 42 бакета, `4096` → 50, `8192` → 58, `16384` → 74. В отличие от decode, сам `max_bs` **не** дописывается принудительно: если он не попал в сетку, максимальный бакет будет меньше него.

### Как список урезается дальше

`capture_prefill_graph` в `model_runner_components/cuda_graph_setup.py` считает потолок по емкости:

- для backend'а `full`: `max_capture_requests = full_prefill_max_req` (по умолчанию `max(chunked_prefill_size // 512, 1)`), ограниченное размером `req_to_token_pool`;
- для остальных backend'ов: `max_capture_requests = req_to_token_pool.size`;
- `max_capture_tokens = max_capture_requests * context_length`.

Бакеты больше `max_capture_tokens` выбрасываются. Если после этого не осталось ни одного, печатается предупреждение `Disable prefill CUDA graph capture because no configured capture size fits backend=… with max_capture_tokens=…` и prefill уходит в eager.

### Как бакеты применяются на запросах

Реальное число токенов округляется вверх до ближайшего захваченного бакета (`_pad_to_bucket`). Батч отвергается и уходит в eager, если он больше максимального бакета либо если округление увеличивает число токенов более чем вдвое (`_MAX_PREFILL_CUDA_GRAPH_PADDING_FACTOR = 2`). То есть редкая сетка на верхнем конце не только теряет вычисления на padding, но и просто выключает граф для «неудобных» размеров.

## Значения и формат

- Целое число токенов. Ноль или отрицательное значение приведет к пустому списку и предупреждению `Disable prefill CUDA graph because the capture size is not set`.
- Специальных значений (`-1`, `auto`) нет; «авто» — это не задавать флаг.
- Значение больше `--chunked-prefill-size` бесполезно для обычной нагрузки: планировщик все равно не соберет prefill-батч крупнее чанка.
- Явное значение фиксирует пару `(prefill, "max_bs")`, из-за чего пропускается пересчет под DP attention и подъем буфера для EmbeddingGemma. При `--enable-dp-attention` это опасно: `chunked_prefill_size` делится на `dp_size`, а ваш `max_bs` останется прежним и может превысить бюджет `max_num_tokens` у MoE all-to-all.

## Когда использовать

- Сократить старт: `--cuda-graph-max-bs-prefill 2048` вместо автоподобранных 8192 убирает 16 бакетов из 58 (и это самые дорогие, крупные бакеты).
- Убрать регресс на длинных prefill: если ваш профиль — редкие длинные запросы, верхние бакеты почти не используются, а память под них занята постоянно.
- Поднять, если вы увеличили `--chunked-prefill-size` вручную и хотите, чтобы граф покрывал новый максимум.
- Не поднимать выше `--chunked-prefill-size`, если только вы не отключили chunked prefill (`--chunked-prefill-size -1`) — тогда prefill-батч ограничен `--max-prefill-tokens`, и осмысленный потолок другой.
- Не задавать вместе с `--enable-dp-attention`, если не понимаете последствий: автоматический пересчет под DP не сработает.

## Влияние на производительность и память

- **Время старта.** Число бакетов растет примерно линейно от 42 (2048) до 74 (16384). При backend'е `tc_piecewise` каждый бакет проходит еще и компиляцию (`Compiling num tokens (num_tokens=…)`) — это самая дорогая часть старта.
- **VRAM.** В автоподборе `--mem-fraction-static` prefill-граф оценивается как `len(prefill.bs) * 8` МиБ для не-MLA моделей и фиксированные 1.5 ГиБ для MLA — то есть для MLA этот флаг на резерв **не** влияет, а для не-MLA влияет через длину списка. Фактический расход — в строке `Capture target prefill CUDA graph end. … mem usage=… GB`.
- **TTFT.** Понижение порога переводит крупные prefill в eager: TTFT на длинных запросах вырастет, на коротких не изменится.
- Padding на prefill дороже, чем на decode: лишние токены — это лишние строки в attention и MLP, а не просто лишние слоты.

## Взаимодействие с другими аргументами

- `--cuda-graph-bs-prefill`: полностью заменяет генерацию списка, этот флаг тогда не применяется.
- `--cuda-graph-config`: ключ `prefill.max_bs` перекрывает флаг.
- `--piecewise-cuda-graph-max-tokens` (устаревший): то же поле под старым именем.
- `--chunked-prefill-size`: источник дефолта для не-MLA моделей.
- `--max-total-tokens`: жесткий потолок автоподобранного значения.
- `--context-length`: через `max_capture_tokens` ограничивает, какие бакеты вообще имеют смысл (особенно при backend'е `full` с маленьким `full_prefill_max_req`).
- `--mem-fraction-static`: связь через `reserve_for_graph_mb()`, только для не-MLA моделей.
- `--enable-dp-attention`: пересчитывает значение, но лишь если оно не задано явно.
- `--cuda-graph-backend-prefill` / `--disable-prefill-cuda-graph`: при `disabled` значение остается в конфиге, но не используется.

## Типовые проблемы и диагностика

- **Симптом:** `Disable prefill CUDA graph capture because no configured capture size fits backend=full with max_capture_tokens=…`. **Причина:** `full_prefill_max_req * context_length` меньше самого маленького бакета (4 токена). **Решение:** поднять `full_prefill_max_req` в `--cuda-graph-config` или сменить backend.
- **Симптом:** в логе `Breakable prefill CUDA graph with DeepEP requires bucket sizes divisible by 8; aligning […] -> […]`. **Причина:** DeepEP a2a требует кратности 8; список выровнен автоматически, `max_bs` при этом мог вырасти.
- **Симптом:** задали 16384, а максимальный бакет в логе 15872. **Причина:** сетка идет шагом 512 от 4608 и не обязана попадать точно в `max_bs`.
- **Симптом:** после включения DP attention захват префилла падает или зависает на all-to-all. **Причина:** явный `max_bs` пережил автоматический пересчет на `chunked_prefill_size // dp_size`. **Решение:** убрать флаг либо задать значение, уже поделенное на `dp_size`.
- **Что смотреть:** `Capture target prefill CUDA graph begin. backend=…, num_tokens=[4, 8, …], avail mem=… GB` — здесь виден итоговый список; и `cuda_graph_config=` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-max-bs-prefill 2048
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --chunked-prefill-size 4096 --cuda-graph-max-bs-prefill 4096 --cuda-graph-backend-prefill breakable
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`
