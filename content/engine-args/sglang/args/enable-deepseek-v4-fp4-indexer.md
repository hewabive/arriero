---
schema: 1
engine: sglang
primaryName: "--enable-deepseek-v4-fp4-indexer"
title: "--enable-deepseek-v4-fp4-indexer"
summary: Экспериментальный FP4-путь индексера DeepSeek V4: вдвое уменьшает байты на токен в индексном KV-буфере. Требует SM100 или SM120 — иначе сервер не стартует.
group: exec.kernel
related:
  - --attention-backend
  - --page-size
  - --mem-fraction-static
  - --dsa-topk-backend
  - --dsa-paged-mqa-logits-backend
  - --kv-cache-dtype
---

# --enable-deepseek-v4-fp4-indexer

## Кратко

У DeepSeek V4 индексер держит собственный сжатый KV-буфер (C4), отдельный от основного MLA-пула. По умолчанию он хранится в fp8 с масштабами. Флаг переключает его на FP4 (C4-путь) — экономия ровно вдвое на элементе, плюс другой набор ядер квантования q и записи в буфер. Справка честно называет путь экспериментальным, и код это подтверждает: он появляется только в ветках DeepSeek V4 и жестко ограничен Blackwell.

## Оригинальная справка

```text
Enable the experimental FP4 C4 indexer path for DeepSeek V4. Default keeps the existing indexer implementation.
```

## Паспорт аргумента

- Флаги: `--enable-deepseek-v4-fp4-indexer`
- Группа: `exec.kernel`
- Тип значения: bool (флаг без значения)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но проверяется в `__post_init__`: без SM100/SM120 — `ValueError: --enable-deepseek-v4-fp4-indexer requires SM100 or SM120 GPUs with DeepGEMM FP4 indexer support.`
- Где объявлен: `ServerArgs.enable_deepseek_v4_fp4_indexer`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный по форме, экспериментальный по содержанию (так написано в самой справке); контракт может измениться без предупреждения
- Этап применения: разбор CLI → проверка capability в `__post_init__` → создание индексного KV-пула (`DeepSeekV4TokenToKVPool`) → конструктор `DeepseekV4AttnBackend` → каждый forward индексера

## Что меняет в движке

1. **Размер индексного буфера.** `DeepSeekV4TokenToKVPool.get_bytes_per_token` (`sglang/python/sglang/srt/mem_cache/deepseek_v4_memory_pool.py`) возвращает `index_head_dim // 2 + 4` при включенном флаге против `index_head_dim + 4` по умолчанию. Буфер выделяется на весь пул и на все слои, так что экономия прямая и предсказуемая.
2. **Ядро подготовки q.** Индексер (`sglang/python/sglang/srt/layers/attention/dsv4/indexer.py`) при включенном флаге вызывает `fused_q_indexer_rope_hadamard_fp4_quant` вместо `fused_q_indexer_rope_hadamard_quant`.
3. **Запись в буфер.** Компрессор (`sglang/python/sglang/srt/layers/attention/dsv4/compressor.py`, `compressor_v2.py`) вместо `set_index_k_scale_buffer` / `set_index_k_fused` вызывает `set_index_k_fp4`. Обратите внимание: FP4-ветка приоритетнее оптимизации `SGLANG_OPT_USE_FUSED_STORE_CACHE`, то есть включение флага меняет и путь записи.
4. **Метаданные индексера.** На SM120 `DeepseekV4AttnBackend.init_forward_metadata_indexer` выставляет `force_deep_gemm_metadata=True`, потому что SM120-ядро FP4 планирует `split_kv=128`, а универсальный JIT-планировщик кодирует 256.
5. ROCm-вариант backend'а (`deepseek_v4_backend_hip_radix.py`) поле тоже читает, но проверка capability в `__post_init__` пропустит только SM100/SM120 — то есть на ROCm флаг включить нельзя.

