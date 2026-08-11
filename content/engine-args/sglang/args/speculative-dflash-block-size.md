---
schema: 1
engine: sglang
primaryName: "--speculative-dflash-block-size"
title: "--speculative-dflash-block-size"
summary: Длина блока верификации для алгоритма DFLASH — то же самое, что `--speculative-num-draft-tokens`, но под именем из терминологии DFlash. Читается только хуком DFLASH; при любом другом `--speculative-algorithm` значение лежит без дела и даже без предупреждения.
group: spec
related:
  - --speculative-algorithm
  - --speculative-num-draft-tokens
  - --speculative-draft-model-path
  - --speculative-draft-window-size
  - --speculative-num-steps
  - --speculative-eagle-topk
---

# --speculative-dflash-block-size

## Кратко

DFLASH не строит дерево кандидатов: draft выдаёт линейный блок токенов, а target проверяет его одним forward'ом. Длина этого блока и есть block size. В `ServerArgs` она хранится в общем поле `speculative_num_draft_tokens`, а этот аргумент — второе имя для той же величины, оставленное ради терминологии DFlash-чекпоинтов. Задавать оба одновременно можно, но только одинаковыми значениями.

## Оригинальная справка

```text
DFLASH only. Block size (verify window length). Alias of --speculative-num-draft-tokens for DFLASH.
```

## Паспорт аргумента

- Флаги: `--speculative-dflash-block-size`
- Группа: `spec`
- Тип значения: целое (`Optional[int]`), число токенов
- Допустимые значения: строго положительное; проверка после разбора CLI
- Значение по умолчанию: `null`
- Эффективное значение: при заданном значении `speculative_num_draft_tokens` становится равным ему. При обоих незаданных block size выводится из hf-конфига draft-чекпоинта (`dflash_config.block_size` или верхнеуровневый `block_size`), а если конфиг прочитать не удалось — `16` с предупреждением. `speculative_num_steps` и `speculative_eagle_topk` в этом же хуке принудительно становятся `1`
- Где объявлен: `ServerArgs.speculative_dflash_block_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но алгоритмо-специфичный: единственный читатель — `_handle_dflash`
- Этап применения: `__post_init__` (`_handle_dflash`) → размер verify-форварда, размер draft-KV на шаг, размерность CUDA graph → forward

## Что меняет в движке

`_handle_dflash` выполняет ровно три действия с этим значением:

1. отвергает неположительное (`DFLASH requires --speculative-dflash-block-size to be positive, got N`);
2. сверяет с `--speculative-num-draft-tokens`, если тот тоже задан, и падает при расхождении (`Both --speculative-num-draft-tokens and --speculative-dflash-block-size are set but they differ. For DFLASH they must match.`);
3. записывает значение в `speculative_num_draft_tokens`.

Дальше работает уже общее поле: от него зависят ширина verify-форварда (`num_tokens_per_req`), резерв KV на шаг декодирования (`2 × max(steps × topk, num_draft_tokens)`, где steps и topk у DFLASH равны 1), размерность буферов и захваченных CUDA graph'ов, а также оценка активаций при автоподборе `--mem-fraction-static` в режиме `--disaggregation-mode decode`.

Сам воркер `DFlashWorkerV2` затем ещё раз сверяет принятое значение с `block_size` из конфига draft-модели и печатает предупреждение при расхождении: `DFLASH block size mismatch: using speculative_num_draft_tokens=X but draft config block_size=Y`. Это не ошибка — движок работает с вашим значением, но чекпоинт обучен под своё.

## Значения и формат

- Целое число токенов. Типичные значения для DFlash-чекпоинтов — 8, 16, 32; ориентир даёт `block_size` в конфиге draft'а.
- `0` и отрицательные — `ValueError` на старте.
- Не задано и `--speculative-num-draft-tokens` не задан — берётся из конфига draft'а; это самый правильный режим, потому что чекпоинт обучен под конкретный блок.
- Задавать оба флага можно только одинаковыми значениями; расхождение — не «побеждает последний», а падение.
- При любом алгоритме, кроме `DFLASH`, значение не читается вообще и предупреждения не будет — в отличие от `--speculative-draft-window-size`, который о неприменимости сообщает.

## Когда использовать

- Нужно уменьшить блок относительно обученного, чтобы сократить ширину verify-форварда при большом running batch: verify стоит `block_size` токенов на запрос, и на батче это доминирующая статья.
- Нужно вручную зафиксировать блок, потому что в конфиге чекпоинта поля `block_size` нет и движок иначе возьмёт 16.
- Не увеличивать блок сверх обученного: draft начнёт предлагать позиции, которых не видел, accept rate упадёт, а стоимость verify вырастет.
- Не задавать вместе с `--speculative-num-draft-tokens`: два имени одной величины в командной строке — лишний повод для рассинхронизации при правках.

## Влияние на производительность и память

- VRAM: линейно по значению — резерв KV на запрос на каждый decode-шаг равен `2 × block_size` токенов, шире становятся буферы verify и захваченные графы.
- Latency: верхняя граница выигрыша — `block_size` токенов за раунд; фактический результат равен `accept len`.
- Throughput: обратная зависимость при большом батче — каждый верифицируемый токен занимает вычислительную ширину независимо от того, будет он принят или отброшен.
- Время старта: чуть дольше захват графов на больших блоках.

## Взаимодействие с другими аргументами

- `--speculative-num-draft-tokens`: то же самое поле; расхождение при обоих заданных — ошибка.
- `--speculative-algorithm DFLASH`: единственный режим, где значение читается.
- `--speculative-draft-model-path`: источник значения по умолчанию (конфиг чекпоинта).
- `--speculative-draft-window-size`: обязан быть `>= block_size`, иначе `ValueError`.
- `--speculative-num-steps` / `--speculative-eagle-topk`: у DFLASH оба принудительно `1`; задавать их другими значениями бессмысленно (предупреждение и перезапись).
- `--mem-fraction-static`: рост блока увеличивает и резерв KV, и активации.

## Типовые проблемы и диагностика

- `DFLASH requires --speculative-dflash-block-size to be positive, got 0` — недопустимое значение.
- `Both --speculative-num-draft-tokens and --speculative-dflash-block-size are set but they differ.` — уберите один из двух флагов.
- `speculative_num_draft_tokens is not set; defaulting to 16 for DFLASH.` — конфиг draft'а не дал block size; проверьте чекпоинт или задайте значение явно.
- `Failed to infer DFLASH block_size from draft model config; defaulting speculative_num_draft_tokens to 16. Error: …` — конфиг не прочитался (путь, `--trust-remote-code`, доступ к хабу).
- `DFLASH block size mismatch: using speculative_num_draft_tokens=32 but draft config block_size=16.` — вы переопределили обученный блок; ожидайте падения accept rate.
- Что смотреть: `Initialized DFLASH draft runner. attention_backend=…, model=…, block_size=…, draft_window_size=…, compact_cache=…` и поле `speculative_num_draft_tokens` в дампе `server_args=` (собственное поле `speculative_dflash_block_size` там останется таким, каким вы его задали).

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm DFLASH --speculative-draft-model-path z-lab/LLaMA3.1-8B-Instruct-DFlash-UltraChat --speculative-dflash-block-size 16
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm DFLASH --speculative-draft-model-path z-lab/LLaMA3.1-8B-Instruct-DFlash-UltraChat --speculative-dflash-block-size 8 --speculative-draft-window-size 512 --max-running-requests 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/dflash_utils.py`
- `sglang/python/sglang/srt/speculative/dflash_worker_v2.py`
- `sglang/python/sglang/srt/mem_cache/allocation_sizing.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
