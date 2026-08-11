---
schema: 1
engine: sglang
primaryName: "--speculative-attention-mode"
title: "--speculative-attention-mode"
summary: Выбирает, каким из двух backend'ов внимания (prefill или decode) считаются спекулятивные фазы — target verify и draft extend. Имеет смысл только тогда, когда prefill- и decode-backend'ы реально различаются.
group: spec
related:
  - --speculative-algorithm
  - --attention-backend
  - --prefill-attention-backend
  - --decode-attention-backend
  - --speculative-draft-attention-backend
  - --speculative-num-draft-tokens
---

# --speculative-attention-mode

## Кратко

Спекулятивный verify — это forward фиксированной ширины `num_draft_tokens` на запрос: формально extend, по нагрузке ближе к decode. SGLang не угадывает, каким ядром его считать, а спрашивает этим флагом. `prefill` (по умолчанию) отправляет verify и draft-extend на prefill-backend, `decode` — на decode-backend. Ручка становится значимой ровно тогда, когда у вас разные backend'ы на prefill и decode: при одинаковых обе ветки ведут в одно и то же ядро.

## Оригинальная справка

```text
Attention backend for speculative decoding operations (both target verify and draft extend). Can be one of 'prefill' (default) or 'decode'.
```

## Паспорт аргумента

- Флаги: `--speculative-attention-mode`
- Группа: `spec`
- Тип значения: строка
- Допустимые значения: `prefill`, `decode` (`choices` из extract; argparse отвергает всё остальное)
- Значение по умолчанию: `prefill`
- Эффективное значение: поле помечено `resolvable=True`, то есть реестр модельных override'ов может его переписать. Сегодня это делает Kimi-K3: при `--dcp-size > 1` вместе с `DSPARK` режим принудительно становится `decode` (иначе verify уходит на `trtllm_mla`, у которого нет DCP-пути), и на SM100/SM103 — `decode`, если decode-backend способен обслужить verify при данном `q_len`
- Где объявлен: `ServerArgs.speculative_attention_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (модельные override'ы) → сборка `HybridAttnBackend` и draft-extend-backend'а → каждый forward фазы `target_verify` / `draft_extend`

## Что меняет в движке

Три независимых потребителя:

1. **`HybridAttnBackend._select_backend`.** Этот композитный backend создаётся только когда разрешённые prefill- и decode-backend'ы **различаются**. `decode_or_idle` всегда идёт на decode-backend, обычный prefill — на prefill-backend, а `target_verify` — туда, куда укажет режим. Он же определяет `needs_cpu_seq_lens`: при `prefill`-режиме к D2H-синхронизации на каждом шаге приводит уже prefill-backend, при `decode` — только decode-backend.
2. **`DraftBackendFactory.create_draft_extend_backend`.** Для EAGLE-семейства режим выбирает, из какого поля брать имя backend'а для draft-extend: `decode_attention_backend` или `prefill_attention_backend` (если у draft'а нет собственного `--speculative-draft-attention-backend`).
3. **Модели с собственным диспетчером внимания** (DeepSeek-V2/V3-семейство): в `forward` фазы `target_verify` и `draft_extend_v2` маршрутизируются по тому же правилу.

Если prefill- и decode-backend'ы совпадают (обычный случай, когда задан только `--attention-backend`), `HybridAttnBackend` не создаётся и обе ветки указывают на одно ядро — режим перестаёт что-либо менять, кроме выбора имени поля в draft-фабрике.

## Значения и формат

- Ровно две строки, регистр важен: `prefill`, `decode`.
- «Auto» нет: значение по умолчанию — это конкретный `prefill`, а не подбор.
- Значение не связано с `--speculative-draft-attention-backend`: если тот задан, он перебивает выбор для draft-runner'а целиком, а режим продолжает управлять target-verify.
- Ошибка в написании отвергается argparse со списком допустимых значений.

## Когда использовать

- У вас гибридная конфигурация внимания (`--prefill-attention-backend` ≠ `--decode-attention-backend`) и verify по профилю ближе к decode — типично при малом `--speculative-num-draft-tokens` и большом running batch.
- Prefill-backend требует host-плана (flashinfer и родственные) и вы видите per-step синхронизацию D2H на спекулятивных шагах: `decode` убирает её, если decode-backend умеет обслуживать verify при вашей ширине окна.
- Не трогать, когда backend один на обе фазы: результат ровно нулевой, а в конфигурации появляется лишняя ручка.
- Не ставить `decode` вслепую: не каждое decode-ядро принимает `q_len > 1`. Kimi-K3-хук именно поэтому проверяет пригодность backend'а перед тем, как переключить режим, и печатает предупреждение, если не может.

## Влияние на производительность и память

- Latency: главный эффект. Смена ядра меняет и время самого verify, и наличие блокирующей синхронизации `seq_lens` на каждом спекулятивном шаге.
- VRAM: косвенно — у разных backend'ов разные workspace-буферы; переключение режима само по себе новых аллокаций не добавляет.
- CUDA graph: verify-графы захватываются для выбранного ядра, так что смена режима меняет и то, что попадёт в графы на старте.
- На KV-пул и на throughput вне спекулятивных фаз влияния нет.

## Взаимодействие с другими аргументами

- `--prefill-attention-backend` / `--decode-attention-backend`: пара, между которой и происходит выбор. Если оба не заданы, оба разрешаются из `--attention-backend`, и режим становится безразличен.
- `--attention-backend`: общий fallback для обоих.
- `--speculative-draft-attention-backend`: перебивает выбор режима для draft-воркера (у него собственный backend на все фазы).
- `--speculative-algorithm`: без него режим не читается вообще.
- `--speculative-num-draft-tokens`: задаёт `q_len` verify-форварда; именно от него зависит, справится ли decode-ядро.

## Типовые проблемы и диагностика

- `TypeError: ... unexpected keyword argument 'causal_seqs'` и подобные падения внутри verify — ядро не поддерживает выбранный режим; это тот самый случай, ради которого Kimi-K3 принудительно ставит `decode`.
- Предупреждение вида `... decode attention backend X cannot serve target verify at q_len=N, so verify runs on the prefill backend (speculative_attention_mode=prefill). A host-plan prefill backend costs a per-step seq_lens D2H sync` — режим не переключился, и вы платите синхронизацией.
- Изменили режим — ничего не изменилось: скорее всего prefill и decode backend'ы одинаковы. Проверьте в дампе `server_args=` поля `attention_backend`, `prefill_attention_backend`, `decode_attention_backend`.
- Что смотреть: `server_args=` (поле `speculative_attention_mode`, уже с учётом модельных override'ов) и информационные строки Kimi-K3-хука.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2-Exp --prefill-attention-backend trtllm_mla --decode-attention-backend cutedsl_mla --speculative-algorithm EAGLE --speculative-attention-mode decode
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B --speculative-attention-mode prefill --speculative-num-draft-tokens 8 --speculative-num-steps 5 --speculative-eagle-topk 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/hybrid_attn_backend.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/attention_backend_setup.py`
- `sglang/python/sglang/srt/speculative/draft_utils.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/models/deepseek_v2.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
