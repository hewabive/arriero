---
schema: 1
engine: sglang
primaryName: "--load-format"
title: "--load-format"
summary: Как читать веса модели. `auto` почти всегда верен и вдобавок сам переключается на gguf/mistral/runai/remote по виду `--model-path`; остальные значения — это разные загрузчики со своими требованиями и своим `--model-loader-extra-config`.
group: model
related:
  - --model-path
  - --model-loader-extra-config
  - --download-dir
  - --quantization
  - --weight-loader-disable-mmap
  - --weight-loader-prefetch-checkpoints
  - --rl-quant-profile
  - --speculative-draft-load-format
  - --weight-cache-mode
  - --remote-instance-weight-loader-backend
---

# --load-format

## Кратко

`--load-format` выбирает класс загрузчика в `get_model_loader` (`sglang/python/sglang/srt/model_loader/loader.py`). Дефолт `auto` — это `DefaultModelLoader`, который пробует safetensors и откатывается на `*.bin`. Важнее другое: `_handle_load_format` в `__post_init__` **сам меняет значение** по виду `--model-path` (GGUF-файл, нативный формат Mistral, `s3://`/`gs://`/`az://`, любой `схема://`), поэтому заданный вручную формат не всегда доживает до загрузчика. Каждый нестандартный формат — это отдельная подсистема со своими требованиями к файлам и к `--model-loader-extra-config`.

## Оригинальная справка

```text
The format of the model weights to load. "auto" will try to load the weights in the safetensors format and fall back to the pytorch bin format if safetensors format is not available. "pt" will load the weights in the pytorch bin format. "safetensors" will load the weights in the safetensors format. "npcache" will load the weights in pytorch format and store a numpy cache to speed up the loading. "dummy" will initialize the weights with random values, which is mainly for profiling."gguf" will load the weights in the gguf format. "bitsandbytes" will load the weights using bitsandbytes quantization."layered" loads weights layer by layer so that one can quantize a layer before loading another to make the peak memory envelope smaller."presharded" performs a normal first-time load (with quantization), then dumps a per-rank/per-tensor sharded checkpoint with content deduplication into <model_path>/presharded/<parallelism+quant subfolder>/. Subsequent runs with the same parallelism+quantization config load directly from this presharded checkpoint and skip re-quantization. The dump directory must be on a shared filesystem across all ranks/nodes. Optional model_loader_extra_config roots: presharded_path (target) and draft_presharded_path (speculative draft); each replaces <model_path>/presharded and still gets a config subfolder appended. Use a writable path when model_path is read-only (e.g. HF cache mounts).
```

## Паспорт аргумента

- Флаги: `--load-format`
- Группа: `model`
- Тип значения: строка
- Допустимые значения: `auto`, `pt`, `safetensors`, `npcache`, `dummy`, `sharded_state`, `presharded`, `gguf`, `bitsandbytes`, `mistral`, `layered`, `flash_rl`, `remote`, `remote_instance`, `fastsafetensors`, `private`, `runai_streamer`. Внутренний `ipc_cache` намеренно не выведен в CLI; попытка задать его отвергается с подсказкой про `--weight-cache-mode`
- Значение по умолчанию: `auto`
- Эффективное значение: `_handle_load_format` переписывает его на `gguf` / `mistral` / `runai_streamer` / `remote` по `--model-path`, а `remote_instance` откатывает обратно в `auto` при неполной конфигурации удаленного загрузчика; кроме того `presharded` и `layered` внутри своих загрузчиков подменяют формат на `auto` для фактического чтения файлов
- Где объявлен: `ServerArgs.load_format`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_load_format`) → построение `LoadConfig` → `get_model_loader` → чтение весов в каждом воркере

## Что меняет в движке

Диспетчер `get_model_loader` выбирает загрузчик в следующем порядке: `dummy` → квантизация AutoRound → ModelOpt (если задан `--modelopt-quant`/`--quantization modelopt_*` или пути ModelOpt-чекпоинтов) → и только потом по значению `--load-format`. То есть ModelOpt-путь перекрывает выбранный формат, кроме `runai_streamer` и `remote_instance`.

Что делают конкретные значения:

- **`auto`, `safetensors`, `pt`, `fastsafetensors`, `npcache`, `mistral`** — все это `DefaultModelLoader` с разным набором glob-паттернов: `auto` берет `*.safetensors` и откатывается на `*.bin`, `mistral` ищет `consolidated*.safetensors`, `npcache` требует `*.bin` (внутри стоит `assert use_safetensors is False`) и кладет рядом numpy-кеш. `fastsafetensors` дополнительно разрешает ключ `enable_gds` в `--model-loader-extra-config`.
- **`dummy`** — `DummyModelLoader`: веса не читаются, инициализируются случайными значениями. Конфиг модели все равно нужен настоящий. Любой непустой `--model-loader-extra-config` при этом формате отвергается `ValueError`.
- **`gguf`** — `GGUFModelLoader`. `--model-path` обязан быть **файлом**, не каталогом (`ValueError: … is not a file.`); `--model-loader-extra-config` запрещен.
- **`bitsandbytes`** — квантизация на лету через bitsandbytes; поддерживает `qlora_adapter_name_or_path` в extra-config.
- **`layered`** — `LayeredModelLoader`: модель создается на meta-device и заполняется помодульно, что снижает пиковую память при квантизации torchao. Требует у класса модели метод `load_weights_to_module`, иначе `ValueError: LayeredModelLoader requires the model to have a load_weights_to_module method.`
- **`sharded_state`** — загрузка заранее нарезанного per-rank чекпоинта по шаблону `model-rank-{rank}-part-{part}.safetensors` (шаблон переопределяется ключом `pattern`).
- **`presharded`** — первый запуск грузится как обычно и **дампит** пошардованный чекпоинт в `<model_path>/presharded/<подкаталог по параллелизму и квантизации>/`, последующие запуски читают его и пропускают повторную квантизацию. Каталог должен быть общим для всех rank'ов и записываемым; корень переопределяется ключами `presharded_path` / `draft_presharded_path`.
- **`flash_rl`** — RL-сценарий: `QuantizedRLModelLoader` плюс автоматическая установка `quantization=fp8`; требует `--rl-quant-profile`.
- **`remote`**, **`remote_instance`**, **`runai_streamer`**, **`private`** — транспортные загрузчики: connector-URL, веса от другого живого инстанса (NCCL / transfer engine / ModelExpress), объектное хранилище, приватный плагин `sglang.private.private_model_loader`.

## Значения и формат

- Значение приводится к нижнему регистру при построении `LoadConfig` (`LoadFormat(load_format.lower())`), но argparse сверяет `choices` до этого — пишите как в списке.
- Автоподмена по пути безусловна: GGUF-файл превратит даже явный `--load-format safetensors` в `gguf`, а `s3://` — в `runai_streamer`.
- `remote_instance` при неполной конфигурации не падает, а откатывается в `auto` с предупреждением «Fallback load_format to 'auto' due to incomplete remote instance weight loader settings.» — то есть сервер поднимется, просто загрузит веса с диска.
- `ipc_cache` — `ValueError: load_format='ipc_cache' is an internal-only format and must not be set directly.`; включается через `--weight-cache-mode client|daemon`.
- `--weight-cache-mode` несовместим со спекулятивным декодированием — проверка живет в том же `_handle_load_format`.

