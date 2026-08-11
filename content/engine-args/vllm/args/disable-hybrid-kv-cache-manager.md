---
schema: 1
engine: vllm
primaryName: "--disable-hybrid-kv-cache-manager"
title: "--disable-hybrid-kv-cache-manager"
summary: Отключает раздельный учет KV-cache для разнотипных слоев внимания (full attention плюс sliding window и т. п.), заставляя выделять всем слоям одинаковый объем. Трехпозиционный: не задан — движок решает сам, и на гибридных моделях выключение стоит заметной VRAM.
group: SchedulerConfig
related:
  - --kv-transfer-config
  - --disable-sliding-window
  - --max-model-len
  - --gpu-memory-utilization
  - --block-size
  - --mamba-block-size
  - --enable-prefix-caching
  - --speculative-config
---

# --disable-hybrid-kv-cache-manager

## Кратко

У современных моделей слои внимания разнородны: часть — full attention, часть — sliding window, chunked local attention или Mamba/SSM состояние. Hybrid KV cache manager (HMA) учитывает это и выделяет каждой группе слоев ровно столько блоков, сколько ей нужно, освобождая KV за пределами окна. Отключение HMA приводит все спецификации к одному типу — sliding-window-слои получают полный KV наравне с full-attention слоями.

Это трехпозиционный аргумент: `None` (по умолчанию) означает «решит движок по конфигурации», и в норме решение — «HMA включен».

## Оригинальная справка

```text
If set to True, KV cache manager will allocate the same size of KV cache
for all attention layers even if there are multiple type of attention layers
like full attention and sliding window attention.
If set to None, the default value will be determined based on the environment
and starting configuration.
```

## Паспорт аргумента

- Флаги: `--disable-hybrid-kv-cache-manager`, `--no-disable-hybrid-kv-cache-manager`
- Группа argparse: `SchedulerConfig`
- Тип значения: bool, объявленный как `bool | None` (`action: argparse.BooleanOptionalAction`)
- Допустимые значения: не ограничены сверх пары флагов; «не задан» — отдельное третье состояние
- Значение по умолчанию: `None`
- Эффективное значение: вычисляется в `VllmConfig.__post_init__`. Из `None` получается `True`, если платформа не поддерживает гибридный KV (`current_platform.support_hybrid_kv_cache()`), либо модель использует chunked local attention (кроме случая `VLLM_ALLOW_CHUNKED_LOCAL_ATTN_WITH_HYBRID_KV_CACHE=1`), либо выбранный KV-connector не объявляет поддержку HMA; иначе `False`
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.disable_hybrid_kv_cache_manager`
- Этап применения: сборка `VllmConfig` → построение групп KV-cache (`get_kv_cache_groups`) до выделения памяти

## Что меняет в движке

При истинном значении `get_kv_cache_groups()` (`vllm/v1/core/kv_cache_utils.py`) сначала вызывает `unify_hybrid_kv_cache_specs()`, которая приводит спецификации слоев к одному типу: `SlidingWindowSpec` повышается до `FullAttentionSpec`. Дальше все слои попадают в одну однородную группу, и каждый получает KV на всю длину `max_model_len`.

Для гибридной модели это фиксируется предупреждением:

```text
Hybrid KV cache manager is disabled for this hybrid model, This means we do not
enable any optimizations for saving KV cache memory (e.g., dropping the KV cache
outside the sliding window). The compute of layers like sliding window is still saved.
```

То есть экономия **вычислений** на sliding-window слоях сохраняется, теряется только экономия памяти. Для однородной модели `unify_hybrid_kv_cache_specs()` выходит сразу, и флаг не наблюдаем.

Значение читают и KV-коннекторы (`vllm/distributed/kv_transfer/kv_connector/`): NIXL, Mooncake и `MultiConnector` ветвятся по нему при построении метаданных передачи.

## Значения и формат

- **Не задан (`None`)** — движок сам решает; в обычной CUDA-конфигурации без коннекторов результат — HMA включен.
- **`--disable-hybrid-kv-cache-manager`** — жесткое отключение, оно всегда уважается и никаких проверок не вызывает.
- **`--no-disable-hybrid-kv-cache-manager`** — жесткое требование HMA. Если runtime-условия его не допускают, старт падает с `ValueError`, а не деградирует молча.

## Когда использовать

- **Отключать** имеет смысл только как обход конкретной проблемы: подозрение на баг в раздельном учете групп, несовместимость с внешним KV-коннектором, воспроизведение поведения старой версии. Цена — потеря KV-памяти на гибридной модели.
- **Явно требовать** (`--no-disable-hybrid-kv-cache-manager`) полезно на управляемом сервере, где важно поймать регрессию: если новая версия движка или новый коннектор начнет отключать HMA сам, вы получите ошибку старта вместо тихой потери половины KV-cache.
- Гибридным SSM-моделям (Jamba, Bamba и подобным) HMA **необходим** — предупреждение в `KVConnectorFactory` прямо говорит, что без него они падают на старте.

## Влияние на производительность и память

- **VRAM.** Основной эффект. На модели со sliding window отключение HMA заставляет каждый такой слой держать KV на всю `max_model_len` вместо длины окна; фактическая емкость KV-cache в токенах падает пропорционально доле таких слоев. Наблюдается по строке `GPU KV cache size: N tokens, Maximum concurrency for M tokens per request: X.XXx`.
- **Throughput.** Падает косвенно, через уменьшение `Maximum concurrency` и рост числа вытеснений.
- **Compute.** Не меняется: sliding-window слои по-прежнему считают внимание только по окну.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--kv-transfer-config`: главный источник авто-отключения. Если выбранный коннектор не реализует `SupportsHMA`, движок при `None` выключит HMA с подробным предупреждением; при `--no-disable-hybrid-kv-cache-manager` это станет ошибкой.
- `--disable-sliding-window`: убирает sliding-window слои как класс, после чего отключение HMA перестает что-либо стоить.
- `--max-model-len`: определяет, сколько именно памяти теряется — без HMA каждый sliding-window слой резервируется на полную длину.
- `--gpu-memory-utilization`, `--block-size`, `--mamba-block-size`: вместе с этим флагом определяют итоговое число блоков и размер страницы.
- `--speculative-config`: связка chunked local attention + EAGLE — одно из условий, по которым HMA отключается автоматически.
- `--enable-prefix-caching`: работает и с HMA, и без него; отключение HMA не отключает префиксное кэширование.

