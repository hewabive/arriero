---
schema: 1
engine: sglang
primaryName: "--hisparse-config"
title: "--hisparse-config"
summary: JSON с числовыми параметрами HiSparse: размер per-request буфера на GPU, top-k, кратность host-пула и размер CUDA-блока подкачки. Именно здесь задается фактический расход VRAM и RAM при `--enable-hisparse`.
group: memory
related:
  - --enable-hisparse
  - --disaggregation-mode
  - --disable-radix-cache
  - --page-size
---

# --hisparse-config

## Кратко

`--enable-hisparse` только включает механизм, а все, что определяет его стоимость по памяти, живет в `--hisparse-config`. Это JSON-объект из четырех числовых ручек с дефолтами (`top_k` 2048, `device_buffer_size` = 2×`top_k`, `host_to_device_ratio` 2, `swap_in_block_size` 960) плюс несколько необязательных полей; все нераспознанные ключи уходят алгоритму сжатия как есть. Аргумент имеет алиас `--hierarchical-sparse-attention-extra-config` и читается только при включенном HiSparse.

## Оригинальная справка

```text
A dictionary in JSON string format for hierarchical sparse attention configuration. Example: '{"top_k": 2048, "device_buffer_size": 4096, "host_to_device_ratio": 2}'
```

## Паспорт аргумента

