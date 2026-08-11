---
schema: 1
engine: sglang
primaryName: "--speculative-draft-load-format"
title: "--speculative-draft-load-format"
summary: Формат файлов весов draft-модели, независимый от `--load-format` целевой. Нужен, когда draft лежит в другом формате или когда для профилирования его надо поднять со случайными весами (`dummy`).
group: spec
related:
  - --load-format
  - --speculative-draft-model-path
  - --speculative-draft-model-quantization
  - --speculative-algorithm
  - --download-dir
  - --weight-cache-mode
---

# --speculative-draft-load-format

## Кратко

Отдельная ось от квантизации: не «в каком формате числа», а «из каких файлов и каким загрузчиком». Значение действует только на draft-воркер: на время его загрузки runner подменяет опубликованный load format, а потом возвращает целевой. Практический смысл ровно два — draft хранится иначе, чем target, или draft нужно поднять пустым (`dummy`), чтобы измерить стоимость спекулятивного контура без реального качества.

## Оригинальная справка

```text
The format of the draft model weights to load. If not specified, will use the same format as --load-format. Use 'dummy' to initialize draft model weights with random values for profiling.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-load-format`
- Группа: `spec`
- Тип значения: строка (`Optional[str]`)
- Допустимые значения (из `choices`): `auto`, `pt`, `safetensors`, `npcache`, `dummy`, `sharded_state`, `presharded`, `gguf`, `bitsandbytes`, `mistral`, `layered`, `flash_rl`, `remote`, `remote_instance`, `fastsafetensors`, `private`, `runai_streamer`. Список общий с `--load-format` и может расширяться плагинами через `add_load_format_choices`
- Значение по умолчанию: `null` — используется `--load-format`
- Эффективное значение: `runai_streamer`, если `--speculative-draft-model-path` указывает на объект RunAI-хранилища и аргумент не задан (`_handle_load_format`)
- Где объявлен: `ServerArgs.speculative_draft_load_format`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_load_format`) → `ModelRunner._resolve_draft_load_format` при инициализации draft-воркера → `build_load_config` → загрузка весов

## Что меняет в движке

`ModelRunner._resolve_draft_load_format()` возвращает значение только для runner'а с `is_draft_worker=True`; для целевого runner'а это всегда `None`. Дальше:

- `build_load_config(load_format=load_format or server_args.load_format, ...)` — то есть пустое значение честно означает «как у target'а»;
- на время загрузки `_load_format_scope` публикует этот формат в общий контекст (`get_model().override(load_format=...)`), потому что код некоторых моделей смотрит формат при конструировании (например, Inkling иначе заполняет шкалы shared-эксперта под `dummy`), и по выходе возвращает целевой;
- в лог пишется `Using draft model load_format: '<значение>'` — по этой строке видно, что аргумент вообще применился.

Аргумент не влияет ни на `--load-format` target'а, ни на выбор квантизации: за неё отвечает `--speculative-draft-model-quantization`.

## Значения и формат

- Одно значение из `choices`; неизвестное отвергает argparse со списком допустимых.
- `auto` — не «как у target'а», а обычная автодетекция (safetensors, иначе `.bin`). Чтобы взять формат target'а, аргумент надо не задавать.
- `dummy` — веса draft'а инициализируются случайными числами: модель стартует быстро и занимает штатную память, но качество предсказаний бессмысленно. Годится только для замеров памяти/скорости контура, не для трафика.
- `remote_instance`, `remote`, `runai_streamer` требуют соответствующей инфраструктуры и своих `--remote-instance-weight-loader-*` настроек; специальных «draft-версий» этих настроек нет — они общие.
- `layered`, `sharded_state`, `presharded` предполагают, что чекпоинт заранее подготовлен именно в этом виде.

## Когда использовать

- Draft хранится в другом виде, чем target: например, target — `presharded`, а draft — обычные safetensors.
- Замер накладных расходов спекуляции (VRAM draft-весов, время захвата графов, стоимость draft-шага) без скачивания настоящего чекпоинта: `dummy`.
- Не задавать в обычной эксплуатации: наследование `--load-format` — правильное поведение по умолчанию, а лишнее значение легко забыть и потом гадать, почему draft ничего не предсказывает (`dummy`).

## Влияние на производительность и память

- Время старта: главный эффект. `fastsafetensors`/`runai_streamer` ускоряют чтение, `dummy` убирает чтение вовсе, `npcache` тратит первый запуск на построение кеша.
- VRAM: не меняется — объём весов определяется архитектурой и квантизацией, а не форматом файла.
- Throughput/latency: косвенно, через `dummy` — со случайными весами accept rate падает до шума, и спекуляция становится чистым замедлением.

## Взаимодействие с другими аргументами

- `--load-format`: значение по умолчанию; после подстановки они уже независимы.
- `--speculative-draft-model-path`: определяет, откуда читать; RunAI-URI сам включает `runai_streamer`.
- `--speculative-draft-model-quantization`: ортогональная ось, но некоторые форматы (`gguf`, `bitsandbytes`) фактически несут квантизацию в себе.
- `--download-dir`: куда кладутся скачанные файлы.
- `--weight-cache-mode`: несовместим со спекулятивным декодированием целиком (`--weight-cache-mode` ≠ `off` + `--speculative-algorithm` = `ValueError`), поэтому IPC-кеш весов для draft'а недоступен.

## Типовые проблемы и диагностика

- Draft поднялся, но `accept len` ≈ 1.00 и ответы не деградировали — почти наверняка забытый `dummy`: draft предлагает случайные токены, target их отвергает.
- `error: argument --speculative-draft-load-format: invalid choice` — значение не из списка установленной версии.
- Ошибка «no safetensors found» при `--speculative-draft-load-format safetensors` — в чекпоинте `.bin`; используйте `auto` или `pt`.
- Подтверждение применения: строка `Using draft model load_format: '…'` в логе старта и поле `speculative_draft_load_format` в дампе `server_args=`. Отсутствие строки означает, что значение не задано и используется `--load-format`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B --speculative-draft-load-format dummy
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --load-format presharded --speculative-algorithm STANDALONE --speculative-draft-model-path /models/Llama-3.2-1B-Instruct --speculative-draft-load-format safetensors
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/load_model_utils.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/docs/docs/advanced_features/model_loading.mdx`
