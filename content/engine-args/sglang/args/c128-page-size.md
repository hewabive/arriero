---
schema: 1
engine: sglang
primaryName: "--c128-page-size"
title: "--c128-page-size"
summary: Физический размер страницы C128-пула сжатого KV-кеша DeepSeek-V4 на NPU Ascend — положительное кратное 16, по умолчанию 16. На CUDA- и CPU-хостах аргумент инертен, размер C128-страницы там выводится из `--page-size`.
group: schedule
related:
  - --page-size
  - --attention-backend
  - --mem-fraction-static
---

# --c128-page-size

## Кратко

`--c128-page-size` задает размер физической страницы C128-пула — той части KV-кеша DeepSeek-V4 (DSV4), где хранятся записи со степенью сжатия 128 (одна C128-запись покрывает 128 токенов модели). Аргумент читается ровно одним кодовым путем: NPU-реализацией DSV4-пула в `hardware_backend/npu/dsv4/`, которая активируется только при `is_npu()` и модели DeepSeek-V4. На CUDA размер C128-страницы не настраивается этим флагом, а выводится как `page_size // 128` из глобального `--page-size`. Для arriero это означает: в профиле SGLang-KT (GPU/CPU, без Ascend NPU) аргумент можно передать, но ни один потребитель его не прочитает — он инертен.

## Оригинальная справка

```text
The physical page size of the NPU DSV4 C128 KV cache. Must be a positive multiple of 16.
```

## Паспорт аргумента

- Флаги: `--c128-page-size`, алиасов нет
- Группа: `schedule`
- Тип значения: целое (`int`)
- Допустимые значения: `choices` нет; runtime-валидация требует положительное кратное 16 (`16`, `32`, `48`, ...), и срабатывает она только на NPU-пути
- Значение по умолчанию: `16` — литерал в декларации; ни один `_handle_*` в `__post_init__` его не переписывает, так что объявленный default здесь равен эффективному (для SGLang это редкость)
- Где объявлен: `ServerArgs.c128_page_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI → без пост-обработки → конструктор `DSV4NPUTokenToKVPool` (валидация и передача в C128-пул) и `DSV4NPUReqToTokenPool._init_dsv4_tables` (размер sidecar-таблицы) при инициализации KV-пула

Аргумент новый: добавлен коммитом `b83d507cd7` от 2026-08-17 (PR #33676, «[NPU] Support DeepSeek-V4 DSpark and refactor DSV4 cache management»). Закрепленная в arriero сборка `sglang-kt` может его не содержать — проверяйте по `--help` установленного пакета или по каталогу аргументов arriero, который строится из `--help` реального окружения.

## Что меняет в движке

KV-кеш DeepSeek-V4 в SGLang устроен ступенчато: часть слоев держит полный KV, часть — сжатый со степенью 4 (c4-пул) и часть — со степенью 128 (c128-пул), где одна запись представляет 128 токенов контекста. На NPU Ascend этот c128-пул получает **собственный** физический размер страницы, независимый от глобального `--page-size`:

- `DSV4NPUTokenToKVPool.__init__` (`hardware_backend/npu/dsv4/dsv4_memory_pool.py`) читает `get_schedule().c128_page_size`, валидирует «положительное кратное 16» и в `_make_kv_pool` передает его как `kernel_page_size` только для c128-пула; full/SWA-пулы используют глобальный page size, c4 — свой нативный.
- `DSV4NPUReqToTokenPool._init_dsv4_tables` (`dsv4_req_to_token_pool.py`) заводит per-request sidecar-таблицу `req_to_c128_sidecar`: одна колонка на группу из `128 * c128_page_size` токенов контекста. Через нее attention backend и аллокатор находят физические C128-страницы запроса.
- Аллокатор (`dsv4_allocator.py`) управляет C128-страницами с per-page refcount'ами: страницы удерживаются, пока на них ссылается хоть один запрос или radix cache, и освобождаются при обнулении счетчика.
- Компонент Unified Radix Cache (`c128_sidecar_component.py`) отдает в префикс-дерево **только целиком заполненные** физические C128-страницы; неполная хвостовая страница остается собственностью запроса и в переиспользование не попадает.
- Ascend attention backend (`ascend_dsv4_backend.py`) строит page table для c128-слоев группировкой по `c128_page_size`; PD-disaggregation на Ascend передает C128-страницы теми же группами (`dsv4_common_hooks.py:c128_kv_pages`).

Вне этого пути значение никто не читает: на CUDA и в Triton-ядрах DSV4 (`mem_cache/deepseek_v4_memory_pool.py`, `kernels/ops/attention/dsv4/metadata_kernel.py`) одноименная локальная переменная вычисляется как `page_size // 128` и с флагом не связана.

## Значения и формат

Целое число C128-записей на физическую страницу. Требование движка — положительное кратное 16; оно проверяется не argparse'ом, а конструктором NPU-пула, поэтому невалидное значение на NPU роняет старт, а на любой другой платформе молча проходит (валидатор просто не вызывается). Одна страница покрывает `128 * c128_page_size` токенов контекста: `16` → 2048 токенов, `32` → 4096. Значений «выключить» нет: `0` и отрицательные — это ошибка на NPU и no-op в остальных случаях.

## Когда использовать