Аргумент значим только для архитектуры DeepSeek V4 (`DeepseekV4ForCausalLM`), для которой движок сам ставит `--attention-backend dsv4` и `--page-size 256` (128 на NPU).

## Значения и формат

- Флаг без аргумента; парной формы `--no-…` нет.
- Не задан — сохраняется существующая fp8-реализация индексера, это состояние по умолчанию и оно же протестированное.
- Задан на не-Blackwell карте — отказ на старте, без деградации.
- Задан на модели, отличной от DeepSeek V4, — проверка capability все равно сработает (она не смотрит на архитектуру), а дальше поле просто не будет прочитано.

## Когда использовать

- Когда вы упираетесь в VRAM именно на индексном буфере DeepSeek V4 и готовы принять экспериментальный путь: у V4 при `--page-size 256` и длинном контексте этот буфер заметен.
- Когда участвуете в тестировании FP4-индексера на Blackwell и сравниваете качество с fp8-путем.
- Не включайте на продакшн-инстансе без собственной проверки качества: FP4 — это еще более грубая квантизация индексных ключей, а от них зависит, какие позиции вообще попадут в разреженное внимание.
- Не включайте «за компанию» с `--kv-cache-dtype nvfp4`: это разные буферы и разные подсистемы.

## Влияние на производительность и память

- **VRAM.** Индексный буфер уменьшается примерно вдвое: с `index_head_dim + 4` до `index_head_dim // 2 + 4` байт на токен на слой. Освободившееся идет в общий бюджет `--mem-fraction-static`, то есть увеличивает `max_total_num_tokens`.
- **Latency.** Меньше трафика памяти при чтении индексного KV — потенциальный выигрыш, но он зависит от того, насколько ядра FP4 отлажены; путь экспериментальный, и измерять надо на своей нагрузке.
- **Точность.** Индексер решает, какие позиции увидит внимание. Ошибка отбора не «немного размывает» ответ, а выбрасывает контекст. Это главный риск флага.
- **Время старта.** DeepGEMM FP4-ядра компилируются JIT.

## Взаимодействие с другими аргументами

- `--attention-backend`: значим только при `dsv4` (движок ставит его сам для DeepSeek V4).
- `--page-size`: для V4 равен 256 (128 на NPU); от него зависит, сколько страниц занимает индексный буфер.
- `--mem-fraction-static`: экономия от флага возвращается в общий бюджет KV.
- `--dsa-topk-backend`, `--dsa-paged-mqa-logits-backend`: другие части того же индексера; FP4-путь на них не завязан напрямую, но работает с их данными.
- `--kv-cache-dtype`: относится к основному MLA-пулу, не к индексному буферу.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: --enable-deepseek-v4-fp4-indexer requires SM100 or SM120 GPUs with DeepGEMM FP4 indexer support.` **Причина:** карта не Blackwell. **Решение:** убрать флаг.
- **Симптом:** флаг включен, а `max_total_num_tokens` не вырос. **Причина:** модель не DeepSeek V4, поле не читается.
- **Симптом:** качество ответов на длинном контексте просело после включения. **Причина:** более грубый индексер отбирает другие позиции. **Решение:** вернуться к дефолту.
- **Проверка:** дамп `server_args=` при старте показывает флаг; эффект на память виден по строке планировщика с `max_total_num_tokens=…`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4 --enable-deepseek-v4-fp4-indexer
```

```bash
python -m sglang.launch_server --model-path /models/DeepSeek-V4 --enable-deepseek-v4-fp4-indexer --mem-fraction-static 0.9
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/deepseek_v4_memory_pool.py`
- `sglang/python/sglang/srt/layers/attention/dsv4/indexer.py`
- `sglang/python/sglang/srt/layers/attention/dsv4/compressor.py`
- `sglang/python/sglang/srt/layers/attention/dsv4/compressor_v2.py`
- `sglang/python/sglang/srt/layers/attention/deepseek_v4_backend.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
