---
schema: 1
engine: sglang
primaryName: "--enable-linear-replayssm-spec"
title: "--enable-linear-replayssm-spec"
summary: Заменяет per-draft снимки полного состояния при спекулятивной сверке линейного внимания на окно сырых входов, которое переигрывается при коммите. Убирает доминирующий буфер спекуляции, но работает только на линейной цепочке черновиков.
group: exec.mamba
related:
  - --enable-linear-replayssm
  - --enable-gdn-replayssm-spec
  - --linear-replayssm-cache-len
  - --linear-attn-decode-backend
  - --linear-attn-verify-backend
  - --speculative-algorithm
  - --speculative-eagle-topk
  - --speculative-num-draft-tokens
  - --mamba-ssm-dtype
  - --disaggregation-mode
  - --max-mamba-cache-size
---

# --enable-linear-replayssm-spec

## Кратко

При спекулятивной сверке линейному вниманию нужно уметь откатиться к состоянию на границе принятого префикса. Базовый путь решает это в лоб: на каждый черновой токен сохраняется полный снимок SSM-состояния (`intermediate_ssm`), и это самый большой буфер всей спекуляции — в комментарии к коду упоминается порядка 9 ГиБ для Kimi K3 с DSpARK при γ=7. Флаг переводит сверку на схему «fold-every-commit»: verify пишет в окно сырые входы (`rawv`, `rawk`, `g`, `beta`), а коммит последовательно переигрывает принятый префикс через рекуррентное обновление. Снимки становятся не нужны и не выделяются вовсе.

Ограничение принципиальное: маска внутри окна строго нижнетреугольная, поэтому схема верна только для линейной цепочки черновиков (`--speculative-eagle-topk` не задан или равен 1, то есть NEXTN/MTP). Древовидная верификация EAGLE обязана остаться на рекуррентном пути.

## Оригинальная справка

```text
Enable the ReplaySSM spec-verify: fold-every-commit -- a per-slot raw-input window replaces the recurrent verify's per-draft full-state snapshots. GDN or KDA hybrid linear-attn models, linear-chain (--speculative-eagle-topk in {None, 1}) only.
```

## Паспорт аргумента

- Флаги: `--enable-linear-replayssm-spec`
- Группа: `exec.mamba`
- Тип значения: bool (флаг без значения)
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; побочно **переписывает** `--mamba-ssm-dtype` на `float32`, если тот не задан
- Где объявлен: `ServerArgs.enable_linear_replayssm_spec`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; устаревшее имя того же флага — `--enable-gdn-replayssm-spec` (переименован, когда механизм перестал быть специфичным для GDN)
- Этап применения: `__post_init__` (`_handle_linear_attn_backend` — шесть проверок и подстановка типа состояния) → аллокация `MambaPool` → каждый шаг target-verify и коммита

## Что меняет в движке

### Буферы вместо снимков

`MambaPool.SpeculativeState.intermediate_ssm` при включенном флаге равен `None`: verify-ядро вызывается с `intermediate_states_buffer=None`, per-step запись отключается. Вместо этого выделяются кольца сырых входов:

```text
replayssm_rawv:  [layers, slots, HV, record_len, V]  в conv/активационном типе
replayssm_rawk:  [layers, slots, H,  record_len, K]  в conv/активационном типе
replayssm_beta:  [layers, slots, HV, record_len]     fp32
replayssm_g:     [layers, slots, HV, record_len]     fp32 (GDN)
                 [layers, slots, HV, record_len, K]  fp32 (KDA)
```

`record_len` для GDN равен максимуму черновых токенов (`--speculative-num-draft-tokens`), для KDA — `--linear-replayssm-cache-len`. У KDA дополнительно остаются чанковые записи `d`/`k`: их отсутствие переключило бы decode на другой путь, а это отдельное изменение поведения. Окно свертки (`intermediate_conv_window`) сохраняется в обоих случаях — откат свертки его потребляет.

В отличие от decode-кольца (`--enable-linear-replayssm`) эта память **учитывается** в бюджетном решении: `_handle_max_mamba_cache` считает `replayssm_ring_bytes_per_req(record_len)` и добавляет его к цене слота.

### Проверки на старте

1. `--speculative-eagle-topk` только `None` или `1`;
2. decode-backend линейного внимания — `triton` или `flashinfer`;
3. при `SGLANG_RAGGED_VERIFY_MODE` отличном от `static` требуется алгоритм из семейства fold-every-commit (`DSPARK`/`DFLASH`) и пишущее кольцо verify-ядро (`--linear-attn-verify-backend triton` или `nv_cutedsl`);
4. запрещено на PD-сервере prefill (`--disaggregation-mode prefill`): кольцо — это scratch, существующий только ради сверки;
5. взаимно исключен с `--enable-linear-replayssm`;
6. тип состояния: при незаданном `--mamba-ssm-dtype` ставится `float32` с info-строкой в логе, при любом другом — warning о том, что закрытый пересчет каждый раз переквантует состояние и может дрейфовать на длинных последовательностях.

Для KDA дополнительно в аллокаторе пула проверяется, что `--linear-replayssm-cache-len` — степень двойки и не меньше `2 × speculative_num_draft_tokens` (запас на ранний сброс).

## Значения и формат

