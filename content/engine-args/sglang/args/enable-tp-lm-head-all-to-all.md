---
schema: 1
engine: sglang
primaryName: "--enable-tp-lm-head-all-to-all"
title: "--enable-tp-lm-head-all-to-all"
summary: Заменяет для TP-шардированной `lm_head` под DP-attention связку «all-gather по TP + scatter по DP» на один all-to-all, сокращая объем коллектива примерно в `tp_size` раз. По умолчанию не задан — движок сам включает его только на decode-узлах PD-разнесения с чистым DP-attention.
group: parallel
related:
  - --enable-dp-lm-head
  - --enable-dp-attention
  - --tp-size
  - --dp-size
  - --attn-cp-size
  - --disaggregation-mode
---

# --enable-tp-lm-head-all-to-all

## Кратко

Под DP-attention с TP-шардированной головой словаря каждый ранг после `lm_head` держит `[global_rows, vocab/tp]` — свой словарный шард для токенов всех DP-групп. Классический путь собирает полный словарь через all-gather по всей TP-группе, а затем каждый DP-ранг вырезает свои строки (scatter): почти весь принятый трафик тут же выбрасывается. `--enable-tp-lm-head-all-to-all` заменяет эту пару на один `all_to_all_single`: каждый ранг обменивается только блоками `[local_rows, vocab/tp]` и сразу получает полные логиты своих токенов. Объем коммуникации на ранг падает с ~`global_rows × vocab` до ~`local_rows × vocab`, то есть примерно в `tp_size` раз. Флаг новый (commit `fcdaaf8a5d`, август 2026) и трехзначный: не задан — движок решает по роли узла, `--enable-…` — принудительно включить, `--no-enable-…` — принудительно выключить.

## Оригинальная справка

```text
Use all-to-all instead of TP all-gather followed by DP scatter for the TP-sharded LM head under DP attention. By default this is enabled only on decode-only PD nodes with pure DP attention (tp_size == dp_size > 1 and attn_cp_size == 1), and disabled on prefill-only and colocated nodes. Pass --no-enable-tp-lm-head-all-to-all to opt out. The path is incompatible with --enable-dp-lm-head; batches without an equal padded row count fall back to the existing all-gather path.
```

## Паспорт аргумента

