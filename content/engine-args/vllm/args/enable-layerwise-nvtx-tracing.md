---
schema: 1
engine: vllm
primaryName: "--enable-layerwise-nvtx-tracing"
title: "--enable-layerwise-nvtx-tracing"
summary: Вешает NVTX-маркеры на каждый модуль модели с формами входов и выходов — для чтения профиля в Nsight Systems. Работает только по eager-пути: скомпилированные регионы и CUDA graph маркеров не получают.
group: ObservabilityConfig
related:
  - --enforce-eager
  - --compilation-config
  - --disable-log-stats
  - --enable-mfu-metrics
---

# --enable-layerwise-nvtx-tracing

## Кратко

Флаг для профилирования в Nsight Systems: перед каждым модулем открывается NVTX-диапазон с именем модуля, формами входов, формами весов и статическими параметрами слоя, после модуля — диапазон с формами выходов. В `nsys`-трейсе это даёт послойную разметку GPU-таймлайна.

Ограничение зафиксировано в справке и в комментарии кода: хуки регистрируются и на скомпилированной, и на нескомпилированной версии модели, но **на пути исполнения скомпилированной модели они не вызываются**. Практически это значит, что для получения маркеров нужен `--enforce-eager` (или иная конфигурация без torch.compile и CUDA graph).

## Оригинальная справка

```text
Enable layerwise NVTX tracing. This traces the execution of each layer or
module in the model and attach information such as input/output shapes to
nvtx range markers. Noted that this doesn't work with CUDA graphs enabled.
```

## Паспорт аргумента

