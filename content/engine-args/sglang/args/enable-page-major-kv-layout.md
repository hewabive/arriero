---
schema: 1
engine: sglang
primaryName: "--enable-page-major-kv-layout"
title: "--enable-page-major-kv-layout"
summary: Переводит KV полного внимания, SWA и состояние Mamba в раскладку «страница снаружи, слои внутри страницы» вместо пер-слойной. Читают такие представления только Triton-ядра, поэтому флаг жестко ограничивает выбор бэкендов.
group: memory
related:
  - --enable-unified-memory
  - --attention-backend
  - --linear-attn-backend
  - --mamba-backend
  - --page-size
  - --speculative-algorithm
---

# --enable-page-major-kv-layout

## Кратко

По умолчанию KV-пул нарезан по слоям: внешняя ось — номер слоя, внутри — слоты. `--enable-page-major-kv-layout` переворачивает это: один непрерывный байтовый буфер, внешняя ось — страница, внутри страницы данные лежат послойно. Такая раскладка нужна unified-пулу (`--enable-unified-memory` включает флаг автоматически), но может быть задана и отдельно. Цена — жесткое ограничение по ядрам: строковые 4-мерные представления читают только Triton-ядра внимания, linear-attn и Mamba, а несколько оптимизированных путей (тайловое копирование KV, CPU-оффлоад, prefix-commit спекуляции) в этом режиме сознательно падают, а не работают с неверными индексами.

## Оригинальная справка

```text
Enable the page-major KV layout: lay out the Mamba state and full/SWA KV caches in a page-granularity envelope (page is the outermost axis, layer-major within a page) instead of the default per-layer (layer-major) layout. Requires the Triton attention / linear-attn / Mamba backends.
```

## Паспорт аргумента

- Флаги: `--enable-page-major-kv-layout`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`)
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false`
- Эффективное значение: принудительно становится `true` при `--enable-unified-memory` (`_handle_page_major_kv_layout`); для draft-воркера в связке с unified-пулом, наоборот, принудительно отключается — draft читает обычную пер-слойную раскладку
- Где объявлен: `ServerArgs.enable_page_major_kv_layout`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный флаг, но узкий по совместимости; список разрешенных бэкендов в коде помечен как результат поэтапного аудита
- Этап применения: `__post_init__` (`_handle_page_major_kv_layout`) → выбор класса KV-пула при инициализации model runner → forward

## Что меняет в движке

Флаг подменяет класс пула: вместо `MHATokenToKVPool` создается `PageMajorMHATokenToKVPool` (`sglang/python/sglang/srt/mem_cache/memory_pool.py`), а состояние Mamba получает «конвертную» раскладку через параметр `mamba_envelope_layout` у req-to-token пула (`mem_cache/kv_cache_configurator.py`).

`PageMajorMHATokenToKVPool` держит все слои и слоты в одном непрерывном `uint8`-буфере; пер-слойные K/V — это 4-мерные строковые представления `(num_pages, page_size, head_num, head_dim*)`. Отображение простое: токен `t` → страница `t // page_size`, слот `t % page_size`; зарезервированный слот-заполнитель 0 лежит в нулевой странице. При `page_size == 1` страница вырождается в один слот.

Класс сознательно отключает часть оптимизаций: тайловое ядро копирования KV предполагает, что шаг равен длине строки, чего строковые представления не гарантируют, поэтому `enable_kv_cache_copy` всегда сбрасывается в `False`, а CPU-оффлоад и prefix-commit спекулятивного декодирования падают явно, а не индексируют буфер неверно.

Проверки бэкендов в `_handle_page_major_kv_layout`:

- полное внимание — только `triton`; исключение сделано для MLA-модели с unified-пулом, где допустимы также `fa3`, `trtllm_mla`, `flashinfer`, `cutedsl_mla`, `tokenspeed_mla` (unified MLA-пул отдает плотные пер-слойные представления);
- linear-attention decode — `triton`, `flashinfer`, плюс `cutedsl` для MLA-гибридов (KDA);
- linear-attention prefill — `triton`, `flashkda`, плюс `cutedsl` для MLA-гибридов;
- Mamba — только `triton` (`--mamba-backend triton` либо не задан).

