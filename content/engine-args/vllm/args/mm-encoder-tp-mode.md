---
schema: 1
engine: vllm
primaryName: "--mm-encoder-tp-mode"
title: "--mm-encoder-tp-mode"
summary: Как энкодер использует тензорный параллелизм: шардировать веса по рангам (`weights`) или держать полные веса на каждом ранге и делить между ними батч (`data`). Второй режим убирает all-reduce внутри ViT ценой дублирования его весов.
group: MultiModalConfig
related:
  - --tensor-parallel-size
  - --data-parallel-size
  - --mm-encoder-attn-backend
  - --limit-mm-per-prompt
  - --gpu-memory-utilization
  - --compilation-config
---

# --mm-encoder-tp-mode

## Кратко

`weights` — обычное поведение TP: матрицы каждого слоя ViT разрезаны по рангам, между слоями идут коллективы. `data` — batch-level data parallel: каждый ранг держит **полный** ViT и обрабатывает свою часть медиа-элементов батча, коллективов внутри энкодера нет.

Выигрыш `data` тем больше, чем больше элементов в батче и чем мельче ViT относительно языковой модели: типичный ViT — сотни мегабайт, продублировать его на 4 ранга дешевле, чем платить all-reduce на каждом слое.

Это **не** `--data-parallel-size`: тот делит запросы между независимыми движками, а здесь речь про один движок и один батч.

## Оригинальная справка

```text
Indicates how to optimize multi-modal encoder inference using tensor
parallelism (TP).

- `"weights"`: Within the same vLLM engine, split the weights of
  each layer across TP ranks. (default TP behavior)
- `"data"`: Within the same vLLM engine, split the batched input data
  across TP ranks to process the data in parallel, while hosting
  the full weights on each TP rank.
  This batch-level DP is not to be confused with API request-level
  DP (which is controlled by `--data-parallel-size`).
  This is only supported on a per-model basis and falls back to
  `"weights"` if the encoder does not support DP.
```

## Паспорт аргумента

- Флаги: `--mm-encoder-tp-mode`
- Группа argparse: `MultiModalConfig`
- Тип значения: enum (строка)
- Допустимые значения: `weights`, `data` (`MMEncoderTPMode`)
- Значение по умолчанию: `weights`
- Эффективное значение: `data` откатывается в `weights` в `ModelConfig.__post_init__`, если модель не объявляет `supports_encoder_tp_data`; кроме того, `data` включается **вынужденно**, когда число голов внимания ViT не делится на TP-размер
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_encoder_tp_mode`
- Этап применения: сборка `ModelConfig` (проверка поддержки) → построение модели (выбор слоёв ViT) → forward энкодера

## Что меняет в движке

**Проверка поддержки.** `ModelConfig.__post_init__`:

```python
if mm_encoder_tp_mode == "data" and not self._model_info.supports_multimodal_encoder_tp_data:
    logger.warning_once("This model does not support `--mm-encoder-tp-mode data`. Falling back to `--mm-encoder-tp-mode weights`.")
    mm_encoder_tp_mode = "weights"
