---
schema: 1
engine: sglang
primaryName: "--trust-mm-content-hashes"
title: "--trust-mm-content-hashes"
summary: Разрешает preprocess cache доверять переданному клиентом SHA-256 и обслуживать hot hit без чтения media bytes. Включать можно только за доверенным шлюзом, который связывает hash с неизменяемым содержимым; ложный hash способен вернуть artifact другого media object.
group: mm
related:
  - --mm-preprocess-cache-size-mb
  - --allowed-media-domains
  - --media-url-max-file-size-mb
---

# --trust-mm-content-hashes

## Кратко

По умолчанию caller-provided `content_hash` служит проверяемым ожиданием: SGLang читает media, вычисляет SHA-256 и сравнивает значения до cache lookup. Флаг разрешает оптимистичный fast path: если по переданному hash уже есть совместимый preprocess artifact, media URL/bytes вообще не читаются.

Доверие экономит I/O только на hot hit. На miss SGLang всё равно снимает snapshot, вычисляет digest и отвергает несовпадение. Риск находится именно в попадании: злоумышленник, знающий hash кешированного объекта, может указать другой URL и получить старый artifact.

## Оригинальная справка

```text
Trust caller-provided multimodal SHA-256 content hashes. This can skip reading media on a hot metadata-cache hit; only enable it when the caller guarantees that hashes identify immutable media bytes.
```

## Паспорт аргумента

- Флаги: `--trust-mm-content-hashes`
- Группа: `mm`
- Тип значения: bool, флаг без значения
- Значение по умолчанию: `false`
- Где объявлен: `ServerArgs.trust_mm_content_hashes`
- Этап применения: нормализация request hashes в tokenizer manager → artifact-cache fast lookup до media snapshot/download → обычная hash verification на miss

## Что меняет в движке

`TokenizerManager._normalize_mm_content_hashes` объединяет отдельное поле `mm_content_hashes` и inline `content_hash` из image URL object. Формат нормализуется к lowercase `sha256:<64 hex digits>`; число hashes обязано совпадать с числом images, а два одновременно заданных источника не могут конфликтовать.

`MediaArtifactCacheMixin.prepare_media_artifacts` при включённом trust строит artifact key прямо из caller hash, modality, processor fingerprint и preprocess kwargs. Совместимый hit возвращается до `snapshot_media_source`, то есть удалённый URL не скачивается. При отсутствии entry код переходит на обычный путь, читает содержимое и требует точного совпадения caller hash с вычисленным digest.

В текущем checkout artifact-cache opt-in реализован у Kimi-K3 image processor. Флаг не превращает остальные multimodal processors в content-addressed cache автоматически.

## Значения и формат

- Флаг без значения; `false` означает обязательную проверку media bytes даже при предоставленном hash.
- Принимается только строка `sha256:` и ровно 64 hex-цифры; регистр hex нормализуется.
- Hash идентифицирует **исходное media content**, не готовый feature tensor. `mm_hashes` — другой API и продолжает идентифицировать processor output/prefix-cache key.
- Без включённого preprocess cache флаг почти ничего не ускоряет: hot entry отсутствует.

## Когда использовать

- Включайте за собственным authenticated gateway/content store, который сам вычисляет hash по bytes и гарантирует immutable object по этому идентификатору.
- Полезно для повторных больших remote images: hot hit пропускает download, decode и preprocessing.
- Не включайте на публичном API, где клиент может независимо выбирать URL и hash.
- Не используйте как замену `--allowed-media-domains` и download-size limit: на cache miss сеть всё равно читается.

## Влияние на производительность и память

На hot hit уменьшаются network traffic, CPU hashing/decode и TTFT. На miss стоимость почти та же, что без флага, потому что bytes всё равно snapshot'ятся и проверяются. Сам bool дополнительную память не резервирует; объём entries задаёт `--mm-preprocess-cache-size-mb`.

## Взаимодействие с другими аргументами

- `--mm-preprocess-cache-size-mb` создаёт cache, ради которого существует fast path; `0` отключает retention.
- `--allowed-media-domains` и `--media-url-max-file-size-mb` применяются на miss. На trusted hot hit URL не читается, поэтому сетевые проверки не запускаются — это ещё одна причина доверять только корректному hash issuer.

## Типовые проблемы и диагностика

- `content_hash must use the form 'sha256:<64 hex digits>'` / `must contain exactly 64 ...` — неверный формат.
- `content hash mismatch for media_data[i]` — cache miss заставил прочитать media, и bytes не совпали с обещанным SHA-256.
- `Conflicting content hashes for image_data[i]` — inline hash и `mm_content_hashes` различаются.
- Стартовая строка preprocess cache заканчивается `caller content hashes are trusted` при включённом флаге и `verified` по умолчанию.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Kimi-K3-Instruct --mm-preprocess-cache-size-mb 256 --trust-mm-content-hashes --allowed-media-domains media.internal.example
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/io_struct.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/multimodal/cache/identity.py`
- `sglang/python/sglang/srt/multimodal/media_artifacts/base.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/multimodal/processors/kimi_k3.py`
