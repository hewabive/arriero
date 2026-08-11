---
schema: 1
engine: sglang
primaryName: "--enable-deterministic-inference"
title: "--enable-deterministic-inference"
summary: Включает batch-invariant режим: подменяет несколько ядер PyTorch, переписывает `--sampling-backend`, размеры split-тайлов внимания, `--attention-backend`, а при `--tp-size` больше 1 — алгоритм all-reduce. Гарантирует независимость выхода от состава батча, но не переносимость между машинами и версиями.
group: exec.deterministic
related:
  - --rl-on-policy-target
  - --attention-backend
  - --sampling-backend
  - --triton-attention-split-tile-size
  - --triton-attention-num-kv-splits
  - --disable-radix-cache
  - --tp-size
  - --disable-custom-all-reduce
  - --enable-torch-symm-mem
  - --flashinfer-allreduce-fusion-backend
  - --enable-aiter-allreduce-fusion
  - --enforce-disable-flashinfer-allreduce-fusion
  - --disable-flashinfer-autotune
  - --disable-piecewise-cuda-graph
  - --enable-mis
---

# --enable-deterministic-inference

## Кратко

Источник недетерминизма в обычном инференсе — не случайность, а плавающая точка: при разных размерах батча ядра режут редукции по-разному, а сложение float неассоциативно. Один и тот же запрос, попавший в батч из 1 и в батч из 64, дает разные логиты даже при `temperature=0`. Флаг включает **batch-invariant** режим: реализации ключевых операций подменяются на такие, чей порядок редукции зависит только от формы данных самого запроса.

Это не одна настройка, а связка: флаг переписывает `--sampling-backend`, фиксирует размеры split-тайлов у backend'ов внимания, сужает список допустимых `--attention-backend`, может выключить radix-кеш, отключает автотюнинг FlashInfer, запрещает piecewise CUDA graph и при `--tp-size` больше 1 переводит NCCL на детерминированный all-reduce. Полный список — ниже.

## Оригинальная справка

```text
Enable deterministic inference mode with batch invariant ops.
```

## Паспорт аргумента

