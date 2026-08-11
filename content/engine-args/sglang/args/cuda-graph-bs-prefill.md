---
schema: 1
engine: sglang
primaryName: "--cuda-graph-bs-prefill"
title: "--cuda-graph-bs-prefill"
summary: Явный список форм prefill-графа, заданный в **токенах** (не в запросах); заменяет сгенерированную сетку и делает `--cuda-graph-max-bs-prefill` бесполезным. Основной способ сократить старт при backend'е `tc_piecewise`, где каждая форма еще и компилируется.
group: exec.graph
related:
  - --cuda-graph-max-bs-prefill
  - --piecewise-cuda-graph-tokens
  - --cuda-graph-bs-decode
  - --cuda-graph-backend-prefill
  - --disable-prefill-cuda-graph
  - --cuda-graph-tc-compiler
  - --cuda-graph-config
  - --chunked-prefill-size
  - --context-length
  - --mem-fraction-static
  - --moe-a2a-backend
---

# --cuda-graph-bs-prefill

## Кратко

Prefill-граф захватывается по количеству токенов в объединенном батче. Этот флаг перечисляет эти количества явно. Ключ называется `bs` из-за общей схемы `PhaseConfig`, но единица — токены; устаревший псевдоним назывался понятнее: `--piecewise-cuda-graph-tokens`. Список стоит трогать, когда старт слишком долгий (при `tc_piecewise` каждая форма проходит компиляцию) или когда известно, что реальные prefill-батчи концентрируются вокруг нескольких размеров.

## Оригинальная справка

```text
Explicit list of batch sizes to capture for the prefill cuda graph.
```

## Паспорт аргумента

