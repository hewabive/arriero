---
schema: 1
engine: sglang
primaryName: "--nsa-prefill-backend"
title: "--nsa-prefill-backend"
summary: Устаревшее имя `--dsa-prefill-backend` — ядро разреженного внимания DeepSeek на фазе prefill. Переименовано вместе со сменой NSA на DSA; при незаданном значении backend подбирается по `--kv-cache-dtype` и поколению карты.
group: null
related:
  - --dsa-prefill-backend
  - --dsa-decode-backend
  - --nsa-decode-backend
  - --kv-cache-dtype
  - --attention-backend
  - --enable-hisparse
  - --dsa-paged-mqa-logits-backend
  - --page-size
---

# --nsa-prefill-backend

## Кратко

Модели DeepSeek с разреженным вниманием (DSA, в старой терминологии NSA) выбирают ядро внимания раздельно для prefill и decode. Этот аргумент задает prefill-ядро и устарел в пользу `--dsa-prefill-backend` — переименование чисто терминологическое, поле и `dest` те же.

Задавать его вручную нужно редко: при незаданном значении backend подбирается автоматически по типу KV-кеша и поколению GPU. Но если вы его задали, апстрим настоятельно советует задать и `--kv-cache-dtype` явно — иначе автоматический выбор dtype может не совпасть с тем, что умеет выбранное ядро.

## Оригинальная справка

```text
[Deprecated] Use --dsa-prefill-backend instead.
```

## Паспорт аргумента

- Флаги: `--nsa-prefill-backend`; тот же `dest` у актуального `--dsa-prefill-backend`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне группы `exec.kernel`, где живет актуальный флаг
- Тип значения: str
- Допустимые значения: `flashmla_sparse`, `flashmla_sparse_q8`, `flashmla_kv`, `flashmla_auto`, `flashinfer_sparse_mla`, `fa3`, `tilelang`, `aiter`, `trtllm` (список `DSA_CHOICES`, тот же, что у актуального флага)
- Значение по умолчанию: в extract это выражение `argparse.SUPPRESS` — при отсутствии флага argparse ничего не пишет в namespace, поэтому действует значение по умолчанию актуального `--dsa-prefill-backend`, то есть `None` («подберет движок»)
- Эффективное значение: при `None` подбирается в пассе `_dsa_split_backend_resolution` (`arg_groups/overrides.py`) — см. ниже
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `dsa_prefill_backend`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--dsa-prefill-backend`
- Этап применения: разбор CLI (предупреждение) → `__post_init__` → `_handle_model_specific_adjustments` (пассы резолюции DSA) → конфигурация KV-пула → инициализация attention backend

## Что меняет в движке

### Предупреждение и трансляция

```text
'--nsa-prefill-backend' is deprecated and will be removed in a future release. Use '--dsa-prefill-backend' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Автоподбор при незаданном значении

Пасс `_dsa_split_backend_resolution` работает только для архитектур семейства DeepSeek с признаком DSA и не на NPU/XPU. Логика по убыванию приоритета:

- GLM-MoE-DSA на SM120/SM121 с fp8-кешем → `flashinfer_sparse_mla` для обеих фаз;
- `--enable-hisparse` → backend из `_hisparse_default_backend(kv_cache_dtype)` для обеих фаз;
- ROCm при обоих незаданных значениях → `tilelang` для обеих фаз;
- `kv_cache_dtype == "fp8_e4m3"` → `trtllm` на Blackwell (SM100+), `flashmla_kv` на Hopper;
- иначе → prefill получает `flashmla_sparse`, decode — `trtllm` на SM100+ и `fa3` ниже.

Результат печатается предупреждением:

```text
Set DSA backends for fp8_e4m3 KV Cache: prefill=trtllm, decode=trtllm.
```

Кроме того, если вы задали любой из двух backend'ов, но оставили `--kv-cache-dtype auto`, выводится:

```text
When specifying --dsa-prefill-backend or --dsa-decode-backend, you should also explicitly set --kv-cache-dtype (e.g., 'fp8_e4m3' or 'bfloat16'). DeepSeek V3.2 defaults to FP8 KV cache which may not be compatible with all backends.
```

а сам dtype при `auto` подставляется как `fp8_e4m3` на SM100+ и `bfloat16` ниже.

### Проверка совместимости с fp8

