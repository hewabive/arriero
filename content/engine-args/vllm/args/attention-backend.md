---
schema: 1
engine: vllm
primaryName: "--attention-backend"
title: "--attention-backend"
summary: Жёстко фиксирует backend внимания вместо автоподбора по приоритетному списку платформы. Неподходящий выбор не откатывается на запасной вариант — движок падает на старте со списком причин.
group: AttentionConfig
related:
  - --attention-config
  - --kv-cache-dtype
  - --block-size
  - --dtype
  - --enforce-eager
  - --compilation-config
  - --mm-encoder-attn-backend
  - --decode-context-parallel-size
  - --prefill-context-parallel-size
  - --disable-cascade-attn
  - --speculative-config
---

# --attention-backend

## Кратко

По умолчанию vLLM сам перебирает backend'ы внимания в приоритетном порядке, зависящем от compute capability и от того, MLA ли модель, и берёт первый, который проходит валидацию по head size, dtype, dtype KV-cache, размеру блока, sink'ам, sparse-режиму и типу внимания. `--attention-backend` отменяет перебор: указанный backend проверяется теми же правилами, и при первом же несоответствии старт падает.

Это диагностическая и «зафиксировать поведение» ручка. Если backend просто хочется исключить, обычно правильнее менять `--kv-cache-dtype`, `--block-size` или `--attention-config.flash_attn_version`, а не прибивать backend гвоздями.

## Оригинальная справка

```text
Attention backend to use. Use "auto" or None for automatic selection.
```

## Паспорт аргумента

- Флаги: `--attention-backend`
- Группа argparse: `AttentionConfig`
- Тип значения: строка — имя элемента `AttentionBackendEnum` (регистр не важен, приводится к верхнему)
- Допустимые значения: `choices` пуст, потому что список собирается в runtime из реестра `vllm/v1/attention/backends/registry.py:AttentionBackendEnum`; в `--help` перечня нет. Смотреть реальный список надо в реестре установленной версии: `python -c "from vllm.v1.attention.backends.registry import AttentionBackendEnum as B; print([b.name for b in B])"` в окружении инстанса. Отдельно принимаются `auto` и `None` (пустая строка тоже) — оба означают «выбрать автоматически»
- Значение по умолчанию: `None` (автоподбор)
- Эффективное значение: `AttentionConfig.__post_init__` перехватывает два имени: `CUTLASS_MSA` и `TRITON_MSA` — они не выбирают backend, а лишь переключают `minimax_m3_msa_decode_backend` (sparse-decode ядро MiniMax M3) и **сбрасывают** `backend` обратно в `None`, так что плотные слои снова идут через автоподбор
- Где объявлен: `vllm/config/attention.py:AttentionConfig.backend`
- Этап применения: `create_engine_config` (перенос в `AttentionConfig`) → загрузка модели, конструктор каждого слоя `Attention`/`MLAAttention` → резолв режима CUDA-графов

## Что меняет в движке

Значение кладётся в `AttentionConfig.backend`. Дальше `get_attn_backend()` (`vllm/v1/attention/selector.py`) вызывается при создании **каждого** слоя внимания и собирает `AttentionSelectorConfig`: `head_size`, `dtype` модели, `kv_cache_dtype`, `block_size` (только если он задан пользователем), `use_mla`, `has_sink`, `use_sparse`, `use_mm_prefix`, `attn_type`, `has_sliding_window`, `use_non_causal`, `use_batch_invariant`, `use_kv_connector`, `use_pcp`. Затем `current_platform.get_attn_backend_cls()` разводит два сценария.

**Backend задан.** Класс импортируется и один раз проходит `AttentionBackend.validate_configuration()`; при непустом списке причин поднимается `ValueError`, никакого отката нет. При успехе — `Using <backend> backend.` Проверки внутри `validate_configuration` (`vllm/v1/attention/backend.py`):

