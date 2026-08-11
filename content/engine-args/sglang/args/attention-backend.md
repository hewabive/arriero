---
schema: 1
engine: sglang
primaryName: "--attention-backend"
title: "--attention-backend"
summary: Выбирает ядра внимания для всего сервера. Значение по умолчанию `null` означает не «универсальный backend», а многоступенчатый автоподбор по архитектуре модели, поколению GPU и режиму спекуляции; неудачный ручной выбор в одних случаях падает на старте, в других молча подменяется другим backend'ом.
group: exec.kernel
related:
  - --prefill-attention-backend
  - --decode-attention-backend
  - --speculative-draft-attention-backend
  - --mm-attention-backend
  - --page-size
  - --kv-cache-dtype
  - --enable-deterministic-inference
  - --disable-chunked-prefix-cache
  - --dsa-prefill-backend
  - --dsa-decode-backend
  - --device
---

# --attention-backend

## Кратко

`--attention-backend` определяет, какая реализация внимания создается для модели: FlashAttention (fa3/fa4), FlashInfer, Triton, TRT-LLM (MHA и MLA), FlashMLA, CuTe DSL MLA, торч-нативные пути и платформенные backend'ы AMD/Ascend/Intel. Это самый нагруженный аргумент группы `exec.kernel`: он тянет за собой обязательный `--page-size`, ограничивает допустимые `--kv-cache-dtype`, включает или выключает CUDA graph, chunked prefix cache и radix cache, и участвует в проверках почти каждой модельной ветки `_handle_model_specific_adjustments`. Оставленный незаданным, он подбирается движком; заданный вручную — жестко проверяется, и часть проверок это не ошибка, а тихая подмена значения с записью в лог.

## Оригинальная справка

```text
Choose the kernels for attention layers.
```

## Паспорт аргумента

- Флаги: `--attention-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `triton`, `torch_native`, `flex_attention`, `dsa`, `nsa`, `dsv4`, `compressed`, `cutlass_mla`, `fa3`, `fa4`, `flashinfer`, `flashmla`, `trtllm_mla`, `cutedsl_mla`, `tokenspeed_mla`, `trtllm_mha`, `dual_chunk_flash_attn`, `hpc_ops`, `aiter`, `wave`, `intel_amx`, `ascend`, `intel_xpu`. Список — константа `ATTENTION_BACKEND_CHOICES` в `sglang/python/sglang/srt/server_args.py`; функция `add_attention_backend_choices` позволяет out-of-tree платформенным пакетам его расширить, поэтому итоговый набор смотрите в `--help` установленной сборки. `nsa` — устаревший синоним `dsa`, `compressed` — устаревший синоним `dsv4`
- Значение по умолчанию: `null` — «подберет движок»
- Эффективное значение: переписывается на нескольких шагах `__post_init__` — платформенные обработчики (`_handle_hpu_backends`, `_handle_cpu_backends`, `_handle_npu_backends`), модельные переопределения в `_handle_model_specific_adjustments`, детерминированный режим (`_deterministic_attention_backend`), затем `_handle_attention_backend_compatibility` (`_attention_backend_default`, `_attention_backend_fa3_fp8_fallback`, `_attention_backend_platform_fallbacks`, `_attention_backend_dual_chunk`)
- Где объявлен: `ServerArgs.attention_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; поле помечено `resolvable=True`, то есть проходит через пайплайн деклараций `arg_groups/overrides.py`
- Этап применения: разбор CLI → `__post_init__` (подбор и проверки, попутные правки `--page-size`, CUDA graph, radix cache) → создание backend'а в model runner (`ATTENTION_BACKENDS[...]`, там же вторая волна отказов) → захват CUDA graph → каждый forward

## Что меняет в движке

Значение — это ключ в реестре `ATTENTION_BACKENDS` (`sglang/python/sglang/srt/layers/attention/attention_registry.py`). Model runner берет пару `(prefill, decode)` из `attention_backends_of` (`sglang/python/sglang/srt/arg_groups/overrides.py`) и строит backend в `attention_backend_setup.py`:

- пара совпадает → один backend на обе фазы;
- пара различается → `HybridAttnBackend` с двумя вложенными backend'ами, плюс лог «Using hybrid attention backend for decode and prefill: …» и предупреждение о том, что гибридный режим экспериментальный;
- для draft-воркера спекуляции backend берется из `--speculative-draft-attention-backend` и перекрывает процессное значение.

### Как выбирается backend, если аргумент не задан

Порядок — это порядок вызовов в `ServerArgs.__post_init__`, и каждый следующий шаг видит результат предыдущего.

