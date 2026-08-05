---
schema: 1
primaryName: "--cache-type-v"
title: "--cache-type-v"
summary: "Тип данных V-части KV-cache. Квантованный V-cache экономит память, но требует Flash Attention и аккуратной проверки качества."
category: "Общие параметры"
valueType: "enum"
estimation: "normal"
valueHint: "TYPE"
aliases:
  - "-ctv"
  - "--cache-type-v"
allowedValues:
  - "f32"
  - "f16"
  - "bf16"
  - "q8_0"
  - "q4_0"
  - "q4_1"
  - "iq4_nl"
  - "q5_0"
  - "q5_1"
env:
  - "LLAMA_ARG_CACHE_TYPE_V"
related:
  - "--cache-type-k"
  - "--ctx-size"
  - "--parallel"
  - "--kv-offload"
  - "--kv-unified"
---

# --cache-type-v

## Кратко

`--cache-type-v` задает `common_params::cache_type_v` и затем `llama_context_params::type_v`: тип хранения values в KV-cache.

По умолчанию используется `f16`. Практически всегда этот аргумент оценивают вместе с `--cache-type-k`, потому что общий размер KV-cache складывается из K и V.

Полная таблица типов, расчет памяти, различия `f16`/`bf16`, `q4_0`/`q4_1`/`iq4_nl` и общая стратегия выбора описаны в [--cache-type-k](./cache-type-k.md). Здесь собраны особенности именно V-cache.

## Оригинальная справка llama.cpp

```text
KV cache data type for V
allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
(default: f16)
```

## Паспорт аргумента

- Основное имя: `--cache-type-v`
- Алиасы: `-ctv`, `--cache-type-v`
- Значение по умолчанию: `f16`
- Переменная окружения: `LLAMA_ARG_CACHE_TYPE_V`
- Поле llama.cpp: `common_params::cache_type_v`
- Этап применения: создание `llama_context` и выделение KV-cache

## Что именно меняется

Тип передается в `cparams.type_v` перед `llama_init_from_model()`. При выделении KV-cache llama.cpp логирует фактический тип и размер V-части: `V (...): ... MiB`.

Аргумент не меняет модельный файл и не переквантует веса. Он влияет только на runtime cache.

Values в attention - это сохраненное содержимое, которое смешивается весами внимания после выбора релевантных позиций через K. Поэтому агрессивная квантизация V может не только "смазать" отдельные числа, но и ухудшить извлечение информации из длинного контекста, даже если модель стартует и не показывает явных ошибок.

## Значения

Допустимые значения: `f32`, `f16`, `bf16`, `q8_0`, `q4_0`, `q4_1`, `iq4_nl`, `q5_0`, `q5_1`.

Неверное значение приводит к ошибке разбора KV-cache type.

Подробная таблица памяти находится в `--cache-type-k`. Короткая практическая шкала:

- `f16`: default и baseline.
- `q8_0`: первый разумный шаг при нехватке памяти.
- `q5_0`/`q5_1`: промежуточные варианты, но скорость зависит от backend kernels.
- `q4_0`/`q4_1`/`iq4_nl`: сильная экономия с обязательной проверкой качества.
- `bf16`: не экономит память относительно `f16`; используйте только осознанно.
- `f32`: почти никогда не нужен для production llama-server.

## Главное ограничение V-cache

Квантованный V-cache требует Flash Attention. Если указать `--cache-type-v q8_0`, `q5_0`, `q4_0` и т.п. при явно отключенном Flash Attention (`--flash-attn off`), llama.cpp завершит старт ошибкой `V cache quantization requires flash_attn`. При `--flash-attn auto` FA может авторазрешиться в off (device mismatch при пробной сборке графа), и старт тоже упадет, но уже с другим сообщением: `quantized V cache was requested, but this requires Flash Attention` — то есть `auto` квантованный V не гарантирует.

Практически:

- Явно включайте `--flash-attn on`; `--flash-attn auto` — не гарантия: если backend не потянет FA, старт все равно упадет.
- Для архитектуры Grok Flash Attention принудительно выключается (`flash_attn is not compatible with Grok - forcing off`), поэтому квантованный V-cache там невозможен.
- При `--split-mode tensor` quantized KV-cache сейчас не поддерживается; используйте `f16`, `bf16` или `f32`.
- Для квантованных V-типов block size должен делить `n_embd_head_v`; иначе сервер завершится ошибкой на старте.

## Когда использовать

