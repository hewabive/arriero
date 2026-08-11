---
schema: 1
engine: sglang
primaryName: "--cuda-graph-backend-prefill"
title: "--cuda-graph-backend-prefill"
summary: Выбирает механизм захвата графа для фазы prefill. По умолчанию `breakable` на CUDA и `tc_piecewise` на остальных платформах, но этот дефолт молча отключается двумя десятками правил совместимости — а любое явное значение эти правила выключает целиком.
group: exec.graph
related:
  - --cuda-graph-config
  - --cuda-graph-backend-decode
  - --disable-prefill-cuda-graph
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-bs-prefill
  - --cuda-graph-tc-compiler
  - --enable-torch-compile
  - --enforce-piecewise-cuda-graph
  - --disable-piecewise-cuda-graph
  - --enable-breakable-cuda-graph
  - --chunked-prefill-size
  - --mem-fraction-static
  - --attention-backend
---

# --cuda-graph-backend-prefill

## Кратко

Prefill-граф в SGLang — недавний и заметно более хрупкий механизм, чем decode-граф: он работает не для всех архитектур, не для всех backend'ов внимания и не для всех режимов параллелизма. Поэтому дефолт живой (`breakable` на CUDA), но обвешан каскадом авто-отключений. Ключевое свойство этого флага: **любое явное значение пропускает весь каскад**. Это генерализация старого `--enforce-piecewise-cuda-graph` — вы получаете ровно то, что попросили, вместе с ответственностью за падение или регресс.

## Оригинальная справка

```text
Backend for the prefill phase. Folds into cuda_graph_config[prefill].backend.
```

## Паспорт аргумента