Только на хосте с Ascend NPU, обслуживающем модель DeepSeek-V4 (гейт — `_is_npu and is_deepseek_v4(...)` в `mem_cache/kv_cache_configurator.py`). Это ручка гранулярности пейджинга C128-кеша: значение по умолчанию `16` — минимально допустимое и самое мелкозернистое. В профиле arriero SGLang-KT (CUDA GPU + CPU-оффлоад через kt-kernel) аргумент трогать незачем — он инертен, и задавать его в инстансе не нужно даже «на всякий случай»: это лишь маскирует реальную конфигурацию.

## Влияние на производительность и память

Все эффекты — только на NPU DSV4-пути; в остальных конфигурациях влияния нет вовсе.

- Общий объем C128-пула аргумент не меняет (тот задается конфигуратором KV-кеша) — меняется только нарезка на страницы: больше страница ⇒ меньше страниц и меньше колонок в `req_to_c128_sidecar` (int32-таблица размером `max_requests × max_context_len / (128 * c128_page_size)`).
- Гранулярность переиспользования префикса: radix cache делит только целые страницы, поэтому шаг совпадения по c128-слоям равен `128 * c128_page_size` токенов. Крупная страница снижает долю префикса, которую можно разделить между запросами.
- Внутренняя фрагментация: хвост последовательности занимает страницу целиком, так что средний перерасход на запрос растет с размером страницы.
- Требование кратности 16 идет от NPU-оператора sparse attention (формулировка ошибки в `dsv4_memory_pool.py`); измеренных данных о влиянии размера страницы на скорость самого оператора в коде и документации checkout'а нет — это проверяется только бенчмарком на Ascend-железе.

## Взаимодействие с другими аргументами

- `--page-size` — глобальный размер страницы KV-пула. На NPU DSV4 он продолжает управлять full/SWA-пулами, а c128-пул отвязывается на `--c128-page-size`; на CUDA c128-страница жестко равна `page_size // 128` и этим флагом не управляется.
- `--attention-backend` — NPU-путь DSV4 работает через backend `ascend` (`ascend_dsv4_backend.py`); гейт самого пула, впрочем, платформенный (`is_npu()`), а не по имени backend'а.
- `--mem-fraction-static` — определяет бюджет KV-пула в целом; `--c128-page-size` лишь нарезает уже выделенную c128-часть.
- Архитектура модели: аргумент осмыслен только для DeepSeek-V4; для любой другой модели он инертен на всех платформах.

## Типовые проблемы и диагностика

- Значение принято: итоговый дамп `server_args=` при старте (`logger.info(f"{server_args=}")` в `sglang/python/sglang/srt/entrypoints/engine.py`) показывает `c128_page_size=<N>`.
- Невалидное значение на NPU: старт падает на инициализации KV-пула с `ValueError: c128_page_size must be a positive multiple of 16 for the NPU sparse-attention operator, got <N>` (`dsv4_memory_pool.py`). Лечится значением, кратным 16.
- Задали на CUDA/CPU и «ничего не изменилось» — это ожидаемо: вне NPU DSV4-пути значение не читается, ошибок не будет.
- Флага нет в `--help` установленного пакета: сборка старше коммита `b83d507cd7`; argparse ответит `unrecognized arguments: --c128-page-size`. Уберите аргумент или обновите пакет.

## Примеры

Сервер DeepSeek-V4 на Ascend NPU с дефолтной страницей (16 записей = 2048 токенов на страницу):

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V4 --attention-backend ascend
```

Укрупнить C128-страницу вдвое (32 записи = 4096 токенов), сократив sidecar-таблицу ценой более грубого переиспользования префикса:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V4 --attention-backend ascend --c128-page-size 32
```

Проверить, что установленный пакет вообще знает этот флаг:

```bash
python -m sglang.launch_server --help
```

## Источники

- `sglang/python/sglang/srt/server_args.py` — декларация `ServerArgs.c128_page_size` (группа `schedule`, default `16`)
- `sglang/python/sglang/srt/hardware_backend/npu/dsv4/dsv4_memory_pool.py` — валидация «положительное кратное 16», передача `kernel_page_size` в c128-пул
- `sglang/python/sglang/srt/hardware_backend/npu/dsv4/dsv4_req_to_token_pool.py` — sidecar-таблица `req_to_c128_sidecar`, группа = `128 * c128_page_size` токенов
- `sglang/python/sglang/srt/hardware_backend/npu/dsv4/dsv4_allocator.py` — постраничный аллокатор c128 с refcount'ами
- `sglang/python/sglang/srt/hardware_backend/npu/dsv4/c128_sidecar_component.py` — radix cache делит только целые физические C128-страницы
- `sglang/python/sglang/srt/hardware_backend/npu/dsv4/dsv4_common_hooks.py` — передача C128-страниц в PD-disaggregation
- `sglang/python/sglang/srt/hardware_backend/npu/attention/ascend_dsv4_backend.py` — построение c128 page table в Ascend backend
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py` — платформенный гейт `is_npu()` + DeepSeek-V4
- `sglang/python/sglang/srt/mem_cache/deepseek_v4_memory_pool.py` — CUDA-путь: c128-страница выводится из `--page-size`, флаг не читается
- PR upstream: https://github.com/sgl-project/sglang/pull/33676 (коммит `b83d507cd7`, вводит аргумент и NPU-рефакторинг DSV4-кеша)
- Документы arriero: `docs/KTRANSFORMERS_OPERATIONS.md` (профиль SGLang-KT — GPU/CPU, аргумент там инертен)
