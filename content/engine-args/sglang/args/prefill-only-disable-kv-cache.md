---
schema: 1
engine: sglang
primaryName: "--prefill-only-disable-kv-cache"
title: "--prefill-only-disable-kv-cache"
summary: Полностью отменяет выделение физических буферов KV-кеша для embedding-нагрузок, где ни один слой не читает и не пишет пул. Работает только в очень узкой комбинации флагов и backend'ов, иначе старт падает с явной ошибкой.
group: schedule
related:
  - --is-embedding
  - --chunked-prefill-size
  - --disable-radix-cache
  - --attention-backend
  - --prefill-attention-backend
  - --kv-cache-dtype
  - --enable-hisparse
  - --attn-cp-size
  - --enable-prefill-cp
  - --page-size
  - --mem-fraction-static
---

# --prefill-only-disable-kv-cache

## Кратко

Для embedding-модели один запрос — это один prefill-проход, после которого KV никому не нужен. Флаг заменяет обычный пул на `NoOpMHATokenToKVPool`: логическая емкость пула для планировщика сохраняется, а физически на слой выделяются заглушки размера `(page_size, head_num, head_dim)` — килобайты вместо гигабайт. Освободившаяся VRAM уходит под веса и активации.

## Оригинальная справка

```text
Skip the physical KV cache allocation for embedding-mode prefill-only workloads. Currently only valid with --is-embedding, --chunked-prefill-size=-1, --disable-radix-cache, an FA prefill backend, and non-FP4 KV cache so the fa_skip_kv_cache path is active (no layer reads or writes the cache). Other prefill-only workloads such as scoring/MIS may benefit from this later once their attention paths stop using paged KV. Scheduler admission accounting is unchanged; per-layer K/V tensors are sized to (page_size, head_num, head_dim) placeholders so GPU memory is not wasted.
```

## Паспорт аргумента

