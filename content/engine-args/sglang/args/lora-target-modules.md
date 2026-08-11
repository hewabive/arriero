---
schema: 1
engine: sglang
primaryName: "--lora-target-modules"
title: "--lora-target-modules"
summary: Объединение всех модулей, которые будут обернуты в LoRA-слои и получат буферы в пуле. Вместе с рангом и числом слотов определяет расход VRAM; адаптер с модулем вне этого списка не загрузится.
group: lora
related:
  - --max-lora-rank
  - --max-loras-per-batch
  - --lora-paths
  - --enable-lora
  - --lora-strict-loading
  - --tp-size
  - --enable-dp-attention
---

# --lora-target-modules

## Кратко

`--lora-target-modules` перечисляет модули базовой модели, которые оборачиваются LoRA-слоями и под которые в пуле выделяются буферы. Это множество — **объединение** по всем адаптерам, которые сервер согласится обслуживать. Не задан — выводится из `--lora-paths`; специальное значение `all` разворачивается обходом самой модели. Каждый добавленный модуль стоит VRAM на всех слотах пула, а `lm_head`/`embed_tokens` стоят несопоставимо дороже остальных, потому что их размерность — словарь.

## Оригинальная справка

```text
The union set of all target modules where LoRA should be applied. If not specified, it will be automatically inferred from the adapters provided in --lora-paths. If 'all' is specified, all supported modules will be targeted.
```

## Паспорт аргумента

- Флаги: `--lora-target-modules`
- Группа: `lora`
- Тип значения: список строк (`nargs="*"`)
- Допустимые значения: `q_proj`, `k_proj`, `v_proj`, `o_proj`, `q_a_proj`, `kv_a_proj_with_mqa`, `q_b_proj`, `kv_b_proj`, `wq_b`, `wk`, `weights_proj`, `gate_proj`, `up_proj`, `down_proj`, `qkv_proj`, `gate_up_proj`, `embed_tokens`, `lm_head`, `qkvr`, `wo_ud` (константа `SUPPORTED_LORA_TARGET_MODULES`) плюс сентинел `all`
- Значение по умолчанию: `null` — «вывести из адаптеров»
- Эффективное значение: нормализуется в множество в `check_lora_server_args`; `all` разворачивается в `LoRAManager.init_lora_shapes` через `auto_detect_lora_target_modules(base_model)` с добавлением `embed_tokens` и `lm_head`
- Где объявлен: `ServerArgs.lora_target_modules`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (нормализация и проверка) → `LoRAManager.init_lora_shapes` (после загрузки весов) → `init_lora_modules` и `LoRAMemoryPool.init_buffers`

## Что меняет в движке

### Нормализация имен

`get_normalized_target_modules` (`sglang/python/sglang/srt/lora/utils.py`) схлопывает имена PEFT в «упакованные» имена SGLang:

- `q_proj`, `k_proj`, `v_proj` → `qkv_proj`;
- `gate_proj`, `up_proj` → `gate_up_proj`;
- `q_a_proj`, `kv_a_proj_with_mqa` → `fused_qkv_a_proj_with_mqa`;
- `vocab_emb`/`embeddings`/`word_embeddings` → `embed_tokens`, `output`/`unembed_tokens` → `lm_head`;
- `wq_b`, `wk`, `weights_proj` → квалифицированные `indexer.*` имена DSA.

Поэтому перечислять `q_proj k_proj v_proj` и `qkv_proj` — одно и то же, и в пуле в обоих случаях появится один буфер `qkv_proj`.

### Значение `all`

`check_lora_server_args` требует, чтобы `all` был **единственным** элементом списка (`If 'all' is specified in --lora-target-modules, it should be the only module specified.`). Разворачивается он не по константе, а обходом загруженной модели: `auto_detect_lora_target_modules` идет по `named_modules()`, добавляет `gate_up_proj`/`down_proj` за каждый `FusedMoE`, `lm_head` за `ParallelLMHead`, `embed_tokens` за `VocabParallelEmbedding` и листовые имена всех `LinearBase`, затем пересекает результат с `_KNOWN_LORA_TARGET_MODULES`. Итог печатается: `CLI --lora-target-modules='all' resolved to [...] by inspecting the base model.`

### Проверка адаптеров

Когда список задан явно, каждый адаптер обязан быть его подмножеством:

```text
LoRA adapter '<name>' contains target modules ['down_proj'] that are not included in the specified --lora-target-modules ['qkv_proj']. Please update --lora-target-modules to include all required modules: [...], or use 'all' to enable all supported modules.
```

Когда список не задан, множество собирается объединением по адаптерам; PEFT-сокращения `all-linear`/`all` в `adapter_config.json` при этом разворачиваются тем же обходом модели. Прочие строковые значения в конфиге адаптера дают `ValueError` с требованием задать `--lora-target-modules` явно.

Отдельная несовместимость: если в целевые модули попал DSA-индексер (`indexer.wq_b`, `indexer.wk`, `indexer.weights_proj`), а в модели включено слияние Q/K индексера, старт падает с требованием выставить `SGLANG_DISABLE_DSA_INDEXER_FUSION=1` — слитые модули LoRA обернуть нечем, и адаптер был бы молча проигнорирован.

### Формы буферов

