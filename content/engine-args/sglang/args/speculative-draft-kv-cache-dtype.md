---
schema: 1
engine: sglang
primaryName: "--speculative-draft-kv-cache-dtype"
title: "--speculative-draft-kv-cache-dtype"
summary: Задаёт dtype отдельного KV-пула draft-модели, не меняя target KV cache. FP8 вдвое уменьшает draft pool относительно BF16, но требует совместимого draft attention backend; без флага dtype наследуется от `--kv-cache-dtype`.
group: spec
related:
  - --kv-cache-dtype
  - --speculative-draft-attention-backend
  - --speculative-algorithm
  - --speculative-draft-model-path
  - --mem-fraction-static
  - --max-total-tokens
---

# --speculative-draft-kv-cache-dtype

## Кратко

Draft worker спекулятивного декодирования имеет собственную геометрию внимания и отдельный KV pool, но разделяет с target пространство slot indices: один draft slot резервируется на каждый target token slot. Поэтому даже draft из нескольких слоёв может занимать заметную VRAM. Флаг позволяет перевести только этот пул в FP8, оставив target cache в BF16 или другом dtype.

## Оригинальная справка

```text
KV cache dtype for the speculative draft model only. The draft pool is allocated with one slot per target token (draft and target share a slot index space), so for a small draft it can still rival the target pool: a 5-layer DFLASH draft costs 10240 bytes/token in bf16. Setting fp8_e4m3 halves the draft pool; the saving shows up as free device memory, so raise --mem-fraction-static to convert it into KV capacity. Default follows --kv-cache-dtype.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-kv-cache-dtype`
- Группа: `spec`
- Тип значения: `Optional[str]`
- Допустимые значения: `auto`, `fp8_e5m2`, `fp8_e4m3`, `bf16`, `bfloat16`
- Значение по умолчанию: `null` — draft наследует target `--kv-cache-dtype`
- Где объявлен: `ServerArgs.speculative_draft_kv_cache_dtype`
- Этап применения: создание draft `ModelRunner` → разрешение dtype → расчёт draft bytes/token для target KV budget → аллокация draft KV pool

## Что меняет в движке

`ModelRunner.configure_kv_cache_dtype` передаёт draft-specific значение в `configure_kv_cache_dtype` только для `is_draft_worker`. Target runner его не читает. Явные `fp8_e4m3`/`fp8_e5m2` выбирают torch FP8 dtype (на ROCm оба проходят через нативный `fp8_dtype`), `bf16` и `bfloat16` эквивалентны.

Для DFLASH target заранее вычисляет точную стоимость draft pool по числу KV-heads, сумме key/value head dimensions, числу draft layers и размеру dtype. Если вычисление невозможно, логируется warning и budget возвращается к приближению по числу слоёв.

Отдельное исключение — DFLASH с `--speculative-draft-attention-backend fa4`: FA4 требует `K.dtype == Q.dtype`. Если выбранный/inherited KV dtype отличается от model dtype, движок принудительно возвращает draft cache к model dtype и пишет info-строку.

## Значения и формат

- `null` — полное наследование `--kv-cache-dtype`, включая его `auto` semantics.
- `auto` — draft pool выбирается по quant config draft-модели; без FP8 KV metadata используется dtype draft model.
- `fp8_e4m3` / `fp8_e5m2` — один byte на элемент, то есть примерно половина BF16 draft-pool.
- `bf16` / `bfloat16` — два равнозначных имени `torch.bfloat16`.
- FP4/MXFP8 значения target-флага здесь намеренно отсутствуют и отвергаются argparse.

## Когда использовать

- DFLASH/DSpark с малым draft, когда draft pool неожиданно съедает существенную VRAM несмотря на небольшое число весовых слоёв.
- `fp8_e4m3` — практический первый вариант после проверки acceptance rate/качества и совместимости draft attention backend.
- Явный BF16 полезен для диагностики, если target KV cache квантизован, а draft path даёт numerics/backend errors.
- Не задавайте для NGRAM или режима без отдельного draft runner: значение не будет использовано.

## Влияние на производительность и память

FP8 вдвое уменьшает bytes/token draft pool относительно BF16. Это освобождает device memory, но не обязательно автоматически увеличивает target KV capacity: если `--mem-fraction-static` уже фиксирует долю, её нужно отдельно пересчитать/поднять, сохраняя OOM headroom. Скорость зависит от поддержки FP8 в draft attention; лишние cast/descale могут съесть выигрыш.

На host RAM и размер draft weights флаг не влияет.

## Взаимодействие с другими аргументами

- `--kv-cache-dtype` — источник значения, когда draft-specific флаг не задан.
- `--speculative-draft-attention-backend fa4` может принудительно отменить FP8 и вернуть model dtype.
- `--speculative-algorithm` определяет, существует ли отдельный draft worker/pool и используется ли точный DFLASH budget.
- `--mem-fraction-static` и `--max-total-tokens` определяют, превратится ли освобождённая VRAM в дополнительную KV capacity.

## Типовые проблемы и диагностика

- `DFLASH fa4 draft: overriding KV cache dtype ...` — FA4 не может читать выбранный quantized KV; значение принято CLI, но эффективно заменено.
- OOM не изменился после перехода на FP8 — проверьте, что draft runner действительно создан и что `mem_fraction_static`/`max_total_tokens` не фиксируют прежний budget.
- Ошибка backend при первом draft forward — выбранный attention kernel не поддерживает FP8 KV; верните `auto`/`bf16` или смените draft attention backend.
- Эффективный dtype подтверждайте по строкам аллокации KV pool и info/warning из `configure_kv_cache_dtype`, а исходный флаг — по `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/target --speculative-algorithm DFLASH --speculative-draft-model-path /models/draft --speculative-draft-kv-cache-dtype fp8_e4m3 --mem-fraction-static 0.88
```

```bash
python -m sglang.launch_server --model-path /models/target --speculative-algorithm EAGLE --speculative-draft-model-path /models/draft --speculative-draft-kv-cache-dtype bf16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_dtype.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/spec_aux_hidden_state.py`
- `sglang/python/sglang/srt/speculative/dflash_utils.py`
