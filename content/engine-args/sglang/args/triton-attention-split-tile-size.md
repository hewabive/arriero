---
schema: 1
engine: sglang
primaryName: "--triton-attention-split-tile-size"
title: "--triton-attention-split-tile-size"
summary: Фиксирует размер KV-тайла в flash-decoding ядре Triton, делая разбиение независимым от длины батча — это то, что дает batch-invariant результаты. Заданное значение полностью перекрывает `--triton-attention-num-kv-splits`.
group: exec.kernel
related:
  - --attention-backend
  - --decode-attention-backend
  - --triton-attention-num-kv-splits
  - --enable-deterministic-inference
  - --context-length
  - --mem-fraction-static
---

# --triton-attention-split-tile-size

## Кратко

Обычно Triton-декод сам решает, на сколько кусков резать KV, исходя из длин запросов в текущем батче и загрузки SM. Из-за этого порядок редукции меняется от батча к батчу, и один и тот же запрос дает побитово разные логиты. `--triton-attention-split-tile-size` фиксирует ширину куска в токенах: число split'ов становится функцией только длины последовательности, а не состава батча. Это ручной аналог того, что включает `--enable-deterministic-inference`.

## Оригинальная справка

```text
The size of split KV tile in flash decoding Triton kernel. Used for deterministic inference.
```

## Паспорт аргумента

- Флаги: `--triton-attention-split-tile-size`
- Группа: `exec.kernel`
- Тип значения: целое (`Optional[int]`)
- Допустимые значения: `choices` нет; смысл имеют степени двойки в диапазоне сотен токенов (референс детерминированного режима — 256)
- Значение по умолчанию: `null` — динамическое планирование split'ов
- Эффективное значение: при `--enable-deterministic-inference` заданное здесь число **игнорируется**: `TritonAttnBackend.__init__` берет `SGLANG_TRITON_DECODE_SPLIT_TILE_SIZE` (по умолчанию 256) и одновременно выключает `static_kv_splits`
- Где объявлен: `ServerArgs.triton_attention_split_tile_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → конструктор `TritonAttnBackend` → расчет `max_kv_splits` и буферов → планирование split'ов на каждом decode-forward

## Что меняет в движке

В `sglang/python/sglang/srt/layers/attention/triton_backend.py`:

1. Значение попадает в `self.split_tile_size`. Если оно не `None`, `max_kv_splits` **пересчитывается**: `ceil(max_context_len / split_tile_size)`. Значение `--triton-attention-num-kv-splits` (и уже применённый к нему MLA-потолок) при этом теряет силу.
2. Ветка фиксированного разбиения в `get_num_kv_splits` работает по формуле `num_kv_splits[i] = ceil(seq_len[i] / split_tile_size)` — но только **вместе** с `enable_deterministic`. Условие в коде — `if self.split_tile_size is not None and self.enable_deterministic`.

Это ключевая деталь: **сам по себе, без `--enable-deterministic-inference`, флаг меняет только размер буферов и потолок split'ов, а раскладку по запросам по-прежнему считает динамический планировщик** `get_num_kv_splits_triton`. Детерминизм он в одиночку не дает. А когда детерминированный режим включен, значение флага заменяется переменной окружения. То есть штатный способ получить batch-invariant Triton-декод — это `--enable-deterministic-inference` (плюс при необходимости `SGLANG_TRITON_DECODE_SPLIT_TILE_SIZE`), а не этот аргумент.

## Значения и формат

- `null` (не задан) — обычный динамический режим.
- Маленький тайл (например 64) означает много split'ов: `ceil(context_len / 64)` при контексте 131072 — это 2048, и ровно во столько раз раздувается персистентный fp32-буфер `attn_logits`. Практически это гарантированный OOM.
- Большой тайл (1024 и выше) означает мало split'ов и недозагрузку GPU на длинном контексте.
- Значение не читается вообще, если декод обслуживает не `triton`.
- Ноль или отрицательное значение argparse примет, а деление в backend'е упадет. Не задавайте их.

## Когда использовать

- Когда вы уже работаете с `--enable-deterministic-inference` и хотите поменять ширину тайла — но менять ее нужно переменной `SGLANG_TRITON_DECODE_SPLIT_TILE_SIZE`, а не этим флагом.
- Когда нужно принудительно ограничить `max_kv_splits` производной от контекста величиной вместо потолка `_mla_decode_kv_splits_cap` — редкий случай отладки конкретного ядра.
- Не задавайте «для воспроизводимости» без детерминированного режима: раскладка split'ов останется динамической, а буферы вырастут.

## Влияние на производительность и память

- **VRAM.** Через пересчет `max_kv_splits` значение линейно и очень резко влияет на размер буферов `attn_logits` (fp32, `max_num_tokens × num_head × max_kv_splits × v_head_dim`) и `attn_lse`. Это самый быстрый способ случайно съесть несколько гигабайт VRAM на длинном контексте.
- **Latency.** Фиксированное разбиение хуже адаптивного по загрузке: на коротких запросах в большом батче оно создает лишние split'ы, на длинных — может их недобрать.
- **Точность.** Фиксированный порядок редукции — это ровно то, что делает результат независимым от состава батча.
- **Время старта.** Косвенно, через размер буферов, захватываемых в CUDA graph.

## Взаимодействие с другими аргументами

- `--triton-attention-num-kv-splits`: перекрывается этим флагом полностью.
- `--enable-deterministic-inference`: единственный режим, в котором фиксированное разбиение реально применяется к запросам, — и он же подменяет значение переменной окружения.
- `--attention-backend` / `--decode-attention-backend`: значение читает только Triton-backend.
- `--context-length`: входит в формулу `max_kv_splits` напрямую, поэтому эффект на память зависит от длины контекста, а не от реальных запросов.
- `--mem-fraction-static`: буферы конкурируют за ту же VRAM, что и KV-пул.

## Типовые проблемы и диагностика

- **Симптом:** OOM сразу после старта или на захвате CUDA graph. **Причина:** маленький тайл при большом `--context-length` дал огромный `max_kv_splits`. **Решение:** увеличить тайл или убрать флаг.
- **Симптом:** флаг задан, но результаты по-прежнему меняются от батча к батчу. **Причина:** не включен `--enable-deterministic-inference`. **Решение:** включить его.
- **Симптом:** флаг задан вместе с детерминированным режимом, а эффективный тайл другой. **Причина:** используется `SGLANG_TRITON_DECODE_SPLIT_TILE_SIZE` (256 по умолчанию).
- **Проверка:** дамп `server_args=` при старте показывает заданное значение, но не показывает вычисленный `max_kv_splits`; косвенно эффект виден по `graph_memory_usage` в логе захвата графов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --attention-backend triton --enable-deterministic-inference
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --attention-backend triton --triton-attention-split-tile-size 512 --context-length 32768
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/triton_backend.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/deterministic_inference.mdx`