- Флаги: `--enable-deterministic-inference`
- Группа: `exec.deterministic`
- Тип значения: bool (флаг без значения)
- Значение по умолчанию: `false`
- Эффективное значение: становится `true` автоматически, если задан `--rl-on-policy-target` (с warning'ом `Enable deterministic inference because of rl_on_policy_target.`)
- Где объявлен: `ServerArgs.enable_deterministic_inference`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_deterministic_inference`, `_handle_model_specific_adjustments`, `_handle_environment_variables`) → загрузка модели (`maybe_enable_batch_invariant_mode`) → создание backend'ов внимания → инициализация scheduler'а → каждый forward и sampling

## Что меняет в движке

### Подмена ядер

После загрузки модели `ModelRunner.maybe_enable_batch_invariant_mode` вызывает `enable_batch_invariant_mode()` (`sglang/python/sglang/srt/batch_invariant_ops/batch_invariant_ops.py`), который через `torch.library.Library("aten", "IMPL")` переопределяет для текущего устройства: `aten::mm`, `aten::addmm`, `aten::_log_softmax`, `aten::mean.dim`, `aten::rms_norm`, `aten::mm.dtype` и, по умолчанию, `aten::bmm` (плюс прямой monkey-patch `torch.bmm`). На NPU набор свой, включая `npu_fused_infer_attention_score` и `npu_add_rms_norm`.

### Какие аргументы переписываются

| Что | Как | Где |
| --- | --- | --- |
| `--sampling-backend` | становится `pytorch` (кроме `ascend`), warning `Sampling backend is set to pytorch for deterministic inference.` | `_deterministic_sampling_backend` |
| `--attention-backend` | если не задан — `triton` (Blackwell + DeepSeek), `flashinfer` (Blackwell, не DeepSeek) или `fa3` (SM90 и старше), с warning'ом; если задан вне `["ascend", "fa3", "fa4", "flashinfer", "triton"]` — `ValueError` | `_deterministic_attention_backend` |
| размер split-тайла Triton | `--triton-attention-split-tile-size` **игнорируется**: берется `SGLANG_TRITON_DECODE_SPLIT_TILE_SIZE` (256) и выключается `static_kv_splits` | `TritonAttnBackend.__init__` |
| размеры тайлов FlashInfer | `SGLANG_FLASHINFER_PREFILL_SPLIT_TILE_SIZE` (4096) и `SGLANG_FLASHINFER_DECODE_SPLIT_TILE_SIZE` (2048), decode переводится на tensor cores, KV-split в CUDA graph отключается, workspace принудительно 2 ГиБ | `FlashInferAttnBackend.__init__` |
| выравнивание усечения prefill | `truncation_align_size` = 4096 для `flashinfer` и `triton` | `Scheduler.init_deterministic_inference_config` |
| `--disable-radix-cache` | включается принудительно, если backend внимания вне `["ascend", "fa3", "fa4", "triton"]` — то есть при `flashinfer` radix-кеш выключается с warning'ом | `_handle_deterministic_inference` |
| `--enable-aiter-allreduce-fusion` | выключается | `_handle_deterministic_inference` |
| `--flashinfer-allreduce-fusion-backend` | сбрасывается в `null`; дополнительно ставится `enforce_disable_flashinfer_allreduce_fusion = True` | `_deterministic_allreduce_fusion_disable`, `_handle_model_specific_adjustments` |
| автотюнинг FlashInfer | не запускается: подобранные конфиги зависят от формы задачи, а значит и порядок редукции следовал бы за размером батча | `should_run_flashinfer_autotune` |
| piecewise CUDA graph | не захватывается («deterministic inference» в списке причин) | `server_args.py` |
| `SGLANG_ENABLE_DETERMINISTIC_INFERENCE` | выставляется в `1`/`0` — эту переменную читают custom all-reduce и `parallel_state` | `_handle_environment_variables` |

### При `--tp-size` больше 1

На CUDA: `NCCL_ALGO=allreduce:tree`, `--disable-custom-all-reduce` включается, `--enable-torch-symm-mem` выключается, число NCCL-каналов фиксируется через `NCCL_MIN_NCHANNELS`/`NCCL_MAX_NCHANNELS` (значение из `SGLANG_DETERMINISTIC_NCCL_NCHANNELS`). Причина в комментариях кода: и симметрично-памятный путь, и число каналов выбираются по объему сообщения, то есть порядок редукции следовал бы за числом токенов. На ROCm вместо этого используется одноступенчатое all-reduce ядро, детерминированное по построению.

### Дополнительные проверки для DeepSeek

Для `DeepseekV2/V3/V32ForCausalLM`, `MistralLarge3ForCausalLM`, `PixtralForConditionalGeneration`, `GlmMoeDsaForCausalLM` backend внимания обязан входить в `["ascend", "fa3", "fa4", "triton"]` (FlashInfer для них пока не детерминирован), а `fa4` дополнительно требует SM100/SM110.

### Сэмплирование

При включенном флаге `SamplingBatchInfo` формирует тензор `sampling_seed`, беря `sampling_params.sampling_seed` запроса, а при его отсутствии — `42`. То есть неgreedy-сэмплирование становится воспроизводимым: один и тот же seed дает один и тот же ответ, разные seed'ы — разные, но повторяемые. Это то, ради чего режим и нужен в RL-сценариях (GRPO).

## Значения и формат

- Флаг без значения; парной формы нет.
- Не задан — обычный режим; исключение — заданный `--rl-on-policy-target`, который включает флаг сам.
- Явно заданные `--sampling-backend` и `--triton-attention-split-tile-size` в этом режиме не действуют: первый переписывается, второй игнорируется в пользу переменной окружения.
- Тонкая настройка — только через переменные окружения (`SGLANG_TRITON_DECODE_SPLIT_TILE_SIZE`, `SGLANG_FLASHINFER_*_SPLIT_TILE_SIZE`, `SGLANG_TRITON_PREFILL_TRUNCATION_ALIGN_SIZE`, `SGLANG_DETERMINISTIC_NCCL_NCHANNELS`), CLI-флагов для них нет.

## Что режим гарантирует и что нет

Гарантирует:

- независимость выхода от размера и состава батча — один и тот же запрос дает один и тот же ответ, попал он в батч из 1 или из 64;
- воспроизводимость при `temperature > 0` — через `sampling_seed` (по умолчанию 42);
- совместимость с chunked prefill и CUDA graph на всех трех поддерживаемых backend'ах; radix-кеш — на `fa3`, `fa4`, `triton`, `ascend`, но не на `flashinfer`.

Не гарантирует:

- переносимости между машинами: другая карта, другая версия CUDA/PyTorch/FlashInfer или другой backend внимания дают другие числа;
- переносимости между версиями SGLang;
- инвариантности к `--tp-size`: смена степени параллелизма меняет разбиение редукций;
- инвариантности к самому набору аргументов — режим фиксирует порядок операций при заданной конфигурации, а не между конфигурациями;
- отсутствия эффекта от квантизации, спекуляции или иной длины контекста — это другие вычисления, а не тот же расчет с другим порядком.

Проверить на своей сборке: `python3 -m sglang.test.test_deterministic --test-mode single --n-trials 50` (ожидается `Unique samples: 1`), а также режимы `prefix` и `radix_cache`.

## Когда использовать

- RL-обучение (в том числе GRPO), где нужны стабильные logprob'ы между прогонами; для полного соответствия тренеру существует `--rl-on-policy-target`.
- Регрессионные проверки и отладка: воспроизводимый ответ отделяет реальные изменения от плавающей точки.
- Не включать в обычном продакшене: режим стоит throughput'а (нет автотюнинга, нет piecewise-графа, фиксированные тайлы, на `flashinfer` еще и нет radix-кеша) и не дает пользователю ничего, что тот заметил бы.
- Не рассчитывать на «одинаковые ответы на двух серверах» — режим об этом не говорит.

## Влияние на производительность и память

- VRAM: FlashInfer-workspace принудительно поднимается до 2 ГиБ; фиксированный размер тайла меняет `max_kv_splits` и, соответственно, размер буфера `attn_logits` у Triton; отключение piecewise-графа освобождает его память.
- RAM хоста: не влияет.
- Время старта: автотюнинг FlashInfer не выполняется — старт быстрее; захват графов не меняется.
- Throughput: падает. Batch-invariant `mm`/`bmm` уступают тюнингованным ядрам, фиксированные тайлы не подстраиваются под нагрузку, а при `flashinfer` выключается еще и radix-кеш.
- Latency: следует за throughput.

## Взаимодействие с другими аргументами

- `--rl-on-policy-target`: включает этот флаг автоматически и добавляет свои требования к вычислениям.
- `--attention-backend`: сужается до `ascend`/`fa3`/`fa4`/`flashinfer`/`triton`, для DeepSeek — до первых четырех без `flashinfer`.
- `--sampling-backend`: переписывается на `pytorch`.
- `--triton-attention-split-tile-size` / `--triton-attention-num-kv-splits`: игнорируются в пользу фиксированного тайла из переменной окружения.
- `--disable-radix-cache`: включается принудительно на неподдерживающих backend'ах.
- `--tp-size`: значение больше 1 включает детерминированный NCCL-путь.
- `--disable-custom-all-reduce`, `--enable-torch-symm-mem`: переписываются при `--tp-size` больше 1.
- `--flashinfer-allreduce-fusion-backend`, `--enable-aiter-allreduce-fusion`, `--enforce-disable-flashinfer-allreduce-fusion`: fusion-пути all-reduce отключаются.
- `--disable-flashinfer-autotune`: автотюнинг и так не запускается.
- `--disable-piecewise-cuda-graph`: piecewise-граф отключается сам.
- `--enable-mis`: требует `flashinfer` в обеих фазах, что для DeepSeek-моделей несовместимо с детерминированным списком backend'ов.
- `--speculative-use-rejection-sampling`: несовместим (`the sampling kernel draws coins from the global RNG and is not batch-invariant`).

## Типовые проблемы и диагностика

- `ValueError: Currently only ['ascend', 'fa3', 'fa4', 'flashinfer', 'triton'] attention backends are supported for deterministic inference, but you explicitly specified 'trtllm_mla'.`
- `ValueError: Currently only ['ascend', 'fa3', 'fa4', 'triton'] attention backends are supported for deterministic inference with DeepSeek models. But you're using flashinfer.`
- `ValueError: Deterministic inference with DeepSeek models on the fa4 attention backend requires SM100/SM110 …`
- `ValueError: --speculative-use-rejection-sampling is incompatible with --enable-deterministic-inference …`
- Warning `Currently radix cache is not compatible with flashinfer attention backend for deterministic inference.` — кеш префиксов выключен, TTFT на повторяющихся промптах вырос.
- Тест `sglang.test.test_deterministic` показывает `Unique samples: 2` — режим не применился полностью; сверьте по логу, что все переписывания произошли.
- Что смотреть в логе: `Sampling backend is set to pytorch for deterministic inference.`, `Attention backend not specified. Falling back to '<backend>' for deterministic inference.`, `NCCL_ALGO is set to 'allreduce:tree', the NCCL channel count is pinned, and custom and symmetric-memory all reduce are disabled …` и итоговый дамп `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --attention-backend fa3 --enable-deterministic-inference
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --attention-backend triton --enable-deterministic-inference --disable-radix-cache
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/batch_invariant_ops/batch_invariant_ops.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/layers/attention/triton_backend.py`
- `sglang/python/sglang/srt/layers/attention/flashinfer_backend.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/sampling/sampling_batch_info.py`
- `sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`
- `sglang/docs/docs/advanced_features/deterministic_inference.mdx`
