---
schema: 1
engine: vllm
primaryName: "--enable-moe-shared-loras"
title: "--enable-moe-shared-loras"
summary: Читает MoE-адаптеры в раскладке «shared-outer», где lora_A для gate/up и lora_B для down общие на всех экспертов. Схлопывает размерность экспертов в двух из четырёх буферов, ощутимо сокращая VRAM под слоты на MoE-моделях.
group: LoRAConfig
related:
  - --enable-lora
  - --enable-mixed-moe-lora-format
  - --max-loras
  - --max-lora-rank
  - --fully-sharded-loras
  - --enable-expert-parallel
  - --gpu-memory-utilization
---

# --enable-moe-shared-loras

## Кратко

Флаг описывает **формат весов адаптера**, а не оптимизацию: он применим только к адаптерам, обученным так, что внешние множители разложения общие для всех экспертов. Если включить его для обычного per-expert адаптера, имена модулей в файле не совпадут с ожидаемыми и загрузка упадёт.

Выигрыш конкретный: у двух из четырёх буферов MoE-обёртки размерность экспертов становится равной 1, и в момент вычисления общий множитель просто транслируется на все эксперты.

## Оригинальная справка

```text
If True, load MoE expert adapters in the "shared-outer" layout, where the
gate/up (`w1`/`w3`) lora_A and the down (`w2`) lora_B are shared across all
experts (stored once with expert-dim 1) instead of per-expert. The shared
factors are broadcast to the expert count at kernel time. Only meaningful for
MoE models whose adapters use this layout; ignored otherwise.
```

## Паспорт аргумента

