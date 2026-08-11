---
schema: 1
engine: sglang
primaryName: "--linear-attn-backend"
title: "--linear-attn-backend"
summary: Базовый выбор ядер линейного внимания (GDN и KDA) для всех трех фаз сразу. Помимо скорости меняет и режим кеша: только `triton` разрешает стратегию `extra_buffer`, поэтому любое другое значение при `--mamba-radix-cache-strategy auto` выключает overlap-планировщик.
group: exec.mamba
related:
  - --linear-attn-prefill-backend
  - --linear-attn-decode-backend
  - --linear-attn-verify-backend
  - --mamba-ssm-dtype
  - --mamba-radix-cache-strategy
  - --disable-overlap-schedule
  - --enable-linear-replayssm
  - --enable-page-major-kv-layout
  - --mamba-backend
  - --attention-backend
---

# --linear-attn-backend

## Кратко

Гибридные модели с линейным вниманием считают свои «линейные» слои отдельными ядрами: gated delta net (Qwen3-Next, Qwen3.5, JetNemotron, InternS2, MiniCPM-V 4.6, BailingMoe V2.5) и KDA (Kimi Linear, Kimi K3). `--linear-attn-backend` — базовое значение для трех фаз: prefill/extend, decode и спекулятивная сверка. Каждую фазу можно переопределить отдельным флагом; этот задает то, что берется, когда переопределения нет.

Второй, менее очевидный эффект: предикат `supports_mamba_cache_extra_buffer` требует `--linear-attn-backend triton`. Смена базы на `cutedsl` или `flashinfer` выбивает архитектуру из числа поддерживающих `extra_buffer`, и стратегия `auto` уходит в `no_buffer`, а вместе с этим принудительно выключается overlap-планировщик. Это не ошибка и не предупреждение — просто другой режим работы кеша.

## Оригинальная справка

```text
The default kernel backend for linear attention (GDN/KDA). Can be overridden per-mode by --linear-attn-decode-backend and --linear-attn-prefill-backend.
```

## Паспорт аргумента

- Флаги: `--linear-attn-backend`
- Группа: `exec.mamba`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `triton`, `cutedsl`, `flashinfer`, `flashkda`, `nvidia_kda`, `ptx_kda` (константа `LINEAR_ATTN_KERNEL_BACKEND_CHOICES`; out-of-tree пакеты могут расширить список через `add_linear_attn_kernel_backend_choices`, поэтому итоговый набор смотрите в `--help` установленной сборки). Не всякое значение применимо к обеим семьям ядер — см. ниже
- Значение по умолчанию: `triton`
- Эффективное значение: само значение не переписывается, но производные могут: `--linear-attn-decode-backend` автоматически становится `flashinfer` на SM100+ при явном `--mamba-ssm-dtype bfloat16`, а унаследованный из базы `flashkda` в decode заменяется на `triton` с записью в лог
- Где объявлен: `ServerArgs.linear_attn_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_linear_attn_backend`) → создание backend'а внимания (`attention_registry.py`, `initialize_linear_attn_config`) → каждый forward линейных слоев

## Что меняет в движке

Значение раскладывается в три роли в `initialize_linear_attn_config` (`sglang/python/sglang/srt/layers/attention/linear/utils.py`):

```python
decode  = linear_attn_decode_backend  or base
prefill = linear_attn_prefill_backend or prefill_default or base
verify  = linear_attn_verify_backend  or (decode if decode == "flashinfer" else "triton")
```

Дальше конкретный диспетчер собирает ядра. Наборы допустимых значений у двух семей разные:

- **GDN** (`GDNKernelDispatcher`): decode — `triton`, `cutedsl`, `flashinfer`; prefill — `triton`, `cutedsl`, `flashinfer`. Все остальное дает `ValueError: Unsupported GDN decode backend: …` / `Unsupported GDN prefill backend: …`. Verify-ядро GDN **не** читает `--linear-attn-verify-backend`: оно берется как FlashInfer-ядро, если оно уже создано для decode или prefill и умеет target-verify, иначе Triton.
- **KDA** (`KDAKernelDispatcher`): decode — `triton`, `cutedsl`, `flashinfer`; prefill — `triton`, `flashkda`, `cutedsl`, `nvidia_kda`, `ptx_kda`; verify — `triton`, `nv_cutedsl`, `flashinfer`.

Несколько backend'ов деградируют к Triton с записью в лог, а не падают: `cutedsl` prefill вне SM100, `nvidia_kda` вне SM100, `ptx_kda` вне SM103 (GB300).

Модели с mamba2-слоями (NemotronH, FalconH1, GraniteMoeHybrid) идут другим путем и этот аргумент игнорируют — их ядро выбирается `--mamba-backend`. Short-conv-гибриды (LFM2, ZAYA1) и lightning attention (BailingHybrid) тоже имеют свои backend'ы.

## Значения и формат