- Флаги: `--cuda-graph-bs-prefill`
- Группа: `exec.graph`
- Тип значения: список целых, `nargs="+"` — значения разделяются пробелами; единица измерения — токены
- Допустимые значения: положительные целые
- Значение по умолчанию: `null` — список генерируется `_generate_prefill_cuda_graph_batch_sizes(prefill.max_bs)`
- Эффективное значение: заданный список может быть переписан в трех местах — выравнивание по 8 при MoE a2a backend `deepep` и prefill-backend'е `breakable` (`_apply_deepep_adjustments`), отсечение бакетов больше `max_capture_requests * context_length` в `capture_prefill_graph`, и фильтр CP при `enable_cp_v2_bcg_capture`. Итог записывается обратно в `cuda_graph_config[prefill].bs`
- Где объявлен: `ServerArgs.cuda_graph_bs_prefill`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный. Устаревший псевдоним — `--piecewise-cuda-graph-tokens`
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config`, `_apply_deepep_adjustments`) → `capture_prefill_graph` → компиляция (`tc_piecewise`) и захват

## Что меняет в движке

При заданном списке `_handle_gpu_memory_settings` не вызывает генератор сетки, и `--cuda-graph-max-bs-prefill` в расчете не участвует (само поле `prefill.max_bs` остается тем, что вы задали или что подобрал движок, но список от него больше не зависит).

`capture_prefill_graph` считает потолок по емкости — `max_capture_tokens = max_capture_requests * context_length`, где `max_capture_requests` равно размеру `req_to_token_pool` (для backend'а `full` — `full_prefill_max_req`) — и оставляет только бакеты не больше него. Отфильтрованный отсортированный список записывается обратно в конфиг, и уже он попадает в лог:

```text
Capture target prefill CUDA graph begin. backend=breakable, num_tokens=[128, 512, 2048], avail mem=… GB
```

Если после фильтра список пуст, печатается `Disable prefill CUDA graph capture because no configured capture size fits backend=… with max_capture_tokens=…` и prefill уходит в eager.

При исполнении реальное число токенов округляется вверх до ближайшего бакета. Батч отвергается, если он больше максимального бакета или если округление увеличивает число токенов более чем вдвое (`_MAX_PREFILL_CUDA_GRAPH_PADDING_FACTOR = 2`). Это важное следствие разреженного списка: `--cuda-graph-bs-prefill 128 4096` оставит без графа все, что между 257 и 2047 токенами.

## Значения и формат

- Разделитель — пробел: `--cuda-graph-bs-prefill 256 1024 4096`.
- Порядок не важен: список сортируется (`sorted(capture_tokens)` в `PrefillCudaGraphRunner.__init__`).
- Пустой список получить нельзя через CLI (`nargs="+"` требует хотя бы одного значения), но он может стать пустым после фильтров — тогда prefill-граф выключается с предупреждением.
- При MoE a2a `deepep` + `breakable` значения автоматически округляются вверх до кратных 8 с сообщением `Breakable prefill CUDA graph with DeepEP requires bucket sizes divisible by 8; aligning […] -> […]`.
- Задание списка фиксирует пару `(prefill, "bs")`: пропускается пересчет под DP attention и подъем буфера для EmbeddingGemma.

## Когда использовать

- Backend `tc_piecewise` и долгий старт: компиляция идет по каждой форме (`Compiling num tokens (num_tokens=…)`), и сокращение 58 форм до 5 сокращает старт кратно.
- Известное распределение длин запросов: если prefill почти всегда укладывается в 1–2 тысячи токенов, верхние бакеты — чистые накладные расходы.
- Отладка: сузить список до одной формы, чтобы воспроизвести проблему захвата минимальным набором.
- Не задавайте разреженный список: разрывы больше чем вдвое выключают граф для промежуточных размеров, и вы получите худшее из двух миров — время на захват потрачено, а выигрыша нет.
- Не задавайте список, если пользуетесь DP attention и не пересчитали значения на `dp_size`: автоматический пересчет пропускается.

## Влияние на производительность и память

- **Время старта** линейно по длине списка; при `tc_piecewise` — линейно по длине списка с большим коэффициентом (компиляция + захват).
- **VRAM.** В автоподборе `--mem-fraction-static` prefill-граф оценивается как `len(prefill.bs) * 8` МиБ для не-MLA моделей — то есть здесь длина списка входит в резерв напрямую; для MLA-моделей резерв фиксированный (1.5 ГиБ) и от списка не зависит. Фактический расход — строка `Capture target prefill CUDA graph end. … mem usage=… GB`.
- **TTFT.** Хорошо подобранный список не меняет TTFT на покрытых размерах и ухудшает его на непокрытых (eager вместо графа).
- Padding на prefill дороже decode-падинга: лишние токены реально считаются во всех слоях.

## Взаимодействие с другими аргументами

- `--cuda-graph-max-bs-prefill`: не применяется при заданном списке.
- `--cuda-graph-config`: ключ `prefill.bs` перекрывает флаг.
- `--piecewise-cuda-graph-tokens` (устаревший): то же поле под старым именем.
- `--cuda-graph-backend-prefill`: определяет, кто список потребляет; при `disabled` список игнорируется.
- `--cuda-graph-tc-compiler`: вместе с `tc_piecewise` определяет стоимость каждой формы.
- `--chunked-prefill-size`: практический потолок осмысленных значений — планировщик не соберет батч крупнее чанка.
- `--context-length`: через `max_capture_tokens` отсекает верхние бакеты, особенно при backend'е `full`.
- `--moe-a2a-backend deepep`: принудительное выравнивание по 8.
- `--mem-fraction-static`: через `reserve_for_graph_mb()` для не-MLA моделей.

## Типовые проблемы и диагностика

- **Симптом:** в логе `num_tokens=[…]` короче заданного списка. **Причина:** отсечение по `max_capture_tokens` или выравнивание DeepEP.
- **Симптом:** `Disable prefill CUDA graph because the capture size is not set` или `… because no configured capture size fits backend=…`. **Причина:** список после фильтров пуст.
- **Симптом:** часть запросов идет в eager, хотя укладывается в максимум. **Причина:** разрыв в списке больше чем вдвое — сработал `_MAX_PREFILL_CUDA_GRAPH_PADDING_FACTOR`.
- **Симптом:** захват DeepEP зависает. **Причина/решение:** значения не кратны 8; движок выравнивает их сам, но при явно заданном `max_bs` итог стоит проверить в логе.
- **Что смотреть:** строка `Capture target prefill CUDA graph begin. … num_tokens=[…]`, сообщения выравнивания DeepEP и `cuda_graph_config=` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-bs-prefill 256 512 1024 2048
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill tc_piecewise --cuda-graph-bs-prefill 512 1024 2048 --chunked-prefill-size 2048
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/tc_piecewise_cuda_graph_backend.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