Используйте квантованный V-cache, когда именно KV-cache не помещается при нужном `--ctx-size`, `--parallel` или числе router-слотов. Если цель только снизить вес модели в VRAM, меняйте GGUF-квантизацию модели или `--gpu-layers`, а не `--cache-type-v`.

Рекомендуемый порядок:

1. `f16/f16` для baseline.
2. `q8_0/q8_0`, если не хватает памяти.
3. `q5_0/q5_0`, `q5_1/q5_1` или `q4_0/q4_0`, если нужна дальнейшая экономия.
4. Смешанные типы, например `--cache-type-k q8_0 --cache-type-v q4_0`, только после проверки качества, скорости и логов device placement.

Не занижайте V без benchmark для tool/function calling, кода, задач с длинными инструкциями, RAG с важными фактами в начале контекста и любых production-пресетов, где деградация качества дороже экономии VRAM.

## Делать V ниже K?

Да, иногда это имеет смысл: K влияет на attention scores, а V хранит смешиваемое содержимое. Исследование "More for Keys, Less for Values" прямо поддерживает идею, что keys часто заслуживают больше битов, чем values. Поэтому `q8_0/q4_0` или `q8_0/q5_0` может быть разумным экспериментом, если `q8_0/q8_0` почти помещается, но нужна еще экономия.

Но для llama.cpp это именно экспериментальная настройка:

- mixed K/V-типы могут не иметь быстрого CUDA/Vulkan/Metal path;
- одинаковые пары иногда быстрее, чем более "логичная" смешанная пара;
- если V quantization включена, Flash Attention обязателен;
- для качества сравнивайте ответы на длинном контексте, а не только короткий smoke test.

Если после изменения V вы видите резкое падение prompt speed, рост Host memory или странное качество, верните V на `q8_0` или `f16` и повторите измерение.

## Взаимодействие с другими аргументами

- `--cache-type-k`: вторая половина выбора KV-типа.
- `--ctx-size`: линейно влияет на число KV-ячеек.
- `--parallel`: меняет `n_seq_max` и организацию KV.
- `--kv-unified`: включает общий KV-буфер.
- `--kv-offload`: влияет на размещение KV/KQV на device или host.
- `--flash-attn`: обязателен для квантованного V-cache.
- `--split-mode tensor`: несовместим с quantized KV-cache.
- `--spec-draft-type-v` (`-ctvd`, `--cache-type-v-draft`; env `LLAMA_ARG_SPEC_DRAFT_CACHE_TYPE_V`): отдельный тип V-cache draft-модели speculative decoding; основной `--cache-type-v` на draft-модель не действует.

Актуальная реализация KV-cache может создавать Hadamard rotation tensors для quantized K/V при подходящей размерности head. Это не меняет список допустимых значений, но влияет на то, какой fast path реально используется backend.

## INI-пресеты и router-режим

В INI используйте `cache-type-v = q8_0` или `LLAMA_ARG_CACHE_TYPE_V`. В router-режиме применяется к дочернему процессу модели.

## Типовые проблемы и диагностика

- Смотрите лог `llama_kv_cache` или `llama-kv-cache`: там должна быть строка `V (...): ... MiB`.
- При ошибке `V cache quantization requires flash_attn` (явный `--flash-attn off`) или `quantized V cache was requested, but this requires Flash Attention` (`auto` разрешился в off) включите `--flash-attn on` или верните V на `f16`.
- При compute errors или падении качества вернитесь на `f16` и меняйте только один из `--cache-type-k`/`--cache-type-v` за раз.
- При резком замедлении проверьте, не оказалась ли выбранная mixed-пара без fast-path на вашем backend.
- Если память почти не изменилась, проверьте, что изменили оба типа или что OOM был не в KV-cache.

## Примеры

```bash
llama-server --model /models/model.gguf --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0
```

```bash
llama-server --model /models/model.gguf --flash-attn on --cache-type-k f16 --cache-type-v q4_0
```

```bash
llama-server --model /models/model.gguf --flash-attn on --cache-type-k q8_0 --cache-type-v q4_0
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/common.h`
- `llama.cpp/common/common.cpp`
- `llama.cpp/src/llama-context.cpp`
- `llama.cpp/src/llama-kv-cache.cpp`
- `llama.cpp/docs/multi-gpu.md`
- <https://arxiv.org/abs/2402.02750>
- <https://arxiv.org/abs/2502.15075>
- <https://huggingface.co/docs/transformers/v4.56.1/en/kv_cache>
- <https://github.com/ggml-org/llama.cpp/issues/20866>
- <https://github.com/ggml-org/llama.cpp/issues/21295>
