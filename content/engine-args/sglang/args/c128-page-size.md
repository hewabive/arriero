---
schema: 1
engine: sglang
primaryName: "--c128-page-size"
title: "--c128-page-size"
summary: Задает физическую страницу C128 KV-кеша DeepSeek-V4 на NPU. Значение должно быть положительным и кратным 16; на остальных моделях и устройствах аргумент не участвует в аллокации.
group: schedule
related:
  - --page-size
  - --mem-fraction-static
  - --disaggregation-mode
---

# --c128-page-size

## Кратко

DeepSeek-V4 хранит дополнительное C128-представление KV, где одна позиция соответствует группе из 128 обычных токенов. На NPU это представление имеет собственную физическую страницу; `--c128-page-size` задает число C128-позиций в ней. Дефолт `16` означает гранулярность `128 × 16 = 2048` исходных токенов для sidecar-таблицы запроса.

## Оригинальная справка

```text
The physical page size of the NPU DSV4 C128 KV cache. Must be a positive multiple of 16.
```

## Паспорт аргумента

- Флаги: `--c128-page-size`
- Группа: `schedule`
- Тип значения: целое число
- Значение по умолчанию: `16`
- Где объявлен: `ServerArgs.c128_page_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Этап применения: построение NPU DeepSeek-V4 request/token pools → аллокация и адресация C128 KV → attention и PD-transfer

## Что меняет в движке

`DSV4NPUTokenToKVPool` проверяет значение и передает его как `kernel_page_size` только C128-пулу. `DSV4ReqToTokenTablesMixin` выделяет для каждого request slot sidecar длиной `ceil(max_context_len / (128 * c128_page_size))`; элементы sidecar содержат id физических C128-страниц. Те же границы страниц используются attention-backend'ом и при передаче C128-состояния в PD-disaggregation.

Обычные full/SWA/C4 KV-пулы продолжают использовать свои размеры. CUDA-путь DeepSeek-V4 и модели без DSV4-NPU pool аргумент не читают.

## Значения и формат

Допустимо положительное целое, кратное 16. Проверка выполняется при создании KV-пула; `0`, отрицательное и некратное значение дают `ValueError`. Чем больше страница, тем короче sidecar, но тем грубее гранулярность выделения и освобождения C128 KV.

## Когда использовать

Оставляйте `16`, пока конкретное NPU-ядро или измеренный профиль памяти не требует другой гранулярности. Это аппаратно- и модельно-специфичная ручка, а не замена общему `--page-size`.

## Влияние на производительность и память

Большая страница уменьшает таблицу page ids и число операций с ней, но увеличивает внутреннюю фрагментацию C128-пула на границах запросов. На full KV и веса не влияет. Практический выбор проверяйте по числу доступных KV-токенов, OOM и latency sparse-attention на целевой NPU.

## Взаимодействие с другими аргументами

- `--page-size` задает глобальную страницу full/SWA/C4-пулов; C128 использует отдельное значение.
- `--mem-fraction-static` определяет общий бюджет KV, внутри которого строится C128-пул.
- `--disaggregation-mode`: на NPU decode/prefill C128 page ids входят в отдельный PD payload.

## Типовые проблемы и диагностика

- `c128_page_size must be a positive multiple of 16 ...` — исправьте значение на `16`, `32`, `48` и т. п.
- На CUDA или не-DeepSeek-V4 модели эффект отсутствует — выбран другой класс KV-пула.
- Принятое значение видно в `server_args=`, а реальное использование подтверждает создание `DSV4NPUTokenToKVPool`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4 --c128-page-size 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/hardware_backend/npu/dsv4/dsv4_memory_pool.py`
- `sglang/python/sglang/srt/hardware_backend/npu/dsv4/dsv4_req_to_token_pool.py`
- `sglang/python/sglang/srt/hardware_backend/npu/dsv4/dsv4_common_hooks.py`
- `sglang/python/sglang/srt/hardware_backend/npu/attention/ascend_dsv4_backend.py`

