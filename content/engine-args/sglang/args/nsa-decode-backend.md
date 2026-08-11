---
schema: 1
engine: sglang
primaryName: "--nsa-decode-backend"
title: "--nsa-decode-backend"
summary: Устаревшее имя `--dsa-decode-backend` — ядро разреженного внимания DeepSeek на фазе decode. Переименовано вместе со сменой NSA на DSA; при незаданном значении подбирается по `--kv-cache-dtype` и поколению карты.
group: null
related:
  - --dsa-decode-backend
  - --dsa-prefill-backend
  - --nsa-prefill-backend
  - --kv-cache-dtype
  - --attention-backend
  - --enable-hisparse
  - --cuda-graph-backend-decode
  - --page-size
---

# --nsa-decode-backend

## Кратко

Парный аргумент к `--nsa-prefill-backend`: то же поле выбора ядра разреженного внимания, но для фазы decode. Устарел в пользу `--dsa-decode-backend`; переименование терминологическое (NSA → DSA), `dest` и семантика не менялись.

Отличие decode-фазы от prefill в том, что именно ее ядро попадает в захваченный CUDA graph. Неудачная пара «backend + тип KV-кеша» поэтому чаще всего проявляется не как ошибка конфигурации, а как падение на этапе захвата decode-графа.

## Оригинальная справка

```text
[Deprecated] Use --dsa-decode-backend instead.
```

## Паспорт аргумента

- Флаги: `--nsa-decode-backend`; тот же `dest` у актуального `--dsa-decode-backend`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне группы `exec.kernel`, где живет актуальный флаг
- Тип значения: str
- Допустимые значения: `flashmla_sparse`, `flashmla_sparse_q8`, `flashmla_kv`, `flashmla_auto`, `flashinfer_sparse_mla`, `fa3`, `tilelang`, `aiter`, `trtllm` (список `DSA_CHOICES`)
- Значение по умолчанию: в extract это выражение `argparse.SUPPRESS` — при отсутствии флага argparse ничего не пишет в namespace, поэтому действует значение по умолчанию актуального `--dsa-decode-backend`, то есть `None` («подберет движок»)
- Эффективное значение: при `None` подбирается в пассе `_dsa_split_backend_resolution` — на fp8-кеше `trtllm` для SM100+ и `flashmla_kv` для Hopper; на прочих dtype `trtllm` для SM100+ и `fa3` ниже; на ROCm (при обоих незаданных значениях) `tilelang`; отдельные ветки для GLM-MoE-DSA на SM120/SM121 с fp8 (`flashinfer_sparse_mla`) и для `--enable-hisparse`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `dsa_decode_backend`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--dsa-decode-backend`
- Этап применения: разбор CLI (предупреждение) → `__post_init__` → пассы резолюции DSA → конфигурация KV-пула → инициализация attention backend → захват decode-графа

## Что меняет в движке

### Предупреждение и трансляция

```text
'--nsa-decode-backend' is deprecated and will be removed in a future release. Use '--dsa-decode-backend' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Куда попадает значение

`DsaAttnBackend` (`sglang/python/sglang/srt/layers/attention/dsa_backend.py`) читает `server_args.dsa_decode_backend` в конструкторе и хранит его как реализацию decode-пути; prefill-путь берет соседнее поле. Кроме этого, значение читается в двух местах вне слоя внимания:

- `kv_cache_configurator.py` меняет раскладку пула, если хотя бы одно из двух полей равно `trtllm` либо входит в пару `tilelang`/`aiter`;
- forward-методы DeepSeek (`forward_mla.py`, `forward_mha.py`) проверяют `trtllm` для выбора пути внутри модели.

### Проверки и предупреждения

Те же, что и у prefill-варианта: предупреждение о необходимости явного `--kv-cache-dtype` при заданном backend'е, автоподстановка dtype при `auto`, отказ на паре «tilelang + fp8_e4m3» на CUDA и итоговая строка

```text
Set DSA backends for bfloat16 KV Cache: prefill=flashmla_sparse, decode=fa3.
```

## Значения и формат

- Одно значение из списка `DSA_CHOICES`; иное отвергается argparse'ом.
- Не задавать — значит «подберет движок».
- Относится только к моделям DeepSeek с DSA; на остальных архитектурах пасс резолюции не запускается.
- prefill и decode независимы, и автоподбор действительно выдает разные значения для фаз на не-fp8 кеше.
- В YAML через `--config` ключ `dsa-decode-backend` задать нельзя — он отвергается из-за этого устаревшего алиаса на общем `dest`.

## Когда использовать

- Не использовать: пишите `--dsa-decode-backend`.
- Сам параметр (под новым именем) задают при измеренной просадке или дефекте автоматически выбранного ядра на конкретной карте.
- Всегда вместе с явным `--kv-cache-dtype`.
- Если после смены backend'а падает захват decode-графа, сначала проверьте совместимость пары backend/dtype, и только потом трогайте `--cuda-graph-backend-decode`.

## Влияние на производительность и память

- Latency decode: главный эффект. Decode на разреженном внимании — самая частая операция, и разница между ядрами здесь заметнее, чем на prefill.
- VRAM: косвенно, через раскладку KV-пула и через ветку страничного размера.
- Время старта: некоторые backend'ы компилируются при первом использовании; кроме того, decode-ядро прогоняется на каждой захватываемой форме графа.
- Стабильность: несовместимая пара backend/dtype проявляется на этапе `Capturing batches (bs=…)`.

## Взаимодействие с другими аргументами

- `--dsa-decode-backend`: актуальное имя того же поля.
- `--dsa-prefill-backend` / `--nsa-prefill-backend`: парная настройка фазы prefill.
- `--kv-cache-dtype`: определяет автоподбор и совместимость.
- `--enable-hisparse`: перехватывает выбор для обеих фаз.
- `--attention-backend`: общий выбор; для DSA-моделей резолвится в `dsa`/`dsv4`.
- `--cuda-graph-backend-decode`: decode-ядро попадает в захватываемый граф; при проблемах захвата смотрите обе настройки.
- `--page-size`: раскладка пула зависит от выбранного backend'а.

## Типовые проблемы и диагностика

- `'--nsa-decode-backend' is deprecated …` — замените на `--dsa-decode-backend`.
- `ValueError: The tilelang DSA prefill/decode kernels only support an fp8_e4m3 KV cache on ROCm/HIP; …` — несовместимая пара; используйте `bfloat16` с tilelang либо fp8-совместимое ядро (`flashmla_kv` на Hopper, `trtllm` на Blackwell).
- Падение во время `Capturing batches (bs=…)` сразу после смены backend'а — ядро несовместимо с захватом при текущем типе кеша.
- Предупреждение про явный `--kv-cache-dtype` — задайте dtype.
- Значение задано, а в логе другое — сработала ветка более высокого приоритета (GLM SM120 fp8 или hisparse).
- Что смотреть: строка `Set DSA backends for … KV Cache: prefill=…, decode=….`, поля `dsa_decode_backend=` и `kv_cache_dtype=` в дампе `server_args=`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --dsa-decode-backend fa3 --kv-cache-dtype bfloat16
```

Пара prefill/decode на Blackwell с fp8-кешем:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --dsa-prefill-backend trtllm --dsa-decode-backend trtllm --kv-cache-dtype fp8_e4m3
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/attention/dsa_backend.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/models/deepseek_common/attention_forward_methods/forward_mla.py`