1. **Платформа.** `--device hpu` жестко ставит `torch_native`; `--device cpu` при незаданном значении ставит `intel_amx` (или `torch_native` на ARM-хосте); `--device npu` через `set_default_server_args` пишет `ascend` **во все три** поля (`attention_backend`, `prefill_…`, `decode_…`) независимо от того, что задал оператор.
2. **Архитектура модели** (`_handle_model_specific_adjustments` и реестр `arg_groups/overrides.py`). Эти переопределения срабатывают только если не задан ни один из трех флагов (`ServerArgs.is_attention_backend_not_set()`). Примеры из checkout'а: DeepSeek с DSA (V3.2, GLM DSA) → `dsa` плюс `--page-size 64`; DeepSeek V4 → `dsv4` плюс `--page-size 256` (128 на NPU); DeepSeek V3/R1 на SM100 → `trtllm_mla`; Qwen3-Next/Qwen3.5-гибриды на SM100 → `triton` или `trtllm_mha`; Lfm2 на SM100 → `flashinfer`.
3. **Детерминированный режим.** При `--enable-deterministic-inference` и незаданном backend'е `_deterministic_attention_backend` выбирает `triton` (Blackwell + DeepSeek), `flashinfer` (Blackwell, не DeepSeek) либо `fa3` (SM90 и старше) и пишет warning со списком допустимых значений.
4. **Общий автоподбор** — `ServerArgs._get_default_attn_backend(use_mla_backend, model_config)`:
   - out-of-tree платформа — свой `current_platform.get_default_attention_backend()`;
   - Whisper — всегда `flashinfer` (cross-attention под CUDA graph);
   - **MHA**: Hopper с CUDA ≥ 12.3 и без спекуляции с topk > 1 → `fa3`; SM100 без спекуляции с topk > 1 → `trtllm_mha`, а при асимметричных K/V (`has_asymmetric_kv`) → `fa4`; ROCm → `aiter`; MPS → `torch_native`; иначе `flashinfer`, если он установлен и у модели нет attention sinks, иначе `triton`;
   - **MLA**: Hopper с CUDA ≥ 12.3 → `fa3`; SM100 → `flashinfer`; ROCm → `aiter` при 16 или 128 KV-головах, иначе `triton`; MPS → `torch_native`; иначе `triton`.

   Факт подстановки виден в логе: `Attention backend not specified. Use <backend> backend by default.`
5. **Dual chunk.** Если у модели в `hf_config` есть `dual_chunk_attention_config`, `_attention_backend_dual_chunk` ставит `dual_chunk_flash_attn` (лог «Dual chunk attention is turned on by default.»), а любое другое явное значение отвергается `ValueError`. Этот backend дополнительно принудительно выключает `--enable-mixed-chunk` и radix cache.

### Что backend меняет помимо самих ядер

- **`--page-size`.** Backend'ы MLA/TRT-LLM/HPC-Ops притягивают размер страницы к своему единственному допустимому значению, `fa4` на не-MLA модели под SM100 требует 128, `intel_xpu` — 64/128 (MLA-декод — 16/32/64/128). Все привязки перечислены в справке `--page-size`; здесь важно одно: `--page-size` вы задаете не «сам по себе», а вместе с backend'ом, и движок поправит его молча, с одним warning в логе.
- **CUDA graph.** `torch_native` и `flex_attention` полностью отключают захват графов для prefill и decode (`Cuda graph is disabled because of using torch native attention backend`), а `flex_attention` дополнительно запрещает спекулятивное декодирование. Для DeepSeek-V3 на `trtllm_mla` отключается prefill-граф.
- **Chunked prefix cache.** Работает только для MLA-моделей и только на backend'ах из `CHUNKED_PREFIX_CACHE_SUPPORTED_ATTENTION_BACKENDS` (`flashinfer`, `fa3`, `fa4`, `flashmla`, `cutedsl_mla`, `cutlass_mla`, `trtllm_mla`, `tokenspeed_mla`). Иначе `maybe_disable_chunked_prefix_cache` тихо выставляет `disable_chunked_prefix_cache=True` уже на этапе загрузки модели.
- **Radix cache.** Whisper и `dual_chunk_flash_attn` отключают его; в детерминированном режиме radix cache остается только на `ascend`, `fa3`, `fa4`, `triton` — на прочих печатается warning и кеш выключается.
- **`--mem-fraction-static`.** Backend `aiter` на модели с `context_len > 8192` умножает его на 0.85.
- **`--kv-cache-dtype`.** Набор допустимых типов у каждого backend'а свой; полная таблица — в справке `--kv-cache-dtype`.

## Значения и формат

