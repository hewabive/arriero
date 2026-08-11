---
schema: 1
engine: sglang
primaryName: "--dllm-algorithm"
title: "--dllm-algorithm"
summary: Переключает сервер в отдельный режим обслуживания — диффузионные LLM, где токены не генерируются слева направо, а разглаживаются блоками. Задание алгоритма перестраивает планировщик, `--page-size`, attention backend и отключает часть кешей.
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
  - --disable-piecewise-cuda-graph
  - --disable-cuda-graph
---

# --dllm-algorithm

## Кратко

Это не «еще одна ручка», а переключатель режима работы всего сервера. Диффузионная LLM (LLaDA2-MoE, SDAR) генерирует блок фиксированной длины целиком, заполненный маскирующим токеном, и за несколько шагов «разглаживает» его, раскрывая на каждом шаге те позиции, в которых уверена. `--dllm-algorithm` задает имя класса, реализующего правило раскрытия. Пока значение не задано, ни один из остальных `dllm`-аргументов не читается и режим не активен.

Включение режима переписывает целый набор соседних настроек: overlap-планировщик выключается, `--page-size` приравнивается к размеру блока модели, attention backend может смениться на `flashinfer` (или `triton`/`ascend` на других платформах), иерархический кеш и LMCache отключаются, piecewise CUDA graph запрещается.

## Оригинальная справка

```text
The diffusion LLM algorithm, such as LowConfidence.
```

## Паспорт аргумента

- Флаги: `--dllm-algorithm`
- Группа: `exec.dllm`
- Тип значения: str (`Optional[str]`) — имя класса алгоритма
- Допустимые значения: в argparse не ограничены (`choices: null`). Список собирается в runtime: `import_algorithms` перебирает модули пакета `sglang.srt.dllm.algorithm` и берет из каждого атрибут `Algorithm`. В checkout'е это `LowConfidence` (`low_confidence.py`) и `JointThreshold` (`joint_threshold.py`). Посмотреть список на своей сборке: `python -c "from sglang.srt.dllm.algorithm import algo_name_to_cls; print(list(algo_name_to_cls))"`
- Значение по умолчанию: `null` — режим выключен
- Эффективное значение: совпадает с заданным; вместо него переписываются соседние аргументы
- Где объявлен: `ServerArgs.dllm_algorithm`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но отдельный режим обслуживания — комбинировать его с остальной функциональностью сервера нельзя произвольно
- Этап применения: `__post_init__` (`_handle_dllm_inference` и три пасса резолюции) → инициализация scheduler'а (`DllmConfig.from_server_args`, `get_algorithm`) → каждый forward

## Что меняет в движке

### Поддерживаемые модели и параметры блока

`DllmConfig.from_server_args` (`sglang/python/sglang/srt/dllm/config.py`) держит таблицу архитектур:

| Архитектура | `block_size` | `mask_id` |
| --- | --- | --- |
| `LLaDA2MoeModelLM` | 32 | 156895 |
| `SDARForCausalLM` | 4 | 151669 |
| `SDARMoeForCausalLM` | 4 | 151669 |

Любая другая архитектура — `RuntimeError: Unknown diffusion LLM: <arch>`. Неизвестное имя алгоритма — `RuntimeError: Unknown diffusion LLM algorithm: <name>`.

Если `--max-running-requests` не задан, `DllmConfig` подставляет `1`.

### Что переписывается при включении

- **Overlap-планировщик** (`_dllm_overlap_disable`): выключается с warning'ом `Overlap schedule is disabled because of using diffusion LLM inference`.
- **Attention backend** (`_dllm_attention_backend`): на HIP — `triton` (если не `triton`/`aiter`), на NPU — `ascend`, на CUDA при включенном decode-графе — `flashinfer`. Каждый случай печатает warning.
- **CUDA graph на AMD**: при `is_hip()` prefill- и decode-графы отключаются целиком (`Cuda graph is disabled for diffusion LLM inference on AMD GPUs`).
- **`--page-size`** (`_dllm_page_size`): при включенном radix-кеше, если размер страницы не кратен размеру блока, он приравнивается к `block_size` (`Setting page size to N for diffusion LLM inference`); независимо от кеша размер страницы не может превышать размер блока и в этом случае тоже опускается до него.
- **Иерархический кеш и LMCache**: при включенном radix-кеше оба выключаются с warning'ами.
- **Piecewise CUDA graph**: `DLLM (diffusion LLM)` входит в список причин отключения.

### Как это исполняется

