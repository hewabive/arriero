---
schema: 1
engine: sglang
primaryName: "--triton-attention-num-kv-splits"
title: "--triton-attention-num-kv-splits"
summary: Верхняя граница числа split'ов KV в flash-decoding ядре Triton. Влияет только на backend'ы `triton` и `wave`, но напрямую задает размер персистентного fp32-буфера промежуточных логитов, который захватывается в CUDA graph.
group: exec.kernel
related:
  - --attention-backend
  - --decode-attention-backend
  - --triton-attention-split-tile-size
  - --enable-deterministic-inference
  - --context-length
  - --mem-fraction-static
  - --cuda-graph-max-bs
---

# --triton-attention-num-kv-splits

## Кратко

`--triton-attention-num-kv-splits` задает `max_kv_splits` — на сколько кусков ядро flash decoding режет KV-последовательность, чтобы занять все SM. Значение имеет смысл только если декод обслуживает `triton` (или `wave`); на любом другом backend'е поле просто не читается. Практическая цена — память: персистентный fp32-буфер `attn_logits`, который выделяется под захват CUDA graph, линейно зависит от этого числа.

## Оригинальная справка

```text
The number of KV splits in flash decoding Triton kernel. Larger value is better in longer context scenarios. The default value is 8.
```

## Паспорт аргумента

- Флаги: `--triton-attention-num-kv-splits`
- Группа: `exec.kernel`
- Тип значения: целое
- Допустимые значения: `choices` нет; практический смысл имеют степени двойки, потому что и `_mla_decode_kv_splits_cap`, и планировщик split'ов округляют вверх до степени двойки
- Значение по умолчанию: `8`
- Эффективное значение: на ROCm `_handle_amd_specifics` в `__post_init__` безусловно переписывает поле на `16`, независимо от заданного значения. Дальше уже в backend'е (`TritonAttnBackend.__init__`) для MLA-моделей значение поднимается до `_mla_decode_kv_splits_cap(...)` — `max(заданное, min(next_pow2(число SM), next_pow2(ceil(context_len / 32))))`, а на gfx942 дополнительно ограничивается сверху 256. Если задан `--triton-attention-split-tile-size`, `max_kv_splits` пересчитывается из него как `ceil(context_len / split_tile_size)` и заданное здесь значение теряет силу
- Где объявлен: `ServerArgs.triton_attention_num_kv_splits`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `_handle_amd_specifics` (ROCm) → конструктор `TritonAttnBackend` / `WaveAttnBackend` → выделение буферов CUDA graph → каждый decode-forward

## Что меняет в движке

`TritonAttnBackend` (`sglang/python/sglang/srt/layers/attention/triton_backend.py`) хранит значение как `self.max_kv_splits` и использует его тремя способами.

1. **Планирование split'ов на forward.** `get_num_kv_splits_triton` на каждом шаге подбирает фактическое число split'ов на запрос по длинам последовательностей, числу голов и числу SM, но не выше `max_kv_splits`. Если включена переменная `SGLANG_TRITON_DECODE_ATTN_STATIC_KV_SPLITS=true` или число ядер устройства неизвестно, планирование выключается и всем запросам ставится ровно `max_kv_splits`.
2. **Размер буферов.** На каждом eager-forward выделяются `attn_logits` формы `(bs, num_head, max_kv_splits, v_head_dim)` в fp32 и `attn_lse` формы `(bs, num_head, max_kv_splits)`. Для CUDA graph те же буферы выделяются один раз на `max_num_tokens` строк и живут все время работы сервера. Комментарий в коде про gfx942 дает порядок величины: 512 split'ов на Kimi-K2.6 раздували этот буфер примерно до 4 GiB, из-за чего его и ограничили 256.
3. **Потолок для MLA.** `_mla_decode_kv_splits_cap` может **поднять** значение выше заданного: если у карты много SM и длинный контекст, движок сам увеличит число split'ов. Уменьшить значение ниже вычисленного минимума этим флагом нельзя.

Backend `wave` (`sglang/python/sglang/srt/layers/attention/wave_backend.py`) читает то же поле как `max_kv_splits`.

## Значения и формат

