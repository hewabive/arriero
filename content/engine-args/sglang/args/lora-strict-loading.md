---
schema: 1
engine: sglang
primaryName: "--lora-strict-loading"
title: "--lora-strict-loading"
summary: Превращает молчаливый пропуск несматчившихся весов адаптера в ошибку загрузки. Единственная защита от адаптера, который «загрузился», но половина его весов не применяется.
group: lora
related:
  - --lora-target-modules
  - --lora-paths
  - --enable-lora
  - --max-lora-rank
  - --max-loras-per-batch
---

# --lora-strict-loading

## Кратко

При заезде адаптера в слот пула SGLang сопоставляет имена его весов с целевыми модулями. Веса, которым не нашлось модуля, по умолчанию **пропускаются** с предупреждением в логе — сервер продолжает работать, а адаптер применяется частично и тихо дает не тот результат, что ожидался. `--lora-strict-loading` превращает это предупреждение в `ValueError`, то есть в отказ загрузки. Это единственный флаг группы с парой `--no-...`.

## Оригинальная справка

```text
Enable strict loading for LoRA adapters. When set, mismatched or missing keys in the adapter weights will raise an error.
```

## Паспорт аргумента

- Флаги: `--lora-strict-loading`, `--no-lora-strict-loading`
- Группа: `lora`
- Тип значения: bool, `action=argparse.BooleanOptionalAction`
- Допустимые значения: значения не принимает; задается наличием одного из двух флагов
- Значение по умолчанию: `false` — несовпадения только логируются
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.lora_strict_loading`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `LoRAMemoryPool.load_lora_weight_to_buffer` — то есть при **заезде адаптера в слот**, а не при регистрации

## Что меняет в движке

Проверка стоит в `load_lora_weight_to_buffer` (`sglang/python/sglang/srt/lora/mem_pool.py`) **до** записи в буферы GPU, чтобы отказ не оставил слот в полусобранном состоянии. Собираются все имена весов адаптера по всем слоям плюс embedding-веса, и каждое прогоняется через `get_target_module_name(name, self.target_modules)`. Не сматчившиеся попадают в `skipped_weight_names`, и дальше:

```python
msg = (
    f"LoRA adapter '{uid}': {len(skipped_weight_names)} weight(s) skipped because they did not "
    f"match any target module in {sorted(self.target_modules)}. Skipped weights: {sorted(skipped_weight_names)}. "
    f"This likely indicates a mismatch between the adapter's target modules and the base model architecture."
)
if self.strict_loading:
    raise ValueError(msg)
else:
    logger.warning(msg)
```

Успешно сматчившиеся модули печатаются отдельной информационной строкой: `LoRA adapter '<uid>': loaded weights for target modules [...]`.

Важно понимать границы флага:

- он **не** проверяет ранг и не заменяет `can_support` — несоответствие ранга отвергается раньше, в `validate_new_adapter`, независимо от этого флага;
- он **не** ловит обратную ситуацию (целевой модуль есть, а весов под него в адаптере нет): такие срезы буфера просто обнуляются, и это штатное поведение, а не ошибка;
- он срабатывает не в момент `/load_lora_adapter`, а при первом попадании адаптера в батч, где он занимает слот. На стартовых `--lora-paths` это происходит сразу, при инициализации пула базовым слотом и первым батчем.

Флаг — единственный в группе с `BooleanOptionalAction`. Из этого следует практическая мелочь: YAML-конфигурация через `--config` его не примет вовсе — `ConfigArgumentMerger` явно отвергает опции, чей action не `store_true` и не `store`, с сообщением `Unsupported config option 'lora_strict_loading' with action 'BooleanOptionalAction'`.

## Значения и формат

- `--lora-strict-loading` включает, `--no-lora-strict-loading` выключает; значений ни один из них не принимает.
- Отсутствие обоих равносильно `--no-lora-strict-loading`.
- Указание обоих флагов не ошибка: побеждает последний в командной строке.
- Через `--config` задать нельзя (см. выше).

## Когда использовать

- Продакшен-развертывание с динамической загрузкой адаптеров от третьих лиц: без флага битый или чужой адаптер «загрузится» и будет молча выдавать не тот результат. С флагом он отвалится с точным списком неприменённых весов.
- Отладка адаптера, обученного на другой архитектуре или другом форке базовой модели: сообщение сразу показывает и пропущенные имена, и текущее множество целевых модулей.
- Проверка того, что `--lora-target-modules` действительно покрывает адаптер, а не «почти покрывает».
- **Не включайте**, если сознательно обслуживаете адаптер частично — например, намеренно сузили `--lora-target-modules` ради экономии VRAM и согласны, что часть весов не применяется. Это осмысленный компромисс, и флаг его запретит.

## Влияние на производительность и память

- На память не влияет: значение только меняет реакцию на несовпадение имен.
- На скорость не влияет: сопоставление имен выполняется один раз на заезд адаптера в слот и в любом случае, независимо от флага.

## Взаимодействие с другими аргументами

- `--lora-target-modules`: множество, с которым сверяются имена весов. Флаг делает несоответствие фатальным, а не косметическим.
- `--lora-paths`: при строгом режиме несовместимый стартовый адаптер валит сервер (`RuntimeError: Failed to load LoRA adapter ...`), а не только пишет предупреждение.
- `--max-lora-rank`: несоответствие ранга ловится раньше и другим механизмом.
- `--max-loras-per-batch`: определяет, когда адаптер заедет в слот и, значит, когда проверка сработает.
- `--enable-lora`: без него аргумент инертен.

## Типовые проблемы и диагностика

- `ValueError: LoRA adapter '<uid>': N weight(s) skipped because they did not match any target module in [...]. Skipped weights: [...]` — строгий режим сработал; в сообщении есть и что пропущено, и на что сверялись.
- То же самое, но уровнем `warning` — флаг выключен; это ровно тот случай, ради которого его и включают.
- Ошибка приходит не в ответе `/load_lora_adapter`, а позже, на первом запросе к адаптеру — проверка выполняется при заезде в слот, а не при регистрации.
- `Unsupported config option 'lora_strict_loading' with action 'BooleanOptionalAction'` — попытка задать флаг через `--config`.
- Строка `LoRA adapter '<uid>': loaded weights for target modules [...]` показывает, что реально сматчилось; сравнение её с `target_modules` адаптера — самый быстрый способ понять масштаб расхождения.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-paths sql=/models/lora/sql --max-loras-per-batch 2 --lora-strict-loading
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --enable-lora --max-lora-rank 64 --lora-target-modules qkv_proj o_proj --max-loras-per-batch 4 --no-lora-strict-loading
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/mem_pool.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/python/sglang/srt/lora/utils.py`
- `sglang/python/sglang/srt/server_args_config_parser.py`
