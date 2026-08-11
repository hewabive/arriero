---
schema: 1
engine: sglang
primaryName: "--cuda-graph-max-bs-decode"
title: "--cuda-graph-max-bs-decode"
summary: Верхняя граница размера батча, для которого записывается decode-граф. Не задан — подбирается по объему видеопамяти и `--tp-size` (от 8 на картах меньше 20 ГиБ до 512 на B200); от него же линейно зависит и время захвата, и резерв VRAM в автоподборе `--mem-fraction-static`.
group: exec.graph
related:
  - --cuda-graph-bs-decode
  - --cuda-graph-max-bs
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-backend-decode
  - --disable-decode-cuda-graph
  - --disable-cuda-graph-padding
  - --cuda-graph-config
  - --mem-fraction-static
  - --max-running-requests
  - --tp-size
  - --speculative-algorithm
  - --enable-dp-attention
---

# --cuda-graph-max-bs-decode

## Кратко

Decode-граф записывается не для произвольного батча, а для фиксированного набора размеров. `--cuda-graph-max-bs-decode` задает верхнюю границу этого набора; сам набор генерируется из нее по зашитой сетке. Батч больше границы декодируется в eager-режиме, батч меньше — дополняется (padding) до ближайшего захваченного размера. Это одна из двух ручек (вторая — `--cuda-graph-bs-decode`), которые напрямую определяют, сколько секунд занимает старт и сколько мегабайт видеопамяти уходит на графы.

## Оригинальная справка

```text
Maximum batch size captured for the decode cuda graph.
```

## Паспорт аргумента

- Флаги: `--cuda-graph-max-bs-decode`
- Группа: `exec.graph`
- Тип значения: int
- Допустимые значения: положительное целое; argparse верхнюю границу не проверяет
- Значение по умолчанию: `null` — «подберет движок»
- Эффективное значение: подбирается в `_handle_gpu_memory_settings` по объему GPU-памяти и `--tp-size` (таблица ниже). Если задан `--cuda-graph-bs-decode`, значение **перезаписывается** на `max(bs)`. На `--device cpu` перезаписывается на `--torch-compile-max-bs`
- Где объявлен: `ServerArgs.cuda_graph_max_bs_decode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный. Устаревший псевдоним — `--cuda-graph-max-bs` (`DeprecatedAliasStoreAction`, пишет в то же поле с предупреждением)
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config` → `_handle_gpu_memory_settings`) → `get_batch_sizes_to_capture` при создании decode-runner'а → захват графов

## Что меняет в движке

### Автоподбор при незаданном значении

`_handle_gpu_memory_settings(gpu_mem)` получает емкость карты в МиБ и выбирает значение вместе с `--chunked-prefill-size`:

| Емкость GPU | `chunked_prefill_size` | `cuda_graph_max_bs_decode` |
| --- | --- | --- |
| < 20 ГиБ (T4, 4080) | 2048 | 8 |
| < 35 ГиБ (A10, 4090, 5090) | 2048 | 24 при `tp_size < 4`, иначе 80 |
| < 60 ГиБ (A100 40 ГБ, L40) | 4096 | 32 при `tp_size < 4`, иначе 160 |
| < 90 ГиБ (H100, A100 80 ГБ) | 8192 | 256 при `tp_size < 4`, иначе 512 |
| < 160 ГиБ (H20, H200) | 8192 | 256 при `tp_size < 4`, иначе 512 |
| ≥ 160 ГиБ (B200, MI300) | 16384 | 512 |
| емкость неизвестна | 4096 | 160 |

Логика в комментарии кода прямая: карта больше — карта мощнее, значит имеет смысл ловить графом более крупные батчи.

### Как из значения получается список форм

`_generate_decode_cuda_graph_batch_sizes(max_bs)` строит сетку и отсекает все, что больше `max_bs`, после чего добавляет сам `max_bs`, если его в сетке нет:

- обычный режим: `[1, 2, 4, 8, 12]` + `range(16, 257, 8)` + `range(272, 512, 16)` + `range(512, max_bs+1, 32)`;
- при заданном `--speculative-algorithm`: `range(1, 9)` + `range(10, 33, 2)` + `range(40, 65, 4)` + `range(72, 257, 8)` + `range(272, max_bs+1, 16)` — мельче на маленьких батчах, чтобы padding не съедал выигрыш спекуляции;
- при `--disable-cuda-graph-padding`: просто `range(1, max_bs+1)`, то есть **каждый** размер батча.

Численно: `max_bs 8` → 4 формы, `24` → 7, `32` → 8, `80` → 14, `160` → 24, `256` → 36, `512` → 52. Со спекуляцией: `24` → 16 форм, `160` → 39, `256` → 51. С `--disable-cuda-graph-padding` и `max_bs 160` — 160 форм.

### Как список урезается дальше

`get_batch_sizes_to_capture` (`model_executor/runner/base_cuda_graph_runner.py`) перед захватом:

1. берет `req_to_token_pool.size` — фактический предел числа одновременных запросов, выведенный из эффективного `--max-running-requests`;
2. выравнивает его вверх по `get_cuda_graph_batch_size_alignment` (двойка при two-batch overlap, `attn_tp_size` при собранном буфере, `attn_cp_size`);
3. добавляет это значение в список, чтобы максимальный реальный батч точно был захвачен;
4. выбрасывает формы, у которых `bs * ширина_запроса` не кратно выравниванию, и все, что больше предела;
5. сортирует и дедуплицирует.

