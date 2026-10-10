---
schema: 1
engine: sglang
primaryName: "--dllm-algorithm"
title: "--dllm-algorithm"
summary: Переключает сервер в отдельный режим обслуживания — диффузионные LLM, где токены не генерируются слева направо, а разглаживаются блоками. Задание алгоритма перестраивает планировщик, `--page-size` и attention backend и молча выключает несовместимое: часть кешей, PP, LoRA, PD disaggregation, mixed chunk.
group: exec.dllm
related:
  - --dllm-algorithm-config
  - --dllm-fdfo
  - --page-size
  - --attention-backend
  - --disable-overlap-schedule
  - --disable-radix-cache
  - --enable-hierarchical-cache
  - --enable-lmcache
  - --max-running-requests
  - --disable-cuda-graph
  - --enable-flexkv
  - --pp-size
  - --enable-lora
  - --disaggregation-mode
  - --enable-mixed-chunk
---

# --dllm-algorithm

## Кратко

Это не «еще одна ручка», а переключатель режима работы всего сервера. Диффузионная LLM (LLaDA2-MoE, SDAR) генерирует блок фиксированной длины целиком, заполненный маскирующим токеном, и за несколько шагов «разглаживает» его, раскрывая на каждом шаге те позиции, в которых уверена. `--dllm-algorithm` задает имя класса, реализующего правило раскрытия. Пока значение не задано, ни один из остальных `dllm`-аргументов не читается и режим не активен.

Включение режима переписывает целый набор соседних настроек: overlap-планировщик выключается, `--page-size` приравнивается к размеру блока модели, attention backend может смениться на `flashinfer` (или `triton`/`ascend` на других платформах), иерархический кеш, LMCache и FlexKV отключаются, piecewise CUDA graph запрещается. Pipeline parallelism, LoRA, PD disaggregation и mixed chunk сбрасываются с warning'ом, а не отказом на старте.

## Оригинальная справка

```text
The diffusion LLM algorithm, such as LowConfidence.
```

## Паспорт аргумента

- Флаги: `--dllm-algorithm`
- Группа: `exec.dllm`
- Тип значения: str (`Optional[str]`) — имя класса алгоритма
- Допустимые значения: в argparse не ограничены (`choices: null`). Список собирается в runtime: `import_algorithms` перебирает модули пакета `sglang.srt.dllm.algorithm` и берет из каждого атрибут `Algorithm`. В checkout'е это `LowConfidence` (`low_confidence.py`), `JointThreshold` (`joint_threshold.py`) и `Gemma4Renoise` (`gemma4_renoise.py`, только для DiffusionGemma). Посмотреть список на своей сборке: `python -c "from sglang.srt.dllm.algorithm import algo_name_to_cls; print(list(algo_name_to_cls))"`
- Значение по умолчанию: `null` — режим выключен
- Эффективное значение: совпадает с заданным; вместо него резолв декларирует новые значения соседних аргументов
- Где объявлен: `python/sglang/srt/arg_groups/fields/exec_.py:ExecDllm.dllm_algorithm`
- Статус: обычный, но отдельный режим обслуживания — комбинировать его с остальной функциональностью сервера нельзя произвольно
- Этап применения: `ServerArgs.resolve_once` → `run_resolution_pipeline`, шаг `handle_dllm_inference` (`python/sglang/srt/arg_groups/dllm_hook.py`; внутри — `configure_server_args` класса алгоритма, три пасса резолюции из `arg_groups/overrides.py` и сбросы несовместимых режимов) → инициализация scheduler'а (`DllmConfig.from_server_args`, `get_algorithm`) → каждый forward

## Что меняет в движке

### Поддерживаемые модели и параметры блока

`DllmConfig.from_server_args` (`sglang/python/sglang/srt/dllm/config.py`) держит таблицу архитектур:

| Архитектура | `block_size` | `mask_id` |
| --- | --- | --- |
| `LLaDA2MoeModelLM` | 32 | 156895 |
| `SDARForCausalLM` | 4 | 151669 |
| `SDARMoeForCausalLM` | 4 | 151669 |
| `DiffusionGemmaForBlockDiffusion` | `canvas_length` из конфига модели (без него 256) | -1 |

Любая другая архитектура — `RuntimeError: Unknown diffusion LLM: <arch>`. Неизвестное имя алгоритма — `RuntimeError: Unknown diffusion LLM algorithm: <name>`. Пара «архитектура — алгоритм» проверяется в обе стороны: `DiffusionGemmaForBlockDiffusion` принимает только `Gemma4Renoise` (`ValueError: DiffusionGemmaForBlockDiffusion requires the Gemma4Renoise diffusion algorithm`), а `Gemma4Renoise` — только эту архитектуру (`ValueError: Gemma4Renoise does not support model architecture <arch>`).

Если `--max-running-requests` не задан, `DllmConfig` подставляет `1`.

### Что переписывается при включении

