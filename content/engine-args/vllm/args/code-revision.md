---
schema: 1
engine: vllm
primaryName: "--code-revision"
title: "--code-revision"
summary: Пин ревизии кода модели на Hugging Face Hub — отдельно от `--revision`, который пинит веса и конфиг. Имеет смысл только для репозиториев с remote code и `--trust-remote-code`.
group: ModelConfig
related:
  - --revision
  - --trust-remote-code
  - --tokenizer-revision
  - --hf-config-path
  - --model-impl
---

# --code-revision

## Кратко

Некоторые репозитории на Hub несут собственный Python-код (`auto_map` в `config.json`, файлы `modeling_*.py`, `configuration_*.py`). `transformers` скачивает и исполняет его, если разрешён `--trust-remote-code`. `--code-revision` фиксирует, какую ревизию этого кода брать.

Это отдельная ось от `--revision`: веса и конфиг можно держать на теге релиза, а код — на конкретном коммите. Для локального каталога и для модели, у которой есть штатная реализация в vLLM или в `transformers`, флаг не делает ничего.

## Оригинальная справка

```text
The specific revision to use for the model code on the Hugging Face Hub.
It can be a branch name, a tag name, or a commit id. If unspecified, will
use the default version.
```

## Паспорт аргумента

- Флаги: `--code-revision`
- Группа argparse: `ModelConfig`
- Тип значения: str (имя ветки, тег или commit id)
- Допустимые значения: не ограничены; корректность проверяет Hub при скачивании
- Значение по умолчанию: `None` — «взять ревизию по умолчанию» (обычно `main`)
- Эффективное значение: не переопределяется и, в отличие от `--revision`, **не резолвится в commit-хеш** (`resolve_revision` применяется только к `revision`/`tokenizer_revision`)
- Где объявлен: `vllm/config/model.py:ModelConfig.code_revision`
- Этап применения: разбор CLI → загрузка HF-конфига в `ModelConfig.__post_init__` → разрешение класса модели → чат-шаблон процессора и generation config

## Что меняет в движке

Значение прокидывается как `code_revision=` в четыре независимых места:

1. **Конфиг модели.** `ModelConfig.__post_init__` → `get_config(..., code_revision, ...)` → `HFConfigParser.parse` → `PretrainedConfig.get_config_dict(..., code_revision=...)` и `AutoConfig.from_pretrained(..., code_revision=...)`. Тут `transformers` решает, из какой ревизии брать `configuration_*.py`, если конфиг-класс кастомный.
2. **Класс модели.** `vllm/model_executor/models/registry.py` при разборе `auto_map` вызывает `try_get_class_from_dynamic_module(..., code_revision=model_config.code_revision, trust_remote_code=...)` (обёртка над `transformers.dynamic_module_utils` в `vllm/transformers_utils/dynamic_module.py`), сначала для `AutoConfig`/`AutoModel`-записей, потом для конкретного `AutoModelFor*`.
3. **Чат-шаблон.** `vllm/renderers/hf.py:_try_get_processor_chat_template` кэширует шаблон по ключу `(name_or_path, revision, code_revision, trust_remote_code)` и передаёт `code_revision` в `cached_get_processor`.
4. **Generation config.** `ModelConfig.try_get_generation_config()` пробрасывает `code_revision` в резервный путь через `get_config`.

Ключевая связка: без `--trust-remote-code` `transformers` не станет исполнять удалённый код вовсе, и пункт 2 либо вернёт `None`, либо приведёт к ошибке «Failed to load the model config. If the model is a custom model not yet available in the HuggingFace transformers library, consider setting `trust_remote_code=True` ...». То есть `--code-revision` без `--trust-remote-code` почти всегда бессмыслен.

Второе следствие: если vLLM нашёл модель в своём реестре архитектур или model_type попал в `_CONFIG_REGISTRY`, `trust_remote_code` внутри парсера сбрасывается в `False` («Now that it is registered, it is not considered remote code anymore»), и remote code не загружается — `--code-revision` снова ни на что не влияет.

## Значения и формат

