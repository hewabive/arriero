---
schema: 1
engine: vllm
primaryName: "--language-model-only"
title: "--language-model-only"
summary: Одним флагом обнуляет лимиты всех модальностей, превращая мультимодальную модель в текстовую: башни энкодера не грузятся, кэш процессора не создаётся, медиа-входы отвергаются.
group: MultiModalConfig
related:
  - --limit-mm-per-prompt
  - --enable-mm-embeds
  - --mm-processor-cache-gb
  - --skip-mm-profiling
  - --gpu-memory-utilization
  - --convert
  - --runner
---

# --language-model-only

## Кратко

`--language-model-only` — сокращение для «поставить `--limit-mm-per-prompt` в 0 по каждой модальности», но без необходимости знать, какие модальности у модели вообще есть. Полезен, когда мультимодальный чекпоинт нужен только как текстовая LLM: веса визуальной/аудио-башни не читаются с диска, профилирование не гоняет энкодер, кэш мультимодального процессора не создаётся.

Парный флаг `--no-language-model-only` возвращает обычное поведение.

## Оригинальная справка

```text
If True, disables all multimodal inputs by setting all modality limits to 0.
Equivalent to setting `--limit-mm-per-prompt` to 0 for every modality.
```

## Паспорт аргумента

- Флаги: `--language-model-only`, `--no-language-model-only`
- Группа argparse: `MultiModalConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует → `True`, `--no-language-model-only` → `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется; на текстовой модели без `multimodal_config` флаг просто ни на что не действует
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.language_model_only`
- Этап применения: сборка `VllmConfig` → загрузка модели (пропуск башен) → профилирование → HTTP-слой

## Что меняет в движке

Значение читается ровно в одном месте — в начале `MultiModalConfig.get_limit_per_prompt()`:

```python
if self.language_model_only:
    return 0
