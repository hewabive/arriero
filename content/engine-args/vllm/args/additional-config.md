---
schema: 1
engine: vllm
primaryName: "--additional-config"
title: "--additional-config"
summary: Свободный JSON-словарь без схемы: канал для платформенных и out-of-tree настроек, который движок только хеширует и передает дальше. В основном дереве его читают ровно две пары ключей, и обе дублированы отдельными флагами.
group: VllmConfig
related:
  - --gdn-prefill-backend
  - --kda-prefill-backend
  - --model-loader-extra-config
  - --hf-overrides
  - --compilation-config
  - --kernel-config
---

# --additional-config

## Кратко

`--additional-config` попадает в `VllmConfig.additional_config` — единственное поле конфигурации без схемы. Комментарий в исходниках описывает его как «some opaque config, only used to provide additional information for the hash computation, mainly used for testing, debugging or out of tree config registration».

Практически это точка расширения для платформ и форков: движок кладет содержимое в хеш `VllmConfig` (чтобы кэш компиляции различал конфигурации) и делает его доступным любому коду, у которого есть `vllm_config`. В основном дереве его читают только слои линейного внимания GDN и KDA, и оба ключа продублированы штатными флагами.

## Оригинальная справка

```text
Additional config for specified platform. Different platforms may
support different configs. Make sure the configs are valid for the platform
you are using. Contents must be hashable.
```

## Паспорт аргумента