- Флаг без значения; парной формы нет.
- Без включенного спекулятивного декодирования смысла не имеет: кольцо выделится, а сверки не будет.
- Применим к GDN- и KDA-гибридам. На mamba2-моделях и моделях без линейного внимания не действует.
- Устаревший алиас `--enable-gdn-replayssm-spec` печатает предупреждение и транслируется в этот флаг; в новых конфигурациях используйте актуальное имя.

## Когда использовать

- Когда спекуляция на гибридной модели упирается в память: буфер снимков растет как `слоты × черновые_токены × размер_состояния` и на моделях уровня Kimi K3 занимает единицы-десятки гигабайт.
- Только с линейной цепочкой черновиков — NEXTN/MTP или EAGLE с `--speculative-eagle-topk 1`.
- Не включать одновременно с `--enable-linear-replayssm`: они делят одно хранилище кольца и продвигают курсор по несовместимым протоколам.
- Помнить о цене принудительного `float32`: если вы держали состояние в `bfloat16` ради емкости пула, включение флага без явного `--mamba-ssm-dtype` удвоит размер слота. Явно заданный `bfloat16` сохранится, но с предупреждением о дрейфе.

## Влияние на производительность и память

- VRAM: обычно крупная **экономия** — уходит доминирующий буфер `intermediate_ssm` (`слоты × draft_tokens × состояние`), приходит кольцо сырых входов (`слоты × record_len × (V + K + скаляры)`), которое существенно меньше. Обе величины учитываются в бюджетном решении, поэтому итог виден по `max_mamba_cache_size` в логе.
- RAM хоста: не влияет.
- Время старта: дополнительная компиляция ядер сверки и коммита.
- Latency: коммит последовательно переигрывает принятый префикс, то есть работа переносится со сверки на коммит. На линейной цепочке длина префикса ограничена окном черновиков, поэтому вклад невелик.
- Точность: при `float32` закрытый пересчет бит-в-бит совпадает с рекуррентной базой — в этом и смысл принудительной подстановки типа. При 16-битном состоянии каждое сворачивание переквантует состояние, и расхождение накапливается.

## Взаимодействие с другими аргументами

- `--enable-linear-replayssm`: взаимно исключающая пара.
- `--linear-replayssm-cache-len`: длина окна для KDA (степень двойки, не меньше `2 × --speculative-num-draft-tokens`); для GDN окно берется по максимуму черновых токенов.
- `--speculative-eagle-topk`: только `None` или `1`.
- `--speculative-num-draft-tokens`: задает `record_len` для GDN и нижнюю границу длины кольца для KDA.
- `--speculative-algorithm`: при не-статическом ragged-режиме обязателен `DSPARK` или `DFLASH`.
- `--linear-attn-decode-backend`: `triton` или `flashinfer`.
- `--linear-attn-verify-backend`: в ragged-режимах обязателен `triton` или `nv_cutedsl` (FlashInfer-ядро кольцо не пишет).
- `--mamba-ssm-dtype`: подставляется `float32` при незаданном значении.
- `--disaggregation-mode prefill`: запрещен.
- `--max-mamba-cache-size`: итоговое число слотов меняется, поскольку меняется цена слота.

## Типовые проблемы и диагностика

- `ValueError: --enable-linear-replayssm-spec requires a linear draft chain (--speculative-eagle-topk in {None, 1}); the chunked verify kernel uses a strictly-lower causal mask and is invalid for EAGLE tree verify.`
- `ValueError: --enable-linear-replayssm-spec requires the triton or flashinfer linear-attn decode backend, got 'cutedsl'.`
- `ValueError: --enable-linear-replayssm-spec is not supported on a PD prefill server …`
- `ValueError: spec-verify ring too small: 8 < 2 * 6 (early-flush margin)` или `spec-verify ring length must be a power of two, got 12` — обе проверки только для KDA, поднимайте `--linear-replayssm-cache-len`.
- В логе `--enable-linear-replayssm-spec: setting --mamba-ssm-dtype float32 …` — учтите удвоение размера слота относительно bf16.
- Warning `--enable-linear-replayssm-spec with --mamba-ssm-dtype=bfloat16: the closed-loop fold re-quantizes the committed state each commit/flush … Validate accuracy for your model.` — это не ошибка, но проверять качество придется вам.
- Что смотреть в логе: `GDN ReplaySSM ring buffers allocated (record_len=…, fold=True): … rawv=…GB, rawk=…GB, beta=…GB` и итоговый `max_mamba_cache_size`.

## Примеры

Флаг настраивает поведение спекулятивной сверки, поэтому эффект появляется только после того, как спекуляция сконфигурирована отдельно (`--speculative-algorithm` и сопутствующие аргументы своего алгоритма); сам по себе он запускается и просто меняет схему буферов.

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --enable-linear-replayssm-spec --speculative-eagle-topk 1
```

```bash
python -m sglang.launch_server --model-path /models/Kimi-Linear-48B-A3B-Instruct --enable-linear-replayssm-spec --linear-replayssm-cache-len 16 --mamba-ssm-dtype float32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/configs/mamba_utils.py`
- `sglang/python/sglang/srt/speculative/ragged_verify.py`
- `sglang/python/sglang/srt/layers/attention/linear/kda_backend.py`