Для каждого модуля из множества и каждого слоя создаются `A`/`B`-буферы (см. `--max-lora-rank`). Размерности берутся из `get_hidden_dim` и делятся на «свой» TP-размер: `moe_tp_size` для routed-экспертов, `attn_tp_size` для attention-проекций (это важно при `--enable-dp-attention`, где `attn_tp_size = tp_size // dp_size`), `tp_size` для остального. Модули `embed_tokens` и `lm_head` живут в отдельных буферах: у `embed_tokens` вход — размер словаря и он **не шардируется** между рангами, у `lm_head` выход шардируется по разбиению `ParallelLMHead`.

Для неоднородных архитектур (гибрид linear/full attention, first-k-dense MoE) буферы заводятся под объединение по всем типам слоев, а на слоях, где модуль отсутствует, слот просто не используется.

## Значения и формат

- Разделитель — пробел: `--lora-target-modules qkv_proj o_proj gate_up_proj down_proj`.
- `nargs="*"` позволяет указать аргумент без значений — получится пустой список, эквивалентный «не задан».
- Значение вне `choices` argparse отвергнет; список `choices` в вашей сборке может отличаться от исходников checkout'а.
- `all` — единственный элемент, иначе ассерт.
- Порядок не важен: значение нормализуется в множество.

## Когда использовать

- Динамическая загрузка адаптеров: список обязателен вместе с `--max-lora-rank`. `all` — самый безопасный выбор по совместимости и самый дорогой по VRAM.
- Нужно сузить пул: если все ваши адаптеры трогают только attention, `qkv_proj o_proj` вместо `all` убирает из пула буферы MLP — а это две трети объема для типовой Llama-архитектуры.
- Нужно **запретить** обслуживание адаптеров, трогающих лишние модули: заданный список работает как контракт, и несовместимый адаптер отвергается с явным сообщением.
- **Избегайте `lm_head` и `embed_tokens`**, если они вам не нужны: их буферы размерны по словарю, и на моделях со 128k+ токенов это отдельный крупный расход, в разы превышающий остальные модули вместе взятые.
- **Не подбирайте список наугад**: пропущенный модуль обнаружится не при старте, а при загрузке конкретного адаптера.

## Влияние на производительность и память

- **VRAM.** Множитель объема пула наравне с рангом и числом слотов. Для Llama-подобной модели вклад по группам примерно такой: `gate_up_proj` ~45 %, `qkv_proj` и `down_proj` по ~22 %, `o_proj` ~10 %. Добавление `lm_head`/`embed_tokens` меняет порядок величины.
- **Скорость.** Каждый обернутый модуль добавляет к своему GEMM две дополнительные операции на каждом forward — и на prefill, и на decode. Лишние модули в списке, которых нет ни в одном адаптере, буферы всё равно занимают, но считаются по обнуленным весам.
- **RAM хоста.** Влияет косвенно: набор модулей определяет, сколько весит адаптер в CPU-кеше.
- **Время старта.** `all` требует обхода модели — недорого, но выполняется после загрузки весов.

## Взаимодействие с другими аргументами

- `--max-lora-rank`, `--max-loras-per-batch`: остальные два множителя объема пула.
- `--lora-paths`: источник вывода списка, если он не задан; одновременно набор, проверяемый на подмножество.
- `--enable-lora`: при пустом `--lora-paths` требует эту пару аргументов.
- `--lora-strict-loading`: веса адаптера, не сматчившиеся ни с одним целевым модулем, при нем становятся ошибкой, а не предупреждением.
- `--tp-size`, `--enable-dp-attention`, `--ep-size`: определяют, по какой ширине шардируется каждый модуль; attention-проекции идут по attn-TP, routed-эксперты — по moe-TP.
- В arriero изменение списка меняет VRAM-draw инстанса — заявку в `config/resources.json` надо пересчитывать (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `argument --lora-target-modules: invalid choice: 'mlp'` — имя вне поддерживаемого списка.
- `AssertionError: If 'all' is specified in --lora-target-modules, it should be the only module specified.`
- `ValueError: LoRA adapter '<name>' contains target modules [...] that are not included in the specified --lora-target-modules [...]` — сообщение сразу содержит готовое объединение, которое надо подставить.
- `ValueError: SGLang does not recognize target_modules='<x>'` — в `adapter_config.json` строка, отличная от `all`/`all-linear`; задайте список явно.
- `ValueError: SGLang currently only supports inferring LoRA target modules when a list of suffixes is provided ...` — тот же класс проблемы с нестандартным конфигом адаптера.
- `ValueError: LoRA targets the DSA indexer (...), which is incompatible with DSA indexer Q/K fusion. Set SGLANG_DISABLE_DSA_INDEXER_FUSION=1 ...`
- OOM или неожиданно маленький KV-пул после добавления `all` — почти всегда `lm_head`/`embed_tokens`.
- Что реально получилось, печатается двумя строками: `CLI --lora-target-modules='all' resolved to [...]` при разворачивании сентинела и `LoRA adapter '<uid>': loaded weights for target modules [...]` при загрузке каждого адаптера.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 64 --lora-target-modules qkv_proj o_proj --max-loras-per-batch 8
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 256 --lora-target-modules all --max-loras-per-batch 2 --lora-backend csgmv
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/utils.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