- Флаги: `--additional-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `--additional-config.<ключ> <значение>`)
- Допустимые значения: не ограничены — схемы нет
- Значение по умолчанию: `Field(default_factory=dict)`, то есть пустой словарь `{}`, а не `None`
- Эффективное значение: `EngineArgs.create_engine_config` дописывает в словарь ключ `gdn_prefill_backend`, если задан `--gdn-prefill-backend`, и `kda_prefill_backend`, если задан `--kda-prefill-backend`. Никакой валидации содержимого нет ни на разборе CLI, ни при сборке конфигурации
- Где объявлен: `vllm/config/vllm.py:VllmConfig.additional_config`
- Этап применения: разбор CLI → `create_engine_config` → `VllmConfig.compute_hash()` → чтение произвольным кодом во время загрузки модели и forward

## Что меняет в движке

Само по себе — ничего. Значение делает две вещи:

1. **Входит в хеш конфигурации.** `VllmConfig.compute_hash()` для словаря считает хеш от `json.dumps(additional_config, sort_keys=True)`, а для объекта, реализующего протокол `SupportsHash`, вызывает его `compute_hash()`. Поэтому смена содержимого инвалидирует кэш торч-компиляции — это и есть смысл требования «contents must be hashable» из справки.
2. **Доступно любому коду через `vllm_config.additional_config`.** В основном дереве такие потребители пересчитываются по пальцам:

| Ключ | Кто читает | Смысл |
| --- | --- | --- |
| `gdn_prefill_backend` | `vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py` | выбор ядра prefill для GDN-линейного внимания: `auto` (по умолчанию), `flashinfer`, `triton`, `cutedsl` |
| `kda_prefill_backend` | `vllm/model_executor/layers/mamba/gdn/kimi_gdn_linear_attn.py`, `vllm/models/kimi_k3/*/kda.py` | то же для KDA: `auto`, `triton`, `flashkda` |

Оба ключа читаются с проверкой `isinstance(additional_config, dict)` и падением обратно на `auto`, если значение не словарь.

Все остальное — платформы вне дерева и форки, которые регистрируют собственные конфигурации. Для конкретной платформы список допустимых ключей знает только она сама; справка прямо перекладывает ответственность на пользователя.

## Значения и формат

- Обе формы: `--additional-config '{"gdn_prefill_backend":"triton"}'` и `--additional-config.gdn_prefill_backend triton`. Точечные под-флаги должны использовать одно написание флага и не смешиваться с полной JSON-строкой.
- **Важная особенность разбора.** Тип поля — `dict | SupportsHash`, поэтому argparse получает функцию `union_dict_and_str`: если значение не выглядит как `{...}`, оно возвращается **строкой**, без ошибки. То есть `--additional-config foo` тихо примется на разборе CLI и упадет позже — при валидации `VllmConfig` либо, если заодно задан `--gdn-prefill-backend`, при попытке присвоить ключ строке. Всегда передавайте валидный JSON-объект.
- Пустая строка и `None` дают `None`.
- Числа в значениях понимают человекочитаемые суффиксы при точечной записи (`--additional-config.some_size 8G`), поскольку это общий механизм `FlexibleArgumentParser`.
- Никаких зарезервированных или специальных значений нет.

## Когда использовать

- **Платформа вне основного дерева** (свой backend, свой акселератор), которая документирует собственные ключи.
- **Тонкая настройка GDN/KDA-ядер** — хотя штатный путь для этого `--gdn-prefill-backend` и `--kda-prefill-backend`, которые к тому же ограничены `choices` и потому защищают от опечатки.
- **Тестирование и отладка**, когда нужно донести значение до собственного кода, не заводя новый флаг.
- **Не используйте как «универсальный конфиг».** Опечатка в ключе не даст ни ошибки, ни предупреждения: неизвестные ключи просто никем не читаются, и вы получите молча проигнорированную настройку.
- **Не кладите сюда секреты.** Содержимое попадает в сводку конфигурации движка в логе.

## Влияние на производительность и память

Прямого влияния нет: это словарь в конфигурации. Единственный измеримый эффект — участие в хеше `VllmConfig`: изменение содержимого вызывает полную перекомпиляцию модели при следующем старте, даже если новый ключ никто не читает. Косвенно на производительность влияют только те ключи, которые действительно меняют выбор ядра (`gdn_prefill_backend`, `kda_prefill_backend`).

## Взаимодействие с другими аргументами

- `--gdn-prefill-backend`, `--kda-prefill-backend`: штатные флаги, которые дописывают одноименные ключи в этот словарь. Заданный флаг **перетирает** ключ, переданный через JSON, без предупреждения.
- `--model-loader-extra-config`: похожий по духу свободный словарь, но адресованный загрузчику весов, а не платформе.
- `--hf-overrides`: свободные переопределения HF-конфига модели — другой слой.
- `--compilation-config`, `--kernel-config`: настоящие типизированные конфигурации; если нужная ручка есть там, использовать ее правильнее.

## Типовые проблемы и диагностика

- **Симптом:** ключ задан, а поведение не изменилось. **Причина:** ключ никем не читается (опечатка или неподдерживаемое имя). **Проверка:** поиск имени ключа в исходниках вашей сборки — валидации нет, других сигналов не будет. **Лечение:** сверить имя с потребителем.
- **Симптом:** ошибка валидации `VllmConfig` про тип `additional_config`. **Причина:** передана строка, не похожая на JSON-объект, и `union_dict_and_str` вернул ее как есть. **Лечение:** передавать `{...}`.
- **Симптом:** `TypeError: 'str' object does not support item assignment` при старте. **Причина:** `--additional-config` получил строку, а `--gdn-prefill-backend`/`--kda-prefill-backend` пытаются дописать в нее ключ. **Лечение:** то же.
- **Симптом:** модель компилируется заново после безобидной правки. **Причина:** содержимое входит в хеш конфигурации. **Лечение:** ожидаемое поведение; зафиксируйте словарь в конфигурации инстанса.
- **Подтверждение принятого значения:** сводка конфигурации движка в логе старта содержит `additional_config` целиком.

## Примеры

```bash
vllm serve /models/Qwen3-Next-4B --additional-config '{"gdn_prefill_backend":"triton"}' --gpu-memory-utilization 0.85
```

```bash
vllm serve /models/Qwen3-Next-4B --additional-config.gdn_prefill_backend flashinfer --max-model-len 8192
```

## Источники

- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/utils.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py`
- `vllm/vllm/model_executor/layers/mamba/gdn/kimi_gdn_linear_attn.py`