Есть и обратное влияние: `flashinfer_gdn_prefill_default` (`layers/attention/linear/gdn_backend.py`) не выбирает FlashInfer для GDN-prefill, если page-major включен.

## Значения и формат

- Флаг без аргумента.
- Настроек раскладки нет — это бинарный выбор между пер-слойной и страничной формой.
- Не путайте с `--hicache-mem-layout`: тот описывает раскладку **host-пула** HiCache, а этот — раскладку пулов на устройстве.

## Когда использовать

- Как обязательное следствие `--enable-unified-memory` — там его задавать отдельно не нужно.
- Отдельно — когда вы сознательно работаете на Triton-стеке гибридной модели и хотите страничную раскладку (например, для экспериментов с гранулярностью страниц).
- Не включайте на конфигурации с FA3/FlashInfer в качестве основного бэкенда полного внимания: старт упадет с ассертом.
- Не включайте, если рассчитываете на CPU-оффлоад или на спекулятивное декодирование с prefix-commit — эти пути в page-major режиме отключены.

## Влияние на производительность и память

- Суммарный объем VRAM не меняется: тот же KV, другая раскладка. Аллокация становится одним непрерывным буфером вместо набора пер-слойных тензоров.
- Локальность доступа меняется в пользу постраничных операций: все, что относится к одной странице, лежит рядом.
- Отключение тайлового копирования KV может стоить производительности на путях, где оно раньше работало.
- Ограничение бэкендов — главный практический риск: если Triton на вашей модели медленнее FA3/FlashInfer, page-major обойдется дороже, чем выигрывает.
- На время старта не влияет заметно.

## Взаимодействие с другими аргументами

- `--enable-unified-memory`: включает этот флаг принудительно и расширяет список допустимых бэкендов для MLA-моделей.
- `--attention-backend` (а также `--prefill-attention-backend`/`--decode-attention-backend` через разрешенную пару): вне списка — ассерт «--enable-page-major-kv-layout requires the Triton attention backend for the full-attention layers …».
- `--linear-attn-backend` и его prefill/decode-варианты: наборы допустимых значений различаются для prefill и decode.
- `--mamba-backend`: допустим только `triton` или значение по умолчанию.
- `--page-size`: определяет размер «конверта»; при `page_size 1` страничная раскладка вырождается в токенную.
- `--speculative-algorithm`: prefix-commit путь спекуляции в page-major режиме не поддержан; в связке с unified-пулом дополнительно действует ограничение на `DSPARK`.

## Типовые проблемы и диагностика

- Ассерт «--enable-page-major-kv-layout requires the Triton attention backend for the full-attention layers (unified-memory MLA also allows the paged MLA backends); got [...], allowed [...]» — смените `--attention-backend` на `triton` или снимите флаг.
- Ассерт «--enable-page-major-kv-layout: linear-attention DECODE backend must be one of [...]» / «… PREFILL backend must be one of [...]» — неподдерживаемый linear-attn бэкенд.
- Ассерт «--enable-page-major-kv-layout requires the Triton Mamba kernels for the strided conv/SSM state; got …. Pass --mamba-backend triton.» — неверный mamba-бэкенд.
- Ассерт про делимость `size + page_size` на `page_size` из `PageMajorMHATokenToKVPool._create_buffers` — редкий случай несогласованного сайзинга пула.
- Флаг «включился сам» — вы задали `--enable-unified-memory`; в дампе `server_args=` при старте это видно напрямую.
- Явное падение вместо тихой деградации — ожидаемое поведение: пути, не прошедшие аудит под строковые представления, специально сделаны шумными.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/qwen3-next-hybrid --enable-page-major-kv-layout --attention-backend triton --linear-attn-backend triton --mamba-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/qwen3-next-hybrid --enable-page-major-kv-layout --attention-backend triton --mamba-backend triton --page-size 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/mem_cache/layout/page_major.py`
- `sglang/python/sglang/srt/layers/attention/linear/gdn_backend.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
