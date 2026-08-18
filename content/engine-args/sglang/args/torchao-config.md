---
schema: 1
engine: sglang
primaryName: "--torchao-config"
title: "--torchao-config"
summary: Онлайн-квантизация проекционных слоев средствами библиотеки `torchao` сразу после загрузки весов. Это путь квантизации, а не настройка графов, хотя объявлен в группе `exec.graph`; требует установленного пакета `torchao` и для `int8dq` — отключенного CUDA graph.
group: exec.graph
related:
  - --quantization
  - --load-format
  - --dtype
  - --enable-torch-compile
  - --disable-cuda-graph
  - --disable-decode-cuda-graph
  - --cuda-graph-backend-decode
  - --mem-fraction-static
  - --device
---

# --torchao-config

## Кратко

`--torchao-config` включает квантизацию весов «на лету»: модель загружается в исходной точности, а затем `torchao.quantization.quantize_` переписывает линейные слои, чьи имена содержат `proj`, в выбранный формат. Это отдельный от `--quantization` механизм — он не читает конфиг чекпойнта и не требует заранее квантованных весов. Возможность помечена экспериментальной в собственной справке; в группе `exec.graph` она оказалась исторически, рядом с `torch.compile`.

## Оригинальная справка

```text
Optimize the model with torchao. Experimental feature. Current choices are: int8dq, int8wo, int4wo-<group_size>, fp8wo, fp8dq-per_tensor, fp8dq-per_row
```

## Паспорт аргумента

- Флаги: `--torchao-config`
- Группа: `exec.graph`
- Тип значения: строка
- Допустимые значения: `choices` в argparse нет, но `apply_torchao_config_to_model` распознает только `int8dq`, `int8wo`, `int4wo-<group_size>`, `fp8wo`, `fp8dq-per_tensor`, `fp8dq-per_row`; все остальное падает с `ValueError: Unexpected config: <значение>`
- Значение по умолчанию: пустая строка `""` — квантизация выключена
- Эффективное значение: не переопределяется в `__post_init__`; читается из `get_exec().graph.torchao_config`
- Где объявлен: `ServerArgs.torchao_config`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, помечен экспериментальным в собственной справке
- Этап применения: загрузка весов → `ModelRunner.maybe_apply_post_load_model_transforms` (или послойно внутри `LayeredModelLoader`, если задан `--load-format layered`)

## Что меняет в движке

`layers/torchao_utils.py:apply_torchao_config_to_model` подбирает функцию `torchao` по **вхождению подстроки** в заданное значение, в фиксированном порядке проверок:

| Подстрока | Что применяется | Фильтр слоев |
| --- | --- | --- |
| `int8wo` | `int8_weight_only()` | `proj_filter_conv3d` |
| `int8dq` | `int8_dynamic_activation_int8_weight()` | `proj_filter` |
| `int4wo` | `int4_weight_only(group_size=<число после дефиса>)` | `proj_filter` |
| `fp8wo` | `float8_weight_only()` | `proj_filter_conv3d` |
| `fp8dq` | `float8_dynamic_activation_float8_weight(granularity=PerRow()/PerTensor())` | `proj_filter_conv3d` |

`proj_filter` пропускает модули, у которых в полном имени встречается `proj`; `proj_filter_conv3d` делает то же, но дополнительно пропускает `torch.nn.Conv3d` с предупреждением `Quantize: skipping <fqn> because it's a Conv3d`. Слои внимания и MLP, названные иначе, не квантуются вовсе.

Место применения зависит от `--load-format`:

- обычный загрузчик: веса грузятся целиком, затем `maybe_apply_post_load_model_transforms` вызывает квантизацию один раз для всей модели. Пик памяти при загрузке — полный размер модели в исходной точности;
- `--load-format layered` (`LayeredModelLoader`): каждый модуль квантуется сразу после заполнения весами, что снижает пиковую память загрузки; в конце модель помечается `torchao_applied = True`, и повторного применения не происходит.

Пакет `torchao` импортируется лениво, внутри функции. В checkout'е он объявлен в основных зависимостях `python/pyproject.toml` (`torchao==0.17.0`), но в конкретном окружении (для arriero это закрепленная пара `sglang-kt` + `kt-kernel`) его может не оказаться — тогда вы получите `ModuleNotFoundError: No module named 'torchao'` в момент загрузки модели, а не при разборе аргументов.

## Значения и формат

- Пустая строка (значение по умолчанию) — квантизация выключена; явно передавать `--torchao-config ""` не нужно.
- Разбор по подстроке означает, что `int4wo-128` работает, а `int4wo` без числа падает на `int("int4wo")` с `ValueError`. Допустимые размеры группы: `32`, `64`, `128`, `256` — иначе `AssertionError: int4wo groupsize needs to be one of [32, 64, 128, 256] but got …`.
- `fp8dq` требует суффикса: `per_row` или `per_tensor`, иначе `AssertionError: Supported granularity are: dict_keys(['per_row', 'per_tensor']), got …`.
- `fp8wo` требует железа с compute capability ≥ 8.9: на более старых картах падает с `AssertionError: fp8e4nv data type is not supported on CUDA arch < 89`.
- Опечатка в имени метода не отвергается argparse — она долетает до загрузки модели и роняет процесс с `ValueError: Unexpected config: …`.