`_check_tilelang_dsa_fp8_kv` отвергает пару «tilelang + fp8_e4m3» на CUDA: fp8-путь tilelang существует только на ROCm, а CUDA-ядро жестко работает с bfloat16.

### Связь с размером страницы KV-пула

Выбор backend'а влияет и на раскладку пула: в `kv_cache_configurator.py` есть отдельные ветки для `trtllm` и для пары `tilelang`/`aiter`. Смена backend'а поэтому меняет не только скорость, но и требования к странице пула.

## Значения и формат

- Одно значение из списка `DSA_CHOICES`; иное отвергается argparse'ом.
- Не задавать — значит «подберет движок» по правилам выше.
- Значение относится только к моделям DeepSeek с DSA. На остальных архитектурах пасс резолюции просто не запускается, и аргумент ни на что не влияет.
- prefill и decode настраиваются независимо; смешанные комбинации допустимы и используются автоподбором (например, `flashmla_sparse` на prefill и `fa3` на decode).
- В YAML через `--config` ключ `dsa-prefill-backend` задать нельзя — он отвергается из-за этого устаревшего алиаса на общем `dest`.

## Когда использовать

- Не использовать: пишите `--dsa-prefill-backend`.
- Сам параметр (под новым именем) задают, когда автоподбор выбирает ядро, у которого на вашем железе есть дефект или просадка, и есть измеренная альтернатива.
- Задавая его, обязательно задавайте `--kv-cache-dtype` — иначе получите молчаливое несовпадение между ядром и типом кеша.
- Не подбирать значение по названию: `flashmla_*` требует соответствующего пакета, `aiter`/`tilelang` осмысленны на ROCm, `trtllm` — на Blackwell.

## Влияние на производительность и память

- Latency prefill: главный эффект; разные ядра по-разному работают с длинным разреженным контекстом.
- VRAM: косвенно, через раскладку KV-пула — ветки `trtllm` и `tilelang`/`aiter` в конфигураторе пула отличаются.
- Время старта: некоторые backend'ы требуют JIT-компиляции ядер при первом использовании.
- Совместимость с CUDA graph: неудачная пара backend/kv-dtype проявляется как падение уже на этапе захвата decode-графа — именно ради этого проверка tilelang+fp8 вынесена на старт.

## Взаимодействие с другими аргументами

- `--dsa-prefill-backend`: актуальное имя того же поля.
- `--dsa-decode-backend` / `--nsa-decode-backend`: парная настройка для фазы decode.
- `--kv-cache-dtype`: определяет автоподбор и совместимость; при заданном backend'е задавайте явно.
- `--enable-hisparse`: перехватывает выбор backend'а для обеих фаз.
- `--attention-backend`: общий выбор внимания; для DSA-моделей резолвится в `dsa`/`dsv4`, после чего работают эти раздельные настройки.
- `--dsa-paged-mqa-logits-backend`: отдельное ядро индексатора DSA, настраивается независимо.
- `--page-size`: раскладка пула зависит от выбранного backend'а.

## Типовые проблемы и диагностика

- `'--nsa-prefill-backend' is deprecated …` — замените на `--dsa-prefill-backend`.
- `ValueError: The tilelang DSA prefill/decode kernels only support an fp8_e4m3 KV cache on ROCm/HIP; on CUDA they require a bfloat16 KV cache. …` — смените dtype или backend.
- Предупреждение `When specifying --dsa-prefill-backend or --dsa-decode-backend, you should also explicitly set --kv-cache-dtype …` — задайте dtype.
- Значение задано, а в логе другой backend — значит сработала ветка с более высоким приоритетом (GLM SM120 fp8 или `--enable-hisparse`), которая переписывает оба поля.
- Аргумент не принимается (`unrecognized arguments`) — установленная версия уже удалила устаревшее имя; сверьтесь с `--help` своей сборки.
- Что смотреть: строка `Set DSA backends for … KV Cache: prefill=…, decode=….` и поля `dsa_prefill_backend=`, `kv_cache_dtype=` в дампе `server_args=`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --dsa-prefill-backend flashmla_sparse --kv-cache-dtype bfloat16
```

Согласованная пара prefill/decode на Hopper с fp8-кешем:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --dsa-prefill-backend flashmla_kv --dsa-decode-backend flashmla_kv --kv-cache-dtype fp8_e4m3
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/hisparse_hook.py`
- `sglang/python/sglang/srt/layers/attention/dsa_backend.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