## Когда использовать

- Оставьте `auto`: он покрывает safetensors, bin и все автодетектируемые случаи.
- `dummy` — для профилирования формы модели без чтения весов (типичный приём в апстрим-бенчмарках вместе с `--json-model-override-args`, урезающим число слоев).
- `presharded` — когда квантизация на старте занимает минуты и запуск повторяется часто; выигрыш есть только при неизменных параллелизме и квантизации.
- `layered` — когда пиковая память при загрузке с квантизацией не влезает, хотя финальная модель влезает.
- Не выбирайте формат «на всякий случай»: каждый нестандартный загрузчик отключает часть оптимизаций общего пути (многопоточное чтение, mmap, prefetch).

## Влияние на производительность и память

- Время старта — главная величина, на которую влияет аргумент. `npcache` и `presharded` торгуют место на диске за скорость повторных запусков; `fastsafetensors`/`runai_streamer` — за пропускную способность чтения.
- Пиковая VRAM при загрузке: `layered` заметно ниже, `presharded` при повторном запуске ниже (нет ре-квантизации), `dummy` минимальна.
- RAM хоста: обычный путь читает safetensors через mmap, страницы оседают в page cache (`--weight-loader-disable-mmap` это отключает; `--weight-loader-drop-cache-after-load` сбрасывает кеш после чтения).
- Сетевые ФС: на них выигрывает `--weight-loader-prefetch-checkpoints`, при этом многопоточное чтение по умолчанию отключается — вернуть его можно ключом `enable_multithread_load` в `--model-loader-extra-config`.
- На throughput после старта формат загрузки не влияет: он определяет, как веса попали в память, а не как считаются.

## Взаимодействие с другими аргументами

- `--model-path`: главный источник автоподмены формата.
- `--model-loader-extra-config`: набор допустимых ключей зависит от формата, лишние ключи — `ValueError` на старте.
- `--download-dir`: используется загрузчиками, которые скачивают веса с HF.
- `--quantization`: ModelOpt-квантизация перехватывает диспетчер загрузчика; `flash_rl` сам ставит `fp8`; GGUF имеет собственную связку с квантизацией.
- `--speculative-draft-load-format`: отдельный формат для draft-модели; для `s3://`-пути draft он выставляется в `runai_streamer` автоматически.
- `--weight-cache-mode`: единственный легальный способ получить `ipc_cache`.
- `--remote-instance-weight-loader-backend`, `--modelexpress-config`: конфигурация `remote_instance`.

## Типовые проблемы и диагностика

- `ValueError: <path> is not a file.` — `gguf` (часто автодетект) при каталоге в `--model-path`.
- `ValueError: Unexpected extra config keys for load format …` / `Model loader extra config is not supported for load format …` — ключи `--model-loader-extra-config` не подходят выбранному формату.
- `ValueError: LayeredModelLoader requires the model to have a load_weights_to_module method.` — архитектура не поддерживает `layered`.
- Предупреждение «Fallback load_format to 'auto' …» — `remote_instance` собран не полностью (нет IP/порта seed-инстанса либо групповых портов NCCL).
- «Detected Mistral native format checkpoint, setting load_format='mistral'» — сработал автодетект по составу каталога.
- Итоговое значение (уже после всех подмен) печатается в дампе `server_args=` при старте; факт удачной загрузки — в строке `Load weight end. elapsed=… s, type=…, avail mem=… GB, mem usage=… GB.`

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --load-format presharded --model-loader-extra-config '{"presharded_path": "/fast/presharded"}' --tp-size 2
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --load-format dummy --json-model-override-args '{"num_hidden_layers": 2}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/load_config.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_loader/weight_utils.py`
- `sglang/python/sglang/srt/utils/runai_utils.py`
- `sglang/docs/docs/developer_guide/benchmark_and_profiling.mdx`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
