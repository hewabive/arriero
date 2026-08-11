---
schema: 1
engine: vllm
primaryName: "--disable-chunked-mm-input"
title: "--disable-chunked-mm-input"
summary: Запрещает планировщику разрезать один мультимодальный элемент (картинку, аудио, видео) между двумя шагами при chunked prefill. Нужен моделям с двунаправленным вниманием по мультимодальному блоку; для них движок включает флаг сам.
group: SchedulerConfig
related:
  - --enable-chunked-prefill
  - --max-num-batched-tokens
  - --limit-mm-per-prompt
  - --mm-processor-cache-gb
  - --long-prefill-token-threshold
  - --mamba-cache-mode
  - --enable-mm-embeds
---

# --disable-chunked-mm-input

## Кратко

При chunked prefill длинный промпт режется на куски по `max_num_batched_tokens`. Если в промпте есть мультимодальный элемент, граница куска может пройти прямо по нему: часть плейсхолдеров картинки попадет в один шаг, часть — в следующий. Для большинства моделей это допустимо, потому что энкодер уже посчитал эмбеддинги целиком и они лежат в encoder cache. Для моделей, где внимание внутри мультимодального блока двунаправленное (prefix-LM), разрез меняет результат.

`--disable-chunked-mm-input` заставляет планировщик откатить границу куска **до начала** мультимодального элемента: в примере из справки получается шаг `TTTT`, затем шаг `IIIIIIIIII`, а не `TTTTIIIII` + `IIIII`.

## Оригинальная справка

```text
If set to true and chunked prefill is enabled, we do not want to
partially schedule a multimodal item. Only used in V1
This ensures that if a request has a mixed prompt
(like text tokens TTTT followed by image tokens IIIIIIIIII) where only
some image tokens can be scheduled (like TTTTIIIII, leaving IIIII),
it will be scheduled as TTTT in one step and IIIIIIIIII in the next.
```

## Паспорт аргумента

- Флаги: `--disable-chunked-mm-input`, `--no-disable-chunked-mm-input`
- Группа argparse: `SchedulerConfig`
- Тип значения: bool (`action: argparse.BooleanOptionalAction`)
- Допустимые значения: не ограничены сверх пары флагов
- Значение по умолчанию: `false`
- Эффективное значение: переопределяется в двух местах. `SchedulerConfig.__post_init__` ставит `True` для encoder-decoder моделей (вместе с отключением chunked prefill). `vllm/platforms/cuda.py` ставит `True` для мультимодальной prefix-LM модели с сообщением `Forcing --disable_chunked_mm_input for models with multimodal-bidirectional attention.`
- Где объявлен: `vllm/config/scheduler.py:SchedulerConfig.disable_chunked_mm_input`
- Этап применения: сборка `VllmConfig` → платформенный хук → планировщик, на каждом шаге (`_try_schedule_encoder_inputs`)

## Что меняет в движке

Значение читается в `Scheduler._try_schedule_encoder_inputs` (`vllm/v1/core/sched/scheduler.py`). Когда планировщик подбирает `num_new_tokens` для запроса и видит, что окно шага накрывает мультимодальный элемент лишь частично, при `disable_chunked_mm_input == True` он обрезает окно до `start_pos` — позиции начала элемента:

```
num_new_tokens = max(0, start_pos - (num_computed_tokens + shift_computed_tokens))
```

и прекращает разбор оставшихся элементов промпта. То есть текущий шаг довозит только текст перед картинкой, а сам мультимодальный блок целиком уезжает в следующий шаг.

Второе место — `vllm/v1/core/encoder_cache_manager.py`: при `disable_chunked_mm_input` бюджет энкодера обязан вмещать самый крупный элемент, и если это не так, конфигурация отвергается на старте.

Значение также участвует в валидации `VllmConfig`: при `--mamba-cache-mode align` разрезание мультимодального ввода обязательно, поэтому комбинация с `disable_chunked_mm_input` падает на assert.

## Значения и формат

