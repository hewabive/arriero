---
schema: 1
engine: vllm
primaryName: "--enable-mixed-moe-lora-format"
title: "--enable-mixed-moe-lora-format"
summary: Заставляет MoE-модель использовать универсальную 2D-обёртку `FusedMoEWithLoRA` вместо 3D, чтобы в одном инстансе обслуживать адаптеры обоих форматов. Актуален только для MoE-моделей, объявивших `is_3d_moe_weight = True`.
group: LoRAConfig
related:
  - --enable-lora
  - --enable-moe-shared-loras
  - --max-loras
  - --max-lora-rank
  - --fully-sharded-loras
  - --enable-expert-parallel
---

# --enable-mixed-moe-lora-format

## Кратко

У MoE-адаптеров два раскладки весов на диске: «2D» — отдельный набор тензоров на каждого эксперта, и «3D» — один тензор, в котором эксперты сложены по ведущей размерности. Модель объявляет, какую раскладку она ждёт, атрибутом класса `is_3d_moe_weight`; по умолчанию он `False`, а у части моделей (Qwen3.5, Qwen3-VL-MoE, GPT-OSS, InternS1-Pro) — `True`.

Флаг снимает это решение с модели: движок всегда берёт 2D-обёртку `FusedMoEWithLoRA`, а 3D-адаптеры конвертируются в 2D при добавлении. Смысл — обслуживать оба формата одним процессом.

## Оригинальная справка

```text
If True, force the engine to use the universal 2D MoE LoRA wrapper
(`FusedMoEWithLoRA`) regardless of the model's `is_3d_moe_weight` flag, so
that 2D-format and 3D-format MoE LoRA adapters can be served in the same
deployment. Only meaningful for MoE models; ignored otherwise. Default False
keeps the existing model-driven behavior.
```

## Паспорт аргумента

