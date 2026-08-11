---
schema: 1
engine: sglang
primaryName: "--prefill-attention-backend"
title: "--prefill-attention-backend"
summary: Отдельный backend внимания для фазы prefill. Имеет приоритет над `--attention-backend`; вместе с несовпадающим decode-backend'ом включает экспериментальный `HybridAttnBackend` с двумя независимо инициализированными наборами ядер и буферов.
group: exec.kernel
related:
  - --attention-backend
  - --decode-attention-backend
  - --speculative-draft-attention-backend
  - --page-size
  - --kv-cache-dtype
  - --disable-chunked-prefix-cache
  - --flashinfer-mla-disable-ragged
  - --prefill-only-disable-kv-cache
  - --chunked-prefill-size
---

# --prefill-attention-backend

## Кратко

`--prefill-attention-backend` задает ядра внимания только для extend/prefill-проходов. Он перекрывает `--attention-backend` для этой фазы, а если он совпадает с `--decode-attention-backend`, движок записывает это значение и в общее поле. Расхождение prefill и decode — это не «настройка», а отдельный режим работы: model runner строит `HybridAttnBackend`, инициализирует два backend'а целиком и печатает предупреждение о том, что режим экспериментальный.

## Оригинальная справка

```text
Choose the kernels for prefill attention layers (have priority over --attention-backend).
```

## Паспорт аргумента

- Флаги: `--prefill-attention-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения: тот же `ATTENTION_BACKEND_CHOICES`, что и у `--attention-backend` (`triton`, `torch_native`, `flex_attention`, `dsa`, `nsa`, `dsv4`, `compressed`, `cutlass_mla`, `fa3`, `fa4`, `flashinfer`, `flashmla`, `trtllm_mla`, `cutedsl_mla`, `tokenspeed_mla`, `trtllm_mha`, `dual_chunk_flash_attn`, `hpc_ops`, `aiter`, `wave`, `intel_amx`, `ascend`, `intel_xpu`), расширяемый out-of-tree платформами через `add_attention_backend_choices`
- Значение по умолчанию: `null` — фаза prefill наследует разрешенный `--attention-backend`
- Эффективное значение: `attention_backends_of` (`sglang/python/sglang/srt/arg_groups/overrides.py`) возвращает `prefill_attention_backend or attention_backend`. Само поле дописывается движком в двух случаях: `--device npu` пишет в него `ascend`, а `_cutedsl_prefill_backend_fill` подставляет `trtllm_mla`, если decode-backend — `cutedsl_mla`, а prefill не задан. Для DeepSeek V4 на NPU `_deepseek_v4_overrides` пишет `dsv4` в оба split-поля
- Где объявлен: `ServerArgs.prefill_attention_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; поле помечено `resolvable=True`
- Этап применения: разбор CLI → `__post_init__` (`_attention_backend_default` и вся цепочка проверок совместимости) → создание backend'а в model runner → forward фазы extend

## Что меняет в движке

Пара `(prefill, decode)` вычисляется в одном месте — `attention_backends_of`, и оттуда расходится по всем проверкам `__post_init__` (`_resolved_attention_backends`) и по `attention_backend_setup.py`.

- Если `prefill == decode` и prefill задан, `_attention_backend_default` записывает это значение в `attention_backend` — то есть два split-флага с одинаковым значением эквивалентны одному `--attention-backend`.
- Если задан только prefill, поле `attention_backend` все равно заполняется автоподбором `_get_default_attn_backend`, и decode получает именно его. То есть один split-флаг почти всегда означает гибридный режим, даже если вы этого не планировали.
- При разных значениях создается `HybridAttnBackend` (`sglang/python/sglang/srt/layers/attention/hybrid_attn_backend.py`): два полноценных backend'а конструируются отдельно, модельные обертки (гибридные GDN/Mamba/линейные слои) применяются один раз поверх пары. Лог: `Using hybrid attention backend for decode and prefill: decode_backend=…, prefill_backend=…` плюс `Warning: Attention backend specified by --attention-backend or default backend might be overridden. The feature of hybrid attention backend is experimental and unstable.`

### Проверки, которые смотрят именно на prefill-сторону