`DllmAlgorithm.run` (`sglang/python/sglang/srt/dllm/algorithm/base.py`) выбирает одну из двух петель по `--dllm-fdfo`. Синхронная петля прогоняет forward'ы внутри одного вызова, пока весь блок не разглажен (не более `max_steps(block_size)` шагов). FDFO-петля делает ровно один шаг за итерацию планировщика и переносит состояние алгоритма между итерациями.

Сам шаг у `LowConfidence` устроен так: берется `argmax` логитов, softmax-уверенность в выбранном токене, раскрываются все позиции с уверенностью выше порога (по умолчанию 0.95), а если таких нет — одна самая уверенная. `JointThreshold` дополнительно умеет редактировать уже раскрытые токены и имеет собственный бюджет правок.

## Значения и формат

- Строка — имя класса, регистр важен: реестр строится по `algo.__name__`.
- Не задан — режим выключен, и это единственный способ его выключить: парного `--no-…` нет.
- Модули алгоритмов импортируются с подавлением ошибок: если файл не импортировался (например, из-за отсутствующей зависимости), в логе появится `Ignore import error when loading …`, а имя просто не попадет в реестр.
- Значение читается несколько раз за старт (при резолюции `--page-size` и при создании алгоритма), поэтому связанный `--dllm-algorithm-config` тоже читается несколько раз.

## Когда использовать

- Только для перечисленных выше архитектур и только когда вы осознанно обслуживаете диффузионную модель.
- `LowConfidence` — базовый и предсказуемый выбор; `JointThreshold` дает пост-редактирование уже раскрытых токенов и больше настроек через `--dllm-algorithm-config`.
- Не включать на обычной авторегрессионной модели: `RuntimeError` на старте.
- Не рассчитывать на привычные оптимизации: radix-кеш формально работает, но иерархический кеш, LMCache и overlap-планировщик — нет.
- В arriero такой инстанс — это отдельная конфигурация со своим набором аргументов; смешивать его с профилем обычной модели не стоит.

## Влияние на производительность и память

- VRAM: сам режим буферов не добавляет, но принудительный `--page-size` = `block_size` (32 у LLaDA2-MoE, 4 у SDAR) меняет округление длин в KV-пуле, а отключение piecewise-графа убирает соответствующие накладные расходы и выигрыш.
- RAM хоста: не влияет.
- Время старта: конфиг модели читается несколько раз (`DllmConfig.from_server_args` вызывается и при резолюции `--page-size`, и при создании алгоритма).
- Latency: единица генерации — блок, а не токен. Одному блоку требуется до `block_size + 1` шагов (у `JointThreshold` плюс бюджет правок), поэтому потоковая выдача ведет себя иначе, чем у авторегрессионной модели.
- Throughput: без overlap-планировщика конкурентная нагрузка обслуживается хуже, чем на обычной модели той же величины; частично это компенсирует FDFO-режим.

## Взаимодействие с другими аргументами

- `--dllm-algorithm-config`: YAML с параметрами алгоритма и возможностью переопределить `block_size`.
- `--dllm-fdfo`: выбор петли исполнения (по умолчанию включен).
- `--page-size`: приравнивается к размеру блока.
- `--attention-backend`: может быть заменен на `flashinfer`/`triton`/`ascend`.
- `--disable-overlap-schedule`: включается принудительно.
- `--enable-hierarchical-cache`, `--enable-lmcache`: выключаются принудительно при включенном radix-кеше.
- `--disable-radix-cache`: меняет ветку резолюции `--page-size` (без кеша проверяется только потолок).
- `--max-running-requests`: при незаданном значении конфиг диффузии подставляет `1`.
- `--disable-piecewise-cuda-graph` / `--disable-cuda-graph`: piecewise-граф отключается сам; на AMD отключаются оба графа.

## Типовые проблемы и диагностика

- `RuntimeError: Unknown diffusion LLM: LlamaForCausalLM` — модель не из таблицы поддерживаемых архитектур.
- `RuntimeError: Unknown diffusion LLM algorithm: lowconfidence` — неверный регистр или имя не попало в реестр.
- В логе `Ignore import error when loading sglang.srt.dllm.algorithm.…` — модуль алгоритма не импортировался, имя недоступно.
- `Setting page size to 32 for diffusion LLM inference` — ваш `--page-size` был переписан; это норма.
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

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/dllm/config.py`
- `sglang/python/sglang/srt/dllm/algorithm/__init__.py`
- `sglang/python/sglang/srt/dllm/algorithm/base.py`
- `sglang/python/sglang/srt/dllm/algorithm/low_confidence.py`
- `sglang/python/sglang/srt/dllm/algorithm/joint_threshold.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/dllm/mixin/scheduler.py`
