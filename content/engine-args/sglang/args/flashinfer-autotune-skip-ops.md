---
schema: 1
engine: sglang
primaryName: "--flashinfer-autotune-skip-ops"
title: "--flashinfer-autotune-skip-ops"
summary: Список идентификаторов custom-op FlashInfer, которые надо пропустить при автотюнинге; пропущенные остаются на эвристике FlashInfer. Точечная замена полного `--disable-flashinfer-autotune` при падении конкретного ядра.
group: exec.kernel
related:
  - --disable-flashinfer-autotune
  - --moe-runner-backend
  - --fp8-gemm-backend
  - --fp4-gemm-backend
  - --quantization
---

# --flashinfer-autotune-skip-ops

## Кратко

Автотюнинг FlashInfer перебирает тактики для каждой зарегистрированной тюнимой операции. Если одна из них падает или дает illegal memory access, не обязательно выключать весь прогон — можно перечислить проблемные операции здесь, и они пойдут по эвристике FlashInfer, а остальные все равно будут оттюнены. Набор имен задает установленный пакет FlashInfer, а не SGLang, поэтому проверять его нужно по своей сборке.

## Оригинальная справка

```text
FlashInfer custom-op identifiers to skip during autotuning. Skipped ops use FlashInfer's heuristic fallback. SGLang temporarily skips mxfp8_gemm by default due to an IMA.
```

## Паспорт аргумента

- Флаги: `--flashinfer-autotune-skip-ops`
- Группа: `exec.kernel`
- Тип значения: список строк (`nargs="+"`, значения через пробел)
- Допустимые значения: `choices` нет и быть не может — это идентификаторы custom-op из установленного пакета FlashInfer, которые передаются как есть в `flashinfer.autotuner.autotune(..., skip_ops=…)`. SGLang их не валидирует и не перечисляет; смотрите реестр автотюнера в своей версии FlashInfer (неизвестное имя просто ни на что не подействует)
- Значение по умолчанию: `null` — пустой набор
- Эффективное значение: `get_flashinfer_autotune_skip_ops` объединяет заданный список с константой `FLASHINFER_AUTOTUNE_WORKAROUND_SKIPS`. **В checkout'е, по которому снят extract, эта константа пуста** (`frozenset()`), то есть фраза справки про «SGLang temporarily skips mxfp8_gemm by default» устарела: `mxfp8_gemm` убрали из набора коммитом `e226bb711c` от 9 августа 2026
- Где объявлен: `ServerArgs.flashinfer_autotune_skip_ops`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → `warmup()` в `BaseRunner` (только если автотюнинг вообще запускается) → путь кеша тактик → контекст `flashinfer.autotuner.autotune`

## Что меняет в движке

`sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`:

1. `get_flashinfer_autotune_skip_ops(model_runner)` возвращает `set(server_args.flashinfer_autotune_skip_ops or ()) | FLASHINFER_AUTOTUNE_WORKAROUND_SKIPS`.
2. Этот набор входит в **ключ кеша тактик**: строка `"skip_ops=" + ",".join(sorted(skip_ops))` добавляется в материал хеша каталога. Смена политики пропусков означает новый каталог кеша — старые тактики не переиспользуются, и это сделано намеренно.
3. Набор передается в `autotune(True, cache=…, skip_ops=skip_ops)` — дальше решение принимает автотюнер FlashInfer.

Аргумент имеет смысл только там, где автотюнинг вообще запускается. Условия перечислены в справке `--disable-flashinfer-autotune`: CUDA, compute capability ≥ 9.0, не детерминированный режим и попадание в один из трех триггеров (FlashInfer-раннер MoE, FP4-GEMM `flashinfer_cutlass`/`flashinfer_cutedsl` на modelopt-FP4-модели, FP8-GEMM `flashinfer_cutlass` или modelopt-FP8-модель на SM100/SM120).

## Значения и формат

- Формат — список через пробел: `--flashinfer-autotune-skip-ops <op1> <op2>`. Запятая разделителем не является: `nargs="+"` берет все последующие токены до следующего флага.
- Пустой список задать нельзя: `--flashinfer-autotune-skip-ops` без значений argparse отвергнет.
- Имя, которого нет в реестре автотюнера FlashInfer, ошибки не вызовет — оно просто не совпадет ни с одной операцией. Ошибку вы заметите только по тому, что падение не ушло.
- Отсутствие аргумента (`null`) и пустой набор эквивалентны, пока `FLASHINFER_AUTOTUNE_WORKAROUND_SKIPS` пуст.

## Когда использовать

- Когда прогон автотюнинга падает в конкретной операции, а остальные тюнятся нормально: имя операции видно в трассировке из `flashinfer.autotuner`.
- Когда апстрим-issue про конкретное ядро известен и вы хотите обойти его точечно, не теряя тюнинг всего остального.
- Не используйте как общую «настройку производительности»: пропуск операции — это отказ от измеренной тактики в пользу эвристики, то есть заведомая потеря.
- Не переносите список между версиями FlashInfer: имена операций — контракт пакета, а не SGLang.

## Влияние на производительность и память

- **Throughput.** Каждая пропущенная операция теряет выигрыш от тюнинга. Для trtllm-gen fp4 MoE код фиксирует порядок ~30 % на батчах ≥ 8k токенов на SM100.
- **Время старта.** Слегка уменьшается: перебор тактик для пропущенных операций не выполняется.
- **Дисковый кеш.** Любое изменение списка создает новый каталог тактик под `$SGLANG_CACHE_DIR/flashinfer/autotune/...`; старые каталоги остаются лежать и вручную не чистятся.
- **VRAM.** Влияния нет.

## Взаимодействие с другими аргументами

- `--disable-flashinfer-autotune`: полностью перекрывает — при нем список не используется вовсе.
- `--moe-runner-backend`, `--fp8-gemm-backend`, `--fp4-gemm-backend`, `--quantization`: определяют, какие операции вообще участвуют в автотюнинге, а значит какие имена имеет смысл перечислять.
- `--enable-deterministic-inference`: отключает автотюнинг целиком, список становится неактуален.
- `--model-path`, `--tp-size`, `--ep-size`: входят в ключ кеша тактик наравне со списком пропусков.

## Типовые проблемы и диагностика

- **Симптом:** справка обещает пропуск `mxfp8_gemm` по умолчанию, а его нет. **Причина:** текст справки устарел, набор по умолчанию пуст. **Решение:** задать имя явно, если в вашей версии FlashInfer проблема сохраняется.
- **Симптом:** после добавления имени старт снова стал долгим. **Причина:** сменился ключ кеша, тактики тюнятся заново.
- **Симптом:** имя задано, а падение осталось. **Причина:** имя не совпало с идентификатором в реестре автотюнера FlashInfer, либо падает другая операция.
- **Проверка:** дамп `server_args=` при старте показывает список; строка `Running FlashInfer autotune with cache: <path>` показывает каталог, чей хеш зависит от этого списка.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-R1-FP4 --quantization modelopt_fp4 --moe-runner-backend flashinfer_trtllm --flashinfer-autotune-skip-ops mxfp8_gemm
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-R1-FP4 --quantization modelopt_fp4 --fp4-gemm-backend flashinfer_cutlass --flashinfer-autotune-skip-ops mxfp8_gemm
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner/flashinfer_autotune.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
- `sglang/python/sglang/srt/environ.py`
- коммит checkout'а `e226bb711c` — очистка `FLASHINFER_AUTOTUNE_WORKAROUND_SKIPS`