- **Ограничения самого алгоритма** (`configure_server_args`): у `LowConfidence` и `JointThreshold` их нет. `Gemma4Renoise` требует `device == "cuda"` (ROCm-сборка тоже дает `cuda`) и отвергает `--pp-size` больше 1, `--dcp-size`/`--attn-cp-size` больше 1, квантизованную загрузку и модель без tied embeddings — каждый случай `ValueError`. Затем он декларирует `disable_radix_cache=True`, `chunked_prefill_size=-1` и выключенный prefill-граф.
- **Overlap-планировщик** (`_dllm_overlap_disable`): выключается с warning'ом `Overlap schedule is disabled because of using diffusion LLM inference`.
- **Attention backend** (`_dllm_attention_backend`): если алгоритм требует свой backend (`required_attention_backend`; у `Gemma4Renoise` это `triton`), им заменяются сразу `attention_backend`, `prefill_attention_backend` и `decode_attention_backend` (`<алгоритм> requires the triton attention backend`). Иначе: на HIP — `triton` (если не `triton`/`aiter`), на NPU — `ascend`, на CUDA при включенном decode-графе — `flashinfer`. Каждый случай печатает warning.
- **CUDA graph на AMD**: при `is_hip()` prefill- и decode-графы отключаются целиком (`Cuda graph is disabled for diffusion LLM inference on AMD GPUs`).
- **`--page-size`** (`_dllm_page_size`): при включенном radix-кеше, если размер страницы не кратен размеру блока, он приравнивается к `block_size` (`Setting page size to N for diffusion LLM inference`); независимо от кеша размер страницы не может превышать размер блока и в этом случае тоже опускается до него.
- **Иерархический кеш, LMCache и FlexKV**: при включенном radix-кеше все три выключаются с warning'ами (`FlexKV is disabled because of using diffusion LLM inference` и аналогичные).
- **Pipeline parallelism**: `--pp-size` больше 1 сбрасывается в 1 (`Pipeline parallelism is disabled because of using diffusion LLM inference`). Для `Gemma4Renoise` до этого не доходит: его `configure_server_args` уже отверг PP.
- **LoRA**: `--enable-lora` выключается (`Currently LoRA is not supported by diffusion LLM inference.`).
- **PD disaggregation**: `--disaggregation-mode` приводится к `null` (`Currently disaggregation is not supported by diffusion LLM inference.`) — сервер, запущенный как prefill- или decode-узел, теряет эту роль. Значения, которые ранний шаг `handle_pd_disaggregation` уже вывел из роли, при этом не откатываются: сброс идет почти в конце пайплайна.
- **Mixed chunk**: `--enable-mixed-chunk` выключается (`Mixed chunked prefill is disabled because of using diffusion LLM inference.`).
- **Piecewise CUDA graph**: `DLLM (diffusion LLM)` входит в список причин отключения.

### Как это исполняется

`DllmAlgorithm.run` (`sglang/python/sglang/srt/dllm/algorithm/base.py`) выбирает одну из двух петель по `--dllm-fdfo`. Синхронная петля прогоняет forward'ы внутри одного вызова, пока весь блок не разглажен (не более `max_steps(block_size)` шагов). FDFO-петля делает ровно один шаг за итерацию планировщика и переносит состояние алгоритма между итерациями.

Сам шаг у `LowConfidence` устроен так: берется `argmax` логитов, softmax-уверенность в выбранном токене, раскрываются все позиции с уверенностью выше порога (по умолчанию 0.95), а если таких нет — одна самая уверенная. `JointThreshold` дополнительно умеет редактировать уже раскрытые токены и имеет собственный бюджет правок. `Gemma4Renoise` устроен иначе: он перешумливает весь холст по температурному расписанию, число шагов ограничено `max_denoising_steps` (по умолчанию 48) из `--dllm-algorithm-config`, а request-level параметры вроде penalties, `logit_bias`, structured output и logprobs отвергаются на уровне запроса.

## Значения и формат

- Строка — имя класса, регистр важен: реестр строится по `algo.__name__`.
- Не задан — режим выключен, и это единственный способ его выключить: парного `--no-…` нет.
- Модули алгоритмов импортируются с подавлением ошибок: если файл не импортировался (например, из-за отсутствующей зависимости), в логе появится `Ignore import error when loading …`, а имя просто не попадет в реестр.
- Значение читается несколько раз за старт (при резолюции `--page-size` и при создании алгоритма), поэтому связанный `--dllm-algorithm-config` тоже читается несколько раз.

## Когда использовать

- Только для перечисленных выше архитектур и только когда вы осознанно обслуживаете диффузионную модель.
- `LowConfidence` — базовый и предсказуемый выбор; `JointThreshold` дает пост-редактирование уже раскрытых токенов и больше настроек через `--dllm-algorithm-config`. Для DiffusionGemma выбора нет — только `Gemma4Renoise`.
- Не включать на обычной авторегрессионной модели: `RuntimeError` на старте.
- Не рассчитывать на привычные оптимизации: radix-кеш формально работает (кроме DiffusionGemma, где он выключается), но иерархический кеш, LMCache, FlexKV и overlap-планировщик — нет. PP, LoRA, PD disaggregation и mixed chunk тоже выключаются, причем молча, только warning'ом: проверяйте дамп `server_args=`, а не свою командную строку.
- В arriero такой инстанс — это отдельная конфигурация со своим набором аргументов; смешивать его с профилем обычной модели не стоит.