- Флаги: `--enable-tp-lm-head-all-to-all` / парный `--no-enable-tp-lm-head-all-to-all` (`argparse.BooleanOptionalAction`)
- Группа: `parallel`
- Тип значения: `Optional[bool]` — три состояния: не задан (`None`) / включен / выключен
- Значение по умолчанию: `None` — «не задан», решение принимает post-process `_tp_lm_head_all_to_all_default` в `arg_groups/overrides.py`
- Эффективное значение при `None`: `True` только когда одновременно `--disaggregation-mode decode`, включен `--enable-dp-attention`, `dp_size > 1`, `tp_size == dp_size`, `attn_cp_size == 1` и `--enable-dp-lm-head` не задан; во всех прочих конфигурациях (prefill-узел, colocated-узел, смешанный TP/DP, context parallel) — `False`. Явное значение из CLI всегда побеждает
- Где объявлен: `ServerArgs.enable_tp_lm_head_all_to_all`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: новый — добавлен upstream-коммитом `fcdaaf8a5d` «[Feature] Optimize TP LMHead with All-to-All (#32313)» от 2026-08-18; в закрепленной паре пакетов `sglang-kt` его может еще не быть — проверяйте `python -m sglang.launch_server --help | grep tp-lm-head` в своем окружении или каталог аргументов arriero, построенный из `--help` установленного движка
- Этап применения: разбор CLI → post-process `_tp_lm_head_all_to_all_default` и валидация `_dp_lm_head_validation` (`__post_init__`) → инициализация torch distributed (прогрев PyNCCL P2P в `distributed/bootstrap.py`) → конструктор `LogitsProcessor` → каждый шаг сэмплирования

## Что меняет в движке

Значение публикуется в `ParallelState` и читается в двух местах:

1. `layers/logits_processor.py`: конструктор запоминает `self.use_tp_lm_head_all_to_all`. В `_get_logits`, там где раньше безусловно шел all-gather логитов по TP-группе с последующим `_scatter_dp_attn_logits`, появляется ветка: если `_can_use_tp_lm_head_all_to_all(...)` — выполняется `get_tp_group().all_to_all_single(...)`, результат пересобирается из «source-major» раскладки (`tp_size` блоков `[local_rows, vocab_shard]` по dim 0) в строчную `[local_rows, tp_size × vocab_shard]` (`_reassemble_tp_lm_head_all_to_all_output`), и scatter-шаг пропускается целиком.
2. `distributed/bootstrap.py`: при включенном флаге и `tp_size > 1` на CUDA выполняется стартовый прогрев `_prewarm_tp_lm_head_all_to_all` — обмен буферами по 4 MiB на пира через PyNCCL, чтобы транспортные P2P-ресурсы NCCL были выделены **до** замера `pre_model_load_memory` и учлись в расчете размера KV-пула, а не всплыли во время захвата CUDA graph. Если PyNCCL-коммуникатор недоступен, старт падает с `RuntimeError`.

Ветка all-to-all включается только внутри общей ветки `do_tensor_parallel_all_gather` и только когда не активен `use_attn_tp_group` (то есть `--enable-dp-lm-head`); проверка `_can_use_tp_lm_head_all_to_all` дополнительно требует, чтобы `lm_head` был реально шардирован на весь глобальный `tp_size` (tied embeddings, реплицированные по DP-рангам с `tp_size=1`, отправляются в старый путь), чтобы у всех рангов был **одинаковый** padded-размер батча (decode под CUDA graph — всегда; eager — только если все глобальные счетчики токенов равны) и чтобы `local_rows > 0`. Любое нарушение — тихий fallback в существующий all-gather + scatter, без ошибки.

## Значения и формат

- Не задан (`None`): движок включает путь только на decode-узле PD-разнесения с чистым DP-attention (`tp_size == dp_size > 1`, `attn_cp_size == 1`, без `--enable-dp-lm-head`); prefill-узлы и colocated-узлы остаются на старом пути — раскладка весов `lm_head` фиксируется при загрузке, и включение TP-пути увело бы их длинные prefill'ы с бескоммуникационной DP-головы.
- `--enable-tp-lm-head-all-to-all`: принудительное включение; валидация требует `--enable-dp-attention`, `tp_size == dp_size`, `attn_cp_size == 1` и отсутствие `--enable-dp-lm-head` — иначе `AssertionError` на старте.
- `--no-enable-tp-lm-head-all-to-all`: принудительное выключение, в том числе на decode-узле, где движок включил бы его сам.

## Когда использовать

- Обычно не трогать: дефолтная логика уже включает путь ровно там, где он выигрывает — decode-узел PD-разнесения с чистым DP-attention и большим словарем (DeepSeek-класс: `vocab_size` ~129k).
- Явно включать имеет смысл на colocated-узле с `tp_size == dp_size > 1`, если профилирование показывает, что экономия на decode-коллективе перевешивает эффект на prefill.
- `--no-enable-tp-lm-head-all-to-all` — аварийный откат на проверенный all-gather-путь без смены остальной конфигурации (например, при проблемах с PyNCCL на конкретной сборке).
- Бессмысленно без DP-attention и при `tp_size != dp_size` — такие комбинации либо отклоняются валидацией (при явном включении), либо дефолт сам остается `False`.

## Влияние на производительность и память

- **Latency decode.** Основной эффект: объем коллектива на шаг сэмплирования падает примерно в `tp_size` раз (all-to-all обменивает `local_rows × vocab` на ранг вместо all-gather на `global_rows × vocab`), плюс исчезает отдельный scatter-шаг. Выигрыш растет с `tp_size` и размером словаря.
- **VRAM.** Голова остается TP-шардированной — в отличие от `--enable-dp-lm-head` дополнительной реплики весов нет. Прогрев PyNCCL резервирует транспортные буферы NCCL на старте; временные буферы прогрева (4 MiB × число пиров, вход + выход) освобождаются сразу, а постоянные транспортные аллокации намеренно попадают в замер до загрузки модели и уменьшают доступный KV-пул на свою величину — это учтенная, а не внезапная память.
- **Время старта.** Плюс прогрев all-to-all (обычно доли секунды, время печатается в лог).
- **Throughput.** На размер KV-пула сверх транспортных буферов и на конкурентность не влияет.

## Взаимодействие с другими аргументами

- `--enable-dp-lm-head`: несовместим — all-to-all-путь работает с TP-шардированной головой, DP-голова словарного параллелизма его исключает; одновременное явное включение обоих — `AssertionError`. При `None` наличие `--enable-dp-lm-head` просто оставляет дефолт `False`.
- `--enable-dp-attention`: обязательное условие для явного включения (`AssertionError` без него) и часть дефолтной формулы.
- `--tp-size` / `--dp-size`: требуется строгое равенство `tp_size == dp_size` (чистый DP-attention, `attn_tp_size == 1`); иное — `AssertionError` при явном включении.
- `--attn-cp-size`: должен быть `1`; context parallel по attention с этим путем не совместим.
- `--disaggregation-mode`: `decode` — единственная роль узла, где дефолт `None` разворачивается в `True`; `prefill` и `"null"` (colocated) дают `False` по умолчанию, но явный флаг это переопределяет.
- Спекулятивное декодирование: ограничений в коде пути нет, но fallback-условие «равный padded-размер у всех рангов» решается на каждом батче — под CUDA graph decode оно выполняется всегда.

## Типовые проблемы и диагностика

- `AssertionError: Please enable dp attention when setting enable_tp_lm_head_all_to_all.` — флаг задан без `--enable-dp-attention`.
- `AssertionError: --enable-tp-lm-head-all-to-all uses a TP-sharded LM head and is incompatible with --enable-dp-lm-head.` — уберите один из двух флагов.
- `AssertionError: --enable-tp-lm-head-all-to-all currently requires tp_size == dp_size, got tp_size=…, dp_size=…` / `…requires attn_cp_size == 1, got …` — конфигурация не является чистым DP-attention.
- `RuntimeError: --enable-tp-lm-head-all-to-all requires an available PyNCCL communicator for CUDA graph capture.` — PyNCCL-коммуникатор TP-группы недоступен на этой сборке/платформе; откатитесь через `--no-enable-tp-lm-head-all-to-all`.
- Подтверждение включения — строка `TP LM-head PyNCCL all-to-all warmup completed in …s (tp_size=…, bytes_per_peer=…)` при старте и значение поля в дампе `server_args=`.
- Флаг включен, но профиль показывает all-gather — сработал fallback: неравные padded-размеры батча у рангов (eager-режим), реплицированная tied-голова (`lm_head` не шардирован на глобальный `tp_size`) или пустой локальный батч. Это штатное поведение, не ошибка.
- Аргумент не распознается парсером (`unrecognized arguments`) — установленный пакет `sglang-kt` старше коммита `fcdaaf8a5d`; сверьте `--help` установленного движка.

## Примеры

Decode-узел PD-разнесения — здесь путь включен и по умолчанию, флаг фиксирует выбор явно:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode decode --tp-size 8 --dp-size 8 --enable-dp-attention --enable-tp-lm-head-all-to-all
```

Откат decode-узла на классический all-gather-путь без смены остальной конфигурации:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --disaggregation-mode decode --tp-size 8 --dp-size 8 --enable-dp-attention --no-enable-tp-lm-head-all-to-all
```

Принудительное включение на colocated-узле (по умолчанию тут выключено — оцените эффект на prefill):

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3 --tp-size 8 --dp-size 8 --enable-dp-attention --enable-tp-lm-head-all-to-all
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/logits_processor.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- Upstream PR: [sgl-project/sglang#32313](https://github.com/sgl-project/sglang/pull/32313) — «[Feature] Optimize TP LMHead with All-to-All», commit `fcdaaf8a5d`
