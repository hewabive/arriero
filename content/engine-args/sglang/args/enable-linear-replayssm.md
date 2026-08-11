---
schema: 1
engine: sglang
primaryName: "--enable-linear-replayssm"
title: "--enable-linear-replayssm"
summary: Буферизованный decode-путь линейного внимания: вместо записи полного состояния в HBM каждый шаг ядро копит записи в кольце длины L и сбрасывает состояние раз в L шагов. Дает 1.2–1.5× на GDN при батче от 64 и замедляет KDA.
group: exec.mamba
related:
  - --linear-replayssm-cache-len
  - --enable-linear-replayssm-spec
  - --enable-gdn-replayssm-spec
  - --linear-attn-decode-backend
  - --linear-attn-backend
  - --mamba-radix-cache-strategy
  - --mamba-track-interval
  - --disaggregation-mode
  - --max-mamba-cache-size
  - --mamba-ssm-dtype
  - --mem-fraction-static
---

# --enable-linear-replayssm

## Кратко

Обычный decode линейного внимания на каждом токене читает и записывает полное рекуррентное состояние слота — а это мегабайты на слой. ReplaySSM меняет схему: ядро пишет в кольцевой буфер компактные записи (`d`, `k`, `g`) и полное состояние сбрасывает в HBM только раз в `--linear-replayssm-cache-len` шагов, восстанавливая выход из кольца. Выигрыш — на пропускной способности памяти, поэтому он проявляется на больших батчах: в справке заявлено 1.2–1.5× при батче от 64 для GDN (скалярный гейт). Для KDA то же ядро численно корректно, но **медленнее** базового: покомпонентный гейт делает `g_cache` в K раз больше и требует пересворачивать затухание на каждом шаге.

Отдельно стоит помнить о памяти: кольцо выделяется на каждый слот пула, но в бюджетном решении `_handle_max_mamba_cache` оно **не учитывается** — учитывается только кольцо спекулятивного варианта. Пул состояний в итоге занимает больше, чем заложено в расчет KV-пула.

## Оригинальная справка

```text
Enable the ReplaySSM buffered output-only linear-attn decode kernel. Primarily a GDN (scalar-gate) decode-bandwidth optimization (~1.2-1.5x at batch >= 64). The unified kernel also supports KDA (per-K gate) and is numerically correct, but KDA decode is SLOWER than the packed baseline (the per-K g_cache is K x larger and the reconstruction refolds the per-K decay every step), so it is not recommended for KDA models. Requires the Triton linear-attn decode backend and --mamba-radix-cache-strategy no_buffer (the default).
```

## Паспорт аргумента

- Флаги: `--enable-linear-replayssm`
- Группа: `exec.mamba`
- Тип значения: bool (флаг без значения)
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; движок его не включает сам
- Где объявлен: `ServerArgs.enable_linear_replayssm`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но явно экспериментальный по формулировке справки и по числу оговорок в коде (часть путей помечена как follow-up)
- Этап применения: `__post_init__` (`_handle_linear_attn_backend` — четыре проверки) → аллокация `MambaPool` (кольцевые буферы + курсоры) → каждый decode-шаг линейных слоев

## Что меняет в движке

### Буферы

`MambaPool` (`sglang/python/sglang/srt/mem_cache/memory_pool.py`) при включенном флаге добавляет к каждому слоту:

```text
replayssm_d: [layers, slots, HV, L, V]   в типе SSM-состояния
replayssm_k: [layers, slots, H,  L, K]   в типе SSM-состояния
replayssm_g: [layers, slots, HV, L]      fp32 (GDN, скалярный гейт)
             [layers, slots, HV, L, K]   fp32 (KDA, покомпонентный гейт)
```

плюс общий курсор `replayssm_write_pos` длины `slots`. Численно на Qwen3-Next-80B-A3B (36 линейных слоев, `HV=32`, `H=16`, `V=K=128`, tp=1) при `L=16`: 13.57 MiB на слот с `--mamba-ssm-dtype float32` и 6.82 MiB с `bfloat16` — то есть +18 % к самому состоянию.

### Курсор и сбросы

Курсор ведет `HybridLinearAttnBackend` один раз на forward для всех слоев: снимает текущее значение, отдает ядрам и продвигает по модулю `L`. Сброс полного состояния происходит в двух случаях: естественный, когда `write_pos == L - 1`, и принудительный, когда для GDN `seq_len % mamba_track_interval == 0` — так снимок для radix-кеша всегда видит актуальное состояние. У KDA принудительного сброса нет (нет координации с radix), только естественный.

### Проверки на старте

1. decode-backend линейного внимания должен быть `triton`;
2. стратегия кеша не должна быть `extra_buffer`/`extra_buffer_lazy` — путь донорства ping-pong-слота не сбрасывает курсор кольца;
3. `--disaggregation-mode` должен быть `null` — decode-пул PD не подключен к кольцу;
4. `--linear-replayssm-cache-len` не меньше 1;
5. флаг взаимно исключен с `--enable-linear-replayssm-spec` (они делят одно хранилище, но продвигают курсор по разным протоколам).

