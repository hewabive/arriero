---
schema: 1
engine: sglang
primaryName: "--dsa-topk-backend"
title: "--dsa-topk-backend"
summary: Ядро отбора top-k позиций в индексере DSA. Значение `torch` работает только при выключенной переменной `SGLANG_DSA_FUSE_TOPK`, которая по умолчанию включена, — иначе сервер падает на первом же forward.
group: exec.kernel
related:
  - --dsa-prefill-backend
  - --dsa-decode-backend
  - --dsa-paged-mqa-logits-backend
  - --attention-backend
  - --enable-deterministic-inference
  - --page-size
---

# --dsa-topk-backend

## Кратко

Индексер DSA считает логиты «релевантности» по всем позициям, а затем отбирает top-k тех, по которым дальше и считается разреженное внимание. `--dsa-topk-backend` выбирает, чем именно делается этот отбор и последующая трансформация индексов в страничные адреса. По умолчанию `sgl-kernel` — слитое ядро из `sgl_kernel`, которое делает отбор и трансформацию за один запуск. Аргумент значим только для DSA-моделей (DeepSeek V3.2 / V4 / GLM DSA).

## Оригинальная справка

```text
DSA indexer top-k backend. Options: 'sgl-kernel', 'torch', 'flashinfer'. The 'torch' backend currently requires SGLANG_DSA_FUSE_TOPK=false.
```

## Паспорт аргумента

- Флаги: `--dsa-topk-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `sgl-kernel`, `torch`, `flashinfer` (константа `DSA_TOPK_BACKEND_CHOICES`, перечисление `DSATopKBackend` в `sglang/python/sglang/srt/layers/attention/dsa/dsa_topk_backend.py`)
- Значение по умолчанию: `sgl-kernel`
- Эффективное значение: `__post_init__` его не трогает. Но в DeepSeek-V4-индексере (`sglang/python/sglang/srt/layers/attention/dsv4/indexer.py`) есть путь, который жестко использует `DSATopKBackend.SGL_KERNEL` независимо от аргумента, а слитый v2-путь дополнительно требует `SGLANG_OPT_USE_TOPK_V2` (по умолчанию включена)
- Где объявлен: `ServerArgs.dsa_topk_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → конструктор `DeepseekSparseAttnBackend` / `DeepseekV4AttnBackend` → построение метаданных индексера на каждом forward → сам отбор top-k

## Что меняет в движке

`DSATopKBackend` реализует два метода — `topk_func` (чистый отбор) и `topk_transform` (отбор + перевод индексов в адреса страниц), и они ведут себя по-разному:

- **`sgl-kernel`.** `fast_topk_v2` для отбора; в слитом режиме — `fast_topk_transform_fused` / `fast_topk_transform_ragged_fused`. При включенной `SGLANG_OPT_USE_TOPK_V2` decode-образная PAGED-форма уходит в JIT-ядро DeepSeek-V4 `topk_transform_512_v2`, которое читает компактную таблицу страниц напрямую и позволяет вообще не материализовать таблицу с `page_size=1`. Это не «попытка с откатом»: код прямо документирует, что при совпадении формы решение принято окончательно, а fallback на широкую таблицу может быть физически невозможен, потому что ее уже не выделили.
- **`flashinfer`.** `flashinfer.top_k` для отбора и `flashinfer.top_k_page_table_transform` / `top_k_ragged_transform` для трансформации. Учитывает переменные `SGLANG_DSA_TOPK_FLASHINFER_DETERMINISTIC` (детерминированный отбор) и `SGLANG_DSA_TOPK_FLASHINFER_TIE_BREAK` (`small`/`large`, иначе значение 0). Для упакованной PAGED-формы с `row_starts` внутри все равно вызывается `fast_topk_transform_fused` из `sgl_kernel`.
- **`torch`.** `_topk_unfused` поверх `torch.topk`: маскирование по длинам, полный отбор, приведение индексов. Трансформации у него нет — `topk_transform` при включенном слитом режиме бросает `RuntimeError: Unsupported <self> for SGLANG_DSA_FUSE_TOPK.`, и то же делает `_get_fused_topk_page_table`. Поскольку `SGLANG_DSA_FUSE_TOPK` по умолчанию `True`, `--dsa-topk-backend torch` **без** `SGLANG_DSA_FUSE_TOPK=false` приводит к падению на первом же forward, а не к деградации.

