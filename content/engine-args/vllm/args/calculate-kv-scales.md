---
schema: 1
engine: vllm
primaryName: "--calculate-kv-scales"
title: "--calculate-kv-scales"
summary: Устаревший флаг «калибровки на лету» для fp8 KV-cache — масштабы `k_scale`/`v_scale` один раз оцениваются по первому forward-проходу и замораживаются. Апстрим объявил его к удалению; штатный путь — чекпоинт с откалиброванными масштабами или масштаб 1.0.
group: CacheConfig
related:
  - --kv-cache-dtype
  - --kv-cache-dtype-skip-layers
  - --quantization
---

# --calculate-kv-scales

## Кратко

`--calculate-kv-scales` включает динамический расчет масштабов квантования `k_scale`/`v_scale` для fp8 KV-cache: на первом forward-проходе каждый attention-слой берет `max(abs(...))` по своим query/key/value, делит на диапазон формата и на этом навсегда фиксирует масштабы. Апстрим называет этот режим «random token calibration» — калибровка по одному прогревочному батчу.

Аргумент официально deprecated: любой запуск с ним пишет предупреждение об удалении. Штатная альтернатива — чекпоинт с масштабами, откалиброванными на реальном датасете (llm-compressor); без флага и без масштабов в чекпоинте движок использует 1.0. Новые конфигурации на этот флаг завязывать не стоит.

## Оригинальная справка

```text
Deprecated: This option is deprecated and will be removed in v0.19.
It enables dynamic calculation of `k_scale` and `v_scale` when
kv_cache_dtype is fp8. If `False`, the scales will be loaded from the model
checkpoint if available. Otherwise, the scales will default to 1.0.
```

## Паспорт аргумента

- Флаги: `--calculate-kv-scales`, парный `--no-calculate-kv-scales` (`argparse.BooleanOptionalAction`)
- Группа argparse: `CacheConfig`
- Тип значения: bool
- Значение по умолчанию: `false` — масштабы берутся из чекпоинта, иначе 1.0
- Где объявлен: `vllm/config/cache.py:CacheConfig.calculate_kv_scales`
- Статус: deprecated. Справка обещает удаление в v0.19, но в стабильном релизе v0.27.1 флаг все еще принимается — заявленная версия удаления уже позади, так что исчезнуть он может в любом следующем релизе; наличие проверяется через `vllm serve --help` в конкретном окружении
- Эффективное значение: движок сам гасит флаг в ряде случаев — для гибридных моделей с рекуррентными слоями (Mamba/GDN/SSM, `vllm/model_executor/models/config.py`), для слоя, чей чекпоинт уже содержит `q_scale` (`vllm/model_executor/layers/quantization/kv_cache.py`), для per-token-head форматов KV-cache (масштабы там считает kernel при каждой записи), для слоев из `--kv-cache-dtype-skip-layers` и при подхвате fp8-схемы из `quantization_config` чекпоинта при `--kv-cache-dtype auto`
- Этап применения: разбор CLI → `CacheConfig` (здесь же deprecation-предупреждение) → флаг копируется в каждый attention-слой при конструировании модели → фактический расчет на первом forward-проходе, после чего флаг слоя сбрасывается

## Что меняет в движке

Значение попадает в `CacheConfig.calculate_kv_scales` и оттуда разносится по трем местам:

- каждый слой `Attention`/`MLAAttention` запоминает его при инициализации (`vllm/model_executor/layers/attention/attention.py`, `mla_attention.py`);
- `gpu_model_runner` держит собственную копию: на тот проход, где масштабы еще не посчитаны, он принудительно ставит `cudagraph_mode = NONE` (расчет — динамическая операция, несовместимая с захватом CUDA graph), после первого прохода сбрасывает копию;
- загрузчик масштабов (`vllm/model_executor/layers/quantization/kv_cache.py`) при взведенном флаге пропускает чтение `k_scale`/`v_scale` из чекпоинта — считать их будут на лету.

Сам расчет — custom op `maybe_calc_kv_scales` в начале `forward` слоя: `_q_scale = max(abs(query)) / q_range`, аналогично для key и value, затем `self.calculate_kv_scales = False`. Масштабы считаются ровно один раз по первому попавшемуся батчу и дальше не пересматриваются.

