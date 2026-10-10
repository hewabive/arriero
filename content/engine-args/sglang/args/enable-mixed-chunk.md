---
schema: 1
engine: sglang
primaryName: "--enable-mixed-chunk"
title: "--enable-mixed-chunk"
summary: Разрешает класть prefill-кусок и decode-шаг работающих запросов в один forward, убирая паузу в генерации на время prefill. Требует включенного chunked prefill и несовместим со спекулятивным декодированием.
group: schedule
related:
  - --chunked-prefill-size
  - --max-prefill-tokens
  - --speculative-algorithm
  - --max-running-requests
  - --enable-prefill-delayer
  - --attention-backend
---

# --enable-mixed-chunk

## Кратко

Без этого флага один forward — это либо prefill, либо decode: пока считается кусок длинного промпта, уже работающие запросы не получают токенов. `--enable-mixed-chunk` объединяет их в один batch, и генерация не «замирает» на время prefill. Плата — decode-токены занимают часть prefill-бюджета, а требования к совместимости жесткие: chunked prefill должен быть включен, а из спекулятивных алгоритмов флаг переживают только `EAGLE`, `EAGLE3`, `DFLASH` и `DSPARK`.

## Оригинальная справка

```text
Enabling mixing prefill and decode in a batch when using chunked prefill.
```

## Паспорт аргумента