- Флаги: `--cuda-graph-backend-prefill`
- Группа: `exec.graph`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `full`, `breakable`, `tc_piecewise`, `disabled`
- Значение по умолчанию: `null` — флаг не задан; `cuda_graph_config.prefill.backend` берет значение `default_prefill_backend()`: `breakable` на CUDA, `tc_piecewise` на остальных платформах (HIP/NPU/…)
- Эффективное значение: складывается в `cuda_graph_config[prefill].backend` в `_parse_cuda_graph_config`; при **незаданном** флаге далее переписывается `_apply_cuda_graph_compatibility`, `_apply_cuda_graph_disaggregation_roles`, `_disable_prefill_cuda_graph_for_deepseek_trtllm_mla`, `_apply_inkling_prefill_cuda_graph_default` (архитектура Inkling → `full`), правилами EmbeddingGemma и HRM-Text, а также `--enable-mis`
- Где объявлен: `ServerArgs.cuda_graph_backend_prefill`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный. Устаревшие псевдонимы, транслирующиеся в это же поле: `--enable-breakable-cuda-graph` → `breakable`, `--disable-piecewise-cuda-graph` → `disabled`, `--enforce-piecewise-cuda-graph` → `tc_piecewise`
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config`) → `capture_prefill_graph` и `resolve_prefill_backend` при инициализации model runner

## Что меняет в движке

`runner_backend/utils.py:resolve_prefill_backend` превращает значение в backend для `PrefillCudaGraphRunner`:

- **`breakable`** (`BreakableCudaGraphBackend`) — сегментированный захват без `torch.compile`. Захватывает один полный prefill-forward на каждое количество токенов из `cuda_graph_config[prefill].bs`. На NVIDIA требует пакет `cuda-python`; несовместим с memory saver.
- **`tc_piecewise`** (`TcPiecewiseCudaGraphBackend`) — `torch.compile` разрезает FX-граф на attention-слоях, и каждая часть захватывается отдельно. Compiler выбирается `--cuda-graph-tc-compiler` (`eager`/`inductor`). На старте выполняется отдельный проход компиляции по всем формам с прогресс-строками `Compiling num tokens (num_tokens=…)`, что стоит времени.
- **`full`** (`FullCudaGraphBackend`) — цельный граф на каждый токен-бакет с фиксированным числом слотов запросов (`full_prefill_max_req` из `--cuda-graph-config`). Экспериментальный: `_handle_cuda_graph_config` печатает `cuda_graph_config[prefill].backend='full' is experimental. Use breakable or tc_piecewise for production workloads.` Батчи с числом запросов больше `full_prefill_max_req` уходят в eager.
- **`disabled`** — `capture_prefill_graph` печатает `Disable prefill CUDA graph because cuda_graph_config resolved prefill.backend='disabled' (e.g. via --cuda-graph-backend-prefill=disabled or auto-disable rules).` и направляет prefill в `EagerRunner`.

### Каскад авто-отключения (работает только при незаданном флаге)

`_apply_cuda_graph_compatibility` сначала может подменить `breakable` на `tc_piecewise` для мультимодальных моделей из валидированного списка (лог `Using tc_piecewise CUDA graph for validated multimodal decoder prefill.`), а затем прогоняет правила для выбранного backend'а.

Для `tc_piecewise` prefill выключается при: модели из черного списка, DP attention, `--enable-torch-compile`, `--pp-size > 1`, не-CUDA железе, MoE a2a backend'е, LoRA, неподдерживаемой мультимодальности, GGUF-квантизации, DLLM, `--cpu-offload-gb > 0` или `--enable-hierarchical-cache`, детерминированном режиме, PD disaggregation, symmetric memory, EPLB/записи распределения экспертов, `attn_cp_size > 1`, `--debug-cuda-graph`, DSA prefill CP, `dcp_size > 1`.

Для `breakable` — при NemotronH, DeepSeek-V4, `attn_cp_size > 1` без поддержки, `dcp_size > 1`, two-batch overlap, невалидированном a2a backend'е и неподдерживаемой мультимодальности; каждое срабатывание печатает `Breakable CUDA graph is incompatible with <причина>; disabling prefill CUDA graph.`

Для `full` список правил сегодня пуст.

Отдельно: при DeepSeek-V3 на `--attention-backend trtllm_mla` prefill-граф гасится с подробным предупреждением, потому что захваченный граф заставляет backend откатываться в FlashAttention и регрессирует prefill.

## Значения и формат

- Значение вне списка отвергает argparse. `_validate_cuda_graph_config` дополнительно проверяет итог по `ALLOWED_BACKENDS_PER_PHASE`.
- Флаг перекрывает `--disable-prefill-cuda-graph` и legacy `--disable-cuda-graph`.
- Явное значение ставит замок на `(prefill, "backend")`, из-за чего пропускаются: весь каскад совместимости, правило DeepSeek/`trtllm_mla`, и назначение роли при `--disaggregation-mode decode`.
- Даже с явным backend'ом граф может не появиться по причинам вне каскада: `capture_prefill_graph` отдельно отказывается при неподдерживаемой LoRA-конфигурации, при модели без атрибута `layers`, при нестандартном GQA, при пустом списке форм и для EAGLE-target на `tc_piecewise`.

## Когда использовать

- `disabled` — если prefill-граф явно вредит (регресс TTFT после обновления, странные ошибки в захвате) или если старт слишком долгий: захват prefill добавляет к старту столько же порядка, сколько decode.
- `breakable` — чтобы принудительно оставить prefill-граф там, где каскад его гасит, и вы измерением подтвердили выигрыш.
- `tc_piecewise` — когда нужен piecewise-путь с inductor (см. `--cuda-graph-tc-compiler`) и модель его поддерживает.
- Не выставляйте `full` на продовой инсталляции: это явно помеченный экспериментальным путь с пустым списком проверок совместимости.
- Не задавайте флаг «просто чтобы совпадало с дефолтом»: `--cuda-graph-backend-prefill breakable` и отсутствие флага — разные вещи, первое отключает защитный каскад.

## Влияние на производительность и память

- **Время старта.** `tc_piecewise` дороже всех: сначала проход компиляции по всем формам (`Compiling num tokens (num_tokens=…)`), потом захват. `breakable` дешевле, `disabled` бесплатен. Число форм при `chunked_prefill_size` 8192 — 58 бакетов, при 2048 — 42.
- **VRAM.** В автоподборе `--mem-fraction-static` prefill-граф оценивается как `len(prefill.bs) * 8` МиБ для не-MLA моделей и как фиксированные 1.5 ГиБ для MLA; при `breakable` вместе с DeepEP добавляется еще 1 ГиБ. Фактическое значение — в строке `Capture target prefill CUDA graph end. … mem usage=… GB`.
- **TTFT.** Выигрыш заметен на коротких и средних prefill, где доля python-overhead велика; на длинных чанках он тонет в самих вычислениях.
- Реплей возможен, только если округление вверх до ближайшего захваченного бакета не раздувает батч более чем вдвое (`_MAX_PREFILL_CUDA_GRAPH_PADDING_FACTOR = 2`), иначе батч идет в eager.

## Взаимодействие с другими аргументами

- `--cuda-graph-config`: ключ `prefill.backend` перекрывает флаг.
- `--disable-prefill-cuda-graph`: то же, что `disabled`, ниже по приоритету.
- `--cuda-graph-max-bs-prefill` / `--cuda-graph-bs-prefill`: задают формы (в токенах), которые этот backend захватывает.
- `--cuda-graph-tc-compiler`: читается только при `tc_piecewise`.
- `--enable-torch-compile`: отключает `tc_piecewise` в каскаде (если backend не задан явно); это два разных механизма компиляции, которые не складываются.
- `--attention-backend`: `trtllm_mla` на DeepSeek-V3 гасит prefill-граф; `torch_native` и `flex_attention` отключают графы обеих фаз.
- `--chunked-prefill-size`: определяет дефолтный `prefill.max_bs` для не-MLA моделей и, значит, длину списка форм.
- `--disaggregation-mode decode`: гасит prefill-граф, если backend не задан явно.
- `--enable-mis`: гасит графы обеих фаз безусловно.

## Типовые проблемы и диагностика

- **Симптом:** в логе `Breakable CUDA graph is incompatible with LoRA; disabling prefill CUDA graph.` (или другая причина). **Причина:** сработал каскад. **Решение:** либо принять, либо задать backend явно и измерить.
- **Симптом:** `Disable prefill CUDA graph capture because no configured capture size fits backend=full with max_capture_tokens=…`. **Причина:** произведение `full_prefill_max_req * context_length` меньше самого маленького бакета. **Решение:** поднять `full_prefill_max_req` в `--cuda-graph-config` или уменьшить `--cuda-graph-max-bs-prefill`.
- **Симптом:** старт растянулся на минуты после включения `tc_piecewise`. **Причина:** компиляция всех форм. **Решение:** сократить список через `--cuda-graph-bs-prefill` или `--cuda-graph-max-bs-prefill`.
- **Симптом:** `Disable prefill CUDA graph because the current LoRA configuration does not support it`. **Причина:** отказ уже на этапе создания runner'а, каскад тут ни при чем.
- **Что смотреть:** `Capture target prefill CUDA graph begin. backend=…, num_tokens=[…], avail mem=… GB` и `end. elapsed=… s, mem usage=… GB, …`; при `disabled` — строка `Disable prefill CUDA graph because …`. Итоговый `cuda_graph_config=…` в дампе `server_args=` показывает разрешенный backend.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill disabled
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill tc_piecewise --cuda-graph-tc-compiler inductor --cuda-graph-max-bs-prefill 4096
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/utils.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/tc_piecewise_cuda_graph_backend.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/breakable_cuda_graph_backend.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
