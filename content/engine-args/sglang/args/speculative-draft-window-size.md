---
schema: 1
engine: sglang
primaryName: "--speculative-draft-window-size"
title: "--speculative-draft-window-size"
summary: Ограничивает контекст, который видит draft-модель: sliding window у Llama-EAGLE3-драфтера и компактный локальный KV-кеш у DFLASH. На остальных алгоритмах игнорируется с предупреждением, целевую модель не затрагивает никогда.
group: spec
related:
  - --speculative-algorithm
  - --speculative-num-draft-tokens
  - --speculative-dflash-block-size
  - --speculative-draft-model-path
  - --page-size
  - --context-length
---

# --speculative-draft-window-size

## Кратко

Draft видит не весь контекст, а последние N токенов. Смысл в том, что для предсказания ближайших нескольких токенов далёкий префикс почти не нужен, а платить за него приходится и памятью (KV draft'а), и временем (внимание по всей длине). Аргумент работает ровно у двух драфтеров — Llama-EAGLE3 (`LlamaForCausalLMEagle3`) и DFLASH; остальные, включая MLA-драфтеры EAGLE3, его молча не читают (предупреждение печатается на старте).

## Оригинальная справка

```text
Sliding window size for the draft model. Honored by Llama EAGLE-3 (`LlamaForCausalLMEagle3`) and DFLASH only; other EAGLE-3 backends (e.g. MLA-based drafters) silently ignore it. For Llama EAGLE-3, the drafter only attends to the most recent N keys (verifier hidden states + its own outputs); the verifier is unaffected. For DFLASH, the draft worker keeps a recent target-token window in its local KV cache (paged backends may retain up to one extra page on the left for alignment). Default is full attention/context.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-window-size`; устаревший алиас `--speculative-dflash-draft-window-size` (объявлен литеральным `parser.add_argument` с `DeprecatedAliasStoreAction` и `help=argparse.SUPPRESS`, то есть в `--help` не показывается и в extract отдельной записи не имеет)
- Группа: `spec`
- Тип значения: целое (`Optional[int]`), число токенов
- Допустимые значения: строго положительное; ноль и отрицательные отвергаются проверкой после разбора
- Значение по умолчанию: `null` — полное внимание/полный контекст
- Эффективное значение: значение приводится к `int`; для DFLASH дополнительно требуется `window_size >= speculative_num_draft_tokens`
- Где объявлен: `ServerArgs.speculative_draft_window_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный (алиас `--speculative-dflash-draft-window-size` — устаревший)
- Этап применения: `__post_init__` (`handle_speculative_decoding` — проверка и предупреждение; `_handle_dflash` — сверка с block size) → конструирование draft-модели (EAGLE3) или draft-воркера (DFLASH) → forward

## Что меняет в движке

Проверка выполняется **один раз для всех алгоритмов**: `handle_speculative_decoding` требует положительности и, если алгоритм не `EAGLE3` и не `DFLASH`, печатает `--speculative-draft-window-size has no effect with speculative_algorithm=<x> (honored by Llama EAGLE-3 and DFLASH only)`.

- **Llama EAGLE-3.** В `LlamaForCausalLMEagle3.__init__` значение читается один раз и проставляется каждому слою как `layer.self_attn.attn.sliding_window_size`; оно же возвращается из `get_attention_sliding_window_size()`. Драфтер смотрит только на последние N ключей — это hidden states верификатора плюс его собственные выходы. Целевая модель не затрагивается: её окно и её KV остаются полными.
- **DFLASH.** `DFlashWorkerV2` включает компактный draft-кеш (`use_compact_draft_cache = draft_window_size is not None`) и на каждом шаге считает видимую длину как `min(seq_len, window)`. При `--page-size > 1` начало окна выравнивается вниз по границе страницы, поэтому фактически может удерживаться до `page_size − 1` лишних токенов слева; хостовая оценка использует монотонную верхнюю границу `min(len, window + page_size)`.

## Значения и формат

- Целое число токенов, без суффиксов. Разумный порядок — сотни-тысячи, а не единицы.
- `0` и отрицательные: `ValueError: --speculative-draft-window-size must be positive, got N`.
- Не задано = полный контекст (для DFLASH — компактный кеш выключен целиком, draft хранит KV на всю длину).
- Для DFLASH окно не может быть меньше блока верификации: `--speculative-draft-window-size must be >= --speculative-num-draft-tokens (block_size)`, где `block_size` — это `--speculative-dflash-block-size` либо выведенное значение.
- Верхней границы нет; значение больше фактической длины запроса эквивалентно полному вниманию.

## Когда использовать

- DFLASH на длинных контекстах: draft-KV — это отдельный пул поверх целевого, и на 32k+ он заметен. Окно в несколько сотен токенов обычно не портит accept rate, потому что DFlash предсказывает блок вперёд по недавнему тексту.
- Llama-EAGLE3-драфтер, обученный с ограниченным окном: значение надо привести в соответствие с обучением, иначе драфтер получает распределение, которого не видел.
- Не задавать «на всякий случай» на MLA-драфтерах и EAGLE-2 — там аргумент ничего не делает, кроме предупреждения в логе.
- Не выкручивать окно в минимум ради памяти: у DFLASH это прямой обмен на accept rate, а восстановить его можно только новым замером.

## Влияние на производительность и память

- VRAM: у DFLASH сокращает объём draft-KV, участвующий в форварде (компактный кеш), у EAGLE3 сокращает объём вычислений внимания драфтера, но не сам KV-пул — размер пула считается на этапе конфигурации по числу слоёв, а не по окну.
- Время draft-шага: внимание по N ключам вместо всей последовательности — на длинном контексте разница заметная.
- На target'а: нулевое влияние по обоим путям.
- Accept rate: главный риск. Слишком маленькое окно снижает качество предложений, и выигрыш спекуляции падает быстрее, чем экономится память.

## Взаимодействие с другими аргументами

- `--speculative-algorithm`: значение читается только у `EAGLE3` (Llama-драфтер) и `DFLASH`.
- `--speculative-num-draft-tokens` / `--speculative-dflash-block-size`: нижняя граница окна для DFLASH.
- `--page-size`: при страницах > 1 фактическое окно округляется вверх до границы страницы.
- `--context-length`: draft всегда работает в абсолютных позициях target'а; окно — это ограничение внимания, а не длины запроса.
- `--speculative-draft-model-path`: чекпоинт должен быть совместим с выбранным окном (для EAGLE3 — обучен с ним).

## Типовые проблемы и диагностика

- `--speculative-draft-window-size must be positive, got 0` — недопустимое значение.
- `--speculative-draft-window-size must be >= --speculative-num-draft-tokens (block_size). window_size=8, block_size=16` — окно меньше блока верификации DFLASH.
- `--speculative-draft-window-size has no effect with speculative_algorithm=EAGLE (honored by Llama EAGLE-3 and DFLASH only).` — аргумент задан не тому алгоритму.
- Задан для EAGLE3, предупреждения нет, но ничего не изменилось — драфтер не `LlamaForCausalLMEagle3` (например, MLA-драфтер); поведение штатное, читайте оригинальную справку.
- Что смотреть: у DFLASH строка `Initialized DFLASH draft runner. attention_backend=…, block_size=…, draft_window_size=…, compact_cache=True`; общий дамп `server_args=` показывает принятое значение.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm DFLASH --speculative-draft-model-path z-lab/LLaMA3.1-8B-Instruct-DFlash-UltraChat --speculative-dflash-block-size 16 --speculative-draft-window-size 512
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B --speculative-draft-window-size 1024
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/models/llama_eagle3.py`
- `sglang/python/sglang/srt/speculative/dflash_worker_v2.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