| Проверка | Причина в сообщении |
| --- | --- |
| `supports_head_size` | `head_size not supported` |
| `supports_dtype` (dtype модели) | `dtype not supported` |
| `supports_kv_cache_dtype` | `kv_cache_dtype not supported` |
| `supports_block_size` | `block_size not supported` |
| `is_mla()` ≠ `use_mla` | `MLA not supported` / `non-MLA not supported` |
| `is_sparse()` ≠ `use_sparse` | `sparse not supported` / `non-sparse not supported` |
| `supports_sink` | `attention sinks not supported` |
| `supports_compute_capability` | `compute capability not supported` |
| `supports_attn_type` | `attention type <тип> not supported` |
| `supports_sliding_window` | `sliding window not supported` |
| `supports_non_causal` | `non-causal attention not supported` |
| `supports_batch_invariance` | `batch invariance not supported` |
| `supports_kv_connector` | `KV connector not supported` |
| `supports_pcp` | `PCP not supported` |
| `supports_mm_prefix`, `supports_per_head_quant_scales` | `partial multimodal token full attention not supported`, `per-head quant scales not supported` |
| `supports_combination(...)` | свободная строка backend'а |

Импорт, который не удался (нет flashinfer, нет собранного ядра), даёт причину `ImportError` — то есть отсутствующая библиотека выглядит так же, как несовместимость.

**Backend не задан.** `_get_backend_priorities()` (`vllm/platforms/cuda.py`) строит список-кандидатов, зависящий от `use_mla`, compute capability, числа голов и dtype KV-cache:

- не-MLA, SM 10.x и causal-внимание: `FLASHINFER → FLASH_ATTN → TRITON_ATTN → FLEX_ATTENTION → TURBOQUANT`;
- не-MLA во всех остальных случаях (в том числе SM 8.x/9.x и non-causal на SM 10.x): `FLASH_ATTN → FLASHINFER → TRITON_ATTN → FLEX_ATTENTION → TURBOQUANT`;
- MLA, SM 10.x: `FLASHINFER_MLA → TOKENSPEED_MLA → CUTLASS_MLA → FLASH_ATTN_MLA → FLASHMLA → TRITON_MLA` плюс sparse-хвост, порядок которого зависит от квантованного KV-cache и числа query-голов;
- MLA, SM 12.x: `TRITON_MLA → FLASHINFER_MLA_SPARSE_SM120`;
- MLA, остальные: `FLASH_ATTN_MLA → FLASHMLA → FLASHINFER_MLA → TRITON_MLA → FLASH_ATTN_MLA_SPARSE → FLASHMLA_SPARSE`.

Каждый кандидат проходит ту же `validate_configuration`, побеждает первый валидный, в лог уходит `Using FLASH_ATTN attention backend out of potential backends: ['FLASH_ATTN', 'TRITON_ATTN'].` Если валидных нет — `ValueError: No valid attention backend found for cuda with AttentionSelectorConfig(...). Reasons: {...}` с построчными причинами по каждому backend'у. У ROCm свой `get_valid_backends` в `vllm/platforms/rocm.py`, у CPU — свой; списки приоритетов выше относятся к CUDA.

Выбранный backend после этого влияет ещё на две вещи: он может потребовать конкретный layout KV-cache (`get_required_kv_cache_layout()`) и он задаёт потолок режима CUDA-графов — `resolve_cudagraph_mode_and_sizes()` понижает `cudagraph_mode` до уровня, который backend поддерживает (`AttentionCGSupport`).

## Значения и формат

- Значение — имя элемента enum, не путь к классу: `FLASH_ATTN`, `flash_attn`, `FlashInfer` эквивалентны (`AttentionBackendEnum[value.upper()]`).
- `auto`, `None` и пустая строка означают автоподбор.
- Неизвестное имя даёт `ValueError: Unknown attention backend: 'X'. Valid options are: FLASH_ATTN, FLASH_ATTN_DIFFKV, TRITON_ATTN, ...` — сообщение само печатает полный список.
- Тот же смысл имеет структурная форма `--attention-config.backend FLASH_ATTN` (или `-ac.backend`, или `-ac '{"backend": "FLASH_ATTN"}'`). Задать оба сразу нельзя: `create_engine_config` поднимает `ValueError: attention_backend and attention_config.backend are mutually exclusive`.
- `CUSTOM` без предварительной регистрации через `register_backend()` даёт `ValueError: Backend CUSTOM must be registered before use`. `TORCH_SDPA` — тег только для ViT, для декодера он не выбирается.
- Переменной окружения `VLLM_ATTENTION_BACKEND` в этом commit'е не существует (в `vllm/envs.py` её нет, во всём дереве упоминаний нет) — единственный способ задать backend снаружи это CLI или конфиг-файл `--config`.

