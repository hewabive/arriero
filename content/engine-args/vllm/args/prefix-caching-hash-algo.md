---
schema: 1
engine: vllm
primaryName: "--prefix-caching-hash-algo"
title: "--prefix-caching-hash-algo"
summary: Выбирает функцию хэширования блоков для prefix caching. Меняет стоимость хэширования на запрос и воспроизводимость ключей между процессами и языками; безопасность коллизий — отдельный вопрос для мультиарендных установок.
group: CacheConfig
related:
  - --enable-prefix-caching
  - --prefix-match-unit
  - --block-size
  - --kv-transfer-config
---

# --prefix-caching-hash-algo

## Кратко

При включенном prefix caching для каждого блока промпта считается хэш от (хэш родительского блока, токены блока, дополнительные ключи: LoRA-id, хэши мультимодальных входов, cache salt). `--prefix-caching-hash-algo` выбирает саму функцию.

Аргумент читается не только при prefix caching: тот же хэшер строится, если сконфигурирован KV-connector (P/D-дизагрегация, offloading), потому что block hashes — общий ключ для всех этих механизмов.

## Оригинальная справка

```text
Set the hash algorithm for prefix caching:

- "sha256" uses Pickle for object serialization before hashing. This is the current
  default, as SHA256 is the most secure choice to avoid potential hash collisions.
- "sha256_cbor" provides a reproducible, cross-language compatible hash. It
  serializes objects using canonical CBOR and hashes them with SHA-256.
- "xxhash" uses Pickle serialization with xxHash (128-bit) for faster,
  non-cryptographic hashing. Requires the optional ``xxhash`` package.
  IMPORTANT: Use of a hashing algorithm that is not considered  cryptographically
  secure theoretically increases the risk of hash collisions, which can cause
  undefined behavior or even leak private information in multi-tenant environments.
  Even if collisions are still very unlikely, it is important to consider your
  security risk tolerance against the performance benefits before turning this on.
- "xxhash_cbor" combines canonical CBOR serialization with xxHash for
  reproducible hashing. Requires the optional ``xxhash`` package.
```

## Паспорт аргумента

- Флаги: `--prefix-caching-hash-algo`
- Группа argparse: `CacheConfig`
- Тип значения: enum (строка)
- Допустимые значения: `sha256`, `sha256_cbor`, `xxhash`, `xxhash_cbor` (тип `PrefixCachingHashAlgo` в `vllm/config/cache.py`)
- Значение по умолчанию: `sha256`
- Эффективное значение: не переопределяется; но при выключенном prefix caching и отсутствии KV-connector значение вообще не читается
- Где объявлен: `vllm/config/cache.py:CacheConfig.prefix_caching_hash_algo`
- Этап применения: инициализация `EngineCore` — построение `request_block_hasher`; далее на каждом входящем запросе

## Что меняет в движке

`EngineCore.__init__` вызывает `get_hash_fn_by_name(prefix_caching_hash_algo)` и передает результат в `get_request_block_hasher(hash_block_size, caching_hash_fn)`. Различаются две независимые оси.

**Сериализация.** `sha256` и `xxhash` сериализуют объект через `pickle.dumps(..., protocol=HIGHEST_PROTOCOL)`; `*_cbor`-варианты — через `cbor2.dumps(..., canonical=True)`. Pickle зависит от версии Python и от внутреннего представления объектов, каноничный CBOR — нет, поэтому только CBOR-варианты дают одинаковые ключи в разных процессах и на разных языках.

**Дайджест.** SHA-256 (криптографический) против xxHash `xxh3_128` (некриптографический, 128 бит). `xxhash` — опциональная зависимость: если пакет не установлен (или в нем нет `xxh3_128_digest`), при первом же хэшировании поднимается `ModuleNotFoundError: xxhash is required for the 'xxhash' prefix caching hash algorithms. Install it via pip install xxhash.`