- Строка: имя ветки (`main`, `refs/pr/3`), тег (`v1.2`) или полный/сокращённый commit id.
- `None` (не задан) — ревизия по умолчанию репозитория.
- Значение не проверяется на старте отдельно: ошибка приходит от Hub при попытке скачивания.
- Для локального пути к модели значение игнорируется — `transformers` читает файлы с диска.
- В отличие от `--revision`, значение не превращается в фиксированный commit-хеш, поэтому `--code-revision main` не даёт воспроизводимости: код может измениться между рестартами.

## Когда использовать

- Репозиторий с remote code обновил `modeling_*.py`, новая версия несовместима с вашей сборкой vLLM/`transformers` — зафиксируйте рабочий коммит кода, не откатывая веса.
- Нужна воспроизводимость окружения: тогда указывайте **commit id**, а не ветку, иначе фиксация иллюзорна.
- Проверяете патч из PR репозитория модели (`refs/pr/N`) на тех же весах.
- **Не трогайте** для моделей со штатной поддержкой в vLLM — remote code там не загружается, и флаг молча ничего не изменит; вы получите ложное ощущение, что версия зафиксирована.

## Влияние на производительность и память

Прямого влияния нет: флаг определяет только, какой файл кода скачивается. Косвенно смена ревизии кода может поменять архитектуру, размерности и, следовательно, потребление VRAM — но это следствие другого кода, а не самого флага. На время старта влияет разве что дополнительным обращением к Hub при первом запуске.

## Взаимодействие с другими аргументами

- `--trust-remote-code`: обязателен, чтобы remote code вообще загружался. Без него `--code-revision` инертен.
- `--revision`: соседняя ось — ревизия весов/конфига. Резолвится в commit-хеш; `--code-revision` нет.
- `--tokenizer-revision`: третья ось. По умолчанию наследует `--revision`, но не `--code-revision`.
- `--hf-config-path`: если конфиг берётся из другого репозитория, `code_revision` применяется к загрузке именно этого конфига (`get_config(self.hf_config_path or self.model, ...)`).
- `--model-impl`: при `transformers` fallback путь через `auto_map` используется активнее, поэтому и `--code-revision` заметнее.

## Типовые проблемы и диагностика

- **Симптом:** в логе `WARNING ... Unable to load <module> from HF Hub on <model>.` с трейсбеком. **Причина:** `try_get_class_from_dynamic_module` не смог достать класс по указанной ревизии (нет такого коммита, нет файла, нет `trust_remote_code`). **Лечение:** проверить существование ревизии и добавить `--trust-remote-code`.
- **Симптом:** флаг задан, но поведение не меняется. **Причина:** архитектура найдена в реестре vLLM или в `transformers`, remote code не грузится. **Проверка:** строка `Resolved architecture: <Arch>` в логе старта — если это класс vLLM, remote code не участвует.
- **Симптом:** `RuntimeError: Failed to load the model config. If the model is a custom model not yet available in the HuggingFace transformers library, consider setting trust_remote_code=True ...` **Причина:** remote code нужен, но не разрешён. **Лечение:** `--trust-remote-code`, оценив риск исполнения чужого кода в процессе сервера.
- **Симптом:** после рестарта поведение модели изменилось, хотя `--code-revision` задан. **Причина:** указана ветка, а не коммит. **Лечение:** зафиксировать commit id.
- **Проверка принятого значения:** отдельной строки в логе нет; косвенно ревизия видна по пути кэша `~/.cache/huggingface/modules/transformers_modules/<repo>/<commit>/`.

## Примеры

```bash
vllm serve some-org/custom-arch-7b --trust-remote-code --code-revision 9f0c1d2e3b4a5c6d7e8f9a0b1c2d3e4f5a6b7c8d
```

```bash
vllm serve some-org/custom-arch-7b --trust-remote-code --revision v1.2 --code-revision refs/pr/17 --max-model-len 8192
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/transformers_utils/config.py`
- `vllm/vllm/transformers_utils/dynamic_module.py`
- `vllm/vllm/model_executor/models/registry.py`
- `vllm/vllm/renderers/hf.py`