## Когда использовать

- Нужно уменьшить объем весов в VRAM, а квантованного чекпойнта нет и конвертировать его нечем. `int4wo-128` уменьшает проекционные веса примерно вчетверо относительно bf16.
- Апстрим-документация по квантизации приводит `--torchao-config int4wo-128` как штатный пример для Llama-3.1-8B и `int4wo-128` же — как рекомендацию для NVIDIA Jetson, где память дефицитна.
- Не используйте, если у модели уже есть квантованный чекпойнт: `--quantization` (fp8, awq, gptq, modelopt) даст лучшее качество и лучшие ядра.
- Не используйте на MoE-моделях с оффлоадом экспертов (профиль SGLang-KT в arriero): квантуются только слои с `proj` в имени, а вес экспертов живет в CPU-бэкенде KTransformers и этим путем не затрагивается — вы заплатите за загрузку и не получите экономии там, где она нужна.
- Не сочетайте `int8dq` с включенным CUDA graph: апстрим прямо документирует несовместимость (issue #2219) и рекомендует отключать графы.

## Влияние на производительность и память

- **VRAM (веса).** Основной эффект. Уменьшаются только проекционные слои; эмбеддинги, нормализации и все, что не названо `proj`, остаются в исходной точности. Реальную экономию видно по строке `Memory pool end. avail mem=… GB` и по величине `max_total_num_tokens` — освободившаяся память уходит в KV-пул при незаданном `--mem-fraction-static`.
- **Время старта.** Растет: квантизация выполняется в процессе загрузки. `--load-format layered` перераспределяет пик памяти, но не ускоряет.
- **Latency и throughput.** Непредсказуемы: `int8wo`/`int4wo` уменьшают трафик памяти, но требуют деквантизации в ядрах; `int8dq`/`fp8dq` квантуют еще и активации. Выигрыш зависит от модели, формы батча и поддержки ядер в установленной версии `torchao`.
- **Качество.** Онлайн-квантизация без калибровки; для `int4wo` деградация может быть заметной.
- **RAM хоста.** Пик при загрузке — как у обычного пути, если не задан `--load-format layered`.

## Взаимодействие с другими аргументами

- `--quantization`: независимый механизм для чекпойнтов, квантованных заранее. Одновременное использование не проверяется движком и не имеет смысла.
- `--load-format layered`: переносит квантизацию внутрь загрузки, снижая пик памяти.
- `--disable-cuda-graph` / `--disable-decode-cuda-graph` / `--cuda-graph-backend-decode disabled`: практически обязательны для `int8dq`.
- `--enable-torch-compile`: сочетание не проверяется; квантованные слои `torchao` и `max-autotune` компиляция — два независимых экспериментальных пути, риск ошибок складывается.
- `--dtype`: определяет исходную точность, из которой идет квантизация.
- `--mem-fraction-static`: при незаданном значении освободившаяся память автоматически уйдет в KV-пул.
- `--device`: `fp8wo`/`fp8dq` требуют современных NVIDIA-карт; на CPU и прочих устройствах эти пути не проверялись.

## Типовые проблемы и диагностика

- **Симптом:** `ModuleNotFoundError: No module named 'torchao'` при загрузке модели. **Причина:** пакет не установлен в окружении движка. **Проверка:** `<env>/bin/python -c "import torchao; print(torchao.__version__)"`.
- **Симптом:** `ValueError: Unexpected config: int4wo128`. **Причина:** пропущен дефис перед размером группы.
- **Симптом:** `AssertionError: int4wo groupsize needs to be one of [32, 64, 128, 256]`.
- **Симптом:** `AssertionError: fp8e4nv data type is not supported on CUDA arch < 89` — `fp8wo`/`fp8dq` на карте старше Ada/Hopper.
- **Симптом:** нужного сокращения памяти не произошло. **Причина:** у модели мало слоев с `proj` в имени или основной вес лежит в экспертах/эмбеддингах. **Проверка:** сравните `Memory pool end. avail mem=… GB` с запуском без флага.
- **Симптом:** мусорный вывод при `int8dq`. **Решение:** отключить CUDA graph, как рекомендует апстрим.
- **Что смотреть:** `torchao_config='…'` в дампе `server_args=`, предупреждения `Quantize: skipping … because it's a Conv3d`, и объем свободной памяти после загрузки весов.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --torchao-config int4wo-128
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3.1-8B-Instruct --torchao-config int8dq --disable-decode-cuda-graph --disable-prefill-cuda-graph
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/torchao_utils.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/pyproject.toml`
- `sglang/docs/docs/advanced_features/quantization.mdx`
- `sglang/docs/docs/hardware-platforms/nvidia_jetson.mdx`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`
