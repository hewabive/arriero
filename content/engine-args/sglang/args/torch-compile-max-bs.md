---
schema: 1
engine: sglang
primaryName: "--torch-compile-max-bs"
title: "--torch-compile-max-bs"
summary: Верхняя граница размера батча, для которого при `--enable-torch-compile` применяется `torch.compile`; батчи выше нее захватываются в CUDA graph без компиляции. Объявленный дефолт 32 действует на GPU; на `--device cpu` значение переписывается движком.
group: exec.graph
related:
  - --enable-torch-compile
  - --enable-torch-compile-debug-mode
  - --cuda-graph-max-bs-decode
  - --cuda-graph-bs-decode
  - --disable-cuda-graph-padding
  - --disable-decode-cuda-graph
  - --device
  - --speculative-algorithm
  - --max-running-requests
---

# --torch-compile-max-bs

## Кратко

`torch.compile` в SGLang применяется не ко всей модели целиком и не ко всем батчам, а по формам: из списка захватываемых decode-форм берется подмножество `bs <= --torch-compile-max-bs`, и только эти формы компилируются перед записью в CUDA graph. Флаг напрямую задает, сколько компиляций произойдет на старте — а компиляция в режиме `max-autotune-no-cudagraphs` стоит дорого. Без `--enable-torch-compile` на GPU значение не используется.

## Оригинальная справка

```text
Set the maximum batch size when using torch compile.
```

## Паспорт аргумента

- Флаги: `--torch-compile-max-bs`
- Группа: `exec.graph`
- Тип значения: int
- Допустимые значения: положительное целое; argparse границ не проверяет
- Значение по умолчанию: `32`
- Эффективное значение: на GPU-устройствах остается заданным. На `--device cpu` в `_handle_gpu_memory_settings` **переписывается**: при заданном `--cuda-graph-bs-decode` становится `max(bs)`, иначе `torch_compile_max_bs or decode.max_bs`, после чего `decode.max_bs` приравнивается к нему; там же стоит ассерт `torch_compile_max_bs > 0`
- Где объявлен: `ServerArgs.torch_compile_max_bs`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (только для `--device cpu`) → `get_batch_sizes_to_capture` при создании decode-runner'а → захват графов

## Что меняет в движке

### На GPU

`get_batch_sizes_to_capture` (`model_executor/runner/base_cuda_graph_runner.py`) в конце строит два списка:

```python
compile_bs = (
    [bs for bs in capture_bs if bs <= server_args.torch_compile_max_bs]
    if get_flags().capture.enable_torch_compile
    else []
)
```

Дальше `DecodeCudaGraphRunner._capture_one_stream` для каждой формы вызывает `patch_model(model, bs in self.compile_bs, …)`: при попадании в подмножество forward оборачивается `torch.compile`, иначе используется как есть. То есть флаг задает **границу между компилируемой и некомпилируемой частью** одного и того же списка захватываемых форм.

Численно: при автоподобранном `--cuda-graph-max-bs-decode 160` захватываются 24 формы, из них при дефолтном `--torch-compile-max-bs 32` компилируются восемь (`1, 2, 4, 8, 12, 16, 24, 32`). Подняв флаг до 160, вы получите 24 компиляции вместо восьми.

Если `--enable-torch-compile` не задан, `compile_bs` пуст, и значение флага ни на что не влияет.

### На CPU

На `--device cpu` CUDA graph отсутствует, а его роль играет CPU-граф на базе `torch.compile` (`model_executor/cpu_graph_runner.py`). Там `--torch-compile-max-bs` становится основным ограничителем:

- если задан `--cuda-graph-bs-decode`, флаг переписывается на максимум этого списка;
- иначе из флага (или из `decode.max_bs`, если флаг пуст) генерируется список форм `_generate_cpu_graph_batch_sizes()`: `range(1, 17)` + `range(18, 31, 2)` + `range(32, 81, 4)` + `range(84, max+1, 8)`, плюс сам максимум;
- `decode.max_bs` приравнивается к флагу;
- в `cpu_graph_runner.get_batch_sizes_to_capture` стоит ассерт `max(capture_bs) <= torch_compile_max_bs`.

