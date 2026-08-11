---
schema: 1
engine: vllm
primaryName: "--enforce-eager"
title: "--enforce-eager"
summary: Выключает не только CUDA graphs, но и `torch.compile` целиком — эквивалент `-cc.mode=none -cc.cudagraph_mode=none`. Освобождает память графового пула и радикально ускоряет старт ценой latency декодирования.
group: ModelConfig
related:
  - --compilation-config
  - --cudagraph-capture-sizes
  - --max-cudagraph-capture-size
  - --gpu-memory-utilization
  - --kv-cache-memory-bytes
  - --speculative-config
---

# --enforce-eager

## Кратко

Справка говорит про CUDA graphs, но реальный эффект шире: `--enforce-eager` переводит `CompilationConfig.mode` в `NONE` и `cudagraph_mode` в `NONE`. То есть отключается и захват CUDA-графов, и компиляция модели через `torch.compile`.

Отсюда три практических следствия: старт становится намного короче (нет компиляции и нет захвата), пул CUDA-графов исчезает из бюджета памяти и целиком уходит в KV-cache, а latency декодирования растёт из-за накладных расходов на запуск ядер.

## Оригинальная справка

```text
Whether to always use eager-mode PyTorch. If True, we will disable CUDA
graph and always execute the model in eager mode. If False, we will use
CUDA graph and eager execution in hybrid for maximal performance and
flexibility.
```

## Паспорт аргумента

- Флаги: `--enforce-eager`, `--no-enforce-eager`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enforce-eager` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: принудительно становится `True` для encoder-decoder моделей на ROCm (`ModelConfig._verify_cuda_graph`, лог `CUDA graph is not supported for %s on ROCm yet, fallback to eager mode.`); у speculative-конфига есть собственное поле `enforce_eager`, переопределяющее значение для черновой модели
- Где объявлен: `vllm/config/model.py:ModelConfig.enforce_eager`
- Этап применения: сборка `VllmConfig` (правка `CompilationConfig`) → прогрев worker'а (пропуск `capture_model()`) → каждый forward

## Что меняет в движке

**Правка компиляции.** `VllmConfig.__post_init__`:

```
logger.warning_once("Enforce eager set, disabling torch.compile and CUDAGraphs. "
                    "This is equivalent to setting -cc.mode=none -cc.cudagraph_mode=none")
self.compilation_config.mode = CompilationMode.NONE
self.compilation_config.cudagraph_mode = CUDAGraphMode.NONE
```

Ниже, в блоке настройки графов, при `enforce_eager` дополнительно: `cudagraph_mode = NONE`, `max_cudagraph_capture_size = 0`, `cudagraph_capture_sizes = []`, лог `Cudagraph is disabled under eager mode`. Ветка `_set_cudagraph_sizes()` для eager не выполняется.

**Прогрев.** `Worker.compile_or_warm_up_model` (`vllm/v1/worker/gpu_worker.py`):

```
cuda_graph_memory_bytes = 0
if not self.model_config.enforce_eager:
    cuda_graph_memory_bytes = self.model_runner.capture_model()
```

То есть шаг захвата пропускается целиком. `kernel_warmup(self)` при этом выполняется в любом случае.

**Память.** Профилирование (`Worker.determine_available_memory`) отдельно оценивает объём CUDA-графов и вычитает его из бюджета. При eager этой статьи нет, и весь остаток бюджета `--gpu-memory-utilization` уходит в KV-cache. Именно поэтому eager иногда единственный способ поднять модель на тесной карте.

**Прочие потребители.** `enforce_eager` читают также `all2all_utils` (`use_cudagraph = not enforce_eager` для all2all-путей MoE) и spec-decode (`llm_base_proposer`, `extract_hidden_states`) — их графовые пути тоже отключаются.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False` = гибридный режим (компиляция + графы + eager там, где графы неприменимы).
- `--no-enforce-eager` — явное подтверждение дефолта.
- Более тонкая настройка возможна не этим флагом, а `--compilation-config` (`-cc`): можно оставить компиляцию, но отключить графы (`-cc.cudagraph_mode=none`), или наоборот сузить набор захватываемых размеров.

