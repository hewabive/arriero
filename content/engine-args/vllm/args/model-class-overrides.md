---
schema: 1
engine: vllm
primaryName: "--model-class-overrides"
title: "--model-class-overrides"
summary: Подмена класса модели для указанных архитектур на произвольный `module:class`. Отладочный аргумент: регистрирует класс в реестре моделей каждого процесса и импортирует ваш модуль в движке и во всех воркерах.
group: ModelConfig
related:
  - --model-impl
  - --model
  - --trust-remote-code
  - --hf-overrides
---

# --model-class-overrides

## Кратко

`--model-class-overrides` — карта «имя архитектуры → `module:class`». Каждый элемент регистрируется в `ModelRegistry` тем же способом, что и внешняя модель, поэтому резолв архитектуры находит ваш класс раньше встроенного.

Справка прямо называет аргумент отладочным. Он не предназначен для постоянной конфигурации сервера: контракт классов моделей vLLM меняется между релизами без предупреждения.

## Оригинальная справка

```text
Override the model class used for one or more architectures, mapping the
architecture name to a `"module:class"` target (the same format accepted by
`ModelRegistry.register_model`). This registers the target class at runtime,
e.g. `{"GlmMoeDsaForCausalLM":
"vllm.models.deepseek_v32.nvidia.model:DeepseekV32ForCausalLM"}`. This
argument is for development and debugging purposes only.
```

## Паспорт аргумента

- Флаги: `--model-class-overrides`
- Группа argparse: `ModelConfig`
- Тип значения: JSON-объект `{"<Архитектура>": "<module>:<class>"}`; принимается строкой JSON и точечными под-флагами
- Допустимые значения: ключ — имя архитектуры из `config.json`, значение — строка строго формата `module:class`
- Значение по умолчанию: `field(default_factory=dict)` — пустой словарь
- Эффективное значение: не переопределяется. Регистрация выполняется лениво и **по одному разу на процесс**: guard `_REGISTERED_MODEL_CLASS_OVERRIDES` — модульная переменная, а не поле конфига, потому что `ModelConfig` пикируется в воркеры, и флаг на экземпляре приехал бы туда уже «выставленным», хотя реестр воркера еще пуст
- Где объявлен: `vllm/config/model.py:ModelConfig.model_class_overrides`
- Этап применения: первое обращение к свойству `ModelConfig.registry` — то есть при инспекции и при резолве класса модели, в процессе движка и в каждом воркере

## Что меняет в движке

Свойство `ModelConfig.registry` — единственная точка, через которую проходят все обращения к реестру моделей. Перед возвратом реестра вызывается `_maybe_register_model_class_overrides()`:

1. Отбираются пары `(arch, target)`, еще не зарегистрированные **в этом процессе**.
2. Один раз печатается предупреждение `Applying model_class_overrides {...}. This is intended for development/debugging.`
3. Для каждой пары вызывается `ModelRegistry.register_model(arch, target)`.

`register_model` со строкой создает ленивую запись `_LazyRegisteredModel(module, class)`: импорт откладывается до момента фактической загрузки модели. Это сделано специально — чтобы импорт не инициализировал CUDA раньше времени (иначе в форкнутых воркерах ловится `RuntimeError: Cannot re-initialize CUDA in forked subprocess`).

Если архитектура уже зарегистрирована, старая запись заменяется вашей (в debug-лог пишется `Model architecture X is already registered, and will be overwritten by the new model class Y`).

## Значения и формат

Одной строкой JSON:

```bash
--model-class-overrides '{"GlmMoeDsaForCausalLM":"vllm.models.deepseek_v32.nvidia.model:DeepseekV32ForCausalLM"}'
```

Точечным под-флагом:

```bash
--model-class-overrides.GlmMoeDsaForCausalLM vllm.models.deepseek_v32.nvidia.model:DeepseekV32ForCausalLM
```

Требования к значению:

- ровно одно двоеточие: `Expected a string in the format '<module>:<class>'`;
- модуль должен быть импортируемым в окружении инстанса **и** в процессах воркеров, а не только во фронтенде;
- ключ должен совпадать с именем архитектуры из `config.json` модели (или из `--hf-overrides`), иначе подмена просто не сработает;
- пустой объект эквивалентен отсутствию аргумента.

## Когда использовать

- Локальная разработка или отладка: сравнить поведение своей реализации слоя с встроенной без пересборки vLLM.
- Быстрая проверка патча к классу модели на реальном инстансе перед отправкой изменения в апстрим.
- Не используйте на постоянно работающем сервере. Класс модели — внутренний интерфейс vLLM; при обновлении версии он может перестать соответствовать окружению, и отказ произойдет на старте инстанса.
- Не используйте как «облегченную» замену `--trust-remote-code`: механика другая (импорт модуля из окружения, а не выполнение кода из репозитория), но по последствиям это тоже исполнение произвольного кода в движке и во всех воркерах.

## Влияние на производительность и память

Сам аргумент ресурсов не потребляет: регистрация ленивая, импорт происходит один раз при загрузке модели. Все дальнейшее поведение — производительность, VRAM, поддержанные фичи — определяется подставленным классом, а не этим аргументом.

## Взаимодействие с другими аргументами

- `--model-impl`: подмененный класс попадает в реестр vLLM, поэтому резолв найдет его до любых откатов на Transformers; при `--model-impl transformers` ветка Transformers проверяется первой и подмена может не сработать.
- `--model`: имена архитектур берутся из его конфига.
- `--hf-overrides`: позволяет изменить сам список `architectures` в прочитанном конфиге — иногда это более прямой путь, чем подмена класса.
- `--trust-remote-code`: альтернативный (и тоже небезопасный) способ подключить нестандартный класс модели, но из репозитория, а не из окружения.

## Типовые проблемы и диагностика

- **Симптом:** `Expected a string in the format '<module>:<class>'`. **Причина:** в значении нет ровно одного двоеточия. **Лечение:** привести к формату `module:class`.
- **Симптом:** подмена «не применилась». **Причина:** ключ не совпадает с именем архитектуры из `config.json`. **Проверка:** строка `Resolved architecture: <Arch>` в логе старта — там видно, какое имя реально резолвится.
- **Симптом:** фронтенд стартовал, а воркер упал на `ModuleNotFoundError`. **Причина:** модуль импортируем только в одном окружении. **Лечение:** установить модуль так, чтобы он был доступен всем процессам инстанса.
- **Симптом:** предупреждение `Applying model_class_overrides {...}. This is intended for development/debugging.` в продакшен-логах. **Причина:** отладочный аргумент попал в постоянную конфигурацию. **Лечение:** убрать его.

## Примеры

```bash
vllm serve /models/GLM-MoE --model-class-overrides '{"GlmMoeDsaForCausalLM":"vllm.models.deepseek_v32.nvidia.model:DeepseekV32ForCausalLM"}'
```

```bash
vllm serve /models/GLM-MoE --model-class-overrides.GlmMoeDsaForCausalLM my_pkg.patched_model:PatchedForCausalLM --enforce-eager
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/model_executor/models/registry.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
