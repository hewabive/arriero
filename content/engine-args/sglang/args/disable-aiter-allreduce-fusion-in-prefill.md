---
schema: 1
engine: sglang
primaryName: "--disable-aiter-allreduce-fusion-in-prefill"
title: "--disable-aiter-allreduce-fusion-in-prefill"
summary: Выключает ROCm aiter-фьюжен «all-reduce + residual + RMSNorm» только на prefill-батчах (EXTEND, MIXED, SPLIT_PREFILL) и оставляет его на decode. Без `--enable-aiter-allreduce-fusion` ничего не делает; для GLM-5 (`GlmMoeDsaForCausalLM`) на ROCm движок сам включает фьюжен и ставит этот флаг.
group: exec.comm
related:
  - --enable-aiter-allreduce-fusion
  - --disable-aiter-allreduce-fusion-in-decode
  - --enable-dp-attention
  - --nnodes
  - --tp-size
  - --enable-deterministic-inference
  - --attn-cp-size
  - --disable-custom-all-reduce
  - --flashinfer-allreduce-fusion-backend
---

# --disable-aiter-allreduce-fusion-in-prefill

## Кратко

`--enable-aiter-allreduce-fusion` сливает all-reduce выхода слоя, сложение с residual и RMSNorm в одно ядро aiter. Этот флаг оставляет слитый путь только для decode-батчей: на prefill работают обычный all-reduce и отдельные ядра нормализации.