При `false` (по умолчанию) масштабы для квантованного KV-cache загружаются из чекпоинта; если их там нет — 1.0, о чем для fp8_e4m3 движок предупреждает отдельной строкой (`Using KV cache scaling factor 1.0 for fp8_e4m3...`).

## Значения и формат

- Не задан = `--no-calculate-kv-scales` = `false`: масштабы из чекпоинта, иначе 1.0.
- `--calculate-kv-scales`: однократная калибровка по первому проходу.
- Смысл флаг имеет только вместе с fp8-семейством `--kv-cache-dtype`; сочетание с неквантованным кешем движок не отклоняет, но масштабам там нечего масштабировать.

## Когда использовать

Не использовать в новых конфигурациях — флаг deprecated и держится на честном слове. Он оставался быстрым способом получить хоть какие-то масштабы для fp8 KV-cache у модели без калиброванного чекпоинта, когда точность с масштабом 1.0 заметно проседала. Сегодня рекомендованный апстримом путь (`vllm/docs/features/quantization/quantized_kvcache.md`) — откалибровать масштабы датасетом через llm-compressor и положить их в чекпоинт; калибровка по одному случайному батчу — самый грубый из трех вариантов.

## Влияние на производительность и память

На память не влияет: масштабы — скаляры на слой. По скорости — первый forward-проход выполняется без CUDA graphs (медленнее обычного), дальше расчетов нет. Основная плата — качество: масштабы, снятые с одного нерепрезентативного батча, могут быть хуже и калиброванных, и даже 1.0, и исправить их без перезапуска нельзя.

## Взаимодействие с другими аргументами

- `--kv-cache-dtype`: флаг осмыслен только для fp8-семейства. Для per-token-head форматов (`fp8_per_token_head` и подобных) масштабы считаются kernel'ом при каждой записи в кеш и флаг игнорируется. Если при `auto` fp8-схема KV-cache подхватывается из `quantization_config` чекпоинта, движок сам выключает расчет — масштабы уже есть в чекпоинте.
- `--kv-cache-dtype-skip-layers`: пропущенные слои остаются в родном dtype, и расчет масштабов для них отключается.
- `--quantization` и квантованные чекпоинты: чекпоинт с готовыми масштабами (в том числе `q_scale`) — прямая замена этого флага; при наличии `q_scale` в чекпоинте движок гасит расчет для слоя.

## Типовые проблемы и диагностика

- **Симптом:** при старте строка `The --calculate-kv-scales option is deprecated and will be removed in v0.19...`. **Причина:** флаг принят и работает, но объявлен к удалению. **Лечение:** переехать на чекпоинт с калиброванными масштабами и убрать флаг.
- **Симптом:** `Disabling calculate_kv_scales for hybrid model ...` в логе. **Причина:** у гибридных моделей с рекуррентными слоями неинициализированное состояние портит калибровку, движок принудительно возвращает масштаб 1.0. **Лечение:** флаг для таких моделей бесполезен, убрать.
- **Симптом:** без флага при `--kv-cache-dtype fp8` предупреждение `Using KV cache scaling factor 1.0 for fp8_e4m3`. **Причина:** в чекпоинте нет масштабов. **Лечение:** либо чекпоинт с калиброванными масштабами, либо осознанно принять 1.0; включение этого флага — временная затычка, а не решение.
- **Симптом:** качество генерации с fp8 KV-cache нестабильно между рестартами при включенном флаге. **Причина:** масштабы зависят от содержимого первого батча. **Лечение:** калибровка датасетом через llm-compressor.

## Примеры

```bash
vllm serve /models/Qwen3-4B --kv-cache-dtype fp8 --calculate-kv-scales
```

```bash
vllm serve /models/Qwen3-4B --kv-cache-dtype fp8 --no-calculate-kv-scales
```

## Источники

- `vllm/vllm/config/cache.py`
- `vllm/vllm/model_executor/layers/attention/attention.py`
- `vllm/vllm/model_executor/layers/attention/mla_attention.py`
- `vllm/vllm/model_executor/layers/quantization/kv_cache.py`
- `vllm/vllm/model_executor/models/config.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/docs/features/quantization/quantized_kvcache.md`