- Флаги: `--hisparse-config`, `--hierarchical-sparse-attention-extra-config`
- Группа: `memory`
- Тип значения: строка с JSON-объектом (`Optional[str]`)
- Допустимые значения: не ограничены argparse; разбор и проверки — в `_parse_sparse_config`
- Значение по умолчанию: `null` — берется полный набор дефолтов `SparseConfig`
- Эффективное значение: `top_k` переопределяется значением `index_topk` из конфигурации модели, если оно там есть — при создании `HiSparseCoordinator` берется `hf_text_config.index_topk`, и заданное в JSON значение в этом случае не применяется
- Где объявлен: `ServerArgs.hisparse_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный аргумент узкого назначения; поля алгоритмов могут меняться вместе с самим путем HiSparse
- Этап применения: `parse_hisparse_config` при построении KV-пула и аллокатора, затем при создании `HiSparseCoordinator` в `ModelRunner.initialize()`

## Что меняет в движке

Разбор выполняет `_parse_sparse_config` (`sglang/python/sglang/srt/mem_cache/sparsity/factory.py`). Строка парсится как JSON, из словаря извлекаются известные ключи, остаток складывается в `sparse_extra_config` и достается уже конкретному алгоритму:

- `top_k` (int, 2048) — сколько позиций KV отбирается для внимания на шаге decode;
- `device_buffer_size` (int, по умолчанию `2 * top_k`) — сколько токенов вмещает per-request буфер на GPU. Проверяется `device_buffer_size >= top_k`, иначе `ValueError`;
- `host_to_device_ratio` (int, 2) — во сколько раз логическая емкость пула больше device-пула; именно этот множитель определяет объем pinned-памяти хоста и передается в `HiSparseDSATokenToKVPool` и `HiSparseTokenToKVPoolAllocator`;
- `swap_in_block_size` (int, 960) — размер CUDA thread-block для ядра подкачки. Проверяется целочисленность (значение `True`/`False` отвергается отдельно) и диапазон `[1, 1024]`;
- `algorithm` (по умолчанию `null`) — имя алгоритма разреженности из реестра `_ALGORITHM_REGISTRY`: `quest` или `deepseek_dsa`;
- `backend` (`null`) — адаптер внимания: `fa3`/`flashattention` дают `FlashAttentionAdaptor`, для `DeepSeekDSAAlgorithm` всегда берется `DSABackendAdaptor` независимо от значения;
- `page_size`, `min_sparse_prompt_len` (`null`) — переопределения гранулярности и минимальной длины промпта, с которой включается разреженный путь.

Полученный `SparseConfig` используется в двух независимых местах: при конструировании пулов (только `host_to_device_ratio`) и при создании координатора (`top_k`, `device_buffer_size`).

Обратите внимание на приоритет `top_k`: `ModelRunner.maybe_init_hisparse_coordinator` берет `getattr(self.model_config.hf_text_config, "index_topk", hisparse_cfg.top_k)` — у моделей, объявляющих `index_topk`, побеждает конфигурация модели.

## Значения и формат

- JSON-объект в одинарных кавычках: `'{"top_k": 2048, "device_buffer_size": 6144, "host_to_device_ratio": 10, "swap_in_block_size": 960}'`.
- Все четыре основных поля — целые. Дробное значение там, где ожидается int, приведет к ошибке или к некорректному сайзингу.
- `device_buffer_size` меньше `top_k` — `ValueError: device_buffer_size (X) must be no smaller than top_k (Y)`.
- `swap_in_block_size` вне `[1, 1024]` — `ValueError` с явным диапазоном; булево значение отвергается отдельной проверкой.
- Отсутствие аргумента эквивалентно пустому объекту: применяются все дефолты.
- Формат «`@`-файл» здесь **не** поддерживается — это отличие от `--hicache-storage-backend-extra-config`.

## Когда использовать

- Всегда при `--enable-hisparse` в продакшене: дефолтный `host_to_device_ratio` 2 почти наверняка занижен для длинного контекста. Апстрим дает ориентир по объему RAM хоста: ~1 ТБ → 5, ~2 ТБ → 10.
- `device_buffer_size` подбирается под целевую конкурентность: он умножается на число одновременных decode-запросов и определяет расход VRAM.
- `swap_in_block_size` трогайте только при профилировании ядра подкачки — дефолт 960 подобран апстримом.
- `algorithm`/`backend` задавайте только при воспроизведении конкретной конфигурации: для DSA-моделей адаптер выбирается автоматически.
- Не задавайте аргумент без `--enable-hisparse` — он не будет прочитан.

## Влияние на производительность и память

- VRAM: `device_buffer_size` × число активных decode-запросов. Это и есть основной рычаг конкурентности.
- RAM хоста: `host_to_device_ratio` × размер device-пула, pinned-память. Занижение приводит к нехватке емкости под длинные последовательности, завышение — к бессмысленному резерву.
- `top_k` влияет на качество и на объем подкачки: чем больше, тем больше данных приходит хост→GPU на каждом шаге.
- `swap_in_block_size` влияет только на эффективность ядра подкачки, не на объем.
- Время старта растет с размером host-пула (аллокация pinned-памяти).

## Взаимодействие с другими аргументами

- `--enable-hisparse`: без него значение не читается.
- `--disable-radix-cache`: обязателен для HiSparse в целом.
- `--disaggregation-mode decode`: штатный режим; на prefill-узле конфигурация не нужна.
- `--page-size`: поле `page_size` внутри JSON — отдельное переопределение для разреженного пути, не путайте его с одноименным CLI-аргументом.
- `--mem-fraction-static`: задает device-пул, на который умножается `host_to_device_ratio`, то есть косвенно определяет расход RAM.
- В arriero объем host-пула HiSparse должен быть учтен в host memory draw инстанса (`docs/RESOURCE_MANAGEMENT.md`).

## Типовые проблемы и диагностика

- `ValueError: Failed to parse hisparse_config: …` — сломанный JSON (чаще всего съеденные shell'ом кавычки).
- `ValueError: device_buffer_size (X) must be no smaller than top_k (Y)` — буфер меньше числа отбираемых позиций.
- `ValueError: swap_in_block_size (X) must be in the range [1, 1024]` или «must be an integer» — неверный размер блока.
- `ValueError: Unknown sparse algorithm: <x>` — значение `algorithm` вне реестра (`quest`, `deepseek_dsa`).
- `ValueError: Unknown attention backend: <x>` — значение `backend` не распознано адаптером.
- Заданный `top_k` не действует — у модели есть `index_topk` в конфигурации, и он имеет приоритет.
- Принятая строка видна в дампе `server_args=` при старте; фактические числа проще проверить по расходу VRAM на запрос и по объему pinned-памяти процесса.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --trust-remote-code --tp-size 8 --disable-radix-cache --disaggregation-mode decode --enable-hisparse --hisparse-config '{"top_k": 2048, "device_buffer_size": 6144, "host_to_device_ratio": 10, "swap_in_block_size": 960}'
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --trust-remote-code --tp-size 8 --disable-radix-cache --disaggregation-mode decode --enable-hisparse --hisparse-config '{"top_k": 2048, "device_buffer_size": 4096, "host_to_device_ratio": 5}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/sparsity/factory.py`
- `sglang/python/sglang/srt/mem_cache/sparsity/core/sparse_coordinator.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/docs/docs/advanced_features/hisparse_guide.mdx`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