- Флаги: `--enable-moe-shared-loras`, `--no-enable-moe-shared-loras`
- Группа argparse: `LoRAConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; выключается парной формой из списка выше
- Значение по умолчанию: `false`
- Эффективное значение: гасится на не-MoE модели — `LoRAModelManager` вычисляет `self._enable_moe_shared_loras = is_moe and lora_config.enable_moe_shared_loras`, без предупреждения при несовпадении
- Где объявлен: `vllm/config/lora.py:LoRAConfig.enable_moe_shared_loras`
- Этап применения: загрузка модели (packed-mapping и формы буферов) → загрузка адаптера (проверка ожидаемых имён модулей)

## Что меняет в движке

**Ожидаемые имена модулей.** `process_packed_modules_mapping(..., enable_moe_shared_loras=True)` перезаписывает запись `experts` тремя фиксированными именами: `experts.w1`, `experts.w2`, `experts.w3`. Эта ветка проверяется первой и перекрывает обе остальные (3D-модель и `force_2d_moe`). Именно этот список попадает в `expected_lora_modules`, по которому `LoRAModel.from_local_checkpoint()` отвергает адаптер с неожиданными модулями.

**Формы буферов.** В `FusedMoEWithLoRA` два свойства становятся равны 1 вместо числа локальных экспертов:

- `_w13_a_num_experts` — ведущая размерность экспертов у `w13_lora_a_stacked`;
- `_w2_b_num_experts` — то же у `w2_lora_b_stacked`.

Итоговые формы при включённом флаге:

- `w13_lora_a_stacked`: `_w13_slices` × `(max_loras, 1, rank, hidden_size)` вместо `(max_loras, E_local, rank, hidden_size)`;
- `w2_lora_a_stacked`: `(max_loras, E_local, rank, intermediate_per_partition)` — без изменений;
- `w13_lora_b_stacked`: `_w13_slices` × `(max_loras, E_local, intermediate_per_partition, rank)` — без изменений;
- `w2_lora_b_stacked`: `(max_loras, 1, hidden_size, rank)` вместо `(max_loras, E_local, hidden_size, rank)`.

**Индексация.** В `create_lora_weights()` при построении плоских списков `lora_a_stacked`/`lora_b_stacked` индекс эксперта для схлопнутых тензоров жёстко равен 0 (`w13_a_eid`, `w2_b_eid`), поэтому все эксперты ссылаются на один и тот же общий множитель.

## Значения и формат

- Значение по умолчанию `false`; «не задан» и `--no-enable-moe-shared-loras` эквивалентны.
- На не-MoE модели флаг бездействует.
- Флаг определяет ожидания движка относительно файла адаптера. Автодетекта раскладки нет — совпадение обеспечивает оператор.
- Значение входит в `LoRAConfig.compute_hash()`, поэтому переключение инвалидирует кэш компиляции.

## Когда использовать

- Ваши MoE-адаптеры действительно сохранены в shared-outer раскладке (в файле присутствуют `experts.w1`, `experts.w2`, `experts.w3`, а не per-expert имена).
- VRAM на MoE-модели с большим числом экспертов упирается в LoRA-буферы: схлопывание двух буферов из четырёх снимает заметную долю, поскольку `E_local` у MoE-моделей исчисляется десятками.
- Не включайте «для экономии» при обычных per-expert адаптерах: экономии не будет, будет отказ загрузки.
- Не совмещайте с `--enable-mixed-moe-lora-format` в надежде «принять любой формат»: shared-ветка packed-mapping выигрывает и вычисляется раньше, так что смешанный режим для 3D-адаптеров при ней не действует.

## Влияние на производительность и память

- **VRAM.** Основной эффект. Схлопывание размерности экспертов в `w13_lora_a_stacked` и `w2_lora_b_stacked` убирает множитель `E_local` из этих двух буферов; освободившееся уходит в KV-cache при том же `--gpu-memory-utilization`.
- **RAM хоста.** CPU-копия адаптера меньше ровно настолько, насколько меньше сам файл при shared-раскладке.
- **Время старта.** Слегка меньше: меньше нулевых тензоров выделяется и меньше данных копируется при активации адаптера.
- **Throughput.** Общий множитель транслируется на эксперты в момент запуска ядра; заявленных в коде изменений в стоимости forward нет — проверять на своей модели замером.

## Взаимодействие с другими аргументами

- `--enable-mixed-moe-lora-format`: обе опции правят одну и ту же запись `experts` в packed-mapping; shared-ветка проверяется первой и перекрывает `force_2d_moe`.
- `--max-loras`, `--max-lora-rank`: остальные множители тех же буферов.
- `--fully-sharded-loras`: дополнительно делит ранг и `hidden_size` на `tensor_parallel_size`; несовместим с `--enable-expert-parallel` на MoE-LoRA.
- `--enable-expert-parallel`: определяет `E_local` (число экспертов на ранге), то есть базу для экономии.
- `--gpu-memory-utilization`: освободившаяся память уходит в KV-cache.

## Типовые проблемы и диагностика

- **Симптом:** `While loading <dir>, expected target modules in {'experts.w1', 'experts.w2', 'experts.w3', ...} but received [...]`. **Причина:** флаг включён, а адаптер сохранён per-expert. **Лечение:** снять флаг.
- **Симптом:** зеркальная ошибка — в ожидаемых per-expert имена, а в файле `experts.w1/w2/w3`. **Причина:** адаптер shared-outer, флаг не включён. **Лечение:** включить флаг.
- **Симптом:** флаг задан, потребление VRAM не изменилось. **Причина:** модель не MoE (`_enable_moe_shared_loras` погашен). **Проверка:** наличие строки `MoE model detected. Using fused MoE LoRA implementation.` в логе. **Лечение:** флаг не применим.
- **Подтверждение принятого значения:** отдельной строки нет; косвенно — успешная загрузка shared-адаптера и меньшее значение в строке `Available KV cache memory: X GiB` при прочих равных.

## Примеры

```bash
vllm serve /models/Qwen3-30B-A3B --enable-lora --enable-moe-shared-loras --max-lora-rank 32 --max-loras 2
```

```bash
vllm serve /models/Qwen3-30B-A3B --enable-lora --enable-moe-shared-loras --lora-modules moe=/models/lora/moe-shared --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/lora.py`
- `vllm/vllm/lora/utils.py`
- `vllm/vllm/lora/model_manager.py`
- `vllm/vllm/lora/layers/fused_moe.py`
- `vllm/vllm/lora/lora_model.py`
- `vllm/docs/features/lora.md`
