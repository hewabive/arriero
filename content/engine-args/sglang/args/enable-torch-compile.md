---
schema: 1
engine: sglang
primaryName: "--enable-torch-compile"
title: "--enable-torch-compile"
summary: Компилирует decode-forward целиком через `torch.compile` в режиме `max-autotune-no-cudagraphs` перед записью CUDA graph; работает только для батчей не больше `--torch-compile-max-bs` и только при включенном decode-графе. Стоит минут старта на холодном кеше; апстрим помечает возможность как не поддерживаемую.
group: exec.graph
related:
  - --torch-compile-max-bs
  - --enable-torch-compile-debug-mode
  - --cuda-graph-backend-decode
  - --cuda-graph-backend-prefill
  - --cuda-graph-bs-decode
  - --cuda-graph-max-bs-decode
  - --disable-cuda-graph-padding
  - --disable-decode-cuda-graph
  - --cuda-graph-tc-compiler
  - --device
  - --speculative-algorithm
---

# --enable-torch-compile

## Кратко

Это отдельный от CUDA graph механизм: `torch.compile` трассирует forward модели и генерирует слитые Triton-ядра, а уже скомпилированный forward записывается в граф. Выигрыш ожидается на **маленьких моделях и маленьких батчах**, где доминируют накладные расходы запуска ядер; на крупных моделях он обычно теряется. Плата — минуты компиляции на первом старте и заметный риск: апстрим-документация прямо пишет, что возможность «out of maintenance and might cause error».

## Оригинальная справка

```text
Optimize the model with torch.compile. Experimental feature.
```

## Паспорт аргумента

- Флаги: `--enable-torch-compile`
- Группа: `exec.graph`
- Тип значения: bool, `action="store_true"` — значение не принимает
- Допустимые значения: флаг либо есть, либо его нет
- Значение по умолчанию: `false`
- Эффективное значение: `_handle_environment_variables` копирует его в переменную окружения `SGLANG_ENABLE_TORCH_COMPILE`. Во время прогрева `BaseRunner.warmup` может выключить компиляцию, если модель через Transformers-backend сообщает `_can_torch_compile = False` (лог «Transformers backend model reports it is not torch.compile compatible (e.g. dynamic rope scaling). Disabling torch.compile.»); `DecodeCudaGraphRunner.capture()` в этом случае пересчитывает список компилируемых форм
- Где объявлен: `ServerArgs.enable_torch_compile`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, помечен экспериментальным в собственной справке
- Этап применения: `__post_init__` (правило каскада prefill, установка env, ассерт совместимости) → прогрев и захват decode-графа (`patch_model` на каждую компилируемую форму) → реплей

## Что меняет в движке

### Что именно компилируется

`compilation/torch_compile_decoration.py:patch_model` оборачивает `model.forward`:

```python
torch.compile(
    torch.no_grad()(model.forward),
    mode=os.environ.get("SGLANG_TORCH_COMPILE_MODE", "max-autotune-no-cudagraphs"),
    dynamic=_is_hip and get_bool_env_var("SGLANG_TORCH_DYNAMIC_SHAPE"),
)
```

Обертка применяется в `DecodeCudaGraphRunner._capture_one_stream` только для форм из `compile_bs`, и `compile_bs = [bs for bs in capture_bs if bs <= torch_compile_max_bs]` (`base_cuda_graph_runner.py:get_batch_sizes_to_capture`). При дефолтном `--torch-compile-max-bs 32` и автоподобранном `max_bs 160` компилируются формы `1, 2, 4, 8, 12, 16, 24, 32` — восемь компиляций; остальные 16 форм захватываются без `torch.compile`.

Из этого следуют два практических вывода:

- **Без decode-графа флаг почти ничего не делает.** `EagerRunner` `torch.compile` не применяет, поэтому при `--disable-decode-cuda-graph` останется только побочный эффект — глобальная настройка dynamo/inductor.
- Модули `BaseFusedOp` на время компиляции переводятся в compile-режим (`enter_torch_compile`) и возвращаются обратно после.

`set_torch_compile_config()` включает `torch._inductor.config.coordinate_descent_tuning`, `triton.unique_kernel_names`, `fx_graph_cache`, поднимает лимиты кеша dynamo до 1024 и ставит патч `monkey_patch_torch_compile()`.

### Где живет кеш и что его сбрасывает

При `import sglang` вызывается `environ.redirect_third_party_caches()`, который через `os.environ.setdefault` направляет сторонние JIT-кеши в один каталог `SGLANG_CACHE_DIR` (по умолчанию `~/.cache/sglang`):

- `TORCHINDUCTOR_CACHE_DIR` → `~/.cache/sglang/inductor`;
- `TRITON_CACHE_DIR` → `~/.cache/sglang/triton`;
- `CUDA_CACHE_PATH` → `~/.cache/sglang/nv`;
- `FLASHINFER_WORKSPACE_BASE` → `~/.cache/sglang`.

Перенаправление не срабатывает, если переменная уже задана в окружении или если inductor успел разрешить свой каталог раньше; апстрим-документация (`server_arguments.mdx`) все еще называет старый путь `/tmp/torchinductor_root`, поэтому фактический каталог проверяйте по содержимому, а не по документации.

Кеш — это FX graph cache самого inductor. Его инвалидирует все, что меняет ключ компиляции: версия torch/triton/inductor, поколение GPU, набор inductor-конфигов (то есть в том числе смена `SGLANG_TORCH_COMPILE_MODE`), изменившийся граф модели (другая модель, другой dtype, другая квантизация, другой набор форм). Кеш переносим между машинами с одинаковым стеком — апстрим описывает это как штатный прием (`docs/docs/references/torch_compile_cache.mdx`).

