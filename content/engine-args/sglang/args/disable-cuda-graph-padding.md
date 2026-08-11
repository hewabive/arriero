---
schema: 1
engine: sglang
primaryName: "--disable-cuda-graph-padding"
title: "--disable-cuda-graph-padding"
summary: Запрещает дополнять батч до ближайшего захваченного размера: вместо разреженной сетки захватывается **каждый** размер от 1 до максимума. Убирает потери на padding ценой сотен графов, десятков секунд захвата и заметно большего расхода VRAM.
group: exec.graph
related:
  - --cuda-graph-max-bs-decode
  - --cuda-graph-bs-decode
  - --cuda-graph-backend-decode
  - --disable-decode-cuda-graph
  - --cuda-graph-config
  - --enable-torch-compile
  - --torch-compile-max-bs
  - --mem-fraction-static
  - --max-running-requests
  - --speculative-algorithm
---

# --disable-cuda-graph-padding

## Кратко

По умолчанию decode-граф захватывается для разреженного набора размеров батча, и реальный батч дополняется до ближайшего сверху: батч 130 при захваченных `128, 136` исполняется как 136. Этот флаг отключает такое дополнение. Последствие двойное: во-первых, генератор форм переключается на сплошной диапазон `1…max_bs`; во-вторых, во время исполнения граф применяется только при точном совпадении формы. Флаг относится к decode-фазе и к спекулятивным draft-runner'ам; prefill-граф свою логику padding'а не меняет.

## Оригинальная справка

```text
Disable cuda graph when padding is needed. Still uses cuda graph when padding is not needed.
```

## Паспорт аргумента

- Флаги: `--disable-cuda-graph-padding`
- Группа: `exec.graph`
- Тип значения: bool, `action="store_true"` — значение не принимает
- Допустимые значения: флаг либо есть, либо его нет
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; но есть жесткая проверка — `assert not (disable_cuda_graph_padding and enable_torch_compile)`, сервер не стартует при обоих флагах
- Где объявлен: `ServerArgs.disable_cuda_graph_padding`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (генерация списка форм в `_generate_decode_cuda_graph_batch_sizes` / `_generate_cpu_graph_batch_sizes`) → создание decode-runner'а (`self.disable_padding`) → каждый выбор графа в `can_run_graph`

## Что меняет в движке

### На этапе генерации форм

`_generate_decode_cuda_graph_batch_sizes(max_bs)` при взведенном флаге возвращает `list(range(1, max_bs + 1))` — все размеры подряд, вместо сетки `[1, 2, 4, 8, 12] + range(16, 257, 8) + …`. Аналогично `_generate_cpu_graph_batch_sizes` для `--device cpu`. Разница драматична: `max_bs 160` — 24 формы против 160, `max_bs 512` — 52 против 512.

Если формы заданы вручную через `--cuda-graph-bs-decode`, генератор не вызывается и состав списка флаг не меняет — остается только эффект времени исполнения.

### На этапе исполнения

`DecodeCudaGraphRunner` сохраняет флаг как `self.disable_padding`. В `can_run_graph` проверка допустимости батча меняется:

```python
is_bs_supported = (
    self.backend.can_run(forward_batch, graph_key)   # точное совпадение формы
    if self.disable_padding
    else cuda_graph_bs <= self.max_bs                # с дополнением
)
```

То есть при взведенном флаге граф применяется, только если ровно эта форма была захвачена; иначе батч идет в eager. Тот же флаг читают спекулятивные runner'ы (`eagle_draft_cuda_graph_runner.py`, `eagle_draft_extend_cuda_graph_runner.py`, `frozen_kv_mtp_cuda_graph_runner.py`, `multi_layer_eagle_draft_extend_cuda_graph_runner.py`) и `cpu_graph_runner.py`.

Режим compact ragged verify (`SGLANG_RAGGED_VERIFY_MODE`) с этим флагом несовместим и падает с `ValueError: Compact ragged verify does not support two-batch-overlap, LoRA, or disable-cuda-graph-padding …`.

## Значения и формат

