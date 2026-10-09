---
schema: 1
engine: vllm
primaryName: "--max-lora-cls-labels"
title: "--max-lora-cls-labels"
summary: Максимальное число меток у полной классификационной головы, которую приносит LoRA-адаптер (PEFT `modules_to_save` для `score`/`classifier`). Нужен, чтобы в одном батче обслуживать адаптеры с разным `num_labels`, в том числе больше, чем у базовой модели.
group: LoRAConfig
related:
  - --enable-lora
  - --max-loras
  - --runner
  - --convert
  - --hf-overrides
  - --lora-modules
---

# --max-lora-cls-labels

## Кратко

PEFT-адаптер для sequence classification может сохранить классификационную голову целиком (`modules_to_save`, модуль `score` или `classifier`). Раньше такая голова обязана была совпадать по `num_labels` с базовой моделью. Теперь под каждый слот адаптера на GPU резервируется голова шириной `max(num_labels базы, --max-lora-cls-labels)`, и адаптер с любым числом меток от 1 до значения флага загружается. Каждый запрос получает столько логитов, сколько меток у его адаптера.

Флаг относится только к классификационным (pooling) моделям с `--enable-lora`. На генеративных моделях он ничего не меняет.

## Оригинальная справка

```text
Maximum output size for LoRA classification heads. Defaults to the
base classification head size.
```

## Паспорт аргумента

- Флаги: `--max-lora-cls-labels`
- Группа argparse: `LoRAConfig`
- Тип значения: int (число меток)
- Допустимые значения: `>= 1` (валидация `Field(default=None, ge=1)`)
- Значение по умолчанию: `None` — лимит равен выходному размеру базовой классификационной головы
- Эффективное значение: в `ClassificationHeadWithLoRA.create_lora_weights` лимит `max_lora_cls_labels = значение or output_size`, а ширина буфера `padded_num_labels = max(output_size, max_lora_cls_labels)`. При значении меньше базового `num_labels` буфер все равно имеет базовую ширину, но адаптеры с числом меток больше значения флага отвергаются
- Где объявлен: `vllm/config/lora.py:LoRAConfig.max_lora_cls_labels`
- Этап применения: загрузка модели (создание LoRA-обертки над головой) → загрузка каждого адаптера (`_validate_modules_to_save`) → forward классификационного запроса

## Что меняет в движке

**Буферы на GPU.** `ClassificationHeadWithLoRA` создает `full_weight_stacked` формы `max_loras × 1 × padded_num_labels × hidden_size` в `lora_dtype` и `full_bias_stacked` формы `max_loras × padded_num_labels` в dtype головы. Это место под полную голову для каждого слота адаптера.

**Загрузка адаптера.** `LoRAModelManager._validate_modules_to_save` проверяет форму веса сохраненной головы: двумерный тензор `(1..max_lora_cls_labels, hidden_size)`, bias, если есть, длины `num_labels`. Иначе адаптер отвергается:

```text
Full module '<имя>' for '<голова>' has an incompatible weight shape: expected (1..N, H), received (...).
```

Если у модели нет ровно одной обертки `ClassificationHeadWithLoRA`, адаптер с `modules_to_save` отвергается сообщением `the model does not expose a unique ClassificationHeadWithLoRA`.

**Forward.** Базовая голова считается всегда. Если ни у одного запроса в батче нет адаптера с полной головой, возвращается базовый результат. Иначе выход расширяется до `padded_num_labels`, полные головы применяются по слотам, и каждая строка обрезается до числа меток своего адаптера; строки без полной головы сохраняют базовый размер. При разной ширине строк результат — список тензоров, а не один тензор.

**Активация.** После изменения пулер классификации выбирает активацию по фактической ширине строки (`static_num_labels=False`): sigmoid при одной метке, softmax при двух и больше. Приоритет у явных настроек из конфига модели: `problem_type` `regression` и `multi_label_classification` и активация sentence-transformers.

