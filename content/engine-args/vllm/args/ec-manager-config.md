---
schema: 1
engine: vllm
primaryName: "--ec-manager-config"
title: "--ec-manager-config"
summary: JSON-объект `EncoderCacheManagerConfig` — подмена штатного менеджера encoder cache мультимодальных моделей на собственный класс по полному имени. Точка расширения для плагинов; без мультимодального тракта аргумент инертен.
group: VllmConfig
related:
  - --ec-transfer-config
  - --limit-mm-per-prompt
  - --disable-chunked-mm-input
  - --max-num-batched-tokens
---

# --ec-manager-config

## Кратко

`--ec-manager-config` заполняет `EncoderCacheManagerConfig` (`vllm/config/ec_manager_config.py`) — конфигурацию, по которой планировщик выбирает класс менеджера encoder cache. Encoder cache хранит эмбеддинги, которые вычислил энкодер мультимодальной модели (например, vision-эмбеддинги изображений), и решает, что вытеснять при нехватке места. По умолчанию класс выбирается автоматически: `EncoderDecoderCacheManager` для encoder-decoder архитектур, иначе `EncoderCacheManager` (`vllm/v1/core/sched/scheduler.py`).

Это точка расширения для внешних плагинов (пример из апстрима — `vllm-project/bart-plugin`), а не эксплуатационная ручка: штатной альтернативной реализации в дереве vLLM нет, задавать здесь нечего, пока у вас нет собственного класса менеджера. На текстовой модели без мультимодального тракта аргумент инертен — менеджер создается с `cache_size = 0` и не работает.

## Оригинальная справка

```text
The configurations for custom encoder cache manager.
```

## Паспорт аргумента

- Флаги: `--ec-manager-config`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект `EncoderCacheManagerConfig`
- Допустимые значения: поля `encoder_cache_manager_cls` (строка, полное имя класса, по умолчанию `None`) и `manager_config` (произвольный dict, по умолчанию `{}`)
- Значение по умолчанию: `Field(default_factory=EncoderCacheManagerConfig)` — сконструированный объект с `encoder_cache_manager_cls: None`, то есть автоматический выбор штатного менеджера
- Эффективное значение: сам объект не переписывается, но размер кеша, с которым будет создан менеджер, аргумент не задает — он приходит из мультимодального бюджета (`mm_budget.encoder_cache_size`, производная от `--max-num-batched-tokens` и лимитов модальностей); для модели без мультимодальных входов это `0`
- Где объявлен: `vllm/config/vllm.py:VllmConfig.ec_manager_config`
- Этап применения: разбор CLI (валидация пары полей) → конструирование `Scheduler` в процессе engine core (импорт и инстанцирование класса)

## Что меняет в движке

Одну строку в конструкторе планировщика. `Scheduler.__init__` вызывает `ec_manager_config.get_encoder_cache_manager_obj()`: если `encoder_cache_manager_cls` задан, класс импортируется через `resolve_obj_by_qualname` (обычный `importlib.import_module` плюс `getattr`), иначе берется штатный. Затем менеджер создается фабричным classmethod:

```python
manager_cls_obj.create_manager(cache_size=encoder_cache_size, vllm_config=vllm_config)
```

Контракт собственного класса — этот `create_manager(cls, *, cache_size, vllm_config)`: базовый `EncoderCacheManager.create_manager` игнорирует `vllm_config`, а кастомный класс через него добирается до своего непрозрачного словаря `vllm_config.ec_manager_config.manager_config`. Дальше менеджер владеет жизненным циклом encoder cache на стороне планировщика: учет свободных слотов, разделение эмбеддингов между запросами по хешу мультимодального элемента, вытеснение нессылаемых записей. С worker-стороной он обменивается через абстрактный `EncoderCacheManagerMetadata` (`SchedulerOutput` → `gpu_model_runner`).

Валидация пары полей происходит еще на разборе аргументов: `EncoderCacheManagerConfig.__post_init__` отвергает `manager_config` без класса — `ValueError: manager_config requires encoder_cache_manager_cls to be set.`

## Значения и формат

Обе формы JSON-аргумента равнозначны:

```bash
--ec-manager-config '{"encoder_cache_manager_cls": "my_pkg.cache.MyManager", "manager_config": {"policy": "lru"}}'
--ec-manager-config.encoder_cache_manager_cls my_pkg.cache.MyManager
```