## Влияние на производительность и память

- VRAM: сам режим буферов не добавляет, но принудительный `--page-size` = `block_size` (32 у LLaDA2-MoE, 4 у SDAR) меняет округление длин в KV-пуле, а отключение piecewise-графа убирает соответствующие накладные расходы и выигрыш.
- RAM хоста: не влияет.
- Время старта: конфиг модели читается несколько раз (`DllmConfig.from_server_args` вызывается и при резолюции `--page-size`, и при создании алгоритма).
- Latency: единица генерации — блок, а не токен. Одному блоку требуется до `block_size + 1` шагов (у `JointThreshold` плюс бюджет правок, у `Gemma4Renoise` — до `max_denoising_steps`), поэтому потоковая выдача ведет себя иначе, чем у авторегрессионной модели.
- Throughput: без overlap-планировщика конкурентная нагрузка обслуживается хуже, чем на обычной модели той же величины; частично это компенсирует FDFO-режим.

## Взаимодействие с другими аргументами

- `--dllm-algorithm-config`: YAML с параметрами алгоритма и возможностью переопределить `block_size`.
- `--dllm-fdfo`: выбор петли исполнения (по умолчанию включен).
- `--page-size`: приравнивается к размеру блока.
- `--attention-backend`: может быть заменен на `flashinfer`/`triton`/`ascend`.
- `--disable-overlap-schedule`: включается принудительно.
- `--enable-hierarchical-cache`, `--enable-lmcache`: выключаются принудительно при включенном radix-кеше.
- `--disable-radix-cache`: меняет ветку резолюции `--page-size` (без кеша проверяется только потолок). `Gemma4Renoise` включает его сам.
- `--enable-flexkv`: выключается принудительно при включенном radix-кеше.
- `--pp-size`: сбрасывается в 1; с `Gemma4Renoise` значение больше 1 — ошибка старта.
- `--enable-lora`: выключается.
- `--disaggregation-mode`: приводится к `null`, роль prefill/decode теряется.
- `--enable-mixed-chunk`: выключается.
- `--chunked-prefill-size`: `Gemma4Renoise` выставляет `-1` (chunked prefill выключен).
- `--max-running-requests`: при незаданном значении конфиг диффузии подставляет `1`.
- `--cuda-graph-backend-prefill disabled` / `--disable-cuda-graph`: piecewise-граф отключается сам; на AMD отключаются оба графа.

## Типовые проблемы и диагностика

- `RuntimeError: Unknown diffusion LLM: LlamaForCausalLM` — модель не из таблицы поддерживаемых архитектур.
- `RuntimeError: Unknown diffusion LLM algorithm: lowconfidence` — неверный регистр или имя не попало в реестр.
- В логе `Ignore import error when loading sglang.srt.dllm.algorithm.…` — модуль алгоритма не импортировался, имя недоступно.
- `Setting page size to 32 for diffusion LLM inference` — ваш `--page-size` был переписан; это норма.
- `Pipeline parallelism is disabled …`, `Currently LoRA is not supported …`, `Currently disaggregation is not supported …`, `Mixed chunked prefill is disabled …`, `FlexKV is disabled …` — соответствующий режим выключен резолвом. Сервер стартует, но не в той конфигурации, что задана в командной строке.
- `ValueError: DiffusionGemma does not support pipeline parallelism` (и родственные `… context parallelism`, `… quantized loading`, `DiffusionGemma requires tied word embeddings`, `DiffusionGemma currently supports CUDA/ROCm GPU execution only`) — ограничения `Gemma4Renoise` на старте.
- Пустой ответ или подвисание на первом запросе — проверьте, что attention backend совместим: на CUDA с включенным decode-графом режим требует `flashinfer`.
- Что смотреть в логе: три warning'а (`Overlap schedule is disabled …`, `Attention backend is set to flashinfer …`, `Setting page size to …`) и итоговый дамп `server_args=` с уже переписанными значениями.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/LLaDA2.0-mini-preview --dllm-algorithm LowConfidence
```

```bash
python -m sglang.launch_server --model-path /models/LLaDA2.0-mini-preview --dllm-algorithm JointThreshold --dllm-algorithm-config /etc/sglang/dllm.yaml --max-running-requests 8
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/dllm/config.py`
- `sglang/python/sglang/srt/dllm/algorithm/__init__.py`
- `sglang/python/sglang/srt/dllm/algorithm/base.py`
- `sglang/python/sglang/srt/dllm/algorithm/low_confidence.py`
- `sglang/python/sglang/srt/dllm/algorithm/joint_threshold.py`
- `sglang/python/sglang/srt/dllm/algorithm/gemma4_renoise.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/arg_groups/dllm_hook.py`
- `sglang/python/sglang/srt/arg_groups/cuda_graph_hook.py`
- `sglang/python/sglang/srt/dllm/mixin/scheduler.py`
