---
schema: 1
engine: sglang
primaryName: "--disable-aiter-allreduce-fusion-in-decode"
title: "--disable-aiter-allreduce-fusion-in-decode"
summary: Выключает ROCm aiter-фьюжен «all-reduce + residual + RMSNorm» на decode-батчах (DECODE, TARGET_VERIFY, draft-extend, IDLE) и оставляет его на prefill. Без `--enable-aiter-allreduce-fusion` ничего не делает; для GLM-5 на ROCm это единственный CLI-способ полностью снять автоматически включенный фьюжен.
group: exec.comm
related:
  - --enable-aiter-allreduce-fusion
  - --disable-aiter-allreduce-fusion-in-prefill
  - --enable-dp-attention
  - --nnodes
  - --tp-size
  - --speculative-algorithm
  - --enable-deterministic-inference
  - --attn-cp-size
  - --flashinfer-allreduce-fusion-backend
---

# --disable-aiter-allreduce-fusion-in-decode

## Кратко

`--enable-aiter-allreduce-fusion` сливает all-reduce выхода слоя, сложение с residual и RMSNorm в одно ядро aiter. Этот флаг оставляет слитый путь только для prefill-батчей: на decode работают обычный all-reduce и отдельные ядра нормализации.

Фаза определяется по `ForwardMode` батча. Prefill — это `EXTEND`, `MIXED` и `SPLIT_PREFILL`; decode — все остальное: `DECODE`, `TARGET_VERIFY` (проверка спекулятивных токенов), `DRAFT_EXTEND_V2` (draft-extend спекулятивного декодирования), `IDLE`, а также `DLLM_EXTEND`. Аргумент новый (upstream PR #39790); в закрепленной паре `sglang-kt` его может не быть.

## Оригинальная справка

```text
Disable Aiter AllReduce Fusion for decode batches (DECODE / TARGET_VERIFY / draft-extend / IDLE) while keeping it for prefill. Only meaningful with --enable-aiter-allreduce-fusion.
```

## Паспорт аргумента

- Флаги: `--disable-aiter-allreduce-fusion-in-decode`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: пайплайн разрешения этот флаг не переписывает (поле помечено `resolvable=True`, но объявлений для него в checkout нет). Сочетание с `--enable-aiter-allreduce-fusion` не проверяется — без него флаг молча ни на что не влияет
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecComm.disable_aiter_allreduce_fusion_in_decode`
- Статус: обычный, новый
- Этап применения: разбор CLI → каждый forward: предикат `apply_aiter_all_reduce_fusion` в `layers/layer_boundary/residual/add_norm.py`

## Что меняет в движке

Решения о слитом пути проходят через предикат `aiter_all_reduce_fusion_enabled_for(forward_mode)`. Он возвращает `False`, если главный флаг выключен, а иначе для prefill-режимов смотрит на `disable_aiter_allreduce_fusion_in_prefill`, для всех остальных — на этот флаг. Предикат входит в `apply_aiter_all_reduce_fusion(tensor, forward_batch)` вместе с остальными условиями слитого пути: `SGLANG_USE_AITER=1` на HIP, последняя размерность ≤ 16384, тензор не больше 64 МиБ, `tp_size != 6`, DP attention выключен.

Применяют предикат:

- `layers/layer_boundary/fusions/allreduce.py` — `complete_attention_input` и `complete_ffn_input` (слитые all-reduce + residual + норма на входе внимания и FFN, при FP8-чекпойнте с per-group квантованием);
- `layers/layer_boundary/exit.py` — решение, может ли FFN отложить свой all-reduce до слитого ядра следующего слоя.

На decode-батче с поднятым флагом FFN сводит выход обычным all-reduce (custom AR / quick-reduce / RCCL), residual и RMSNorm считаются отдельно. Prefill-батчи идут слитым путем.

Главный `enable_aiter_allreduce_fusion` остается `True`. Ассерт для context parallel, сброс в детерминированном режиме, решение о custom AR для MiniMax-M3 на ROCm и страховочная ветка в `layers/layernorm.py` ведут себя как при включенном фьюжене.

### GLM-5 на ROCm

Для `GlmMoeDsaForCausalLM` на HIP при выключенном DP attention и `--nnodes 1` пайплайн сам объявляет `enable_aiter_allreduce_fusion=True` и `disable_aiter_allreduce_fusion_in_prefill=True` (лог `Enable Aiter AllReduce Fusion on decode phase for GlmMoeDsaForCausalLM`), не глядя на CLI. Отключить главный флаг из командной строки там нельзя. Если слитый путь мешает и на decode, `--disable-aiter-allreduce-fusion-in-decode` выключает его и в последней фазе, где он оставался. Другой путь — не задавать `SGLANG_USE_AITER=1`, но это выключает весь aiter, а не только фьюжен.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Вместе с `--disable-aiter-allreduce-fusion-in-prefill` фьюжен выключен во всех фазах; побочные эффекты главного флага остаются.

## Когда использовать

- ROCm, `SGLANG_USE_AITER=1`, `--enable-aiter-allreduce-fusion`, и на decode слитый путь дает регресс TPOT, ошибки или расхождения, а на prefill полезен.
- Спекулятивное декодирование: `TARGET_VERIFY` и draft-extend относятся к decode-фазе. Если проблемы возникают только на шагах verify, флаг убирает фьюжен и там.
- GLM-5 на ROCm, где нужно полностью снять автоматически включенный фьюжен (см. выше).
- На NVIDIA флаг бесполезен: аналог там — `--flashinfer-allreduce-fusion-backend`.
- arriero: ROCm не входит в квалифицированный профиль (`docs/KTRANSFORMERS_OPERATIONS.md`).

## Влияние на производительность и память

- **Decode.** Возвращается пара «all-reduce → нормализация»: плюс запуск ядра и проход по HBM на слой. Ради экономии именно на decode фьюжен и включают, поэтому ждите роста TPOT и измеряйте до и после.
- **Prefill.** Без изменений.
- **VRAM.** Не меняется.

## Взаимодействие с другими аргументами

- `--enable-aiter-allreduce-fusion`: без него флаг не действует.
- `--disable-aiter-allreduce-fusion-in-prefill`: симметричный флаг для prefill; на GLM-5/ROCm его ставит сам движок.
- `--enable-dp-attention`, `--nnodes`: при DP attention слитого пути нет; автоматическое включение для GLM-5 — только без DP attention и на одном узле.
- `--speculative-algorithm`: шаги verify и draft-extend считаются decode.
- `--tp-size`: при 6 слитый путь исключен.
- `--enable-deterministic-inference`: сбрасывает главный флаг.
- `--attn-cp-size`: ассерт для CP смотрит на главный флаг и фазовым флагом не обходится.
- `--flashinfer-allreduce-fusion-backend`: CUDA-путь в том же `or`.

## Типовые проблемы и диагностика

- **Что принято.** Дамп `server_args=` при старте: `disable_aiter_allreduce_fusion_in_decode=True` рядом с `enable_aiter_allreduce_fusion=True`.
- **Флаг задан, а decode не изменился.** Слитого пути не было: нет `SGLANG_USE_AITER=1`, главный флаг выключен, работает DP attention или `tp_size == 6`.
- **Проверка фазы.** В профиле rocprof на decode-шагах — обычные all-reduce и отдельные ядра RMSNorm.

## Примеры

```bash
SGLANG_USE_AITER=1 python -m sglang.launch_server --model-path /models/Qwen3-32B --tp-size 4 --enable-aiter-allreduce-fusion --disable-aiter-allreduce-fusion-in-decode
```

```bash
SGLANG_USE_AITER=1 python -m sglang.launch_server --model-path /models/GLM-5 --tp-size 8 --trust-remote-code --disable-aiter-allreduce-fusion-in-decode
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/model_hook.py`
- `sglang/python/sglang/srt/layers/layer_boundary/residual/add_norm.py`
- `sglang/python/sglang/srt/layers/layer_boundary/fusions/allreduce.py`
- `sglang/python/sglang/srt/layers/layer_boundary/exit.py`
- `sglang/python/sglang/srt/layers/layernorm.py`
- `sglang/python/sglang/srt/model_executor/forward_batch_info.py`
- `sglang/test/registered/ops/test_aiter_allreduce_fusion_amd.py`
- upstream PR #39790 «[ROCm] feat: enable aiter allreduce fusion for GLM models» (коммит `48c3854620` в checkout)
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
