---
schema: 1
engine: vllm
primaryName: "--mamba-ssu-algorithm"
title: "--mamba-ssu-algorithm"
summary: Принудительно задаёт алгоритм selective state update внутри FlashInfer вместо его собственного "auto". Работает только с `--mamba-backend flashinfer`; неподдерживаемый выбор всплывает не на старте, а на первом decode-шаге.
group: MambaConfig
related:
  - --mamba-backend
  - --enable-mamba-cache-stochastic-rounding
  - --mamba-cache-philox-rounds
  - --mamba-ssm-cache-dtype
---

# --mamba-ssu-algorithm

## Кратко

FlashInfer реализует selective state update несколькими способами и по умолчанию выбирает между ними сам (режим `auto`). Аргумент фиксирует конкретный: `simple`, `vertical` или `horizontal`.

Это ручка замеров для гибридных SSM-моделей на FlashInfer-backend'е. vLLM значение не валидирует за пределами списка имён — пригодность алгоритма для вашей карты, типа состояния и режима декодирования проверяет сама FlashInfer, уже во время работы.

## Оригинальная справка

```text
Selective state update algorithm to use with the FlashInfer backend.
None defaults to FlashInfer's "auto" algorithm. Forced algorithms must
be supported by FlashInfer for the active GPU, state dtype, and decoding
mode.
```

## Паспорт аргумента