Radix-кеш при этом поддерживается (принудительный сброс на границе трека и сброс курсора при копировании в слот), и CUDA graph тоже — буферы курсора статические.

## Значения и формат

- Флаг без значения; парной формы нет.
- Применим только к гибридам с линейным вниманием: GDN (Qwen3-Next и семейство) и KDA (Kimi Linear, Kimi K3). На mamba2-моделях и на моделях без линейных слоев ничего не делает.
- Стратегия `no_buffer` — это значение по умолчанию для большинства конфигураций, но не для всех: `auto` выбирает `extra_buffer`, если включен overlap-планировщик и архитектура его поддерживает. То есть, включив ReplaySSM, вы почти наверняка одновременно уходите в `no_buffer` со всеми его последствиями (`--page-size 1`, overlap выключен).

## Когда использовать

- На GDN-модели с устойчиво большим decode-батчем (от 64 одновременных запросов) и достаточным запасом VRAM под кольцо.
- Когда профилирование показывает, что decode упирается в HBM, а не в вычисления: у линейных слоев это типично при большом батче.
- Не включать на KDA-моделях: в собственной справке аргумента прямо сказано, что там он медленнее базового пути.
- Не включать на маленьких батчах: выигрыш пропорционален числу слотов, обрабатываемых за шаг, а кольцо занимает память всегда.
- Не включать под PD-disaggregation и вместе со спекулятивным вариантом ReplaySSM — старт откажет.

## Влияние на производительность и память

- VRAM: **прибавка, не учтенная в бюджете**. `(N + 1) × размер кольца` поверх пула состояний, где N — `--max-mamba-cache-size`. Планируя память, вычитайте это вручную либо понижайте `--mem-fraction-static`.
- RAM хоста: не влияет.
- Время старта: дополнительные аллокации и еще одна компиляция Triton-ядра (кольцевой вариант) при первом decode.
- Throughput decode: заявленные 1.2–1.5× на GDN при батче от 64.
- Latency: на шагах сброса шаг чуть дороже (полная запись состояния), на остальных — дешевле. Средняя latency падает, дисперсия растет.
- Точность: кольцевой decode на GDN численно эквивалентен базовому пути в пределах типа состояния; отдельного дрейфа он не вносит (в отличие от спекулятивного варианта, где тип принудительно поднимается до fp32).

## Взаимодействие с другими аргументами

- `--linear-replayssm-cache-len`: длина кольца L; линейно определяет и память, и частоту сбросов.
- `--linear-attn-decode-backend`: обязателен `triton` (в том числе унаследованный из `--linear-attn-backend`).
- `--mamba-radix-cache-strategy`: обязателен `no_buffer`; `extra_buffer` отвергается.
- `--mamba-track-interval`: задает ритм принудительных сбросов для GDN.
- `--disaggregation-mode`: любое значение кроме `null` отвергается.
- `--enable-linear-replayssm-spec`: взаимно исключающая пара.
- `--max-mamba-cache-size` / `--mem-fraction-static`: планирование памяти с учетом неучтенного кольца.
- `--mamba-ssm-dtype`: тип записей кольца в decode-режиме совпадает с типом состояния, поэтому `bfloat16` уменьшает кольцо вдвое.

## Типовые проблемы и диагностика

- `ValueError: --enable-linear-replayssm requires the Triton linear-attn decode backend, got 'flashinfer'.`
- `ValueError: --enable-linear-replayssm requires --mamba-radix-cache-strategy no_buffer (the default); the extra_buffer ping-pong donation path is not yet supported (follow-up). Got --mamba-radix-cache-strategy='extra_buffer'.`
- `ValueError: --enable-linear-replayssm is not supported under PD disaggregation yet (follow-up). Got --disaggregation-mode='decode'.`
- `ValueError: --enable-linear-replayssm-spec and --enable-linear-replayssm are mutually exclusive …`
- CUDA OOM вскоре после старта при формально корректном бюджете — кольцо не входит в расчет `max_mamba_cache_size`; уменьшите `--linear-replayssm-cache-len` или `--mem-fraction-static`.
- Что смотреть в логе: `GDN ReplaySSM ring buffers allocated (record_len=…, fold=False): d=…GB, k=…GB, g=…GB` — там точный объем колец, и `Mamba Cache is allocated. max_mamba_cache_size: …` строкой выше для сравнения.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --enable-linear-replayssm --mamba-radix-cache-strategy no_buffer --page-size 1 --disable-overlap-schedule
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --enable-linear-replayssm --linear-replayssm-cache-len 8 --mamba-ssm-dtype bfloat16 --mem-fraction-static 0.8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/layers/attention/hybrid_linear_attn_backend.py`
- `sglang/python/sglang/srt/layers/attention/linear/gdn_backend.py`
- `sglang/python/sglang/srt/configs/mamba_utils.py`
