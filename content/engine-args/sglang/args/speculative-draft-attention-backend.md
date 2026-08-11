---
schema: 1
engine: sglang
primaryName: "--speculative-draft-attention-backend"
title: "--speculative-draft-attention-backend"
summary: Backend внимания для forward'ов draft-модели (draft decode и draft extend), отдельный от backend'ов целевой модели. В отличие от `--attention-backend`, список значений здесь argparse не проверяет — ошибка вылезет позже, и у разных алгоритмов по-разному.
group: spec
related:
  - --attention-backend
  - --decode-attention-backend
  - --prefill-attention-backend
  - --speculative-attention-mode
  - --speculative-algorithm
  - --speculative-draft-model-path
  - --page-size
  - --kv-cache-dtype
---

# --speculative-draft-attention-backend

## Кратко

Draft-воркер — отдельный `ModelRunner` со своим attention-backend'ом. По умолчанию он берёт backend целевой модели, и это не всегда правильно: у draft'а другая геометрия внимания (часто плотная MQA против MLA у target'а), и оптимальное ядро для него другое. Аргумент задаёт этот backend напрямую. Значение проверяется не argparse, а хуками конкретного алгоритма — от «молча заменю на flashinfer» до `ValueError` на инициализации.

## Оригинальная справка

```text
Attention backend for speculative decoding drafting.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-attention-backend`
- Группа: `spec`
- Тип значения: строка (`Optional[str]`)
- Допустимые значения: `choices: null` — в отличие от `--attention-backend`, поле объявлено без `choices`, и **argparse принимает любую строку**. Реальный набор имён — ключи реестра `ATTENTION_BACKENDS` (`layers/attention/attention_registry.py`), доступность каждого зависит от железа и установленных пакетов. Посмотреть на своей сборке: `python -c "import sglang.srt.layers.attention.attention_registry as r; print(sorted(r.ATTENTION_BACKENDS))"`
- Значение по умолчанию: `null` — берётся backend target'а
- Эффективное значение: `dsv4` вместо устаревшего `compressed` (`_handle_deprecated_args`); `trtllm_mha` для Kimi-K3 + DSPARK на SM100 при незаданном значении (`arg_groups/kimi_k3_hook.py`); для `DFLASH` значение **дорезолвливается на этапе разбора аргументов** и может быть молча заменено (см. ниже), после чего в `server_args` лежит уже итоговый backend
- Где объявлен: `ServerArgs.speculative_draft_attention_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (DFLASH-резолвинг, Kimi-K3-хук, deprecated-алиас) → создание draft-`ModelRunner` → инициализация draft-backend'ов (`DraftBackendFactory` или `build_draft_tp_worker`) → forward

## Что меняет в движке

Значение попадает в `ModelRunner.draft_attention_backend` только у draft-воркера (`resolve_draft_attention_backend` возвращает `None` для target'а), но путь к нему разный:

- **DFLASH.** `_resolve_dflash_draft_attention_backend` выполняется ещё в `handle_speculative_decoding`. Поддерживаются `flashinfer`, `fa3`, `fa4`, `triton`, `trtllm_mha`, `ascend`; всё остальное заменяется на `flashinfer` (на ROCm — `triton`) с предупреждением. `trtllm_mha` дополнительно требует, чтобы у draft'а все слои были sliding-attention либо чтобы он был явно causal, иначе тоже откат. Незаданное значение подставляется из backend'ов target'а.
- **DSPARK** (и вообще всё, что строится через `build_draft_tp_worker`). Тот же список поддерживаемых backend'ов и тот же откат, но уже на инициализации воркера. Для DeepSeek-V4-драфта backend жёстко переопределяется на `dsv4`.
- **EAGLE / EAGLE3 / STANDALONE.** Значение уходит в draft-runner как есть, а `DraftBackendFactory` ищет его в своих таблицах: для draft-decode (`create_decode_backend`, только при `speculative_num_steps > 1`) и для draft-extend (`create_draft_extend_backend`). Отсутствие имени в таблице — `ValueError: EAGLE is not supported in decode attention backend <x>`. Никакого молчаливого отката здесь нет.
- **FROZEN_KV_MTP.** При `topk == 1` используется обычный backend draft-runner'а, при `topk > 1` — только `triton` и `trtllm_mha`, остальное `ValueError`.

Кроме выбора ядра, значение участвует ещё в двух местах: `--page-size` принудительно приводится к 16/32/64/128, если draft-backend — `trtllm_mha`; а у DFLASH-драфта на `fa4` тип KV-кеша принудительно возвращается к compute-dtype (`fa4` не умеет читать квантованный KV target'а) с записью в лог.

## Значения и формат

- Одна строка-имя backend'а. Регистр важен, имена в реестре в нижнем регистре.
- Опечатка не отвергается argparse: для DFLASH/DSPARK она станет предупреждением и откатом на `flashinfer`, для EAGLE — падением на инициализации. То есть «сервер поднялся» не означает «мой backend применился».
- `compressed` — устаревший алиас `dsv4`, переписывается с предупреждением.
- `nsa` — устаревший алиас `dsa`.
- Не задавать = использовать backend target'а (для draft-extend — с оглядкой на `--speculative-attention-mode`, который выбирает между `--prefill-attention-backend` и `--decode-attention-backend`).

## Когда использовать

- Draft — плотная модель рядом с MLA-target'ом (типичный DSPARK/STANDALONE-случай): MLA-ядра для него не подходят, а `trtllm_mha` избавляет от блокирующего host-плана flashinfer на каждом шаге.
- Target работает на backend'е, которого нет в draft-таблицах (`flashmla`, `cutlass_mla`, `hpc_ops` и т. п.) и EAGLE падает с «is not supported in decode attention backend» — задайте draft'у `triton` или `flashinfer` явно.
- Не трогать, когда draft и target одной архитектуры (MTP-голова того же чекпоинта): наследование корректно и обычно оптимально.

## Влияние на производительность и память

- Время draft-шага — единственная величина, на которую аргумент влияет напрямую, и она вычитается из выигрыша спекуляции целиком: медленный draft-backend может обнулить весь выигрыш при неизменном `accept len`.
- VRAM: у backend'ов разные рабочие буферы и workspace (`flashinfer` резервирует свой), плюс отдельный набор CUDA graph'ов на draft-фазы.
- KV-память: косвенно — через принудительный `--page-size` при `trtllm_mha` и через возврат к compute-dtype KV у DFLASH+`fa4` (KV draft'а становится крупнее квантованного).

## Взаимодействие с другими аргументами

- `--attention-backend`, `--prefill-attention-backend`, `--decode-attention-backend`: источник значения по умолчанию.
- `--speculative-attention-mode`: определяет, какой из пары target-backend'ов достаётся draft-extend'у и target-verify, когда собственного draft-backend'а нет.
- `--speculative-algorithm`: от него зависит и список допустимых значений, и то, будет ли ошибка или тихий откат.
- `--page-size`: `trtllm_mha` в этой роли ограничивает страницу значениями 16/32/64/128.
- `--kv-cache-dtype`: `fa4`-draft у DFLASH отменяет квантованный KV для себя.
- `--speculative-num-steps`: при `steps <= 1` отдельный draft-decode-backend не создаётся вовсе, и значение влияет только на draft-extend.

## Типовые проблемы и диагностика

- `EAGLE is not supported in decode attention backend flashmla` — backend target'а не поддержан draft-путём; задайте `--speculative-draft-attention-backend triton`.
- `DFLASH draft worker only supports attention_backend in ('flashinfer', 'fa3', 'fa4', 'triton', 'trtllm_mha', 'ascend') for now, but got 'X'. Falling back to 'flashinfer'.` — ваше значение проигнорировано; сервер работает, но не так, как задумано.
- `DFLASH only enables 'trtllm_mha' when all layers use sliding attention or the draft is explicitly causal` — чекпоинт draft'а не подходит под это ядро.
- `Frozen-KV MTP topk > 1 currently supports triton and trtllm_mha attention backends, got X` — сузьте выбор или поставьте `--speculative-eagle-topk 1`.
- `TensorRT-LLM MHA only supports page_size of 16, 32, 64 or 128, changing page_size from N to 64` — побочный эффект выбора `trtllm_mha` для draft'а.
- Что смотреть: дамп `server_args=` (для DFLASH там уже итоговое значение), у DFLASH — строка `Initialized DFLASH draft runner. attention_backend=…`, у Kimi-K3 — `Kimi hybrid DSPARK: defaulting --speculative-draft-attention-backend to trtllm_mha`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B --speculative-draft-attention-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --attention-backend trtllm_mla --speculative-algorithm DSPARK --speculative-draft-model-path /models/DeepSeek-V3.2-DSpark-Draft --speculative-draft-attention-backend trtllm_mha --page-size 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/arg_groups/kimi_k3_hook.py`
- `sglang/python/sglang/srt/speculative/draft_worker_common.py`
- `sglang/python/sglang/srt/speculative/draft_utils.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_dtype.py`
- `sglang/python/sglang/srt/layers/attention/attention_registry.py`
- `sglang/docs/docs/advanced_features/attention_backend.mdx`
