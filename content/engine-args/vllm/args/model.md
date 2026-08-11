---
schema: 1
engine: vllm
primaryName: "--model"
title: "--model"
summary: Что именно грузит движок — идентификатор репозитория Hugging Face, локальный путь или URI объектного хранилища. В `vllm serve` это позиционный аргумент, и он же задает дефолт для токенизатора, конфига и публичного имени модели.
group: ModelConfig
related:
  - --served-model-name
  - --tokenizer
  - --revision
  - --trust-remote-code
  - --model-impl
  - --hf-config-path
  - --hf-overrides
  - --max-model-len
---

# --model

## Кратко

`--model` — единственный обязательный по смыслу вход инстанса: из него берутся веса, `config.json` (а значит архитектура, dtype и производная длина контекста), токенизатор и публичное имя модели. В командной строке `vllm serve` значение обычно передается **позиционно**, а не флагом.

Ошибка в этом значении обнаруживается на самом раннем этапе — при чтении HF-конфига, задолго до профилирования памяти, поэтому диагностика отличается от «не влезло в VRAM».

## Оригинальная справка

```text
Name or path of the Hugging Face model to use. It is also used as the
content for `model_name` tag in metrics output when `served_model_name` is
not specified.
```

## Паспорт аргумента

- Флаги: `--model`
- Группа argparse: `ModelConfig`
- Тип значения: str — идентификатор репозитория HF (`org/name`), локальный путь или URI объектного хранилища (`s3://`, `gs://`, `az://`)
- Допустимые значения: не ограничены парсером
- Значение по умолчанию: `Qwen/Qwen3-0.6B` (тот же дефолт проговорен в описании подкоманды: «Defaults to Qwen/Qwen3-0.6B if no model is specified»)
- Эффективное значение: позиционный `model_tag` подкоманды `serve` **перебивает** флаг (`ServeSubcommand.cmd`: `args.model = args.model_tag`, если позиционный задан). Далее значение может быть подменено картой редиректов `VLLM_MODEL_REDIRECT_PATH` (`maybe_model_redirect`), заменено локальным путем при `HF_HUB_OFFLINE=1` (`get_model_path`) и заменено временным каталогом при выкачивании из объектного хранилища (исходный URI сохраняется в `model_weights`)
- Где объявлен: `vllm/config/model.py:ModelConfig.model`
- Этап применения: разбор CLI → `EngineArgs.__post_init__` (offline-подстановка пути) → `ModelConfig.__post_init__` (редирект, выкачивание, разрешение revision, загрузка `hf_config`) → резолв архитектуры → загрузка весов

## Что меняет в движке

Значение попадает в `ModelConfig.model` и оттуда расходится по всей сборке конфига:

1. `get_served_model_name(self.model, self.served_model_name)` вызывается **первым**, до `maybe_model_redirect`, — то есть публичное имя фиксируется по исходной строке, а не по результату редиректа.
2. Если `--tokenizer` не задан, он приравнивается к `--model`; то же самое для `--hf-config-path`.
3. `resolve_revision(self.model, self.revision, self.hf_token)` один раз превращает ветку/тег в commit-хеш, чтобы дальше не ходить в Hub повторно; для локального пути и при `VLLM_USE_MODELSCOPE` шаг пропускается.
4. `get_config(...)` читает `config.json` (или mistral-формат при `--config-format auto`), после чего определяются `architectures`, `runner_type`, `convert_type`, dtype и производный `max_model_len`. В лог идет строка `Resolved architecture: <Arch>`.
5. Загрузчик весов читает файлы из того же пути/репозитория (либо из `model_weights`, если модель была скачана из объектного хранилища).

Для URI объектного хранилища `maybe_pull_model_tokenizer_for_runai` скачивает во временный каталог только метаданные (`*.model`, `*.py`, `*.json`), подменяет `self.model` на этот каталог и сохраняет исходный URI в `model_weights`.

## Значения и формат

- **Идентификатор HF**: `Qwen/Qwen3-4B`. Существование проверяется сетевым запросом в Hub (или локальным кешем при `HF_HUB_OFFLINE=1`).
- **Локальный путь**: абсолютный либо относительный. `resolve_revision` для него ничего не делает, `--revision` фактически игнорируется.
- **URI объектного хранилища**: `s3://…`, `gs://…`, `az://…` — распознается `is_runai_obj_uri`; при `HF_HUB_OFFLINE=1` такие значения намеренно не превращаются в локальный путь.
- Пустого значения и специальных слов (`auto`, `none`) нет: любая строка трактуется как имя модели или путь.
- Флаг `--model` при `vllm serve … --help` **не регистрируется вовсе** (`add_cli_args`: `if not ("serve" in sys.argv[1:] and "--help" in sys.argv[1:])`), поэтому в выводе справки `serve` его не видно — там модель показана как позиционный `model_tag`. При реальном запуске флаг существует, но позиционное значение имеет приоритет.

