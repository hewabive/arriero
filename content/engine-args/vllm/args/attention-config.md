---
schema: 1
engine: vllm
primaryName: "--attention-config"
title: "--attention-config"
summary: JSON-объект `AttentionConfig` — выбор attention-backend'а (в том числе отдельного на каждую группу KV-cache), версия FlashAttention, тонкие переключатели MLA, sparse-индексера и flex-attention. Верхнеуровневый `--attention-backend` покрывает только одно его поле.
group: VllmConfig
related:
  - --attention-backend
  - --kv-cache-dtype
  - --compilation-config
  - --kernel-config
  - --disable-cascade-attn
  - --disable-hybrid-kv-cache-manager
  - --block-size
  - --override-attention-dtype
---

# --attention-config

## Кратко

`--attention-config` (алиас `-ac`) заполняет датакласс `AttentionConfig` (`vllm/config/attention.py`). Практически он нужен для трех задач: зафиксировать backend внимания, задать разные backend'ы для разных групп KV-cache у гибридных моделей и принудить конкретную версию FlashAttention. Остальные поля — узкие переключатели для MLA, sparse-attention и flex-attention.

Значение валидируется прямо на разборе CLI (argparse-тип — `TypeAdapter(AttentionConfig).validate_json`), поэтому опечатка в имени backend'а или в имени группы ловится до загрузки весов.

## Оригинальная справка

```text
Attention configuration.
```

## Паспорт аргумента

- Флаги: `--attention-config`, `-ac`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `-ac.<поле> <значение>`)
- Допустимые значения: поля `AttentionConfig`; значения `backend` и `backend_per_kind` — имена из реестра, а не статический список
- Значение по умолчанию: `Field(default_factory=AttentionConfig)` — объект со всеми значениями по умолчанию, а не `None`
- Эффективное значение: `EngineArgs.create_engine_config` делает копию и вливает в нее `--attention-backend`; при квантизации KV в TurboQuant принудительно понижает `flash_attn_version` до 2 с предупреждением. `AttentionConfig.__post_init__` превращает `backend: CUTLASS_MSA`/`TRITON_MSA` в `minimax_m3_msa_decode_backend` и **обнуляет** сам `backend`. Дополнительно `vllm/model_executor/models/config.py` может править конфиг под конкретную архитектуру — например, для DiffusionGemma включает `use_non_causal`, чтобы исключить FlashInfer из автовыбора
- Где объявлен: `vllm/config/vllm.py:VllmConfig.attention_config`
- Этап применения: разбор CLI → `create_engine_config` → выбор backend'а при инициализации слоев внимания → forward

## Что меняет в движке

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `backend` | `None` (автовыбор) | имя backend'а из `AttentionBackendEnum`; строка `auto` эквивалентна `None` |
| `backend_per_kind` | `{}` | словарь «вид группы KV-cache → backend», например `{"mla_attention":"FLASHINFER_MLA","sliding_window_mla":"TRITON_MLA"}`. Позволяет модели с разнородными слоями (полное внимание вперемешку со sliding window) использовать разные ядра. Незаданные виды падают обратно на `backend` или автовыбор; неизвестный ключ отвергается с перечислением допустимых |
| `flash_attn_version` | `None` | принудительная версия FlashAttention: `2`, `3` или `4`; действует только для flash-attention backend'ов |
| `mla_prefill_backend` | `None` | backend prefill для MLA: `FLASH_ATTN`, `FLASHINFER`, `TRTLLM_RAGGED` |
| `use_prefill_decode_attention` | `false` | раздельные ядра prefill и decode вместо единого triton-ядра |
| `use_trtllm_attention` | `None` | принудительно включить или выключить TRTLLM-путь внутри FlashInfer; `None` — автоопределение |
| `disable_flashinfer_q_quantization` | `false` | при fp8 KV не квантовать Q |
| `use_prefill_query_quantization` | `false` | квантовать Q на prefill |
| `indexer_kv_dtype` | `"bf16"` | тип K-кэша sparse-индексера: `bf16`, `fp8`, `mxfp4`, `nvfp4`. Квантованные форматы требуют поддержки в ядре индексера |
| `use_fp4_indexer_cache` | `false` | помечено в исходниках как «not support yet» |
| `sparse_mla_force_mqa` | `false` | всегда идти по MQA-пути в sparse MLA, включая чистый prefill |
| `use_non_causal` | `false` | двунаправленное внимание; выставляется автоматически для dLLM-моделей |
| `minimax_m3_msa_decode_backend` | `"triton"` | ядро sparse-decode для MiniMax M3 MSA: `triton` или `cutlass` |
| `flash_attn_max_num_splits_for_cuda_graph` | `32` | фиксированное число сплитов FlashAttention при decode в CUDA graph |
| `tq_max_kv_splits_for_cuda_graph` | `32` | то же для TurboQuant; фиксация нужна, чтобы размеры grid не менялись между захватами |
| `flex_attn_block_m`, `flex_attn_block_n`, `flex_attn_q_block_size`, `flex_attn_kv_block_size` | `None` | размеры тайлов и логических блоков flex-attention; все должны быть степенями двойки |

`compute_hash()` этого конфига входит в хеш `VllmConfig`, то есть влияет на ключ кэша компиляции: смена backend'а вызывает перекомпиляцию.

## Значения и формат