- Флаги: `--prefill-only-disable-kv-cache`
- Группа: `schedule`
- Тип значения: булев флаг (`store_true`), значения не принимает
- Допустимые значения: наличие/отсутствие флага
- Значение по умолчанию: `false`
- Эффективное значение: может быть включен автоматически. Для encoder-архитектур семейства EmbeddingGemma (`Gemma3TextModel` с политикой `FULL_ENCODER`) `_handle_model_capability_adjustments` сам выставляет `is_embedding`, `disable_radix_cache`, `chunked_prefill_size = -1` и, на CUDA sm90/sm100 с запрошенным FA-backend'ом (`None`, `fa3` или `fa4`), включает `prefill_only_disable_kv_cache = True`
- Где объявлен: `ServerArgs.prefill_only_disable_kv_cache`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но намеренно узко ограниченный; апстрим прямо пишет, что другие prefill-only нагрузки (scoring, MIS) будут поддержаны позже
- Этап применения: две фазы валидации в `__post_init__` (`_validate_prefill_only_disable_kv_cache_args` до разрешения backend'ов и `_handle_prefill_only_disable_kv_cache` после) → выбор класса KV-пула при инициализации model runner

## Что меняет в движке

Вместо `MHATokenToKVPool` создается `NoOpMHATokenToKVPool` (`sglang/python/sglang/srt/mem_cache/memory_pool.py`):

- `_create_buffers` выделяет по одному тензору `(page_size, head_num, head_dim)` на слой для K и V — они существуют только чтобы не падали `view()` и арифметика указателей в FA-backend'е;
- `get_kv_size_bytes()` возвращает `(0, 0)`, так что учет памяти вниз по стеку видит реальные нули;
- `set_kv_buffer` намеренно бросает `RuntimeError` — любая попытка реальной записи в пул падает громко, а не тихо портит результат;
- в логе вместо обычной строки о размере пула печатается `KV Cache skipped (no-op pool). Logical #tokens: …, physical K/V size: ~… KB placeholder`.

Учет допуска в планировщике не меняется: `self.size` пула остается прежним, и `PrefillAdder` считает бюджеты так же, как с настоящим пулом.

Корректность держится на том, что FA-backend в embedding-режиме идет по ветке `fa_skip_kv_cache` — считает внимание прямо по сырым K/V через `flash_attn_varlen_func`, ни разу не обращаясь к пулу. Отсюда и весь список предусловий.

Побочный эффект: `prefill_only_disable_kv_cache` входит в число условий, отключающих отдельный оптимизированный путь пула (проверка `if self.prefill_only_disable_kv_cache: return False` в `server_args.py`).

## Значения и формат

Флаг без значения. Ошибки при старте, если предусловия не выполнены (все — `ValueError` с текстом):

- нет `--is-embedding`;
- `--kv-cache-dtype` из числа `nvfp4`, `fp4_mx_block16` (отдельный путь выделения) или `mxfp8` (отдельные буферы масштабов);
- `--chunked-prefill-size` не равен `-1` — иначе K/V пришлось бы переиспользовать между чанками;
- не задан `--disable-radix-cache` — radix cache индексировал бы слоты пула, в которых нет данных;
- `attn_cp_size > 1` или задан `--enable-prefill-cp` — context-parallel prefill пишет K/V в пул;
- задан `--enable-hisparse` — у него собственное семейство пулов;
- разрешенный prefill-backend не `fa3` и не `fa4` (проверяется отдельно, после того как backend'ы окончательно выбраны).

## Когда использовать

- Единственный штатный сценарий: сервер embedding-модели на CUDA (Hopper/Blackwell) с FA-backend'ом, где вы хотите отдать всю VRAM под веса и активации. Для EmbeddingGemma-подобных архитектур включать вручную не нужно — движок сделает это сам.
- Не включайте на генеративной модели: даже если старт пройдет, первый же decode упрется в `RuntimeError` из `set_kv_buffer`.
- Не пытайтесь совместить с prefix caching или chunked prefill — это взаимоисключающие вещи по построению.
- Не рассчитывайте на него для scoring/MIS-нагрузок: их пути внимания пока используют paged KV, и валидация их отклонит.

## Влияние на производительность и память

- VRAM: главный эффект. Физический KV-пул исчезает целиком; вместо него на слой остается пара тензоров на `page_size` токенов. При `--mem-fraction-static` без изменений вся эта память достается весам и активациям.
- Скорость: сама по себе замена пула ничего не ускоряет — путь `fa_skip_kv_cache` активен и без флага, флаг лишь убирает бесполезное выделение.
- Время старта немного сокращается: нет аллокации и обнуления больших буферов.
- RAM хоста не затрагивается.
- Планировщик по-прежнему считает допуск по логической емкости пула, так что конкурентность не меняется.

## Взаимодействие с другими аргументами

- `--is-embedding`: обязателен.
- `--chunked-prefill-size -1`: обязателен (chunked prefill должен быть выключен).
- `--disable-radix-cache`: обязателен.
- `--attention-backend` / `--prefill-attention-backend`: разрешенный prefill-backend должен быть `fa3` или `fa4`.
- `--kv-cache-dtype`: запрещены FP4-варианты и `mxfp8`.
- `--attn-cp-size`, `--enable-prefill-cp`, `--enable-hisparse`: несовместимы.
- `--page-size`: задает размер тензоров-заглушек; на суммарный объем влияет пренебрежимо.
- `--mem-fraction-static`: остается основным регулятором доли памяти под веса; с этим флагом «вторая половина» доли просто не расходуется на KV.

## Типовые проблемы и диагностика

- `--prefill-only-disable-kv-cache currently requires --is-embedding. …` и однотипные сообщения про `--chunked-prefill-size=-1`, `--disable-radix-cache`, FP4/MXFP8, `--attn-cp-size`, `--enable-prefill-cp`, `--enable-hisparse` — предусловия проверяются на старте и называют себя явно.
- `--prefill-only-disable-kv-cache currently requires the FA prefill backend (fa3/fa4), but got prefill backend '…'` — backend был разрешен в другой; уберите явный `--attention-backend` или задайте `fa3`.
- `NoOpMHATokenToKVPool.set_kv_buffer was called. …` в рантайме — нагрузка все-таки пишет в пул; значит, это не чистый embedding-prefill.
- Подтверждение, что флаг сработал: строка `KV Cache skipped (no-op pool). Logical #tokens: …` вместо обычного сообщения о размере KV-пула, плюс поле в дампе `server_args=`.
- Флаг мог включиться сам: для EmbeddingGemma-архитектур ищите в логе `Embedding architecture detected: enabling embedding mode automatically.` и проверяйте `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/embedding-model --is-embedding --disable-radix-cache --chunked-prefill-size -1 --attention-backend fa3 --prefill-only-disable-kv-cache
```

```bash
python -m sglang.launch_server --model-path /models/embedding-model --is-embedding --disable-radix-cache --chunked-prefill-size -1 --prefill-attention-backend fa4 --prefill-only-disable-kv-cache --mem-fraction-static 0.9
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/configs/embedding_model_spec.py`