Практическое следствие: **`--cuda-graph-max-bs-decode 256` при `--max-running-requests 2` даст ровно две захваченные формы.** Ровно это видно в квалификационном профиле arriero: `--max-running-requests 2` → «CUDA graph batch 1/2».

Захват идет от большего к меньшему, чтобы мелкие графы переиспользовали mempool, выделенный крупными.

## Значения и формат

- Целое число; отрицательное или ноль argparse примет, но `get_batch_sizes_to_capture` упадет ассертом `capture_bs=[]`.
- Значение больше предела запросов не увеличивает набор форм: лишние отфильтруются. Чтобы реально захватывать крупные батчи, поднимайте и `--max-running-requests`.
- Значение, отсутствующее в сетке, все равно попадает в набор: `max_bs` дописывается принудительно.
- При заданном `--cuda-graph-bs-decode` этот флаг игнорируется — `max_bs` становится максимумом списка.
- Специальных значений (`0`, `-1`, `auto`) нет; «авто» — это не задавать флаг.

## Когда использовать

- Поднимать, когда реальные батчи регулярно превышают порог и уходят в eager. Апстрим прямо советует это для больших `--tp-size`: значения 512 и 768 бывают полезны там, где автоподбор дал 256. Одновременно придется опустить `--mem-fraction-static`, если оно задано явно.
- Опускать, когда захват падает по памяти или когда старт слишком долгий, а конкурентность заведомо мала. Для одиночного пользователя с `--max-running-requests 2` значение больше 2 бессмысленно.
- Не трогать, если вы не задавали `--max-running-requests`: тогда предел запросов вычисляется из емкости KV-пула, и порог графа почти всегда упирается не в этот флаг.
- Не переносить значение между картами: на 24-ГиБ карте автоподбор дает 24, на H100 — 256, и жестко зашитое «256» на 4090 приведет к длинному захвату ради форм, которых не будет.

## Влияние на производительность и память

- **VRAM.** Априорная оценка в автоподборе `--mem-fraction-static` — ровно `decode.max_bs * 2` МиБ (`reserve_for_graph_mb()`), то есть 512 МиБ при `max_bs 256`. При включенном DP attention добавляется `max_bs * dp_size * 3` МиБ, а при `max_bs > 300` еще `max_bs * dp_size * 1.5` МиБ. Фактический расход печатается в строке `Capture target decode CUDA graph end. … mem usage=… GB`.
- **Время старта.** Пропорционально числу форм. Переход с автоподобранных 256 на 512 — это 36 → 52 формы, то есть примерно +45 % времени захвата.
- **Latency:** повышение порога помогает только тем батчам, которые раньше не попадали в граф; на остальных ничего не меняется.
- **Padding.** Батч 130 при захваченных `128, 136` выполняется как 136: считаются лишние строки. Чем реже сетка, тем выше эти потери — и наоборот, `--disable-cuda-graph-padding` их убирает ценой сотен графов.

## Взаимодействие с другими аргументами

- `--cuda-graph-bs-decode`: полностью перекрывает этот флаг (`max_bs = max(bs)`).
- `--cuda-graph-config`: ключ `decode.max_bs` перекрывает флаг.
- `--cuda-graph-max-bs` (устаревший): тот же параметр под старым именем.
- `--max-running-requests`: реальный потолок набора форм. Поднимать `max_bs` без него бесполезно.
- `--mem-fraction-static`: линейная связь через `reserve_for_graph_mb()`. При явно заданном `--mem-fraction-static` рост `max_bs` не компенсируется и ведет к OOM на захвате.
- `--tp-size`: вход автоподбора (порог `tp_size < 4`).
- `--speculative-algorithm`: меняет сетку форм на более плотную; кроме того, каждая форма захватывается с шириной `num_tokens_per_req > 1`.
- `--disable-cuda-graph-padding`: превращает сетку в сплошной диапазон `1…max_bs`.
- `--enable-dp-attention`: добавляет собственные слагаемые в резерв графа и меняет выравнивание форм.
- `--disable-decode-cuda-graph` / `--cuda-graph-backend-decode disabled`: значение остается в конфиге, но ни на что не влияет.

## Типовые проблемы и диагностика

- **Симптом:** `torch.OutOfMemoryError` во время `Capturing batches (bs=… avail_mem=… GB)`. **Причина:** резерв меньше, чем нужно графам. **Решение:** уменьшить `--cuda-graph-max-bs-decode` вдвое либо опустить `--mem-fraction-static` на 0.02–0.05.
- **Симптом:** подняли `max_bs`, а в логе `bs=[…]` не изменился. **Причина:** список обрезан по `req_to_token_pool.size`. **Решение:** поднять `--max-running-requests`.
- **Симптом:** `AssertionError: capture_bs=[]` при старте. **Причина:** после фильтра по выравниванию и пределу запросов не осталось ни одной формы (обычно при большом `attn_tp_size` и крошечном пределе запросов).
- **Симптом:** старт занимает минуты. **Проверка:** длина списка `bs=[…]` в строке `Capture target decode CUDA graph begin` и `elapsed=… s` в парной строке.
- **Что смотреть:** `Capture target decode CUDA graph begin. backend=full, num_tokens_per_req=1, bs=[1, 2, 4, …], avail mem=… GB`; `cuda_graph_config=` в дампе `server_args=`; при спекуляции имя capture меняется на `target verify`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-max-bs-decode 32 --max-running-requests 32
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-max-bs-decode 512 --max-running-requests 512 --mem-fraction-static 0.82
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
- arriero: `docs/qualification/ktransformers/0.6.4-2026-07-30.md`