- Значение вне списка отвергает argparse.
- `triton` — единственное значение, работающее на любой карте и в обеих семьях; оно же требуется для стратегии `extra_buffer` и для `--enable-linear-replayssm`.
- `flashinfer` в роли decode на SM100+ требует `--mamba-ssm-dtype bfloat16`, в роли prefill на SM100+ — CUDA 13+.
- `flashkda` — prefill-only ядро KDA. Заданное как база, оно применится к prefill, а decode тихо (с info-строкой) откатится на `triton`.
- `nvidia_kda` и `ptx_kda` — только prefill KDA, и только на SM100/SM103 соответственно; иначе Triton.
- `nv_cutedsl` в этом списке нет — он допустим только для `--linear-attn-verify-backend`.
- На модели без линейного внимания значение принимается и не используется.

## Когда использовать

- Оставить `triton`, если вы не разбирались с деталями: это единственная комбинация, гарантированно совместимая с `extra_buffer`, overlap-планировщиком и ReplaySSM.
- Задавать явно, когда вы воспроизводите чужой бенчмарк или подбираете ядро под конкретную карту, и при этом контролируете все три фазы отдельными флагами.
- Не менять базу «одним движением», если вас интересует только decode: используйте `--linear-attn-decode-backend`, иначе смена базы утянет за собой и prefill, и стратегию кеша.
- Не задавать `flashkda`/`nvidia_kda`/`ptx_kda` базой на GDN-модели: диспетчер GDN отвергает эти значения жесткой ошибкой.

## Влияние на производительность и память

- VRAM: сам выбор ядра пул состояний не меняет. Но косвенно меняет очень сильно: уход из `extra_buffer` в `no_buffer` снижает число слотов на запрос с 5 до 3, то есть повышает достижимую конкурентность при том же пуле — ценой overlap-планировщика.
- RAM хоста: не влияет.
- Время старта: `cutedsl` и FlashInfer-ядра компилируются JIT перед первым проходом; Triton — при первом вызове соответствующей фазы.
- Latency и throughput: это и есть цель аргумента. У decode-фазы линейного внимания на больших батчах узкое место — трафик состояния в HBM, и специализированные ядра выигрывают у Triton заметно.
- Спекуляция: у KDA выбор verify-ядра меняет и корректность режима (см. `--linear-attn-verify-backend`), не только скорость.

## Взаимодействие с другими аргументами

- `--linear-attn-decode-backend` / `--linear-attn-prefill-backend` / `--linear-attn-verify-backend`: имеют приоритет над базой, каждый в своей фазе.
- `--mamba-radix-cache-strategy`: `extra_buffer` требует базу `triton`; иначе `auto` выбирает `no_buffer` и выключает overlap.
- `--disable-overlap-schedule`: следствие предыдущего пункта.
- `--mamba-ssm-dtype`: `bfloat16` обязателен для FlashInfer decode/verify на SM100+, `float32` — тип по умолчанию.
- `--enable-linear-replayssm`: требует Triton именно в decode.
- `--enable-page-major-kv-layout`: сужает допустимые backend'ы до `triton`/`flashinfer` в decode и `triton`/`flashkda` в prefill (плюс `cutedsl` для MLA-гибридов вроде Kimi K3).
- `--attention-backend`: полноконтекстные слои той же гибридной модели; на Blackwell для GDN-моделей допустимы только `triton`, `trtllm_mha` и `fa4`/`flashinfer` — проверяется ассертом при создании backend'а.
- `--mamba-backend`: аналог этого аргумента для mamba2-семейства, области не пересекаются.

## Типовые проблемы и диагностика

- `ValueError: Unsupported GDN decode backend: LinearAttnKernelBackend.FLASHKDA` — KDA-ядро задано на GDN-модели.
- `ValueError: --linear-attn-decode-backend flashinfer on SM100+ requires --mamba-ssm-dtype bfloat16, got None` — база `flashinfer` унаследовалась в decode.
- `ValueError: --linear-attn-prefill-backend flashinfer on SM100+ requires CUDA 13+, got CUDA 12.8`
- `AssertionError: Only {'triton', 'trtllm_mha', 'fa4'} backends are supported on Blackwell GPUs for hybrid GDN models.` — это уже про `--attention-backend`, но всплывает в том же месте инициализации.
- Overlap-планировщик выключился «сам» после смены backend'а — сработала резолюция `auto` в `no_buffer`. Проверьте `mamba_radix_cache_strategy` и `disable_overlap_schedule` в дампе `server_args=`.
- Что смотреть в логе: строку `Linear attention kernel backend: decode=…, prefill=…, verify=…` (печатается с ранга 0) и следом `GDN kernel dispatcher: decode=… extend=… verify=… packed_decode=…` либо `KDA kernel dispatcher: …` — там уже классы реальных ядер, включая молчаливые откаты на Triton.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --linear-attn-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/Kimi-Linear-48B-A3B-Instruct --linear-attn-backend triton --linear-attn-prefill-backend flashkda
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/linear/utils.py`
- `sglang/python/sglang/srt/layers/attention/linear/gdn_backend.py`
- `sglang/python/sglang/srt/layers/attention/linear/kda_backend.py`
- `sglang/python/sglang/srt/layers/attention/attention_registry.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