Значение входит в `LoRAConfig.compute_hash`: его изменение инвалидирует кэш компиляции.

## Значения и формат

- Целое число меток, минимум 1. `0` и отрицательные значения отвергает валидация.
- Не задан — лимит равен `num_labels` базовой головы.
- Значение меньше базового `num_labels` память не экономит (буфер остается базовой ширины), но запрещает адаптеры с числом меток больше значения.

## Когда использовать

- Несколько классификаторов-адаптеров с разным числом классов на одной базе: guard-модели, тематические классификаторы.
- База загружена с `num_labels: 1` (например, через `--hf-overrides`), а адаптеры двух- и более классовые.
- Не нужен, если все адаптеры совпадают с базой по `num_labels` или адаптеры не сохраняют полную голову (только LoRA A/B на голове).
- Token-classification адаптеры этой функцией не поддерживаются.

## Влияние на производительность и память

- **VRAM.** `max_loras × padded_num_labels × (hidden_size × размер lora_dtype + размер dtype головы)` байт. Для `max_loras=4`, 16 меток и `hidden_size=4096` в fp16 это около 0,5 МБ, на фоне весов пренебрежимо.
- **Latency.** Батч с хотя бы одним адаптером с полной головой выполняет дополнительное умножение на `padded_num_labels` выходов и копирование; разношерстный батч разбирается построчно.
- **Время старта.** Значение входит в хеш компиляции: смена значения означает перекомпиляцию.

## Взаимодействие с другими аргументами

- `--enable-lora`: без него обертка головы не создается и флаг не действует.
- `--max-loras`: число слотов, под каждый резервируется полная голова шириной `padded_num_labels`.
- `--runner`, `--convert`: голова есть только у pooling-моделей для классификации (`--runner pooling --convert classify` или нативная `*ForSequenceClassification`).
- `--hf-overrides`: задает `num_labels` базовой головы, от которого считается значение по умолчанию.
- `--lora-modules`: адаптеры, загружаемые при старте, проходят ту же проверку формы головы.

## Типовые проблемы и диагностика

- **Симптом:** `Full module 'score' for '...' has an incompatible weight shape: expected (1..2, 1024), received (5, 1024).` **Причина:** у адаптера больше меток, чем позволяет лимит. **Лечение:** поднять `--max-lora-cls-labels` до максимального `num_labels` среди адаптеров.
- **Симптом:** адаптер с другим `hidden_size` отвергается той же ошибкой. **Причина:** адаптер обучен на другой базе. **Лечение:** флаг не поможет, нужна совместимая база.
- **Симптом:** `Cannot load full module ...: the model does not expose a unique ClassificationHeadWithLoRA.` **Причина:** модель не классификационная или голова не обернута для LoRA. **Проверка:** `--runner`/`--convert` и архитектура модели.
- **Подтверждение принятого значения:** строка `non-default args: {...}` при старте содержит `max_lora_cls_labels`; ответ `/classify` для запроса с адаптером содержит столько вероятностей, сколько меток у адаптера.

## Примеры

```bash
vllm serve /models/Qwen3-0.6B --runner pooling --convert classify --hf-overrides '{"num_labels": 1}' --enable-lora --max-loras 2 --max-lora-cls-labels 2
```

```bash
vllm serve /models/Qwen3-0.6B --runner pooling --convert classify --enable-lora --max-loras 4 --max-lora-cls-labels 8 --lora-modules guard-a=/adapters/guard-a guard-b=/adapters/guard-b
```

## Источники

- `vllm/vllm/config/lora.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/lora/layers/classifier.py`
- `vllm/vllm/lora/model_manager.py`
- `vllm/vllm/model_executor/layers/pooler/activations.py`
- `vllm/vllm/model_executor/layers/pooler/seqwise/heads.py`
- `vllm/docs/features/lora.md`
- `vllm/tests/lora/test_sequence_classification.py`