- Значение вне списка отвергает argparse (`invalid choice`). Значение из списка, но неподходящее вашей модели или карте, отвергается ассертом/`ValueError` — на этапе `__post_init__` либо при создании backend'а в model runner.
- `nsa` и `compressed` — устаревшие синонимы. `compressed` нормализуется в `dsv4` прямо в `_handle_deprecated_args` (для всех четырех полей, включая `--speculative-draft-attention-backend`) с предупреждением `--attention-backend=compressed is deprecated; use 'dsv4' instead.`; `nsa` остается в реестре и печатает `DeprecationWarning` при создании DSA-backend'а. В новых конфигурациях используйте `dsa` и `dsv4`.
- `dsa` и `dsv4` — не универсальные ядра, а backend'ы конкретных архитектур: `DeepseekSparseAttnBackend` падает ассертом `DSA backend only supports DeepSeek DSA`, если модель не DSA.
- `null` (аргумент не задан) — единственный способ получить автоподбор. Задать «auto» строкой нельзя, такого значения в `choices` нет.

### Мягкие отказы (тихая подмена, только warning)

- `fa3` + `--kv-cache-dtype fp8_e5m2` → `triton`: «FlashAttention3 only supports fp8_e4m3 if using FP8; Setting attention backend to triton.»
- `intel_amx` на CPU без поддержки AMX → `torch_native`.
- `intel_xpu` на XPU без XMX → `triton`.
- `cutedsl_mla` в роли decode-backend'а при незаданном prefill → prefill автоматически становится `trtllm_mla`.

Все четыре случая меняют производительность в разы и никак иначе себя не проявляют. Если вы задали backend осознанно — проверьте по логу, что он выжил.

### Жесткие отказы (сервер не стартует)

- `trtllm_mla` / `tokenspeed_mla` / `cutedsl_mla` вне Blackwell — `ValueError` с явным текстом про SM100/SM12x.
- `trtllm_mha` в prefill вне SM100 или в decode вне SM90/SM100/SM120 — `ValueError`.
- `trtllm_mla`, `tokenspeed_mla` — с неподдерживаемым `--kv-cache-dtype`; `cutedsl_mla` — с чем-либо кроме `fp8_e4m3`/`bf16`/`auto`.
- `cutedsl_mla` в роли prefill — `CuteDSL MLA only supports decoding for now`.
- `intel_xpu` в prefill для MLA-модели — `ValueError` с рекомендацией задать его только в `--decode-attention-backend`.
- `dual_chunk_flash_attn` — любое расхождение с наличием `dual_chunk_attention_config` у модели.
- В детерминированном режиме — любой backend вне `["ascend", "fa3", "fa4", "flashinfer", "triton"]`.
- При создании backend'а: `fa3` вне SM80–SM90, `trtllm_mla`/`cutedsl_mla`/`tokenspeed_mla` на не-MLA модели, `trtllm_mha`/`hpc_ops` на MLA-модели, `triton` на encoder-decoder модели (cross-attention), `hpc_ops` со спекуляцией или encoder-decoder.
- Модельные ассерты: Llama4 требует один из `fa3`/`aiter`/`triton`/`ascend`/`trtllm_mha`/`intel_xpu`; Gemma4 — `trtllm_mha`/`triton`/`ascend`/`intel_xpu`; GPT-OSS — `triton`/`trtllm_mha`/`fa3`/`fa4`/`ascend`/`intel_amx`/`intel_xpu`/`aiter`; Exaone4 со скользящим окном — `fa3`/`triton`/`trtllm_mha`; NemotronH и Lfm2 запрещают `triton`; Olmo2/Olmo3 запрещают `flashinfer`.
- `--enable-mis` требует `flashinfer` и в prefill, и в decode.
- `--prefill-only-disable-kv-cache` требует prefill-backend `fa3` или `fa4`.
- `--enable-page-major-kv-layout` требует `triton` (для unified-memory MLA дополнительно разрешены `fa3`, `trtllm_mla`, `flashinfer`, `cutedsl_mla`, `tokenspeed_mla`).

## Когда использовать

- Задавайте явно, когда воспроизводите чужой бенчмарк или инструкцию, когда автоподбор выбрал backend без нужной вам возможности (FP8 KV, спекуляция с topk > 1, sliding window, мультимодальность — матрица в `sglang/docs/docs/advanced_features/attention_backend.mdx`), или когда сравниваете два backend'а на своей нагрузке.
- Не задавайте, если модель из списка с архитектурным переопределением (DeepSeek DSA, DeepSeek V4, Qwen3.5-гибриды, GPT-OSS, Llama4, Gemma4). Ручное значение там либо совпадет с автоподбором, либо будет отвергнуто ассертом, либо отключит переопределение вместе с сопутствующей настройкой `--page-size`.
- Не переносите значение между машинами разных поколений: `trtllm_mla` на Hopper и `fa3` на Blackwell — гарантированный отказ на старте.
- В arriero смена backend'а — это правка инстанса и перезапуск процесса; на живом процессе изменение видно как `config drift` в health summary, но реально применится только после рестарта.