## Когда использовать

- Всегда задавайте модель явно: дефолт `Qwen/Qwen3-0.6B` — это удобство для быстрой пробы, а не конфигурация сервера.
- Для управляемого сервера предпочитайте локальный путь плюс явный `--served-model-name`: путь не зависит от сети, а публичное имя не меняется при переносе весов.
- Идентификатор HF имеет смысл, когда веса подтягиваются в кеш и вы фиксируете `--revision` коммитом.
- Не подставляйте сюда путь к отдельному файлу весов: движок ждет каталог/репозиторий с `config.json`, а не один `*.safetensors`.

## Влияние на производительность и память

- **VRAM.** Через размер и формат весов задает основную часть потребления; остаток бюджета `--gpu-memory-utilization` уходит на KV-cache.
- **Время старта.** Скачивание (если веса не в кеше), чтение конфига, резолв архитектуры, загрузка весов, компиляция и захват CUDA graphs. На локальных весах старт полностью упирается в чтение с диска и компиляцию.
- **Производная длина контекста.** `config.json` задает `derived_max_model_len`, от которого пляшет `--max-model-len`.
- **RAM хоста.** Токенизатор и конфиги живут во фронтенд-процессе; веса стримятся в устройство.

## Взаимодействие с другими аргументами

- `--served-model-name`: публичное имя; без него имя равно строке `--model` целиком (для локального пути — весь путь).
- `--tokenizer`, `--hf-config-path`: по умолчанию наследуют это значение; задаются отдельно, когда токенизатор или конфиг лежат в другом месте.
- `--revision`, `--tokenizer-revision`, `--code-revision`: фиксируют версию репозитория; для локального пути бессмысленны.
- `--trust-remote-code`: нужен, если репозиторий модели содержит собственный код конфига/модели.
- `--model-impl`: решает, брать ли реализацию vLLM или Transformers для найденной архитектуры.
- `--hf-overrides`: правит прочитанный `config.json`, не трогая сам репозиторий.
- `--max-model-len`: по умолчанию выводится из конфига этой модели.

## Типовые проблемы и диагностика

- **Симптом:** старт падает при чтении конфига с ошибкой Hugging Face Hub («Repository Not Found», «Revision Not Found»). **Причина:** опечатка в идентификаторе, приватный репозиторий без токена, несуществующий `--revision`. **Лечение:** проверить идентификатор, задать `--hf-token`, зафиксировать существующий коммит.
- **Симптом:** `Failed to load the model config. If the model is a custom model not yet available in the HuggingFace transformers library, consider setting `trust_remote_code=True` in LLM or using the `--trust-remote-code` flag in the CLI.` **Причина:** репозиторий требует исполнения собственного `configuration_*.py`. **Лечение:** осознанно включить `--trust-remote-code` (см. документ этого аргумента) либо взять другой чекпойнт.
- **Симптом:** в логе `model redirect: [ A ] -> [ B ]`, и грузится не то, что вы указали. **Причина:** задан `VLLM_MODEL_REDIRECT_PATH` с картой подмен. **Проверка:** переменная окружения инстанса.
- **Симптом:** при `HF_HUB_OFFLINE=1` в логе `HF_HUB_OFFLINE is True, replace model_id [...] to model_path [...]`, и путь ведет в чужой кеш. **Лечение:** указывать локальный путь явно.
- **Симптом (arriero):** инстанс не стартует с `vLLM requires a model name or local model path.` **Причина:** у инстанса нет позиционного аргумента. **Лечение:** задать модель в позиционных аргументах инстанса — preflight (`process/preflight-vllm.ts`) проверяет именно `positionalArgs[0]`.
- **Симптом (arriero):** `Local vLLM model path not found: <путь>` или `Local vLLM model path is not readable: <путь>`. **Причина:** preflight резолвит абсолютные и явно-относительные (`./`, `../`) пути относительно `cwd` инстанса и требует их существования и читаемости; голый идентификатор HF так не проверяется. **Лечение:** исправить путь или права.
- **Подтверждение принятого значения:** строка `Resolved architecture: <Arch>` и следом `Using max model len N` в логе старта.

## Примеры

```bash
vllm serve /models/Qwen3-4B --served-model-name qwen3-4b --gpu-memory-utilization 0.85
```

```bash
vllm serve Qwen/Qwen3-4B --revision 8dc1b7b3a1b3e4b2b0a4a7e2f6c9b1d0e3f5a7c9 --max-model-len 8192
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/entrypoints/cli/serve.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/vllm/transformers_utils/config.py`
- `vllm/vllm/transformers_utils/utils.py`
- `vllm/vllm/transformers_utils/repo_utils.py`
- `vllm/vllm/transformers_utils/runai_utils.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