- `--disable-chunked-mm-input` — запретить разрез, `--no-disable-chunked-mm-input` — разрешить (значение по умолчанию).
- Аргумент действует только когда chunked prefill включен и модель мультимодальная. В текстовой модели он не наблюдаем.
- Для encoder-decoder модели значение не имеет смысла: там chunked prefill выключен, а сам флаг принудительно поставлен в `True`.

## Когда использовать

- Когда модель мультимодальная и вы **вручную** отключили что-то из авто-логики платформы (например, запускаете не на CUDA), а вывод на картинках отличается от эталона: разрез элемента — первый подозреваемый.
- Для prefix-LM моделей флаг вообще не нужно задавать: `vllm/platforms/cuda.py` включит его сам и напишет об этом в лог.
- Не включайте «на всякий случай» на обычной мультимодальной модели: вы получите шаги неравномерного размера и, при слишком маленьком `--max-num-batched-tokens`, ошибку старта.

## Влияние на производительность и память

- **VRAM.** Прямого влияния нет. Косвенное — через требование к бюджету энкодера: при включенном флаге `max_num_batched_tokens` обязан быть не меньше числа токенов самого крупного мультимодального элемента, а этот параметр определяет размеры буферов активаций и `encoder_cache_size`.
- **Throughput.** Слегка падает: шаг, на котором картинка не поместилась, заполняется не полностью, а остаток бюджета уходит впустую.
- **TTFT.** Для запроса с крупным изображением может вырасти: элемент ждет шага, где под него найдется целый непрерывный кусок бюджета.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--enable-chunked-prefill`: без chunked prefill аргумент бессмыслен — резать нечего.
- `--max-num-batched-tokens`: главный партнер. При включенном флаге бюджет одного шага обязан вмещать самый крупный мультимодальный элемент целиком, иначе движок падает на старте.
- `--limit-mm-per-prompt`: ограничивает число элементов на запрос и тем самым влияет на то, насколько часто планировщик упирается в границу элемента.
- `--long-prefill-token-threshold`: дополнительно урезает размер куска, из-за чего вероятность «элемент не влез» растет.
- `--mamba-cache-mode`: значение `align` требует свободы разреза и с этим флагом несовместимо.
- `--mm-processor-cache-gb`, `--enable-mm-embeds`: относятся к подготовке мультимодальных входов, а не к их планированию; на решение о разрезе не влияют.

## Типовые проблемы и диагностика

- **Симптом:** `Chunked MM input disabled but max_tokens_per_mm_item (N) is larger than max_num_batched_tokens (M). Please increase max_num_batched_tokens.` **Причина:** бюджет шага меньше крупнейшего мультимодального элемента. **Лечение:** поднять `--max-num-batched-tokens` минимум до `N`.
- **Симптом:** старт падает на assert `Chunked MM input is required because we need the flexibility to schedule a multiple of block_size tokens even if they are in the middle of a mm input`. **Причина:** связка с `--mamba-cache-mode align`. **Лечение:** снять флаг либо сменить режим кэша Mamba.
- **Симптом:** флаг не задан, но в логе `Forcing --disable_chunked_mm_input for models with multimodal-bidirectional attention.` **Причина:** штатное включение платформенным хуком для prefix-LM модели. **Лечение:** ничего; заодно ожидайте, что движок сам поднимет `max_num_batched_tokens` до размера самого дорогого элемента (`Raising max_num_batched_tokens from ... to ... to accommodate ... input for prefix-LM model ...`), если вы не задали его явно.
- **Симптом:** вывод по изображению «плывет» на длинных промптах при chunked prefill. **Проверка:** мультимодальная ли модель prefix-LM и включен ли флаг. **Лечение:** включить явно и сравнить.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --disable-chunked-mm-input --max-num-batched-tokens 16384
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --no-disable-chunked-mm-input --max-num-batched-tokens 4096 --limit-mm-per-prompt '{"image": 2}'
```

## Источники

- `vllm/vllm/config/scheduler.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/core/encoder_cache_manager.py`
- `vllm/vllm/engine/arg_utils.py`