## Значения и формат

- Целое число. Ноль или отрицательное значение на CPU падает ассертом `cuda_graph_config[decode].bs should contain positive batch sizes`; на GPU даст пустой `compile_bs`, то есть тихо отключит компиляцию.
- Значение больше `--cuda-graph-max-bs-decode` безвредно: подмножество ограничено самим списком захватываемых форм.
- Специальных значений (`-1`, `auto`) нет.
- Флаг не входит в схему `--cuda-graph-config` — он самостоятельное поле `ServerArgs`, а не ключ `PhaseConfig`.

## Когда использовать

- Уменьшать, когда старт с `--enable-torch-compile` слишком долгий: каждая исключенная форма — это один цикл автотюнинга меньше.
- Увеличивать, когда реальные батчи стабильно выше 32 и вы измерением подтвердили, что компиляция дает выигрыш именно на них.
- На `--device cpu` — задавать осознанно: это единственный потолок форм CPU-графа.
- Не поднимать «про запас»: компилируются все формы до границы, а не только граничная, и стоимость растет линейно.
- Не задавать без `--enable-torch-compile` на GPU: значение будет проигнорировано.

## Влияние на производительность и память

- **Время старта.** Линейно по числу компилируемых форм. На холодном кеше inductor каждая форма — десятки секунд; на прогретом — секунды.
- **Диск.** Кеш растет с числом скомпилированных форм (`~/.cache/sglang/inductor`, `~/.cache/sglang/triton`, база — `SGLANG_CACHE_DIR`).
- **VRAM.** Практически не меняется: захваченный граф от скомпилированного forward занимает столько же, сколько от обычного. Исключение — CPU-путь, где флаг задает `decode.max_bs` и, значит, размер статических буферов.
- **Latency.** Улучшается только на батчах внутри границы, и только если компиляция вообще что-то дает на этой модели.

## Взаимодействие с другими аргументами

- `--enable-torch-compile`: без него флаг не читается на GPU.
- `--cuda-graph-max-bs-decode` / `--cuda-graph-bs-decode`: задают список, из которого берется подмножество; на CPU связь обратная — список выводится из `--torch-compile-max-bs`.
- `--disable-cuda-graph-padding`: комбинация с `--enable-torch-compile` запрещена ассертом именно из-за взрыва числа компиляций.
- `--disable-decode-cuda-graph`: на GPU обесценивает и `--enable-torch-compile`, и этот флаг.
- `--device cpu`: значение переписывается движком и задает формы CPU-графа независимо от `--enable-torch-compile`, но сам CPU-граф без этого флага не захватывается.
- `--speculative-algorithm`: EAGLE-draft-runner обнуляет свой `compile_bs`, так что граница касается target-модели.
- `--max-running-requests`: реальный предел батчей; граница выше него бессмысленна.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: capture_bs=…, server_args.torch_compile_max_bs=…` на `--device cpu`. **Причина:** заданный `--cuda-graph-bs-decode` содержит форму больше границы. **Решение:** поднять флаг до максимума списка.
- **Симптом:** `--enable-torch-compile` задан, старт быстрый, эффекта нет. **Причина:** граница ниже реальных батчей. **Проверка:** сопоставьте `--torch-compile-max-bs` с `#running-req` в строках `Decode batch, …`.
- **Симптом:** старт вырос в разы после подъема границы. Ожидаемо: скомпилировано больше форм.
- **Симптом:** `AssertionError: cuda_graph_config[decode].bs should contain positive batch sizes`. **Причина:** нулевое или отрицательное значение на CPU-пути.
- **Что смотреть:** `torch_compile_max_bs=` в дампе `server_args=` (на CPU там уже переписанное значение) и время в строке `Capture target decode CUDA graph end. elapsed=… s`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-4B --enable-torch-compile --torch-compile-max-bs 8
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-4B --device cpu --enable-torch-compile --torch-compile-max-bs 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/cpu_graph_runner.py`
- `sglang/python/sglang/srt/compilation/torch_compile_decoration.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
