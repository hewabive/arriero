---
schema: 1
engine: sglang
primaryName: "--max-lora-chunk-size"
title: "--max-lora-chunk-size"
summary: Верхняя граница размера чанка в backend'е `csgmv`. Значение по умолчанию 16 совпадает с минимумом и тем самым отключает эвристику подбора чанка по размеру батча.
group: lora
related:
  - --lora-backend
  - --max-loras-per-batch
  - --enable-lora
  - --cuda-graph-backend-prefill
  - --chunked-prefill-size
---

# --max-lora-chunk-size

## Кратко

Backend `csgmv` режет последовательности батча на чанки фиксированного размера, чтобы не запускать ядро на каждый сегмент отдельно. Размер чанка подбирается эвристикой по числу токенов в батче (16 / 32 / 128), а `--max-lora-chunk-size` ограничивает её сверху. Тонкость: значение по умолчанию — `16`, и оно же является минимумом, поэтому по умолчанию эвристика выключена и чанк всегда равен 16. Аргумент читается только backend'ом `csgmv`; для `triton`, `ascend` и `torch_native` он не значит ничего.

## Оригинальная справка

```text
Maximum chunk size for the ChunkedSGMV LoRA backend. Only used when --lora-backend is 'csgmv'. Choosing a larger value might improve performance.
```

## Паспорт аргумента

- Флаги: `--max-lora-chunk-size`
- Группа: `lora`
- Тип значения: `Optional[int]`
- Допустимые значения: `16`, `32`, `64`, `128` (список `choices`); дополнительно `check_lora_server_args` требует степень двойки в диапазоне 16…128
- Значение по умолчанию: `16`
- Эффективное значение: не переопределяется, но фактический размер чанка на каждом батче равен `min(max_chunk_size, эвристика(num_tokens))`, а при `max_chunk_size <= 16` — всегда 16
- Где объявлен: `ServerArgs.max_lora_chunk_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `ChunkedSgmvLoRABackend` → выбор размера чанка на каждом forward → размерности буферов prefill-CUDA-graph

## Что меняет в движке

Эвристика (`sglang/python/sglang/srt/lora/backend/chunked_backend.py`):

```python
def _determine_chunk_size_for_tokens(self, num_tokens: int) -> int:
    if self.max_chunk_size <= MIN_CHUNK_SIZE:   # MIN_CHUNK_SIZE = 16
        return MIN_CHUNK_SIZE
    if num_tokens >= 256:
        chunk_size = 128
    elif num_tokens >= 64:
        chunk_size = 32
    else:
        chunk_size = 16
    return min(self.max_chunk_size, chunk_size)
```

`num_tokens` берется как `extend_num_tokens` для extend-батчей и как `batch_size` для decode. Отсюда практические следствия:

- при значении по умолчанию `16` первая же ветка возвращает 16 всегда, независимо от размера батча;
- при `32` эвристика включается, но потолок 32: крупные prefill-батчи получат 32 вместо 128;
- при `128` эвристика работает полностью — 16 на мелких decode-батчах, 32 на средних, 128 на крупных prefill.

Размер чанка определяет нарезку в `_get_segments_info`: группа токенов одного адаптера длиной `L` превращается в `ceil(L / chunk_size)` сегментов, последний — остаточной длины. Меньший чанк — больше сегментов и больше работы по индексации; больший чанк — меньше сегментов, но грубее гранулярность при перекошенном распределении адаптеров.

Значение влияет и на статические буферы prefill-CUDA-graph:

```python
chunk_top = self._determine_chunk_size_for_tokens(max_num_tokens)
max_num_segments = max((max_num_tokens + chunk_top - 1) // chunk_top, 16) + self.max_loras_per_batch
```

то есть больший чанк уменьшает число сегментов худшего случая и, соответственно, размер этих буферов. Буферы decode-графа считаются по `MIN_CHUNK_SIZE`, а не по аргументу.

## Значения и формат

- Только `16`, `32`, `64` или `128`; argparse отвергнет остальное как `invalid choice`, а дублирующая проверка в `check_lora_server_args` даст `--max-lora-chunk-size must be a power of 2 between 16 and 128.`
- Аргумент объявлен `Optional[int]`, но с непустым значением по умолчанию, так что `None` в рантайме получается только через Python-API.
- Единица измерения — токены.
- Для backend'ов, отличных от `csgmv`, значение игнорируется полностью.

## Когда использовать

- Используете `csgmv` (дефолт) и обслуживаете длинные prefill: повышение до `64` или `128` включает эвристику и уменьшает число запусков ядра на крупных батчах. Апстрим прямо предлагает подбирать значение под железо и нагрузку.
- Профилируете LoRA-overhead и хотите сравнить нарезку: это единственная ручка формы батча внутри LoRA-ядер.
- **Не трогайте** при `--lora-backend triton|ascend|torch_native` — эффекта не будет.
- **Не ждите чуда на decode**: там `num_tokens = batch_size`, и при типичных размерах батча эвристика всё равно вернет 16 или 32.

## Влияние на производительность и память

- **Скорость.** Основной и единственный существенный эффект: меньше сегментов — меньше накладных расходов на запуск и индексацию в SGMV-ядрах. Величина выигрыша зависит от длины prefill и от того, насколько перекошено распределение адаптеров по запросам.
- **VRAM.** Влияние есть, но малое и в «хорошую» сторону: буферы prefill-CUDA-graph (`seg_lens`, `seg_indptr`, `weight_indices`) размерны по числу сегментов худшего случая, которое с ростом чанка уменьшается.
- **RAM хоста.** Не затрагивается.
- **Размер LoRA-пула** (веса адаптеров) от этого аргумента не зависит совсем.

## Взаимодействие с другими аргументами

- `--lora-backend`: значение читается только при `csgmv`.
- `--max-loras-per-batch`: входит слагаемым в оценку числа сегментов prefill-графа.
- `--chunked-prefill-size`: определяет, сколько токенов реально приходит в один extend-батч, а значит какую ветку эвристики вы будете видеть на практике.
- `--cuda-graph-backend-prefill`: буферы, чей размер зависит от чанка, выделяются только когда prefill-граф с LoRA возможен.
- `--enable-lora`: без него backend не создается.

## Типовые проблемы и диагностика

- `argument --max-lora-chunk-size: invalid choice: 24` — значение вне списка.
- `AssertionError: --max-lora-chunk-size must be a power of 2 between 16 and 128.` — значение пришло не через argparse (Python-API, YAML-конфиг).
- Изменили значение, разницы нет: проверьте `--lora-backend` (должен быть `csgmv`) и реальный размер батчей — при `num_tokens < 64` чанк всегда 16 независимо от потолка.
- Отдельной строки в логе аргумент не печатает; фактическое значение видно в дампе `server_args=`, а эффект — только в замерах latency.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-backend csgmv --max-lora-chunk-size 128 --lora-paths lora1=/models/lora/lora1 --max-loras-per-batch 2
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --lora-backend csgmv --max-lora-chunk-size 64 --chunked-prefill-size 8192 --lora-paths lora1=/models/lora/lora1 lora2=/models/lora/lora2 --max-loras-per-batch 3
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/lora/backend/chunked_backend.py`
- `sglang/python/sglang/srt/lora/backend/lora_registry.py`
- `sglang/python/sglang/srt/lora/lora_manager.py`
- `sglang/docs/docs/advanced_features/lora.mdx`