## Типовые проблемы и диагностика

- **Симптом:** `Hybrid KV cache manager was explicitly enabled but is not supported in this configuration. Consider omitting the --no-disable-hybrid-kv-cache-manager flag to let vLLM decide automatically.` **Причина:** явное требование HMA при несовместимой конфигурации. **Лечение:** убрать явный флаг и посмотреть, какое именно условие сработало.
- **Симптом:** после подключения `--kv-transfer-config` резко упала емкость KV-cache. **Проверка:** предупреждение `Turning off hybrid kv cache manager because --kv-transfer-config selects a KV connector that does not support it.` **Лечение:** сменить коннектор либо принять потерю памяти.
- **Симптом:** в логе `Hybrid KV cache manager is disabled for this hybrid model ...` **Причина:** HMA отключен (явно или авто), модель гибридная. **Проверка:** сравните `GPU KV cache size` с запуском без флага.
- **Симптом:** предупреждение `There is a latency regression when using chunked local attention with the hybrid KV cache manager. Disabling it, by default.` **Причина:** штатное авто-отключение для chunked local attention. **Лечение:** при желании включить обратно — переменная окружения `VLLM_ALLOW_CHUNKED_LOCAL_ATTN_WITH_HYBRID_KV_CACHE=1` (это переменная окружения, а не CLI-аргумент).
- **Проверка принятого значения:** отдельной строки «HMA enabled» нет. Наблюдаемое следствие — величина `GPU KV cache size` и отсутствие предупреждения об унификации спецификаций.

## Примеры

```bash
vllm serve /models/gemma-3-12b-it --no-disable-hybrid-kv-cache-manager --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/gemma-3-12b-it --disable-hybrid-kv-cache-manager --max-model-len 8192
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
- `vllm/vllm/distributed/kv_transfer/kv_connector/factory.py`
- `vllm/vllm/distributed/kv_transfer/kv_connector/v1/nixl/base_scheduler.py`
- `vllm/vllm/envs.py`