## Влияние на производительность и память

- Это основной рычаг latency и throughput внимания: разница между Triton-путем и специализированным ядром на длинном контексте измеряется разами, а не процентами.
- VRAM меняется косвенно, но заметно: через навязанный `--page-size` (страница 128 против 1 меняет округление длин и page overhead планировщика), через рабочие буферы backend'а (workspace FlashInfer/TRT-LLM размером `SGLANG_FLASHINFER_WORKSPACE_SIZE`, персистентный fp32-буфер `attn_logits` у Triton), через отключение CUDA graph (`torch_native`/`flex_attention` освобождают память графов, но теряют скорость декода) и через `aiter`, который сам режет `--mem-fraction-static` на 15 %.
- Время старта: `fa4`, CuTe DSL и DeepGEMM-ветки компилируются JIT перед первым проходом; захват CUDA graph для гибридной пары backend'ов дороже, чем для одного.
- Гибридная пара prefill/decode дает две независимые инициализации и два набора буферов — экономии памяти от нее ждать не надо.

## Взаимодействие с другими аргументами

- `--prefill-attention-backend` / `--decode-attention-backend`: имеют приоритет над этим флагом; если оба заданы одинаковым значением, оно записывается и в `--attention-backend`.
- `--speculative-draft-attention-backend`: отдельный backend draft-воркера, процессное значение на него не влияет.
- `--page-size`: см. выше и справку `--page-size`.
- `--kv-cache-dtype`: см. справку `--kv-cache-dtype`.
- `--enable-deterministic-inference`: сужает список до пяти backend'ов и может выключить radix cache.
- `--disable-chunked-prefix-cache`: включается автоматически на backend'ах вне списка поддержки.
- `--dsa-prefill-backend` / `--dsa-decode-backend`: работают внутри `dsa`, это второй уровень выбора, а не альтернатива этому флагу.
- `--mm-attention-backend`: отдельный backend визуального энкодера, со своим списком значений.
- `--device`: платформенные обработчики пишут backend раньше всех остальных шагов.

## Типовые проблемы и диагностика

- **Симптом:** после смены `--kv-cache-dtype` на `fp8_e5m2` throughput упал в разы. **Причина:** `fa3` заменен на `triton`. **Проверка:** строка `Setting attention backend to triton` в логе. **Решение:** `fp8_e4m3`.
- **Симптом:** `page_size` в дампе не тот, что вы задали. **Причина:** привязка backend'а. **Проверка:** warning вида `FlashMLA only supports a page_size of 64, change page_size to 64.` **Решение:** задать совместимое значение или сменить backend.
- **Симптом:** `ValueError: TRTLLM MLA backend is only supported on Blackwell GPUs (SM100/SM12x).` **Причина:** конфиг с другой машины. **Решение:** убрать флаг и дать автоподбору выбрать `fa3` (Hopper) или `flashinfer`.
- **Симптом:** `AssertionError: DSA backend only supports DeepSeek DSA`. **Причина:** `--attention-backend dsa` на обычной модели.
- **Симптом:** «Chunked prefix cache is turned on» не появилось, prefill долгий на повторяющихся префиксах. **Причина:** backend вне списка поддержки chunked prefix cache либо не-MLA модель.
- **Что смотреть всегда:** итоговый дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) — там уже разрешенное значение; строку `Attention backend not specified. Use … backend by default.`; при разных prefill/decode — строку про hybrid attention backend. В arriero эти строки видны в фильтрованном логе инстанса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --attention-backend fa3 --kv-cache-dtype fp8_e4m3
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --attention-backend trtllm_mha --page-size 64 --kv-cache-dtype fp8_e4m3
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/attention/attention_registry.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/attention_backend_setup.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/misc_utils.py`
- `sglang/python/sglang/srt/hardware_backend/npu/utils.py`
- `sglang/python/sglang/srt/layers/attention/flashinfer_mla_backend.py`
- `sglang/python/sglang/srt/layers/attention/triton_backend.py`
- `sglang/docs/docs/advanced_features/attention_backend.mdx`
- `sglang/docs/docs/advanced_features/deterministic_inference.mdx`