- Флаги: `--enable-layerwise-nvtx-tracing`, `--no-enable-layerwise-nvtx-tracing`
- Группа argparse: `ObservabilityConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения; выключается парной формой из списка выше
- Значение по умолчанию: `false`
- Эффективное значение: в режиме компиляции `STOCK_TORCH_COMPILE` регистрация хуков полностью пропускается (`debug_once`: `layerwise NVTX tracing is not supported when CompilationMode is STOCK_TORCH_COMPILE, skipping function hooks registration`). При включённых CUDA graph хуки регистрируются, но не срабатывают на графовом пути
- Где объявлен: `vllm/config/observability.py:ObservabilityConfig.enable_layerwise_nvtx_tracing`
- Этап применения: после первой трассировки dynamo в model runner (регистрация хуков) → каждый eager-forward

## Что меняет в движке

**Регистрация.** `GPUModelRunner._register_layerwise_nvtx_hooks()` вызывается уже после первой трассировки dynamo — иначе `nvtx.range_push`/`range_pop` попали бы в трассируемый граф и вызвали graph break. Метод создаёт `PytHooks()` и вызывает `register_hooks(self.model, <имя класса модели>)`, который обходит `named_modules()` и на каждый модуль, кроме `Identity` и `Dropout*`, вешает `register_forward_pre_hook(..., with_kwargs=True)` и `register_forward_hook(...)`. Повторная регистрация защищена флагом `layerwise_nvtx_hooks_registered`.

**Содержимое маркера.** `construct_marker_dict_and_push()` собирает словарь: имя модуля, формы собственных обучаемых параметров (`named_parameters(recurse=False)`), формы входных и выходных тензоров (рекурсивный обход списков и кортежей), формы тензорных kwargs и статические параметры для свёрточных/линейных слоёв. Затем словарь форматируется в строку и передаётся в `nvtx.range_push`. То есть на каждый модуль на каждом forward выполняется построение и форматирование Python-словаря.

**Обёртка компилированного модуля.** `CompilerWrapper.__call__` при включённом флаге дополнительно оборачивает вызов в `layerwise_nvtx_marker_context("Torch Compiled Module (input):<Class>", …)`, то есть верхнеуровневый диапазон вокруг скомпилированного модуля вы получите, а послойной разбивки внутри него — нет.

**Сообщение про CUDA graph.** В `_register_layerwise_nvtx_hooks()` ветка срабатывает при `cudagraph_mode != CUDAGraphMode.NONE`, то есть когда графы **включены**, а текст сообщения написан наоборот («not supported when CUDA graph is turned off»). Ориентируйтесь на условие и на справку: маркеров не будет именно при включённых графах. Сообщение печатается уровнем `debug` и хуки всё равно регистрируются.

## Значения и формат

- Значение по умолчанию `false`; «не задан» и `--no-enable-layerwise-nvtx-tracing` эквивалентны.
- Ни списка модулей, ни глубины разметки задать нельзя: размечается вся иерархия модулей целиком.
- Флаг сам по себе ничего не записывает в файл — маркеры видны только под внешним профилировщиком (`nsys profile ...`).

## Когда использовать

- Разовое профилирование в Nsight Systems, когда нужно понять, какой слой занимает время на GPU-таймлайне, и агрегатов `--enable-mfu-metrics` недостаточно.
- Только вместе с `--enforce-eager`: иначе основная часть форварда исполняется графом и остаётся без разметки, а накладные расходы вы всё равно заплатите.
- Никогда — в постоянной эксплуатации: два Python-хука на каждый модуль на каждом шаге переносят заметную часть времени в интерпретатор.
- Не используйте для измерения абсолютной производительности: eager-режим и хуки сами по себе меняют профиль, который вы измеряете.

## Влияние на производительность и память

- **CPU/latency.** Основной эффект. Для типовой decoder-модели с сотнями модулей это сотни вызовов Python-хуков на каждый forward, каждый со сборкой словаря и обходом тензорных аргументов. Замедление кратное, а не процентное.
- **VRAM.** Не влияет: хуки не создают тензоров.
- **RAM хоста.** Словарь `module_to_name_map` на все модули модели — единожды при регистрации.
- **Время старта.** Одна дополнительная итерация по `named_modules()` после первой трассировки.

## Взаимодействие с другими аргументами

- `--enforce-eager`: практическая предпосылка. Он выставляет `CompilationMode.NONE` и `CUDAGraphMode.NONE`, то есть форвард идёт по пути, на котором хуки срабатывают.
- `--compilation-config`: режим `STOCK_TORCH_COMPILE` отключает регистрацию хуков целиком; `cudagraph_mode` определяет, будет ли форвард исполняться графом.
- `--enable-mfu-metrics`: агрегированная альтернатива без профилировщика.
- `--disable-log-stats`: на этот механизм не влияет — маркеры не проходят через стат-логгеры.

## Типовые проблемы и диагностика

- **Симптом:** в `nsys`-трейсе нет послойных маркеров, есть только один диапазон `Torch Compiled Module (input):<Class>`. **Причина:** форвард исполняется скомпилированным графом. **Лечение:** добавить `--enforce-eager`.
- **Симптом:** маркеров нет совсем. **Причина:** режим компиляции `STOCK_TORCH_COMPILE` — регистрация пропущена. **Проверка:** debug-сообщение `layerwise NVTX tracing is not supported when CompilationMode is STOCK_TORCH_COMPILE, skipping function hooks registration`. **Лечение:** сменить режим компиляции.
- **Симптом:** старт падает с `ValueError: Module instance <...> is not unique`. **Причина:** `register_hooks` требует, чтобы каждый объект модуля встречался в `named_modules()` ровно один раз; повторно используемый (разделяемый) модуль ломает это допущение. **Лечение:** для такой модели флаг неприменим.
- **Симптом:** throughput упал в разы. **Причина:** штатная цена хуков. **Лечение:** выключить после снятия профиля.
- **Подтверждение принятого значения:** наличие NVTX-диапазонов с именами модулей в трейсе Nsight Systems.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-layerwise-nvtx-tracing --enforce-eager --max-num-seqs 1
```

```bash
nsys profile -o /tmp/vllm-trace vllm serve /models/Qwen3-4B --enable-layerwise-nvtx-tracing --enforce-eager
```

## Источники

- `vllm/vllm/config/observability.py`
- `vllm/vllm/utils/nvtx_pytorch_hooks.py`
- `vllm/vllm/v1/worker/gpu_model_runner.py`
- `vllm/vllm/compilation/wrapper.py`
- `vllm/vllm/config/vllm.py`