## Значения и формат

- `sgl-kernel` — дефолт и единственный вариант, покрывающий все формы (в том числе слитый v2-путь декода).
- `flashinfer` — альтернатива со своими переменными окружения для детерминизма и разрешения ничьих; требует установленного FlashInfer.
- `torch` — отладочный: медленный, без трансформации, требует `SGLANG_DSA_FUSE_TOPK=false`.
- Значение вне списка отвергает argparse.

## Когда использовать

- `flashinfer` — когда нужно управлять правилом разрешения ничьих в top-k (`SGLANG_DSA_TOPK_FLASHINFER_TIE_BREAK`) или детерминированным отбором на уровне ядра.
- `torch` — только для отладки: сверить результат слитого ядра с эталонной реализацией на torch. Обязательно вместе с `SGLANG_DSA_FUSE_TOPK=false`.
- Не трогайте на продакшн-инстансе: дефолт `sgl-kernel` — самый быстрый путь и единственный, у которого есть слитая decode-оптимизация.

## Влияние на производительность и память

- **VRAM.** Слитый v2-путь `sgl-kernel` позволяет не материализовать таблицу страниц с `page_size=1` для decode-формы — это ощутимая экономия на длинном контексте и большом батче. Остальные варианты эту таблицу требуют.
- **Latency.** `torch`-путь делает полный `torch.topk` по всей ширине логитов на каждом слое и каждом шаге — он на порядок дороже слитых ядер.
- **Точность.** Сам отбор top-k детерминирован по значениям, но при равных логитах порядок зависит от реализации; для `flashinfer` это регулируется явно.
- **Время старта.** JIT-компиляция v2-ядра происходит при первом использовании.

## Взаимодействие с другими аргументами

- `--dsa-prefill-backend`, `--dsa-decode-backend`: выбирают ядро самого разреженного внимания; этот флаг — про индексер перед ним.
- `--dsa-paged-mqa-logits-backend`: другое ядро того же индексера, считающее сами логиты.
- `--attention-backend`: значим только при `dsa` (и на DeepSeek V4 — при `dsv4`).
- `--enable-deterministic-inference`: собственных правок этого поля не делает; детерминизм отбора у FlashInfer управляется переменной окружения.
- `--page-size`: слитый v2-путь читает компактную таблицу с шагом `page_size`, что и позволяет отказаться от таблицы с шагом 1.

## Типовые проблемы и диагностика

- **Симптом:** `RuntimeError: Unsupported self = <DSATopKBackend.TORCH: 'torch'> for SGLANG_DSA_FUSE_TOPK.` **Причина:** `torch` при включенном слитом режиме. **Решение:** `SGLANG_DSA_FUSE_TOPK=false` либо вернуть `sgl-kernel`.
- **Симптом:** `ImportError` из `flashinfer` при старте DSA-модели. **Причина:** выбран `flashinfer`, пакет не установлен.
- **Симптом:** `RuntimeError: SGLANG_DSA_TOPK_FLASHINFER_TIE_BREAK must be one of ('small', 'large') or unset`. **Причина:** опечатка в переменной окружения.
- **Симптом:** значение задано, а на DeepSeek V4 ничего не изменилось. **Причина:** часть путей индексера V4 фиксированно использует `sgl-kernel`.
- **Проверка:** дамп `server_args=` при старте показывает значение; фактический путь виден только по поведению (ошибка либо профиль).

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --kv-cache-dtype fp8_e4m3 --dsa-topk-backend flashinfer --page-size 64
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3.2-Exp --kv-cache-dtype bfloat16 --dsa-topk-backend sgl-kernel --page-size 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/dsa/dsa_topk_backend.py`
- `sglang/python/sglang/srt/layers/attention/dsa_backend.py`
- `sglang/python/sglang/srt/layers/attention/dsv4/indexer.py`
- `sglang/python/sglang/srt/environ.py`