- Дефолт `8` — компромисс для коротких контекстов. Справка прямо говорит, что на длинном контексте выгоднее больше.
- Значения не-степени двойки принимаются argparse, но `_mla_decode_kv_splits_cap` сравнивает их с округленными вверх степенями двойки, так что эффект будет ступенчатым.
- `0` и отрицательные значения кода не проверяются нигде: они дадут буфер нулевого/некорректного размера и упадут на первом forward. Не задавайте их.
- Значение не читается вообще, если ни prefill, ни decode не обслуживает `triton`/`wave`.

## Когда использовать

- Поднимайте (16, 32, 64), когда decode идет через `triton`, контекст длинный, батч маленький и GPU недозагружен: это классический случай, когда параллелизма по батчу не хватает и его добирают split'ами по KV.
- Не трогайте на MLA-моделях, пока не посмотрели, что реально выбрал `_mla_decode_kv_splits_cap`: там значение и так поднимается по числу SM и длине контекста.
- Не трогайте на ROCm: `_handle_amd_specifics` все равно поставит 16.
- Уменьшайте (4), только если упираетесь в память под CUDA graph на модели с большим `v_head_dim` и большим `--cuda-graph-max-bs`.

## Влияние на производительность и память

- **VRAM.** Прямая линейная зависимость: буфер CUDA graph `max_num_tokens × num_head × max_kv_splits × v_head_dim × 4` байта плюс `max_num_tokens × num_head × max_kv_splits × 4` под LSE, и еще столько же на SWA-слои у моделей со скользящим окном. Эта память отнимается у KV-пула через общий бюджет `--mem-fraction-static`.
- **Latency.** Больше split'ов — больше параллелизма на длинных последовательностях и меньше времени на шаг декода; но и больше работы на финальном reduce, поэтому на коротких контекстах рост значения только вредит.
- **Throughput.** При большом батче параллелизма хватает и без split'ов, так что выигрыш проявляется на малой конкурентности.
- **Время старта.** Косвенно: больший буфер CUDA graph — дольше выделение и выше риск OOM на этапе захвата.

## Взаимодействие с другими аргументами

- `--attention-backend` / `--decode-attention-backend`: значение имеет смысл только при `triton` или `wave`.
- `--triton-attention-split-tile-size`: если задан, полностью перекрывает это значение (`max_kv_splits = ceil(context_len / split_tile_size)`).
- `--enable-deterministic-inference`: включает фиксированный tile-размер из `SGLANG_TRITON_DECODE_SPLIT_TILE_SIZE` (по умолчанию 256) и отключает динамическое планирование split'ов — значение флага снова становится производным.
- `--context-length`: входит в формулу потолка для MLA и в пересчет из tile-размера.
- `--mem-fraction-static`: буфер логитов конкурирует за ту же VRAM, что и KV-пул.

## Типовые проблемы и диагностика

- **Симптом:** OOM на этапе захвата CUDA graph после увеличения значения. **Причина:** персистентный fp32-буфер. **Решение:** вернуть меньшее число split'ов либо уменьшить `--cuda-graph-max-bs`.
- **Симптом:** значение задано, а поведение не изменилось. **Причина:** декод обслуживает не `triton`; либо ROCm перетер значение на 16; либо MLA-потолок и так был выше.
- **Симптом:** на ROCm gfx942 при длинном контексте были падения в graph replay. **Причина/решение:** это как раз тот случай, ради которого код ограничивает значение 256 — не пытайтесь обойти ограничение вручную.
- **Проверка:** дамп `server_args=` при старте показывает значение после `_handle_amd_specifics`, но **не** показывает потолок MLA — тот применяется уже внутри backend'а. Косвенно эффект виден по размеру `graph_memory_usage` в логе захвата графов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --attention-backend triton --triton-attention-num-kv-splits 16
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --decode-attention-backend triton --prefill-attention-backend fa3 --triton-attention-num-kv-splits 32 --context-length 131072
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/triton_backend.py`
- `sglang/python/sglang/srt/layers/attention/wave_backend.py`
- `sglang/docs/docs/advanced_features/hyperparameter_tuning.mdx`
