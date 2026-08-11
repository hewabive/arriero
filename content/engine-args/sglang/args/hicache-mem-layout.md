---
schema: 1
engine: sglang
primaryName: "--hicache-mem-layout"
title: "--hicache-mem-layout"
summary: Раскладка host-пула HiCache: что идет внешней осью — слой, страница или голова. Определяет, возможен ли zero-copy в L3 и насколько крупными блоками идет перенос в GPU; согласуется с `--hicache-io-backend` автоматически.
group: memory
related:
  - --enable-hierarchical-cache
  - --hicache-io-backend
  - --hicache-storage-backend
  - --hicache-storage-backend-extra-config
  - --page-size
---

# --hicache-mem-layout

## Кратко

`--hicache-mem-layout` задает порядок осей в буфере L2. GPU считает KV послойно, поэтому «родная» для него раскладка — `layer_first`; внешние хранилища, наоборот, читают и пишут страницами, поэтому им нужен `page_first`. Выбор layout определяет, можно ли отдать страницу в L3 одним куском без промежуточной сборки, и насколько крупными блоками идет перенос из хоста в GPU. Пять допустимых значений неравноправны: два из них (`page_first_kv_split`, `page_head`) — узкоспециальные, а любую невалидную пару layout/IO движок перепишет сам на старте.

## Оригинальная справка

```text
The layout of host memory pool for hierarchical cache.
```

## Паспорт аргумента