- Флаги: `--mamba-ssu-algorithm`
- Группа argparse: `MambaConfig`
- Тип значения: строка из фиксированного набора (`Literal`), argparse проверяет по `choices`
- Допустимые значения: `auto`, `simple`, `vertical`, `horizontal`. Поле объявлено как `optional`, поэтому в `--help` к списку добавляется вариант `None`, а строки `None` и `""` парсер превращает в «не задано»
- Значение по умолчанию: `None` — FlashInfer работает в своём режиме `auto`
- Эффективное значение: `None` подставляется как `"auto"` в момент вызова ядра (`self._mamba_config.ssu_algorithm or "auto"`), то есть `None` и `auto` эквивалентны по результату. Никаких переопределений по железу нет
- Где объявлен: `vllm/config/mamba.py:MambaConfig.ssu_algorithm`
- Этап применения: `MambaConfig.__post_init__` и повторно `create_engine_config` (валидация связки с backend'ом) → инициализация FlashInfer-backend'а → каждый decode-шаг Mamba-слоя

## Что меняет в движке

Значение проверяется дважды одной и той же функцией `MambaConfig.validate_ssu_algorithm()`: в `__post_init__` датакласса и явно в `create_engine_config` после переноса CLI-значений. Проверок ровно две — имя должно быть из списка, и backend должен быть `flashinfer`:

```
raise ValueError(
    "Mamba SSU algorithm selection is only supported with the "
    "FlashInfer backend. Please set `--mamba-backend flashinfer`, "
    "or omit `--mamba-ssu-algorithm`."
)
```

Дальше `FlashInferSSUBackend` (`vllm/model_executor/layers/mamba/ops/ssu_dispatch.py`) при инициализации печатает `Using FlashInfer Mamba SSU algorithm: <значение>` и на каждом вызове передаёт его в `flashinfer.mamba.selective_state_update(..., algorithm=...)`.

Всё, что дальше, — территория FlashInfer. vLLM не сопоставляет алгоритм ни с compute capability, ни с dtype состояния, ни с режимом декодирования (обычный decode против спекулятивного, где передаются `cu_seqlens` и `num_accepted_tokens`). Поэтому формально валидное, но неподдерживаемое сочетание падает не на старте, а при первом реальном decode-шаге — исключением из библиотеки.

Для Triton- и CPU-backend'ов значение недостижимо: они игнорируют поле, а валидация не даст им стартовать с непустым значением.

## Значения и формат

- `auto` — то же, что не задавать: выбор делает FlashInfer.
- `simple`, `vertical`, `horizontal` — принудительные варианты. Их семантика определена в FlashInfer, а не в vLLM; сверяться нужно с документацией установленной версии библиотеки (`>= 0.6.4`, как требует сам backend).
- `None` строкой и пустая строка принимаются и означают «не задано».
- Значение вне списка отвергает argparse (`invalid choice`) — до всякой валидации связки с backend'ом.

## Когда использовать

- **Сравнительный замер на FlashInfer-backend'е.** `auto` — эвристика библиотеки; на конкретных размерах состояния и батча принудительный вариант может оказаться быстрее.
- **Обход регрессии в автоподборе FlashInfer.** Если после обновления библиотеки decode просел, фиксация алгоритма даёт быстрый способ проверить гипотезу.
- **Не задавайте вместе с `--mamba-backend triton`** — это гарантированный отказ на старте, а не «мягкое игнорирование».
- **Не оставляйте принудительное значение в проде без перепроверки после обновления flashinfer.** Набор поддерживаемых алгоритмов и их применимость — контракт внешней библиотеки, а не vLLM.

## Влияние на производительность и память

- **Latency decode.** Единственная точка приложения: алгоритм меняет способ обхода состояния SSM на decode-шаге. Величина эффекта зависит от размеров состояния и числа голов и определяется только замером.
- **VRAM.** Не влияет: состояние и его раскладка не меняются.
- **Время старта.** Не влияет; JIT-компиляция ядер FlashInfer происходит в любом случае.
- **Численность.** Разные алгоритмы дают разный порядок накопления, поэтому побитового совпадения между ними ждать не стоит.

## Взаимодействие с другими аргументами

- `--mamba-backend`: обязательное условие — только `flashinfer`. Любое другое значение backend'а при непустом алгоритме означает отказ на старте.
- `--enable-mamba-cache-stochastic-rounding`: независимая настройка того же FlashInfer-ядра; при включённом округлении в ядро дополнительно передаётся случайное зерно.
- `--mamba-cache-philox-rounds`: тоже уходит в тот же вызов; на FlashInfer-пути нулевое значение подменяется на `10`.
- `--mamba-ssm-cache-dtype`: тип состояния входит в условие применимости алгоритма на стороне FlashInfer — справка называет его явно.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Mamba SSU algorithm selection is only supported with the FlashInfer backend. Please set --mamba-backend flashinfer, or omit --mamba-ssu-algorithm.` **Причина:** алгоритм задан при Triton/CPU-backend'е. **Лечение:** добавить `--mamba-backend flashinfer` либо убрать алгоритм.
- **Симптом:** `argument --mamba-ssu-algorithm: invalid choice: 'vert'`. **Причина:** значение вне списка. **Лечение:** одно из `auto`, `simple`, `vertical`, `horizontal`, `None`.
- **Симптом:** старт прошёл, а первый запрос падает исключением из `flashinfer.mamba`. **Причина:** алгоритм не поддержан для этой карты, типа состояния или режима декодирования — vLLM это не проверяет. **Лечение:** вернуть `auto` (или снять флаг) и убедиться, что проблема уходит.
- **Симптом:** флаг задан, а строки `Using FlashInfer Mamba SSU algorithm: ...` нет. **Причина:** FlashInfer-backend не инициализировался — в модели нет групп `MAMBA1`/`MAMBA2`.
- **Подтверждение принятого значения:** строка `Using FlashInfer Mamba SSU algorithm: vertical` при инициализации backend'а.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --mamba-backend flashinfer --mamba-ssu-algorithm vertical --max-model-len 32768
```

```bash
vllm serve /models/Nemotron-H-8B --mamba-backend flashinfer --mamba-ssu-algorithm auto --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/mamba.py`
- `vllm/vllm/model_executor/layers/mamba/ops/ssu_dispatch.py`
- `vllm/vllm/engine/arg_utils.py`