### Что флаг выключает

`--enable-torch-compile` входит в правила `_disable_tc_piecewise_cudagraph_if_incompatible` («full torch.compile mode»): при незаданном `--cuda-graph-backend-prefill` и prefill-backend'е `tc_piecewise` prefill-граф выключается. Два механизма компиляции не складываются.

## Значения и формат

- Значения не принимает.
- Жесткая несовместимость: `assert not (disable_cuda_graph_padding and enable_torch_compile)` — сервер не стартует. Причина в тексте ассерта: без padding каждый размер батча получил бы собственный цикл компиляции и автотюнинга, то есть `O(max_batch_size)` компиляций.
- Режим компиляции переопределяется только переменной окружения `SGLANG_TORCH_COMPILE_MODE`, CLI-флага нет.
- Динамические формы (`dynamic=True`) включаются лишь на ROCm и лишь при `SGLANG_TORCH_DYNAMIC_SHAPE`.

## Когда использовать

- Маленькая модель (единицы миллиардов параметров) и маленькие батчи, где python/launch overhead — заметная доля времени шага. Апстрим формулирует это как «accelerates small models on small batch sizes».
- Спекулятивное декодирование EAGLE-2: апстрим предлагает `--enable-torch-compile --torch-compile-max-bs 8` как отдельный сценарий, честно предупреждая, что на H100 с уже включенными CUDA graph выигрыш может быть нулевым.
- `--device cpu`: там это не опция, а условие — CPU-граф захватывается только при `get_flags().capture.enable_torch_compile`.
- Не включайте на больших моделях и больших батчах: время старта вырастет на минуты, а выигрыша, скорее всего, не будет.
- Не включайте без измерения: это единственный способ узнать, есть ли эффект на вашей паре модель+железо.

## Влияние на производительность и память

- **Время старта.** Главная плата. `max-autotune-no-cudagraphs` перебирает конфигурации ядер для каждой компилируемой формы; на холодном кеше это минуты. На прогретом кеше — секунды.
- **Диск.** Каталог `~/.cache/sglang/inductor` и `~/.cache/sglang/triton` растут с числом форм и вариантов конфигурации.
- **RAM хоста.** Компиляция сама по себе прожорлива: dynamo-трассировка плюс сборка Triton-ядер.
- **VRAM.** Прямого влияния почти нет; захваченный граф от скомпилированного forward занимает столько же, сколько от обычного.
- **Latency.** Ради этого флаг и существует, но эффект узкий: только формы `bs <= --torch-compile-max-bs`, только при включенном decode-графе.

## Взаимодействие с другими аргументами

- `--torch-compile-max-bs`: единственная ручка, ограничивающая число компилируемых форм.
- `--enable-torch-compile-debug-mode`: относится к другому механизму (`tc_piecewise`), а не к этому флагу.
- `--disable-cuda-graph-padding`: взаимно исключающая комбинация, ассерт на старте.
- `--disable-decode-cuda-graph` / `--cuda-graph-backend-decode disabled`: обесценивают флаг.
- `--cuda-graph-bs-decode` / `--cuda-graph-max-bs-decode`: определяют исходный список форм, из которого выбирается `compile_bs`.
- `--cuda-graph-backend-prefill` / `--cuda-graph-tc-compiler`: путь `tc_piecewise` отключается этим флагом, если backend prefill не задан явно.
- `--speculative-algorithm`: EAGLE-draft-runner явно обнуляет свой `compile_bs`, то есть компилируется target-модель, а не draft.
- `--device cpu`: флаг обязателен для CPU-графа.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: --disable-cuda-graph-padding is incompatible with --enable-torch-compile.` **Решение:** убрать один из флагов.
- **Симптом:** старт занял 10+ минут. **Причина:** холодный кеш inductor. **Решение:** сохранить каталог кеша между запусками; в arriero это уровень пользователя, под которым работает менеджер, — `~/.cache/sglang`.
- **Симптом:** лог «Transformers backend model reports it is not torch.compile compatible … Disabling torch.compile.» **Причина:** модель через Transformers-backend несовместима (например динамическое масштабирование rope). Флаг молча выключен.
- **Симптом:** флаг включен, скорость не изменилась. **Причина:** реальные батчи больше `--torch-compile-max-bs` (по умолчанию 32) и компилируемых форм не касаются.
- **Симптом:** ошибки dynamo/inductor на старте. **Причина:** возможность заявлена вне поддержки. **Решение:** снять флаг; для prefill-компиляции используйте `--cuda-graph-backend-prefill tc_piecewise`.
- **Что смотреть:** `enable_torch_compile=True` в дампе `server_args=`, время в строке `Capture target decode CUDA graph end. elapsed=… s` (при компиляции оно резко больше обычного), наполнение каталога `~/.cache/sglang/inductor`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-4B --enable-torch-compile --torch-compile-max-bs 8
```

```bash
SGLANG_CACHE_DIR=/var/cache/sglang python -m sglang.launch_server --model-path /models/Qwen3-4B --enable-torch-compile --torch-compile-max-bs 16 --cuda-graph-max-bs-decode 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/compilation/torch_compile_decoration.py`
- `sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/base_runner.py`
- `sglang/python/sglang/srt/model_executor/cpu_graph_runner.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- `sglang/docs/docs/references/torch_compile_cache.mdx`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