- Флаги: `--hicache-mem-layout`
- Группа: `memory`
- Тип значения: строка с фиксированным списком
- Допустимые значения: `layer_first`, `page_first`, `page_first_direct`, `page_first_kv_split`, `page_head`
- Значение по умолчанию: `page_first`
- Эффективное значение: `_resolve_layout_io_compatibility` меняет `page_first` на `page_first_direct` при `--hicache-io-backend direct`; `_resolve_storage_layout_compatibility` меняет `layer_first` на `page_first`/`page_first_direct` при `--hicache-storage-backend mooncake`; на Ascend NPU платформа выставляет `page_first_kv_split` (MLA) или `page_first_direct`
- Где объявлен: `ServerArgs.hicache_mem_layout`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_hicache`) → аллокация буфера host-пула → каждая операция переноса

## Что меняет в движке

Layout — это буквально форма тензора host-пула. Для MHA-моделей (`mem_cache/pool_host/mha.py`) размерности такие:

- `layer_first` → `(2, layer_num, size, head_num, head_dim)`;
- `page_first` → `(2, size, layer_num, head_num, head_dim)`;
- `page_first_direct` → `(2, page_num, layer_num, page_size, head_num, head_dim)`;
- `page_head` → `(2, page_num, head_num, page_size, layer_num, head_dim)`.

Для MLA (`mem_cache/pool_host/mla.py`) набор другой, и там же живет `page_first_kv_split`, который выделяет `k_buffer` и `v_buffer` **раздельно** — это Ascend-специфичная раскладка под `NPUMLATokenToKVPool`.

Смысл различий (`sglang/docs/docs/advanced_features/hicache_design.mdx`): при `page_first`/`page_first_direct` весь KV одной страницы лежит непрерывно, поэтому его можно отдать в L3 одним объектом без копии. Но GPU работает послойно, поэтому обратный перенос из `page_first` идет по одному токену на слой; `page_first_direct` группирует внутри страницы токены одного слоя и позволяет агрегировать передачу на уровне «страница-слой».

`page_head` добавляет к этому ось голов внешним уровнем — она нужна для heterogeneous-TP сценария: `tp_lcm_size` в `--hicache-storage-backend-extra-config` включает разбиение по головам (`should_split_heads` в `cache_controller.py`) только при `layout == "page_head"` и только для не-MLA моделей. Так один и тот же ключ в L3 остается переиспользуемым между кластерами с разными `--tp-size`.

## Значения и формат

- `page_first` (по умолчанию) — страница внешней осью, работает с `--hicache-io-backend kernel`. Zero-copy в L3 доступен.
- `page_first_direct` — то же, но с группировкой токенов слоя внутри страницы; предназначен для `--hicache-io-backend direct`, дает ту же zero-copy эффективность и более крупные передачи в GPU.
- `layer_first` — раскладка «как на GPU». Совместима с обоими IO-backend'ами, но не позволяет отдавать страницу в L3 одним куском.
- `page_head` — для heterogeneous-TP с MHA-моделями и backend'ами, умеющими head-shard (Mooncake, UMBP/`mori`). Без `tp_lcm_size` в extra-config смысла не имеет.
- `page_first_kv_split` — Ascend NPU, MLA-модели: раздельные буферы K и V. На CUDA/ROCm не применяется.
- Значение вне списка отвергает argparse.

## Когда использовать

- Без L3 и с `kernel` — оставляйте дефолт `page_first`.
- С L3 (`hf3fs`, `mooncake`, `nixl`) — берите пару `--hicache-mem-layout page_first_direct --hicache-io-backend direct`: именно она стоит во всех развернутых примерах апстрим-руководства.
- `layer_first` — только если L3 не используется и вы измеряли, что послойная раскладка выигрывает на вашей модели; с Mooncake она все равно будет переписана.
- `page_head` — только при реальном heterogeneous-TP развертывании и заданном `tp_lcm_size`.
- `page_first_kv_split` вручную не задавайте: вне Ascend-пулов путь переноса для него не определен.

## Влияние на производительность и память

- Суммарный объем host-пула от layout не зависит: он задан `--hicache-ratio`/`--hicache-size` и `size_per_token`.
- Основной эффект — гранулярность IO. Page-ориентированные раскладки дают крупные непрерывные передачи и zero-copy в L3; `layer_first` вынуждает L3-backend собирать страницу из кусков.
- Взаимодействие с `--page-size` прямое: при `page_size 1` преимущество page-раскладок исчезает, потому что страница вырождается в один токен. Апстрим для storage-конфигураций рекомендует `--page-size 64`.
- На время старта влияет только через форму аллокации, различие незначительно.

## Взаимодействие с другими аргументами

- `--hicache-io-backend`: пара нормализуется в `__post_init__`. `page_first` + `direct` → layout становится `page_first_direct`; `page_first_direct` + `kernel` → IO становится `direct`.
- `--hicache-storage-backend mooncake` + `layer_first` → layout меняется на `page_first` (для `kernel`) или `page_first_direct` (для `direct`); при `kernel_ascend` остается прежним.
- `--hicache-storage-backend hf3fs`: размер страницы для backend'а считается по layout — `get_ksize_per_token()` для page-раскладок и `get_size_per_token()` для `layer_first` (`mem_cache/storage/backend_factory.py`).
- `--hicache-storage-backend-extra-config`: ключ `tp_lcm_size` работает только с `page_head`.
- `--page-size`: определяет, насколько крупной получается страница и, соответственно, выигрыш page-раскладок.
- `--enable-hierarchical-cache`: без него значение не читается.

## Типовые проблемы и диагностика

- «Page first layout is not supported with direct IO backend, switching to page first direct layout» — ваш layout заменен; это ожидаемо при `--hicache-io-backend direct`.
- «Mooncake storage backend does not support layer_first layout, switching to … layout for … io backend» — L3 потребовал page-раскладку.
- `ValueError: Unsupported layout: …` из пула хоста или `Unsupported V4 paged host layout/backend: …/…` — выбрана комбинация layout + IO, для которой нет реализации переноса (типично при ручном `page_first_kv_split` вне NPU).
- Ассерт «UMBP store only supports page_first, page_first_direct, or page_head layout» — backend `mori` не принял `layer_first`.
- Итоговый layout смотрите в дампе `server_args=` при старте: он печатается уже после всех автозамен.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --page-size 64 --enable-hierarchical-cache --hicache-ratio 3 --hicache-mem-layout page_first --hicache-io-backend kernel
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V3.2 --page-size 64 --enable-hierarchical-cache --hicache-ratio 2 --hicache-mem-layout page_first_direct --hicache-io-backend direct --hicache-storage-backend mooncake
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/mha.py`
- `sglang/python/sglang/srt/mem_cache/pool_host/mla.py`
- `sglang/python/sglang/srt/managers/cache_controller.py`
- `sglang/python/sglang/srt/mem_cache/storage/backend_factory.py`
- `sglang/python/sglang/srt/mem_cache/storage/umbp/umbp_store.py`
- `sglang/docs/docs/advanced_features/hicache_design.mdx`
- `sglang/docs/docs/advanced_features/hicache_best_practices.mdx`