- `trtllm_mha` в prefill требует SM100; в decode список шире (SM90/SM100/SM120).
- `cutedsl_mla` в prefill запрещен: `CuteDSL MLA only supports decoding for now`.
- `intel_xpu` в prefill для MLA-модели — `ValueError` с прямой рекомендацией задать его только через `--decode-attention-backend`, а prefill оставить на `triton`.
- `--prefill-only-disable-kv-cache` требует, чтобы разрешенный prefill-backend был `fa3` или `fa4`.
- FP4 KV (`--kv-cache-dtype nvfp4`/`fp4_mx_block16`): если prefill — `fa4`, набор допустимых decode-backend'ов жестко ограничен (`cutlass_mla`/`flashinfer`/`trtllm_mla` для MLA, `triton`/`torch_native`/`flex_attention` для MHA); если prefill не `fa4` и отличается от decode, печатается предупреждение «Compatibility issues are unlikely, but may occur in rare edge cases».
- `_mla_backend_page_constraints` учитывает prefill-сторону для `cutedsl_mla`, `trtllm_mha` и `hpc_ops`, `_fa4_page_constraint` — для `fa4`.
- Chunked prefix cache проверяется по общему `attention_backend`, а не по prefill-полю: гибридная пара не расширяет список поддерживаемых backend'ов.

## Значения и формат

- Значение вне списка отвергает argparse. Все жесткие и мягкие отказы совпадают с описанными в справке `--attention-backend`, кроме перечисленных выше prefill-специфичных.
- `null` не означает «torch_native» или что-то нейтральное: это буквально «взять разрешенный `--attention-backend`».
- Мягкие подмены (`fa3` + `fp8_e5m2` → `triton`, `intel_amx`/`intel_xpu` fallback'и) написаны против поля `attention_backend`, а не против split-полей. Если вы задали `--prefill-attention-backend fa3`, подмена по fp8 до него не дойдет, и несовместимость всплывет позже.

## Когда использовать

- Когда prefill и decode упираются в разные вещи: например, prefill выгоднее гнать через ragged-ядро FlashInfer, а decode — через `trtllm_mla` на Blackwell. Это осмысленно только после замеров обеих фаз по отдельности.
- Когда decode-backend физически не умеет prefill (`cutedsl_mla`) — но там движок и сам подставит `trtllm_mla`.
- Не используйте, чтобы «просто задать backend» — для этого есть `--attention-backend`. Один split-флаг превращает конфигурацию в гибридную, с двойной инициализацией и экспериментальным кодом на пути.

## Влияние на производительность и память

- Гибридный режим удваивает объем backend-специфичных буферов: у каждого из двух backend'ов свои workspace, индексные буферы и (для Triton) персистентный fp32 `attn_logits`. Планируйте это в memory-draw инстанса arriero, иначе пул KV окажется меньше ожидаемого.
- Время старта растет: две инициализации, два набора JIT-компиляций, и захват CUDA graph выполняется для decode-стороны отдельно.
- Выигрыш возможен только на фазе prefill и только если выбранное ядро реально быстрее на ваших длинах; на коротких промптах разница тонет в накладных расходах планировщика.

## Взаимодействие с другими аргументами

- `--attention-backend`: перекрывается этим флагом для prefill; при совпадении с decode получает его значение.
- `--decode-attention-backend`: вторая половина пары; равенство значений отменяет гибридный режим.
- `--page-size`: привязки backend'ов проверяют и prefill-поле (`cutedsl_mla`, `trtllm_mha`, `hpc_ops`, `fa4`).
- `--kv-cache-dtype`: FP4-ветка `_handle_kv4_compatibility` разбирает пару prefill/decode отдельно.
- `--flashinfer-mla-disable-ragged`: влияет только на prefill-путь FlashInfer MLA.
- `--disable-chunked-prefix-cache`: гейт по общему backend'у.
- `--speculative-draft-attention-backend`: у draft-воркера split-полей нет, его backend один на все фазы.

## Типовые проблемы и диагностика

- **Симптом:** задан только `--prefill-attention-backend`, в логе появился hybrid-warning. **Причина:** decode взял значение автоподбора. **Решение:** задать оба split-флага или один `--attention-backend`.
- **Симптом:** `ValueError: intel_xpu backend is only supported on decode for MLA models …`. **Решение:** перенести значение в `--decode-attention-backend`.
- **Симптом:** `AssertionError: CuteDSL MLA only supports decoding for now`. **Решение:** убрать `cutedsl_mla` из prefill.
- **Симптом:** `AssertionError: KV4 FA4 MLA expects decode_attention_backend to be one of […]`. **Причина:** FP4 KV с prefill=`fa4` и несовместимым decode.
- **Проверка:** дамп `server_args=` при старте показывает оба split-поля и разрешенный `attention_backend`; строка про hybrid attention backend подтверждает, что пара действительно разная.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --prefill-attention-backend trtllm_mla --decode-attention-backend cutedsl_mla --page-size 64
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --prefill-attention-backend fa3 --decode-attention-backend triton
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/attention_backend_setup.py`
- `sglang/python/sglang/srt/layers/attention/hybrid_attn_backend.py`
- `sglang/python/sglang/srt/layers/attention/attention_registry.py`
- `sglang/docs/docs/advanced_features/attention_backend.mdx`