- Обе формы: `--attention-config '{"backend":"FLASH_ATTN","flash_attn_version":3}'` и `-ac.backend=FLASH_ATTN -ac.flash_attn_version=3`. Все точечные под-флаги должны использовать одно написание флага и не смешиваться с полной JSON-строкой — иначе argparse увидит два разных аргумента и применит последний.
- Имена backend'ов разбираются регистронезависимо и приводятся к верхнему регистру (`AttentionBackendEnum[value.upper()]`), поэтому `flash_attn` и `FLASH_ATTN` эквивалентны.
- `"auto"` в поле `backend` означает `None`, то есть автовыбор.
- **Список допустимых backend'ов не статичен.** Он собирается из `AttentionBackendEnum` в `vllm/v1/attention/backends/registry.py`, а `register_backend()` позволяет подменять реализации в runtime. Перечислять его в документе бессмысленно — он меняется от релиза к релизу. Смотрите фактический список на своей сборке: `vllm serve --help=attention-backend` в нужном окружении, а неверное имя даст ошибку валидации со списком вариантов.
- Ключи `backend_per_kind` — значения `KVCacheSpecKind` (`vllm/v1/kv_cache_interface.py`); неизвестный ключ отвергается сообщением `Unknown KV cache group kind '...' in backend_per_kind. Valid kinds are: ...`.

## Когда использовать

- **Зафиксировать backend в эксплуатации.** Автовыбор зависит от версии, железа и установленных пакетов; фиксация делает поведение воспроизводимым. Для одного поля проще `--attention-backend`, этот флаг нужен, когда полей несколько.
- **Гибридные модели.** `backend_per_kind` — единственный способ дать разным группам KV-cache разные ядра.
- **Обход дефекта в конкретной версии FlashAttention** — `flash_attn_version`.
- **Не подбирайте backend наугад «для скорости».** Неподходящий backend чаще всего не медленнее, а несовместим: старт падает на несоответствии `block_size`, dtype KV или головной размерности.
- **`use_fp4_indexer_cache` не включайте** — поле помечено в исходниках как нереализованное.

## Влияние на производительность и память

- **VRAM.** Backend определяет требования к раскладке KV-cache и размер вспомогательных буферов; `flash_attn_max_num_splits_for_cuda_graph`/`tq_max_kv_splits_for_cuda_graph` фиксируют число сплитов, чтобы буферы можно было выделить заранее и не раздувать оценку памяти. `indexer_kv_dtype` напрямую задает размер K-кэша индексера у sparse-моделей.
- **Latency/throughput.** Основной эффект — выбор ядра; разница между FlashAttention, FlashInfer и Triton на одной карте может быть кратной на длинных контекстах.
- **Время старта.** Смена backend'а меняет хеш конфигурации и вызывает перекомпиляцию; FlashInfer дополнительно может проходить JIT-компиляцию ядер.

## Взаимодействие с другими аргументами

- `--attention-backend`: верхнеуровневый синоним поля `backend`. Задавать оба нельзя — `attention_backend and attention_config.backend are mutually exclusive`.
- `--kv-cache-dtype`: часть backend'ов не поддерживает fp8-KV или требует отдельных ключей (`disable_flashinfer_q_quantization`); при TurboQuant движок сам понижает `flash_attn_version` до 2.
- `--block-size`: у backend'ов разные допустимые размеры блока; несовместимость проявляется на старте.
- `--disable-cascade-attn`, `--disable-hybrid-kv-cache-manager`: соседние переключатели того же тракта, живут вне этого конфига.
- `--compilation-config`: захват CUDA graphs зависит от того, какие операции backend помечает несовместимыми с графами.
- `--kernel-config`: выбор MoE/linear-ядер; на attention не влияет, но вместе они определяют, какие fusion-проходы включатся.
- `--override-attention-dtype`: отдельный флаг, меняющий dtype вычислений внимания.

## Типовые проблемы и диагностика

- **Симптом:** argparse отвергает значение с `ValidationError` и упоминанием `AttentionBackendEnum`. **Причина:** имя backend'а отсутствует в реестре этой сборки. **Лечение:** сверить список через `vllm serve --help=attention-backend`.
- **Симптом:** `Unknown KV cache group kind '...' in backend_per_kind. Valid kinds are: ...` **Лечение:** взять имя из перечисленных в сообщении.
- **Симптом:** `attention_backend and attention_config.backend are mutually exclusive`. **Лечение:** оставить что-то одно.
- **Симптом:** предупреждение `TurboQuant is not yet compatible with FlashAttention >= 3. Overriding flash_attn_version to 2. To silence this warning, pass --attention-config.flash_attn_version=2`. **Лечение:** задать версию явно.
- **Симптом:** `FlashInfer does not support DiffusionGemma's mixed causal/bidirectional attention. Use --attention-backend FLASH_ATTN or TRITON_ATTN instead.` **Причина:** backend задан вручную для dLLM-модели. **Лечение:** следовать сообщению.
- **Симптом:** старт падает на несовместимости backend'а с `--block-size` или dtype KV. **Лечение:** вернуть `backend` в автовыбор и посмотреть, что движок выберет сам.
- **Подтверждение принятого значения:** в логе старта backend печатается при инициализации слоев внимания (строка вида `Using ... backend`), а `Final IR op priority after setting platform defaults: ...` подтверждает, что платформенные умолчания уже применены.

## Примеры

```bash
vllm serve /models/Qwen3-4B --attention-config '{"backend":"FLASH_ATTN","flash_attn_version":3}' --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-4B -ac.backend_per_kind '{"mla_attention":"FLASHINFER_MLA","sliding_window_mla":"TRITON_MLA"}'
```

## Источники

- `vllm/vllm/config/attention.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/attention/backends/registry.py`
- `vllm/vllm/model_executor/models/config.py`
- `vllm/docs/design/attention_backends.md`