- Не задан — автоматический выбор штатного менеджера; это нормальное состояние для любой конфигурации без плагина.
- `encoder_cache_manager_cls` — полное имя (`module.submodule.ClassName`); модуль должен импортироваться в процессе engine core, то есть пакет плагина обязан стоять в том же окружении, из которого запускается `vllm serve`.
- `manager_config` — движок его не интерпретирует вовсе: содержимое читает только сам кастомный менеджер.

## Когда использовать

- Только вместе с внешним плагином, который поставляет класс менеджера и документирует свой `manager_config`. Апстрим ссылается на `vllm-project/bart-plugin` как на пример потребителя этих хуков.
- Для обычной эксплуатации мультимодальной модели аргумент не нужен: политика штатного менеджера (разделение по хешу, вытеснение старейших нессылаемых записей) не настраивается этим флагом, а размер кеша задается не здесь.
- Учитывайте, что это исполнение произвольного кода из конфигурации: класс импортируется и работает внутри процесса движка. Для инстанса arriero строка живет в `config/instances/<name>.json` — тот, кто может ее править, может исполнить код от имени процесса vLLM.

## Влияние на производительность и память

Сам аргумент бюджет не меняет: размер encoder cache по-прежнему выводится из мультимодального бюджета планировщика. Что меняется — политика удержания и вытеснения эмбеддингов, то есть частота повторного прогона энкодера при совпадающих изображениях; это и есть смысл кастомного менеджера. Плохая реализация проявится как рост TTFT на мультимодальных запросах (энкодер пересчитывает то, что мог бы отдать кеш) при неизменном VRAM.

## Взаимодействие с другими аргументами

- `--ec-transfer-config`: другой слой той же подсистемы — передача encoder cache между инстансами (разнесенный энкодер); менеджер из этого аргумента остается локальным для планировщика и работает независимо.
- `--limit-mm-per-prompt`: отключение всех модальностей обнуляет мультимодальный бюджет — менеджер создается с `cache_size = 0`, и кастомный класс становится бесполезен так же, как штатный.
- `--disable-chunked-mm-input`: меняет требования к бюджету энкодера (самый крупный элемент обязан помещаться целиком), что влияет на `cache_size`, передаваемый менеджеру.
- `--max-num-batched-tokens`: из него выводится размер encoder cache — та самая величина `cache_size` в `create_manager`.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: manager_config requires encoder_cache_manager_cls to be set.` при старте. **Причина:** задан только словарь без класса. **Лечение:** указать `encoder_cache_manager_cls` или убрать аргумент.
- **Симптом:** `ModuleNotFoundError` / `AttributeError` при старте engine core. **Причина:** полное имя класса не импортируется в окружении движка. **Проверка:** `python -c "from my_pkg.cache import MyManager"` в том же окружении (для инстанса arriero — python из env инстанса). **Лечение:** установить пакет плагина в окружение или исправить имя.
- **Симптом:** `TypeError` про `create_manager` при старте. **Причина:** класс не реализует контракт `create_manager(cls, *, cache_size, vllm_config)`. **Лечение:** привести фабричный метод к сигнатуре базового `EncoderCacheManager.create_manager`.
- **Симптом:** аргумент задан, а поведение не изменилось. **Причина:** модель без мультимодальных входов — encoder cache не используется, менеджер простаивает с нулевым размером. **Лечение:** ничего; на текстовой модели аргумент инертен.
- Аргумент новый (в дереве с августа 2026): в установленной сборке его наличие проверяется через `vllm serve --help` в нужном окружении.

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B --ec-manager-config '{"encoder_cache_manager_cls": "my_pkg.cache.MyManager"}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B --ec-manager-config '{"encoder_cache_manager_cls": "my_pkg.cache.MyManager", "manager_config": {"policy": "lru", "pin_first_image": true}}'
```

## Источники

- `vllm/vllm/config/ec_manager_config.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/v1/core/sched/scheduler.py`
- `vllm/vllm/v1/core/encoder_cache_manager.py`
- коммит checkout'а `833483f357` «Encoder cache extension hooks (#48218)» — добавил поле `ec_manager_config` и хуки менеджера
- коммит checkout'а `7bbbf7c8e5` «[Core] Configure custom encoder cache managers from VllmConfig (#51251)» — вывел поле в CLI-флаг, добавил `manager_config` и фабрику `create_manager`
