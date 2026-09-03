---
schema: 1
engine: sglang
primaryName: "--enable-tp-lm-head-all-to-all"
title: "--enable-tp-lm-head-all-to-all"
summary: На DP-attention decode-узле заменяет TP all-gather полных logits и последующий DP scatter одним all-to-all обменом нужными строками. Автовключение действует только для чистой DP-конфигурации decode-only; есть явный `--no-*` opt-out.
group: parallel
related:
  - --enable-dp-attention
  - --enable-dp-lm-head
  - --tp-size
  - --dp-size
  - --attn-cp-size
  - --disaggregation-mode
---

# --enable-tp-lm-head-all-to-all

## Кратко

При TP-sharded LM head каждый rank сначала получает свой vocab shard logits. Обычный DP-attention путь делает TP all-gather полного vocab для всех строк, затем оставляет локальные DP-строки. Этот флаг меняет коллектив: каждый rank сразу обменивается только блоком строк, принадлежащим получателю, через `all_to_all_single`, после чего shards собираются вдоль vocab.

## Оригинальная справка

```text
Use all-to-all instead of TP all-gather followed by DP scatter for the TP-sharded LM head under DP attention. By default this is enabled only on decode-only PD nodes with pure DP attention (tp_size == dp_size > 1 and attn_cp_size == 1), and disabled on prefill-only and colocated nodes. Pass --no-enable-tp-lm-head-all-to-all to opt out. The path is incompatible with --enable-dp-lm-head; batches without an equal padded row count fall back to the existing all-gather path.
```

## Паспорт аргумента

- Флаги: `--enable-tp-lm-head-all-to-all`, `--no-enable-tp-lm-head-all-to-all`
- Группа: `parallel`
- Тип значения: optional bool (`argparse.BooleanOptionalAction`)
- Декларативное значение по умолчанию: `null`
- Где объявлен: `ServerArgs.enable_tp_lm_head_all_to_all`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: post-process аргументов → prewarm PyNCCL → каждый LM-head forward

## Что меняет в движке

При `null` post-process включает путь, только если узел имеет `--disaggregation-mode decode`, DP attention включен, `dp_size > 1`, `tp_size == dp_size`, `attn_cp_size == 1` и DP LM head выключен. На prefill-only и colocated сервере остается `false`.

Даже при эффективном `true` `LogitsProcessor` использует all-to-all лишь для реально TP-sharded LM head и одинакового числа padded rows у всех участников. Tied/replicated embeddings и неравные eager-batch counts автоматически возвращаются на прежний all-gather + scatter, чтобы все rank'и выбрали один коллектив.

## Значения и формат

- Не задан — условный default по топологии и роли PD-узла.
- `--enable-tp-lm-head-all-to-all` — принудительно запросить путь; несовместимая конфигурация отклоняется post-process assert'ом.
- `--no-enable-tp-lm-head-all-to-all` — надежно оставить старый all-gather путь даже на подходящем decode-узле.

## Когда использовать

Оставляйте auto на обычном pure-DP decode-узле. Явно включайте для контролируемого A/B-теста коммуникации; явно отключайте при проблемах PyNCCL/all-to-all или если коллектив медленнее на конкретной межсоединительной топологии.

## Влияние на производительность и память

Путь уменьшает передаваемые/временно собираемые logits для локальных DP-строк и на decode может снизить latency LM head. Выигрыш зависит от TP размера и сети. Коммуникатор prewarm'ится до измерения свободной GPU-памяти, поэтому его постоянные allocations учитываются при последующем sizing KV cache.

## Взаимодействие с другими аргументами

- Требуется `--enable-dp-attention`.
- `--enable-dp-lm-head` несовместим: тот использует другой, DP-sharded LM head.
- Требуются `--tp-size == --dp-size` и `--attn-cp-size 1`.
- Автовключение ограничено `--disaggregation-mode decode`; явное включение не снимает топологические проверки.

## Типовые проблемы и диагностика

- Assert `Please enable dp attention ...` — DP attention выключен.
- Assert про `tp_size == dp_size` или `attn_cp_size == 1` — топология не поддержана.
- Флаг принят, но профиль показывает all-gather — batch rows неравны либо LM head реплицирован; это штатный runtime fallback.
- Эффективное значение смотрите в разрешенном `server_args=`; транспорт prewarm'ится при старте CUDA worker'ов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --dp-size 8 --enable-dp-attention --disaggregation-mode decode --enable-tp-lm-head-all-to-all
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --dp-size 8 --enable-dp-attention --disaggregation-mode decode --no-enable-tp-lm-head-all-to-all
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/logits_processor.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`