- Флаги: `--enable-mixed-chunk`
- Группа: `schedule`
- Тип значения: bool (флаг без значения, `store_true`)
- Допустимые значения: флаг присутствует или отсутствует; парного `--no-*` нет
- Значение по умолчанию: `false`
- Эффективное значение: `server_args.enable_mixed_chunk` хранит ввод оператора, а шаги резолва декларируют `false` для спекулятивных алгоритмов без поддержки смешения — `NGRAM`, `UNO`, `FROZEN_KV_MTP`, `STANDALONE` (`_handle_ngram`, `_handle_uno`, `_handle_frozen_kv_mtp`, `_handle_eagle_family` в `arg_groups/speculative_hook.py`, вызываются из шага `handle_speculative_decoding`; `EAGLE`, `EAGLE3`, `DFLASH`, `DSPARK` флаг сохраняют по `SpeculativeAlgorithm.supports_mixed_chunk`) — и при diffusion-LLM (`--dllm-algorithm`, шаг `handle_dllm_inference`). Итог виден в `resolved_dict()` и дампе `server_args=`; в scheduler'е флаг дополнительно не действует, если chunked prefill выключен
- Где объявлен: `python/sglang/srt/arg_groups/fields/schedule.py:Schedule.enable_mixed_chunk`
- Статус: обычный
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline` (принудительные отключения в `handle_speculative_decoding` и `handle_dllm_inference`) → `Scheduler.init_chunked_prefill` → каждый проход `get_new_batch_prefill`

## Что меняет в движке

В scheduler'е флаг превращается в `is_mixed_chunk`:

```python
self.is_mixed_chunk = self.chunked_prefill_size is not None and get_schedule().enable_mixed_chunk
```

то есть при `--chunked-prefill-size -1` он молча не действует. Дальше `is_mixed_chunk` работает в двух местах:

1. `PrefillAdder` создается с `num_mixed_decode_tokens = running_bs` (число запросов в running batch). Это число сразу вычитается и из `rem_input_tokens` (`--max-prefill-tokens`), и из `rem_chunk_tokens` (`--chunked-prefill-size`), потому что каждый decode-запрос добавит в forward по одному токену. Prefill-бюджет, доступный новым запросам, уменьшается ровно на размер running batch.
2. После сборки prefill-batch'а running batch подмешивается в него через `new_batch.mix_with_running(running_batch)`, а `running_batch` обнуляется. Смешение пропускается, если в любом из batch'ей запрошены logprobs (`return_logprob`) или если у нового batch'а есть `input_embeds` — формы тензоров не совпадут.

Практическое следствие второго пункта: запросы с `logprobs` в ответе не получают выгоды от смешения, батч для них разделяется как обычно.

## Значения и формат

- Флаг без значения; «не задан» означает раздельные prefill- и decode-batch'и.
- Обратного флага нет.
- Флаг не является ошибкой при `--chunked-prefill-size -1`, но и не делает ничего.
- При спекулятивном алгоритме без поддержки смешения флаг снимается автоматически с предупреждением. Ассерт `enable_mixed_chunk is not supported with speculative_algorithm=…` в `check_server_args` (`arg_groups/validation_hook.py`, вызывается при старте после `resolve_once`) — страховка после этого снятия: он срабатывает, только если флаг остался включен при алгоритме, для которого `supports_mixed_chunk()` ложно.

## Когда использовать

- Интерактивная нагрузка с длинными промптами: пользователи, которые уже получают токены, перестают видеть паузы при подключении нового длинного запроса.
- Смешанный трафик, где TTFT одних запросов не должен покупаться за счет ITL других.
- Со спекулятивным декодированием флаг имеет смысл только для `EAGLE`, `EAGLE3`, `DFLASH` и `DSPARK`; с остальными алгоритмами он все равно будет снят.
- Не включайте, если основной сценарий — оффлайн-батчинг: там разделение фаз дает более крупные и более эффективные prefill-batch'и.
- Учитывайте при отдаче logprobs: для таких запросов смешение отключается пофактно, и выигрыш будет неравномерным.

## Влияние на производительность и память

- VRAM: дополнительных пулов не заводится; пик активаций смешанного forward'а чуть выше, потому что к prefill-токенам добавляются decode-токены (по одному на running-запрос).
- RAM хоста: не влияет.
- Время старта: не влияет.
- ITL (межтоковый интервал): улучшается — decode не простаивает во время prefill.
- TTFT новых запросов: слегка ухудшается, так как из prefill-бюджета вычитается `running_bs` токенов; при большом `--max-running-requests` и маленьком `--chunked-prefill-size` вычет становится ощутимым.

## Взаимодействие с другими аргументами

- `--chunked-prefill-size`: обязателен (положительный). Из его бюджета вычитается размер running batch.
- `--max-prefill-tokens`: из него вычитается тот же размер.
- `--max-running-requests`: определяет величину вычета; пара «большой running batch + маленький chunk» может почти обнулить prefill-бюджет.
- `--speculative-algorithm`: `NGRAM`, `UNO`, `FROZEN_KV_MTP`, `STANDALONE` снимают флаг; `EAGLE`, `EAGLE3`, `DFLASH`, `DSPARK` его сохраняют.
- `--attention-backend dual_chunk_flash_attn`: значение удалено вместе с Dual Chunk Flash Attention (v0.5.20), ветки резолва, снимавшей флаг, больше нет.
- `--enable-prefill-delayer`: решает похожую задачу с другой стороны — не смешивает фазы, а придерживает prefill, чтобы decode-batch не дробился.

## Типовые проблемы и диагностика

- `Mixed chunked prefill is disabled: STANDALONE speculative decoding does not support it.`, `Mixed chunked prefill is disabled for UNO speculative decoding.`, `Mixed chunked prefill is disabled because of using Frozen-KV MTP speculative decoding.`, `The mixed chunked prefill are disabled because of using ngram speculative decoding.` — ожидаемое снятие флага спекулятивным алгоритмом.
- `Mixed chunked prefill is disabled because of using diffusion LLM inference.` — то же самое для `--dllm-algorithm`.
- Флаг задан, эффекта нет — проверьте `chunked_prefill_size` в сводке scheduler'а: при `-1` смешение выключено.
- Выросло TTFT после включения — вычет `running_bs` из prefill-бюджета; увеличьте `--chunked-prefill-size` или уменьшите `--max-running-requests`.
- Эффект наблюдается не на всех запросах — вероятно, часть трафика запрашивает logprobs.
- Принятое значение — в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --chunked-prefill-size 4096 --enable-mixed-chunk
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --chunked-prefill-size 8192 --max-running-requests 32 --enable-mixed-chunk
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/schedule.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/managers/schedule_policy.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/arg_groups/dllm_hook.py`
- `sglang/python/sglang/srt/arg_groups/validation_hook.py`
- `sglang/python/sglang/srt/speculative/spec_info.py`