- Значения не принимает.
- Отменить нельзя: парного `--no-` варианта нет, поле сбрасывается только отсутствием флага.
- Комбинация с `--enable-torch-compile` отвергается ассертом на старте с явным текстом: без padding каждый размер батча получил бы собственный цикл `torch.compile` + автотюнинг Triton, то есть `O(max_batch_size)` компиляций, и инициализация встала бы на много минут.
- Со списком `--cuda-graph-bs-decode` флаг остается в силе как правило исполнения: батчи, не совпавшие с элементом списка точно, пойдут в eager.

## Когда использовать

- Только при маленьком `--cuda-graph-max-bs-decode`. При `max_bs 8` сплошной диапазон — это 8 форм вместо 4, и цена приемлема.
- Когда padding реально дорог: большие модели, где лишние строки в батче стоят заметных вычислений, и при этом реальные размеры батчей распределены плотно.
- Для измерений: чистая latency без эффекта дополнения — полезный референс при сравнении конфигураций.
- **Не включайте на дефолтных `max_bs` 160–512.** 160–512 захватов — это минуты старта и кратно больший расход VRAM на графы; выигрыш от отсутствия padding почти всегда меньше.
- Не включайте вместе с `--enable-torch-compile` — сервер не стартует.

## Влияние на производительность и память

- **Время старта.** Растет пропорционально числу форм: с 24 до 160 при `max_bs 160`, то есть примерно в 6–7 раз.
- **VRAM.** Каждый захваченный граф занимает память в общем mempool. Априорный резерв в автоподборе `--mem-fraction-static` при этом **не меняется**: `reserve_for_graph_mb()` считает `decode.max_bs * 2` МиБ и не смотрит на длину списка. То есть при взведенном флаге автоподбор систематически недооценивает расход — при явно заданном `--mem-fraction-static` это прямой путь к OOM на захвате.
- **Latency.** На покрытых размерах — небольшой выигрыш (нет лишних строк). На непокрытых (например при заданном вручную списке) — полный откат в eager, то есть заметная потеря.
- **RAM хоста:** без изменений.

## Взаимодействие с другими аргументами

- `--cuda-graph-max-bs-decode`: единственная ручка, ограничивающая взрыв числа форм.
- `--cuda-graph-bs-decode`: при заданном списке флаг не меняет его состав, но продолжает требовать точного совпадения при исполнении.
- `--enable-torch-compile`: взаимно исключающая комбинация, ассерт на старте.
- `--torch-compile-max-bs`: на `--device cpu` определяет длину сплошного диапазона (`range(1, torch_compile_max_bs + 1)`).
- `--speculative-algorithm`: спекулятивная сетка тоже заменяется на сплошной диапазон; кроме того, флаг несовместим с compact ragged verify.
- `--max-running-requests`: реальный предел, до которого доходит сплошной диапазон после фильтрации.
- `--mem-fraction-static`: при взведенном флаге задавайте его вручную и с запасом.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: --disable-cuda-graph-padding is incompatible with --enable-torch-compile.` **Решение:** убрать один из флагов.
- **Симптом:** старт растянулся в разы, в логе сотни шагов `Capturing batches (bs=…)`. **Причина:** сплошной диапазон. **Решение:** уменьшить `--cuda-graph-max-bs-decode` или снять флаг.
- **Симптом:** `torch.OutOfMemoryError` при захвате, хотя раньше все помещалось. **Причина:** резерв автоподбора не учитывает рост числа графов. **Решение:** опустить `--mem-fraction-static` на 0.03–0.05.
- **Симптом:** `ValueError: Compact ragged verify does not support … disable-cuda-graph-padding`. **Решение:** снять флаг либо `SGLANG_RAGGED_VERIFY_MODE`.
- **Что смотреть:** длина списка `bs=[…]` в строке `Capture target decode CUDA graph begin` — при взведенном флаге это сплошной ряд `[1, 2, 3, 4, …]`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --disable-cuda-graph-padding --cuda-graph-max-bs-decode 8
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --disable-cuda-graph-padding --cuda-graph-max-bs-decode 16 --max-running-requests 16 --mem-fraction-static 0.8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/cpu_graph_runner.py`
- `sglang/python/sglang/srt/speculative/eagle_draft_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`