```

Дальше срабатывает вся цепочка, которая и так реагирует на нулевой лимит:

- `SupportsMultiModal._mark_tower_model` оборачивает инициализацию каждой башни в `no_init_weights`, потому что условие `all(get_limit_per_prompt(m) == 0 ...)` истинно для всех. Модули становятся `StageMissingLayer`, их веса не читаются;
- `MULTIMODAL_REGISTRY.supports_multimodal_inputs()` возвращает `False` с логом `All limits of multimodal modalities supported by the model are set to 0, running in text-only mode.` Следствие: рендерер не создаёт мультимодальный процессор, кэш процессора не создаётся вовсе (`_get_cache_type` → `None`), а `--mm-processor-cache-gb` перестаёт что-либо значить;
- `ModelConfig._supports_multimodal_for_mm_prefix()` снимает режим `mm_prefix` внимания (лог `Disabled mm_prefix attention mode because multimodal inputs are configuration-disabled.`), что расширяет список пригодных attention-backend'ов;
- профилирование не строит фиктивный мультимодальный батч — `tower_modalities` пуст;
- `chat_utils` отвергает медиа-части сообщения на валидации количества (`At most 0 image(s) may be provided in one prompt.`).

Само поле `limit_per_prompt` при этом не переписывается: если вы одновременно задали `--limit-mm-per-prompt '{"image": 4}'`, словарь останется в конфиге, но все его читатели увидят 0.

Значение попадает в `ModelConfig.compute_hash` (`factors["language_model_only"]`), поэтому граф компиляции для текстового и мультимодального режима кэшируется раздельно.

## Значения и формат

- Флага нет — `False`, штатное мультимодальное поведение.
- `--language-model-only` — `True`.
- `--no-language-model-only` — явный `False`; нужен, когда значение приходит из `--config file.yaml` и его надо перебить в командной строке.
- Промежуточного состояния нет: это либо «все модальности выключены», либо «лимиты как заданы».

## Когда использовать

- Один чекпоинт обслуживает и мультимодальный, и чисто текстовый инстанс: текстовому ставим `--language-model-only` и получаем меньший футпринт весов без отдельного чекпоинта.
- Нужно локализовать проблему: если ошибка исчезает с `--language-model-only`, она в мультимодальном тракте (процессор, энкодер, encoder cache), а не в языковой части.
- Не используйте, если хоть один клиент шлёт картинки: отказ произойдёт на валидации запроса, а не при старте, то есть найдётся в проде.
- Не используйте вместо `--limit-mm-per-prompt '{"video": 0}'`, когда нужно выключить одну модальность из нескольких: этот флаг выключает всё.

## Влияние на производительность и память

- **VRAM (веса).** Основной выигрыш: веса всех башен энкодера и проектора, помеченных как tower-компоненты, не создаются. На VL-моделях это от сотен мегабайт до нескольких гигабайт.
- **VRAM (активации).** Профилирование не прогоняет энкодер, поэтому его пик не вычитается из бюджета — при том же `--gpu-memory-utilization` KV-cache становится больше.
- **RAM хоста.** Кэш мультимодального процессора не создаётся, `--mm-processor-cache-gb` (по умолчанию 4 GiB на процесс) не тратится.
- **Время старта.** Короче: меньше весов читается с диска, профилировочного прогона энкодера нет.
- **Throughput/latency текстовых запросов.** Не меняются, кроме побочного эффекта от большего KV-cache.

## Взаимодействие с другими аргументами

- `--limit-mm-per-prompt`: полностью перебивается этим флагом; словарь остаётся в конфиге, но не читается.
- `--enable-mm-embeds`: комбинация бессмысленна для приёма эмбеддингов — `supports_multimodal_inputs()` возвращает `True` при `enable_mm_embeds`, но `get_limit_per_prompt` всё равно даёт 0, и путь остаётся embedding-only. Если цель — принимать готовые эмбеддинги без энкодера, штатный способ — `--limit-mm-per-prompt` с нулём по нужной модальности плюс `--enable-mm-embeds`, а не этот флаг.
- `--mm-processor-cache-gb`, `--mm-processor-cache-type`, `--mm-hasher-algorithm`: становятся инертны, кэш не создаётся.
- `--skip-mm-profiling`: избыточен, профилировать всё равно нечего.
- `--gpu-memory-utilization`: бюджет тот же, но освободившееся от энкодера место уходит в KV-cache.
- `--runner`, `--convert`: меняют режим работы модели (generate/pooling), а не набор модальностей; путать не стоит.

## Типовые проблемы и диагностика

- **Симптом:** запросы с картинками падают с `At most 0 image(s) may be provided in one prompt.` **Причина:** инстанс поднят с `--language-model-only`. **Лечение:** снять флаг или направить такие запросы на мультимодальный инстанс.
- **Симптом:** флаг задан, а VRAM не уменьшилась. **Причина:** архитектура не помечает свои визуальные модули как tower-компоненты, либо модель вообще не мультимодальная и `multimodal_config` не создаётся. **Проверка:** в логе должно быть `All limits of multimodal modalities supported by the model are set to 0, running in text-only mode.`; если строки нет — флаг не сработал.
- **Симптом:** после включения флага сменился выбранный attention-backend. **Причина:** снятие `mm_prefix` расширяет список допустимых backend'ов. **Действие:** ожидаемо; при необходимости зафиксировать backend явно.
- **Подтверждение принятого значения:** упомянутая строка про text-only mode плюс отсутствие строки `Encoder cache will be initialized with a budget of ...`.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --language-model-only --gpu-memory-utilization 0.9 --max-model-len 16384
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --no-language-model-only --limit-mm-per-prompt '{"image": 2, "video": 0}'
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/multimodal/registry.py`
- `vllm/vllm/model_executor/models/interfaces.py`
- `vllm/vllm/entrypoints/chat_utils.py`
- `vllm/docs/configuration/conserving_memory.md`