Отдельный тонкий момент — начальное значение цепочки. `init_none_hash` берет `PYTHONHASHSEED`: если переменная не задана, `NONE_HASH` заполняется `os.urandom(32)`, то есть ключи не воспроизводятся между запусками. Для CBOR-вариантов при незаданном `PYTHONHASHSEED` дополнительно выводится предупреждение: `PYTHONHASHSEED is not set. This will lead to non-reproducible block-hashes when using CBOR-based hash functions such as sha256_cbor or xxhash_cbor. Consider setting PYTHONHASHSEED to a fixed value for reproducibility.`

## Значения и формат

- `sha256` — pickle + SHA-256. Дефолт, максимальная стойкость к коллизиям, самый дорогой вариант.
- `sha256_cbor` — каноничный CBOR + SHA-256. Воспроизводимый и кроссязыковой ключ при зафиксированном `PYTHONHASHSEED`.
- `xxhash` — pickle + xxh3-128. Заметно дешевле, некриптографический. Требует пакета `xxhash`.
- `xxhash_cbor` — каноничный CBOR + xxh3-128. Дешевый и воспроизводимый. Требует пакета `xxhash`.

## Когда использовать

- `xxhash`/`xxhash_cbor` — когда профиль показывает заметную долю времени в хэшировании: длинные промпты, высокий RPS, мелкие блоки. Апстрим-справка требует осознанно принять риск коллизий: они маловероятны, но их последствие — выдача чужого KV-блока, то есть утечка контекста между запросами.
- `*_cbor` — когда ключи блоков должны совпадать между разными процессами/узлами: внешнее хранилище KV, дизагрегация prefill/decode, кросс-язычные интеграции. Не забудьте зафиксировать `PYTHONHASHSEED`.
- Оставляйте `sha256` на сервере, доступном более чем одному потребителю, если у вас нет измеренной проблемы с производительностью хэширования.
- Не меняйте алгоритм «на горячую» между инстансами, которые делят внешний KV-кэш: ключи не совпадут, и кэш будет холодным.

## Влияние на производительность и память

- **CPU.** Единственный ресурс, который затрагивается: хэширование выполняется на CPU в процессе engine core, на каждый блок каждого нового запроса.
- **VRAM.** Не влияет.
- **Hit rate.** При корректной работе одинаков для всех вариантов; различие возникает только при смене алгоритма на живом внешнем кэше.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--enable-prefix-caching`: при выключенном prefix caching и отсутствии KV-connector значение не читается.
- `--prefix-match-unit` и `--block-size`: определяют, на каких границах считаются хэши, то есть **сколько** раз вызывается выбранная функция. Мелкая гранулярность увеличивает стоимость хэширования — именно тот случай, когда переход на xxhash оправдан.
- `--kv-transfer-config` (и производный от `--kv-offloading-size`): включает хэшер независимо от prefix caching; для внешних хранилищ имеет смысл CBOR-вариант.

## Типовые проблемы и диагностика

- **Симптом:** `ModuleNotFoundError: xxhash is required for the 'xxhash' prefix caching hash algorithms. Install it via pip install xxhash.` **Причина:** опциональный пакет не установлен в окружении. **Лечение:** установить `xxhash` в то же окружение, откуда запускается `vllm serve`, либо вернуться к `sha256`.
- **Симптом:** предупреждение `PYTHONHASHSEED is not set ...` при CBOR-варианте. **Причина:** начальный элемент цепочки хэшей случаен, воспроизводимость теряется. **Лечение:** задать `PYTHONHASHSEED` в окружении процесса.
- **Симптом:** после смены алгоритма внешний KV-кэш перестал давать попадания. **Причина:** ключи блоков считаются иначе. **Лечение:** привести алгоритм к единому значению на всех участниках.
- **Проверка эффекта:** `vllm:prefix_cache_queries` / `vllm:prefix_cache_hits` в `/metrics` и строка `Prefix cache hit rate: X.X%` в периодическом логе — они должны остаться прежними после смены алгоритма на изолированном инстансе.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-prefix-caching --prefix-caching-hash-algo xxhash
```

```bash
vllm serve /models/Qwen3-4B --enable-prefix-caching --prefix-caching-hash-algo sha256_cbor
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/utils/hashing.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/vllm/v1/engine/core.py`
- `vllm/docs/design/prefix_caching.md`
