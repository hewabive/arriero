---
schema: 1
engine: sglang
primaryName: "--deepep-config"
title: "--deepep-config"
summary: Подставляет оттюненные под ваш кластер параметры DeepEP для normal-режима (число SM под коммуникацию и размеры чанков NVL/RDMA). Влияет и на размер коммуникационных буферов, и на число QP; при отсутствии берутся дефолты DeepEP.
group: exec.moe
related:
  - --moe-a2a-backend
  - --deepep-mode
  - --enable-two-batch-overlap
  - --ep-size
  - --tp-size
---

# --deepep-config

## Кратко

DeepEP в normal-режиме принимает объект конфигурации на каждый вызов dispatch и combine: сколько SM отдать под коммуникационные ядра и какими чанками гонять токены по NVLink и RDMA. Значения зависят от топологии кластера, и апстрим предлагает подбирать их бенчмарком. Аргумент — способ передать результат подбора в сервер. Low-latency-режим свою геометрию считает сам и этот конфиг не читает.

## Оригинальная справка

```text
Tuned DeepEP config suitable for your own cluster. It can be either a string with JSON content or a file path.
```

## Паспорт аргумента

- Флаги: `--deepep-config`
- Группа: `exec.moe`
- Тип значения: str — JSON-строка либо путь к файлу с JSON
- Допустимые значения: `choices` нет; структура проверяется при первом создании `DeepEPConfig`
- Значение по умолчанию: `null` — используются `Buffer.get_dispatch_config(...)` и `Buffer.get_combine_config(...)` из самого DeepEP, а `num_sms` берется из `Buffer.num_sms`
- Эффективное значение: не переопределяется; пустая строка приводится к «не задан» (`server_args.deepep_config or ""`)
- Где объявлен: `ServerArgs.deepep_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: первое создание DeepEP-буфера (ленивая инициализация синглтона `DeepEPConfig`) → каждый normal-dispatch и normal-combine

## Что меняет в движке

`DeepEPConfig.__init__` (`sglang/python/sglang/srt/layers/moe/token_dispatcher/deepep.py`) читает строку через `load_json_config`: сначала пробует разобрать ее как JSON, при неудаче — прочитать как путь к файлу и разобрать его содержимое. Дальше обязательны два ключа верхнего уровня, `normal_dispatch` и `normal_combine`; их содержимое передается в конструктор `deep_ep.Config`. Ключ `num_sms` обязан совпадать в обоих (ассерт), и именно он запоминается как `DeepEPConfig.num_sms`.

Значение расходится по трем направлениям:

1. **Размер буферов.** `DeepEPBuffer.get_deepep_buffer` для normal-режима берет максимум подсказок `get_nvl_buffer_size_hint` и `get_rdma_buffer_size_hint` от обоих конфигов. Ваши размеры чанков напрямую определяют, сколько VRAM уйдет под коммуникационные буферы.
2. **Число QP.** Для `--deepep-mode normal` `num_qps_per_rank` равно `num_sms`; для `auto` — максимуму из `num_sms` и `num_experts / ep_size`.
3. **Сами вызовы.** `normal_dispatch_config` и `normal_combine_config` передаются в `buffer.dispatch(...)` и `buffer.combine(...)`.

Если `num_sms` меньше половины SM устройства, при инициализации буфера печатается предупреждение `Only use N SMs for DeepEP communication. This may result in highly suboptimal performance. Consider using --deepep-config to change the behavior.` Предупреждение подавляется при включенном two-batch overlap и не печатается в чистом low-latency-режиме.

Конфиг — синглтон, создаваемый лениво при первом обращении, и на ранге 0 печатается `Use DeepEP Config: {...}`.

## Значения и формат

Минимальная форма, которая встречается в тестах апстрима:

```text
{"normal_dispatch":{"num_sms":96},"normal_combine":{"num_sms":96}}
```

Полный набор полей `deep_ep.Config`, который умеет выдавать тюнер: `num_sms`, `num_max_nvl_chunked_send_tokens`, `num_max_nvl_chunked_recv_tokens`, `num_max_rdma_chunked_send_tokens`, `num_max_rdma_chunked_recv_tokens`. Набор полей определяется установленной версией DeepEP, а не SGLang, — лишний ключ даст `TypeError` в конструкторе `Config`.

- JSON-строку удобно передавать в одинарных кавычках, чтобы шелл не съел фигурные скобки.
- Путь к файлу распознается по неудаче разбора JSON, то есть любое имя файла подойдет; файл должен быть виден каждому воркеру на каждом узле.
- Аргумент не задан или пустая строка — дефолты DeepEP.
- Оттюненный файл получают запуском `benchmark/kernels/deepep/tuning_deepep.py` из репозитория SGLang (`python tuning_deepep.py --nnodes 4 --node-rank $MY_NODE_RANK --master-addr 1.2.3.4`); он пишет `deepep_tuned.json` ровно с ключами `normal_dispatch` и `normal_combine`.

## Когда использовать

- Многоузловая EP-развертка на RDMA, где нужен максимум пропускной способности prefill: подбор чанков дает измеримую разницу, ради этого тюнер и существует.
- В логе появилось предупреждение про малое число SM — значит, DeepEP по умолчанию взял мало SM для вашей карты; задайте `num_sms` явно.
- Только low-latency-декод (`--deepep-mode low_latency`): аргумент бесполезен, конфиг normal-режима не читается.
- Не переносите чужой `deepep_tuned.json` между кластерами с другой топологией: подобранные чанки завязаны на число узлов и на конкретную сеть.

## Влияние на производительность и память

- **VRAM.** Прямое: размеры NVL/RDMA-буферов считаются из этого конфига. Увеличение чанков увеличивает буферы, и это отдельная от KV-кеша статья расхода, которую надо учитывать в бюджете `--mem-fraction-static`.
- **SM.** `num_sms` отбирается у вычислений в пользу коммуникации. Слишком мало — предупреждение и просадка dispatch/combine; слишком много — меньше SM под GEMM экспертов.
- **Throughput prefill.** Основная цель тюнинга: чанки определяют, насколько эффективно заполняется канал.
- **Decode.** В low-latency-режиме влияния нет.
- При `--deepep-mode auto` резервируются буферы обоих режимов, поэтому вклад normal-конфига в пиковый расход сохраняется и там.

## Взаимодействие с другими аргументами

- `--moe-a2a-backend`: конфиг читается только бэкендами класса DeepEP (`deepep`, `mooncake`, `nixl`, `mori`, `pplx` используют общий буфер).
- `--deepep-mode`: применяется к `normal` и к normal-половине `auto`; в `low_latency` не участвует.
- `--enable-two-batch-overlap`: подавляет предупреждение о малом числе SM (TBO сам перераспределяет SM).
- `--ep-size`, `--tp-size`: размер группы входит в подсказки размеров буферов, поэтому конфиг, снятый на другой геометрии, даст другой расход.

## Типовые проблемы и диагностика

- `KeyError: 'normal_dispatch'` при первом MoE-проходе — в JSON нет обязательного ключа.
- `AssertionError` на сравнении `num_sms` — значения в `normal_dispatch` и `normal_combine` разошлись.
- `TypeError: __init__() got an unexpected keyword argument ...` — поле не поддерживается установленной версией DeepEP.
- `orjson.JSONDecodeError` или `FileNotFoundError` — строка не разобралась как JSON и не нашлась как файл; проверьте кавычки и доступность пути на всех узлах.
- `Only use N SMs for DeepEP communication ...` — дефолтное число SM мало для вашей карты.
- Подтверждение приема — строка `Use DeepEP Config: {...}` на ранге 0.
- Ошибка `DeepEP is not installed ...` означает, что до конфига дело не дошло: сначала нужен сам пакет DeepEP, он тянется по импорту и падает не на разборе аргументов.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode normal --deepep-config '{"normal_dispatch":{"num_sms":96},"normal_combine":{"num_sms":96}}'
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --deepep-mode auto --deepep-config /etc/sglang/deepep_tuned.json
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/moe/token_dispatcher/deepep.py`
- `sglang/python/sglang/srt/layers/moe/utils.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/benchmark/kernels/deepep/tuning_deepep.py`
- `sglang/test/registered/models_e2e/test_deepseek_v4_flash_fp4_h200.py`