- Флаги: `--enable-mixed-moe-lora-format`, `--no-enable-mixed-moe-lora-format`
- Группа argparse: `LoRAConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; выключается парной формой из списка выше
- Значение по умолчанию: `false`
- Эффективное значение: гасится самим движком на не-MoE модели — `LoRAModelManager` вычисляет `self._enable_mixed_moe_lora_format = is_moe and lora_config.enable_mixed_moe_lora_format`, то есть при отсутствии слоёв `MoERunner` флаг не делает ничего и об этом не сообщается
- Где объявлен: `vllm/config/lora.py:LoRAConfig.enable_mixed_moe_lora_format`
- Этап применения: загрузка модели (выбор обёртки и packed-mapping) → добавление каждого адаптера (конвертация 3D → 2D)

## Что меняет в движке

**Выбор обёртки.** `LoRAModelManager.__init__` вычисляет `self._is_3d_moe_model = is_moe and model.is_3d_moe_weight and not self._enable_mixed_moe_lora_format`. С включённым флагом это выражение всегда `False`, поэтому все MoE-слои оборачиваются в `FusedMoEWithLoRA`, а не в `FusedMoE3DWithLoRA`.

**Packed-mapping.** `process_packed_modules_mapping(model, force_2d_moe=True, …)` перезаписывает запись `experts` списком имён из `get_moe_expert_mapping(model)` — это тот же путь, что и для моделей с `is_3d_moe_weight = False`. От этого списка зависит `expected_lora_modules`, то есть какие имена в файле адаптера считаются ожидаемыми.

**Конвертация адаптера.** В `_add_adapter`/`_create_merged_loras_inplace` для каждой обёртки `FusedMoEWithLoRA` проверяется, объявил ли адаптер 3D-раскладку. Если да — вызывается `_convert_3d_to_2d_moe_lora()`: тензоры `gate_up_proj`/`down_proj` разворачиваются в форму `(num_experts, …)`, при expert parallelism срезаются по локальному диапазону экспертов и раскладываются в три per-expert тензора `[w1, w2, w3]`. Если нет — работает обычный путь `_slice_moe_lora_ep()`.

**Откуда берётся признак «адаптер 3D».** Это не автодетект по файлу, а поле запроса: `is_3d_lora_weight` в `LoRARequest`. Задаётся либо в JSON-форме `--lora-modules` (`{"name": ..., "path": ..., "is_3d_lora_weight": true}`), либо в теле `POST /v1/load_lora_adapter`. По умолчанию `false`.

## Значения и формат

- Значение по умолчанию `false`, «не задан» и `--no-enable-mixed-moe-lora-format` эквивалентны.
- На не-MoE модели флаг игнорируется без предупреждения.
- На MoE-модели с `is_3d_moe_weight = False` флаг тоже ничего не меняет: там 2D-обёртка используется и так.
- Значение входит в `LoRAConfig.compute_hash()` — переключение инвалидирует кэш компиляции.

## Когда использовать

- В одном инстансе нужно обслуживать MoE-адаптеры, часть которых сохранена в 3D-раскладке, а часть — в 2D, и вы готовы помечать 3D-адаптеры флагом `is_3d_lora_weight` в момент их регистрации.
- Не включайте на модели с `is_3d_moe_weight = True`, если все ваши адаптеры 3D: родная 3D-обёртка работает с ними напрямую, без конвертации при загрузке.
- Не включайте на не-MoE моделях: это шум в конфигурации, который ничего не делает.

## Влияние на производительность и память

- **VRAM.** Формы буферов 2D-обёртки задаются `--max-loras`, `--max-lora-rank`, числом локальных экспертов и `--enable-moe-shared-loras`; сам по себе флаг размер слота не меняет — он меняет, какой класс обёртки этот слот создаёт.
- **RAM хоста.** Конвертация 3D → 2D делает `contiguous()`-копии срезов при добавлении адаптера, то есть кратковременно удваивает память под веса этого адаптера.
- **Время старта / добавления адаптера.** Конвертация выполняется один раз на адаптер, в момент его регистрации; для больших MoE-адаптеров это заметно.
- **Throughput.** Определяется 2D-ядрами MoE-LoRA; отличие от 3D-пути надо мерить на своей модели, кода-подсказки о заведомой разнице в forward нет.

## Взаимодействие с другими аргументами

- `--enable-moe-shared-loras`: применяется раньше в `process_packed_modules_mapping` — при нём запись `experts` формируется по shared-раскладке, и ветка `force_2d_moe` не выполняется.
- `--enable-expert-parallel`: конвертация учитывает EP и срезает эксперты по локальному диапазону ранга.
- `--fully-sharded-loras`: несовместим с `--enable-expert-parallel` на MoE-LoRA (явный assert в `FusedMoEWithLoRA`).
- `--lora-modules`: единственный способ пометить статический адаптер как 3D через поле `is_3d_lora_weight` в JSON-форме.
- `--max-loras`, `--max-lora-rank`: задают размер per-expert буферов.

## Типовые проблемы и диагностика

- **Симптом:** 3D-адаптер зарегистрирован, но его влияние на выход отсутствует или выход испорчен. **Причина:** адаптер не помечен `is_3d_lora_weight`, и 2D-путь разобрал его тензоры как per-expert. **Лечение:** передать `is_3d_lora_weight: true` при регистрации.
- **Симптом:** при загрузке адаптера `While loading <dir>, expected target modules in {...} but received [...]`. **Причина:** имена в файле адаптера не совпали с packed-mapping, собранным для выбранной раскладки. **Проверка:** сопоставить включённые флаги (`--enable-mixed-moe-lora-format`, `--enable-moe-shared-loras`) с фактической раскладкой файла. **Лечение:** выбрать раскладку, соответствующую адаптеру.
- **Симптом:** флаг задан, поведение не изменилось. **Причина:** модель не MoE, либо у неё `is_3d_moe_weight = False`. **Проверка:** строка `MoE model detected. Using fused MoE LoRA implementation.` в логе означает, что MoE-путь вообще активен. **Лечение:** флаг не нужен.
- **Подтверждение принятого значения:** отдельной строки нет; косвенно — успешная регистрация адаптеров обоих форматов в одном процессе.

## Примеры

```bash
vllm serve /models/Qwen3-VL-MoE --enable-lora --enable-mixed-moe-lora-format --max-lora-rank 32 --max-loras 2
```

```bash
vllm serve /models/Qwen3-VL-MoE --enable-lora --enable-mixed-moe-lora-format --lora-modules '{"name": "legacy3d", "path": "/models/lora/legacy3d", "is_3d_lora_weight": true}'
```

## Источники

- `vllm/vllm/config/lora.py`
- `vllm/vllm/lora/utils.py`
- `vllm/vllm/lora/model_manager.py`
- `vllm/vllm/lora/layers/fused_moe.py`
- `vllm/vllm/lora/request.py`
- `vllm/vllm/model_executor/models/interfaces.py`
- `vllm/vllm/entrypoints/openai/models/protocol.py`
- `vllm/docs/features/lora.md`