Фаза определяется по `ForwardMode` батча. Prefill — это `EXTEND`, `MIXED` и `SPLIT_PREFILL`; все остальное (`DECODE`, `TARGET_VERIFY`, `DRAFT_EXTEND_V2`, `IDLE`, `DLLM_EXTEND`) считается decode. Аргумент новый (upstream PR #39790); в закрепленной паре `sglang-kt` его может не быть.

## Оригинальная справка

```text
Disable Aiter AllReduce Fusion for prefill batches (EXTEND / MIXED / SPLIT_PREFILL) while keeping it for decode. Only meaningful with --enable-aiter-allreduce-fusion.
```

## Паспорт аргумента

- Флаги: `--disable-aiter-allreduce-fusion-in-prefill`
- Группа: `exec.comm`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: поле помечено `resolvable=True`. Для `GlmMoeDsaForCausalLM` на HIP при выключенном DP attention и `--nnodes 1` `handle_model_specific_adjustments` (`arg_groups/model_hook.py`) объявляет `enable_aiter_allreduce_fusion=True` и `disable_aiter_allreduce_fusion_in_prefill=True`, не глядя на CLI: у этой модели на этом пути prefill-фьюжен выключен всегда. Других переопределений нет. Сочетание с `--enable-aiter-allreduce-fusion` не проверяется — без него флаг молча ни на что не влияет
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecComm.disable_aiter_allreduce_fusion_in_prefill`
- Статус: обычный, новый
- Этап применения: разбор CLI → пайплайн разрешения (`handle_model_specific_adjustments`) → каждый forward: предикат `apply_aiter_all_reduce_fusion` в `layers/layer_boundary/residual/add_norm.py`

## Что меняет в движке

Все решения о слитом пути проходят через один предикат:

```python
def aiter_all_reduce_fusion_enabled_for(forward_mode: ForwardMode) -> bool:
    comm = get_exec().comm
    if not comm.enable_aiter_allreduce_fusion:
        return False
    if forward_mode.is_extend_or_draft_extend_or_mixed():
        return not comm.disable_aiter_allreduce_fusion_in_prefill
    return not comm.disable_aiter_allreduce_fusion_in_decode
```

Его вызывает `apply_aiter_all_reduce_fusion(tensor, forward_batch)` вместе с остальными условиями слитого пути: `SGLANG_USE_AITER=1` на HIP, последняя размерность ≤ 16384, тензор не больше 64 МиБ, `tp_size != 6`, DP attention выключен. Предикат применяют:

- `layers/layer_boundary/fusions/allreduce.py` — `complete_attention_input` (сумма, оставленная предыдущим слоем, плюс residual и входная RMSNorm, при FP8-чекпойнте еще и per-group квантование) и `complete_ffn_input` (attention-TP all-reduce, residual и норма перед FFN);
- `layers/layer_boundary/exit.py` — решение, может ли FFN не делать собственный all-reduce и отложить сумму до слитого ядра следующего слоя.

На prefill-батче с поднятым флагом предикат ложен. FFN сводит выход обычным all-reduce (цепочка custom AR / quick-reduce / RCCL), residual и RMSNorm считаются отдельными ядрами. Decode-батчи продолжают идти слитым путем.

Сам `enable_aiter_allreduce_fusion` остается `True`. Поэтому все, что смотрит на главный флаг, ведет себя как при включенном фьюжене: ассерт `Aiter allreduce fusion is not supported with context parallelism`, сброс в детерминированном режиме, решение о custom AR для MiniMax-M3 на ROCm и страховочная ветка в `layers/layernorm.py`.

## Значения и формат

- Флаг без значения; парной `--no-…` формы нет.
- Вместе с `--disable-aiter-allreduce-fusion-in-decode` фьюжен выключен во всех фазах, но перечисленные выше побочные эффекты главного флага остаются.

## Когда использовать

- ROCm, `SGLANG_USE_AITER=1`, `--enable-aiter-allreduce-fusion`, и измерения показывают, что слитый путь ускоряет decode, но вредит TTFT или дает ошибки и расхождения на prefill.
- GLM-5 на ROCm: движок ставит флаг сам (лог `Enable Aiter AllReduce Fusion on decode phase for GlmMoeDsaForCausalLM`), задавать его вручную не нужно.
- На NVIDIA флаг бесполезен: без HIP и `SGLANG_USE_AITER=1` слитого пути нет. Аналог для CUDA — `--flashinfer-allreduce-fusion-backend`.
- arriero: ROCm не входит в квалифицированный профиль (`docs/KTRANSFORMERS_OPERATIONS.md`).

## Влияние на производительность и память

- **Prefill.** Возвращается обычная пара «all-reduce → нормализация»: на слой добавляется проход по HBM, зато не действуют ограничения слитого ядра. Прямой эффект — на TTFT.
- **Decode.** Без изменений.
- **VRAM.** Не меняется.
- **Точность.** На prefill порядок сложения совпадает с обычным путем, на decode — со слитым ядром.

## Взаимодействие с другими аргументами

- `--enable-aiter-allreduce-fusion`: без него флаг не действует.
- `--disable-aiter-allreduce-fusion-in-decode`: симметричный флаг для decode.
- `--enable-dp-attention`, `--nnodes`: при DP attention слитый путь не применяется вовсе; автоматическое включение для GLM-5 срабатывает только без DP attention и на одном узле.
- `--tp-size`: при 6 слитый путь исключен.
- `--enable-deterministic-inference`: сбрасывает главный флаг, и фазовые флаги теряют смысл.
- `--attn-cp-size`: ассерт смотрит на главный флаг, поэтому фазовый флаг его не обходит.
- `--disable-custom-all-reduce`: влияет на транспорт обычного all-reduce, который на prefill заменяет слитый путь.
- `--flashinfer-allreduce-fusion-backend`: CUDA-путь; проверяется в том же `or`, но на одной платформе истинным может быть только один.

## Типовые проблемы и диагностика

- **Что принято.** Дамп `server_args=` при старте: `disable_aiter_allreduce_fusion_in_prefill=True` вместе с `enable_aiter_allreduce_fusion=True`.
- **Флаг задан, а prefill не изменился.** Не задан `SGLANG_USE_AITER=1`, не включен главный флаг, работает DP attention или `tp_size == 6` — слитого пути не было и раньше.
- **GLM-5 на ROCm и prefill-фьюжен не включить.** Это автоматическое объявление движка для `GlmMoeDsaForCausalLM`; CLI-значение его не перекрывает.
- **Проверка фазы.** В профиле rocprof на prefill-шагах видны обычные all-reduce и отдельные ядра RMSNorm, на decode — слитое ядро aiter.

## Примеры

```bash
SGLANG_USE_AITER=1 python -m sglang.launch_server --model-path /models/Qwen3-32B --tp-size 4 --enable-aiter-allreduce-fusion --disable-aiter-allreduce-fusion-in-prefill
```

```bash
SGLANG_USE_AITER=1 python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --trust-remote-code --enable-aiter-allreduce-fusion --disable-aiter-allreduce-fusion-in-prefill
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
