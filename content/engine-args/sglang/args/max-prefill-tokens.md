---
schema: 1
engine: sglang
primaryName: "--max-prefill-tokens"
title: "--max-prefill-tokens"
summary: Бюджет prefill-токенов на один batch, независимый от `--chunked-prefill-size`. Реальный потолок prefill — минимум из двух, и по умолчанию (16384) связывает обычно не он.
group: schedule
related:
  - --chunked-prefill-size
  - --prefill-max-requests
  - --max-running-requests
  - --mem-fraction-static
  - --enable-dynamic-chunking
  - --enable-mixed-chunk
  - --page-size
  - --context-length
---

# --max-prefill-tokens

## Кратко

`--max-prefill-tokens` — второй, независимый бюджет prefill-batch'а: сколько суммарно новых токенов планировщик готов посчитать за один проход. `--chunked-prefill-size` ограничивает то же самое, но дополнительно умеет резать один запрос на куски; `--max-prefill-tokens` только перестает добавлять новые запросы. При дефолтах (16384 против 2048…8192 у chunk'а) связывает обычно chunk, поэтому аргумент вспоминают в двух случаях: при отключенном chunked prefill и при `--enable-dynamic-chunking`.

## Оригинальная справка

```text
The maximum number of tokens in a prefill batch. The real bound will be the maximum of this value and the model's maximum context length.

Supports standard SI suffixes (k, M, G, T) and IEC suffixes
(Ki, Mi, Gi, Ti). Suffixes are case-sensitive.

Decimals are allowed for SI suffixes only.

Examples:
    '1k' -> 1000      '1M' -> 1000000    '25.6k' -> 25600
    '1Ki' -> 1024     '1Mi' -> 1048576
```

## Паспорт аргумента

- Флаги: `--max-prefill-tokens`
- Группа: `schedule`
- Тип значения: целое (`int`), парсится `human_readable_int`
- Допустимые значения: положительное целое, опционально с суффиксом SI (`k`, `M`, `G`, `T`) или IEC (`Ki`, `Mi`, `Gi`, `Ti`); суффиксы регистрозависимы, дробная часть допустима только с SI
- Значение по умолчанию: `16384`
- Эффективное значение: не переопределяется ни `__post_init__`, ни `_handle_*` — значение попадает в scheduler как есть
- Где объявлен: `ServerArgs.max_prefill_tokens`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `Scheduler` через `TpModelWorker.get_worker_info()` → `PrefillAdder` на каждом проходе планирования

## Что меняет в движке

Значение приходит в `PrefillAdder` как `rem_input_tokens` и уменьшается на длину каждого принятого в batch запроса (`_update_prefill_budget`). Как только бюджет исчерпан, `budget_state()` возвращает `AddReqResult.OTHER` и batch закрывается.

Особенность admission: проверка `real_input_tokens >= self.rem_input_tokens` применяется **только при выключенном chunked prefill** (`rem_chunk_tokens is None`) и **только если batch не пуст**. Иначе говоря, один запрос всегда проходит целиком, каким бы длинным он ни был. Это и есть практический смысл фразы справки про «максимум из этого значения и длины контекста»: явного `max(max_prefill_tokens, context_len)` в коде checkout'а нет — эффект достигается правилом «первый запрос принимается всегда».

При включенном chunked prefill `rem_input_tokens` продолжает уменьшаться, но решение о нарезке принимает `rem_chunk_tokens`; фактический потолок batch'а — минимум из двух бюджетов.

Помимо планирования значение читают:

- автоподбор `--mem-fraction-static`, если chunked prefill выключен: `activation_tokens = max(max_prefill_tokens, 2048)`;
- `--enable-dynamic-chunking` при `--pp-size > 1`: предсказанный размер куска ограничивается сверху `max_prefill_tokens`, и от этой же величины считается верхняя граница prefill-буфера;
- бюджет токенов CuteDSL MoE all-to-all (`cutedsl_moe_max_num_tokens`), где недостаточный лимит диспетчера FlashInfer приводит к отказу на старте;
- прогрев автотюнера FlashInfer, который прогоняет фиктивный extend-батч на `max_prefill_tokens` токенов.