```

Признак — классовый атрибут `supports_encoder_tp_data` (`SupportsMultiModal`, по умолчанию `False`). В этом commit'е checkout'а его объявляют многие VL-семейства (Qwen2-VL/Qwen2.5-VL/Qwen3-VL, InternVL, GLM-4.1V, MiniCPM-V, Llama-4, Step3-VL, Kimi-VL и другие), но список меняется от релиза к релизу — проверяйте grep'ом по `supports_encoder_tp_data = True` в `vllm/model_executor/models/` своей версии.

**Чтение в модели.** Реализации читают значение прямо: `self.use_data_parallel = multimodal_config.mm_encoder_tp_mode == "data"` — этот паттерн повторяется в двух десятках моделей. Общий помощник `vllm/model_executor/models/vision.py:is_vit_use_data_parallel()` дополнительно **включает** DP независимо от флага, если число голов внимания ViT не делится на TP-размер, с предупреждением `The number of vision attention heads is not divisible by the tensor parallel size. Falling back to data parallelism for the vision encoder.`

**CUDA graphs энкодера.** `vllm/v1/worker/encoder_cudagraph.py` учитывает режим (`use_dp = mm_encoder_tp_mode == "data" and tensor_parallel_size > 1`) при построении графов энкодера — именно эта комбинация фигурирует в апстрим-бенчмарках `--tensor-parallel-size 4 --mm-encoder-tp-mode data` вместе с `--compilation-config '{"cudagraph_mm_encoder": true}'`.

**Кэш компиляции.** Значение входит в `MultiModalConfig.compute_hash()`, поэтому переключение режима даёт другой ключ кэша графа.

## Значения и формат

- `weights` — дефолт. Работает всегда, требований к модели нет.
- `data` — требует поддержки со стороны модели; иначе молча (с warning) откатится.
- При `--tensor-parallel-size 1` разницы нет: делить нечего.
- Значение проверяется argparse по `choices`.

## Когда использовать

- `data` на VL-модели с TP ≥ 2 и заметным потоком изображений: коллективы внутри ViT исчезают, а элементы батча считаются параллельно.
- `data` вместе с CUDA graphs энкодера (`--compilation-config '{"cudagraph_mm_encoder": true}'`) — именно эта пара даёт максимальный эффект в апстрим-замерах.
- `weights`, когда VRAM в дефиците: полный ViT на каждом ранге — реальный расход, который вычитается из бюджета до KV-cache.
- Не включайте `data` ради одиночных запросов с одной картинкой: делить между рангами нечего, а веса продублируются.
- Проверьте, что модель поддерживает режим, прежде чем закладывать выигрыш в план: молчаливый откат легко не заметить.

## Влияние на производительность и память

- **VRAM.** `data` дублирует веса ViT на каждом TP-ранге. Для энкодера в сотни мегабайт при TP=4 это дополнительные сотни мегабайт на карту, вычитаемые из бюджета до KV-cache (механику см. в `--gpu-memory-utilization`).
- **Throughput.** `data` растёт с числом элементов в батче; на батче из одного элемента преимущества нет.
- **Latency.** Убираются коллективы на каждом слое ViT — это заметная доля времени энкодера на коротких ViT.
- **Профилирование.** Пик активаций считается в выбранном режиме, поэтому переключение меняет и измеренный объём.
- **Время старта.** `data` требует загрузить полные веса ViT на каждый ранг — чуть дольше; кроме того, смена режима инвалидирует кэш компиляции графа.

## Взаимодействие с другими аргументами

- `--tensor-parallel-size`: без TP > 1 аргумент бессмыслен; он же определяет коэффициент дублирования весов в режиме `data`.
- `--data-parallel-size`: другая ось — параллелизм на уровне запросов между движками. Справка специально предупреждает не путать.
- `--limit-mm-per-prompt`: определяет, насколько крупные батчи элементов вообще возможны, то есть окупится ли `data`.
- `--mm-encoder-attn-backend`: оба входят в `MultiModalConfig.compute_hash()`; вместе они и определяют, как считается внимание ViT.
- `--compilation-config`: `cudagraph_mm_encoder` включает CUDA graphs для энкодера, где режим TP учитывается явно.
- `--gpu-memory-utilization`: бюджет, из которого вычитаются продублированные веса ViT.

## Типовые проблемы и диагностика

- **Симптом:** warning `This model does not support --mm-encoder-tp-mode data. Falling back to --mm-encoder-tp-mode weights.` **Причина:** модель не объявляет `supports_encoder_tp_data`. **Лечение:** остаться на `weights`; выигрыша на этой модели не будет.
- **Симптом:** warning `The number of vision attention heads is not divisible by the tensor parallel size. Falling back to data parallelism for the vision encoder.` **Причина:** голов ViT не хватает на выбранный TP. **Действие:** режим DP включён вынужденно; проверьте, что VRAM это выдержит.
- **Симптом:** после `data` KV-cache уменьшился. **Причина:** веса ViT продублированы по рангам. **Лечение:** вернуться на `weights` либо поднять `--gpu-memory-utilization`.
- **Симптом:** `data` включён, а throughput не вырос. **Причина:** батчи по одному элементу — делить нечего; либо энкодер не является узким местом. **Проверка:** строка `Encoder cache will be initialized with a budget of N tokens, and profiled with M <modality> items ...` показывает ожидаемый размер батча.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `mm_encoder_tp_mode=...`; отсутствие warning'а об откате означает, что режим принят.

## Примеры

```bash
vllm serve /models/Qwen3-VL-32B-Instruct --tensor-parallel-size 4 --mm-encoder-tp-mode data --limit-mm-per-prompt '{"image": 4}'
```

```bash
vllm serve /models/Qwen3-VL-32B-Instruct --tensor-parallel-size 4 --mm-encoder-tp-mode data --compilation-config '{"cudagraph_mm_encoder": true}'
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/model_executor/models/interfaces.py`
- `vllm/vllm/model_executor/models/registry.py`
- `vllm/vllm/model_executor/models/vision.py`
- `vllm/vllm/v1/worker/encoder_cudagraph.py`
- `vllm/docs/design/cuda_graphs_multimodal.md`