## Когда использовать

- **Воспроизводимость профиля.** Автоподбор зависит от того, что установлено в окружении: появившийся flashinfer меняет выбранный backend без изменения аргументов. Явное имя фиксирует поведение и делает регрессию видимой сразу на старте.
- **Обход бага в приоритетном backend'е.** Численные расхождения, зависание на конкретной длине, падение внутри ядра — сначала перевести на `TRITON_ATTN` (самый терпимый: head size ≥ 32, fp16/bf16/fp32, широкий набор dtype KV-cache, все типы внимания) и посмотреть, воспроизводится ли.
- **Сравнительный замер.** Прогнать один и тот же бенчмарк на `FLASH_ATTN` и `FLASHINFER` на своей карте, вместо того чтобы верить приоритетному списку.
- **Не используйте для «ускорения» вслепую.** Приоритетный список — уже результат замеров апстрима на конкретных compute capability; ручной выбор чаще всего либо ничего не меняет (тот же backend выбрался бы сам), либо роняет старт.
- **Не подставляйте сюда ViT-backend.** Внимание визуального энкодера выбирается отдельно, аргументом `--mm-encoder-attn-backend` (`MultiModalConfig`), и допускает только `FLASH_ATTN`, `TRITON_ATTN`, `TORCH_SDPA`, `FLASHINFER`.

## Влияние на производительность и память

- **VRAM.** Прямо — почти никак: сам выбор backend'а память не резервирует. Косвенно значимо: backend диктует требуемый layout и допустимый размер блока KV-cache, а через понижение `cudagraph_mode` может убрать из бюджета часть графового пула (или, наоборот, вернуть его). Рабочие буферы (workspace flashinfer, split-KV буферы) у backend'ов разные и попадают в профилирование как не-KV память.
- **Latency и throughput.** Это и есть основная разница: на одной и той же карте decode-ядро FlashInfer/TRT-LLM и FlashAttention дают разное время шага, а `TRITON_ATTN` и `FLEX_ATTENTION` заметно медленнее и служат совместимостным вариантом.
- **Время старта.** Backend с JIT-ядрами (flashinfer, CuTe-DSL) добавляет к первому старту компиляцию ядер; при `--enable-flashinfer-autotune` сверху ложится автотюнинг.
- **Спекулятивное декодирование.** Backend с `AttentionCGSupport` ниже `UNIFORM_BATCH` заставляет понизить `cudagraph_mode` до `PIECEWISE`/`NONE`, что само по себе бьёт по latency сильнее, чем разница между ядрами.

## Взаимодействие с другими аргументами