## Значения и формат

- `--max-prefill-tokens 32768`, `32Ki`, `32.7k` — валидны; `1.5Ki` отвергается (дробь с IEC-суффиксом запрещена).
- Значение не обязано быть кратно `--page-size` — в отличие от `--chunked-prefill-size`.
- `0` и отрицательные значения argparse примет. Практически это означает «ни один batch не наберет бюджета», и отдельные подсистемы (например `kv-canary`) падают с явной ошибкой `max_prefill_tokens must be positive`.
- «Отключающего» значения нет: чтобы снять ограничение, поставьте заведомо большое число.
- Значение не делится на `--dp-size` (в отличие от `--chunked-prefill-size`) — это бюджет одного scheduler'а, то есть одного DP-ранга.

## Когда использовать

- Поднимать вместе с `--chunked-prefill-size`, если chunk увеличен выше 16384: иначе новый chunk не будет достижим, потому что `rem_input_tokens` закончится раньше.
- Ограничивать prefill-batch при выключенном chunked prefill (`--chunked-prefill-size -1`), когда несколько средних промптов, попав в один batch, дают пик активаций.
- Учитывать при `--enable-dynamic-chunking`: именно это значение задает верхнюю границу, до которой предсказатель может растить кусок.
- Не трогать при обычной конфигурации с включенным chunked prefill: дефолт 16384 в этом режиме почти никогда не является связывающим ограничением, и его изменение ничего не даст.

## Влияние на производительность и память

- VRAM: влияет на пик активаций только при выключенном chunked prefill (тогда участвует и в автоподборе `--mem-fraction-static`) и при dynamic chunking. В обычном режиме пик задает chunk.
- RAM хоста: не влияет.
- Время старта: косвенно — размер прогревочного батча автотюнера FlashInfer.
- Throughput: слишком малое значение дробит prefill на много мелких batch'ей и снижает утилизацию GPU.
- Latency: увеличение значения удлиняет один prefill-проход и, соответственно, паузу в decode, если не включен `--enable-mixed-chunk`.

## Взаимодействие с другими аргументами

- `--chunked-prefill-size`: параллельный бюджет того же batch'а; действует минимум из двух. Только chunk умеет резать один запрос.
- `--prefill-max-requests`: ограничение того же batch'а, но по числу запросов, а не по токенам.
- `--enable-mixed-chunk`: число decode-токенов вычитается из обоих бюджетов до начала admission.
- `--enable-dynamic-chunking`: использует значение как верхнюю границу предсказанного куска.
- `--mem-fraction-static`: при выключенном chunked prefill значение попадает в формулу резерва под активации.
- `--moe-a2a-backend flashinfer` + `--moe-runner-backend flashinfer_cutedsl`: значение участвует в проверке бюджета диспетчера, отказ виден на старте.
- `--context-length`: границу длины запроса задает он, а не этот аргумент.

## Типовые проблемы и диагностика

- Prefill-batch'и заметно меньше `--chunked-prefill-size`, хотя очередь длинная, — вероятно, исчерпан `rem_input_tokens`. Сверьте оба значения в сводке `max_total_num_tokens=…, chunked_prefill_size=…, max_prefill_tokens=…`.
- Отказ на старте `FlashInfer MoE A2A with flashinfer_cutedsl requires SGLANG_FLASHINFER_NUM_MAX_DISPATCH_TOKENS_PER_RANK * ep_size to cover the largest CuteDSL MoE forward` — уменьшите `--max-prefill-tokens` или поднимите переменную окружения.
- `kv-canary: max_prefill_tokens must be positive` — задано неположительное значение.
- OOM на prefill при `--chunked-prefill-size -1` — уменьшайте именно `--max-prefill-tokens`: это единственный оставшийся бюджет batch'а (но помните, что одиночный длинный запрос все равно пройдет целиком).
- Принятое значение печатается в дампе `server_args=` и в сводке scheduler'а при готовности.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --max-prefill-tokens 32768 --chunked-prefill-size 16384
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --chunked-prefill-size -1 --max-prefill-tokens 8192
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/managers/scheduler_pp_mixin.py`
- `sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`