## Когда использовать

- **Тесная карта.** Убрать графовый пул из бюджета и отдать его KV-cache. Проверять по строке `Available KV cache memory: X GiB` до и после.
- **Диагностика.** Падение внутри `torch.compile`/захвата графа, непонятный стек, странная численность: eager даёт нормальные трейсбеки и воспроизводимый порядок операций.
- **Быстрая итерация.** Старт без компиляции — секунды вместо минут; удобно при подборе других аргументов.
- **Экзотическая связка модель/backend**, где захват графов не работает.
- **Не используйте в проде по умолчанию.** Дельта latency на декодировании при малом батче значительная: каждый шаг — это сотни отдельных запусков ядер вместо одного графа.

## Влияние на производительность и память

- **VRAM.** Убирает статью «CUDAGraph memory» из профилирования; при том же `--gpu-memory-utilization` KV-cache растёт ровно на эту величину.
- **Время старта.** Пропадают и компиляция, и захват графов для всех размеров батча — обычно самая долгая часть старта.
- **Latency.** Растёт на декодировании, где батч мал и накладные расходы на запуск ядер доминируют. На prefill с большими батчами разница меньше.
- **Throughput.** Под конкурентной нагрузкой просадка меньше, чем на одиночном запросе, но она есть.
- **CPU хоста.** Eager-исполнение нагружает Python/CPU сильнее: launch-overhead ложится на управляющий поток.

## Взаимодействие с другими аргументами

- `--compilation-config`: перекрывается полностью. `--enforce-eager` — грубый эквивалент `-cc.mode=none -cc.cudagraph_mode=none`; если нужно отключить только графы, используйте `-cc`, а не этот флаг.
- `--cudagraph-capture-sizes`, `--max-cudagraph-capture-size`: обнуляются при eager (`cudagraph_capture_sizes = []`, `max_cudagraph_capture_size = 0`), задавать их вместе с флагом бессмысленно.
- `--gpu-memory-utilization`, `--kv-cache-memory-bytes`: eager меняет распределение внутри бюджета, а не сам бюджет.
- `--speculative-config`: у черновой модели своё поле `enforce_eager`, поэтому режимы target- и draft-модели могут различаться.
- `--disable-cascade-attn`: при eager исчезает предупреждение про piecewise-графы для cascade — графов нет в принципе.

## Типовые проблемы и диагностика

- **Симптом:** после добавления флага упал throughput, но вырос `GPU KV cache size`. **Причина:** штатный размен графов на KV-cache. **Решение:** решить, что важнее; промежуточный вариант — `-cc.cudagraph_mode=none` с сохранённой компиляцией.
- **Симптом:** в логе `CUDA graph is not supported for <model_type> on ROCm yet, fallback to eager mode.`, хотя флаг не задавался. **Причина:** encoder-decoder на ROCm; движок сам включил eager.
- **Симптом:** `Enforce eager set, disabling torch.compile and CUDAGraphs. This is equivalent to setting -cc.mode=none -cc.cudagraph_mode=none` — и вы не ожидали отключения компиляции. **Причина:** это и есть полный эффект флага, справка описывает только его часть.
- **Симптом:** OOM ушёл, но latency неприемлема. **Лечение:** вернуть графы и вместо eager снизить `--max-num-seqs` или `--max-model-len`, либо ограничить `--cudagraph-capture-sizes` небольшим набором.
- **Подтверждение принятого значения:** строка стартового конфига содержит `enforce_eager=True`; в логе профилирования статья `... for CUDAGraph memory` будет нулевой, а строки `Capturing CUDA graphs` не появится.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enforce-eager --gpu-memory-utilization 0.85 --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-4B --enforce-eager --max-num-seqs 4 --kv-cache-dtype fp8
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/worker/gpu_worker.py`
- `vllm/vllm/model_executor/layers/fused_moe/all2all_utils.py`
- `vllm/vllm/config/speculative.py`
- `vllm/docs/configuration/conserving_memory.md`