- `--attention-config` (`-ac`): тот же параметр в структурной форме плюс все остальные поля `AttentionConfig` (`flash_attn_version`, `use_trtllm_attention`, `mla_prefill_backend`, `backend_per_kind`). Взаимно исключается с `--attention-backend`. Для модели с несколькими KV-cache-группами (перемежающиеся full и sliding-window слои) точечная настройка делается через `-ac.backend_per_kind`, а не этим флагом.
- `--kv-cache-dtype`: самый частый источник отказа. `FLEX_ATTENTION` принимает только `auto`/`float16`/`bfloat16`; `FLASH_ATTN` — плюс `fp8`/`fp8_e4m3` и то с оговорками по версии FA и compute capability; `TRITON_ATTN` дополнительно умеет `fp8_e5m2` и per-token-head int4/int8/fp8; `FLASHINFER` — ещё и `nvfp4`. Комбинация «fp8 KV + backend без его поддержки» — это `kv_cache_dtype not supported` при явном выборе и молчаливое исключение кандидата при автоподборе.
- `--block-size`: заданный вручную размер блока участвует в валидации. При автоподборе, если `--block-size` отсёк более приоритетный backend, движок предупреждает: `--block-size N precluded higher-priority backend(s) X. Using Y instead, which may result in reduced performance.` При явном backend'е то же условие превращается в отказ `block_size not supported`.
- `--dtype`: `FLASH_ATTN` и `FLASHINFER` работают только с fp16/bf16, `TRITON_ATTN` и `FLEX_ATTENTION` принимают ещё fp32.
- `--enforce-eager`: убирает CUDA-графы целиком, поэтому влияние backend'а на `cudagraph_mode` перестаёт существовать; сам выбор backend'а остаётся в силе.
- `--compilation-config`: если backend поддерживает графы хуже, чем требует `-cc.cudagraph_mode`, режим понижается с предупреждением `CUDAGraphMode.X is not supported with <backend> backend (support: ...)`, а при `AttentionCGSupport.NEVER` и mixed-режиме `FULL` — поднимается `ValueError`.
- `--decode-context-parallel-size`, `--prefill-context-parallel-size`: PCP > 1 добавляет проверку `supports_pcp`; DCP меняет эффективный размер блока при хешировании.
- `--speculative-config`: длина проверяемого блока > 1 требует от backend'а `AttentionCGSupport.UNIFORM_BATCH`, иначе графы деградируют.
- `--disable-cascade-attn`: cascade-путь — надстройка над backend'ом, и он не поддерживается графами; при принудительном backend'е без cascade-реализации флаг просто не имеет эффекта.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Selected backend AttentionBackendEnum.FLASHMLA is not valid for this configuration. Reason: ['compute capability not supported']`. **Причина:** backend требует более новую карту. **Лечение:** убрать флаг (пусть подбирает движок) или взять backend из списка, который автоподбор реально печатает.
- **Симптом:** `Reason: ['ImportError']` при явно указанном flashinfer-backend'е. **Причина:** библиотека не установлена в окружении инстанса или собрана без нужного ядра, а не несовместимость конфигурации. **Проверка:** `python -c "import flashinfer; print(flashinfer.__version__)"` в том же окружении.
- **Симптом:** `ValueError: No valid attention backend found for cuda with AttentionSelectorConfig(head_size=..., dtype=..., kv_cache_dtype=..., ...)`. **Причина:** ни один кандидат не прошёл — обычно из-за экзотического `head_size`, `--kv-cache-dtype` или `--block-size`. **Лечение:** читать `Reasons:` — там перечислены все backend'ы с их причинами; чаще всего снимается возвратом `--kv-cache-dtype auto` или снятием ручного `--block-size`.
- **Симптом:** `ValueError: Unknown attention backend: 'flash-attn'`. **Причина:** дефисы вместо подчёркиваний. Имя приводится только к верхнему регистру, замены `-` на `_` здесь нет (в отличие от `--moe-backend`/`--linear-backend`). **Лечение:** `FLASH_ATTN`.
- **Симптом:** задал `TRITON_MSA`, а в логе всё равно автоподбор. **Причина:** это не backend, а алиас для sparse-decode ядра MiniMax M3; `__post_init__` сбрасывает `backend` в `None`. Так и задумано.
- **Симптом:** после смены backend'а упал throughput на спекулятивном декодировании. **Проверка:** строка `CUDAGraphMode.FULL_AND_PIECEWISE is not supported with spec-decode for attention backend X (support: AttentionCGSupport.UNIFORM_SINGLE_TOKEN_DECODE); setting cudagraph_mode=PIECEWISE`. **Лечение:** вернуть backend с поддержкой uniform-batch графов.
- **Подтверждение принятого значения:** при явном выборе — `Using AttentionBackendEnum.FLASH_ATTN backend.`; при автоподборе — `Using FLASH_ATTN attention backend out of potential backends: [...]`. Полный разбор отвергнутых кандидатов виден только на уровне debug (`Some attention backends are not valid for cuda with ...`), поэтому при расследовании поднимайте уровень логирования движка.

## Примеры

```bash
vllm serve /models/Qwen3-4B --attention-backend TRITON_ATTN --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --attention-backend FLASH_ATTN --kv-cache-dtype fp8 --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B --attention-config '{"backend": "FLASHINFER", "flash_attn_version": 2}'
```

## Источники

- `vllm/vllm/config/attention.py`
- `vllm/vllm/v1/attention/backends/registry.py`
- `vllm/vllm/v1/attention/backend.py`
- `vllm/vllm/v1/attention/selector.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/v1/attention/backends/flash_attn.py`
- `vllm/vllm/v1/attention/backends/triton_attn.py`
- `vllm/vllm/v1/attention/backends/flashinfer.py`
- `vllm/vllm/v1/attention/backends/flex_attention.py`
- `vllm/vllm/config/compilation.py`
- `vllm/vllm/model_executor/models/vision.py`
- `vllm/docs/design/attention_backends.md`
